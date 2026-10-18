const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns').promises;
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const store = require('../lib/store');
const runner = require('../lib/image-task-runner');
const assets = require('../lib/image-assets');
const { handleMe } = require('../routes/me');
const { handleStoredImage } = require('../routes/stored-images');
const EMAIL = 'asset@staging.invalid';
const OTHER = 'other@staging.invalid';
let png;

async function fixture(run) {
  const previous = { DATA_DIR: process.env.DATA_DIR, ADMIN_EMAIL: process.env.ADMIN_EMAIL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-audit-'));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAIL;
  try {
    png ||= await sharp({ create: { width: 8, height: 8, channels: 3, background: '#446688' } }).png().toBuffer();
    const data = store.emptyStore();
    for (const email of [EMAIL, OTHER]) data.users[email] = { email, active: true, balanceMicros: 900 };
    data.sessions.token = { email: EMAIL, expiresAt: '2999-01-01T00:00:00Z' };
    data.sessions.other = { email: OTHER, expiresAt: '2999-01-01T00:00:00Z' };
    store.saveDataStore(data);
    fs.mkdirSync(path.join(dir, 'images'));
    await run(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function log(id = 'task', overrides = {}) {
  return { id, type: 'generation', email: EMAIL, status: 'completed', settled: true, chargedMicros: 100, actualCostMicros: 100, balanceAfterMicros: 900, imageFiles: [], inputFiles: [], ...overrides };
}
function req(method = 'GET', token = 'token') {
  return { method, headers: { authorization: `Bearer ${token}`, 'x-confirm-delete': 'permanent' } };
}
function response() {
  let finish;
  return { statusCode: 0, headers: {}, done: new Promise((resolve) => { finish = resolve; }),
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body) { this.body = body; finish(); } };
}
async function remove(id = 'task', token = 'token') {
  const res = response();
  const pathname = `/api/me/logs/${id}/assets`;
  await handleMe(req('DELETE', token), res, pathname, new URL(pathname, 'http://localhost'));
  return res;
}
const current = () => store.loadDataStore().spendLogs[0];
const addLogs = (...logs) => store.withDataStoreMutation((data) => data.spendLogs.push(...logs));
function queued(id = 'task') {
  const value = log(id, { estimatedCostMicros: 100, settled: false });
  runner.initializeHybridLog(value);
  return value;
}

test('image-assets safe downloader rejects malformed redirects and still follows relative redirects with per-hop safety', async () => {
  const originalLookup = dns.lookup;
  const originalGet = https.get;
  const paths = [];
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  https.get = (url, options, callback) => {
    paths.push(url.href);
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) request.emit('error', error); request.emit('close'); };
    setImmediate(() => {
      const response = Readable.from(url.pathname === '/final' ? [Buffer.from('image')] : []);
      response.statusCode = url.pathname === '/final' ? 200 : 302;
      response.headers = { location: url.pathname === '/bad' ? 'https://[invalid/' : url.pathname === '/private' ? 'https://127.0.0.1/a' : '/final' };
      response.on('end', () => request.emit('close'));
      callback(response);
    });
    return request;
  };
  try {
    await assert.rejects(assets.downloadSafe('https://public.invalid/bad'), /Invalid URL/);
    assert.equal((await assets.downloadSafe('https://public.invalid/start')).toString(), 'image');
    dns.lookup = async (hostname) => [{ address: hostname === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
    await assert.rejects(assets.downloadSafe('https://public.invalid/private'), /禁止/);
    assert.deepEqual(paths, ['https://public.invalid/bad', 'https://public.invalid/start', 'https://public.invalid/final', 'https://public.invalid/private']);
  } finally { dns.lookup = originalLookup; https.get = originalGet; }
});

test('input rename before failed metadata persistence: no submit, single refund, explicit exact-task deletion', async () => {
  await fixture(async (dir) => {
    await addLogs(queued());
    const originalRename = fs.promises.rename;
    let failures = 0;
    fs.promises.rename = async (from, to) => {
      if (!failures && to === store.getDataFilePath() && fs.existsSync(path.join(dir, 'images/task_input_0.png'))) {
        failures += 1; throw new Error('metadata persistence fault');
      }
      return originalRename(from, to);
    };
    let calls = 0;
    try {
      await runner.startTask('task', { image_urls: [`data:image/png;base64,${png.toString('base64')}`] }, { cpa: () => { calls += 1; assert.fail('no submit'); } });
    } finally { fs.promises.rename = originalRename; }
    assert.equal(failures, 1); assert.equal(calls, 0);
    assert.equal(current().settled, true); assert.equal(current().chargedMicros, 0);
    assert.deepEqual(current().inputFiles, []);
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
    await runner.startTask('task', {}, { cpa: () => assert.fail('no replay') });
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
    const spool = path.join(dir, 'pending-results'); fs.mkdirSync(spool);
    for (const name of ['task.json', 'task.json.tmp', 'other.json']) fs.writeFileSync(path.join(spool, name), 'copy');
    for (const name of ['task_other.png', 'task_input_0.png.extra', 'task2_input_0.png', 'notes.txt']) fs.writeFileSync(path.join(dir, 'images', name), 'unrelated');
    assert.equal((await remove()).statusCode, 200);
    assert.equal(fs.existsSync(path.join(dir, 'images/task_input_0.png')), false);
    assert.deepEqual(fs.readdirSync(spool), ['other.json']);
    assert.equal(fs.readdirSync(path.join(dir, 'images')).length, 4);
    assert.equal(current().assetDeletionStatus, 'complete');
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
  });
});

test('crash after asset write recovers finances only; explicit tombstone restart cleans exact orphan and temporary files', async () => {
  await fixture(async (dir) => {
    await addLogs(queued());
    const child = spawnSync(process.execPath, ['-e', `require('./lib/image-assets').saveAsset('task','input',0,Buffer.from('${png.toString('base64')}','base64')).then(()=>process.exit(19))`], { cwd: path.join(__dirname, '..'), env: process.env });
    assert.equal(child.status, 19, child.stderr.toString());
    await runner.recoverTasks(true, { network: false });
    assert.equal(current().status, 'failed');
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
    assert.equal(fs.existsSync(path.join(dir, 'images/task_input_0.png')), true, 'no automatic terminal-asset sweep');
    await addLogs(log('unknown', { status: 'submission_unknown', settled: false }), log('unrelated'));
    for (const name of ['unknown_input_0.png', 'unrelated_input_0.png', 'task2_input_0.png', 'task_input_1.png.01234567-1234-1234-1234-0123456789ab.tmp']) fs.writeFileSync(path.join(dir, 'images', name), 'bytes');
    await store.withDataStoreMutation((data) => { data.spendLogs[0].assetsDeletedAt = '2026-01-01'; data.spendLogs[0].assetDeletionStatus = 'complete'; });
    // A fresh process models startup after the tombstone persisted but metadata missed the file.
    const restart = spawnSync(process.execPath, ['-e', "require('./lib/image-task-runner').recoverTasks(true,{network:false}).catch(e=>{console.error(e);process.exitCode=1})"], { cwd: path.join(__dirname, '..'), env: process.env });
    assert.equal(restart.status, 0, restart.stderr.toString());
    assert.deepEqual(fs.readdirSync(path.join(dir, 'images')).sort(), ['task2_input_0.png', 'unknown_input_0.png', 'unrelated_input_0.png']);
    const persisted = JSON.parse(fs.readFileSync(store.getDataFilePath()));
    assert.equal(persisted.spendLogs[0].assetDeletionStatus, 'complete');
    assert.equal(persisted.spendLogs[1].status, 'submission_unknown');
    assert.equal(persisted.spendLogs[1].settled, false);
    assert.equal(persisted.users[EMAIL].balanceMicros, 1000);
  });
});

test('unlink failure keeps tombstone and metadata; restart retries only explicitly deleted eligible tasks', async () => {
  await fixture(async (dir) => {
    await addLogs(log('task', { imageFiles: [{ fileName: 'task_result_0.png' }] }), log('other', { email: OTHER, imageFiles: [{ fileName: 'shared.png' }, { fileName: 'task_result_1.png' }] }));
    await store.withDataStoreMutation((data) => data.spendLogs[0].inputFiles.push({ fileName: 'shared.png' }));
    for (const name of ['task_result_0.png', 'task_result_1.png', 'shared.png']) fs.writeFileSync(path.join(dir, 'images', name), 'bytes');
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (file) => {
      if (path.basename(file) === 'task_result_0.png') {
        const persisted = JSON.parse(fs.readFileSync(store.getDataFilePath()));
        assert.ok(persisted.spendLogs[0].assetsDeletedAt, 'tombstone must be durable before unlink');
        const error = new Error('denied'); error.code = 'EACCES'; throw error; }
      return unlink(file);
    };
    try { assert.equal((await remove()).statusCode, 500); } finally { fs.unlinkSync = unlink; }
    assert.equal(current().assetDeletionStatus, 'pending');
    assert.equal(current().imageFiles.length, 1);
    assert.ok(current().assetsDeletedAt);
    await runner.recoverTasks(true, { network: false });
    assert.equal(current().assetDeletionStatus, 'complete');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'images')).sort(), ['shared.png', 'task_result_1.png']);
    assert.equal(current().chargedMicros, 100);
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 900);
  });
});

