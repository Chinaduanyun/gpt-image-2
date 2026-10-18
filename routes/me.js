const { sendJson } = require('../lib/http-utils');
const { loadApiMarketConfig } = require('../lib/api-market-config');
const { loadDataStore, withDataStoreMutation } = require('../lib/store');
const { requireSession, sendAuthError, publicUser, setSessionCookie } = require('../lib/auth');
const { decodePathPart } = require('../lib/common');
const { refreshLogsFromUpstream, markStaleSubmittingUnknown } = require('../lib/spend-logs');
const { purgeStoredImageFiles } = require('../lib/image-store');
const { removePendingResultSpool } = require('../lib/image-assets');
const { batchDto, getBatchLogs, neutralizeSubmitEcho } = require('./api-market');

const TERMINAL_GENERATION_STATUSES = new Set([
  'completed', 'succeeded', 'success', 'failed', 'cancelled', 'error', 'submit_failed_refunded', 'submission_refunded_closed'

]);

function groupHistoryLogs(logs) {
  const output = [];
  const batches = new Map();
  for (const log of logs) {
    if (log.type === 'generation' && log.batchId) {
      if (!batches.has(log.batchId)) batches.set(log.batchId, []);
      batches.get(log.batchId).push(log);
    } else {
      output.push(log);
    }
  }
  for (const members of batches.values()) output.push(batchDto(members));
  return output.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
}

function getLogsForEmail(data, email, limit = 50, offset = 0) {
  const logs = data.spendLogs
    .filter((log) => log.type === 'generation' && log.email === email && log.hiddenFromHistory !== true);
  return groupHistoryLogs(logs).slice(offset, offset + limit).map(require('../lib/image-task-runner').publicLog);
}

function getRefreshLogsForHistoryItems(data, items) {
  const logs = [];
  for (const item of items) {
    if (item.kind === 'batch' && item.batchId) logs.push(...getBatchLogs(data, item.batchId));
    else if (item.type === 'generation') logs.push(item);
  }
  return logs;
}

// Resolve the generation logs a DELETE targets: a standalone generation by id, or all
// members of the batch (whether logId is a batch member's id or the batchId itself).
function collectDeletableGenerationLogs(data, email, logId) {
  const direct = data.spendLogs.find((entry) => entry.id === logId && entry.email === email && entry.type === 'generation');
  if (direct && !direct.batchId) return [direct];
  const batchId = direct?.batchId || logId;
  return data.spendLogs.filter((entry) => entry.type === 'generation' && entry.email === email && entry.batchId === batchId);
}

