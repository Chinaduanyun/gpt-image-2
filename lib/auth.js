const crypto = require('node:crypto');
const { SESSION_TTL_MS } = require('./constants');
const { normalizeEmail, nowIso } = require('./common');
const { formatMoneyMicros } = require('./pricing');
const { sendJson } = require('./http-utils');

function publicUser(user) {
  return {
    email: user.email,
    name: user.name || '',
    active: user.active !== false,
    isAdmin: user.isAdmin === true,
    balanceMicros: Number(user.balanceMicros) || 0,
    balanceText: formatMoneyMicros(user.balanceMicros),
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || ''
  };
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    // Malformed percent-encoding must not throw and 500/502 the whole request;
    // fall back to the raw value.
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function isSecureRequest(req) {
  return req?.headers?.['x-forwarded-proto'] === 'https' || Boolean(req?.socket?.encrypted);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || parseCookies(req).imageGenToken || '';
}

function setSessionCookie(res, token, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `imageGenToken=${encodeURIComponent(token)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; SameSite=Lax; HttpOnly${secure}`);
}

function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `imageGenToken=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure}`);
}

function createSession(data, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = nowIso();
  data.sessions[token] = {
    email,
    createdAt,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  return token;
}

function requireSession(req, data) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: '请先登录。' };
  const session = data.sessions[token];
  if (!session) return { ok: false, status: 401, error: '登录已失效，请重新登录。' };
  if (Date.parse(session.expiresAt) <= Date.now()) {
    delete data.sessions[token];
    return { ok: false, status: 401, error: '登录已过期，请重新登录。' };
  }
  const email = normalizeEmail(session.email);
  const user = data.users[email];
  if (!user || user.active === false) return { ok: false, status: 403, error: '用户不存在或已被禁用。' };
  return { ok: true, token, session, email, user };
}

function requireAdmin(req, data) {
  const auth = requireSession(req, data);
  if (!auth.ok) return auth;
  if (auth.user.isAdmin !== true) return { ok: false, status: 403, error: '需要管理员权限。' };
  return auth;
}

function sendAuthError(res, auth) {
  sendJson(res, auth.status || 401, { error: { message: auth.error || '未授权。' } });
}

module.exports = {
  publicUser,
  parseCookies,
  isSecureRequest,
  getBearerToken,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  requireSession,
  requireAdmin,
  sendAuthError
};
