const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function classes() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); }
  };
}

function element(value = '') {
  return {
    value,
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: '',
    classList: classes(),
    style: { width: '', setProperty() {} },
    setAttribute() {},
    removeAttribute() {},
    replaceChildren(...children) { this.children = children; },
    focus() {},
    scrollIntoView() {},
    querySelectorAll() { return []; }
  };
}

function loadScript(ns, script, extras = {}) {
  const localStorageValues = new Map();
  const window = {
    ImageGen: ns,
    localStorage: {
      getItem(key) { return localStorageValues.get(key) ?? null; },
      setItem(key, value) { localStorageValues.set(key, String(value)); },
      removeItem(key) { localStorageValues.delete(key); }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: false }; },
    confirm() { return true; },
    ...extras.window
  };
  const context = vm.createContext({
    window,
    globalThis: extras.globalThis || { crypto: globalThis.crypto, indexedDB: null },
    document: extras.document || { createElement: () => element(), getElementById: () => null },
    navigator: extras.navigator || { clipboard: { async writeText() {} } },
    AbortController,
    TextEncoder,
    URL,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Math,
    Number,
    String,
    Date,
    Promise,
    Error,
    TypeError,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: extras.fetch
  });
  vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), context, { filename: script });
  return { ns, window, context, localStorageValues };
}

function generationHarness() {
  const ns = {
    state: {
      session: { token: 'token', user: { email: 'user@example.com' } },
      publicConfig: { progress: {}, features: { quickBatchEnabled: true } },
      pendingRequest: null,
      isBusy: false,
      referenceImages: [],
      accountEpoch: 0
    },
    polling: {},
    generationStepOrder: ['validate', 'submit', 'queued', 'poll', 'result', 'done'],
    els: {
      progressBar: element(), progressPercent: element(), progressTrack: element(), progressPanel: element(),
      progressHint: element(), progressElapsed: element(), generationSteps: element(), runBtn: element(), clearBtn: element(),
      model: element('gpt-image-2'), aspectRatio: element('1:1'), resolution: element('1k'), imageCount: element('4'),
      quality: element('low'), outputFormat: element('png'), outputCompression: element('90'), referenceUploadBtn: element(),
      referenceFileInput: element(), prompt: element('test'), refreshCurrentTaskBtn: element()
    },
    updatePendingUi() {},
    renderReferences() {},
    isOfficialModel() { return this.els.model.value === 'gpt-image-2-official'; },
    isQuickBatchEnabled() { return true; },
    getImageCount() { return Number(this.els.imageCount.value); },
    requestJson: async () => ({ ok: true, status: 200, json: {} }),
    saveStoredResult() {},
    renderResult() {},
    toErrorText: (value) => typeof value === 'string' ? value : (value == null ? '' : (value.message || value.error || value.detail || '')),
    announceLive() {},
    setStatus() {},
    showDebug() {},
    loadMe: async () => true,
    loadMyLogs: async () => {},
    clearPendingRequestSafely: async () => {},
    savePendingRequest: async (pending) => { ns.state.pendingRequest = pending; },
    restorePendingRequest: async () => ns.state.pendingRequest,
    estimatePrice: () => ({ ok: true, totalMicros: 1224000, minimumPerImageMicros: 300000 }),
    formatMicros: (value) => `micros:${value}`,
    setBusy(value) { this.state.isBusy = value; },
    resetResult() {},
    updatePriceEstimate() {}
  };
  return loadScript(ns, 'app/generation.js');
}

