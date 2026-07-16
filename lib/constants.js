const path = require('node:path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, '..');
const API_PREFIX = '/api/api-market';
const BODY_LIMIT = 2 * 1024 * 1024;
const GENERATION_BODY_LIMIT = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_DOWNLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const BACKGROUND_REFRESH_INTERVAL_MS = 30000;
const STALE_SUBMITTING_MS = 5 * 60 * 1000;
const POLL_BACKOFF_BASE_MS = 4000;
const POLL_BACKOFF_MAX_MS = 60000;
const API_MARKET_BASE_URL = 'https://api.apimart.ai';

function readBooleanEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} 必须是 true 或 false。`);
}

const QUICK_BATCH_ENABLED = readBooleanEnv('QUICK_BATCH_ENABLED', false);
const PRICE_MULTIPLIER = 10;
const MICROS_PER_YUAN = 1000000;
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 18 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

module.exports = {
  HOST,
  PORT,
  ROOT,
  API_PREFIX,
  BODY_LIMIT,
  GENERATION_BODY_LIMIT,
  REQUEST_TIMEOUT_MS,
  SESSION_TTL_MS,
  IMAGE_DOWNLOAD_LIMIT_BYTES,
  BACKGROUND_REFRESH_INTERVAL_MS,
  STALE_SUBMITTING_MS,
  POLL_BACKOFF_BASE_MS,
  POLL_BACKOFF_MAX_MS,
  QUICK_BATCH_ENABLED,
  readBooleanEnv,
  API_MARKET_BASE_URL,
  PRICE_MULTIPLIER,
  MICROS_PER_YUAN,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
  MIME_TYPES
};
