const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { emptyStore, loadDataStore, saveDataStore, withDataStoreMutation } = require('../lib/store');
const { canonicalPayloadHash } = require('../lib/common');
const { sanitizeGenerationPayload } = require('../lib/pricing');
const { isActive, activeRequestCount, taskWorkspace } = require('../lib/task-workspace');
const { handleAdmin } = require('../routes/admin');
const { handleLogout } = require('../routes/auth');
const { handleGeneration } = require('../routes/api-market');

const EMAIL = 'user@example.com';
const CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.test', model: 'gpt-image-2', quickBatchEnabled: true };
const PAYLOAD = { model: 'gpt-image-2', prompt: 'admission test', size: '1:1', resolution: '1k', n: 1 };

async function withDataDir(run) {
  const keys = ['DATA_DIR', 'ADMIN_EMAIL', 'IMAGE_PROVIDER_MODE', 'MAX_ACTIVE_REQUESTS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-admission-audit-'));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAIL;
  delete process.env.IMAGE_PROVIDER_MODE;
  process.env.MAX_ACTIVE_REQUESTS = '3';
  try {
    const data = emptyStore();
    data.users[EMAIL] = { email: EMAIL, active: true, balanceMicros: 10000000 };
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    for (const [token, email] of [['userToken', EMAIL], ['adminToken', 'admin@example.com']]) {
      data.sessions[token] = { email, expiresAt: '2999-01-01T00:00:00.000Z' };
    }
    saveDataStore(data);
    await run(dir);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function headers(req, method = 'POST', token = 'userToken', key = 'audit-key') {
  req.method = method;
  req.headers = { authorization: `Bearer ${token}`, 'idempotency-key': key };
  return req;
}
function request(body, method = 'POST', token = 'userToken', key) {
  return headers(Readable.from([Buffer.from(JSON.stringify(body))]), method, token, key);
}
function responseCapture() {
  return {
    statusCode: 0,
    setHeader() {},
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { this.body = body; }
  };
}
function mockProvider(t) {
  const original = https.request;
  let calls = 0;
  https.request = (options, callback) => {
    calls += 1;
    const outgoing = new EventEmitter();
    outgoing.setTimeout = () => outgoing;
    outgoing.write = () => true;
    outgoing.destroy = (error) => { if (error) outgoing.emit('error', error); };
    outgoing.end = () => {
      const upstream = Readable.from([Buffer.from(JSON.stringify({ data: { task_id: `audit_task_${calls}` } }))]);
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => callback(upstream));
    };
    return outgoing;
  };
  t.after(() => { https.request = original; });
  return () => calls;
}
async function admin(body, method, pathname) {
  const res = responseCapture();
  await handleAdmin(request(body, method, 'adminToken'), res, pathname, new URL(`http://localhost${pathname}`));
  return res;
}
function generationLog(id, extra = {}) {
  return { id, type: 'generation', email: EMAIL, status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

test('admin rejects malformed provided USD on create, overwrite and adjustment without target or audit changes', async () => {
  await withDataDir(async () => {
    const before = structuredClone(loadDataStore());
    const invalid = [null, true, false, {}, [], [1], '', ' ', '$', '￥  ', 'not-money', 'Infinity', '-Infinity', 'NaN', '1e400', '1e20', 1e20];
    const cases = [
      ['POST', '/api/admin/users', 'balanceUsd', { email: 'new@example.com' }],
      ['PATCH', '/api/admin/users/user%40example.com', 'balanceUsd', { name: 'must not change', active: false }],
      ['POST', '/api/admin/users/user%40example.com/balance', 'deltaUsd', { reason: 'must not audit' }]
    ];
    for (const [method, pathname, key, extra] of cases) {
      for (const value of invalid) {
        const res = await admin({ ...extra, [key]: value }, method, pathname);
        assert.equal(res.statusCode, 400, `${key}=${JSON.stringify(value)}`);
        assert.deepEqual(loadDataStore(), before);
      }
    }
    // A second, valid Micros field must not hide malformed provided USD.
    for (const [method, pathname, key, extra] of cases) {
      const microsKey = key === 'deltaUsd' ? 'deltaMicros' : 'balanceMicros';
      assert.equal((await admin({ ...extra, [key]: 'invalid', [microsKey]: 10 }, method, pathname)).statusCode, 400);
      assert.deepEqual(loadDataStore(), before);
    }
  });
});

test('admin rejects computed balance overflow before assigning balance, collecting debt or auditing', async () => {
  await withDataDir(async () => {
    const data = loadDataStore();
    data.users[EMAIL].balanceMicros = Number.MAX_SAFE_INTEGER;
    data.spendLogs.push(generationLog('debt', { settled: true, balanceUnderpaidMicros: 100 }));
    saveDataStore(data);
    const before = structuredClone(loadDataStore());
    for (const body of [{ deltaMicros: 1 }, { deltaMicros: Number.MAX_SAFE_INTEGER }, { deltaUsd: '0.00001' }]) {
      assert.equal((await admin(body, 'POST', '/api/admin/users/user%40example.com/balance')).statusCode, 400);
      assert.deepEqual(loadDataStore(), before);
    }
  });
});

test('admin keeps valid negative USD adjustments, currency strings, Micros precedence and zero-floor compatibility', async () => {
  await withDataDir(async () => {
    const pathname = '/api/admin/users/user%40example.com/balance';
    assert.equal((await admin({ deltaUsd: ' -$1 ' }, 'POST', pathname)).statusCode, 400);
    const cases = [
      [{ deltaUsd: ' $-1.25 ' }, -1250000, 8750000],
      [{ deltaUsd: -0.5 }, -500000, 8250000],
      [{ deltaMicros: '-25' }, -25, 8249975],
      [{ deltaMicros: '10', deltaUsd: '5' }, 10, 8249985],
      [{ deltaUsd: '-200' }, -200000000, 0]
    ];
    for (const [body, delta, balance] of cases) {
      assert.equal((await admin(body, 'POST', pathname)).statusCode, 200);
      assert.equal(loadDataStore().users[EMAIL].balanceMicros, balance);
      assert.equal(loadDataStore().spendLogs.at(-1).deltaMicros, delta);
    }
    assert.equal((await admin({ balanceUsd: ' ￥2.5 ' }, 'PATCH', '/api/admin/users/user%40example.com')).statusCode, 200);
    assert.equal(loadDataStore().users[EMAIL].balanceMicros, 2500000);
  });
});

test('slow generation body completed after logout rejects 401 without debit, log or provider call', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    for (const n of [1, 2]) {
      const data = loadDataStore();
      data.sessions.userToken = { email: EMAIL, expiresAt: '2999-01-01T00:00:00.000Z' };
      saveDataStore(data);
      const req = headers(new PassThrough());
      const res = responseCapture();
      const generation = handleGeneration(req, res, CONFIG);
      const body = JSON.stringify({ ...PAYLOAD, n });
      req.write(body.slice(0, 10));
      const loggedOut = responseCapture();
      await handleLogout(request({}), loggedOut);
      assert.equal(loggedOut.statusCode, 200);
      req.end(body.slice(10));
      await generation;
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.body).error.message, /登录/);
      assert.equal(loadDataStore().users[EMAIL].balanceMicros, 10000000);
      assert.equal(loadDataStore().spendLogs.length, 0);
      assert.equal(calls(), 0);
    }
  });
});

