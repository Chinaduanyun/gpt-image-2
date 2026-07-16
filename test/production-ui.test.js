const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getStaticPath, serveStatic } = require('../routes/static');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'workspace.css'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(root, 'workspace-shell.js'), 'utf8');
const domJs = fs.readFileSync(path.join(root, 'app/dom.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function idCount(id) {
  return (html.match(new RegExp(`\\bid=["']${escapeRegExp(id)}["']`, 'g')) || []).length;
}

function tagForId(id) {
  const match = html.match(new RegExp(`<([a-z0-9-]+)\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, 'i'));
  return match ? { tag: match[1].toLowerCase(), markup: match[0] } : null;
}

function selectValues(id) {
  const match = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
  assert.ok(match, `missing select #${id}`);
  return [...match[1].matchAll(/<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>/gi)].map((option) => option[1]);
}

function staticResponse(method, pathname, headers = {}) {
  return new Promise((resolve) => {
    const result = { statusCode: 0, headers: {}, body: undefined };
    const res = {
      writeHead(statusCode, responseHeaders) {
        result.statusCode = statusCode;
        result.headers = responseHeaders;
      },
      end(body) {
        result.body = body;
        resolve(result);
      }
    };
    serveStatic({ method, headers }, res, pathname);
  });
}

class FakeClassList {
  constructor(...names) {
    this.values = new Set(names);
  }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor(id, { dataset = {}, hidden = false, classes = [] } = {}) {
    this.id = id;
    this.dataset = dataset;
    this.hidden = hidden;
    this.classList = new FakeClassList(...classes);
    this.listeners = new Map();
    this.attributes = new Map();
    this.focused = false;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  click(target = this) {
    const event = { currentTarget: this, target };
    for (const listener of this.listeners.get('click') || []) listener(event);
  }
}

function navigationHarness({ appHidden = false, hash = '' } = {}) {
  const appShell = new FakeElement('appShell', { classes: appHidden ? ['hidden'] : [] });
  const adminButton = new FakeElement('adminToggleBtn', { dataset: { previewNav: 'admin' } });
  const adminPanel = new FakeElement('adminPanel', { classes: ['hidden'] });
  const historyList = new FakeElement('myLogsList');
  const workspaceButton = new FakeElement('workspaceNav', { dataset: { previewNav: 'workspace' }, classes: ['is-active'] });
  const libraryButton = new FakeElement('libraryNav', { dataset: { previewNav: 'library' } });
  const workspaceView = new FakeElement('workspaceView', { dataset: { previewView: 'workspace' } });
  const libraryView = new FakeElement('libraryView', { dataset: { previewView: 'library' }, hidden: true });
  const adminView = new FakeElement('adminView', { dataset: { previewView: 'admin' }, hidden: true });
  const workspaceTitle = new FakeElement('workspaceTitle');
  const libraryTitle = new FakeElement('libraryTitle');
  const adminTitle = new FakeElement('adminTitle');
  const elements = new Map([
    ['appShell', appShell], ['adminToggleBtn', adminButton], ['adminPanel', adminPanel],
    ['myLogsList', historyList], ['workspaceTitle', workspaceTitle], ['libraryTitle', libraryTitle], ['adminTitle', adminTitle]
  ]);
  const navButtons = [workspaceButton, libraryButton, adminButton];
  const views = [workspaceView, libraryView, adminView];
  const windowListeners = new Map();
  const window = {
    location: { hash },
    history: {
      replaceState(_state, _title, hash) { window.location.hash = hash; }
    },
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: true }; },
    setTimeout(callback) { callback(); },
    addEventListener(type, listener) { windowListeners.set(type, listener); }
  };
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) {
      if (selector === '[data-preview-nav]') return navButtons;
      if (selector === '[data-preview-view]') return views;
      return [];
    }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }

  adminButton.addEventListener('click', () => adminPanel.classList.toggle('hidden'));
  vm.runInNewContext(workspaceJs, { window, document, MutationObserver, Set });

  return {
    window, windowListeners, appShell, adminButton, adminPanel, historyList,
    workspaceButton, libraryButton, workspaceView, libraryView, adminView,
    workspaceTitle, libraryTitle, adminTitle
  };
}