test('batch normalization preserves requested slots, child order, statuses and aggregate billing', () => {
  const { ns } = generationHarness();
  const result = ns.normalizeBatchResult({
    kind: 'batch',
    batch_id: 'batch_1',
    status: 'partial_success',
    requestedCount: 4,
    counts: { succeeded: 2, failed: 1, unknown: 1, pending: 0, processing: 0 },
    children: [
      { index: 3, status: 'submission_unknown', error: 'unknown' },
      { index: 0, status: 'completed', imageUrl: '/zero.png', billing: { chargedMicros: 300000 } },
      { index: 2, status: 'failed', error: 'failed' },
      { index: 1, status: 'completed', imageUrls: ['/one.png'] }
    ],
    aggregateBilling: { settled: true, actualCostMicros: 600000 }
  }, { prompt: 'test', settings: { model: 'gpt-image-2', n: 4 } });

  assert.equal(result.kind, 'batch');
  assert.equal(result.batchId, 'batch_1');
  assert.equal(result.requestedCount, 4);
  assert.deepEqual(Array.from(result.children, (child) => child.index), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(result.children, (child) => child.status), ['completed', 'completed', 'failed', 'submission_unknown']);
  assert.deepEqual(Array.from(result.imageUrls), ['/zero.png', '/one.png']);
  assert.equal(result.children[0].billing.chargedMicros, 300000);
  assert.equal(result.billing.actualCostMicros, 600000);
  assert.equal(result.counts.succeeded, 2);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.unknown, 1);
});

test('result rendering keeps one visible slot per requested child including failed and unknown positions', () => {
  const ns = {
    state: {
      result: {
        kind: 'batch', batchId: 'batch_slots', status: 'attention_required', requestedCount: 4,
        settings: { model: 'gpt-image-2', size: '1:1', resolution: '1k' },
        counts: { succeeded: 1, failed: 1, unknown: 1 },
        children: [
          { index: 2, status: 'failed', imageUrl: '', error: 'bad' },
          { index: 0, status: 'completed', imageUrl: '/ok.png', error: '' },
          { index: 3, status: 'submission_unknown', imageUrl: '', error: 'unknown' }
        ],
        imageUrls: ['/ok.png']
      },
      lastResultFocusId: ''
    },
    els: {
      emptyState: element(), resultCard: element(), resultActions: element(), resultGrid: element(),
      resultSummary: element(), taskIdText: element(), useAllResultsAsReferenceBtn: element(), regenerateResultBtn: element(),
      refreshCurrentTaskBtn: element(), debugDetails: element(), debugOutput: element()
    },
    hasPendingGeneration: () => true,
    showDebug() {},
    setStatus() {},
    clearReferences() {},
    clearStoredResult() {},
    resetProgress() {}
  };
  loadScript(ns, 'app/results.js');
  const rendered = [];
  ns.createResultItem = (child, index) => {
    rendered.push({ index, status: child.status, imageUrl: child.imageUrl });
    return { child, index };
  };
  ns.renderResult();

  assert.deepEqual(rendered, [
    { index: 0, status: 'completed', imageUrl: '/ok.png' },
    { index: 1, status: 'attention_required', imageUrl: '' },
    { index: 2, status: 'failed', imageUrl: '' },
    { index: 3, status: 'submission_unknown', imageUrl: '' }
  ]);
  assert.match(ns.els.resultSummary.textContent, /1\/4 成功/);
  assert.match(ns.els.resultSummary.textContent, /1 失败/);
  assert.match(ns.els.resultSummary.textContent, /1 未知/);
  assert.equal(ns.els.taskIdText.textContent, 'Batch ID: batch_slots');
  assert.equal(ns.els.refreshCurrentTaskBtn.classList.contains('hidden'), false);
});