for (const change of ['delete', 'logout', 'disable', 'owner', 'metadata', 'admin-revoke']) {
  test(`stored image delayed read rechecks ${change} and returns no image bytes`, async () => {
    await fixture(async (dir) => {
      await addLogs(log('task', { imageFiles: [{ fileName: 'task_result_0.png' }] }));
      fs.writeFileSync(path.join(dir, 'images/task_result_0.png'), 'secret-image-bytes');
      if (change === 'admin-revoke') await store.withDataStoreMutation((data) => { data.users[OTHER].isAdmin = true; });
      const read = fs.readFile;
      let release;
      fs.readFile = (file, callback) => { const bytes = fs.readFileSync(file); release = () => callback(null, bytes); };
      const res = response();
      try {
        await handleStoredImage(req('GET', change === 'admin-revoke' ? 'other' : 'token'), res, '/api/stored-images/task_result_0.png');
        assert.equal(typeof release, 'function');
        if (change === 'delete') assert.equal((await remove()).statusCode, 200);
        else await store.withDataStoreMutation((data) => {
          if (change === 'logout') delete data.sessions.token;
          if (change === 'disable') data.users[EMAIL].active = false;
          if (change === 'owner') data.spendLogs[0].email = OTHER;
          if (change === 'metadata') data.spendLogs[0].imageFiles = [];
          if (change === 'admin-revoke') data.users[OTHER].isAdmin = false;
        });
        release(); await res.done;
        assert.equal(res.statusCode, change === 'logout' ? 401 : ['disable', 'owner', 'admin-revoke'].includes(change) ? 403 : 404);
        assert.equal(String(res.body).includes('secret-image-bytes'), false);
        assert.equal(res.headers['Cache-Control'], 'no-store');
      } finally { fs.readFile = read; }
    });
  });
}

