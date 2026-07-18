const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getProviderCostMicrosState,
  extractProviderCostMicros,
  getTaskStatus
} = require('../lib/api-market-client');
const {
  replaceTaskJsonImageUrls,
  getLogTotalMultiplier,
  getSettlementPricingSnapshot,
  applyActualCostSettlement,
  applyProviderCostSettlement,
  applyTaskJsonToLog,
  logNeedsUpstreamRefresh,
  logNeedsRefresh
} = require('../lib/spend-logs');

test('provider cost rejects missing, blank, NaN, and negative values but accepts zero', () => {
  for (const cost of [undefined, null, '', '  ', 'nope', -1, '-0.1']) {
    assert.equal(extractProviderCostMicros({ data: { cost } }), null, String(cost));
  }
  assert.equal(extractProviderCostMicros({ data: { cost: 0 } }), 0);
  assert.equal(extractProviderCostMicros({ data: { cost: '0' } }), 0);
});

test('provider cost state distinguishes missing, invalid, and valid values', () => {
  assert.deepEqual(getProviderCostMicrosState({ data: {} }), { status: 'missing', micros: null });
  assert.deepEqual(getProviderCostMicrosState({ data: { cost: 'nope' } }), { status: 'invalid', micros: null });
  assert.deepEqual(getProviderCostMicrosState({ data: { cost: -1 } }), { status: 'invalid', micros: null });
  assert.deepEqual(getProviderCostMicrosState({ data: { cost: 1e308 } }), { status: 'invalid', micros: null });
  assert.deepEqual(getProviderCostMicrosState({ data: { cost: '0.006' } }), { status: 'valid', micros: 6000 });
});

test('task status is trimmed and normalized to lowercase', () => {
  assert.equal(getTaskStatus({ data: { status: '  COMPLETED ' } }), 'completed');
});

test('completed unsettled logs with task ids remain refreshable', () => {
  assert.equal(logNeedsRefresh({ type: 'generation', taskId: 'task_1', status: 'completed', settled: false }), true);
  assert.equal(logNeedsRefresh({ type: 'generation', taskId: 'task_1', status: 'completed', settled: true, imageFiles: [] }), false);
});

test('completed historical logs remain eligible for remote image archival without settlement', () => {
  for (const settled of [true, undefined]) {
    const data = { users: { 'u@example.com': { balanceMicros: 1000 } } };
    const log = {
      type: 'generation',
      taskId: 'historical_task',
      status: 'completed',
      settled,
      email: 'u@example.com',
      chargedMicros: 100,
      actualCostMicros: 100,
      remoteImageUrls: ['https://example.com/image.png'],
      imageFiles: []
    };
    assert.equal(logNeedsRefresh(log), true);
    assert.equal(logNeedsUpstreamRefresh(log), false);
    assert.equal(applyProviderCostSettlement(data, log, 6000), false);
    assert.equal(data.users['u@example.com'].balanceMicros, 1000);
    assert.equal(log.actualCostMicros, 100);
  }
});

test('missing settled state with task id cannot refresh upstream without archival URLs', () => {
  assert.equal(logNeedsUpstreamRefresh({
    type: 'generation',
    taskId: 'legacy_task',
    status: 'submitted'
  }), false);
  assert.equal(logNeedsRefresh({
    type: 'generation',
    taskId: 'legacy_task',
    status: 'submitted'
  }), false);
  assert.equal(logNeedsRefresh({
    type: 'generation',
    taskId: 'legacy_task',
    status: 'completed',
    remoteImageUrls: ['https://example.com/image.png'],
    imageFiles: []
  }), true);
});

test('extracts raw provider cost without applying a billing multiplier', () => {
  const result = { data: { usage: { cost: '0.006' } } };
  assert.equal(extractProviderCostMicros(result), 6000);
  assert.deepEqual(getProviderCostMicrosState(result), { status: 'valid', micros: 6000 });
});

test('legacy unsettled logs use total multiplier 50', () => {
  assert.equal(getLogTotalMultiplier({}), 50);
  assert.equal(getLogTotalMultiplier({ totalMultiplier: 36 }), 36);
});

test('settlement uses the log pricing snapshot and is idempotent', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
  const log = {
    email: 'u@example.com',
    totalMultiplier: 36,
    chargedMicros: 300000,
    settled: false
  };
  assert.equal(applyProviderCostSettlement(data, log, 6000), true);
  assert.equal(log.providerCostMicros, 6000);
  assert.equal(log.actualCostMicros, 216000);
  assert.equal(log.chargedMicros, 216000);
  assert.equal(data.users['u@example.com'].balanceMicros, 1084000);
  assert.equal(applyProviderCostSettlement(data, log, 9000), false);
  assert.equal(data.users['u@example.com'].balanceMicros, 1084000);
});