test('production page provides every existing DOM binding exactly once', () => {
  const requiredIds = [...domJs.matchAll(/\$\('#([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(requiredIds.length > 60);
  for (const id of requiredIds) assert.equal(idCount(id), 1, `#${id} must exist exactly once`);

  const expectedTags = {
    emailInput: 'input', loginBtn: 'button', model: 'select', prompt: 'textarea',
    referenceFileInput: 'input', aspectRatio: 'select', resolution: 'select', imageCount: 'select',
    advancedSettings: 'details', quality: 'select', outputFormat: 'select', outputCompression: 'input',
    runBtn: 'button', clearBtn: 'button', generationSteps: 'ol', resultGrid: 'div',
    historySearchInput: 'input', historyFilterSelect: 'select', previewHistoryDialog: 'dialog',
    previewHistoryDialogClose: 'button', previewHistoryDetailImage: 'img',
    previewHistoryDetailGallery: 'div', previewHistoryDetailContent: 'section',
    adminUsersBody: 'tbody', adminLogsBody: 'tbody'
  };
  for (const [id, tag] of Object.entries(expectedTags)) assert.equal(tagForId(id)?.tag, tag, `#${id} must be <${tag}>`);

  assert.match(tagForId('referenceFileInput').markup, /\btype="file"/i);
  assert.match(tagForId('referenceFileInput').markup, /\bmultiple\b/i);
  assert.match(tagForId('referenceFileInput').markup, /image\/png,image\/jpeg,image\/webp/i);
  assert.match(tagForId('outputCompression').markup, /\btype="range"/i);
});

test('production page preserves selectable values, progress steps and asset order', () => {
  assert.deepEqual(selectValues('model'), ['gpt-image-2', 'gpt-image-2-official']);
  assert.deepEqual(selectValues('resolution'), ['1k', '2k', '4k']);
  assert.deepEqual(selectValues('imageCount'), ['1', '2', '3', '4']);
  assert.deepEqual(selectValues('quality'), ['low', 'medium', 'high']);
  assert.deepEqual(selectValues('outputFormat'), ['png', 'jpeg', 'webp']);
  assert.deepEqual(selectValues('historyFilterSelect'), ['all', 'completed', 'failed', 'partial', 'active', 'with-reference']);
  assert.deepEqual(
    [...html.matchAll(/\bdata-step="([^"]+)"/g)].map((match) => match[1]),
    ['validate', 'submit', 'queued', 'poll', 'result', 'done']
  );

  const styles = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(styles, ['./styles.css', './workspace.css']);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    './config.example.js', './app/state.js', './app/dom.js', './app/utils.js', './app/pricing.js',
    './app/auth.js', './app/references.js', './app/generation.js', './app/results.js', './app/history.js',
    './app/admin.js', './app/main.js', './workspace-shell.js'
  ]);
});

test('production assets contain no preview demo or secret-bearing configuration', () => {
  assert.match(html, /<title>Image Studio · 图片生成工作台<\/title>/);
  assert.doesNotMatch(html, /设计预览|preview\.(?:css|js)/);
  assert.doesNotMatch(
    `${html}\n${workspaceJs}`,
    /本地预览|界面示例|preview-demo|纯色示例图片|#7868e6|data-preview-demo/
  );
  assert.doesNotMatch(html, /config\.local\.js|runtime\.env|apimark\.env|packy\.env|poloai\.env|\.data\//i);
  assert.doesNotMatch(workspaceJs, /\bfetch\b|requestJson|\/api\/|localStorage|sessionStorage|indexedDB|ImageGen\.state/);
});

test('production composer keeps prompt content in natural grid rows', () => {
  assert.match(workspaceCss, /\.preview-composer-scroll\s*\{[\s\S]*?grid-auto-rows:\s*max-content;/);
  assert.match(workspaceCss, /\.preview-prompt-field\s*\{[\s\S]*?min-height:\s*auto;/);
  assert.match(workspaceCss, /\.preview-prompt-field textarea\s*\{[\s\S]*?height:\s*172px;[\s\S]*?max-height:\s*360px;/);
  assert.doesNotMatch(workspaceCss, /\.preview-prompt-field\s*\{[^}]*min-height:\s*0;/);
});

test('production library uses image-first cards and delegated artwork details', () => {
  assert.equal(idCount('previewHistoryDialog'), 1);
  assert.equal(idCount('previewHistoryDetailContent'), 1);
  assert.match(workspaceCss, /#myLogsList \.history-images[\s\S]*?aspect-ratio:\s*1\s*\/\s*1;/);
  assert.match(workspaceJs, /style\.aspectRatio\s*=/);
  assert.match(workspaceCss, /#myLogsList \.history-main\s*\{[\s\S]*?display:\s*none;/);
  assert.match(workspaceCss, /\.preview-history-summary-text\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(workspaceJs, /dataset\.previewHistoryDetail\s*=\s*['"]true['"]/);
  assert.match(workspaceJs, /historyDialog\.showModal\(\)/);
  assert.match(workspaceJs, /historyDetailContent\.replaceChildren/);
  assert.match(workspaceJs, /original\.click\(\)/);
});

test('production navigation switches views and delegates admin visibility', () => {
  const harness = navigationHarness();
  assert.equal(harness.workspaceView.hidden, false);
  assert.equal(harness.libraryView.hidden, true);
  assert.equal(harness.window.location.hash, '#workspace');

  harness.libraryButton.click();
  assert.equal(harness.workspaceView.hidden, true);
  assert.equal(harness.libraryView.hidden, false);
  assert.equal(harness.libraryTitle.focused, true);
  assert.equal(harness.window.location.hash, '#library');

  harness.adminButton.click();
  assert.equal(harness.adminPanel.classList.contains('hidden'), false);
  assert.equal(harness.adminView.hidden, false);
  assert.equal(harness.adminTitle.focused, true);
  assert.equal(harness.window.location.hash, '#admin');

  harness.workspaceButton.click();
  assert.equal(harness.adminPanel.classList.contains('hidden'), true);
  assert.equal(harness.workspaceView.hidden, false);
  assert.equal(harness.window.location.hash, '#workspace');

  harness.libraryButton.click();
  harness.historyList.click({ closest() { return { dataset: { historyAction: 'reuse' } }; } });
  assert.equal(harness.workspaceView.hidden, false);
  assert.equal(harness.window.location.hash, '#workspace');

  harness.adminButton.classList.add('hidden');
  harness.window.location.hash = '#admin';
  harness.windowListeners.get('hashchange')();
  assert.equal(harness.workspaceView.hidden, false);
  assert.equal(harness.adminView.hidden, true);
});

test('production navigation preserves deep links while authentication is restoring', () => {
  const library = navigationHarness({ appHidden: true, hash: '#library' });
  assert.equal(library.window.location.hash, '#library');
  assert.equal(library.workspaceView.hidden, false);
  assert.equal(library.libraryView.hidden, true);

  const admin = navigationHarness({ appHidden: true, hash: '#admin' });
  assert.equal(admin.window.location.hash, '#admin');
  assert.equal(admin.workspaceView.hidden, false);
  assert.equal(admin.adminView.hidden, true);
});

test('production assets are exact-allowlisted while preview and private paths are denied', () => {
  assert.match(getStaticPath('/'), /index\.html$/);
  assert.match(getStaticPath('/index.html'), /index\.html$/);
  assert.match(getStaticPath('/workspace.css'), /workspace\.css$/);
  assert.match(getStaticPath('/workspace-shell.js'), /workspace-shell\.js$/);
  assert.equal(getStaticPath('/preview.html'), null);
  assert.equal(getStaticPath('/preview.css'), null);
  assert.equal(getStaticPath('/preview.js'), null);
  assert.equal(getStaticPath('/workspace.map'), null);
  assert.equal(getStaticPath('/config.local.js'), null);
  assert.equal(getStaticPath('/runtime.env'), null);
  assert.equal(getStaticPath('/.data/app-data.json'), null);
  assert.equal(getStaticPath('/../runtime.env'), null);
});

test('production static responses use correct MIME, no-cache/ETag and method handling', async () => {
  for (const pathname of ['/', '/index.html']) {
    const page = await staticResponse('GET', pathname);
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['Cache-Control'], 'no-cache');
    assert.match(page.headers.ETag, /^"[0-9a-f]{40}"$/);
    assert.match(page.body.toString('utf8'), /Image Studio · 图片生成工作台/);

    // A matching If-None-Match revalidates to a bodyless 304.
    const revalidated = await staticResponse('GET', pathname, { 'if-none-match': page.headers.ETag });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body, undefined);
    assert.equal(revalidated.headers.ETag, page.headers.ETag);
  }

  const css = await staticResponse('GET', '/workspace.css');
  assert.equal(css.statusCode, 200);
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');

  const script = await staticResponse('HEAD', '/workspace-shell.js');
  assert.equal(script.statusCode, 200);
  assert.equal(script.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(script.body, undefined);

  for (const pathname of ['/preview.html', '/preview.css', '/preview.js', '/config.local.js']) {
    const denied = await staticResponse('GET', pathname);
    assert.equal(denied.statusCode, 404);
  }
  const method = await staticResponse('POST', '/');
  assert.equal(method.statusCode, 405);
});

test('Docker image copies every production root asset and no preview asset', () => {
  assert.match(
    dockerfile,
    /COPY --chown=node:node server\.js index\.html styles\.css workspace\.css workspace-shell\.js config\.example\.js \.\//
  );
  assert.doesNotMatch(dockerfile, /\bpreview\.(?:html|css|js)\b/);
});


test('admin recovery UI only exposes the explicit refund-and-close action for safe unknown submissions', () => {
  const adminJs = fs.readFileSync(path.join(root, 'app/admin.js'), 'utf8');
  assert.match(adminJs, /canAdminRefundAndClose/);
  assert.match(adminJs, /status === 'submission_unknown'/);
  assert.match(adminJs, /!hasRootTask && !hasChildTask/);
  assert.match(adminJs, /refund-and-close/);
  assert.match(adminJs, /不会删除记录、不会重试或创建任务/);
  assert.match(adminJs, /data-admin-log-action/);
});

test('history explains why unsafe records cannot be hidden', () => {
  const historyJs = fs.readFileSync(path.join(root, 'app/history.js'), 'utf8');
  assert.match(historyJs, /提交状态尚未确认，不能隐藏/);
  assert.match(historyJs, /隐藏不会取消任务或退款/);
  assert.match(historyJs, /账务尚未结清，不能隐藏/);
});


test('safe current-request dismissal is limited to taskless submission_unknown records', () => {
  const generationJs = fs.readFileSync(path.join(root, 'app/generation.js'), 'utf8');
  const resultsJs = fs.readFileSync(path.join(root, 'app/results.js'), 'utf8');
  assert.match(generationJs, /isTasklessSubmissionUnknown/);
  assert.match(generationJs, /=== 'submission_unknown'/);
  assert.match(generationJs, /!pending\.taskId[\s\S]*?!pending\.batchId/);
  assert.match(generationJs, /不会退款、删除记录、重试或创建新任务/);
  assert.match(resultsJs, /await ns\.dismissTasklessSubmissionUnknown\(\)/);
  assert.match(resultsJs, /未退款、删除或重试任务/);
});
