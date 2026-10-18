const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

process.env.QUICK_BATCH_ENABLED = 'true';
const { emptyStore, loadDataStore, saveDataStore } = require('../lib/store');
const { handleGeneration } = require('../routes/api-market');
const { handleMe } = require('../routes/me');
const { taskWorkspace, activeRequestCount, maxActiveRequests } = require('../lib/task-workspace');
const { handlePublicConfig } = require('../routes/public-config');
const CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.test', model: 'gpt-image-2', quickBatchEnabled: true };
async function withDataDir(run) {
  const previousDataDir = process.env.DATA_DIR;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-quick-batch-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.ADMIN_EMAIL;
  try {
    return await run(dataDir);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function seedStore({ balanceMicros = 10000000, secondUser = false } = {}) {
  const data = emptyStore();
  data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros };
  data.sessions.userToken = { email: 'user@example.com', createdAt: new Date().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' };
  if (secondUser) {
    data.users['other@example.com'] = { email: 'other@example.com', active: true, balanceMicros };
    data.sessions.otherToken = { email: 'other@example.com', createdAt: new Date().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' };
  }
  saveDataStore(data);
  return data;
}

function request(method, body, token = 'userToken', headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  return req;
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...(headers || {}) };
    },
    end(body) { this.body = body; }
  };
}

function upstreamResponse(spec) {
  const payload = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body || {});
  const upstream = Readable.from([Buffer.from(payload)]);
  upstream.statusCode = spec.status ?? 200;
  upstream.headers = { 'content-type': 'application/json', ...(spec.headers || {}) };
  return upstream;
}

function installHttpsMock(handler) {
  const original = https.request;
  https.request = (options, callback) => {
    const outgoing = new EventEmitter();
    let requestBody = '';
    outgoing.setTimeout = () => outgoing;
    outgoing.write = (chunk) => { requestBody += Buffer.from(chunk).toString('utf8'); return true; };
    outgoing.destroy = (error) => { if (error) outgoing.emit('error', error); };
    outgoing.end = () => handler({ options, callback, outgoing, requestBody });
    return outgoing;
  };
  return () => { https.request = original; };
}


test('feed groups batches, conservatively retains unsettled and hidden unknown, bounds recent and redacts assets', async () => {
  await withDataDir(async () => {
    const data = seedStore({ secondUser: true });
    const log = (id, extra = {}) => ({ id, email: 'user@example.com', type: 'generation', status: 'completed', settled: true, createdAt: '2026-01-01T00:00:00Z', ...extra });
    data.spendLogs = [
      log('unknown', { status: 'submission_unknown', settled: false, hiddenFromHistory: true }),
      log('unsettled', { settled: false }),
      ...[0, 1, 2, 3].map((batchIndex) => log(`batch_${batchIndex}`, { batchId: 'batch', batchIndex, clientRequestId: 'batch-key', status: 'processing', settled: false })),
      log('foreign', { email: 'other@example.com', status: 'processing', settled: false }),
      log('ledger', { type: 'adjustment', status: 'processing', settled: false }),
      log('deleted', { createdAt: '2027-01-01T00:00:00Z', assetsDeletedAt: 'now', imageFiles: [{ fileName: 'secret.png', originalUrl: 'https://private.test' }], inputFiles: [{ fileName: 'input.png' }], imageUrls: ['data:image/png;base64,SECRET'], submitResponse: { secret: 'SECRET' }, error: 'api-key SECRET', settings: { size: '1:1', token: 'SECRET' } }),
      log('local', { createdAt: '2027-01-02T00:00:00Z', imageFiles: [{ fileName: 'output.png', originalUrl: 'https://private.test' }], inputFiles: [{ fileName: 'input.png', secret: 'SECRET' }] }),
      ...Array.from({ length: 25 }, (_, index) => log(`recent_${index}`))
    ];
    saveDataStore(data);
    assert.equal(activeRequestCount(data, 'user@example.com'), 3);
    const feed = taskWorkspace(data, 'user@example.com');
    assert.equal(feed.activeCount, 3);
    assert.equal(feed.tasks.length, 23);
    assert.equal(feed.tasks.find((task) => task.batchId === 'batch').children.length, 4);
    assert.ok(feed.tasks.find((task) => task.id === 'unknown'));
    const deleted = feed.tasks.find((task) => task.id === 'deleted');
    assert.deepEqual(deleted.imageFiles, []);
    assert.deepEqual(deleted.inputFiles, []);
    assert.equal(deleted.assetsDeleted, true);
    assert.equal(JSON.stringify(feed).includes('SECRET'), false);
    assert.equal(JSON.stringify(feed).includes('private.test'), false);
    assert.equal(JSON.stringify(feed).includes('foreign'), false);
    assert.equal(JSON.stringify(feed).includes('ledger'), false);
    assert.deepEqual(feed.tasks.find((task) => task.id === 'local').inputFiles, [{ fileName: 'input.png', url: '/api/stored-images/input.png' }]);
    const res = responseCapture();
    await handleMe(request('GET'), res, '/api/me/tasks', new URL('http://localhost/api/me/tasks'));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).activeCount, 3);
    const other = responseCapture();
    await handleMe(request('GET', undefined, 'otherToken'), other, '/api/me/tasks', new URL('http://localhost/api/me/tasks'));
    assert.deepEqual(JSON.parse(other.body).tasks.map((task) => task.id), ['foreign']);
    const denied = responseCapture();
    await handleMe(request('GET', undefined, null), denied, '/api/me/tasks', new URL('http://localhost/api/me/tasks'));
    assert.equal(denied.statusCode, 401);
  });
});

