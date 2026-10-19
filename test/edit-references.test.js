const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const image = (bytes = 3, mime = 'png') => `data:image/${mime};base64,${Buffer.alloc(bytes).toString('base64')}`;
const file = (name = 'chair.png', size = 3, type = 'image/png') => ({ name, size, type });

function element() {
  return {
    value: '', textContent: '', disabled: false, checked: false, dataset: {}, children: [], attributes: {},
    classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return this.children.flatMap((child) => child.children.slice(-1)); },
    addEventListener() {}
  };
}

function harness() {
  const ns = {};
  const readers = [];
  const images = [];
  class Reader {
    constructor() { readers.push(this); }
    readAsDataURL(value) { this.file = value; }
    finish(value = image(this.file.size)) { this.result = value; this.onload(); }
    fail() { this.onerror(); }
  }
  class LoadedImage {
    constructor() { images.push(this); }
    finish() { this.naturalWidth = 100; this.naturalHeight = 80; this.onload(); }
  }
  const window = { ImageGen: ns, location: { hash: '#edit', href: 'https://test.invalid/', origin: 'https://test.invalid' }, confirm: () => true };
  const context = vm.createContext({ window, document: { createElement: element }, FileReader: Reader, Image: LoadedImage, URL, TextEncoder, console });
  for (const name of ['state', 'utils', 'auth', 'references', 'edit', 'edit-references']) {
    vm.runInContext(fs.readFileSync(path.join(root, `app/${name}.js`), 'utf8'), context);
  }
  ns.state.session = { token: 'test', user: { email: 'user@test.invalid' } };
  ns.els = Object.fromEntries([
    'editReferenceFileInput', 'editReferenceUploadBtn', 'editClearReferencesBtn', 'editReferenceCount',
    'editReferencePreviewGrid', 'editReferenceStatus', 'editSubmitBtn', 'editChangeImageBtn', 'editUploadBtn',
    'editUploadInput', 'editBaseCanvas', 'editEmptyStatus', 'editStatus', 'editPromptStats', 'editPrompt',
    'editAnnotationText', 'editAppendToggle', 'editAspectRatio', 'editResolution', 'editModel', 'model',
    'referenceFileInput', 'referenceStatus', 'referenceCount', 'referenceUploadBtn', 'clearReferencesBtn', 'referencePreviewGrid',
    'quality', 'outputFormat', 'outputCompression', 'prompt'
  ].map((key) => [key, element()]));
  ns.els.editAspectRatio.value = 'follow';
  ns.els.editResolution.value = '1k';
  ns.els.model.value = 'gpt-image-2';
  ns.els.editModel.value = 'gpt-image-2';
  ns.els.quality.value = 'high';
  ns.els.outputFormat.value = 'png';
  ns.els.editPrompt.value = '将图 1 的椅子换成图 2 的款式';
  ns.state.edit = ns.createEditState();
  Object.assign(ns.state.edit, { image: {}, naturalWidth: 100, naturalHeight: 80, strokes: [{}] });
  ns.hasPendingGeneration = () => Boolean(ns.state.pendingRequest);
  ns.setStatus = () => {};
  ns.renderReferences = () => {};
  ns.updatePromptStats = () => {};
  ns.syncGlobalModelFromEdit = () => {};
  ns.isOfficialModel = () => ns.els.model.value === 'gpt-image-2-official';
  ns.estimatePrice = () => ({ ok: true, unitMicros: 300000 });
  ns.formatMicros = (value) => `¥${value / 1000000}`;
  ns.composeEditedImage = () => ({ dataUrl: image() });
  const submitted = [];
  ns.runGeneration = async (settings) => { submitted.push(settings); };
  return { ns, window, readers, images, submitted };
}

async function addOne(h, f = file()) {
  const pending = h.ns.addEditReferenceFiles([f]);
  h.readers.at(-1).finish();
  await pending;
}

