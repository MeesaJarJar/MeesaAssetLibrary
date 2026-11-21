#!/usr/bin/env node
/**
 * Meesa Asset Library MCP server.
 *
 * Exposes the published media asset catalog over the MCP stdio transport:
 * newline-delimited JSON-RPC 2.0 on stdin/stdout. Diagnostics go to stderr.
 *
 * The catalog can be read from the local repository root or from the published
 * site (MEESA_LIBRARY_URL). Remote reads use catalog/search-index.json,
 * catalog/concepts.json and catalog/embeddings.json plus its .bin files, with a
 * five minute in-memory cache and conditional refresh.
 *
 * Zero dependencies. Requires Node.js 18 or newer.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
const SEARCH_INDEX_PATH = path.join(CATALOG_DIR, "search-index.json");
const CONCEPTS_PATH = path.join(CATALOG_DIR, "concepts.json");
const EMBEDDINGS_PATH = path.join(CATALOG_DIR, "embeddings.json");

const DEFAULT_LIBRARY_URL = "https://meesajarjar.github.io/MeesaAssetLibrary/";
const URL_SETTING = process.env.MEESA_LIBRARY_URL;
const RAW_LIBRARY_URL = (
  URL_SETTING === undefined ? DEFAULT_LIBRARY_URL : URL_SETTING
).trim();
const REMOTE_ENABLED = RAW_LIBRARY_URL.length > 0;
const LIBRARY_URL = REMOTE_ENABLED
  ? RAW_LIBRARY_URL.endsWith("/")
    ? RAW_LIBRARY_URL
    : `${RAW_LIBRARY_URL}/`
  : "";

const ISSUE_REPO =
  (process.env.MEESA_ISSUE_REPO ?? "").trim() ||
  "meesajarjar/MeesaAssetLibrary";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_DIM = 512;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RESTRICTED_LICENSE = "LicenseRef-All-Rights-Reserved";

const TOOLS = [
  {
    name: "search_assets",
    description:
      "Search the media asset catalog by free-text query, kind, and tags. Matches concepts by id, label and synonym, then blends semantic (CLIP/CLAP) similarity with keyword scoring: 0.55 semantic + 0.45 keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text query. Matched against concepts and asset title, tags, keywords, summary, prompt, role and kind.",
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
      "Return one asset's full asset.json metadata plus the raw text of its asset.md digest and, when available, its search-index entry.",
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
      "List catalog facet files and collections with their names and short descriptions, plus asset families and the most used concepts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "checkout_pack",
    description:
      "Download a set of assets into a self-contained pack with pack.json, CREDITS.md, LICENSE.txt and README.md. Verifies SHA-256 and refuses LicenseRef-All-Rights-Reserved assets unless acknowledged.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Asset ids to include in the pack.",
        },
        outDir: {
          type: "string",
          description:
            "Output directory. Defaults to a new directory under the OS temp directory. Must not contain '..'.",
        },
        includePreview: {
          type: "boolean",
          default: true,
          description: "Download each asset's preview file when one is available.",
        },
        acknowledgeRestricted: {
          type: "boolean",
          default: false,
          description:
            "Explicitly allow assets licensed LicenseRef-All-Rights-Reserved in this pack.",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "request_asset",
    description:
      "Build a prefilled GitHub issue URL requesting an asset that is not in the library. Does not open a browser or post anything.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the asset request is for.",
        },
        note: {
          type: "string",
          description: "Optional extra context for the request.",
        },
      },
      required: ["query"],
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

function singularWord(value) {
  const word = String(value ?? "").toLowerCase();
  if (word.length > 4 && word.slice(-3) === "ies") {
    return `${word.slice(0, -3)}y`;
  }
  if (
    word.length > 3 &&
    word.charAt(word.length - 1) === "s" &&
    word.slice(-2) !== "ss"
  ) {
    return word.slice(0, -1);
  }
  return word;
}

// Mirrors the gallery tokenizer: ASCII words, simple singularization, deduped.
function tokenize(value) {
  const seen = new Set();
  const tokens = [];
  for (const raw of String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")) {
    if (!raw) continue;
    const token = singularWord(raw);
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function stringArray(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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
 * Local index (legacy catalog/index.jsonl)
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
  const tags = stringArray(record.tags);

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
    file: asText(record.file),
    mime: asText(record.mime),
    sha256: asText(record.sha256),
    keywords: stringArray(record.keywords),
    prompt: asText(record.prompt),
    family: asText(record.family),
    scope: asText(record.scope),
    contributor: asText(record.contributor),
    license: asText(record.license),
    text: asText(record.text),
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

function legacyAsset(record) {
  return {
    id: record.id,
    kind: record.kind,
    role: record.role,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    keywords: record.keywords,
    prompt: record.prompt,
    family: record.family,
    scope: record.scope,
    contributor: record.contributor,
    license: record.license,
    preview: record.preview,
    file: record.file,
    mime: record.mime,
    bytes: record.bytes,
    sha256: record.sha256,
    dir: record.dir,
    added: record.added,
    text: record.text,
    embeddings: {},
  };
}

/* --------------------------------------------------------------------------
 * Search catalog (search-index.json + concepts + embeddings)
 * ----------------------------------------------------------------------- */

function normalizeDim(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(number) && number > 0 && number <= 8192) {
    return number;
  }
  return DEFAULT_DIM;
}

function refValue(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  if (isPlainObject(value)) {
    const candidate = value.index ?? value.idx ?? value.slot;
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      return Number(candidate.trim());
    }
  }
  return null;
}

function embeddingRef(embeddings, field) {
  if (!isPlainObject(embeddings)) return null;

  const direct = embeddings[field];
  if (direct !== undefined && direct !== null) {
    const resolved = refValue(direct);
    if (resolved !== null) return resolved;
  }

  const modality = field.startsWith("clip") ? "clip" : "clap";
  const nested = embeddings[modality];
  if (isPlainObject(nested)) {
    const suffix = field.slice(4).toLowerCase();
    const resolved = refValue(nested[suffix]);
    if (resolved !== null) return resolved;
  }

  // Tolerate compact manifests that use {clip: n} or {clap: n} for the
  // modality's text vector.
  const compact = refValue(nested);
  if (compact !== null) return compact;

  return null;
}

function normalizeSearchAsset(raw, dim, embeddingsFallback) {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";

  const tags = stringArray(raw.tags);
  const keywords = stringArray(raw.keywords);
  const summary = asText(raw.summary);
  const prompt = asText(raw.prompt);
  const role = asText(raw.role);
  const kind = asText(raw.kind);

  const fallback = isPlainObject(embeddingsFallback) ? embeddingsFallback : {};
  const rawEmbeddings = isPlainObject(raw.embeddings) ? raw.embeddings : {};
  const embeddings = { ...rawEmbeddings, ...fallback };

  const normalized = {
    id,
    kind,
    role,
    title: asText(raw.title),
    summary,
    tags,
    keywords,
    prompt,
    family: asText(raw.family),
    scope: asText(raw.scope),
    contributor: asText(raw.contributor),
    license: asText(raw.license),
    preview: asText(raw.preview),
    file: asText(raw.file),
    mime: asText(raw.mime),
    bytes:
      typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? raw.bytes : 0,
    sha256: asText(raw.sha256),
    dir: asText(raw.dir),
    added: asText(raw.added),
    text: asText(raw.text),
    dim,
    embeddings,
    raw,
  };

  normalized.searchFields = {
    title: `${normalized.title} ${id}`.toLowerCase(),
    tags: tags.join(" ").toLowerCase(),
    keywords: keywords.join(" ").toLowerCase(),
    summary: summary.toLowerCase(),
    prompt: prompt.toLowerCase(),
    role: `${role} ${kind}`.toLowerCase(),
  };

  normalized.allTokens = new Set(
    tokenize(
      [
        normalized.title,
        id,
        tags.join(" "),
        keywords.join(" "),
        summary,
        prompt,
        role,
        kind,
        normalized.text,
      ].join(" "),
    ),
  );

  return normalized;
}

