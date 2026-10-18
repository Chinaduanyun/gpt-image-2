const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/workspace.js'), 'utf8');
const start = source.indexOf('  function requestInputs(task) {');
const end = source.indexOf('  async function copyTask', start);
const requestInputs = vm.runInNewContext(`${source.slice(start, end)}; requestInputs`, { ns: { constants: { MAX_REFERENCE_IMAGES: 16 } } });
test('batch copy chooses first ordered request input sequence, not repeated archives', () => {
  const children = Array.from({ length: 4 }, (_, i) => ({ inputFiles: [{ fileName: `${i}-first` }, { fileName: `${i}-second` }] }));
  assert.equal(requestInputs({ kind: 'batch', children }), children[0].inputFiles);
  assert.deepEqual(requestInputs({ kind: 'batch', children }).map(f => f.fileName), ['0-first', '0-second']);
});
test('batch incomplete/deleted first sequence and over-limit inputs fail closed', () => {
  assert.throws(() => requestInputs({ kind: 'batch', children: [{ inputFiles: [] }, { inputFiles: [{}] }] }), /不完整/);
  assert.throws(() => requestInputs({ kind: 'batch', children: [{ assetsDeleted: true, inputFiles: [{}] }] }), /已删除/);
  assert.throws(() => requestInputs({ kind: 'task', inputFiles: Array(17).fill({}) }), /16/);
});
