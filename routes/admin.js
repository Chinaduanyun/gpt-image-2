const { normalizeEmail, nowIso, createId, decodePathPart } = require('../lib/common');
const { sendJson, readJsonBody } = require('../lib/http-utils');
const { loadApiMarketConfig } = require('../lib/api-market-config');
const { loadDataStore, withDataStoreMutation } = require('../lib/store');
const { requireAdmin, sendAuthError, publicUser } = require('../lib/auth');
const { parseMoneyToMicros } = require('../lib/pricing');
const { refreshLogsFromUpstream, markStaleSubmittingUnknown, closeSubmissionUnknownWithRefund } = require('../lib/spend-logs');


// Resolve a ledger amount from either the *Micros integer field or the *Usd field
// (parsed via parseMoneyToMicros). Any amount that enters the ledger must be a safe
// integer; NaN / Infinity / floats / oversized values are rejected instead of being
// silently swallowed by `|| 0`. Returns { ok, micros, provided }.
function resolveLedgerMicros(body, microsKey, usdKey) {
  if (body[microsKey] !== undefined) {
    const micros = Number(body[microsKey]);
    if (!Number.isSafeInteger(micros)) return { ok: false };
    return { ok: true, micros, provided: true };
  }
  if (body[usdKey] !== undefined) {
    const micros = parseMoneyToMicros(body[usdKey]);
    if (!Number.isSafeInteger(micros)) return { ok: false };
    return { ok: true, micros, provided: true };
  }
  return { ok: true, micros: 0, provided: false };
}

const INVALID_AMOUNT_MESSAGE = '金额无效：必须是安全整数 micros，或可解析且不溢出的金额。';

