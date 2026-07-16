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
const { estimateGenerationCostMicros } = require('../lib/pricing');
const {
  findTaskLocation,
  applyTaskJsonToLog,
  flattenGenerationLogs,
  logNeedsRefresh,
  mergeArchivedImages,
  refreshLogsFromUpstream
} = require('../lib/spend-logs');
const { saveImagesForLog, hasCompleteImageArchive } = require('../lib/image-store');
const {
  createBatchLogs,
  getBatchLogs,
  batchDto,
  handleGeneration,
  handleBatch
} = require('../routes/api-market');
const { handlePublicConfig } = require('../routes/public-config');
const { handleMe, getLogsForEmail } = require('../routes/me');
const { getStaticPath } = require('../routes/static');

const CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.test', model: 'gpt-image-2' };

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

function quickPayload(n = 4) {
  return { model: 'gpt-image-2', prompt: 'four concepts', size: '1:1', resolution: '1k', n };
}

function makeBatchLogs(n = 4, batchId = 'batch_fixture') {
  const payload = quickPayload(n);
  const childCost = estimateGenerationCostMicros({ ...payload, n: 1 });
  return createBatchLogs({
    batchId, email: 'user@example.com', payload, childCost,
    balanceBefore: 10000000, clientRequestId: 'fixture-key', requestHash: 'fixture-hash',
    timestamp: '2026-07-10T00:00:00.000Z'
  });
}

test('quick batch feature flag and pricing expose n=1..4 linear per-child charges', () => {
  const res = responseCapture();
  handlePublicConfig({ method: 'GET' }, res);
  const publicConfig = JSON.parse(res.body);
  assert.equal(publicConfig.features.quickBatchEnabled, true);

  for (let n = 1; n <= 4; n += 1) {
    const estimate = estimateGenerationCostMicros(quickPayload(n));
    assert.equal(estimate.ok, true);
    assert.equal(estimate.billingImageCount, n);
    assert.equal(estimate.minimumChargeMicros, 300000 * n);
    assert.equal(estimate.unitMicros, 306000);
    assert.equal(estimate.totalMicros, 306000 * n);
  }
});

test('n=4 precharges atomically before four simultaneous n=1 upstream submits and preserves DTO order', { concurrency: false }, async () => {
  await withDataDir(async () => {
    seedStore();
    let started = 0;
    let release;
    const releaseAll = new Promise((resolve) => { release = resolve; });
    const bodies = [];
    const restore = installHttpsMock(({ callback, requestBody }) => {
      const index = started++;
      bodies[index] = JSON.parse(requestBody);
      releaseAll.then(() => setImmediate(() => callback(upstreamResponse({ body: { data: { task_id: `task_${index}` } } }))));
    });

    try {
      const res = responseCapture();
      const submission = handleGeneration(
        request('POST', quickPayload(4), 'userToken', { 'idempotency-key': 'batch-key' }), res, CONFIG
      );
      while (started < 4) await new Promise((resolve) => setImmediate(resolve));

      const precharged = loadDataStore();
      assert.equal(precharged.users['user@example.com'].balanceMicros, 8776000);
      assert.equal(precharged.spendLogs.length, 4);
      assert.deepEqual(precharged.spendLogs.map((log) => log.batchIndex), [0, 1, 2, 3]);
      assert.deepEqual(precharged.spendLogs.map((log) => log.chargedMicros), [306000, 306000, 306000, 306000]);
      assert.deepEqual(precharged.spendLogs.map((log) => log.settings.n), [1, 1, 1, 1]);
      assert.deepEqual(bodies.map((body) => body.n), [1, 1, 1, 1]);

      release();
      await submission;
      const dto = JSON.parse(res.body);
      assert.equal(res.statusCode, 202);
      assert.equal(dto.kind, 'batch');
      assert.equal(dto.batchId, precharged.spendLogs[0].batchId);
      assert.equal(dto.clientRequestId, 'batch-key');
      assert.equal(dto.requestedCount, 4);
      assert.deepEqual(dto.children.map((child) => child.index), [0, 1, 2, 3]);
      assert.deepEqual(dto.children.map((child) => child.taskId), ['task_0', 'task_1', 'task_2', 'task_3']);
      assert.deepEqual(dto.children.map((child) => child.status), ['submitted', 'submitted', 'submitted', 'submitted']);
      assert.deepEqual(dto.counts, { pending: 0, submitting: 0, processing: 4, succeeded: 0, failed: 0, unknown: 0 });
      assert.equal(dto.aggregateBilling.estimatedCostMicros, 1224000);
      assert.equal(dto.aggregateBilling.chargedMicros, 1224000);
      for (const child of dto.children) {
        assert.equal(child.billing.estimatedCostMicros, 306000);
        assert.equal(child.billing.minimumChargeMicros, 300000);
        assert.equal(child.billing.chargedMicros, 306000);
      }
    } finally {
      restore();
    }
  });
});

