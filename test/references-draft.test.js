const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const readers = [];
  const element = () => ({ value: '', disabled: false, replaceChildren() {}, classList: { toggle() {} } });
  const ns = { state: { accountEpoch: 0, session: { user: { email: 'a@test.invalid' } }, referenceImages: [] },
    constants: { MAX_REFERENCE_IMAGES: 16, MAX_REFERENCE_IMAGE_BYTES: 5, MAX_REFERENCE_TOTAL_BYTES: 18 },
    els: { referenceFileInput: element() }, renderReferences() {}, setReferenceStatus() {} };
  const context = vm.createContext({ window: { ImageGen: ns }, FileReader: class { readAsDataURL() { readers.push(this); } } });
  vm.runInContext(fs.readFileSync(require.resolve('../app/references.js'), 'utf8'), context);
  ns.renderReferences = () => {};
  return { ns, finish() { const reader = readers.shift(); reader.result = 'data:image/png;base64,AA=='; reader.onload(); } };
}
const file = { name: 'reference.png', type: 'image/png', size: 5 };
test('reference read generation invalidation discards deferred results and leaves new list untouched', async () => {
  const h = harness();
  const pending = h.ns.addReferenceFileList([file]);
  h.ns.clearReferences(); h.finish();
  assert.equal((await pending).aborted, true);
  assert.equal(h.ns.state.referenceImages.length, 0);
});
test('overlapping reference reads recheck total bytes after decoding', async () => {
  const h = harness(); h.ns.state.referenceImages = [{ bytes: 10 }];
  const first = h.ns.addReferenceFileList([file]), second = h.ns.addReferenceFileList([file]);
  h.finish(); assert.equal((await first).added, 1);
  h.finish(); const rejected = await second;
  assert.equal(rejected.added, 0); assert.match(rejected.rejected[0], /18MB/);
  assert.equal(h.ns.state.referenceImages.reduce((sum, ref) => sum + ref.bytes, 0), 15);
});
test('account boundary invalidates deferred reference reads', async () => {
  const h = harness(); const pending = h.ns.addReferenceFileList([file]);
  h.ns.state.accountEpoch++; h.ns.state.session.user.email = 'b@test.invalid'; h.finish();
  assert.equal((await pending).aborted, true); assert.equal(h.ns.state.referenceImages.length, 0);
});
