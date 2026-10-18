// Account workspace feed: deliberately independent of legacy/provider DTOs.
const TERMINAL = new Set(['completed', 'succeeded', 'success', 'failed', 'cancelled', 'error', 'submit_failed_refunded', 'submission_refunded_closed']);
const STATUSES = new Set([...TERMINAL, 'queued', 'pending', 'submitting', 'submitted', 'processing', 'running', 'submission_unknown']);
function maxActiveRequests() {
  const value = Number(process.env.MAX_ACTIVE_REQUESTS);
  return Number.isSafeInteger(value) && value > 0 ? value : 3;
}
function isActive(log) {
  // Historical terminal records without explicit unsettled state are frozen.
  // Unknown/nonterminal records remain active even with inconsistent settlement.
  return log.settled === false || !TERMINAL.has(String(log.status || '').toLowerCase());
}
function requestGroups(data, email) {
  const groups = new Map();
  for (const log of data.spendLogs || []) {
    if (log.type !== 'generation' || log.email !== email) continue;
    const key = log.batchId ? `batch:${log.batchId}` : (log.clientRequestId || log.idempotencyKey) ? `request:${log.clientRequestId || log.idempotencyKey}` : `log:${log.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }
  return [...groups.values()];
}
function activeRequestCount(data, email) {
  return requestGroups(data, email).filter((logs) => logs.some(isActive)).length;
}
function activeRequestLimit(data, email) {
  const limit = maxActiveRequests();
  const activeCount = activeRequestCount(data, email);
  return activeCount >= limit ? { limit, activeCount } : null;
}
function text(value) {
  return typeof value === 'string' ? value.replace(/data:[^\s]+/gi, '[embedded data omitted]').slice(0, 16000) : '';
}
function files(log, field) {
  if (log.assetsDeletedAt) return [];
  return (Array.isArray(log[field]) ? log[field] : []).flatMap((file) => {
    if (!file || typeof file.fileName !== 'string' || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(file.fileName)) return [];
    return [{ fileName: file.fileName, url: `/api/stored-images/${encodeURIComponent(file.fileName)}` }];
  });
}
function billing(logs) {
  const sum = (key) => logs.reduce((total, log) => total + (Number.isFinite(log[key]) ? log[key] : 0), 0);
  const settled = logs.every((log) => log.settled === true);
  return { estimatedCostMicros: sum('estimatedCostMicros'), chargedMicros: sum('chargedMicros'), actualCostMicros: settled ? sum('actualCostMicros') : null, settled };
}
function childDto(log, index) {
  const imageFiles = files(log, 'imageFiles');
  const referenceImageCount = Number.isSafeInteger(log.referenceImageCount) && log.referenceImageCount >= 0 ? log.referenceImageCount : null;
  return { id: text(log.id), taskId: text(log.taskId), index, status: STATUSES.has(log.status) ? log.status : 'submission_unknown', active: isActive(log), createdAt: text(log.createdAt), completedAt: text(log.completedAt), imageFiles, imageUrls: imageFiles.map((file) => file.url), inputFiles: files(log, 'inputFiles'), referenceImageCount, assetsDeleted: Boolean(log.assetsDeletedAt), billing: billing([log]), error: log.error ? '任务异常，请打开任务详情或联系管理员核查。' : '' };
}
function groupDto(logs) {
  logs = logs.slice().sort((a, b) => (Number(a.batchIndex) || 0) - (Number(b.batchIndex) || 0));
  const first = logs[0];
  const children = logs.map(childDto);
  // The expected input count cannot be inferred from a possibly incomplete archive.
  const referenceImageCount = children.every((child) => child.referenceImageCount !== null && child.referenceImageCount === children[0].referenceImageCount) ? children[0].referenceImageCount : null;
  const active = children.some((child) => child.active);
  const status = children.some((child) => child.status === 'submission_unknown') ? 'submission_unknown' : active ? (children.length === 1 ? children[0].status : 'processing') : children.every((child) => ['completed', 'success', 'succeeded'].includes(child.status)) ? 'completed' : 'failed';
  const settings = {};
  for (const key of ['size', 'resolution', 'quality', 'output_format']) settings[key] = text(first.settings?.[key]);
  if (Number.isFinite(first.settings?.output_compression)) settings.output_compression = first.settings.output_compression;
  settings.n = first.batchId ? logs.length : (Number(first.settings?.n) || 1);
  return { id: text(first.batchId || first.id), clientRequestId: text(first.clientRequestId || first.idempotencyKey), kind: first.batchId ? 'batch' : 'task', taskId: children.length === 1 ? children[0].taskId : '', batchId: text(first.batchId), createdAt: text(first.createdAt), completedAt: active ? '' : children.map((child) => child.completedAt).sort().at(-1), prompt: text(first.prompt), model: text(first.model), settings, status, active, requestedCount: settings.n, completedCount: children.filter((child) => ['completed', 'success', 'succeeded'].includes(child.status)).length, children, imageFiles: children.flatMap((child) => child.imageFiles), imageUrls: children.flatMap((child) => child.imageUrls), inputFiles: children.flatMap((child) => child.inputFiles), referenceImageCount, assetsDeleted: children.every((child) => child.assetsDeleted), billing: billing(logs), error: children.find((child) => child.error)?.error || '' };
}
function taskWorkspace(data, email) {
  const groups = requestGroups(data, email);
  const active = groups.filter((logs) => logs.some(isActive));
  const recent = groups.filter((logs) => !logs.some(isActive) && !logs.every((log) => log.hiddenFromHistory === true)).sort((a, b) => Date.parse(b[0].createdAt || '') - Date.parse(a[0].createdAt || '')).slice(0, 20);
  return { tasks: [...active, ...recent].map(groupDto).sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '')), activeCount: active.length, limit: maxActiveRequests() };
}
module.exports = { maxActiveRequests, isActive, requestGroups, activeRequestCount, activeRequestLimit, taskWorkspace };
