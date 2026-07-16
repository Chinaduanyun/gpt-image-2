const https = require('node:https');
const { REQUEST_TIMEOUT_MS, MICROS_PER_USD } = require('./constants');
const { getProxyEnvValue, createProxyAgent } = require('./proxy-agent');

function sanitizeErrorMessage(error) {
  let message = error?.message || 'API Market 代理请求失败。';
  const proxyEnvValue = getProxyEnvValue();
  if (proxyEnvValue) message = message.split(proxyEnvValue).join('[proxy]');
  return message;
}

function getApiMarketBaseUrl(config) {
  let baseUrl;
  try {
    baseUrl = new URL(config?.baseUrl || '');
  } catch {
    return { ok: false, error: 'API Market baseUrl 无效。' };
  }
  if (baseUrl.protocol !== 'https:') return { ok: false, error: 'API Market baseUrl 必须使用 HTTPS。' };
  return { ok: true, url: baseUrl };
}

function requestApiMarket(method, targetPath, headers, body, config) {
  const baseUrl = getApiMarketBaseUrl(config);
  if (!baseUrl.ok) return Promise.reject(new Error(baseUrl.error));
  const upstreamUrl = new URL(targetPath, baseUrl.url);
  const proxyEnvValue = getProxyEnvValue();
  const bodyBuffer = body ? Buffer.from(body) : null;


  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
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
      upstreamRes.on('error', fail);
      upstreamRes.on('aborted', () => fail(new Error('上游响应已中止。')));
      upstreamRes.on('end', () => {
        succeed({
          status: upstreamRes.statusCode || 502,
          contentType: upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
          headers: upstreamRes.headers,
          retryAfter: upstreamRes.headers['retry-after'] || '',
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('上游请求超时。')));
    req.on('error', fail);
    req.on('socket', (socket) => socket.on('error', fail));
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
  getApiMarketBaseUrl,
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
