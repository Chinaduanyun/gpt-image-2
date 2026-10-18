const fs = require('node:fs');
const path = require('node:path');
const { getImageStoreDir } = require('./store');
const { ProviderError } = require('./cpa-image');
const { requestApiMarket, getApiHeaders, parseJsonText, extractTaskId, extractImageUrls, getTaskStatus, toApiMarketGenerationPayload } = require('./api-market-client');

function marketConfig() {
  if (process.env.HYBRID_MARKET_ENABLED !== 'true') return null;
  try {
    const config = JSON.parse(fs.readFileSync(process.env.HYBRID_MARKET_CONFIG_FILE || '/run/secrets/market.json', 'utf8'));
    const url = new URL(config.baseUrl);
    const allowed = process.env.HYBRID_MARKET_ALLOWED_ORIGIN || 'https://api.apimart.ai';
    if (url.protocol !== 'https:' || url.origin !== allowed || url.username || url.password || !config.apiKey?.trim()) return null;
    return config;
  } catch { return null; }
}
function createMarketAdapter(config = marketConfig(), transport = requestApiMarket) {
  if (!config) return null;
  return {
    async submit(payload, inputs) {
      const imageUrls = inputs.map((file) => `data:${file.contentType};base64,${fs.readFileSync(path.join(getImageStoreDir(), file.fileName)).toString('base64')}`);
      const body = toApiMarketGenerationPayload({ ...payload, n: 1, image_urls: imageUrls });
      let response;
      try { response = await transport('POST', '/v1/images/generations', { ...getApiHeaders(config), 'Content-Type': 'application/json' }, JSON.stringify(body), config); }
      catch { throw new ProviderError('unknown', 'Market 提交断连或超时，结果未知；不会再次提交。'); }
      if (response.status < 200 || response.status >= 300) {
        if (/safety|moderation|content_policy|policy_violation|安全策略/i.test(response.text)) throw new ProviderError('policy', 'Market 安全策略拒绝。');
        if ([400, 401, 403, 404, 422].includes(response.status)) throw new ProviderError('technical', `Market 明确拒绝提交（HTTP ${response.status}）。`);
        throw new ProviderError('unknown', `Market HTTP ${response.status}，提交结果未知。`);
      }
      const externalTaskId = extractTaskId(parseJsonText(response.text));
      if (typeof externalTaskId !== 'string' || !externalTaskId || externalTaskId.length > 512) throw new ProviderError('unknown', 'Market 响应缺少有效任务编号；不会再次提交。');
      return { externalTaskId };
    },
    async poll(externalTaskId) {
      const response = await transport('GET', `/v1/tasks/${encodeURIComponent(externalTaskId)}`, getApiHeaders(config), null, config);
      if (response.status < 200 || response.status >= 300) throw new Error('Market 查询暂不可用，将仅重试查询。');
      const json = parseJsonText(response.text);
      if (!json) throw new Error('Market 查询响应无效，将仅重试查询。');
      const status = getTaskStatus(json);
      if (['failed', 'cancelled', 'error'].includes(status)) return { failed: true };
      if (['completed', 'succeeded', 'success'].includes(status)) {
        const results = extractImageUrls(json).map((url) => ({ url }));
        if (!results.length) return { unknown: true };
        return { results };
      }
      return { pending: true };
    }
  };
}
module.exports = { marketConfig, createMarketAdapter };
