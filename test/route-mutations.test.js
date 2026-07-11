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
