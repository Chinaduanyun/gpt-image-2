const { nowIso } = require('./common');
const { POLL_BACKOFF_BASE_MS, POLL_BACKOFF_MAX_MS, STALE_SUBMITTING_MS } = require('./constants');
const { withDataStoreMutation } = require('./store');
const {
  saveImagesForLog,
  isLocalStoredImageUrl,
  hasCompleteImageArchive,
  deleteStoredImageFiles
} = require('./image-store');
const {
  requestApiMarket,
  getApiHeaders,
  parseJsonText,
  extractImageUrls,
  getTaskStatus,
  getProviderCostMicrosState
} = require('./api-market-client');
const {
  pricingConfig,
  BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1
} = require('./pricing-config');

function replaceTaskJsonImageUrls(taskJson, imageUrls) {
  if (!imageUrls?.length || !taskJson) return taskJson;
  taskJson.data = taskJson.data && typeof taskJson.data === 'object' ? taskJson.data : {};
  taskJson.data.result = taskJson.data.result && typeof taskJson.data.result === 'object' ? taskJson.data.result : {};
  taskJson.data.result.images = imageUrls.map((url) => ({ url }));
  return taskJson;
}

function findTaskLocation(data, taskId) {
  return data.spendLogs.find((entry) => entry.type !== 'balance_adjustment' && entry.taskId === taskId) || null;
}

function findSpendLogByTaskId(data, taskId) {
  return findTaskLocation(data, taskId);
}

function findLogById(data, id) {
  return data.spendLogs.find((entry) => entry.id === id) || null;
}

function findSnapshotLog(data, snapshot) {
  return snapshot.taskId
    ? findSpendLogByTaskId(data, snapshot.taskId)
    : findLogById(data, snapshot.id);
}

function getLogTotalMultiplier(log) {
  const snapshot = Number(log.totalMultiplier);
  return Number.isFinite(snapshot) && snapshot > 0 ? snapshot : pricingConfig.legacyTotalMultiplier;
}

function hasNewPolicyMarker(log) {
  const nested = log.pricingSnapshot;
  const hasVersionMarker = Object.prototype.hasOwnProperty.call(log, 'pricingVersion')
    && log.pricingVersion !== undefined
    && log.pricingVersion !== null
    && (typeof log.pricingVersion !== 'string' || log.pricingVersion.trim() !== '');
  return log.billingPolicy !== undefined
    || hasVersionMarker
    || (nested && typeof nested === 'object');
}

function getFloorPolicySnapshot(log) {
  if (!Number.isFinite(log.totalMultiplier) || log.totalMultiplier <= 0) return null;
  if (!Number.isSafeInteger(log.minimumPerImageMicros) || log.minimumPerImageMicros <= 0) return null;
  if (!Number.isSafeInteger(log.billingImageCount) || log.billingImageCount < 1 || log.billingImageCount > 4) return null;
  if (!Number.isSafeInteger(log.minimumChargeMicros) || log.minimumChargeMicros <= 0) return null;
  const expectedMinimumChargeMicros = log.minimumPerImageMicros * log.billingImageCount;
  if (!Number.isSafeInteger(expectedMinimumChargeMicros) || log.minimumChargeMicros !== expectedMinimumChargeMicros) return null;

  if (log.pricingSnapshot !== undefined) {
    const nested = log.pricingSnapshot;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return null;
    for (const field of [
      'pricingVersion',
      'billingPolicy',
      'totalMultiplier',
      'minimumPerImageMicros',
      'billingImageCount',
      'minimumChargeMicros'
    ]) {
      if (nested[field] !== log[field]) return null;
    }
  }

  return {
    totalMultiplier: log.totalMultiplier,
    minimumChargeMicros: log.minimumChargeMicros
  };
}

function getLogMinimumChargeMicros(log) {
  if (log.billingPolicy !== BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1) return null;
  return getFloorPolicySnapshot(log)?.minimumChargeMicros ?? null;
}

function getSettlementPricingSnapshot(log) {
  if (log.billingPolicy === BILLING_POLICY_PROVIDER_TASK_TOTAL_WITH_PER_IMAGE_FLOOR_V1) {
    const snapshot = getFloorPolicySnapshot(log);
    return snapshot ? { ok: true, ...snapshot } : { ok: false };
  }
  if (hasNewPolicyMarker(log)) return { ok: false };
  return { ok: true, totalMultiplier: getLogTotalMultiplier(log), minimumChargeMicros: null };
}

