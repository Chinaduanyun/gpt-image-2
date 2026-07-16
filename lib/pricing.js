const {
  MICROS_PER_YUAN,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES
} = require('./constants');
const {
  pricingConfig,
  normalizePricingModel,
  resolveModelPricingPolicy
} = require('./pricing-config');

const SIMPLE_PRICE_MAP = {
  '1k': 0.0085,
  '2k': 0.014,
  '4k': 0.021
};

const SIZE_RESOLUTION_MAP = {
  auto: { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:2': { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2336' },
  '2:3': { '1k': '1024x1536', '2k': '1360x2048', '4k': '2336x3520' },
  '4:3': { '1k': '1024x768', '2k': '2048x1536', '4k': '3312x2480' },
  '3:4': { '1k': '768x1024', '2k': '1536x2048', '4k': '2480x3312' },
  '5:4': { '1k': '1280x1024', '2k': '2560x2048', '4k': '3216x2576' },
  '4:5': { '1k': '1024x1280', '2k': '2048x2560', '4k': '2576x3216' },
  '16:9': { '1k': '1536x864', '2k': '2048x1152', '4k': '3840x2160' },
  '9:16': { '1k': '864x1536', '2k': '1152x2048', '4k': '2160x3840' },
  '2:1': { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2': { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
  '3:1': { '1k': '1536x512', '2k': '3072x1024', '4k': '3840x1280' },
  '1:3': { '1k': '512x1536', '2k': '1024x3072', '4k': '1280x3840' },
  '21:9': { '1k': '2016x864', '2k': '2688x1152', '4k': '3840x1648' },
  '9:21': { '1k': '864x2016', '2k': '1152x2688', '4k': '1648x3840' }
};

const OFFICIAL_PRICE_MAP = {
  '1536x512': { low: 0.00144, medium: 0.01296, high: 0.05144 },
  '512x1536': { low: 0.00144, medium: 0.01296, high: 0.05144 },
  '1024x3072': { low: 0.00256, medium: 0.02384, high: 0.09496 },
  '3072x1024': { low: 0.00256, medium: 0.02384, high: 0.09496 },
  '2016x864': { low: 0.00264, medium: 0.0228, high: 0.08848 },
  '864x2016': { low: 0.00264, medium: 0.0228, high: 0.08848 },
  '1536x864': { low: 0.00304, medium: 0.026, high: 0.1036 },
  '864x1536': { low: 0.00304, medium: 0.026, high: 0.1036 },
  '1024x2048': { low: 0.00328, medium: 0.02848, high: 0.11344 },
  '2048x1024': { low: 0.00328, medium: 0.02848, high: 0.11344 },
  '1024x768': { low: 0.00336, medium: 0.02904, high: 0.11568 },
  '768x1024': { low: 0.00336, medium: 0.02904, high: 0.11568 },
  '1280x3840': { low: 0.00344, medium: 0.032, high: 0.1276 },
  '3840x1280': { low: 0.00344, medium: 0.032, high: 0.1276 },
  '1152x2688': { low: 0.0036, medium: 0.03096, high: 0.12056 },
  '2688x1152': { low: 0.0036, medium: 0.03096, high: 0.12056 },
  '1024x1536': { low: 0.00392, medium: 0.03304, high: 0.13184 },
  '1536x1024': { low: 0.00392, medium: 0.03304, high: 0.13184 },
  '1152x2048': { low: 0.00392, medium: 0.03408, high: 0.13576 },
  '2048x1152': { low: 0.00392, medium: 0.03408, high: 0.13576 },
  '1024x1280': { low: 0.00432, medium: 0.0364, high: 0.14696 },
  '1280x1024': { low: 0.00432, medium: 0.0364, high: 0.14696 },
  '1344x2688': { low: 0.00448, medium: 0.03896, high: 0.15536 },
  '2688x1344': { low: 0.00448, medium: 0.03896, high: 0.15536 },
  '1024x1024': { low: 0.00488, medium: 0.04232, high: 0.16872 },
  '1360x2048': { low: 0.0052, medium: 0.04424, high: 0.17656 },
  '2048x1360': { low: 0.0052, medium: 0.04424, high: 0.17656 },
  '1648x3840': { low: 0.00576, medium: 0.05048, high: 0.19688 },
  '3840x1648': { low: 0.00576, medium: 0.05048, high: 0.19688 },
  '1536x2048': { low: 0.00608, medium: 0.05352, high: 0.21352 },
  '2048x1536': { low: 0.00608, medium: 0.05352, high: 0.21352 },
  '1920x3840': { low: 0.00736, medium: 0.06496, high: 0.25928 },
  '3840x1920': { low: 0.00736, medium: 0.06496, high: 0.25928 },
  '2160x3840': { low: 0.00904, medium: 0.08024, high: 0.32032 },
  '3840x2160': { low: 0.00904, medium: 0.08024, high: 0.32032 },
  '2048x2560': { low: 0.0092, medium: 0.07944, high: 0.32136 },
  '2560x2048': { low: 0.0092, medium: 0.07944, high: 0.32136 },
  '2048x2048': { low: 0.00968, medium: 0.08576, high: 0.34264 },
  '2336x3520': { low: 0.01088, medium: 0.09432, high: 0.37696 },
  '3520x2336': { low: 0.01088, medium: 0.09432, high: 0.37696 },
  '2480x3312': { low: 0.01192, medium: 0.106, high: 0.42368 },
  '3312x2480': { low: 0.01192, medium: 0.106, high: 0.42368 },
  '2576x3216': { low: 0.01296, medium: 0.11264, high: 0.45624 },
  '3216x2576': { low: 0.01296, medium: 0.11264, high: 0.45624 },
  '2880x2880': { low: 0.01592, medium: 0.1424, high: 0.56936 }
};

function usdToMicros(value, totalMultiplier = pricingConfig.totalMultiplier) {
  return Math.round(Number(value || 0) * totalMultiplier * MICROS_PER_YUAN);
}

function formatMoneyMicros(micros) {
  return `¥${(Number(micros || 0) / MICROS_PER_YUAN).toFixed(5)}`;
}

function parseMoneyToMicros(value) {
  if (value === undefined || value === null || value === '') return 0;
  const normalized = String(value).trim().replace(/^[¥￥$]/, '');
  const number = Number(normalized);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * MICROS_PER_YUAN);
}

