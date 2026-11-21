#!/usr/bin/env node
// Build a single self-contained gallery page from catalog/index.jsonl.
//
// The page has no external dependencies: all CSS and JS are inlined and every
// media URL is relative to the generated HTML, so it works from file://.
// The 3D Gaussian splat renderer (scripts/splat-viewer.js) is inlined before
// the gallery script. Splat assets stay lazy and only fetch their PLY on demand.
//
// Optional index keys (newer catalogs):
//   "file" - repo-relative path to the primary deliverable
//   "mime" - IANA type of that file
// Older indexes without these still render; the bundle's asset.json is used to
// locate a playable/viewable file.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = ['image', 'model', 'audio', 'video', 'font', 'material', 'doc', 'project', 'other'];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SPLAT_VIEWER_PATH = path.join(SCRIPT_DIR, 'splat-viewer.js');

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
  const outPath = path.resolve(options.out || path.join(root, 'gallery', 'index.html'));
  const index = await loadIndex(root);

  if (index.records.length === 0) {
    console.error('Error: catalog/index.jsonl contains no asset records; nothing to build.');
    console.error('       Add bundles to assets/ and re-run the ingest script.');
    process.exitCode = 1;
    return;
  }

  const assets = [];
  for (const entry of index.records) {
    const bundle = await readBundle(root, entry.dir);
    assets.push(toAsset(entry, bundle, root, outPath));
  }

  const splatSource = await loadSplatViewer();
  const html = renderHtml(assets, splatSource);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');

  const kib = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log('Built gallery: ' + assets.length + ' assets, ' + kib + ' KB -> ' + outPath);
}

async function loadSplatViewer() {
  let source;

  try {
    source = await readFile(SPLAT_VIEWER_PATH, 'utf8');
  } catch (error) {
    throw new Error('Cannot read the splat renderer at ' + SPLAT_VIEWER_PATH + ': ' + error.message);
  }

  if (!source.includes('window.MeesaSplat')) {
    throw new Error(SPLAT_VIEWER_PATH + ' does not expose window.MeesaSplat.');
  }

  if (/<\/script/i.test(source)) {
    throw new Error(SPLAT_VIEWER_PATH + ' contains a closing script tag and cannot be inlined.');
  }

  return source.trim();
}

function parseArgs(argv) {
  const options = { root: null, out: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root requires a directory');
      options.root = argv[++i];
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--out') {
      if (i + 1 >= argv.length) throw new Error('--out requires a file path');
      options.out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else {
      throw new Error('Unknown option "' + arg + '". Use --help for usage.');
    }
  }

  if (options.root === '') throw new Error('--root requires a directory');
  if (options.out === '') throw new Error('--out requires a file path');
  return options;
}

function printUsage() {
  console.log('Usage: node scripts/build-gallery.mjs [--root <dir>] [--out <file>]');
  console.log('');
  console.log('  --root <dir>   Repository root (default: parent of scripts/)');
  console.log('  --out <file>   Output HTML file (default: <root>/gallery/index.html)');
}

async function loadIndex(root) {
  const indexPath = path.join(root, 'catalog', 'index.jsonl');
  let text;

  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('catalog/index.jsonl was not found at ' + indexPath);
    }
    throw new Error('Cannot read ' + indexPath + ': ' + error.message);
  }

  const records = [];
  const seenIds = new Set();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!line.trim()) return;

    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      console.warn('Warning: line ' + lineNo + ': invalid JSON (' + error.message + '); skipped.');
      return;
    }

    const result = validateRecord(raw, lineNo, seenIds);
    if (result.error) {
      console.warn('Warning: line ' + lineNo + ': ' + result.error + '; skipped.');
      return;
    }

    seenIds.add(result.record.id);
    records.push(result.record);
  });

  return { records };
}

function validateRecord(raw, lineNo, seenIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'record is not a JSON object' };
  }

  const id = cleanString(raw.id);
  if (!id) return { error: 'missing or invalid "id"' };
  if (seenIds.has(id)) return { error: 'duplicate id "' + id + '"' };

  const kind = cleanString(raw.kind).toLowerCase();
  if (!KINDS.includes(kind)) {
    return { error: 'missing or unknown "kind" (expected one of: ' + KINDS.join(', ') + ')' };
  }

  const dir = cleanString(raw.dir).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir || !isSafeRelative(dir)) {
    return { error: 'missing or unsafe "dir" (must be a repo-relative path)' };
  }

  let preview = cleanString(raw.preview).replace(/\\/g, '/').replace(/^\.\//, '');
  if (preview && !isSafeRelative(preview)) {
    console.warn('Warning: line ' + lineNo + ': unsafe "preview" path; using a placeholder.');
    preview = '';
  }

  let file = cleanString(raw.file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (file && !isSafeRelative(file)) {
    console.warn('Warning: line ' + lineNo + ': unsafe "file" path; ignoring it.');
    file = '';
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(cleanString).filter((tag) => tag.length > 0)
    : [];

  return {
    record: {
      id,
      kind,
      role: cleanString(raw.role),
      title: cleanString(raw.title) || id,
      summary: cleanString(raw.summary),
      tags,
      preview,
      file,
      mime: cleanString(raw.mime),
      dir,
      bytes: toBytes(raw.bytes),
      added: cleanString(raw.added),
    },
  };
}

async function readBundle(root, dir) {
  const bundleDir = path.join(root, ...dir.split('/'));
  const assetJsonPath = path.join(bundleDir, 'asset.json');
  const result = { files: [], technical: {} };
  let text;

  try {
    text = await readFile(assetJsonPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Warning: ' + dir + '/asset.json could not be read; file list omitted.');
    }
    return result;
  }

  let bundle;
  try {
    bundle = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    console.warn('Warning: ' + dir + '/asset.json is not valid JSON; file list omitted.');
    return result;
  }

  if (!bundle || typeof bundle !== 'object') return result;

  if (Array.isArray(bundle.files)) {
    result.files = bundle.files
      .filter((file) => file && typeof file === 'object' && cleanString(file.path))
      .map((file) => {
        const filePath = cleanString(file.path).replace(/\\/g, '/');
        return {
          path: filePath,
          bytes: Number.isFinite(file.bytes) && file.bytes >= 0 ? file.bytes : null,
          mime: cleanString(file.mime),
        };
      })
      .filter((file) => isSafeRelative(file.path));
  }

  if (bundle.technical && typeof bundle.technical === 'object' && !Array.isArray(bundle.technical)) {
    result.technical = bundle.technical;
  }

  return result;
}

function toAsset(entry, bundle, root, outPath) {
  const outDir = path.dirname(outPath);
  const bundleDir = path.join(root, ...entry.dir.split('/'));
  const relativeBundle = path.relative(outDir, bundleDir);

  if (path.isAbsolute(relativeBundle)) {
    throw new Error('--out must be on the same drive as --root so media paths can stay relative.');
  }

  const bundleUrl = relativeUrl(relativeBundle);
  const prefix = bundleUrl ? bundleUrl + '/' : '';

  const files = bundle.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    mime: file.mime,
    url: prefix + encodePath(file.path),
  }));

  let fileUrl = '';
  let filePath = '';
  let mime = entry.mime;
  const technical = bundle.technical || {};

  if (entry.file) {
    filePath = entry.file;
    fileUrl = relativeUrl(path.relative(outDir, path.join(root, ...entry.file.split('/'))));
  } else {
    const picked = pickPrimary(files, entry.kind, technical);
    if (picked) {
      filePath = picked.path;
      fileUrl = picked.url;
      if (!mime) mime = picked.mime;
    }
  }

  if (fileUrl && !mime) mime = guessMime(filePath);
  if (!mime && entry.preview) mime = guessMime(entry.preview);

  const previewUrl = entry.preview ? prefix + encodePath(entry.preview) : '';
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  const tileable = technical.tileable === true || tags.includes('use:tileset');
  const formatName = String(technical.format || '').trim().toLowerCase();
  const mimeLower = String(mime || '').toLowerCase();
  const fileLower = filePath.toLowerCase();
  const splat = entry.kind === 'model' && (
    formatName === 'ply' ||
    (mimeLower === 'application/octet-stream' && fileLower.endsWith('.ply')) ||
    fileLower.endsWith('.ply')
  );

  return {
    id: entry.id,
    kind: entry.kind,
    role: entry.role,
    title: entry.title,
    summary: entry.summary,
    tags,
    preview: previewUrl,
    file: fileUrl,
    mime: mime || '',
    tileable,
    splat,
    technical,
    dir: entry.dir,
    bytes: entry.bytes,
    added: entry.added,
    md: prefix + 'asset.md',
    json: prefix + 'asset.json',
    files,
  };
}

// Old indexes have no "file", so use the first bundle file that matches the
// asset kind. Audio/video need a real playable file; images can use any image.
function pickPrimary(files, kind, technical) {
  const prefix = kind + '/';
  const formatName = String((technical && technical.format) || '').trim().toLowerCase();

  if (kind === 'model' && formatName === 'ply') {
    for (const file of files) {
      if (/\.ply$/i.test(file.path)) return file;
    }
  }

  for (const file of files) {
    if (file.mime && file.mime.startsWith(prefix)) return file;
  }

  if (kind === 'image' || kind === 'material') {
    for (const file of files) {
      if (file.mime && file.mime.startsWith('image/')) return file;
    }
  }

  return null;
}

function guessMime(value) {
  const ext = path.extname(String(value)).toLowerCase().slice(1);
  const table = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    obj: 'model/obj',
    fbx: 'model/gltf-binary',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
  };
  return table[ext] || '';
}

