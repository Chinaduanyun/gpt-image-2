const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { estimateGenerationCostMicros } = require('../lib/pricing');
const { handlePublicConfig } = require('../routes/public-config');

const root = path.join(__dirname, '..');

function responseCapture() {
  return {
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { this.body = body; }
  };
}

function element(value = '') {
  const classes = new Set();
  return {
    value,
    textContent: '',
    disabled: false,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    }
  };
}

function createPricingHarness(model = 'gpt-image-2') {
  const res = responseCapture();
  handlePublicConfig({ method: 'GET' }, res);
  const publicConfig = JSON.parse(res.body);
  const ns = {
    state: { publicConfig, session: { user: { balanceMicros: 50000000 } }, isBusy: false },
    constants: { MODEL_NOTES: { 'gpt-image-2': '', 'gpt-image-2-official': '' } },
    els: {
      model: element(model), imageCount: element('1'), aspectRatio: element('1:1'), resolution: element('1k'),
      quality: element('low'), outputFormat: element('png'), outputCompression: element('90'),
      prompt: element('test'), promptStats: element(), advancedSummary: element(), modelNote: element(),
      officialSettings: element(), compressionField: element(), compressionValue: element(),
      priceTotal: element(), priceDetail: element(), priceBalanceText: element(), priceWarning: element(),
      runBtn: element()
    }
  };
  const context = vm.createContext({ window: { ImageGen: ns }, Object, Number, Math, String });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/pricing.js'), 'utf8'), context, { filename: 'app/pricing.js' });
  return ns;
}

test('frontend estimates match backend model policies and per-image floor', () => {
  const cases = [
    { model: 'gpt-image-2', resolution: '1k', n: 1 },
    { model: 'gpt-image-2', resolution: '2k', n: 1 },
    { model: 'gpt-image-2', resolution: '4k', n: 1 },
    { model: 'gpt-image-2-official', size: '1:1', resolution: '4k', quality: 'high', n: 4 },
    { model: 'gpt-image-2-official', size: '3:1', resolution: '1k', quality: 'low', n: 4 }
  ];

  for (const settings of cases) {
    const ns = createPricingHarness(settings.model);
    ns.els.aspectRatio.value = settings.size || '1:1';
    ns.els.resolution.value = settings.resolution;
    ns.els.quality.value = settings.quality || 'low';
    ns.els.imageCount.value = String(settings.n);
    const frontend = ns.estimatePrice();
    const backend = estimateGenerationCostMicros(settings);
    assert.equal(frontend.ok, true, JSON.stringify(settings));
    assert.equal(frontend.unitMicros, backend.unitMicros, JSON.stringify(settings));
    assert.equal(frontend.totalMicros, backend.totalMicros, JSON.stringify(settings));
    assert.equal(frontend.totalMultiplier, backend.totalMultiplier, JSON.stringify(settings));
    assert.equal(frontend.minimumPerImageMicros, backend.minimumPerImageMicros, JSON.stringify(settings));
  }
});

test('adaptive display changes precision without changing micros', () => {
  const ns = createPricingHarness();
  assert.equal(ns.formatAdaptiveMicros(300000), '¥0.300');
  assert.equal(ns.formatAdaptiveMicros(306000), '¥0.306');
  // 向零截断而非四舍五入：5978280 -> ¥5.97（旧四舍五入版本为 ¥5.98），避免显示虚高。
  assert.equal(ns.formatAdaptiveMicros(5978280), '¥5.97');
  assert.equal(ns.estimatePrice().totalMicros, 306000);
});

test('adaptive display truncates toward zero instead of rounding up', () => {
  const ns = createPricingHarness();
  // ≥¥1 保留 2 位、截断
  assert.equal(ns.formatAdaptiveMicros(1999999), '¥1.99');
  assert.equal(ns.formatAdaptiveMicros(2000000), '¥2.00');
  assert.equal(ns.formatAdaptiveMicros(1000000), '¥1.00');
  // <¥1 保留 3 位、截断（不进位到 0.307）
  assert.equal(ns.formatAdaptiveMicros(306999), '¥0.306');
  assert.equal(ns.formatAdaptiveMicros(999999), '¥0.999');
  assert.equal(ns.formatAdaptiveMicros(0), '¥0.000');
  // 负数向零截断（余额调整为负时不夸大绝对值）
  assert.equal(ns.formatAdaptiveMicros(-1999999), '¥-1.99');
  assert.equal(ns.formatAdaptiveMicros(-500000), '¥-0.500');
});

