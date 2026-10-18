const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const script = path.join(__dirname, '../deploy/migrate-data-ownership.sh');

function run(args) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

test('ownership helper rejects zero identities including zero-padded forms', () => {
  for (const zero of ['0', '00', '000']) {
    for (const [uid, gid] of [[zero, '1000'], ['1000', zero]]) {
      const result = run(['--uid', uid, '--gid', gid, '--dir', os.tmpdir()]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /拒绝迁移/);
    }
  }
});

test('ownership helper rejects root even when reached through a symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-migration-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rootLink = path.join(dir, 'root-link');
  fs.symlinkSync('/', rootLink);
  const result = run(['--uid', '1000', '--gid', '1000', '--dir', rootLink]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /拒绝对根目录/);
});

test('ownership helper defaults to a nonmutating dry run', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-migration-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app-data.json');
  fs.writeFileSync(file, '{}', { mode: 0o640 });
  const before = fs.statSync(file);
  const result = run(['--uid', '1000', '--gid', '1000', '--dir', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run：未做任何修改/);
  const after = fs.statSync(file);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});
