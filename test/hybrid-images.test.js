const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const store = require('../lib/store');
const runner = require('../lib/image-task-runner');
const { ProviderError, normalizeResult, generateCpa } = require('../lib/cpa-image');
const assets = require('../lib/image-assets');
const { closeSubmissionUnknownWithRefund, logNeedsRefresh } = require('../lib/spend-logs');
let png;
async function fixture() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-test-'));
  png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#338855' } }).png().toBuffer();
  store.saveDataStore({ version: 1, users: { 'test@staging.invalid': { email: 'test@staging.invalid', active: true, balanceMicros: 900 } }, sessions: {}, spendLogs: [] });
  const log = { id: 'task1', type: 'generation', email: 'test@staging.invalid', estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [] };
  runner.initializeHybridLog(log);
  await store.withDataStoreMutation((data) => data.spendLogs.push(log));
  return log;
}
const payload = () => ({ prompt: 'test', size: '16:9', resolution: '4k', quality: 'high', output_format: 'webp', n: 1 });
const result = () => [{ base64: png.toString('base64') }];
const current = () => store.loadDataStore().spendLogs[0];

test('hybrid archives actual specifications and settles the locked quote once', async () => {
  await fixture(); let calls = 0;
  await Promise.all([runner.startTask('task1', payload(), { cpa: async () => { calls++; return result(); } }), runner.startTask('task1', payload(), { cpa: async () => { calls++; return result(); } })]);
  assert.equal(calls, 1); assert.equal(current().status, 'completed'); assert.equal(current().actualCostMicros, 100);
  assert.equal(current().imageFiles[0].width, 16); assert.equal(current().imageFiles[0].format, 'png');
  assert.equal(store.loadDataStore().users['test@staging.invalid'].balanceMicros, 900);
  assert.equal(logNeedsRefresh(current()), false);
  await runner.startTask('task1', payload(), { cpa: () => assert.fail('must not resubmit') });
});
for (const count of [2, 4]) test(`hybrid permanently archives ${count} reference images`, async () => {
  await fixture();
  await runner.startTask('task1', { ...payload(), image_urls: Array(count).fill(`data:image/png;base64,${png.toString('base64')}`) }, { cpa: async (_payload, files) => { assert.equal(files.length, count); return result(); } });
  assert.equal(current().inputFiles.length, count); assert.equal(current().status, 'completed');
});
test('explicit technical rejection falls back to mock Market at most once with one bill', async () => {
  await fixture(); let market = 0;
  await runner.startTask('task1', payload(), { cpa: async () => { throw new ProviderError('technical', 'rejected'); }, market: async () => { market++; return result(); } });
  assert.equal(market, 1); assert.deepEqual(current().attempts.map((a) => a.provider), ['cpa', 'market']); assert.equal(current().chargedMicros, 100);
});
test('disabled real Market is reported and refunded exactly once', async () => {
  await fixture();
  await runner.startTask('task1', payload(), { cpa: async () => { throw new ProviderError('technical', 'rejected'); } });
  assert.equal(current().status, 'failed'); assert.equal(current().chargedMicros, 0);
  assert.match(current().error, /Market/); assert.equal(store.loadDataStore().users['test@staging.invalid'].balanceMicros, 1000);
  assert.equal(runner.settleFixed(store.loadDataStore(), current(), false), false);
});
for (const kind of ['unknown', 'policy']) test(`${kind} never falls back to another provider`, async () => {
  await fixture();
  await runner.startTask('task1', payload(), { cpa: async () => { throw new ProviderError(kind, kind); }, market: () => assert.fail('no fallback') });
  assert.equal(current().status, kind === 'unknown' ? 'submission_unknown' : 'failed');
  assert.equal(current().settled, kind !== 'unknown');
});
test('unknown local task permits audited admin close and repeated refund is blocked', async () => {
  await fixture();
  await runner.startTask('task1', payload(), { cpa: async () => { throw new ProviderError('unknown', 'timeout'); } });
  assert.equal(closeSubmissionUnknownWithRefund(store.loadDataStore(), current(), 'admin').ok, true);
  assert.equal(closeSubmissionUnknownWithRefund(store.loadDataStore(), current(), 'admin').ok, false);
  await runner.startTask('task1', payload(), { cpa: () => assert.fail('late resubmit') });
});
test('restart marks submitted task unknown and refunds never-submitted queued task', async () => {
  await fixture(); await runner.recoverTasks(true); assert.equal(current().status, 'failed');
  await fixture(); await store.withDataStoreMutation((data) => { data.spendLogs[0].status = 'processing'; data.spendLogs[0].attempts = [{ provider: 'cpa', state: 'submitted' }]; });
  await runner.recoverTasks(true); assert.equal(current().status, 'submission_unknown'); assert.equal(current().chargedMicros, 100);
});
test('corrupt result becomes terminal refunded failure and recovery never generates', async () => {
  await fixture(); let calls = 0;
  await runner.startTask('task1', payload(), { cpa: async () => { calls++; return [{ base64: Buffer.from('broken').toString('base64') }]; } });
  assert.equal(current().status, 'failed'); assert.equal(current().archiveStatus, 'invalid_image'); assert.equal(current().settled, true);
  assert.equal(current().chargedMicros, 0);
  await runner.recoverTasks(true);
  assert.equal(current().status, 'failed'); assert.equal(calls, 1);
  assert.equal(store.loadDataStore().users['test@staging.invalid'].balanceMicros, 1000);
});
test('private addresses, credentials, non-HTTPS references and invalid images are rejected', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.equal(assets.publicAddress(ip), false);
  for (const url of ['http://example.com/a', 'https://u:p@example.com/a', 'https://127.0.0.1/a']) await assert.rejects(assets.downloadSafe(url));
  await assert.rejects(assets.decodeImage(Buffer.from('broken')));
});
test('capacity rejection never deletes existing assets', async () => {
  await fixture(); const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1, bsize: 1 });
  try { assert.throws(assets.assertCapacity, /空间不足/); } finally { fs.statfsSync = original; }
});
test('CPA JSON and final SSE base64 normalize without resubmitting', () => {
  assert.deepEqual(normalizeResult('{"data":[{"b64_json":"abc"}]}', 'application/json'), [{ base64: 'abc' }]);
  assert.deepEqual(normalizeResult('data: {"type":"image_generation.completed","b64_json":"abc"}\n\ndata: [DONE]\n\n', 'text/event-stream'), [{ base64: 'abc' }]);
});
test('CPA preserves structured size and uses multipart for input images', async () => {
  await fixture(); const file = await assets.saveAsset('task1', 'input', 0, png);
  await generateCpa(payload(), [file, file], { config: { baseUrl: 'https://example.invalid/v1', apiKey: 'mock' }, fetch: async (url, options) => {
    assert.match(url, /edits$/); assert.equal(options.body.getAll('image[]').length, 2); assert.equal(options.body.get('size'), '3840x2160');
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  } });
});

