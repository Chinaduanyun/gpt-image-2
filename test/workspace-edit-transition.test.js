const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/workspace.js'), 'utf8');
const start = source.indexOf('  ns.isWorkspaceEditLocked =');
const end = source.indexOf('  ns.applyWorkspaceLocks =', start);
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Run the actual workspace-owned transition with controllable hydration/storage.
function harness() {
  const task = { id: 'completed', status: 'completed', recovery: { idempotencyKey: 'original' } };
  const state = {
    selected: 'completed', revision: 0, restored: true, restoring: false, restoration: null,
    hydrating: null, editPreparation: null, draftHydrationError: null, registry: new Map([['completed', task]]),
    account: 'first', restores: 0, saves: 0, snapshots: 0, statuses: [],
    ns: { state: { edit: {}, isBusy: false }, updatePendingUi() {}, setEditStatus(message) { state.statuses.push(message); }, setEditEmptyStatus() {}, renderResult() {} }
  };
  const sandbox = vm.createContext(state);
  vm.runInContext(`
    const context = () => ({ account });
    const current = c => c.account === account;
    const showSnapshot = () => { snapshots++; };
    const restoreDraft = async () => {
      restores++; selected = ''; revision++;
      if (restoreGate) await restoreGate.promise;
      return true;
    };
    const persist = async () => { saves++; if (saveGate) await saveGate.promise; };
    ${source.slice(start, end)}
  `, Object.assign(sandbox, { restoreGate: null, saveGate: null }));
  return state;
}

test('workspace edit transition deduplicates hydration and preserves registry/recovery', async () => {
  const h = harness(); h.restoreGate = defer();
  const first = h.ns.prepareWorkspaceEdit(), second = h.ns.prepareWorkspaceEdit();
  assert.equal(first, second);
  assert.equal(h.ns.isWorkspaceEditLocked(), true);
  await Promise.resolve();
  assert.equal(h.restores, 1);
  h.restoreGate.resolve();
  assert.equal(await first, true);
  assert.equal(h.selected, ''); assert.equal(h.saves, 1);
  assert.equal(h.registry.get('completed').recovery.idempotencyKey, 'original');
  assert.equal(h.ns.isWorkspaceEditLocked(), false);
  await h.ns.prepareWorkspaceEdit();
  assert.equal(h.restores, 1, 'duplicate late tab entry cannot reset an already editable image');
});

test('workspace edit transition waits for restoration and existing hydration', async () => {
  const h = harness(), restoring = defer(), hydration = defer();
  h.restoring = true; h.restoration = restoring.promise; h.hydrating = { promise: hydration.promise };
  const pending = h.ns.prepareWorkspaceEdit();
  await Promise.resolve(); assert.equal(h.restores, 0);
  h.restoring = false; restoring.resolve();
  await Promise.resolve(); assert.equal(h.restores, 0);
  h.hydrating = null; hydration.resolve();
  assert.equal(await pending, true); assert.equal(h.restores, 1);
});

test('workspace edit transition refuses busy/readers and unavailable storage restoration', async () => {
  for (const flag of ['isBusy', 'imageLoading', 'referencesLoading', 'notRestored']) {
    const h = harness();
    if (flag === 'notRestored') h.restored = false;
    else if (flag === 'isBusy') h.ns.state.isBusy = true;
    else h.ns.state.edit[flag] = true;
    assert.equal(await h.ns.prepareWorkspaceEdit(), false, flag);
    assert.equal(h.selected, 'completed'); assert.equal(h.restores, 0); assert.equal(h.saves, 0);
    assert.match(h.statuses[0], /无法安全进入编辑/);
  }
});

test('workspace edit transition rolls back selection on decode/storage/revision failure', async () => {
  for (const failure of ['decode', 'storage', 'revision']) {
    const h = harness();
    if (failure === 'storage') h.saveGate = defer(); else h.restoreGate = defer();
    const pending = h.ns.prepareWorkspaceEdit();
    await Promise.resolve(); await Promise.resolve();
    if (failure === 'storage') h.saveGate.reject(new Error('disk full'));
    else if (failure === 'decode') h.restoreGate.reject(new Error('image unavailable'));
    else { h.revision++; h.restoreGate.resolve(); }
    assert.equal(await pending, false, failure);
    assert.equal(h.selected, 'completed'); assert.equal(h.snapshots, 1);
    assert.equal(h.registry.size, 1); assert.equal(h.ns.isWorkspaceEditLocked(), true);
  }
});

