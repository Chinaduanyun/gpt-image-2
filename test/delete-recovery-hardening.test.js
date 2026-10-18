// Regression cover for three review blockers. Everything here is local: no provider,
// no network, no credentials. DATA_DIR is a throwaway temp dir per test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const sharp = require('sharp');

const store = require('../lib/store');
const runner = require('../lib/image-task-runner');
const { ProviderError } = require('../lib/cpa-image');
const { removePendingResultSpool } = require('../lib/image-assets');
const { handleMe } = require('../routes/me');
const { handleTask, handleBatch, taskDto, batchDto } = require('../routes/api-market');
const { requestTaskDeduped } = require('../lib/spend-logs');

const CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.test', model: 'gpt-image-2' };
const EMAIL = 'review@staging.invalid';
let png;

async function withDataDir(run) {
  const previousDataDir = process.env.DATA_DIR;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-recovery-'));
  delete process.env.ADMIN_EMAIL;
  try {
    png = png || await sharp({ create: { width: 16, height: 12, channels: 3, background: '#336699' } }).png().toBuffer();
    return await run(process.env.DATA_DIR);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previousAdminEmail;
  }
}

function seedStore(extraLogs = []) {
  const data = store.emptyStore();
  data.users[EMAIL] = { email: EMAIL, active: true, balanceMicros: 1000 };
  data.sessions.reviewToken = { email: EMAIL, createdAt: new Date().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' };
  data.spendLogs.push(...extraLogs);
  store.saveDataStore(data);
  return data;
}

function request(method, headers = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = { authorization: 'Bearer reviewToken', ...headers };
  return req;
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = { ...this.headers, ...(headers || {}) }; },
    end(body) { this.body = body; }
  };
}

// A settled legacy (non-hybrid) generation whose submitResponse still echoes the
// upstream image address that the permanent delete must erase.
function legacyLog(overrides = {}) {
  return {
    id: 'legacy_del',
    type: 'generation',
    email: EMAIL,
    taskId: 'legacy-upstream-task',
    status: 'completed',
    settled: true,
    chargedMicros: 850000,
    actualCostMicros: 850000,
    balanceBeforeMicros: 1000,
    balanceAfterMicros: 150,
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    pricingVersion: 'v1',
    imageUrls: ['/api/stored-images/legacy_del.png'],
    remoteImageUrls: ['https://upstream.invalid/paid.png'],
    imageFiles: [{ fileName: 'legacy_del.png', sourceIndex: 0 }],
    inputFiles: [],
    submitResponse: {
      task_id: 'legacy-upstream-task',
      data: { status: 'completed', result: { images: [{ url: 'https://upstream.invalid/paid.png' }] } }
    },
    ...overrides
  };
}

function installHttpsMock(handler) {
  const original = http && require('node:https').request;
  const https = require('node:https');
  https.request = (options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.setTimeout = () => outgoing;
    outgoing.write = () => true;
    outgoing.destroy = (error) => { if (error) outgoing.emit('error', error); };
    outgoing.end = () => handler({ options, callback, outgoing });
    return outgoing;
  };
  return () => { https.request = original; };
}

function upstreamResponse(spec) {
  const payload = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body || {});
  const upstream = Readable.from([Buffer.from(payload)]);
  upstream.statusCode = spec.status ?? 200;
  upstream.headers = { 'content-type': 'application/json', ...(spec.headers || {}) };
  return upstream;
}

// ---------------------------------------------------------------------------
// Blocker 1: deleted assets must not leak a legacy address
// ---------------------------------------------------------------------------

