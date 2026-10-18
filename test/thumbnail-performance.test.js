const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const sharp = require('sharp');
const store = require('../lib/store');
const { handleStoredImage } = require('../routes/stored-images');
const { handleMe } = require('../routes/me');
const runner = require('../lib/image-task-runner');
const EMAIL = 'thumbnail@staging.invalid';
const OTHER = 'other@staging.invalid';
let large;
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function fixture(run) {
  const previous = { DATA_DIR: process.env.DATA_DIR, ADMIN_EMAIL: process.env.ADMIN_EMAIL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-performance-'));
  process.env.DATA_DIR = dir; delete process.env.ADMIN_EMAIL;
  try {
    large ||= await sharp(crypto.randomBytes(1600 * 1200 * 3), { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer();
    const data = store.emptyStore();
    for (const email of [EMAIL, OTHER]) data.users[email] = { email, active: true, balanceMicros: 1000 };
    data.sessions.token = { email: EMAIL, expiresAt: '2999-01-01T00:00:00Z' };
    data.sessions.other = { email: OTHER, expiresAt: '2999-01-01T00:00:00Z' };
    store.saveDataStore(data);
    fs.mkdirSync(path.join(dir, 'images'));
    await addSource('task', 'task_result_0.png', large);
    await run(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function addSource(id, fileName, bytes) {
  fs.writeFileSync(path.join(store.getImageStoreDir(), fileName), bytes);
  await store.withDataStoreMutation((data) => data.spendLogs.push({ id, type: 'generation', email: EMAIL, status: 'completed', settled: true, chargedMicros: 100, imageFiles: [{ fileName }], inputFiles: [] }));
}
function response() {
  let finish;
  return { statusCode: 0, headers: {}, done: new Promise((resolve) => { finish = resolve; }),
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body) { this.body = body; finish(); } };
}
async function get(name = 'task_result_0.png', headers = {}, token = 'token') {
  const res = response();
  await handleStoredImage({ method: 'GET', headers: { authorization: `Bearer ${token}`, ...headers } }, res, `/api/stored-images/thumb/${name}`);
  await res.done;
  return res;
}
async function remove(id = 'task') {
  const res = response(); const pathname = `/api/me/logs/${id}/assets`;
  await handleMe({ method: 'DELETE', headers: { authorization: 'Bearer token', 'x-confirm-delete': 'permanent' } }, res, pathname, new URL(pathname, 'http://localhost'));
  return res;
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const cacheFiles = (dir) => fs.existsSync(path.join(dir, 'thumbnails')) ? fs.readdirSync(path.join(dir, 'thumbnails')) : [];

test('thumbnail on-demand encode deduplicates concurrent requests, bounds bytes/dimensions, preserves original, reuses disk and validates ETag', async () => {
  await fixture(async (dir) => {
    const original = sharp.prototype.toBuffer; let encodes = 0;
    sharp.prototype.toBuffer = function (...args) { encodes += 1; return original.apply(this, args); };
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, () => get()));
      assert.equal(encodes, 1);
      for (const res of responses) { assert.equal(res.statusCode, 200); assert.deepEqual(res.body, responses[0].body); }
      const first = responses[0]; const meta = await sharp(first.body).metadata();
      assert.equal(meta.format, 'webp'); assert.equal(meta.width, 640); assert.equal(meta.height, 480);
      assert.ok(first.body.length < large.length / 5, `${first.body.length} vs original ${large.length}`);
      assert.equal(hash(fs.readFileSync(path.join(dir, 'images/task_result_0.png'))), hash(large));
      assert.equal(first.headers['Cache-Control'], 'private, no-cache, must-revalidate');
      assert.equal(first.headers.Vary, 'Cookie, Authorization'); assert.equal(first.headers['Content-Type'], 'image/webp');
      assert.equal(cacheFiles(dir).length, 1); assert.equal(fs.statSync(path.join(dir, 'thumbnails', cacheFiles(dir)[0])).mode & 0o777, 0o600);
      assert.equal((await get()).headers.ETag, first.headers.ETag);
      const conditional = await get(undefined, { 'if-none-match': `W/${first.headers.ETag}` });
      assert.equal(conditional.statusCode, 304); assert.equal(conditional.body, undefined); assert.equal(encodes, 1);
      // A changed legacy source at the same URL gets a new fingerprint and bytes.
      fs.writeFileSync(path.join(dir, 'images/task_result_0.png'), await original.call(sharp({ create: { width: 20, height: 10, channels: 4, background: '#ff000080' } }).png()));
      const changed = await get(); assert.equal(changed.statusCode, 200); assert.notEqual(changed.headers.ETag, first.headers.ETag); assert.equal(encodes, 2);
      const small = await sharp(changed.body).metadata(); assert.equal(small.width, 20); assert.equal(small.height, 10); assert.equal(small.hasAlpha, true);
      assert.equal(cacheFiles(dir).length, 2);
      assert.equal((await remove()).statusCode, 200); assert.deepEqual(cacheFiles(dir), []);
    } finally { sharp.prototype.toBuffer = original; }
  });
});

test('real HTTP thumbnail conditional cache stays private, and originals remain unchanged no-store', async () => {
  await fixture(async () => {
    const server = http.createServer((req, res) => { handleStoredImage(req, res, new URL(req.url, 'http://localhost').pathname).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/stored-images/`;
    try {
      const headers = { cookie: 'imageGenToken=token' };
      const first = await fetch(`${base}thumb/task_result_0.png`, { headers });
      assert.equal(first.status, 200); assert.equal(first.headers.get('content-type'), 'image/webp');
      assert.equal(first.headers.get('cache-control'), 'private, no-cache, must-revalidate'); assert.equal(first.headers.get('vary'), 'Cookie, Authorization');
      const bytes = Buffer.from(await first.arrayBuffer()); assert.ok(bytes.length < large.length / 5);
      const conditional = await fetch(`${base}thumb/task_result_0.png`, { headers: { ...headers, 'if-none-match': first.headers.get('etag') } });
      assert.equal(conditional.status, 304); assert.equal((await conditional.arrayBuffer()).byteLength, 0);
      const original = await fetch(`${base}task_result_0.png`, { headers });
      assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control'), 'no-store'); assert.equal(hash(Buffer.from(await original.arrayBuffer())), hash(large));
      await store.withDataStoreMutation((data) => { delete data.sessions.token; });
      const denied = await fetch(`${base}thumb/task_result_0.png`, { headers: { ...headers, 'if-none-match': first.headers.get('etag') } });
      assert.equal(denied.status, 401); assert.equal(denied.headers.get('cache-control'), 'no-store');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test('source replacement during an encode cannot publish stale bytes', async () => {
  await fixture(async (dir) => {
    const replacement = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const original = sharp.prototype.toBuffer; const entered = deferred(); const release = deferred();
    sharp.prototype.toBuffer = async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
    const pending = get();
    try {
      await entered.promise; fs.writeFileSync(path.join(dir, 'images/task_result_0.png'), replacement);
      release.resolve(); const res = await pending; assert.equal(res.statusCode, 409); assert.deepEqual(cacheFiles(dir), []);
    } finally { release.resolve(); sharp.prototype.toBuffer = original; await pending; }
    const res = await get(); assert.equal(res.statusCode, 200); assert.equal((await sharp(res.body).metadata()).width, 20);
  });
});

test('thumbnail auto-orients without enlargement and does not fall back to invalid original bytes', async () => {
  await fixture(async () => {
    await addSource('portrait', 'legacy.jpg', await sharp({ create: { width: 100, height: 50, channels: 3, background: '#336699' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    const res = await get('legacy.jpg'); const meta = await sharp(res.body).metadata();
    assert.equal(meta.width, 50); assert.equal(meta.height, 100);
    await addSource('invalid', 'invalid.png', Buffer.from('secret-invalid-original'));
    const invalid = await get('invalid.png'); assert.equal(invalid.statusCode, 500); assert.ok(!String(invalid.body).includes('secret-invalid-original'));
  });
});

for (const phase of ['encode', 'cached-read']) {
  for (const change of ['delete', 'logout', 'disable', 'owner', 'metadata', 'admin-revoke', 'session-account']) {
    test(`thumbnail ${phase} rechecks ${change} before publishing bytes or conditional 304`, async () => {
      await fixture(async (dir) => {
        let etag;
        if (phase === 'cached-read') etag = (await get()).headers.ETag;
        if (change === 'admin-revoke') await store.withDataStoreMutation((data) => { data.users[OTHER].isAdmin = true; });
        const entered = deferred(); const release = deferred();
        const originalBuffer = sharp.prototype.toBuffer; const originalOpen = fs.promises.open;
        if (phase === 'encode') sharp.prototype.toBuffer = async function (...args) { entered.resolve(); await release.promise; return originalBuffer.apply(this, args); };
        else fs.promises.open = async (...args) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).includes('/thumbnails/')) {
            const read = handle.readFile.bind(handle);
            handle.readFile = async (...readArgs) => { const bytes = await read(...readArgs); entered.resolve(); await release.promise; return bytes; };
          }
          return handle;
        };
        const pending = get(undefined, etag ? { 'if-none-match': etag } : {}, change === 'admin-revoke' ? 'other' : 'token');
        try {
          await entered.promise;
          if (change === 'delete') assert.equal((await remove()).statusCode, 200);
          else await store.withDataStoreMutation((data) => {
            if (change === 'logout') delete data.sessions.token;
            if (change === 'disable') data.users[EMAIL].active = false;
            if (change === 'owner') data.spendLogs[0].email = OTHER;
            if (change === 'metadata') data.spendLogs[0].imageFiles = [];
            if (change === 'admin-revoke') data.users[OTHER].isAdmin = false;
            if (change === 'session-account') data.sessions.token.email = OTHER;
          });
          release.resolve(); const res = await pending;
          assert.equal(res.statusCode, change === 'logout' ? 401 : ['delete', 'metadata'].includes(change) ? 404 : 403);
          assert.equal(res.headers['Cache-Control'], 'no-store'); assert.ok(!Buffer.isBuffer(res.body));
          if (phase === 'encode' || change === 'delete') assert.deepEqual(cacheFiles(dir), [], 'late encoder must not resurrect cache');
        } finally { release.resolve(); sharp.prototype.toBuffer = originalBuffer; fs.promises.open = originalOpen; await pending; }
      });
    });
  }
}

test('thumbnail rejects oversized decoded inputs and unsupported methods without serving originals', async () => {
  await fixture(async (dir) => {
    const oversized = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: '#336699' } }).png().toBuffer();
    await addSource('oversized', 'oversized.png', oversized);
    assert.equal((await get('oversized.png')).statusCode, 500); assert.deepEqual(cacheFiles(dir), []);
    const res = response();
    await handleStoredImage({ method: 'POST', headers: { authorization: 'Bearer token' } }, res, '/api/stored-images/thumb/task_result_0.png');
    assert.equal(res.statusCode, 405); assert.equal(res.headers['Cache-Control'], 'no-store');
  });
});

test('thumbnail atomic write failure leaves no partial variant and can retry without touching originals', async () => {
  await fixture(async (dir) => {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(to).includes('/thumbnails/')) throw Object.assign(new Error('disk fault'), { code: 'EIO' }); return rename(from, to); };
    try { assert.equal((await get()).statusCode, 500); } finally { fs.renameSync = rename; }
    assert.deepEqual(cacheFiles(dir), []); assert.equal(hash(fs.readFileSync(path.join(dir, 'images/task_result_0.png'))), hash(large));
    assert.equal((await get()).statusCode, 200); assert.equal(cacheFiles(dir).length, 1);
  });
});

test('cached ETag never bypasses fresh authorization, tombstone or source existence', async () => {
  await fixture(async (dir) => {
    const first = await get(); const headers = { 'if-none-match': first.headers.ETag };
    assert.equal((await get(undefined, headers, 'other')).statusCode, 403);
    assert.equal((await get(undefined, headers, 'missing')).statusCode, 401);
    fs.unlinkSync(path.join(dir, 'images/task_result_0.png'));
    assert.equal((await get(undefined, headers)).statusCode, 404);
  });
});

test('thumbnail validates encoded names and refuses source/cache file and directory symlinks', async () => {
  await fixture(async (dir) => {
    for (const name of ['../task_result_0.png', '%2e%2e%2ftask_result_0.png', '%2ftask_result_0.png', 'a%5cb.png', '.hidden.png', 'a.png%00', '%ZZ', 'https%3A%2F%2Fexample.test%2Fa.png']) assert.equal((await get(name)).statusCode, 400, name);
    const file = path.join(dir, 'images/task_result_0.png'); fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file);
    assert.equal((await get()).statusCode, 404);
    fs.unlinkSync(file); fs.writeFileSync(file, large);
    await get(); const cache = path.join(dir, 'thumbnails', cacheFiles(dir)[0]); fs.unlinkSync(cache); fs.symlinkSync(file, cache);
    assert.equal((await get()).statusCode, 500);
    fs.unlinkSync(cache); fs.rmdirSync(path.join(dir, 'thumbnails')); fs.mkdirSync(path.join(dir, 'elsewhere')); fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'thumbnails'));
    assert.equal((await get()).statusCode, 500); assert.deepEqual(fs.readdirSync(path.join(dir, 'elsewhere')), []);
    fs.unlinkSync(path.join(dir, 'thumbnails')); fs.renameSync(path.join(dir, 'images'), path.join(dir, 'real-images')); fs.symlinkSync(path.join(dir, 'real-images'), path.join(dir, 'images'));
    assert.equal((await get()).statusCode, 500);
  });
});

test('two thumbnail workers bound global concurrency and reject excess queue with 503', async () => {
  await fixture(async (dir) => {
    const small = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#336699' } }).png().toBuffer();
    for (let i = 0; i < 38; i += 1) await addSource(`queue${i}`, `queue${i}.png`, small);
    const original = sharp.prototype.toBuffer; const release = deferred(); const ready = deferred();
    let active = 0; let maximum = 0; let entered = 0;
    sharp.prototype.toBuffer = async function (...args) {
      active += 1; entered += 1; maximum = Math.max(active, maximum); if (entered === 2) ready.resolve();
      try { await release.promise; return await original.apply(this, args); } finally { active -= 1; }
    };
    const requests = Array.from({ length: 38 }, (_, i) => get(`queue${i}.png`));
    try {
      await ready.promise;
      // Wait for all asynchronous cache misses to reach admission while both workers are held.
      const rejected = await Promise.race(requests);
      assert.equal(rejected.statusCode, 503); assert.equal(maximum, 2);
      release.resolve(); const responses = await Promise.all(requests);
      assert.equal(responses.filter((res) => res.statusCode === 200).length, 34);
      assert.equal(responses.filter((res) => res.statusCode === 503).length, 4); assert.equal(maximum, 2);
      assert.equal(cacheFiles(dir).length, 34);
    } finally { release.resolve(); sharp.prototype.toBuffer = original; await Promise.all(requests); }
  });
});

test('thumbnail unlink failure remains pending and retry removes exact variants/temps while protecting shared sources', async () => {
  await fixture(async (dir) => {
    await get(); const variant = cacheFiles(dir)[0];
    const temp = `${variant}.01234567-1234-1234-1234-0123456789ab.tmp`;
    fs.writeFileSync(path.join(dir, 'thumbnails', temp), 'temporary');
    fs.writeFileSync(path.join(dir, 'thumbnails', `${variant}.unrelated`), 'unrelated');
    await addSource('other', 'other.png', large); await get('other.png');
    await store.withDataStoreMutation((data) => { data.spendLogs[0].inputFiles = [{ fileName: 'other.png' }]; });
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (file) => { if (path.basename(file) === variant) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return unlink(file); };
    try { assert.equal((await remove()).statusCode, 500); } finally { fs.unlinkSync = unlink; }
    const log = store.loadDataStore().spendLogs[0]; assert.ok(log.assetsDeletedAt); assert.equal(log.assetDeletionStatus, 'pending'); assert.equal(log.imageFiles.length, 1);
    await runner.recoverTasks(true, { network: false });
    assert.equal(log.assetDeletionStatus, 'complete'); assert.equal(log.chargedMicros, 100);
    assert.equal(fs.existsSync(path.join(dir, 'images/task_result_0.png')), false);
    assert.equal(fs.existsSync(path.join(dir, 'images/other.png')), true);
    assert.equal(cacheFiles(dir).length, 2); assert.ok(cacheFiles(dir).includes(`${variant}.unrelated`));
    assert.equal(cacheFiles(dir).includes(temp), false);
    assert.equal((await get('other.png')).statusCode, 200);
  });
});