function maxSimplePriceUsd() {
  return Math.max(...Object.values(SIMPLE_PRICE_MAP));
}

function maxOfficialPriceUsd() {
  return Math.max(...Object.values(OFFICIAL_PRICE_MAP).flatMap((tiers) => Object.values(tiers)));
}

function validateReferenceImage(value) {
  const text = String(value || '').trim();
  if (!text) return { ok: false, error: '参考图 URL 不能为空。' };

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
      return { ok: true, value: text, bytes: 0 };
    } catch {
      return { ok: false, error: '参考图 URL 格式无效。' };
    }
  }

  const match = text.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return { ok: false, error: '参考图只支持 http(s) URL 或 png/jpeg/webp base64 data URL。' };

  const base64 = match[2].replace(/[\r\n]/g, '');
  if (!base64 || base64.length % 4 !== 0) return { ok: false, error: '参考图 base64 格式无效。' };

  let bytes = 0;
  try {
    bytes = Buffer.from(base64, 'base64').length;
  } catch {
    return { ok: false, error: '参考图 base64 解码失败。' };
  }

  if (!bytes || bytes > MAX_REFERENCE_IMAGE_BYTES) {
    return { ok: false, error: `单张参考图不能超过 ${Math.round(MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024)}MB。` };
  }

  return { ok: true, value: `data:${match[1].toLowerCase()};base64,${base64}`, bytes };
}