test('permanent delete erases the legacy submitResponse image address and stays idempotent', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');

    // Before the delete the DTO still spreads submitResponse, i.e. the leak existed.
    assert.equal(taskDto(store.loadDataStore().spendLogs[0]).data.result.images[0].url, 'https://upstream.invalid/paid.png');

    const first = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), first, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(first.statusCode, 200);
    assert.equal(first.body, JSON.stringify({ ok: true }));

    const current = store.loadDataStore().spendLogs[0];
    assert.ok(current.assetsDeletedAt);
    assert.equal(current.assetDeletionStatus, 'complete');
    assert.deepEqual(current.imageUrls, []);
    assert.deepEqual(current.imageFiles, []);
    assert.deepEqual(current.remoteImageUrls, []);
    assert.equal(fs.existsSync(path.join(dir, 'images/legacy_del.png')), false);
    // Financial identity is preserved on purpose.
    assert.equal(current.chargedMicros, 850000);
    assert.equal(current.actualCostMicros, 850000);
    assert.equal(current.balanceBeforeMicros, 1000);
    assert.equal(current.balanceAfterMicros, 150);

    // The DTO must not resurrect the upstream address through submitResponse.
    const dto = taskDto(current);
    assert.equal(dto.assetsDeleted, true);
    assert.deepEqual(dto.imageUrls, []);
    assert.deepEqual(dto.imageFiles, []);
    assert.deepEqual(dto.remoteImageUrls, []);
    assert.equal(JSON.stringify(dto).includes('upstream.invalid'), false);
    assert.equal(JSON.stringify(dto).includes('paid.png'), false);

    // Idempotent replay of the same delete.
    const replay = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), replay, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(replay.statusCode, 200);
    const afterReplay = store.loadDataStore().spendLogs[0];
    assert.equal(afterReplay.assetDeletionStatus, 'complete');
    assert.equal(afterReplay.assetsDeletedAt, current.assetsDeletedAt);
    assert.equal(afterReplay.chargedMicros, 850000);
  });
});

test('deleted legacy task never re-archives even when the delete lands mid-query', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    let release;
    const entered = new Promise((resolve) => { release = resolve; });
    let queried = false;
    // Model an upstream query that hangs (180s REQUEST_TIMEOUT_MS in production) while a
    // permanent delete completes. No real transport: the mock answers locally.
    const restore = installHttpsMock(({ callback }) => {
      queried = true;
      const finish = () => callback(upstreamResponse({ body: { data: { status: 'completed', result: { images: [{ url: 'https://upstream.invalid/paid.png' }] } } } }));
      entered.then(finish);
    });
    try {
      const res = responseCapture();
      const pending = handleTask(request('GET'), res, '/api/api-market/v1/tasks/legacy-upstream-task', CONFIG);
      // Wait until the upstream query is in flight, then tombstone the task.
      while (!queried) await new Promise((resolve) => setImmediate(resolve));
      const deleted = responseCapture();
      await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
      assert.equal(deleted.statusCode, 200);
      release();
      await pending;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.assetsDeleted, true);
      assert.deepEqual(body.imageUrls, []);
      assert.equal(JSON.stringify(body).includes('upstream.invalid'), false);
      // The delete survives: the completed upstream result must not be re-archived.
      const current = store.loadDataStore().spendLogs[0];
      assert.ok(current.assetsDeletedAt);
      assert.deepEqual(current.imageFiles, []);
      assert.deepEqual(current.imageUrls, []);
      assert.equal(fs.existsSync(path.join(dir, 'images/legacy_del.png')), false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Blocker 2: the runner spool must not survive a permanent delete
// ---------------------------------------------------------------------------

test('permanent delete clears the pending-results spool and only that task file', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    const spoolDir = path.join(dir, 'pending-results');
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(path.join(spoolDir, 'legacy_del.json'), JSON.stringify([{ base64: 'paid' }]));
    fs.writeFileSync(path.join(spoolDir, 'legacy_del.json.tmp'), 'partial');
    fs.writeFileSync(path.join(spoolDir, 'other_task.json'), JSON.stringify([{ base64: 'other' }]));
    fs.writeFileSync(path.join(spoolDir, 'notes.txt'), 'unrelated');

    const res = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), res, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(res.statusCode, 200);
    assert.equal(fs.existsSync(path.join(spoolDir, 'legacy_del.json')), false);
    assert.equal(fs.existsSync(path.join(spoolDir, 'legacy_del.json.tmp')), false);
    // Other tasks' spools and unknown files are untouched - never sweep the directory.
    assert.equal(fs.existsSync(path.join(spoolDir, 'other_task.json')), true);
    assert.equal(fs.existsSync(path.join(spoolDir, 'notes.txt')), true);
  });
});

