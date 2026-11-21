#!/usr/bin/env node
// Ingest one file as one complete bundle, then append it to the catalog.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const KIND_ABBR = {
  image: 'IMG', model: 'MDL', audio: 'SND', video: 'VID', font: 'FNT',
  material: 'MAT', doc: 'DOC', project: 'PRJ', other: 'MSC',
};
const ORIGINS = ['original', 'generated', 'purchased', 'reference', 'unknown'];
const PREVIEW_WARN_BYTES = 512 * 1024;
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.blend': 'application/octet-stream',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.md': 'text/markdown', '.pdf': 'application/pdf', '.csv': 'text/csv',
  '.json': 'application/json', '.txt': 'text/plain',
};
main().catch((error) => {
  console.error('ERROR ' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printUsage();
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const indexPath = path.join(root, 'catalog', 'index.jsonl');
  const indexText = await readFile(indexPath, 'utf8').catch((error) => {
    throw new Error(error.code === 'ENOENT' ? 'catalog/index.jsonl not found under ' + root : 'cannot read ' + indexPath + ': ' + error.message);
  });

  const input = validateInput(options);
  const sourcePath = path.resolve(input.file), sourceStat = await statFile(sourcePath, 'source file');
  const previewPath = input.preview ? path.resolve(input.preview) : sourcePath;
  const previewStat = await statFile(previewPath, 'preview file');
  const sourceHash = await hashFile(sourcePath);
  const detected = input.kind === 'image' ? await detectImage(sourcePath)
    : input.kind === 'audio' ? await detectWav(sourcePath, sourceStat.size) : null;
  const technical = { ...(detected || {}), ...input.technical };

  const existing = await scanExisting(root, indexText);
  const duplicate = existing.hashes.get(sourceHash);
  if (duplicate && !options.allowDuplicate) {
    throw new Error('duplicate source file (sha256 ' + sourceHash + ') is already ingested as ' + duplicate + '; pass --allow-duplicate to override');
  }

  const seqText = String(existing.maxSeq + 1).padStart(6, '0');
  const id = KIND_ABBR[input.kind] + '-' + input.role.toUpperCase() + '-' + seqText;
  const bundleName = seqText + '-' + input.slug;
  const bundleDir = path.join(root, 'assets', input.kind, input.role, bundleName);
  const relDir = ['assets', input.kind, input.role, bundleName].join('/');
  if (await statSafe(bundleDir)) throw new Error('bundle directory already exists: ' + relDir);

  const roleDir = path.join(root, 'assets', input.kind, input.role), roleStat = await statSafe(roleDir);
  if (!roleStat && !options.allowNewRole) throw new Error('role directory does not exist: assets/' + input.kind + '/' + input.role + '; pass --allow-new-role to create it');
  if (roleStat && !roleStat.isDirectory()) throw new Error('role path is not a directory: assets/' + input.kind + '/' + input.role);

  const sourceName = path.basename(sourcePath);
  const previewName = 'preview' + safeExtension(path.extname(previewPath) || path.extname(sourcePath));
  const mime = MIME_BY_EXT[path.extname(sourceName).toLowerCase()] || 'application/octet-stream';
  const added = localDate();
  if (previewStat.size > PREVIEW_WARN_BYTES) console.warn('WARN preview is ' + previewStat.size + ' bytes, over 512 KB; copied without resizing.');

  const bundle = {
    schema: 1, id, kind: input.kind, role: input.role, title: input.title, summary: input.summary, tags: input.tags, preview: previewName,
    files: [{ path: 'src/' + sourceName, bytes: sourceStat.size, mime, sha256: sourceHash }], technical,
    source: { origin: input.origin, tool: input.tool, captured: added },
    relations: { parent: null, variants: [], collections: [] }, notes: input.notes,
  };
  const entry = {
    id, kind: input.kind, role: input.role, title: input.title, summary: input.summary,
    tags: input.tags, preview: previewName, dir: relDir, bytes: sourceStat.size, added,
  };

  const counts = { ...existing.counts };
  counts[input.kind] += 1;
  const overviewPath = path.join(root, 'catalog', 'overview.md');
  const overviewText = await readFile(overviewPath, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  const overview = overviewText === null ? { text: null, found: false } : updateOverview(overviewText, counts, existing.total + 1);
  if (overviewText === null) console.warn('WARN catalog/overview.md not found; counts were not updated.');
  else if (!overview.found) console.warn('WARN catalog/overview.md has no "## Bundles by kind" table; counts were not updated.');

  if (options.dryRun) {
    printSummary('DRY RUN', id, relDir, sourceName, sourceStat.size, sourceHash, previewName, previewStat.size, technical);
    console.log('  dry-run: no files written');
    console.log('  next: re-run without --dry-run to write the bundle');
    return;
  }

  let indexTouched = false, overviewTouched = false;
  try {
    await mkdir(path.join(bundleDir, 'src'), { recursive: true });
    const copiedPath = path.join(bundleDir, 'src', sourceName);
    await copyFile(sourcePath, copiedPath);
    if ((await stat(copiedPath)).size !== sourceStat.size || (await hashFile(copiedPath)) !== sourceHash) {
      throw new Error('copied file does not match the source (size or sha256)');
    }
    await copyFile(previewPath, path.join(bundleDir, previewName));
    await writeFile(path.join(bundleDir, 'asset.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    await writeFile(path.join(bundleDir, 'asset.md'), renderMarkdown(bundle, mime), 'utf8');
    const prefix = indexText.length > 0 && !indexText.endsWith('\n') ? '\n' : '';
    await appendFile(indexPath, prefix + JSON.stringify(entry) + '\n', 'utf8');
    indexTouched = true;
    if (overview.text !== null) { await writeFile(overviewPath, overview.text, 'utf8'); overviewTouched = true; }
  } catch (error) {
    if (indexTouched) await writeFile(indexPath, indexText, 'utf8');
    if (overviewTouched && overviewText !== null) await writeFile(overviewPath, overviewText, 'utf8');
    await rm(bundleDir, { recursive: true, force: true });
    throw error;
  }

  printSummary('Ingested', id, relDir, sourceName, sourceStat.size, sourceHash, previewName, previewStat.size, technical);
  if (options.build) runBuild(root);
  console.log('  next: ' + nextCommand(root));
}
function validateInput(options) {
  const missing = ['file', 'kind', 'role', 'title', 'summary', 'tags']
    .filter((key) => !options[key] || !String(options[key]).trim());
  if (missing.length) throw new Error('missing required option(s): ' + missing.map((key) => '--' + key).join(', '));

  const kind = options.kind.trim().toLowerCase();
  if (!Object.hasOwn(KIND_ABBR, kind)) throw new Error('invalid --kind "' + options.kind + '" (expected one of: ' + Object.keys(KIND_ABBR).join(', ') + ')');
  const role = options.role.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(role)) throw new Error('invalid --role "' + options.role + '" (expected ^[a-z0-9][a-z0-9-]*$)');

  const title = oneLine(options.title);
  if (title.length > 80) throw new Error('--title must be at most 80 characters');
  const summary = oneLine(options.summary);
  if (!summary) throw new Error('--summary must not be empty');
  const tags = String(options.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
  if (tags.length < 2) throw new Error('--tags needs at least two namespace:value tags');
  const badTag = tags.find((tag) => !/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9/_-]*$/.test(tag));
  if (badTag) throw new Error('invalid tag "' + badTag + '" (expected lowercase namespace:value)');

  const origin = (options.origin || 'generated').trim().toLowerCase();
  if (!ORIGINS.includes(origin)) throw new Error('invalid --source-origin "' + options.origin + '" (expected one of: ' + ORIGINS.join(', ') + ')');
  let technical = {};
  if (options.technical) {
    try {
      technical = JSON.parse(options.technical);
    } catch (error) {
      throw new Error('--technical is not valid JSON (' + error.message + ')');
    }
    if (!technical || typeof technical !== 'object' || Array.isArray(technical)) throw new Error('--technical must be a JSON object');
  }

  const slug = options.slug ? options.slug.trim() : slugify(title);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length < 2 || slug.length > 40) {
    throw new Error('invalid slug "' + slug + '" (expected 2-40 lowercase letters, digits or hyphens)');
  }
  return {
    file: options.file, kind, role, title, summary, tags, slug, origin,
    notes: options.notes ? oneLine(options.notes) : '', tool: options.tool ? oneLine(options.tool) : '', preview: options.preview || null, technical,
  };
}
async function scanExisting(root, indexText) {
  const counts = Object.fromEntries(Object.keys(KIND_ABBR).map((kind) => [kind, 0]));
  const hashes = new Map();
  let maxSeq = 0, total = 0;

  for (const line of indexText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    try {
      const match = String(JSON.parse(line).id).match(/\d{6}/g);
      if (match) maxSeq = Math.max(maxSeq, Number(match[match.length - 1]));
    } catch { /* Invalid index lines are check-library's problem. */ }
  }

  async function walk(directory, parts) {
    let items;
    try { items = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const item of items) {
      const itemPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        const match = /^(\d{6})-/.exec(item.name);
        if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
        await walk(itemPath, parts.concat(item.name));
      } else if (item.isFile() && item.name === 'asset.json') {
        if (Object.hasOwn(counts, parts[0])) counts[parts[0]] += 1;
        total += 1;
        try {
          const data = JSON.parse((await readFile(itemPath, 'utf8')).replace(/^\uFEFF/, ''));
          for (const file of Array.isArray(data.files) ? data.files : []) {
            if (file?.sha256 && !hashes.has(file.sha256.toLowerCase())) hashes.set(file.sha256.toLowerCase(), data.id || 'unknown');
          }
        } catch { /* Broken existing bundles are not this tool's problem. */ }
      }
    }
  }
  await walk(path.join(root, 'assets'), []);
  return { maxSeq, hashes, counts, total };
}
async function detectImage(filePath) {
  const b = await readHead(filePath, 4 * 1024 * 1024);
  const info = (width, height, alpha) => ({ width, height, alpha, tileable: null, palette: null });
  if (b.length >= 24 && b.toString('hex', 0, 8) === '89504e470d0a1a0a' && b.toString('ascii', 12, 16) === 'IHDR') {
    const colorType = b[25];
    return info(b.readUInt32BE(16), b.readUInt32BE(20), colorType === 4 || colorType === 6 ? true : colorType === 3 ? null : false);
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return info(b.readUInt16LE(6), b.readUInt16LE(8), null);
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return info(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3), b[20] & 0x10 ? true : null);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return info(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff, false);
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return info((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, null);
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const size = jpegSize(b);
    if (size) return info(size.width, size.height, false);
  }
  return null;
}
function jpegSize(b) {
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) { offset += 1; continue; }
    let marker = b[offset + 1];
    while (marker === 0xff) { offset += 1; marker = b[offset + 1]; }
    offset += 2;
    if (offset + 2 > b.length) break;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(offset + 3), width: b.readUInt16BE(offset + 5) };
    }
    offset += b.readUInt16BE(offset);
  }
  return null;
}
async function detectWav(filePath, size) {
  if (size < 44) return null;
  const b = await readHead(filePath, 1024 * 1024);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, format = null, dataBytes = null;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4), chunkSize = b.readUInt32LE(offset + 4);
    if (id === 'fmt ' && chunkSize >= 16) {
      format = {
        channels: b.readUInt16LE(offset + 10), sampleRate: b.readUInt32LE(offset + 12),
        byteRate: b.readUInt32LE(offset + 16), bits: b.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      dataBytes = chunkSize;
      if (format) break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!format) return null;
  return {
    duration_s: dataBytes !== null && format.byteRate > 0 ? Math.round(dataBytes / format.byteRate * 1000) / 1000 : null,
    sample_rate: format.sampleRate, channels: format.channels, bit_depth: format.bits, loopable: null,
  };
}
async function readHead(filePath, maxBytes) {
  const handle = await open(filePath, 'r');
  try {
    const size = Math.min((await handle.stat()).size, maxBytes);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer;
  } finally { await handle.close(); }
}
function updateOverview(text, counts, total) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Bundles by kind\s*$/.test(line));
  if (start < 0) return { text, found: false };
  let found = false;
  for (let i = start + 1; i < lines.length && !/^##\s+/.test(lines[i]); i += 1) {
    const match = /^\|\s*([a-z]+)\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/.exec(lines[i]);
    if (!match || !Object.hasOwn(counts, match[1])) continue;
    lines[i] = '| ' + match[1] + ' |' + match[2] + '| ' + counts[match[1]] + ' |' + match[4] + '|';
    found = true;
  }
  if (!found) return { text, found: false };
  const totalLine = lines.findIndex((line) => /^Total:\s+\d+\s+bundles\.\s*$/.test(line));
  if (totalLine >= 0) lines[totalLine] = 'Total: ' + total + ' bundles.';
  return { text: lines.join(eol), found: true };
}
function renderMarkdown(bundle, mime) {
  const useTags = bundle.tags.filter((tag) => tag.startsWith('use:'));
  const useValues = (useTags.length ? useTags : bundle.tags).map((tag) => tag.slice(tag.indexOf(':') + 1).replace(/\//g, ' '));
  const lines = ['# ' + bundle.title, '', bundle.summary, '- Use for: ' + useValues.join(', '),
    '- Technical: ' + formatTechnical(bundle.technical, mime)];
  if (bundle.notes) lines.push('- Notes: ' + bundle.notes);
  return lines.join('\n') + '\n';
}
function formatTechnical(technical, fallback) {
  const fields = Object.entries(technical).map(([key, value]) => key + '=' + (Array.isArray(value) ? value.join('/') : String(value)));
  return fields.length ? fields.join(', ') : fallback || '(none detected)';
}
function printSummary(label, id, relDir, sourceName, bytes, hash, previewName, previewBytes, technical) {
  console.log(label + ' ' + id);
  console.log('  bundle: ' + relDir);
  console.log('  source: ' + sourceName + ' (' + bytes + ' bytes, sha256 ' + hash.slice(0, 12) + '...)');
  console.log('  preview: ' + previewName + ' (' + previewBytes + ' bytes)');
  console.log('  technical: ' + formatTechnical(technical));
}
function runBuild(root) {
  let failed = false;
  for (const name of ['build-gallery.mjs', 'check-library.mjs']) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', name), '--root', root], { cwd: root, stdio: 'inherit' });
    if (result.error) {
      console.error('ERROR could not run scripts/' + name + ': ' + result.error.message);
      failed = true;
    } else {
      console.log('  ' + name + ': exit ' + result.status);
      failed ||= result.status !== 0;
    }
  }
  if (failed) process.exitCode = 1;
}
function nextCommand(root) {
  return path.resolve(root) === DEFAULT_ROOT ? 'node scripts/check-library.mjs'
    : 'node scripts/check-library.mjs --root ' + (/\s/.test(root) ? JSON.stringify(root) : root);
}
function parseArgs(argv) {
  const options = {
    file: null, kind: null, role: null, title: null, summary: null, tags: null, slug: null,
    notes: '', origin: 'generated', tool: '', preview: null, technical: null, root: null,
    allowNewRole: false, allowDuplicate: false, build: false, dryRun: false, help: false,
  };
  const valued = {
    file: 'file', kind: 'kind', role: 'role', title: 'title', summary: 'summary', tags: 'tags', slug: 'slug', notes: 'notes',
    'source-origin': 'origin', 'source-tool': 'tool', preview: 'preview', technical: 'technical', root: 'root',
  };
  const flags = { 'allow-new-role': 'allowNewRole', 'allow-duplicate': 'allowDuplicate', build: 'build', 'dry-run': 'dryRun', help: 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error('unexpected argument "' + arg + '"; use --help for usage');
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    if (flags[name]) {
      if (inline !== null) throw new Error('--' + name + ' does not take a value');
      options[flags[name]] = true;
    } else if (valued[name]) {
      if (inline === null && i + 1 >= argv.length) throw new Error('--' + name + ' requires a value');
      options[valued[name]] = inline !== null ? inline : argv[++i];
    } else {
      throw new Error('unknown option "--' + name + '"; use --help for usage');
    }
  }
  return options;
}
function printUsage() {
  console.log('Usage: node scripts/ingest.mjs --file <path> --kind <kind> --role <role> --title "..." --summary "..." --tags "ns:value,ns:value" [options]');
  console.log('Options: --slug --notes --source-origin --source-tool --preview --technical --root --allow-new-role --allow-duplicate --build --dry-run');
}
function slugify(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}
const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim();
const safeExtension = (value) => {
  const extension = String(value).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
};
function localDate() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
async function statFile(filePath, label) {
  let fileStat;
  try { fileStat = await stat(filePath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(label + ' not found: ' + filePath);
    throw new Error('cannot stat ' + label + ' ' + filePath + ': ' + error.message);
  }
  if (!fileStat.isFile()) throw new Error(label + ' is not a file: ' + filePath);
  if (fileStat.size < 1) throw new Error(label + ' is empty: ' + filePath);
  return fileStat;
}
async function statSafe(target) {
  try { return await stat(target); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}
async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
