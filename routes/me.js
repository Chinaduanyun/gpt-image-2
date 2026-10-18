const { sendJson } = require('../lib/http-utils');
const { taskWorkspace } = require('../lib/task-workspace');
const { loadApiMarketConfig } = require('../lib/api-market-config');
const { loadDataStore, withDataStoreMutation } = require('../lib/store');
const { requireSession, sendAuthError, publicUser, setSessionCookie } = require('../lib/auth');
const { decodePathPart } = require('../lib/common');
const { refreshLogsFromUpstream, markStaleSubmittingUnknown } = require('../lib/spend-logs');
const { canPermanentlyDeleteAssets, completeAssetDeletion } = require('../lib/image-assets');
const { batchDto, getBatchLogs, neutralizeSubmitEcho } = require('./api-market');

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

  if (pathname === '/api/me/tasks' && req.method === 'GET') {
    await withDataStoreMutation((latestData) => markStaleSubmittingUnknown(latestData));
    sendJson(res, 200, taskWorkspace(loadDataStore(), auth.email));
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
    // Recheck authorization and eligibility in the queue, not against a snapshot
    // taken before another mutation (logout, disablement or task state change).
    const tombstoned = await withDataStoreMutation((latest) => {
      const latestAuth = requireSession(req, latest);
      if (!latestAuth.ok) return { auth: latestAuth };
      const logs = collectDeletableGenerationLogs(latest, latestAuth.email, id);
      if (!logs.length) return { notFound: true };
      if (logs.some((log) => !canPermanentlyDeleteAssets(log))) return { conflict: true };
      for (const log of logs) {
        log.assetsDeletedAt = log.assetsDeletedAt || new Date().toISOString();
        log.remoteImageUrls = []; log.imageUrls = []; log.assetDeletionStatus = 'pending';
        neutralizeSubmitEcho(log);
        delete log.imageSaveErrors;
      }
      return { ids: logs.map((log) => log.id) };
    });
    if (tombstoned.auth) { sendAuthError(res, tombstoned.auth); return; }
    if (tombstoned.notFound) { sendJson(res, 404, { error: { message: '作品不存在。' } }); return; }
    if (tombstoned.conflict) { sendJson(res, 409, { error: { message: '仅已结算的终态任务可以永久删除资产。' } }); return; }
    try {
      const result = await withDataStoreMutation((latest) => {
        const latestAuth = requireSession(req, latest);
        if (!latestAuth.ok) return { auth: latestAuth };
        const logs = latest.spendLogs.filter((log) => tombstoned.ids.includes(log.id) && log.email === latestAuth.email);
        if (logs.length !== tombstoned.ids.length) throw new Error('作品已变更。');
        if (logs.some((log) => require('../lib/image-task-runner').isTaskActive(log.id))) return { pending: true };
        completeAssetDeletion(latest, logs);
        return {};
      });
      if (result.auth) { sendAuthError(res, result.auth); return; }
      if (result.pending) { sendJson(res, 409, { error: { message: '资产已停止访问，后台写入尚未结束，请稍后重试永久删除。' } }); return; }
    } catch {
      sendJson(res, 500, { error: { message: '资产尚未删除干净，请重试永久删除；未标记为已完成。' } });
      return;
    }
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
      if (!standaloneUnknown && logs.some((log) => !canPermanentlyDeleteAssets(log))) {
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
