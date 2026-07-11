const fs = require('node:fs');
const path = require('node:path');
const { decodePathPart } = require('../lib/common');
const { send, sendJson } = require('../lib/http-utils');
const { loadDataStore, getImageStoreDir } = require('../lib/store');
const { requireSession, sendAuthError } = require('../lib/auth');
const { getImageContentType } = require('../lib/image-store');

async function handleStoredImage(req, res, pathname) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
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

  const ownerLog = data.spendLogs.find((log) => Array.isArray(log.imageFiles) && log.imageFiles.some((file) => file.fileName === fileName));
  if (!ownerLog) {
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
    if (error) {
      send(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getImageContentType(fileName),
      'Cache-Control': 'private, max-age=86400'
    });
    res.end(dataBuffer);
  });
}

module.exports = {
  handleStoredImage
};
