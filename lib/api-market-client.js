const https = require('node:https');
const { REQUEST_TIMEOUT_MS, MICROS_PER_USD } = require('./constants');
const { getProxyEnvValue, createProxyAgent } = require('./proxy-agent');

function sanitizeErrorMessage(error) {
  let message = error?.message || 'API Market 代理请求失败。';
  const proxyEnvValue = getProxyEnvValue();
  if (proxyEnvValue) message = message.split(proxyEnvValue).join('[proxy]');
  return message;
}

function requestApiMarket(method, targetPath, headers, body, config) {
  const upstreamUrl = new URL(targetPath, config.baseUrl);
  const proxyEnvValue = getProxyEnvValue();
  const bodyBuffer = body ? Buffer.from(body) : null;

  if (upstreamUrl.protocol !== 'https:') {
    return Promise.reject(new Error('API Market baseUrl 必须使用 HTTPS。'));
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: {
        ...headers,
        ...(bodyBuffer ? { 'Content-Length': bodyBuffer.length } : {})
      },
      agent: proxyEnvValue ? createProxyAgent(proxyEnvValue) : undefined
    }, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        resolve({
          status: upstreamRes.statusCode || 502,
          contentType: upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
          headers: upstreamRes.headers,
          retryAfter: upstreamRes.headers['retry-after'] || '',
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('上游请求超时。')));
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function getApiHeaders(config) {
  return {
    Authorization: `Bearer ${config.apiKey.trim()}`,
    Accept: 'application/json'
  };
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTaskId(result) {
  return result?.data?.[0]?.task_id
    || result?.data?.[0]?.id
    || result?.data?.task_id
    || result?.data?.id
    || result?.task_id
    || result?.id
    || '';
}

function normalizeUrlValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function extractImageUrls(result) {
  const data = result?.data;
  const resultObj = data?.result || result?.result || {};
  const images = resultObj?.images || data?.images || result?.images || [];
  const urls = [];

  for (const image of images) urls.push(...normalizeUrlValues(image?.url));
  urls.push(...normalizeUrlValues(resultObj.url));
  urls.push(...normalizeUrlValues(data?.url));
  urls.push(...normalizeUrlValues(result?.url));
  urls.push(...normalizeUrlValues(data?.[0]?.url));

  return Array.from(new Set(urls.filter(Boolean)));
}

function getTaskStatus(result) {
  return String(result?.data?.status || result?.status || result?.data?.task_status || '').trim().toLowerCase();
}

function getProviderCostMicrosState(result) {
  const cost = result?.data?.cost ?? result?.cost ?? result?.data?.usage?.cost;
  if (cost === undefined || cost === null || (typeof cost === 'string' && !cost.trim())) {
    return { status: 'missing', micros: null };
  }
  const number = Number(cost);
  if (!Number.isFinite(number) || number < 0) return { status: 'invalid', micros: null };
  const micros = Math.round(number * MICROS_PER_USD);
  if (!Number.isSafeInteger(micros)) return { status: 'invalid', micros: null };
  return { status: 'valid', micros };
}

function extractProviderCostMicros(result) {
  return getProviderCostMicrosState(result).micros;
}

function toApiMarketGenerationPayload(payload) {
  const clean = { ...payload };
  if (!Array.isArray(clean.image_urls) || !clean.image_urls.length) delete clean.image_urls;
  return clean;
}

module.exports = {
  sanitizeErrorMessage,
  requestApiMarket,
  getApiHeaders,
  parseJsonText,
  extractTaskId,
  normalizeUrlValues,
  extractImageUrls,
  getTaskStatus,
  getProviderCostMicrosState,
  extractProviderCostMicros,
  toApiMarketGenerationPayload
};
