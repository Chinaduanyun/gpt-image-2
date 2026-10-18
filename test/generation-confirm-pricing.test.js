const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
// Execute the real backend pricing modules with an empty environment, never host env/config.
const modules = new Map();
function loadBackend(name) {
  if (modules.has(name)) return modules.get(name);
  assert.ok(['constants', 'pricing-config', 'pricing'].includes(name));
  const filename = path.join(root, 'lib', `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env: Object.freeze({}) },
    require(id) {
      if (id === 'node:path') return path;
      assert.ok(id.startsWith('./'));
      return loadBackend(id.slice(2));
    }
  }, { filename });
  modules.set(name, module.exports);
  return module.exports;
}
const backend = loadBackend('pricing');

function harness({ accepted = true, hybridImages = true } = {}) {
  const confirmations = [];
  const requests = [];
  const ns = {
    state: {
      publicConfig: {
        features: { hybridImages, quickBatchEnabled: true },
        pricing: {
          ...backend.pricingConfig,
          modelProfiles: { ...backend.pricingConfig.modelProfiles },
          simplePriceMap: backend.SIMPLE_PRICE_MAP,
          officialPriceMap: backend.OFFICIAL_PRICE_MAP,
          sizeResolutionMap: backend.SIZE_RESOLUTION_MAP
        }
      },
      session: { token: 'mock-token', user: { email: 'mock@example.invalid' } },
      accountEpoch: 1
    },
    els: {
      model: { value: 'gpt-image-2-official' }, quality: { value: 'low' },
      aspectRatio: { value: '1:1' }, resolution: { value: '1k' },
      imageCount: { value: '4' }, progressHint: {}
    },
    async savePendingRequest(value) { ns.state.pendingRequest = value; },
    async requestJson(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      // Stop at a deterministic mock rejection; no polling, timers, server or provider.
      return { ok: false, status: 400, json: { error: 'mock stop' } };
    },
    getErrorMessage: () => 'mock stop',
    toErrorText: (value) => String(value || ''), announceLive() {},
    resetResult() {}, setStatus() {}, saveStoredResult() {}, renderResult() {},
    loadMe: async () => {}, loadMyLogs: async () => {}, showDebug() {}
  };
  const context = vm.createContext({
    window: { ImageGen: ns, confirm(message) { confirmations.push(message); return accepted; } },
    AbortController
  });
  for (const script of ['pricing', 'generation']) {
    const filename = path.join(root, 'app', `${script}.js`);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  // UI-only effects are isolated; pricing, confirmation and serialization remain real.
  for (const method of ['setBusy', 'startProgress', 'stopProgress', 'setProgress', 'setGenerationStep', 'failProgress']) ns[method] = () => {};
  return { ns, confirmations, requests };
}

function assertBackendPrice(ns, settings) {
  const actual = ns.estimatePrice(settings);
  const expected = backend.estimateGenerationCostMicros(settings);
  assert.equal(actual.ok, true);
  assert.equal(expected.ok, true);
  for (const key of ['model', 'totalMultiplier', 'minimumPerImageMicros', 'convertedUnitMicros', 'unitMicros', 'totalMicros', 'pixelSize', 'isMaximum']) {
    assert.equal(actual[key], expected[key], key);
  }
  return expected;
}

const editSettings = {
  model: 'gpt-image-2-official', quality: 'low', n: 1,
  size: '16:9', resolution: '4k', prompt: 'isolated edit'
};

test('creation 1k x4 versus edit 4k x1: confirmation and submitted settings match backend', async () => {
  const { ns, confirmations, requests } = harness();
  assert.equal(ns.estimatePrice().totalMicros, 1200000);
  const expected = assertBackendPrice(ns, editSettings);
  assert.equal(expected.totalMicros, 850000);
  await ns.runGeneration(editSettings);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0], '生成 1 张，费用 ¥0.850。继续？');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/api-market/v1/images/generations');
  assert.deepEqual(requests[0].body, { ...editSettings, bestEffortAccepted: true });
  assert.equal(Object.hasOwn(editSettings, 'bestEffortAccepted'), false);
  assert.equal(ns.estimatePrice().totalMicros, 1200000);
});

test('all five pricing overrides drive policy, price map, quality, pixels and count', async () => {
  const cases = [
    { ...editSettings, quality: 'high', n: 2 },
    { ...editSettings, model: 'gpt-image-2', n: 3 },
    { ...editSettings, model: 'gpt-image-2-ext', n: 2 },
    { ...editSettings, size: 'unmapped', quality: 'high' }
  ];
  for (const settings of cases) {
    const { ns, confirmations, requests } = harness();
    // Opposite model/quality on creation controls exposes accidental DOM reads.
    ns.els.model.value = settings.model === 'gpt-image-2-official' ? 'gpt-image-2' : 'gpt-image-2-official';
    const expected = assertBackendPrice(ns, settings);
    await ns.runGeneration(settings);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0], `生成 ${settings.n} 张，${expected.isMaximum ? '最高' : '费用'} ${ns.formatMicros(expected.totalMicros)}。继续？`);
    assert.deepEqual(requests[0].body, { ...settings, bestEffortAccepted: true });
  }
});

test('partial edit overrides and no-argument creation pricing retain their defaults', () => {
  const { ns } = harness();
  assertBackendPrice(ns, { model: 'gpt-image-2-official', quality: 'low', n: 4, size: '1:1', resolution: '1k' });
  assert.equal(ns.estimatePrice().totalMicros, 1200000);
  assert.equal(ns.estimatePrice({ size: '16:9', resolution: '4k', n: 1 }).totalMicros, 850000);
});

test('cancelled confirmation never submits', async () => {
  const { ns, confirmations, requests } = harness({ accepted: false });
  await ns.runGeneration(editSettings);
  assert.equal(confirmations.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(ns.state.pendingRequest, undefined);
});

test('missing submitted model policy fails closed even when creation policy is valid', async () => {
  const { ns, confirmations, requests } = harness();
  ns.els.model.value = 'gpt-image-2';
  delete ns.state.publicConfig.pricing.modelProfiles['gpt-image-2-official'];
  assert.equal(ns.estimatePrice().ok, true);
  await ns.runGeneration(editSettings);
  assert.equal(confirmations.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(ns.state.pendingRequest, undefined);
});

test('non-hybrid submission does not add a confirmation or acceptance field', async () => {
  const { ns, confirmations, requests } = harness({ hybridImages: false });
  await ns.runGeneration(editSettings);
  assert.equal(confirmations.length, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, editSettings);
});
