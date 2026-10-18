// Isolated static-page integration: no app server, storage, ledger or generation.
// NODE_PATH=<existing playwright install>/node_modules node test/browser-history.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const origin = 'http://history.test';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const ledger = { id: 'ledger', type: 'balance_adjustment', kind: 'batch', prompt: 'ledger-only', status: 'completed' };

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_EXECUTABLE ? { executablePath: process.env.QA_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      const unexpected = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && route.request().method() === 'GET') {
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
          // Only the styles explicitly linked by the static page may be loaded.
          const styles = [...html.matchAll(/href="\.\/([^"?]+\.css)(?:\?[^\"]*)?"/g)].map((match) => `/${match[1]}`);
          if (styles.includes(url.pathname)) return route.fulfill({ contentType: 'text/css', body: fs.readFileSync(path.join(root, url.pathname.slice(1))) });
          if (url.pathname === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>' });
        }
        unexpected.push(`${route.request().method()} ${url.href}`);
        return route.abort();
      });
      await page.goto(origin);
      await page.evaluate(() => {
        window.ImageGen = {
          formatMicros: (value) => String(value ?? 0),
          state: { myLogs: [], historySearch: '', historyFilter: 'all' },
          els: Object.fromEntries(['myLogsList', 'historySearchInput', 'historyFilterSelect'].map((id) => [id, document.getElementById(id)]))
        };
        document.getElementById('loginPanel').classList.add('hidden');
        document.getElementById('userBar').classList.remove('hidden');
        document.getElementById('appShell').classList.remove('hidden');
      });
      for (const file of ['app/utils.js', 'app/history.js', 'workspace-shell.js']) {
        await page.addScriptTag({ path: path.join(root, file) });
      }
      await page.evaluate(() => {
        ImageGen.els.historyFilterSelect.addEventListener('change', ImageGen.handleHistoryFilter);
        ImageGen.els.historySearchInput.addEventListener('input', ImageGen.handleHistorySearch);
      });
      await page.locator('[data-preview-nav="library"]').click();
      const render = (logs) => page.evaluate((value) => {
        ImageGen.state.historySearch = '';
        ImageGen.state.historyFilter = 'all';
        ImageGen.els.historySearchInput.value = '';
        ImageGen.els.historyFilterSelect.value = 'all';
        ImageGen.renderMyLogs(value);
      }, logs);
      await render([ledger, { id: 'blank', type: ' ' }]);
      const filters = await page.locator('#historyFilterSelect option').evaluateAll((options) => options.map((option) => option.value));
      for (const filter of filters) {
        await page.locator('#historyFilterSelect').selectOption(filter);
        assert.match(await page.locator('#myLogsList').textContent(), /暂无作品/);
        assert.equal(await page.locator('#myLogsList [data-preview-history-detail], #myLogsList .history-row').count(), 0);
        await page.locator('#myLogsList .list-state').click();
        assert.equal(await page.locator('#previewHistoryDialog').evaluate((dialog) => dialog.open), false);
      }
      const batch = { id: 'batch', type: 'generation', kind: 'batch', batchId: 'batch_mock', prompt: 'normal batch', status: 'completed', settings: { n: 1 }, requestedCount: 1, imageUrls: ['/fixture.svg'], children: [{ index: 0, taskId: 'task_mock', status: 'completed' }] };
      for (const active of [false, true]) {
        await render([ledger, { ...batch, status: active ? 'processing' : 'completed', imageUrls: active ? [] : batch.imageUrls, children: [{ ...batch.children[0], status: active ? 'processing' : 'completed' }] }]);
        const trigger = page.locator('#myLogsList [data-preview-history-detail]');
        await trigger.waitFor();
        assert.equal(await page.locator('#myLogsList .history-row').count(), 1);
        assert.doesNotMatch(await page.locator('#myLogsList').textContent(), /ledger-only/);
        await trigger.click();
        assert.equal(await page.locator('#previewHistoryDialog').evaluate((dialog) => dialog.open), true);
        assert.match(await page.locator('#previewHistoryDetailContent').textContent(), /normal batch/);
        assert.match(await page.locator('#previewHistoryDetailContent').textContent(), /task_mock/);
        assert.equal(await page.locator('#previewHistoryDetailEmpty').evaluate((element) => element.hidden), !active);
        assert.equal(await page.locator('#previewHistoryDetailImage').evaluate((element) => element.hidden), active);
        assert.equal(await page.locator('#previewHistoryDetailContent [data-history-action="delete"]').count(), 0);
        await page.locator('#previewHistoryDialogClose').click();
      }
      for (const shape of [{ type: 'generation' }, { kind: 'task', billing: { settled: false } }]) {
        await render([{ id: 'unknown', ...shape, status: 'submission_unknown', chargedMicros: 306000, settled: false, billingVersion: 'fixed-quote-v2' }]);
        assert.equal(await page.locator('#myLogsList [data-history-action="delete"]').count(), 1);
        assert.equal(await page.locator('#myLogsList [data-history-action="delete-assets"]').count(), 0);
        await page.locator('#myLogsList [data-preview-history-detail]').click();
        assert.equal(await page.locator('#previewHistoryDetailContent [data-history-action="delete"]').count(), 1);
        assert.equal(await page.locator('#previewHistoryDetailContent [data-history-action="delete-assets"]').count(), 0);
        await page.locator('#previewHistoryDialogClose').click();
      }
      for (const status of ['submitting', 'submitted', 'processing', 'attention_required']) {
        await render([{ id: 'inflight', type: 'generation', status, settled: false }]);
        assert.equal(await page.locator('#myLogsList [data-history-action="delete"]').count(), 0);
      }
      await render([{ ...batch, status: 'submission_unknown', settled: false }]);
      assert.equal(await page.locator('#myLogsList [data-history-action="delete"]').count(), 0);
      const confirmation = await page.evaluate(async () => {
        let message; const calls = [];
        window.confirm = (text) => { message = text; return true; };
        ImageGen.requestJson = async (...args) => { calls.push(args); return { ok: true }; };
        ImageGen.setStatus = () => {};
        ImageGen.loadMyLogs = async () => {};
        await ImageGen.deleteHistoryLog('unknown');
        return { message, calls };
      });
      assert.match(confirmation.message, /不会取消任务或退款/);
      assert.match(confirmation.message, /管理员记录会保留/);
      assert.deepEqual(confirmation.calls, [['/api/me/logs/unknown', { method: 'DELETE' }]]);
      await page.locator('#historySearchInput').fill('not-found');
      await page.waitForFunction(() => ImageGen.state.historySearch === 'not-found');
      assert.match(await page.locator('#myLogsList').textContent(), /没有匹配的作品/);
      assert.equal(await page.locator('#myLogsList [data-preview-history-detail]').count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      await context.close();
      console.log(`PASS history static browser mock ${viewport.width}x${viewport.height}`);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