function conceptModalities(value) {
  const modality = String(value ?? "").trim().toLowerCase();
  if (modality === "audio" || modality === "sound") {
    return { visual: false, audio: true };
  }
  if (
    modality === "visual" ||
    modality === "image" ||
    modality === "video" ||
    modality === "model" ||
    modality === "3d"
  ) {
    return { visual: true, audio: false };
  }
  // "both", empty and unknown modalities may search either cohort.
  return { visual: true, audio: true };
}

function normalizeConcept(raw) {
  const id =
    typeof raw.id === "string"
      ? raw.id.trim()
      : typeof raw.label === "string"
        ? raw.label.trim()
        : "";
  const label = asText(raw.label) || id;
  const synonyms = stringArray(raw.synonyms);
  const rawTerms = [id, label, ...synonyms]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);

  const termSet = new Set(rawTerms);
  for (const value of rawTerms) {
    for (const token of tokenize(value)) termSet.add(token);
  }

  const modality = asText(raw.modality).trim().toLowerCase();

  return {
    id,
    label,
    synonyms,
    kind: asText(raw.kind),
    modality,
    modalities: conceptModalities(modality),
    rawTerms,
    termSet,
    tokens: new Set(tokenize(rawTerms.join(" "))),
  };
}

function manifestAssetList(value) {
  if (Array.isArray(value)) return value.filter(isPlainObject);
  if (isPlainObject(value)) {
    return Object.entries(value)
      .filter(([, asset]) => isPlainObject(asset))
      .map(([id, asset]) => ({ ...asset, id: asText(asset.id) || id }));
  }
  return [];
}

function conceptList(value) {
  if (Array.isArray(value)) return value.filter(isPlainObject);
  if (isPlainObject(value)) {
    return Object.entries(value)
      .filter(([, concept]) => isPlainObject(concept))
      .map(([id, concept]) => ({ ...concept, id: asText(concept.id) || id }));
  }
  return [];
}

function conceptRef(value, field) {
  if (!isPlainObject(value)) return null;

  const direct = refValue(
    value[field] ?? value[`${field}Text`] ?? value[`${field}_text`],
  );
  if (direct !== null) return direct;

  if (isPlainObject(value.embeddings)) {
    return conceptRef(value.embeddings, field);
  }

  return null;
}

function addConceptRefs(map, id, item) {
  if (!id) return;

  let refs;
  if (
    typeof item === "number" ||
    (typeof item === "string" && /^\d+$/.test(item.trim()))
  ) {
    refs = { clip: refValue(item), clap: null };
  } else if (isPlainObject(item)) {
    const source = isPlainObject(item.embeddings) ? item.embeddings : item;
    refs = {
      clip: conceptRef(source, "clip"),
      clap: conceptRef(source, "clap"),
    };
  } else {
    return;
  }

  if (refs.clip === null && refs.clap === null) return;

  const existing = map.get(id);
  if (!existing) {
    map.set(id, refs);
    return;
  }
  if (existing.clip === null) existing.clip = refs.clip;
  if (existing.clap === null) existing.clap = refs.clap;
}

function conceptEmbeddingMap(value) {
  const map = new Map();
  if (value === null || value === undefined) return map;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      addConceptRefs(map, asText(item.id).trim(), item);
    }
    return map;
  }

  if (isPlainObject(value)) {
    for (const [id, item] of Object.entries(value)) {
      addConceptRefs(map, id, item);
    }
  }

  return map;
}

function float32FromBuffer(buffer) {
  const count = Math.floor(buffer.length / 4);
  const floats = new Float32Array(count);
  const view = new DataView(buffer.buffer, buffer.byteOffset, count * 4);
  for (let index = 0; index < count; index += 1) {
    floats[index] = view.getFloat32(index * 4, true);
  }
  return floats;
}

function vectorAt(bin, dim, index) {
  if (!(bin instanceof Float32Array)) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  const offset = index * dim;
  if (offset + dim > bin.length) return null;
  return bin.subarray(offset, offset + dim);
}

function buildSnapshot({
  source,
  searchManifest,
  conceptsDocument,
  embeddingsManifest,
  clip,
  clap,
  legacyRecords,
}) {
  const dim = normalizeDim(
    embeddingsManifest?.dim ?? searchManifest?.dim ?? DEFAULT_DIM,
  );

  const embeddingAssets = isPlainObject(embeddingsManifest?.assets)
    ? embeddingsManifest.assets
    : {};

  const rawAssets = legacyRecords ?? manifestAssetList(searchManifest?.assets);
  const assets = [];
  const byId = new Map();

  for (const raw of rawAssets) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || byId.has(id)) continue;
    const fallback = isPlainObject(embeddingAssets[id])
      ? isPlainObject(embeddingAssets[id].embeddings)
        ? embeddingAssets[id].embeddings
        : embeddingAssets[id]
      : {};
    const normalized = normalizeSearchAsset(raw, dim, fallback);
    assets.push(normalized);
    byId.set(id, normalized);
  }

  const conceptSource =
    conceptsDocument?.concepts ??
    conceptsDocument ??
    embeddingsManifest?.concepts ??
    searchManifest?.concepts;

  const concepts = [];
  const seenConceptIds = new Set();
  for (const concept of conceptList(conceptSource).map(normalizeConcept)) {
    if (!concept.id || seenConceptIds.has(concept.id)) continue;
    seenConceptIds.add(concept.id);
    concepts.push(concept);
  }

  // Concept vectors normally live in embeddings.json, but tolerate manifests
  // that carry the indices on the concepts themselves.
  const conceptEmbeddings = conceptEmbeddingMap(
    embeddingsManifest?.concepts ?? searchManifest?.concepts,
  );

  for (const [id, refs] of conceptEmbeddingMap(conceptSource)) {
    const existing = conceptEmbeddings.get(id);
    if (!existing) {
      conceptEmbeddings.set(id, refs);
      continue;
    }
    if (existing.clip === null) existing.clip = refs.clip;
    if (existing.clap === null) existing.clap = refs.clap;
  }

  return {
    source,
    dim,
    assets,
    byId,
    concepts,
    conceptEmbeddings,
    clip: clip instanceof Float32Array ? clip : null,
    clap: clap instanceof Float32Array ? clap : null,
    loadedAt: Date.now(),
    conceptRanking: null,
  };
}

/* --------------------------------------------------------------------------
 * Local search catalog loading
 * ----------------------------------------------------------------------- */

let localCache = { signature: null, snapshot: null };

function statSignature(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    return "error";
  }
}