function applyActualCostSettlement(data, log, actualCostMicros) {
  if (log.settled !== false || !Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0) return false;
  const user = data.users[log.email];
  if (!user) return false;

  const charged = Number(log.chargedMicros) || 0;
  const diff = actualCostMicros - charged;
  if (diff > 0) {
    const extra = Math.min(Number(user.balanceMicros) || 0, diff);
    user.balanceMicros = (Number(user.balanceMicros) || 0) - extra;
    log.balanceUnderpaidMicros = diff - extra;
    log.balanceAfterMicros = user.balanceMicros;
    log.chargedMicros = charged + extra;
  } else if (diff < 0) {
    user.balanceMicros = (Number(user.balanceMicros) || 0) + Math.abs(diff);
    log.balanceAfterMicros = user.balanceMicros;
    log.chargedMicros = actualCostMicros;
  }
  log.actualCostMicros = actualCostMicros;
  log.balanceUpdatedAt = nowIso();
  log.settlementStatus = 'settled';
  log.settled = true;
  return true;
}

function applyProviderCostSettlement(data, log, providerCostMicros) {
  if (log.settled !== false) return false;
  if (!Number.isSafeInteger(providerCostMicros) || providerCostMicros < 0) {
    if (providerCostMicros === null) log.settlementStatus = 'provider_cost_missing';
    return false;
  }
  const pricingSnapshot = getSettlementPricingSnapshot(log);
  if (!pricingSnapshot.ok) {
    log.settlementStatus = 'invalid_snapshot';
    return false;
  }
  const multiplierChargeMicros = Math.round(providerCostMicros * pricingSnapshot.totalMultiplier);
  if (!Number.isSafeInteger(multiplierChargeMicros) || multiplierChargeMicros < 0) return false;
  const actualCostMicros = pricingSnapshot.minimumChargeMicros === null
    ? multiplierChargeMicros
    : Math.max(multiplierChargeMicros, pricingSnapshot.minimumChargeMicros);
  log.providerCostMicros = providerCostMicros;
  return applyActualCostSettlement(data, log, actualCostMicros);
}

function applyTaskJsonToLog(data, log, taskJson) {
  const status = getTaskStatus(taskJson);
  const providerCost = getProviderCostMicrosState(taskJson);
  if (status === 'completed' || status === 'succeeded' || status === 'success') {
    const remoteUrls = extractImageUrls(taskJson);
    log.status = 'completed';
    log.completedAt = log.completedAt || nowIso();
    delete log.lastRefreshError;
    if (remoteUrls.length) log.remoteImageUrls = remoteUrls;
    if (providerCost.status === 'valid') {
      applyProviderCostSettlement(data, log, providerCost.micros);
    } else if (log.settled === false) {
      log.settlementStatus = providerCost.status === 'missing'
        ? 'provider_cost_missing'
        : 'provider_cost_invalid';
    }
    return true;
  }

  if (status === 'failed' || status === 'cancelled' || status === 'error') {
    log.status = 'failed';
    log.completedAt = log.completedAt || nowIso();
    delete log.lastRefreshError;
    log.error = taskJson?.data?.error?.message || taskJson?.error?.message || '任务失败';
    if (providerCost.status === 'valid') {
      applyProviderCostSettlement(data, log, providerCost.micros);
    } else if (providerCost.status === 'invalid') {
      if (log.settled === false) log.settlementStatus = 'provider_cost_invalid';
    } else if (log.settled === false) {
      const user = data.users[log.email];
      if (user) {
        user.balanceMicros = (Number(user.balanceMicros) || 0) + (Number(log.chargedMicros) || 0);
        log.balanceAfterMicros = user.balanceMicros;
      }
      log.actualCostMicros = 0;
      log.chargedMicros = 0;
      log.settlementStatus = 'refunded';
      log.settled = true;
    }
    return true;
  }

  return false;
}