test('restart unlink failure downgrades an old complete tombstone to pending without losing retry metadata', async () => {
  await fixture(async (dir) => {
    await addLogs(log('task', { assetsDeletedAt: '2026-01-01', assetDeletionStatus: 'complete', inputFiles: [{ fileName: 'task_input_0.png' }] }));
    fs.mkdirSync(path.join(dir, 'images/task_input_0.png'));
    fs.mkdirSync(path.join(dir, 'pending-results/task.json'), { recursive: true });
    await runner.recoverTasks(true, { network: false });
    assert.equal(current().assetDeletionStatus, 'pending');
    assert.equal(current().inputFiles.length, 1);
    assert.equal(current().chargedMicros, 100);
    fs.rmdirSync(path.join(dir, 'pending-results/task.json'));
    fs.rmdirSync(path.join(dir, 'images/task_input_0.png'));
    fs.writeFileSync(path.join(dir, 'images/task_input_0.png'), 'bytes');
    await runner.recoverTasks(true, { network: false });
    assert.equal(current().assetDeletionStatus, 'complete');
    assert.equal(fs.existsSync(path.join(dir, 'images/task_input_0.png')), false);
  });
});

test('stored images use no-store for successful owner reads and reject other accounts', async () => {
  await fixture(async (dir) => {
    await addLogs(log('task', { inputFiles: [{ fileName: 'task_input_0.png' }] }));
    fs.writeFileSync(path.join(dir, 'images/task_input_0.png'), png);
    const res = response(); await handleStoredImage(req(), res, '/api/stored-images/task_input_0.png'); await res.done;
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, png); assert.equal(res.headers['Cache-Control'], 'no-store');
    const denied = response(); await handleStoredImage(req('GET', 'other'), denied, '/api/stored-images/task_input_0.png');
    assert.equal(denied.statusCode, 403);
  });
});

