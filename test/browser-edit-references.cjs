// Optional smoke: NODE_PATH=<temporary playwright install>/node_modules node test/browser-edit-references.cjs
// Real app + real canvas + local HTTPS provider. No production data or paid API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-edit-browser-'));
const dataDir = path.join(temp, 'data');
const email = 'edit-qa@example.invalid';
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'app-data.json'), JSON.stringify({
  version: 1, users: { [email]: { email, active: true, isAdmin: false, balanceMicros: 100000000 } },
  sessions: {}, spendLogs: []
}));
const keyFile = path.join(temp, 'key.pem');
const certFile = path.join(temp, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
  '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });

(async () => {
  const captures = [];
  const provider = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captures.push({ path: req.url, payload: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      // Deliberately fail after capture: exercises the app's safe refund path, not image generation.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'LOCAL_QA_CAPTURE_ONLY' } }));
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const portProbe = net.createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
    ADMIN_EMAIL: '', API_MARKET_API_KEY: 'local-qa-only', API_MARKET_BASE_URL: `https://127.0.0.1:${provider.address().port}`,
    NODE_EXTRA_CA_CERTS: certFile, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
  const app = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let appOutput = '';
  app.stdout.on('data', (chunk) => { appOutput += chunk; });
  app.stderr.on('data', (chunk) => { appOutput += chunk; });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, appOutput);
    const asset = await fetch(`${base}/app/edit-references.js`);
    assert.equal(asset.status, 200, 'new module must be served by the static allowlist');
    const launchOptions = { headless: true };
    if (process.env.QA_COMPACT_CHROMIUM === '1') {
      const compact = require('@sparticuz/chromium');
      launchOptions.executablePath = await compact.executablePath();
      launchOptions.args = ['--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    }
    browser = await chromium.launch(launchOptions);
    const results = [];
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        return route.abort();
      });
      page.on('dialog', (dialog) => dialog.accept());
      await page.goto(base);
      await page.locator('#emailInput').fill(email);
      await page.locator('#loginBtn').click();
      await page.locator('#appShell').waitFor({ state: 'visible' });
      const fixtures = await page.evaluate(() => {
        function make(color) {
          const canvas = document.createElement('canvas');
          canvas.width = 640; canvas.height = 480;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(100, 100, 180, 180);
          return canvas.toDataURL('image/png');
        }
        return { base: make('#a5b4fc'), ref: make('#f59e0b'), style: make('#14b8a6') };
      });
      const upload = (name, value) => ({ name, mimeType: 'image/png', buffer: Buffer.from(value.split(',')[1], 'base64') });
      // Creation references must survive and must not leak into edit submissions.
      await page.locator('#referenceFileInput').setInputFiles(upload('creation-only.png', fixtures.style));
      await page.waitForFunction(() => ImageGen.state.referenceImages.length === 1);
      await page.locator('[data-preview-nav="edit"]').click();
      await page.locator('#editUploadInput').setInputFiles(upload('base.png', fixtures.base));
      await page.locator('#editWorkspace').waitFor({ state: 'visible' });
      await page.locator('#editReferenceFileInput').setInputFiles([
        upload('chair.png', fixtures.ref), upload('style.png', fixtures.style)
      ]);
      await page.waitForFunction(() => ImageGen.state.edit.referenceImages.length === 2 && !ImageGen.state.edit.referencesLoading);
      assert.equal(await page.locator('#editReferenceCount').textContent(), '2/15 张');
      await page.locator('[data-edit-tool="rect"]').click();
      await page.locator('#editAnnotationCanvas').scrollIntoViewIfNeeded();
      const box = await page.locator('#editAnnotationCanvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 8 });
      await page.mouse.up();
      await page.locator('#editPrompt').fill('把图 1 绿色框中的椅子替换为图 2 的款式，颜色参考图 3，其他区域不变。');
      await page.locator('#editAppendToggle').uncheck();
      const expectedComposite = await page.evaluate(() => ImageGen.composeEditedImage().dataUrl);
      const before = captures.length;
      await page.locator('#editSubmitBtn').click();
      await page.waitForFunction(() => !ImageGen.state.isBusy && !ImageGen.state.pendingRequest);
      assert.equal(captures.length, before + 1);
      const capture = captures.at(-1);
      assert.equal(capture.path, '/v1/images/generations');
      assert.equal(capture.payload.image_urls.length, 3);
      assert.deepEqual(capture.payload.image_urls, [expectedComposite, fixtures.ref, fixtures.style]);
      assert.notEqual(expectedComposite, fixtures.base, 'first image must be the canvas composition');
      assert.match(capture.payload.prompt, /图 2 起是额外参考图/);
      assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 1);
      assert.match(await page.locator('#status').textContent(), /LOCAL_QA_CAPTURE_ONLY/);
      await page.locator('[data-preview-nav="edit"]').click();
      await page.locator('#editReferenceTitle').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      assert.equal(await page.locator('#editReferencePreviewGrid img').count(), 2);
      await page.screenshot({ path: path.join(temp, `edit-${viewport.width}.png`), fullPage: true });
      await page.locator('#editReferencePreviewGrid button').first().click();
      assert.match(await page.locator('#editReferencePreviewGrid figcaption').textContent(), /^图 2 · style/);
      await page.locator('#editClearReferencesBtn').click();
      assert.equal(await page.locator('#editReferenceCount').textContent(), '0/15 张');
      assert.equal(await page.evaluate(() => ImageGen.state.edit.strokes.length), 1);
      await page.locator('#editReferenceFileInput').setInputFiles(upload('chair.png', fixtures.ref));
      await page.waitForFunction(() => ImageGen.state.edit.referenceImages.length === 1 && !ImageGen.state.edit.referencesLoading);
      await page.locator('#editUploadInput').setInputFiles(upload('new-base.png', fixtures.style));
      await page.waitForFunction(() => ImageGen.state.edit.referenceImages.length === 0 && !ImageGen.state.edit.imageLoading);
      assert.equal(await page.evaluate(() => ImageGen.state.edit.strokes.length), 0);
      assert.deepEqual(errors, []);
      results.push({ viewport, inputImages: 3, canvasStrokes: 1, orderedPayload: true, isolatedReferences: true, noHorizontalOverflow: true, pageErrors: errors });
      await context.close();
    }
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ ok: true, artifacts: temp, results }, null, 2));
  } finally {
    if (browser) await browser.close();
    app.kill();
    await once(app, 'exit');
    await new Promise((resolve) => provider.close(resolve));
  }
})().catch((error) => { console.error(error); console.error(`Artifacts: ${temp}`); process.exitCode = 1; });