test('idempotency replays the original batch without charge or submit and conflicts on payload changes', { concurrency: false }, async () => {
  await withDataDir(async () => {
    seedStore();
    let calls = 0;
    const restore = installHttpsMock(({ callback }) => {
      const index = calls++;
      setImmediate(() => callback(upstreamResponse({ body: { data: { task_id: `task_${index}` } } })));
    });
    try {
      const first = responseCapture();
      await handleGeneration(request('POST', quickPayload(2), 'userToken', { 'idempotency-key': 'same-key' }), first, CONFIG);
      const balanceAfterFirst = loadDataStore().users['user@example.com'].balanceMicros;
      assert.equal(calls, 2);

      const replay = responseCapture();
      await handleGeneration(request('POST', quickPayload(2), 'userToken', { 'idempotency-key': 'same-key' }), replay, CONFIG);
      assert.equal(replay.statusCode, 200);
      assert.equal(calls, 2);
      assert.equal(loadDataStore().users['user@example.com'].balanceMicros, balanceAfterFirst);
      assert.equal(JSON.parse(replay.body).batchId, JSON.parse(first.body).batchId);

      const conflict = responseCapture();
      await handleGeneration(request('POST', { ...quickPayload(3), prompt: 'different' }, 'userToken', { 'idempotency-key': 'same-key' }), conflict, CONFIG);
      assert.equal(conflict.statusCode, 409);
      assert.equal(JSON.parse(conflict.body).error.code, 'idempotency_conflict');
      assert.equal(calls, 2);
      assert.equal(loadDataStore().users['user@example.com'].balanceMicros, balanceAfterFirst);
    } finally {
      restore();
    }
  });
});

test('quick batches reject missing or invalid idempotency keys before debit or upstream submission', { concurrency: false }, async () => {
  await withDataDir(async () => {
    seedStore();
    for (const headers of [{}, { 'idempotency-key': 'x'.repeat(201) }]) {
      const res = responseCapture();
      await handleGeneration(request('POST', quickPayload(2), 'userToken', headers), res, CONFIG);
      assert.equal(res.statusCode, 400);
    }
    const stored = loadDataStore();
    assert.equal(stored.users['user@example.com'].balanceMicros, 10000000);
    assert.equal(stored.spendLogs.length, 0);
  });
});

test('feature flag shutdown still permits exact idempotent replay of an existing charged batch', { concurrency: false }, async () => {
  await withDataDir(async () => {
    seedStore();
    let calls = 0;
    const restore = installHttpsMock(({ callback }) => {
      calls += 1;
      setImmediate(() => callback(upstreamResponse({ body: { data: { task_id: `replay_${calls}` } } })));
    });
    try {
      const first = responseCapture();
      await handleGeneration(request('POST', quickPayload(2), 'userToken', { 'idempotency-key': 'flag-replay' }), first, { ...CONFIG, quickBatchEnabled: true });
      const balance = loadDataStore().users['user@example.com'].balanceMicros;
      const replay = responseCapture();
      await handleGeneration(request('POST', quickPayload(2), 'userToken', { 'idempotency-key': 'flag-replay' }), replay, { ...CONFIG, quickBatchEnabled: false });
      assert.equal(replay.statusCode, 200);
      assert.equal(JSON.parse(replay.body).batchId, JSON.parse(first.body).batchId);
      assert.equal(calls, 2);
      assert.equal(loadDataStore().users['user@example.com'].balanceMicros, balance);
    } finally {
      restore();
    }
  });
});