test('new-policy settlement applies the task floor below the multiplier charge', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 0 } } };
  const log = {
    email: 'u@example.com',
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    minimumChargeMicros: 1200000,
    chargedMicros: 1200000,
    settled: false
  };

  assert.equal(applyProviderCostSettlement(data, log, 100000), true);
  assert.equal(log.providerCostMicros, 100000);
  assert.equal(log.actualCostMicros, 1200000);
  assert.equal(log.chargedMicros, 1200000);
  assert.equal(data.users['u@example.com'].balanceMicros, 0);
});

test('new-policy settlement uses the multiplier charge above the task floor', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
  const log = {
    email: 'u@example.com',
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    minimumChargeMicros: 1200000,
    chargedMicros: 1200000,
    settled: false
  };

  assert.equal(applyProviderCostSettlement(data, log, 200000), true);
  assert.equal(log.actualCostMicros, 2100000);
  assert.equal(log.chargedMicros, 2100000);
  assert.equal(data.users['u@example.com'].balanceMicros, 100000);
});

test('failed tasks settle by multiplier only — the floor never applies', () => {
  // 失败且上游报 cost:0 → 全额退款（此前会被下限收 ¥0.30，与"cost 缺失→退款"分支不一致）。
  const data = { users: { 'u@example.com': { balanceMicros: 0 } } };
  const log = {
    email: 'u@example.com',
    status: 'failed',
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    totalMultiplier: 36,
    minimumPerImageMicros: 300000,
    billingImageCount: 1,
    minimumChargeMicros: 300000,
    chargedMicros: 306000,
    settled: false
  };
  assert.equal(applyProviderCostSettlement(data, log, 0), true);
  assert.equal(log.actualCostMicros, 0);
  assert.equal(log.chargedMicros, 0);
  assert.equal(data.users['u@example.com'].balanceMicros, 306000);

  // 失败但上游确实收了钱 → 按系数结算、不套下限（低于下限也照实收）。
  const data2 = { users: { 'u@example.com': { balanceMicros: 0 } } };
  const log2 = { ...log, chargedMicros: 306000, settled: false };
  delete log2.actualCostMicros;
  delete log2.providerCostMicros;
  assert.equal(applyProviderCostSettlement(data2, log2, 2000), true);
  assert.equal(log2.actualCostMicros, 72000);
  assert.equal(log2.chargedMicros, 72000);
  assert.equal(data2.users['u@example.com'].balanceMicros, 234000);
});

test('persisted floor policy is dispatched by its stable identifier', () => {
  assert.deepEqual(getSettlementPricingSnapshot({
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    minimumChargeMicros: 1200000
  }), {
    ok: true,
    totalMultiplier: 10.5,
    minimumChargeMicros: 1200000
  });
  assert.deepEqual(getSettlementPricingSnapshot({
    billingPolicy: 'unknown-future-policy',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    minimumChargeMicros: 1200000
  }), { ok: false });
});

test('incomplete or corrupt floor snapshots remain unsettled', () => {
  const validSnapshot = {
    billingPolicy: 'provider-task-total-with-per-image-floor-v1',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    minimumChargeMicros: 1200000
  };
  const invalidSnapshots = [
    { ...validSnapshot, totalMultiplier: undefined },
    { ...validSnapshot, totalMultiplier: '10.5' },
    { ...validSnapshot, minimumPerImageMicros: undefined },
    { ...validSnapshot, billingImageCount: 2.5 },
    { ...validSnapshot, billingImageCount: 5 },
    { ...validSnapshot, minimumChargeMicros: undefined },
    { ...validSnapshot, minimumChargeMicros: 300000 },
    { ...validSnapshot, billingPolicy: 'unknown-future-policy' }
  ];

  for (const snapshot of invalidSnapshots) {
    const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
    const log = {
      ...snapshot,
      email: 'u@example.com',
      chargedMicros: 1200000,
      settled: false
    };
    assert.equal(applyProviderCostSettlement(data, log, 100000), false, JSON.stringify(snapshot));
    assert.equal(log.settled, false, JSON.stringify(snapshot));
    assert.equal(log.settlementStatus, 'invalid_snapshot', JSON.stringify(snapshot));
    assert.equal(log.providerCostMicros, undefined, JSON.stringify(snapshot));
    assert.equal(log.actualCostMicros, undefined, JSON.stringify(snapshot));
    assert.equal(data.users['u@example.com'].balanceMicros, 1000000, JSON.stringify(snapshot));
  }
});