function localCatalogSignature() {
  const parts = [
    SEARCH_INDEX_PATH,
    CONCEPTS_PATH,
    EMBEDDINGS_PATH,
    INDEX_PATH,
  ].map(statSignature);

  try {
    for (const name of fs.readdirSync(CATALOG_DIR).sort()) {
      if (name.toLowerCase().endsWith(".bin")) {
        parts.push(`${name}:${statSignature(path.join(CATALOG_DIR, name))}`);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      parts.push(`readdir-error:${error.message}`);
    }
  }

  return parts.join("|");
}

function readJsonFile(filePath, { optional = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (optional) {
      log(`Ignoring invalid JSON in ${filePath}: ${error.message}`);
      return null;
    }
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function resolveCatalogDataFile(fileName) {
  const raw = String(fileName ?? "").replace(/\\/g, "/");
  if (!raw) return null;

  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return null;
  }

  const candidates = [];
  if (segments[0].toLowerCase() === "catalog") {
    candidates.push(path.join(LIBRARY_ROOT, ...segments));
  }
  candidates.push(path.join(CATALOG_DIR, ...segments));
  candidates.push(path.join(LIBRARY_ROOT, ...segments));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        const relative = path.relative(LIBRARY_ROOT, candidate);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          continue;
        }
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function loadLocalBin(fileName) {
  const resolved = resolveCatalogDataFile(fileName);
  if (!resolved) return null;
  try {
    return float32FromBuffer(fs.readFileSync(resolved));
  } catch (error) {
    log(`Cannot read embedding bin ${resolved}: ${error.message}`);
    return null;
  }
}

function hasLocalCatalog() {
  return fs.existsSync(SEARCH_INDEX_PATH) || fs.existsSync(INDEX_PATH);
}

function loadLocalCatalog() {
  const signature = localCatalogSignature();
  if (localCache.signature === signature) return localCache.snapshot;

  const searchManifest = readJsonFile(SEARCH_INDEX_PATH, { optional: true });
  const conceptsDocument = readJsonFile(CONCEPTS_PATH, { optional: true });
  const embeddingsManifest = readJsonFile(EMBEDDINGS_PATH, { optional: true });

  let snapshot;
  if (isPlainObject(searchManifest)) {
    const clipFile =
      embeddingsManifest?.clip?.file ?? searchManifest?.clip?.file ?? null;
    const clapFile =
      embeddingsManifest?.clap?.file ?? searchManifest?.clap?.file ?? null;

    snapshot = buildSnapshot({
      source: "local",
      searchManifest,
      conceptsDocument,
      embeddingsManifest,
      clip: clipFile ? loadLocalBin(clipFile) : null,
      clap: clapFile ? loadLocalBin(clapFile) : null,
      legacyRecords: null,
    });
  } else {
    snapshot = buildSnapshot({
      source: "legacy",
      searchManifest: null,
      conceptsDocument,
      embeddingsManifest,
      clip: null,
      clap: null,
      legacyRecords: loadIndex().items.map(legacyAsset),
    });
  }

  localCache = { signature, snapshot };
  return snapshot;
}

function loadLocalCatalogIfPresent() {
  return hasLocalCatalog() ? loadLocalCatalog() : null;
}

/* --------------------------------------------------------------------------
 * Remote search catalog loading
 * ----------------------------------------------------------------------- */

const remoteState = {
  snapshot: null,
  loadedAt: 0,
  failure: null,
  failedAt: 0,
  slots: {
    search: { url: null, value: undefined },
    concepts: { url: null, value: undefined },
    embeddings: { url: null, value: undefined },
    clip: { url: null, data: undefined },
    clap: { url: null, data: undefined },
  },
};

function describeFetchError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return `timed out after ${FETCH_TIMEOUT_MS} ms`;
  }
  return error?.message || String(error);
}