test('only definitive child submit failures refund; transient, transport, and ambiguous success remain charged unknown', { concurrency: false }, async () => {
  await withDataDir(async () => {
    seedStore();
    let index = 0;
    const specs = [
      { status: 400, body: { error: { message: 'bad request' } } },
      { status: 503, body: { error: { message: 'busy' } } },
      { error: new Error('socket reset') },
      { status: 200, body: { data: {} } }
    ];
    const restore = installHttpsMock(({ callback, outgoing }) => {
      const spec = specs[index++];
      setImmediate(() => {
        if (spec.error) outgoing.emit('error', spec.error);
        else callback(upstreamResponse(spec));
      });
    });
    try {
      const res = responseCapture();
      await handleGeneration(request('POST', quickPayload(4), 'userToken', { 'idempotency-key': 'fault-key' }), res, CONFIG);
      const stored = loadDataStore();
      const logs = getBatchLogs(stored, JSON.parse(res.body).batchId);
      const dto = batchDto(logs);
      assert.equal(res.statusCode, 202);
      assert.deepEqual(logs.map((log) => log.status), [
        'submit_failed_refunded', 'submission_unknown', 'submission_unknown', 'submission_unknown'
      ]);
      assert.deepEqual(logs.map((log) => log.chargedMicros), [0, 306000, 306000, 306000]);
      assert.deepEqual(logs.map((log) => log.settled), [true, false, false, false]);
      assert.equal(stored.users['user@example.com'].balanceMicros, 9082000);
      assert.equal(dto.chargedMicros, 918000);
      assert.equal(dto.balanceBeforeMicros, 10000000);
      assert.equal(dto.balanceAfterMicros, stored.users['user@example.com'].balanceMicros);
      assert.equal(dto.status, 'attention_required');
      assert.deepEqual(dto.counts, { pending: 0, submitting: 0, processing: 0, succeeded: 0, failed: 1, unknown: 3 });
    } finally {
      restore();
    }
  });
});

test('child traversal, settlement and aggregate billing keep a per-child floor and original image order', () => {
  const logs = makeBatchLogs(4);
  const data = { users: { 'user@example.com': { balanceMicros: 8776000 } }, spendLogs: logs };
  logs.forEach((log, index) => {
    log.status = 'submitted';
    log.taskId = `child_task_${index}`;
  });

  assert.equal(flattenGenerationLogs(logs).length, 4);
  assert.equal(findTaskLocation(data, 'child_task_2').log.batchIndex, 2);
  assert.equal(findTaskLocation(data, 'child_task_2').parent, null);

  applyTaskJsonToLog(data, logs[2], { data: { status: 'failed' } });
  for (const index of [0, 1, 3]) {
    applyTaskJsonToLog(data, logs[index], {
      data: { status: 'completed', cost: 0.0001, result: { images: [{ url: `https://images.test/${index}.png` }] } }
    });
    logs[index].imageUrls = [`/api/stored-images/${index}.png`];
  }

  assert.deepEqual(logs.map((log) => log.actualCostMicros), [300000, 300000, 0, 300000]);
  assert.deepEqual(logs.map((log) => log.chargedMicros), [300000, 300000, 0, 300000]);
  assert.equal(data.users['user@example.com'].balanceMicros, 9100000);

  const dto = batchDto(logs);
  assert.deepEqual(dto.children.map((child) => child.index), [0, 1, 2, 3]);
  assert.equal(dto.aggregateBilling.actualCostMicros, 900000);
  assert.equal(dto.aggregateBilling.settledActualCostMicros, 900000);
  assert.equal(dto.aggregateBilling.chargedMicros, 900000);
  assert.equal(dto.aggregateBilling.settled, true);
  assert.equal(dto.status, 'partial_success');
  assert.deepEqual(dto.imageUrls, [
    '/api/stored-images/0.png', '/api/stored-images/1.png', '/api/stored-images/3.png'
  ]);
});

test('batch polling is account-isolated before any child refresh', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = seedStore({ secondUser: true });
    const logs = makeBatchLogs(2, 'private_batch');
    logs.forEach((log, index) => {
      log.status = 'submitted';
      log.taskId = `private_${index}`;
    });
    data.spendLogs.push(...logs);
    saveDataStore(data);

    let calls = 0;
    const restore = installHttpsMock(() => { calls += 1; });
    try {
      const res = responseCapture();
      await handleBatch(request('GET', undefined, 'otherToken'), res, '/api/api-market/v1/batches/private_batch', CONFIG);
      assert.equal(res.statusCode, 403);
      assert.equal(calls, 0);
    } finally {
      restore();
    }
  });
});

