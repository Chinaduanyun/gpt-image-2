const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { handlePublicConfig } = require('../routes/public-config');

(async () => {
  const root = path.join(__dirname, '..');
  const server = http.createServer((req, res) => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER_EXECUTABLE });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let tasks = [], generationPosts = 0, allowGeneration = false; const generationRequests = []; const inputReads = [];
    const configRes = { writeHead() {}, end(body) { this.body = body; } }; handlePublicConfig({ method: 'GET' }, configRes);
    const config = JSON.parse(configRes.body); config.features.quickBatchEnabled = false;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), email = route.request().headers().authorization?.replace('Bearer token-', '') || 'a@test.invalid';
      let json = {};
      if (url.pathname === '/api/public-config') json = config;
      else if (url.pathname === '/api/auth/login') { const email = route.request().postDataJSON().email; json = { token: `token-${email}`, user: { email, isAdmin: email.startsWith('a@'), balanceMicros: 100000000 } }; }
      else if (url.pathname === '/api/me') json = { user: { email, isAdmin: email.startsWith('a@'), balanceMicros: 100000000 } };
      else if (url.pathname === '/api/me/tasks') json = { tasks, activeCount: tasks.filter(t => t.active).length, limit: 3 };
      else if (url.pathname.includes('/images/generations')) { generationPosts++; if (!allowGeneration) throw new Error('Unexpected generation POST'); generationRequests.push(route.request().postDataJSON()); json = { taskId: `history-${generationPosts}`, status: 'processing' }; }
      else if (url.pathname.includes('/logs') || url.pathname.includes('spend-logs')) json = { logs: [] };
      else if (url.pathname.includes('/users')) json = { users: [] };
      else if (url.pathname.startsWith('/api/stored-images/')) {
        inputReads.push(url.pathname);
        await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }); return;
      }
      await route.fulfill({ json });
    });
    await page.addInitScript(() => {
      window.readAuditStore = async (database, store, key) => new Promise((resolve, reject) => {
        const open = indexedDB.open(database);
        open.onsuccess = () => { const db = open.result, tx = db.transaction(store), request = tx.objectStore(store).get(key); let value;
          request.onsuccess = () => { value = request.result; }; tx.oncomplete = () => { db.close(); resolve(value ?? null); }; tx.onerror = () => reject(tx.error); };
        open.onerror = () => reject(open.error);
      });
      window.notifications = [];
      window.Notification = class {
        static permission = 'granted';
        static requestPermission() { throw new Error('Completion must not request permission'); }
        constructor(title, options) { window.notifications.push({ title, ...options }); }
        close() {}
      };
    });
    await page.goto(base);
    const login = async email => {
      await page.locator('#emailInput').fill(email); await page.locator('#loginBtn').click();
      await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
      await page.evaluate(() => ImageGen.recoverPendingGeneration());
    };
    const logout = async () => { await page.locator('#logoutBtn').click(); await page.locator('#loginPanel').waitFor({ state: 'visible' }); };
    const task = (id, active = false, referenceImageCount = 0, inputFiles = []) => ({ id, clientRequestId: id, kind: 'task', taskId: `task-${id}`, active, status: active ? 'processing' : 'completed', referenceImageCount, inputFiles, prompt: `prompt-${id}`, model: 'gpt-image-2', settings: { n: 1, size: '1:1', resolution: '1k' }, children: [{ status: active ? 'processing' : 'completed', active, referenceImageCount }], imageUrls: [] });
    await login('a@test.invalid');
    // Real production pricing + generation + workspace composition, including feed/capacity updates.
    assert.equal(await page.locator('#imageCount').isDisabled(), true);
    await page.locator('#model').selectOption('gpt-image-2-official');
    assert.equal(await page.locator('#imageCount').isDisabled(), false);
    await page.locator('#imageCount').selectOption('4');
    assert.equal(await page.evaluate(() => ImageGen.getSettings().n), 4);
    await page.locator('#model').selectOption('gpt-image-2');
    assert.equal(await page.locator('#imageCount').inputValue(), '1');
    assert.equal(await page.evaluate(() => ImageGen.getSettings().n), 1);
    await page.evaluate(() => { ImageGen.state.publicConfig.features.quickBatchEnabled = true; ImageGen.updateModelUi(); });
    assert.equal(await page.locator('#imageCount').isDisabled(), false);
    await page.locator('#imageCount').selectOption('3');
    assert.equal(await page.evaluate(() => ImageGen.getSettings().n), 3);
    await page.evaluate(() => { ImageGen.state.publicConfig.features.quickBatchEnabled = false; ImageGen.updateModelUi(); });
    tasks = [task('one', true), task('two', true), task('three', true)];
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => ImageGen.updatePriceEstimate());
    assert.equal(await page.locator('#runBtn').isDisabled(), true);
    const immutable = task('immutable'); immutable.settings.n = 4; immutable.requestedCount = 4;
    tasks = [immutable]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.locator('#taskCapsule').click(); await page.locator('[data-action-key="open:immutable"]').click();
    await page.evaluate(() => ImageGen.updateModelUi());
    assert.equal(await page.locator('#imageCount').inputValue(), '4');
    assert.equal(await page.locator('#imageCount').isDisabled(), true);
    assert.equal(await page.locator('#runBtn').isDisabled(), true);
    await page.locator('#detailNewDraftBtn').click();
    tasks = [task('one', true), task('two', true), task('three', true)];
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    // Notifications are authoritative active -> terminal only, concurrent and deduplicated.
    await page.evaluate(() => { ImageGen.setNotifyPref(true); Object.defineProperty(document, 'hidden', { configurable: true, value: true }); });
    tasks = tasks.map(t => ({ ...t, active: false, status: 'completed', children: t.children.map(c => ({ ...c, active: false, status: 'completed' })) }));
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.evaluate(() => notifications.length), 3);
    tasks = [task('foreground', true)]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }));
    tasks = [task('foreground')]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.evaluate(() => notifications.length), 3, 'foreground transition is not queued for later delivery');
    tasks = [task('denied', true)]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => Notification.permission = 'denied');
    tasks = [task('denied')]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.evaluate(() => notifications.length), 3);
    await page.evaluate(() => Notification.permission = 'granted');
    // Deferred references: typing preserves reads, replacement boundaries discard them, totals checked on completion.
    await page.evaluate(() => {
      window.pendingReaders = [];
      window.NativeReader = window.FileReader;
      window.FileReader = class { readAsDataURL() { pendingReaders.push(this); } };
      window.finishReader = () => { const r = pendingReaders.shift(); r.result = 'data:image/png;base64,AA=='; r.onload(); };
    });
    const beginRead = () => page.evaluate(() => { window.readResult = ImageGen.addReferenceFileList([{ type: 'image/png', size: 4, name: 'private.png' }]); });
    await beginRead(); await page.locator('#prompt').fill('typing keeps reference');
    await page.evaluate(async () => { finishReader(); await readResult; ImageGen.renderReferences(); });
    assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 1);
    for (const boundary of ['clear', 'new', 'detail', 'copy']) {
      tasks = [task('copy')]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
      await beginRead();
      if (boundary === 'clear') await page.evaluate(() => ImageGen.clearReferences());
      else {
        await page.locator('#taskCapsule').click();
        if (boundary === 'new') await page.locator('#newDraftBtn').click();
        if (boundary === 'copy') await page.locator('.task-card-copy').click();
        if (boundary === 'detail') { await page.locator('.task-card-open').click(); await page.locator('#detailNewDraftBtn').click(); }
      }
      await page.evaluate(async () => { finishReader(); const result = await readResult; if (!result.aborted) throw new Error('stale read accepted'); });
      assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 0);
    }
    await page.evaluate(async () => {
      const size = 5 * 1024 * 1024;
      ImageGen.state.referenceImages = [{ bytes: 10 * 1024 * 1024 }];
      const file = { type: 'image/png', size, name: 'large.png' };
      const a = ImageGen.addReferenceFileList([file]), b = ImageGen.addReferenceFileList([file]);
      finishReader(); await a; finishReader(); const result = await b;
      if (result.added !== 0 || !result.rejected.length) throw new Error('overlapping reads bypassed total limit');
      ImageGen.clearReferences(); window.FileReader = NativeReader;
    });
    // A deferred copy is cancelled by a replacement draft without stealing it.
    tasks = [task('slow', false, 1, [{ fileName: 'slow', url: '/api/stored-images/slow' }])];
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.evaluate(() => {
      window.originalReferenceReader = ImageGen.referenceFileToDataUrl;
      ImageGen.referenceFileToDataUrl = () => new Promise(resolve => { window.finishCopy = () => resolve('data:image/png;base64,AA=='); });
    });
    await page.locator('#taskCapsule').click(); await page.locator('.task-card-copy').click();
    await page.waitForFunction(() => Boolean(window.finishCopy));
    await page.locator('#newDraftBtn').click(); await page.locator('#prompt').fill('replacement during slow copy');
    await page.evaluate(async () => { finishCopy(); ImageGen.referenceFileToDataUrl = originalReferenceReader; await ImageGen.flushWorkspace(); });
    assert.equal(await page.locator('#prompt').inputValue(), 'replacement during slow copy');
    assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 0);
    // Failed copy must leave the current draft untouched; explicit zero copies successfully.
    await page.locator('#prompt').fill('keep my draft');
    for (const count of [2, null]) {
      tasks = [task('partial', false, count)]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
      await page.locator('#taskCapsule').click(); await page.locator('.task-card-copy').click();
      await page.waitForFunction(() => ImageGen.els.status.textContent.includes('保存失败'));
      assert.equal(await page.locator('#prompt').inputValue(), 'keep my draft');
      await page.keyboard.press('Escape');
    }
    tasks = [task('complete', false, 2, ['first', 'second'].map(fileName => ({ fileName, url: `/api/stored-images/${fileName}` })))];
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.locator('#taskCapsule').click(); await page.locator('.task-card-copy').click();
    await page.waitForFunction(() => ImageGen.state.referenceImages.length === 2);
    assert.deepEqual(await page.evaluate(() => ImageGen.state.referenceImages.map(r => r.type)), ['file', 'file']);
    assert.deepEqual(inputReads.slice(-2), ['/api/stored-images/first', '/api/stored-images/second']);
    // History programmatic changes are committed even when the central regenerate confirmation is cancelled.
    const history = { id: 'history', kind: 'task', prompt: 'durable history reuse', model: 'gpt-image-2-official', settings: { size: '16:9', resolution: '2k', n: 2 } };
    await page.evaluate(async log => {
      ImageGen.state.myLogs = [log];
      await ImageGen.handleHistoryClick({ target: { closest: () => ({ dataset: { historyAction: 'reuse', logId: log.id } }) } });
    }, history);
    await page.reload(); await page.waitForFunction(() => ImageGen.els.prompt.value === 'durable history reuse');
    assert.equal(await page.locator('#imageCount').inputValue(), '2');
    assert.equal(await page.evaluate(() => ImageGen.state.referenceImages.length), 2, 'history reuse deliberately preserves existing draft references');
    await page.evaluate(async log => {
      ImageGen.state.myLogs = [log]; window.confirm = () => false;
      await ImageGen.handleHistoryClick({ target: { closest: () => ({ dataset: { historyAction: 'regenerate', logId: log.id } }) } });
      await ImageGen.flushWorkspace();
    }, { ...history, prompt: 'cancelled regeneration survives' });
    await page.reload(); await page.waitForFunction(() => ImageGen.els.prompt.value === 'cancelled regeneration survives');
    assert.equal(generationPosts, 0);
    // Actual history DOM clicks retain the production handler while exposing its completion barrier.
    await page.evaluate(() => {
      ImageGen.state.publicConfig.features.hybridImages = true;
      window.unhandledHistory = []; window.historyRunCalls = 0; window.saveFailureMessages = [];
      addEventListener('unhandledrejection', event => unhandledHistory.push(String(event.reason)));
      const original = ImageGen.handleHistoryClick;
      ImageGen.els.myLogsList.removeEventListener('click', original);
      ImageGen.els.myLogsList.addEventListener('click', event => {
        window.historyAction = original(event);
        // Do not catch rejections: the production DOM handler must settle successfully itself.
        window.historySettled = historyAction.then(() => true);
      });
      const run = ImageGen.handleRun;
      ImageGen.handleRun = (...args) => { historyRunCalls++; return run(...args); };
      const status = ImageGen.setStatus;
      ImageGen.setStatus = (message, ...args) => { if (message.includes('工作区保存失败')) saveFailureMessages.push(message); return status(message, ...args); };
      window.clickHistory = (action, prompt = 'history A') => {
        ImageGen.renderMyLogs([{ id: 'dom-history', kind: 'task', type: 'generation', prompt, status: 'completed', model: 'gpt-image-2', settings: { size: '1:1', resolution: '1k', n: 1 } }]);
        ImageGen.els.myLogsList.querySelector(`[data-history-action="${action}"]`).click();
      };
      window.deferHistorySave = () => {
        const save = ImageGen.saveWorkspaceDraft;
        ImageGen.saveWorkspaceDraft = (...args) => {
          ImageGen.saveWorkspaceDraft = save;
          const committed = save(...args);
          return new Promise((resolve, reject) => { window.releaseHistorySave = () => committed.then(resolve, reject); });
        };
      };
    });
    for (const boundary of ['prompt', 'parameter', 'reference', 'clear-reference', 'new', 'copy', 'reuse']) {
      tasks = [task('replacement')]; await page.evaluate(() => ImageGen.recoverPendingGeneration());
      await page.evaluate(() => { window.confirm = () => false; deferHistorySave(); clickHistory('regenerate'); });
      if (boundary === 'prompt') await page.locator('#prompt').fill('superseding B');
      if (boundary === 'parameter') await page.locator('#resolution').selectOption('2k');
      if (boundary === 'reference') {
        await page.locator('#referenceFileInput').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
        await page.waitForFunction(() => ImageGen.state.referenceImages.length > 2);
      }
      if (boundary === 'clear-reference') await page.locator('#clearReferencesBtn').click();
      if (boundary === 'new' || boundary === 'copy') {
        await page.locator('#taskCapsule').click();
        if (boundary === 'new') await page.locator('#newDraftBtn').click();
        else { await page.locator('[data-action-key="copy:replacement"]').click(); await page.waitForFunction(() => ImageGen.els.prompt.value === 'prompt-replacement'); }
      }
      if (boundary === 'reuse') await page.evaluate(() => { window.firstHistoryAction = historyAction; clickHistory('reuse', 'reuse B'); });
      const before = await page.evaluate(() => ({ prompt: ImageGen.els.prompt.value, resolution: ImageGen.els.resolution.value, references: ImageGen.state.referenceImages }));
      await page.evaluate(async () => { releaseHistorySave(); await (window.firstHistoryAction || historyAction); window.firstHistoryAction = null; await ImageGen.flushWorkspace(); });
      assert.equal(await page.evaluate(() => historyRunCalls), 0, `${boundary} invalidates delayed regeneration before handleRun`);
      assert.deepEqual(await page.evaluate(() => ({ prompt: ImageGen.els.prompt.value, resolution: ImageGen.els.resolution.value, references: ImageGen.state.referenceImages })), before);
    }
    // Unchanged A alone may reach the central fee confirmation; cancellation still makes zero POSTs.
    await page.evaluate(() => { deferHistorySave(); clickHistory('regenerate', 'unchanged cancelled A'); });
    await page.evaluate(async () => { releaseHistorySave(); await historyAction; });
    assert.equal(await page.evaluate(() => historyRunCalls), 1);
    assert.equal(generationPosts, 0);
    allowGeneration = true;
    await page.evaluate(() => { window.confirm = () => true; deferHistorySave(); clickHistory('regenerate', 'unchanged submitted A'); });
    await page.evaluate(async () => { releaseHistorySave(); await historyAction; });
    assert.equal(generationPosts, 1); assert.equal(generationRequests[0].prompt, 'unchanged submitted A');
    allowGeneration = false;
    await page.locator('#detailNewDraftBtn').click();
    // A failed actual IndexedDB write is displayed once, handled by the DOM action, and remains retryable.
    for (const action of ['reuse', 'regenerate']) {
      await page.evaluate(action => {
        window.confirm = () => true; saveFailureMessages.length = 0;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {
          const request = put.apply(this, args);
          if (this.transaction.db.name === 'imageGenWorkspace') { this.transaction.abort(); IDBObjectStore.prototype.put = put; }
          return request;
        };
        clickHistory(action, `quota ${action}`);
      }, action);
      await page.evaluate(() => historySettled);
      assert.equal(await page.evaluate(() => saveFailureMessages.length), 1);
      assert.match(await page.locator('#status').textContent(), /工作区保存失败/);
      assert.equal(await page.locator('#prompt').inputValue(), `quota ${action}`);
      assert.equal(generationPosts, 1);
      await page.evaluate(() => ImageGen.saveWorkspaceDraft());
      assert.equal((await page.evaluate(() => readAuditStore('imageGenWorkspace', 'accounts', 'workspace:a@test.invalid'))).draft.prompt, `quota ${action}`);
    }
    assert.deepEqual(await page.evaluate(() => unhandledHistory), []);
    // Account changes also invalidate an unchanged delayed history continuation.
    await page.evaluate(() => { deferHistorySave(); clickHistory('regenerate', 'old account A'); });
    const runCount = await page.evaluate(() => historyRunCalls);
    await logout(); await login('history-switch@test.invalid');
    await page.evaluate(async () => { releaseHistorySave(); await historyAction; });
    assert.equal(await page.evaluate(() => historyRunCalls), runCount);
    await logout(); await login('a@test.invalid');
    // Rejected reads from the old account may not repopulate account-owned DOM.
    await page.evaluate(() => {
      const request = ImageGen.requestJson;
      ImageGen.requestJson = url => {
        if (url === '/api/me/logs?limit=100') return new Promise((_, reject) => { window.rejectOldHistory = () => reject(new Error('old history failure')); });
        if (url === '/api/admin/users') return new Promise((_, reject) => { window.rejectOldAdmin = () => reject(new Error('old admin failure')); });
        return request(url);
      };
      window.oldHistoryRead = ImageGen.loadMyLogs(); window.oldAdminRead = ImageGen.loadAdminData();
      ImageGen.requestJson = request;
    });
    await page.evaluate(async () => {
      await ImageGen.recoverPendingGeneration();
      const request = ImageGen.requestJson;
      ImageGen.requestJson = url => url === '/api/me/tasks' ? new Promise(resolve => { window.resolveOldFeed = () => resolve({ ok: true, json: { tasks: [], activeCount: 0, limit: 3 } }); }) : request(url);
      window.oldFeedRead = ImageGen.recoverPendingGeneration(); ImageGen.requestJson = request;
      Notification.permission = 'default';
      Notification.requestPermission = () => new Promise(resolve => { window.resolveOldPermission = () => resolve('granted'); });
      ImageGen.els.notifyToggle.checked = true; window.oldPermissionRequest = ImageGen.handleNotifyToggle();
    });
    // Account privacy before delayed restore: clear live DOM, cloned detail, editor and admin fields.
    await page.evaluate(async () => {
      ImageGen.els.editAnnotationText.value = 'A private annotation'; ImageGen.saveEditAnnotation();
      ImageGen.els.editPrompt.value = 'A edit prompt'; ImageGen.els.editAppendToggle.checked = false;
      ImageGen.state.adminLogs = [{ prompt: 'A secret' }];
      for (const id of ['myLogsList', 'adminUsersBody', 'adminLogsBody', 'previewHistoryDetailContent']) document.getElementById(id).textContent = 'A private DOM';
      await ImageGen.saveWorkspaceDraft();
      localStorage.setItem('imageGenEditAnnotation:b@test.invalid', 'B annotation');
    });
    tasks = []; await logout();
    await page.evaluate(async () => { rejectOldHistory(); rejectOldAdmin(); await Promise.all([oldHistoryRead, oldAdminRead]); });
    assert.equal(await page.locator('#previewHistoryDetailContent').textContent(), '');
    assert.doesNotMatch(await page.locator('#myLogsList').textContent(), /old history/);
    assert.doesNotMatch(await page.locator('#adminStatus').textContent(), /old admin/);
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        const request = open(...args);
        if (args[0] === 'imageGenWorkspace') {
          let handler;
          Object.defineProperty(request, 'onsuccess', { set(fn) { handler = fn; }, get() { return handler; } });
          request.addEventListener('success', () => { window.releaseRestore = () => handler(); });
          indexedDB.open = open;
        }
        return request;
      };
    });
    await page.locator('#emailInput').fill('b@test.invalid'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => Boolean(window.releaseRestore));
    assert.equal(await page.locator('#editAnnotationText').inputValue(), 'B annotation');
    assert.equal(await page.locator('#editPrompt').inputValue(), '');
    assert.equal(await page.locator('#editAppendToggle').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => ImageGen.state.adminLogs), []);
    for (const id of ['myLogsList', 'adminUsersBody', 'adminLogsBody', 'previewHistoryDetailContent']) assert.doesNotMatch(await page.locator(`#${id}`).textContent(), /A private/);
    await page.evaluate(async () => {
      resolveOldFeed(); resolveOldPermission();
      await Promise.all([oldFeedRead, oldPermissionRequest]);
      if (ImageGen.isNotifyEnabled()) throw new Error('old permission grant enabled next account preference');
      if (document.querySelector('.task-notice').textContent) throw new Error('old account feed populated next account notice');
      releaseRestore();
    });
    await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    await page.evaluate(() => ImageGen.saveWorkspaceDraft());
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    assert.equal(await page.locator('#editAnnotationText').inputValue(), 'B annotation');
    assert.equal(await page.evaluate(() => notifications.length), 0, 'another account never receives historical completion notifications');
    // Existing B workspace overlays B's account preference, never A's previous controls.
    await page.evaluate(async () => { ImageGen.els.editAnnotationText.value = 'B saved draft annotation'; ImageGen.els.editAppendToggle.checked = false; await ImageGen.saveWorkspaceDraft(); });
    await logout(); await login('a@test.invalid');
    assert.equal(await page.locator('#editAnnotationText').inputValue(), 'A private annotation');
    await logout(); await login('b@test.invalid');
    assert.equal(await page.locator('#editAnnotationText').inputValue(), 'B saved draft annotation');
    assert.equal(await page.locator('#editAppendToggle').isChecked(), false);
    // Legacy migration: durable import first, failure leaves source; cleanup interruption is idempotent.
    await logout();
    await page.evaluate(() => {
      localStorage.setItem('imageGenPendingRequest:c@test.invalid', JSON.stringify({ idempotencyKey: 'unknown-c', ownerEmail: 'c@test.invalid', status: 'submission_unknown', settings: { prompt: 'unresolved evidence', referenceImageCount: 2 }, hasReferencePayload: true }));
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const request = put.apply(this, args);
        if (this.transaction.db.name === 'imageGenWorkspace') { this.transaction.abort(); IDBObjectStore.prototype.put = put; }
        return request;
      };
    });
    await page.locator('#emailInput').fill('c@test.invalid'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => ImageGen.els.status.textContent.includes('保存失败'));
    assert.ok(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:c@test.invalid')));
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    assert.equal(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:c@test.invalid')), null);
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    await page.locator('#taskCapsule').click();
    assert.equal(await page.locator('.task-card').count(), 1);
    assert.match(await page.locator('.task-card').textContent(), /unresolved evid/);
    // Interrupted cleanup preserves the committed import; repeated startup consumes only once.
    await page.keyboard.press('Escape'); await logout();
    await page.evaluate(async () => {
      await ImageGen.savePendingRequest({ idempotencyKey: 'terminal-d', ownerEmail: 'd@test.invalid', taskId: 'done-d', status: 'completed', settings: { prompt: 'terminal evidence', image_urls: ['data:image/png;base64,AA=='] } }, 'd@test.invalid');
      const consume = ImageGen.consumeLegacyPendingRequest;
      ImageGen.consumeLegacyPendingRequest = async () => { ImageGen.consumeLegacyPendingRequest = consume; throw new Error('interrupted cleanup'); };
    });
    await page.locator('#emailInput').fill('d@test.invalid'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => ImageGen.els.status.textContent.includes('interrupted cleanup'));
    assert.ok(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:d@test.invalid')));
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    assert.equal(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:d@test.invalid')), null);
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    await page.locator('#taskCapsule').click(); assert.equal(await page.locator('.task-card').count(), 0, 'consumed terminal evidence never resurrects after aging out');
    await page.keyboard.press('Escape'); await logout();
    await page.evaluate(async () => {
      await ImageGen.savePendingRequest({ idempotencyKey: 'full-e', status: 'submission_unknown', settings: { prompt: 'full evidence', image_urls: ['data:image/png;base64,AQ==', 'data:image/png;base64,Ag=='] } }, 'e@test.invalid');
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function(...args) {
        const request = get.apply(this, args);
        if (this.transaction.db.name === 'imageGenRecovery') { this.transaction.abort(); IDBObjectStore.prototype.get = get; }
        return request;
      };
    });
    await login('e@test.invalid');
    const compact = await page.evaluate(() => readAuditStore('imageGenWorkspace', 'accounts', 'workspace:e@test.invalid'));
    assert.equal(compact.tasks[0].recovery.settings.image_urls, undefined);
    assert.equal(compact.tasks[0].recovery.legacySourceReadComplete, false);
    assert.deepEqual(await page.evaluate(async () => (await readAuditStore('imageGenRecovery', 'pending', 'imageGenPendingRequest:e@test.invalid')).settings.image_urls), ['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']);
    assert.ok(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:e@test.invalid')));
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    const upgraded = await page.evaluate(() => readAuditStore('imageGenWorkspace', 'accounts', 'workspace:e@test.invalid'));
    assert.equal(upgraded.tasks.length, 1);
    assert.deepEqual(upgraded.tasks[0].recovery.settings.image_urls, ['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']);
    assert.equal(upgraded.tasks[0].recovery.legacyRecoveryComplete, true);
    assert.equal(await page.evaluate(() => readAuditStore('imageGenRecovery', 'pending', 'imageGenPendingRequest:e@test.invalid')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('imageGenPendingRequest:e@test.invalid')), null);
    await page.reload(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled);
    assert.deepEqual((await page.evaluate(() => readAuditStore('imageGenWorkspace', 'accounts', 'workspace:e@test.invalid'))).tasks[0].recovery.settings.image_urls, upgraded.tasks[0].recovery.settings.image_urls);
    assert.equal(generationPosts, 1);
    assert.deepEqual(errors, []);
    console.log('PASS frontend production composition: locks/counts, notifications, deferred references/copy, actual history DOM delayed-save revision/cancel/account/quota, account isolation, migration failed GET/full-evidence upgrade/idempotency');
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
