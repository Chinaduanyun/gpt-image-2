const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness() {
  const pending = [], list = { innerHTML: '' };
  const state = { myLogs: [], historySearch: '', historyFilter: 'all', accountEpoch: 1, session: { token: 'a' } };
  const document = { hidden: false, getElementById: () => null, addEventListener() {} };
  const ns = { state, els: { myLogsList: list, refreshMyLogsBtn: {}, historySearchInput: {}, historyFilterSelect: {} },
    formatMicros: String, formatDate: String, escapeHtml: String, isSafeLinkUrl: () => true, setStatus() {},
    requestJson: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })),
    isAccountContextCurrent: (epoch, token) => epoch === state.accountEpoch && token === state.session?.token,
    getErrorMessage: (_result, fallback) => fallback };
  const context = { window: { ImageGen: ns, setTimeout, clearTimeout, confirm: () => true }, document, URLSearchParams, AbortController };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/history.js'), 'utf8'), context);
  const reply = (index, logs, more = false, total = logs.length) => pending[index].resolve({ ok: true, json: { logs, page: { total, limit: 24, hasMore: more, nextCursor: more ? `cursor-${index}` : null } } });
  return { ns, state, pending, reply, document };
}
const log = id => ({ id, type: 'generation', prompt: id, createdAt: `2026-01-${id}`, imageUrls: [], status: 'completed' });
test('gallery is on-demand, requests 24, deduplicates concurrent reads and appends unique IDs', async () => {
  const { ns, pending, reply, state } = harness();
  await ns.loadMyLogs(); await ns.ensureHistoryLibrary();
  assert.equal(pending.length, 0);
  const first = ns.setHistoryLibraryVisible(true);
  const duplicate = ns.ensureHistoryLibrary();
  assert.equal(pending.length, 1);
  assert.match(pending[0].url, /paged=1&limit=24&q=&filter=all$/);
  reply(0, [log('24'), log('23')], true, 125); await first; await duplicate;
  const next = ns.requestHistoryPage({ append: true });
  assert.match(pending[1].url, /cursor=cursor-0/);
  reply(1, [log('23'), log('22')], true, 125); await next;
  assert.deepEqual(Array.from(state.myLogs, log => log.id), ['24', '23', '22']);
  await ns.ensureHistoryLibrary(); assert.equal(pending.length, 2);
});
test('query reset and account reset abort requests and ignore late non-cooperative callbacks', async () => {
  const { ns, pending, reply, state } = harness();
  const first = ns.setHistoryLibraryVisible(true);
  state.historySearch = 'older prompt'; state.myLogs = [];
  const search = ns.requestHistoryPage({ reset: true });
  assert.equal(pending[0].options.signal.aborted, true);
  reply(0, [log('private-old')]); await first;
  assert.equal(state.myLogs.length, 0);
  assert.match(pending[1].url, /q=older\+prompt/);
  state.accountEpoch++; state.session.token = 'b'; ns.resetHistoryLibrary();
  reply(1, [log('private-a')]); await search;
  assert.equal(pending[1].options.signal.aborted, true);
  assert.equal(state.myLogs.length, 0);
});
test('hidden task completion marks dirty without fetching; visible completions coalesce', async () => {
  const { ns, pending, reply } = harness();
  ns.markHistoryDirty(); ns.markHistoryDirty(); await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(pending.length, 0);
  const first = ns.setHistoryLibraryVisible(true); reply(0, [log('24')]); await first;
  ns.markHistoryDirty(); ns.markHistoryDirty(); ns.markHistoryDirty();
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(pending.length, 2); reply(1, [log('24')]);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(pending.length, 2);
});
test('refresh reconciles through the loaded boundary instead of dropping older pages', async () => {
  const { ns, pending, reply, state } = harness();
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24')], true, 100); await read;
  read = ns.requestHistoryPage({ append: true }); reply(1, [log('23')], true, 100); await read;
  read = ns.loadMyLogs(); reply(2, [log('25'), log('24')], true, 101);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4); reply(3, [log('23'), log('22')], true, 101); await read;
  assert.deepEqual(Array.from(state.myLogs, log => log.id), ['25', '24', '23', '22']);
});
test('error does not trigger automatic retries and hiding aborts an in-flight page', async () => {
  const { ns, pending, state } = harness();
  const read = ns.setHistoryLibraryVisible(true);
  pending[0].resolve({ ok: false }); await read;
  await ns.ensureHistoryLibrary(); assert.equal(pending.length, 1);
  assert.equal(ns.getHistoryPageState().status, 'error');
  const retry = ns.loadMyLogs(); ns.setHistoryLibraryVisible(false);
  assert.equal(pending[1].options.signal.aborted, true);
  pending[1].resolve({ ok: true, json: { logs: [log('late')], page: {} } }); await retry;
  assert.equal(state.myLogs.length, 0);
});
test('thumbnail helper accepts only local archived originals and never remote fallback', () => {
  const ns = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/utils.js'), 'utf8'), { window: { ImageGen: ns }, URL });
  assert.equal(ns.storedImageThumbnailUrl('/api/stored-images/a.png'), '/api/stored-images/thumb/a.png');
  for (const value of ['https://external/a.png', '//host/api/stored-images/a.png', '/api/stored-images/thumb/a.png', '/api/stored-images/%2fetc', '/api/stored-images/a.png?q=x', '/api/stored-images/..']) assert.equal(ns.storedImageThumbnailUrl(value), '');
});

