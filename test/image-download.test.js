const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { downloadExternalFile } = require('../lib/image-store');

test('download rejects (does not hang) when the connection aborts mid-stream', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
    res.write(Buffer.from('partial-bytes'));
    // Drop the connection before finishing the declared body.
    setImmediate(() => res.socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(downloadExternalFile(`http://127.0.0.1:${port}/x.png`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('download resolves for a complete small image', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from('image-bytes'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await downloadExternalFile(`http://127.0.0.1:${port}/x.png`);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.buffer.toString(), 'image-bytes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
