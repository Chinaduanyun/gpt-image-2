const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { emptyStore, loadDataStore, saveDataStore, withDataStoreMutation } = require('../lib/store');
const { handleLogin } = require('../routes/auth');
const { handleAdmin } = require('../routes/admin');
const { handleGeneration } = require('../routes/api-market');

async function withDataDir(run) {
  const previousDataDir = process.env.DATA_DIR;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-routes-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.ADMIN_EMAIL;

  try {
    return await run();
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function request(method, body, token) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body) { this.body = body; }
  };
}

function futureSession(email) {
  return { email, createdAt: new Date().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' };
}

test('login session creation preserves a concurrent billing mutation', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 100 };
    saveDataStore(data);

    let releaseBilling;
    const billingCanFinish = new Promise((resolve) => { releaseBilling = resolve; });
    const billing = withDataStoreMutation(async (latestData) => {
      await billingCanFinish;
      latestData.users['user@example.com'].balanceMicros = 75;
      latestData.spendLogs.push({ id: 'usage_concurrent', type: 'generation', email: 'user@example.com' });
    });

    const res = responseCapture();
    const login = handleLogin(request('POST', { email: 'user@example.com' }), res);
    await new Promise((resolve) => setImmediate(resolve));
    releaseBilling();
    await Promise.all([billing, login]);

    const stored = loadDataStore();
    assert.equal(res.statusCode, 200);
    assert.equal(stored.users['user@example.com'].balanceMicros, 75);
    assert.equal(stored.spendLogs[0].id, 'usage_concurrent');
    assert.equal(Object.keys(stored.sessions).length, 1);
  });
});

test('generation precharge persists the complete immutable pricing snapshot', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 10000000 };
    data.sessions.userToken = futureSession('user@example.com');
    saveDataStore(data);

    const originalRequest = https.request;
    https.request = (options, callback) => {
      const upstream = Readable.from([Buffer.from(JSON.stringify({ data: { task_id: 'task_snapshot' } }))]);
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'application/json' };
      const outgoing = new EventEmitter();
      outgoing.setTimeout = () => outgoing;
      outgoing.write = () => true;
      outgoing.end = () => setImmediate(() => callback(upstream));
      outgoing.destroy = (error) => { if (error) outgoing.emit('error', error); };
      return outgoing;
    };

    try {
      const res = responseCapture();
      await handleGeneration(request('POST', {
        model: 'gpt-image-2-official', prompt: 'test', size: '3:1', resolution: '1k', quality: 'low', n: 4
      }, 'userToken'), res, {
        apiKey: 'test-key', baseUrl: 'https://example.test', model: 'gpt-image-2'
      });

      const stored = loadDataStore();
      const log = stored.spendLogs[0];
      assert.equal(res.statusCode, 200);
      assert.equal(log.status, 'submitted');
      assert.equal(log.taskId, 'task_snapshot');
      assert.equal(log.pricingVersion, '2026-07-10-model-policy-v1');
      assert.equal(log.billingPolicy, 'provider-task-total-with-per-image-floor-v1');
      assert.equal(log.totalMultiplier, 10.5);
      assert.equal(log.minimumPerImageMicros, 300000);
      assert.equal(log.billingImageCount, 4);
      assert.equal(log.minimumChargeMicros, 1200000);
      assert.equal(log.estimatedCostMicros, 1200000);
      assert.equal(log.chargedMicros, 1200000);
      assert.equal(log.providerCostMicros, null);
      assert.equal(log.actualCostMicros, null);
      assert.deepEqual(log.pricingSnapshot, {
        pricingVersion: log.pricingVersion,
        billingPolicy: log.billingPolicy,
        model: 'gpt-image-2-official',
        totalMultiplier: 10.5,
        minimumPerImageMicros: 300000,
        billingImageCount: 4,
        minimumChargeMicros: 1200000,
        convertedUnitMicros: 15120,
        unitMicros: 300000,
        estimatedCostMicros: 1200000
      });
    } finally {
      https.request = originalRequest;
    }
  });
});

