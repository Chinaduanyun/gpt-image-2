const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');
const { chromium } = require('playwright');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-hybrid-browser-'));
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const users = {};
  for (const email of ['test@staging.invalid', 'other@staging.invalid']) users[email] = { email, active: true, isAdmin: false, balanceMicros: 100000000 };
  fs.writeFileSync(path.join(data, 'app-data.json'), JSON.stringify({ version: 1, users, sessions: {}, spendLogs: [] }));
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#669944' } }).png().toBuffer();
  let calls = 0; const captures = [];
  const provider = http.createServer((req, res) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { calls++; captures.push({ path: req.url, text: Buffer.concat(chunks).toString() }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const config = path.join(temp, 'cpa.json'); fs.writeFileSync(config, JSON.stringify({ baseUrl: `${origin}/v1`, apiKey: 'mock-only' }), { mode: 0o600 });
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, IMAGE_PROVIDER_MODE: 'cpa', CPA_ALLOWED_ORIGIN: origin, CPA_CONFIG_FILE: config, SESSION_COOKIE_NAME: 'imageStudioStagingToken', QUICK_BATCH_ENABLED: 'true', ADMIN_EMAIL: '', API_MARKET_API_KEY: '', APIMARKET_API_KEY: '' }, stdio: 'pipe' });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const page = await context.newPage(); const errors = []; const dialogs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.goto(base);
    await page.locator('#emailInput').fill('test@staging.invalid'); await page.locator('#loginBtn').click(); await page.locator('#appShell').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#runBtn').disabled);
    await page.evaluate(() => { ImageGen.polling.initialDelayMs = 10; ImageGen.polling.intervalMs = 20; ImageGen.els.prompt.value = 'A small green tree'; });
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => ImageGen.state.result?.status === 'completed' && !ImageGen.state.isBusy);
    assert.deepEqual(dialogs, ['生成 1 张，费用 ¥0.306。继续？']);
    assert.equal(calls, 1);
    await page.waitForFunction(() => document.querySelector('.result-thumb').textContent.includes('80 × 60'));
    const cookies = await context.cookies(); assert.ok(cookies.some((cookie) => cookie.name === 'imageStudioStagingToken')); assert.ok(!cookies.some((cookie) => cookie.name === 'imageGenToken'));
    await page.reload(); await page.locator('#appShell').waitFor({ state: 'visible' });
    await page.evaluate(() => ImageGen.loadMyLogs());
    const first = await page.evaluate(() => ImageGen.state.myLogs.find((log) => log.type === 'generation'));
    assert.equal(first.settled, true); assert.equal(first.actualCostMicros, first.estimatedCostMicros);
    const auth = await page.evaluate(() => ImageGen.state.session.token);
    const headers = { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' };
    const request = { model: 'gpt-image-2', prompt: 'Edit with two references', n: 1, bestEffortAccepted: true, image_urls: Array(2).fill(`data:image/png;base64,${png.toString('base64')}`) };
    const submit = async (key, body) => fetch(`${base}/api/api-market/v1/images/generations`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) });
    assert.equal((await submit('no-consent', { ...request, bestEffortAccepted: false })).status, 400);
    const duplicates = await Promise.all([submit('repeat', request), submit('repeat', request)]);
    const ids = await Promise.all(duplicates.map((response) => response.json())); assert.equal(ids[0].taskId, ids[1].taskId);
    let edited;
    for (let i = 0; i < 100; i++) { edited = await (await fetch(`${base}/api/api-market/v1/tasks/${ids[0].taskId}`, { headers })).json(); if (edited.status === 'completed') break; await new Promise((r) => setTimeout(r, 30)); }
    assert.equal(edited.status, 'completed'); assert.equal(edited.inputFiles.length, 2); assert.equal(calls, 2); assert.equal(captures[1].path, '/v1/images/edits');
    assert.equal((await submit('repeat', { ...request, prompt: 'different' })).status, 409);
    const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'other@staging.invalid' }) })).json();
    assert.equal((await fetch(`${base}/api/stored-images/${edited.inputFiles[0].fileName}`, { headers: { Authorization: `Bearer ${login.token}` } })).status, 403);
    const hidden = await fetch(`${base}/api/me/logs/${first.id}`, { method: 'DELETE', headers }); assert.equal(hidden.status, 200);
    assert.equal((await fetch(`${base}${first.imageUrls[0]}`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/me/logs/${first.id}/assets`, { method: 'DELETE', headers })).status, 400);
    assert.equal((await fetch(`${base}/api/me/logs/${first.id}/assets`, { method: 'DELETE', headers: { ...headers, 'X-Confirm-Delete': 'permanent' } })).status, 200);
    assert.equal((await fetch(`${base}${first.imageUrls[0]}`, { headers })).status, 404);
    const legacyControls = await page.evaluate(() => {
      const saved = ImageGen.state.myLogs;
      const base = { type: 'generation', email: 'test@staging.invalid', createdAt: new Date().toISOString(), imageUrls: [], chargedMicros: 123, settings: {} };
      ImageGen.renderMyLogs([
        { ...base, id: 'legacy-terminal', status: 'completed', settled: true },
        { ...base, id: 'legacy-unknown', status: 'submission_unknown', settled: false },
        { ...base, id: 'v2-terminal', status: 'completed', settled: true, billingVersion: 'fixed-quote-v2' }
      ]);
      const has = (id, action) => Boolean(document.querySelector(`[data-log-id="${id}"][data-history-action="${action}"]`));
      const result = { legacyDelete: has('legacy-terminal', 'delete-assets'), legacyHide: has('legacy-terminal', 'delete'), unknownDelete: has('legacy-unknown', 'delete-assets'), unknownHide: has('legacy-unknown', 'delete'), v2Delete: has('v2-terminal', 'delete-assets') };
      ImageGen.renderMyLogs(saved);
      return result;
    });
    assert.deepEqual(legacyControls, { legacyDelete: true, legacyHide: true, unknownDelete: false, unknownHide: true, v2Delete: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, legacyControls, mockCalls: calls, consent: true, fixedQuote: true, refreshRecovery: true, referenceOwnership: true, hideRetains: true, explicitDeletion: true, cookieIsolation: true, pageErrors: errors, artifacts: temp }, null, 2));
  } finally { await browser?.close(); app.kill(); await new Promise((resolve) => provider.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
