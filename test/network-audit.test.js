const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { downloadExternalFile } = require('../lib/image-store');
const { isPublicImageAddress } = require('../lib/public-image-target');
const { requestApiMarket } = require('../lib/api-market-client');
const { createProxyTlsSocket, createProxyAgent } = require('../lib/proxy-agent');
const { generateCpa } = require('../lib/cpa-image');
const { REQUEST_TIMEOUT_MS, IMAGE_DOWNLOAD_LIMIT_BYTES } = require('../lib/constants');

const PUBLIC = { address: '8.8.8.8', family: 4 };
const CONFIG = { baseUrl: 'https://market.example', apiKey: 'test-only' };
function response(status = 200, headers = {}) {
  const res = new PassThrough();
  res.statusCode = status; res.headers = headers;
  return res;
}
function request() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  req.setTimeout = () => req;
  req.write = () => true;
  return req;
}
function imageTransport(t, handler, lookup = async () => [PUBLIC]) {
  const requests = [];
  t.mock.method(dns, 'lookup', lookup);
  const get = (url, options, callback) => {
    const req = request(); requests.push({ url, options, req });
    process.nextTick(() => handler({ url, options, callback, req }));
    return req;
  };
  t.mock.method(http, 'get', get);
  t.mock.method(https, 'get', get);
  return requests;
}
function marketTransport(t, handler) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = request(); calls.push(req);
    req.end = () => handler({ options, callback, req });
    return req;
  });
  return calls;
}

test('legacy archival rejects credentials, private and special IPv4/IPv6 before transport', async (t) => {
  let connects = 0;
  imageTransport(t, () => { connects++; }, async () => { throw new Error('unexpected DNS'); });
  const blocked = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.31.1.2', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001::1', '2001:db8::1', '3fff::1', '2002:7f00:1::1'];
  for (const ip of blocked) {
    assert.equal(isPublicImageAddress(ip), false, ip);
    await assert.rejects(downloadExternalFile(`https://${ip.includes(':') ? `[${ip}]` : ip}/a`), /禁止/);
  }
  for (const url of ['https://user:pass@images.example/a', 'http://user@images.example/a', 'file:///a', 'http://[invalid/']) await assert.rejects(downloadExternalFile(url));
  assert.equal(connects, 0);
});

test('legacy archival validates every DNS answer, including mixed public/private and IPv6', async (t) => {
  let connects = 0;
  let answers;
  imageTransport(t, () => { connects++; }, async () => answers);
  for (answers of [[], [PUBLIC, { address: '127.0.0.1', family: 4 }], [PUBLIC, { address: 'fe80::1', family: 6 }], [{ address: '::ffff:10.1.1.1', family: 6 }]]) {
    await assert.rejects(downloadExternalFile('https://images.example/a'), /禁止/);
  }
  assert.equal(connects, 0);
});

