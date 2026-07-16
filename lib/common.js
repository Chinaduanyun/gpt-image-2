const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalize(value[key]);
    return output;
  }, {});
}

function canonicalPayloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function getIdempotencyKeyInfo(req) {
  const headers = req?.headers || {};
  const present = Object.prototype.hasOwnProperty.call(headers, 'idempotency-key');
  if (!present) return { present: false, valid: true, value: '' };
  const value = String(headers['idempotency-key'] || '').trim();
  return {
    present: true,
    valid: Boolean(value) && value.length <= 200 && !/[\r\n]/.test(value),
    value
  };
}

function getIdempotencyKey(req) {
  const result = getIdempotencyKeyInfo(req);
  return result.valid ? result.value : '';
}

module.exports = {
  nowIso,
  createId,
  normalizeEmail,
  decodePathPart,
  canonicalize,
  canonicalPayloadHash,
  getIdempotencyKeyInfo,
  getIdempotencyKey
};
