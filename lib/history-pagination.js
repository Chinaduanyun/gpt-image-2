const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { batchDto } = require('../routes/api-market');
const { publicLog } = require('./image-task-runner');

// Cursors are read boundaries, not credentials. Restarting the server expires them;
// every page still independently selects only the authenticated account's logs.
const cursorKey = randomBytes(32);
const FILTERS = new Set(['all', 'completed', 'failed', 'partial', 'active', 'with-reference']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'submit_failed_refunded', 'submission_refunded_closed', 'attention_required', 'submission_unknown']);
const COMPLETED = new Set(['completed', 'succeeded', 'success']);
const PARTIAL = new Set(['partial_success', 'partial']);
const OMIT_KEYS = new Set(['b64_json', 'b64', 'base64', 'image_base64', 'imagebase64', 'api_key', 'apikey', 'authorization', 'access_token']);
const ASSET_KEYS = new Set(['image_urls', 'imageUrls', 'image_files', 'imageFiles', 'input_files', 'inputFiles', 'mask', 'mask_url', 'originalUrl', 'originalUrls']);

function historyError(message, code = 'history_query_invalid') {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function groupHistoryLogs(logs) {
  const output = [];
  const batches = new Map();
  for (const log of logs) {
    if (log.type === 'generation' && log.batchId) {
      if (!batches.has(log.batchId)) batches.set(log.batchId, []);
      batches.get(log.batchId).push(log);
    } else output.push(log);
  }
  for (const members of batches.values()) output.push(batchDto(members));
  return output.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
}

function referenceCount(log) {
  return Number(log.referenceImageCount || log.settings?.referenceImageCount || log.settings?.image_urls?.length || log.imageUrlsReferenceCount || 0);
}

// Copy without embedded image payloads; do not mutate publicLog or persisted records.
// Iterative traversal also handles deeply nested legacy provider JSON without a
// recursive call-stack limit. Array omissions are compact, never sparse/null slots.
function pagedPublicLog(log) {
  const source = publicLog(log);
  const output = {};
  const pending = [[source, output]];
  while (pending.length) {
    const [input, target] = pending.pop();
    for (const [key, value] of Object.entries(input)) {
      // Authoritative user text is needed verbatim for display/reuse; illustrative
      // asset syntax is not a provider payload or a deleted asset reference.
      if (input === source && key === 'prompt') {
        output.prompt = value;
        continue;
      }
      if (OMIT_KEYS.has(key.toLowerCase()) || (typeof value === 'string' && /\bdata:[^\s,]*[;,]/i.test(value))) continue;
      if (source.assetsDeletedAt && ((input === source.settings && ASSET_KEYS.has(key)) || (typeof value === 'string' && value.includes('/api/stored-images/')))) continue;
      const copy = value && typeof value === 'object' ? (Array.isArray(value) ? [] : {}) : value;
      if (Array.isArray(target)) target.push(copy);
      else Object.defineProperty(target, key, { value: copy, enumerable: true, configurable: true, writable: true });
      if (copy && typeof value === 'object') pending.push([value, copy]);
    }
  }
  const count = referenceCount(source);
  if (count > 0) output.referenceImageCount = count;
  return output;
}

function formatMicros(value) {
  const number = Number(value) || 0;
  const precision = Math.abs(number) < 1000000 ? 3 : 2;
  const scale = 10 ** precision;
  const absolute = Math.abs(number);
  const integer = Math.floor(absolute / 1000000);
  const fraction = Math.floor(((absolute - integer * 1000000) * scale) / 1000000);
  return `¥${number < 0 ? '-' : ''}${integer}.${String(fraction).padStart(precision, '0')}`;
}

function matches(log, q, filter) {
  const status = String(log.status || '').toLowerCase();
  if (filter === 'completed' && !log.imageUrls?.length) return false;
  if (filter === 'failed' && !FAILED.has(status)) return false;
  if (filter === 'partial' && !PARTIAL.has(status)) return false;
  if (filter === 'active' && (FAILED.has(status) || COMPLETED.has(status) || PARTIAL.has(status))) return false;
  if (filter === 'with-reference' && !(referenceCount(log) > 0)) return false;
  if (!q) return true;
  const settings = log.settings || {};
  const count = log.requestedImageCount || log.requestedCount || settings.n || 1;
  const settingsText = [log.model || settings.model, settings.size, settings.resolution, settings.quality, `${count}张`].filter(Boolean).join(' · ');
  const billing = log.aggregateBilling || log.aggregate_billing || log.billing || log;
  const cost = [
    `${log.priceIsMaximum ? '最高预扣' : '预估'} ${formatMicros(billing.estimatedCostMicros)}`,
    `预扣/扣费 ${formatMicros(billing.chargedMicros)}`,
    Number.isSafeInteger(billing.settledActualCostMicros) ? `已结算小计 ${formatMicros(billing.settledActualCostMicros)}` : '',
    billing.settled === true && Number.isSafeInteger(billing.actualCostMicros) && billing.actualCostMicros >= 0 ? `最终实际 ${formatMicros(billing.actualCostMicros)}` : ''
  ].filter(Boolean).join(' / ');
  const ids = (log.children || []).flatMap((child) => [child.id, child.taskId, child.task_id]);
  return [log.prompt, log.model, log.id, log.taskId, log.batchId, log.batch_id, log.status, ...ids, settingsText, cost].filter(Boolean).join(' ').toLowerCase().includes(q);
}

function boundary(log) {
  return { t: Date.parse(log.createdAt || '') || 0, id: String(log.batchId || log.id || '') };
}
function compare(a, b) {
  return b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
function signature(body) {
  return createHmac('sha256', cursorKey).update(body).digest('base64url');
}
function encodeCursor(scope, log) {
  const body = Buffer.from(JSON.stringify({ v: 1, s: scope, ...boundary(log) })).toString('base64url');
  return `${body}.${signature(body)}`;
}
function decodeCursor(cursor, scope) {
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new Error();
    const [body, mac] = cursor.split('.');
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(body)))) throw new Error();
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.s !== scope || !Number.isSafeInteger(value.t) || typeof value.id !== 'string' || !value.id || value.id.length > 512) throw new Error();
    return value;
  } catch {
    throw historyError('历史分页游标无效，请重新加载。', 'history_cursor_invalid');
  }
}

