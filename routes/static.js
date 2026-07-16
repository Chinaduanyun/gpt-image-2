const fs = require('node:fs');
const path = require('node:path');
const { MIME_TYPES, ROOT } = require('../lib/constants');
const { send } = require('../lib/http-utils');

const STATIC_ALLOWLIST = new Set([
  '/index.html',
  '/styles.css',
  '/workspace.css',
  '/workspace-shell.js',
  '/config.example.js',
  '/app/state.js',
  '/app/dom.js',
  '/app/utils.js',
  '/app/pricing.js',
  '/app/auth.js',
  '/app/references.js',
  '/app/generation.js',
  '/app/results.js',
  '/app/history.js',
  '/app/admin.js',
  '/app/main.js'
]);

function getStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = decoded === '/' ? '/index.html' : decoded;
  if (!STATIC_ALLOWLIST.has(normalized)) return null;
  return path.join(ROOT, normalized.slice(1));
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }
  const filePath = getStaticPath(pathname);
  if (!filePath) {
    send(res, 404, 'Not Found');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    send(res, 200, req.method === 'HEAD' ? undefined : data, contentType);
  });
}

module.exports = {
  STATIC_ALLOWLIST,
  getStaticPath,
  serveStatic
};
