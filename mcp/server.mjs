#!/usr/bin/env node
/**
 * Meesa Asset Library MCP server.
 *
 * Exposes the local media asset catalog over the MCP stdio transport:
 * newline-delimited JSON-RPC 2.0 on stdin/stdout. Diagnostics go to stderr.
 *
 * Zero dependencies. Requires Node.js 18 or newer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "meesa-asset-library";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = process.env.MEESA_LIBRARY_ROOT
  ? path.resolve(process.env.MEESA_LIBRARY_ROOT)
  : path.resolve(MCP_DIR, "..");
const CATALOG_DIR = path.join(LIBRARY_ROOT, "catalog");
const INDEX_PATH = path.join(CATALOG_DIR, "index.jsonl");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const TOOLS = [
  {
    name: "search_assets",
    description:
      "Search the local media asset catalog by free-text query, kind, and tags. Returns compact asset records scored by id, title, summary, tags, and role.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text query scored across id, title, summary, tags, and role.",
        },
        kind: {
          type: "string",
          description: "Exact asset kind filter, for example image, audio, or model.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags in namespace:value form. Every supplied tag must match.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: `Maximum number of results (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).`,
        },
      },
    },
  },
  {
    name: "get_asset",
    description:
      "Return one asset's full asset.json metadata plus the raw text of its asset.md digest.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Asset id exactly as returned by search_assets.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_taxonomy",
    description:
      "List catalog facet files and collections with their names and short descriptions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

class UserInputError extends Error {}

function log(message) {
  process.stderr.write(`[meesa-mcp] ${message}\n`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function tokenize(value) {
  return String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function cleanInline(value) {
  return String(value)
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;

  const slice = value.slice(0, maxLength - 3);
  const lastSpace = slice.lastIndexOf(" ");
  const clipped = lastSpace > maxLength * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${clipped.trimEnd()}...`;
}

function titleize(name) {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function collectionTitle(heading, name) {
  if (!heading) return titleize(name);
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(heading)) return titleize(heading);
  return heading;
}

/* --------------------------------------------------------------------------
 * Catalog index
 * ----------------------------------------------------------------------- */

let indexCache = {
  signature: null,
  items: [],
  byId: new Map(),
};

function indexSignature() {
  try {
    const stats = fs.statSync(INDEX_PATH);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw new Error(`Cannot stat catalog index at ${INDEX_PATH}: ${error.message}`);
  }
}

function normalizeRecord(record) {
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];

  const normalized = {
    id: record.id.trim(),
    kind: asText(record.kind),
    role: asText(record.role),
    title: asText(record.title),
    summary: asText(record.summary),
    tags,
    preview: asText(record.preview),
    dir: asText(record.dir),
    bytes:
      typeof record.bytes === "number" && Number.isFinite(record.bytes)
        ? record.bytes
        : 0,
    added: asText(record.added),
  };

  normalized.tokens = {
    id: new Set(tokenize(normalized.id)),
    title: new Set(tokenize(normalized.title)),
    summary: new Set(tokenize(normalized.summary)),
    tags: new Set(tokenize(normalized.tags.join(" "))),
    role: new Set(tokenize(normalized.role)),
  };

  normalized.lower = {
    id: normalized.id.toLowerCase(),
    title: normalized.title.toLowerCase(),
    summary: normalized.summary.toLowerCase(),
    tags: normalized.tags.join(" ").toLowerCase(),
    role: normalized.role.toLowerCase(),
  };

  return normalized;
}

