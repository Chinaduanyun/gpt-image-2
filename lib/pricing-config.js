const { MICROS_PER_USD } = require('./constants');

const PRICING_VERSION = '2026-07-10-model-policy-v1';
const BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1 = 'provider-task-total-with-per-image-floor-v1';
const BILLING_POLICY = BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1;

function readPositiveNumber(names, defaultValue) {
  const envNames = Array.isArray(names) ? names : [names];
  const name = envNames.find((candidate) => process.env[candidate] !== undefined && process.env[candidate] !== '');
  if (!name) return defaultValue;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是大于 0 的有限数值。`);
  }
  return value;
}

function readPositiveSafeInteger(names, defaultValue) {
  const envNames = Array.isArray(names) ? names : [names];
  const name = envNames.find((candidate) => process.env[candidate] !== undefined && process.env[candidate] !== '');
  if (!name) return defaultValue;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是大于 0 的安全整数。`);
  }
  return value;
}

function normalizePricingModel(model) {
  const normalized = String(model || '').trim();
  if (normalized === 'gpt-image-2-ext') return 'gpt-image-2';
  if (normalized === 'gpt-image-2' || normalized === 'gpt-image-2-official') return normalized;
  throw new Error(`不支持的计价模型：${normalized || '空值'}。`);
}

const currencyRate = readPositiveNumber(['PRICING_CURRENCY_RATE', 'CURRENCY_RATE'], 10);
const markupMultiplier = readPositiveNumber(['PRICING_MARKUP_MULTIPLIER', 'MARKUP_MULTIPLIER'], 3.6);
const totalNames = ['PRICING_TOTAL_MULTIPLIER', 'TOTAL_MULTIPLIER'];
const totalWasExplicit = totalNames.some((name) => process.env[name] !== undefined && process.env[name] !== '');
const totalMultiplier = readPositiveNumber(totalNames, currencyRate * markupMultiplier);
if (totalWasExplicit && Math.abs(totalMultiplier - (currencyRate * markupMultiplier)) > 1e-9) {
  throw new Error('PRICING_TOTAL_MULTIPLIER 必须等于 currencyRate × markupMultiplier。');
}
const legacyTotalMultiplier = readPositiveNumber(['PRICING_LEGACY_TOTAL_MULTIPLIER', 'LEGACY_TOTAL_MULTIPLIER'], 50);

const modelProfiles = Object.freeze({
  'gpt-image-2': Object.freeze({
    totalMultiplier: readPositiveNumber('PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER', totalMultiplier),
    minimumPerImageMicros: readPositiveSafeInteger('PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS', 300000)
  }),
  'gpt-image-2-official': Object.freeze({
    totalMultiplier: readPositiveNumber('PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER', 10.5),
    minimumPerImageMicros: readPositiveSafeInteger('PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS', 300000)
  })
});

function resolveModelPricingPolicy(model) {
  const normalizedModel = normalizePricingModel(model);
  const policy = modelProfiles[normalizedModel];
  if (!policy || !Number.isFinite(policy.totalMultiplier) || policy.totalMultiplier <= 0) {
    throw new Error(`模型 ${normalizedModel} 的总系数配置无效。`);
  }
  if (!Number.isSafeInteger(policy.minimumPerImageMicros) || policy.minimumPerImageMicros <= 0) {
    throw new Error(`模型 ${normalizedModel} 的单张最低收费配置无效。`);
  }
  return { model: normalizedModel, ...policy };
}

const pricingConfig = Object.freeze({
  version: process.env.PRICING_VERSION || PRICING_VERSION,
  billingPolicy: BILLING_POLICY,
  currencyRate,
  markupMultiplier,
  totalMultiplier,
  legacyTotalMultiplier,
  microsPerUnit: MICROS_PER_USD,
  modelProfiles
});

module.exports = {
  PRICING_VERSION,
  BILLING_POLICY,
  BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1,
  pricingConfig,
  readPositiveNumber,
  readPositiveSafeInteger,
  normalizePricingModel,
  resolveModelPricingPolicy
};
