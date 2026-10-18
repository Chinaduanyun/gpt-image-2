const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { emptyStore, saveDataStore, loadDataStore } = require('../lib/store');
const { handleMe, getLogsForEmail } = require('../routes/me');
const { handleAdmin } = require('../routes/admin');
const { logNeedsRefresh } = require('../lib/spend-logs');
const { publicLog } = require('../lib/image-task-runner');

test('isolated unknown hiding preserves all non-visibility state and independent admin resolution', async () => {
  const previous = { DATA_DIR: process.env.DATA_DIR, ADMIN_EMAIL: process.env.ADMIN_EMAIL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-unknown-'));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAIL;
  const invoke = async (handler, method, pathname, token = 'user', extra = {}) => {
    const req = Readable.from(method === 'POST' ? [Buffer.from('{}')] : []);
    req.method = method; req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
    const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(body) { this.json = JSON.parse(body); } };
    await handler(req, res, pathname, new URL(`http://fixture.invalid${pathname}`));
    return res;
  };
  try {
    const data = emptyStore();
    for (const name of ['user', 'other', 'admin']) {
      data.users[`${name}@fixture.invalid`] = { email: `${name}@fixture.invalid`, active: true, isAdmin: name === 'admin', balanceMicros: 1000000 };
      data.sessions[name] = { email: `${name}@fixture.invalid`, expiresAt: '2999-01-01T00:00:00.000Z' };
    }
    const log = { id: 'unknown', type: 'generation', email: 'user@fixture.invalid', status: 'submission_unknown', chargedMicros: 306000, settled: false, terminal: false, actualCostMicros: null, settlementStatus: 'submission_unknown', balanceBeforeMicros: 1306000, balanceAfterMicros: 1000000, imageFiles: [{ fileName: 'fixture.png' }], inputFiles: [{ fileName: 'input.png' }], imageUrls: ['/api/stored-images/fixture.png'], remoteImageUrls: [] };
    data.spendLogs.push(log, { id: 'balance', type: 'balance_adjustment', email: log.email, deltaMicros: 10 });
    fs.mkdirSync(path.join(dir, 'images'));
    for (const file of ['fixture.png', 'input.png']) fs.writeFileSync(path.join(dir, 'images', file), 'fixture-only-bytes');
    saveDataStore(data);
    const before = structuredClone(loadDataStore());
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown', '')).code, 401);
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown', 'other')).code, 404);
    assert.deepEqual(loadDataStore(), before);
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown')).code, 200);
    const hidden = structuredClone(loadDataStore());
    assert.equal(hidden.spendLogs[0].hiddenFromHistory, true);
    assert.equal(hidden.spendLogs[0].cleanupStatus, 'retained');
    assert.ok(hidden.spendLogs[0].deletedAt);
    const stripped = structuredClone(hidden);
    for (const key of ['hiddenFromHistory', 'deletedAt', 'cleanupStatus']) delete stripped.spendLogs[0][key];
    assert.deepEqual(stripped, before);
    assert.deepEqual(getLogsForEmail(loadDataStore(), log.email), []);
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown')).code, 200);
    assert.deepEqual(loadDataStore(), hidden);
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown/assets', 'user', { 'x-confirm-delete': 'permanent' })).code, 409);
    assert.deepEqual(loadDataStore(), hidden);
    for (const file of ['fixture.png', 'input.png']) assert.equal(fs.readFileSync(path.join(dir, 'images', file), 'utf8'), 'fixture-only-bytes');
    const admin = await invoke(handleAdmin, 'GET', '/api/admin/spend-logs', 'admin');
    assert.equal(admin.code, 200);
    assert.equal(admin.json.logs.find((entry) => entry.id === 'unknown').hiddenFromHistory, true);
    assert.equal((await invoke(handleAdmin, 'POST', '/api/admin/spend-logs/unknown/refund-and-close', 'user')).code, 403);
    assert.equal((await invoke(handleAdmin, 'POST', '/api/admin/spend-logs/unknown/refund-and-close', 'admin')).code, 200);
    assert.equal(loadDataStore().users[log.email].balanceMicros, 1306000);
    assert.equal(loadDataStore().spendLogs[0].hiddenFromHistory, true);
    assert.deepEqual(getLogsForEmail(loadDataStore(), log.email), []);
    assert.equal((await invoke(handleAdmin, 'POST', '/api/admin/spend-logs/unknown/refund-and-close', 'admin')).code, 200);
    assert.equal(loadDataStore().users[log.email].balanceMicros, 1306000);

    for (const status of ['submitting', 'submitted', 'processing', 'attention_required', 'submission_unknown']) {
      for (const settled of [false, true]) {
        const fixture = structuredClone(before);
        fixture.spendLogs[0].status = status; fixture.spendLogs[0].settled = settled;
        if (status === 'submission_unknown') {
          fixture.spendLogs[0].batchId = 'batch-fixture';
          fixture.spendLogs.push({ ...log, id: 'active-child', status: 'processing', batchId: 'batch-fixture' });
        }
        saveDataStore(fixture);
        const snapshot = structuredClone(loadDataStore());
        assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown')).code, 409);
        assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/unknown/assets', 'user', { 'x-confirm-delete': 'permanent' })).code, 409);
        assert.deepEqual(loadDataStore(), snapshot);
      }
    }
    const fixed = { ...before.spendLogs[0], id: 'fixed', billingVersion: 'fixed-quote-v2', taskId: 'local-fixture', attempts: [] };
    const fixture = structuredClone(before); fixture.spendLogs = [fixed]; saveDataStore(fixture);
    assert.equal(publicLog(fixed).type, 'generation');
    assert.equal((await invoke(handleMe, 'DELETE', '/api/me/logs/fixed')).code, 200);
    assert.equal(loadDataStore().spendLogs[0].taskId, 'local-fixture');
    assert.equal(logNeedsRefresh({ ...before.spendLogs[0], hiddenFromHistory: true, taskId: 'upstream-fixture' }), true);
    assert.equal(logNeedsRefresh({ ...before.spendLogs[0], hiddenFromHistory: true }), false);
    assert.equal(logNeedsRefresh({ ...fixed, hiddenFromHistory: true }), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
