const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { historyPage, pagedPublicLog } = require('../lib/history-pagination');
const { handleMe, getLogsForEmail } = require('../routes/me');
const { emptyStore, saveDataStore, loadDataStore, withDataStoreMutation } = require('../lib/store');

const EMAIL = 'owner@fixture.invalid';
const OTHER = 'other@fixture.invalid';
const params = (values = {}) => new URLSearchParams(values);
function log(id, extra = {}) {
  return { id, email: EMAIL, type: 'generation', createdAt: '2026-10-01T00:00:00.000Z', status: 'completed', settled: true, prompt: `full prompt ${id}`, model: 'gpt-image-2', settings: { size: '3:2', resolution: '2k', quality: 'high', n: 1 }, imageUrls: [`/api/stored-images/${id}.png`], chargedMicros: 306000, estimatedCostMicros: 306000, actualCostMicros: 306000, ...extra };
}
function fixture(logs = []) {
  const data = emptyStore();
  for (const [token, email] of [['owner', EMAIL], ['other', OTHER]]) {
    data.users[email] = { email, active: true, balanceMicros: 9876543 };
    data.sessions[token] = { email, expiresAt: '2999-01-01T00:00:00.000Z' };
  }
  data.spendLogs = logs;
  return data;
}
function manyLogs() {
  const logs = Array.from({ length: 137 }, (_, i) => log(`log-${String(i).padStart(3, '0')}`));
  for (let i = 0; i < 9; i += 1) {
    for (let child = 0; child < 3; child += 1) logs.push(log(`batch-${i}-child-${child}`, { batchId: `batch-${i}`, batchIndex: child, batchSize: 3, taskId: `provider-${i}-${child}` }));
  }
  return logs;
}
async function withStore(logs, run) {
  const previous = { DATA_DIR: process.env.DATA_DIR, ADMIN_EMAIL: process.env.ADMIN_EMAIL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-pagination-'));
  process.env.DATA_DIR = dir;
  delete process.env.ADMIN_EMAIL;
  try {
    saveDataStore(fixture(logs));
    return await run(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function invoke(query = 'paged=1', token = 'owner') {
  const url = new URL(`http://fixture.invalid/api/me/logs?${query}`);
  const req = Readable.from([]);
  req.method = 'GET'; req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = { setHeader() {}, writeHead(code) { this.code = code; }, end(body) { this.json = JSON.parse(body); } };
  await handleMe(req, res, url.pathname, url);
  return res;
}

test('historyPage pages all >100 groups with complete batches and deterministic equal-time boundaries', () => {
  const data = fixture(manyLogs());
  const snapshot = structuredClone(data);
  const first = historyPage(data, EMAIL, params());
  assert.equal(first.logs.length, 24);
  assert.deepEqual({ ...first.page, nextCursor: Boolean(first.page.nextCursor) }, { limit: 24, total: 146, hasMore: true, nextCursor: true });
  const expected = [...Array.from({ length: 137 }, (_, i) => `log-${String(i).padStart(3, '0')}`), ...Array.from({ length: 9 }, (_, i) => `batch-${i}`)].sort().reverse();
  const seen = [];
  let page = first;
  do {
    seen.push(...page.logs.map((entry) => entry.id));
    for (const batch of page.logs.filter((entry) => entry.kind === 'batch')) {
      assert.equal(batch.children.length, 3);
      assert.equal(batch.imageUrls.length, 3);
      assert.equal(batch.chargedMicros, 918000);
    }
    if (!page.page.hasMore) break;
    page = historyPage(data, EMAIL, params({ cursor: page.page.nextCursor }));
  } while (true);
  assert.deepEqual(seen, expected);
  assert.equal(page.page.nextCursor, null);
  assert.equal(new Set(seen).size, 146);
  assert.deepEqual(data, snapshot, 'read must not alter billing or any persisted state');
});

test('historyPage ordering prioritizes createdAt over ids and safely orders missing dates', () => {
  const data = fixture([log('z-old', { createdAt: '2025-01-01' }), log('a-new', { createdAt: '2026-01-01' }), log('missing', { createdAt: '' }), log('invalid', { createdAt: 'invalid' })]);
  assert.deepEqual(historyPage(data, EMAIL, params()).logs.map((entry) => entry.id), ['a-new', 'z-old', 'missing', 'invalid']);
});

test('historyPage keyset keeps older remainder after new inserts, hiding a boundary, and hiding unseen work', () => {
  const data = fixture(manyLogs());
  const first = historyPage(data, EMAIL, params());
  const allBefore = historyPage(data, EMAIL, params({ limit: '100' })).logs.map((entry) => entry.id);
  const hiddenId = 'log-080';
  data.spendLogs.find((entry) => entry.id === first.logs.at(-1).id).hiddenFromHistory = true;
  data.spendLogs.find((entry) => entry.id === hiddenId).hiddenFromHistory = true;
  data.spendLogs.push(log('zz-new-same-timestamp'), log('a-newer', { createdAt: '2026-11-01T00:00:00Z' }));
  const next = historyPage(data, EMAIL, params({ cursor: first.page.nextCursor, limit: '100' }));
  assert.ok(next.logs.every((entry) => !first.logs.some((previous) => previous.id === entry.id)));
  assert.ok(!next.logs.some((entry) => [hiddenId, 'zz-new-same-timestamp', 'a-newer'].includes(entry.id)));
  assert.deepEqual(next.logs.slice(0, 75).map((entry) => entry.id), allBefore.slice(24).filter((id) => id !== hiddenId));
  assert.equal(next.page.total, 146);
});

test('historyPage searches full prompts, models, group/child identifiers, displayed settings and fees beyond recent100', () => {
  const longPrompt = `${'ordinary '.repeat(100)}tail-needle`;
  const logs = manyLogs();
  logs.push(log('ancient', { createdAt: '2001-01-01', prompt: longPrompt, model: 'rare-model', chargedMicros: 1234567, estimatedCostMicros: 1234567, settings: { size: '7:3', resolution: '8k', quality: 'unusual', n: 4 } }));
  logs.push(log('rare-child-id', { batchId: 'old-batch', batchIndex: 0, createdAt: '2000-01-01', taskId: 'external-rare-task', prompt: 'batch complete' }), log('sibling', { batchId: 'old-batch', batchIndex: 1, createdAt: '2000-01-01', prompt: 'child-tail-needle' }));
  const data = fixture(logs);
  for (const q of ['tail-needle', 'rare-model', 'ancient', '7:3', '8k', 'unusual', '4张', '¥1.23']) {
    const page = historyPage(data, EMAIL, params({ q }));
    assert.ok(page.logs.some((entry) => entry.id === 'ancient'), q);
  }
  for (const q of ['old-batch', 'rare-child-id', 'external-rare-task', 'child-tail-needle']) {
    const page = historyPage(data, EMAIL, params({ q }));
    assert.equal(page.logs.length, 1, q);
    assert.equal(page.logs[0].id, 'old-batch');
    assert.equal(page.logs[0].children.length, 2, 'search cannot truncate a matched batch to one child');
  }
  assert.ok(historyPage(data, EMAIL, params({ q: 'completed' })).page.total > 100);
  assert.equal(historyPage(data, EMAIL, params({ q: 'not-present' })).page.total, 0);
});

test('historyPage filters match gallery status, image and original/legacy reference semantics', () => {
  const failed = ['failed', 'error', 'cancelled', 'submit_failed_refunded', 'submission_refunded_closed', 'attention_required', 'submission_unknown'];
  const partial = ['partial_success', 'partial'];
  const active = ['processing', 'queued', 'submitting', 'submitted', 'pending', 'archiving', 'running', 'future-status'];
  const data = fixture([
    ...[...failed, ...partial, ...active, 'completed', 'succeeded', 'success'].map((status) => log(status, { status, imageUrls: [] })),
    log('failed-with-image', { status: 'failed' }),
    log('ref-authoritative', { referenceImageCount: 2 }),
    log('ref-settings-count', { settings: { referenceImageCount: 3 } }),
    log('ref-legacy-images', { settings: { image_urls: ['data:image/png;base64,AAAA', 'https://fixture.invalid/ref.png'] } }),
    log('ref-legacy-count', { imageUrlsReferenceCount: 4 })
  ]);
  const ids = (filter) => historyPage(data, EMAIL, params({ filter, limit: '100' })).logs.map((entry) => entry.id).sort();
  assert.deepEqual(ids('failed'), [...failed, 'failed-with-image'].sort());
  assert.deepEqual(ids('partial'), partial.sort());
  assert.deepEqual(ids('active'), active.sort());
  assert.deepEqual(ids('completed'), ['failed-with-image', 'ref-authoritative', 'ref-settings-count', 'ref-legacy-images', 'ref-legacy-count'].sort());
  assert.deepEqual(ids('with-reference'), ['ref-authoritative', 'ref-settings-count', 'ref-legacy-images', 'ref-legacy-count'].sort());
  const legacy = historyPage(data, EMAIL, params({ q: 'ref-legacy-images' })).logs[0];
  assert.equal(legacy.referenceImageCount, 2);
  assert.deepEqual(legacy.settings.image_urls, ['https://fixture.invalid/ref.png']);
});

test('historyPage validates bounded inputs and account/query/filter-bound signed cursors', () => {
  const data = fixture(manyLogs());
  const cursor = historyPage(data, EMAIL, params()).page.nextCursor;
  const invalidCursor = (values, email = EMAIL) => assert.throws(() => historyPage(data, email, params(values)), { statusCode: 400, code: 'history_cursor_invalid' });
  for (const value of ['', 'bogus', 'a.b', 'a'.repeat(2049), cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A')]) invalidCursor({ cursor: value });
  invalidCursor({ cursor }, OTHER);
  invalidCursor({ cursor, q: 'different' });
  invalidCursor({ cursor, filter: 'active' });
  const [body, mac] = cursor.split('.');
  const tampered = JSON.parse(Buffer.from(body, 'base64url'));
  assert.ok(!body.includes(EMAIL));
  assert.ok(!JSON.stringify(tampered).includes(EMAIL));
  for (const changes of [{ v: 2 }, { id: 'other-owned-boundary' }, { t: 0 }]) {
    invalidCursor({ cursor: `${Buffer.from(JSON.stringify({ ...tampered, ...changes })).toString('base64url')}.${mac}` });
  }
  const normalizedCursor = historyPage(data, EMAIL, params({ q: ' FULL PROMPT ' })).page.nextCursor;
  assert.doesNotThrow(() => historyPage(data, EMAIL, params({ cursor: normalizedCursor, q: 'full prompt', limit: '8' })));
  for (const values of [{ limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'NaN' }, { limit: '' }, { limit: '1e2' }, { limit: '9007199254740992' }, { filter: 'nonsense' }, { q: 'x'.repeat(1001) }]) {
    assert.throws(() => historyPage(data, EMAIL, params(values)), { statusCode: 400, code: 'history_query_invalid' });
  }
  assert.equal(historyPage(data, EMAIL, params({ limit: '101' })).logs.length, 100);
  assert.doesNotThrow(() => historyPage(data, EMAIL, params({ q: 'x'.repeat(1000) })));
  const restarted = spawnSync(process.execPath, ['-e', `const {historyPage}=require('./lib/history-pagination');try{historyPage({spendLogs:[]},${JSON.stringify(EMAIL)},new URLSearchParams({cursor:${JSON.stringify(cursor)}}));process.exit(1)}catch(e){console.log(e.code);process.exit(e.code==='history_cursor_invalid'?0:2)}`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.stdout, /history_cursor_invalid/);
});

test('pagedPublicLog omits embedded data and known credential fields without changing ordinary DTOs or stored inputs', () => {
  const source = log('safe', { referenceImageCount: 2, settings: { image_urls: ['data:image/png;base64,AAAA', '/api/stored-images/input.png'], n: 1 }, submitResponse: { data: { result: [{ b64_json: 'RAW_SECRET_BYTES', url: 'data:image/png;base64,AAAA' }, { url: 'https://fixture.invalid/original.png' }], api_key: 'provider-secret' } }, attempts: [{ provider: 'market', apiKey: 'provider-secret', externalTaskId: 'private-provider-id' }], billingVersion: 'fixed-quote-v2' });
  const before = structuredClone(source);
  const dto = pagedPublicLog(source);
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('data:image'));
  assert.ok(!json.includes('RAW_SECRET_BYTES'));
  assert.ok(!json.includes('provider-secret'));
  assert.ok(!json.includes('private-provider-id'));
  assert.equal(dto.referenceImageCount, 2);
  assert.deepEqual(dto.settings.image_urls, ['/api/stored-images/input.png']);
  assert.deepEqual(dto.imageUrls, before.imageUrls);
  assert.equal(dto.chargedMicros, before.chargedMicros);
  assert.equal(dto.submitResponse.data.result[1].url, 'https://fixture.invalid/original.png');
  assert.deepEqual(source, before);
  assert.deepEqual(pagedPublicLog(log('ordinary')), log('ordinary'));
  const nested = {};
  let tail = nested;
  for (let i = 0; i < 12000; i += 1) { tail.value = {}; tail = tail.value; }
  tail.base64 = 'embedded';
  const deep = pagedPublicLog(log('deep', { nested }));
  let result = deep.nested;
  for (let i = 0; i < 12000; i += 1) result = result.value;
  assert.deepEqual(result, {});
});

test('pagedPublicLog and historyPage preserve authoritative illustrative data syntax prompts verbatim', () => {
  const prompt = '  Create a tutorial illustration titled "data:image/png;base64" with no actual image data.\n保留示例 /api/stored-images/example.png and punctuation verbatim.  ';
  const source = log('illustrative-prompt', {
    prompt,
    settings: { image_urls: ['data:image/png;base64,AAAA', '/api/stored-images/input.png'], n: 1 },
    submitResponse: { prompt: 'data:image/png;base64,PROVIDER_PAYLOAD', b64_json: 'RAW_SECRET_BYTES', api_key: 'provider-secret', url: 'https://fixture.invalid/original.png' }
  });
  const before = structuredClone(source);
  const dto = pagedPublicLog(source);
  assert.equal(dto.prompt, prompt);
  assert.deepEqual(dto.settings.image_urls, ['/api/stored-images/input.png']);
  assert.equal(dto.referenceImageCount, 2);
  assert.deepEqual(dto.submitResponse, { url: 'https://fixture.invalid/original.png' });
  assert.deepEqual(dto.imageUrls, source.imageUrls);
  assert.equal(dto.chargedMicros, source.chargedMicros);
  assert.deepEqual(source, before);

  const data = fixture([
    source,
    log('illustrative-batch-child', { prompt, batchId: 'illustrative-batch', batchIndex: 0 }),
    log('illustrative-tombstone', { prompt, assetsDeletedAt: '2026-10-02' })
  ]);
  const snapshot = structuredClone(data);
  const page = historyPage(data, EMAIL, params({ q: 'data:image/png;base64' }));
  assert.equal(page.page.total, 3);
  for (const entry of page.logs) assert.equal(entry.prompt, prompt, entry.id);
  assert.deepEqual(page.logs.find((entry) => entry.id === source.id), dto);
  assert.deepEqual(data, snapshot);
});

test('paged route is authenticated, only-own and hidden/tombstone safe, with zero provider HTTP or persisted mutations', async () => {
  const logs = [
    ...manyLogs(), log('foreign', { email: OTHER, prompt: 'private-other-prompt' }),
    log('hidden', { hiddenFromHistory: true, prompt: 'private-hidden-prompt' }),
    log('tombstone', { assetsDeletedAt: '2026-10-02', imageFiles: [{ fileName: 'deleted.png' }], inputFiles: [{ fileName: 'deleted-input.png' }], imageUrls: ['/api/stored-images/deleted.png'], settings: { image_urls: ['/api/stored-images/deleted-input.png'] }, submitResponse: { url: '/api/stored-images/deleted.png' } }),
    log('active', { status: 'submitted', settled: false, taskId: 'must-not-poll-upstream', submittedAt: '2000-01-01' })
  ];
  await withStore(logs, async (dir) => {
    const before = fs.readFileSync(path.join(dir, 'app-data.json'), 'utf8');
    const snapshot = structuredClone(loadDataStore());
    const originals = [http.request, https.request];
    const previousKey = process.env.API_MARKET_API_KEY;
    process.env.API_MARKET_API_KEY = 'fixture-only-provider-key';
    let calls = 0;
    http.request = https.request = () => { calls += 1; throw new Error('paged history must never poll a provider'); };
    try {
      const response = await invoke();
      assert.equal(response.code, 200);
      assert.equal(response.json.page.total, 148);
      assert.equal(response.json.logs.length, 24);
      assert.equal((await invoke('paged=1', '')).code, 401);
      const foreign = await invoke('paged=1', 'other');
      assert.deepEqual(foreign.json.logs.map((entry) => entry.id), ['foreign']);
      for (const q of ['private-other-prompt', 'private-hidden-prompt']) assert.equal((await invoke(params({ paged: '1', q }).toString())).json.page.total, 0);
      const deleted = (await invoke('paged=1&q=tombstone')).json.logs[0];
      assert.deepEqual(deleted.imageUrls, []);
      assert.deepEqual(deleted.imageFiles, []);
      assert.deepEqual(deleted.inputFiles, []);
      assert.equal((await invoke('paged=1&q=tombstone&filter=completed')).json.page.total, 0);
      assert.ok(!JSON.stringify(deleted).includes('/api/stored-images/deleted'));
      assert.equal((await invoke('paged=1&cursor=bogus')).json.error.code, 'history_cursor_invalid');
      assert.equal((await invoke('paged=1&limit=-1')).code, 400);
      assert.equal(calls, 0);
      assert.deepEqual(loadDataStore(), snapshot);
      assert.equal(fs.readFileSync(path.join(dir, 'app-data.json'), 'utf8'), before);
    } finally {
      [http.request, https.request] = originals;
      if (previousKey === undefined) delete process.env.API_MARKET_API_KEY;
      else process.env.API_MARKET_API_KEY = previousKey;
    }
  });
});

test('legacy history retains its envelope, limits, offsets, embedded input echo and full grouped DTOs', async () => {
  await withStore([...manyLogs(), log('zz-legacy', { createdAt: '2026-11-01T00:00:00Z', settings: { image_urls: ['data:image/png;base64,legacy'] } })], async () => {
    const data = loadDataStore();
    for (const [query, limit, offset] of [['limit=100&offset=11', 100, 11], ['limit=7&offset=3', 7, 3], ['', 20, 0], ['paged=0&limit=5', 5, 0]]) {
      const response = await invoke(query);
      assert.equal(response.code, 200);
      assert.deepEqual(Object.keys(response.json), ['logs']);
      assert.deepEqual(response.json.logs, getLogsForEmail(data, EMAIL, limit, offset));
    }
    const response = await invoke('limit=100');
    assert.equal(response.json.logs.find((entry) => entry.id === 'zz-legacy').settings.image_urls[0], 'data:image/png;base64,legacy');
    assert.equal(getLogsForEmail(data, EMAIL, 100, 137).find((entry) => entry.kind === 'batch').children.length, 3);
  });
});

test('legacy history rechecks revoked sessions after awaited history mutations', async () => {
  await withStore([log('one')], async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const revoke = withDataStoreMutation(async (latest) => { await gate; delete latest.sessions.owner; });
    await new Promise((resolve) => setImmediate(resolve));
    const pending = invoke('limit=100');
    release();
    await revoke;
    const response = await pending;
    assert.equal(response.code, 401);
    assert.ok(!response.json.logs);
    assert.equal((await invoke()).code, 401);
  });
});

test('legacy history rechecks a session revoked while provider refresh is awaiting HTTP', async () => {
  await withStore([log('await-provider', { status: 'processing', settled: false, taskId: 'fixture-task' })], async () => {
    const previousKey = process.env.API_MARKET_API_KEY;
    process.env.API_MARKET_API_KEY = 'fixture-only-key';
    const originalRequest = https.request;
    let reachedProvider;
    const reached = new Promise((resolve) => { reachedProvider = resolve; });
    let finishProvider;
    https.request = (_options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.setTimeout = () => outgoing;
      outgoing.write = () => true;
      outgoing.destroy = () => {};
      outgoing.end = () => {
        finishProvider = () => {
          const upstream = Readable.from([Buffer.from('{}')]);
          upstream.statusCode = 503;
          upstream.headers = {};
          callback(upstream);
        };
        reachedProvider();
      };
      return outgoing;
    };
    try {
      const pending = invoke('limit=100');
      await reached;
      await withDataStoreMutation((latest) => { delete latest.sessions.owner; });
      finishProvider();
      const response = await pending;
      assert.equal(response.code, 401);
      assert.ok(!response.json.logs);
      assert.equal(loadDataStore().users[EMAIL].balanceMicros, 9876543);
    } finally {
      https.request = originalRequest;
      if (previousKey === undefined) delete process.env.API_MARKET_API_KEY;
      else process.env.API_MARKET_API_KEY = previousKey;
    }
  });
});
