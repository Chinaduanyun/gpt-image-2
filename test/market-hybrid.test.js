const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createMarketAdapter, marketConfig } = require('../lib/market-image');
const store = require('../lib/store');
const runner = require('../lib/image-task-runner');
const { ProviderError } = require('../lib/cpa-image');
const config = { baseUrl: 'https://example.invalid', apiKey: 'mock-only' };
async function fixture() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'market-hybrid-test-'));
  const log = { id: 'market1', type: 'generation', email: 'test@invalid', estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [] };
  runner.initializeHybridLog(log);
  store.saveDataStore({ version: 1, users: { 'test@invalid': { email: 'test@invalid', balanceMicros: 900 } }, sessions: {}, spendLogs: [log] });
}
const current = () => store.loadDataStore().spendLogs[0];
const rejectCpa = async () => { throw new ProviderError('technical', 'reject'); };
const payload = { model: 'gpt-image-2', prompt: 'mock only', n: 1 };

test('real Market adapter is disabled without explicit enable and isolated config', () => {
  delete process.env.HYBRID_MARKET_ENABLED;
  assert.equal(marketConfig(), null); assert.equal(createMarketAdapter(), null);
});
test('real adapter submit persists external ID and restart only polls with fixed billing', async () => {
  await fixture(); let submits = 0; let polls = 0; let done = false;
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#888888' } }).png().toBuffer();
  const adapter = createMarketAdapter(config, async (method, route, _headers, body) => {
    if (method === 'POST') { submits++; assert.equal(JSON.parse(body).n, 1); return { status: 200, text: '{"data":[{"task_id":"private-external-id"}]}' }; }
    polls++; assert.match(route, /private-external-id$/);
    return { status: 200, text: JSON.stringify({ data: { status: done ? 'completed' : 'processing', cost: 999999, result: done ? { images: [{ url: `data:image/png;base64,${png.toString('base64')}` }] } : {} } }) };
  });
  await runner.startTask('market1', payload, { cpa: rejectCpa, marketAdapter: adapter });
  assert.equal(submits, 1); assert.equal(polls, 1); assert.equal(current().status, 'processing');
  assert.equal(current().attempts.at(-1).externalTaskId, 'private-external-id');
  assert.equal(JSON.stringify(runner.publicLog(current())).includes('private-external-id'), false);
  done = true;
  await runner.recoverTasks(true, { marketAdapter: adapter });
  assert.equal(submits, 1); assert.equal(polls, 2); assert.equal(current().status, 'completed');
  assert.equal(current().actualCostMicros, 100); assert.equal(current().chargedMicros, 100);
});
test('Market submission disconnect stays unknown without resubmit', async () => {
  await fixture(); let submits = 0;
  const adapter = createMarketAdapter(config, async () => { submits++; throw new Error('disconnect'); });
  await runner.startTask('market1', payload, { cpa: rejectCpa, marketAdapter: adapter });
  assert.equal(current().status, 'submission_unknown'); assert.equal(current().settled, false);
  await runner.recoverTasks(true, { marketAdapter: adapter }); assert.equal(submits, 1);
});
test('Market explicit terminal failure refunds once even if upstream reports cost', async () => {
  await fixture(); let submits = 0;
  const adapter = createMarketAdapter(config, async (method) => {
    if (method === 'POST') { submits++; return { status: 200, text: '{"task_id":"known"}' }; }
    return { status: 200, text: '{"data":{"status":"failed","cost":99999}}' };
  });
  await runner.startTask('market1', payload, { cpa: rejectCpa, marketAdapter: adapter });
  assert.equal(current().status, 'failed'); assert.equal(current().chargedMicros, 0);
  await runner.recoverTasks(true, { marketAdapter: adapter });
  assert.equal(submits, 1); assert.equal(store.loadDataStore().users['test@invalid'].balanceMicros, 1000);
});
test('Market polling outage and disabled config keep known task pending, never resubmit', async () => {
  await fixture(); let submits = 0;
  const adapter = createMarketAdapter(config, async (method) => {
    if (method === 'POST') { submits++; return { status: 200, text: '{"task_id":"known"}' }; }
    throw new Error('outage');
  });
  await runner.startTask('market1', payload, { cpa: rejectCpa, marketAdapter: adapter });
  await runner.recoverTasks(true);
  assert.equal(current().status, 'processing'); assert.equal(current().settled, false); assert.equal(submits, 1);
  assert.match(current().error, /未配置/);
});