function loadIndex() {
  const signature = indexSignature();
  if (signature === indexCache.signature) return indexCache;

  const items = [];
  const byId = new Map();

  if (signature !== "missing") {
    let raw;
    try {
      raw = fs.readFileSync(INDEX_PATH, "utf8");
    } catch (error) {
      throw new Error(`Cannot read catalog index at ${INDEX_PATH}: ${error.message}`);
    }

    let malformed = 0;

    raw
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .forEach((line, lineIndex) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let record;
        try {
          record = JSON.parse(trimmed);
        } catch {
          malformed += 1;
          if (malformed <= 5) {
            log(`Skipping malformed catalog line ${lineIndex + 1}`);
          }
          return;
        }

        if (
          !isPlainObject(record) ||
          typeof record.id !== "string" ||
          !record.id.trim()
        ) {
          malformed += 1;
          if (malformed <= 5) {
            log(`Skipping catalog line ${lineIndex + 1}: missing string id`);
          }
          return;
        }

        const normalized = normalizeRecord(record);
        if (byId.has(normalized.id)) {
          log(`Skipping duplicate catalog id: ${normalized.id}`);
          return;
        }

        items.push(normalized);
        byId.set(normalized.id, normalized);
      });

    if (malformed > 5) {
      log(`Skipped ${malformed} malformed catalog line(s) in total`);
    }
  }

  indexCache = { signature, items, byId };
  return indexCache;
}

/* --------------------------------------------------------------------------
 * Tool implementations
 * ----------------------------------------------------------------------- */

function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function optionalString(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new UserInputError(`'${key}' must be a string.`);
  }
  return value.trim();
}

function optionalTags(args) {
  const value = args.tags;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new UserInputError("'tags' must be an array of strings.");
  }
  return value
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function optionalLimit(args) {
  const value = args.limit;
  if (value === undefined || value === null) return DEFAULT_LIMIT;

  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new UserInputError("'limit' must be a positive number.");
  }

  return Math.min(MAX_LIMIT, Math.floor(number));
}

function compactRecord(record) {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    role: record.role,
    summary: record.summary,
    tags: record.tags,
    dir: record.dir,
  };
}

const SCORE_FIELDS = [
  ["title", 6],
  ["id", 5],
  ["tags", 4],
  ["role", 2],
  ["summary", 2],
];

function scoreRecord(record, terms, phrase) {
  let score = 0;

  for (const term of terms) {
    for (const [field, weight] of SCORE_FIELDS) {
      if (record.tokens[field].has(term)) {
        score += weight;
      } else if (record.lower[field].includes(term)) {
        score += weight * 0.5;
      }
    }
  }

  if (phrase && record.lower.id === phrase) score += 25;
  if (phrase && record.lower.title.includes(phrase)) score += 4;
  if (phrase && record.lower.id.includes(phrase)) score += 3;

  return score;
}

function searchAssets(args) {
  if (args === undefined || args === null) args = {};
  if (!isPlainObject(args)) {
    throw new UserInputError("search_assets arguments must be an object.");
  }

  const query = optionalString(args, "query");
  const kind = optionalString(args, "kind").toLowerCase();
  const wantedTags = optionalTags(args);
  const limit = optionalLimit(args);

  const terms = tokenize(query);
  const phrase = query.toLowerCase();
  const matches = [];

  for (const record of loadIndex().items) {
    if (kind && record.kind.toLowerCase() !== kind) continue;

    if (wantedTags.length > 0) {
      const recordTags = record.tags.map((tag) => tag.toLowerCase());
      if (!wantedTags.every((tag) => recordTags.includes(tag))) continue;
    }

    const score = terms.length > 0 ? scoreRecord(record, terms, phrase) : 0;
    if (terms.length > 0 && score <= 0) continue;

    matches.push({ record, score });
  }

  if (terms.length > 0) {
    matches.sort(
      (left, right) =>
        right.score - left.score ||
        left.record.id.localeCompare(right.record.id),
    );
  }

  return toolText(
    JSON.stringify(matches.slice(0, limit).map(({ record }) => compactRecord(record))),
  );
}

function resolveAssetDir(relativeDir) {
  const target = path.resolve(LIBRARY_ROOT, relativeDir);
  const relative = path.relative(LIBRARY_ROOT, target);

  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new UserInputError(
      `Asset directory escapes the library root: ${relativeDir}`,
    );
  }

  return target;
}

