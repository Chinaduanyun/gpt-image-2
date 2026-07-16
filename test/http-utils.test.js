const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachResponseErrorHandler, send } = require('../lib/http-utils');

function response(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHeadCalls: 0,
    endCalls: 0,
    writeHead() { this.writeHeadCalls += 1; },
    end() { this.endCalls += 1; },
    ...overrides
  });
}

test('send skips a response that the client has already disconnected', () => {
  const res = response({ destroyed: true });
  assert.equal(send(res, 200, 'ok'), false);
  assert.equal(res.writeHeadCalls, 0);
  assert.equal(res.endCalls, 0);
});

test('send skips ending a response that finished after headers were written', () => {
  const res = response({ writeHead() { this.writeHeadCalls += 1; this.writableEnded = true; } });
  assert.equal(send(res, 200, 'ok'), false);
  assert.equal(res.writeHeadCalls, 1);
  assert.equal(res.endCalls, 0);
});

test('response error handler consumes client socket errors', () => {
  const res = response();
  attachResponseErrorHandler(res);
  assert.doesNotThrow(() => res.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
});
