const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { IMAGE_DOWNLOAD_LIMIT_BYTES, MIME_TYPES, REQUEST_TIMEOUT_MS } = require('./constants');
const { nowIso } = require('./common');
const { getImageStoreDir } = require('./store');
const { getProxyEnvValue, createProxyAgent } = require('./proxy-agent');

function getImageExtension(contentType, url) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('image/png')) return '.png';
  if (normalized.includes('image/jpeg') || normalized.includes('image/jpg')) return '.jpg';
  if (normalized.includes('image/webp')) return '.webp';
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
}

function getImageContentType(fileName) {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function isLocalStoredImageUrl(url) {
  return String(url || '').startsWith('/api/stored-images/');
}

function downloadExternalFile(url, redirects = 0) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('不支持的图片 URL 协议。'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const clearDeadline = () => {
      if (deadline) {
        clearTimeout(deadline);
        deadline = null;
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      try { req.destroy(); } catch { /* already torn down */ }
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(value);
    };

    const client = parsed.protocol === 'https:' ? https : http;
    const proxyEnvValue = parsed.protocol === 'https:' ? getProxyEnvValue() : '';
    const req = client.get(parsed, {
      headers: { Accept: 'image/png,image/jpeg,image/webp,*/*' },
      agent: proxyEnvValue ? createProxyAgent(proxyEnvValue) : undefined
    }, (response) => {
      if (settled) {
        response.resume();
        return;
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
        response.resume();
        // Hand off to the recursive hop, which owns its own deadline; stop reacting
        // to this hop's socket errors/timeout.
        settled = true;
        clearDeadline();
        const nextUrl = new URL(response.headers.location, parsed).toString();
        downloadExternalFile(nextUrl, redirects + 1).then(resolve, reject);
        return;
      }

      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        response.resume();
        fail(new Error(`图片下载失败：HTTP ${response.statusCode || 'unknown'}`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > IMAGE_DOWNLOAD_LIMIT_BYTES) {
          fail(new Error('图片文件过大。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => succeed({
        buffer: Buffer.concat(chunks),
        contentType: response.headers['content-type'] || 'application/octet-stream'
      }));
      // Without these, a mid-stream disconnect would leave the Promise unsettled
      // (stalling background refresh) or throw an unhandled 'error' and crash.
      response.on('error', (error) => fail(error instanceof Error ? error : new Error('图片下载连接出错。')));
      response.on('aborted', () => fail(new Error('图片下载连接中断。')));
    });

    // Overall deadline so a stalled connection cannot hang forever.
    deadline = setTimeout(() => fail(new Error('图片下载超时。')), REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    req.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error('图片下载超时。')));
    req.on('error', fail);
  });
}

function validStoredImageFile(file) {
  return Boolean(file?.fileName) && fs.existsSync(path.join(getImageStoreDir(), file.fileName));
}

function hasCompleteImageArchive(log, sourceUrls = log?.remoteImageUrls || []) {
  const remoteUrls = (sourceUrls || []).filter((url) => url && !isLocalStoredImageUrl(url));
  if (!remoteUrls.length) return true;
  const files = Array.isArray(log?.imageFiles) ? log.imageFiles.filter(validStoredImageFile) : [];
  const matched = new Set();
  return remoteUrls.every((url, index) => {
    const fileIndex = files.findIndex((file, candidateIndex) => !matched.has(candidateIndex) && (
      file.sourceIndex === index || (file.sourceIndex === undefined && file.originalUrl === url)
    ));
    if (fileIndex < 0) return false;
    matched.add(fileIndex);
    return true;
  });
}

function deleteStoredImageFiles(logOrLogs) {
  const logs = Array.isArray(logOrLogs) ? logOrLogs : [logOrLogs];
  const imageDir = getImageStoreDir();
  for (const file of logs.flatMap((log) => Array.isArray(log?.imageFiles) ? log.imageFiles : [])) {
    if (!file?.fileName || file.fileName.includes('/') || file.fileName.includes('\\') || file.fileName.startsWith('.')) continue;
    const filePath = path.normalize(path.join(imageDir, file.fileName));
    if (!filePath.startsWith(`${imageDir}${path.sep}`)) continue;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function saveImagesForLog(log, sourceUrls) {
  const remoteUrls = (sourceUrls || []).filter((url) => url && !isLocalStoredImageUrl(url));
  if (!remoteUrls.length) return log.imageUrls || [];

  fs.mkdirSync(getImageStoreDir(), { recursive: true, mode: 0o700 });
  const existingFiles = (Array.isArray(log.imageFiles) ? log.imageFiles : []).filter(validStoredImageFile);
  const usedExisting = new Set();
  const imageFiles = [];
  const outputUrls = [];
  const errors = [];

  for (let index = 0; index < remoteUrls.length; index += 1) {
    const url = remoteUrls[index];
    const existingIndex = existingFiles.findIndex((file, candidateIndex) => !usedExisting.has(candidateIndex) && (
      file.sourceIndex === index || (file.sourceIndex === undefined && file.originalUrl === url)
    ));
    if (existingIndex >= 0) {
      const existing = { ...existingFiles[existingIndex], sourceIndex: index, originalUrl: url };
      usedExisting.add(existingIndex);
      imageFiles.push(existing);
      outputUrls.push(`/api/stored-images/${encodeURIComponent(existing.fileName)}`);
      continue;
    }

    try {
      const downloaded = await downloadExternalFile(url);
      const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
      const ext = getImageExtension(downloaded.contentType, url);
      const stableStem = String(log.stableFileStem || '').replace(/[^A-Za-z0-9_-]/g, '');
      const fileName = stableStem
        ? `${stableStem}${index === 0 ? '' : `_${index}`}${ext}`
        : `${log.id}_${index}_${hash}${ext}`;
      const filePath = path.join(getImageStoreDir(), fileName);
      fs.writeFileSync(filePath, downloaded.buffer, { mode: 0o600 });
      imageFiles.push({
        fileName,
        contentType: downloaded.contentType,
        size: downloaded.buffer.length,
        originalUrl: url,
        sourceIndex: index,
        savedAt: nowIso()
      });
      outputUrls.push(`/api/stored-images/${encodeURIComponent(fileName)}`);
    } catch (error) {
      outputUrls.push(url);
      errors.push(`${url}: ${error?.message || error}`);
    }
  }

  log.remoteImageUrls = remoteUrls;
  log.imageFiles = imageFiles;
  log.imageUrls = outputUrls;
  if (errors.length) log.imageSaveErrors = errors;
  else delete log.imageSaveErrors;
  return outputUrls;
}

module.exports = {
  getImageExtension,
  getImageContentType,
  isLocalStoredImageUrl,
  hasCompleteImageArchive,
  deleteStoredImageFiles,
  downloadExternalFile,
  saveImagesForLog
};
