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
  const provider = http.createServer((req, res) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { calls++; captures.push({ path: req.url, text: Buffer.concat(chunks).toString() }); res.setHeader('Content-Type', 'application/json'); setTimeout(() => res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })), calls === 1 ? 2500 : 100); }); });
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
    assert.equal(await page.locator('#taskCapsule').isVisible(), false, 'task capsule is hidden before account restoration');
    await page.locator('#emailInput').fill('test@staging.invalid'); await page.locator('#loginBtn').click(); await page.locator('#appShell').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#runBtn').disabled);
    assert.equal(await page.locator('#aspectRatio').inputValue(), 'auto');
    assert.equal(await page.locator('.reference-help p').isVisible(), false);
    assert.equal(await page.locator('#referenceStatus').textContent(), '');
    await page.locator('.reference-help summary').click();
    assert.equal(await page.locator('.reference-help p').textContent(), '支持 PNG、JPEG、WebP；单张不超过 5MB，本地文件合计不超过 18MB，最多 16 张。');
    assert.equal(await page.locator('.reference-help p').isVisible(), true);
    await page.locator('.reference-help summary').press('Enter');
    assert.equal(await page.locator('.reference-help p').isVisible(), false);
    // Header removal must not leave a phantom grid row that pushes submit off-screen.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.locator('#runBtn').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
      await page.locator('#model').selectOption('gpt-image-2-official');
      assert.equal(await page.locator('#model').inputValue(), 'gpt-image-2-official');
      await page.locator('#model').selectOption('gpt-image-2');
    }
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.locator('#prompt').fill('first overlapping request');
    await page.locator('#runBtn').dblclick();
    await page.waitForFunction(() => !ImageGen.state.isBusy && ImageGen.state.result?.taskId);
    // An accepted background task must not block draft editing or cause a new request.
    await page.locator('[data-preview-nav="edit"]').click();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && !ImageGen.els.editUploadBtn.disabled);
    await page.locator('#editUploadInput').setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => ImageGen.editHasImage());
    assert.equal(calls, 1, 'opening/uploading an editor draft never submits');
    await page.locator('[data-preview-nav="workspace"]').click();
    await page.locator('#taskCapsule').click(); await page.locator('#newDraftBtn').click();
    await page.locator('#prompt').fill('second overlapping request');
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => !ImageGen.state.isBusy && ImageGen.state.result?.prompt === 'second overlapping request');
    await page.locator('#taskCapsule').click(); await page.locator('#newDraftBtn').click();
    await page.locator('#prompt').fill('durable unfinished draft');
    await page.locator('#referenceFileInput').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => ImageGen.state.referenceImages.length === 1);
    await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#prompt').value === 'durable unfinished draft' && ImageGen.state.referenceImages.length === 1);
    await page.evaluate(async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await ImageGen.recoverPendingGeneration();
        const response = await fetch('/api/me/tasks', { headers: { Authorization: `Bearer ${ImageGen.state.session.token}` } });
        const feed = await response.json();
        if (feed.tasks?.length === 2 && feed.tasks.every(t => t.status === 'completed')) return;
      }
      throw new Error('Mock tasks did not reach completed state');
    });
    assert.equal(await page.locator('#prompt').inputValue(), 'durable unfinished draft');
    assert.equal(calls, 2, 'double click must not produce a third paid provider call');
    await page.locator('#taskCapsule').click();
    assert.equal(await page.locator('.task-card').count(), 2);
    await page.screenshot({ path: '/tmp/image-capsule-desktop.png' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#taskCapsule').evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: '/tmp/image-capsule-collapsed.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#taskCapsule').click();
    assert.ok(await page.locator('#taskDrawer').isVisible());
    await page.keyboard.press('Escape');
    const feed = await page.evaluate(async () => {
      const response = await fetch('/api/me/tasks', { headers: { Authorization: `Bearer ${ImageGen.state.session.token}` } });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(feed.status, 200, 'real HTTP router exposes task feed');
    assert.equal(feed.body.tasks.length, 2);
    assert.ok(feed.body.tasks.every(t => t.status === 'completed'), JSON.stringify(feed.body));
    await page.locator('#taskCapsule').click();
    const firstCard = page.locator('.task-card').filter({ hasText: 'first overlappi…' });
    await firstCard.locator('.task-card-open').click();
    await page.waitForFunction(() => ImageGen.state.result?.status === 'completed');
    assert.equal(await page.locator('.result-thumb img').count(), 1);
    assert.equal(await page.locator('#prompt').inputValue(), 'first overlapping request');
    assert.equal(await page.locator('#prompt').getAttribute('readonly'), '');
    assert.equal(await page.locator('#referenceUploadBtn').isDisabled(), true);
    // RED on baseline: selected completed task kept upload disabled forever.
    await page.locator('[data-preview-nav="edit"]').click();
    await page.waitForFunction(() => !ImageGen.els.editUploadBtn.disabled);
    assert.equal(await page.locator('#prompt').inputValue(), 'durable unfinished draft');
    assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 1);
    await page.locator('#editUploadInput').setInputFiles({ name: 'completed.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => ImageGen.editHasImage());
    await page.locator('#editPrompt').fill('unfinished editor instructions');
    await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    const openFirst = async () => {
      await page.locator('[data-preview-nav="workspace"]').click();
      await page.locator('#taskCapsule').click();
      await firstCard.locator('.task-card-open').click();
      await page.waitForFunction(() => ImageGen.isWorkspaceReadOnly());
    };
    await openFirst();
    // Real result Edit routes through the same guarded transition and decodes an archived image.
    await page.locator('[data-edit-url]').first().click();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && ImageGen.state.edit.sourceUrl.startsWith('/api/stored-images/') && ImageGen.editHasImage());
    assert.equal(await page.locator('#editPrompt').inputValue(), 'unfinished editor instructions');
    assert.ok(await page.evaluate(() => ImageGen.composeEditedImage().dataUrl.startsWith('data:image/')));
    assert.equal(calls, 2);
    await openFirst();
    // Hold the actual IndexedDB put completion: editor inputs must not accept unsaved typing.
    await page.locator('[data-preview-nav="edit"]').click();
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready());
    await page.locator('#editPrompt').fill('durable text before delayed transaction');
    await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    await openFirst();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === 'accounts') {
          IDBObjectStore.prototype.put = original;
          const transaction = this.transaction;
          Object.defineProperty(transaction, 'oncomplete', { configurable: true, set(callback) {
            transaction.addEventListener('complete', () => {
              window.releaseWorkspacePut = () => callback();
            }, { once: true });
          } });
        }
        return request;
      };
      void ImageGen.prepareWorkspaceEdit();
    });
    await page.waitForFunction(() => typeof window.releaseWorkspacePut === 'function');
    for (const id of ['editPrompt', 'editAnnotationText', 'editAppendToggle']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
    assert.equal(await page.locator('#editPrompt').inputValue(), 'durable text before delayed transaction');
    await page.evaluate(() => { window.releaseWorkspacePut(); delete window.releaseWorkspacePut; });
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready());
    // Once enabled, real UI typing must save and survive reload after the transaction finishes.
    await page.locator('[data-preview-nav="edit"]').click();
    await page.locator('#editPrompt').fill('durable text after delayed transaction');
    await page.evaluate(() => ImageGen.flushWorkspace());
    await page.reload();
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready() && ImageGen.editHasImage());
    assert.equal(await page.locator('#editPrompt').inputValue(), 'durable text after delayed transaction');
    await page.locator('#editPrompt').fill('unfinished editor instructions');
    await page.evaluate(() => ImageGen.flushWorkspace());
    await openFirst();
    // Actual IndexedDB write failure must not unlock a selected snapshot or lose its saved draft.
    assert.equal(await page.evaluate(async () => {
      const original = indexedDB.open;
      indexedDB.open = () => { throw new Error('QA storage unavailable'); };
      try { return await ImageGen.prepareWorkspaceEdit(); }
      finally { indexedDB.open = original; }
    }), false);
    assert.equal(await page.evaluate(() => ImageGen.isWorkspaceReadOnly()), true);
    assert.equal(await page.locator('#prompt').inputValue(), 'first overlapping request');
    assert.match(await page.locator('#editStatus').textContent(), /QA storage unavailable/);
    // Slow saved-source hydration + duplicate result/nav entry must not cancel the new image.
    let releaseImage; const imageGate = new Promise(resolve => { releaseImage = resolve; });
    let sawImage; const imageRequested = new Promise(resolve => { sawImage = resolve; });
    await page.route('**/api/stored-images/*', async route => { sawImage(); await imageGate; await route.continue(); });
    await page.locator('[data-edit-url]').first().click();
    await imageRequested;
    await page.locator('[data-preview-nav="edit"]').click();
    await page.evaluate(() => { void ImageGen.prepareWorkspaceEdit(); });
    releaseImage();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && ImageGen.editHasImage() && !ImageGen.state.edit.imageLoading);
    assert.equal(await page.evaluate(() => ImageGen.state.edit.sourceKind), 'stored');
    assert.equal(await page.locator('#editPrompt').inputValue(), 'unfinished editor instructions');
    await page.unroute('**/api/stored-images/*');
    await page.evaluate(() => ImageGen.flushWorkspace());
    await openFirst();
    // Reload directly at #edit while IndexedDB still has selected: resume, not task snapshot.
    await page.evaluate(() => history.replaceState(null, '', '#edit'));
    await page.reload();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && !ImageGen.els.editUploadBtn.disabled && ImageGen.editHasImage());
    assert.equal(await page.locator('#prompt').inputValue(), 'durable unfinished draft');
    assert.equal(await page.locator('#editPrompt').inputValue(), 'unfinished editor instructions');
    assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 1);
    await openFirst();
    await page.locator('[data-preview-nav="library"]').click();
    await page.locator('.history-thumb').first().click();
    await page.locator('#previewHistoryDetailContent [data-history-action="edit"]').click();
    await page.waitForFunction(() => location.hash === '#edit' && !ImageGen.isWorkspaceReadOnly() && ImageGen.editHasImage());
    assert.equal(await page.locator('#previewHistoryDialog').evaluate(el => el.open), false);
    assert.equal(calls, 2, 'nav, upload, result and library detail Edit do not issue paid requests');
    // Authoritative capacity disables submission, not editing; reject with useful editor feedback.
    await page.route('**/api/me/tasks', async route => {
      const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, json: { ...body, activeCount: 3, limit: 3 } });
    });
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.locator('#editChangeImageBtn').isDisabled(), false);
    await page.locator('#editSubmitBtn').click();
    assert.match(await page.locator('#editStatus').textContent(), /已达上限 3/);
    assert.equal(calls, 2);
    await page.unroute('**/api/me/tasks');
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await openFirst();
    await page.locator('#detailNewDraftBtn').click();
    assert.equal(await page.locator('#prompt').inputValue(), '');
    assert.equal(await page.locator('.result-thumb img').count(), 0);
    assert.equal(await page.evaluate(() => ImageGen.state.result), null);
    // Empty local registry in another browser context must discover account tasks.
    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(base);
    await otherPage.locator('#emailInput').fill('test@staging.invalid'); await otherPage.locator('#loginBtn').click();
    await otherPage.waitForFunction(() => !document.querySelector('#taskCapsule').hidden);
    await otherPage.locator('#taskCapsule').click();
    await otherPage.waitForFunction(() => document.querySelectorAll('.task-card').length === 2);
    assert.equal(await otherPage.locator('.task-card img').count(), 2);
    assert.deepEqual(await otherPage.locator('.task-card-prompt').allTextContents(), ['second overlapp…', 'first overlappi…']);
    assert.equal(await otherPage.locator('.task-capsule-stack img').count(), 2);
    assert.equal(await otherPage.locator('#taskDrawer').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await otherPage.screenshot({ path: '/tmp/image-capsule-mobile.png' });
    await otherContext.close();
    // Exercise copy completeness against the real integrated task DTO, not just
    // frontend mocks: two original inputs must return once, in their original order.
    await page.locator('#prompt').fill('copy complete archived inputs');
    const secondPng = await sharp({ create: { width: 60, height: 80, channels: 3, background: '#994466' } }).png().toBuffer();
    await page.locator('#referenceFileInput').setInputFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: png },
      { name: 'second.png', mimeType: 'image/png', buffer: secondPng }
    ]);
    await page.waitForFunction(() => ImageGen.state.referenceImages.length === 2);
    const originalInputs = await page.evaluate(() => ImageGen.state.referenceImages.map(ref => ref.value));
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => !ImageGen.state.isBusy && ImageGen.state.result?.prompt === 'copy complete archived inputs');
    await page.waitForFunction(async () => {
      const result = await ImageGen.requestJson('/api/me/tasks');
      return result.json?.tasks?.some(task => task.prompt === 'copy complete archived inputs' && !task.active && task.referenceImageCount === 2 && task.inputFiles.length === 2);
    });
    await page.locator('#taskCapsule').click();
    await page.locator('.task-card').filter({ hasText: 'copy complete a…' }).locator('.task-card-copy').click();
    await page.waitForFunction(() => !document.querySelector('#taskDrawer').open && !ImageGen.isWorkspaceReadOnly() && ImageGen.state.referenceImages.length === 2);
    assert.deepEqual(await page.evaluate(() => ImageGen.state.referenceImages.map(ref => ref.value)), originalInputs);
    assert.equal(await page.locator('#prompt').inputValue(), 'copy complete archived inputs');
    assert.equal(calls, 3, 'copying inputs must not submit another paid provider request');
    await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#prompt').value === 'copy complete archived inputs' && ImageGen.state.referenceImages.length === 2);
    assert.deepEqual(await page.evaluate(() => ImageGen.state.referenceImages.map(ref => ref.value)), originalInputs);
    // Durable editor mutations and old transient flags must not lock a restored editor.
    await page.evaluate(async (image) => {
      ImageGen.loadEditImage(image, 'upload');
      await new Promise((resolve, reject) => { const deadline = Date.now() + 5000; const check = () => { if (ImageGen.state.edit?.image) return resolve(); if (Date.now() > deadline) return reject(new Error('mock editor image did not decode')); setTimeout(check, 20); }; check(); });
      ImageGen.els.editModel.value = 'gpt-image-2-official';
      ImageGen.els.model.value = 'gpt-image-2-official';
      ImageGen.els.editAspectRatio.value = '16:9'; ImageGen.els.editResolution.value = '2k';
      ImageGen.setEditTool('rect'); ImageGen.setEditColor('#ef4444'); ImageGen.setEditWidthTier(2);
      ImageGen.state.edit.referencesLoading = true; ImageGen.state.edit.imageLoading = true;
      await ImageGen.saveWorkspaceDraft();
    }, `data:image/png;base64,${png.toString('base64')}`);
    await page.reload();
    await page.waitForFunction(() => ImageGen.state.edit?.image && !ImageGen.state.edit.imageLoading && !ImageGen.state.edit.referencesLoading);
    assert.deepEqual(await page.evaluate(() => ({ tool: ImageGen.state.edit.tool, color: ImageGen.state.edit.color, width: ImageGen.state.edit.widthTier, model: ImageGen.els.editModel.value, ratio: ImageGen.els.editAspectRatio.value, resolution: ImageGen.els.editResolution.value })), { tool: 'rect', color: '#ef4444', width: 2, model: 'gpt-image-2-official', ratio: '16:9', resolution: '2k' });
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready());
    // A missing optional saved editor asset must retain the draft, not strand all task actions.
    const savedWorkspace = async () => page.evaluate(async () => {
      await ImageGen.flushWorkspace();
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('imageGenWorkspace', 1);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('accounts', 'readonly');
          const read = tx.objectStore('accounts').get('workspace:test@staging.invalid');
          read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      });
    });
    await page.evaluate(async () => {
      ImageGen.state.edit.sourceUrl = '/api/stored-images/missing-qa.png';
      ImageGen.state.edit.strokes = [{ tool: 'brush', points: [{ x: 5, y: 6 }], color: '#ef4444', width: 2 }];
      ImageGen.state.edit.referenceImages = [{ id: 'retained-ref', value: 'data:image/png;base64,AAAA', name: 'retained' }];
      ImageGen.els.editPrompt.value = 'retain missing source instructions';
      await ImageGen.saveWorkspaceDraft();
    });
    const missingDraft = (await savedWorkspace()).draft;
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-workspace-draft-recovery]')].some(el => !el.hidden));
    assert.equal(await page.locator('[data-retry-workspace-draft]').first().isDisabled(), false);
    assert.deepEqual((await savedWorkspace()).draft, missingDraft, '404 startup must not persist a blank editor over saved source/strokes/refs');
    await page.locator('#taskCapsule').click();
    await page.locator('.task-card').first().locator('.task-card-open').click();
    await page.waitForFunction(() => ImageGen.state.result?.taskId);
    assert.deepEqual((await savedWorkspace()).draft, missingDraft, 'task navigation retains failed draft');
    // The original asset URL can recover after a transient server failure; retry retains all metadata.
    await page.route('**/api/stored-images/missing-qa.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.locator('[data-retry-workspace-draft]').first().click();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && ImageGen.editHasImage());
    assert.equal(await page.locator('#editPrompt').inputValue(), 'retain missing source instructions');
    assert.deepEqual((await savedWorkspace()).draft, missingDraft);
    await page.unroute('**/api/stored-images/missing-qa.png');
    await page.route('**/api/stored-images/missing-qa.png', route => route.fulfill({ status: 503, body: 'QA temporary unavailable' }));
    await openFirst();
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-workspace-draft-recovery]')].some(el => !el.hidden));
    assert.equal(await page.evaluate(() => ImageGen.state.result?.prompt), 'first overlapping request', 'startup transient failure restores valid selected task');
    assert.deepEqual((await savedWorkspace()).draft, missingDraft);
    await page.unroute('**/api/stored-images/missing-qa.png');
    await page.route('**/api/stored-images/missing-qa.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.locator('[data-retry-workspace-draft]').first().click();
    await page.waitForFunction(() => !ImageGen.isWorkspaceReadOnly() && ImageGen.editHasImage());
    assert.deepEqual((await savedWorkspace()).draft, missingDraft);
    await page.unroute('**/api/stored-images/missing-qa.png');
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-workspace-draft-recovery]')].some(el => !el.hidden));
    // Account switch must not capture partial hydration or write another account into this record.
    await page.locator('#logoutBtn').click(); await page.locator('#loginPanel').waitFor({ state: 'visible' });
    await page.locator('#emailInput').fill('other@staging.invalid'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready());
    await page.locator('#prompt').fill('other account draft'); await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    assert.deepEqual((await savedWorkspace()).draft, missingDraft, 'account switch preserves failed first-account draft');
    await page.locator('#logoutBtn').click(); await page.locator('#loginPanel').waitFor({ state: 'visible' });
    await page.locator('#emailInput').fill('test@staging.invalid'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-workspace-draft-recovery]')].some(el => !el.hidden));
    await page.locator('[data-replace-workspace-draft]').first().click();
    await page.waitForFunction(() => ImageGen.workspaceSubmit.ready());
    assert.ok(dialogs.some(message => message.includes('旧草稿底图尚未恢复')));
    assert.equal((await savedWorkspace()).draft.edit, null, 'only explicit confirmed new draft discards failed editor');
    await page.locator('#taskCapsule').click(); assert.equal(await page.locator('.task-card').count(), 3); await page.keyboard.press('Escape');
    assert.equal(calls, 3, '404/retry/account switch/new draft never submit or replay provider requests');
    await page.locator('#logoutBtn').click();
    await page.locator('#loginPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#taskCapsule').isVisible(), false);
    assert.equal(await page.locator('.task-notice').textContent(), '');
    assert.equal(await page.locator('#taskDrawer').evaluate(el => el.open), false);
    assert.deepEqual(errors, []);
    console.log('workspace browser behavior passed: overlap/idempotency, selected/background edit nav/upload, result/library Edit, real canvas/archive, direct #edit reload, draft preservation, slow duplicate entry, IndexedDB failure, capacity feedback, task readonly/feed cards, desktop/mobile Escape focus, startup 404/503 recovery, saved metadata retention, account isolation and confirmed discard');
  } finally { await browser?.close(); app.kill(); await new Promise((resolve) => provider.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