test('parallel submissions atomically cap groups before debit/provider, replay at cap, batch is one slot', { timeout: 10000 }, async () => {
  await withDataDir(async () => {
    const previous = process.env.MAX_ACTIVE_REQUESTS;
    process.env.MAX_ACTIVE_REQUESTS = '1';
    seedStore();
    let calls = 0;
    const restore = installHttpsMock(({ callback }) => {
      calls += 1;
      setImmediate(() => callback(upstreamResponse({ body: { data: { task_id: `task_${calls}` } } })));
    });
    try {
      const payload = { model: 'gpt-image-2', prompt: 'test', size: '1:1', resolution: '1k', n: 4 };
      const responses = [responseCapture(), responseCapture()];
      await Promise.all(responses.map((res, index) => handleGeneration(request('POST', payload, 'userToken', { 'idempotency-key': `race_${index}` }), res, CONFIG)));
      assert.deepEqual(responses.map((res) => res.statusCode).sort(), [202, 409]);
      const rejected = JSON.parse(responses.find((res) => res.statusCode === 409).body);
      assert.equal(rejected.error.code, 'active_request_limit');
      assert.equal(rejected.error.limit, 1);
      assert.equal(rejected.error.activeCount, 1);
      assert.equal(calls, 4);
      const snapshot = loadDataStore();
      assert.equal(snapshot.spendLogs.length, 4);
      assert.equal(activeRequestCount(snapshot, 'user@example.com'), 1);
      assert.equal(snapshot.users['user@example.com'].balanceMicros, 8776000);
      const replay = responseCapture();
      await handleGeneration(request('POST', payload, 'userToken', { 'idempotency-key': snapshot.spendLogs[0].clientRequestId }), replay, CONFIG);
      assert.equal(replay.statusCode, 200);
      assert.equal(calls, 4);
      assert.equal(loadDataStore().users['user@example.com'].balanceMicros, 8776000);
    } finally {
      restore();
      if (previous === undefined) delete process.env.MAX_ACTIVE_REQUESTS;
      else process.env.MAX_ACTIVE_REQUESTS = previous;
    }
  });
});

test('single unknown and terminal-unsettled requests occupy slots until conservative settlement', async () => {
  await withDataDir(async () => {
    const data = seedStore();
    data.spendLogs = Array.from({ length: 3 }, (_, index) => ({ id: `single_${index}`, type: 'generation', email: 'user@example.com', clientRequestId: `single-key-${index}`, status: index === 0 ? 'completed' : 'submission_unknown', settled: false, hiddenFromHistory: true }));
    saveDataStore(data);
    const res = responseCapture();
    await handleGeneration(request('POST', { model: 'gpt-image-2', prompt: 'single', size: '1:1', resolution: '1k', n: 1 }, 'userToken', { 'idempotency-key': 'blocked-single' }), res, CONFIG);
    assert.equal(res.statusCode, 409);
    assert.equal(loadDataStore().users['user@example.com'].balanceMicros, 10000000);
    assert.equal(loadDataStore().spendLogs.length, 3);
    data.spendLogs[0].settled = true;
    assert.equal(activeRequestCount(data, 'user@example.com'), 2);
    data.spendLogs[1].settled = true; // Unknown cannot release a slot even if settlement is inconsistent.
    assert.equal(activeRequestCount(data, 'user@example.com'), 2);
    const config = responseCapture();
    handlePublicConfig({ method: 'GET' }, config);
    assert.equal(JSON.parse(config.body).limits.maxActiveRequests, 3);
  });
});

test('active limit defaults safely on invalid configuration', () => {
  const previous = process.env.MAX_ACTIVE_REQUESTS;
  try {
    for (const value of ['', '0', '-1', 'NaN', '1.5']) {
      process.env.MAX_ACTIVE_REQUESTS = value;
      assert.equal(maxActiveRequests(), 3);
    }
    process.env.MAX_ACTIVE_REQUESTS = '5';
    assert.equal(maxActiveRequests(), 5);
  } finally {
    if (previous === undefined) delete process.env.MAX_ACTIVE_REQUESTS;
    else process.env.MAX_ACTIVE_REQUESTS = previous;
  }
});