test('custom pricing versions fail closed without a complete valid policy snapshot', () => {
  const invalidSnapshots = [
    { pricingVersion: 'tenant-policy-v2', totalMultiplier: 36 },
    { pricingVersion: 'tenant-policy-v2', totalMultiplier: '36' },
    { pricingVersion: 2, totalMultiplier: 36 }
  ];

  for (const snapshot of invalidSnapshots) {
    const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
    const log = {
      ...snapshot,
      email: 'u@example.com',
      chargedMicros: 300000,
      settled: false
    };

    assert.deepEqual(getSettlementPricingSnapshot(log), { ok: false }, JSON.stringify(snapshot));
    assert.equal(applyProviderCostSettlement(data, log, 6000), false, JSON.stringify(snapshot));
    assert.equal(log.settled, false, JSON.stringify(snapshot));
    assert.equal(log.settlementStatus, 'invalid_snapshot', JSON.stringify(snapshot));
    assert.equal(log.providerCostMicros, undefined, JSON.stringify(snapshot));
    assert.equal(log.actualCostMicros, undefined, JSON.stringify(snapshot));
    assert.equal(log.chargedMicros, 300000, JSON.stringify(snapshot));
    assert.equal(data.users['u@example.com'].balanceMicros, 1000000, JSON.stringify(snapshot));
  }
});

test('historical multiplier snapshots never gain a floor from their model', () => {
  for (const log of [
    { model: 'gpt-image-2-official', totalMultiplier: 36 },
    { model: 'gpt-image-2', totalMultiplier: 10.5 },
    { model: 'gpt-image-2-official' }
  ]) {
    const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
    Object.assign(log, { email: 'u@example.com', chargedMicros: 300000, settled: false });
    assert.equal(applyProviderCostSettlement(data, log, 1000), true);
    const expected = log.totalMultiplier ? Math.round(1000 * log.totalMultiplier) : 50000;
    assert.equal(log.actualCostMicros, expected);
  }
});

test('missing minimum charge is not reconstructed from image count or model', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 1000000 } } };
  const log = {
    email: 'u@example.com',
    model: 'gpt-image-2-official',
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000,
    billingImageCount: 4,
    chargedMicros: 1200000,
    settled: false
  };

  assert.equal(applyProviderCostSettlement(data, log, 1000), true);
  assert.equal(log.actualCostMicros, 10500);
});

test('completed task without provider cost remains unsettled', async () => {
  const data = { users: { 'u@example.com': { balanceMicros: 0 } } };
  const log = {
    type: 'generation',
    email: 'u@example.com',
    chargedMicros: 100,
    imageUrls: [],
    remoteImageUrls: [],
    imageFiles: [],
    settled: false
  };
  await applyTaskJsonToLog(data, log, { data: { status: 'completed', result: { images: [] } } });
  assert.equal(log.status, 'completed');
  assert.equal(log.settled, false);
  assert.equal(log.settlementStatus, 'provider_cost_missing');
});

test('completed task with invalid provider cost remains unsettled for retry', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 0 } } };
  const log = {
    type: 'generation',
    taskId: 'invalid_completed',
    email: 'u@example.com',
    chargedMicros: 100,
    settled: false
  };
  applyTaskJsonToLog(data, log, { data: { status: 'completed', cost: 'not-a-number' } });
  assert.equal(log.status, 'completed');
  assert.equal(log.settled, false);
  assert.equal(log.settlementStatus, 'provider_cost_invalid');
  assert.equal(data.users['u@example.com'].balanceMicros, 0);
  assert.equal(logNeedsUpstreamRefresh(log), true);
});

test('failed task with invalid provider cost does not refund and remains retryable', () => {
  for (const cost of [1e308, 'not-a-number', -1]) {
    const data = { users: { 'u@example.com': { balanceMicros: 900 } } };
    const log = {
      type: 'generation',
      taskId: `invalid_failed_${String(cost)}`,
      email: 'u@example.com',
      chargedMicros: 100,
      balanceAfterMicros: 900,
      settled: false
    };
    applyTaskJsonToLog(data, log, { data: { status: 'failed', cost } });
    assert.equal(log.status, 'failed', String(cost));
    assert.equal(log.settled, false, String(cost));
    assert.equal(log.settlementStatus, 'provider_cost_invalid', String(cost));
    assert.equal(log.chargedMicros, 100, String(cost));
    assert.equal(log.balanceAfterMicros, 900, String(cost));
    assert.equal(data.users['u@example.com'].balanceMicros, 900, String(cost));
    assert.equal(logNeedsUpstreamRefresh(log), true, String(cost));
  }
});

