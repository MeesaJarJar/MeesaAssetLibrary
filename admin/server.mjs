#!/usr/bin/env node
// Pack Console - a zero-dependency local admin server for the request queue.
//
// It talks to scripts/lib/pack.mjs through a dynamic import so the console can
// start before the engine exists. All generation and publishing decisions stay
// in the engine; this process only schedules work, tracks progress in memory,
// and serves the local UI.
//
// Run: node admin/server.mjs
// URL: http://127.0.0.1:4310/

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(ADMIN_DIR, '..');
const INDEX_PATH = path.join(ADMIN_DIR, 'index.html');
const ENV_PATH = path.join(ADMIN_DIR, '.env.local');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROGRESS_LINES = 200;
const GROUPS = ['image', 'audio', 'video', 'model'];
const ENGINE_RELATIVE_PATH = path.join('scripts', 'lib', 'pack.mjs');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';
const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

class HttpError extends Error {
  constructor(status, message, code, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || null;
    this.detail = detail || null;
  }
}

// ---------------------------------------------------------------------------
// Configuration and .env.local parsing
// ---------------------------------------------------------------------------

function parseEnvText(text) {
  const values = {};
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

async function readEnvFile(filePath) {
  try {
    return parseEnvText(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new HttpError(500, 'Could not read ' + filePath + ': ' + safeMessage(error));
  }
}

function trimUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function loadConfig(overrides = {}) {
  const envFile =
    overrides.envFile !== undefined
      ? overrides.envFile
      : process.env.ADMIN_ENV_FILE || ENV_PATH;
  const fileEnv = await readEnvFile(envFile);
  const pick = (key) => {
    if (overrides[key] !== undefined) return overrides[key];
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    if (fileEnv[key] !== undefined) return fileEnv[key];
    return undefined;
  };

  const root = path.resolve(
    overrides.root !== undefined ? overrides.root : pick('MEESA_ROOT') || DEFAULT_REPO,
  );

  const rawPort = overrides.port !== undefined ? overrides.port : pick('ADMIN_PORT');
  const port =
    rawPort === undefined || rawPort === null || rawPort === ''
      ? DEFAULT_PORT
      : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new HttpError(500, 'ADMIN_PORT must be an integer from 0 to 65535.');
  }

  const token = String(
    overrides.token !== undefined ? overrides.token : pick('ADMIN_TOKEN') || '',
  ).trim();
  const mock =
    overrides.mock !== undefined
      ? Boolean(overrides.mock)
      : String(pick('MEESA_MOCK') || '') === '1';

  return {
    root,
    port,
    token,
    mock,
    ollamaUrl: trimUrl(
      overrides.ollamaUrl !== undefined ? overrides.ollamaUrl : pick('OLLAMA_URL') || DEFAULT_OLLAMA_URL,
    ),
    model: String(
      overrides.model !== undefined ? overrides.model : pick('OLLAMA_MODEL') || DEFAULT_OLLAMA_MODEL,
    ),
    comfyUrl: trimUrl(
      overrides.comfyUrl !== undefined ? overrides.comfyUrl : pick('COMFYUI_URL') || DEFAULT_COMFY_URL,
    ),
  };
}

function installEngineEnvironment(config) {
  // The engine may read these at module load, before any options reach it.
  const values = {
    MEESA_ROOT: config.root,
    OLLAMA_URL: config.ollamaUrl,
    OLLAMA_MODEL: config.model,
    COMFYUI_URL: config.comfyUrl,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeMessage(error) {
  const message = error && error.message ? error.message : String(error || 'Unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, 700);
}

function normalizeQuery(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!/^[a-z]{3,30}$/.test(query)) {
    throw new HttpError(400, 'query must be one lowercase word of 3-30 letters.', 'BAD_QUERY');
  }
  return query;
}

function normalizeAssets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        if (typeof item.id === 'string') return item.id;
        if (typeof item.path === 'string') return item.path;
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const query = String(raw.query || '').trim().toLowerCase();
  if (!query) return null;
  const requesters = Array.isArray(raw.requesters)
    ? raw.requesters.map((value) => String(value)).filter(Boolean).slice(0, 100)
    : [];
  return {
    query,
    count: Number.isFinite(Number(raw.count)) ? Math.max(0, Number(raw.count)) : 0,
    requesters,
    first: raw.first ? String(raw.first) : null,
    last: raw.last ? String(raw.last) : null,
    note: raw.note ? String(raw.note) : '',
    status: raw.status ? String(raw.status) : 'open',
    assets: Array.isArray(raw.assets) ? raw.assets.map((value) => String(value)) : [],
  };
}

function validateClientPlan(raw, query) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'plan must be a JSON object.', 'BAD_PLAN');
  }
  if (raw.query !== undefined && String(raw.query).toLowerCase() !== query) {
    throw new HttpError(400, 'plan.query does not match the request query.', 'BAD_PLAN');
  }
  let total = 0;
  for (const name of GROUPS) {
    const group = raw[name];
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new HttpError(400, 'plan.' + name + ' is missing.', 'BAD_PLAN');
    }
    const count = Number(group.count);
    if (!Number.isInteger(count) || count < 0 || count > 5) {
      throw new HttpError(400, 'plan.' + name + '.count must be an integer from 0 to 5.', 'BAD_PLAN');
    }
    if (name === 'model') {
      if (group.prompts !== undefined && !Array.isArray(group.prompts)) {
        throw new HttpError(400, 'plan.model.prompts must be an array when present.', 'BAD_PLAN');
      }
    } else if (!Array.isArray(group.prompts) || group.prompts.some((prompt) => typeof prompt !== 'string')) {
      throw new HttpError(400, 'plan.' + name + '.prompts must be an array of strings.', 'BAD_PLAN');
    }
    total += count;
  }
  if (total < 1) {
    throw new HttpError(400, 'The plan must request at least one asset.', 'BAD_PLAN');
  }
  return raw;
}