async function fetchResource(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Fetch failed for ${url}: ${describeFetchError(error)}`);
    }

    if (response.status === 304) {
      return {
        status: 304,
        notModified: true,
        headers: response.headers,
        buf: null,
      };
    }

    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      const error = new Error(
        `HTTP ${response.status}${statusText} for ${url}`,
      );
      error.status = response.status;
      throw error;
    }

    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new Error(`Reading ${url} failed: ${describeFetchError(error)}`);
    }

    return { status: response.status, buf: buffer, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function conditionalHeaders(slot, url, hasCachedValue) {
  const headers = {};
  if (!slot || slot.url !== url || !hasCachedValue) return headers;
  if (slot.etag) headers["If-None-Match"] = slot.etag;
  if (slot.lastModified) headers["If-Modified-Since"] = slot.lastModified;
  return headers;
}

async function fetchJsonSlot(url, slot, { optional = false } = {}) {
  const headers = conditionalHeaders(
    slot,
    url,
    slot?.value !== undefined && slot.value !== null,
  );

  let result;
  try {
    result = await fetchResource(url, headers);
  } catch (error) {
    if (optional && error.status === 404) {
      return { url, value: null, etag: null, lastModified: null };
    }
    throw error;
  }

  if (result.notModified) {
    return { ...slot, url };
  }

  let value;
  try {
    value = JSON.parse(result.buf.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (optional) {
      log(`Ignoring invalid JSON at ${url}: ${error.message}`);
      return { url, value: null, etag: null, lastModified: null };
    }
    throw new Error(`Invalid JSON at ${url}: ${error.message}`);
  }

  return {
    url,
    value,
    etag: result.headers.get("etag"),
    lastModified: result.headers.get("last-modified"),
  };
}

async function fetchBinarySlot(url, slot, { optional = true } = {}) {
  if (!url) return { url: null, data: null, etag: null, lastModified: null };

  const headers = conditionalHeaders(
    slot,
    url,
    slot?.data !== undefined && slot.data !== null,
  );

  let result;
  try {
    result = await fetchResource(url, headers);
  } catch (error) {
    if (optional && error.status === 404) {
      return { url, data: null, etag: null, lastModified: null };
    }
    throw error;
  }

  if (result.notModified) {
    return { ...slot, url };
  }

  return {
    url,
    data: float32FromBuffer(result.buf),
    etag: result.headers.get("etag"),
    lastModified: result.headers.get("last-modified"),
  };
}

function remoteDataUrl(fileName) {
  const raw = String(fileName ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const base = new URL(LIBRARY_URL);
      return url.origin === base.origin ? url.toString() : null;
    } catch {
      return null;
    }
  }

  if (raw.startsWith("/")) {
    try {
      return new URL(raw, LIBRARY_URL).toString();
    } catch {
      return null;
    }
  }

  const segments = raw.replace(/^\.\//, "").split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return null;
  }

  const relative =
    segments[0].toLowerCase() === "catalog"
      ? segments
      : ["catalog", ...segments];

  return `${LIBRARY_URL}${relative.map(encodeURIComponent).join("/")}`;
}

function remoteCatalogUrl(name) {
  return `${LIBRARY_URL}catalog/${segmentsForUrl([name])}`;
}

function segmentsForUrl(segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

async function loadRemoteCatalog() {
  const now = Date.now();
  if (remoteState.snapshot && now - remoteState.loadedAt < CACHE_TTL_MS) {
    return remoteState.snapshot;
  }

  if (remoteState.failure && now - remoteState.failedAt < CACHE_TTL_MS) {
    throw remoteState.failure;
  }

  try {
    const search = await fetchJsonSlot(
      remoteCatalogUrl("search-index.json"),
      remoteState.slots.search,
    );
    remoteState.slots.search = search;

    if (!isPlainObject(search.value)) {
      throw new Error(
        `${remoteCatalogUrl("search-index.json")} must contain a JSON object`,
      );
    }

    const concepts = await fetchJsonSlot(
      remoteCatalogUrl("concepts.json"),
      remoteState.slots.concepts,
      { optional: true },
    );
    remoteState.slots.concepts = concepts;

    const embeddings = await fetchJsonSlot(
      remoteCatalogUrl("embeddings.json"),
      remoteState.slots.embeddings,
      { optional: true },
    );
    remoteState.slots.embeddings = embeddings;

    const manifest = search.value;
    const embeddingsManifest = isPlainObject(embeddings.value)
      ? embeddings.value
      : null;

    const clipFile =
      embeddingsManifest?.clip?.file ?? manifest?.clip?.file ?? null;
    const clapFile =
      embeddingsManifest?.clap?.file ?? manifest?.clap?.file ?? null;

    const [clipSlot, clapSlot] = await Promise.all([
      fetchBinarySlot(remoteDataUrl(clipFile), remoteState.slots.clip, {
        optional: true,
      }),
      fetchBinarySlot(remoteDataUrl(clapFile), remoteState.slots.clap, {
        optional: true,
      }),
    ]);
    remoteState.slots.clip = clipSlot;
    remoteState.slots.clap = clapSlot;

    const snapshot = buildSnapshot({
      source: "remote",
      searchManifest: manifest,
      conceptsDocument: concepts.value,
      embeddingsManifest,
      clip: clipSlot.data,
      clap: clapSlot.data,
      legacyRecords: null,
    });

    remoteState.snapshot = snapshot;
    remoteState.loadedAt = Date.now();
    remoteState.failure = null;
    return snapshot;
  } catch (error) {
    remoteState.failure = error;
    remoteState.failedAt = Date.now();
    throw error;
  }
}

let fallbackLogged = false;

async function loadCatalog() {
  if (REMOTE_ENABLED) {
    try {
      return await loadRemoteCatalog();
    } catch (error) {
      const local = loadLocalCatalogIfPresent();
      if (!fallbackLogged) {
        fallbackLogged = true;
        log(
          local
            ? `Remote catalog unavailable (${error.message}); using ${LIBRARY_ROOT}`
            : `Remote catalog unavailable (${error.message})`,
        );
      }
      if (local) return local;
      throw new UserInputError(
        `Search catalog unavailable. Remote: ${error.message}. No local catalog at ${CATALOG_DIR}.`,
      );
    }
  }

  return loadLocalCatalog();
}

/* --------------------------------------------------------------------------
 * Scoring
 * ----------------------------------------------------------------------- */

const CLIP_IMAGE_FLOOR = 0.22;
const CLAP_AUDIO_FLOOR = 0.1;

const KEYWORD_FIELDS = [
  ["title", 5],
  ["tags", 4],
  ["keywords", 3],
  ["summary", 2],
  ["prompt", 2],
  ["role", 1],
];

function queryTerms(query) {
  const terms = [];
  let rest = String(query ?? "");
  rest = rest.replace(/"([^"]+)"/g, (match, phrase) => {
    const words = tokenize(phrase);
    if (words.length > 0) terms.push({ text: words.join(" "), phrase: true });
    return " ";
  });

  for (const token of tokenize(rest)) {
    terms.push({ text: token, phrase: false });
  }

  const seen = new Set();
  return terms.filter((term) => {
    const key = `${term.phrase ? "p" : "t"}:${term.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function termInAsset(asset, term) {
  for (const field of Object.values(asset.searchFields)) {
    if (field.includes(term.text)) return true;
  }
  return false;
}

function keywordScore(asset, terms) {
  if (terms.length === 0) return 0;

  let total = 0;
  for (const term of terms) {
    if (!termInAsset(asset, term)) continue;

    let weight = 0;
    for (const [field, fieldWeight] of KEYWORD_FIELDS) {
      if (asset.searchFields[field].includes(term.text)) {
        weight += fieldWeight;
      }
    }
    total += Math.min(5, weight);
  }

  return total / (5 * terms.length);
}

function matchConcepts(concepts, query, terms) {
  if (concepts.length === 0) return [];

  const tokens = new Set();
  for (const term of terms) {
    if (!term.phrase) tokens.add(term.text);
  }

  const lower = String(query ?? "").toLowerCase();
  const matched = [];

  for (const concept of concepts) {
    let hit = false;

    for (const token of tokens) {
      if (concept.termSet.has(token)) {
        hit = true;
        break;
      }
    }

    if (!hit) {
      for (const term of concept.rawTerms) {
        if (term.includes(" ") && lower.includes(term)) {
          hit = true;
          break;
        }
      }
    }

    if (hit) matched.push(concept);
  }

  return matched;
}

function cosine(left, right, dim) {
  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < dim; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dotProduct += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (!leftNorm || !rightNorm) return 0;
  return dotProduct / Math.sqrt(leftNorm * rightNorm);
}

function meanConceptVector(concepts, field, snapshot) {
  const bin = field === "clip" ? snapshot.clip : snapshot.clap;
  if (!bin) return null;

  const wantsVisual = field === "clip";
  const vectors = [];
  for (const concept of concepts) {
    const modalities = concept.modalities ?? { visual: true, audio: true };
    if (wantsVisual ? !modalities.visual : !modalities.audio) continue;

    const entry = snapshot.conceptEmbeddings.get(concept.id);
    if (!entry) continue;
    const ref = entry[field];
    if (ref === null || ref === undefined) continue;
    const vector = vectorAt(bin, snapshot.dim, ref);
    if (vector) vectors.push(vector);
  }

  if (vectors.length === 0) return null;

  const sum = new Float32Array(snapshot.dim);
  for (const vector of vectors) {
    for (let index = 0; index < snapshot.dim; index += 1) {
      sum[index] += vector[index];
    }
  }

  let norm = 0;
  for (let index = 0; index < snapshot.dim; index += 1) {
    norm += sum[index] * sum[index];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let index = 0; index < snapshot.dim; index += 1) {
      sum[index] /= norm;
    }
  }

  return sum;
}

function semanticScoreFor(asset, queryClip, queryClap, snapshot) {
  const audio = asset.kind === "audio";
  const bin = audio ? snapshot.clap : snapshot.clip;
  const query = audio ? queryClap : queryClip;
  if (!bin || !query) return null;

  // Media vectors only. Text vectors are anisotropic and never score here.
  const field = audio ? "clapAudio" : "clipImage";
  const ref = embeddingRef(asset.embeddings, field);
  const vector = vectorAt(bin, snapshot.dim, ref);
  if (!vector) return null;

  const score = Math.max(0, cosine(query, vector, snapshot.dim));
  const floor = audio ? CLAP_AUDIO_FLOOR : CLIP_IMAGE_FLOOR;
  return score >= floor ? score : null;
}

function compareTitles(left, right) {
  return String(left.title).localeCompare(String(right.title), undefined, {
    sensitivity: "base",
  });
}

function roundScore(value) {
  return Number(value.toFixed(4));
}

/* --------------------------------------------------------------------------
 * Tool helpers
 * ----------------------------------------------------------------------- */

function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolTextError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function optionalString(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new UserInputError(`'${key}' must be a string.`);
  }
  return value.trim();
}

function requiredString(args, key) {
  const value = optionalString(args, key);
  if (!value) throw new UserInputError(`'${key}' is required and must be a non-empty string.`);
  return value;
}

function optionalTags(args) {
  const value = args.tags;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new UserInputError("'tags' must be an array of strings.");
  }
  return value.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
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

function optionalBoolean(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new UserInputError(`'${key}' must be a boolean.`);
  }
  return value;
}

function compactRecord(asset, score, matchedConcepts) {
  return {
    id: asset.id,
    title: asset.title,
    kind: asset.kind,
    role: asset.role,
    summary: asset.summary,
    tags: asset.tags,
    family: asset.family,
    license: asset.license,
    contributor: asset.contributor,
    score,
    matchedConcepts,
  };
}

/* --------------------------------------------------------------------------
 * search_assets
 * ----------------------------------------------------------------------- */

