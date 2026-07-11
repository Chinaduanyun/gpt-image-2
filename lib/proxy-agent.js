const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { REQUEST_TIMEOUT_MS } = require('./constants');

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

function createProxyTlsSocket(proxyEnvValue, options, callback) {
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
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
  const connectOptions = {
    host: proxyUrl.hostname,
    port: proxyPort,
    servername: proxyUrl.protocol === 'https:' ? proxyUrl.hostname : undefined
  };
  const proxySocket = proxyUrl.protocol === 'https:'
    ? tls.connect(connectOptions)
    : net.connect(connectOptions);

  let buffered = Buffer.alloc(0);
  let settled = false;

  function fail(error) {
    if (settled) return;
    settled = true;
    proxySocket.destroy();
    callback(error);
  }

  function onConnect() {
    const headers = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      'Connection: close'
    ];
    const proxyAuthorization = getProxyAuthorization(proxyUrl);
    if (proxyAuthorization) headers.push(`Proxy-Authorization: ${proxyAuthorization}`);
    proxySocket.write(`${headers.join('\r\n')}\r\n\r\n`);
  }

  function onData(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffered.subarray(0, headerEnd).toString('utf8');
    const statusCode = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1]);
    proxySocket.removeListener('data', onData);

    if (statusCode !== 200) {
      fail(new Error(`代理 CONNECT 失败：HTTP ${statusCode || 'unknown'}`));
      return;
    }

    const tlsSocket = tls.connect({ socket: proxySocket, servername: targetHost });

    tlsSocket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      callback(null, tlsSocket);
    });
    tlsSocket.once('error', fail);
  }

  proxySocket.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error('代理连接超时。')));
  proxySocket.once('error', fail);
  proxySocket.on('data', onData);

  if (proxyUrl.protocol === 'https:') {
    proxySocket.once('secureConnect', onConnect);
  } else {
    proxySocket.once('connect', onConnect);
  }
}

function createProxyAgent(proxyEnvValue) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    createProxyTlsSocket(proxyEnvValue, options, callback);
  };
  return agent;
}

module.exports = {
  getProxyEnvValue,
  getProxyAuthorization,
  createProxyTlsSocket,
  createProxyAgent
};