function sanitizeReferenceImages(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  if (values.length > MAX_REFERENCE_IMAGES) throw new Error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张。`);

  const clean = [];
  let totalBytes = 0;
  for (const item of values) {
    const result = validateReferenceImage(item);
    if (!result.ok) throw new Error(result.error);
    totalBytes += result.bytes;
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
      throw new Error(`参考图总大小不能超过 ${Math.round(MAX_REFERENCE_TOTAL_BYTES / 1024 / 1024)}MB。`);
    }
    clean.push(result.value);
  }
  return clean;
}

function normalizeOfficialImageCount(value) {
  if (value === undefined || value === null || value === '') return 1;
  const count = Number(value);
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    throw new Error('生成张数必须是整数。');
  }
  return Math.max(1, Math.min(4, count));
}

const MAX_PROMPT_LENGTH = 8000;
const MAX_STRING_FIELD_LENGTH = 128;
const STRING_FIELDS = ['size', 'resolution', 'quality', 'output_format', 'background', 'moderation', 'user'];

function sanitizeGenerationPayload(payload, config) {
  const clean = {
    model: normalizePricingModel(payload.model || config.model)
  };

  // prompt：必须是字符串、trim 后非空、长度不超过 8000。
  const prompt = payload.prompt;
  if (typeof prompt !== 'string') throw new Error('提示词必须是字符串。');
  if (!prompt.trim()) throw new Error('提示词不能为空。');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`提示词长度不能超过 ${MAX_PROMPT_LENGTH} 个字符。`);
  clean.prompt = prompt;

  // 其余字符串参数：若提供必须是字符串且不超过 128 字符，防止对象/超长垃圾入库或上游。
  for (const key of STRING_FIELDS) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串。`);
    if (value.length > MAX_STRING_FIELD_LENGTH) throw new Error(`参数 ${key} 长度不能超过 ${MAX_STRING_FIELD_LENGTH} 个字符。`);
    clean[key] = value;
  }

  clean.n = normalizeOfficialImageCount(payload.n);

  if (payload.output_compression !== undefined && payload.output_compression !== null && payload.output_compression !== '') {
    clean.output_compression = Math.max(0, Math.min(100, Number(payload.output_compression) || 0));
  }

  const imageUrls = sanitizeReferenceImages(payload.image_urls);
  if (imageUrls.length) clean.image_urls = imageUrls;

  return clean;
}

function estimateGenerationCostMicros(payload) {
  let policy;
  let n;
  try {
    policy = resolveModelPricingPolicy(payload.model);
    n = normalizeOfficialImageCount(payload.n);
  } catch (error) {
    return { ok: false, error: error.message || '计价模型配置无效。' };
  }
  let providerUnitUsd;
  let detail;
  let pixelSize = '';
  let isMaximum = false;

  if (policy.model === 'gpt-image-2') {
    const resolution = payload.resolution || '1k';
    providerUnitUsd = SIMPLE_PRICE_MAP[resolution] ?? maxSimplePriceUsd();
    isMaximum = SIMPLE_PRICE_MAP[resolution] === undefined;
    detail = `${isMaximum ? '最高预扣' : resolution} × ${n}`;
  } else {
    const size = payload.size || '1:1';
    const resolution = payload.resolution || '1k';
    const quality = payload.quality || 'low';
    pixelSize = SIZE_RESOLUTION_MAP[size]?.[resolution] || '';
    const exactUnit = pixelSize ? OFFICIAL_PRICE_MAP[pixelSize]?.[quality] : undefined;
    providerUnitUsd = exactUnit ?? maxOfficialPriceUsd();
    isMaximum = exactUnit === undefined;
    detail = `${isMaximum ? '最高预扣' : pixelSize} · ${quality} × ${n}`;
  }

  const convertedUnitMicros = usdToMicros(providerUnitUsd, policy.totalMultiplier);
  const unitMicros = Math.max(convertedUnitMicros, policy.minimumPerImageMicros);
  const totalMicros = unitMicros * n;
  const minimumChargeMicros = policy.minimumPerImageMicros * n;
  if (![convertedUnitMicros, unitMicros, totalMicros, minimumChargeMicros].every(Number.isSafeInteger)) {
    return { ok: false, error: '计价结果超出安全整数范围。' };
  }

  return {
    ok: true,
    model: policy.model,
    pricingVersion: pricingConfig.version,
    billingPolicy: pricingConfig.billingPolicy,
    totalMultiplier: policy.totalMultiplier,
    minimumPerImageMicros: policy.minimumPerImageMicros,
    billingImageCount: n,
    minimumChargeMicros,
    providerUnitUsd,
    convertedUnitMicros,
    unitMicros,
    totalMicros,
    detail,
    pixelSize,
    isMaximum
  };
}

module.exports = {
  SIMPLE_PRICE_MAP,
  SIZE_RESOLUTION_MAP,
  OFFICIAL_PRICE_MAP,
  pricingConfig,
  usdToMicros,
  formatMoneyMicros,
  parseMoneyToMicros,
  maxSimplePriceUsd,
  maxOfficialPriceUsd,
  validateReferenceImage,
  sanitizeReferenceImages,
  normalizeOfficialImageCount,
  sanitizeGenerationPayload,
  estimateGenerationCostMicros
};
