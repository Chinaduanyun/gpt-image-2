const { sendJson } = require('../lib/http-utils');
const { loadApiMarketConfig } = require('../lib/api-market-config');
const { loadDataStore, withDataStoreMutation } = require('../lib/store');
const { requireSession, sendAuthError, publicUser, setSessionCookie } = require('../lib/auth');
const { decodePathPart } = require('../lib/common');
const { refreshLogsFromUpstream, markStaleSubmittingUnknown } = require('../lib/spend-logs');
const { deleteStoredImageFiles } = require('../lib/image-store');
const { batchDto, getBatchLogs } = require('./api-market');

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
    .filter((log) => log.email === email && log.hiddenFromHistory !== true);
  return groupHistoryLogs(logs).slice(offset, offset + limit);
}

function getRefreshLogsForHistoryItems(data, items) {
  const logs = [];
  for (const item of items) {
    if (item.kind === 'batch' && item.batchId) logs.push(...getBatchLogs(data, item.batchId));
    else if (item.type === 'generation') logs.push(item);
  }
  return logs;
}

async function handleMe(req, res, pathname, url) {
  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    setSessionCookie(res, auth.token);
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

  const deleteMatch = pathname.match(/^\/api\/me\/logs\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const logId = decodePathPart(deleteMatch[1]);
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireSession(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };

      const direct = latestData.spendLogs.find((entry) => entry.id === logId && entry.email === latestAuth.email && entry.type === 'generation');
      const batchId = direct?.batchId || logId;
      const logs = direct?.batchId
        ? latestData.spendLogs.filter((entry) => entry.type === 'generation' && entry.email === latestAuth.email && entry.batchId === batchId)
        : (direct ? [direct] : latestData.spendLogs.filter((entry) => entry.type === 'generation' && entry.email === latestAuth.email && entry.batchId === batchId));
      if (!logs.length) return { notFound: true };
      if (logs.every((log) => log.hiddenFromHistory === true && log.cleanupStatus === 'cleanupComplete')) return { alreadyComplete: true };
      if (logs.some((log) => log.settled !== true || !TERMINAL_GENERATION_STATUSES.has(String(log.status || '').toLowerCase()))) {
        return { conflict: true };
      }
      const timestamp = new Date().toISOString();
      for (const log of logs) {
        log.hiddenFromHistory = true;
        log.deletedAt = log.deletedAt || timestamp;
        log.cleanupStatus = 'cleanupPending';
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
      sendJson(res, 409, { error: { message: '进行中或账务未结清的生成记录不能删除。' } });
      return;
    }
    if (result.alreadyComplete) {
      sendJson(res, 200, { ok: true, cleanupStatus: 'cleanupComplete' });
      return;
    }

    try {
      deleteStoredImageFiles(result.logs);
    } catch {
      sendJson(res, 500, { error: { message: '生成历史已隐藏，但图片文件清理失败，可再次删除重试。' } });
      return;
    }
    await withDataStoreMutation((latestData) => {
      const latestAuth = requireSession(req, latestData);
      if (!latestAuth.ok) return;
      const direct = latestData.spendLogs.find((entry) => entry.id === logId && entry.email === latestAuth.email && entry.type === 'generation');
      const batchId = direct?.batchId || logId;
      const logs = direct?.batchId
        ? latestData.spendLogs.filter((entry) => entry.type === 'generation' && entry.email === latestAuth.email && entry.batchId === batchId)
        : (direct ? [direct] : latestData.spendLogs.filter((entry) => entry.type === 'generation' && entry.email === latestAuth.email && entry.batchId === batchId));
      const timestamp = new Date().toISOString();
      for (const log of logs) {
        if (log.hiddenFromHistory === true) {
          log.cleanupStatus = 'cleanupComplete';
          log.cleanupCompletedAt = timestamp;
        }
      }
    });
    sendJson(res, 200, { ok: true, cleanupStatus: 'cleanupComplete' });
    return;
  }

  sendJson(res, 404, { error: { message: '不支持的用户接口。' } });
}

module.exports = {
  getLogsForEmail,
  handleMe
};