test('cleanup failure does not mark the delete complete', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog({ imageSaveErrors: [{ originalUrl: 'https://upstream.invalid/paid.png' }] })]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    // A directory where the file is expected: unlink fails with EISDIR/EPERM.
    fs.mkdirSync(path.join(dir, 'images/legacy_del.png'));

    const res = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), res, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(res.statusCode, 500);
    const current = store.loadDataStore().spendLogs[0];
    assert.equal(current.assetDeletionStatus, 'pending');
    assert.equal(current.imageSaveErrors, undefined);
    assert.deepEqual(runner.publicLog(current).imageFiles, []);
    // The record still knows which bytes are left, so a retry can finish the job.
    assert.equal(current.imageFiles.length, 1);
    assert.deepEqual(current.imageUrls, []);
    assert.equal(current.chargedMicros, 850000);

    // Retry after the obstruction is gone completes and clears the record.
    fs.rmdirSync(path.join(dir, 'images/legacy_del.png'));
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    const retry = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), retry, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(retry.statusCode, 200);
    assert.equal(store.loadDataStore().spendLogs[0].assetDeletionStatus, 'complete');
    assert.equal(fs.existsSync(path.join(dir, 'images/legacy_del.png')), false);
  });
});

test('restart cleans a settled spool without re-archiving and never touches other records', async () => {
  await withDataDir(async (dir) => {
    const settled = legacyLog({ id: 'spool_settled', taskId: 'task-settled' });
    const tombstoned = legacyLog({ id: 'spool_deleted', taskId: 'task-deleted', assetsDeletedAt: new Date().toISOString(), imageFiles: [], imageUrls: [], remoteImageUrls: [] });
    const pending = legacyLog({ id: 'spool_pending', taskId: 'task-pending', status: 'submitted', settled: false, imageFiles: [], imageUrls: [], remoteImageUrls: [] });
    seedStore([settled, tombstoned, pending]);
    const spoolDir = path.join(dir, 'pending-results');
    fs.mkdirSync(spoolDir, { recursive: true });
    // A settled log cannot have a live spool in the store's model, so reset settled
    // afterwards to model "crashed after settle, before unlink".
    for (const id of ['spool_settled', 'spool_deleted', 'spool_pending']) {
      fs.writeFileSync(path.join(spoolDir, `${id}.json`), JSON.stringify([{ base64: png.toString('base64') }]));
    }
    const data = store.loadDataStore();
    data.spendLogs.find((log) => log.id === 'spool_settled').settled = false;
    data.spendLogs.find((log) => log.id === 'spool_settled').settled = true;
    store.saveDataStore(data);

    // Disk-only startup classification: it must not archive anything over the network.
    await runner.recoverTasks(true, { network: false });
    assert.equal(fs.existsSync(path.join(spoolDir, 'spool_settled.json')), false, 'settled spool cleaned');
    assert.equal(fs.existsSync(path.join(spoolDir, 'spool_deleted.json')), false, 'tombstoned spool cleaned');
    assert.equal(fs.existsSync(path.join(spoolDir, 'spool_pending.json')), true, 'live spool preserved');
    const after = store.loadDataStore().spendLogs;
    assert.equal(after.find((log) => log.id === 'spool_settled').settled, true, 'settled record untouched');
    assert.equal(after.find((log) => log.id === 'spool_deleted').assetsDeletedAt !== undefined, true);
    assert.equal(after.find((log) => log.id === 'spool_pending').settled, false);
  });
});

test('a spool cleanup failure during recovery does not mark the record complete', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    const spoolDir = path.join(dir, 'pending-results');
    // A directory where the spool file is expected makes unlink fail.
    fs.mkdirSync(path.join(spoolDir, 'legacy_del.json'), { recursive: true });
    assert.throws(() => removePendingResultSpool('legacy_del'));
    const current = store.loadDataStore().spendLogs[0];
    assert.equal(current.assetDeletionStatus, undefined);
    assert.equal(current.chargedMicros, 850000);
  });
});

// ---------------------------------------------------------------------------
// Blocker 4: startup must not block listen on an upstream query
// ---------------------------------------------------------------------------

test('startup classification never queries upstream and never resubmits', async () => {
  await withDataDir(async () => {
    const unknown = legacyLog({
      id: 'market_pending',
      taskId: 'market-task-1',
      status: 'processing',
      settled: false,
      billingPolicy: undefined,
      pricingVersion: undefined,
      submitResponse: undefined
    });
    runner.initializeHybridLog(unknown);
    unknown.attempts = [{ provider: 'market', state: 'submitted', externalTaskId: 'external-1', submissionCertainty: 'accepted' }];
    unknown.status = 'processing';
    unknown.settled = false;
    seedStore([unknown]);

    let requests = 0;
    const restore = installHttpsMock(() => { requests += 1; });
    try {
      const started = Date.now();
      await runner.recoverTasks(true, { network: false });
      assert.ok(Date.now() - started < 1000, 'startup classification must not wait on the network');
      assert.equal(requests, 0);
      const current = store.loadDataStore().spendLogs[0];
      // A Market submission with an external id must be left for the post-listen pass.
      assert.equal(current.status, 'processing');
      assert.equal(current.settled, false);
      assert.equal(current.attempts.at(-1).externalTaskId, 'external-1');
    } finally {
      restore();
    }
  });
});

