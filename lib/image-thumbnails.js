const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { getDataDir, getImageStoreDir } = require('./store');

const VERSION = 'v1';
const MAX_PENDING = 32;
const inFlight = new Map();
const queue = [];
let active = 0;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}
function validThumbnailSourceName(name) {
  return typeof name === 'string' && name.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp)$/i.test(name);
}
function checkedDirectory(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(500, 'Unsafe image directory');
  return dir;
}
function cacheDirectory(create = false) {
  return checkedDirectory(path.join(getDataDir(), 'thumbnails'), create);
}
function sourceIdentity(fileName) {
  if (!validThumbnailSourceName(fileName)) throw failure(400, 'Bad Request');
  const dir = checkedDirectory(getImageStoreDir());
  const filePath = path.join(dir, fileName);
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure(404, 'Not Found');
  if (stat.size > 20n * 1024n * 1024n) throw failure(422, 'Image too large');
  const fingerprint = crypto.createHash('sha256').update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).digest('hex');
  const sourceKey = crypto.createHash('sha256').update(fileName).digest('hex');
  return { fileName, filePath, fingerprint, cacheName: `${sourceKey}.${VERSION}.${fingerprint}.webp` };
}
async function readRegularFile(filePath) {
  const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw failure(404, 'Not Found');
    if (stat.size > 20 * 1024 * 1024) throw failure(422, 'Image too large');
    return await file.readFile();
  } finally { await file.close(); }
}
function runQueue() {
  while (active < 2 && queue.length) {
    const { work, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; runQueue(); });
  }
}
function enqueue(work) {
  if (active >= 2 && queue.length >= MAX_PENDING) throw failure(503, 'Thumbnail queue is full');
  const promise = new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); });
  runQueue();
  return promise;
}
async function prepareThumbnail(fileName) {
  const source = sourceIdentity(fileName);
  const cacheDir = cacheDirectory(true);
  const cachePath = path.join(cacheDir, source.cacheName);
  let buffer;
  try { buffer = await readRegularFile(cachePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!buffer) {
    const key = cachePath;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = enqueue(async () => {
        // Another request may have published while this cache miss waited for a worker.
        cacheDirectory();
        try { return await readRegularFile(cachePath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        checkedDirectory(getImageStoreDir());
        const original = await readRegularFile(source.filePath);
        if (original.length > 20 * 1024 * 1024) throw failure(422, 'Image too large');
        const image = sharp(original, { limitInputPixels: 40 * 1024 * 1024, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.pages > 1) throw failure(422, 'Unsupported image');
        return image.rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
      });
      inFlight.set(key, pending);
      pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
    }
    buffer = await pending;
  }
  return { source, cachePath, buffer, etag: `"${crypto.createHash('sha256').update(buffer).digest('hex')}"` };
}
// Called synchronously after the route's final authorization. No await may separate
// that check, publication and response: deletion mutates the same authoritative store.
function publishThumbnail(prepared) {
  const current = sourceIdentity(prepared.source.fileName);
  if (current.filePath !== prepared.source.filePath || current.fingerprint !== prepared.source.fingerprint) throw failure(409, 'Image changed');
  const dir = cacheDirectory();
  if (path.join(dir, current.cacheName) !== prepared.cachePath) throw failure(409, 'Image changed');
  try {
    const stat = fs.lstatSync(prepared.cachePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure(500, 'Unsafe thumbnail file');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${prepared.cachePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, prepared.buffer, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, prepared.cachePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function removeSourceThumbnails(fileName) {
  if (!validThumbnailSourceName(fileName)) return;
  let dir;
  try { dir = cacheDirectory(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const sourceKey = crypto.createHash('sha256').update(fileName).digest('hex');
  const variant = new RegExp(`^${sourceKey}\\.v[0-9]+\\.[a-f0-9]{64}\\.webp(?:\\.[0-9a-f-]{36}\\.tmp)?$`);
  for (const name of fs.readdirSync(dir)) {
    if (!variant.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { validThumbnailSourceName, prepareThumbnail, publishThumbnail, removeSourceThumbnails };