test('legacy archival pins validated DNS while preserving public HTTP/HTTPS, ports and IPv6', async (t) => {
  let lookups = 0;
  const requests = imageTransport(t, ({ callback }) => { const res = response(200, { 'content-type': 'image/png' }); callback(res); res.end('ok'); }, async (_host, options) => {
    lookups++; assert.deepEqual(options, { all: true }); return [PUBLIC, { address: '1.1.1.1', family: 4 }];
  });
  for (const url of ['http://images.example:8080/a', 'https://images.example:8443/a', 'https://[2606:4700:4700::1111]:9443/a']) {
    assert.equal((await downloadExternalFile(url)).buffer.toString(), 'ok');
    const { options } = requests.at(-1);
    const pinned = await new Promise((resolve, reject) => options.lookup('ignored-rebound-host', { all: true }, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(pinned, [url.includes('2606:') ? { address: '2606:4700:4700::1111', family: 6 } : PUBLIC]);
    if (options.agent) options.agent.destroy();
  }
  assert.equal(lookups, 2, 'connection lookup must not re-resolve hostnames');
  assert.equal(requests[0].url.port, '8080');
  assert.equal(requests[1].url.port, '8443');
});

test('legacy redirect malformed location rejects normally; a subsequent relative redirect succeeds', async (t) => {
  let malformed = true;
  const requests = imageTransport(t, ({ url, callback }) => {
    const res = url.pathname === '/start' ? response(302, { location: malformed ? 'https://[invalid/' : '../done.png' }) : response(200);
    callback(res); if (!res.destroyed) res.end('image');
  });
  await assert.rejects(downloadExternalFile('http://images.example/start'), /Invalid URL/);
  assert.equal(requests.length, 1);
  malformed = false;
  assert.equal((await downloadExternalFile('http://images.example/start')).buffer.toString(), 'image');
  assert.equal(requests.at(-1).url.href, 'http://images.example/done.png');
});

test('legacy redirects reject private, credential and rebinding destinations before next connection', async (t) => {
  let location;
  let answers = 0;
  const requests = imageTransport(t, ({ callback }) => callback(response(302, { location })), async (hostname) => {
    answers++;
    return hostname === 'rebound.example' ? [PUBLIC, { address: '10.0.0.1', family: 4 }] : [PUBLIC];
  });
  for (location of ['http://127.0.0.1/internal', 'https://u:p@images.example/a', 'http://rebound.example/a']) {
    const before = requests.length;
    await assert.rejects(downloadExternalFile('http://images.example/start'), /禁止|无凭据/);
    assert.equal(requests.length, before + 1);
  }
  assert.equal(answers, 4);
});

test('legacy relative redirect revalidates DNS and cannot reuse a rebound connection', async (t) => {
  let lookups = 0;
  const requests = imageTransport(t, ({ callback }) => callback(response(302, { location: '/next' })), async () => ++lookups === 1 ? [PUBLIC] : [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(downloadExternalFile('http://images.example/start'), /禁止/);
  assert.equal(requests.length, 1);
  assert.equal(lookups, 2);
});

test('legacy redirect count remains bounded and redirect bodies are destroyed', async (t) => {
  const responses = [];
  const requests = imageTransport(t, ({ callback }) => { const res = response(302, { location: '/again' }); responses.push(res); callback(res); });
  await assert.rejects(downloadExternalFile('http://images.example/start'), /重定向/);
  assert.equal(requests.length, 4);
  assert.ok(responses.every(res => res.destroyed));
  assert.ok(requests.every(({ req }) => req.destroyed));
});

test('legacy image 50 MiB cap is unchanged and oversize destroys both streams', async (t) => {
  let oversize = false;
  let lastResponse;
  const chunk = Buffer.alloc(1024 * 1024);
  const requests = imageTransport(t, ({ callback }) => {
    const res = lastResponse = response(); callback(res);
    for (let i = 0; i < IMAGE_DOWNLOAD_LIMIT_BYTES / chunk.length; i++) res.emit('data', chunk);
    if (oversize) res.emit('data', Buffer.from('x')); else res.emit('end');
  });
  assert.equal((await downloadExternalFile('http://images.example/a')).buffer.length, IMAGE_DOWNLOAD_LIMIT_BYTES);
  oversize = true;
  await assert.rejects(downloadExternalFile('http://images.example/a'), /过大/);
  assert.ok(lastResponse.destroyed);
  assert.ok(requests.at(-1).req.destroyed);
});

for (const pinned of [undefined, '8.8.8.8', '2606:4700:4700::1111']) test(`HTTPS proxy CONNECT pins ${pinned || 'default hostname'} but keeps original TLS identity`, async (t) => {
  const raw = request(); const secure = request();
  let written = ''; let tlsOptions;
  raw.write = (text) => { written = text; };
  t.mock.method(net, 'connect', (options) => { assert.equal(options.host, 'proxy.example'); process.nextTick(() => raw.emit('connect')); return raw; });
  t.mock.method(tls, 'connect', (options) => { tlsOptions = options; process.nextTick(() => secure.emit('secureConnect')); return secure; });
  const agent = createProxyAgent('http://proxy.example:8080', pinned);
  const pending = new Promise((resolve, reject) => agent.createConnection({ host: 'images.example', port: 8443 }, (error, socket) => error ? reject(error) : resolve(socket)));
  await new Promise(resolve => process.nextTick(resolve));
  const authority = pinned?.includes(':') ? `[${pinned}]` : pinned || 'images.example';
  assert.match(written, new RegExp(`^CONNECT ${authority.replace(/[\[\]]/g, '\\$&')}:8443 HTTP/1.1`));
  assert.match(written, /Host: images.example:8443/);
  raw.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
  assert.equal(await pending, secure);
  assert.equal(tlsOptions.servername, 'images.example');
  assert.equal(tlsOptions.socket, raw);
  agent.destroy();
});

test('unsafe pinned proxy target is rejected before proxy connection', async (t) => {
  t.mock.method(net, 'connect', () => assert.fail('must not connect'));
  t.mock.method(tls, 'connect', () => assert.fail('must not connect'));
  for (const ip of ['127.0.0.1', '::1', 'fe80::1', 'not-an-ip']) {
    await assert.rejects(new Promise((resolve, reject) => createProxyTlsSocket('http://proxy.example', { host: 'images.example' }, (error) => error ? reject(error) : resolve(), ip)), /禁止/);
  }
});

test('Market 128 MiB cap aborts an oversized response without submitting again', async (t) => {
  let res;
  const calls = marketTransport(t, ({ callback }) => {
    res = response(); callback(res);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 129; i++) res.emit('data', chunk);
  });
  await assert.rejects(requestApiMarket('POST', '/v1/images/generations', {}, '{}', CONFIG), /过大/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].destroyed);
  assert.ok(res.destroyed);
});

test('Market absolute deadline defeats a trickling body and clears timers on failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let res;
  const calls = marketTransport(t, ({ callback }) => { res = response(); callback(res); });
  const pending = requestApiMarket('POST', '/v1/images/generations', {}, '{}', CONFIG);
  const rejected = assert.rejects(pending, /超时/);
  for (let i = 0; i < 18; i++) { res.emit('data', Buffer.from(' ')); t.mock.timers.tick(10000); }
  await rejected;
  assert.ok(res.destroyed); assert.ok(calls[0].destroyed); assert.equal(calls.length, 1);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
});

test('Market normal inline-image response clears deadline, retains response metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const text = JSON.stringify({ data: [{ url: `data:image/png;base64,${'a'.repeat(1024 * 1024)}` }] });
  const calls = marketTransport(t, ({ callback }) => {
    const res = response(202, { 'content-type': 'application/json', 'retry-after': '5' }); callback(res); res.end(text);
  });
  const result = await requestApiMarket('GET', '/task', {}, null, CONFIG);
  assert.equal(result.text, text); assert.equal(result.status, 202); assert.equal(result.retryAfter, '5');
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
  assert.equal(calls[0].destroyed, false);
});