test('refresh failure retries from the head rather than incorrectly appending the next page', async () => {
  const { ns, pending, reply } = harness();
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24')], true, 100); await read;
  read = ns.loadMyLogs(); pending[1].resolve({ ok: false }); await read;
  assert.equal(ns.getHistoryPageState().status, 'error');
  read = ns.loadMyLogs();
  assert.doesNotMatch(pending[2].url, /cursor=/);
  reply(2, [log('24')], true, 100); await read;
});

test('hide invalidates an older in-flight refresh so deleted cards cannot reappear', async () => {
  const { ns, pending, reply, state } = harness();
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24'), log('23')], true, 100); await read;
  const stale = ns.loadMyLogs();
  const hiding = ns.deleteHistoryLog('24');
  assert.equal(pending[2].options.method, 'DELETE');
  pending[2].resolve({ ok: true }); await hiding;
  assert.equal(pending[1].options.signal.aborted, true);
  reply(1, [log('24'), log('23')], true, 100); await stale;
  assert.deepEqual(Array.from(state.myLogs, log => log.id), ['23']);
  assert.equal(ns.getHistoryPageState().total, 99);
});

test('expired signed load-more cursor recovers first page once with the same server query and filter', async () => {
  const { ns, pending, reply, state } = harness();
  state.historySearch = 'older prompt'; state.historyFilter = 'with-reference';
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24')], true, 100); await read;
  read = ns.requestHistoryPage({ append: true });
  pending[1].resolve({ ok: false, status: 400, json: { error: { code: 'history_cursor_invalid', message: 'expired' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3);
  assert.doesNotMatch(pending[2].url, /cursor=/);
  assert.match(pending[2].url, /q=older\+prompt&filter=with-reference/);
  assert.match(ns.getHistoryPageState().refreshNotice, /重新加载首页/);
  reply(2, [log('new-head')], true, 101); await read;
  assert.deepEqual(Array.from(state.myLogs, log => log.id), ['new-head']);
  assert.equal(ns.getHistoryPageState().status, 'loaded');
});
test('cursor recovery never loops if the replacement first page also rejects', async () => {
  const { ns, pending, reply } = harness();
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24')], true, 100); await read;
  read = ns.requestHistoryPage({ append: true });
  const expired = { ok: false, status: 400, json: { error: { code: 'history_cursor_invalid' } } };
  pending[1].resolve(expired); await new Promise(resolve => setImmediate(resolve));
  pending[2].resolve(expired); await read; await ns.ensureHistoryLibrary();
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(pending.length, 3);
  assert.equal(ns.getHistoryPageState().status, 'error');
});
test('other load-more errors do not trigger cursor recovery', async () => {
  const { ns, pending, reply } = harness();
  let read = ns.setHistoryLibraryVisible(true); reply(0, [log('24')], true, 100); await read;
  read = ns.requestHistoryPage({ append: true });
  pending[1].resolve({ ok: false, status: 400, json: { error: { code: 'different_error' } } }); await read;
  assert.equal(pending.length, 2);
  assert.equal(ns.getHistoryPageState().status, 'error');
});


function deleteItem(ns, id, assetsOnly) {
  return assetsOnly ? ns.handleHistoryClick({ target: { closest: () => ({ dataset: { historyAction: 'delete-assets', logId: id } }) } }) : ns.deleteHistoryLog(id);
}
for (const assetsOnly of [false, true]) {
  for (const responseTiming of ['while-loading', 'after-loaded']) {
    for (const includesTarget of [false, true]) {
      test(`delayed ${assetsOnly ? 'assets DELETE' : 'hide DELETE'} ${responseTiming} preserves newer query${includesTarget ? ' and reconciles its matching item' : ' and unrelated total'}`, async () => {
        const { ns, pending, reply, state } = harness();
        const target = { ...log('24'), imageUrls: ['/api/stored-images/24.png'] };
        let read = ns.setHistoryLibraryVisible(true); reply(0, [target], true, 100); await read;
        const deleting = deleteItem(ns, '24', assetsOnly);
        assert.equal(pending[1].options.method, 'DELETE');
        assert.equal(pending[1].url, `/api/me/logs/24${assetsOnly ? '/assets' : ''}`);
        state.historySearch = 'query B'; ns.els.historyFilterSelect.value = 'completed'; ns.handleHistoryFilter();
        const queryB = ns.requestHistoryPage();
        const queryBLogs = includesTarget ? [target, log('23')] : [log('23')];
        const finishDelete = async () => { pending[1].resolve({ ok: true }); await deleting; };
        if (responseTiming === 'while-loading') {
          await finishDelete();
          assert.equal(ns.getHistoryPageState().status, 'loading');
        }
        assert.equal(pending[2].options.signal.aborted, false, 'query A DELETE never aborts query B');
        reply(2, queryBLogs, true, 77); await queryB;
        if (responseTiming === 'after-loaded') await finishDelete();
        assert.deepEqual(Array.from(state.myLogs, log => log.id), ['23']);
        assert.equal(ns.getHistoryPageState().total, includesTarget ? 76 : 77);
        assert.equal(ns.getHistoryPageState().nextCursor, 'cursor-2');
        const append = ns.requestHistoryPage({ append: true });
        assert.match(pending[3].url, /q=query\+B&filter=completed&cursor=cursor-2/);
        reply(3, [log('22')], false, includesTarget ? 76 : 77); await append;
        assert.deepEqual(Array.from(state.myLogs, log => log.id), ['23', '22']);
      });
    }
  }
}
for (const filter of ['all', 'completed']) {
  test(`asset deletion under ${filter} preserves audit membership only when matching`, async () => {
    const { ns, pending, reply, state } = harness(); state.historyFilter = filter;
    const target = { ...log('24'), imageUrls: ['/api/stored-images/24.png'] }, unaffected = log('23');
    const first = ns.setHistoryLibraryVisible(true); reply(0, [target, unaffected], true, 100); await first;
    const deleting = deleteItem(ns, '24', true); pending[1].resolve({ ok: true }); await deleting;
    assert.equal(ns.getHistoryPageState().total, filter === 'completed' ? 99 : 100);
    assert.equal(ns.getHistoryPageState().nextCursor, 'cursor-0');
    assert.equal(state.myLogs.find(log => log.id === '23'), unaffected);
    if (filter === 'completed') assert.equal(state.myLogs.some(log => log.id === '24'), false);
    else { assert.equal(state.myLogs[0].assetsDeleted, true); assert.equal(state.myLogs[0].imageUrls.length, 0); }
  });
}
for (const timestampMode of ['equivalent-formats', 'different-times']) {
  test(`refresh crosses removed loaded boundary with parsed time and batch/group ID: ${timestampMode}`, async () => {
    const { ns, pending, reply, state } = harness();
    const records = Array.from({ length: 144 }, (_, i) => {
      const id = String(144 - i).padStart(3, '0');
      return { ...log(`standalone-${id}`), ...(i % 2 ? { id: `aggregate-${String(i).padStart(3, '0')}`, batchId: `group-${id}` } : { id: `group-${id}` }),
        createdAt: timestampMode === 'equivalent-formats' ? (i % 2 ? '2026-01-01T00:00:00Z' : '2025-12-31T19:00:00-05:00') : new Date(Date.UTC(2026, 0, 1, 0, 144 - i)).toISOString() };
    });
    let read = ns.setHistoryLibraryVisible(true); reply(0, records.slice(0, 24), true, 144); await read;
    read = ns.requestHistoryPage({ append: true }); reply(1, records.slice(24, 48), true, 144); await read;
    const previousBoundary = records[47];
    let remaining = records.filter(log => log.id !== previousBoundary.id);
    if (timestampMode === 'different-times') {
      // An older date can be lexically larger with a timezone offset; it still crosses the boundary.
      remaining = remaining.map((log, i) => i >= 47 ? { ...log, createdAt: new Date(Date.parse(log.createdAt) + 5 * 3600000).toISOString().replace('Z', '+05:00') } : log);
    }
    read = ns.loadMyLogs(); reply(2, remaining.slice(0, 24), true, 143);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 4);
    reply(3, remaining.slice(24, 48), true, 143); await read;
    assert.equal(pending.length, 4, 'refresh stops after two pages instead of fetching unseen remainder');
    assert.equal(state.myLogs.length, 48);
    assert.ok(records.slice(0, 47).every(log => state.myLogs.some(item => item.id === log.id)));
    assert.equal(state.myLogs.some(log => log.id === previousBoundary.id), false);
    assert.equal(state.myLogs.some(log => log.id === records[60].id), false);
  });
}
test('asset deletion invalidates a same-query stale refresh and keeps the all-filter audit card', async () => {
  const { ns, pending, reply, state } = harness();
  const target = { ...log('24'), imageUrls: ['/api/stored-images/24.png'] };
  const first = ns.setHistoryLibraryVisible(true); reply(0, [target], true, 100); await first;
  const stale = ns.loadMyLogs(), deleting = deleteItem(ns, '24', true);
  pending[2].resolve({ ok: true }); await deleting;
  assert.equal(pending[1].options.signal.aborted, true);
  reply(1, [target], true, 100); await stale;
  assert.equal(state.myLogs[0].assetsDeleted, true);
  assert.equal(state.myLogs[0].imageUrls.length, 0);
  assert.equal(ns.getHistoryPageState().total, 100);
});
test('delayed asset deletion patches a matching newer all-filter response without cancelling it', async () => {
  const { ns, pending, reply, state } = harness();
  const target = { ...log('24'), imageUrls: ['/api/stored-images/24.png'] };
  const first = ns.setHistoryLibraryVisible(true); reply(0, [target], true, 100); await first;
  const deleting = deleteItem(ns, '24', true);
  state.historySearch = 'query B'; state.myLogs = [];
  const newer = ns.requestHistoryPage({ reset: true });
  pending[1].resolve({ ok: true }); await deleting;
  assert.equal(pending[2].options.signal.aborted, false);
  reply(2, [target], true, 77); await newer;
  assert.equal(state.myLogs[0].assetsDeleted, true);
  assert.equal(state.myLogs[0].imageUrls.length, 0);
  assert.equal(ns.getHistoryPageState().total, 77);
});