test('history groups batch members, tombstones a settled batch, retains audit logs and rejects unsettled deletion', { concurrency: false }, async () => {
  await withDataDir(async (dataDir) => {
    const data = seedStore();
    const settled = makeBatchLogs(2, 'settled_batch');
    settled.forEach((log) => {
      log.status = 'completed';
      log.settled = true;
      log.actualCostMicros = 300000;
      log.chargedMicros = 300000;
    });
    const pending = makeBatchLogs(2, 'pending_batch');
    const inconsistent = makeBatchLogs(1, 'nonterminal_settled');
    inconsistent[0].status = 'processing';
    inconsistent[0].settled = true;
    data.spendLogs.push(...settled, ...pending, ...inconsistent);
    saveDataStore(data);

    const grouped = getLogsForEmail(data, 'user@example.com');
    assert.equal(grouped.length, 3);
    assert.equal(grouped.find((item) => item.batchId === 'settled_batch').children.length, 2);

    const deleteSettled = responseCapture();
    await handleMe(
      request('DELETE', undefined, 'userToken'), deleteSettled,
      '/api/me/logs/settled_batch', new URL('http://localhost/api/me/logs/settled_batch')
    );
    assert.equal(deleteSettled.statusCode, 200);
    const stored = loadDataStore();
    const tombstones = stored.spendLogs.filter((log) => log.batchId === 'settled_batch');
    assert.equal(tombstones.length, 2);
    assert.equal(tombstones.every((log) => log.hiddenFromHistory === true), true);
    assert.equal(tombstones.every((log) => log.cleanupStatus === 'cleanupComplete'), true);
    assert.equal(getLogsForEmail(stored, 'user@example.com').some((item) => item.batchId === 'settled_batch'), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'app-data.json')), true);

    const deletePending = responseCapture();
    await handleMe(
      request('DELETE', undefined, 'userToken'), deletePending,
      '/api/me/logs/pending_batch', new URL('http://localhost/api/me/logs/pending_batch')
    );
    assert.equal(deletePending.statusCode, 409);
    assert.equal(loadDataStore().spendLogs.filter((log) => log.batchId === 'pending_batch').some((log) => log.hiddenFromHistory), false);

    const deleteNonterminal = responseCapture();
    await handleMe(
      request('DELETE', undefined, 'userToken'), deleteNonterminal,
      '/api/me/logs/nonterminal_settled', new URL('http://localhost/api/me/logs/nonterminal_settled')
    );
    assert.equal(deleteNonterminal.statusCode, 409);
    assert.equal(loadDataStore().spendLogs.find((log) => log.batchId === 'nonterminal_settled').hiddenFromHistory, undefined);
  });
});