for (const event of ['error', 'aborted', 'close']) test(`Market ${event} cleans up response/request and deadline`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let res;
  const calls = marketTransport(t, ({ callback }) => { res = response(); callback(res); res.emit(event, new Error('broken response')); });
  await assert.rejects(requestApiMarket('GET', '/task', {}, null, CONFIG), /broken|中止/);
  assert.ok(res.destroyed); assert.ok(calls[0].destroyed);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
});

test('Market request construction failure clears its absolute timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(https, 'request', () => { throw new Error('local request failure'); });
  await assert.rejects(requestApiMarket('POST', '/task', {}, '{}', CONFIG), /local request failure/);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
});

for (const status of [400, 401, 500]) test(`CPA oversized HTTP ${status} error is stream-bounded and remains unknown`, async () => {
  let cancelled = false; let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } });
  let calls = 0;
  await assert.rejects(generateCpa({ prompt: 'test' }, [], { config: CONFIG, fetch: async () => {
    calls++; return new Response(body, { status });
  } }), error => error.kind === 'unknown' && /过大/.test(error.message));
  assert.equal(calls, 1); assert.ok(cancelled); assert.ok(pulls <= 2);
});

test('CPA bounded non-2xx responses retain policy/technical/unavailable classifications', async () => {
  for (const [status, text, kind] of [[400, 'invalid size', 'technical'], [401, 'unauthorized', 'unavailable'], [500, 'safety policy_violation', 'policy'], [500, 'unexpected', 'unknown']]) {
    await assert.rejects(generateCpa({ prompt: 'test' }, [], { config: CONFIG, fetch: async () => new Response(text, { status }) }), error => error.kind === kind);
  }
});

