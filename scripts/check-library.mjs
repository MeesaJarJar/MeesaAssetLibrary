#!/usr/bin/env node
// Validate catalog/index.jsonl against the bundles under assets/.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

main().catch((error) => {
  console.error('Error: ' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const root = path.resolve(options.root || DEFAULT_ROOT);
  const indexPath = path.join(root, 'catalog', 'index.jsonl');
  let text;

  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Nothing to check: catalog/index.jsonl does not exist yet.');
      return;
    }
    throw new Error('Cannot read ' + indexPath + ': ' + error.message);
  }

  if (!options.quiet) console.log('Checking ' + root + ' ...');

  let errorCount = 0;
  let warningCount = 0;

  function reportError(message) {
    errorCount += 1;
    console.error('ERROR ' + message);
  }

  function reportWarning(message) {
    warningCount += 1;
    console.warn('WARN  ' + message);
  }

  const entries = parseIndex(text, reportError, reportWarning);
  const knownDirs = new Set();

  for (const entry of entries) {
    if (!entry.dir || !entry.safeDir) continue;

    knownDirs.add(dirKey(entry.dir));

    const bundleDir = path.join(root, ...entry.dir.split('/'));
    const bundleStat = await statSafe(bundleDir);

    if (!bundleStat || !bundleStat.isDirectory()) {
      reportError(entry.dir + ': index directory is missing or is not a directory');
      continue;
    }

    await checkBundle(entry, bundleDir, reportError, reportWarning);
  }

  await scanOrphans(root, knownDirs, reportWarning);

  const errorWord = errorCount === 1 ? 'error' : 'errors';
  const warningWord = warningCount === 1 ? 'warning' : 'warnings';
  console.log('Checked ' + entries.length + ' entries: ' +
    errorCount + ' ' + errorWord + ', ' + warningCount + ' ' + warningWord + '.');

  process.exitCode = errorCount > 0 ? 1 : 0;
}

function parseIndex(text, reportError, reportWarning) {
  const entries = [];
  const seenIds = new Map();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim()) return;

    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      reportError('catalog/index.jsonl:' + lineNo + ': invalid JSON (' + error.message + ')');
      return;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reportError('catalog/index.jsonl:' + lineNo + ': entry is not a JSON object');
      return;
    }

    const entry = { raw, lineNo, id: '', dir: '', safeDir: false };
    entry.id = typeof raw.id === 'string' ? raw.id.trim() : '';

    if (!entry.id) {
      reportError('catalog/index.jsonl:' + lineNo + ': missing or invalid "id"');
    } else if (seenIds.has(entry.id)) {
      reportError('duplicate id "' + entry.id + '" at catalog/index.jsonl:' + lineNo +
        ' (first seen at line ' + seenIds.get(entry.id) + ')');
    } else {
      seenIds.set(entry.id, lineNo);
    }

    const dirValue = typeof raw.dir === 'string'
      ? raw.dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      : '';

    if (!safeRelative(dirValue)) {
      reportError('catalog/index.jsonl:' + lineNo + ': missing or unsafe "dir" (must be repo-relative)');
    } else {
      entry.dir = dirValue;
      entry.safeDir = true;
    }

    checkTags(raw.tags, 'index', 'catalog/index.jsonl:' + lineNo, reportError, reportWarning);
    entries.push(entry);
  });

  return entries;
}

async function checkBundle(entry, bundleDir, reportError, reportWarning) {
  const label = entry.dir;

  const markdownStat = await statSafe(path.join(bundleDir, 'asset.md'));
  if (!markdownStat || !markdownStat.isFile()) {
    reportWarning(label + ': asset.md is missing');
  }

  let bundleText;
  try {
    bundleText = await readFile(path.join(bundleDir, 'asset.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      reportError(label + ': asset.json is missing');
    } else {
      reportError(label + ': asset.json could not be read (' + error.message + ')');
    }
    return;
  }

  let bundle;
  try {
    bundle = JSON.parse(bundleText.replace(/^\uFEFF/, ''));
  } catch (error) {
    reportError(label + ': asset.json is not valid JSON (' + error.message + ')');
    return;
  }

  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    reportError(label + ': asset.json is not a JSON object');
    return;
  }

  const bundleId = typeof bundle.id === 'string' ? bundle.id.trim() : '';
  if (!bundleId) {
    reportError(label + ': asset.json "id" is missing or invalid');
  } else if (entry.id && bundleId !== entry.id) {
    reportError(label + ': asset.json id "' + bundleId + '" does not match index id "' + entry.id + '"');
  }

  // Catalogs may use a short numeric id (000001) or a namespaced id
  // (IMG-TILE-000001); in both cases the bundle's six-digit prefix must agree.
  const prefixMatch = /^(\d{6})(?:-|$)/.exec(path.basename(bundleDir));
  if (!prefixMatch) {
    reportError(label + ': bundle directory name does not start with a 6-digit id');
  } else if (bundleId) {
    const prefix = prefixMatch[1];
    const matches = /^\d{6}$/.test(entry.id)
      ? bundleId === prefix
      : idIncludesPrefix(bundleId, prefix);

    if (!matches) {
      reportError(label + ': asset.json id "' + bundleId + '" does not match bundle prefix "' + prefix + '"');
    }
  }

  checkTags(bundle.tags, 'asset.json', label, reportError, reportWarning);
  await checkPreview(entry.raw, bundle, bundleDir, label, reportError);
  await checkFiles(bundle, bundleDir, label, reportError);
}