test('pending recovery refuses a different account and account reset aborts in-flight work', async () => {
  const { ns } = generationHarness();
  let submitCalls = 0;
  ns.submitGeneration = async () => { submitCalls += 1; return { ok: true, json: {} }; };
  ns.state.pendingRequest = {
    idempotencyKey: 'foreign-key', settings: { model: 'gpt-image-2', prompt: 'test', n: 4 },
    requestedCount: 4, ownerEmail: 'other@example.com'
  };
  await ns.recoverPendingGeneration();
  assert.equal(submitCalls, 0);
  assert.equal(ns.state.isBusy, false);

  let pollAborted = false;
  let submitAborted = false;
  ns.state.pollController = { abort() { pollAborted = true; } };
  ns.state.submitController = { abort() { submitAborted = true; } };
  ns.state.result = { batchId: 'batch_1' };
  ns.state.myLogs = [{ id: 'log_1' }];
  ns.stopProgress = () => {};
  loadScript(ns, 'app/auth.js');
  const before = ns.state.accountEpoch;
  ns.resetAccountRuntime();
  assert.equal(pollAborted, true);
  assert.equal(submitAborted, true);
  assert.equal(ns.state.accountEpoch, before + 1);
  assert.equal(ns.state.pendingRequest, null);
  assert.equal(ns.state.result, null);
  assert.equal(ns.state.myLogs.length, 0);
});

test('ambiguous submit responses preserve the original pending idempotency record', async () => {
  const { ns } = generationHarness();
  ns.submitGeneration = async () => ({ ok: false, status: 503, json: { error: { message: 'upstream timeout' } } });
  ns.showDebug = () => {};
  await ns.handleRun();
  assert.equal(ns.state.pendingRequest?.ownerEmail, 'user@example.com');
  assert.ok(ns.state.pendingRequest?.idempotencyKey);
  assert.equal(ns.state.pendingRequest?.settings.n, 4);
  assert.equal(ns.state.isBusy, false);
});

test('stored results and pending requests use account-scoped keys', () => {
  const ns = { state: { session: { user: { email: 'alice@example.com' } }, accountEpoch: 0 }, getStoredSession: () => ({ email: '', token: '' }) };
  loadScript(ns, 'app/auth.js');
  assert.equal(ns.resultStorageKey(), 'imageGenLastResult:alice@example.com');
  assert.equal(ns.pendingStorageKey(), 'imageGenPendingRequest:alice@example.com');
  ns.state.session.user.email = 'bob@example.com';
  assert.equal(ns.resultStorageKey(), 'imageGenLastResult:bob@example.com');
  assert.equal(ns.pendingStorageKey(), 'imageGenPendingRequest:bob@example.com');
});

test('stale 401 responses cannot clear a newer account session', async () => {
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const ns = {
    state: { session: { token: 'old-token', user: { email: 'old@example.com' } } },
    clearStoredSession(expected) {
      if (this.storedToken !== expected) return false;
      this.storedToken = '';
      return true;
    },
    storedToken: 'old-token',
    resetAccountRuntime() { this.resetCount = (this.resetCount || 0) + 1; },
    renderAuthState() {}
  };
  loadScript(ns, 'app/utils.js', { fetch: () => fetchPromise });
  const request = ns.requestJson('/api/me');
  ns.state.session = { token: 'new-token', user: { email: 'new@example.com' } };
  ns.storedToken = 'new-token';
  resolveFetch({ ok: false, status: 401, async text() { return '{}'; } });
  await request;
  assert.equal(ns.state.session.token, 'new-token');
  assert.equal(ns.storedToken, 'new-token');
  assert.equal(ns.resetCount, undefined);
});

test('toErrorText renders any error value as human text, never [object Object]', () => {
  const ns = {};
  loadScript(ns, 'app/utils.js');
  assert.equal(ns.toErrorText('boom'), 'boom');
  assert.equal(ns.toErrorText({ message: '上游超时' }), '上游超时');
  assert.equal(ns.toErrorText({ error: 'e' }), 'e');
  assert.equal(ns.toErrorText({ detail: 'd' }), 'd');
  assert.equal(ns.toErrorText(null), '');
  assert.equal(ns.toErrorText(undefined), '');
  assert.equal(ns.toErrorText({}), '');
  const objText = ns.toErrorText({ code: 'E_UPSTREAM', reason: 'boom' });
  assert.notEqual(objText, '[object Object]');
  assert.match(objText, /E_UPSTREAM/);
});