test('admin balance adjustment uses latest balance after concurrent billing', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 100 };
    data.sessions.adminToken = futureSession('admin@example.com');
    saveDataStore(data);

    let releaseBilling;
    const billingCanFinish = new Promise((resolve) => { releaseBilling = resolve; });
    const billing = withDataStoreMutation(async (latestData) => {
      await billingCanFinish;
      latestData.users['user@example.com'].balanceMicros = 75;
      latestData.spendLogs.push({ id: 'usage_concurrent', type: 'generation', email: 'user@example.com' });
    });

    const res = responseCapture();
    const adminRequest = handleAdmin(
      request('POST', { deltaMicros: 10, reason: '补额' }, 'adminToken'),
      res,
      '/api/admin/users/user%40example.com/balance',
      new URL('http://localhost/api/admin/users/user%40example.com/balance')
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseBilling();
    await Promise.all([billing, adminRequest]);

    const stored = loadDataStore();
    assert.equal(res.statusCode, 200);
    assert.equal(stored.users['user@example.com'].balanceMicros, 85);
    assert.equal(stored.spendLogs.length, 2);
    assert.equal(stored.spendLogs[0].id, 'usage_concurrent');
    assert.equal(stored.spendLogs[1].type, 'balance_adjustment');
    assert.equal(stored.spendLogs[1].balanceBeforeMicros, 75);
    assert.equal(stored.spendLogs[1].balanceAfterMicros, 85);
  });
});


test('admin PATCH direct balance overwrite records an auditable balance_adjustment', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 500 };
    data.sessions.adminToken = futureSession('admin@example.com');
    saveDataStore(data);

    const res = responseCapture();
    await handleAdmin(
      request('PATCH', { balanceMicros: 2000 }, 'adminToken'),
      res,
      '/api/admin/users/user%40example.com',
      new URL('http://localhost/api/admin/users/user%40example.com')
    );
    assert.equal(res.statusCode, 200);

    const stored = loadDataStore();
    assert.equal(stored.users['user@example.com'].balanceMicros, 2000);
    const audit = stored.spendLogs.filter((log) => log.type === 'balance_adjustment');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, '管理员直接设置余额');
    assert.equal(audit[0].email, 'user@example.com');
    assert.equal(audit[0].adminEmail, 'admin@example.com');
    assert.equal(audit[0].balanceBeforeMicros, 500);
    assert.equal(audit[0].balanceAfterMicros, 2000);
    assert.equal(audit[0].deltaMicros, 1500);
  });
});

test('admin balance inputs reject non-safe-integer amounts without touching the ledger', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 500 };
    data.sessions.adminToken = futureSession('admin@example.com');
    saveDataStore(data);

    const balancePath = '/api/admin/users/user%40example.com/balance';
    for (const badBody of [{ deltaMicros: 'abc' }, { deltaMicros: 1.5 }, { deltaMicros: 9e18 }, { deltaMicros: {} }]) {
      const res = responseCapture();
      await handleAdmin(request('POST', badBody, 'adminToken'), res, balancePath, new URL(`http://localhost${balancePath}`));
      assert.equal(res.statusCode, 400, JSON.stringify(badBody));
    }

    const patchPath = '/api/admin/users/user%40example.com';
    const patchRes = responseCapture();
    await handleAdmin(request('PATCH', { balanceMicros: 'oops' }, 'adminToken'), patchRes, patchPath, new URL(`http://localhost${patchPath}`));
    assert.equal(patchRes.statusCode, 400);

    const stored = loadDataStore();
    assert.equal(stored.users['user@example.com'].balanceMicros, 500);
    assert.equal(stored.spendLogs.length, 0);
  });
});