test('workspace edit transition never applies old account hydration after reset', async () => {
  const h = harness(); h.restoreGate = defer();
  const pending = h.ns.prepareWorkspaceEdit();
  await Promise.resolve();
  h.account = 'second'; h.selected = 'second-account-task';
  h.restoreGate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.selected, 'second-account-task'); assert.equal(h.saves, 0); assert.equal(h.snapshots, 0);
  assert.deepEqual(h.statuses, []);
});


test('workspace retry restores retained draft even when there is no selected task', async () => {
  const h = harness(); h.selected = ''; h.draftHydrationError = new Error('missing source');
  assert.equal(h.ns.isWorkspaceEditLocked(), true);
  assert.equal(await h.ns.prepareWorkspaceEdit(), true);
  assert.equal(h.restores, 1); assert.equal(h.saves, 1);
});

function startupHarness() {
  const saved = { selected: 'completed', draft: { prompt: 'keep me', edit: { sourceUrl: '/api/stored-images/missing.png', strokes: [{ x: 1 }], referenceImages: [{ value: 'reference' }] } }, tasks: [{ id: 'completed', recovery: { idempotencyKey: 'original' } }] };
  const h = {
    saved, selected: '', draft: null, registry: new Map(), restored: false, restoring: false, restoration: null,
    draftHydrationError: null, account: 'first', writes: [], synced: 0, snapshots: 0, errors: [],
    ns: { state: {}, updatePendingUi() {}, renderResult() {} }, window: { location: { hash: '#edit' } },
    gate: null
  };
  const sandbox = { ...h, structuredClone };
  vm.createContext(sandbox);
  const block = source.slice(source.indexOf('  async function restoreWorkspace() {'), source.indexOf('  const saveDraft ='));
  vm.runInContext(`
    const context = () => ({ account, email: account });
    const current = c => c.account === account;
    const storage = async () => saved;
    const captureDraft = () => { throw new Error('must not capture blank editor'); };
    const legacyRestore = async () => null;
    const restoreDraft = async () => { selected = ''; if (gate) await gate.promise; draftHydrationError = new Error('source 404'); throw draftHydrationError; };
    const showSnapshot = () => { snapshots++; };
    const persist = async () => { writes.push(structuredClone({ draft, selected, tasks: [...registry.values()] })); };
    const sync = () => { synced++; };
    const storageError = e => { errors.push(e.message); };
    ${block}
  `, sandbox);
  return sandbox;
}

test('workspace startup scopes saved editor hydration failure and retains draft/task recovery', async () => {
  const h = startupHarness();
  await h.ns.restorePendingRequest();
  assert.equal(h.restored, true); assert.equal(h.restoring, false);
  assert.equal(h.selected, 'completed'); assert.equal(h.snapshots, 1); assert.equal(h.synced, 1);
  assert.deepEqual(h.writes[0].draft, h.saved.draft);
  assert.equal(h.writes[0].tasks[0].recovery.idempotencyKey, 'original');
  assert.deepEqual(h.errors, []);
});

test('workspace startup hydration completion after account reset never persists old metadata', async () => {
  const h = startupHarness(); h.gate = defer();
  const pending = h.ns.restorePendingRequest();
  await Promise.resolve(); await Promise.resolve();
  h.account = 'second'; h.draft = { prompt: 'second account' }; h.restoring = false;
  h.gate.resolve(); await pending;
  assert.equal(h.writes.length, 0); assert.equal(h.synced, 0); assert.equal(h.snapshots, 0);
  assert.equal(h.draft.prompt, 'second account');
});


test('workspace edit transition rolls back revision invalidation during successful delayed persistence', async () => {
  const h = harness(); h.saveGate = defer();
  const pending = h.ns.prepareWorkspaceEdit();
  while (!h.saves) await Promise.resolve();
  assert.equal(h.selected, '');
  h.revision++;
  h.saveGate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.selected, 'completed'); assert.equal(h.snapshots, 1);
  assert.equal(h.ns.isWorkspaceEditLocked(), true);
  assert.match(h.statuses[0], /草稿已变化/);
});
