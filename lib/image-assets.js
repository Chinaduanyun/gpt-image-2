const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { getImageStoreDir, getDataDir } = require('./store');

const MAX_BYTES = 20 * 1024 * 1024;
function capacity() {
  const stat = fs.statfsSync(getDataDir());
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  return { freeBytes, minimumFreeBytes: 256 * 1024 * 1024 };
}
function assertCapacity() {
  const info = capacity();
  if (info.freeBytes < info.minimumFreeBytes) throw new Error('磁盘可用空间不足，拒绝新任务；不会删除旧作品。');
  return info;
}
function publicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || a === 198);
}
async function downloadSafe(url, redirects = 0) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) throw new Error('图片引用只允许公共 HTTPS 地址。');
  const answers = await dns.lookup(target.hostname, { all: true });
  if (!answers.length || answers.some((answer) => !publicAddress(answer.address))) throw new Error('禁止内网或特殊地址图片引用。');
  return new Promise((resolve, reject) => {
    const request = https.get(target, { lookup: (_host, options, callback) => callback(null, options.all ? [answers[0]] : answers[0].address, 4) }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error('图片重定向过多。'));
        let nextUrl;
        try { nextUrl = new URL(response.headers.location, target).href; }
        catch (error) { reject(error); return; }
        downloadSafe(nextUrl, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error('图片下载失败。')); }
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BYTES) request.destroy(new Error('图片文件过大。')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('图片下载中断。')));
    });
    const timer = setTimeout(() => request.destroy(new Error('图片下载超时。')), 60000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
class InvalidImageError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_IMAGE'; }
}
async function decodeImage(buffer) {
  try {
    if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('图片字节数无效。');
    const image = sharp(buffer, { limitInputPixels: 40 * 1024 * 1024, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.pages > 1) throw new Error('图片必须是静态 PNG/JPEG/WebP。');
    await image.stats();
    return { width: metadata.width, height: metadata.height, format: metadata.format, contentType: `image/${metadata.format}` };
  } catch (error) { throw new InvalidImageError(error.message || '图片无法完整解码。'); }
}
async function readSource(source) {
  if (Buffer.isBuffer(source)) return source;
  if (String(source).startsWith('data:')) {
    const match = source.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match || match[1].length > MAX_BYTES * 1.4) throw new Error('图片编码无效。');
    return Buffer.from(match[1], 'base64');
  }
  return downloadSafe(source);
}
async function saveAsset(taskId, role, index, buffer) {
  const metadata = await decodeImage(buffer);
  const dir = getImageStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('无效任务标识。');
  const fileName = `${taskId}_${role}_${index}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
  const target = path.join(dir, fileName);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, buffer, { mode: 0o600 }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
  return { fileName, ...metadata, size: buffer.length, savedAt: new Date().toISOString(), role, sourceIndex: index };
}
// Delete the runner's paid-result spool for this exact task only. The spool holds a
// complete base64 copy of an upstream result, so a permanent delete must clear it too,
// or the paid image survives on the container volume after the user deleted it.
// Callers must only invoke this for tasks that are already settled (or being settled
// as part of the same delete); never for a task that could still be archived.
function removePendingResultSpool(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('无效任务标识。');
  const spoolDir = path.join(getDataDir(), 'pending-results');
  let stat;
  try { stat = fs.lstatSync(spoolDir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资产目录无效。');
  for (const name of [`${id}.json`, `${id}.json.tmp`]) {
    try { fs.unlinkSync(path.join(spoolDir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Only remove names emitted by our writers for this exact task. Never sweep a directory.
function cleanupTaskFiles(log, removeAssets = false, protectedFiles = new Set()) {
  if (!/^[A-Za-z0-9_-]+$/.test(log.id)) throw new Error('无效任务标识。');
  const unlink = (file) => {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const checkedDirectory = (dir) => {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资产目录无效。');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  removePendingResultSpool(log.id);
  const dir = getImageStoreDir();
  if (!checkedDirectory(dir)) return;
  const asset = `${log.id}_(?:input|result)_[0-9]+\\.(?:png|jpg|webp)`;
  const temporary = new RegExp(`^${asset}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`, 'i');
  const generated = new RegExp(`^${asset}$`);
  const recorded = new Set(removeAssets ? [...(log.imageFiles || []), ...(log.inputFiles || [])].map((file) => file.fileName) : []);
  for (const name of fs.readdirSync(dir)) {
    if (protectedFiles.has(name)) continue;
    if (temporary.test(name) || (removeAssets && (generated.test(name) || recorded.has(name)))) unlink(path.join(dir, name));
  }
}
const TERMINAL_GENERATION_STATUSES = new Set([
  'completed', 'succeeded', 'success', 'failed', 'cancelled', 'error', 'submit_failed_refunded', 'submission_refunded_closed'
]);
function canPermanentlyDeleteAssets(log) {
  return log.type === 'generation' && log.settled === true && TERMINAL_GENERATION_STATUSES.has(String(log.status || '').toLowerCase());
}
// Run inside the store mutation queue, only AFTER the tombstone was persisted. Keep
// metadata until every unlink succeeds; a failed unlink/persist must remain retryable.
function completeAssetDeletion(data, logs) {
  if (logs.some((log) => !log.assetsDeletedAt || !canPermanentlyDeleteAssets(log))) throw new Error('资产尚不能永久删除。');
  const deleting = new Set(logs.map((log) => log.id));
  const protectedFiles = new Set(data.spendLogs.filter((log) => !deleting.has(log.id))
    .flatMap((log) => [...(log.imageFiles || []), ...(log.inputFiles || [])]).map((file) => file.fileName));
  for (const log of logs) cleanupTaskFiles(log, true, protectedFiles);
  for (const log of logs) {
    log.imageFiles = []; log.inputFiles = []; log.imageUrls = []; log.remoteImageUrls = [];
    log.assetDeletionStatus = 'complete';
  }
}
module.exports = { InvalidImageError, capacity, assertCapacity, publicAddress, downloadSafe, decodeImage, readSource, saveAsset, cleanupTaskFiles, removePendingResultSpool, canPermanentlyDeleteAssets, completeAssetDeletion };