test('a positive top-up auto-collects outstanding underpayment debt oldest-first without going negative', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 0 };
    data.sessions.adminToken = futureSession('admin@example.com');
    data.spendLogs.push({
      id: 'debt_old', type: 'generation', email: 'user@example.com', settled: true, status: 'completed',
      balanceUnderpaidMicros: 100, createdAt: '2026-07-01T00:00:00.000Z'
    });
    data.spendLogs.push({
      id: 'debt_new', type: 'generation', email: 'user@example.com', settled: true, status: 'completed',
      balanceUnderpaidMicros: 200, createdAt: '2026-07-02T00:00:00.000Z'
    });
    saveDataStore(data);

    const res = responseCapture();
    const balancePath = '/api/admin/users/user%40example.com/balance';
    await handleAdmin(request('POST', { deltaMicros: 250, reason: '充值' }, 'adminToken'), res, balancePath, new URL(`http://localhost${balancePath}`));
    assert.equal(res.statusCode, 200);

    const stored = loadDataStore();
    // 250 credited, 100 clears the old debt, 150 partially clears the new debt; balance ends at 0.
    assert.equal(stored.users['user@example.com'].balanceMicros, 0);
    const oldDebt = stored.spendLogs.find((log) => log.id === 'debt_old');
    const newDebt = stored.spendLogs.find((log) => log.id === 'debt_new');
    assert.equal(oldDebt.balanceUnderpaidMicros, 0);
    assert.equal(oldDebt.debtCollectedMicros, 100);
    assert.match(oldDebt.debtCollectedAt, /^\d{4}-/);
    assert.equal(newDebt.balanceUnderpaidMicros, 50);
    assert.equal(newDebt.debtCollectedMicros, 150);
    const adjustment = stored.spendLogs.find((log) => log.type === 'balance_adjustment');
    assert.equal(adjustment.deltaMicros, 250);
    assert.equal(adjustment.collectedDebtMicros, 250);
    assert.equal(adjustment.balanceAfterMicros, 0);
  });
});

test('admin refunds and closes only taskless submission_unknown logs once', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 100 };
    data.sessions.adminToken = futureSession('admin@example.com');
    data.spendLogs.push({
      id: 'usage_unknown', type: 'generation', email: 'user@example.com', status: 'submission_unknown', taskId: '',
      chargedMicros: 250, settled: false, settlementStatus: 'submission_unknown', createdAt: '2026-07-16T00:00:00.000Z'
    });
    saveDataStore(data);

    const pathname = '/api/admin/spend-logs/usage_unknown/refund-and-close';
    const first = responseCapture();
    await handleAdmin(request('POST', { reason: 'provider response unavailable' }, 'adminToken'), first, pathname, new URL(`http://localhost${pathname}`));
    const stored = loadDataStore();
    const log = stored.spendLogs.find((entry) => entry.id === 'usage_unknown');
    const audit = stored.spendLogs.find((entry) => entry.type === 'admin_refund_and_close');
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).refundMicros, 250);
    assert.equal(stored.users['user@example.com'].balanceMicros, 350);
    assert.equal(log.status, 'submission_refunded_closed');
    assert.equal(log.chargedMicros, 0);
    assert.equal(log.actualCostMicros, 0);
    assert.equal(log.settled, true);
    assert.equal(log.settlementStatus, 'admin_refunded_closed');
    assert.deepEqual(log.resolution.action, 'admin_refund_and_close');
    assert.equal(log.resolution.adminEmail, 'admin@example.com');
    assert.equal(log.resolution.refundMicros, 250);
    assert.equal(audit.targetLogId, 'usage_unknown');
    assert.equal(audit.refundMicros, 250);

    const repeat = responseCapture();
    await handleAdmin(request('POST', {}, 'adminToken'), repeat, pathname, new URL(`http://localhost${pathname}`));
    assert.equal(repeat.statusCode, 200);
    assert.equal(JSON.parse(repeat.body).refundMicros, 250);
    assert.equal(loadDataStore().users['user@example.com'].balanceMicros, 350);

    assert.equal(loadDataStore().spendLogs.filter((entry) => entry.type === 'admin_refund_and_close').length, 1);
  });
});

