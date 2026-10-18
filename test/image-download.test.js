const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns').promises;
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { downloadExternalFile } = require('../lib/image-store');

// Mock transport only: production never permits a loopback image URL.
function mockDownload(t, handler) {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'get', (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = 200; res.headers = { 'content-type': 'image/png' };
      callback(res); handler(res);
    });
    return req;
  });
}

test('download rejects (does not hang) when the connection aborts mid-stream', async (t) => {
  mockDownload(t, (res) => { res.write('partial-bytes'); res.emit('aborted'); });
  await assert.rejects(downloadExternalFile('http://images.example/x.png'), /中断/);
});

test('download resolves for a complete small image', async (t) => {
  mockDownload(t, (res) => res.end('image-bytes'));
  const result = await downloadExternalFile('http://images.example/x.png');
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.buffer.toString(), 'image-bytes');
});
