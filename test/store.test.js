const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptyStore, loadDataStore, saveDataStore, withDataStoreMutation, initializeDataStore } = require('../lib/store');

function withDataDir(run) {
  const previousDataDir = process.env.DATA_DIR;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-store-'));
  process.env.DATA_DIR = dataDir;
  delete process.env.ADMIN_EMAIL;

  try {
    return run(dataDir);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withAsyncDataDir(run) {
  const previousDataDir = process.env.DATA_DIR;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-store-'));
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

test('round-trips a version 1 store', { concurrency: false }, () => {
  withDataDir(() => {
    const data = emptyStore();
    data.users['user@example.com'] = { email: 'user@example.com', active: true };
    data.sessions.token = { email: 'user@example.com', expiresAt: '2999-01-01T00:00:00.000Z' };
    data.spendLogs.push({ id: 'log-1', amountMicros: 1200 });

    saveDataStore(data);

    assert.deepEqual(loadDataStore(), data);
  });
});

test('preserves optional and unknown spend log fields', { concurrency: false }, () => {
  withDataDir(() => {
    const data = emptyStore();
    data.spendLogs.push({
      id: 'log-optional',
      amountMicros: 500,
      provider: 'api-market',
      imageCount: 2,
      futureField: { nested: true }
    });

    saveDataStore(data);

    assert.deepEqual(loadDataStore().spendLogs, data.spendLogs);
  });
});

test('rejects malformed JSON without overwriting it', { concurrency: false }, () => {
  withDataDir((dataDir) => {
    const dataFile = path.join(dataDir, 'app-data.json');
    const malformed = '{"version":1,"users":';
    fs.writeFileSync(dataFile, malformed);

    assert.throws(() => loadDataStore(), /Invalid data store JSON/);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), malformed);
    assert.throws(() => saveDataStore(emptyStore()), /Refusing to overwrite invalid data store/);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), malformed);
  });
});

test('rejects a store with invalid field types', { concurrency: false }, () => {
  withDataDir((dataDir) => {
    const dataFile = path.join(dataDir, 'app-data.json');
    fs.writeFileSync(dataFile, JSON.stringify({ version: 1, users: [], sessions: {}, spendLogs: [] }));

    assert.throws(() => loadDataStore(), /users must be an object/);
  });
});

test('keeps the most recent valid data file as a backup', { concurrency: false }, () => {
  withDataDir((dataDir) => {
    const first = emptyStore();
    first.spendLogs.push({ id: 'first', custom: 'recoverable' });
    saveDataStore(first);

    const second = emptyStore();
    second.spendLogs.push({ id: 'second' });
    saveDataStore(second);

    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-data.json.bak'), 'utf8'));
    assert.deepEqual(backup, first);
    assert.deepEqual(loadDataStore(), second);
  });
});

test('serializes concurrent async mutations and returns their results', { concurrency: false }, async () => {
  await withAsyncDataDir(async () => {
    saveDataStore(emptyStore());
    const order = [];
    let releaseFirst;
    const firstCanFinish = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = withDataStoreMutation(async (data) => {
      order.push('first-start');
      await firstCanFinish;
      data.spendLogs.push({ id: 'first' });
      order.push('first-finish');
      return 'first-result';
    });
    const second = withDataStoreMutation(async (data) => {
      order.push('second-start');
      data.spendLogs.push({ id: 'second' });
      return 'second-result';
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['first-start']);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
    assert.deepEqual(order, ['first-start', 'first-finish', 'second-start']);
    assert.deepEqual(loadDataStore().spendLogs.map((log) => log.id), ['first', 'second']);
  });
});

test('read cleanup never persists an old snapshot over a queued mutation', { concurrency: false }, async () => {
  await withAsyncDataDir(async (dataDir) => {
    const data = emptyStore();
    data.sessions.expired = { email: 'user@example.com', expiresAt: '2000-01-01T00:00:00.000Z' };
    saveDataStore(data);

    let releaseBilling;
    const billingCanFinish = new Promise((resolve) => { releaseBilling = resolve; });
    const billing = withDataStoreMutation(async (latestData) => {
      await billingCanFinish;
      latestData.spendLogs.push({ id: 'preserved-billing' });
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(loadDataStore().sessions, {});
    assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'app-data.json'), 'utf8')).sessions.expired);
    releaseBilling();
    await billing;

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-data.json'), 'utf8'));
    assert.deepEqual(stored.sessions, {});
    assert.deepEqual(stored.spendLogs.map((log) => log.id), ['preserved-billing']);
  });
});

test('initialization creates and restores the configured admin through the mutation queue', { concurrency: false }, async () => {
  await withAsyncDataDir(async () => {
    process.env.ADMIN_EMAIL = 'Admin@Example.com';
    await initializeDataStore();

    let stored = loadDataStore();
    assert.equal(stored.users['admin@example.com'].isAdmin, true);
    assert.equal(stored.users['admin@example.com'].active, true);

    stored.users['admin@example.com'].isAdmin = false;
    stored.users['admin@example.com'].active = false;
    saveDataStore(stored);
    await initializeDataStore();

    stored = loadDataStore();
    assert.equal(stored.users['admin@example.com'].isAdmin, true);
    assert.equal(stored.users['admin@example.com'].active, true);
  });
});

test('continues mutation queue after a rejected mutation', { concurrency: false }, async () => {
  await withAsyncDataDir(async () => {
    saveDataStore(emptyStore());

    const failed = withDataStoreMutation((data) => {
      data.spendLogs.push({ id: 'discarded' });
      throw new Error('mutation failed');
    });
    const continued = withDataStoreMutation((data) => {
      data.spendLogs.push({ id: 'continued' });
      return 'saved';
    });

    await assert.rejects(failed, /mutation failed/);
    assert.equal(await continued, 'saved');
    assert.deepEqual(loadDataStore().spendLogs.map((log) => log.id), ['continued']);
  });
});