test('edit references preserve image order and never read or mutate creation references', async () => {
  const h = harness();
  const { ns } = h;
  const creation = [{ value: image(5), name: 'creation' }];
  ns.state.referenceImages = creation;
  await addOne(h);
  await addOne(h, file('style.png', 6));
  const settings = ns.getEditSettings(image(9), 'change');
  assert.deepEqual([...settings.image_urls], [image(9), image(3), image(6)]);
  assert.equal(ns.state.referenceImages, creation);
  assert.equal(ns.els.editReferenceCount.textContent, '2/15 张');
  assert.match(ns.els.editReferencePreviewGrid.children[0].children[1].textContent, /^图 2/);
  ns.removeEditReference(ns.state.edit.referenceImages[0].id);
  assert.match(ns.els.editReferencePreviewGrid.children[0].children[1].textContent, /^图 2 · style/);
  assert.match(ns.els.editReferenceStatus.textContent, /重新排列/);
  ns.clearEditReferences();
  assert.equal(ns.state.edit.referenceImages.length, 0);
  assert.equal(ns.state.edit.strokes.length, 1);
  assert.equal(ns.state.referenceImages, creation);
});

test('both model channels submit the composite first, with role guidance independent of annotation toggle', async () => {
  for (const model of ['gpt-image-2', 'gpt-image-2-official']) {
    const h = harness();
    h.ns.els.model.value = model;
    await addOne(h);
    await h.ns.handleEditSubmit();
    const settings = h.submitted[0];
    assert.equal(settings.model, model);
    assert.equal(settings.n, 1);
    assert.equal(settings.image_urls.length, 2);
    assert.match(settings.prompt, /图 1 是待修改的底图/);
    assert.match(settings.prompt, /图 2 起是额外参考图/);
    assert.ok(!settings.prompt.includes(h.ns.EDIT_DEFAULT_ANNOTATION));
    assert.equal(h.ns.els.editPromptStats.textContent, `${settings.prompt.length} 字`);
    if (model.endsWith('official')) assert.equal(settings.quality, 'high');
  }
});

test('no extra reference preserves legacy prompt and a single-image request, strokes remain optional', async () => {
  const { ns, submitted, window } = harness();
  ns.state.edit.strokes = [];
  const confirmations = [];
  window.confirm = (text) => { confirmations.push(text); return true; };
  await ns.handleEditSubmit();
  assert.equal(submitted[0].prompt, ns.els.editPrompt.value);
  assert.equal(submitted[0].image_urls.length, 1);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /修改 1 张/);
  assert.doesNotMatch(confirmations[0], /没有任何标注/);
});

test('role guidance cannot turn an empty prompt into an implicit edit, and counts toward 8000 chars', async () => {
  const h = harness();
  await addOne(h);
  h.ns.els.editPrompt.value = '';
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted.length, 0);
  assert.match(h.ns.els.editStatus.textContent, /修改说明/);
  h.ns.els.editPrompt.value = 'a'.repeat(7950);
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted.length, 0);
  assert.match(h.ns.els.editStatus.textContent, /8000/);
});

test('upload and submit require a base image', async () => {
  const { ns, readers, submitted } = harness();
  ns.resetEditState();
  ns.updateEditControls();
  assert.equal(ns.els.editReferenceUploadBtn.disabled, true);
  assert.equal(ns.els.editSubmitBtn.disabled, true);
  await ns.addEditReferenceFiles([file()]);
  assert.equal(readers.length, 0);
  assert.match(ns.els.editEmptyStatus.textContent, /底图/);
  await ns.handleEditSubmit();
  assert.equal(submitted.length, 0);
});

test('uploads reject bad MIME, empty files and files over 5MB before reading', async () => {
  const { ns, readers } = harness();
  await ns.addEditReferenceFiles([file('evil.svg', 5, 'image/svg+xml'), file('empty.png', 0), file('big.png', 5 * 1024 * 1024 + 1)]);
  assert.equal(readers.length, 0);
  assert.equal(ns.state.edit.referencesLoading, false);
  assert.match(ns.els.editReferenceStatus.textContent, /PNG、JPEG、WebP/);
  assert.match(ns.els.editReferenceStatus.textContent, /5MB/);
});

test('15 references plus the base is accepted, the 16th extra is rejected', async () => {
  const h = harness();
  for (let i = 0; i < 15; i++) await addOne(h, file(`r${i}.png`));
  await h.ns.addEditReferenceFiles([file()]);
  assert.equal(h.ns.state.edit.referenceImages.length, 15);
  assert.equal(h.readers.length, 15);
  assert.equal(h.ns.els.editReferenceUploadBtn.disabled, true);
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted[0].image_urls.length, 16);
  assert.match(h.ns.validateEditImagePayload(Array(17).fill(image())), /最多 16 张/);
});

