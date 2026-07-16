const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { pricingConfig } = require('../lib/pricing-config');
const {
  SIMPLE_PRICE_MAP,
  SIZE_RESOLUTION_MAP,
  OFFICIAL_PRICE_MAP,
  usdToMicros,
  sanitizeGenerationPayload,
  estimateGenerationCostMicros
} = require('../lib/pricing');

test('pricing defaults preserve the cheap compatibility fields and legacy multiplier', () => {
  assert.equal(pricingConfig.currencyRate, 10);
  assert.equal(pricingConfig.markupMultiplier, 3.6);
  assert.equal(pricingConfig.totalMultiplier, 36);
  assert.equal(pricingConfig.legacyTotalMultiplier, 50);
  assert.equal(SIMPLE_PRICE_MAP['1k'], 0.0085);
});

test('cheap estimates use multiplier 36 and the per-image floor', () => {
  const expected = { '1k': 306000, '2k': 504000, '4k': 756000 };
  for (const [resolution, totalMicros] of Object.entries(expected)) {
    const estimate = estimateGenerationCostMicros({ model: 'gpt-image-2', resolution, n: 1 });
    assert.equal(estimate.ok, true, resolution);
    assert.equal(estimate.model, 'gpt-image-2', resolution);
    assert.equal(estimate.totalMultiplier, 36, resolution);
    assert.equal(estimate.minimumPerImageMicros, 300000, resolution);
    assert.equal(estimate.billingImageCount, 1, resolution);
    assert.equal(estimate.minimumChargeMicros, 300000, resolution);
    assert.equal(estimate.unitMicros, totalMicros, resolution);
    assert.equal(estimate.totalMicros, totalMicros, resolution);
  }
});

test('official 1:1 4K high uses multiplier 10.5 for one or four images', () => {
  const one = estimateGenerationCostMicros({
    model: 'gpt-image-2-official', size: '1:1', resolution: '4k', quality: 'high', n: 1
  });
  const four = estimateGenerationCostMicros({
    model: 'gpt-image-2-official', size: '1:1', resolution: '4k', quality: 'high', n: 4
  });

  assert.equal(one.totalMultiplier, 10.5);
  assert.equal(one.unitMicros, 5978280);
  assert.equal(one.totalMicros, 5978280);
  assert.equal(four.billingImageCount, 4);
  assert.equal(four.minimumChargeMicros, 1200000);
  assert.equal(four.totalMicros, 23913120);
});

test('official low-price estimates apply the floor once per requested image', () => {
  const one = estimateGenerationCostMicros({
    model: 'gpt-image-2-official', size: '3:1', resolution: '1k', quality: 'low', n: 1
  });
  const four = estimateGenerationCostMicros({
    model: 'gpt-image-2-official', size: '3:1', resolution: '1k', quality: 'low', n: 4
  });

  assert.equal(one.unitMicros, 300000);
  assert.equal(one.minimumChargeMicros, 300000);
  assert.equal(one.totalMicros, 300000);
  assert.equal(four.unitMicros, 300000);
  assert.equal(four.minimumChargeMicros, 1200000);
  assert.equal(four.totalMicros, 1200000);
});

test('official image counts reject fractional values before estimation or submission', () => {
  for (const n of [1.5, '2.5', NaN, Infinity]) {
    assert.throws(
      () => sanitizeGenerationPayload({ model: 'gpt-image-2-official', prompt: 'test', n }, { model: 'gpt-image-2' }),
      /生成张数必须是整数/,
      String(n)
    );
    const estimate = estimateGenerationCostMicros({
      model: 'gpt-image-2-official', size: '1:1', resolution: '1k', quality: 'low', n
    });
    assert.equal(estimate.ok, false, String(n));
    assert.match(estimate.error, /生成张数必须是整数/, String(n));
  }
});

test('official integer image counts remain clamped to the supported range', () => {
  assert.equal(sanitizeGenerationPayload({ model: 'gpt-image-2-official', prompt: 'test', n: 0 }, { model: 'gpt-image-2' }).n, 1);
  assert.equal(sanitizeGenerationPayload({ model: 'gpt-image-2-official', prompt: 'test', n: 10 }, { model: 'gpt-image-2' }).n, 4);
});

test('sanitizeGenerationPayload enforces prompt and string parameter limits', () => {
  const config = { model: 'gpt-image-2' };
  // prompt must be a non-empty string within the length cap.
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2' }, config), /提示词必须是字符串/);
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 42 }, config), /提示词必须是字符串/);
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: '   ' }, config), /提示词不能为空/);
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 'x'.repeat(8001) }, config), /不能超过 8000/);
  // A prompt exactly at the cap is accepted.
  assert.equal(sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 'x'.repeat(8000) }, config).prompt.length, 8000);

  // Optional string parameters must be strings and stay within 128 chars.
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 'ok', size: { bad: true } }, config), /参数 size 必须是字符串/);
  assert.throws(() => sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 'ok', user: 'u'.repeat(129) }, config), /参数 user 长度不能超过 128/);
  const clean = sanitizeGenerationPayload({ model: 'gpt-image-2', prompt: 'ok', size: '1:1', resolution: '1k' }, config);
  assert.equal(clean.size, '1:1');
  assert.equal(clean.resolution, '1k');
});

test('gpt-image-2-ext is accepted as a documented alias and normalized to the canonical model', () => {
  assert.equal(
    sanitizeGenerationPayload({ model: 'gpt-image-2-ext', prompt: 'test' }, { model: 'gpt-image-2-official' }).model,
    'gpt-image-2'
  );
  assert.equal(
    sanitizeGenerationPayload({ prompt: 'test' }, { model: 'gpt-image-2-ext' }).model,
    'gpt-image-2'
  );
});

test('all selectable official pixel sizes have exact three-tier pricing', () => {
  const pixelSizes = new Set(Object.values(SIZE_RESOLUTION_MAP).flatMap((resolutions) => Object.values(resolutions)));
  for (const pixelSize of pixelSizes) {
    assert.deepEqual(Object.keys(OFFICIAL_PRICE_MAP[pixelSize] || {}).sort(), ['high', 'low', 'medium'], pixelSize);
    for (const tier of Object.values(OFFICIAL_PRICE_MAP[pixelSize])) {
      assert.equal(Number.isFinite(tier) && tier > 0, true, pixelSize);
    }
  }
});

test('explicit total multiplier must match rate times markup', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./lib/pricing-config')"], {
    cwd: root,
    env: { ...process.env, PRICING_CURRENCY_RATE: '10', PRICING_MARKUP_MULTIPLIER: '3.6', PRICING_TOTAL_MULTIPLIER: '50' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /必须等于/);
});

test('invalid pricing environment value rejects startup', () => {
  for (const [name, value] of [
    ['PRICING_CURRENCY_RATE', 'not-a-number'],
    ['PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER', '0'],
    ['PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS', '1.5']
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./lib/pricing-config')"], {
      cwd: root,
      env: { ...process.env, [name]: value },
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(name), name);
  }
});

test('unknown models are rejected instead of inheriting another pricing profile', () => {
  assert.throws(
    () => sanitizeGenerationPayload({ model: 'unknown-image-model', prompt: 'test' }, { model: 'gpt-image-2' }),
    /不支持的计价模型/
  );
  const estimate = estimateGenerationCostMicros({ model: 'unknown-image-model', resolution: '1k', n: 1 });
  assert.equal(estimate.ok, false);
  assert.match(estimate.error, /不支持的计价模型/);
});
