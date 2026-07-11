const http = require('node:http');
const { HOST, PORT, API_PREFIX, BACKGROUND_REFRESH_INTERVAL_MS } = require('./lib/constants');
const { sendJson } = require('./lib/http-utils');
const { initializeDataStore, withDataStoreMutation } = require('./lib/store');
const { markStaleSubmittingUnknown } = require('./lib/spend-logs');
const { sanitizeErrorMessage } = require('./lib/api-market-client');
const { refreshPendingLogsInBackground } = require('./lib/background-refresh');
const { handleAuth } = require('./routes/auth');
const { handleMe } = require('./routes/me');
const { handleAdmin } = require('./routes/admin');
const { proxyApiMarket } = require('./routes/api-market');
const { handleStoredImage } = require('./routes/stored-images');
const { handlePublicConfig } = require('./routes/public-config');
const { serveStatic } = require('./routes/static');

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/public-config') {
    handlePublicConfig(req, res);
    return;
  }

  if (url.pathname.startsWith('/api/stored-images/')) {
    handleStoredImage(req, res, url.pathname).catch((error) => {
      const message = error.message || '图片读取失败。';
      sendJson(res, 500, { error: { message } });
    });
    return;
  }

  if (url.pathname.startsWith('/api/auth/')) {
    handleAuth(req, res, url.pathname).catch((error) => {
      const message = error instanceof SyntaxError ? '请求 JSON 格式无效。' : error.message || '认证接口请求失败。';
      sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: { message } });
    });
    return;
  }

  if (url.pathname === '/api/me' || url.pathname === '/api/me/logs' || url.pathname.startsWith('/api/me/logs/')) {
    handleMe(req, res, url.pathname, url).catch((error) => {
      const message = error instanceof SyntaxError ? '请求 JSON 格式无效。' : error.message || '用户接口请求失败。';
      sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: { message } });
    });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    handleAdmin(req, res, url.pathname, url).catch((error) => {
      const message = error instanceof SyntaxError ? '请求 JSON 格式无效。' : error.message || '管理员接口请求失败。';
      sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: { message } });
    });
    return;
  }

  if (url.pathname.startsWith(API_PREFIX)) {
    proxyApiMarket(req, res, url.pathname).catch((error) => {
      const statusCode = error instanceof SyntaxError ? 400 : 502;
      const message = error instanceof SyntaxError ? '请求 JSON 格式无效。' : sanitizeErrorMessage(error);
      sendJson(res, statusCode, { error: { message } });
    });
    return;
  }

  serveStatic(req, res, url.pathname);
});

async function startServer() {
  await initializeDataStore();
  await withDataStoreMutation((data) => markStaleSubmittingUnknown(data, Date.now(), 0, true));
  const backgroundRefreshTimer = setInterval(refreshPendingLogsInBackground, BACKGROUND_REFRESH_INTERVAL_MS);
  backgroundRefreshTimer.unref?.();
  refreshPendingLogsInBackground();
  server.listen(PORT, HOST, () => {
    console.log(`Local server listening at http://${HOST}:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error(`Server initialization failed: ${error.message}`);
  process.exitCode = 1;
});
