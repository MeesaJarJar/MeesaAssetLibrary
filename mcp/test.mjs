#!/usr/bin/env node
/**
 * End-to-end smoke test for the Meesa Asset Library MCP server.
 *
 * Tests the real catalog when it has records. If the catalog is missing or
 * empty, data-dependent checks are skipped and only protocol checks run.
 *
 * Run with --fixture to exercise every check against a temporary, generated
 * library under the OS temp directory. The real library is never modified.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const USE_FIXTURE = process.argv.includes("--fixture");
const REQUEST_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 5000;

let fixtureDir = null;
let libraryRoot = REPO_ROOT;

if (USE_FIXTURE) {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "meesa-mcp-fixture-"));
  buildFixture(fixtureDir);
  libraryRoot = fixtureDir;
}

const indexPath = path.join(libraryRoot, "catalog", "index.jsonl");
const hasData = countIndexRecords(indexPath) > 0;

console.log("Meesa Asset Library MCP test");
console.log(`  server:       ${path.join(HERE, "server.mjs")}`);
console.log(
  `  library root: ${libraryRoot}${USE_FIXTURE ? " (temporary fixture)" : ""}`,
);
console.log("");

const env = { ...process.env };
if (USE_FIXTURE) {
  env.MEESA_LIBRARY_ROOT = libraryRoot;
} else {
  // Test the server's default root detection, not an inherited override.
  delete env.MEESA_LIBRARY_ROOT;
}

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: HERE,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdoutBuffer = "";
let stderrText = "";
let spawnError = null;
const stdoutNoise = [];

const pending = new Map();
const orphans = [];
const orphanWaiters = [];

let nextId = 1;
let closeInfo = null;
let resolveClose;
const closePromise = new Promise((resolve) => {
  resolveClose = resolve;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;

  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stdoutNoise.push(line);
      continue;
    }

    dispatch(message);
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrText += chunk;
});

child.on("error", (error) => {
  spawnError = error;
  rejectAllPending(`Failed to spawn server: ${error.message}`);
});

child.once("close", (code, signal) => {
  closeInfo = { code, signal };
  resolveClose(closeInfo);
  rejectAllPending(
    `Server exited before responding (code ${code}, signal ${signal})`,
  );
});

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

function fail(name, detail) {
  failed += 1;
  failures.push({ name, detail });
  console.log(`FAIL ${name}`);
  if (detail) {
    const indented = String(detail)
      .split(/\r?\n/)
      .map((line) => `     ${line}`)
      .join("\n");
    console.log(indented);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name} (${reason})`);
}

async function check(name, fn) {
  try {
    const note = await fn();
    pass(name);
    if (note) console.log(`     ${note}`);
    return true;
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dispatch(message) {
  const hasId =
    message !== null &&
    typeof message === "object" &&
    message.id !== undefined &&
    message.id !== null;
  const key = hasId ? String(message.id) : null;

  if (key !== null && pending.has(key)) {
    const waiter = pending.get(key);
    pending.delete(key);
    waiter.resolve(message);
    return;
  }

  if (orphanWaiters.length > 0) {
    orphanWaiters.shift().resolve(message);
  } else {
    orphans.push(message);
  }
}

function rejectAllPending(message) {
  for (const [key, waiter] of pending) {
    pending.delete(key);
    waiter.reject(new Error(message));
  }
  for (const waiter of orphanWaiters.splice(0)) {
    waiter.reject(new Error(message));
  }
}

function writeLine(text, eol = "\n") {
  if (!child.stdin.writable) {
    throw new Error("Server stdin is not writable.");
  }
  child.stdin.write(`${text}${eol}`);
}

function waitForResponse(id, method) {
  return new Promise((resolve, reject) => {
    const key = String(id);
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS} ms waiting for ${method}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(key, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function request(method, params, options = {}) {
  const id = nextId;
  nextId += 1;
  const promise = waitForResponse(id, method);

  const message = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  writeLine(JSON.stringify(message), options.eol ?? "\n");

  return promise;
}

function notify(method, params) {
  const message = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  writeLine(JSON.stringify(message));
}

function nextOrphan() {
  if (orphans.length > 0) return Promise.resolve(orphans.shift());

  return new Promise((resolve, reject) => {
    let settled = false;
    const waiter = {
      resolve: (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(message);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = orphanWaiters.indexOf(waiter);
      if (index !== -1) orphanWaiters.splice(index, 1);
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS} ms waiting for a response`));
    }, REQUEST_TIMEOUT_MS);

    orphanWaiters.push(waiter);
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function contentText(res) {
  assert(
    res && !res.error,
    `JSON-RPC error: ${res?.error?.message ?? "missing response"}`,
  );
  assert(
    Array.isArray(res.result?.content) && res.result.content.length > 0,
    "tool result has no content",
  );

  const first = res.result.content[0];
  assert(
    first?.type === "text" && typeof first.text === "string",
    "tool result content is not a text block",
  );
  return first.text;
}

function countIndexRecords(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return text.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function countMarkdownFiles(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .length;
  } catch {
    return 0;
  }
}

let firstAsset = null;

try {
  await check("initialize returns serverInfo.name", async () => {
    // A blank CRLF line must be ignored; the request itself uses CRLF framing.
    writeLine("", "\r\n");

    const res = await request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "meesa-mcp-test", version: "0.1.0" },
      },
      { eol: "\r\n" },
    );

    assert(res && !res.error, `initialize failed: ${res?.error?.message}`);
    assert(
      res.result?.protocolVersion === "2024-11-05",
      `unexpected protocolVersion: ${res.result?.protocolVersion}`,
    );
    assert(
      res.result?.capabilities && typeof res.result.capabilities.tools === "object",
      "initialize did not advertise a tools capability",
    );
    assert(
      res.result?.serverInfo?.name === "meesa-asset-library",
      `unexpected serverInfo.name: ${res.result?.serverInfo?.name}`,
    );
    assert(
      res.result?.serverInfo?.version === "0.1.0",
      `unexpected serverInfo.version: ${res.result?.serverInfo?.version}`,
    );

    notify("notifications/initialized");
  });

  await check("tools/list returns the three tools", async () => {
    const res = await request("tools/list");
    assert(res && !res.error, `tools/list failed: ${res?.error?.message}`);

    const tools = res.result?.tools;
    assert(Array.isArray(tools), "tools/list did not return an array");
    assert(tools.length === 3, `expected 3 tools, received ${tools.length}`);

    const expected = ["search_assets", "get_asset", "list_taxonomy"];
    const names = tools.map((tool) => tool.name);
    for (const name of expected) {
      assert(names.includes(name), `missing tool: ${name}`);
    }

    const search = tools.find((tool) => tool.name === "search_assets");
    assert(search?.inputSchema?.type === "object", "search_assets has no object schema");
    assert(
      search.inputSchema.properties?.limit?.default === 20,
      "search_assets limit default is not 20",
    );
    assert(
      search.inputSchema.properties?.limit?.maximum === 100,
      "search_assets limit maximum is not 100",
    );

    const get = tools.find((tool) => tool.name === "get_asset");
    assert(
      Array.isArray(get?.inputSchema?.required) &&
        get.inputSchema.required.includes("id"),
      "get_asset does not require id",
    );
  });

  await check("unknown tool returns -32602", async () => {
    const res = await request("tools/call", {
      name: "definitely_not_a_tool",
      arguments: {},
    });
    assert(res?.error, "unknown tool did not return a JSON-RPC error");
    assert(
      res.error.code === -32602,
      `expected error code -32602, received ${res.error.code}`,
    );
  });

  if (!hasData) {
    skip(
      "search_assets finds 'mossy'",
      `catalog/index.jsonl is missing or empty: ${indexPath}`,
    );
  } else {
    await check("search_assets finds 'mossy'", async () => {
      const res = await request("tools/call", {
        name: "search_assets",
        arguments: { query: "mossy" },
      });
      const text = contentText(res);
      assert(res.result.isError !== true, `tool returned isError: ${text}`);

      const rows = JSON.parse(text);
      assert(Array.isArray(rows), "search result is not a JSON array");
      assert(rows.length > 0, "no assets matched 'mossy'");

      firstAsset = rows[0];
      assert(
        typeof firstAsset.id === "string" && firstAsset.id.length > 0,
        "first result has no string id",
      );

      for (const key of ["id", "title", "kind", "role", "summary", "tags", "dir"]) {
        assert(key in firstAsset, `compact result is missing '${key}'`);
      }
      assert(
        !("preview" in firstAsset) && !("bytes" in firstAsset),
        "search result is not compact",
      );
    });
  }

  if (!hasData) {
    skip("get_asset returns the first id", "catalog/index.jsonl is missing or empty");
  } else if (!firstAsset) {
    skip("get_asset returns the first id", "search did not produce an asset id");
  } else {
    await check("get_asset returns the first id", async () => {
      const res = await request("tools/call", {
        name: "get_asset",
        arguments: { id: firstAsset.id },
      });
      const text = contentText(res);
      assert(res.result.isError !== true, `tool returned isError: ${text}`);
      assert(
        text.includes(firstAsset.id),
        `response does not contain the requested id ${firstAsset.id}`,
      );

      const payload = JSON.parse(text);
      assert(payload.id === firstAsset.id, "payload id does not match the request");
      assert(
        payload.asset && typeof payload.asset === "object" && !Array.isArray(payload.asset),
        "payload has no asset object",
      );
      assert(
        typeof payload.markdown === "string" && payload.markdown.length > 0,
        "payload has no asset.md text",
      );
    });
  }

  await check("list_taxonomy returns taxonomy data", async () => {
    const res = await request("tools/call", {
      name: "list_taxonomy",
      arguments: {},
    });
    const text = contentText(res);
    assert(res.result.isError !== true, `tool returned isError: ${text}`);
    assert(text.trim().length > 0, "list_taxonomy returned empty text");

    const taxonomy = JSON.parse(text);
    assert(Array.isArray(taxonomy.facets), "taxonomy.facets is not an array");
    assert(
      Array.isArray(taxonomy.collections),
      "taxonomy.collections is not an array",
    );

    const expectedFacets = countMarkdownFiles(
      path.join(libraryRoot, "catalog", "facets"),
    );
    const expectedCollections = countMarkdownFiles(
      path.join(libraryRoot, "catalog", "collections"),
    );
    assert(
      taxonomy.facets.length === expectedFacets,
      `expected ${expectedFacets} facets, received ${taxonomy.facets.length}`,
    );
    assert(
      taxonomy.collections.length === expectedCollections,
      `expected ${expectedCollections} collections, received ${taxonomy.collections.length}`,
    );

    if (USE_FIXTURE) {
      assert(taxonomy.facets.length > 0, "fixture returned no facets");
      assert(taxonomy.collections.length > 0, "fixture returned no collections");
    }
  });

  if (USE_FIXTURE) {
    await check("search_assets filters by kind and tags", async () => {
      const tagged = await request("tools/call", {
        name: "search_assets",
        arguments: {
          tags: ["subject:environment/stone", "palette:mossy-green"],
        },
      });
      const taggedRows = JSON.parse(contentText(tagged));
      assert(
        taggedRows.length === 1 && taggedRows[0].id === "IMG-TILE-000001",
        "all-tags filter did not return exactly the mossy stone tile",
      );

      const impossible = await request("tools/call", {
        name: "search_assets",
        arguments: {
          tags: ["subject:environment/stone", "palette:missing"],
        },
      });
      assert(
        JSON.parse(contentText(impossible)).length === 0,
        "tag filter matched when one required tag was absent",
      );

      const models = await request("tools/call", {
        name: "search_assets",
        arguments: { kind: "model" },
      });
      const modelRows = JSON.parse(contentText(models));
      assert(
        modelRows.length === 1 && modelRows[0].kind === "model",
        "kind filter did not return exactly the model asset",
      );
    });

    await check("search_assets reloads a changed index", async () => {
      const extra = {
        id: "IMG-TILE-000003",
        kind: "image",
        role: "tile",
        title: "Obsidian Shard Tile",
        summary: "Glossy black volcanic shard tile.",
        tags: ["subject:environment/stone", "palette:obsidian"],
        preview: "preview.svg",
        dir: "assets/image/tile/000003-obsidian-shard",
        bytes: 1024,
        added: "2026-11-20T12:00:00Z",
      };

      fs.appendFileSync(indexPath, `${JSON.stringify(extra)}\n`, "utf8");
      const now = new Date();
      fs.utimesSync(indexPath, now, new Date(now.getTime() + 2000));

      const res = await request("tools/call", {
        name: "search_assets",
        arguments: { query: "obsidian" },
      });
      const text = contentText(res);
      assert(res.result.isError !== true, `tool returned isError: ${text}`);

      const rows = JSON.parse(text);
      assert(
        rows.some((row) => row.id === extra.id),
        "new catalog record was not discovered after the index mtime changed",
      );
    });
  }

  await check("unknown method returns -32601", async () => {
    const res = await request("definitely_not_a_method");
    assert(res?.error, "unknown method did not return a JSON-RPC error");
    assert(
      res.error.code === -32601,
      `expected error code -32601, received ${res.error.code}`,
    );
  });

  await check("malformed JSON returns -32700 and keeps running", async () => {
    writeLine("{ this is not json }");
    const res = await nextOrphan();
    assert(res?.error, "malformed JSON did not return a JSON-RPC error");
    assert(
      res.error.code === -32700,
      `expected error code -32700, received ${res.error.code}`,
    );
    assert(res.id === null, "parse error response id should be null");

    const ping = await request("ping");
    assert(ping && !ping.error, `ping failed after parse error: ${ping?.error?.message}`);
    assert(
      ping.result && typeof ping.result === "object",
      "ping did not return an object result",
    );
    assert(Object.keys(ping.result).length === 0, "ping result should be {}");
  });

  await check("clean shutdown on stdin EOF", async () => {
    if (spawnError) throw spawnError;

    child.stdin.end();
    const info = await withTimeout(
      closePromise,
      SHUTDOWN_TIMEOUT_MS,
      `server did not exit within ${SHUTDOWN_TIMEOUT_MS} ms after stdin EOF`,
    );

    assert(
      info.code === 0,
      `expected exit code 0, received ${info.code} (signal ${info.signal})`,
    );
    assert(info.signal === null, `server was terminated by signal ${info.signal}`);
    assert(
      stdoutNoise.length === 0,
      `server wrote non-JSON data to stdout: ${stdoutNoise[0]}`,
    );
    assert(
      stdoutBuffer.trim() === "",
      `server left an unterminated line on stdout: ${stdoutBuffer}`,
    );
    assert(
      !/unhandled|uncaught/i.test(stderrText),
      `stderr reported an unhandled error:\n${stderrText.trim()}`,
    );
  });

  if (spawnError) throw spawnError;
} catch (error) {
  fail("test harness", error instanceof Error ? error.stack : String(error));

  if (!closeInfo) {
    try {
      child.kill();
    } catch {
      // The process may already have exited.
    }
  }
} finally {
  if (!closeInfo) {
    try {
      child.kill();
    } catch {
      // The process may already have exited.
    }
    try {
      await withTimeout(closePromise, 2000, "close timeout");
    } catch {
      // Best effort cleanup; the test result is already recorded.
    }
  }

  if (fixtureDir) {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove fixture directory: ${error.message}`);
    }
  }

  console.log("");
  console.log(
    `Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) {
      console.log(`  - ${failure.name}`);
    }
  }

  if (stderrText.trim()) {
    console.log("");
    console.log("Server stderr:");
    console.log(
      stderrText
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

/* --------------------------------------------------------------------------
 * Temporary fixture
 * ----------------------------------------------------------------------- */