async function searchAssets(args) {
  if (args === undefined || args === null) args = {};
  if (!isPlainObject(args)) {
    throw new UserInputError("search_assets arguments must be an object.");
  }

  const query = optionalString(args, "query");
  const kind = optionalString(args, "kind").toLowerCase();
  const wantedTags = optionalTags(args);
  const limit = optionalLimit(args);

  const snapshot = await loadCatalog();

  const terms = query ? queryTerms(query) : [];
  const matchedConcepts =
    terms.length > 0 ? matchConcepts(snapshot.concepts, query, terms) : [];
  const matchedConceptIds = matchedConcepts.map((concept) => concept.id);

  const allowedModalities = { visual: true, audio: true };
  if (matchedConcepts.length > 0) {
    allowedModalities.visual = false;
    allowedModalities.audio = false;
    for (const concept of matchedConcepts) {
      allowedModalities.visual =
        allowedModalities.visual || concept.modalities.visual;
      allowedModalities.audio =
        allowedModalities.audio || concept.modalities.audio;
    }
  }

  const queryClip = allowedModalities.visual
    ? meanConceptVector(matchedConcepts, "clip", snapshot)
    : null;
  const queryClap = allowedModalities.audio
    ? meanConceptVector(matchedConcepts, "clap", snapshot)
    : null;

  const candidates = [];

  for (const asset of snapshot.assets) {
    if (kind && asset.kind.toLowerCase() !== kind) continue;

    const assetModality = asset.kind === "audio" ? "audio" : "visual";
    if (!allowedModalities[assetModality]) continue;

    if (wantedTags.length > 0) {
      const assetTags = asset.tags.map((tag) => tag.toLowerCase());
      if (!wantedTags.every((tag) => assetTags.includes(tag))) continue;
    }

    const keyword = terms.length > 0 ? keywordScore(asset, terms) : 0;
    const all =
      terms.length > 0
        ? terms.every((term) => termInAsset(asset, term))
        : true;
    const any =
      terms.length > 0
        ? terms.some((term) => termInAsset(asset, term))
        : true;
    const semantic = semanticScoreFor(asset, queryClip, queryClap, snapshot);
    const score =
      semantic !== null ? 0.55 * semantic + 0.45 * keyword : keyword;

    candidates.push({ asset, keyword, all, any, semantic, score });
  }

  let chosen = [];

  if (terms.length === 0) {
    chosen = candidates;
  } else {
    const allTermMatches = candidates.filter(
      (entry) => entry.all && entry.keyword > 0,
    );
    const anyTermMatches = candidates.filter(
      (entry) => entry.any && entry.keyword > 0,
    );
    const keywordChosen =
      allTermMatches.length > 0 ? allTermMatches : anyTermMatches;

    const semanticChosen = candidates.filter(
      (entry) => entry.semantic !== null,
    );

    const merged = new Map();
    for (const entry of [...keywordChosen, ...semanticChosen]) {
      merged.set(entry.asset.id, entry);
    }
    chosen = [...merged.values()];
  }

  chosen.sort(
    (left, right) =>
      right.score - left.score || compareTitles(left.asset, right.asset),
  );

  const rows = chosen
    .slice(0, limit)
    .map((entry) =>
      compactRecord(
        entry.asset,
        roundScore(entry.score),
        matchedConceptIds,
      ),
    );

  const content = [{ type: "text", text: JSON.stringify(rows) }];

  if (chosen.length === 0 && terms.length > 0) {
    content.push({ type: "text", text: requestHint(query) });
  }

  return { content };
}

/* --------------------------------------------------------------------------
 * get_asset
 * ----------------------------------------------------------------------- */

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

const ASSET_METADATA_TTL_MS = 5 * 60 * 1000;
const assetMetadataCache = new Map();

function assetMetadataUrl(dir, fileName) {
  const segments = safeSegments(dir, "asset directory");
  return `${LIBRARY_URL}${segments
    .map((segment) => encodeURIComponent(segment))
    .join("/")}/${encodeURIComponent(fileName)}`;
}

function searchEntryFor(record) {
  if (isPlainObject(record.raw)) return record.raw;

  return {
    id: record.id,
    kind: record.kind ?? "",
    role: record.role ?? "",
    title: record.title ?? "",
    summary: record.summary ?? "",
    tags: Array.isArray(record.tags) ? record.tags : [],
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    prompt: record.prompt ?? "",
    family: record.family ?? "",
    scope: record.scope ?? "",
    contributor: record.contributor ?? "",
    license: record.license ?? "",
    preview: record.preview ?? "",
    file: record.file ?? "",
    mime: record.mime ?? "",
    bytes: record.bytes ?? 0,
    sha256: record.sha256 ?? "",
    dir: record.dir ?? "",
    added: record.added ?? "",
    text: record.text ?? "",
    embeddings: isPlainObject(record.embeddings) ? record.embeddings : {},
  };
}

async function fetchRemoteAssetMetadata(record) {
  const jsonUrl = assetMetadataUrl(record.dir, "asset.json");

  let response;
  try {
    response = await fetchResource(jsonUrl);
  } catch (error) {
    if (error.status === 404) {
      return {
        asset: null,
        markdown: null,
        metadataUnavailable: true,
        note: `asset.json is not available at ${jsonUrl} (HTTP 404). Returning the search-index entry only.`,
      };
    }
    throw new UserInputError(`Cannot fetch ${jsonUrl}: ${error.message}`);
  }

  let asset;
  try {
    asset = JSON.parse(response.buf.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new UserInputError(`Invalid JSON at ${jsonUrl}: ${error.message}`);
  }
  if (!isPlainObject(asset)) {
    throw new UserInputError(`${jsonUrl} must contain a JSON object.`);
  }

  let markdown = null;
  let markdownError = null;
  const markdownUrl = assetMetadataUrl(record.dir, "asset.md");
  try {
    const markdownResponse = await fetchResource(markdownUrl);
    markdown = markdownResponse.buf
      .toString("utf8")
      .replace(/^\uFEFF/, "");
  } catch (error) {
    markdownError =
      error.status === 404
        ? "asset.md not found"
        : `Cannot fetch asset.md: ${error.message}`;
  }

  return { asset, markdown, markdownError, metadataUnavailable: false };
}

async function loadRemoteAssetMetadata(record) {
  const cached = assetMetadataCache.get(record.id);
  if (cached && Date.now() - cached.fetchedAt < ASSET_METADATA_TTL_MS) {
    return cached.metadata;
  }

  const metadata = await fetchRemoteAssetMetadata(record);
  assetMetadataCache.set(record.id, {
    fetchedAt: Date.now(),
    metadata,
  });
  return metadata;
}

async function getAsset(args) {
  if (!isPlainObject(args)) {
    throw new UserInputError("get_asset arguments must be an object.");
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new UserInputError("get_asset requires a non-empty string 'id'.");
  }

  let snapshot = null;
  let searchRecord = null;
  try {
    snapshot = await loadCatalog();
    searchRecord = snapshot.byId.get(id) ?? null;
  } catch (error) {
    log(`Search index unavailable while reading ${id}: ${error.message}`);
  }

  const record = searchRecord ?? loadIndex().byId.get(id) ?? null;
  if (!record) return toolError(`Asset not found: ${id}`);
  if (!record.dir) {
    return toolError(`Asset ${id} has no directory in the catalog index.`);
  }

  const searchIndex = searchEntryFor(searchRecord ?? record);
  const remoteSource = snapshot?.source === "remote" && Boolean(searchRecord);

  if (remoteSource) {
    let metadata;
    try {
      metadata = await loadRemoteAssetMetadata(record);
    } catch (error) {
      return toolError(error.message);
    }

    const payload = {
      id: record.id,
      dir: record.dir,
      asset: metadata.asset,
      markdown: metadata.markdown,
      searchIndex,
    };

    if (metadata.metadataUnavailable) {
      payload.metadataUnavailable = true;
      payload.note = metadata.note;
    } else if (metadata.markdownError) {
      payload.markdownError = metadata.markdownError;
    }

    return toolText(JSON.stringify(payload, null, 2));
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
    searchIndex,
  };
  if (markdownError) payload.markdownError = markdownError;

  return toolText(JSON.stringify(payload, null, 2));
}

/* --------------------------------------------------------------------------
 * Taxonomy
 * ----------------------------------------------------------------------- */

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

function rankConcepts(snapshot) {
  if (snapshot.conceptRanking) return snapshot.conceptRanking;

  const ranking = snapshot.concepts.map((concept) => {
    let count = 0;
    for (const asset of snapshot.assets) {
      for (const term of concept.tokens) {
        if (asset.allTokens.has(term)) {
          count += 1;
          break;
        }
      }
    }
    return {
      id: concept.id,
      label: concept.label,
      kind: concept.kind,
      modality: concept.modality,
      count,
    };
  });

  ranking.sort(
    (left, right) =>
      right.count - left.count || left.id.localeCompare(right.id),
  );

  snapshot.conceptRanking = ranking;
  return ranking;
}

async function listTaxonomy() {
  const facetsDirectory = path.join(CATALOG_DIR, "facets");
  const collectionsDirectory = path.join(CATALOG_DIR, "collections");

  const facets = markdownFiles(facetsDirectory).map((filename) =>
    readTaxonomyEntry(facetsDirectory, filename, false),
  );
  const collections = markdownFiles(collectionsDirectory).map((filename) =>
    readTaxonomyEntry(collectionsDirectory, filename, true),
  );

  let families = [];
  let topConcepts = [];
  let conceptCount = 0;
  let catalogSource = "unavailable";

  try {
    const snapshot = await loadCatalog();
    catalogSource = snapshot.source;
    conceptCount = snapshot.concepts.length;

    const familyCounts = new Map();
    for (const asset of snapshot.assets) {
      const family = asset.family.trim();
      if (!family) continue;
      familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }

    families = [...familyCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.name.localeCompare(right.name),
      )
      .slice(0, 50);

    topConcepts = rankConcepts(snapshot).slice(0, 20);
  } catch (error) {
    log(`Taxonomy enrichment unavailable: ${error.message}`);
  }

  return toolText(
    JSON.stringify(
      {
        facets,
        collections,
        families,
        topConcepts,
        conceptCount,
        catalogSource,
      },
      null,
      2,
    ),
  );
}

/* --------------------------------------------------------------------------
 * checkout_pack
 * ----------------------------------------------------------------------- */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safeSegments(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new UserInputError(`${label} must be a non-empty string.`);
  }

  const raw = value.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new UserInputError(`${label} must be relative: ${value}`);
  }

  const segments = raw.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.includes("\0"),
    )
  ) {
    throw new UserInputError(`${label} must not contain '.' or '..': ${value}`);
  }

  return segments;
}