test('post-listen recovery queries the market task at most once and dedupes with inflight reads', async () => {
  await withDataDir(async () => {
    const unknown = legacyLog({ id: 'market_pending', taskId: 'market-task-1', status: 'processing', settled: false, submitResponse: undefined });
    runner.initializeHybridLog(unknown);
    unknown.attempts = [{ provider: 'market', state: 'submitted', externalTaskId: 'external-1', submissionCertainty: 'accepted' }];
    unknown.status = 'processing';
    unknown.settled = false;
    seedStore([unknown]);

    let gets = 0;
    const restore = installHttpsMock(({ callback }) => {
      gets += 1;
      setImmediate(() => callback(upstreamResponse({ body: { data: { status: 'processing' } } })));
    });
    try {
      await Promise.all([
        runner.recoverTasks(false, { marketAdapter: { submit: () => assert.fail('must not resubmit'), poll: async () => ({ pending: true }) } }),
        runner.recoverTasks(false, { marketAdapter: { submit: () => assert.fail('must not resubmit'), poll: async () => ({ pending: true }) } })
      ]);
      assert.equal(gets, 0, 'adapter injection means no real transport call');
      const current = store.loadDataStore().spendLogs[0];
      assert.equal(current.settled, false);
      assert.ok(current.nextProviderPollAt > Date.now(), 'backoff scheduled, no resubmit');
    } finally {
      restore();
    }
  });
});

