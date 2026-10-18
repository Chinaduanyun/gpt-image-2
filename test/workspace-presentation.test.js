const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/workspace.js'), 'utf8');
const start = source.indexOf('  function promptPreview(value) {');
const end = source.indexOf('  function taskLabel', start);
const preview = vm.runInNewContext(`${source.slice(start, end)}; promptPreview`);
test('task captions retain exactly the first 15 code points and ellipsis only on overflow', () => {
  assert.equal(preview('一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四五…');
  assert.equal(preview('123456789012345'), '123456789012345');
  assert.equal(preview('1234567890123456'), '123456789012345…');
  assert.equal(preview('😀'.repeat(16)), '😀'.repeat(15) + '…');
  assert.equal(preview('  雨后\n  森林  '), '雨后 森林');
  assert.equal(preview(''), '未命名创作');
});