test('missing selected model profile disables generation and reports configuration error', () => {
  const ns = createPricingHarness();
  delete ns.state.publicConfig.pricing.modelProfiles['gpt-image-2'];
  const estimate = ns.estimatePrice();
  assert.equal(estimate.ok, false);
  ns.updatePriceEstimate();
  assert.equal(ns.els.runBtn.disabled, true);
  assert.match(ns.els.priceDetail.textContent, /价格配置异常/);
});

test('removed price breakdown DOM and styles do not remain referenced', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = fs.readFileSync(path.join(root, 'app/dom.js'), 'utf8');
  const pricing = fs.readFileSync(path.join(root, 'app/pricing.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const removed of ['priceUnitText', 'priceCountText', 'priceBillingText']) {
    assert.equal(html.includes(removed), false, removed);
    assert.equal(dom.includes(removed), false, removed);
    assert.equal(pricing.includes(removed), false, removed);
  }
  assert.equal(html.includes('price-breakdown'), false);
  assert.equal(styles.includes('.price-breakdown'), false);
});

function createRerunHarness(script, estimate) {
  const confirmations = [];
  const statuses = [];
  let runCount = 0;
  const ns = {
    state: {
      result: { prompt: 'test', settings: { model: 'gpt-image-2', resolution: '1k' } },
      myLogs: [{ id: 'log-1', type: 'generation', prompt: 'test', model: 'gpt-image-2', settings: { resolution: '1k' } }],
      historySearch: '',
      historyFilter: 'all'
    },
    els: {
      prompt: { value: '', focus() {} }, model: element(), aspectRatio: element(), resolution: element(), imageCount: element(),
      quality: element(), outputFormat: element(), outputCompression: element(), myLogsList: element()
    },
    setSelectValue(select, value) { if (value !== undefined) select.value = String(value); },
    updatePromptStats() {},
    updateModelUi() {},
    estimatePrice() { return estimate; },
    formatMicros(micros) { return `micros:${micros}`; },
    escapeHtml(value) { return String(value ?? ''); },
    formatDate() { return date; },
    setStatus(message, type) { statuses.push({ message, type }); },
    hasPendingGeneration() { return false; },
    async handleRun() { runCount += 1; }
  };
  const context = vm.createContext({
    window: {
      ImageGen: ns,
      confirm(message) {
        confirmations.push(message);
        return true;
      }
    },
    document: { createElement() { return {}; } },
    navigator: { clipboard: { async writeText() {} } },
    JSON,
    String,
    Array
  });
  vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), context, { filename: script });
  return { ns, confirmations, statuses, getRunCount: () => runCount };
}

test('result rerun confirms exact micros and blocks unavailable pricing', async () => {
  const available = createRerunHarness('app/results.js', { ok: true, totalMicros: 5978280 });
  await available.ns.regenerateCurrentResult();
  assert.equal(available.confirmations.length, 1);
  assert.match(available.confirmations[0], /micros:5978280/);
  assert.equal(available.getRunCount(), 1);

  const unavailable = createRerunHarness('app/results.js', { ok: false, error: 'missing profile' });
  await unavailable.ns.regenerateCurrentResult();
  assert.equal(unavailable.confirmations.length, 0);
  assert.equal(unavailable.getRunCount(), 0);
  assert.deepEqual(unavailable.statuses.at(-1), { message: '无法再次生成：missing profile', type: 'error' });
});

