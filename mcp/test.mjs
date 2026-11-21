#!/usr/bin/env node
/**
 * End-to-end test for the Meesa Asset Library MCP server.
 *
 * Default mode builds a temporary fixture library, runs the protocol, search,
 * checkout and request checks against it, then starts a local static server and
 * repeats the catalog checks over HTTP (including cache verification).
 *
 * --live runs read-only protocol and catalog checks against the real library
 * with remote loading disabled. --fixture is accepted as an alias for the
 * default fixture mode. The real library is never modified.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(HERE, "server.mjs");
const REPO_ROOT = path.resolve(HERE, "..");
const LIVE = process.argv.includes("--live");
const REQUEST_TIMEOUT_MS = 20000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const DIM = 512;
const RESTRICTED_LICENSE = "LicenseRef-All-Rights-Reserved";

let passed = 0;
let failed = 0;
let skipped = 0;
let assertionCount = 0;
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
  assertionCount += 1;
  if (!condition) throw new Error(message);
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function contentText(result) {
  assert(
    result && !result.error,
    `JSON-RPC error: ${result?.error?.message ?? "missing response"}`,
  );
  assert(
    Array.isArray(result.result?.content) && result.result.content.length > 0,
    "tool result has no content",
  );

  const first = result.result.content[0];
  assert(
    first?.type === "text" && typeof first.text === "string",
    "tool result content is not a text block",
  );
  return first.text;
}

/* --------------------------------------------------------------------------
 * MCP session
 * ----------------------------------------------------------------------- */

class Session {
  constructor(env, label = "server") {
    this.label = label;
    this.child = spawn(process.execPath, [SERVER_PATH], {
      cwd: HERE,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.stdoutBuffer = "";
    this.stderrText = "";
    this.stdoutNoise = [];
    this.spawnError = null;
    this.closeInfo = null;
    this.nextId = 1;
    this.pending = new Map();
    this.orphans = [];
    this.orphanWaiters = [];
    this.stdinEnded = false;

    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk;

      let newlineIndex;
      while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer
          .slice(0, newlineIndex)
          .replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.stdoutNoise.push(line);
          continue;
        }

        this.dispatch(message);
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrText += chunk;
    });

    this.child.on("error", (error) => {
      this.spawnError = error;
      this.rejectAllPending(`Failed to spawn server: ${error.message}`);
    });