function safeFileName(name, label) {
  const value = String(name ?? "").trim();
  if (
    !value ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    WINDOWS_RESERVED.test(value)
  ) {
    throw new UserInputError(`${label} is not a safe file name: ${name}`);
  }
  return value;
}

function validateAssetId(value) {
  if (typeof value !== "string") {
    throw new UserInputError("Every id in 'ids' must be a string.");
  }
  const id = value.trim();
  if (
    !id ||
    id.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
  ) {
    throw new UserInputError(`Invalid asset id: ${value}`);
  }
  return id;
}

function resolveOutDir(value) {
  const requested = typeof value === "string" ? value.trim() : "";

  if (!requested) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = crypto.randomBytes(3).toString("hex");
    return path.join(os.tmpdir(), `meesa-pack-${stamp}-${suffix}`);
  }

  if (/[\0*?"<>|]/.test(requested)) {
    throw new UserInputError(`'outDir' contains invalid characters: ${value}`);
  }

  const segments = requested.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    throw new UserInputError("'outDir' must not contain '..'.");
  }

  const resolved = path.resolve(requested);
  if (resolved === path.parse(resolved).root) {
    throw new UserInputError("'outDir' must not be a filesystem root.");
  }
  if (resolved === LIBRARY_ROOT) {
    throw new UserInputError("'outDir' must not be the library root.");
  }

  return resolved;
}

function assetRelativePath(asset, key) {
  const raw = key === "file" ? asset.file : asset.preview;
  if (!raw) return null;

  let relative = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = relative.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  if (segments.length === 1 && asset.dir) {
    relative = `${String(asset.dir).replace(/\\/g, "/").replace(/\/+$/, "")}/${segments[0]}`;
  }

  return safeSegments(relative, key === "file" ? "asset file" : "asset preview");
}

function localAssetPath(segments) {
  const target = path.resolve(LIBRARY_ROOT, ...segments);
  const relative = path.relative(LIBRARY_ROOT, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new UserInputError(
      `Asset path escapes the library root: ${segments.join("/")}`,
    );
  }
  return target;
}

function remoteAssetUrl(segments) {
  return `${LIBRARY_URL}${segmentsForUrl(segments)}`;
}

function normalizeHash(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
}

async function downloadRemoteToFile(segments, destination) {
  const url = remoteAssetUrl(segments);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Fetch failed for ${url}: ${describeFetchError(error)}`);
    }

    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      const error = new Error(`HTTP ${response.status}${statusText} for ${url}`);
      error.status = response.status;
      throw error;
    }
    if (!response.body) {
      throw new Error(`Empty response body for ${url}`);
    }

    const hash = crypto.createHash("sha256");
    const reader = response.body.getReader();
    const descriptor = fs.openSync(destination, "w");
    let bytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        fs.writeSync(descriptor, chunk);
        bytes += chunk.length;
      }
    } finally {
      fs.closeSync(descriptor);
    }

    return { bytes, sha256: hash.digest("hex"), source: "remote" };
  } catch (error) {
    try {
      fs.unlinkSync(destination);
    } catch {
      // Ignore cleanup failures.
    }
    if (error.status) throw error;
    throw new Error(`Download failed for ${url}: ${describeFetchError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function copyLocalToFile(segments, destination) {
  const source = localAssetPath(segments);
  let stats;
  try {
    stats = fs.statSync(source);
  } catch (error) {
    throw new Error(`Cannot read ${segments.join("/")}: ${error.message}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${segments.join("/")}`);
  }

  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(destination, "w");
  let bytes = 0;

  try {
    const stream = fs.createReadStream(source);
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      fs.writeSync(descriptor, buffer);
      bytes += buffer.length;
    }
  } catch (error) {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(destination);
    } catch {
      // Ignore cleanup failures.
    }
    throw new Error(`Cannot copy ${segments.join("/")}: ${error.message}`);
  }

  fs.closeSync(descriptor);
  return { bytes, sha256: hash.digest("hex"), source: "local" };
}

function localFileExists(segments) {
  try {
    return fs.statSync(localAssetPath(segments)).isFile();
  } catch {
    return false;
  }
}

async function downloadAssetFile(snapshot, segments, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (snapshot.source === "remote" && REMOTE_ENABLED) {
    try {
      return await downloadRemoteToFile(segments, destination);
    } catch (error) {
      if (localFileExists(segments)) {
        log(
          `Remote download failed for ${segments.join("/")}; using local copy`,
        );
        return copyLocalToFile(segments, destination);
      }
      throw error;
    }
  }

  return copyLocalToFile(segments, destination);
}