test('history rerun confirms exact micros and blocks unavailable pricing', async () => {
  const event = { target: { closest: () => ({ dataset: { logId: 'log-1', historyAction: 'regenerate' } }) } };
  const available = createRerunHarness('app/history.js', { ok: true, totalMicros: 1200000 });
  await available.ns.handleHistoryClick(event);
  assert.equal(available.confirmations.length, 1);
  assert.match(available.confirmations[0], /micros:1200000/);
  assert.equal(available.getRunCount(), 1);

  const unavailable = createRerunHarness('app/history.js', { ok: false, error: 'invalid profile' });
  await unavailable.ns.handleHistoryClick(event);
  assert.equal(unavailable.confirmations.length, 0);
  assert.equal(unavailable.getRunCount(), 0);
  assert.deepEqual(unavailable.statuses.at(-1), { message: '无法再次生成：invalid profile', type: 'error' });
});

test('history cost text shows actual cost only for settled valid micros', () => {
  const { ns } = createRerunHarness('app/history.js', { ok: true, totalMicros: 1200000 });
  const base = { estimatedCostMicros: 100, chargedMicros: 90 };

  assert.equal(ns.costText({ ...base, settled: false, actualCostMicros: 80 }), '预估 micros:100 / 预扣/扣费 micros:90');
  assert.equal(ns.costText({ ...base, settled: true, actualCostMicros: 80 }), '预估 micros:100 / 预扣/扣费 micros:90 / 最终实际 micros:80');
  assert.equal(ns.costText({ ...base, settled: true, actualCostMicros: -1 }), '预估 micros:100 / 预扣/扣费 micros:90');
  assert.equal(ns.costText({ ...base, settled: true, actualCostMicros: Number.MAX_SAFE_INTEGER + 1 }), '预估 micros:100 / 预扣/扣费 micros:90');
});

test('handleRun fails closed before submission when pricing is unavailable', async () => {
  const statuses = [];
  const steps = [];
  let submitCount = 0;
  let priceUpdateCount = 0;
  const ns = {
    state: { session: { token: 'token' }, currentGenerationStep: '', referenceImages: [] },
    generationStepOrder: ['validate', 'submit'],
    els: {
      generationSteps: { querySelectorAll: () => [] },
      prompt: { value: 'test', focus() {} },
      imageCount: { value: '1', focus() {} }
    },
    estimatePrice: () => ({ ok: false, error: 'missing profile' }),
    updatePriceEstimate() { priceUpdateCount += 1; },
    setStatus(message, type) { statuses.push({ message, type }); },
    async submitGeneration() { submitCount += 1; }
  };
  const context = vm.createContext({ window: { ImageGen: ns }, Math, Number, String, Array, Date, AbortController });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/generation.js'), 'utf8'), context, { filename: 'app/generation.js' });
  const originalSetGenerationStep = ns.setGenerationStep;
  ns.setGenerationStep = (step, type) => {
    steps.push({ step, type });
    originalSetGenerationStep(step, type);
  };
  await ns.handleRun();
  assert.equal(submitCount, 0);
  assert.equal(priceUpdateCount, 1);
  assert.deepEqual(statuses.at(-1), { message: '无法生成：missing profile', type: 'error' });
  assert.deepEqual(steps.at(-1), { step: 'validate', type: 'error' });
});



test('history renders admin-refunded closed submissions as a terminal refunded failure', () => {
  const { ns } = createRerunHarness('app/history.js', { ok: true, totalMicros: 1200000 });
  const status = ns.classifyLogStatus('submission_refunded_closed');
  assert.equal(status.label, '提交未确认，已退款并关闭');
  assert.equal(status.className, 'error');
  assert.equal(status.group, 'failed');
  ns.escapeHtml = (value) => String(value ?? '');
  ns.formatDate = () => 'date';

  ns.renderMyLogs([{

    id: 'refunded_closed', type: 'generation', status: 'submission_refunded_closed', settled: true,
    model: 'gpt-image-2', settings: { n: 1 }, estimatedCostMicros: 300000, chargedMicros: 0, actualCostMicros: 0
  }]);
  assert.match(ns.els.myLogsList.innerHTML, /提交未确认，已退款并关闭/);

  assert.match(ns.els.myLogsList.innerHTML, /隐藏作品/);
});