test('CPA interrupted error stream remains unknown, never a technical fallback', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('disconnect')); } });
  await assert.rejects(generateCpa({ prompt: 'test' }, [], { config: CONFIG, fetch: async () => new Response(body, { status: 400 }) }), error => error.kind === 'unknown');
});

test('real bounded Market transport failure leaves synthetic fixed-quote task unknown through recovery', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const runner = require('../lib/image-task-runner');
  const { createMarketAdapter } = require('../lib/market-image');
  const { ProviderError } = require('../lib/cpa-image');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-audit-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    const log = { id: 'network_only', type: 'generation', email: 'network@test.invalid', estimatedCostMicros: 100, chargedMicros: 100, settled: false, imageUrls: [], imageFiles: [] };
    runner.initializeHybridLog(log);
    store.saveDataStore({ version: 1, users: { [log.email]: { email: log.email, balanceMicros: 900 } }, sessions: {}, spendLogs: [log] });
    const calls = marketTransport(t, ({ callback }) => {
      const res = response(); callback(res);
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 129; i++) res.emit('data', chunk);
    });
    const adapter = createMarketAdapter(CONFIG);
    await runner.startTask(log.id, { prompt: 'synthetic only', n: 1 }, {
      cpa: async () => { throw new ProviderError('technical', 'explicit mock rejection'); }, marketAdapter: adapter
    });
    await runner.recoverTasks(true, { marketAdapter: adapter });
    const data = store.loadDataStore();
    assert.equal(data.spendLogs[0].status, 'submission_unknown');
    assert.equal(data.spendLogs[0].settled, false);
    assert.equal(data.spendLogs[0].chargedMicros, 100);
    assert.equal(data.users[log.email].balanceMicros, 900);
    assert.equal(calls.length, 1, 'no replay after an ambiguous oversized response');
  } finally {
    if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTPS proxy itself retains TLS while pinned destination keeps original SNI', async (t) => {
  const proxySocket = request(); const targetSocket = request();
  const calls = []; let written;
  proxySocket.write = value => { written = value; };
  t.mock.method(tls, 'connect', (options) => {
    calls.push(options);
    const socket = calls.length === 1 ? proxySocket : targetSocket;
    process.nextTick(() => socket.emit('secureConnect'));
    return socket;
  });
  const pending = new Promise((resolve, reject) => createProxyTlsSocket('https://proxy.example:9443', { host: 'images.example', port: 443 }, (error, socket) => error ? reject(error) : resolve(socket), PUBLIC.address));
  await new Promise(resolve => process.nextTick(resolve));
  assert.equal(calls[0].host, 'proxy.example'); assert.equal(calls[0].servername, 'proxy.example');
  assert.match(written, /^CONNECT 8\.8\.8\.8:443 HTTP\/1.1/);
  proxySocket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  assert.equal(await pending, targetSocket);
  assert.equal(calls[1].servername, 'images.example');
});

test('legacy trickle cannot exceed its absolute deadline and failure destroys both streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let res; let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const requests = imageTransport(t, ({ callback }) => { res = response(); callback(res); connected(); });
  const pending = downloadExternalFile('http://images.example/a');
  const rejected = assert.rejects(pending, /超时/);
  await ready;
  for (let i = 0; i < 18; i++) { res.emit('data', Buffer.from('x')); t.mock.timers.tick(10000); }
  await rejected;
  assert.ok(res.destroyed); assert.ok(requests[0].req.destroyed);
});