function statusOf(value) {
  const status = String(value || 'open');
  return /^[a-z-]{2,20}$/.test(status) ? status : 'open';
}

function groupCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(count)));
}

// ---------------------------------------------------------------------------
// Mock engine (MEESA_MOCK=1) - deterministic, no network, no writes
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createMockEngine(config) {
  const requests = [
    {
      query: 'treant',
      count: 3,
      requesters: ['MeesaJarJar', 'octocat', 'mossfan'],
      first: '2026-11-19T10:12:00.000Z',
      last: '2026-11-22T00:49:23.323Z',
      note: 'forest boss',
      status: 'open',
      assets: [],
    },
    {
      query: 'mushroom',
      count: 2,
      requesters: ['sporeling', 'MeesaJarJar'],
      first: '2026-11-20T08:30:00.000Z',
      last: '2026-11-21T18:05:00.000Z',
      note: 'small glowing shelf fungus',
      status: 'open',
      assets: [],
    },
    {
      query: 'crystal',
      count: 1,
      requesters: ['shardling'],
      first: '2026-11-18T14:20:00.000Z',
      last: '2026-11-18T14:20:00.000Z',
      note: 'a usable cave crystal cluster',
      status: 'planned',
      assets: [],
    },
    {
      query: 'wisp',
      count: 4,
      requesters: ['glowbug', 'octocat', 'mossfan', 'MeesaJarJar'],
      first: '2026-11-17T09:00:00.000Z',
      last: '2026-11-20T22:10:00.000Z',
      note: 'soft floating light for a swamp',
      status: 'fulfilled',
      assets: ['IMG-CONCEPT-900001', 'SND-SFX-900002'],
    },
    {
      query: 'golem',
      count: 1,
      requesters: ['stonewright'],
      first: '2026-11-16T11:45:00.000Z',
      last: '2026-11-16T11:45:00.000Z',
      note: 'mossy stone guardian',
      status: 'rejected',
      assets: [],
    },
  ];

  const repo = { dirty: false, commit: '9f1c2ab77d1e' };

  function find(query) {
    return requests.find((request) => request.query === query) || null;
  }

  function makePlan(query) {
    const label = titleCase(query);
    const baseTags = ['subject:request/' + query, 'style:stylized', 'engine:any'];
    return {
      query,
      family: query,
      image: {
        count: 1,
        prompts: [
          'game concept art of a ' +
            query +
            ', single subject, full body, centered, neutral dark studio background, clean silhouette, no text',
        ],
        negative: 'text, watermark, blurry, multiple subjects, frame, human',
        title: label + ' Concept',
        summary:
          'A single game-ready ' +
          query +
          ' concept on a neutral studio background. Use it as a first-pass prop, creature, or environment reference.',
        tags: [...baseTags, 'use:concept-art', 'format:png'],
        keywords: [query, 'concept', 'game asset'],
      },
      audio: {
        count: 1,
        prompts: [
          'a natural ' + query + ' sound effect, close perspective, single event, dry, no music, no reverb',
        ],
        negative: 'music, loop, noise, distortion',
        title: label + ' Sound',
        summary:
          'A four-second one-shot sound effect for a ' +
          query +
          '. Use it as a first-pass cue and trim it for the final mix.',
        tags: [...baseTags, 'use:sfx', 'format:mp3'],
        keywords: [query, 'sfx', 'sound'],
      },
      video: {
        count: 0,
        prompts: [],
        negative: 'text, watermark, camera shake',
        title: label + ' Loop',
        summary: 'Reserved for a short looping animation of the ' + query + '.',
        tags: [...baseTags, 'use:animation', 'format:mp4'],
        keywords: [query, 'loop', 'animation'],
      },
      model: {
        count: 0,
        prompts: [],
        negative: '',
        title: label + ' Model',
        summary: 'Reserved for a low-poly game-ready model of the ' + query + '.',
        tags: [...baseTags, 'use:prop', 'format:glb'],
        keywords: [query, 'model', 'prop'],
      },
    };
  }

  return {
    repo() {
      return { dirty: repo.dirty, commit: repo.commit };
    },
    async health() {
      return {
        ollama: { ok: true, model: config.model },
        comfy: { ok: true },
      };
    },
    async readRequests() {
      return {
        requests: requests.map((request) => ({
          ...request,
          requesters: [...request.requesters],
          assets: [...request.assets],
        })),
        status: 'ok',
      };
    },
    async planPack(query) {
      await delay(120);
      return makePlan(query);
    },
    async generatePack(plan, opts = {}) {
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
      const query = String((plan && plan.query) || 'pack');
      const produced = [];
      for (const name of GROUPS) {
        const count = groupCount(plan && plan[name] ? plan[name].count : 0);
        for (let index = 1; index <= count; index += 1) {
          onProgress(name, 'Generated ' + name + ' ' + index + ' of ' + count + ' for "' + query + '".', {
            index,
            total: count,
          });
          produced.push('MOCK-' + name.toUpperCase() + '-' + String(900100 + produced.length));
          await delay(420);
        }
      }
      onProgress('ingest', 'Copying the generated files into the library bundles.', {});
      await delay(320);
      onProgress('build', 'Refreshing the catalog, search index, and gallery.', {});
      await delay(360);
      const request = find(query);
      if (request) {
        request.status = 'fulfilled';
        request.assets = produced.map((id) => id);
      }
      repo.dirty = true;
      onProgress('done', 'Generated ' + produced.length + ' asset(s).', { assets: produced.length });
      return { assets: produced, status: 'fulfilled' };
    },
    async publishPack(query) {
      await delay(180);
      const request = find(query);
      if (!request || request.status !== 'fulfilled') {
        throw new Error('Only a fulfilled request can be published.');
      }
      repo.dirty = false;
      repo.commit = 'a1b2c3d4e5f6';
      return { commit: repo.commit };
    },
    async rejectRequest(query, reason) {
      await delay(100);
      const request = find(query);
      if (!request) throw new Error('Request not found: ' + query);
      request.status = 'rejected';
      request.reason = String(reason || '');
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Live engine loader
// ---------------------------------------------------------------------------

function createEngineLoader(config) {
  let loaded = null;
  let lastError = '';
  let lastAttempt = 0;

  async function getEngine() {
    if (config.mock) return null;
    if (loaded) return loaded;
    const now = Date.now();
    if (now - lastAttempt < 1500) return null;
    lastAttempt = now;

    const enginePath = path.join(config.root, ENGINE_RELATIVE_PATH);
    try {
      const info = await stat(enginePath);
      if (!info.isFile()) throw new Error('not a file');
    } catch (error) {
      lastError = 'scripts/lib/pack.mjs was not found under ' + config.root;
      return null;
    }

    try {
      const moduleUrl = pathToFileURL(enginePath).href + '?v=' + now;
      const imported = await import(moduleUrl);
      for (const name of ['planPack', 'generatePack', 'publishPack', 'rejectRequest', 'readRequests']) {
        if (typeof imported[name] !== 'function') {
          throw new Error('scripts/lib/pack.mjs does not export ' + name + '()');
        }
      }
      loaded = imported;
      lastError = '';
      return loaded;
    } catch (error) {
      lastError = safeMessage(error);
      return null;
    }
  }

  return {
    getEngine,
    getError: () => lastError,
  };
}

// ---------------------------------------------------------------------------
// Server runtime
// ---------------------------------------------------------------------------

function createRuntime(config) {
  const mock = config.mock ? createMockEngine(config) : null;
  const engineLoader = createEngineLoader(config);
  const jobs = new Map();
  const queryJobs = new Map();
  const overrides = new Map();
  const publishing = new Set();
  let gitCache = { at: 0, value: { dirty: false, commit: null } };

  async function getEngine() {
    if (mock) return mock;
    return engineLoader.getEngine();
  }

  async function requireEngine() {
    const engine = await getEngine();
    if (!engine) {
      const reason = config.mock
        ? 'The mock engine failed to load.'
        : engineLoader.getError() || 'scripts/lib/pack.mjs is missing or failed to load.';
      throw new HttpError(
        503,
        'Engine not ready. ' + reason,
        'ENGINE_NOT_READY',
        engineLoader.getError() || null,
      );
    }
    return engine;
  }

  function engineOptions() {
    return {
      repo: config.root,
      root: config.root,
      ollamaUrl: config.ollamaUrl,
      model: config.model,
      comfyUrl: config.comfyUrl,
    };
  }

  async function checkHealth() {
    if (mock) return mock.health();
    const probe = async (url) => {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(1200),
        });
        await response.text().catch(() => '');
        return response.ok;
      } catch {
        return false;
      }
    };
    const [ollamaOk, comfyOk] = await Promise.all([
      probe(config.ollamaUrl + '/api/tags'),
      probe(config.comfyUrl + '/system_stats'),
    ]);
    return {
      ollama: { ok: ollamaOk, model: config.model },
      comfy: { ok: comfyOk },
    };
  }

  function invalidateGitCache() {
    gitCache = { at: 0, value: gitCache.value };
  }

  async function getGitInfo() {
    if (mock) return mock.repo();
    const now = Date.now();
    if (now - gitCache.at < 1200) return gitCache.value;
    let value = { dirty: false, commit: null };
    try {
      const options = {
        cwd: config.root,
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      };
      const [statusResult, headResult] = await Promise.all([
        execFileAsync('git', ['status', '--porcelain'], options),
        execFileAsync('git', ['rev-parse', '--short', 'HEAD'], options),
      ]);
      value = {
        dirty: String(statusResult.stdout || '').trim().length > 0,
        commit: String(headResult.stdout || '').trim() || null,
      };
    } catch {
      value = { dirty: false, commit: null };
    }
    gitCache = { at: now, value };
    return value;
  }

  async function readStatusDocument() {
    if (mock) return { requests: {} };
    try {
      const text = await readFile(
        path.join(config.root, 'catalog', 'asset-requests-status.json'),
        'utf8',
      );
      const document = JSON.parse(text.replace(/^\uFEFF/, ''));
      return document && typeof document === 'object' ? document : { requests: {} };
    } catch {
      return { requests: {} };
    }
  }

  function persistedStatus(value) {
    const status = String(value || '').toLowerCase();
    if (
      status === 'fulfilled' ||
      status === 'rejected' ||
      status === 'planned' ||
      status === 'failed'
    ) {
      return status;
    }
    // "generating" left in the status file is from a previous process. Live
    // work is represented by an in-memory override instead.
    return 'open';
  }

  function mergeStatusEntryIntoRequest(request, entry) {
    if (!entry || typeof entry !== 'object') return request;
    const assets = Array.isArray(entry.assets)
      ? entry.assets.map((value) => String(value))
      : request.assets;
    return {
      ...request,
      status: persistedStatus(entry.status),
      assets,
    };
  }

  function aggregateRawRequests(records, statusDocument) {
    const statusRequests =
      statusDocument && statusDocument.requests && typeof statusDocument.requests === 'object'
        ? statusDocument.requests
        : {};
    const groups = new Map();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const query = String(record.query || '').trim().toLowerCase();
      if (!query) continue;
      let group = groups.get(query);
      if (!group) {
        group = {
          query,
          count: 0,
          requesters: [],
          first: null,
          last: null,
          note: '',
          noteAt: '',
          status: 'open',
          assets: [],
        };
        groups.set(query, group);
      }
      group.count += 1;
      const requester = String(record.requested_by || '').trim();
      if (requester && group.requesters.indexOf(requester) < 0) group.requesters.push(requester);
      const at = String(record.requested_at || '').trim();
      if (at) {
        if (!group.first || at < group.first) group.first = at;
        if (!group.last || at > group.last) group.last = at;
      }
      const note = String(record.note || '').trim();
      if (note && (!group.noteAt || at >= group.noteAt)) {
        group.note = note;
        group.noteAt = at;
      }
    }
    return [...groups.values()].map((group) => {
      const entry = statusRequests[group.query];
      const normalized = mergeStatusEntryIntoRequest(
        {
          query: group.query,
          count: group.count,
          requesters: group.requesters,
          first: group.first,
          last: group.last,
          note: group.note,
          status: 'open',
          assets: [],
        },
        entry,
      );
      return normalized;
    });
  }

  async function readBaseRequests() {
    const engine = await getEngine();
    if (!engine) return [];
    let data;
    try {
      data = await engine.readRequests(config.root);
    } catch (error) {
      throw new HttpError(502, 'Reading the request queue failed: ' + safeMessage(error), 'READ_FAILED');
    }

    if (Array.isArray(data)) {
      const raw = data.filter((record) => record && typeof record === 'object');
      const looksAggregated = raw.some(
        (record) =>
          !record.requested_at &&
          !record.requested_by &&
          (record.count !== undefined || Array.isArray(record.requesters)),
      );
      if (looksAggregated) {
        const statusDocument = await readStatusDocument();
        const statusRequests =
          statusDocument && statusDocument.requests && typeof statusDocument.requests === 'object'
            ? statusDocument.requests
            : {};
        return raw
          .map(normalizeRequest)
          .filter(Boolean)
          .map((request) => mergeStatusEntryIntoRequest(request, statusRequests[request.query]));
      }
      return aggregateRawRequests(raw, await readStatusDocument());
    }

    const list = data && Array.isArray(data.requests) ? data.requests : [];
    if (!list.length) return [];
    const normalized = list.map(normalizeRequest).filter(Boolean);
    const hasStatuses = normalized.some((request) => request.status !== 'open' || request.assets.length > 0);
    if (hasStatuses) return normalized;
    const statusDocument = data && data.status && typeof data.status === 'object' ? data.status : null;
    const source = statusDocument || (await readStatusDocument());
    const statusRequests = source && source.requests && typeof source.requests === 'object' ? source.requests : {};
    return normalized.map((request) => mergeStatusEntryIntoRequest(request, statusRequests[request.query]));
  }

  function applyOverride(request) {
    const override = overrides.get(request.query);
    if (!override) return request;
    return {
      ...request,
      status: statusOf(override.status || request.status),
      assets: Array.isArray(override.assets) ? override.assets : request.assets,
      ...(override.jobId ? { jobId: override.jobId } : {}),
    };
  }

  async function listRequests() {
    const base = await readBaseRequests();
    return base.map(applyOverride);
  }

  async function findRequest(query) {
    const requests = await listRequests();
    return requests.find((request) => request.query === query) || null;
  }

  async function buildState() {
    const engine = await getEngine();
    let requests = [];
    let readError = null;
    if (engine) {
      try {
        requests = await listRequests();
      } catch (error) {
        readError = safeMessage(error);
      }
    } else {
      readError = engineLoader.getError() || null;
    }
    const [health, repo] = await Promise.all([checkHealth(), getGitInfo()]);
    const state = {
      requests,
      health,
      engineReady: Boolean(engine),
      tokenRequired: Boolean(config.token),
      repo,
    };
    if (readError) state.engineError = readError;
    return state;
  }

  function jobView(job) {
    return {
      id: job.id,
      query: job.query,
      state: job.state,
      progress: job.progress.map((line) => ({ ...line })),
      error: job.error,
      assets: [...job.assets],
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  function pushProgress(job, stage, message) {
    job.progress.push({
      at: new Date().toISOString(),
      stage: String(stage || 'progress').slice(0, 60),
      message: String(message || '').slice(0, 2000),
    });
    while (job.progress.length > MAX_PROGRESS_LINES) job.progress.shift();
  }

  function isRunning(job) {
    return job && (job.state === 'generating' || job.state === 'queued');
  }

  async function runGeneration(job, plan, engine) {
    try {
      const result = await engine.generatePack(plan, {
        ...engineOptions(),
        onProgress(...args) {
          // The shipped engine emits one event object. The published contract
          // allows (stage, message, data). Accept both shapes.
          let stage = 'progress';
          let message = '';
          if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            stage = args[0].stage;
            message = args[0].message;
          } else {
            stage = args[0];
            message = args[1];
          }
          pushProgress(job, stage, message);
        },
      });
      const assets = normalizeAssets(result && result.assets);
      const rawStatus = result && result.status;
      const failed =
        rawStatus === 'failed' ||
        (rawStatus && typeof rawStatus === 'object' && rawStatus.status === 'failed');
      job.assets = assets;
      job.state = failed ? 'failed' : 'fulfilled';
      job.finishedAt = new Date().toISOString();
      if (job.state === 'fulfilled') {
        pushProgress(job, 'done', 'Generation finished with ' + assets.length + ' asset(s).');
        overrides.set(job.query, {
          status: 'fulfilled',
          assets,
          jobId: job.id,
        });
      } else {
        job.error = 'The engine reported a failed generation.';
        pushProgress(job, 'error', job.error);
        overrides.set(job.query, { status: 'failed', jobId: job.id });
      }
    } catch (error) {
      job.state = 'failed';
      const partial = normalizeAssets(error && error.assets);
      if (partial.length) job.assets = partial;
      job.error = safeMessage(error) + (error && error.stage ? ' (stage: ' + error.stage + ')' : '');
      job.finishedAt = new Date().toISOString();
      pushProgress(job, (error && error.stage) || 'error', job.error);
      overrides.set(job.query, { status: 'failed', jobId: job.id });
    } finally {
      if (queryJobs.get(job.query) === job.id) queryJobs.delete(job.query);
    }
  }

  function startGeneration(query, plan, engine) {
    const id = 'job-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
    const job = {
      id,
      query,
      state: 'generating',
      progress: [],
      error: null,
      assets: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    jobs.set(id, job);
    queryJobs.set(query, id);
    overrides.set(query, { status: 'generating', jobId: id });
    pushProgress(job, 'queued', 'Generation job queued for "' + query + '".');
    setTimeout(() => {
      runGeneration(job, plan, engine);
    }, 20);
    return job;
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  function sendJson(response, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    });
    response.end(body);
  }

  function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
    response.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    response.end(text);
  }

  function isAuthorized(request) {
    if (!config.token) return true;
    const header = String(request.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    const provided = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(config.token, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  function readJsonBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (tooLarge) {
          reject(new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE'));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpError(400, 'Request body must be valid JSON.', 'BAD_JSON'));
        }
      });
      request.on('error', (error) => {
        reject(new HttpError(400, 'Could not read the request body: ' + safeMessage(error), 'BAD_BODY'));
      });
    });
  }

  async function serveIndex(request, response) {
    let html;
    try {
      html = await readFile(INDEX_PATH, 'utf8');
    } catch (error) {
      throw new HttpError(500, 'admin/index.html could not be read: ' + safeMessage(error), 'NO_INDEX');
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  }

  async function handleRequest(request, response) {
    try {
      await route(request, response);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) {
        console.error('Request failed: ' + safeMessage(error));
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const payload = {
        error: error instanceof HttpError ? error.message : 'Internal server error.',
        code: error instanceof HttpError && error.code ? error.code : 'INTERNAL',
      };
      if (error instanceof HttpError && error.detail) payload.detail = error.detail;
      sendJson(response, status, payload);
    }
  }

  async function route(request, response) {
    if (!request.url) throw new HttpError(400, 'Bad request.', 'BAD_REQUEST');
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      throw new HttpError(400, 'Bad request.', 'BAD_REQUEST');
    }
    const pathname = url.pathname;
    const method = String(request.method || 'GET').toUpperCase();

    if (pathname === '/' || pathname === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, HEAD' });
        return;
      }
      await serveIndex(request, response);
      return;
    }

    if (pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (pathname === '/session-info') {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
        return;
      }
      sendJson(response, 200, {
        tokenRequired: Boolean(config.token),
        mock: Boolean(config.mock),
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!isAuthorized(request)) {
        sendJson(
          response,
          401,
          {
            error: 'Unauthorized. Send Authorization: Bearer <ADMIN_TOKEN>.',
            code: 'UNAUTHORIZED',
            tokenRequired: true,
          },
          { 'www-authenticate': 'Bearer' },
        );
        return;
      }

      if (pathname === '/api/state') {
        if (method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
          return;
        }
        sendJson(response, 200, await buildState());
        return;
      }

      if (pathname === '/api/health') {
        if (method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
          return;
        }
        const [health, engine] = await Promise.all([checkHealth(), getEngine()]);
        sendJson(response, 200, { ...health, engineReady: Boolean(engine) });
        return;
      }

      if (pathname === '/api/plan') {
        if (method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
          return;
        }
        const body = await readJsonBody(request);
        const query = normalizeQuery(body.query);
        const engine = await requireEngine();
        let plan;
        try {
          plan = await engine.planPack(query, engineOptions());
        } catch (error) {
          throw new HttpError(502, 'Planning failed: ' + safeMessage(error), 'PLAN_FAILED');
        }
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
          throw new HttpError(502, 'The engine returned an invalid plan.', 'PLAN_FAILED');
        }
        const existing = overrides.get(query);
        if (!existing || (existing.status !== 'fulfilled' && existing.status !== 'rejected')) {
          overrides.set(query, { ...(existing || {}), status: 'planned' });
        }
        sendJson(response, 200, plan);
        return;
      }

      if (pathname === '/api/generate') {
        if (method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
          return;
        }
        const body = await readJsonBody(request);
        const query = normalizeQuery(body.query);
        const plan = validateClientPlan(body.plan, query);
        const activeId = queryJobs.get(query);
        const activeJob = activeId ? jobs.get(activeId) : null;
        if (isRunning(activeJob)) {
          sendJson(response, 409, {
            error: 'A generation job is already running for this request.',
            code: 'JOB_ACTIVE',
            jobId: activeJob.id,
          });
          return;
        }
        const engine = await requireEngine();
        const job = startGeneration(query, plan, engine);
        sendJson(response, 200, { jobId: job.id });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (jobMatch) {
        if (method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
          return;
        }
        let id;
        try {
          id = decodeURIComponent(jobMatch[1]);
        } catch {
          throw new HttpError(400, 'Bad job id.', 'BAD_JOB_ID');
        }
        const job = jobs.get(id);
        if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
        sendJson(response, 200, jobView(job));
        return;
      }

      if (pathname === '/api/publish') {
        if (method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
          return;
        }
        const body = await readJsonBody(request);
        const query = normalizeQuery(body.query);
        const activeId = queryJobs.get(query);
        if (isRunning(activeId ? jobs.get(activeId) : null)) {
          throw new HttpError(409, 'Wait for the generation job to finish before publishing.', 'JOB_ACTIVE');
        }
        if (publishing.has(query)) {
          throw new HttpError(409, 'A publish operation is already running for this request.', 'PUBLISH_ACTIVE');
        }
        const engine = await requireEngine();
        const current = await findRequest(query);
        if (!current || current.status !== 'fulfilled') {
          throw new HttpError(409, 'Only a fulfilled request can be published.', 'NOT_FULFILLED');
        }
        const repo = await getGitInfo();
        if (!repo.dirty) {
          throw new HttpError(409, 'There are no uncommitted changes to publish.', 'NOTHING_TO_PUBLISH');
        }
        publishing.add(query);
        try {
          let result;
          try {
            result = await engine.publishPack(query, {
              ...engineOptions(),
              message: 'Add pack for "' + query + '"',
            });
          } catch (error) {
            throw new HttpError(502, 'Publishing failed: ' + safeMessage(error), 'PUBLISH_FAILED');
          }
          let commit = result && typeof result.commit === 'string' ? result.commit.trim() : '';
          if (!commit && result && result.reason === 'no changes') {
            throw new HttpError(409, 'There are no uncommitted changes to publish.', 'NOTHING_TO_PUBLISH');
          }
          if (!commit) {
            const after = await getGitInfo();
            commit = after.commit || '';
          }
          if (!commit) {
            throw new HttpError(502, 'The engine did not return a commit hash.', 'NO_COMMIT');
          }
          const existing = overrides.get(query) || {};
          overrides.set(query, { ...existing, status: 'fulfilled' });
          invalidateGitCache();
          sendJson(response, 200, { ok: true, commit });
          return;
        } finally {
          publishing.delete(query);
        }
      }

      if (pathname === '/api/reject') {
        if (method !== 'POST') {
          sendJson(response, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
          return;
        }
        const body = await readJsonBody(request);
        const query = normalizeQuery(body.query);
        const reason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!reason) {
          throw new HttpError(400, 'A rejection reason is required.', 'BAD_REASON');
        }
        const activeId = queryJobs.get(query);
        if (isRunning(activeId ? jobs.get(activeId) : null)) {
          throw new HttpError(409, 'Wait for the generation job to finish before rejecting.', 'JOB_ACTIVE');
        }
        const engine = await requireEngine();
        try {
          await engine.rejectRequest(query, reason, config.root);
        } catch (error) {
          throw new HttpError(502, 'Rejecting the request failed: ' + safeMessage(error), 'REJECT_FAILED');
        }
        const existing = overrides.get(query) || {};
        overrides.set(query, { ...existing, status: 'rejected' });
        sendJson(response, 200, { ok: true });
        return;
      }

      throw new HttpError(404, 'API route not found.', 'NOT_FOUND');
    }

    throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  }

  return { handleRequest };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startServer(overrides = {}) {
  const config = await loadConfig(overrides);
  installEngineEnvironment(config);
  const runtime = createRuntime(config);
  const server = http.createServer((request, response) => {
    runtime.handleRequest(request, response).catch((error) => {
      console.error('Request failed: ' + safeMessage(error));
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal server error\n');
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  try {
    await listen(server, config.port, HOST);
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      throw new Error('Port ' + config.port + ' is already in use. Stop the other process or set ADMIN_PORT.');
    }
    throw error;
  }

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.port;
  const url = 'http://' + HOST + ':' + port + '/';

  if (!overrides.quiet) {
    console.log('Pack Console running at ' + url);
    console.log(
      'Engine: ' +
        (config.mock ? 'mock (MEESA_MOCK=1)' : 'scripts/lib/pack.mjs (loaded on first use)') +
        '. Auth: ' +
        (config.token ? 'Bearer token required' : 'no token, local only') +
        '.',
    );
  }

  return {
    server,
    port,
    url,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--port') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--port requires a value.');
      options.port = Number(value);
      index += 1;
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node admin/server.mjs [--port <number>]');
    console.log('Default: http://127.0.0.1:4310/');
    console.log('Configure with admin/.env.local (see admin/.env.local.example).');
    return;
  }
  const app = await startServer({ port: args.port });
  const shutdown = () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('Pack Console failed: ' + safeMessage(error));
    process.exitCode = 1;
  });
}