for (const change of ['logout', 'disable', 'eligibility']) {
  test(`permanent deletion rechecks ${change} inside the mutation queue before tombstoning or unlinking`, async () => {
    await fixture(async (dir) => {
      await addLogs(log('task', { imageFiles: [{ fileName: 'task_result_0.png' }] }));
      fs.writeFileSync(path.join(dir, 'images/task_result_0.png'), 'bytes');
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const preceding = store.withDataStoreMutation(async (data) => {
        await gate;
        if (change === 'logout') delete data.sessions.token;
        if (change === 'disable') data.users[EMAIL].active = false;
        if (change === 'eligibility') { data.spendLogs[0].settled = false; data.spendLogs[0].status = 'submission_unknown'; }
      });
      const pending = remove();
      release(); await preceding;
      assert.equal((await pending).statusCode, change === 'logout' ? 401 : change === 'disable' ? 403 : 409);
      assert.equal(current().assetsDeletedAt, undefined);
      assert.equal(fs.existsSync(path.join(dir, 'images/task_result_0.png')), true);
      assert.equal(current().chargedMicros, 100);
      assert.equal((await remove('task', 'other')).statusCode, 404);
    });
  });
}

test('runner rechecks terminal state after input metadata await and never submits a closed task', async () => {
  await fixture(async (dir) => {
    await addLogs(queued());
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const originalWrite = fs.promises.writeFile;
    let held = false;
    // Hold the input-metadata persistence after the asset rename, while the runner
    // still owns its active entry. Queue the administrative close behind it.
    fs.promises.writeFile = async (file, contents, options) => {
      if (!held && String(file).startsWith(store.getDataFilePath()) && String(contents).includes('task_input_0.png')) {
        held = true; entered(); await gate;
      }
      return originalWrite(file, contents, options);
    };
    const pending = runner.startTask('task', { image_urls: [`data:image/png;base64,${png.toString('base64')}`] }, { cpa: () => assert.fail('closed input task must not submit') });
    try {
      await ready;
      const close = store.withDataStoreMutation((data) => { const value = data.spendLogs[0]; value.status = 'submission_refunded_closed'; value.settled = true; value.chargedMicros = 0; data.users[EMAIL].balanceMicros = 1000; });
      // The close runs before the runner's provider-admission mutation.
      release(); await close;
      await pending;
      assert.equal(current().settled, true);
    } finally { release(); fs.promises.writeFile = originalWrite; await pending; }
  });
});

test('active writer gets durable tombstone and pending 409, then retry cleans bytes without changing finances', async () => {
  await fixture(async (dir) => {
    await addLogs(queued('live'));
    // A provider response in flight may be administratively closed; deletion must
    // tombstone now but wait for explicit retry rather than block on that provider.
    let providerRelease;
    let providerEntered;
    const providerReady = new Promise((resolve) => { providerEntered = resolve; });
    const running = runner.startTask('live', {}, { cpa: async () => { providerEntered(); return new Promise((resolve) => { providerRelease = resolve; }); } });
    await providerReady;
    await store.withDataStoreMutation((data) => { const value = data.spendLogs[0]; value.status = 'submission_refunded_closed'; value.settled = true; value.chargedMicros = 0; data.users[EMAIL].balanceMicros = 1000; });
    fs.writeFileSync(path.join(dir, 'images/live_input_0.png'), 'reference-bytes');
    const before = { charged: current().chargedMicros, actual: current().actualCostMicros, balance: store.loadDataStore().users[EMAIL].balanceMicros };
    const deleted = await remove('live');
    assert.equal(deleted.statusCode, 409); assert.ok(current().assetsDeletedAt); assert.equal(current().assetDeletionStatus, 'pending');
    assert.equal(fs.existsSync(path.join(dir, 'images/live_input_0.png')), true);
    providerRelease([{ base64: png.toString('base64') }]); await running;
    assert.equal((await remove('live')).statusCode, 200);
    assert.equal(current().assetDeletionStatus, 'complete');
    assert.equal(fs.existsSync(path.join(dir, 'images/live_result_0.png')), false);
    assert.equal(fs.existsSync(path.join(dir, 'images/live_input_0.png')), false);
    assert.deepEqual({ charged: current().chargedMicros, actual: current().actualCostMicros, balance: store.loadDataStore().users[EMAIL].balanceMicros }, before);
  });
});