function relativeUrl(value) {
  if (!value || value === '.') return '';
  return value
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function encodePath(value) {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isSafeRelative(value) {
  if (!value || value.includes('\0')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function serializeAssets(assets) {
  return JSON.stringify(assets)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderHtml(assets, splatSource) {
  const data = serializeAssets(assets);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Asset Library</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:dark;
  --bg:#0b0e14;--bg2:#11161f;--panel:#151b26;--panel2:#1b2331;--text:#e6edf3;
  --muted:#9aa7b8;--line:#2a3444;--accent:#7cc4ff;--accent-soft:#24384d;
  --chip:#1d2735;--focus:#ffd166;--stage:#090c11;
  --shadow:0 12px 32px rgba(0,0,0,.35);
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f6f7f9;--bg2:#eef1f5;--panel:#ffffff;--panel2:#f1f4f8;--text:#17202b;
  --muted:#5b6878;--line:#d8dee7;--accent:#0b63a8;--accent-soft:#d9ecfc;
  --chip:#e8eef6;--focus:#9a5b00;--stage:#dfe4ea;
  --shadow:0 12px 32px rgba(23,32,43,.12);
}
html,body{margin:0;min-height:100%}
body{
  background:radial-gradient(1100px 560px at 18% -12%,var(--panel2),transparent 70%),var(--bg);
  color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
[hidden]{display:none!important}
a{color:var(--accent)}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.muted{color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
.site-header{
  display:flex;gap:1rem;align-items:end;justify-content:space-between;flex-wrap:wrap;
  padding:1.1rem clamp(1rem,3vw,2rem);border-bottom:1px solid var(--line);
  background:var(--bg2);position:sticky;top:0;z-index:5;
}
.brand h1{margin:0;font-size:1.25rem;letter-spacing:.01em}
.brand p{margin:.15rem 0 0;color:var(--muted);font-size:.85rem}
.search{flex:1 1 300px;min-width:200px}
.search label,.controls label,.field-label{
  display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);margin-bottom:.3rem;
}
.search input{
  width:100%;padding:.6rem .75rem;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);
}
.controls{display:flex;align-items:end;gap:.6rem;flex-wrap:wrap}
select{
  padding:.6rem .75rem;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);
}
.kind-tabs{
  display:flex;gap:.5rem;overflow-x:auto;padding:.7rem clamp(1rem,3vw,2rem);
  border-bottom:1px solid var(--line);background:var(--bg2);
}
.tab{
  white-space:nowrap;border:1px solid var(--line);background:transparent;
  color:var(--muted);padding:.35rem .7rem;border-radius:999px;
}
.tab:hover{border-color:var(--accent);color:var(--text)}
.tab[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--text)}
.tab .count{opacity:.7;margin-left:.35rem;font-variant-numeric:tabular-nums}
.layout{
  display:grid;grid-template-columns:250px minmax(0,1fr);gap:1.5rem;
  padding:1.25rem clamp(1rem,3vw,2rem) 3rem;max-width:1600px;margin:0 auto;
}
.facets{
  align-self:start;background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:1rem;position:sticky;top:6.4rem;max-height:calc(100vh - 8rem);overflow:auto;
}
.facets-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.6rem}
.facets h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin:0;color:var(--muted)}
.link-button{background:none;border:0;color:var(--accent);padding:.15rem;border-radius:4px}
.link-button:disabled{color:var(--muted);cursor:not-allowed}
.tag-group{border-top:1px solid var(--line);padding:.4rem 0}
.tag-group summary{cursor:pointer;font-weight:600;font-size:.9rem;padding:.15rem 0}
.tag-options{display:grid;gap:.1rem;padding:.35rem 0 .15rem .25rem}
.tag-option{display:flex;gap:.4rem;align-items:center;font-size:.84rem;color:var(--muted);cursor:pointer;padding:.08rem 0}
.tag-option input{accent-color:var(--accent);margin:0}
.tag-option .n{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.6;font-size:.78rem}
.results-bar{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap}
#result-count{margin:0;color:var(--muted);font-variant-numeric:tabular-nums}
.button{
  border:1px solid var(--accent);background:var(--accent-soft);color:var(--text);
  padding:.45rem .85rem;border-radius:8px;
}
.button:hover{filter:brightness(1.08)}
.button:disabled{opacity:.45;cursor:not-allowed;filter:none}
.button.subtle{border-color:var(--line);background:var(--panel2);color:var(--muted)}
.button.subtle:hover{color:var(--text);border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1rem}
.card{
  display:flex;flex-direction:column;text-align:left;padding:0;overflow:hidden;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;color:var(--text);
  transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;
}
.card:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:var(--shadow)}
.thumb{
  display:block;position:relative;aspect-ratio:4/3;overflow:hidden;
  border-bottom:1px solid var(--line);background-color:var(--panel2);
}
.thumb::before{
  content:"";position:absolute;inset:0;
  background-image:
    linear-gradient(45deg,var(--bg) 25%,transparent 25%,transparent 75%,var(--bg) 75%),
    linear-gradient(45deg,var(--bg) 25%,transparent 25%,transparent 75%,var(--bg) 75%);
  background-size:16px 16px;background-position:0 0,8px 8px;opacity:.55;
}
.thumb img{position:relative;z-index:1;width:100%;height:100%;object-fit:contain;display:block}
.thumb img.cover{object-fit:cover}
.tile-preview{
  position:absolute;inset:0;z-index:1;background-repeat:repeat;background-size:50% 50%;
  image-rendering:pixelated;
}
.tile-badge{
  position:absolute;z-index:3;top:.4rem;right:.4rem;background:rgba(8,12,18,.78);
  border:1px solid rgba(255,255,255,.4);color:#eaf2fb;border-radius:999px;
  padding:.08rem .5rem;font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;
}
.waveform{position:relative;z-index:1;display:block;width:100%;height:100%;color:var(--accent)}
.waveform rect{fill:currentColor}
.play-badge{
  position:absolute;z-index:2;left:50%;top:50%;transform:translate(-50%,-50%);
  width:46px;height:46px;border-radius:50%;background:rgba(8,12,18,.72);
  border:1px solid rgba(255,255,255,.65);display:grid;place-items:center;pointer-events:none;
}
.play-badge::after{
  content:"";width:0;height:0;margin-left:3px;
  border-style:solid;border-width:7px 0 7px 11px;
  border-color:transparent transparent transparent #fff;
}
.card-body{display:flex;flex-direction:column;gap:.38rem;padding:.75rem .85rem .9rem;min-width:0}
.card-title{font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.badge{display:flex;flex-wrap:wrap;align-items:center;font-size:.7rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.badge-kind{color:var(--accent);font-weight:700}
.badge-sep{opacity:.5;white-space:pre}
.card-summary{
  font-size:.82rem;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;
}
.tag-row{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.1rem}
.tag{
  font-size:.7rem;background:var(--chip);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:.1rem .45rem;overflow-wrap:anywhere;
}
.tag-more{font-size:.7rem;color:var(--muted);align-self:center}
.placeholder{
  position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:.3rem;margin:8px;border:1px dashed var(--line);border-radius:8px;
  color:var(--muted);text-align:center;padding:.5rem;
}
.ph-label{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;font-weight:700;opacity:.85}
.ph-detail{font-size:.75rem;overflow-wrap:anywhere}
.empty{border:1px dashed var(--line);border-radius:12px;padding:3rem 1.5rem;text-align:center;background:var(--panel)}
.empty h2{margin:.2rem 0 .5rem;font-size:1.15rem}
.empty p{color:var(--muted);max-width:42ch;margin:0 auto 1rem}
dialog{
  border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--text);
  padding:0;width:min(1180px,calc(100vw - 2rem));max-height:calc(100vh - 2rem);
  box-shadow:var(--shadow);
}
dialog[open]{display:grid;grid-template-rows:auto minmax(0,1fr) auto}
dialog::backdrop{background:rgba(0,0,0,.74);backdrop-filter:blur(2px)}
.v-head{
  display:flex;justify-content:space-between;align-items:start;gap:1rem;
  padding:.9rem 1.25rem;border-bottom:1px solid var(--line);background:var(--panel);
}
.v-head h2{margin:0;font-size:1.15rem;overflow-wrap:anywhere}
.v-head .badge{margin-top:.2rem}
.v-body{
  display:grid;grid-template-columns:minmax(0,1.35fr) minmax(270px,.65fr);gap:1.25rem;
  padding:1.25rem;overflow:auto;
}
.v-main{min-width:0}
.v-side{min-width:0;overflow-wrap:anywhere}
.v-summary{color:var(--muted);margin:.15rem 0 .8rem;white-space:pre-wrap}
.v-side h3{font-size:.76rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1rem 0 .4rem}
.meta{display:grid;grid-template-columns:auto 1fr;gap:.3rem .8rem;font-size:.85rem;margin:0}
.meta dt{color:var(--muted)}
.meta dd{margin:0}
.v-tags{display:flex;flex-wrap:wrap;gap:.3rem}
.file-list{
  list-style:none;margin:0;padding:0;max-height:180px;overflow:auto;
  border:1px solid var(--line);border-radius:8px;background:var(--panel2);
}
.file-list li{
  display:flex;justify-content:space-between;gap:.75rem;padding:.32rem .55rem;
  border-bottom:1px solid var(--line);font-size:.8rem;
}
.file-list li:last-child{border-bottom:0}
.file-list a{overflow-wrap:anywhere}
.file-size{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
.v-links{display:flex;gap:.9rem;flex-wrap:wrap;margin-top:1rem}
.v-links a{font-size:.88rem}
.v-foot{
  display:flex;justify-content:space-between;align-items:center;gap:1rem;
  padding:.7rem 1.25rem;border-top:1px solid var(--line);background:var(--panel);
}
.v-pos{color:var(--muted);font-size:.85rem;font-variant-numeric:tabular-nums}
.image-toolbar{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.6rem}
.zoom-btn{
  border:1px solid var(--line);background:var(--panel2);color:var(--muted);
  border-radius:7px;padding:.25rem .6rem;font-size:.8rem;
}
.zoom-btn[aria-pressed="true"]{border-color:var(--accent);color:var(--text);background:var(--accent-soft)}
.image-stage{
  position:relative;height:clamp(280px,52vh,560px);overflow:auto;cursor:grab;
  border:1px solid var(--line);border-radius:10px;background-color:var(--panel2);
  background-image:
    linear-gradient(45deg,var(--bg) 25%,transparent 25%,transparent 75%,var(--bg) 75%),
    linear-gradient(45deg,var(--bg) 25%,transparent 25%,transparent 75%,var(--bg) 75%);
  background-size:20px 20px;background-position:0 0,10px 10px;
  touch-action:pan-x pan-y;
}
.image-stage.dragging{cursor:grabbing}
.image-canvas{
  display:flex;align-items:center;justify-content:center;
  min-width:100%;min-height:100%;width:max-content;height:max-content;padding:1rem;
}
.image-canvas img{display:block;flex:none}
.audio-panel{display:grid;gap:.9rem}
.wave-large{
  height:clamp(140px,26vh,250px);border:1px solid var(--line);border-radius:10px;
  background:var(--stage);color:var(--accent);overflow:hidden;
}
.wave-large svg{width:100%;height:100%;display:block}
.wave-large rect{fill:currentColor}
audio{width:100%}
.video-wrap{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#000}
.video-wrap video{display:block;width:100%;max-height:58vh;background:#000}
.video-bar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-top:.6rem}
.tile-toolbar{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));
  gap:.55rem .8rem;margin-bottom:.65rem;
}
.ctrl{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.ctrl.wide{grid-column:span 2}
.ctrl-head{display:flex;align-items:center;justify-content:space-between;gap:.35rem}
.ctrl label,.ctrl .ctrl-name{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.ctrl output{font-size:.75rem;color:var(--text);font-variant-numeric:tabular-nums}
.ctrl input[type="range"]{width:100%;accent-color:var(--accent);margin:0}
.ctrl select{padding:.25rem .35rem;font-size:.8rem;border-radius:6px;background:var(--panel2)}
.mini{
  border:1px solid var(--line);background:var(--panel2);color:var(--muted);
  border-radius:5px;padding:.02rem .35rem;font-size:.7rem;
}
.mini:hover{color:var(--text);border-color:var(--accent)}
.seg{display:flex;gap:.25rem;flex-wrap:wrap}
.seg button{
  border:1px solid var(--line);background:var(--panel2);color:var(--muted);
  border-radius:6px;padding:.22rem .45rem;font-size:.75rem;
}
.seg button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--text)}
.tile-readout{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.5rem;font-size:.82rem}
.tile-readout .spacer{margin-left:auto}
#tile-label{font-variant-numeric:tabular-nums;font-weight:650}
.tile-stage{
  position:relative;height:clamp(260px,46vh,520px);overflow:hidden;touch-action:none;
  border:1px solid var(--line);border-radius:10px;cursor:grab;background-color:var(--stage);
}
.tile-stage.dragging{cursor:grabbing}
.tile-stage[data-bg="dark"]{background-color:#090c11}
.tile-stage[data-bg="light"]{background-color:#f1f1f1}
.tile-stage[data-bg="magenta"]{background-color:#ff00ff}
.tile-stage[data-bg="checker"]{
  background-color:#8a8a8a;
  background-image:conic-gradient(#c4c4c4 25%,#8a8a8a 0 50%,#c4c4c4 0 75%,#8a8a8a 0);
  background-size:24px 24px;
}
.tile-rotor{position:absolute;inset:0;transform-origin:50% 50%}
.tile-plane{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
.tile-surface{position:absolute;inset:0;background-repeat:repeat;image-rendering:pixelated}
.tile-grid{
  position:absolute;inset:0;pointer-events:none;
  background-image:
    linear-gradient(to right,rgba(255,212,64,.85) 1px,transparent 1px),
    linear-gradient(to bottom,rgba(255,212,64,.85) 1px,transparent 1px);
}
.tile-note{margin:.5rem 0 0;font-size:.78rem;color:var(--muted)}
.splat-badge{
  position:absolute;z-index:3;top:.4rem;left:.4rem;background:rgba(6,10,16,.84);
  border:1px solid rgba(124,196,255,.7);color:#dff1ff;border-radius:999px;
  padding:.1rem .5rem;font-size:.68rem;letter-spacing:.04em;font-weight:650;
}
.splat-ph{
  position:absolute;inset:0;z-index:2;display:grid;place-items:center;overflow:hidden;
  background-color:#080b11;
  background-image:
    radial-gradient(circle at 14% 24%,rgba(140,205,255,.9) 0 1px,transparent 1.7px),
    radial-gradient(circle at 68% 58%,rgba(255,255,255,.7) 0 1px,transparent 1.7px),
    radial-gradient(circle at 42% 82%,rgba(140,205,255,.55) 0 1px,transparent 1.8px),
    radial-gradient(circle at 86% 32%,rgba(255,255,255,.45) 0 1px,transparent 1.6px);
  background-size:17px 21px,23px 27px,31px 19px,37px 41px;
}
.splat-ph::before{
  content:"";position:absolute;inset:18%;
  background:radial-gradient(closest-side,rgba(124,196,255,.2),transparent);
}
.splat-ph-label{
  position:absolute;left:.55rem;bottom:.55rem;
  font:650 .76rem/1 ui-monospace,SFMono-Regular,Consolas,monospace;
  letter-spacing:.18em;color:#dff1ff;border:1px solid rgba(124,196,255,.55);
  border-radius:6px;padding:.3rem .55rem;background:rgba(6,10,16,.62);
}
.splat-wrap{display:grid;gap:.6rem}
.splat-stage{
  position:relative;min-height:420px;height:clamp(420px,56vh,640px);
  overflow:hidden;border:1px solid var(--line);border-radius:10px;background:#04060a;
}
.splat-stage canvas{position:absolute;inset:0;z-index:1;display:block;width:100%;height:100%}
.splat-poster{
  position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:contain;
  opacity:.5;filter:saturate(.85);
}
.splat-load{
  position:absolute;inset:0;z-index:2;display:grid;place-content:center;justify-items:center;
  gap:.65rem;padding:1.5rem;text-align:center;
  background:linear-gradient(rgba(4,6,10,.2),rgba(4,6,10,.78));
}
.splat-load-btn{
  border:1px solid var(--accent);background:var(--accent-soft);color:var(--text);
  border-radius:10px;padding:.65rem 1.2rem;font-size:1rem;font-weight:650;
}
.splat-load-btn:hover{filter:brightness(1.1)}
.splat-load-hint{max-width:40ch;margin:0;color:#c3cfdd;font-size:.82rem}
.splat-status{margin:0;min-height:1.35em;font-size:.82rem;color:var(--muted)}
.splat-error{
  margin:0;padding:.6rem .75rem;border:1px solid rgba(255,120,120,.55);
  border-radius:8px;background:rgba(180,35,24,.1);color:var(--text);font-size:.86rem;
}
.splat-error code{background:rgba(127,127,127,.16);padding:.05rem .25rem;border-radius:3px}
.splat-error-detail{
  display:block;margin-top:.25rem;color:var(--muted);font-size:.78rem;overflow-wrap:anywhere;
}
.splat-bar{
  display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;
  padding:.45rem;border:1px solid var(--line);border-radius:9px;background:var(--panel2);
}
.splat-btn{
  border:1px solid var(--line);background:var(--panel);color:var(--muted);
  border-radius:7px;padding:.32rem .6rem;font-size:.8rem;
}
.splat-btn[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--text)}
.splat-readout{
  margin-left:auto;display:flex;gap:.7rem;flex-wrap:wrap;align-items:center;
  font-size:.82rem;color:var(--muted);font-variant-numeric:tabular-nums;
}
#splat-total{color:var(--text);font-weight:650}
.splat-hint{margin:0;font-size:.76rem;color:var(--muted)}
@media (max-width:900px){
  .layout{grid-template-columns:1fr}
  .facets{position:static;max-height:none}
  .v-body{grid-template-columns:1fr}
  .image-stage{height:clamp(240px,42vh,420px)}
}
@media (max-width:560px){
  .site-header{align-items:stretch}
  .search{flex-basis:100%}
  .grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.75rem}
  .v-body{padding:1rem;gap:1rem}
  .v-head{padding:.8rem 1rem}
  .v-foot{padding:.65rem 1rem}
  dialog{width:calc(100vw - .75rem);max-height:calc(100vh - .75rem)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
<script>
(function () {
  try {
    var saved = localStorage.getItem('mesa-gallery-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.dataset.theme = 'light';
    }
  } catch (error) {
    /* storage can be unavailable on file://; the dark theme still works */
  }
})();
</script>
</head>
<body>
<header class="site-header">
  <div class="brand">
    <h1>Asset Library</h1>
    <p>Local media catalog</p>
  </div>
  <div class="search">
    <label for="search">Search</label>
    <input id="search" type="search" placeholder="id, title, summary, tags, role" autocomplete="off">
  </div>
  <div class="controls">
    <div>
      <label for="sort">Sort</label>
      <select id="sort">
        <option value="title">Title A-Z</option>
        <option value="newest" selected>Newest added</option>
        <option value="largest">Largest bytes</option>
        <option value="kind">Kind</option>
      </select>
    </div>
    <button type="button" class="button subtle" id="theme" aria-label="Switch to light theme">Light mode</button>
  </div>
</header>
<nav class="kind-tabs" id="kind-tabs" aria-label="Filter by asset kind"></nav>
<div class="layout">
  <aside class="facets" aria-labelledby="tags-heading">
    <div class="facets-head">
      <h2 id="tags-heading">Tags</h2>
      <button type="button" class="link-button" id="clear-tags">Clear all</button>
    </div>
    <div id="tag-groups"></div>
    <p id="no-tags" class="muted" hidden>No tags in this library.</p>
  </aside>
  <main>
    <div class="results-bar">
      <p id="result-count" role="status" aria-live="polite"></p>
      <button type="button" class="button subtle" id="reset">Reset filters</button>
    </div>
    <div class="grid" id="grid" aria-label="Asset results"></div>
    <div class="empty" id="empty" hidden>
      <h2 id="empty-title">No assets found</h2>
      <p id="empty-text"></p>
      <button type="button" class="button" id="empty-reset">Reset filters</button>
    </div>
  </main>
</div>
<noscript><p style="padding:1rem">This gallery needs JavaScript to render the asset grid.</p></noscript>
<dialog id="viewer" aria-labelledby="v-title">
  <div class="v-head">
    <div>
      <h2 id="v-title"></h2>
      <div class="badge" id="v-badge"></div>
    </div>
    <button type="button" class="button subtle" id="v-close" aria-label="Close viewer">Close</button>
  </div>
  <div class="v-body">
    <section class="v-main" id="v-media" aria-label="Asset preview"></section>
    <aside class="v-side">
      <p class="v-summary" id="v-summary"></p>
      <h3>Details</h3>
      <dl class="meta" id="v-meta"></dl>
      <h3>Tags</h3>
      <div class="v-tags" id="v-tags"></div>
      <h3>Files</h3>
      <ul class="file-list" id="v-files"></ul>
      <div class="v-links">
        <a id="v-download" download>Download original</a>
        <a id="v-md" target="_blank" rel="noopener">asset.md</a>
        <a id="v-json" target="_blank" rel="noopener">asset.json</a>
      </div>
    </aside>
  </div>
  <div class="v-foot">
    <button type="button" class="button subtle" id="v-prev">Previous</button>
    <span class="v-pos" id="v-pos"></span>
    <button type="button" class="button subtle" id="v-next">Next</button>
  </div>
</dialog>
<script>
${splatSource}
</script>
<script>
const ASSETS = ${data};
(function () {
  'use strict';

  var KINDS = ['image', 'model', 'audio', 'video', 'font', 'material', 'doc', 'project', 'other'];
  var TECH_LABELS = {
    width: 'Width', height: 'Height', alpha: 'Alpha', tileable: 'Tileable',
    duration_s: 'Duration', sample_rate: 'Sample rate', channels: 'Channels',
    bit_depth: 'Bit depth', loopable: 'Loopable', resolution: 'Resolution',
    fps: 'Frame rate', codec: 'Codec', format: 'Format', polycount: 'Polycount',
    uv: 'UVs', materials: 'Materials', rigged: 'Rigged', animations: 'Animations',
    scale_units: 'Scale units', family: 'Family', weights: 'Weights',
    glyphs: 'Glyphs', pages: 'Pages', engine: 'Engine',
    engine_version: 'Engine version', bundle_type: 'Bundle type', splats: 'Splats'
  };
  var state = { query: '', kind: 'all', sort: 'newest', tags: Object.create(null) };
  var current = [];
  var byId = Object.create(null);
  var viewerList = [];
  var viewerIndex = -1;
  var viewerAsset = null;
  var opener = null;
  var tileApply = null;
  var splatHandle = null;

  var searchInput = document.getElementById('search');
  var sortSelect = document.getElementById('sort');
  var themeButton = document.getElementById('theme');
  var tabs = document.getElementById('kind-tabs');
  var tagGroups = document.getElementById('tag-groups');
  var noTags = document.getElementById('no-tags');
  var clearTags = document.getElementById('clear-tags');
  var resetButton = document.getElementById('reset');
  var emptyReset = document.getElementById('empty-reset');
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var emptyTitle = document.getElementById('empty-title');
  var emptyText = document.getElementById('empty-text');
  var countText = document.getElementById('result-count');
  var dialog = document.getElementById('viewer');
  var vTitle = document.getElementById('v-title');
  var vBadge = document.getElementById('v-badge');
  var vSummary = document.getElementById('v-summary');
  var vMeta = document.getElementById('v-meta');
  var vTags = document.getElementById('v-tags');
  var vFiles = document.getElementById('v-files');
  var vMedia = document.getElementById('v-media');
  var vDownload = document.getElementById('v-download');
  var vMd = document.getElementById('v-md');
  var vJson = document.getElementById('v-json');
  var vPos = document.getElementById('v-pos');
  var vPrev = document.getElementById('v-prev');
  var vNext = document.getElementById('v-next');
  var vClose = document.getElementById('v-close');

  ASSETS.forEach(function (asset) {
    asset.tags = Array.isArray(asset.tags) ? asset.tags : [];
    asset.files = Array.isArray(asset.files) ? asset.files : [];
    asset.technical = asset.technical && typeof asset.technical === 'object' ? asset.technical : {};
    asset.parsedTags = [];
    asset.tags.forEach(function (tag) {
      var at = tag.indexOf(':');
      if (at > 0 && at < tag.length - 1) {
        asset.parsedTags.push({ namespace: tag.slice(0, at), value: tag.slice(at + 1) });
      }
    });
    asset.searchText = [asset.id, asset.title, asset.summary, asset.role, asset.kind, asset.tags.join(' ')]
      .join(' ')
      .toLowerCase();
    asset.timestamp = Date.parse(asset.added || '') || 0;
    byId[asset.id] = asset;
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function formatBytes(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return 'Unknown';
    if (number < 1024) return Math.round(number) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var unit = -1;
    do {
      number = number / 1024;
      unit += 1;
    } while (number >= 1024 && unit < units.length - 1);
    var digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
    return Number(number.toFixed(digits)) + ' ' + units[unit];
  }

  function formatNumber(value) {
    var number = Number(value);
    if (!isFinite(number)) return String(value);
    return String(Math.round(number * 1000) / 1000);
  }

  function formatDate(value) {
    if (!value) return 'Unknown';
    var date = new Date(/^\\d{4}-\\d{2}-\\d{2}$/.test(value) ? value + 'T00:00:00' : value);
    if (isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatTech(key, value) {
    if (value === null || value === undefined || value === '') return '';
    if (Array.isArray(value)) return value.join(', ');
    if (key === 'duration_s') return formatNumber(value) + ' s';
    if (key === 'sample_rate') {
      var khz = Number(value) / 1000;
      return (Math.round(khz * 100) / 100) + ' kHz (' + formatNumber(value) + ' Hz)';
    }
    if (key === 'channels') {
      var labels = { 1: 'Mono', 2: 'Stereo' };
      return formatNumber(value) + (labels[value] ? ' (' + labels[value] + ')' : '');
    }
    if (key === 'bit_depth') return formatNumber(value) + '-bit';
    if (key === 'width' || key === 'height') return formatNumber(value) + ' px';
    if (key === 'fps') return formatNumber(value) + ' fps';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return '';
    return String(value);
  }

  function compareTitles(a, b) {
    return String(a.title).localeCompare(String(b.title), undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  }

  function hashString(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seeded(seed) {
    var value = seed >>> 0;
    return function () {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function buildWaveSvg(asset, bars, className) {
    var random = seeded(hashString(asset.id + ':' + bars));
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    var step = 100 / bars;
    for (var i = 0; i < bars; i += 1) {
      var height = 3 + Math.pow(random(), 1.6) * 31;
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', (i * step + step * 0.18).toFixed(2));
      rect.setAttribute('y', ((40 - height) / 2).toFixed(2));
      rect.setAttribute('width', (step * 0.64).toFixed(2));
      rect.setAttribute('height', height.toFixed(2));
      rect.setAttribute('rx', '0.3');
      svg.appendChild(rect);
    }
    return svg;
  }

  function buildTabs() {
    var counts = Object.create(null);
    ASSETS.forEach(function (asset) {
      counts[asset.kind] = (counts[asset.kind] || 0) + 1;
    });

    addTab('all', 'All', ASSETS.length);
    KINDS.forEach(function (kind) {
      if (counts[kind]) addTab(kind, kind.charAt(0).toUpperCase() + kind.slice(1), counts[kind]);
    });
  }

  function addTab(kind, label, total) {
    var button = el('button', 'tab');
    button.type = 'button';
    button.dataset.kind = kind;
    button.setAttribute('aria-pressed', kind === state.kind ? 'true' : 'false');
    button.appendChild(document.createTextNode(label));
    button.appendChild(el('span', 'count', total));
    button.addEventListener('click', function () {
      state.kind = kind;
      Array.prototype.forEach.call(tabs.querySelectorAll('.tab'), function (tab) {
        tab.setAttribute('aria-pressed', tab.dataset.kind === kind ? 'true' : 'false');
      });
      render();
    });
    tabs.appendChild(button);
  }

  function buildTagFacets() {
    var groups = Object.create(null);

    ASSETS.forEach(function (asset) {
      asset.parsedTags.forEach(function (tag) {
        if (!groups[tag.namespace]) groups[tag.namespace] = Object.create(null);
        groups[tag.namespace][tag.value] = (groups[tag.namespace][tag.value] || 0) + 1;
      });
    });

    var namespaces = Object.keys(groups).sort(function (a, b) {
      return a.localeCompare(b);
    });

    if (!namespaces.length) {
      noTags.hidden = false;
      clearTags.disabled = true;
      return;
    }

    noTags.hidden = true;
    clearTags.disabled = false;

    namespaces.forEach(function (namespace, index) {
      var values = Object.keys(groups[namespace]).sort(function (a, b) {
        return a.localeCompare(b);
      });
      var total = values.reduce(function (sum, value) {
        return sum + groups[namespace][value];
      }, 0);

      var details = document.createElement('details');
      details.className = 'tag-group';
      if (index < 3) details.open = true;

      var summary = document.createElement('summary');
      summary.textContent = namespace + ' (' + total + ')';
      details.appendChild(summary);

      var options = el('div', 'tag-options');
      values.forEach(function (value) {
        var label = el('label', 'tag-option');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.value = value;
        input.dataset.namespace = namespace;
        input.addEventListener('change', onTagChange);
        label.appendChild(input);
        label.appendChild(el('span', 'tag-label', value));
        var tagCount = el('span', 'n', groups[namespace][value]);
        tagCount.setAttribute('aria-hidden', 'true');
        label.appendChild(tagCount);
        options.appendChild(label);
      });

      details.appendChild(options);
      tagGroups.appendChild(details);
    });
  }

  function onTagChange(event) {
    var input = event.target;
    var namespace = input.dataset.namespace;
    var value = input.value;

    if (!state.tags[namespace]) state.tags[namespace] = Object.create(null);

    if (input.checked) {
      state.tags[namespace][value] = true;
    } else {
      delete state.tags[namespace][value];
      if (!Object.keys(state.tags[namespace]).length) delete state.tags[namespace];
    }

    render();
  }

  function matchesQuery(asset) {
    return !state.query || asset.searchText.indexOf(state.query) !== -1;
  }

  function matchesTags(asset) {
    var namespaces = Object.keys(state.tags);

    for (var i = 0; i < namespaces.length; i += 1) {
      var namespace = namespaces[i];
      var selected = state.tags[namespace];
      var found = false;

      for (var j = 0; j < asset.parsedTags.length; j += 1) {
        var tag = asset.parsedTags[j];
        if (tag.namespace === namespace && selected[tag.value]) {
          found = true;
          break;
        }
      }

      if (!found) return false;
    }

    return true;
  }

  function sortList(list) {
    list.sort(function (a, b) {
      if (state.sort === 'title') return compareTitles(a, b);
      if (state.sort === 'largest') return (b.bytes || 0) - (a.bytes || 0) || compareTitles(a, b);
      if (state.sort === 'kind') return a.kind.localeCompare(b.kind) || compareTitles(a, b);
      return (b.timestamp || 0) - (a.timestamp || 0) || compareTitles(a, b);
    });
  }

  function render() {
    var list = ASSETS.filter(function (asset) {
      return (state.kind === 'all' || asset.kind === state.kind) &&
        matchesQuery(asset) &&
        matchesTags(asset);
    });

    sortList(list);
    current = list;

    clear(grid);
    list.forEach(function (asset) {
      grid.appendChild(buildCard(asset));
    });

    countText.textContent = list.length + ' of ' + ASSETS.length +
      (ASSETS.length === 1 ? ' asset' : ' assets');
    grid.hidden = list.length === 0;
    empty.hidden = list.length !== 0;

    if (list.length === 0) {
      if (!ASSETS.length) {
        emptyTitle.textContent = 'No assets in this library yet';
        emptyText.textContent = 'Add bundles to assets/ and rebuild the gallery.';
        emptyReset.hidden = true;
      } else {
        emptyTitle.textContent = 'No assets match';
        emptyText.textContent = 'Try a different search, kind, or tag combination.';
        emptyReset.hidden = false;
      }
    }

    var hasFilters = Boolean(state.query) || state.kind !== 'all' ||
      Object.keys(state.tags).length > 0;
    resetButton.disabled = !hasFilters;
    emptyReset.disabled = !hasFilters;
  }

  function buildCard(asset) {
    var button = el('button', 'card');
    button.type = 'button';
    button.setAttribute('aria-label', 'Open ' + asset.title + ', ' + asset.kind +
      (asset.splat ? ', 3D splat' : '') +
      (asset.tileable ? ', tileable' : '') + (asset.role ? ', ' + asset.role : ''));

    var thumb = el('span', 'thumb');

    if (asset.kind === 'audio') {
      thumb.appendChild(buildWaveSvg(asset, 46, 'waveform'));
      thumb.appendChild(el('span', 'play-badge'));
      thumb.lastChild.setAttribute('aria-hidden', 'true');
    } else if (asset.kind === 'video') {
      addThumbImage(thumb, asset, true);
      thumb.appendChild(el('span', 'play-badge'));
      thumb.lastChild.setAttribute('aria-hidden', 'true');
    } else if (asset.splat) {
      if (asset.preview) {
        addThumbImage(thumb, asset, true, function () {
          showSplatPlaceholder(thumb);
        });
      } else {
        showSplatPlaceholder(thumb);
      }
      thumb.appendChild(el('span', 'play-badge'));
      thumb.lastChild.setAttribute('aria-hidden', 'true');
      thumb.appendChild(el('span', 'splat-badge', '3D Splat'));
    } else if (asset.tileable && asset.preview) {
      addTilePreview(thumb, asset);
    } else {
      addThumbImage(thumb, asset, false);
    }

    if (asset.tileable && !asset.splat && asset.kind !== 'audio' && asset.kind !== 'video') {
      thumb.appendChild(el('span', 'tile-badge', 'Tileable'));
    }

    button.appendChild(thumb);

    var body = el('span', 'card-body');
    body.appendChild(el('span', 'card-title', asset.title));

    var badge = el('span', 'badge');
    badge.appendChild(el('span', 'badge-kind', asset.kind));
    if (asset.role) {
      badge.appendChild(el('span', 'badge-sep', ' / '));
      badge.appendChild(el('span', 'badge-role', asset.role));
    }
    body.appendChild(badge);

    if (asset.summary) body.appendChild(el('span', 'card-summary', asset.summary));

    if (asset.tags.length) {
      var tagRow = el('span', 'tag-row');
      asset.tags.slice(0, 3).forEach(function (tag) {
        tagRow.appendChild(el('span', 'tag', tag));
      });
      if (asset.tags.length > 3) {
        var more = el('span', 'tag-more', '+' + (asset.tags.length - 3));
        more.setAttribute('aria-label', (asset.tags.length - 3) + ' more tags');
        tagRow.appendChild(more);
      }
      body.appendChild(tagRow);
    }

    button.appendChild(body);
    button.addEventListener('click', function () {
      openViewer(asset, false);
    });
    return button;
  }

  function addThumbImage(host, asset, cover, onFail) {
    if (!asset.preview) {
      if (onFail) onFail();
      else showPlaceholder(host, asset);
      return;
    }

    var image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    if (cover) image.className = 'cover';
    image.addEventListener('error', function () {
      if (onFail) onFail();
      else showPlaceholder(host, asset);
    });
    image.src = asset.preview;
    host.appendChild(image);
  }

  function showSplatPlaceholder(host) {
    var existing = host.querySelector('.splat-ph');
    if (existing) return;
    var box = el('span', 'splat-ph');
    box.appendChild(el('span', 'splat-ph-label', 'PLY'));
    host.appendChild(box);
  }

  function addTilePreview(host, asset) {
    var surface = el('span', 'tile-preview');
    surface.style.backgroundImage = 'url("' + asset.preview.replace(/"/g, '%22') + '")';
    host.appendChild(surface);

    var probe = new Image();
    probe.addEventListener('error', function () {
      surface.remove();
      showPlaceholder(host, asset);
    });
    probe.src = asset.preview;
  }

  function showPlaceholder(host, asset) {
    var existing = host.querySelector('.placeholder');
    if (existing) return;
    var box = el('span', 'placeholder');
    box.appendChild(el('span', 'ph-label', 'Preview unavailable'));
    box.appendChild(el('span', 'ph-detail', asset.kind + (asset.role ? ' / ' + asset.role : '')));
    host.appendChild(box);
  }

  // ---- viewer -------------------------------------------------------------

  function openViewer(asset, fromHash) {
    if (!asset) return;
    if (viewerAsset && viewerAsset.id === asset.id && dialog.open) return;

    var wasOpen = dialog.open;
    if (!wasOpen) {
      opener = fromHash ? null : document.activeElement;
    }

    var list = [];
    var index = -1;
    for (var i = 0; i < current.length; i += 1) {
      if (current[i].id === asset.id) {
        list = current.slice();
        index = i;
        break;
      }
    }
    if (index === -1) {
      list = [asset];
      index = 0;
    }

    viewerList = list;
    viewerIndex = index;
    viewerAsset = asset;

    if (!wasOpen) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }

    fillViewer();

    if (!wasOpen) vClose.focus();
    if (!fromHash) setHash(asset.id);
  }

  function fillViewer() {
    var asset = viewerList[viewerIndex];
    if (!asset) return;
    viewerAsset = asset;

    vTitle.textContent = asset.title;
    vBadge.textContent = '';
    vBadge.appendChild(el('span', 'badge-kind', asset.kind));
    if (asset.role) {
      vBadge.appendChild(el('span', 'badge-sep', ' / '));
      vBadge.appendChild(el('span', 'badge-role', asset.role));
    }
    vSummary.textContent = asset.summary || 'No summary.';

    fillMeta(asset);
    fillTags(asset);
    fillFiles(asset);

    vDownload.hidden = !asset.file;
    if (asset.file) {
      vDownload.href = asset.file;
      vDownload.setAttribute('download', '');
    } else {
      vDownload.removeAttribute('href');
    }
    vMd.href = asset.md;
    vJson.href = asset.json;

    vPos.textContent = (viewerIndex + 1) + ' / ' + viewerList.length;
    vPrev.disabled = viewerList.length < 2;
    vNext.disabled = viewerList.length < 2;

    renderMedia(asset);
  }

  function fillMeta(asset) {
    vMeta.textContent = '';
    addMeta('ID', asset.id, true);
    addMeta('Kind', asset.kind);
    if (asset.role) addMeta('Role', asset.role);
    if (asset.added) addMeta('Added', formatDate(asset.added));
    addMeta('Bundle size', formatBytes(asset.bytes));
    addMeta('Directory', asset.dir, true);
    if (asset.mime) addMeta('MIME type', asset.mime);

    Object.keys(asset.technical).forEach(function (key) {
      if (key === 'palette') return;
      var text = formatTech(key, asset.technical[key]);
      if (!text) return;
      addMeta(TECH_LABELS[key] || key.replace(/_/g, ' '), text);
    });
  }

  function addMeta(label, value, code) {
    var dt = el('dt', null, label);
    var dd = document.createElement('dd');
    if (code) {
      dd.appendChild(el('code', null, value));
    } else {
      dd.textContent = value;
    }
    vMeta.appendChild(dt);
    vMeta.appendChild(dd);
  }

  function fillTags(asset) {
    vTags.textContent = '';
    if (!asset.tags.length) {
      vTags.appendChild(el('span', 'muted', 'No tags.'));
      return;
    }
    asset.tags.forEach(function (tag) {
      vTags.appendChild(el('span', 'tag', tag));
    });
  }

  function fillFiles(asset) {
    vFiles.textContent = '';
    if (!asset.files.length) {
      var emptyItem = document.createElement('li');
      emptyItem.appendChild(el('span', 'muted', 'No file listing available.'));
      vFiles.appendChild(emptyItem);
      return;
    }

    asset.files.forEach(function (file) {
      var item = document.createElement('li');
      var link = el('a', null, file.path);
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener';
      item.appendChild(link);
      item.appendChild(el('span', 'file-size', formatBytes(file.bytes)));
      vFiles.appendChild(item);
    });
  }

  function destroySplat() {
    var handle = splatHandle;
    splatHandle = null;
    if (!handle) return;
    try {
      handle.destroy();
    } catch (error) {
      /* the WebGL context may already be gone */
    }
  }

  function renderMedia(asset) {
    destroySplat();
    clear(vMedia);
    tileApply = null;

    if (asset.splat) {
      renderSplat(asset);
    } else if (asset.tileable) {
      renderTileInspector(asset);
    } else if (asset.kind === 'audio') {
      renderAudio(asset);
    } else if (asset.kind === 'video') {
      renderVideo(asset);
    } else {
      renderImage(asset);
    }
  }

  function renderImage(asset) {
    var source = asset.preview;
    if (asset.kind === 'image' && asset.file &&
        (!asset.mime || asset.mime.indexOf('image/') === 0)) {
      source = asset.file;
    }

    if (!source) {
      vMedia.appendChild(el('p', 'muted', 'No preview is available for this asset.'));
      return;
    }

    var toolbar = el('div', 'image-toolbar');
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Image zoom');
    var zoomValues = [['fit', 'Fit'], ['1', '100%'], ['2', '200%']];
    var zoomButtons = [];

    zoomValues.forEach(function (pair) {
      var button = el('button', 'zoom-btn', pair[1]);
      button.type = 'button';
      button.dataset.zoom = pair[0];
      button.setAttribute('aria-pressed', pair[0] === 'fit' ? 'true' : 'false');
      button.addEventListener('click', function () {
        zoomButtons.forEach(function (other) {
          other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
        });
        setZoom(pair[0]);
      });
      zoomButtons.push(button);
      toolbar.appendChild(button);
    });

    var stage = el('div', 'image-stage');
    stage.tabIndex = 0;
    stage.setAttribute('aria-label', 'Image preview. Drag to pan when zoomed.');
    var canvas = el('div', 'image-canvas');
    var image = document.createElement('img');
    image.alt = asset.title;
    image.decoding = 'async';
    canvas.appendChild(image);
    stage.appendChild(canvas);
    vMedia.appendChild(toolbar);
    vMedia.appendChild(stage);

    var natural = {
      width: Number(asset.technical.width) || 512,
      height: Number(asset.technical.height) || 512
    };

    function setZoom(mode) {
      var stageBox = stage.getBoundingClientRect();
      var availableWidth = Math.max(64, stageBox.width - 32);
      var availableHeight = Math.max(64, stageBox.height - 32);
      var scale;

      if (mode === 'fit') {
        scale = Math.min(availableWidth / natural.width, availableHeight / natural.height, 1);
      } else {
        scale = Number(mode) || 1;
      }

      var width = Math.max(1, Math.round(natural.width * scale));
      image.style.width = width + 'px';
      image.style.height = 'auto';
    }

    image.addEventListener('load', function () {
      if (image.naturalWidth > 0) {
        natural.width = image.naturalWidth;
        natural.height = image.naturalHeight;
      }
      setZoom('fit');
    });
    image.addEventListener('error', function () {
      if (source !== asset.preview && asset.preview) {
        source = asset.preview;
        image.src = source;
        return;
      }
      clear(canvas);
      canvas.appendChild(el('p', 'muted', 'The preview image could not be loaded.'));
    });
    image.src = source;

    var drag = null;
    stage.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: stage.scrollLeft,
        top: stage.scrollTop
      };
      stage.classList.add('dragging');
      if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', function (event) {
      if (!drag) return;
      stage.scrollLeft = drag.left - (event.clientX - drag.x);
      stage.scrollTop = drag.top - (event.clientY - drag.y);
    });
    function endDrag() {
      drag = null;
      stage.classList.remove('dragging');
    }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
  }

  function renderAudio(asset) {
    var panel = el('div', 'audio-panel');
    var wave = el('div', 'wave-large');
    wave.setAttribute('aria-hidden', 'true');
    wave.appendChild(buildWaveSvg(asset, 96, null));
    panel.appendChild(wave);

    if (asset.file) {
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = asset.file;
      audio.setAttribute('aria-label', asset.title + ' audio player');
      panel.appendChild(audio);
    } else {
      panel.appendChild(el('p', 'muted', 'No playable audio file is listed for this asset.'));
    }

    var note = el('p', 'muted');
    note.style.margin = '0';
    note.style.fontSize = '.82rem';
    note.textContent = 'Use the player controls to listen. The waveform is a stylized preview.';
    panel.appendChild(note);
    vMedia.appendChild(panel);
  }

  function renderVideo(asset) {
    if (!asset.file) {
      vMedia.appendChild(el('p', 'muted', 'No playable video file is listed for this asset.'));
      return;
    }

    var wrap = el('div', 'video-wrap');
    var video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = asset.file;
    if (asset.preview) video.poster = asset.preview;
    video.setAttribute('aria-label', asset.title + ' video player');
    wrap.appendChild(video);
    vMedia.appendChild(wrap);

    var bar = el('div', 'video-bar');
    var loop = el('button', 'button subtle', 'Loop: off');
    loop.type = 'button';
    loop.setAttribute('aria-pressed', 'false');
    loop.addEventListener('click', function () {
      video.loop = !video.loop;
      loop.setAttribute('aria-pressed', video.loop ? 'true' : 'false');
      loop.textContent = video.loop ? 'Loop: on' : 'Loop: off';
    });
    bar.appendChild(loop);
    if (asset.mime) bar.appendChild(el('span', 'muted', asset.mime));
    vMedia.appendChild(bar);
  }

  function renderSplat(asset) {
    var autoOn = true;
    var flipOn = false;
    var failed = false;

    var wrap = el('div', 'splat-wrap');
    var stage = el('div', 'splat-stage');
    stage.id = 'splat-stage';
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-label', asset.title + ' 3D splat viewport');

    var poster = null;
    if (asset.preview) {
      poster = document.createElement('img');
      poster.className = 'splat-poster';
      poster.alt = '';
      poster.decoding = 'async';
      poster.src = asset.preview;
      poster.addEventListener('error', function () {
        poster.hidden = true;
      });
      stage.appendChild(poster);
    }

    var panel = el('div', 'splat-load');
    var loadButton = el('button', 'splat-load-btn', 'Load 3D');
    loadButton.type = 'button';
    loadButton.id = 'splat-load';
    loadButton.setAttribute('aria-label', 'Load 3D splat preview');
    var loadHint = el('p', 'splat-load-hint',
      'The PLY file is downloaded and parsed in this browser only after you press Load.');
    panel.appendChild(loadButton);
    panel.appendChild(loadHint);
    stage.appendChild(panel);

    var status = el('p', 'splat-status', 'Not loaded');
    status.id = 'splat-status';
    status.dataset.phase = 'idle';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    var errorBox = el('div', 'splat-error');
    errorBox.id = 'splat-error';
    errorBox.hidden = true;
    errorBox.setAttribute('role', 'alert');
    var errorText = el('span', 'splat-error-text');
    var errorDetail = el('span', 'splat-error-detail');
    errorBox.appendChild(errorText);
    errorBox.appendChild(errorDetail);

    var bar = el('div', 'splat-bar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '3D view controls');

    var autoButton = el('button', 'splat-btn', 'Auto-rotate: on');
    autoButton.type = 'button';
    autoButton.id = 'splat-auto';
    autoButton.setAttribute('aria-pressed', 'true');
    var flipButton = el('button', 'splat-btn', 'Flip Y: off');
    flipButton.type = 'button';
    flipButton.id = 'splat-flip';
    flipButton.setAttribute('aria-pressed', 'false');
    var resetButton = el('button', 'button subtle', 'Reset view');
    resetButton.type = 'button';
    resetButton.id = 'splat-reset';

    var readout = el('span', 'splat-readout');
    var totalText = el('span', null, '0 splats');
    totalText.id = 'splat-total';
    var drawnText = el('span', null, '0 drawn');
    drawnText.id = 'splat-drawn';
    readout.appendChild(totalText);
    readout.appendChild(drawnText);

    bar.appendChild(autoButton);
    bar.appendChild(flipButton);
    bar.appendChild(resetButton);
    bar.appendChild(readout);

    var hint = el('p', 'splat-hint', 'Drag to orbit, scroll to zoom. Auto-rotate spins the camera while it is on.');
    wrap.appendChild(stage);
    wrap.appendChild(status);
    wrap.appendChild(errorBox);
    wrap.appendChild(bar);
    wrap.appendChild(hint);
    vMedia.appendChild(wrap);

    function syncToggles() {
      autoButton.textContent = 'Auto-rotate: ' + (autoOn ? 'on' : 'off');
      autoButton.setAttribute('aria-pressed', autoOn ? 'true' : 'false');
      flipButton.textContent = 'Flip Y: ' + (flipOn ? 'on' : 'off');
      flipButton.setAttribute('aria-pressed', flipOn ? 'true' : 'false');
    }

    function setPhase(phase, text) {
      status.dataset.phase = phase;
      status.textContent = text;
    }

    function updateStats(stats) {
      var total = stats && isFinite(stats.total) ? Number(stats.total) : 0;
      var drawn = stats && isFinite(stats.drawn) ? Number(stats.drawn) : 0;
      totalText.textContent = total + (total === 1 ? ' splat' : ' splats');
      drawnText.textContent = drawn + ' drawn';
    }

    function showSplatError(message) {
      failed = true;
      setPhase('error', 'Load failed');
      errorText.textContent = '3D preview needs ';
      errorText.appendChild(el('code', null, 'npm run serve'));
      errorText.appendChild(document.createTextNode(' or the live site.'));
      errorDetail.textContent = message ? String(message) : 'The 3D file could not be loaded.';
      errorBox.hidden = false;
      destroySplat();
    }

    function startSplat() {
      if (failed || splatHandle) return;

      errorBox.hidden = true;
      errorDetail.textContent = '';
      loadButton.disabled = true;
      loadButton.textContent = 'Loading...';
      panel.hidden = true;
      if (poster) poster.hidden = true;
      updateStats(null);
      setPhase('fetch', 'Starting 3D view...');

      if (!asset.file) {
        showSplatError('No .ply file is listed for this asset.');
        return;
      }

      if (!window.MeesaSplat || typeof window.MeesaSplat.mountSplatViewer !== 'function') {
        showSplatError('The 3D renderer did not load.');
        return;
      }

      var handle;
      try {
        handle = window.MeesaSplat.mountSplatViewer(stage, {
          url: asset.file,
          autoRotate: autoOn,
          flipY: flipOn,
          onProgress: function (progress) {
            if (failed) return;
            if (progress.phase === 'fetch') {
              setPhase('fetch', 'Fetching PLY...');
            } else if (progress.phase === 'parse') {
              setPhase('parse', 'Parsing PLY' +
                (progress.bytes ? ' (' + formatBytes(progress.bytes) + ')' : '') + '...');
            } else if (progress.phase === 'ready') {
              updateStats({ total: progress.total, drawn: progress.drawn });
              setPhase('ready', 'Ready');
            } else if (progress.phase === 'error') {
              showSplatError(progress.message);
            }
          },
          onStats: function (stats) {
            if (!failed) updateStats(stats);
          }
        });
      } catch (error) {
        showSplatError(error && error.message ? error.message : String(error));
        return;
      }

      splatHandle = handle;
      var canvas = stage.querySelector('canvas');
      if (canvas) canvas.setAttribute('aria-label', asset.title + ' 3D splat canvas');
      if (failed) destroySplat();
    }

    autoButton.addEventListener('click', function () {
      autoOn = !autoOn;
      syncToggles();
      if (!splatHandle) return;
      try {
        splatHandle.setAutoRotate(autoOn);
      } catch (error) {
        showSplatError(error && error.message ? error.message : String(error));
      }
    });

    flipButton.addEventListener('click', function () {
      flipOn = !flipOn;
      syncToggles();
      if (!splatHandle) return;
      try {
        splatHandle.setFlipY(flipOn);
      } catch (error) {
        showSplatError(error && error.message ? error.message : String(error));
      }
    });

    resetButton.addEventListener('click', function () {
      if (!splatHandle) return;
      try {
        splatHandle.reset();
      } catch (error) {
        showSplatError(error && error.message ? error.message : String(error));
      }
    });

    loadButton.addEventListener('click', startSplat);
    syncToggles();
    updateStats(null);
  }

  function renderTileInspector(asset) {
    var wrap = el('div', 'tile-wrap');
    wrap.innerHTML = [
      '<div class="tile-toolbar">',
      '<div class="ctrl"><div class="ctrl-head"><label for="tile-rx">Repeat X</label><output id="tile-rx-out" for="tile-rx">3</output></div>',
      '<input id="tile-rx" type="range" min="1" max="16" step="1" value="3"></div>',
      '<div class="ctrl"><div class="ctrl-head"><label for="tile-ry">Repeat Y</label><output id="tile-ry-out" for="tile-ry">3</output></div>',
      '<input id="tile-ry" type="range" min="1" max="16" step="1" value="3"></div>',
      '<div class="ctrl"><div class="ctrl-head"><label for="tile-zoom">Zoom</label>',
      '<span><button type="button" class="mini" id="tile-fit">Fit</button> <output id="tile-zoom-out" for="tile-zoom">100%</output></span></div>',
      '<input id="tile-zoom" type="range" min="25" max="400" step="5" value="100"></div>',
      '<div class="ctrl"><div class="ctrl-head"><label for="tile-ox">Offset X</label><output id="tile-ox-out" for="tile-ox">0%</output></div>',
      '<input id="tile-ox" type="range" min="0" max="100" step="1" value="0"></div>',
      '<div class="ctrl"><div class="ctrl-head"><label for="tile-oy">Offset Y</label><output id="tile-oy-out" for="tile-oy">0%</output></div>',
      '<input id="tile-oy" type="range" min="0" max="100" step="1" value="0"></div>',
      '<div class="ctrl wide"><span class="ctrl-name">Background</span><div class="seg" id="tile-bgs" role="group" aria-label="Tiling background">',
      '<button type="button" data-bg="dark" aria-pressed="true">Dark</button>',
      '<button type="button" data-bg="light" aria-pressed="false">Light</button>',
      '<button type="button" data-bg="checker" aria-pressed="false">Checkerboard</button>',
      '<button type="button" data-bg="magenta" aria-pressed="false">Magenta</button></div></div>',
      '<div class="ctrl"><span class="ctrl-name">Overlays</span><div class="seg" role="group" aria-label="Overlays">',
      '<button type="button" id="tile-grid-btn" aria-pressed="false">Grid</button>',
      '<button type="button" id="tile-pixel-btn" aria-pressed="true">Pixelated</button></div></div>',
      '<div class="ctrl"><label for="tile-rot">Rotation</label>',
      '<select id="tile-rot"><option value="0">0 degrees</option><option value="90">90 degrees</option>',
      '<option value="180">180 degrees</option><option value="270">270 degrees</option></select></div>',
      '</div>',
      '<div class="tile-readout"><span id="tile-label" role="status" aria-live="polite"></span>',
      '<span class="spacer"></span><span class="muted">Drag to pan</span>',
      '<button type="button" class="button subtle" id="tile-reset">Reset view</button></div>',
      '<div class="tile-stage" id="tile-stage" data-bg="dark" tabindex="0" aria-label="Tiled preview. Drag to pan the texture.">',
      '<div class="tile-rotor" id="tile-rotor">',
      '<div class="tile-plane" id="tile-plane">',
      '<div class="tile-surface" id="tile-surface"></div>',
      '<div class="tile-grid" id="tile-grid" hidden></div>',
      '</div></div></div>',
      '<p class="tile-note" id="tile-note"></p>'
    ].join('');

    vMedia.appendChild(wrap);

    var rx = wrap.querySelector('#tile-rx');
    var ry = wrap.querySelector('#tile-ry');
    var zoom = wrap.querySelector('#tile-zoom');
    var ox = wrap.querySelector('#tile-ox');
    var oy = wrap.querySelector('#tile-oy');
    var rxOut = wrap.querySelector('#tile-rx-out');
    var ryOut = wrap.querySelector('#tile-ry-out');
    var zoomOut = wrap.querySelector('#tile-zoom-out');
    var oxOut = wrap.querySelector('#tile-ox-out');
    var oyOut = wrap.querySelector('#tile-oy-out');
    var bgs = wrap.querySelector('#tile-bgs');
    var gridButton = wrap.querySelector('#tile-grid-btn');
    var pixelButton = wrap.querySelector('#tile-pixel-btn');
    var rot = wrap.querySelector('#tile-rot');
    var reset = wrap.querySelector('#tile-reset');
    var fit = wrap.querySelector('#tile-fit');
    var stage = wrap.querySelector('#tile-stage');
    var rotor = wrap.querySelector('#tile-rotor');
    var plane = wrap.querySelector('#tile-plane');
    var surface = wrap.querySelector('#tile-surface');
    var gridLayer = wrap.querySelector('#tile-grid');
    var label = wrap.querySelector('#tile-label');
    var note = wrap.querySelector('#tile-note');

    var view = {
      rx: 3, ry: 3, zoom: 100, ox: 0, oy: 0,
      rot: 0, bg: 'dark', grid: false, pixel: true
    };
    var natural = {
      width: Number(asset.technical.width) || 64,
      height: Number(asset.technical.height) || 64
    };
    var tileWidth = natural.width;
    var tileHeight = natural.height;
    var source = asset.file || asset.preview;
    var drag = null;

    if (!source) {
      stage.appendChild(el('p', 'placeholder', 'No image or preview is available to tile.'));
      label.textContent = 'No image';
      return;
    }

    surface.style.backgroundImage = 'url("' + source.replace(/"/g, '%22') + '")';
    note.textContent = asset.file
      ? 'Tiling the original file. Transparent areas show the selected background.'
      : 'No primary file is listed, so the preview is being tiled.';

    var probe = new Image();
    probe.addEventListener('load', function () {
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        natural.width = probe.naturalWidth;
        natural.height = probe.naturalHeight;
      }
      apply();
    });
    probe.addEventListener('error', function () {
      if (source !== asset.preview && asset.preview) {
        source = asset.preview;
        surface.style.backgroundImage = 'url("' + source.replace(/"/g, '%22') + '")';
        note.textContent = 'The primary file could not be loaded; tiling the preview instead.';
        probe.src = source;
      } else {
        clear(stage);
        stage.appendChild(el('p', 'placeholder', 'The tiled image could not be loaded.'));
      }
    });
    probe.src = source;

    function wrapPercent(value) {
      var result = value % 100;
      if (result < 0) result += 100;
      return Math.round(result);
    }

    function apply() {
      var box = stage.getBoundingClientRect();
      var stageWidth = Math.max(1, box.width);
      var stageHeight = Math.max(1, box.height);
      var base = Math.min(
        stageWidth / (view.rx * natural.width),
        stageHeight / (view.ry * natural.height)
      );
      var scale = base * (view.zoom / 100);

      tileWidth = Math.max(1, natural.width * scale);
      tileHeight = Math.max(1, natural.height * scale);

      var position = (-view.ox / 100 * tileWidth) + 'px ' + (-view.oy / 100 * tileHeight) + 'px';
      plane.style.width = (view.rx * tileWidth) + 'px';
      plane.style.height = (view.ry * tileHeight) + 'px';
      surface.style.backgroundSize = tileWidth + 'px ' + tileHeight + 'px';
      surface.style.backgroundPosition = position;
      surface.style.imageRendering = view.pixel ? 'pixelated' : 'auto';
      gridLayer.style.backgroundSize = tileWidth + 'px ' + tileHeight + 'px';
      gridLayer.style.backgroundPosition = position;
      gridLayer.hidden = !view.grid;
      rotor.style.transform = 'rotate(' + view.rot + 'deg)';
      stage.dataset.bg = view.bg;
      label.textContent = view.rx + 'x' + view.ry + ' tiles @ ' + view.zoom + '%' +
        (view.zoom === 100 ? ' (fit)' : '');
    }

    function syncOutputs() {
      rxOut.textContent = view.rx;
      ryOut.textContent = view.ry;
      zoomOut.textContent = view.zoom + '%';
      oxOut.textContent = view.ox + '%';
      oyOut.textContent = view.oy + '%';
    }

    rx.addEventListener('input', function () {
      view.rx = Number(rx.value);
      syncOutputs();
      apply();
    });
    ry.addEventListener('input', function () {
      view.ry = Number(ry.value);
      syncOutputs();
      apply();
    });
    zoom.addEventListener('input', function () {
      view.zoom = Number(zoom.value);
      syncOutputs();
      apply();
    });
    ox.addEventListener('input', function () {
      view.ox = Number(ox.value);
      syncOutputs();
      apply();
    });
    oy.addEventListener('input', function () {
      view.oy = Number(oy.value);
      syncOutputs();
      apply();
    });
    fit.addEventListener('click', function () {
      view.zoom = 100;
      zoom.value = '100';
      syncOutputs();
      apply();
    });

    bgs.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-bg]');
      if (!button) return;
      view.bg = button.dataset.bg;
      Array.prototype.forEach.call(bgs.querySelectorAll('button'), function (other) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
      apply();
    });

    gridButton.addEventListener('click', function () {
      view.grid = !view.grid;
      gridButton.setAttribute('aria-pressed', view.grid ? 'true' : 'false');
      apply();
    });
    pixelButton.addEventListener('click', function () {
      view.pixel = !view.pixel;
      pixelButton.setAttribute('aria-pressed', view.pixel ? 'true' : 'false');
      apply();
    });
    rot.addEventListener('change', function () {
      view.rot = Number(rot.value) || 0;
      apply();
    });

    reset.addEventListener('click', function () {
      view.rx = 3;
      view.ry = 3;
      view.zoom = 100;
      view.ox = 0;
      view.oy = 0;
      view.rot = 0;
      view.bg = 'dark';
      view.grid = false;
      view.pixel = true;
      rx.value = '3';
      ry.value = '3';
      zoom.value = '100';
      ox.value = '0';
      oy.value = '0';
      rot.value = '0';
      Array.prototype.forEach.call(bgs.querySelectorAll('button'), function (button) {
        button.setAttribute('aria-pressed', button.dataset.bg === 'dark' ? 'true' : 'false');
      });
      gridButton.setAttribute('aria-pressed', 'false');
      pixelButton.setAttribute('aria-pressed', 'true');
      syncOutputs();
      apply();
    });

    stage.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, ox: view.ox, oy: view.oy };
      stage.classList.add('dragging');
      if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', function (event) {
      if (!drag) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      var angle = view.rot * Math.PI / 180;
      var cos = Math.cos(angle);
      var sin = Math.sin(angle);
      var localX = dx * cos + dy * sin;
      var localY = -dx * sin + dy * cos;
      view.ox = wrapPercent(drag.ox - localX / tileWidth * 100);
      view.oy = wrapPercent(drag.oy - localY / tileHeight * 100);
      ox.value = String(view.ox);
      oy.value = String(view.oy);
      syncOutputs();
      apply();
    });
    function endDrag() {
      drag = null;
      stage.classList.remove('dragging');
    }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    syncOutputs();
    apply();
    tileApply = apply;
  }

  // ---- navigation ---------------------------------------------------------

  function setHash(id) {
    var target = '#asset=' + encodeURIComponent(id);
    if (location.hash === target) return;
    try {
      history.replaceState(null, '', target);
    } catch (error) {
      location.hash = target.slice(1);
    }
  }

  function clearHash() {
    if (!location.hash) return;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (error) {
      location.hash = '';
    }
  }

  function handleHash() {
    var match = /^#asset=(.+)$/.exec(location.hash);
    if (!match) {
      if (dialog.open) closeViewer(false);
      return;
    }

    var id = match[1];
    try {
      id = decodeURIComponent(match[1]);
    } catch (error) {
      /* keep the raw value */
    }

    var asset = byId[id];
    if (asset) {
      openViewer(asset, true);
    } else if (dialog.open) {
      closeViewer(false);
    }
  }

  function stepViewer(delta) {
    if (viewerList.length < 2) return;
    viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
    fillViewer();
    setHash(viewerAsset.id);
  }

  function closeViewer(updateHash) {
    if (dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
        destroySplat();
        viewerList = [];
        viewerIndex = -1;
        viewerAsset = null;
        if (opener && opener.focus) opener.focus();
      }
    }
    if (updateHash !== false) clearHash();
  }

  function clearTagFilters() {
    state.tags = Object.create(null);
    Array.prototype.forEach.call(tagGroups.querySelectorAll('input[type="checkbox"]'), function (input) {
      input.checked = false;
    });
    render();
  }

  function resetFilters() {
    state.query = '';
    state.kind = 'all';
    state.tags = Object.create(null);
    searchInput.value = '';

    Array.prototype.forEach.call(tagGroups.querySelectorAll('input[type="checkbox"]'), function (input) {
      input.checked = false;
    });
    Array.prototype.forEach.call(tabs.querySelectorAll('.tab'), function (tab) {
      tab.setAttribute('aria-pressed', tab.dataset.kind === 'all' ? 'true' : 'false');
    });

    render();
  }

  searchInput.addEventListener('input', function () {
    state.query = searchInput.value.trim().toLowerCase();
    render();
  });

  sortSelect.addEventListener('change', function () {
    state.sort = sortSelect.value;
    render();
  });

  themeButton.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
      localStorage.setItem('mesa-gallery-theme', next);
    } catch (error) {
      /* storage is optional */
    }
  });

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeButton.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    themeButton.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
  }

  clearTags.addEventListener('click', clearTagFilters);
  resetButton.addEventListener('click', resetFilters);
  emptyReset.addEventListener('click', resetFilters);
  vClose.addEventListener('click', function () { closeViewer(true); });
  vPrev.addEventListener('click', function () { stepViewer(-1); });
  vNext.addEventListener('click', function () { stepViewer(1); });

  dialog.addEventListener('cancel', function (event) {
    event.preventDefault();
    closeViewer(true);
  });

  dialog.addEventListener('close', function () {
    // A hash navigation can open the next asset before this event fires; do not
    // tear down or move focus out of a viewer that is already open again.
    if (dialog.open) return;

    viewerList = [];
    viewerIndex = -1;
    viewerAsset = null;
    tileApply = null;
    destroySplat();
    clear(vMedia);

    if (opener && opener.isConnected && opener.focus) {
      opener.focus();
    } else {
      searchInput.focus();
    }
    opener = null;
  });

  document.addEventListener('keydown', function (event) {
    if (!dialog.open) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeViewer(true);
      return;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    var tag = event.target && event.target.tagName ? event.target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
        tag === 'AUDIO' || tag === 'VIDEO') {
      return;
    }
    event.preventDefault();
    stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
  });

  window.addEventListener('hashchange', handleHash);

  window.addEventListener('resize', function () {
    if (tileApply) tileApply();
  });

  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  buildTabs();
  buildTagFacets();
  render();
  handleHash();
})();
</script>
</body>
</html>
`;
}