test('admin refund close rejects submitted, task-bearing, and unauthenticated logs', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['admin@example.com'] = { email: 'admin@example.com', active: true, isAdmin: true, balanceMicros: 0 };
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 100 };
    data.sessions.adminToken = futureSession('admin@example.com');
    data.spendLogs.push({ id: 'usage_task', type: 'generation', email: 'user@example.com', status: 'submission_unknown', taskId: 'task_1', chargedMicros: 50, settled: false });
    data.spendLogs.push({ id: 'usage_batch', type: 'generation', email: 'user@example.com', status: 'submission_unknown', batchId: 'batch_1', chargedMicros: 60, settled: false });
    data.spendLogs.push({ id: 'usage_legacy_batch', type: 'generation', email: 'user@example.com', status: 'submission_unknown', batch_id: 'legacy_batch_1', chargedMicros: 70, settled: false });


    saveDataStore(data);
    const pathname = '/api/admin/spend-logs/usage_task/refund-and-close';
    const denied = responseCapture();
    await handleAdmin(request('POST', {}), denied, pathname, new URL(`http://localhost${pathname}`));
    assert.equal(denied.statusCode, 401);
    const rejected = responseCapture();
    await handleAdmin(request('POST', {}, 'adminToken'), rejected, pathname, new URL(`http://localhost${pathname}`));
    assert.equal(rejected.statusCode, 409);
    const batchPathname = '/api/admin/spend-logs/usage_batch/refund-and-close';
    const batchRejected = responseCapture();
    await handleAdmin(request('POST', {}, 'adminToken'), batchRejected, batchPathname, new URL(`http://localhost${batchPathname}`));
    assert.equal(batchRejected.statusCode, 409);
    const legacyBatchPathname = '/api/admin/spend-logs/usage_legacy_batch/refund-and-close';
    const legacyBatchRejected = responseCapture();
    await handleAdmin(request('POST', {}, 'adminToken'), legacyBatchRejected, legacyBatchPathname, new URL(`http://localhost${legacyBatchPathname}`));
    assert.equal(legacyBatchRejected.statusCode, 409);
    const stored = loadDataStore();
    assert.equal(stored.users['user@example.com'].balanceMicros, 100);
    assert.equal(stored.spendLogs.find((log) => log.id === 'usage_batch').status, 'submission_unknown');
    assert.equal(stored.spendLogs.find((log) => log.id === 'usage_legacy_batch').status, 'submission_unknown');

    assert.equal(stored.spendLogs.filter((log) => log.type === 'admin_refund_and_close').length, 0);

  });
});




test('invalid upstream base URL rejects generation before balance precharge', { concurrency: false }, async () => {
  await withDataDir(async () => {
    const data = emptyStore();
    data.users['user@example.com'] = { email: 'user@example.com', active: true, balanceMicros: 10000000 };
    data.sessions.userToken = futureSession('user@example.com');
    saveDataStore(data);

    const res = responseCapture();
    await handleGeneration(request('POST', {
      model: 'gpt-image-2', prompt: 'test', size: '1:1', resolution: '1k', quality: 'low', n: 1
    }, 'userToken'), res, { apiKey: 'test-key', baseUrl: 'not a URL', model: 'gpt-image-2' });

    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error.message, /baseUrl 无效/);
    assert.equal(loadDataStore().users['user@example.com'].balanceMicros, 10000000);
    assert.equal(loadDataStore().spendLogs.length, 0);

    const httpRes = responseCapture();
    await handleGeneration(request('POST', {
      model: 'gpt-image-2', prompt: 'test', size: '1:1', resolution: '1k', quality: 'low', n: 1
    }, 'userToken'), httpRes, { apiKey: 'test-key', baseUrl: 'http://example.test', model: 'gpt-image-2' });
    assert.equal(httpRes.statusCode, 500);
    assert.match(JSON.parse(httpRes.body).error.message, /必须使用 HTTPS/);
    assert.equal(loadDataStore().users['user@example.com'].balanceMicros, 10000000);
    assert.equal(loadDataStore().spendLogs.length, 0);
  });
});