// Keep https.request and https.Agent real: sockets alone are fake, so tests cover
// the pre-callback ownership gap that mocking https.request would conceal.
function pendingProxyTransport(t, proxy = 'http://proxy.example:8080') {
  const { Duplex } = require('node:stream');
  const sockets = []; const tlsOptions = [];
  function socket() {
    const writes = [];
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback(); } });
    stream.writes = writes;
    stream.setTimeout = (ms, callback) => { stream.timeoutMs = ms; if (callback) stream.once('timeout', callback); return stream; };
    stream.setNoDelay = stream.setKeepAlive = () => stream;
    sockets.push(stream);
    return stream;
  }
  t.mock.method(net, 'connect', () => socket());
  t.mock.method(tls, 'connect', options => { tlsOptions.push(options); return socket(); });
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = proxy;
  t.after(() => {
    if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous;
    for (const stream of sockets) stream.destroy();
  });
  return { sockets, tlsOptions };
}
function assertHandshakeClean(stream) {
  assert.ok(stream.destroyed);
  for (const event of ['data', 'connect', 'secureConnect', 'timeout', 'end', 'close', 'error']) {
    assert.equal(stream.listenerCount(event), 0, `pending socket retains ${event} listener`);
  }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('real Market request absolute timeout destroys pending CONNECT and stops header consumption', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /上游请求超时/);
  const raw = sockets[0]; raw.emit('connect');
  assert.match(raw.writes[0], /^CONNECT market\.example:443/);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await rejected; await nextTurn();
  assertHandshakeClean(raw);
  raw.emit('data', Buffer.alloc(100000));
  assert.equal(sockets.length, 1, 'late proxy bytes must not start TLS');
});

test('real legacy HTTPS request deadline cancels its pinned pending CONNECT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets } = pendingProxyTransport(t);
  t.mock.method(dns, 'lookup', async () => [PUBLIC]);
  const pending = downloadExternalFile('https://images.example:8443/a');
  const rejected = assert.rejects(pending, /超时/);
  await nextTurn();
  sockets[0].emit('connect');
  assert.match(sockets[0].writes[0], /^CONNECT 8\.8\.8\.8:8443/);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await rejected; await nextTurn();
  assertHandshakeClean(sockets[0]);
});

for (const bytes of [32769, 100000]) test(`real agent rejects ${bytes}-byte CONNECT header before TLS`, async (t) => {
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /响应头过大/);
  sockets[0].emit('connect');
  sockets[0].emit('data', Buffer.alloc(bytes, 'x'));
  await rejected; await nextTurn();
  assertHandshakeClean(sockets[0]); assert.equal(sockets.length, 1);
});

test('real agent accumulative header cap accepts 32 KiB but rejects the next byte', async (t) => {
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /响应头过大/);
  const raw = sockets[0]; raw.emit('connect');
  for (let i = 0; i < 32; i++) raw.emit('data', Buffer.alloc(1024, 'x'));
  assert.equal(raw.destroyed, false);
  raw.emit('data', Buffer.from('x'));
  await rejected; await nextTurn();
  assertHandshakeClean(raw);
});

test('real agent handshake wall-clock deadline defeats CONNECT trickle without API timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets } = pendingProxyTransport(t);
  const agent = createProxyAgent(process.env.HTTPS_PROXY);
  const req = https.request('https://market.example/task', { agent });
  const rejected = assert.rejects(new Promise((resolve, reject) => req.on('error', reject)), /代理连接超时/);
  req.end();
  const raw = sockets[0]; raw.emit('connect');
  for (let i = 0; i < 18; i++) { raw.emit('data', Buffer.from('x')); t.mock.timers.tick(10000); }
  await rejected; await nextTurn();
  assertHandshakeClean(raw); agent.destroy();
});

for (const stage of ['tcp', 'connect', 'proxy-tls', 'target-tls']) test(`real agent destruction cancels pending ${stage} and clears handshake resources`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets, tlsOptions } = pendingProxyTransport(t, stage === 'proxy-tls' ? 'https://proxy.example:9443' : undefined);
  const agent = createProxyAgent(process.env.HTTPS_PROXY, PUBLIC.address);
  const req = https.request('https://images.example:8443/a', { agent });
  let errors = 0; req.on('error', () => errors++);
  const rejected = assert.rejects(new Promise((resolve, reject) => req.on('error', reject)), /已取消/);
  req.end();
  if (stage === 'connect' || stage === 'target-tls') sockets[0].emit('connect');
  if (stage === 'target-tls') {
    sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    assert.equal(tlsOptions[0].servername, 'images.example');
    assert.equal(sockets.length, 2);
  }
  req.destroy(); // Does not own the socket yet; explicit agent cleanup must cancel it.
  agent.destroy();
  await rejected; await nextTurn();
  for (const stream of sockets) assertHandshakeClean(stream);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
  for (const stream of sockets) stream.emit('secureConnect');
  await nextTurn(); assert.equal(errors, 1);
});

