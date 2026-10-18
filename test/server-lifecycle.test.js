const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function startDisposableServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lifecycle-'));
  // Publish the actual ephemeral port without a reserve/release race. This hook
  // exists only in the disposable child, never in production server code.
  const launcher = `const http=require('node:http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args);};require('./server');`;
  const child = spawn(process.execPath, ['-e', launcher], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, ADMIN_EMAIL: '', IMAGE_PROVIDER_MODE: '', API_MARKET_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Server readiness timed out: ${output}`)), 10000);
    const onData = () => {
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match && output.includes('Local server listening')) finish(null, Number(match[1]));
    };
    const onExit = () => finish(new Error(`Server exited before readiness: ${output}`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData();
  });
  return { child, port, output: () => output };
}

test('malformed absolute request target returns 400 without killing the server', { timeout: 15000 }, async (t) => {
  const { child, port, output } = await startDisposableServer(t);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let text = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw HTTP request timed out')));
    socket.on('connect', () => socket.end('GET http://[invalid/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    socket.on('data', (data) => { text += data; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  const next = await fetch(`http://127.0.0.1:${port}/api/public-config`);
  assert.equal(next.status, 200);
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(output(), /TypeError|ERR_INVALID_URL/);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} closes the server cleanly`, { timeout: 15000 }, async (t) => {
    const { child, output } = await startDisposableServer(t);
    const exit = once(child, 'exit');
    child.kill(signal);
    const [code, receivedSignal] = await exit;
    assert.equal(code, 0, output());
    assert.equal(receivedSignal, null);
    assert.doesNotMatch(output(), /ReferenceError|backgroundRefreshTimer/);
  });
}
