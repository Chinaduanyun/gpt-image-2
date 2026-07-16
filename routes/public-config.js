const { sendJson } = require('../lib/http-utils');
const { QUICK_BATCH_ENABLED } = require('../lib/constants');
const {
  SIMPLE_PRICE_MAP,
  SIZE_RESOLUTION_MAP,
  OFFICIAL_PRICE_MAP,
  pricingConfig
} = require('../lib/pricing');

const progressConfig = Object.freeze({
  expectedDurationMs: 85000,
  softCapPercent: 90,
  hardCapPercent: 98,
  overtimeCurveSeconds: 45
});

function handlePublicConfig(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  sendJson(res, 200, {
    features: { quickBatchEnabled: QUICK_BATCH_ENABLED },
    pricing: {
      version: pricingConfig.version,
      currencyRate: pricingConfig.currencyRate,
      markupMultiplier: pricingConfig.markupMultiplier,
      totalMultiplier: pricingConfig.totalMultiplier,
      billingPolicy: pricingConfig.billingPolicy,
      microsPerUnit: pricingConfig.microsPerUnit,
      modelProfiles: pricingConfig.modelProfiles,
      simplePriceMap: SIMPLE_PRICE_MAP,
      sizeResolutionMap: SIZE_RESOLUTION_MAP,
      officialPriceMap: OFFICIAL_PRICE_MAP
    },
    progress: progressConfig
  });
}

module.exports = {
  progressConfig,
  handlePublicConfig
};