function checkTags(tags, source, label, reportError, reportWarning) {
  if (tags === undefined) return;

  if (!Array.isArray(tags)) {
    reportError(label + ': ' + source + ' "tags" is not an array');
    return;
  }

  tags.forEach((tag, index) => {
    if (typeof tag !== 'string' || !tag.trim()) {
      reportError(label + ': ' + source + ' tag #' + (index + 1) + ' is not a non-empty string');
      return;
    }

    const value = tag.trim();
    const colon = value.indexOf(':');

    if (colon <= 0) {
      reportError(label + ': ' + source + ' tag "' + value + '" is not namespace:value');
    } else if (colon === value.length - 1) {
      reportWarning(label + ': ' + source + ' tag "' + value + '" has an empty facet value');
    }
  });
}

async function checkPreview(indexEntry, bundle, bundleDir, label, reportError) {
  const candidates = [];

  if (typeof indexEntry.preview === 'string' && indexEntry.preview.trim()) {
    candidates.push({ source: 'index', value: indexEntry.preview.trim() });
  }
  if (typeof bundle.preview === 'string' && bundle.preview.trim()) {
    candidates.push({ source: 'asset.json', value: bundle.preview.trim() });
  }

  if (!candidates.length) {
    reportError(label + ': preview is not specified in index or asset.json');
    return;
  }

  const checked = new Set();

  for (const candidate of candidates) {
    const preview = candidate.value.replace(/\\/g, '/');
    if (checked.has(preview)) continue;
    checked.add(preview);

    if (!safeRelative(preview)) {
      reportError(label + ': ' + candidate.source + ' preview path "' + preview + '" is unsafe');
      continue;
    }

    const previewPath = path.join(bundleDir, ...preview.split('/'));
    const previewStat = await statSafe(previewPath);

    if (!previewStat || !previewStat.isFile()) {
      reportError(label + ': preview "' + preview + '" is missing');
    }
  }
}

async function checkFiles(bundle, bundleDir, label, reportError) {
  if (bundle.files === undefined) return;

  if (!Array.isArray(bundle.files)) {
    reportError(label + ': asset.json "files" is not an array');
    return;
  }

  for (let index = 0; index < bundle.files.length; index += 1) {
    const file = bundle.files[index];
    const position = 'files[' + index + ']';

    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      reportError(label + ': asset.json ' + position + ' is not an object');
      continue;
    }

    const relativePath = typeof file.path === 'string' ? file.path.trim().replace(/\\/g, '/') : '';
    if (!relativePath) {
      reportError(label + ': asset.json ' + position + ' has a missing or invalid "path"');
      continue;
    }

    if (!safeRelative(relativePath)) {
      reportError(label + ': asset.json ' + position + ' path "' + relativePath + '" is unsafe');
      continue;
    }

    const filePath = path.join(bundleDir, ...relativePath.split('/'));
    const fileStat = await statSafe(filePath);

    if (!fileStat || !fileStat.isFile()) {
      reportError(label + ': file "' + relativePath + '" is missing');
      continue;
    }

    if (typeof file.bytes !== 'number' || !Number.isFinite(file.bytes)) {
      reportError(label + ': file "' + relativePath + '" has an invalid "bytes" value');
    } else if (fileStat.size !== file.bytes) {
      reportError(label + ': file "' + relativePath + '" size mismatch (expected ' +
        file.bytes + ', actual ' + fileStat.size + ')');
    }

    if (typeof file.sha256 === 'string' && file.sha256.trim()) {
      const expected = file.sha256.trim().toLowerCase();
      let actual;

      try {
        actual = await hashFile(filePath);
      } catch (error) {
        reportError(label + ': file "' + relativePath + '" could not be hashed (' + error.message + ')');
        continue;
      }

      if (actual !== expected) {
        reportError(label + ': file "' + relativePath + '" sha256 mismatch (expected ' +
          expected + ', actual ' + actual + ')');
      }
    }
  }
}

async function scanOrphans(root, knownDirs, reportWarning) {
  const assetsRoot = path.join(root, 'assets');
  const assetsStat = await statSafe(assetsRoot);

  if (!assetsStat || !assetsStat.isDirectory()) return;

  async function walk(directory) {
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const item of items) {
      const itemPath = path.join(directory, item.name);

      if (item.isDirectory()) {
        await walk(itemPath);
      } else if (item.isFile() && item.name === 'asset.json') {
        const relativeDir = path.relative(root, directory).split(path.sep).join('/');
        if (!knownDirs.has(dirKey(relativeDir))) {
          reportWarning(relativeDir + ': bundle has asset.json but no index entry');
        }
      }
    }
  }

  await walk(assetsRoot);
}

async function hashFile(filePath) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function statSafe(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function safeRelative(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0')) return false;
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return false;
  return normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function dirKey(relativeDir) {
  const normalized = relativeDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function idIncludesPrefix(id, prefix) {
  const groups = id.match(/\d+/g) || [];
  return groups.includes(prefix);
}

function parseArgs(argv) {
  const options = { root: null, quiet: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root requires a directory');
      options.root = argv[++i];
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else {
      throw new Error('Unknown option "' + arg + '". Use --help for usage.');
    }
  }

  if (options.root === '') throw new Error('--root requires a directory');
  return options;
}

function printUsage() {
  console.log('Usage: node scripts/check-library.mjs [--root <dir>] [--quiet]');
  console.log('');
  console.log('  --root <dir>   Repository root (default: parent of scripts/)');
  console.log('  --quiet        Only print problems and the final summary');
}