test('failed task with missing provider cost still refunds the full charge', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 900 } } };
  const log = {
    type: 'generation',
    taskId: 'missing_failed',
    email: 'u@example.com',
    chargedMicros: 100,
    balanceAfterMicros: 900,
    settled: false
  };
  applyTaskJsonToLog(data, log, { data: { status: 'failed' } });
  assert.equal(log.status, 'failed');
  assert.equal(log.settled, true);
  assert.equal(log.settlementStatus, 'refunded');
  assert.equal(log.chargedMicros, 0);
  assert.equal(log.balanceAfterMicros, 1000);
  assert.equal(data.users['u@example.com'].balanceMicros, 1000);
  assert.equal(logNeedsUpstreamRefresh(log), false);
});

test('already settled legacy logs are not recalculated', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 10 } } };
  const log = { email: 'u@example.com', chargedMicros: 7, actualCostMicros: 7, settled: true };
  assert.equal(applyProviderCostSettlement(data, log, 6000), false);
  assert.equal(log.actualCostMicros, 7);
  assert.equal(data.users['u@example.com'].balanceMicros, 10);
});

test('provider cost rejects overflow and unsafe integer micros', () => {
  assert.equal(extractProviderCostMicros({ data: { cost: 1e308 } }), null);
  assert.equal(extractProviderCostMicros({ data: { cost: Number.MAX_SAFE_INTEGER / 1000000 + 1 } }), null);
  assert.deepEqual(getProviderCostMicrosState({ data: { cost: 1e308 } }), { status: 'invalid', micros: null });
});

test('settlement rejects invalid integer costs without mutating balance or settlement fields', () => {
  for (const cost of [Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const data = { users: { 'u@example.com': { balanceMicros: 1000 } } };
    const log = { email: 'u@example.com', chargedMicros: 100, settled: false };
    assert.equal(applyProviderCostSettlement(data, log, cost), false);
    assert.equal(data.users['u@example.com'].balanceMicros, 1000);
    assert.equal(log.settled, false);
    assert.equal(log.providerCostMicros, undefined);
    assert.equal(log.actualCostMicros, undefined);
  }

  const data = { users: { 'u@example.com': { balanceMicros: 1000 } } };
  const log = { email: 'u@example.com', chargedMicros: 100, settled: false };
  assert.equal(applyActualCostSettlement(data, log, Infinity), false);
  assert.equal(data.users['u@example.com'].balanceMicros, 1000);
  assert.equal(log.settled, false);
});

test('historical logs without explicit unsettled state are frozen', () => {
  const data = { users: { 'u@example.com': { balanceMicros: 1000 } } };
  const log = { type: 'generation', taskId: 'legacy_task', email: 'u@example.com', chargedMicros: 100 };
  assert.equal(applyProviderCostSettlement(data, log, 1), false);
  assert.equal(logNeedsRefresh(log), false);
  applyTaskJsonToLog(data, log, { data: { status: 'failed' } });
  assert.equal(data.users['u@example.com'].balanceMicros, 1000);
  assert.equal(log.settled, undefined);
});

test('NAS generation summary preserves 79 settled logs and skips 3 taskless submissions', () => {
  const logs = Array.from({ length: 79 }, (_, index) => ({
    type: 'generation',
    taskId: `task_${index}`,
    status: 'completed',
    settled: true,
    email: 'u@example.com',
    chargedMicros: 100,
    actualCostMicros: 100
  })).concat(Array.from({ length: 3 }, () => ({
    type: 'generation',
    taskId: '',
    status: 'submitting',
    settled: false
  })));
  const data = { users: { 'u@example.com': { balanceMicros: 1000 } } };

  assert.equal(logs.length, 82);
  assert.equal(logs.filter((log) => log.settled === true).length, 79);
  assert.equal(logs.filter((log) => log.status === 'submitting' && log.settled === false && !log.taskId).length, 3);
  for (const log of logs.slice(0, 79)) {
    assert.equal(applyProviderCostSettlement(data, log, 6000), false);
  }
  assert.equal(data.users['u@example.com'].balanceMicros, 1000);
  assert.equal(logs.filter(logNeedsRefresh).length, 0);
});

test('replaceTaskJsonImageUrls replaces non-object result values', () => {
  const taskJson = { data: { result: 'invalid' } };
  assert.deepEqual(replaceTaskJsonImageUrls(taskJson, ['https://example.com/image.png']).data.result, {
    images: [{ url: 'https://example.com/image.png' }]
  });
});
