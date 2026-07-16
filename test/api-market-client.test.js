const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { requestApiMarket } = require('../lib/api-market-client');

const CONFIG = { baseUrl: 'https://example.test' };

function installHttpsMock(handler) {
  const original = https.request;
  https.request = (options, callback) => {
    const req = new EventEmitter();
    const socket = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = (error) => { if (error) req.emit('error', error); };
    req.end = () => handler({ options, callback, req, socket });
    process.nextTick(() => req.emit('socket', socket));
    return req;
  };
  return () => { https.request = original; };
}

function abortedResponse() {
  const res = new Readable({ read() {} });
  res.statusCode = 200;
  res.headers = { 'content-type': 'application/json' };
  return res;
}

for (const [name, emit] of [
  ['request EPIPE', ({ req }) => req.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))],
  ['socket EPIPE', ({ socket }) => socket.emit('error', Object.assign(new Error('socket EPIPE'), { code: 'EPIPE' }))],
  ['response error', ({ callback }) => {
    const res = abortedResponse();
    callback(res);
    res.emit('error', new Error('response reset'));
  }],
  ['response abort', ({ callback }) => {
    const res = abortedResponse();
    callback(res);
    res.emit('aborted');
  }]
]) {
  test(`requestApiMarket rejects safely on ${name}`, { concurrency: false }, async () => {
    const restore = installHttpsMock(emit);
    try {
      await assert.rejects(
        requestApiMarket('GET', '/v1/tasks/test', {}, null, CONFIG),
        name === 'response abort' ? /上游响应已中止/ : /EPIPE|response reset/
      );
    } finally {
      restore();
    }
  });
}



test('requestApiMarket rejects malformed and non-HTTPS base URLs before opening a request', async () => {
  const original = https.request;
  let calls = 0;
  https.request = () => { calls += 1; throw new Error('should not connect'); };
  try {
    await assert.rejects(requestApiMarket('GET', '/v1/tasks/test', {}, null, { baseUrl: 'not a URL' }), /baseUrl 无效/);
    await assert.rejects(requestApiMarket('GET', '/v1/tasks/test', {}, null, { baseUrl: 'http://example.test' }), /必须使用 HTTPS/);
    assert.equal(calls, 0);
  } finally {
    https.request = original;
  }
});