test('late provider response cannot settle an administratively closed task', async () => {
  await fixture(); let release; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = runner.startTask('task1', payload(), { cpa: async () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  await ready;
  await store.withDataStoreMutation((data) => {
    const log = data.spendLogs[0]; log.status = 'submission_unknown';
    assert.equal(closeSubmissionUnknownWithRefund(data, log, 'admin').ok, true);
  });
  release(result()); await pending;
  assert.equal(current().status, 'submission_refunded_closed');
  assert.equal(current().chargedMicros, 0);
  assert.equal(store.loadDataStore().users['test@staging.invalid'].balanceMicros, 1000);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'pending-results/task1.json')), false);
});
test('image write failure preserves durable result and retries only archival', async () => {
  await fixture(); const original = fs.renameSync; let calls = 0;
  fs.renameSync = (from, to) => { if (String(to).includes('/images/')) throw new Error('disk fault'); return original(from, to); };
  try { await runner.startTask('task1', payload(), { cpa: async () => { calls++; return result(); } }); }
  finally { fs.renameSync = original; }
  assert.equal(current().archiveStatus, 'error'); assert.equal(current().settled, false);
  await runner.recoverTasks(true); assert.equal(current().status, 'completed'); assert.equal(calls, 1);
});


test('CPA malformed config URL, missing file and local multipart errors are unavailable before fetch', async () => {
  const original = process.env.CPA_CONFIG_FILE;
  process.env.CPA_CONFIG_FILE = '/nonexistent/staging-cpa.json';
  try { await assert.rejects(generateCpa(payload(), [], { fetch: () => assert.fail('no network') }), (error) => error.kind === 'unavailable'); }
  finally { if (original === undefined) delete process.env.CPA_CONFIG_FILE; else process.env.CPA_CONFIG_FILE = original; }
  await assert.rejects(generateCpa(payload(), [], { config: { baseUrl: 'invalid', apiKey: 'mock' }, fetch: () => assert.fail('no network') }), (error) => error.kind === 'unavailable');
  await assert.rejects(generateCpa(payload(), [{ fileName: 'missing.png' }], { config: { baseUrl: 'https://example.invalid/v1', apiKey: 'mock' }, fetch: () => assert.fail('no network') }), (error) => error.kind === 'unavailable');
});


test('authenticated me response exposes no storage and does not call capacity for users or admins', async () => {
  await fixture();
  const { createSession } = require('../lib/auth');
  const { handleMe } = require('../routes/me');
  const email = 'test@staging.invalid';
  const original = assets.capacity;
  assets.capacity = () => assert.fail('user endpoint must not inspect server capacity');
  try {
    for (const isAdmin of [false, true]) {
      let token;
      await store.withDataStoreMutation(data => { data.users[email].isAdmin = isAdmin; token = createSession(data, email); });
      const before = JSON.stringify(store.loadDataStore());
      let status, body;
      const res = { setHeader() {}, writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
      await handleMe({ method: 'GET', headers: { authorization: `Bearer ${token}` } }, res, '/api/me', new URL('http://localhost/api/me'));
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body), ['user']);
      assert.equal(body.user.isAdmin, isAdmin);
      assert.doesNotMatch(JSON.stringify(body), /storage|freeBytes|totalBytes|availableBytes/);
      assert.equal(JSON.stringify(store.loadDataStore()), before);
    }
  } finally { assets.capacity = original; }
});