function writeFixture(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function buildFixture(root) {
  const records = [
    {
      id: "IMG-TILE-000001",
      kind: "image",
      role: "tile",
      title: "Mossy Stone Wall Tile",
      summary: "Seamless mossy stone tile for dungeon walls.",
      tags: [
        "subject:environment/stone",
        "style:pixel-art",
        "use:tileset",
        "palette:mossy-green",
      ],
      preview: "preview.svg",
      dir: "assets/image/tile/000001-mossy-stone",
      bytes: 2048,
      added: "2026-11-20T10:00:00Z",
    },
    {
      id: "MDL-PROP-000002",
      kind: "model",
      role: "prop",
      title: "Brass Lantern",
      summary: "A warm brass lantern prop for interior scenes.",
      tags: ["subject:object/lantern", "style:painted", "use:prop"],
      preview: "preview.svg",
      dir: "assets/model/prop/000002-brass-lantern",
      bytes: 4096,
      added: "2026-11-20T11:00:00Z",
    },
  ];

  writeFixture(
    root,
    "catalog/index.jsonl",
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  for (const record of records) {
    writeFixture(
      root,
      path.join(record.dir, "asset.json"),
      `${JSON.stringify(
        {
          id: record.id,
          kind: record.kind,
          role: record.role,
          title: record.title,
          summary: record.summary,
          tags: record.tags,
          preview: record.preview,
          dir: record.dir,
          bytes: record.bytes,
          added: record.added,
        },
        null,
        2,
      )}\n`,
    );

    writeFixture(
      root,
      path.join(record.dir, "asset.md"),
      `# ${record.title}\n\n${record.summary}\n\n- Kind: ${record.kind}\n- Role: ${record.role}\n`,
    );
  }

  writeFixture(
    root,
    "catalog/facets/style.md",
    "---\nname: style\n---\n\n# Style\n\nVisual style and rendering facets.\n",
  );
  writeFixture(
    root,
    "catalog/facets/material.md",
    "# Material\n\nSurface material families such as stone and metal.\n",
  );
  writeFixture(
    root,
    "catalog/collections/dungeon-kit.md",
    "# Dungeon Kit\n\nCoordinated pieces for building dungeon interiors.\n",
  );
}