test('slow duplicate body after logout does not echo an existing private task', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    const data = loadDataStore();
    data.spendLogs.push(generationLog('private-log', {
      clientRequestId: 'audit-key', requestHash: canonicalPayloadHash(sanitizeGenerationPayload(PAYLOAD, CONFIG)),
      taskId: 'private-task', settled: true, submitResponse: { secret: 'private-echo' }
    }));
    saveDataStore(data);
    const before = structuredClone(data.spendLogs);
    const req = headers(new PassThrough());
    const res = responseCapture();
    const generation = handleGeneration(req, res, CONFIG);
    await handleLogout(request({}), responseCapture());
    req.end(JSON.stringify(PAYLOAD));
    await generation;
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.includes('private-'), false);
    assert.deepEqual(loadDataStore().spendLogs, before);
    assert.equal(loadDataStore().users[EMAIL].balanceMicros, 10000000);
    assert.equal(calls(), 0);
  });
});

test('atomic precharge rechecks session and account after early gate but before queued debit', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    for (const disableAccount of [false, true]) {
      const data = loadDataStore();
      data.sessions.userToken = { email: EMAIL, expiresAt: '2999-01-01T00:00:00.000Z' };
      data.users[EMAIL].active = true;
      saveDataStore(data);
      let revocation;
      const config = { ...CONFIG, get quickBatchEnabled() {
        // This getter runs after the early duplicate gate. Queue revocation first,
        // so precharge must authorize against the state when its mutation runs.
        revocation = withDataStoreMutation((latestData) => {
          if (disableAccount) latestData.users[EMAIL].active = false;
          else delete latestData.sessions.userToken;
        });
        return true;
      } };
      const res = responseCapture();
      await handleGeneration(request(PAYLOAD), res, config);
      await revocation;
      assert.equal(res.statusCode, disableAccount ? 403 : 401);
      assert.equal(loadDataStore().users[EMAIL].balanceMicros, 10000000);
      assert.equal(loadDataStore().spendLogs.length, 0);
      assert.equal(calls(), 0);
    }
  });
});