function historyPage(data, email, params) {
  const rawLimit = params.get('limit');
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1)) throw historyError('分页数量必须为正整数。');
  const limit = rawLimit === null ? 24 : Math.min(100, Number(rawLimit));
  const rawQuery = params.get('q') || '';
  if (rawQuery.length > 1000) throw historyError('搜索内容过长。');
  const q = rawQuery.trim().toLowerCase();
  const filter = params.get('filter') || 'all';
  if (!FILTERS.has(filter)) throw historyError('历史筛选条件无效。');
  const scope = createHash('sha256').update(JSON.stringify([email, q, filter])).digest('base64url');
  const cursor = params.has('cursor') ? decodeCursor(params.get('cursor'), scope) : null;
  const owned = data.spendLogs.filter((log) => log.type === 'generation' && log.email === email && log.hiddenFromHistory !== true);
  // Group the complete account history before matching or applying any boundary.
  // Search original child fields too: the legacy aggregate omits child ids and
  // represents shared prompt/settings using only the first child.
  const members = new Map();
  for (const log of owned) {
    if (!log.batchId) continue;
    if (!members.has(log.batchId)) members.set(log.batchId, []);
    members.get(log.batchId).push(log);
  }
  const groups = groupHistoryLogs(owned).map(publicLog).filter((log) => {
    if (matches(log, q, filter)) return true;
    return q && log.batchId && matches(log, '', filter) && members.get(log.batchId).some((child) => matches(child, q, 'all'));
  }).sort((a, b) => compare(boundary(a), boundary(b)));
  const remaining = cursor ? groups.filter((log) => compare(boundary(log), cursor) > 0) : groups;
  const items = remaining.slice(0, limit);
  const hasMore = remaining.length > items.length;
  return { logs: items.map(pagedPublicLog), page: { limit, hasMore, nextCursor: hasMore ? encodeCursor(scope, items.at(-1)) : null, total: groups.length } };
}

module.exports = { groupHistoryLogs, historyPage, pagedPublicLog };
