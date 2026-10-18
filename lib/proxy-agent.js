const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { REQUEST_TIMEOUT_MS } = require('./constants');
const { isPublicImageAddress } = require('./public-image-target');

const PROXY_HEADER_LIMIT_BYTES = 32 * 1024;

function getProxyEnvValue() {
  return process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || '';
}

function getProxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return '';
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function createProxyTlsSocket(proxyEnvValue, options, callback, targetAddress) {
  if (targetAddress !== undefined && !isPublicImageAddress(targetAddress)) {
    callback(new Error('禁止内网或特殊地址图片下载。'));
    return;
  }
  let proxyUrl;

  try {
    proxyUrl = new URL(proxyEnvValue);
  } catch {
    callback(new Error('代理环境变量不是有效 URL。'));
    return;
  }

  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    callback(new Error('当前仅支持 HTTP/HTTPS 出站代理。'));
    return;
  }

  const targetHost = options.hostname || options.host;
  const targetPort = Number(options.port) || 443;
  const connectHost = targetAddress || targetHost;
  const connectAuthority = `${net.isIP(connectHost) === 6 ? `[${connectHost}]` : connectHost}:${targetPort}`;
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
  const connectOptions = {
    host: proxyUrl.hostname,
    port: proxyPort,
    servername: proxyUrl.protocol === 'https:' ? proxyUrl.hostname : undefined
  };
  let proxySocket;
  let tlsSocket;
  let buffered = Buffer.alloc(0);
  let settled = false;
  const deadline = setTimeout(onTimeout, REQUEST_TIMEOUT_MS);
  deadline.unref?.();

  function cleanup() {
    clearTimeout(deadline);
    if (proxySocket) {
      proxySocket.setTimeout(0);
      proxySocket.removeListener('timeout', onTimeout);
      proxySocket.removeListener('connect', onConnect);
      proxySocket.removeListener('secureConnect', onConnect);
      proxySocket.removeListener('data', onData);
      proxySocket.removeListener('error', fail);
      proxySocket.removeListener('end', onClose);
      proxySocket.removeListener('close', onClose);
    }
    if (tlsSocket) {
      tlsSocket.removeListener('secureConnect', onSecureConnect);
      tlsSocket.removeListener('error', fail);
      tlsSocket.removeListener('end', onClose);
      tlsSocket.removeListener('close', onClose);
    }
    buffered = Buffer.alloc(0);
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    cleanup();
    tlsSocket?.destroy();
    proxySocket?.destroy();
    callback(error);
  }

  function onTimeout() { fail(new Error('代理连接超时。')); }
  function onClose() { fail(new Error('代理连接中断。')); }
  function onSecureConnect() {
    if (settled) return;
    settled = true;
    cleanup();
    callback(null, tlsSocket);
  }

  function onConnect() {
    if (settled) return;
    try {
      const headers = [
        `CONNECT ${connectAuthority} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Connection: close'
      ];
      const proxyAuthorization = getProxyAuthorization(proxyUrl);
      if (proxyAuthorization) headers.push(`Proxy-Authorization: ${proxyAuthorization}`);
      proxySocket.write(`${headers.join('\r\n')}\r\n\r\n`);
    } catch (error) { fail(error); }
  }

  function onData(chunk) {
    if (settled) return;
    // Reject before concatenation: even one huge unterminated header is bounded.
    if (buffered.length + chunk.length > PROXY_HEADER_LIMIT_BYTES) {
      fail(new Error('代理 CONNECT 响应头过大。'));
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffered.subarray(0, headerEnd).toString('utf8');
    const statusCode = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1]);
    proxySocket.removeListener('data', onData);
    buffered = Buffer.alloc(0);

    if (statusCode !== 200) {
      fail(new Error(`代理 CONNECT 失败：HTTP ${statusCode || 'unknown'}`));
      return;
    }

    try {
      tlsSocket = tls.connect({ socket: proxySocket, servername: targetHost });
      tlsSocket.once('secureConnect', onSecureConnect);
      tlsSocket.once('error', fail);
      tlsSocket.once('end', onClose);
      tlsSocket.once('close', onClose);
    } catch (error) { fail(error); }
  }

  try {
    proxySocket = proxyUrl.protocol === 'https:'
      ? tls.connect(connectOptions)
      : net.connect(connectOptions);
    proxySocket.setTimeout(REQUEST_TIMEOUT_MS, onTimeout);
    proxySocket.once('error', fail);
    proxySocket.once('end', onClose);
    proxySocket.once('close', onClose);
    proxySocket.on('data', onData);
    proxySocket.once(proxyUrl.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
  } catch (error) { fail(error); }

  // Until callback hands off the socket, https.Agent does not own it.
  return () => fail(new Error('代理连接已取消。'));
}

function createProxyAgent(proxyEnvValue, targetAddress) {
  const agent = new https.Agent({ keepAlive: false });
  const pending = new Set();
  agent.createConnection = (options, callback) => {
    let finished = false;
    let cancel;
    cancel = createProxyTlsSocket(proxyEnvValue, options, (error, socket) => {
      finished = true;
      pending.delete(cancel);
      callback(error, socket);
    }, targetAddress);
    if (!finished) pending.add(cancel);
  };
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => {
    for (const cancel of pending) cancel();
    destroy();
  };
  return agent;
}

module.exports = {
  getProxyEnvValue,
  getProxyAuthorization,
  createProxyTlsSocket,
  createProxyAgent
};