test('partial multi-image archival preserves slot order, retries missing files, and ignores tombstones', { concurrency: false }, async () => {
  await withDataDir(async () => {
    let secondAttempts = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/second.png' && secondAttempts++ === 0) {
        res.writeHead(503);
        res.end('retry');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('image-bytes'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const urls = [`http://127.0.0.1:${port}/first.png`, `http://127.0.0.1:${port}/second.png`];
    const log = { id: 'official_multi', imageFiles: [], imageUrls: [], remoteImageUrls: [] };
    try {
      await saveImagesForLog(log, urls);
      assert.equal(log.imageUrls.length, 2);
      assert.match(log.imageUrls[0], /^\/api\/stored-images\//);
      assert.equal(log.imageUrls[1], urls[1]);
      assert.equal(log.imageFiles.length, 1);
      assert.equal(hasCompleteImageArchive(log, urls), false);

      await saveImagesForLog(log, urls);
      assert.equal(log.imageUrls.length, 2);
      assert.equal(log.imageUrls.every((url) => url.startsWith('/api/stored-images/')), true);
      assert.equal(log.imageFiles.length, 2);
      assert.equal(hasCompleteImageArchive(log, urls), true);

      const hidden = { ...log, hiddenFromHistory: true, status: 'completed' };
      assert.equal(logNeedsRefresh(hidden), false);
      assert.equal(mergeArchivedImages(hidden, { imageUrls: ['/new.png'], remoteImageUrls: urls, imageFiles: [] }), false);
      assert.deepEqual(hidden.imageUrls, log.imageUrls);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('background refresh never applies non-2xx task JSON and backs off terminal cost gaps', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = seedStore();
    data.spendLogs.push({
      id: 'refresh_child', type: 'generation', email: 'user@example.com', taskId: 'refresh_task',
      status: 'submitted', chargedMicros: 306000, settled: false, createdAt: new Date().toISOString()
    });
    saveDataStore(data);
    const specs = [
      { status: 400, body: { data: { status: 'failed' } } },
      { status: 200, body: { data: { status: 'completed', result: { images: [] } } } }
    ];
    let index = 0;
    const restore = installHttpsMock(({ callback }) => {
      const spec = specs[index++];
      setImmediate(() => callback(upstreamResponse(spec)));
    });
    try {
      await refreshLogsFromUpstream(loadDataStore(), [loadDataStore().spendLogs[0]], CONFIG, 1);
      let stored = loadDataStore().spendLogs[0];
      assert.equal(stored.status, 'submitted');
      assert.equal(stored.settled, false);
      assert.equal(stored.chargedMicros, 306000);
      const retryData = loadDataStore();
      retryData.spendLogs[0].nextRefreshAt = '';
      saveDataStore(retryData);
      await refreshLogsFromUpstream(loadDataStore(), [loadDataStore().spendLogs[0]], CONFIG, 1);
      stored = loadDataStore().spendLogs[0];
      assert.equal(stored.status, 'completed');
      assert.equal(stored.settlementStatus, 'provider_cost_missing');
      assert.ok(Date.parse(stored.nextRefreshAt) > Date.now());
    } finally {
      restore();
    }
  });
});

test('static allowlist denies secret/config paths while official and legacy request contracts remain single-task compatible', { concurrency: false }, async () => {
  for (const pathname of ['/runtime.env', '/apimark.env', '/packy.env', '/poloai.env', '/config.local.js', '/.data/app-data.json', '/../runtime.env']) {
    assert.equal(getStaticPath(pathname), null, pathname);
  }
  assert.match(getStaticPath('/config.example.js'), /config\.example\.js$/);

  await withDataDir(async () => {
    seedStore();
    const bodies = [];
    const restore = installHttpsMock(({ callback, requestBody }) => {
      bodies.push(JSON.parse(requestBody));
      setImmediate(() => callback(upstreamResponse({ body: { data: { task_id: `single_${bodies.length}` } } })));
    });
    try {
      const official = responseCapture();
      await handleGeneration(request('POST', {
        model: 'gpt-image-2-official', prompt: 'official', size: '3:1', resolution: '1k', quality: 'low', n: 4
      }, 'userToken', { 'idempotency-key': 'official-key' }), official, CONFIG);
      assert.equal(official.statusCode, 200);
      assert.equal(JSON.parse(official.body).kind, 'task');
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].n, 4);

      const legacyAlias = responseCapture();
      await handleGeneration(request('POST', {
        model: 'gpt-image-2-ext', prompt: 'legacy alias', size: '1:1', resolution: '1k', n: 1
      }, 'userToken', { 'idempotency-key': 'alias-key' }), legacyAlias, CONFIG);
      assert.equal(legacyAlias.statusCode, 200);
      assert.equal(JSON.parse(legacyAlias.body).kind, 'task');
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1].model, 'gpt-image-2');
      assert.equal(bodies[1].n, 1);
    } finally {
      restore();
    }
  });
});



test('refunded closed single generation history is terminal and can be hidden', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = seedStore();
    data.spendLogs.push({
      id: 'refunded_closed', type: 'generation', email: 'user@example.com', status: 'submission_refunded_closed',
      settled: true, chargedMicros: 0, actualCostMicros: 0, imageUrls: [], imageFiles: []
    });
    saveDataStore(data);

    const response = responseCapture();
    await handleMe(
      request('DELETE', undefined, 'userToken'), response,
      '/api/me/logs/refunded_closed', new URL('http://localhost/api/me/logs/refunded_closed')
    );
    assert.equal(response.statusCode, 200);
    const stored = loadDataStore();
    assert.equal(stored.spendLogs.find((log) => log.id === 'refunded_closed').hiddenFromHistory, true);
    assert.equal(getLogsForEmail(stored, 'user@example.com').some((log) => log.id === 'refunded_closed'), false);
  });
});

