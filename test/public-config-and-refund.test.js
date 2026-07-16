const test = require('node:test');
const assert = require('node:assert/strict');

const { handlePublicConfig } = require('../routes/public-config');
const { refundSubmittingLog, getBillingSummary } = require('../routes/api-market');
const { sanitizeErrorMessage } = require('../lib/api-market-client');

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) { this.body = body; }
  };
}

test('public config exposes model pricing profiles without legacy settlement policy', () => {
  const res = responseCapture();
  handlePublicConfig({ method: 'GET' }, res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.progress, {
    expectedDurationMs: 85000,
    softCapPercent: 90,
    hardCapPercent: 98,
    overtimeCurveSeconds: 45
  });
  assert.equal(body.pricing.totalMultiplier, 36);
  assert.deepEqual(body.pricing.modelProfiles['gpt-image-2'], {
    totalMultiplier: 36,
    minimumPerImageMicros: 300000
  });
  assert.deepEqual(body.pricing.modelProfiles['gpt-image-2-official'], {
    totalMultiplier: 10.5,
    minimumPerImageMicros: 300000
  });
  assert.equal(body.pricing.legacyTotalMultiplier, undefined);
  const publicNumbers = [];
  const collectNumbers = (value) => {
    if (typeof value === 'number') publicNumbers.push(value);
    else if (Array.isArray(value)) value.forEach(collectNumbers);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectNumbers);
  };
  collectNumbers(body.pricing);
  assert.equal(publicNumbers.includes(50), false);
});

test('definitive submit rejection refund helper is full and idempotent', () => {
  const data = {
    users: { 'u@example.com': { balanceMicros: 100 } },
    spendLogs: [{ id: 'usage_1', email: 'u@example.com', status: 'submitting', chargedMicros: 250, settled: false }]
  };
  assert.equal(refundSubmittingLog(data, 'usage_1', 'u@example.com', 'network failed'), true);
  assert.equal(data.users['u@example.com'].balanceMicros, 350);
  assert.equal(data.spendLogs[0].chargedMicros, 0);
  assert.equal(data.spendLogs[0].settlementStatus, 'refunded');
  assert.equal(refundSubmittingLog(data, 'usage_1', 'u@example.com', 'again'), false);
  assert.equal(data.users['u@example.com'].balanceMicros, 350);
});

test('submit errors sanitize proxy credentials before persistence', () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://user:secret@proxy.example:8080';
  try {
    const message = sanitizeErrorMessage(new Error(`connect failed via ${process.env.HTTPS_PROXY}`));
    assert.equal(message.includes('user:secret'), false);
    assert.match(message, /\[proxy\]/);
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});

test('billing summary is stable for task responses', () => {
  assert.deepEqual(getBillingSummary({
    pricingVersion: 'v2',
    estimatedCostMicros: 20,
    providerCostMicros: 3,
    actualCostMicros: 18,
    chargedMicros: 18,
    settled: true,
    settlementStatus: 'settled'
  }), {
    pricingVersion: 'v2',
    billingPolicy: null,
    estimatedCostMicros: 20,
    minimumChargeMicros: null,
    providerCostMicros: 3,
    actualCostMicros: 18,
    chargedMicros: 18,
    settled: true,
    settlementStatus: 'settled'
  });
});