test('total bytes include the composed base and single-image bounds use decoded data', () => {
  const { ns } = harness();
  const mb = 1024 * 1024;
  assert.equal(ns.validateEditImagePayload([image(3 * mb), image(5 * mb), image(5 * mb), image(5 * mb)]), '');
  assert.match(ns.validateEditImagePayload([image(3 * mb + 1), image(5 * mb), image(5 * mb), image(5 * mb)]), /合计超过 18MB/);
  assert.match(ns.validateEditImagePayload([image(5 * mb + 1)]), /5MB/);
  assert.match(ns.validateEditImagePayload([image(0)]), /不能为空/);
  assert.match(ns.validateEditImagePayload(['https://example.com/image.png']), /格式无效/);
});

test('upload rechecks actual data size and always releases loading state on failure', async () => {
  const h = harness();
  let pending = h.ns.addEditReferenceFiles([file()]);
  h.readers.at(-1).finish(image(5 * 1024 * 1024 + 1));
  await pending;
  assert.equal(h.ns.state.edit.referenceImages.length, 0);
  assert.match(h.ns.els.editReferenceStatus.textContent, /5MB/);
  pending = h.ns.addEditReferenceFiles([file()]);
  h.readers.at(-1).fail();
  await pending;
  assert.equal(h.ns.state.edit.referencesLoading, false);
  assert.match(h.ns.els.editReferenceStatus.textContent, /读取失败/);
});

test('upload total budget is rechecked after asynchronous read', async () => {
  const h = harness();
  h.ns.constants.MAX_REFERENCE_TOTAL_BYTES = 5;
  const pending = h.ns.addEditReferenceFiles([file()]);
  h.ns.state.edit.referenceImages.push({ id: 'other', value: image(3), name: 'other' });
  h.readers[0].finish();
  await pending;
  assert.equal(h.ns.state.edit.referenceImages.length, 1);
  assert.match(h.ns.els.editReferenceStatus.textContent, /合计超过/);
});

test('reading references locks editing submit, replacement, removal and parallel reads', async () => {
  const h = harness();
  await addOne(h);
  const pending = h.ns.addEditReferenceFiles([file('second.png')]);
  assert.equal(h.ns.els.editSubmitBtn.disabled, true);
  assert.equal(h.ns.els.editChangeImageBtn.disabled, true);
  assert.equal(h.ns.els.editClearReferencesBtn.disabled, true);
  assert.equal(h.ns.els.editReferencePreviewGrid.children[0].children[2].disabled, true);
  await h.ns.addEditReferenceFiles([file('parallel.png')]);
  assert.equal(h.readers.length, 2);
  h.ns.clearEditReferences();
  h.ns.removeEditReference(h.ns.state.edit.referenceImages[0].id);
  assert.equal(h.ns.state.edit.referenceImages.length, 1);
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted.length, 0);
  h.readers[1].finish();
  await pending;
  assert.equal(h.ns.els.editSubmitBtn.disabled, false);
});

test('busy and pending generation lock reference controls and prevent uploads', async () => {
  for (const field of ['isBusy', 'pendingRequest']) {
    const h = harness();
    await addOne(h);
    h.ns.state[field] = true;
    h.ns.updateEditControls();
    assert.equal(h.ns.els.editReferenceUploadBtn.disabled, true);
    assert.equal(h.ns.els.editClearReferencesBtn.disabled, true);
    await h.ns.addEditReferenceFiles([file()]);
    assert.equal(h.readers.length, 1);
    h.ns.clearEditReferences();
    assert.equal(h.ns.state.edit.referenceImages.length, 1);
  }
});

test('account reset discards late reference reads and clears previews', async () => {
  const h = harness();
  await addOne(h);
  const pending = h.ns.addEditReferenceFiles([file('late.png')]);
  h.ns.resetAccountRuntime();
  assert.equal(h.ns.state.edit.referenceImages.length, 0);
  assert.equal(h.ns.els.editReferencePreviewGrid.children.length, 0);
  assert.equal(h.ns.els.editPrompt.value, '');
  h.readers[1].finish();
  await pending;
  assert.equal(h.ns.state.edit.referenceImages.length, 0);
  assert.equal(h.ns.els.editReferenceStatus.textContent, '');
});

