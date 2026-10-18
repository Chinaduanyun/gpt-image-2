const fs = require('node:fs');
const path = require('node:path');
const { decodePathPart } = require('../lib/common');
const { send, sendJson } = require('../lib/http-utils');
const { loadDataStore, getImageStoreDir } = require('../lib/store');
const { requireSession, sendAuthError } = require('../lib/auth');
const { getImageContentType } = require('../lib/image-store');
const { validThumbnailSourceName, prepareThumbnail, publishThumbnail } = require('../lib/image-thumbnails');

async function handleThumbnail(req, res, pathname) {
  const fileName = decodePathPart(pathname.slice('/api/stored-images/thumb/'.length));
  if (!validThumbnailSourceName(fileName)) { send(res, 400, 'Bad Request'); return; }
  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) { sendAuthError(res, auth); return; }
  const hasFile = (log) => [...(log.imageFiles || []), ...(log.inputFiles || [])].some((file) => file.fileName === fileName);
  const ownerLog = data.spendLogs.find(hasFile);
  if (!ownerLog || ownerLog.assetsDeletedAt) { send(res, 404, 'Not Found'); return; }
  if (!auth.user.isAdmin && ownerLog.email !== auth.email) { send(res, 403, 'Forbidden'); return; }
  try {
    const prepared = await prepareThumbnail(fileName);
    const latest = loadDataStore();
    const latestAuth = requireSession(req, latest);
    if (!latestAuth.ok) { sendAuthError(res, latestAuth); return; }
    const current = latest.spendLogs.find((log) => log.id === ownerLog.id);
    if (!current || current.assetsDeletedAt || !hasFile(current)) { send(res, 404, 'Not Found'); return; }
    if (latestAuth.email !== auth.email || (!latestAuth.user.isAdmin && current.email !== latestAuth.email)) { send(res, 403, 'Forbidden'); return; }
    // Synchronous publication and send deliberately share this authorization turn.
    publishThumbnail(prepared);
    const headers = { 'Cache-Control': 'private, no-cache, must-revalidate', ETag: prepared.etag, Vary: 'Cookie, Authorization' };
    const matches = String(req.headers['if-none-match'] || '').split(',').some((value) => value.trim().replace(/^W\//, '') === prepared.etag || value.trim() === '*');
    send(res, matches ? 304 : 200, matches ? undefined : prepared.buffer, 'image/webp', headers);
  } catch (error) {
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    send(res, status, status === 404 ? 'Not Found' : 'Thumbnail unavailable');
  }
}

async function handleStoredImage(req, res, pathname) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  if (pathname.startsWith('/api/stored-images/thumb/')) {
    await handleThumbnail(req, res, pathname);
    return;
  }

  const fileName = decodePathPart(pathname.slice('/api/stored-images/'.length));
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
    send(res, 400, 'Bad Request');
    return;
  }

  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }

  const ownerLog = data.spendLogs.find((log) => [...(log.imageFiles || []), ...(log.inputFiles || [])].some((file) => file.fileName === fileName));
  if (!ownerLog || ownerLog.assetsDeletedAt) {
    send(res, 404, 'Not Found');
    return;
  }
  if (!auth.user.isAdmin && ownerLog.email !== auth.email) {
    send(res, 403, 'Forbidden');
    return;
  }

  const filePath = path.join(getImageStoreDir(), fileName);
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(`${getImageStoreDir()}${path.sep}`)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(normalizedPath, (error, dataBuffer) => {
    // Disk I/O can finish after logout, disablement or a durable delete tombstone.
    // Re-read the authoritative store immediately before releasing any bytes.
    const latest = loadDataStore();
    const latestAuth = requireSession(req, latest);
    if (!latestAuth.ok) { sendAuthError(res, latestAuth); return; }
    const current = latest.spendLogs.find((log) => log.id === ownerLog.id);
    if (!current || current.assetsDeletedAt || ![...(current.imageFiles || []), ...(current.inputFiles || [])].some((file) => file.fileName === fileName)) {
      send(res, 404, 'Not Found'); return;
    }
    if (latestAuth.email !== auth.email || (!latestAuth.user.isAdmin && current.email !== latestAuth.email)) {
      send(res, 403, 'Forbidden'); return;
    }
    if (error) {
      send(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    send(res, 200, dataBuffer, getImageContentType(fileName), {
      'Cache-Control': 'no-store'
    });
  });
}

module.exports = {
  handleStoredImage
};
