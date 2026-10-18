const fs = require('node:fs');
const path = require('node:path');
const { SIZE_RESOLUTION_MAP } = require('./pricing');
const { getImageStoreDir } = require('./store');
const { readSource, InvalidImageError } = require('./image-assets');

class ProviderError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
function cpaConfig() {
  let config; let url;
  try {
    config = JSON.parse(fs.readFileSync(process.env.CPA_CONFIG_FILE || '/run/secrets/cpa.json', 'utf8'));
    url = new URL(config.baseUrl);
  } catch { throw new ProviderError('unavailable', 'CPA 配置不可用。'); }
  const allowed = process.env.CPA_ALLOWED_ORIGIN;
  if (!allowed || url.origin !== allowed || url.username || url.password || !['http:', 'https:'].includes(url.protocol) || typeof config.apiKey !== 'string' || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey)) throw new ProviderError('unavailable', 'CPA 配置不可用。');
  return config;
}
function normalizeResult(text, contentType) {
  const candidates = [];
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { candidates.push(JSON.parse(data)); } catch { /* incomplete event */ }
    }
  } else {
    try { candidates.push(JSON.parse(text)); } catch { throw new ProviderError('unknown', 'CPA 响应无法确认，未自动重发。'); }
  }
  for (const json of candidates.reverse()) {
    if (json.error) throw new ProviderError('unknown', 'CPA 返回错误事件，需人工确认。');
    const data = Array.isArray(json.data) ? json.data : [json];
    const sources = data.map((item) => item.b64_json || item.result ? { base64: item.b64_json || item.result } : item.url ? { url: item.url } : null).filter(Boolean);
    if (sources.length) return sources;
  }
  throw new ProviderError('unknown', 'CPA 未返回可确认的成品，未自动重发。');
}
async function readBoundedResponse(response, limit) {
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      bytes += value.length;
      if (bytes > limit) throw new Error('large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // Do not drain an oversized/failed body or wait for a remote cancellation ack.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
async function generateCpa(payload, inputs, options = {}) {
  let config; let endpoint; let body; let headers;
  try {
  config = options.config || cpaConfig();
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new Error('Invalid CPA config');
  const prefix = base.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
  base.pathname = `${prefix}/v1/images/${inputs.length ? 'edits' : 'generations'}`;
  base.search = ''; base.hash = ''; endpoint = base.href;
  const size = SIZE_RESOLUTION_MAP[payload.size || '1:1']?.[payload.resolution || '1k'] || '1024x1024';
  const fields = {
    model: 'gpt-image-2', n: 1,
    prompt: `${payload.prompt}\n\nRequested output: ${size}, aspect ratio ${payload.size || '1:1'}, quality ${payload.quality || 'auto'}, format ${payload.output_format || 'png'}. Follow these specifications as closely as supported.`,
    size, quality: payload.quality || 'auto', output_format: payload.output_format || 'png', response_format: 'b64_json'
  };
  if (payload.output_compression !== undefined) fields.output_compression = payload.output_compression;
  headers = { Authorization: `Bearer ${config.apiKey}` };
  new Headers(headers);
  if (inputs.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    for (const file of inputs) body.append('image[]', new Blob([fs.readFileSync(path.join(getImageStoreDir(), file.fileName))], { type: file.contentType }), file.fileName);
  } else { body = JSON.stringify(fields); headers['Content-Type'] = 'application/json'; }
  } catch { throw new ProviderError('unavailable', 'CPA 配置或本地请求准备失败，尚未提交。'); }
  let response;
  try {
    response = await (options.fetch || fetch)(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 180000) });
  } catch { throw new ProviderError('unknown', 'CPA 请求断连或超时，提交结果未知；不会自动重发或回退。'); }
  if (!response.ok) {
    let text;
    try { text = await readBoundedResponse(response, 4096); }
    catch { throw new ProviderError('unknown', 'CPA 错误响应中断或过大；不会重发或回退。'); }
    if (/safety|moderation|content_policy|policy_violation|安全策略/i.test(text)) throw new ProviderError('policy', '安全策略拒绝；不会切换通道绕过限制。');
    if ([401, 403, 404].includes(response.status)) throw new ProviderError('unavailable', `CPA 通道不可用（HTTP ${response.status}）。`);
    if ([400, 422].includes(response.status)) throw new ProviderError('technical', `CPA 明确拒绝参数（HTTP ${response.status}）。`);
    throw new ProviderError('unknown', `CPA HTTP ${response.status}，执行结果未知；不会自动回退。`);
  }
  let text;
  try {
    text = await readBoundedResponse(response, 40 * 1024 * 1024);
  } catch { throw new ProviderError('unknown', 'CPA 成品响应中断或过大；不会重发。'); }
  return normalizeResult(text, response.headers.get('content-type') || '');
}
async function resultBuffer(result) {
  if (result.base64) {
    if (typeof result.base64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(result.base64)) throw new InvalidImageError('成品编码无效。');
    return Buffer.from(result.base64, 'base64');
  }
  return readSource(result.url);
}
module.exports = { ProviderError, cpaConfig, normalizeResult, generateCpa, resultBuffer };