function markStaleSubmittingUnknown(data, now = Date.now(), staleMs = STALE_SUBMITTING_MS, force = false) {
  let changed = false;
  for (const log of data.spendLogs) {
    if (log.type !== 'generation' || log.status !== 'submitting' || log.taskId) continue;
    const created = Date.parse(log.submitStartedAt || log.createdAt || '');
    if (!force && Number.isFinite(created) && now - created < staleMs) continue;
    log.status = 'submission_unknown';
    log.error = log.error || '提交结果未知；为避免重复计费，不会自动重试或退款。';
    log.settlementStatus = 'submission_unknown';
    log.completedAt = log.completedAt || nowIso();
    changed = true;
  }
  return changed;
}

function closeSubmissionUnknownWithRefund(data, log, adminEmail, reason = '') {
  if (!log || log.type !== 'generation' || log.status !== 'submission_unknown' || log.taskId || log.batchId || log.batch_id || log.settled !== false) return { ok: false };

  const user = data.users[log.email];
  if (!user) return { ok: false, userMissing: true };

  const refundMicros = Math.max(0, Number(log.chargedMicros) || 0);
  const timestamp = nowIso();

  const balanceBeforeMicros = Number(user.balanceMicros) || 0;
  user.balanceMicros = balanceBeforeMicros + refundMicros;
  user.updatedAt = timestamp;
  log.status = 'submission_refunded_closed';
  log.chargedMicros = 0;
  log.actualCostMicros = 0;
  log.balanceAfterMicros = user.balanceMicros;
  log.balanceUpdatedAt = timestamp;
  log.completedAt = log.completedAt || timestamp;
  log.settlementStatus = 'admin_refunded_closed';
  log.settled = true;
  log.resolution = {
    action: 'admin_refund_and_close',
    adminEmail,
    reason: String(reason || '').trim(),
    refundMicros,
    resolvedAt: timestamp
  };
  return { ok: true, refundMicros, balanceBeforeMicros, balanceAfterMicros: user.balanceMicros, timestamp };
}

function logNeedsUpstreamRefresh(log) {
  if (!log.taskId || log.settled !== false) return false;
  const nextRefreshAt = Date.parse(log.nextRefreshAt || '');
  return !Number.isFinite(nextRefreshAt) || nextRefreshAt <= Date.now();
}

function logNeedsRefresh(log) {

  if (log.type !== 'generation' || log.hiddenFromHistory === true) return false;
  if (logNeedsUpstreamRefresh(log)) return true;
  if (log.status === 'completed') {
    const sourceUrls = (log.remoteImageUrls || log.imageUrls || []).filter((url) => !isLocalStoredImageUrl(url));
    return sourceUrls.length > 0 && !hasCompleteImageArchive(log, sourceUrls);
  }
  return false;
}

async function archiveImagesOutsideMutation(snapshot, sourceUrls) {
  const archived = {
    ...snapshot,
    imageUrls: Array.isArray(snapshot.imageUrls) ? [...snapshot.imageUrls] : [],
    remoteImageUrls: Array.isArray(snapshot.remoteImageUrls) ? [...snapshot.remoteImageUrls] : [],
    imageFiles: Array.isArray(snapshot.imageFiles) ? [...snapshot.imageFiles] : []
  };
  await saveImagesForLog(archived, sourceUrls);
  return {
    imageUrls: archived.imageUrls,
    remoteImageUrls: archived.remoteImageUrls,
    imageFiles: archived.imageFiles,
    imageSaveErrors: archived.imageSaveErrors
  };
}

function mergeArchivedImages(log, archived) {
  if (log.hiddenFromHistory === true) return false;
  log.imageUrls = archived.imageUrls;
  log.remoteImageUrls = archived.remoteImageUrls;
  log.imageFiles = archived.imageFiles;
  if (archived.imageSaveErrors?.length) log.imageSaveErrors = archived.imageSaveErrors;
  else delete log.imageSaveErrors;
  return true;
}

const taskRefreshInFlight = new Map();

function parseRetryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function getPollBackoffMs(attempt, retryAfter = '') {
  const fromHeader = parseRetryAfterMs(retryAfter);
  if (fromHeader > 0) return fromHeader;
  const base = Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * (2 ** Math.max(0, Math.min(6, attempt - 1))));
  const jitterRange = Math.max(1, Math.round(base * 0.2));
  const jitter = Math.floor(Math.random() * ((jitterRange * 2) + 1)) - jitterRange;
  return Math.max(1000, Math.min(POLL_BACKOFF_MAX_MS, base + jitter));
}