function walkFiles(directory, base = directory, output = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, output);
    } else if (entry.isFile()) {
      output.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }

  return output;
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function buildCredits(entries) {
  const lines = ["# Credits", ""];

  for (const entry of entries) {
    const contributor = entry.contributor || "Unattributed";
    const license = entry.license || "Unknown";
    lines.push(
      `- **${entry.title || entry.id}** (\`${entry.id}\`) - ${contributor} - ${license}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function buildLicense(entries, restrictedAcknowledged) {
  const byLicense = new Map();

  for (const entry of entries) {
    const license = entry.license || "Unknown";
    if (!byLicense.has(license)) byLicense.set(license, []);
    byLicense.get(license).push(entry.id);
  }

  const lines = ["Meesa asset pack licences", "=========================", ""];

  if (restrictedAcknowledged) {
    lines.push(
      "Restricted assets included with explicit acknowledgement.",
      "",
    );
  }

  for (const license of [...byLicense.keys()].sort()) {
    lines.push(license);
    lines.push("-".repeat(license.length));
    lines.push(`Applies to: ${byLicense.get(license).join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildPackReadme(entries, restrictedAcknowledged) {
  const lines = [
    "# Meesa asset pack",
    "",
    `${entries.length} asset(s) checked out from the Meesa Asset Library.`,
    "",
    "## Layout",
    "",
    "- `assets/<id>/` - downloaded original files.",
    "- `pack.json` - manifest, hashes and verification results.",
    "- `CREDITS.md` - contributor and licence per asset.",
    "- `LICENSE.txt` - licence summary for the pack.",
    "",
    "## Verify",
    "",
    "Compare each file against the `sha256` in `pack.json` before use.",
    "",
  ];

  if (restrictedAcknowledged) {
    lines.push(
      "This pack contains assets licensed LicenseRef-All-Rights-Reserved.",
      "Do not redistribute them.",
      "",
    );
  }

  return lines.join("\n");
}

function packNameFor(ids) {
  const slug = ids
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "asset-pack";
}

function fullBundlePath(dir, filePath) {
  const base = String(dir ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const raw = String(filePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!raw) return "";
  if (!base || raw === base || raw.startsWith(`${base}/`)) return raw;
  return `${base}/${raw}`;
}

function expectedHashFor(entry, manifest, segments, isPrimary) {
  const relative = segments.join("/");
  const baseName = segments[segments.length - 1];
  const candidates = [];

  if (isPlainObject(manifest) && Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      if (!isPlainObject(file)) continue;
      const sha = normalizeHash(file.sha256);
      if (!sha) continue;
      const full = fullBundlePath(entry.dir, asText(file.path));
      if (!full) continue;
      candidates.push({
        full,
        base: full.split("/").pop(),
        sha,
      });
    }
  }

  // The search-index hash always describes the primary file, never a preview.
  if (isPrimary) {
    const sha = normalizeHash(entry.sha256);
    if (sha) {
      const full = fullBundlePath("", entry.file);
      candidates.push({
        full,
        base: full.split("/").pop(),
        sha,
      });
    }
  }

  const exact = candidates.find((candidate) => candidate.full === relative);
  if (exact) return exact.sha;

  const byBase = candidates.find(
    (candidate) => candidate.base === baseName,
  );
  if (byBase) return byBase.sha;

  if (isPrimary && candidates.length === 1) return candidates[0].sha;
  return "";
}

async function loadCheckoutManifest(entry, snapshot) {
  if (snapshot.source === "remote") {
    try {
      const metadata = await loadRemoteAssetMetadata(entry);
      return isPlainObject(metadata.asset) ? metadata.asset : null;
    } catch (error) {
      log(`Cannot read remote asset.json for ${entry.id}: ${error.message}`);
      return null;
    }
  }

  try {
    const assetDir = resolveAssetDir(entry.dir);
    const text = fs.readFileSync(path.join(assetDir, "asset.json"), "utf8");
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    if (error.code !== "ENOENT") {
      log(`Cannot read asset.json for ${entry.id}: ${error.message}`);
    }
    return null;
  }
}

async function checkoutPack(args) {
  if (!isPlainObject(args)) {
    throw new UserInputError("checkout_pack arguments must be an object.");
  }

  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    throw new UserInputError("checkout_pack requires a non-empty 'ids' array.");
  }

  const ids = [];
  const seen = new Set();
  for (const value of args.ids) {
    const id = validateAssetId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const outDir = resolveOutDir(args.outDir);
  const includePreview = optionalBoolean(args, "includePreview", true);
  const acknowledgeRestricted = optionalBoolean(
    args,
    "acknowledgeRestricted",
    false,
  );

  const snapshot = await loadCatalog();
  const entries = [];

  for (const id of ids) {
    const entry = snapshot.byId.get(id);
    if (!entry) throw new UserInputError(`Asset not found: ${id}`);
    entries.push(entry);
  }

  if (!acknowledgeRestricted) {
    const restricted = entries
      .filter(
        (entry) =>
          entry.license.trim().toLowerCase() ===
          RESTRICTED_LICENSE.toLowerCase(),
      )
      .map((entry) => entry.id);
    if (restricted.length > 0) {
      throw new UserInputError(
        `Refusing LicenseRef-All-Rights-Reserved assets: ${restricted.join(", ")}. ` +
          "Pass acknowledgeRestricted: true to include them.",
      );
    }
  }

  let existing = null;
  try {
    existing = fs.statSync(outDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new UserInputError(`Cannot use outDir ${outDir}: ${error.message}`);
    }
  }
  if (existing && !existing.isDirectory()) {
    throw new UserInputError(`outDir is not a directory: ${outDir}`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const restrictedIds = entries
    .filter(
      (entry) =>
        entry.license.trim().toLowerCase() ===
        RESTRICTED_LICENSE.toLowerCase(),
    )
    .map((entry) => entry.id);
  const restrictedAcknowledged = acknowledgeRestricted === true;
  const restrictedIncluded = restrictedIds.length > 0;

  const verification = [];
  const failures = [];
  const primaryPathById = new Map();
  let totalBytes = 0;

  for (const entry of entries) {
    const fileSegments = assetRelativePath(entry, "file");
    if (!fileSegments) {
      failures.push({ id: entry.id, error: "Asset has no 'file' in the catalog." });
      continue;
    }

    // Resolve hashes from the search-index entry and the asset.json files[]
    // block. The deployed search index stores sha256: null for some assets even
    // though asset.json has the authoritative primary hash.
    const manifest = await loadCheckoutManifest(entry, snapshot);

    const requested = [
      {
        kind: "file",
        segments: fileSegments,
        expected: expectedHashFor(entry, manifest, fileSegments, true),
      },
    ];

    if (includePreview) {
      const previewSegments = assetRelativePath(entry, "preview");
      if (previewSegments) {
        requested.push({
          kind: "preview",
          segments: previewSegments,
          expected: expectedHashFor(entry, manifest, previewSegments, false),
        });
      }
    }

    const assetDir = path.join(outDir, "assets", entry.id);
    const usedNames = new Set();

    for (const item of requested) {
      const baseName = safeFileName(
        item.segments[item.segments.length - 1],
        item.kind === "file" ? "asset file name" : "asset preview name",
      );
      let fileName = baseName;
      if (usedNames.has(fileName) && item.kind === "preview") {
        fileName = `preview-${baseName}`;
      }
      usedNames.add(fileName);

      const destination = path.join(assetDir, fileName);
      const relativeDestination = path
        .relative(outDir, destination)
        .split(path.sep)
        .join("/");
      const isPrimary = item.kind === "file";
      if (isPrimary) primaryPathById.set(entry.id, relativeDestination);

      try {
        const result = await downloadAssetFile(
          snapshot,
          item.segments,
          destination,
        );

        let verified;
        let status;
        if (item.expected) {
          if (result.sha256 === item.expected) {
            verified = true;
            status = "verified";
          } else {
            verified = false;
            status = "mismatch";
          }
        } else if (isPrimary) {
          verified = false;
          status = "unverified";
        } else {
          // Previews usually have no catalog hash. Record the computed hash so
          // the pack is still self-verifying.
          verified = true;
          status = "verified";
        }

        if (status === "mismatch") {
          try {
            fs.unlinkSync(destination);
          } catch {
            // Ignore cleanup failures.
          }
          failures.push({
            id: entry.id,
            file: item.segments.join("/"),
            error: `SHA-256 mismatch: expected ${item.expected}, received ${result.sha256}`,
          });
          verification.push({
            id: entry.id,
            kind: item.kind,
            file: item.segments.join("/"),
            path: relativeDestination,
            bytes: result.bytes,
            sha256: result.sha256,
            expected: item.expected,
            status,
            verified: false,
            source: result.source,
            written: false,
          });
          continue;
        }

        if (status === "unverified") {
          failures.push({
            id: entry.id,
            file: item.segments.join("/"),
            error: "No expected SHA-256 in the search index or asset.json.",
          });
        }

        totalBytes += result.bytes;
        verification.push({
          id: entry.id,
          kind: item.kind,
          file: item.segments.join("/"),
          path: relativeDestination,
          bytes: result.bytes,
          sha256: result.sha256,
          expected: item.expected || null,
          status,
          verified,
          source: result.source,
          written: true,
        });
      } catch (error) {
        failures.push({
          id: entry.id,
          file: item.segments.join("/"),
          error: error.message,
        });
        verification.push({
          id: entry.id,
          kind: item.kind,
          file: item.segments.join("/"),
          path: relativeDestination,
          bytes: 0,
          sha256: "",
          expected: item.expected || null,
          status: "error",
          verified: false,
          source: null,
          written: false,
        });
      }
    }
  }

  const written = verification.filter((item) => item.written);
  const payloadFileCount = written.length;
  const allVerified =
    failures.length === 0 &&
    verification.length > 0 &&
    verification.every((item) => item.verified);

  const restrictedNote = restrictedIncluded && restrictedAcknowledged;

  writeText(path.join(outDir, "CREDITS.md"), buildCredits(entries));
  writeText(
    path.join(outDir, "LICENSE.txt"),
    buildLicense(entries, restrictedNote),
  );
  writeText(
    path.join(outDir, "README.md"),
    buildPackReadme(entries, restrictedNote),
  );

  const metadataFiles = ["pack.json", "CREDITS.md", "LICENSE.txt", "README.md"];
  const createdAt = new Date().toISOString();
  const name = packNameFor(ids);

  const assetRecords = entries.map((entry) => {
    const assetFiles = written.filter((item) => item.id === entry.id);
    const primary = assetFiles.find((item) => item.kind === "file");
    return {
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      role: entry.role,
      family: entry.family,
      contributor: entry.contributor || "",
      license: entry.license || "",
      file: entry.file,
      preview: entry.preview,
      sha256: primary?.sha256 ?? normalizeHash(entry.sha256),
      path: primary?.path ?? primaryPathById.get(entry.id) ?? "",
      files: assetFiles.map((item) => ({
        path: item.path,
        sha256: item.sha256,
        bytes: item.bytes,
        expected: item.expected,
        verified: item.verified,
        status: item.status,
        kind: item.kind,
        source: item.source,
      })),
    };
  });

  const pack = {
    version: 1,
    name,
    query: null,
    ids,
    format: "meesa-asset-pack/1",
    created: createdAt,
    source: {
      kind: snapshot.source,
      libraryUrl: REMOTE_ENABLED ? LIBRARY_URL : null,
    },
    restrictedAcknowledged,
    restrictedAssets: restrictedIds,
    contactSheet: false,
    notes: [],
    assets: assetRecords,
    totals: {
      assets: entries.length,
      files: payloadFileCount,
      bytes: totalBytes,
      verified: allVerified,
    },
    verification: {
      allVerified,
      failures,
    },
  };

  writeText(
    path.join(outDir, "pack.json"),
    `${JSON.stringify(pack, null, 2)}\n`,
  );

  const finalCount = walkFiles(outDir).length;

  const payload = {
    outDir,
    version: 1,
    name,
    fileCount: finalCount,
    payloadFileCount,
    bytes: totalBytes,
    totals: pack.totals,
    assets: assetRecords.map((asset) => ({
      id: asset.id,
      title: asset.title,
      license: asset.license,
      contributor: asset.contributor,
      sha256: asset.sha256,
      path: asset.path,
    })),
    verification,
    failures,
    allVerified,
    metadataFiles,
    restrictedAcknowledged,
    restrictedAssets: restrictedIds,
  };

  const text = JSON.stringify(payload, null, 2);
  return failures.length > 0 ? toolTextError(text) : toolText(text);
}

/* --------------------------------------------------------------------------
 * request_asset
 * ----------------------------------------------------------------------- */

function buildIssueUrl(query, note) {
  const title = `Asset request: ${truncate(query, 80)}`;
  const bodyLines = [
    "Asset request from the Meesa Asset Library MCP server.",
    "",
    `Query: ${query}`,
  ];

  if (note) {
    bodyLines.push("", "Additional context:", note);
  }

  bodyLines.push(
    "",
    "Please describe what the asset should contain, when it would be used, and any style or format constraints.",
  );

  const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
  url.searchParams.set("title", title);
  url.searchParams.set("body", bodyLines.join("\n"));
  return url.toString();
}

function requestHint(query) {
  const url = buildIssueUrl(query, "");
  return `No assets matched "${query}". Request it with request_asset, or open: ${url}`;
}

function requestAsset(args) {
  if (!isPlainObject(args)) {
    throw new UserInputError("request_asset arguments must be an object.");
  }

  const query = requiredString(args, "query");
  const note = optionalString(args, "note");

  return toolText(
    JSON.stringify(
      {
        url: buildIssueUrl(query, note),
        query,
        note: note || null,
        action: "Open the URL to review and submit the request. Nothing was posted.",
      },
      null,
      2,
    ),
  );
}

/* --------------------------------------------------------------------------
 * Dispatch
 * ----------------------------------------------------------------------- */

async function callTool(name, args) {
  switch (name) {
    case "search_assets":
      return searchAssets(args);
    case "get_asset":
      return getAsset(args);
    case "list_taxonomy":
      return listTaxonomy();
    case "checkout_pack":
      return checkoutPack(args);
    case "request_asset":
      return requestAsset(args);
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

async function handleToolsCall(id, params) {
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
    return response(id, await callTool(name, params.arguments ?? {}));
  } catch (error) {
    if (error instanceof UserInputError) {
      return response(id, toolError(error.message));
    }

    log(`Tool ${name} failed: ${error.stack || error.message || error}`);
    return response(id, toolError(`Tool ${name} failed: ${error.message || error}`));
  }
}

async function handleMessage(message) {
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

async function handleLine(line) {
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
    reply = await handleMessage(message);
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
let workQueue = Promise.resolve();

function enqueueLine(line) {
  workQueue = workQueue
    .then(() => handleLine(line))
    .catch((error) => {
      log(`Request handling failed: ${error.stack || error.message || error}`);
    });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;

  let newlineIndex;
  while ((newlineIndex = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    enqueueLine(line);
  }
});

process.stdin.on("end", () => {
  if (inputBuffer.length > 0) {
    enqueueLine(inputBuffer.replace(/\r$/, ""));
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