function getAsset(args) {
  if (!isPlainObject(args)) {
    throw new UserInputError("get_asset arguments must be an object.");
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new UserInputError("get_asset requires a non-empty string 'id'.");
  }

  const record = loadIndex().byId.get(id);
  if (!record) return toolError(`Asset not found: ${id}`);
  if (!record.dir) {
    return toolError(`Asset ${id} has no directory in the catalog index.`);
  }

  let assetDir;
  try {
    assetDir = resolveAssetDir(record.dir);
  } catch (error) {
    return toolError(error.message);
  }

  const metadataPath = path.join(assetDir, "asset.json");
  let metadataText;
  try {
    metadataText = fs.readFileSync(metadataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return toolError(`Asset metadata not found: ${record.dir}/asset.json`);
    }
    return toolError(`Cannot read ${record.dir}/asset.json: ${error.message}`);
  }

  let asset;
  try {
    asset = JSON.parse(metadataText.replace(/^\uFEFF/, ""));
  } catch (error) {
    return toolError(`Invalid JSON in ${record.dir}/asset.json: ${error.message}`);
  }

  if (!isPlainObject(asset)) {
    return toolError(`${record.dir}/asset.json must contain a JSON object.`);
  }

  let markdown = null;
  let markdownError = null;
  try {
    markdown = fs.readFileSync(path.join(assetDir, "asset.md"), "utf8");
  } catch (error) {
    markdownError =
      error.code === "ENOENT"
        ? "asset.md not found"
        : `Cannot read asset.md: ${error.message}`;
  }

  const payload = {
    id: record.id,
    dir: record.dir,
    asset,
    markdown,
  };
  if (markdownError) payload.markdownError = markdownError;

  return toolText(JSON.stringify(payload, null, 2));
}

function markdownFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw new Error(`Cannot read ${directory}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function parseMarkdownDigest(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  let index = 0;

  while (index < lines.length && !lines[index].trim()) index += 1;

  // Skip YAML frontmatter only when it has a closing delimiter.
  if (index < lines.length && lines[index].trim() === "---") {
    let closing = index + 1;
    while (closing < lines.length && lines[closing].trim() !== "---") closing += 1;
    if (closing < lines.length) index = closing + 1;
  }

  let heading = "";
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const match = /^#{1,6}\s+(.+)$/.exec(lines[cursor].trim());
    if (match) {
      heading = cleanInline(match[1]);
      break;
    }
  }

  let summary = "";

  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      if (summary) break;
      continue;
    }
    if (/^(?:---|\*\*\*|___)$/.test(line)) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^```/.test(line) || /^\|/.test(line)) continue;

    const listMatch = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    const quoteMatch = /^>\s*(.+)$/.exec(line);

    if (listMatch || quoteMatch) {
      summary = cleanInline(listMatch?.[1] ?? quoteMatch[1]);
      break;
    }

    // Join hard-wrapped prose into the first logical paragraph.
    const parts = [line];
    while (index + 1 < lines.length) {
      const next = lines[index + 1].trim();
      if (!next) break;
      if (/^(?:---|\*\*\*|___)$/.test(next)) break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^```/.test(next) || /^\|/.test(next)) break;
      if (/^(?:[-*+]|\d+\.)\s+/.test(next)) break;
      if (/^>\s*/.test(next)) break;
      parts.push(next);
      index += 1;
    }

    summary = cleanInline(parts.join(" "));
    break;
  }

  return {
    heading,
    summary: truncate(summary || heading, 240),
  };
}

function readTaxonomyEntry(directory, filename, isCollection) {
  const name = path.basename(filename, path.extname(filename));
  const filePath = path.join(directory, filename);

  let parsed;
  try {
    parsed = parseMarkdownDigest(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { name, summary: "", error: `Cannot read ${filename}: ${error.message}` };
  }

  if (isCollection) {
    const title = collectionTitle(parsed.heading, name);
    return {
      name,
      title,
      summary: parsed.summary && parsed.summary !== title ? parsed.summary : "",
    };
  }

  return { name, summary: parsed.summary };
}

function listTaxonomy() {
  const facetsDirectory = path.join(CATALOG_DIR, "facets");
  const collectionsDirectory = path.join(CATALOG_DIR, "collections");

  const facets = markdownFiles(facetsDirectory).map((filename) =>
    readTaxonomyEntry(facetsDirectory, filename, false),
  );
  const collections = markdownFiles(collectionsDirectory).map((filename) =>
    readTaxonomyEntry(collectionsDirectory, filename, true),
  );

  return toolText(JSON.stringify({ facets, collections }, null, 2));
}

function callTool(name, args) {
  switch (name) {
    case "search_assets":
      return searchAssets(args);
    case "get_asset":
      return getAsset(args);
    case "list_taxonomy":
      return listTaxonomy();
    default:
      throw new Error(`Unhandled tool: ${name}`);
  }
}

/* --------------------------------------------------------------------------
 * JSON-RPC
 * ----------------------------------------------------------------------- */

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handleToolsCall(id, params) {
  if (!isPlainObject(params)) {
    return errorResponse(id, -32602, "Invalid params: tools/call requires an object.");
  }

  const name = params.name;
  if (typeof name !== "string" || !name) {
    return errorResponse(
      id,
      -32602,
      "Invalid params: tools/call requires a string 'name'.",
    );
  }

  if (!TOOL_NAMES.has(name)) {
    return errorResponse(id, -32602, `Unknown tool: ${name}`);
  }

  try {
    return response(id, callTool(name, params.arguments ?? {}));
  } catch (error) {
    if (error instanceof UserInputError) {
      return response(id, toolError(error.message));
    }

    log(`Tool ${name} failed: ${error.stack || error.message || error}`);
    return response(id, toolError(`Tool ${name} failed: ${error.message || error}`));
  }
}

function handleMessage(message) {
  if (!isPlainObject(message)) {
    return errorResponse(null, -32600, "Invalid Request: expected a JSON object.");
  }

  if (message.method === "notifications/initialized") return null;

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (!hasId) return null; // Notifications never receive a response.

  const id = message.id;
  if (message.jsonrpc !== "2.0") {
    return errorResponse(id, -32600, "Invalid Request: jsonrpc must be '2.0'.");
  }

  if (typeof message.method !== "string") {
    return errorResponse(id, -32600, "Invalid Request: missing string 'method'.");
  }

  switch (message.method) {
    case "initialize":
      return response(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "ping":
      return response(id, {});

    case "tools/list":
      return response(id, { tools: TOOLS });

    case "tools/call":
      return handleToolsCall(id, message.params);

    default:
      return errorResponse(id, -32601, `Method not found: ${message.method}`);
  }
}

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    log(`Cannot write response: ${error.message}`);
  }
}

function handleLine(line) {
  const trimmed = line.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send(errorResponse(null, -32700, "Parse error"));
    return;
  }

  let reply;
  try {
    reply = handleMessage(message);
  } catch (error) {
    log(`Internal error: ${error.stack || error.message || error}`);
    const id =
      isPlainObject(message) && Object.prototype.hasOwnProperty.call(message, "id")
        ? message.id
        : null;
    reply = errorResponse(id, -32603, "Internal error");
  }

  if (reply) send(reply);
}

/* --------------------------------------------------------------------------
 * stdio transport
 * ----------------------------------------------------------------------- */

let inputBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;

  let newlineIndex;
  while ((newlineIndex = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    handleLine(line);
  }
});

process.stdin.on("end", () => {
  if (inputBuffer.length > 0) {
    handleLine(inputBuffer.replace(/\r$/, ""));
    inputBuffer = "";
  }
});

process.stdin.on("error", (error) => {
  log(`stdin error: ${error.message}`);
  process.exitCode = 1;
});

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  log(`stdout error: ${error.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log(
    `Unhandled promise rejection: ${
      reason instanceof Error ? reason.stack || reason.message : String(reason)
    }`,
  );
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  log(`Uncaught exception: ${error.stack || error.message || error}`);
  process.exit(1);
});