function scheduleRefreshBackoff(log, message, retryAfter = '') {
  log.refreshAttempt = (Number(log.refreshAttempt) || 0) + 1;
  log.nextRefreshAt = new Date(Date.now() + getPollBackoffMs(log.refreshAttempt, retryAfter)).toISOString();
  log.lastRefreshError = message;
}

function needsTerminalSettlementBackoff(log) {
  return log.settled === false
    && ['completed', 'failed'].includes(String(log.status || '').toLowerCase())
    && ['provider_cost_missing', 'provider_cost_invalid', 'invalid_snapshot'].includes(log.settlementStatus);
}

function requestTaskDeduped(taskId, config) {
  if (taskRefreshInFlight.has(taskId)) return taskRefreshInFlight.get(taskId);
  const request = requestApiMarket('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, getApiHeaders(config), null, config)
    .finally(() => taskRefreshInFlight.delete(taskId));
  taskRefreshInFlight.set(taskId, request);
  return request;
}

async function refreshLogsFromUpstream(data, logs, config, maxCount = 25) {
  if (!config.apiKey?.trim()) return false;
  let changed = false;
  let refreshed = 0;

  for (const snapshot of logs) {
    if (!logNeedsRefresh(snapshot) || refreshed >= maxCount) continue;
    refreshed += 1;

    try {
      let taskJson = null;
      let latestSnapshot = snapshot;
      if (logNeedsUpstreamRefresh(snapshot)) {
        const upstream = await requestTaskDeduped(snapshot.taskId, config);
        taskJson = parseJsonText(upstream.text);
        latestSnapshot = await withDataStoreMutation((latestData) => {
          const log = findSpendLogByTaskId(latestData, snapshot.taskId);
          if (!log) return null;
          if (upstream.status < 200 || upstream.status >= 300) {
            scheduleRefreshBackoff(log, `状态查询失败：HTTP ${upstream.status}`, upstream.retryAfter);
          } else if (!taskJson) {
            scheduleRefreshBackoff(log, '状态查询返回了无效 JSON。');
          } else {
            applyTaskJsonToLog(latestData, log, taskJson);
            if (needsTerminalSettlementBackoff(log)) {
              scheduleRefreshBackoff(log, '任务已终止，但供应商成本缺失或无效，稍后重试。');
            } else {
              delete log.nextRefreshAt;
              delete log.lastRefreshError;
              log.refreshAttempt = 0;
            }
          }
          return { ...log };
        });
        if (latestSnapshot) changed = true;
      }

      const sourceUrls = taskJson ? extractImageUrls(taskJson) : (latestSnapshot?.remoteImageUrls || latestSnapshot?.imageUrls || []);
      if (latestSnapshot?.status === 'completed' && sourceUrls.length && !hasCompleteImageArchive(latestSnapshot, sourceUrls)) {
        const archived = await archiveImagesOutsideMutation(latestSnapshot, sourceUrls);
        const merged = await withDataStoreMutation((latestData) => {
          const log = findLogById(latestData, snapshot.id);
          return log ? mergeArchivedImages(log, archived) : false;
        });
        if (!merged) deleteStoredImageFiles(archived);
        changed = true;
      }
    } catch (error) {
      await withDataStoreMutation((latestData) => {
        const log = findLogById(latestData, snapshot.id);
        if (log) scheduleRefreshBackoff(log, error?.message || String(error));
      });
      changed = true;
    }
  }

  return changed;
}

module.exports = {
  replaceTaskJsonImageUrls,
  findTaskLocation,
  findSpendLogByTaskId,
  findLogById,
  findSnapshotLog,
  getLogTotalMultiplier,
  getLogMinimumChargeMicros,
  getSettlementPricingSnapshot,
  applyActualCostSettlement,
  applyProviderCostSettlement,
  applyTaskJsonToLog,
  markStaleSubmittingUnknown,
  closeSubmissionUnknownWithRefund,
  logNeedsUpstreamRefresh,

  logNeedsRefresh,
  parseRetryAfterMs,
  getPollBackoffMs,
  scheduleRefreshBackoff,
  needsTerminalSettlementBackoff,
  requestTaskDeduped,
  archiveImagesOutsideMutation,
  mergeArchivedImages,
  refreshLogsFromUpstream
};