    this.child.once("close", (code, signal) => {
      this.closeInfo = { code, signal };
      this.resolveClose(this.closeInfo);
      this.rejectAllPending(
        `Server exited before responding (code ${code}, signal ${signal})`,
      );
    });
  }

  dispatch(message) {
    const hasId =
      message !== null &&
      typeof message === "object" &&
      message.id !== undefined &&
      message.id !== null;
    const key = hasId ? String(message.id) : null;

    if (key !== null && this.pending.has(key)) {
      const waiter = this.pending.get(key);
      this.pending.delete(key);
      waiter.resolve(message);
      return;
    }

    if (this.orphanWaiters.length > 0) {
      this.orphanWaiters.shift().resolve(message);
    } else {
      this.orphans.push(message);
    }
  }

  rejectAllPending(message) {
    for (const [key, waiter] of this.pending) {
      this.pending.delete(key);
      waiter.reject(new Error(message));
    }
    for (const waiter of this.orphanWaiters.splice(0)) {
      waiter.reject(new Error(message));
    }
  }

  writeLine(text, eol = "\n") {
    if (!this.child.stdin.writable) {
      throw new Error("Server stdin is not writable.");
    }
    this.child.stdin.write(`${text}${eol}`);
  }

  waitForResponse(id, method) {
    return new Promise((resolve, reject) => {
      const key = String(id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new Error(
            `Timed out after ${REQUEST_TIMEOUT_MS} ms waiting for ${method}`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(key, {
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

  request(method, params, options = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = this.waitForResponse(id, method);

    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    this.writeLine(JSON.stringify(message), options.eol ?? "\n");

    return promise;
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.writeLine(JSON.stringify(message));
  }

  nextOrphan() {
    if (this.orphans.length > 0) return Promise.resolve(this.orphans.shift());

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
        const index = this.orphanWaiters.indexOf(waiter);
        if (index !== -1) this.orphanWaiters.splice(index, 1);
        reject(
          new Error(
            `Timed out after ${REQUEST_TIMEOUT_MS} ms waiting for a response`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);

      this.orphanWaiters.push(waiter);
    });
  }

  async callTool(name, args) {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = contentText(res);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, text, json };
  }

  async endInput() {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    try {
      this.child.stdin.end();
    } catch {
      // The process may already be gone.
    }
  }

  async close() {
    await this.endInput();
    if (this.closeInfo) return this.closeInfo;
    return withTimeout(
      this.closePromise,
      SHUTDOWN_TIMEOUT_MS,
      `server did not exit within ${SHUTDOWN_TIMEOUT_MS} ms after stdin EOF`,
    );
  }

  async forceClose() {
    if (this.closeInfo) return;
    try {
      this.child.kill();
    } catch {
      // The process may already have exited.
    }
    try {
      await withTimeout(this.closePromise, 2000, "close timeout");
    } catch {
      // Best effort cleanup; the test result is already recorded.
    }
  }
}

/* --------------------------------------------------------------------------
 * Fixture
 * ----------------------------------------------------------------------- */

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function basis(positions) {
  const vector = new Float32Array(DIM);
  for (const [index, value] of positions) vector[index] = value;
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }
  return vector;
}

function writeBin(vectors) {
  const buffer = Buffer.alloc(vectors.length * DIM * 4);
  vectors.forEach((vector, vectorIndex) => {
    for (let index = 0; index < DIM; index += 1) {
      buffer.writeFloatLE(
        vector[index] ?? 0,
        (vectorIndex * DIM + index) * 4,
      );
    }
  });
  return buffer;
}

function writeFixture(root, relativePath, content, encoding) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, encoding);
}

function buildFixture(root) {
  const contents = {
    sword: Buffer.from("sword-original-bytes-v1\n", "utf8"),
    stone: Buffer.from("stone-original-bytes-v1\n", "utf8"),
    ambience: Buffer.from("ambience-original-bytes-v1\n", "utf8"),
    pot: Buffer.from("pot-original-bytes-v1\n", "utf8"),
    preview: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#4a5"/></svg>\n',
      "utf8",
    ),
  };

  const assets = {
    sword: {
      id: "IMG-WEAPON-000001",
      kind: "image",
      role: "weapon",
      title: "Iron Sword",
      summary:
        "A one-handed iron sword for melee combat scenes. Use it for knight loadouts and inventory icons; it is not a ceremonial display blade.",
      tags: [
        "subject:weapon/sword",
        "style:pixel-art",
        "use:item-icon",
        "format:png",
        "engine:any",
      ],
      keywords: ["sword", "blade", "melee"],
      prompt: "pixel art iron sword on a transparent background",
      family: "weapon",
      scope: "curated",
      contributor: "Meesa",
      license: "CC0-1.0",
      preview: "",
      file: "assets/image/weapon/000001-iron-sword/src/sword.png",
      mime: "image/png",
      bytes: contents.sword.length,
      sha256: sha256(contents.sword),
      dir: "assets/image/weapon/000001-iron-sword",
      added: "2026-11-20T10:00:00Z",
      text: "pixel art iron sword melee weapon blade",
      tokens: ["iron", "sword", "blade", "melee"],
      embeddings: {
        clipImage: 0,
        clipText: 3,
        clapAudio: null,
        clapText: null,
      },
    },
    stone: {
      id: "IMG-TILE-000002",
      kind: "image",
      role: "tile",
      title: "Mossy Stone Texture",
      summary:
        "Seamless wet stone texture for dungeon floors and ruined walls. Use it as a background ambience plate for masonry surfaces; avoid clean science-fiction panels.",
      tags: [
        "subject:environment/stone",
        "style:realistic",
        "use:tileset",
        "format:png",
        "engine:any",
      ],
      keywords: ["stone", "moss", "cobblestone"],
      prompt: "seamless mossy stone texture, top down",
      family: "environment",
      scope: "curated",
      contributor: "Meesa",
      license: "CC-BY-4.0",
      preview: "preview.svg",
      file: "assets/image/tile/000002-mossy-stone/src/stone.png",
      mime: "image/png",
      bytes: contents.stone.length,
      sha256: sha256(contents.stone),
      dir: "assets/image/tile/000002-mossy-stone",
      added: "2026-11-20T11:00:00Z",
      text: "seamless mossy stone texture masonry dungeon floor",
      tokens: ["stone", "moss", "texture", "tile"],
      embeddings: {
        clipImage: 1,
        clipText: 1,
        clapAudio: null,
        clapText: null,
      },
    },
    ambience: {
      id: "SND-AMBIENCE-000003",
      kind: "audio",
      role: "ambience",
      title: "Forest Ambience Loop",
      summary:
        "Six-second stereo forest ambience with birds and wind. Use it as a quiet outdoor loop; it has no combat or crowd layers.",
      tags: [
        "subject:ambience/forest",
        "use:ambience",
        "format:ogg",
        "engine:any",
      ],
      keywords: ["forest", "birds", "wind"],
      prompt: "calm forest ambience with distant birds",
      family: "audio",
      scope: "curated",
      contributor: "Guest",
      license: RESTRICTED_LICENSE,
      preview: "",
      file: "assets/audio/ambience/000003-forest-ambience/src/forest.ogg",
      mime: "audio/ogg",
      bytes: contents.ambience.length,
      sha256: sha256(contents.ambience),
      dir: "assets/audio/ambience/000003-forest-ambience",
      added: "2026-11-20T12:00:00Z",
      text: "calm forest ambience birds wind loop",
      tokens: ["forest", "ambience", "birds", "wind"],
      embeddings: {
        clipImage: null,
        clipText: null,
        clapAudio: 0,
        clapText: 0,
      },
    },
    pot: {
      id: "MDL-PROP-000004",
      kind: "model",
      role: "prop",
      title: "Copper Pot",
      summary:
        "A copper cooking pot for tavern and camp scenes. Use it as a handheld prop; it is not a combat item or a treasure container.",
      tags: ["subject:object/pot", "style:painted", "use:prop", "format:glb"],
      keywords: ["pot", "copper", "cookware"],
      prompt: "low poly copper cooking pot prop",
      family: "prop",
      scope: "curated",
      contributor: "Meesa",
      license: "CC0-1.0",
      preview: "",
      file: "assets/model/prop/000004-copper-pot/src/pot.glb",
      mime: "model/gltf-binary",
      bytes: contents.pot.length,
      sha256: sha256(contents.pot),
      dir: "assets/model/prop/000004-copper-pot",
      added: "2026-11-20T13:00:00Z",
      text: "low poly copper cooking pot tavern prop",
      tokens: ["pot", "copper", "cookware"],
      embeddings: {
        clipImage: 2,
        clipText: 2,
        clapAudio: null,
        clapText: null,
      },
    },
  };

  const concepts = [
    {
      id: "sword",
      label: "Sword",
      synonyms: ["blade", "saber"],
      kind: "object",
      modality: "both",
    },
    {
      id: "stone",
      label: "Stone",
      synonyms: ["rock", "masonry"],
      kind: "material",
      modality: "both",
    },
    {
      id: "ambience",
      label: "Ambience",
      synonyms: ["atmosphere", "background"],
      kind: "audio",
      modality: "audio",
    },
    {
      id: "dog",
      label: "Dog",
      synonyms: ["puppy", "canine"],
      kind: "animal",
      modality: "both",
    },
    {
      id: "music",
      label: "Music",
      synonyms: ["song", "tune"],
      kind: "music",
      modality: "audio",
    },
  ];

  const clipVectors = [
    basis([[0, 1]]),
    basis([[1, 1]]),
    basis([[2, 1]]),
    // Dog scores about 0.15 against every media vector. If text vectors were
    // used, the sword's clipText below would make dog a false 1.0 match.
    basis([
      [0, 1],
      [1, 1],
      [2, 1],
      [4, 6.438],
    ]),
  ];
  const clapVectors = [basis([[0, 1]]), basis([[1, 1]])];

  const searchIndex = {
    version: 1,
    generated: "2026-11-20T00:00:00Z",
    assets: Object.values(assets).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    tokens: {},
    families: {},
    concepts,
    stats: {
      assets: Object.keys(assets).length,
      families: 4,
      concepts: concepts.length,
    },
  };

  const embeddingsManifest = {
    dim: DIM,
    clip: { file: "embeddings-clip.bin", model: "clip-fixture" },
    clap: { file: "embeddings-clap.bin", model: "clap-fixture" },
    assets: Object.fromEntries(
      Object.entries(assets).map(([key, asset]) => [
        asset.id,
        {
          clipImage: asset.embeddings.clipImage,
          clipText: asset.embeddings.clipText,
          clapAudio: asset.embeddings.clapAudio,
          clapText: asset.embeddings.clapText,
        },
      ]),
    ),
    concepts: {
      sword: { clip: 0 },
      stone: { clip: 1 },
      ambience: { clap: 0 },
      dog: { clip: 3 },
      music: { clap: 1 },
    },
  };

  writeFixture(
    root,
    "catalog/search-index.json",
    `${JSON.stringify(searchIndex, null, 2)}\n`,
    "utf8",
  );
  writeFixture(
    root,
    "catalog/concepts.json",
    `${JSON.stringify({ concepts }, null, 2)}\n`,
    "utf8",
  );
  writeFixture(
    root,
    "catalog/embeddings.json",
    `${JSON.stringify(embeddingsManifest, null, 2)}\n`,
    "utf8",
  );
  writeFixture(root, "catalog/embeddings-clip.bin", writeBin(clipVectors));
  writeFixture(root, "catalog/embeddings-clap.bin", writeBin(clapVectors));

  const indexLines = Object.values(assets).map((asset) =>
    JSON.stringify({
      id: asset.id,
      kind: asset.kind,
      role: asset.role,
      title: asset.title,
      summary: asset.summary,
      tags: asset.tags,
      keywords: asset.keywords,
      prompt: asset.prompt,
      family: asset.family,
      scope: asset.scope,
      contributor: asset.contributor,
      license: asset.license,
      preview: asset.preview,
      file: asset.file,
      mime: asset.mime,
      bytes: asset.bytes,
      sha256: asset.sha256,
      dir: asset.dir,
      added: asset.added,
    }),
  );

  writeFixture(root, "catalog/index.jsonl", `${indexLines.join("\n")}\n`, "utf8");

  const fileContents = {
    sword: contents.sword,
    stone: contents.stone,
    ambience: contents.ambience,
    pot: contents.pot,
  };

  for (const [key, asset] of Object.entries(assets)) {
    writeFixture(root, asset.file, fileContents[key]);

    writeFixture(
      root,
      path.join(asset.dir, "asset.json"),
      `${JSON.stringify(
        {
          id: asset.id,
          kind: asset.kind,
          role: asset.role,
          title: asset.title,
          summary: asset.summary,
          tags: asset.tags,
          keywords: asset.keywords,
          family: asset.family,
          contributor: asset.contributor,
          license: asset.license,
          files: [
            {
              path: asset.file,
              mime: asset.mime,
              bytes: asset.bytes,
              sha256: asset.sha256,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeFixture(
      root,
      path.join(asset.dir, "asset.md"),
      `# ${asset.title}\n\n${asset.summary}\n\n- Kind: ${asset.kind}\n- Role: ${asset.role}\n- License: ${asset.license}\n`,
      "utf8",
    );
  }

  writeFixture(
    root,
    path.join(assets.stone.dir, "preview.svg"),
    contents.preview,
  );

  writeFixture(
    root,
    "catalog/facets/style.md",
    "---\nname: style\n---\n\n# Style\n\nVisual style and rendering facets.\n",
    "utf8",
  );
  writeFixture(
    root,
    "catalog/facets/subject.md",
    "# Subject\n\nWhat an asset depicts, independent of format.\n",
    "utf8",
  );
  writeFixture(
    root,
    "catalog/collections/dungeon-kit.md",
    "# Dungeon Kit\n\nCoordinated pieces for building dungeon interiors.\n",
    "utf8",
  );

  return {
    root,
    assets,
    contents,
    searchIndexPath: path.join(root, "catalog", "search-index.json"),
  };
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

/* --------------------------------------------------------------------------
 * Static fixture server (remote mode)
 * ----------------------------------------------------------------------- */

function startStaticServer(root) {
  const requests = [];

  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    requests.push(pathname);

    const segments = pathname.split("/").filter(Boolean);
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    const target = path.resolve(root, ...segments);
    const relative = path.relative(root, target);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    fs.readFile(target, (error, buffer) => {
      if (error) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      const extension = path.extname(target).toLowerCase();
      const type =
        extension === ".json"
          ? "application/json"
          : extension === ".bin"
            ? "application/octet-stream"
            : "application/octet-stream";

      response.writeHead(200, {
        "content-type": type,
        "content-length": buffer.length,
      });
      response.end(buffer);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/* --------------------------------------------------------------------------
 * Local fixture checks
 * ----------------------------------------------------------------------- */

async function runLocalChecks(fixture) {
  console.log("Phase 1: fixture library over stdio");
  console.log("");

  const session = new Session(
    {
      ...process.env,
      MEESA_LIBRARY_ROOT: fixture.root,
      MEESA_LIBRARY_URL: "",
    },
    "local",
  );

  const localResults = { swordRows: null, stoneRows: null };

  try {
    await check("initialize returns serverInfo.name", async () => {
      session.writeLine("", "\r\n");

      const res = await session.request(
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
        res.result?.capabilities &&
          typeof res.result.capabilities.tools === "object",
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

      session.notify("notifications/initialized");
    });

    await check("tools/list returns the five tools", async () => {
      const res = await session.request("tools/list");
      assert(res && !res.error, `tools/list failed: ${res?.error?.message}`);

      const tools = res.result?.tools;
      assert(Array.isArray(tools), "tools/list did not return an array");
      assert(tools.length === 5, `expected 5 tools, received ${tools.length}`);

      const expected = [
        "search_assets",
        "get_asset",
        "list_taxonomy",
        "checkout_pack",
        "request_asset",
      ];
      const names = tools.map((tool) => tool.name);
      for (const name of expected) {
        assert(names.includes(name), `missing tool: ${name}`);
      }

      const search = tools.find((tool) => tool.name === "search_assets");
      assert(
        search?.inputSchema?.type === "object",
        "search_assets has no object schema",
      );
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

      const checkout = tools.find((tool) => tool.name === "checkout_pack");
      assert(
        Array.isArray(checkout?.inputSchema?.required) &&
          checkout.inputSchema.required.includes("ids"),
        "checkout_pack does not require ids",
      );
      assert(
        checkout?.inputSchema?.properties?.includePreview?.default === true,
        "checkout_pack includePreview default is not true",
      );

      const requestTool = tools.find((tool) => tool.name === "request_asset");
      assert(
        Array.isArray(requestTool?.inputSchema?.required) &&
          requestTool.inputSchema.required.includes("query"),
        "request_asset does not require query",
      );
    });

    await check("unknown tool returns -32602", async () => {
      const res = await session.request("tools/call", {
        name: "definitely_not_a_tool",
        arguments: {},
      });
      assert(res?.error, "unknown tool did not return a JSON-RPC error");
      assert(
        res.error.code === -32602,
        `expected error code -32602, received ${res.error.code}`,
      );
    });

    await check("search_assets ranks the sword first", async () => {
      const result = await session.callTool("search_assets", {
        query: "sword",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(Array.isArray(result.json), "search result is not a JSON array");
      assert(
        result.json.length === 1,
        `expected exactly one sword match, received ${result.json.length}`,
      );

      const top = result.json[0];
      assert(top.id === fixture.assets.sword.id, `unexpected top id: ${top.id}`);
      assert(top.title === "Iron Sword", `unexpected title: ${top.title}`);
      assert(top.kind === "image", `unexpected kind: ${top.kind}`);
      assert(top.role === "weapon", `unexpected role: ${top.role}`);
      assert(top.family === "weapon", `unexpected family: ${top.family}`);
      assert(top.license === "CC0-1.0", `unexpected license: ${top.license}`);
      assert(
        top.contributor === "Meesa",
        `unexpected contributor: ${top.contributor}`,
      );
      assert(
        typeof top.score === "number" && top.score > 0.9,
        `sword score is too low: ${top.score}`,
      );
      assert(
        Array.isArray(top.matchedConcepts) &&
          top.matchedConcepts.includes("sword"),
        "sword result did not report the sword concept",
      );
      assert(
        !("preview" in top) && !("bytes" in top) && !("dir" in top),
        "search result is not compact",
      );

      localResults.swordRows = result.json;
    });

    await check("search_assets ranks the stone texture first", async () => {
      const result = await session.callTool("search_assets", {
        query: "stone",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(Array.isArray(result.json), "search result is not a JSON array");
      assert(
        result.json.length === 1,
        `expected exactly one stone match, received ${result.json.length}`,
      );

      const top = result.json[0];
      assert(top.id === fixture.assets.stone.id, `unexpected top id: ${top.id}`);
      assert(
        top.matchedConcepts.includes("stone"),
        "stone result did not report the stone concept",
      );
      assert(
        typeof top.score === "number" && top.score > 0.9,
        `stone score is too low: ${top.score}`,
      );

      localResults.stoneRows = result.json;
    });

    await check("search_assets ranks media-only concept synonyms", async () => {
      const rock = await session.callTool("search_assets", {
        query: "rock",
      });
      assert(
        rock.res.result.isError !== true,
        `tool returned isError: ${rock.text}`,
      );
      assert(
        rock.json.length === 1,
        `expected one stone synonym match, received ${rock.json.length}`,
      );
      assert(
        rock.json[0].id === fixture.assets.stone.id,
        `rock query ranked ${rock.json[0].id} first`,
      );
      assert(
        rock.json[0].matchedConcepts.includes("stone"),
        "rock query did not report the stone concept",
      );
      assert(
        rock.json[0].score > 0.5 && rock.json[0].score < 0.6,
        `stone media-only score is unexpected: ${rock.json[0].score}`,
      );

      const saber = await session.callTool("search_assets", {
        query: "saber",
      });
      assert(
        saber.res.result.isError !== true,
        `tool returned isError: ${saber.text}`,
      );
      assert(
        saber.json.length === 1,
        `expected one sword synonym match, received ${saber.json.length}`,
      );
      assert(
        saber.json[0].id === fixture.assets.sword.id,
        `saber query ranked ${saber.json[0].id} first`,
      );
      assert(
        saber.json[0].matchedConcepts.includes("sword"),
        "saber query did not report the sword concept",
      );
      assert(
        saber.json[0].score > 0.5 && saber.json[0].score < 0.6,
        `sword media-only score is unexpected: ${saber.json[0].score}`,
      );
    });

    await check("search_assets ranks CLAP audio by concept", async () => {
      const result = await session.callTool("search_assets", {
        query: "atmosphere",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.length === 1,
        `expected one ambience match, received ${result.json.length}`,
      );
      assert(
        result.json[0].id === fixture.assets.ambience.id,
        `atmosphere query ranked ${result.json[0].id} first`,
      );
      assert(
        result.json[0].matchedConcepts.includes("ambience"),
        "atmosphere query did not report the ambience concept",
      );
      assert(
        result.json[0].score > 0.5,
        `ambience media-only score is too low: ${result.json[0].score}`,
      );
    });

    await check("search_assets restricts audio concepts to audio assets", async () => {
      const result = await session.callTool("search_assets", {
        query: "ambience",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.length === 1,
        `expected one audio ambience match, received ${result.json.length}`,
      );
      assert(
        result.json[0].id === fixture.assets.ambience.id,
        `ambience query ranked ${result.json[0].id} first`,
      );
      assert(
        result.json[0].kind === "audio",
        `ambience query returned a ${result.json[0].kind} asset`,
      );
      assert(
        !result.json.some((row) => row.id === fixture.assets.stone.id),
        "ambience query leaked the visual stone asset",
      );
    });

    await check("search_assets returns no false dog match", async () => {
      const result = await session.callTool("search_assets", {
        query: "dog",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(Array.isArray(result.json), "search result is not a JSON array");
      assert(
        result.json.length === 0,
        `expected no dog matches, received ${result.json.length}`,
      );

      const blocks = result.res.result.content;
      assert(
        Array.isArray(blocks) && blocks.length === 2,
        "empty search did not include a request hint block",
      );
      const hint = blocks[1]?.text;
      assert(
        typeof hint === "string" && hint.includes("request_asset"),
        "request hint does not mention request_asset",
      );
      assert(
        typeof hint === "string" && hint.includes("issues/new"),
        "request hint has no issue URL",
      );
      assert(
        typeof hint === "string" && hint.includes("dog"),
        "request hint does not repeat the query",
      );
    });

    await check("search_assets returns no music match", async () => {
      const result = await session.callTool("search_assets", {
        query: "music",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.length === 0,
        `expected no music matches, received ${result.json.length}`,
      );
      assert(
        result.res.result.content.length === 2 &&
          result.res.result.content[1].text.includes("issues/new"),
        "music miss did not include a request hint",
      );
    });

    await check("search_assets returns the sword for blade and weapon", async () => {
      const blade = await session.callTool("search_assets", {
        query: "blade",
      });
      assert(
        blade.res.result.isError !== true,
        `tool returned isError: ${blade.text}`,
      );
      assert(
        blade.json.length === 1 &&
          blade.json[0].id === fixture.assets.sword.id,
        "blade query did not return the sword",
      );
      assert(
        blade.json[0].matchedConcepts.includes("sword"),
        "blade query did not report the sword concept",
      );
      assert(
        blade.json[0].score > 0.9,
        `blade score is too low: ${blade.json[0].score}`,
      );

      const weapon = await session.callTool("search_assets", {
        query: "weapon",
      });
      assert(
        weapon.res.result.isError !== true,
        `tool returned isError: ${weapon.text}`,
      );
      assert(
        weapon.json.length === 1 &&
          weapon.json[0].id === fixture.assets.sword.id,
        "weapon query did not return the sword",
      );
      assert(
        Array.isArray(weapon.json[0].matchedConcepts) &&
          weapon.json[0].matchedConcepts.length === 0,
        "weapon query unexpectedly matched a concept",
      );
      assert(
        weapon.json[0].score > 0.9,
        `keyword fallback score is too low: ${weapon.json[0].score}`,
      );
    });

    await check("request_asset returns a prefilled issue link", async () => {
      const result = await session.callTool("request_asset", {
        query: "dog",
        note: "Need a friendly dog sprite for a tavern scene.",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(result.json && typeof result.json.url === "string", "no issue URL");

      const url = new URL(result.json.url);
      assert(url.hostname === "github.com", `unexpected issue host: ${url.hostname}`);
      assert(
        url.pathname === "/meesajarjar/MeesaAssetLibrary/issues/new",
        `unexpected issue path: ${url.pathname}`,
      );
      assert(
        url.searchParams.get("title")?.includes("dog"),
        "issue title does not contain the query",
      );
      assert(
        url.searchParams.get("body")?.includes("friendly dog sprite"),
        "issue body does not contain the note",
      );
    });

    await check("get_asset returns metadata and the search entry", async () => {
      const result = await session.callTool("get_asset", {
        id: fixture.assets.sword.id,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(result.json.id === fixture.assets.sword.id, "payload id mismatch");
      assert(
        result.json.asset && typeof result.json.asset === "object",
        "payload has no asset object",
      );
      assert(
        typeof result.json.markdown === "string" &&
          result.json.markdown.includes("# Iron Sword"),
        "payload has no asset.md text",
      );
      assert(
        result.json.searchIndex?.id === fixture.assets.sword.id,
        "payload has no search-index entry",
      );
    });

    await check("get_asset reports an unknown id", async () => {
      const result = await session.callTool("get_asset", {
        id: "IMG-NOPE-999999",
      });
      assert(
        result.res.result.isError === true,
        "unknown asset did not return isError",
      );
      assert(
        result.text.includes("Asset not found"),
        `unexpected error text: ${result.text}`,
      );
    });

    await check("list_taxonomy returns facets, families and concepts", async () => {
      const result = await session.callTool("list_taxonomy", {});
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );

      const taxonomy = result.json;
      assert(Array.isArray(taxonomy.facets), "taxonomy.facets is not an array");
      assert(
        Array.isArray(taxonomy.collections),
        "taxonomy.collections is not an array",
      );
      assert(taxonomy.facets.length === 2, `expected 2 facets, received ${taxonomy.facets.length}`);
      assert(
        taxonomy.collections.length === 1,
        `expected 1 collection, received ${taxonomy.collections.length}`,
      );

      const familyNames = taxonomy.families.map((family) => family.name);
      for (const name of ["weapon", "environment", "audio", "prop"]) {
        assert(familyNames.includes(name), `missing family: ${name}`);
      }

      assert(taxonomy.conceptCount === 5, `expected 5 concepts, received ${taxonomy.conceptCount}`);
      const conceptIds = taxonomy.topConcepts.map((concept) => concept.id);
      for (const id of ["sword", "stone", "ambience"]) {
        assert(conceptIds.includes(id), `missing top concept: ${id}`);
      }

      const swordConcept = taxonomy.topConcepts.find(
        (concept) => concept.id === "sword",
      );
      assert(swordConcept.count >= 1, "sword concept usage count is zero");
      assert(
        taxonomy.catalogSource === "local",
        `unexpected catalog source: ${taxonomy.catalogSource}`,
      );
    });

    await check("search_assets filters by kind and tags", async () => {
      const audio = await session.callTool("search_assets", {
        kind: "audio",
      });
      assert(
        audio.json.length === 1 && audio.json[0].id === fixture.assets.ambience.id,
        "kind filter did not return exactly the ambience asset",
      );

      const tagged = await session.callTool("search_assets", {
        tags: ["subject:environment/stone"],
      });
      assert(
        tagged.json.length === 1 && tagged.json[0].id === fixture.assets.stone.id,
        "tag filter did not return exactly the stone texture",
      );

      const impossible = await session.callTool("search_assets", {
        tags: ["subject:environment/stone", "palette:missing"],
      });
      assert(
        impossible.json.length === 0,
        "tag filter matched when one tag was absent",
      );
    });

    await check("checkout_pack writes five files with a verified payload", async () => {
      const packDir = path.join(fixture.workRoot, "pack-sword");
      const result = await session.callTool("checkout_pack", {
        ids: [fixture.assets.sword.id],
        outDir: packDir,
        acknowledgeRestricted: true,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );

      const payload = result.json;
      assert(payload.fileCount === 5, `expected 5 files, received ${payload.fileCount}`);
      assert(
        payload.payloadFileCount === 1,
        `expected 1 payload file, received ${payload.payloadFileCount}`,
      );
      assert(
        payload.totals.files === 1,
        `expected payload totals.files 1, received ${payload.totals.files}`,
      );
      assert(
        payload.restrictedAcknowledged === true,
        "acknowledgeRestricted was not recorded",
      );
      assert(payload.allVerified === true, "pack was not fully verified");
      assert(
        payload.bytes === fixture.contents.sword.length,
        `unexpected byte count: ${payload.bytes}`,
      );
      assert(
        payload.verification.length === 1 &&
          payload.verification[0].verified === true &&
          payload.verification[0].status === "verified",
        "primary file verification is missing",
      );
      assert(
        payload.verification[0].sha256 === fixture.assets.sword.sha256,
        "verification hash does not match the fixture",
      );

      const files = walkFiles(packDir);
      assert(files.length === 5, `disk has ${files.length} files`);
      for (const expected of [
        "pack.json",
        "CREDITS.md",
        "LICENSE.txt",
        "README.md",
        `assets/${fixture.assets.sword.id}/sword.png`,
      ]) {
        assert(files.includes(expected), `missing pack file: ${expected}`);
      }

      const written = fs.readFileSync(
        path.join(packDir, "assets", fixture.assets.sword.id, "sword.png"),
      );
      assert(
        sha256(written) === fixture.assets.sword.sha256,
        "written asset hash differs from the catalog hash",
      );

      const pack = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
      assert(pack.version === 1, "pack version is not 1");
      assert(
        pack.name === "img-weapon-000001",
        `unexpected pack name: ${pack.name}`,
      );
      assert(pack.format === "meesa-asset-pack/1", "unexpected pack format");
      assert(
        pack.restrictedAcknowledged === true,
        "pack did not record the restricted acknowledgement",
      );
      assert(pack.totals.assets === 1, "pack total assets is not 1");
      assert(
        pack.totals.files === 1,
        `pack total payload files is not 1: ${pack.totals.files}`,
      );
      assert(pack.totals.verified === true, "pack totals are not verified");
      assert(
        pack.assets[0].sha256 === fixture.assets.sword.sha256,
        "asset-level hash does not match the file hash",
      );
      assert(
        pack.assets[0].path ===
          `assets/${fixture.assets.sword.id}/sword.png`,
        `unexpected asset-level path: ${pack.assets[0].path}`,
      );
      assert(
        pack.assets[0].files.length === 1 &&
          pack.assets[0].files[0].verified === true &&
          pack.assets[0].files[0].status === "verified" &&
          pack.assets[0].files[0].sha256 === fixture.assets.sword.sha256,
        "asset files block is not verified",
      );
      assert(
        pack.verification.allVerified === true &&
          pack.verification.failures.length === 0,
        "pack verification block is not clean",
      );
    });

    await check("checkout_pack refuses restricted licences", async () => {
      const packDir = path.join(fixture.workRoot, "pack-restricted");
      const result = await session.callTool("checkout_pack", {
        ids: [fixture.assets.ambience.id],
        outDir: packDir,
      });
      assert(
        result.res.result.isError === true,
        "restricted checkout did not return isError",
      );
      assert(
        result.text.includes(RESTRICTED_LICENSE),
        `unexpected refusal text: ${result.text}`,
      );
      assert(
        !fs.existsSync(packDir),
        "refused checkout still created the output directory",
      );
    });

    await check("checkout_pack rejects traversal in ids and outDir", async () => {
      const badId = await session.callTool("checkout_pack", {
        ids: ["../escape"],
        outDir: path.join(fixture.workRoot, "pack-bad-id"),
      });
      assert(
        badId.res.result.isError === true,
        "traversal id did not return isError",
      );
      assert(
        /Invalid asset id/.test(badId.text),
        `unexpected id error: ${badId.text}`,
      );

      const badSlashId = await session.callTool("checkout_pack", {
        ids: ["IMG-WEAPON-000001/../../escape"],
        outDir: path.join(fixture.workRoot, "pack-bad-slash"),
      });
      assert(
        badSlashId.res.result.isError === true,
        "slash traversal id did not return isError",
      );

      const badOut = await session.callTool("checkout_pack", {
        ids: [fixture.assets.sword.id],
        outDir: "..\\escape-pack",
      });
      assert(
        badOut.res.result.isError === true,
        "traversal outDir did not return isError",
      );
      assert(
        /must not contain '\.\.'/.test(badOut.text),
        `unexpected outDir error: ${badOut.text}`,
      );
    });

    await check("checkout_pack includes a preview when asked", async () => {
      const packDir = path.join(fixture.workRoot, "pack-stone-preview");
      const result = await session.callTool("checkout_pack", {
        ids: [fixture.assets.stone.id],
        outDir: packDir,
        includePreview: true,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.fileCount === 6,
        `expected 6 files with preview, received ${result.json.fileCount}`,
      );
      assert(
        result.json.payloadFileCount === 2,
        `expected 2 payload files with preview, received ${result.json.payloadFileCount}`,
      );
      assert(
        result.json.totals.files === 2,
        `expected payload totals.files 2, received ${result.json.totals.files}`,
      );
      assert(
        result.json.verification.some(
          (item) =>
            item.kind === "preview" &&
            item.path.endsWith("/preview.svg") &&
            item.verified === true &&
            item.status === "verified",
        ),
        "preview was not recorded as verified",
      );
      assert(
        result.json.verification.every((item) => item.verified === true),
        "a payload file was not verified",
      );
      assert(
        fs.existsSync(
          path.join(
            packDir,
            "assets",
            fixture.assets.stone.id,
            "preview.svg",
          ),
        ),
        "preview.svg was not written",
      );

      const pack = JSON.parse(
        fs.readFileSync(path.join(packDir, "pack.json"), "utf8"),
      );
      assert(
        pack.totals.files === 2,
        `pack total payload files is not 2: ${pack.totals.files}`,
      );
      assert(pack.verification.allVerified === true, "preview pack is not verified");
      assert(
        pack.assets[0].files.length === 2 &&
          pack.assets[0].files.every((file) => file.verified === true),
        "preview pack files are not all verified",
      );
    });

    await check("checkout_pack allows acknowledged restricted assets", async () => {
      const packDir = path.join(fixture.workRoot, "pack-acknowledged");
      const result = await session.callTool("checkout_pack", {
        ids: [fixture.assets.ambience.id],
        outDir: packDir,
        acknowledgeRestricted: true,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(result.json.fileCount === 5, `expected 5 files, received ${result.json.fileCount}`);
      assert(
        result.json.payloadFileCount === 1 &&
          result.json.totals.files === 1,
        "restricted pack payload file count is wrong",
      );
      assert(
        result.json.restrictedAcknowledged === true,
        "pack did not record the restricted acknowledgement",
      );
      assert(
        fs
          .readFileSync(path.join(packDir, "LICENSE.txt"), "utf8")
          .includes("Restricted assets included"),
        "LICENSE.txt does not mention the restricted acknowledgement",
      );

      const pack = JSON.parse(
        fs.readFileSync(path.join(packDir, "pack.json"), "utf8"),
      );
      assert(
        pack.restrictedAcknowledged === true,
        "pack.json did not record the restricted acknowledgement",
      );
    });

    await check("checkout_pack reports a corrupted payload", async () => {
      const potFile = path.join(fixture.root, fixture.assets.pot.file);
      const original = fs.readFileSync(potFile);

      try {
        fs.writeFileSync(
          potFile,
          Buffer.from("corrupted-pot-bytes\n", "utf8"),
        );

        const packDir = path.join(fixture.workRoot, "pack-bad-hash");
        const result = await session.callTool("checkout_pack", {
          ids: [fixture.assets.pot.id],
          outDir: packDir,
        });

        assert(
          result.res.result.isError === true,
          "corrupted payload did not return isError",
        );
        assert(
          result.json.allVerified === false,
          "corrupted payload pack claimed to be verified",
        );
        assert(
          result.json.failures.some((failure) =>
            /SHA-256 mismatch/.test(failure.error),
          ),
          "corrupted payload was not reported in failures",
        );
        assert(
          result.json.verification.some(
            (item) =>
              item.id === fixture.assets.pot.id &&
              item.status === "mismatch" &&
              item.verified === false &&
              item.written === false,
          ),
          "corrupted payload verification entry is wrong",
        );
        assert(
          result.json.totals.files === 0,
          `corrupted pack counted ${result.json.totals.files} payload files`,
        );
        assert(
          !fs.existsSync(
            path.join(
              packDir,
              "assets",
              fixture.assets.pot.id,
              "pot.glb",
            ),
          ),
          "mismatched file was left on disk",
        );

        const pack = JSON.parse(
          fs.readFileSync(path.join(packDir, "pack.json"), "utf8"),
        );
        assert(
          pack.verification.allVerified === false,
          "pack.json claimed the corrupted pack was verified",
        );
        assert(
          pack.verification.failures.some((failure) =>
            /SHA-256 mismatch/.test(failure.error),
          ),
          "pack.json did not record the mismatch",
        );
        assert(pack.totals.files === 0, "corrupted pack totals.files is not 0");
      } finally {
        fs.writeFileSync(potFile, original);
      }
    });

    await check("search_assets reloads a changed search index", async () => {
      const manifest = JSON.parse(
        fs.readFileSync(fixture.searchIndexPath, "utf8"),
      );
      manifest.assets.push({
        id: "IMG-PROP-000005",
        kind: "image",
        role: "prop",
        title: "Obsidian Shard",
        summary: "A glossy black volcanic shard prop.",
        tags: ["subject:object/shard", "palette:obsidian"],
        keywords: ["obsidian", "shard"],
        prompt: "glossy obsidian shard",
        family: "prop",
        scope: "curated",
        contributor: "Meesa",
        license: "CC0-1.0",
        preview: "",
        file: "assets/image/prop/000005-obsidian-shard/src/shard.png",
        mime: "image/png",
        bytes: 128,
        sha256: "",
        dir: "assets/image/prop/000005-obsidian-shard",
        added: "2026-11-20T14:00:00Z",
        text: "glossy obsidian shard",
        tokens: ["obsidian", "shard"],
        embeddings: {},
      });

      fs.writeFileSync(
        fixture.searchIndexPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      const now = new Date();
      fs.utimesSync(
        fixture.searchIndexPath,
        now,
        new Date(now.getTime() + 2000),
      );

      const result = await session.callTool("search_assets", {
        query: "obsidian",
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.some((row) => row.id === "IMG-PROP-000005"),
        "new search-index record was not discovered after the file changed",
      );
    });

    await check("unknown method returns -32601", async () => {
      const res = await session.request("definitely_not_a_method");
      assert(res?.error, "unknown method did not return a JSON-RPC error");
      assert(
        res.error.code === -32601,
        `expected error code -32601, received ${res.error.code}`,
      );
    });

    await check("malformed JSON returns -32700 and keeps running", async () => {
      session.writeLine("{ this is not json }");
      const res = await session.nextOrphan();
      assert(res?.error, "malformed JSON did not return a JSON-RPC error");
      assert(
        res.error.code === -32700,
        `expected error code -32700, received ${res.error.code}`,
      );
      assert(res.id === null, "parse error response id should be null");

      const ping = await session.request("ping");
      assert(
        ping && !ping.error,
        `ping failed after parse error: ${ping?.error?.message}`,
      );
      assert(
        ping.result && typeof ping.result === "object",
        "ping did not return an object result",
      );
      assert(Object.keys(ping.result).length === 0, "ping result should be {}");
    });

    await check("clean shutdown on stdin EOF", async () => {
      if (session.spawnError) throw session.spawnError;

      const info = await session.close();

      assert(
        info.code === 0,
        `expected exit code 0, received ${info.code} (signal ${info.signal})`,
      );
      assert(info.signal === null, `server was terminated by signal ${info.signal}`);
      assert(
        session.stdoutNoise.length === 0,
        `server wrote non-JSON data to stdout: ${session.stdoutNoise[0]}`,
      );
      assert(
        session.stdoutBuffer.trim() === "",
        `server left an unterminated line on stdout: ${session.stdoutBuffer}`,
      );
      assert(
        !/unhandled|uncaught/i.test(session.stderrText),
        `stderr reported an unhandled error:\n${session.stderrText.trim()}`,
      );
    });
  } finally {
    await session.forceClose();
  }

  return localResults;
}

/* --------------------------------------------------------------------------
 * Remote fixture checks
 * ----------------------------------------------------------------------- */

async function runRemoteChecks(fixture, staticServer, localResults) {
  console.log("");
  console.log("Phase 2: fixture library over HTTP");
  console.log(`  base URL: ${staticServer.url}`);
  console.log("");

  const session = new Session(
    {
      ...process.env,
      MEESA_LIBRARY_ROOT: fixture.root,
      MEESA_LIBRARY_URL: staticServer.url,
    },
    "remote",
  );

  try {
    await check("remote search matches local search", async () => {
      assert(localResults.swordRows, "local sword results were not captured");

      const sword = await session.callTool("search_assets", {
        query: "sword",
      });
      assert(
        sword.res.result.isError !== true,
        `tool returned isError: ${sword.text}`,
      );
      assert(
        JSON.stringify(sword.json) === JSON.stringify(localResults.swordRows),
        "remote sword results differ from local results",
      );

      const stone = await session.callTool("search_assets", {
        query: "stone",
      });
      assert(
        JSON.stringify(stone.json) === JSON.stringify(localResults.stoneRows),
        "remote stone results differ from local results",
      );

      const dog = await session.callTool("search_assets", { query: "dog" });
      assert(dog.json.length === 0, "remote dog search returned matches");

      assert(
        staticServer.requests.some((pathname) =>
          pathname.endsWith("/catalog/search-index.json"),
        ),
        "search-index.json was not requested over HTTP",
      );
      assert(
        staticServer.requests.some((pathname) =>
          pathname.endsWith("/catalog/embeddings-clip.bin"),
        ),
        "embeddings-clip.bin was not requested over HTTP",
      );
      assert(
        staticServer.requests.some((pathname) =>
          pathname.endsWith("/catalog/embeddings-clap.bin"),
        ),
        "embeddings-clap.bin was not requested over HTTP",
      );
    });

    await check("remote catalog caching avoids refetching", async () => {
      const before = staticServer.requests.length;

      await session.callTool("search_assets", { query: "sword" });
      await session.callTool("search_assets", { query: "stone" });
      await session.callTool("search_assets", { query: "dog" });

      assert(
        staticServer.requests.length === before,
        `cached searches made ${staticServer.requests.length - before} new request(s)`,
      );
    });

    await check("remote failure falls back to the local catalog", async () => {
      const fallback = new Session(
        {
          ...process.env,
          MEESA_LIBRARY_ROOT: fixture.root,
          MEESA_LIBRARY_URL: `${staticServer.url}missing-library/`,
        },
        "fallback",
      );

      try {
        const result = await fallback.callTool("search_assets", {
          query: "sword",
        });
        assert(
          result.res.result.isError !== true,
          `fallback search returned isError: ${result.text}`,
        );
        assert(
          JSON.stringify(result.json) === JSON.stringify(localResults.swordRows),
          "fallback results differ from local results",
        );
        assert(
          /Remote catalog unavailable/.test(fallback.stderrText),
          "fallback did not report the remote failure on stderr",
        );
      } finally {
        await fallback.forceClose();
      }
    });

    await check("remote failure without a local catalog is a clear error", async () => {
      const emptyRoot = path.join(fixture.workRoot, "empty-root");
      fs.mkdirSync(emptyRoot, { recursive: true });

      const broken = new Session(
        {
          ...process.env,
          MEESA_LIBRARY_ROOT: emptyRoot,
          MEESA_LIBRARY_URL: `${staticServer.url}missing-library/`,
        },
        "broken",
      );

      try {
        const result = await broken.callTool("search_assets", {
          query: "sword",
        });
        assert(
          result.res.result.isError === true,
          "missing catalog did not return isError",
        );
        assert(
          /Search catalog unavailable/.test(result.text),
          `unexpected error text: ${result.text}`,
        );
        assert(
          /No local catalog/.test(result.text),
          `error does not mention the missing local catalog: ${result.text}`,
        );
      } finally {
        await broken.forceClose();
      }
    });

    await check("remote checkout verifies hashes", async () => {
      const packDir = path.join(fixture.workRoot, "pack-remote-sword");
      const result = await session.callTool("checkout_pack", {
        ids: [fixture.assets.sword.id],
        outDir: packDir,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(result.json.fileCount === 5, `expected 5 files, received ${result.json.fileCount}`);
      assert(
        result.json.payloadFileCount === 1 &&
          result.json.totals.files === 1,
        "remote payload file count is wrong",
      );
      assert(result.json.allVerified === true, "remote pack was not verified");
      assert(
        result.json.verification[0].source === "remote",
        "pack file was not downloaded over HTTP",
      );
      assert(
        result.json.verification[0].sha256 === fixture.assets.sword.sha256,
        "remote hash does not match the fixture",
      );
      assert(
        staticServer.requests.some((pathname) =>
          pathname.endsWith("/assets/image/weapon/000001-iron-sword/src/sword.png"),
        ),
        "asset file was not requested over HTTP",
      );
    });

    await check("remote checkout reports a corrupted payload", async () => {
      const potFile = path.join(fixture.root, fixture.assets.pot.file);
      const original = fs.readFileSync(potFile);

      try {
        fs.writeFileSync(
          potFile,
          Buffer.from("remote-corrupted-bytes\n", "utf8"),
        );

        const packDir = path.join(fixture.workRoot, "pack-remote-corrupt");
        const result = await session.callTool("checkout_pack", {
          ids: [fixture.assets.pot.id],
          outDir: packDir,
        });

        assert(
          result.res.result.isError === true,
          "corrupted remote payload did not return isError",
        );
        assert(
          result.json.allVerified === false,
          "corrupted remote payload claimed to be verified",
        );
        assert(
          result.json.failures.some((failure) =>
            /SHA-256 mismatch/.test(failure.error),
          ),
          "corrupted remote payload was not reported in failures",
        );
        assert(
          result.json.totals.files === 0,
          `corrupted remote pack counted ${result.json.totals.files} payload files`,
        );

        const pack = JSON.parse(
          fs.readFileSync(path.join(packDir, "pack.json"), "utf8"),
        );
        assert(
          pack.verification.allVerified === false,
          "corrupted remote pack.json claimed to be verified",
        );
      } finally {
        fs.writeFileSync(potFile, original);
      }
    });

    await check("remote get_asset returns the search entry", async () => {
      const result = await session.callTool("get_asset", {
        id: fixture.assets.stone.id,
      });
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(
        result.json.searchIndex?.id === fixture.assets.stone.id,
        "remote search entry is missing",
      );
    });

    await check("remote-only get_asset fetches metadata and caches it", async () => {
      const emptyRoot = path.join(fixture.workRoot, "remote-only-root");
      fs.mkdirSync(emptyRoot, { recursive: true });

      const remoteOnly = new Session(
        {
          ...process.env,
          MEESA_LIBRARY_ROOT: emptyRoot,
          MEESA_LIBRARY_URL: staticServer.url,
        },
        "remote-only",
      );

      const countPath = (suffix) =>
        staticServer.requests.filter((pathname) => pathname === suffix).length;
      const assetJsonPath =
        "/assets/image/weapon/000001-iron-sword/asset.json";
      const assetMdPath =
        "/assets/image/weapon/000001-iron-sword/asset.md";

      try {
        const beforeJson = countPath(assetJsonPath);
        const beforeMd = countPath(assetMdPath);

        const first = await remoteOnly.callTool("get_asset", {
          id: fixture.assets.sword.id,
        });
        assert(
          first.res.result.isError !== true,
          `tool returned isError: ${first.text}`,
        );

        const payload = first.json;
        assert(payload.id === fixture.assets.sword.id, "payload id mismatch");
        assert(
          payload.dir === fixture.assets.sword.dir,
          `unexpected payload dir: ${payload.dir}`,
        );
        assert(
          payload.asset && payload.asset.title === "Iron Sword",
          "remote asset.json fields are missing",
        );
        assert(
          payload.asset.summary.includes("one-handed iron sword"),
          "remote asset.json summary is missing",
        );
        assert(
          payload.asset.files?.[0]?.sha256 === fixture.assets.sword.sha256,
          "remote asset.json file hash is missing",
        );
        assert(
          typeof payload.markdown === "string" &&
            payload.markdown.includes("# Iron Sword"),
          "remote asset.md text is missing",
        );
        assert(
          payload.searchIndex?.id === fixture.assets.sword.id,
          "remote search entry is missing",
        );
        assert(
          payload.metadataUnavailable !== true,
          "remote metadata was reported unavailable",
        );

        assert(
          countPath(assetJsonPath) === beforeJson + 1,
          "asset.json was not fetched exactly once",
        );
        assert(
          countPath(assetMdPath) === beforeMd + 1,
          "asset.md was not fetched exactly once",
        );

        const second = await remoteOnly.callTool("get_asset", {
          id: fixture.assets.sword.id,
        });
        assert(
          second.json.asset?.title === "Iron Sword",
          "cached metadata response is wrong",
        );
        assert(
          countPath(assetJsonPath) === beforeJson + 1,
          "metadata cache refetched asset.json within the TTL",
        );
        assert(
          countPath(assetMdPath) === beforeMd + 1,
          "metadata cache refetched asset.md within the TTL",
        );

        const missingJsonPath =
          "/assets/image/prop/000005-obsidian-shard/asset.json";
        const beforeMissing = countPath(missingJsonPath);
        const missing = await remoteOnly.callTool("get_asset", {
          id: "IMG-PROP-000005",
        });
        assert(
          missing.res.result.isError !== true,
          `missing metadata returned isError: ${missing.text}`,
        );
        assert(
          missing.json.metadataUnavailable === true,
          "missing metadata was not flagged",
        );
        assert(
          missing.json.asset === null,
          "missing metadata returned an asset object",
        );
        assert(
          missing.json.markdown === null,
          "missing metadata returned markdown",
        );
        assert(
          missing.json.searchIndex?.id === "IMG-PROP-000005",
          "missing metadata has no search entry",
        );
        assert(
          typeof missing.json.note === "string" &&
            missing.json.note.includes("404") &&
            missing.json.note.includes("asset.json"),
          `missing metadata note is unclear: ${missing.json.note}`,
        );
        assert(
          countPath(missingJsonPath) === beforeMissing + 1,
          "missing asset.json was fetched an unexpected number of times",
        );

        const missingAgain = await remoteOnly.callTool("get_asset", {
          id: "IMG-PROP-000005",
        });
        assert(
          missingAgain.json.metadataUnavailable === true,
          "cached missing metadata response is wrong",
        );
        assert(
          countPath(missingJsonPath) === beforeMissing + 1,
          "missing metadata was refetched within the TTL",
        );
      } finally {
        await remoteOnly.forceClose();
      }
    });

    await check("remote clean shutdown on stdin EOF", async () => {
      if (session.spawnError) throw session.spawnError;

      const info = await session.close();

      assert(
        info.code === 0,
        `expected exit code 0, received ${info.code} (signal ${info.signal})`,
      );
      assert(info.signal === null, `server was terminated by signal ${info.signal}`);
      assert(
        session.stdoutNoise.length === 0,
        `server wrote non-JSON data to stdout: ${session.stdoutNoise[0]}`,
      );
      assert(
        session.stdoutBuffer.trim() === "",
        `server left an unterminated line on stdout: ${session.stdoutBuffer}`,
      );
      assert(
        !/unhandled|uncaught/i.test(session.stderrText),
        `stderr reported an unhandled error:\n${session.stderrText.trim()}`,
      );
    });
  } finally {
    await session.forceClose();
  }
}

/* --------------------------------------------------------------------------
 * Live read-only checks
 * ----------------------------------------------------------------------- */

async function runLiveChecks() {
  console.log("Phase 1: live library read-only checks (remote loading disabled)");
  console.log("");

  const env = { ...process.env, MEESA_LIBRARY_URL: "" };
  delete env.MEESA_LIBRARY_ROOT;

  const session = new Session(env, "live");
  const semanticReady =
    fs.existsSync(path.join(REPO_ROOT, "catalog", "search-index.json")) &&
    fs.existsSync(path.join(REPO_ROOT, "catalog", "embeddings.json"));
  const hasData =
    fs.existsSync(path.join(REPO_ROOT, "catalog", "search-index.json")) ||
    fs.existsSync(path.join(REPO_ROOT, "catalog", "index.jsonl"));

  try {
    await check("live initialize", async () => {
      const res = await session.request(
        "initialize",
        { protocolVersion: "2024-11-05", capabilities: {} },
        { eol: "\r\n" },
      );
      assert(res && !res.error, `initialize failed: ${res?.error?.message}`);
      assert(
        res.result?.serverInfo?.name === "meesa-asset-library",
        `unexpected server name: ${res.result?.serverInfo?.name}`,
      );
      session.notify("notifications/initialized");
    });

    await check("live tools/list", async () => {
      const res = await session.request("tools/list");
      assert(res && !res.error, `tools/list failed: ${res?.error?.message}`);
      assert(res.result?.tools?.length === 5, "expected five tools");
    });

    if (!hasData) {
      skip("live search", "no catalog index exists in the repository");
      skip(
        "live semantic expectations",
        "no catalog index exists in the repository",
      );
    } else {
      await check("live search finds records", async () => {
        const result = await session.callTool("search_assets", {
          query: "stone",
          limit: 5,
        });
        assert(
          result.res.result.isError !== true,
          `tool returned isError: ${result.text}`,
        );
        assert(Array.isArray(result.json), "search result is not an array");

        if (result.json.length > 0) {
          const first = result.json[0];
          assert(typeof first.id === "string", "result has no id");

          const asset = await session.callTool("get_asset", { id: first.id });
          assert(
            asset.res.result.isError !== true,
            `get_asset failed: ${asset.text}`,
          );
        }
      });

      if (!semanticReady) {
        skip(
          "live semantic expectations",
          "catalog/search-index.json or catalog/embeddings.json is missing",
        );
      } else {
        const search = async (query) => {
          const result = await session.callTool("search_assets", { query });
          assert(
            result.res.result.isError !== true,
            `search ${query} failed: ${result.text}`,
          );
          return result;
        };

        const assertEmptyWithHint = (result, query) => {
          assert(
            Array.isArray(result.json) && result.json.length === 0,
            `${query} returned ${result.json?.length} result(s)`,
          );
          assert(
            result.res.result.content.length === 2,
            `${query} miss did not include a request hint block`,
          );
          const hint = result.res.result.content[1].text;
          assert(
            hint.includes("issues/new"),
            `${query} hint has no issue URL`,
          );
          assert(hint.includes(query), `${query} hint does not repeat the query`);
        };

        await check("live sword, blade and weapon return the model", async () => {
          for (const query of ["sword", "blade", "weapon"]) {
            const result = await search(query);
            assert(
              result.json.length > 0,
              `${query} returned no results`,
            );
            assert(
              result.json[0].kind === "model",
              `${query} ranked a ${result.json[0].kind} instead of the model`,
            );
          }
        });

        await check("live stone returns texture and video", async () => {
          const result = await search("stone");
          assert(
            result.json.some((row) => row.kind === "video"),
            "stone search returned no video",
          );
          assert(
            result.json.some(
              (row) => row.kind === "image" && row.role === "texture",
            ),
            "stone search returned no texture image",
          );
        });

        await check("live ambience returns audio only", async () => {
          const result = await search("ambience");
          assert(result.json.length > 0, "ambience returned no results");
          assert(
            result.json.every((row) => row.kind === "audio"),
            "ambience returned a non-audio asset",
          );
        });

        await check("live music returns empty with a request hint", async () => {
          const result = await search("music");
          assertEmptyWithHint(result, "music");
        });

        await check("live dog returns cross-modal dog assets", async () => {
          const result = await search("dog");
          assert(
            result.json.length >= 4,
            `dog returned ${result.json.length} results`,
          );
          const kinds = new Set(result.json.map((row) => row.kind));
          for (const kind of ["image", "audio", "video", "model"]) {
            assert(kinds.has(kind), `dog returned no ${kind} asset`);
          }
          const ids = new Set(result.json.map((row) => row.id));
          assert(ids.has("IMG-CONCEPT-000013"), "dog returned no sitting-dog image");
          assert(ids.has("SND-SFX-000016"), "dog returned no bark audio");
          assert(ids.has("MDL-PROP-000018"), "dog returned no dog splat");
        });

        await check("live bark returns the dog audio", async () => {
          const result = await search("bark");
          assert(
            result.json.some((row) => row.id === "SND-SFX-000016"),
            "bark returned no dog bark audio",
          );
        });
      }
    }

    await check("live list_taxonomy", async () => {
      const result = await session.callTool("list_taxonomy", {});
      assert(
        result.res.result.isError !== true,
        `tool returned isError: ${result.text}`,
      );
      assert(Array.isArray(result.json.facets), "taxonomy.facets is not an array");
      assert(
        Array.isArray(result.json.collections),
        "taxonomy.collections is not an array",
      );
    });

    await check("live clean shutdown", async () => {
      const info = await session.close();
      assert(
        info.code === 0,
        `expected exit code 0, received ${info.code} (signal ${info.signal})`,
      );
      assert(
        session.stdoutNoise.length === 0,
        `server wrote non-JSON data to stdout: ${session.stdoutNoise[0]}`,
      );
      assert(
        !/unhandled|uncaught/i.test(session.stderrText),
        `stderr reported an unhandled error:\n${session.stderrText.trim()}`,
      );
    });
  } finally {
    await session.forceClose();
  }
}

/* --------------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meesa-mcp-fixture-"));
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meesa-mcp-work-"));

let staticServer = null;

console.log("Meesa Asset Library MCP test");
console.log(`  server: ${SERVER_PATH}`);
console.log(
  `  mode:   ${LIVE ? "live read-only" : "fixture (stdio + HTTP)"}`,
);
console.log("");

try {
  if (LIVE) {
    await runLiveChecks();
  } else {
    const fixture = buildFixture(fixtureRoot);
    fixture.workRoot = workRoot;

    const localResults = await runLocalChecks(fixture);

    // The live producer writes concepts.json as a bare array. Flip the fixture
    // between phases so both the contract shape and the producer shape run.
    const conceptsPath = path.join(fixture.root, "catalog", "concepts.json");
    const conceptsDocument = JSON.parse(fs.readFileSync(conceptsPath, "utf8"));
    if (Array.isArray(conceptsDocument.concepts)) {
      fs.writeFileSync(
        conceptsPath,
        `${JSON.stringify(conceptsDocument.concepts, null, 2)}\n`,
        "utf8",
      );
    }

    staticServer = await startStaticServer(fixtureRoot);
    try {
      await runRemoteChecks(fixture, staticServer, localResults);
    } finally {
      await staticServer.close();
      staticServer = null;
    }
  }
} catch (error) {
  fail("test harness", error instanceof Error ? error.stack : String(error));
} finally {
  if (staticServer) {
    try {
      await staticServer.close();
    } catch {
      // Ignore cleanup failures.
    }
  }

  for (const directory of [fixtureRoot, workRoot]) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove test directory ${directory}: ${error.message}`);
    }
  }

  console.log("");
  console.log(
    `Summary: ${passed} passed, ${failed} failed, ${skipped} skipped, ${assertionCount} assertions`,
  );

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) {
      console.log(`  - ${failure.name}`);
    }
  }

  process.exitCode = failed > 0 ? 1 : 0;
}
