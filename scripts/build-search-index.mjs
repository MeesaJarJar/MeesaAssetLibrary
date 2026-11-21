#!/usr/bin/env node
// Build catalog/search-index.json for the static gallery.
//
// Dependency-free Node ESM. Reads catalog/index.jsonl, catalog/community.jsonl,
// catalog/concepts.json and catalog/embeddings.json, then writes the flattened
// search index used by the gallery.
//
// Usage: node scripts/build-search-index.mjs [--root <dir>]

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--root=')) {
      root = path.resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return root;
}

async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function promptText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item).trim()).filter(Boolean).join(', ');
    return joined || null;
  }
  return null;
}

function assetText(asset) {
  const parts = [];
  if (asset.title) parts.push(String(asset.title).trim());
  if (asset.summary) parts.push(String(asset.summary).trim());
  if (asset.tags.length) parts.push(asset.tags.join(', '));
  if (asset.keywords.length) parts.push(asset.keywords.join(', '));
  if (asset.prompt) parts.push(asset.prompt);
  return parts
    .filter(Boolean)
    .map((part) => part.replace(/[. ]+$/g, ''))
    .filter(Boolean)
    .join('. ');
}

const IRREGULAR = new Map([
  ['children', 'child'],
  ['feet', 'foot'],
  ['geese', 'goose'],
  ['knives', 'knife'],
  ['leaves', 'leaf'],
  ['lives', 'life'],
  ['men', 'man'],
  ['mice', 'mouse'],
  ['people', 'person'],
  ['teeth', 'tooth'],
  ['wolves', 'wolf'],
  ['women', 'woman'],
]);

function stemToken(token) {
  if (IRREGULAR.has(token)) return IRREGULAR.get(token);
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !/(?:ss|us|is|as)$/.test(token)) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  const tokens = new Set();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    tokens.add(stemToken(raw));
  }
  return [...tokens];
}

function normalizeAsset(row, scope) {
  const tags = asList(row.tags);
  const keywords = asList(row.keywords);
  const prompt = promptText(row.prompt);
  const family = typeof row.family === 'string' && row.family.trim()
    ? row.family.trim()
    : null;
  const asset = {
    id: String(row.id),
    kind: row.kind ?? null,
    role: row.role ?? null,
    title: row.title ?? '',
    summary: row.summary ?? '',
    tags,
    keywords,
    prompt,
    family,
    scope,
    contributor: row.contributor ?? null,
    license: row.license ?? null,
    preview: row.preview ?? null,
    file: row.file ?? null,
    mime: row.mime ?? null,
    bytes: Number.isFinite(row.bytes) ? row.bytes : null,
    sha256: row.sha256 ?? null,
    dir: row.dir ?? null,
    added: row.added ?? null,
    text: '',
    tokens: [],
    embeddings: {
      clipImage: null,
      clipText: null,
      clapAudio: null,
      clapText: null,
    },
  };
  asset.text = assetText(asset);
  asset.tokens = tokenize(asset.text);
  return asset;
}

function promptFamilyKey(prompt) {
  return `prompt-${createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 8)}`;
}

async function main() {
  const root = parseArgs(process.argv.slice(2));
  const catalogDir = path.join(root, 'catalog');

  const curated = (await readJsonl(path.join(catalogDir, 'index.jsonl')))
    .map((row) => normalizeAsset(row, 'curated'));
  const community = (await readJsonl(path.join(catalogDir, 'community.jsonl')))
    .map((row) => normalizeAsset(row, 'community'));

  const seenIds = new Set();
  for (const asset of [...curated, ...community]) {
    if (!asset.id) throw new Error('catalog row without id');
    if (seenIds.has(asset.id)) throw new Error(`duplicate asset id: ${asset.id}`);
    seenIds.add(asset.id);
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const assets = [...curated, ...community].sort(byId);

  const embeddingsFile = path.join(catalogDir, 'embeddings.json');
  let embeddings;
  try {
    embeddings = JSON.parse(await readFile(embeddingsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('catalog/embeddings.json is missing; run python scripts/embed.py first');
    }
    throw error;
  }
  for (const asset of assets) {
    const record = embeddings.assets?.[asset.id];
    if (record && typeof record === 'object') {
      asset.embeddings = {
        clipImage: record.clipImage ?? null,
        clipText: record.clipText ?? null,
        clapAudio: record.clapAudio ?? null,
        clapText: record.clapText ?? null,
      };
    }
  }

  let conceptsDocument;
  try {
    conceptsDocument = JSON.parse(
      await readFile(path.join(catalogDir, 'concepts.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      conceptsDocument = JSON.parse(
        await readFile(path.join(root, 'scripts', 'concepts.json'), 'utf8'),
      );
    } else {
      throw error;
    }
  }
  const concepts = Array.isArray(conceptsDocument)
    ? conceptsDocument
    : Array.isArray(conceptsDocument?.concepts)
      ? conceptsDocument.concepts
      : null;
  if (!concepts || !concepts.length) {
    throw new Error('catalog/concepts.json has no concept array; run python scripts/embed.py');
  }
  concepts.sort(byId);

  // Prompt families only form among assets without an explicit family, and
  // only when at least two assets share the exact same non-empty prompt.
  const promptIds = new Map();
  for (const asset of assets) {
    if (asset.family || !asset.prompt) continue;
    if (!promptIds.has(asset.prompt)) promptIds.set(asset.prompt, []);
    promptIds.get(asset.prompt).push(asset.id);
  }
  const promptKeys = new Map();
  for (const [prompt, ids] of promptIds) {
    if (ids.length >= 2) promptKeys.set(prompt, promptFamilyKey(prompt));
  }
  for (const asset of assets) {
    if (asset.family || !asset.prompt) continue;
    const key = promptKeys.get(asset.prompt);
    if (key) asset.family = key;
  }

  const familyMap = new Map();
  for (const asset of assets) {
    if (!asset.family) continue;
    if (!familyMap.has(asset.family)) familyMap.set(asset.family, []);
    familyMap.get(asset.family).push(asset.id);
  }
  const families = {};
  for (const key of [...familyMap.keys()].sort()) {
    families[key] = familyMap.get(key);
  }

  const tokenMap = new Map();
  for (const asset of assets) {
    for (const token of asset.tokens) {
      if (!tokenMap.has(token)) tokenMap.set(token, []);
      tokenMap.get(token).push(asset.id);
    }
  }
  const tokens = {};
  for (const key of [...tokenMap.keys()].sort()) {
    tokens[key] = tokenMap.get(key);
  }

  const index = {
    version: 1,
    generated: new Date().toISOString(),
    assets,
    tokens,
    families,
    concepts,
    stats: {
      assets: assets.length,
      families: Object.keys(families).length,
      concepts: concepts.length,
    },
  };

  const output = path.join(catalogDir, 'search-index.json');
  await writeFile(output, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(
    `Indexed ${assets.length} assets, ${Object.keys(tokens).length} tokens, ` +
      `${Object.keys(families).length} families -> catalog/search-index.json`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
