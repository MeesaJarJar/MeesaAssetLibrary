#!/usr/bin/env node
// Build a single self-contained gallery page from catalog/index.jsonl and,
// when present, catalog/community.jsonl.
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
//
// Community records carry "contributor" (GitHub login) and "license" and are
// tagged with scope "community" in the browser data. The curated catalog is
// required; the community catalog is optional and may be empty.

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
    console.error('Error: catalog/index.jsonl and catalog/community.jsonl contain no asset records; nothing to build.');
    console.error('       Add bundles to assets/ or community/ and rebuild.');
    process.exitCode = 1;
    return;
  }

  const assets = [];
  for (const entry of index.records) {
    const bundle = await readBundle(root, entry.dir);
    assets.push(toAsset(entry, bundle, root, outPath));
  }

  await mergeSearchIndex(root, assets);

  const splatSource = await loadSplatViewer();
  const html = renderHtml(assets, splatSource);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');

  const curatedCount = assets.filter((asset) => asset.scope === 'curated').length;
  const communityCount = assets.length - curatedCount;
  const kib = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log('Built gallery: ' + assets.length + ' assets (' + curatedCount + ' curated, ' +
    communityCount + ' community), ' + kib + ' KB -> ' + outPath);
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
  const curated = await loadCatalog(root, {
    file: 'index.jsonl',
    scope: 'curated',
    required: true,
  });
  const community = await loadCatalog(root, {
    file: 'community.jsonl',
    scope: 'community',
    required: false,
  });

  return { records: curated.records.concat(community.records) };
}

async function mergeSearchIndex(root, assets) {
  const indexPath = path.join(root, 'catalog', 'search-index.json');
  let text;

  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    console.warn('Warning: catalog/search-index.json could not be read; keyword extras omitted.');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    console.warn('Warning: catalog/search-index.json is not valid JSON; keyword extras omitted.');
    return;
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.assets)
      ? parsed.assets
      : [];
  const byId = new Map();

  entries.forEach((entry) => {
    if (entry && typeof entry === 'object' && cleanString(entry.id)) {
      byId.set(entry.id, entry);
    }
  });

  if (!byId.size) return;

  assets.forEach((asset) => {
    const entry = byId.get(asset.id);
    if (!entry) return;

    if (Array.isArray(entry.keywords)) {
      asset.keywords = entry.keywords.map(cleanString).filter((keyword) => keyword.length > 0);
    }
    if (!asset.prompt) asset.prompt = cleanString(entry.prompt);
    if (!asset.family) asset.family = cleanString(entry.family);
    if (!asset.sha256) asset.sha256 = cleanString(entry.sha256).toLowerCase();
    if (!asset.license) asset.license = cleanString(entry.license);
    if (!asset.contributor) {
      asset.contributor = cleanString(entry.contributor);
      asset.contributorUrl = asset.contributor
        ? 'https://github.com/' + encodeURIComponent(asset.contributor)
        : '';
    }
  });
}

async function loadCatalog(root, options) {
  const catalogPath = path.join(root, 'catalog', options.file);
  const label = 'catalog/' + options.file;
  let text;

  try {
    text = await readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!options.required) return { records: [] };
      throw new Error(label + ' was not found at ' + catalogPath);
    }
    throw new Error('Cannot read ' + catalogPath + ': ' + error.message);
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
      console.warn('Warning: ' + label + ':' + lineNo + ': invalid JSON (' + error.message + '); skipped.');
      return;
    }

    const result = validateRecord(raw, lineNo, seenIds, options.scope, label);
    if (result.error) {
      console.warn('Warning: ' + label + ':' + lineNo + ': ' + result.error + '; skipped.');
      return;
    }

    seenIds.add(result.record.id);
    records.push(result.record);
  });

  return { records };
}

