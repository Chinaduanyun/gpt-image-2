const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/workspace.js'), 'utf8');
const start = source.indexOf('  function requestInputs(task) {');
const end = source.indexOf('  async function copyTask', start);
const requestInputs = vm.runInNewContext(`${source.slice(start, end)}; requestInputs`, { ns: { constants: { MAX_REFERENCE_IMAGES: 16 } } });
test('batch copy chooses first ordered request input sequence, not repeated archives', () => {
  const children = Array.from({ length: 4 }, (_, i) => ({ referenceImageCount: 2, inputFiles: [{ fileName: `${i}-first` }, { fileName: `${i}-second` }] }));
  assert.equal(requestInputs({ kind: 'batch', referenceImageCount: 2, children }), children[0].inputFiles);
  assert.deepEqual(requestInputs({ kind: 'batch', referenceImageCount: 2, children }).map(f => f.fileName), ['0-first', '0-second']);
});
test('batch incomplete/deleted first sequence and over-limit inputs fail closed', () => {
  assert.throws(() => requestInputs({ kind: 'batch', referenceImageCount: 2, children: [{ referenceImageCount: 2, inputFiles: [] }, { referenceImageCount: 2, inputFiles: [{}] }] }), /不完整/);
  assert.throws(() => requestInputs({ kind: 'batch', referenceImageCount: 1, children: [{ referenceImageCount: 1, assetsDeleted: true, inputFiles: [{}] }] }), /已删除/);
  assert.throws(() => requestInputs({ kind: 'task', referenceImageCount: 17, inputFiles: Array(17).fill({}) }), /16/);
});

test('copy completeness uses authoritative count for standalone and equally partial batches', () => {
  for (const count of [0, 1]) {
    assert.throws(() => requestInputs({ kind: 'task', referenceImageCount: 2, inputFiles: Array(count).fill({}) }), /不完整/);
    assert.throws(() => requestInputs({ kind: 'batch', referenceImageCount: 2, children: Array.from({ length: 3 }, () => ({ referenceImageCount: 2, inputFiles: Array(count).fill({}) })) }), /不完整/);
  }
  for (const referenceImageCount of [undefined, null, -1, '0']) assert.throws(() => requestInputs({ kind: 'task', referenceImageCount }), /未知/);
  assert.equal(requestInputs({ kind: 'task', referenceImageCount: 0 }).length, 0);
  assert.equal(requestInputs({ kind: 'batch', referenceImageCount: 0, children: [{ referenceImageCount: 0 }] }).length, 0);
  assert.throws(() => requestInputs({ kind: 'batch', referenceImageCount: 2, children: [{ referenceImageCount: null, inputFiles: [{}, {}] }] }), /未知/);
});