test('batch normalization keeps object errors carrying a message readable', () => {
  const { ns } = generationHarness();
  const result = ns.normalizeBatchResult({
    requestedCount: 1,
    children: [{ index: 0, status: 'failed', error: { message: '上游超时' } }]
  }, { settings: { model: 'gpt-image-2', n: 1 } });
  assert.equal(result.children[0].error, '上游超时');
});

test('isSafeLinkUrl allows http(s) and same-origin relative paths, rejects script/data schemes', () => {
  const ns = {};
  loadScript(ns, 'app/utils.js');
  assert.equal(ns.isSafeLinkUrl('/images/a.png'), true);
  assert.equal(ns.isSafeLinkUrl('https://cdn.example.com/a.png'), true);
  assert.equal(ns.isSafeLinkUrl('http://example.com/a.png'), true);
  assert.equal(ns.isSafeLinkUrl('javascript:alert(1)'), false);
  assert.equal(ns.isSafeLinkUrl('data:image/png;base64,AAAA'), false);
  assert.equal(ns.isSafeLinkUrl('vbscript:msgbox(1)'), false);
  assert.equal(ns.isSafeLinkUrl('  '), false);
  assert.equal(ns.isSafeLinkUrl(''), false);
  assert.equal(ns.isSafeLinkUrl(null), false);
});

test('only the latest concurrent login attempt can activate a session', async () => {
  const pending = [];
  const ns = {
    state: { accountEpoch: 0, session: null, referenceImages: [], myLogs: [], loginAttemptId: 0 },
    els: {
      emailInput: element('alice@example.com'), loginBtn: element(), prompt: element(), referenceFileInput: element(),
      loginPanel: element(), userBar: element(), appShell: element(), adminToggleBtn: element(), adminPanel: element(),
      currentUserEmail: element(), currentUserBalance: element()
    },
    requestJson: () => new Promise((resolve) => pending.push(resolve)),
    setLoginStatus() {}, setStatus() {}, stopProgress() {}, updatePromptStats() {}, renderReferences() {},
    updatePendingUi() {}, updatePriceEstimate() {}, renderResult() {}, loadMyLogs: async () => {}, loadAdminData: async () => {},
    recoverPendingGeneration: async () => {}, formatMicros: (value) => String(value)
  };
  loadScript(ns, 'app/auth.js');
  const first = ns.handleLogin();
  ns.els.emailInput.value = 'bob@example.com';
  const second = ns.handleLogin();
  pending[1]({ ok: true, status: 200, json: { token: 'bob-token', user: { email: 'bob@example.com', balanceMicros: 0 } } });
  await second;
  pending[0]({ ok: true, status: 200, json: { token: 'alice-token', user: { email: 'alice@example.com', balanceMicros: 0 } } });
  await first;
  assert.equal(ns.state.session.token, 'bob-token');
  assert.equal(ns.state.session.user.email, 'bob@example.com');
  assert.equal(ns.els.loginBtn.disabled, false);
  assert.equal(ns.els.emailInput.disabled, false);
});

test('account reset clears prompt and reference payloads', () => {
  const ns = {
    state: {
      accountEpoch: 0, session: { token: 'token', user: { email: 'user@example.com' } },
      referenceImages: [{ value: 'secret-image' }], myLogs: [], pendingRequest: null
    },
    els: { prompt: element('secret prompt'), referenceFileInput: element('selected') },
    stopProgress() {}, updatePromptStats() {}, renderReferences() {}, updatePendingUi() {}
  };
  loadScript(ns, 'app/auth.js');
  ns.resetAccountRuntime();
  assert.equal(ns.els.prompt.value, '');
  assert.equal(ns.els.referenceFileInput.value, '');
  assert.equal(ns.state.referenceImages.length, 0);
});