test('in-mutation idempotency replay still precedes the active cap and never repeats charge or submission', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    let concurrentAdmission;
    const existing = generationLog('queued-duplicate', {
      status: 'submission_unknown', clientRequestId: 'audit-key', settled: false,
      requestHash: canonicalPayloadHash(sanitizeGenerationPayload(PAYLOAD, CONFIG)), chargedMicros: 306000
    });
    const config = { ...CONFIG, get quickBatchEnabled() {
      concurrentAdmission = withDataStoreMutation((data) => {
        data.users[EMAIL].balanceMicros -= 306000;
        data.spendLogs.push(existing, ...[1, 2].map((id) => generationLog(`other-${id}`, { status: 'submission_unknown', settled: false })));
      });
      return true;
    } };
    const res = responseCapture();
    await handleGeneration(request(PAYLOAD), res, config);
    await concurrentAdmission;
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).clientRequestId, 'audit-key');
    assert.equal(loadDataStore().users[EMAIL].balanceMicros, 9694000);
    assert.equal(loadDataStore().spendLogs.length, 3);
    assert.equal(activeRequestCount(loadDataStore(), EMAIL), 3);
    assert.equal(calls(), 0);
  });
});

test('workspace freezes historical terminal records but retains explicit unsettled and inconsistent unknown activity', async () => {
  await withDataDir(async () => {
    const historical = ['completed', 'succeeded', 'success', 'failed', 'cancelled', 'error', 'submit_failed_refunded', 'submission_refunded_closed'].map((status) => generationLog(`old-${status}`, { status }));
    for (const log of historical) assert.equal(isActive(log), false, log.status);
    const unsettled = generationLog('unsettled', { settled: false });
    const unknowns = ['submission_unknown', 'attention_required', 'unknown'].map((status) => generationLog(status, { status, settled: true, hiddenFromHistory: true }));
    assert.equal(isActive(unsettled), true);
    for (const log of unknowns) assert.equal(isActive(log), true, log.status);
    const data = loadDataStore();
    data.spendLogs.push(...historical, unsettled, ...unknowns, generationLog('foreign', { email: 'other@example.com', status: 'processing' }));
    const before = structuredClone(data);
    const feed = taskWorkspace(data, EMAIL);
    assert.equal(activeRequestCount(data, EMAIL), 4);
    assert.equal(feed.activeCount, 4);
    for (const log of historical) assert.equal(feed.tasks.find((entry) => entry.id === log.id).active, false);
    for (const log of [unsettled, ...unknowns]) assert.equal(feed.tasks.find((entry) => entry.id === log.id).active, true);
    assert.deepEqual(data, before);
  });
});

