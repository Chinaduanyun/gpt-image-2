const { normalizeEmail } = require('../lib/common');
const { sendJson, readJsonBody } = require('../lib/http-utils');
const { withDataStoreMutation } = require('../lib/store');
const { publicUser, createSession, setSessionCookie, getBearerToken, clearSessionCookie } = require('../lib/auth');

async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  if (!email) {
    sendJson(res, 400, { error: { message: '请输入邮箱。' } });
    return;
  }

  const result = await withDataStoreMutation((data) => {
    const user = data.users[email];
    if (!user || user.active === false) {
      return { status: 401, error: '邮箱未在允许访问列表中。' };
    }

    const token = createSession(data, email);
    return { status: 200, token, user: publicUser(user) };
  });
  if (result.error) {
    sendJson(res, result.status, { error: { message: result.error } });
    return;
  }

  setSessionCookie(res, result.token, req);
  sendJson(res, 200, { token: result.token, user: result.user });
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  const token = getBearerToken(req);
  if (token) {
    await withDataStoreMutation((data) => {
      delete data.sessions[token];
    });
  }
  clearSessionCookie(res, req);
  sendJson(res, 200, { ok: true });
}

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/login') {
    await handleLogin(req, res);
    return;
  }
  if (pathname === '/api/auth/logout') {
    await handleLogout(req, res);
    return;
  }
  sendJson(res, 404, { error: { message: '不支持的认证接口。' } });
}

module.exports = {
  handleLogin,
  handleLogout,
  handleAuth
};