test('history renders child order and only offers tombstone action for terminal settled batches', () => {
  const ns = {
    state: { myLogs: [], historySearch: '', historyFilter: 'all' },
    els: { myLogsList: element() },
    formatMicros: (value) => `micros:${value}`,
    formatDate: () => 'date',
    escapeHtml: (value) => String(value ?? ''),
    isSafeLinkUrl: (url) => { const t = String(url ?? '').trim(); return t ? ((t.startsWith('/') && !t.startsWith('//')) || /^https?:/i.test(t)) : false; },
    toErrorText: (value) => (typeof value === 'string' ? value : (value == null ? '' : (value.message || value.error || value.detail || JSON.stringify(value)))),
    setStatus() {},
    hasPendingGeneration: () => false
  };
  loadScript(ns, 'app/history.js');
  ns.renderMyLogs([
    {
      id: 'settled', type: 'generation', status: 'partial_success', settled: true, requestedCount: 3,
      model: 'gpt-image-2', settings: { n: 3 }, estimatedCostMicros: 918000, chargedMicros: 600000,
      aggregateBilling: { settled: true, actualCostMicros: 600000 },
      children: [
        { index: 2, status: 'failed', taskId: 'task_2', error: { detail: '内容审核未通过' }, billing: { settled: true } },
        { index: 0, status: 'completed', taskId: 'task_0', billing: { settled: true } },
        { index: 1, status: 'completed', taskId: 'task_1', billing: { settled: true } }
      ],
      imageUrls: ['/0.png', '/1.png']
    },
    {
      id: 'refunded-closed', type: 'generation', status: 'submission_refunded_closed', settled: true, requestedCount: 1,
      model: 'gpt-image-2', settings: { n: 1 }, estimatedCostMicros: 306000, chargedMicros: 306000,
      aggregateBilling: { settled: true, actualCostMicros: 0 }, children: [], imageUrls: []
    },
    {
      id: 'pending', type: 'generation', status: 'processing', settled: false, requestedCount: 2,
      model: 'gpt-image-2', settings: { n: 2 }, estimatedCostMicros: 612000, chargedMicros: 612000,
      children: [{ index: 0, status: 'processing' }, { index: 1, status: 'submitted' }], imageUrls: []
    }
  ]);
  const html = ns.els.myLogsList.innerHTML;
  assert.match(html, /2\/3 成功 · 1 失败/);
  assert.ok(html.indexOf('task_0') < html.indexOf('task_1'));
  assert.ok(html.indexOf('task_1') < html.indexOf('task_2'));
  assert.match(html, /内容审核未通过/);
  assert.ok(!html.includes('[object Object]'));
  assert.match(html, /data-history-action="delete" data-log-id="settled"/);
  assert.match(html, /提交未确认，已退款并关闭/);
  assert.match(html, /data-history-action="delete" data-log-id="refunded-closed"/);
  assert.match(html, /不可隐藏/);
  assert.equal((html.match(/data-history-action="delete"/g) || []).length, 2);
});

test('official and legacy task responses remain single-task compatible', () => {
  const { ns } = generationHarness();
  const official = ns.normalizeTaskResult({
    data: { task_id: 'official_task', status: 'completed', result: { images: [{ url: '/a.png' }, { url: '/b.png' }] } },
    billing: { settled: true, actualCostMicros: 1200000 }
  }, { settings: { model: 'gpt-image-2-official', n: 4 }, prompt: 'official' });
  assert.equal(official.kind, 'task');
  assert.equal(official.taskId, 'official_task');
  assert.equal(official.requestedCount, 4);
  assert.deepEqual(Array.from(official.imageUrls), ['/a.png', '/b.png']);
  assert.equal(official.billing.actualCostMicros, 1200000);

  const legacy = ns.normalizeTaskResult({ task_id: 'legacy_task', status: 'completed', images: [{ url: '/legacy.png' }] }, {
    settings: { model: 'gpt-image-2', n: 1 }
  });
  assert.equal(legacy.kind, 'task');
  assert.equal(legacy.taskId, 'legacy_task');
  assert.deepEqual(Array.from(legacy.imageUrls), ['/legacy.png']);
});
