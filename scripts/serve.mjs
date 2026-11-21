#!/usr/bin/env node
// Minimal zero-dependency static file server for the asset library.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_PORT = 4173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

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
  const rootStat = await statSafe(root);

  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error('Root directory not found: ' + root);
  }

  const requestedPort = options.port === null ? DEFAULT_PORT : options.port;
  const server = http.createServer((request, response) => {
    handleRequest(request, response, root).catch((error) => {
      console.error('Request error: ' + error.message);

      if (!response.headersSent) {
        sendText(response, 500, 'Internal server error\n', request.method === 'HEAD');
      } else {
        response.destroy();
      }
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error('Error: port ' + requestedPort + ' is already in use.');
    } else {
      console.error('Error: ' + error.message);
    }
    process.exitCode = 1;
  });

  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : requestedPort;
    console.log('Serving ' + root + ' at http://localhost:' + port + '/');
  });
}

async function handleRequest(request, response, root) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed\n', request.method === 'HEAD', {
      Allow: 'GET, HEAD',
    });
    return;
  }

  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch (error) {
    sendText(response, 400, 'Bad request\n', request.method === 'HEAD');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    sendText(response, 400, 'Bad request\n', request.method === 'HEAD');
    return;
  }

  if (pathname.includes('\0') || pathname.includes('\\')) {
    sendText(response, 400, 'Bad request\n', request.method === 'HEAD');
    return;
  }

  if (pathname === '/') {
    const galleryStat = await statSafe(path.join(root, 'gallery'));
    if (galleryStat && galleryStat.isDirectory()) {
      response.writeHead(302, { Location: '/gallery/' });
      response.end();
      return;
    }
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    sendText(response, 403, 'Forbidden\n', request.method === 'HEAD');
    return;
  }

  let filePath = path.join(root, ...segments);
  if (!isInside(root, filePath)) {
    sendText(response, 403, 'Forbidden\n', request.method === 'HEAD');
    return;
  }

  let fileStat = await statSafe(filePath);

  if (!fileStat) {
    sendText(response, 404, 'Not found\n', request.method === 'HEAD');
    return;
  }

  if (fileStat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      const location = url.pathname + '/' + url.search;
      response.writeHead(301, { Location: location });
      response.end();
      return;
    }

    filePath = path.join(filePath, 'index.html');
    fileStat = await statSafe(filePath);

    if (!fileStat || !fileStat.isFile()) {
      sendText(response, 404, 'Not found\n', request.method === 'HEAD');
      return;
    }
  }

  if (!fileStat.isFile()) {
    sendText(response, 404, 'Not found\n', request.method === 'HEAD');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('Read error: ' + error.message);
    response.destroy();
  });
  stream.pipe(response);
}

function sendText(response, status, message, isHead, extraHeaders) {
  const body = Buffer.from(message, 'utf8');
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };

  response.writeHead(status, headers);

  if (isHead) {
    response.end();
  } else {
    response.end(body);
  }
}

function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function statSafe(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function parseArgs(argv) {
  const options = { root: null, port: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--port') {
      if (i + 1 >= argv.length) throw new Error('--port requires a number');
      options.port = parsePort(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      options.port = parsePort(arg.slice('--port='.length));
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

function parsePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid port "' + value + '" (expected 0-65535)');
  }

  return port;
}

function printUsage() {
  console.log('Usage: node scripts/serve.mjs [--port <number>] [--root <dir>]');
  console.log('');
  console.log('  --port <number>   Port to listen on (default: 4173)');
  console.log('  --root <dir>      Repository root (default: parent of scripts/)');
}