for (const proxyTls of [false, true]) test(`real Market deadline cancels pending ${proxyTls ? 'proxy' : 'target'} TLS handshake`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets, tlsOptions } = pendingProxyTransport(t, proxyTls ? 'https://proxy.example:9443' : undefined);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /上游请求超时/);
  if (!proxyTls) {
    sockets[0].emit('connect'); sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
    assert.equal(tlsOptions[0].servername, 'market.example');
  }
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await rejected; await nextTurn();
  for (const stream of sockets) assertHandshakeClean(stream);
});

for (const event of ['end', 'close', 'error']) test(`real agent pending CONNECT ${event} cleans up immediately`, async (t) => {
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /中断|broken proxy/);
  sockets[0].emit(event, new Error('broken proxy'));
  await rejected; await nextTurn(); assertHandshakeClean(sockets[0]);
});

test('real HTTPS success clears handshake deadline and keeps original hostname with pinned CONNECT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets, tlsOptions } = pendingProxyTransport(t);
  t.mock.method(dns, 'lookup', async () => [PUBLIC]);
  const pending = downloadExternalFile('https://images.example:8443/a');
  await nextTurn();
  const raw = sockets[0]; raw.emit('connect');
  assert.match(raw.writes[0], /^CONNECT 8\.8\.8\.8:8443/);
  raw.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  const secure = sockets[1]; assert.equal(tlsOptions[0].servername, 'images.example');
  secure.emit('secureConnect'); await nextTurn();
  assert.match(secure.writes.join(''), /Host: images\.example:8443/i);
  assert.equal(raw.timeoutMs, 0);
  assert.equal(raw.listenerCount('data'), 0);
  raw.emit('timeout'); // The old handshake inactivity timer must no longer own TLS.
  secure.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: image/png\r\nConnection: close\r\n\r\nok'));
  assert.equal((await pending).buffer.toString(), 'ok');
  t.mock.timers.tick(REQUEST_TIMEOUT_MS * 2);
  await nextTurn();
  assert.equal(raw.listenerCount('timeout'), 0);
});

for (const phase of ['write', 'tls-construction']) test(`real agent ${phase} exception tears down pending socket`, async (t) => {
  const { sockets } = pendingProxyTransport(t);
  if (phase === 'tls-construction') t.mock.method(tls, 'connect', () => { throw new Error('TLS construction failed'); });
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /construction failed|write failed/);
  if (phase === 'write') sockets[0].write = () => { throw new Error('proxy write failed'); };
  sockets[0].emit('connect');
  if (phase === 'tls-construction') sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  await rejected; await nextTurn(); assertHandshakeClean(sockets[0]);
});

test('real agent target TLS wall-clock deadline also bounds handshake after valid CONNECT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sockets } = pendingProxyTransport(t);
  const agent = createProxyAgent(process.env.HTTPS_PROXY);
  const req = https.request('https://market.example/task', { agent });
  const rejected = assert.rejects(new Promise((resolve, reject) => req.on('error', reject)), /代理连接超时/);
  req.end(); sockets[0].emit('connect');
  t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
  sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  t.mock.timers.tick(1); // CONNECT must not reset the wall-clock handshake budget.
  await rejected; await nextTurn();
  assert.equal(sockets.length, 2);
  for (const stream of sockets) assertHandshakeClean(stream);
  agent.destroy();
});

for (const event of ['error', 'end', 'close']) test(`real agent pending target TLS ${event} destroys both transports`, async (t) => {
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /中断|broken TLS/);
  sockets[0].emit('connect'); sockets[0].emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  sockets[1].emit(event, new Error('broken TLS'));
  await rejected; await nextTurn();
  for (const stream of sockets) assertHandshakeClean(stream);
});

test('real agent non-200 CONNECT rejection destroys and releases its pending transport', async (t) => {
  const { sockets } = pendingProxyTransport(t);
  const pending = requestApiMarket('GET', '/task', {}, null, CONFIG);
  const rejected = assert.rejects(pending, /CONNECT 失败：HTTP 407/);
  sockets[0].emit('connect'); sockets[0].emit('data', Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
  await rejected; await nextTurn(); assertHandshakeClean(sockets[0]);
});