async function handleMe(req, res, pathname, url) {
  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    setSessionCookie(res, auth.token, req);
    sendJson(res, 200, { user: publicUser(auth.user) });
    return;
  }

  if (pathname === '/api/me/logs' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    await withDataStoreMutation((latestData) => markStaleSubmittingUnknown(latestData));
    const refreshData = loadDataStore();
    const logs = getLogsForEmail(refreshData, auth.email, limit, offset);
    await refreshLogsFromUpstream(refreshData, getRefreshLogsForHistoryItems(refreshData, logs), loadApiMarketConfig());
    const refreshedData = loadDataStore();
    sendJson(res, 200, { logs: getLogsForEmail(refreshedData, auth.email, limit, offset) });
    return;
  }

  const assetMatch = pathname.match(/^\/api\/me\/logs\/([^/]+)\/assets$/);
  if (assetMatch && req.method === 'DELETE') {
    if (req.headers['x-confirm-delete'] !== 'permanent') { sendJson(res, 400, { error: { message: '需要明确永久删除确认。' } }); return; }
    const id = decodePathPart(assetMatch[1]);
    const logs = collectDeletableGenerationLogs(loadDataStore(), auth.email, id);
    if (!logs.length) { sendJson(res, 404, { error: { message: '作品不存在。' } }); return; }
    if (logs.some((log) => log.settled !== true || !TERMINAL_GENERATION_STATUSES.has(String(log.status || '').toLowerCase()))) { sendJson(res, 409, { error: { message: '仅已结算的终态任务可以永久删除资产。' } }); return; }
    // Phase 1 tombstones every image address at once, so no reader can serve a URL
    // while phase 2 is still unlinking bytes. Financial identity (settled, charged,
    // balances, price detail) is deliberately preserved.
    await withDataStoreMutation((latest) => {
      for (const log of collectDeletableGenerationLogs(latest, auth.email, id)) {
        log.assetsDeletedAt = log.assetsDeletedAt || new Date().toISOString();
        log.remoteImageUrls = []; log.imageUrls = []; log.assetDeletionStatus = 'pending';
        // The persisted upstream submit echo is spread verbatim by the legacy task DTO and
        // by every history/list read, so it is neutralized in this same mutation: patching
        // the read sites one by one would always leave one more path open. Its identity
        // fields survive under an address-free field for admin diagnosis.
        neutralizeSubmitEcho(log);
        delete log.imageSaveErrors;
      }
    });
    try {
      // Stored files come from the pre-tombstone snapshot: phase 1 keeps imageFiles so a
      // failure below stays retryable instead of stranding bytes with no record of them.
      const purged = purgeStoredImageFiles(logs.map((log) => ({ imageFiles: [...(log.imageFiles || []), ...(log.inputFiles || [])] })));
      if (!purged.ok) throw new Error(`资产删除失败：${purged.remaining.length} 个文件`);
      // The runner spool holds a full base64 copy of the paid result; a permanent delete
      // must clear it too or the image survives on the volume after the user deleted it.
      for (const log of logs) removePendingResultSpool(log.id);
    } catch {
      sendJson(res, 500, { error: { message: '资产尚未删除干净，请重试永久删除；未标记为已完成。' } });
      return;
    }
    await withDataStoreMutation((latest) => {
      for (const log of collectDeletableGenerationLogs(latest, auth.email, id)) {
        log.imageFiles = []; log.inputFiles = []; log.imageUrls = []; log.remoteImageUrls = [];
        log.assetDeletionStatus = 'complete';
      }
    });
    sendJson(res, 200, { ok: true }); return;
  }

  const deleteMatch = pathname.match(/^\/api\/me\/logs\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const logId = decodePathPart(deleteMatch[1]);
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireSession(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };

      const logs = collectDeletableGenerationLogs(latestData, latestAuth.email, logId);
      if (!logs.length) return { notFound: true };
      if (logs.every((log) => log.hiddenFromHistory === true && ['retained', 'cleanupComplete'].includes(log.cleanupStatus))) return { alreadyComplete: true };
      // Only standalone generation unknowns get the visibility-only exception.
      // Batch unknowns remain protected, including requests targeting a child id.
      const standaloneUnknown = logs.length === 1 && logs[0].status === 'submission_unknown'
        && !logs[0].batchId && !logs[0].batch_id;
      if (!standaloneUnknown && logs.some((log) => log.settled !== true || !TERMINAL_GENERATION_STATUSES.has(String(log.status || '').toLowerCase()))) {
        return { conflict: true };
      }
      const timestamp = new Date().toISOString();
      for (const log of logs) {
        log.hiddenFromHistory = true;
        log.deletedAt = log.deletedAt || timestamp;
        log.cleanupStatus = 'retained';
      }
      return { logs };
    });
    if (result.auth) {
      sendAuthError(res, result.auth);
      return;
    }
    if (result.notFound) {
      sendJson(res, 404, { error: { message: '生成历史不存在。' } });
      return;
    }
    if (result.conflict) {
      sendJson(res, 409, { error: { message: '进行中或账务未结清的生成记录不能隐藏（独立的提交状态未知记录除外）；批次未知记录请联系管理员核查。' } });
      return;
    }
    if (result.alreadyComplete) {
      sendJson(res, 200, { ok: true, cleanupStatus: 'cleanupComplete' });
      return;
    }

    sendJson(res, 200, { ok: true, cleanupStatus: 'retained' });
    return;
  }

  sendJson(res, 404, { error: { message: '不支持的用户接口。' } });
}

module.exports = {
  getLogsForEmail,
  handleMe
};