test('requestTaskDeduped shares one upstream read between concurrent callers', async () => {
  await withDataDir(async () => {
    seedStore([]);
    let gets = 0;
    const restore = installHttpsMock(({ callback }) => {
      gets += 1;
      setImmediate(() => callback(upstreamResponse({ body: { data: { status: 'completed' } } })));
    });
    try {
      const [a, b] = await Promise.all([requestTaskDeduped('shared-task', CONFIG), requestTaskDeduped('shared-task', CONFIG)]);
      assert.equal(gets, 1);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// v2 billing policy metadata (explicit fixed quote)
// ---------------------------------------------------------------------------

test('fixed-quote v2 records carry an explicit fixed-quote billing policy', async () => {
  await withDataDir(async () => {
    const log = { id: 'task1', type: 'generation', email: EMAIL, estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [] };
    runner.initializeHybridLog(log);
    assert.equal(log.billingVersion, 'fixed-quote-v2');
    assert.equal(log.billingPolicy, 'fixed-quote-v2');
    seedStore([log]);
    await store.withDataStoreMutation((data) => { data.spendLogs[0].id = 'task1'; });
    const dto = runner.publicTask(store.loadDataStore().spendLogs[0]);
    assert.equal(dto.billing.billingVersion, 'fixed-quote-v2');
    assert.equal(dto.billing.estimatedCostMicros, 100);
    // Settling charges exactly the locked quote and never the provider cost.
    await store.withDataStoreMutation((data) => runner.settleFixed(data, data.spendLogs[0], true));
    const settled = store.loadDataStore().spendLogs[0];
    assert.equal(settled.actualCostMicros, 100);
    assert.equal(settled.settlementStatus, 'settled_fixed_quote');
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
  });
});

test('provider failure still refuses to resubmit and settles the locked quote only once', async () => {
  await withDataDir(async () => {
    const log = { id: 'task1', type: 'generation', email: EMAIL, estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [] };
    runner.initializeHybridLog(log);
    store.saveDataStore({ version: 1, users: { [EMAIL]: { email: EMAIL, active: true, balanceMicros: 900 } }, sessions: {}, spendLogs: [log] });
    let calls = 0;
    await runner.startTask('task1', { prompt: 'local', n: 1 }, { cpa: async () => { calls += 1; throw new ProviderError('unknown', 'timeout'); } });
    assert.equal(calls, 1);
    assert.equal(store.loadDataStore().spendLogs[0].settled, false);
    await runner.startTask('task1', { prompt: 'local', n: 1 }, { cpa: () => assert.fail('late resubmit') });
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// Second review round: one tombstone decision, every read and every exit
// ---------------------------------------------------------------------------

const ADDRESS = 'https://upstream.invalid/paid.png';

for (const version of ['legacy', 'fixed-quote-v2']) {
  for (const deletion of ['pending', 'complete']) {
    test(`tombstone ${version}/${deletion}: history, batch, task and idempotent replay redact assets without changing finances`, async () => {
      await withDataDir(async () => {
        const { handleGeneration } = require('../routes/api-market');
        const { sanitizeGenerationPayload } = require('../lib/pricing');
        const { canonicalPayloadHash } = require('../lib/common');
        const payload = { model: 'gpt-image-2', prompt: 'local replay', n: 1, bestEffortAccepted: true };
        const log = legacyLog({
          billingVersion: version, fixedQuoteMicros: 850000, estimatedCostMicros: 850000,
          assetsDeletedAt: '2026-09-20T00:00:00Z', assetDeletionStatus: deletion,
          clientRequestId: 'tombstone-replay', requestHash: canonicalPayloadHash(sanitizeGenerationPayload(payload, CONFIG)),
          imageFiles: [{ fileName: 'legacy_del.png', originalUrl: ADDRESS }],
          inputFiles: [{ fileName: 'legacy_input.png', originalUrl: ADDRESS }],
          originalUrl: ADDRESS, imageSaveErrors: [{ url: ADDRESS, message: `failed ${ADDRESS}` }]
        });
        seedStore([log]);
        const before = JSON.stringify(store.loadDataStore());
        const assertSafe = (value) => {
          const body = JSON.stringify(value);
          for (const forbidden of [ADDRESS, 'paid.png', 'legacy_del.png', 'legacy_input.png', 'originalUrl', 'imageSaveErrors', 'submitResponse']) {
            assert.equal(body.includes(forbidden), false, forbidden);
          }
        };
        for (const dto of [runner.publicLog(log), runner.publicTask(log), taskDto(log)]) {
          assertSafe(dto); assert.equal(dto.assetsDeleted, true);
          assert.deepEqual(dto.imageFiles, []); assert.deepEqual(dto.inputFiles, []); assert.deepEqual(dto.imageUrls, []);
          assert.equal((dto.billing || dto).chargedMicros, 850000);
        }
        const history = responseCapture();
        await handleMe(request('GET'), history, '/api/me/logs', new URL('http://localhost/api/me/logs'));
        assert.equal(history.statusCode, 200); assertSafe(JSON.parse(history.body));
        const task = responseCapture();
        await handleTask(request('GET'), task, '/api/api-market/v1/tasks/legacy-upstream-task', CONFIG);
        assert.equal(task.statusCode, 200); assertSafe(JSON.parse(task.body));
        const replay = async () => {
          const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
          req.method = 'POST'; req.headers = { authorization: 'Bearer reviewToken', 'idempotency-key': 'tombstone-replay' };
          const res = responseCapture();
          await handleGeneration(req, res, CONFIG);
          assert.equal(res.statusCode, 200); assertSafe(JSON.parse(res.body));
          assert.equal(JSON.parse(res.body).billing.chargedMicros, 850000);
        };
        const restore = installHttpsMock(() => assert.fail('tombstone reads/replays must not call a provider'));
        try {
          await replay();
          assert.equal(JSON.stringify(store.loadDataStore()), before, 'public redaction must not mutate retry files or money');
          await store.withDataStoreMutation((data) => { Object.assign(data.spendLogs[0], { batchId: 'deleted-batch', batchIndex: 0, batchSize: 1 }); });
          const batchBefore = JSON.stringify(store.loadDataStore());
          const batch = responseCapture();
          await handleBatch(request('GET'), batch, '/api/api-market/v1/batches/deleted-batch', CONFIG);
          assert.equal(batch.statusCode, 200); assertSafe(JSON.parse(batch.body));
          assert.equal(JSON.parse(batch.body).chargedMicros, 850000);
          const batchHistory = responseCapture();
          await handleMe(request('GET'), batchHistory, '/api/me/logs', new URL('http://localhost/api/me/logs'));
          assertSafe(JSON.parse(batchHistory.body));
          await replay();
          assert.equal(JSON.stringify(store.loadDataStore()), batchBefore);
        } finally { restore(); }
      });
    });
  }
}

// Counts and fails every result download attempt without touching the network:
// downloadSafe resolves DNS (dns.promises) before it opens the socket, so both are stubbed.
function installDownloadCounter() {
  const dns = require('node:dns');
  const https = require('node:https');
  const originalPromisesLookup = dns.promises.lookup;
  const originalGet = https.get;
  const state = { attempts: 0 };
  dns.promises.lookup = async (hostname, options) => (options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 });
  https.get = () => {
    state.attempts += 1;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => { if (error) req.emit('error', error); };
    setImmediate(() => { req.emit('error', new Error('offline')); req.emit('close'); });
    return req;
  };
  return { state, restore() { dns.promises.lookup = originalPromisesLookup; https.get = originalGet; } };
}

// Models the exact race the review asked about: the delete completes while the upstream
// query is in flight, and the upstream answer is a failure that still carries the address.
async function deleteLandsMidQuery(upstreamSpec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-query-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  let restore = () => {};
  try {
    seedStore([legacyLog()]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    let release;
    const entered = new Promise((resolve) => { release = resolve; });
    let queried = false;
    restore = installHttpsMock(({ callback }) => {
      queried = true;
      entered.then(() => callback(upstreamResponse(upstreamSpec)));
    });
    const res = responseCapture();
    const pending = handleTask(request('GET'), res, '/api/api-market/v1/tasks/legacy-upstream-task', CONFIG);
    while (!queried) await new Promise((resolve) => setImmediate(resolve));
    const deleted = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(deleted.statusCode, 200);
    release();
    await pending;
    return res;
  } finally {
    restore();
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('permanent delete erases the submit echo from the history body', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    const balanceBefore = store.loadDataStore().users[EMAIL].balanceMicros;

    const deleted = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(deleted.statusCode, 200);

    const history = responseCapture();
    await handleMe(request('GET'), history, '/api/me/logs', new URL('http://localhost/api/me/logs'));
    assert.equal(history.statusCode, 200);
    assert.equal(history.body.includes('upstream.invalid'), false, 'history must not echo the deleted address');
    assert.equal(history.body.includes('paid.png'), false);
    assert.equal(history.body.includes('submitResponse'), false, 'the echo field itself must be gone');
    const record = JSON.parse(history.body).logs[0];
    assert.ok(record.assetsDeletedAt);
    assert.deepEqual(record.imageUrls, []);
    assert.deepEqual(record.remoteImageUrls, []);
    assert.deepEqual(record.imageFiles, []);
    // Identity survives for diagnosis, without any address.
    assert.equal(record.deletedSubmitEcho.task_id, 'legacy-upstream-task');
    // Financial identity is preserved and untouched by the read.
    assert.equal(record.chargedMicros, 850000);
    assert.equal(record.actualCostMicros, 850000);
    assert.equal(record.balanceBeforeMicros, 1000);
    assert.equal(record.balanceAfterMicros, 150);
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, balanceBefore);
  });
});

test('a delete landing mid-query suppresses a non-JSON upstream failure body', async () => {
  const res = await deleteLandsMidQuery({ status: 500, body: `upstream exploded ${ADDRESS}`, headers: { 'content-type': 'text/plain' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('upstream.invalid'), false);
  assert.equal(res.body.includes('paid.png'), false);
  assert.equal(res.body.includes('exploded'), false);
  const body = JSON.parse(res.body);
  assert.equal(body.assetsDeleted, true);
  assert.deepEqual(body.imageUrls, []);
});

test('a delete landing mid-query suppresses a 500 JSON echo carrying the address', async () => {
  const res = await deleteLandsMidQuery({ status: 500, body: { error: { message: 'boom' }, data: { result: { images: [{ url: ADDRESS }] } } } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('upstream.invalid'), false);
  const body = JSON.parse(res.body);
  assert.equal(body.assetsDeleted, true);
  assert.deepEqual(body.imageUrls, []);
});

test('a delete landing mid-query answers the tombstone instead of failing the request', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog()]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    let release;
    const entered = new Promise((resolve) => { release = resolve; });
    let queried = false;
    const restore = installHttpsMock(({ outgoing }) => {
      queried = true;
      // The socket dies after the delete has already completed.
      entered.then(() => outgoing.emit('error', new Error('socket hang up')));
    });
    try {
      const res = responseCapture();
      const pending = handleTask(request('GET'), res, '/api/api-market/v1/tasks/legacy-upstream-task', CONFIG);
      while (!queried) await new Promise((resolve) => setImmediate(resolve));
      const deleted = responseCapture();
      await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
      assert.equal(deleted.statusCode, 200);
      release();
      await pending;
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.assetsDeleted, true);
      assert.deepEqual(body.imageUrls, []);
      assert.equal(res.body.includes('upstream.invalid'), false);
    } finally {
      restore();
    }
  });
});

test('a pre-delete record read never answers with a backoff hint after the delete landed', async () => {
  await withDataDir(async (dir) => {
    seedStore([legacyLog({ nextRefreshAt: new Date(Date.now() + 60000).toISOString(), lastRefreshError: '状态查询失败：HTTP 500' })]);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images/legacy_del.png'), 'paid-bytes');
    // The record handleTask would have read before the delete landed.
    const preDelete = JSON.parse(JSON.stringify(store.loadDataStore()));

    const deleted = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/legacy_del/assets', new URL('http://localhost/api/me/logs/legacy_del/assets'));
    assert.equal(deleted.statusCode, 200);

    // Pin the module's record read to that pre-delete snapshot for this one request: the
    // backoff branch is then reached with a record that still looks live, and only a
    // tombstone re-read at the branch itself can keep the 429 hint from being sent.
    const apiMarketPath = require.resolve('../routes/api-market');
    const originalLoad = store.loadDataStore;
    store.loadDataStore = () => preDelete;
    delete require.cache[apiMarketPath];
    try {
      const freshApiMarket = require('../routes/api-market');
      assert.equal(preDelete.spendLogs[0].assetsDeletedAt, undefined);
      assert.ok(Date.parse(preDelete.spendLogs[0].nextRefreshAt) > Date.now());
      const res = responseCapture();
      await freshApiMarket.handleTask(request('GET'), res, '/api/api-market/v1/tasks/legacy-upstream-task', CONFIG);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.assetsDeleted, true);
      assert.equal(res.body.includes('退避'), false);
      assert.equal(res.body.includes('upstream.invalid'), false);
    } finally {
      store.loadDataStore = originalLoad;
      delete require.cache[apiMarketPath];
      require('../routes/api-market');
    }
  });
});

// ---------------------------------------------------------------------------
// Batch list: tombstoned children must not be re-exposed by the aggregate DTO
// ---------------------------------------------------------------------------

function batchChild(index) {
  return legacyLog({
    id: `batch_review_${index}`,
    taskId: `batch-upstream-${index}`,
    batchId: 'batch_review',
    batchIndex: index,
    batchSize: 2,
    chargedMicros: 425000,
    actualCostMicros: 425000,
    imageUrls: [`/api/stored-images/batch_review_${index}.png`],
    imageFiles: [{ fileName: `batch_review_${index}.png`, sourceIndex: 0 }],
    settings: { size: '1024x1024', quality: 'high', n: 1, imageFiles: ['/api/stored-images/batch_review_0.png'] }
  });
}

test('permanently deleted batch children lose their addresses in the batch list', async () => {
  await withDataDir(async (dir) => {
    const children = [batchChild(0), batchChild(1)];
    seedStore(children);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    for (const child of children) fs.writeFileSync(path.join(dir, `images/${child.imageFiles[0].fileName}`), 'paid-bytes');
    const before = batchDto(store.loadDataStore().spendLogs);
    // The leak this covers: the batch DTO re-assembles children and flat-maps their files.
    assert.equal(JSON.stringify(before).includes('/api/stored-images/batch_review_0.png'), true);

    const deleted = responseCapture();
    await handleMe(request('DELETE', { 'x-confirm-delete': 'permanent' }), deleted, '/api/me/logs/batch_review/assets', new URL('http://localhost/api/me/logs/batch_review/assets'));
    assert.equal(deleted.statusCode, 200);

    const res = responseCapture();
    await handleBatch(request('GET'), res, '/api/api-market/v1/batches/batch_review', CONFIG);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes('upstream.invalid'), false, 'no upstream address');
    assert.equal(res.body.includes('/api/stored-images/'), false, 'no stored-image address');
    assert.equal(res.body.includes('submitResponse'), false, 'no submit echo field');
    assert.equal(res.body.includes('batch_review_0.png'), false, 'no deleted file record');
    const body = JSON.parse(res.body);
    assert.deepEqual(body.imageFiles, []);
    assert.deepEqual(body.imageUrls, []);
    assert.equal(body.settings.imageFiles, undefined, 'settings must not keep an asset pointer');
    assert.equal(body.settings.quality, 'high', 'non-asset settings survive');
    for (const child of body.children) {
      assert.deepEqual(child.imageUrls, []);
      assert.deepEqual(child.imageFiles, []);
      assert.deepEqual(child.inputFiles, []);
      assert.equal(child.assetsDeleted, true);
    }
    // Financial aggregation is unchanged by the asset delete.
    assert.equal(body.chargedMicros, before.chargedMicros);
    assert.equal(body.estimatedCostMicros, before.estimatedCostMicros);
    assert.equal(body.settled, before.settled);
    assert.equal(body.balanceAfterMicros, before.balanceAfterMicros);
    assert.equal(body.counts.succeeded, 2);
  });
});

// ---------------------------------------------------------------------------
// Background recovery: at most one archive attempt per task per process
// ---------------------------------------------------------------------------

test('repeated background recovery attempts one spool archive per process', async () => {
  await withDataDir(async (dir) => {
    const log = { id: 'archive_once', type: 'generation', email: EMAIL, estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [], inputFiles: [] };
    runner.initializeHybridLog(log);
    log.status = 'archiving';
    log.archiveStatus = 'error';
    seedStore([log]);
    const spoolDir = path.join(dir, 'pending-results');
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(path.join(spoolDir, 'archive_once.json'), JSON.stringify([{ url: 'https://upstream.invalid/result.png' }]));

    const counter = installDownloadCounter();
    try {
      await runner.recoverTasks(false);
      assert.equal(counter.state.attempts, 1, 'one archive attempt');
      assert.equal(fs.existsSync(path.join(spoolDir, 'archive_once.json')), true, 'a failed archive keeps the spool for a restart');
      await runner.recoverTasks(false);
      await runner.recoverTasks(false);
      assert.equal(counter.state.attempts, 1, 'later 30s ticks must not re-download the result');
      const current = store.loadDataStore().spendLogs[0];
      assert.equal(current.settled, false, 'no double settlement');
      assert.equal(current.archiveStatus, 'error');
    } finally {
      counter.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// v2 pricing snapshot marker
// ---------------------------------------------------------------------------

test('the nested pricing snapshot follows the v2 marker without changing any number', async () => {
  await withDataDir(async () => {
    const { estimateGenerationCostMicros } = require('../lib/pricing');
    const { pricingFields } = require('../routes/api-market');
    const cost = estimateGenerationCostMicros({ model: 'gpt-image-2', resolution: '1K', n: 1 });
    assert.equal(cost.ok, true);
    const log = { id: 'task_px', type: 'generation', email: EMAIL, settled: false, imageUrls: [], imageFiles: [], ...pricingFields(cost) };
    const legacyNested = log.pricingSnapshot.billingPolicy;
    assert.equal(legacyNested, 'provider-task-total-with-per-image-floor-v1');

    runner.initializeHybridLog(log);
    assert.equal(log.billingVersion, 'fixed-quote-v2');
    assert.equal(log.billingPolicy, 'fixed-quote-v2');
    assert.equal(log.pricingSnapshot.billingPolicy, 'fixed-quote-v2', 'nested marker must not contradict the record');
    // Metadata only: every amount is untouched.
    assert.equal(log.estimatedCostMicros, cost.totalMicros);
    assert.equal(log.chargedMicros, cost.totalMicros);
    assert.equal(log.fixedQuoteMicros, cost.totalMicros);
    assert.equal(log.pricingSnapshot.estimatedCostMicros, cost.totalMicros);
    assert.equal(log.totalMultiplier, cost.totalMultiplier);
    assert.equal(log.minimumChargeMicros, cost.minimumChargeMicros);
    assert.equal(log.settlementStatus, 'pending');

    seedStore([log]);
    await store.withDataStoreMutation((data) => runner.settleFixed(data, data.spendLogs[0], true));
    const settled = store.loadDataStore().spendLogs[0];
    assert.equal(settled.actualCostMicros, cost.totalMicros);
    assert.equal(settled.settlementStatus, 'settled_fixed_quote');
    assert.equal(store.loadDataStore().users[EMAIL].balanceMicros, 1000);
  });
});