test('base replacement clears references only on successful load, cancel or errors preserve them', async () => {
  const h = harness();
  await addOne(h);
  h.window.confirm = () => false;
  h.ns.loadEditImage(image(), 'upload');
  assert.equal(h.images.length, 0);
  h.window.confirm = () => true;
  h.ns.loadEditImage(image(), 'upload');
  h.images[0].onerror();
  assert.equal(h.ns.state.edit.referenceImages.length, 1);
  h.ns.loadEditImage(image(), 'upload');
  h.images[1].finish();
  assert.equal(h.ns.state.edit.referenceImages.length, 0);
  assert.equal(h.ns.state.edit.strokes.length, 0);
  assert.match(h.ns.els.editReferenceStatus.textContent, /旧参考图已清空/);
});

test('account reset discards late base FileReader and Image callbacks', () => {
  const h = harness();
  h.ns.els.editUploadInput.files = [file()];
  h.ns.handleEditUpload();
  h.ns.resetAccountRuntime();
  h.readers[0].finish();
  assert.equal(h.images.length, 0);
  h.ns.loadEditImage(image(), 'stored');
  h.ns.resetAccountRuntime();
  h.images[0].finish();
  assert.equal(h.ns.state.edit.image, null);
});

test('image paste is routed by active tab without preventing text paste', async () => {
  const h = harness();
  const event = { clipboardData: { files: [file()] }, preventDefault() { assert.fail('text paste must remain available'); } };
  h.ns.els.referenceFileInput.disabled = true;
  let pending = h.ns.handleReferencePaste(event);
  h.readers[0].finish();
  await pending;
  assert.equal(h.ns.state.edit.referenceImages.length, 1);
  assert.equal(h.ns.state.referenceImages.length, 0);
  h.window.location.hash = '#workspace';
  h.ns.els.referenceFileInput.disabled = false;
  pending = h.ns.handleReferencePaste(event);
  h.readers[1].finish();
  await pending;
  assert.equal(h.ns.state.referenceImages.length, 1);
  assert.equal(h.ns.state.edit.referenceImages.length, 1);
  await h.ns.handleReferencePaste({ clipboardData: { files: [] } });
  assert.equal(h.readers.length, 2);
});

test('final decoded total and encoded request body are rejected before runGeneration', async () => {
  const h = harness();
  await addOne(h);
  h.ns.constants.MAX_REFERENCE_TOTAL_BYTES = 5;
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted.length, 0);
  assert.match(h.ns.els.editStatus.textContent, /18MB/);
  h.ns.constants.MAX_REFERENCE_TOTAL_BYTES = 18 * 1024 * 1024;
  h.ns.MAX_UPSTREAM_BODY_BYTES = 10;
  await h.ns.handleEditSubmit();
  assert.equal(h.submitted.length, 0);
  assert.match(h.ns.els.editStatus.textContent, /24MB/);
});

test('workspace editor load awaits preparation and ignores old-account entry callbacks', async () => {
  const h = harness();
  let finish;
  h.ns.prepareWorkspaceEdit = () => new Promise(resolve => { finish = resolve; });
  const pending = h.ns.loadEditImage(image(), 'stored');
  assert.equal(h.images.length, 0);
  h.ns.resetAccountRuntime();
  finish(true); await pending;
  assert.equal(h.images.length, 0);
});

test('workspace editor keeps capacity feedback and rechecks duplicate async submit after preparation', async () => {
  const h = harness();
  h.ns.prepareWorkspaceEdit = async () => true;
  h.ns.workspaceSubmit = { ready: () => false, blockedReason: () => '进行中请求已达上限 3，可继续编辑草稿。' };
  await h.ns.handleEditSubmit();
  assert.match(h.ns.els.editStatus.textContent, /已达上限 3/);
  assert.equal(h.submitted.length, 0);
  h.ns.workspaceSubmit.ready = () => true;
  h.ns.runGeneration = async settings => { h.ns.state.isBusy = true; h.submitted.push(settings); };
  await Promise.all([h.ns.handleEditSubmit(), h.ns.handleEditSubmit()]);
  assert.equal(h.submitted.length, 1);
});


test('workspace preparation locks editor text, annotation and toggle mutations', () => {
  const h = harness();
  h.ns.isWorkspaceEditLocked = () => true;
  h.ns.updateEditControls();
  for (const key of ['editPrompt', 'editAnnotationText', 'editAppendToggle']) assert.equal(h.ns.els[key].disabled, true, key);
  h.ns.isWorkspaceEditLocked = () => false;
  h.ns.updateEditControls();
  for (const key of ['editPrompt', 'editAnnotationText', 'editAppendToggle']) assert.equal(h.ns.els[key].disabled, false, key);
});
