const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadGeneration(publicConfig = null) {
  const window = {
    ImageGen: { state: { publicConfig }, polling: {}, constants: {}, els: {} },
    setTimeout,
    setInterval,
    clearInterval
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../app/generation.js`, 'utf8'), { window, Date, Math, AbortController, encodeURIComponent });
  return window.ImageGen;
}

test('progress reaches configured soft cap at expected duration', () => {
  const ns = loadGeneration({ progress: { expectedDurationMs: 90000, softCapPercent: 90, hardCapPercent: 98, overtimeCurveSeconds: 45 } });
  assert.equal(ns.getSimulatedProgress(0), 0);
  assert.equal(ns.getSimulatedProgress(45000), 45);
  assert.equal(ns.getSimulatedProgress(90000), 90);
});

test('progress uses 85 second defaults and never exceeds 98 percent', () => {
  const ns = loadGeneration();
  assert.equal(ns.getSimulatedProgress(85000), 90);
  assert.equal(ns.getSimulatedProgress(10 * 60 * 1000), 98);
});

test('task status is normalized and billing uses settled actual micros only', () => {
  const ns = loadGeneration();
  assert.equal(ns.getTaskStatus({ data: { status: 'SUCCEEDED' } }), 'succeeded');
  assert.equal(ns.extractActualCostMicros({ billing: { settled: true, actualCostMicros: 12345, chargedMicros: 99999 }, cost: 100 }), 12345);
  assert.equal(ns.extractActualCostMicros({ data: { billing: { settled: false, actualCostMicros: 54321, chargedMicros: 54321 }, status: 'completed' } }), null);
  assert.equal(ns.extractActualCostMicros({ data: { billing: { settled: false, chargedMicros: 54321 }, status: 'completed' } }), null);
  assert.equal(ns.extractActualCostMicros({ billing: { settled: true, actualCostMicros: -1 } }), null);
  assert.equal(ns.extractActualCostMicros({ billing: { settled: true, actualCostMicros: Number.MAX_SAFE_INTEGER + 1 } }), null);
  assert.equal(ns.extractActualCostMicros({ data: { cost: 100 } }), null);
});

test('successful bootstrap enables generation after public config loads', async () => {
  const element = () => ({
    disabled: false,
    value: '',
    textContent: '',
    addEventListener() {},
    querySelectorAll() { return []; }
  });
  const els = new Proxy({}, { get(target, key) { return target[key] ||= element(); } });
  const busyStates = [];
  const ns = {
    state: {},
    defaults: {},
    els,
    requestJson: async () => ({ ok: true, json: { pricing: {}, progress: {} } }),
    getErrorMessage: () => '配置失败',
    setSelectValue() {},
    updatePromptStats() {},
    updateModelUi() {},
    updateAdvancedSummary() {},
    resetProgress() {},
    renderReferences() {},
    setBusy(value) { busyStates.push(value); els.runBtn.disabled = value; },
    restoreSession: async () => {},
    setStatus() {}
  };
  const window = { ImageGen: ns };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../app/main.js`, 'utf8'), { window });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(busyStates, [false]);
  assert.equal(els.runBtn.disabled, false);
});

test('failed bootstrap keeps generation disabled', async () => {
  const els = { runBtn: { disabled: false }, priceDetail: { textContent: '' } };
  const busyStates = [];
  const ns = {
    state: {},
    els,
    requestJson: async () => ({ ok: false, json: null }),
    getErrorMessage: () => '配置失败',
    setBusy(value) { busyStates.push(value); },
    setStatus() {}
  };
  const window = { ImageGen: ns };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../app/main.js`, 'utf8'), { window });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(busyStates, []);
  assert.equal(els.runBtn.disabled, true);
  assert.match(els.priceDetail.textContent, /加载失败/);
});