test('three frozen historical terminal generations do not prevent a new paid request', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    const data = loadDataStore();
    const historical = ['completed', 'failed', 'cancelled'].map((status) => generationLog(`old-${status}`, { status }));
    data.spendLogs.push(...historical);
    saveDataStore(data);
    const res = responseCapture();
    await handleGeneration(request(PAYLOAD), res, CONFIG);
    assert.equal(res.statusCode, 200);
    assert.equal(calls(), 1);
    assert.equal(loadDataStore().users[EMAIL].balanceMicros, 9694000);
    assert.equal(loadDataStore().spendLogs.length, 4);
    assert.deepEqual(loadDataStore().spendLogs.slice(0, 3), historical);
    assert.equal(activeRequestCount(loadDataStore(), EMAIL), 1);
  });
});

test('three unknown generations remain capped even with inconsistent settled flags and are never changed', async (t) => {
  const calls = mockProvider(t);
  await withDataDir(async () => {
    const data = loadDataStore();
    data.spendLogs.push(...[undefined, false, true].map((settled, index) => generationLog(`unknown-${index}`, {
      status: 'submission_unknown', ...(settled === undefined ? {} : { settled }), chargedMicros: 306000, hiddenFromHistory: true
    })));
    saveDataStore(data);
    const before = structuredClone(loadDataStore());
    const res = responseCapture();
    await handleGeneration(request(PAYLOAD), res, CONFIG);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(JSON.parse(res.body).error, { code: 'active_request_limit', message: '进行中的请求已达上限。', limit: 3, activeCount: 3 });
    assert.deepEqual(loadDataStore(), before);
    assert.equal(calls(), 0);
  });
});

test('workspace referenceImageCount preserves authoritative zero/positive counts and unknown historical metadata', () => {
  const cases = [
    [{}, null],
    [{ referenceImageCount: null }, null],
    [{ referenceImageCount: undefined }, null],
    [{ referenceImageCount: '2' }, null],
    [{ referenceImageCount: false }, null],
    [{ referenceImageCount: -1 }, null],
    [{ referenceImageCount: 1.5 }, null],
    [{ referenceImageCount: Infinity }, null],
    [{ referenceImageCount: Number.MAX_SAFE_INTEGER + 1 }, null],
    [{ referenceImageCount: 0 }, 0],
    [{ referenceImageCount: 2 }, 2]
  ];
  for (const [metadata, expected] of cases) {
    const data = { spendLogs: [generationLog('reference-count', {
      ...metadata, inputFiles: [{ fileName: 'only_archived_input.png' }]
    })] };
    const before = structuredClone(data);
    const [task] = taskWorkspace(data, EMAIL).tasks;
    assert.equal(task.referenceImageCount, expected);
    assert.equal(task.children[0].referenceImageCount, expected);
    assert.equal(task.inputFiles.length, 1);
    assert.deepEqual(data, before);
  }
});

test('workspace batch referenceImageCount requires every original child count to agree, not merely archive lengths', () => {
  const cases = [
    [[{ referenceImageCount: 0 }, { referenceImageCount: 0 }], 0, [0, 0]],
    [[{ referenceImageCount: 2 }, { referenceImageCount: 2 }], 2, [2, 2]],
    [[{ referenceImageCount: 1 }, { referenceImageCount: 2 }], null, [1, 2]],
    [[{ referenceImageCount: 2 }, {}], null, [2, null]],
    [[{ referenceImageCount: 2 }, { referenceImageCount: null }], null, [2, null]],
    [[{}, {}], null, [null, null]],
    [[{ referenceImageCount: -1 }, { referenceImageCount: -1 }], null, [null, null]]
  ];
  for (const [metadata, expected, expectedChildren] of cases) {
    const data = { spendLogs: metadata.map((fields, index) => generationLog(`reference-child-${index}`, {
      batchId: 'reference-batch', batchIndex: index, ...fields,
      // Both children have equally incomplete archives when their expected count is 2.
      inputFiles: [{ fileName: `archived_input_${index}.png` }]
    })).reverse() };
    const before = structuredClone(data);
    const [task] = taskWorkspace(data, EMAIL).tasks;
    assert.equal(task.referenceImageCount, expected);
    assert.deepEqual(task.children.map((child) => child.referenceImageCount), expectedChildren);
    assert.deepEqual(task.children.map((child) => child.inputFiles.length), [1, 1]);
    assert.deepEqual(data, before);
  }
});