async function handleAdmin(req, res, pathname, url) {
  const data = loadDataStore();
  const auth = requireAdmin(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const users = Object.values(data.users).map(publicUser).sort((a, b) => a.email.localeCompare(b.email));
    sendJson(res, 200, { users });
    return;
  }

  if (pathname === '/api/admin/users' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    if (!email) {
      sendJson(res, 400, { error: { message: '请输入用户邮箱。' } });
      return;
    }
    const initialBalance = resolveLedgerMicros(body, 'balanceMicros', 'balanceUsd');
    if (!initialBalance.ok) {
      sendJson(res, 400, { error: { message: INVALID_AMOUNT_MESSAGE } });
      return;
    }
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireAdmin(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };
      if (latestData.users[email]) return { conflict: true };

      const timestamp = nowIso();
      const balanceMicros = Math.max(0, initialBalance.micros);
      latestData.users[email] = {
        email,
        name: String(body.name || '').trim(),
        active: body.active !== false,
        isAdmin: false,
        balanceMicros,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      latestData.spendLogs.push({
        id: createId('admin'),
        type: 'balance_adjustment',
        email,
        adminEmail: latestAuth.email,
        deltaMicros: balanceMicros,
        reason: '初始额度',
        createdAt: timestamp
      });
      return { user: publicUser(latestData.users[email]) };
    });
    if (result.auth) {
      sendAuthError(res, result.auth);
      return;
    }
    if (result.conflict) {
      sendJson(res, 409, { error: { message: '用户已存在。' } });
      return;
    }
    sendJson(res, 201, { user: result.user });
    return;
  }

  if (pathname === '/api/admin/spend-logs' && req.method === 'GET') {
    const email = normalizeEmail(url.searchParams.get('email'));
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    await withDataStoreMutation((latestData) => markStaleSubmittingUnknown(latestData));
    const refreshData = loadDataStore();
    let logs = refreshData.spendLogs.slice().reverse();
    if (email) logs = logs.filter((log) => log.email === email);
    await refreshLogsFromUpstream(refreshData, logs.slice(offset, offset + limit), loadApiMarketConfig());
    const refreshedData = loadDataStore();
    logs = refreshedData.spendLogs.slice().reverse();
    if (email) logs = logs.filter((log) => log.email === email);
    sendJson(res, 200, { logs: logs.slice(offset, offset + limit) });
    return;
  }

  const refundMatch = pathname.match(/^\/api\/admin\/spend-logs\/([^/]+)\/refund-and-close$/);
  if (refundMatch && req.method === 'POST') {
    const logId = decodePathPart(refundMatch[1]);
    const body = await readJsonBody(req);
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireAdmin(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };
      const log = latestData.spendLogs.find((entry) => entry.id === logId);
      if (!log) return { notFound: true };
      const resolution = closeSubmissionUnknownWithRefund(latestData, log, latestAuth.email, body.reason);
      if (!resolution.ok) {
        if (log.resolution?.action === 'admin_refund_and_close') {
          return { log: { ...log }, refundMicros: Number(log.resolution.refundMicros) || 0, idempotent: true };
        }
        return { conflict: true };
      }
      latestData.spendLogs.push({

        id: createId('admin'), type: 'admin_refund_and_close', email: log.email, adminEmail: latestAuth.email,
        targetLogId: log.id, refundMicros: resolution.refundMicros, reason: String(body.reason || '').trim(),
        balanceBeforeMicros: resolution.balanceBeforeMicros, balanceAfterMicros: resolution.balanceAfterMicros,
        createdAt: resolution.timestamp
      });
      return { log: { ...log }, refundMicros: resolution.refundMicros };
    });
    if (result.auth) { sendAuthError(res, result.auth); return; }
    if (result.notFound) { sendJson(res, 404, { error: { message: '记录不存在。' } }); return; }
    if (result.conflict) {
      sendJson(res, 409, { error: { message: '仅可退款并关闭未确认提交记录。' } });

      return;
    }
    sendJson(res, 200, { log: result.log, refundMicros: result.refundMicros });
    return;
  }


  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(balance))?$/);
  if (userMatch && !userMatch[2] && req.method === 'PATCH') {
    const email = normalizeEmail(decodePathPart(userMatch[1]));
    const body = await readJsonBody(req);
    const balanceOverride = resolveLedgerMicros(body, 'balanceMicros', 'balanceUsd');
    if (!balanceOverride.ok) {
      sendJson(res, 400, { error: { message: INVALID_AMOUNT_MESSAGE } });
      return;
    }
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireAdmin(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };
      const target = latestData.users[email];
      if (!target) return { notFound: true };

      if (body.name !== undefined) target.name = String(body.name || '').trim();
      if (body.active !== undefined) target.active = body.active === true;
      if (balanceOverride.provided) {
        // Direct balance overwrite: record an auditable balance_adjustment so there is
        // no traceless way to change the ledger.
        const before = Number(target.balanceMicros) || 0;
        const after = Math.max(0, balanceOverride.micros);
        target.balanceMicros = after;
        latestData.spendLogs.push({
          id: createId('admin'),
          type: 'balance_adjustment',
          email,
          adminEmail: latestAuth.email,
          deltaMicros: after - before,
          reason: '管理员直接设置余额',
          balanceBeforeMicros: before,
          balanceAfterMicros: after,
          createdAt: nowIso()
        });
      }
      target.updatedAt = nowIso();
      return { user: publicUser(target) };
    });
    if (result.auth) {
      sendAuthError(res, result.auth);
      return;
    }
    if (result.notFound) {
      sendJson(res, 404, { error: { message: '用户不存在。' } });
      return;
    }
    sendJson(res, 200, { user: result.user });
    return;
  }

  if (userMatch && userMatch[2] === 'balance' && req.method === 'POST') {
    const email = normalizeEmail(decodePathPart(userMatch[1]));
    const body = await readJsonBody(req);
    const delta = resolveLedgerMicros(body, 'deltaMicros', 'deltaUsd');
    if (!delta.ok) {
      sendJson(res, 400, { error: { message: INVALID_AMOUNT_MESSAGE } });
      return;
    }
    const deltaMicros = delta.micros;
    const result = await withDataStoreMutation((latestData) => {
      const latestAuth = requireAdmin(req, latestData);
      if (!latestAuth.ok) return { auth: latestAuth };
      const target = latestData.users[email];
      if (!target) return { notFound: true };

      const before = Number(target.balanceMicros) || 0;
      target.balanceMicros = Math.max(0, before + deltaMicros);
      target.updatedAt = nowIso();
      latestData.spendLogs.push({
        id: createId('admin'),
        type: 'balance_adjustment',
        email,
        adminEmail: latestAuth.email,
        deltaMicros,
        reason: String(body.reason || '').trim(),
        balanceBeforeMicros: before,
        balanceAfterMicros: target.balanceMicros,
        createdAt: nowIso()
      });
      return { user: publicUser(target) };
    });
    if (result.auth) {
      sendAuthError(res, result.auth);
      return;
    }
    if (result.notFound) {
      sendJson(res, 404, { error: { message: '用户不存在。' } });
      return;
    }
    sendJson(res, 200, { user: result.user });
    return;
  }

  if (userMatch && !data.users[normalizeEmail(decodePathPart(userMatch[1]))]) {
    sendJson(res, 404, { error: { message: '用户不存在。' } });
    return;
  }

  sendJson(res, 404, { error: { message: '不支持的管理员接口。' } });
}

module.exports = {
  handleAdmin
};
