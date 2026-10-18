// Production script composition with a disposable >100-entry paged HTTP-contract mock.
// Backend pagination/thumbnail security and real-backend acceptance belong to integration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { handlePublicConfig } = require('../routes/public-config');
const root = path.join(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const work = index => ({ id: `work-${index}`, kind: 'task', type: 'generation', prompt: index === 3 ? 'older than first 100 searchable' : `artwork ${index}`, model: 'gpt-image-2', status: index === 2 ? 'failed' : index === 4 ? 'partial_success' : index === 5 ? 'processing' : 'completed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), settings: { n: 3, size: '1:1', resolution: '1k' }, requestedCount: 3, referenceImageCount: index === 6 ? 1 : 0, imageUrls: index === 2 ? [] : [0, 1, 2].map(n => `/api/stored-images/work-${index}-${n}.png`), billing: { settled: index !== 5 }, children: [] });
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER_EXECUTABLE });
  const base = `http://127.0.0.1:${server.address().port}`;
  const trace = [], errors = [];
  let works = Array.from({ length: 125 }, (_, i) => work(125 - i)), tasks = [], failNext = false, expireNext = false;
  let releaseSlow, slowStarted, holdDelete = null, holdReviewRead = null;
  const configRes = { writeHead() {}, end(body) { this.body = body; } }; handlePublicConfig({ method: 'GET' }, configRes);
  const config = JSON.parse(configRes.body);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  async function routes(route) {
    const req = route.request(), url = new URL(req.url());
    const email = req.headers().authorization?.replace('Bearer token-', '') || '';
    trace.push({ path: url.pathname, query: url.search, method: req.method(), email });
    let json = {};
    if (url.pathname === '/api/public-config') json = config;
    else if (url.pathname === '/api/auth/login') { const email = req.postDataJSON().email; json = { token: `token-${email}`, user: { email, balanceMicros: 100000000 } }; }
    else if (url.pathname === '/api/me') json = { user: { email, balanceMicros: 100000000 } };
    else if (url.pathname === '/api/me/tasks') json = { tasks: email.startsWith('b@') ? [] : tasks, activeCount: tasks.filter(task => task.active).length, limit: 3 };
    else if (url.pathname === '/api/me/logs') {
      assert.equal(url.searchParams.get('paged'), '1'); assert.equal(url.searchParams.get('limit'), '24');
      if (expireNext) { expireNext = false; return route.fulfill({ status: 400, json: { error: { code: 'history_cursor_invalid', message: 'expired signed cursor' } } }); }
      if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: 'temporary gallery error' } }); }
      const q = url.searchParams.get('q'), filter = url.searchParams.get('filter');
      if (q === 'slow query') { slowStarted?.(); await new Promise(resolve => { releaseSlow = resolve; }); }
      const selected = (email.startsWith('b@') ? [{ ...work(999), prompt: 'account B only' }] : works).filter(log => {
        if (q && !log.prompt.includes(q)) return false;
        return filter === 'completed' ? log.imageUrls.length > 0 : filter === 'failed' ? log.status === 'failed' : filter === 'partial' ? log.status === 'partial_success' : filter === 'active' ? log.status === 'processing' : filter === 'with-reference' ? log.referenceImageCount > 0 : true;
      });
      const boundary = url.searchParams.get('cursor');
      const start = boundary ? selected.findIndex(log => log.id === boundary) + 1 : 0;
      const logs = selected.slice(start, start + 24), hasMore = start + logs.length < selected.length;
      json = { logs, page: { limit: 24, total: selected.length, hasMore, nextCursor: hasMore ? logs.at(-1).id : null } };
      if (q === 'review query B' && holdReviewRead) await holdReviewRead();
    } else if (url.pathname.startsWith('/api/me/logs/') && req.method() === 'DELETE') {
      const id = url.pathname.split('/')[4];
      if (holdDelete) await holdDelete();
      if (url.pathname.endsWith('/assets')) works = works.map(log => log.id === id ? { ...log, assetsDeleted: true, imageUrls: [] } : log);
      else works = works.filter(log => log.id !== id);
      json = { ok: true };
    } else if (url.pathname.startsWith('/api/stored-images/')) return route.fulfill({ contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: pixel });
    try { await route.fulfill({ json }); } catch (error) { if (!/closed|handled|aborted/i.test(error.message)) throw error; }
  }
  await context.route('**/api/**', routes);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const galleryReads = () => trace.filter(item => item.path === '/api/me/logs');
  const originalReads = () => trace.filter(item => item.path.startsWith('/api/stored-images/') && !item.path.startsWith('/api/stored-images/thumb/'));
  const thumbReads = () => trace.filter(item => item.path.startsWith('/api/stored-images/thumb/'));
  const loaded = count => page.waitForFunction(n => ImageGen.state.myLogs.length === n && ImageGen.getHistoryPageState().status === 'loaded', count);
  const login = async email => { await page.locator('#emailInput').fill(email); await page.locator('#loginBtn').click(); await page.waitForFunction(() => !ImageGen.els.runBtn.disabled); };
  const clearQuery = async () => { await page.locator('#historySearchInput').fill(''); await loaded(24); };
  try {
    await page.goto(base); await login('a@test.invalid');
    assert.equal(galleryReads().length, 0, 'workspace startup reads no gallery');
    await page.locator('[data-preview-nav="library"]').click(); await loaded(24);
    assert.equal(galleryReads().length, 1, 'only first page on entry');
    assert.equal(await page.locator('.history-row').count(), 24);
    assert.equal(await page.locator('.history-row img').count(), 24, 'one cover, not three originals');
    await page.waitForFunction(() => [...document.querySelectorAll('.history-row img')].some(img => img.complete && img.naturalWidth));
    assert.equal(originalReads().length, 0); assert.ok(thumbReads().length > 0);
    assert.match(await page.locator('#historyPageStatus').textContent(), /24 \/ 125/);
    await page.evaluate(() => { window.firstCard = document.querySelector('.history-row'); window.firstImage = firstCard.querySelector('img'); });
    const initialThumbReads = thumbReads().length;
    await page.locator('#refreshMyLogsBtn').click(); await loaded(24);
    assert.equal(await page.evaluate(() => firstCard === document.querySelector('.history-row') && firstImage === firstCard.querySelector('img')), true);
    assert.equal(thumbReads().length, initialThumbReads, 'unchanged refresh makes zero repeat thumbnail requests even with no-store');
    await page.locator('#historyPageSentinel').scrollIntoViewIfNeeded(); await loaded(48);
    assert.equal(new Set(await page.locator('.history-row').evaluateAll(rows => rows.map(row => row.dataset.logId))).size, 48);
    assert.equal(await page.evaluate(() => firstCard === document.querySelector('.history-row')), true);
    assert.equal(originalReads().length, 0);
    // Loaded older cards survive new-item refresh and scroll is not reset to the top.
    works.unshift(work(126));
    const scroll = await page.evaluate(() => scrollY);
    await page.evaluate(() => ImageGen.loadMyLogs()); await loaded(72);
    assert.equal(await page.locator('.history-row[data-log-id="work-78"]').count(), 1);
    assert.ok(await page.evaluate(() => scrollY) >= scroll - 100);
    await page.locator('#historySearchInput').fill('older than first 100'); await loaded(1);
    assert.match(await page.locator('.history-row').textContent(), /older than first 100/);
    assert.equal(await page.locator('.history-row').getAttribute('data-log-id'), 'work-3');
    await clearQuery();
    for (const [filter, id] of [['failed', 'work-2'], ['partial', 'work-4'], ['active', 'work-5'], ['with-reference', 'work-6']]) {
      await page.locator('#historyFilterSelect').selectOption(filter); await loaded(1);
      assert.equal(await page.locator('.history-row').getAttribute('data-log-id'), id, `${filter} searches all history`);
    }
    await page.locator('#historyFilterSelect').selectOption('completed'); await loaded(24);
    assert.match(await page.locator('#historyPageStatus').textContent(), /125/);
    await page.locator('#historyFilterSelect').selectOption('all'); await loaded(24);
    // Explicit errors do not spin in an intersecting sentinel; accessible button retries.
    failNext = true; await page.locator('#historyLoadMore').click();
    await page.waitForFunction(() => ImageGen.getHistoryPageState().status === 'error');
    const afterFailure = galleryReads().length; await page.waitForTimeout(350);
    assert.equal(galleryReads().length, afterFailure);
    await page.locator('#historyLoadMore').click(); await loaded(48);
    // Signed cursors expire on server restart: recover just one first page with unchanged query/filter.
    expireNext = true;
    const beforeExpired = galleryReads().length;
    await page.locator('#historyLoadMore').click(); await loaded(24);
    assert.equal(galleryReads().length, beforeExpired + 2);
    assert.match(galleryReads().at(-2).query, /cursor=/);
    assert.doesNotMatch(galleryReads().at(-1).query, /cursor=/);
    assert.match(galleryReads().at(-1).query, /q=&filter=all/);
    // Query abort, late response, and account reset are tested through production event wiring.
    const started = new Promise(resolve => { slowStarted = resolve; });
    await page.locator('#historySearchInput').fill('slow query'); await started;
    await page.locator('#historySearchInput').fill('older than first 100'); await loaded(1);
    releaseSlow(); await page.waitForTimeout(150);
    assert.equal(await page.locator('.history-row').getAttribute('data-log-id'), 'work-3');
    await clearQuery();
    await page.evaluate(() => scrollTo(0, 0));
    const first = page.locator('.history-row').first();
    const beforeDetail = originalReads().length;
    await first.locator('.history-thumb').click(); await page.locator('#previewHistoryDetailImage').evaluate(image => image.decode());
    assert.equal(originalReads().length, beforeDetail + 1, 'detail opens exactly one original');
    assert.equal(await page.locator('#previewHistoryDetailGallery img[src^="/api/stored-images/thumb/"]').count(), 3);
    assert.match(await page.locator('#previewHistoryOpenOriginal').getAttribute('href'), /work-126-0.png$/);
    await page.locator('#previewHistoryDetailGallery button').nth(1).click(); await page.locator('#previewHistoryDetailImage').evaluate(image => image.decode());
    assert.equal(originalReads().length, beforeDetail + 2, 'switching detail fetches exactly one additional original');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 402, height: 874 }, { width: 390, height: 844 }, { width: 390, height: 600 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.locator('.preview-history-dialog-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      const bounds = await page.evaluate(() => { const gallery = document.querySelector('.preview-history-detail-gallery-row').getBoundingClientRect(), content = document.querySelector('#previewHistoryDetailContent').getBoundingClientRect(); return { galleryBottom: gallery.bottom, contentTop: content.top }; });
      if (viewport.width <= 920) assert.ok(bounds.contentTop >= bounds.galleryBottom - 1, JSON.stringify(bounds));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Authoritative asset removal while details are open clears original sources and actions.
    works[0] = { ...works[0], assetsDeleted: true, imageUrls: [] };
    await page.evaluate(() => ImageGen.loadMyLogs()); await loaded(24);
    assert.equal(await page.locator('#previewHistoryDialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#previewHistoryDetailImage').getAttribute('src'), null);
    assert.equal(await page.locator('#previewHistoryOpenOriginal').getAttribute('href'), null);
    await page.locator('[data-log-id="work-125"] .history-thumb').click();
    await page.locator('#previewHistoryDetailContent [data-history-action="delete"]').click();
    await page.waitForFunction(() => !ImageGen.findHistoryLog('work-125'));
    assert.equal(await page.locator('.history-row[data-log-id="work-125"]').count(), 0);
    assert.equal(await page.locator('#previewHistoryDetailImage').getAttribute('src'), null);
    // Identical task feed polls reuse both drawer and capsule images/nodes.
    await page.locator('[data-preview-nav="workspace"]').click();
    tasks = [{ ...work(120), id: 'task-fixture', clientRequestId: 'task-fixture', taskId: 'task-fixture', active: false, children: [] }];
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.locator('#taskCapsule').click(); await page.locator('.task-card img').evaluate(image => image.decode());
    await page.evaluate(() => { window.drawerCard = document.querySelector('.task-card'); window.drawerImage = drawerCard.querySelector('img'); window.capsuleImage = document.querySelector('#taskCapsule img'); });
    const beforeFeed = thumbReads().length, beforeHidden = galleryReads().length;
    await page.evaluate(() => ImageGen.recoverPendingGeneration()); await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.evaluate(() => drawerCard === document.querySelector('.task-card') && drawerImage === drawerCard.querySelector('img') && capsuleImage === document.querySelector('#taskCapsule img')), true);
    assert.equal(thumbReads().length, beforeFeed); assert.equal(galleryReads().length, beforeHidden);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#taskCapsule').evaluate(el => el === document.activeElement), true);
    tasks = tasks.map(task => ({ ...task, active: true, status: 'processing', children: [] })); await page.evaluate(() => ImageGen.recoverPendingGeneration());
    tasks = tasks.map(task => ({ ...task, active: false, status: 'completed' })); await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.waitForTimeout(150); assert.equal(galleryReads().length, beforeHidden, 'hidden completion does not fetch gallery');
    await page.locator('[data-preview-nav="library"]').click(); await loaded(24);
    // Multiple child/group transitions in one feed produce one coalesced refresh.
    tasks = [120, 119, 118].map(index => ({ ...work(index), id: `active-${index}`, clientRequestId: `active-${index}`, active: true, status: 'processing', taskId: `task-${index}`, children: [] }));
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.locator('#taskCapsule').click();
    await page.evaluate(() => { window.unchangedTaskCard = document.querySelector('[data-action-key="open:active-119"]').closest('.task-card'); });
    tasks[0] = { ...tasks[0], prompt: 'changed task metadata only' };
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    assert.equal(await page.evaluate(() => unchangedTaskCard === document.querySelector('[data-action-key="open:active-119"]').closest('.task-card')), true, 'unrelated task changes preserve unchanged keyed cards');
    await page.keyboard.press('Escape');
    const beforeCompletion = galleryReads().length;
    tasks = tasks.map(task => ({ ...task, active: false, status: 'completed' }));
    await page.evaluate(() => ImageGen.recoverPendingGeneration());
    await page.waitForTimeout(300); await loaded(24);
    assert.equal(galleryReads().length, beforeCompletion + 1, 'one visible refresh per completion feed, not per child');
    const startedAccount = new Promise(resolve => { slowStarted = resolve; });
    await page.locator('#historySearchInput').fill('slow query'); await startedAccount;
    await page.locator('#logoutBtn').click(); await page.locator('#loginPanel').waitFor({ state: 'visible' });
    await login('b@test.invalid'); releaseSlow();
    await page.locator('[data-preview-nav="library"]').click(); await loaded(1);
    assert.equal(await page.locator('.history-row').getAttribute('data-log-id'), 'work-999');
    assert.doesNotMatch(await page.locator('#myLogsList').textContent(), /older than first 100|artwork 12/);
    // Cold direct #library restoration loads exactly one first page without eager workspace read.
    const cold = await browser.newContext({ viewport: { width: 402, height: 874 } });
    await cold.route('**/api/**', routes);
    await cold.addInitScript(() => { localStorage.setItem('imageGenEmail', 'a@test.invalid'); localStorage.setItem('imageGenToken', 'token-a@test.invalid'); });
    const coldPage = await cold.newPage(); coldPage.on('pageerror', error => errors.push(error.message));
    const beforeCold = galleryReads().length; await coldPage.goto(`${base}/#library`);
    await coldPage.waitForFunction(() => ImageGen.state.myLogs.length === 24 && ImageGen.getHistoryPageState().status === 'loaded');
    assert.equal(galleryReads().length, beforeCold + 1); await cold.close();
    // Review regressions run through production event handlers and actual delayed DELETE responses.
    const reviewContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await reviewContext.route('**/api/**', routes);
    await reviewContext.addInitScript(() => { localStorage.setItem('imageGenEmail', 'a@test.invalid'); localStorage.setItem('imageGenToken', 'token-a@test.invalid'); });
    const reviewPage = await reviewContext.newPage(); reviewPage.on('pageerror', error => errors.push(error.message)); reviewPage.on('dialog', dialog => dialog.accept());
    const reviewLoaded = count => reviewPage.waitForFunction(n => ImageGen.state.myLogs.length === n && ImageGen.getHistoryPageState().status === 'loaded', count);
    works = Array.from({ length: 125 }, (_, i) => work(125 - i)); tasks = [];
    await reviewPage.goto(`${base}/#library`); await reviewLoaded(24);
    for (const assetsOnly of [false, true]) for (const timing of ['while-loading', 'after-loaded']) {
      works = Array.from({ length: 30 }, (_, i) => ({ ...work(30 - i), prompt: 'review query B' }));
      const target = { ...work(500), prompt: 'query A item only' }; works.unshift(target);
      await reviewPage.evaluate(async () => { ImageGen.state.historySearch = ''; ImageGen.els.historySearchInput.value = ''; ImageGen.state.myLogs = []; await ImageGen.requestHistoryPage({ reset: true }); });
      await reviewLoaded(24);
      let releaseDelete, releaseQuery, notifyDelete, notifyQuery;
      const deletingStarted = new Promise(resolve => { notifyDelete = resolve; }), queryStarted = new Promise(resolve => { notifyQuery = resolve; });
      holdDelete = () => { notifyDelete(); return new Promise(resolve => { releaseDelete = resolve; }); };
      holdReviewRead = () => { notifyQuery(); return new Promise(resolve => { releaseQuery = resolve; }); };
      await reviewPage.evaluate(assets => {
        window.reviewDeleting = assets ? ImageGen.handleHistoryClick({ target: { closest: () => ({ dataset: { historyAction: 'delete-assets', logId: 'work-500' } }) } }) : ImageGen.deleteHistoryLog('work-500');
      }, assetsOnly);
      await deletingStarted;
      await reviewPage.locator('#historySearchInput').fill('review query B'); await queryStarted;
      if (timing === 'while-loading') {
        holdDelete = null; releaseDelete(); await reviewPage.evaluate(() => reviewDeleting);
        assert.equal(await reviewPage.evaluate(() => ImageGen.getHistoryPageState().status), 'loading');
      }
      holdReviewRead = null; releaseQuery(); await reviewLoaded(24);
      if (timing === 'after-loaded') { holdDelete = null; releaseDelete(); await reviewPage.evaluate(() => reviewDeleting); }
      assert.equal(await reviewPage.evaluate(() => ImageGen.getHistoryPageState().total), 30, `${assetsOnly ? 'assets' : 'hide'} ${timing}: unrelated B total unchanged`);
      assert.equal(await reviewPage.locator('.history-row[data-log-id="work-500"]').count(), 0);
      await reviewPage.evaluate(() => ImageGen.requestHistoryPage({ append: true })); await reviewLoaded(30);
      assert.equal(new Set(await reviewPage.locator('.history-row').evaluateAll(rows => rows.map(row => row.dataset.logId))).size, 30);
    }
    // Completed-filter deletion removes the image-free card; all-filter deletion keeps its audit card.
    for (const filter of ['completed', 'all']) {
      works = Array.from({ length: 30 }, (_, i) => work(30 - i));
      await reviewPage.evaluate(async selectedFilter => {
        ImageGen.state.historySearch = ''; ImageGen.els.historySearchInput.value = ''; ImageGen.state.historyFilter = selectedFilter;
        ImageGen.state.myLogs = []; await ImageGen.requestHistoryPage({ reset: true });
        window.unaffectedCover = document.querySelector('.history-row[data-log-id="work-29"] img');
      }, filter);
      await reviewLoaded(24);
      const totalBefore = await reviewPage.evaluate(() => ImageGen.getHistoryPageState().total);
      await reviewPage.evaluate(async () => ImageGen.handleHistoryClick({ target: { closest: () => ({ dataset: { historyAction: 'delete-assets', logId: 'work-30' } }) } }));
      await reviewLoaded(filter === 'completed' ? 23 : 24);
      assert.equal(await reviewPage.evaluate(() => ImageGen.getHistoryPageState().total), totalBefore - Number(filter === 'completed'));
      assert.equal(await reviewPage.locator('.history-row[data-log-id="work-30"]').count(), Number(filter === 'all'));
      assert.equal(await reviewPage.evaluate(() => unaffectedCover === document.querySelector('.history-row[data-log-id="work-29"] img')), true);
      if (filter === 'all') assert.equal(await reviewPage.locator('.history-row[data-log-id="work-30"] img').count(), 0);
    }
    // Equal-time groups with an externally removed boundary stay bounded at the crossed loaded range.
    works = Array.from({ length: 144 }, (_, i) => ({ ...work(144 - i), id: `equal-${String(144 - i).padStart(3, '0')}`, batchId: i % 2 ? `equal-${String(144 - i).padStart(3, '0')}` : undefined,
      createdAt: i % 2 ? '2026-01-01T00:00:00Z' : '2025-12-31T19:00:00-05:00' }));
    await reviewPage.evaluate(async () => { ImageGen.state.myLogs = []; await ImageGen.requestHistoryPage({ reset: true }); }); await reviewLoaded(24);
    await reviewPage.evaluate(() => ImageGen.requestHistoryPage({ append: true })); await reviewLoaded(48);
    works = works.filter(log => log.id !== 'equal-097');
    const readsBeforeBoundary = galleryReads().length;
    await reviewPage.evaluate(() => ImageGen.loadMyLogs()); await reviewLoaded(48);
    assert.equal(galleryReads().length, readsBeforeBoundary + 2);
    assert.equal(await reviewPage.locator('.history-row[data-log-id="equal-098"]').count(), 1);
    assert.equal(await reviewPage.locator('.history-row[data-log-id="equal-097"]').count(), 0);
    assert.equal(await reviewPage.locator('.history-row[data-log-id="equal-080"]').count(), 0);
    await reviewContext.close();
    assert.deepEqual(errors, []);
    const report = { galleryReads: galleryReads().length, thumbnailRequests: thumbReads().length, originalRequests: originalReads().length, entries: 125, viewports: 5, trace };
    fs.writeFileSync('/tmp/frontend-gallery-network-trace.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, trace: `${trace.length} requests saved to /tmp/frontend-gallery-network-trace.json` }));
  } finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