function validateRecord(raw, lineNo, seenIds, scope, label) {
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
    console.warn('Warning: ' + label + ':' + lineNo + ': unsafe "preview" path; using a placeholder.');
    preview = '';
  }

  let file = cleanString(raw.file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (file && !isSafeRelative(file)) {
    console.warn('Warning: ' + label + ':' + lineNo + ': unsafe "file" path; ignoring it.');
    file = '';
  }

  const contributor = cleanString(raw.contributor);
  const license = cleanString(raw.license);
  if (scope === 'community' && !contributor) {
    console.warn('Warning: ' + label + ':' + lineNo + ': community record has no "contributor".');
  }
  if (scope === 'community' && !license) {
    console.warn('Warning: ' + label + ':' + lineNo + ': community record has no "license".');
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(cleanString).filter((tag) => tag.length > 0)
    : [];

  return {
    record: {
      scope,
      id,
      kind,
      role: cleanString(raw.role),
      title: cleanString(raw.title) || id,
      summary: cleanString(raw.summary),
      tags,
      keywords: Array.isArray(raw.keywords)
        ? raw.keywords.map(cleanString).filter((keyword) => keyword.length > 0)
        : [],
      prompt: cleanString(raw.prompt),
      family: cleanString(raw.family),
      preview,
      file,
      mime: cleanString(raw.mime),
      dir,
      bytes: toBytes(raw.bytes),
      sha256: cleanString(raw.sha256).toLowerCase(),
      added: cleanString(raw.added),
      contributor,
      license,
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
          sha256: cleanString(file.sha256).toLowerCase(),
        };
      })
      .filter((file) => isSafeRelative(file.path));
  }

  if (bundle.technical && typeof bundle.technical === 'object' && !Array.isArray(bundle.technical)) {
    result.technical = bundle.technical;
  }

  result.license = cleanString(bundle.license);
  result.contributor = cleanString(bundle.contributor && bundle.contributor.login
    ? bundle.contributor.login
    : bundle.contributor);

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
    sha256: file.sha256,
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

  let sha256 = entry.sha256;
  if (!sha256 && filePath) {
    const primaryFile = files.find((file) =>
      file.path === filePath || filePath.endsWith('/' + file.path));
    if (primaryFile) sha256 = primaryFile.sha256;
  }

  const contributor = entry.contributor || bundle.contributor || '';
  const license = entry.license || bundle.license || '';

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
    scope: entry.scope,
    id: entry.id,
    kind: entry.kind,
    role: entry.role,
    title: entry.title,
    summary: entry.summary,
    tags,
    keywords: entry.keywords,
    prompt: entry.prompt,
    family: entry.family,
    preview: previewUrl,
    previewName: entry.preview ? path.posix.basename(entry.preview) : '',
    file: fileUrl,
    fileName: filePath ? path.posix.basename(filePath) : '',
    mime: mime || '',
    sha256: sha256 || '',
    tileable,
    splat,
    technical,
    dir: entry.dir,
    bytes: entry.bytes,
    added: entry.added,
    contributor,
    contributorUrl: contributor
      ? 'https://github.com/' + encodeURIComponent(contributor)
      : '',
    license,
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
  --ok:#7ee2a8;--bad:#ff9b9b;--warn:#ffd166;
  --shadow:0 12px 32px rgba(0,0,0,.35);
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f6f7f9;--bg2:#eef1f5;--panel:#ffffff;--panel2:#f1f4f8;--text:#17202b;
  --muted:#5b6878;--line:#d8dee7;--accent:#0b63a8;--accent-soft:#d9ecfc;
  --chip:#e8eef6;--focus:#9a5b00;--stage:#dfe4ea;
  --ok:#1d7a46;--bad:#a12626;--warn:#8a5b00;
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
a.button{display:inline-block;text-decoration:none}
.add-asset{white-space:nowrap}
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
.card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;min-width:0}
.community-badge{
  display:inline-block;border:1px solid var(--accent);background:var(--accent-soft);
  color:var(--accent);border-radius:999px;padding:.05rem .45rem;line-height:1.4;
  font-size:.66rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
}
.card-contributor{font-size:.76rem;color:var(--muted);overflow-wrap:anywhere}
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
.search-meta{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin-top:.4rem}
.toggle{display:inline-flex;align-items:center;gap:.35rem;font-size:.78rem;color:var(--muted);cursor:pointer}
.toggle input{accent-color:var(--accent);margin:0}
.index-note{font-size:.76rem;color:var(--muted)}
.index-note.ready{color:var(--ok)}
.search-hint{margin:.3rem 0 0;font-size:.72rem;color:var(--muted);max-width:52ch}
.results-actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.concept-row{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin:-.45rem 0 1rem}
.concept-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.concept-chip{
  font-size:.76rem;border:1px solid var(--accent);background:var(--accent-soft);
  color:var(--text);border-radius:999px;padding:.08rem .55rem;
}
.concept-chip .sep{opacity:.55;padding:0 .12rem}
.partial-note{font-size:.78rem;color:var(--warn);margin:-.4rem 0 .8rem}
.card-main{
  display:flex;flex-direction:column;width:100%;padding:0;border:0;background:none;
  color:inherit;text-align:left;font:inherit;cursor:pointer;min-width:0;
}
.card-actions{display:flex;align-items:center;gap:.4rem;padding:0 .8rem .8rem;flex-wrap:wrap}
.cart-toggle{
  border:1px solid var(--line);background:var(--panel2);color:var(--muted);
  border-radius:7px;padding:.22rem .55rem;font-size:.75rem;
}
.cart-toggle:hover{color:var(--text);border-color:var(--accent)}
.cart-toggle[data-in-cart="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--text)}
.variant-badge{
  position:absolute;z-index:3;top:.4rem;left:.4rem;background:rgba(8,12,18,.8);
  border:1px solid rgba(255,255,255,.4);color:#eaf2fb;border-radius:999px;
  padding:.08rem .5rem;font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;
}
.variant-badge.inline{position:static;background:var(--chip);border-color:var(--line);color:var(--muted)}
.cart-panel{
  position:fixed;right:1rem;bottom:1rem;z-index:8;width:min(370px,calc(100vw - 2rem));
  background:var(--panel);border:1px solid var(--line);border-radius:13px;
  box-shadow:var(--shadow);overflow:hidden;
}
.cart-head{
  display:flex;align-items:center;gap:.5rem;width:100%;padding:.7rem .85rem;
  background:transparent;border:0;color:var(--text);text-align:left;
}
.cart-title{font-weight:650}
.cart-count{
  min-width:1.5rem;text-align:center;border:1px solid var(--accent);
  background:var(--accent-soft);border-radius:999px;padding:0 .4rem;
  font-size:.76rem;font-variant-numeric:tabular-nums;
}
.cart-bytes{margin-left:auto;font-size:.8rem;color:var(--muted);font-variant-numeric:tabular-nums}
.cart-body{border-top:1px solid var(--line);padding:.7rem .85rem .8rem;max-height:min(62vh,540px);overflow:auto}
.cart-licenses{display:grid;gap:.18rem;margin:0 0 .5rem}
.cart-license-row{display:flex;justify-content:space-between;gap:.7rem;font-size:.78rem;color:var(--muted)}
.cart-license-row .n{font-variant-numeric:tabular-nums}
.cart-license-row.restricted{color:var(--warn)}
.cart-items{list-style:none;margin:0;padding:0;display:grid;gap:.3rem}
.cart-item{
  display:flex;align-items:center;gap:.4rem;padding:.32rem .45rem;font-size:.8rem;
  border:1px solid var(--line);border-radius:7px;background:var(--panel2);min-width:0;
}
.cart-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}
.cart-item-id{font-size:.68rem;color:var(--muted);white-space:nowrap}
.cart-remove{border:0;background:none;color:var(--muted);padding:.05rem .25rem;border-radius:4px}
.cart-remove:hover{color:var(--bad)}
.cart-empty{margin:.2rem 0;font-size:.82rem;color:var(--muted)}
.cart-ack{
  display:flex;align-items:flex-start;gap:.45rem;margin:.6rem 0 .1rem;
  font-size:.78rem;line-height:1.35;color:var(--muted);
}
.cart-ack input{accent-color:var(--accent);margin:.12rem 0 0}
.cart-ack strong{color:var(--text);font-weight:600}
.cart-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.55rem}
.cart-note{margin:.45rem 0 0;font-size:.73rem;color:var(--muted)}
.empty-request{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--line)}
.empty-request p{max-width:46ch}
.empty-request .muted{font-size:.78rem;margin-top:.55rem}
.v-variants{margin-bottom:.7rem}
.variant-strip{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.3rem}
.variant-btn{
  border:1px solid var(--line);background:var(--panel2);color:var(--muted);
  border-radius:999px;padding:.18rem .55rem;font-size:.76rem;
}
.variant-btn[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--text)}
.v-cart-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem}
.similar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.45rem}
.similar-card{
  display:flex;flex-direction:column;gap:.25rem;padding:0;overflow:hidden;text-align:left;
  border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);
}
.similar-card:hover{border-color:var(--accent)}
.similar-thumb{display:block;aspect-ratio:4/3;background:var(--panel);overflow:hidden}
.similar-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.similar-title{font-size:.75rem;padding:.1rem .4rem .4rem;overflow-wrap:anywhere}
.check-body{padding:1rem 1.25rem;overflow:auto}
.check-summary{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.75rem}
.check-stat{
  border:1px solid var(--line);border-radius:8px;background:var(--panel2);
  padding:.35rem .6rem;font-size:.8rem;color:var(--muted);font-variant-numeric:tabular-nums;
}
.check-stat strong{color:var(--text)}
.check-item{border:1px solid var(--line);border-radius:9px;background:var(--panel2);padding:.6rem .7rem;margin-bottom:.5rem}
.check-item.restricted{border-color:var(--warn)}
.check-item-head{display:flex;justify-content:space-between;gap:.6rem;align-items:baseline;flex-wrap:wrap}
.check-item-title{font-weight:600;font-size:.88rem;overflow-wrap:anywhere}
.check-item-id{font-size:.72rem;color:var(--muted)}
.check-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:.35rem;margin-top:.5rem}
.check-pill{
  border:1px solid var(--line);border-radius:6px;padding:.25rem .4rem;
  font-size:.73rem;background:var(--panel);overflow-wrap:anywhere;
}
.check-pill .k{display:block;font-size:.64rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.check-pass{border-color:color-mix(in srgb,var(--ok) 55%,var(--line))}
.check-pass .v{color:var(--ok)}
.check-fail{border-color:color-mix(in srgb,var(--bad) 60%,var(--line))}
.check-fail .v{color:var(--bad)}
.check-warn{border-color:color-mix(in srgb,var(--warn) 60%,var(--line))}
.check-warn .v{color:var(--warn)}
.check-detail{display:block;margin-top:.2rem;font-size:.7rem;color:var(--muted)}
.restricted-note{
  margin:.6rem 0 0;padding:.55rem .7rem;border:1px solid var(--warn);border-radius:8px;
  background:color-mix(in srgb,var(--warn) 9%,var(--panel));font-size:.8rem;
}
.progress{height:9px;border:1px solid var(--line);border-radius:999px;background:var(--panel2);overflow:hidden;margin:.7rem 0}
.progress > div{height:100%;width:0;background:var(--accent);transition:width .15s ease}
.pack-status{margin:.2rem 0;font-size:.86rem}
.pack-summary{margin:.6rem 0 0;font-size:.88rem;overflow-wrap:anywhere}
.pack-error{color:var(--bad);font-size:.86rem;overflow-wrap:anywhere}
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
  .cart-panel{left:.5rem;right:.5rem;bottom:.5rem;width:auto}
  .cart-body{max-height:52vh}
  .similar{grid-template-columns:1fr}
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
    <input id="search" type="search" placeholder="id, title, summary, tags, keywords, role" autocomplete="off">
    <div class="search-meta">
      <label class="toggle" for="semantic-toggle">
        <input id="semantic-toggle" type="checkbox" checked>
        <span>Semantic</span>
      </label>
      <span class="index-note" id="index-note" hidden></span>
    </div>
    <p class="search-hint">Semantic ranks results by meaning once the catalog index loads. Keyword search always runs.</p>
  </div>
  <div class="controls">
    <a class="button subtle add-asset" href="https://github.com/MeesaJarJar/MeesaAssetLibrary/issues?q=label%3Aasset-request" target="_blank" rel="noopener">Requests</a>
    <a class="button subtle add-asset" href="../contribute/">Add asset</a>
    <div>
      <label for="sort">Sort</label>
      <select id="sort">
        <option value="relevance" selected>Relevance</option>
        <option value="title">Title A-Z</option>
        <option value="newest">Newest added</option>
        <option value="largest">Largest bytes</option>
        <option value="kind">Kind</option>
      </select>
    </div>
    <button type="button" class="button subtle" id="theme" aria-label="Switch to light theme">Light mode</button>
  </div>
</header>
<nav class="kind-tabs" id="kind-tabs" aria-label="Filter assets"></nav>
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
      <div class="results-actions">
        <button type="button" class="button subtle" id="add-all-results">Add all results</button>
        <button type="button" class="button subtle" id="reset">Reset filters</button>
      </div>
    </div>
    <div class="concept-row" id="concept-row" hidden>
      <span class="concept-label">Semantic match</span>
      <span id="concept-chips"></span>
    </div>
    <p class="partial-note" id="partial-note" hidden>Showing partial matches: no asset carries every term.</p>
    <div class="grid" id="grid" aria-label="Asset results"></div>
    <div class="empty" id="empty" hidden>
      <h2 id="empty-title">No assets found</h2>
      <p id="empty-text"></p>
      <button type="button" class="button" id="empty-reset">Reset filters</button>
      <div class="empty-request" id="empty-request" hidden>
        <p id="request-text"></p>
        <a class="button" id="request-link" href="#" target="_blank" rel="noopener">Request this asset</a>
        <p class="muted">This opens a GitHub issue labelled asset-request. It does not add the asset.</p>
      </div>
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
      <div class="v-variants" id="v-variants" hidden>
        <span class="field-label">Variants</span>
        <div class="variant-strip" id="v-variant-strip"></div>
      </div>
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
      <div class="v-cart-row">
        <button type="button" class="button" id="v-cart">Add to cart</button>
      </div>
      <h3 id="v-similar-heading" hidden>More like this</h3>
      <div class="similar" id="v-similar"></div>
    </aside>
  </div>
  <div class="v-foot">
    <button type="button" class="button subtle" id="v-prev">Previous</button>
    <span class="v-pos" id="v-pos"></span>
    <button type="button" class="button subtle" id="v-next">Next</button>
  </div>
</dialog>
<aside class="cart-panel" id="cart-panel" aria-label="Selection cart">
  <button type="button" class="cart-head" id="cart-head" aria-expanded="false" aria-controls="cart-body">
    <span class="cart-title">Cart</span>
    <span class="cart-count" id="cart-count">0</span>
    <span class="cart-bytes" id="cart-bytes">0 B</span>
  </button>
  <div class="cart-body" id="cart-body" hidden>
    <div class="cart-licenses" id="cart-licenses"></div>
    <p class="cart-empty" id="cart-empty">Cart is empty. Add assets from the grid or a viewer.</p>
    <ul class="cart-items" id="cart-items"></ul>
    <label class="cart-ack" id="cart-ack-row" hidden>
      <input type="checkbox" id="cart-ack">
      <span>I have read the <strong>restricted licence</strong> notice in Check output and accept responsibility for how these files are used.</span>
    </label>
    <div class="cart-actions">
      <button type="button" class="button" id="cart-check">Check output</button>
      <button type="button" class="button" id="cart-download">Download pack</button>
      <button type="button" class="button subtle" id="cart-clear">Clear</button>
    </div>
    <p class="cart-note" id="cart-note">Check output verifies every file hash before a pack can be downloaded.</p>
  </div>
</aside>
<dialog id="check-dialog" aria-labelledby="check-title">
  <div class="v-head">
    <div>
      <h2 id="check-title">Check output</h2>
      <p class="muted" id="check-sub" style="margin:.2rem 0 0;font-size:.82rem"></p>
    </div>
    <button type="button" class="button subtle" id="check-close">Close</button>
  </div>
  <div class="check-body">
    <div class="check-summary" id="check-summary"></div>
    <div id="check-list"></div>
    <label class="cart-ack" id="check-ack-row" hidden>
      <input type="checkbox" id="check-ack">
      <span>I acknowledge that at least one selected asset is <strong>LicenseRef-All-Rights-Reserved</strong> or has an unknown licence. I am responsible for obtaining permission before use.</span>
    </label>
    <p class="restricted-note" id="check-restricted-note" hidden></p>
    <p class="pack-status" id="check-status" role="status" aria-live="polite"></p>
  </div>
  <div class="v-foot">
    <span class="muted" id="check-total"></span>
    <div class="results-actions">
      <button type="button" class="button subtle" id="check-run">Run check</button>
      <button type="button" class="button" id="check-download">Download pack</button>
    </div>
  </div>
</dialog>
<dialog id="pack-dialog" aria-labelledby="pack-title">
  <div class="v-head">
    <div>
      <h2 id="pack-title">Building pack</h2>
      <p class="muted" id="pack-sub" style="margin:.2rem 0 0;font-size:.82rem"></p>
    </div>
    <button type="button" class="button subtle" id="pack-close">Close</button>
  </div>
  <div class="check-body">
    <p class="pack-status" id="pack-status" role="status" aria-live="polite">Starting.</p>
    <div class="progress" id="pack-progress"><div id="pack-bar"></div></div>
    <p class="pack-summary" id="pack-summary"></p>
    <p class="pack-error" id="pack-error" hidden></p>
  </div>
  <div class="v-foot">
    <span class="muted" id="pack-total"></span>
    <div class="results-actions">
      <a class="button" id="pack-save" hidden download>Save ZIP</a>
      <button type="button" class="button subtle" id="pack-done">Done</button>
    </div>
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
  var state = {
    query: '', kind: 'all', sort: 'relevance', tags: Object.create(null),
    semantic: true, partial: false
  };
  var current = [];
  var byId = Object.create(null);
  var viewerList = [];
  var viewerIndex = -1;
  var viewerAsset = null;
  var viewerFamily = [];
  var opener = null;
  var tileApply = null;
  var splatHandle = null;
  var matchedConcepts = [];
  var cartOrder = [];
  var cartMap = Object.create(null);
  var checkResults = null;
  var checkAck = false;
  var checkBusy = false;
  var packBusy = false;
  var cartHadRestricted = false;
  var lastPack = null;

  var semantic = {
    status: 'idle',
    promise: null,
    message: '',
    dim: 512,
    assets: Object.create(null),
    concepts: [],
    conceptEmbeddings: Object.create(null),
    clip: null,
    clap: null,
    clipModel: '',
    clapModel: ''
  };

  var searchInput = document.getElementById('search');
  var semanticToggle = document.getElementById('semantic-toggle');
  var indexNote = document.getElementById('index-note');
  var sortSelect = document.getElementById('sort');
  var themeButton = document.getElementById('theme');
  var tabs = document.getElementById('kind-tabs');
  var tagGroups = document.getElementById('tag-groups');
  var noTags = document.getElementById('no-tags');
  var clearTags = document.getElementById('clear-tags');
  var resetButton = document.getElementById('reset');
  var addAllButton = document.getElementById('add-all-results');
  var emptyReset = document.getElementById('empty-reset');
  var emptyRequest = document.getElementById('empty-request');
  var requestText = document.getElementById('request-text');
  var requestLink = document.getElementById('request-link');
  var conceptRow = document.getElementById('concept-row');
  var conceptChips = document.getElementById('concept-chips');
  var partialNote = document.getElementById('partial-note');
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
  var vVariants = document.getElementById('v-variants');
  var vVariantStrip = document.getElementById('v-variant-strip');
  var vCart = document.getElementById('v-cart');
  var vSimilarHeading = document.getElementById('v-similar-heading');
  var vSimilar = document.getElementById('v-similar');
  var cartPanel = document.getElementById('cart-panel');
  var cartHead = document.getElementById('cart-head');
  var cartBody = document.getElementById('cart-body');
  var cartCount = document.getElementById('cart-count');
  var cartBytes = document.getElementById('cart-bytes');
  var cartLicenses = document.getElementById('cart-licenses');
  var cartItems = document.getElementById('cart-items');
  var cartEmpty = document.getElementById('cart-empty');
  var cartAckRow = document.getElementById('cart-ack-row');
  var cartAck = document.getElementById('cart-ack');
  var cartCheck = document.getElementById('cart-check');
  var cartDownload = document.getElementById('cart-download');
  var cartClear = document.getElementById('cart-clear');
  var checkDialog = document.getElementById('check-dialog');
  var checkSub = document.getElementById('check-sub');
  var checkSummary = document.getElementById('check-summary');
  var checkList = document.getElementById('check-list');
  var checkAckRow = document.getElementById('check-ack-row');
  var checkAckBox = document.getElementById('check-ack');
  var checkRestrictedNote = document.getElementById('check-restricted-note');
  var checkStatus = document.getElementById('check-status');
  var checkTotal = document.getElementById('check-total');
  var checkRun = document.getElementById('check-run');
  var checkDownload = document.getElementById('check-download');
  var checkClose = document.getElementById('check-close');
  var packDialog = document.getElementById('pack-dialog');
  var packSub = document.getElementById('pack-sub');
  var packStatus = document.getElementById('pack-status');
  var packBar = document.getElementById('pack-bar');
  var packSummary = document.getElementById('pack-summary');
  var packError = document.getElementById('pack-error');
  var packTotal = document.getElementById('pack-total');
  var packClose = document.getElementById('pack-close');
  var packDone = document.getElementById('pack-done');
  var packSave = document.getElementById('pack-save');

  function prepareAsset(asset) {
    asset.scope = asset.scope === 'community' ? 'community' : 'curated';
    asset.contributor = typeof asset.contributor === 'string' ? asset.contributor : '';
    asset.contributorUrl = typeof asset.contributorUrl === 'string' ? asset.contributorUrl : '';
    asset.license = typeof asset.license === 'string' ? asset.license : '';
    asset.tags = Array.isArray(asset.tags) ? asset.tags : [];
    asset.files = Array.isArray(asset.files) ? asset.files : [];
    asset.keywords = Array.isArray(asset.keywords) ? asset.keywords : [];
    asset.prompt = typeof asset.prompt === 'string' ? asset.prompt : '';
    asset.family = typeof asset.family === 'string' ? asset.family : '';
    asset.sha256 = typeof asset.sha256 === 'string' ? asset.sha256 : '';
    asset.previewName = typeof asset.previewName === 'string' ? asset.previewName : '';
    asset.fileName = typeof asset.fileName === 'string' ? asset.fileName : '';
    asset.technical = asset.technical && typeof asset.technical === 'object' ? asset.technical : {};
    asset.parsedTags = [];
    asset.tags.forEach(function (tag) {
      var at = tag.indexOf(':');
      if (at > 0 && at < tag.length - 1) {
        asset.parsedTags.push({ namespace: tag.slice(0, at), value: tag.slice(at + 1) });
      }
    });
    asset.searchFields = {
      title: String(asset.title || '') + ' ' + String(asset.id || ''),
      tags: asset.tags.join(' '),
      keywords: asset.keywords.join(' '),
      summary: String(asset.summary || ''),
      prompt: asset.prompt,
      role: String(asset.role || '') + ' ' + String(asset.kind || '')
    };
    Object.keys(asset.searchFields).forEach(function (key) {
      asset.searchFields[key] = asset.searchFields[key].toLowerCase();
    });
    asset.searchFieldsNormalized = Object.create(null);
    Object.keys(asset.searchFields).forEach(function (key) {
      asset.searchFieldsNormalized[key] = tokenize(asset.searchFields[key]).join(' ');
    });
    asset.timestamp = Date.parse(asset.added || '') || 0;
    byId[asset.id] = asset;
  }

  ASSETS.forEach(prepareAsset);

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
    var communityCount = 0;
    ASSETS.forEach(function (asset) {
      counts[asset.kind] = (counts[asset.kind] || 0) + 1;
      if (asset.scope === 'community') communityCount += 1;
    });

    addTab('all', 'All', ASSETS.length);
    addTab('community', 'Community', communityCount);
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

  var KEYWORD_FIELDS = [
    ['title', 5], ['tags', 4], ['keywords', 3], ['summary', 2], ['prompt', 2], ['role', 1]
  ];

  function singularWord(value) {
    var word = String(value || '').toLowerCase();
    if (word.length > 4 && word.slice(-3) === 'ies') return word.slice(0, -3) + 'y';
    if (word.length > 3 && word.charAt(word.length - 1) === 's' && word.slice(-2) !== 'ss') {
      return word.slice(0, -1);
    }
    return word;
  }

  function tokenize(value) {
    var seen = Object.create(null);
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(function (token) { return token.length > 0; })
      .map(singularWord)
      .filter(function (token) {
        if (seen[token]) return false;
        seen[token] = true;
        return true;
      });
  }

  function queryTerms(query) {
    var terms = [];
    var rest = String(query || '');
    rest = rest.replace(/"([^"]+)"/g, function (match, phrase) {
      var words = tokenize(phrase);
      if (words.length) terms.push({ text: words.join(' '), phrase: true });
      return ' ';
    });
    tokenize(rest).forEach(function (token) {
      terms.push({ text: token, phrase: false });
    });
    var seen = Object.create(null);
    return terms.filter(function (term) {
      var key = (term.phrase ? 'p:' : 't:') + term.text;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function termInAsset(asset, term) {
    var fields = asset.searchFields;
    var normalized = asset.searchFieldsNormalized || {};
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i += 1) {
      if (fields[keys[i]].indexOf(term.text) !== -1) return true;
      if (normalized[keys[i]] && normalized[keys[i]].indexOf(term.text) !== -1) return true;
    }
    return false;
  }

  function keywordScore(asset, terms) {
    if (!terms.length) return 0;
    var total = 0;
    var normalized = asset.searchFieldsNormalized || {};
    terms.forEach(function (term) {
      if (!termInAsset(asset, term)) return;
      var weight = 0;
      KEYWORD_FIELDS.forEach(function (pair) {
        if (asset.searchFields[pair[0]].indexOf(term.text) !== -1 ||
            (normalized[pair[0]] && normalized[pair[0]].indexOf(term.text) !== -1)) {
          weight += pair[1];
        }
      });
      total += Math.min(5, weight);
    });
    return total / (5 * terms.length);
  }

  function conceptTermSet(concept) {
    var values = [concept.id, concept.label].concat(
      Array.isArray(concept.synonyms) ? concept.synonyms : []
    );
    var set = Object.create(null);
    values.forEach(function (value) {
      var raw = String(value || '').trim().toLowerCase();
      if (!raw) return;
      set[raw] = true;
      tokenize(raw).forEach(function (token) { set[token] = true; });
    });
    return set;
  }

  function matchConcepts(query, terms) {
    if (!semantic.concepts.length) return [];
    var tokens = Object.create(null);
    terms.forEach(function (term) {
      if (!term.phrase) tokens[term.text] = true;
    });
    var lower = String(query || '').toLowerCase();
    var matched = [];
    semantic.concepts.forEach(function (concept) {
      var set = conceptTermSet(concept);
      var hit = false;
      Object.keys(tokens).forEach(function (token) {
        if (set[token]) hit = true;
      });
      if (!hit) {
        Object.keys(set).forEach(function (term) {
          if (term.indexOf(' ') !== -1 && lower.indexOf(term) !== -1) hit = true;
        });
      }
      if (hit) matched.push(concept);
    });
    return matched;
  }

  function vectorAt(bin, index) {
    if (!bin || index === null || index === undefined) return null;
    var number = Number(index);
    if (!isFinite(number) || number < 0) return null;
    var offset = Math.floor(number) * semantic.dim;
    if (offset + semantic.dim > bin.length) return null;
    return bin.subarray(offset, offset + semantic.dim);
  }

  function cosine(a, b) {
    if (!a || !b) return 0;
    var dot = 0;
    var na = 0;
    var nb = 0;
    for (var i = 0; i < semantic.dim; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  var CLIP_FLOOR = 0.22;
  var CLAP_FLOOR = 0.10;

  function conceptModality(concept) {
    var value = String(concept.modality || 'both').toLowerCase();
    return value === 'audio' || value === 'visual' ? value : 'both';
  }

  function conceptHasVector(concept) {
    var entry = semantic.conceptEmbeddings[concept.id];
    if (!entry) return false;
    var modality = conceptModality(concept);
    var hasClip = modality !== 'audio' && semantic.clip &&
      entry.clip !== null && entry.clip !== undefined;
    var hasClap = modality !== 'visual' && semantic.clap &&
      entry.clap !== null && entry.clap !== undefined;
    return Boolean(hasClip || hasClap);
  }

  function meanConceptVector(field, concepts) {
    var bin = field === 'clip' ? semantic.clip : semantic.clap;
    if (!bin) return null;
    var vectors = [];
    concepts.forEach(function (concept) {
      var modality = conceptModality(concept);
      if (field === 'clip' && modality === 'audio') return;
      if (field === 'clap' && modality === 'visual') return;
      var entry = semantic.conceptEmbeddings[concept.id];
      if (!entry || entry[field] === null || entry[field] === undefined) return;
      var vector = vectorAt(bin, entry[field]);
      if (vector) vectors.push(vector);
    });
    if (!vectors.length) return null;
    var out = new Float32Array(semantic.dim);
    vectors.forEach(function (vector) {
      for (var i = 0; i < semantic.dim; i += 1) out[i] += vector[i];
    });
    var norm = 0;
    for (var j = 0; j < semantic.dim; j += 1) norm += out[j] * out[j];
    norm = Math.sqrt(norm);
    if (norm) {
      for (var k = 0; k < semantic.dim; k += 1) out[k] = out[k] / norm;
    }
    return out;
  }

  // v1 scores media vectors only. Text embeddings stay in the manifest for future
  // calibration but are not compared here: CLIP text-to-text cosines are anisotropic.
  function semanticMediaScore(asset, queryClip, queryClap) {
    var entry = semantic.assets[asset.id];
    if (!entry) return null;
    var audio = asset.kind === 'audio';
    var bin = audio ? semantic.clap : semantic.clip;
    var query = audio ? queryClap : queryClip;
    if (!bin || !query) return null;
    var vector = vectorAt(bin, audio ? entry.clapAudio : entry.clipImage);
    if (!vector) return null;
    var value = cosine(query, vector);
    if (!isFinite(value)) return null;
    return value >= (audio ? CLAP_FLOOR : CLIP_FLOOR) ? value : null;
  }

  function conceptContributes(concept) {
    var modality = conceptModality(concept);
    var clip = modality !== 'audio' ? meanConceptVector('clip', [concept]) : null;
    var clap = modality !== 'visual' ? meanConceptVector('clap', [concept]) : null;
    if (!clip && !clap) return false;

    return ASSETS.some(function (asset) {
      if (asset.kind === 'audio') {
        return clap ? semanticMediaScore(asset, null, clap) !== null : false;
      }
      return clip ? semanticMediaScore(asset, clip, null) !== null : false;
    });
  }

  function computeSearch() {
    var query = state.query.trim();
    var terms = query ? queryTerms(query) : [];
    matchedConcepts = [];
    var semanticScores = null;
    var resultModality = null;

    if (terms.length && state.semantic && semantic.status === 'ready') {
      var matched = matchConcepts(query, terms).filter(conceptHasVector);
      var contributors = matched.filter(conceptContributes);
      if (contributors.length) {
        var clip = meanConceptVector('clip', contributors);
        var clap = meanConceptVector('clap', contributors);
        if (clip || clap) {
          var scores = Object.create(null);
          var contributed = false;
          ASSETS.forEach(function (asset) {
            var value = semanticMediaScore(asset, clip, clap);
            scores[asset.id] = value;
            if (value !== null) contributed = true;
          });
          if (contributed) {
            matchedConcepts = contributors;
            semanticScores = scores;

            // An audio-only concept must not pull in images or video, even when a
            // summary happens to use the same word. Visual-only concepts mirror this.
            var modalities = contributors.map(conceptModality);
            if (modalities.every(function (value) { return value === 'audio'; })) {
              resultModality = 'audio';
            } else if (modalities.every(function (value) { return value === 'visual'; })) {
              resultModality = 'visual';
            }
          }
        }
      }
    }

    var entries = ASSETS.map(function (asset) {
      var keyword = terms.length ? keywordScore(asset, terms) : 0;
      var all = terms.length ? terms.every(function (term) {
        return termInAsset(asset, term);
      }) : true;
      var any = terms.length ? terms.some(function (term) {
        return termInAsset(asset, term);
      }) : true;
      var semanticScore = semanticScores ? semanticScores[asset.id] : null;

      var score = semanticScore !== null
        ? 0.55 * semanticScore + 0.45 * keyword
        : keyword;

      return { asset: asset, keyword: keyword, semantic: semanticScore, score: score, all: all, any: any };
    });

    return { query: query, terms: terms, entries: entries, modality: resultModality };
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

  function buildGroups(entries, hasQuery) {
    var groups = [];
    var map = Object.create(null);

    entries.forEach(function (entry) {
      var key = entry.asset.family
        ? 'family:' + entry.asset.family
        : 'asset:' + entry.asset.id;
      var group = map[key];

      if (!group) {
        group = {
          key: key,
          family: entry.asset.family,
          members: [],
          rep: entry.asset,
          score: entry.score,
          bytes: 0,
          timestamp: 0
        };
        map[key] = group;
        groups.push(group);
      }

      group.members.push(entry);
      group.bytes += Number(entry.asset.bytes) || 0;
      group.timestamp = Math.max(group.timestamp, entry.asset.timestamp || 0);
    });

    groups.forEach(function (group) {
      if (hasQuery) {
        group.members.sort(function (a, b) {
          return b.score - a.score || compareTitles(a.asset, b.asset);
        });
      }
      group.rep = group.members[0].asset;
      group.score = group.members[0].score;
      group.variantCount = group.members.length;
    });

    return groups;
  }

  function sortGroups(groups) {
    groups.sort(function (a, b) {
      if (state.query && state.sort === 'relevance') {
        return b.score - a.score || compareTitles(a.rep, b.rep);
      }
      if (state.sort === 'title') return compareTitles(a.rep, b.rep);
      if (state.sort === 'largest') {
        return (b.bytes || 0) - (a.bytes || 0) || compareTitles(a.rep, b.rep);
      }
      if (state.sort === 'kind') {
        return a.rep.kind.localeCompare(b.rep.kind) || compareTitles(a.rep, b.rep);
      }
      return (b.timestamp || 0) - (a.timestamp || 0) || compareTitles(a.rep, b.rep);
    });
  }

  function requestUrl(query) {
    var body = [
      'The gallery has no result for: ' + query,
      '',
      'What asset would help? Describe the kind, role, style, format and licence you need.',
      '',
      'Opened from the asset library gallery.'
    ].join('\\n');
    return 'https://github.com/MeesaJarJar/MeesaAssetLibrary/issues/new?labels=asset-request' +
      '&title=' + encodeURIComponent('[Asset request] ' + query) +
      '&body=' + encodeURIComponent(body);
  }

  function renderConceptChips() {
    clear(conceptChips);
    conceptRow.hidden = matchedConcepts.length === 0;
    matchedConcepts.forEach(function (concept) {
      var chip = el('span', 'concept-chip');
      chip.appendChild(document.createTextNode(concept.label || concept.id));
      var synonyms = Array.isArray(concept.synonyms) ? concept.synonyms : [];
      synonyms.slice(0, 4).forEach(function (synonym) {
        chip.appendChild(el('span', 'sep', '·'));
        chip.appendChild(document.createTextNode(synonym));
      });
      if (synonyms.length > 4) chip.appendChild(el('span', 'sep', '·'));
      chip.title = 'Concept ' + (concept.id || '') +
        (synonyms.length ? ' · ' + synonyms.join(', ') : '');
      conceptChips.appendChild(chip);
    });
  }

  function render() {
    var search = computeSearch();
    var filtered = search.entries.filter(function (entry) {
      var kindMatch = state.kind === 'all' ||
        (state.kind === 'community'
          ? entry.asset.scope === 'community'
          : entry.asset.kind === state.kind);
      var modalityMatch = !search.modality ||
        (search.modality === 'audio'
          ? entry.asset.kind === 'audio'
          : entry.asset.kind !== 'audio');
      return kindMatch && modalityMatch && matchesTags(entry.asset);
    });

    var chosen = filtered;
    var partial = false;

    if (search.terms.length) {
      var allTerms = filtered.filter(function (entry) { return entry.all; });
      var anyTerms = null;

      if (allTerms.length) {
        chosen = allTerms;
      } else {
        anyTerms = filtered.filter(function (entry) { return entry.any; });
        if (anyTerms.length) {
          chosen = anyTerms;
          partial = true;
        } else {
          chosen = [];
        }
      }

      // Semantic adds candidates and boosts ranking; it never removes a keyword hit.
      if (search.entries.some(function (entry) { return entry.semantic !== null; })) {
        var byKey = Object.create(null);
        chosen.forEach(function (entry) { byKey[entry.asset.id] = entry; });
        filtered.forEach(function (entry) {
          if (entry.semantic !== null) byKey[entry.asset.id] = entry;
        });
        chosen = Object.keys(byKey).map(function (id) { return byKey[id]; });
      }
    }

    state.partial = partial;
    var groups = buildGroups(chosen, search.terms.length > 0);
    sortGroups(groups);
    current = groups;

    clear(grid);
    groups.forEach(function (group) {
      grid.appendChild(buildCard(group));
    });

    var shownAssets = groups.reduce(function (sum, group) {
      return sum + group.variantCount;
    }, 0);
    countText.textContent = groups.length + (groups.length === 1 ? ' result' : ' results') +
      ' · ' + shownAssets + ' of ' + ASSETS.length +
      (ASSETS.length === 1 ? ' asset' : ' assets') + (partial ? ' · partial matches' : '');

    grid.hidden = groups.length === 0;
    empty.hidden = groups.length !== 0;
    renderConceptChips();
    partialNote.hidden = !partial;
    addAllButton.disabled = groups.length === 0;

    if (groups.length === 0) {
      var query = state.query.trim();
      if (!ASSETS.length) {
        emptyTitle.textContent = 'No assets in this library yet';
        emptyText.textContent = 'Add bundles to assets/ and rebuild the gallery.';
        emptyReset.hidden = true;
        emptyRequest.hidden = true;
      } else if (query) {
        emptyTitle.textContent = 'Nothing matches "' + query + '".';
        emptyText.textContent = 'No keyword or semantic result carries every term. You can ask for this asset.';
        emptyReset.hidden = false;
        emptyRequest.hidden = false;
        requestText.textContent = 'Request "' + query + '" from the library maintainers.';
        requestLink.href = requestUrl(query);
      } else {
        emptyTitle.textContent = 'No assets match';
        emptyText.textContent = 'Try a different search, kind, or tag combination.';
        emptyReset.hidden = false;
        emptyRequest.hidden = true;
      }
    }

    var hasFilters = Boolean(state.query) || state.kind !== 'all' ||
      Object.keys(state.tags).length > 0;
    resetButton.disabled = !hasFilters;
    emptyReset.disabled = !hasFilters;
    updateCartPanel();
  }

  function buildCard(group) {
    var asset = group.rep;
    var card = el('article', 'card');
    var open = el('button', 'card-main');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open ' + asset.title + ', ' + asset.kind +
      (group.variantCount > 1 ? ', ' + group.variantCount + ' variants' : '') +
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

    if (group.variantCount > 1) {
      thumb.appendChild(el('span', 'variant-badge', group.variantCount + ' variants'));
    }

    open.appendChild(thumb);

    var body = el('span', 'card-body');
    body.appendChild(el('span', 'card-title', asset.title));

    if (asset.scope === 'community') {
      var scopeRow = el('span', 'card-meta');
      scopeRow.appendChild(el('span', 'community-badge', 'Community'));
      if (asset.contributor) {
        scopeRow.appendChild(el('span', 'card-contributor', '@' + asset.contributor));
      }
      body.appendChild(scopeRow);
    }

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

    open.appendChild(body);
    open.addEventListener('click', function () {
      openViewer(asset, false);
    });
    card.appendChild(open);

    var actions = el('div', 'card-actions');
    var cartButton = el('button', 'cart-toggle', cartLabel(group));
    cartButton.type = 'button';
    cartButton.dataset.inCart = groupInCart(group) ? 'true' : 'false';
    cartButton.setAttribute('aria-label', cartLabel(group) + ': ' + asset.title +
      (group.variantCount > 1 ? ' and its variants' : ''));
    cartButton.addEventListener('click', function () {
      toggleGroupCart(group);
    });
    actions.appendChild(cartButton);
    card.appendChild(actions);

    return card;
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

  function familyAssets(asset) {
    if (!asset || !asset.family) return asset ? [asset] : [];
    var family = ASSETS.filter(function (other) {
      return other.family && other.family === asset.family;
    });
    if (!family.length) return [asset];
    family.sort(compareTitles);
    return family;
  }

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
      var group = current[i];
      list.push(group.rep);
      for (var j = 0; j < group.members.length; j += 1) {
        if (group.members[j].asset.id === asset.id) index = i;
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
    if (!fromHash) syncHash();
  }

  function fillViewer() {
    var asset = viewerAsset;
    if (!asset) return;

    vTitle.textContent = asset.title;
    vBadge.textContent = '';
    vBadge.appendChild(el('span', 'badge-kind', asset.kind));
    if (asset.role) {
      vBadge.appendChild(el('span', 'badge-sep', ' / '));
      vBadge.appendChild(el('span', 'badge-role', asset.role));
    }
    if (asset.scope === 'community') {
      vBadge.appendChild(el('span', 'badge-sep', ' / '));
      vBadge.appendChild(el('span', 'community-badge', 'Community'));
    }
    viewerFamily = familyAssets(asset);
    if (!viewerFamily.length) viewerFamily = [asset];
    if (viewerFamily.length > 1) {
      vBadge.appendChild(el('span', 'badge-sep', ' / '));
      vBadge.appendChild(el('span', 'variant-badge inline', viewerFamily.length + ' variants'));
    }
    vSummary.textContent = asset.summary || 'No summary.';

    fillMeta(asset);
    fillTags(asset);
    fillFiles(asset);
    fillVariants(asset);
    fillSimilar(asset);

    vDownload.hidden = !asset.file;
    if (asset.file) {
      vDownload.href = asset.file;
      vDownload.setAttribute('download', '');
    } else {
      vDownload.removeAttribute('href');
    }
    vMd.href = asset.md;
    vJson.href = asset.json;

    var cartMembers = assetCartMembers(asset);
    var inCart = cartMembers.every(function (member) { return Boolean(cartMap[member.id]); });
    vCart.textContent = inCart
      ? (cartMembers.length > 1 ? 'In cart (' + cartMembers.length + ')' : 'In cart')
      : (cartMembers.length > 1 ? 'Add ' + cartMembers.length + ' variants to cart' : 'Add to cart');
    vCart.dataset.inCart = inCart ? 'true' : 'false';
    vCart.onclick = function () { toggleAssetCart(asset); };

    vPos.textContent = (viewerIndex + 1) + ' / ' + viewerList.length;
    vPrev.disabled = viewerList.length < 2;
    vNext.disabled = viewerList.length < 2;

    renderMedia(asset);
  }

  function fillVariants(asset) {
    clear(vVariantStrip);
    vVariants.hidden = viewerFamily.length < 2;
    if (viewerFamily.length < 2) return;

    viewerFamily.forEach(function (member) {
      var button = el('button', 'variant-btn', member.title);
      button.type = 'button';
      button.setAttribute('aria-pressed', member.id === asset.id ? 'true' : 'false');
      button.addEventListener('click', function () {
        selectVariant(member);
      });
      vVariantStrip.appendChild(button);
    });
  }

  function selectVariant(member) {
    if (!member) return;
    viewerAsset = member;
    fillViewer();
    syncHash();
  }

  function assetVectors(asset) {
    if (semantic.status !== 'ready') return null;
    var entry = semantic.assets[asset.id];
    if (!entry) return null;
    var audio = asset.kind === 'audio';
    var bin = audio ? semantic.clap : semantic.clip;
    if (!bin) return null;
    var vector = vectorAt(bin, audio ? entry.clapAudio : entry.clipImage);
    return vector ? [vector] : null;
  }

  function embeddingSimilarity(a, b) {
    var audioA = a.kind === 'audio';
    var audioB = b.kind === 'audio';
    if (audioA !== audioB) return 0;
    var left = assetVectors(a);
    var right = assetVectors(b);
    if (!left || !right) return 0;
    var best = 0;
    left.forEach(function (one) {
      right.forEach(function (two) {
        best = Math.max(best, cosine(one, two));
      });
    });
    return best;
  }

  function tagSimilarity(a, b) {
    if (!a.tags.length || !b.tags.length) return 0;
    var set = Object.create(null);
    a.tags.forEach(function (tag) { set[tag] = true; });
    var shared = 0;
    b.tags.forEach(function (tag) { if (set[tag]) shared += 1; });
    if (!shared) return 0;
    var union = a.tags.length + b.tags.length - shared;
    return union ? shared / union : 0;
  }

  function findSimilar(asset, limit) {
    var scored = [];
    ASSETS.forEach(function (other) {
      if (other.id === asset.id) return;
      var score = embeddingSimilarity(asset, other);
      if (score <= 0) score = tagSimilarity(asset, other);
      if (score > 0.15) scored.push({ asset: other, score: score });
    });
    scored.sort(function (a, b) {
      return b.score - a.score || compareTitles(a.asset, b.asset);
    });
    return scored.slice(0, limit);
  }

  function fillSimilar(asset) {
    clear(vSimilar);
    var similar = findSimilar(asset, 4);
    vSimilarHeading.hidden = similar.length === 0;
    if (!similar.length) return;

    similar.forEach(function (item) {
      var card = el('button', 'similar-card');
      card.type = 'button';
      card.setAttribute('aria-label', 'Open ' + item.asset.title);
      var thumb = el('span', 'similar-thumb');
      if (item.asset.preview) {
        var image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = item.asset.preview;
        thumb.appendChild(image);
      } else {
        thumb.appendChild(el('span', 'muted', 'No preview'));
      }
      card.appendChild(thumb);
      card.appendChild(el('span', 'similar-title', item.asset.title));
      card.addEventListener('click', function () {
        openViewer(item.asset, false);
      });
      vSimilar.appendChild(card);
    });
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

    if (asset.contributor) {
      addMetaLink('Contributor', '@' + asset.contributor, asset.contributorUrl);
    }
    if (asset.license) addMeta('License', asset.license);
    if (asset.sha256) addMeta('SHA-256', asset.sha256, true);

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

  function addMetaLink(label, value, href) {
    if (!href || (href.indexOf('https://') !== 0 && href.indexOf('http://') !== 0)) {
      addMeta(label, value);
      return;
    }

    var dt = el('dt', null, label);
    var dd = document.createElement('dd');
    var link = el('a', null, value);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    dd.appendChild(link);
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
    var flipOn = !!(asset.technical && asset.technical.flipY === true);
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

    // The dialog reflows after it opens, so the first measurement can be the
    // card width instead of the stage width. Re-apply on the next frame and
    // whenever the stage actually changes size.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { apply(); }).observe(stage);
    }
    requestAnimationFrame(function () { apply(); });

    syncOutputs();
    apply();
    tileApply = apply;
  }

  // ---- navigation ---------------------------------------------------------

  function syncHash() {
    var parts = [];
    if (state.query) parts.push('q=' + encodeURIComponent(state.query));
    if (cartOrder.length) {
      parts.push('cart=' + cartOrder.map(function (id) {
        return encodeURIComponent(id);
      }).join(','));
    }
    if (dialog.open && viewerAsset) {
      parts.push('asset=' + encodeURIComponent(viewerAsset.id));
    }

    var target = parts.length ? '#' + parts.join('&') : '';
    if (location.hash === target) return;

    try {
      if (target) {
        history.replaceState(null, '', target);
      } else {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (error) {
      if (target) location.hash = target.slice(1);
      else location.hash = '';
    }
  }

  function parseHash() {
    var raw = location.hash.replace(/^#/, '');
    var result = { q: '', cart: [], asset: '' };
    if (!raw) return result;

    raw.split('&').forEach(function (pair) {
      if (!pair) return;
      var at = pair.indexOf('=');
      var key = at === -1 ? pair : pair.slice(0, at);
      var value = at === -1 ? '' : pair.slice(at + 1);
      try {
        value = decodeURIComponent(value.replace(/\\+/g, ' '));
      } catch (error) {
        /* keep the raw value */
      }

      if (key === 'q') {
        result.q = value;
      } else if (key === 'cart') {
        result.cart = value.split(',').filter(Boolean);
      } else if (key === 'asset') {
        result.asset = value;
      }
    });

    if (!result.asset && raw.indexOf('=') === -1) result.asset = raw;
    return result;
  }

  function applyHash(initial) {
    var parsed = parseHash();
    var queryChanged = parsed.q !== state.query;
    var cartChanged = parsed.cart.length !== cartOrder.length ||
      parsed.cart.some(function (id, index) { return cartOrder[index] !== id; });

    if (queryChanged) {
      state.query = parsed.q;
      searchInput.value = parsed.q;
      if (parsed.q) ensureSemantic();
    }

    if (cartChanged) setCartOrder(parsed.cart, true);

    if (initial || queryChanged || cartChanged) {
      render();
    } else {
      updateCartPanel();
    }

    if (parsed.asset) {
      var asset = byId[parsed.asset];
      if (asset) openViewer(asset, true);
      else if (dialog.open) closeViewer(false);
    } else if (dialog.open) {
      closeViewer(false);
    }
  }

  function handleHash() {
    applyHash(false);
  }

  function stepViewer(delta) {
    if (viewerList.length < 2) return;
    viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
    viewerAsset = viewerList[viewerIndex];
    fillViewer();
    syncHash();
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
    if (updateHash !== false) syncHash();
  }

  function setSemanticNote(text, ready) {
    indexNote.hidden = !text;
    indexNote.textContent = text || '';
    indexNote.classList.toggle('ready', Boolean(ready));
  }

  function updateIndexNote() {
    if (!state.semantic) {
      setSemanticNote('Semantic is off; ranking by keyword only.', false);
      return;
    }
    if (semantic.status === 'loading') {
      setSemanticNote('Loading semantic index...', false);
    } else if (semantic.status === 'unavailable') {
      setSemanticNote('Semantic index unavailable offline.', false);
      indexNote.title = semantic.message || '';
    } else if (semantic.status === 'ready') {
      setSemanticNote('Semantic index loaded.', true);
      indexNote.title = '';
    } else {
      setSemanticNote('', false);
    }
  }

  function normalizeEmbeddingEntry(entry) {
    function index(value) {
      var number = Number(value);
      if (value === null || value === undefined || !isFinite(number) || number < 0) return null;
      return Math.floor(number);
    }
    return {
      clipImage: index(entry && entry.clipImage),
      clipText: index(entry && entry.clipText),
      clapAudio: index(entry && entry.clapAudio),
      clapText: index(entry && entry.clapText)
    };
  }

  function mergeSemanticEntries(entries) {
    entries.forEach(function (entry) {
      if (!entry || !entry.id) return;
      var asset = byId[entry.id];
      if (!asset) return;
      if (Array.isArray(entry.keywords) && entry.keywords.length) {
        asset.keywords = entry.keywords.map(String).filter(Boolean);
      }
      if (!asset.prompt && typeof entry.prompt === 'string') asset.prompt = entry.prompt;
      if (!asset.family && typeof entry.family === 'string') asset.family = entry.family;
      if (!asset.sha256 && typeof entry.sha256 === 'string') asset.sha256 = entry.sha256;
      if (!asset.license && typeof entry.license === 'string') asset.license = entry.license;
      if (!asset.contributor && typeof entry.contributor === 'string') {
        asset.contributor = entry.contributor;
        asset.contributorUrl = asset.contributor
          ? 'https://github.com/' + encodeURIComponent(asset.contributor)
          : '';
      }
      prepareAsset(asset);
    });
  }

  function binUrl(base, file) {
    var value = String(file || '').trim();
    if (!value) return '';
    if (/^https?:\\/\\//i.test(value) || value.charAt(0) === '/') return value;
    value = value.replace(/^\\.?\\//, '').replace(/^catalog\\//, '');
    return new URL(value, base).href;
  }

  function toVectorArray(buffer) {
    var dim = semantic.dim;
    var bytesPerVector = dim * 4;
    var count = Math.floor(buffer.byteLength / bytesPerVector);
    var view = new DataView(buffer);
    var out = new Float32Array(count * dim);
    for (var i = 0; i < count * dim; i += 1) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }

  function fetchSemanticJson(base, name) {
    return fetch(new URL(name, base).href, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error(name + ' returned HTTP ' + response.status);
      return response.json();
    });
  }

  function fetchSemanticBin(base, file) {
    var url = binUrl(base, file);
    if (!url) return Promise.reject(new Error('missing embedding file name'));
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status);
      return response.arrayBuffer();
    }).then(toVectorArray);
  }

  function ensureSemantic() {
    if (!state.semantic) {
      updateIndexNote();
      return Promise.resolve();
    }
    if (semantic.status === 'ready' || semantic.status === 'unavailable') {
      updateIndexNote();
      return Promise.resolve();
    }
    if (semantic.promise) return semantic.promise;

    if (location.protocol === 'file:') {
      semantic.status = 'unavailable';
      semantic.message = 'file:// cannot fetch catalog/embeddings. Use npm run serve.';
      updateIndexNote();
      return Promise.resolve();
    }

    semantic.status = 'loading';
    updateIndexNote();

    var base = new URL('../catalog/', location.href);
    semantic.promise = Promise.all([
      fetchSemanticJson(base, 'search-index.json'),
      fetchSemanticJson(base, 'concepts.json'),
      fetchSemanticJson(base, 'embeddings.json')
    ]).then(function (values) {
      var indexData = values[0];
      var conceptsData = values[1];
      var manifest = values[2] || {};
      var indexEntries = Array.isArray(indexData)
        ? indexData
        : indexData && Array.isArray(indexData.assets)
          ? indexData.assets
          : [];
      var concepts = conceptsData && Array.isArray(conceptsData.concepts)
        ? conceptsData.concepts
        : [];
      var dim = Number(manifest.dim);

      semantic.dim = isFinite(dim) && dim > 0 ? Math.floor(dim) : 512;
      semantic.concepts = concepts.filter(function (concept) {
        return concept && typeof concept.id === 'string' && concept.id;
      });
      semantic.clipModel = manifest.clip && manifest.clip.model ? String(manifest.clip.model) : '';
      semantic.clapModel = manifest.clap && manifest.clap.model ? String(manifest.clap.model) : '';

      mergeSemanticEntries(indexEntries);

      var indexById = Object.create(null);
      indexEntries.forEach(function (entry) {
        if (entry && entry.id) indexById[entry.id] = entry;
      });

      var manifestAssets = manifest.assets && typeof manifest.assets === 'object'
        ? manifest.assets
        : {};
      Object.keys(byId).forEach(function (id) {
        var entry = manifestAssets[id] || (indexById[id] && indexById[id].embeddings) || null;
        if (entry) semantic.assets[id] = normalizeEmbeddingEntry(entry);
      });

      var manifestConcepts = manifest.concepts && typeof manifest.concepts === 'object'
        ? manifest.concepts
        : {};
      semantic.concepts.forEach(function (concept) {
        var entry = manifestConcepts[concept.id];
        if (!entry) return;
        semantic.conceptEmbeddings[concept.id] = {
          clip: entry.clip === null || entry.clip === undefined ? null : Number(entry.clip),
          clap: entry.clap === null || entry.clap === undefined ? null : Number(entry.clap)
        };
      });

      var jobs = [];
      var clipFile = manifest.clip && manifest.clip.file;
      var clapFile = manifest.clap && manifest.clap.file;

      if (clipFile) {
        jobs.push(fetchSemanticBin(base, clipFile).then(function (vectors) {
          semantic.clip = vectors;
        }).catch(function () {
          semantic.clip = null;
        }));
      }
      if (clapFile) {
        jobs.push(fetchSemanticBin(base, clapFile).then(function (vectors) {
          semantic.clap = vectors;
        }).catch(function () {
          semantic.clap = null;
        }));
      }

      return Promise.all(jobs).then(function () {
        if (!semantic.clip && !semantic.clap) {
          throw new Error('embedding bins could not be loaded');
        }
        semantic.status = 'ready';
        semantic.message = '';
        updateIndexNote();
        render();
      });
    }).catch(function (error) {
      semantic.status = 'unavailable';
      semantic.message = error && error.message ? error.message : String(error);
      semantic.clip = null;
      semantic.clap = null;
      updateIndexNote();
      render();
    });

    return semantic.promise;
  }

  function restrictedLicense(license) {
    var label = String(license || '').trim().toLowerCase();
    return !label || label === 'unknown' || label === 'licenseref-all-rights-reserved';
  }

  function licenseLabel(asset) {
    var label = String(asset.license || '').trim();
    return label || 'unknown';
  }

  function cartAssets() {
    return cartOrder.map(function (id) { return byId[id]; }).filter(Boolean);
  }

  function groupInCart(group) {
    return group.members.every(function (member) { return Boolean(cartMap[member.asset.id]); });
  }

  function cartLabel(group) {
    var count = group.variantCount;
    var inCart = groupInCart(group);
    if (inCart) return count > 1 ? 'In cart (' + count + ')' : 'In cart';
    return count > 1 ? 'Add ' + count + ' variants' : 'Add to cart';
  }

  function assetCartMembers(asset) {
    var family = familyAssets(asset);
    return family.length > 1 ? family : [asset];
  }

  function setCartOrder(ids, silent) {
    cartOrder = [];
    cartMap = Object.create(null);

    ids.forEach(function (id) {
      if (!byId[id] || cartMap[id]) return;
      cartMap[id] = true;
      cartOrder.push(id);
    });

    if (!silent) syncHash();
    updateCartPanel();
  }

  function addCartMembers(members) {
    var changed = false;
    members.forEach(function (asset) {
      if (!asset || cartMap[asset.id]) return;
      cartMap[asset.id] = true;
      cartOrder.push(asset.id);
      changed = true;
    });
    return changed;
  }

  function removeCartMembers(members) {
    var changed = false;
    members.forEach(function (asset) {
      if (!asset || !cartMap[asset.id]) return;
      delete cartMap[asset.id];
      changed = true;
    });
    if (!changed) return false;
    cartOrder = cartOrder.filter(function (id) { return Boolean(cartMap[id]); });
    return true;
  }

  function toggleGroupCart(group) {
    var members = group.members.map(function (member) { return member.asset; });
    if (groupInCart(group)) removeCartMembers(members);
    else addCartMembers(members);
    syncHash();
    render();
  }

  function toggleAssetCart(asset) {
    var members = assetCartMembers(asset);
    var all = members.every(function (member) { return Boolean(cartMap[member.id]); });
    if (all) removeCartMembers(members);
    else addCartMembers(members);
    syncHash();
    render();
    if (dialog.open) fillViewer();
  }

  function removeCartId(id) {
    var asset = byId[id];
    if (asset) removeCartMembers([asset]);
    syncHash();
    render();
    if (dialog.open) fillViewer();
  }

  function setCartOpen(open) {
    cartBody.hidden = !open;
    cartHead.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function updateCartPanel() {
    var assets = cartAssets();
    var bytes = assets.reduce(function (sum, asset) {
      return sum + (Number(asset.bytes) || 0);
    }, 0);
    var licenses = Object.create(null);
    var restricted = [];

    assets.forEach(function (asset) {
      var label = licenseLabel(asset);
      licenses[label] = (licenses[label] || 0) + 1;
      if (restrictedLicense(asset.license)) restricted.push(asset);
    });

    if (restricted.length && !cartHadRestricted) checkAck = false;
    if (!restricted.length) checkAck = false;
    cartHadRestricted = restricted.length > 0;
    checkAckBox.checked = checkAck;
    cartAck.checked = checkAck;

    cartCount.textContent = assets.length;
    cartBytes.textContent = formatBytes(bytes);
    clear(cartLicenses);
    clear(cartItems);

    Object.keys(licenses).sort(function (a, b) {
      return licenses[b] - licenses[a] || a.localeCompare(b);
    }).forEach(function (label) {
      var row = el('div', 'cart-license-row' + (restrictedLicense(label) ? ' restricted' : ''));
      row.appendChild(el('span', null, label));
      row.appendChild(el('span', 'n', licenses[label]));
      cartLicenses.appendChild(row);
    });

    cartEmpty.hidden = assets.length > 0;

    assets.forEach(function (asset) {
      var item = document.createElement('li');
      item.className = 'cart-item';
      var title = el('span', 'cart-item-title', asset.title);
      title.title = asset.title;
      item.appendChild(title);
      item.appendChild(el('span', 'cart-item-id', asset.id));
      var remove = el('button', 'cart-remove', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + asset.title + ' from cart');
      remove.addEventListener('click', function () { removeCartId(asset.id); });
      item.appendChild(remove);
      cartItems.appendChild(item);
    });

    var needsAck = restricted.length > 0;
    cartAckRow.hidden = !needsAck;
    var checkFailed = checkResults && checkResults.failed > 0;
    var blocked = (needsAck && !checkAck) || checkFailed || assets.length === 0;
    cartDownload.disabled = blocked;
    checkDownload.disabled = blocked;
    cartCheck.disabled = assets.length === 0;

    if (!assets.length) {
      setCartOpen(false);
      return;
    }

    if (cartBody.hidden) setCartOpen(true);

    if (needsAck && !checkAck) {
      cartDownload.title = 'Check output and acknowledge the restricted licence first.';
    } else if (checkFailed) {
      cartDownload.title = 'Fix the failed checks before downloading.';
    } else {
      cartDownload.title = '';
    }

    if (needsAck) {
      var note = document.getElementById('cart-note');
      if (note) {
        note.textContent = checkAck
          ? 'Restricted licence acknowledged. The pack report records it.'
          : 'One or more assets are restricted or unknown. Check output and acknowledge before download.';
      }
    }
  }

  function addAllResults() {
    var changed = false;
    current.forEach(function (group) {
      var members = group.members.map(function (member) { return member.asset; });
      if (addCartMembers(members)) changed = true;
    });
    if (!changed) return;
    syncHash();
    render();
  }

  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256Fallback(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var length = bytes.length;
    var padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
    padded.set(bytes);
    padded[length] = 0x80;

    var bitLength = length * 8;
    var high = Math.floor(bitLength / 4294967296);
    var low = bitLength >>> 0;
    var end = padded.length;
    padded[end - 8] = (high >>> 24) & 255;
    padded[end - 7] = (high >>> 16) & 255;
    padded[end - 6] = (high >>> 8) & 255;
    padded[end - 5] = high & 255;
    padded[end - 4] = (low >>> 24) & 255;
    padded[end - 3] = (low >>> 16) & 255;
    padded[end - 2] = (low >>> 8) & 255;
    padded[end - 1] = low & 255;

    var w = new Int32Array(64);

    for (var offset = 0; offset < padded.length; offset += 64) {
      var i;
      for (i = 0; i < 16; i += 1) {
        var at = offset + i * 4;
        w[i] = (padded[at] << 24) | (padded[at + 1] << 16) |
          (padded[at + 2] << 8) | padded[at + 3];
      }
      for (i = 16; i < 64; i += 1) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = H[0];
      var b = H[1];
      var c = H[2];
      var d = H[3];
      var e = H[4];
      var f = H[5];
      var g = H[6];
      var h = H[7];

      for (i = 0; i < 64; i += 1) {
        var sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + sum1 + ch + SHA_K[i] + w[i]) | 0;
        var sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (sum0 + maj) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }

      H[0] = (H[0] + a) | 0;
      H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;
      H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0;
      H[7] = (H[7] + h) | 0;
    }

    return H.map(function (word) {
      return ('00000000' + (word >>> 0).toString(16)).slice(-8);
    }).join('');
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  function sha256Hex(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      return window.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
        return bytesToHex(new Uint8Array(digest));
      }).catch(function () {
        return sha256Fallback(bytes);
      });
    }
    try {
      return Promise.resolve(sha256Fallback(bytes));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function fetchBytes(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.arrayBuffer();
    }).then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  function fetchWithMeta(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.arrayBuffer().then(function (buffer) {
        return {
          bytes: new Uint8Array(buffer),
          type: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
          status: response.status
        };
      });
    });
  }

  function mimeAcceptable(expected, actual) {
    var want = String(expected || '').trim().toLowerCase();
    var got = String(actual || '').trim().toLowerCase();
    if (!want) return false;
    if (!got) return true;
    if (got === 'application/octet-stream') return true;
    return want === got;
  }

  function makeCheck(key, ok, detail, warn) {
    return { key: key, ok: Boolean(ok), detail: detail || '', warn: Boolean(warn) };
  }

  function openCheckDialog() {
    if (!checkDialog.open) {
      if (typeof checkDialog.showModal === 'function') checkDialog.showModal();
      else checkDialog.setAttribute('open', '');
    }
  }

  function runChecks() {
    if (checkBusy) return Promise.resolve();
    var assets = cartAssets();
    if (!assets.length) return Promise.resolve();

    checkBusy = true;
    checkResults = null;
    checkRun.disabled = true;
    checkDownload.disabled = true;
    checkSummary.textContent = '';
    clear(checkList);
    checkAckRow.hidden = true;
    checkRestrictedNote.hidden = true;
    checkStatus.textContent = 'Checking output...';
    checkTotal.textContent = '';
    openCheckDialog();

    var items = [];

    function nextAsset(index) {
      if (index >= assets.length) return Promise.resolve();
      var asset = assets[index];
      checkStatus.textContent = 'Checking ' + (index + 1) + ' of ' + assets.length + ': ' + asset.title;

      return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
        var checks = [];
        var fileResult = null;
        var fileError = '';

        if (!asset.file) {
          fileError = 'No file path in the catalog.';
        } else {
          return fetchWithMeta(asset.file).then(function (result) {
            fileResult = result;
          }).catch(function (error) {
            fileError = error && error.message ? error.message : String(error);
          }).then(function () {
            return finishAsset(asset, checks, fileResult, fileError);
          }).then(function () {
            return nextAsset(index + 1);
          });
        }

        return finishAsset(asset, checks, null, fileError).then(function () {
          return nextAsset(index + 1);
        });
      });
    }

    function finishAsset(asset, checks, fileResult, fileError) {
      var fileOk = Boolean(fileResult);
      checks.push(makeCheck('File', fileOk,
        fileOk ? ('HTTP ' + fileResult.status + ' · ' + formatBytes(fileResult.bytes.length))
          : (fileError || 'File could not be fetched.')));

      var bytesOk = Boolean(fileResult) &&
        (!asset.bytes || fileResult.bytes.length === Number(asset.bytes));
      checks.push(makeCheck('Bytes', bytesOk,
        fileResult
          ? (formatBytes(fileResult.bytes.length) +
            (asset.bytes && fileResult.bytes.length !== Number(asset.bytes)
              ? ' · catalog says ' + formatBytes(asset.bytes)
              : ''))
          : 'Not available.'));

      var mimeOk = Boolean(asset.mime) && Boolean(fileResult) &&
        mimeAcceptable(asset.mime, fileResult.type);
      checks.push(makeCheck('MIME', mimeOk,
        fileResult
          ? (asset.mime || 'missing') + ' · served as ' + (fileResult.type || 'unknown')
          : 'File not fetched.'));

      var hashFormat = /^[0-9a-f]{64}$/.test(String(asset.sha256 || '').toLowerCase());
      var hashOk = hashFormat && Boolean(fileResult);
      var hashDetail = hashFormat ? 'Recorded hash: ' + asset.sha256.slice(0, 16) + '...' : 'Missing or malformed SHA-256.';

      var previewCheck = fetchWithMeta(asset.preview).then(function (preview) {
        var isImage = !preview.type || preview.type.indexOf('image/') === 0;
        return makeCheck('Preview', isImage,
          isImage ? formatBytes(preview.bytes.length) + ' · ' + (preview.type || 'image') : 'Unexpected type ' + preview.type,
          false);
      }).catch(function (error) {
        return makeCheck('Preview', false, error && error.message ? error.message : 'Preview not available.');
      });

      var hashCheck = fileResult
        ? sha256Hex(fileResult.bytes).then(function (actual) {
          if (hashFormat && actual === asset.sha256.toLowerCase()) {
            return makeCheck('SHA-256', true, 'Verified ' + actual.slice(0, 16) + '...');
          }
          hashOk = false;
          return makeCheck('SHA-256', false,
            hashFormat ? 'Mismatch: got ' + actual.slice(0, 16) + '...' : hashDetail);
        })
        : Promise.resolve(makeCheck('SHA-256', false, hashDetail));

      var licenseDetail = asset.license
        ? asset.license + (restrictedLicense(asset.license) ? ' · restricted, acknowledgement required' : '')
        : 'No licence recorded; acknowledgement required.';

      return Promise.all([hashCheck, previewCheck]).then(function (results) {
        checks.push(results[0]);
        checks.push(results[1]);
        checks.push(makeCheck('Licence', true, licenseDetail, restrictedLicense(asset.license)));
        items.push({
          asset: asset,
          checks: checks,
          restricted: restrictedLicense(asset.license)
        });
      });
    }

    return nextAsset(0).then(function () {
      var failed = 0;
      var passed = 0;
      var totalChecks = 0;
      items.forEach(function (item) {
        item.checks.forEach(function (check) {
          totalChecks += 1;
          if (check.ok) passed += 1;
          else failed += 1;
        });
      });
      var restrictedItems = items.filter(function (item) { return item.restricted; });
      var bytes = assets.reduce(function (sum, asset) {
        return sum + (Number(asset.bytes) || 0);
      }, 0);
      checkResults = {
        items: items,
        passed: passed,
        failed: failed,
        totalChecks: totalChecks,
        restricted: restrictedItems,
        bytes: bytes,
        acknowledged: checkAck
      };
      renderCheckResults();
      checkBusy = false;
      checkRun.disabled = false;
      updateCartPanel();
    }).catch(function (error) {
      checkBusy = false;
      checkRun.disabled = false;
      checkStatus.textContent = 'Check failed: ' + (error && error.message ? error.message : String(error));
      checkDownload.disabled = true;
    });
  }

  function renderCheckResults() {
    clear(checkSummary);
    clear(checkList);
    if (!checkResults) return;

    function addStat(label, value) {
      var stat = el('span', 'check-stat');
      stat.appendChild(el('strong', null, value));
      stat.appendChild(document.createTextNode(' ' + label));
      checkSummary.appendChild(stat);
    }

    addStat('files', String(checkResults.items.length));
    addStat('bytes', formatBytes(checkResults.bytes));
    addStat('passed', String(checkResults.passed));
    addStat('failed', String(checkResults.failed));
    if (checkResults.restricted.length) {
      addStat('restricted licences', String(checkResults.restricted.length));
    }

    checkResults.items.forEach(function (item) {
      var box = el('div', 'check-item' + (item.restricted ? ' restricted' : ''));
      var head = el('div', 'check-item-head');
      head.appendChild(el('span', 'check-item-title', item.asset.title));
      head.appendChild(el('span', 'check-item-id', item.asset.id));
      box.appendChild(head);

      var grid = el('div', 'check-grid');
      item.checks.forEach(function (check) {
        var status = check.ok ? (check.warn ? 'RESTRICTED' : 'PASS') : 'FAIL';
        var pill = el('div', 'check-pill ' + (check.ok ? (check.warn ? 'check-warn' : 'check-pass') : 'check-fail'));
        pill.appendChild(el('span', 'k', check.key));
        pill.appendChild(el('span', 'v', status));
        if (check.detail) pill.appendChild(el('span', 'check-detail', check.detail));
        grid.appendChild(pill);
      });
      box.appendChild(grid);
      checkList.appendChild(box);
    });

    var restricted = checkResults.restricted;
    checkAckRow.hidden = restricted.length === 0;
    checkRestrictedNote.hidden = restricted.length === 0;
    checkAckBox.checked = checkAck;

    if (restricted.length) {
      checkRestrictedNote.textContent = 'Restricted or unknown licences: ' +
        restricted.map(function (item) { return item.asset.id; }).join(', ') +
        '. Download stays blocked until you acknowledge responsibility above.';
    }

    if (checkResults.failed > 0) {
      checkStatus.textContent = checkResults.failed + ' check' +
        (checkResults.failed === 1 ? '' : 's') + ' failed. Fix these before downloading.';
    } else if (restricted.length && !checkAck) {
      checkStatus.textContent = 'All checks passed. Acknowledge the restricted licence to download.';
    } else if (restricted.length) {
      checkStatus.textContent = 'All checks passed. Restricted licence acknowledged; the pack report records it.';
    } else {
      checkStatus.textContent = 'All checks passed. Every file hash was verified.';
    }

    checkTotal.textContent = checkResults.items.length + ' file' +
      (checkResults.items.length === 1 ? '' : 's') + ' · ' + formatBytes(checkResults.bytes) +
      ' · ' + (checkResults.failed ? checkResults.failed + ' failed' : 'all hashes verified');

    var blocked = checkResults.failed > 0 || (restricted.length > 0 && !checkAck);
    checkDownload.disabled = blocked;
    cartDownload.disabled = blocked || cartOrder.length === 0;
    checkResults.acknowledged = checkAck;
  }

  function syncAck() {
    cartAck.checked = checkAck;
    checkAckBox.checked = checkAck;
    if (checkResults) {
      checkResults.acknowledged = checkAck;
      renderCheckResults();
    }
    updateCartPanel();
  }

  var CRC_TABLE = null;
  var packObjectUrl = '';

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n += 1) {
        var c = n;
        for (var k = 0; k < 8; k += 1) {
          c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZip(entries) {
    var encoder = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) |
      (Math.floor(now.getSeconds() / 2) & 31);
    var dosDate = (((now.getFullYear() - 1980) & 127) << 9) |
      (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    entries.forEach(function (entry) {
      var nameBytes = encoder.encode(entry.name);
      var data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      localParts.push(local);
      localParts.push(data);

      var central = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    });

    var centralSize = centralParts.reduce(function (sum, part) {
      return sum + part.length;
    }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + centralSize + eocd.length;
    var out = new Uint8Array(total);
    var at = 0;
    localParts.concat(centralParts).forEach(function (part) {
      out.set(part, at);
      at += part.length;
    });
    out.set(eocd, at);
    return out;
  }

  function utf8(value) {
    return new TextEncoder().encode(String(value));
  }

  function slugify(value) {
    var slug = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return slug || 'all-assets';
  }

  function fileNameFromUrl(url) {
    var clean = String(url || '').split('?')[0].split('#')[0];
    var part = clean.slice(clean.lastIndexOf('/') + 1);
    try {
      part = decodeURIComponent(part);
    } catch (error) {
      /* keep the encoded name */
    }
    return part || 'file';
  }

  function uniqueEntryName(used, name) {
    var candidate = name;
    var dot = candidate.lastIndexOf('.');
    var base = dot > 0 ? candidate.slice(0, dot) : candidate;
    var ext = dot > 0 ? candidate.slice(dot) : '';
    var counter = 2;
    while (used[candidate]) {
      candidate = base + '-' + counter + ext;
      counter += 1;
    }
    used[candidate] = true;
    return candidate;
  }

  function buildContactSheet(assets) {
    return new Promise(function (resolve) {
      try {
        var picks = assets.slice(0, 24);
        var columns = 4;
        var cellWidth = 300;
        var cellHeight = 200;
        var gap = 12;
        var header = 44;
        var rows = Math.max(1, Math.ceil(picks.length / columns));
        var canvas = document.createElement('canvas');
        canvas.width = columns * cellWidth + (columns + 1) * gap;
        canvas.height = header + rows * (cellHeight + 22 + gap) + gap;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        ctx.fillStyle = '#0b0e14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#e6edf3';
        ctx.font = '600 20px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Asset Library pack contact sheet', gap, 28);

        var pending = picks.length;
        var settled = false;

        function finish() {
          if (settled) return;
          settled = true;
          try {
            canvas.toBlob(function (blob) {
              if (!blob || !blob.arrayBuffer) {
                resolve(null);
                return;
              }
              blob.arrayBuffer().then(function (buffer) {
                resolve(new Uint8Array(buffer));
              }).catch(function () {
                resolve(null);
              });
            }, 'image/webp', 0.86);
          } catch (error) {
            resolve(null);
          }
        }

        function labelFor(asset, x, y) {
          ctx.fillStyle = '#9aa7b8';
          ctx.font = '12px ui-monospace, Consolas, monospace';
          var text = asset.id + '  ' + asset.title;
          if (text.length > 48) text = text.slice(0, 47) + '...';
          ctx.fillText(text, x, y + cellHeight + 16);
        }

        function drawPlaceholder(asset, x, y) {
          ctx.fillStyle = '#151b26';
          ctx.fillRect(x, y, cellWidth, cellHeight);
          ctx.fillStyle = '#5b6878';
          ctx.font = '600 13px system-ui, sans-serif';
          ctx.fillText('No preview', x + gap, y + cellHeight / 2);
          labelFor(asset, x, y);
        }

        function done() {
          pending -= 1;
          if (pending <= 0) finish();
        }

        if (!picks.length) {
          finish();
          return;
        }

        picks.forEach(function (asset, index) {
          var x = gap + (index % columns) * (cellWidth + gap);
          var y = header + Math.floor(index / columns) * (cellHeight + 22 + gap);
          ctx.fillStyle = '#151b26';
          ctx.fillRect(x, y, cellWidth, cellHeight);

          if (!asset.preview) {
            drawPlaceholder(asset, x, y);
            done();
            return;
          }

          var image = new Image();
          image.onload = function () {
            try {
              var width = image.naturalWidth || image.width || cellWidth;
              var height = image.naturalHeight || image.height || cellHeight;
              var scale = Math.min(cellWidth / width, cellHeight / height);
              var drawWidth = Math.max(1, width * scale);
              var drawHeight = Math.max(1, height * scale);
              ctx.drawImage(image, x + (cellWidth - drawWidth) / 2, y + (cellHeight - drawHeight) / 2,
                drawWidth, drawHeight);
              labelFor(asset, x, y);
            } catch (error) {
              drawPlaceholder(asset, x, y);
            }
            done();
          };
          image.onerror = function () {
            drawPlaceholder(asset, x, y);
            done();
          };
          image.src = asset.preview;
        });

        setTimeout(finish, 8000);
      } catch (error) {
        resolve(null);
      }
    });
  }

  function openPackDialog() {
    if (!packDialog.open) {
      if (typeof packDialog.showModal === 'function') packDialog.showModal();
      else packDialog.setAttribute('open', '');
    }
  }

  function setPackProgress(percent, text) {
    packBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    if (text !== undefined) packStatus.textContent = text;
  }

  function downloadPack() {
    if (packBusy) return;
    var assets = cartAssets();
    if (!assets.length) return;
    var restrictedAssets = assets.filter(function (asset) {
      return restrictedLicense(asset.license);
    });

    if (restrictedAssets.length && !checkAck) {
      openCheckDialog();
      checkStatus.textContent = 'Acknowledge the restricted licence in Check output before downloading.';
      checkDownload.disabled = true;
      return;
    }

    if (checkResults && checkResults.failed > 0) {
      openCheckDialog();
      checkStatus.textContent = 'Fix the failed checks before downloading.';
      return;
    }

    packBusy = true;
    packError.hidden = true;
    packSummary.textContent = '';
    packTotal.textContent = '';
    packSave.hidden = true;
    setPackProgress(0, 'Starting pack...');
    openPackDialog();

    var used = Object.create(null);
    var entries = [];
    var records = [];
    var notes = [];
    var fileCount = 0;
    var totalBytes = 0;
    var steps = assets.length * 2 + 3;
    var step = 0;
    var createdAt = new Date().toISOString();
    var slug = slugify(state.query);

    function progress(text) {
      step += 1;
      setPackProgress(Math.min(96, Math.round(step / steps * 100)), text);
    }

    function fail(message) {
      throw new Error(message);
    }

    var chain = Promise.resolve();
    assets.forEach(function (asset) {
      chain = chain.then(function () {
        if (!asset.file) {
          fail('Pack aborted: ' + asset.title + ' (' + asset.id + ') has no file path.');
        }
        if (!/^[0-9a-f]{64}$/.test(String(asset.sha256 || '').toLowerCase())) {
          fail('Pack aborted: ' + asset.title + ' (' + asset.id + ') has no valid SHA-256.');
        }

        progress('Fetching ' + asset.title + '...');
        return fetchBytes(asset.file).catch(function (error) {
          fail('Could not fetch ' + asset.title + ' (' + asset.id + '): ' +
            (error && error.message ? error.message : String(error)));
        }).then(function (bytes) {
          return sha256Hex(bytes).then(function (actual) {
            if (actual !== asset.sha256.toLowerCase()) {
              fail('SHA-256 mismatch for ' + asset.title + ' (' + asset.id +
                '). Expected ' + asset.sha256.slice(0, 16) + '..., got ' +
                actual.slice(0, 16) + '.... Pack aborted.');
            }
            var primaryName = uniqueEntryName(used,
              'assets/' + asset.id + '/' + (asset.fileName || fileNameFromUrl(asset.file)));
            entries.push({ name: primaryName, data: bytes });
            fileCount += 1;
            totalBytes += bytes.length;

            var previewName = '';
            if (asset.preview) {
              return fetchBytes(asset.preview).then(function (previewBytes) {
                previewName = uniqueEntryName(used,
                  'assets/' + asset.id + '/' + (asset.previewName || fileNameFromUrl(asset.preview)));
                entries.push({ name: previewName, data: previewBytes });
                fileCount += 1;
                totalBytes += previewBytes.length;
                records.push({
                  id: asset.id,
                  title: asset.title,
                  kind: asset.kind,
                  license: licenseLabel(asset),
                  contributor: asset.contributor || '',
                  sha256: asset.sha256,
                  path: primaryName
                });
              }).catch(function (error) {
                fail('Could not fetch the preview for ' + asset.title + ' (' + asset.id + '): ' +
                  (error && error.message ? error.message : String(error)));
              });
            }

            records.push({
              id: asset.id,
              title: asset.title,
              kind: asset.kind,
              license: licenseLabel(asset),
              contributor: asset.contributor || '',
              sha256: asset.sha256,
              path: primaryName
            });
          });
        });
      });
    });

    chain = chain.then(function () {
      progress('Rendering contact sheet...');
      return buildContactSheet(assets).then(function (sheet) {
        if (sheet) {
          entries.push({ name: 'contact-sheet.webp', data: sheet });
          fileCount += 1;
          totalBytes += sheet.length;
        } else {
          notes.push('contact-sheet.webp omitted: canvas rendering failed.');
        }
      });
    }).then(function () {
      progress('Writing pack metadata...');

      var totals = {
        assets: assets.length,
        files: fileCount,
        bytes: totalBytes,
        verified: true
      };
      var pack = {
        version: 1,
        name: slug,
        query: state.query,
        created: createdAt,
        assets: records,
        totals: totals,
        restrictedAcknowledged: Boolean(restrictedAssets.length && checkAck),
        contactSheet: !notes.length,
        notes: notes
      };

      var credits = [
        '# Credits',
        '',
        'Pack: ' + slug,
        'Created: ' + createdAt,
        'Query: ' + (state.query || '(none)'),
        ''
      ];
      records.forEach(function (record) {
        credits.push('## ' + record.title);
        credits.push('');
        credits.push('- ID: ' + record.id);
        credits.push('- Contributor: ' + (record.contributor ? '@' + record.contributor : 'Curated library'));
        credits.push('- Licence: ' + record.license);
        credits.push('- File: ' + record.path);
        credits.push('');
      });

      var licenseCounts = Object.create(null);
      records.forEach(function (record) {
        licenseCounts[record.license] = (licenseCounts[record.license] || 0) + 1;
      });
      var licences = [
        '# Licence summary',
        '',
        'This pack is a convenience bundle. Each asset keeps the licence recorded below;',
        'the pack itself does not grant additional rights.',
        ''
      ];
      Object.keys(licenseCounts).sort().forEach(function (label) {
        licences.push('- ' + label + ': ' + licenseCounts[label] + ' asset' +
          (licenseCounts[label] === 1 ? '' : 's'));
      });
      if (restrictedAssets.length) {
        licences.push('');
        licences.push('LicenseRef-All-Rights-Reserved assets require written permission from the');
        licences.push('rights holder before use. An unknown licence must be clarified first.');
      }
      licences.push('');
      licences.push('Per-asset mapping:');
      licences.push('');
      records.forEach(function (record) {
        licences.push('- ' + record.id + ' — ' + record.license);
      });
      licences.push('');

      var readme = [
        '# ' + slug + ' asset pack',
        '',
        'This is a static pack built in the browser from the Meesa Asset Library gallery.',
        '',
        '## Contents',
        '',
        '- assets/<id>/<file> — the primary deliverable and its preview',
        '- pack.json — machine-readable manifest, paths, sizes and SHA-256 hashes',
        '- CREDITS.md — attribution for every asset',
        '- LICENSE.txt — licence summary and per-asset mapping',
        'README.md — this file',
        (notes.length ? '- contact-sheet.webp — omitted in this pack' : '- contact-sheet.webp — preview grid (max 24)'),
        '',
        '## Use',
        '',
        'Unzip the pack and read pack.json before importing files. Verify hashes with',
        'sha256sum or any equivalent tool. Check CREDITS.md and LICENSE.txt before',
        'publishing anything that uses these assets.',
        '',
        'Generated: ' + createdAt,
        'Query: ' + (state.query || '(none)'),
        'Files: ' + fileCount + ', ' + formatBytes(totalBytes) + '.',
        ''
      ];
      if (notes.length) {
        readme.push('Notes:');
        notes.forEach(function (note) { readme.push('- ' + note); });
        readme.push('');
      }
      if (restrictedAssets.length && checkAck) {
        readme.push('The pack includes restricted or unknown licences. The downloader acknowledged');
        readme.push('responsibility in the gallery; pack.json records restrictedAcknowledged: true.');
        readme.push('');
      }

      entries.push({ name: 'pack.json', data: utf8(JSON.stringify(pack, null, 2) + '\\n') });
      entries.push({ name: 'CREDITS.md', data: utf8(credits.join('\\n')) });
      entries.push({ name: 'LICENSE.txt', data: utf8(licences.join('\\n')) });
      entries.push({ name: 'README.md', data: utf8(readme.join('\\n')) });
      return { pack: pack, totals: totals };
    }).then(function (result) {
      var zip = makeZip(entries);
      setPackProgress(100, 'Pack ready. Starting download...');
      var zipName = 'mesa-pack-' + slug + '.zip';
      var blob = new Blob([zip], { type: 'application/zip' });

      if (packObjectUrl) URL.revokeObjectURL(packObjectUrl);
      packObjectUrl = URL.createObjectURL(blob);
      packSave.href = packObjectUrl;
      packSave.download = zipName;
      packSave.hidden = false;

      var link = document.createElement('a');
      link.href = packObjectUrl;
      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      link.remove();

      packSummary.textContent = assets.length + ' asset' + (assets.length === 1 ? '' : 's') +
        ', ' + result.totals.files + ' files, ' + formatBytes(result.totals.bytes) +
        ', all recorded SHA-256 hashes verified. ZIP size ' + formatBytes(zip.length) +
        (notes.length ? ' · contact sheet omitted.' : ' · contact sheet included.');
      packTotal.textContent = zipName;
      packError.hidden = true;
    }).catch(function (error) {
      setPackProgress(0, 'Pack aborted.');
      packError.hidden = false;
      packError.textContent = error && error.message ? error.message : String(error);
      packSummary.textContent = '';
    }).then(function () {
      packBusy = false;
    });
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

    syncHash();
    render();
  }

  searchInput.addEventListener('input', function () {
    state.query = searchInput.value.trim();
    if (state.query) ensureSemantic();
    syncHash();
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
  addAllButton.addEventListener('click', addAllResults);
  vClose.addEventListener('click', function () { closeViewer(true); });
  vPrev.addEventListener('click', function () { stepViewer(-1); });
  vNext.addEventListener('click', function () { stepViewer(1); });

  semanticToggle.addEventListener('change', function () {
    state.semantic = semanticToggle.checked;
    if (state.semantic && state.query) ensureSemantic();
    updateIndexNote();
    render();
  });

  cartHead.addEventListener('click', function () {
    setCartOpen(cartBody.hidden);
  });

  cartClear.addEventListener('click', function () {
    setCartOrder([]);
    syncHash();
    render();
    if (dialog.open) fillViewer();
  });

  cartCheck.addEventListener('click', function () {
    runChecks();
  });

  cartDownload.addEventListener('click', downloadPack);

  cartAck.addEventListener('change', function () {
    checkAck = cartAck.checked;
    syncAck();
  });

  checkAckBox.addEventListener('change', function () {
    checkAck = checkAckBox.checked;
    syncAck();
  });

  checkRun.addEventListener('click', function () {
    runChecks();
  });

  checkDownload.addEventListener('click', downloadPack);

  checkClose.addEventListener('click', function () {
    if (typeof checkDialog.close === 'function') checkDialog.close();
    else checkDialog.removeAttribute('open');
  });

  packClose.addEventListener('click', function () {
    if (typeof packDialog.close === 'function') packDialog.close();
    else packDialog.removeAttribute('open');
  });

  packDone.addEventListener('click', function () {
    if (typeof packDialog.close === 'function') packDialog.close();
    else packDialog.removeAttribute('open');
  });

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
  applyHash(true);
})();
</script>
</body>
</html>
`;
}
