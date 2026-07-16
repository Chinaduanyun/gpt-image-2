const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const composePath = path.join(root, 'compose.yaml');

function indentedBlock(source, key, indentation) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${' '.repeat(indentation)}${key}:`);
  assert.notEqual(start, -1, `${key} block must exist`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indentation) break;
    block.push(line);
  }
  return block.join('\n');
}

test('Compose keeps runtime.env as the application configuration source', () => {
  const compose = fs.readFileSync(composePath, 'utf8');
  const envFile = indentedBlock(compose, 'env_file', 4);
  const environment = indentedBlock(compose, 'environment', 4);

  assert.match(envFile, /path:\s*runtime\.env/);
  assert.match(envFile, /required:\s*false/);
  assert.deepEqual(
    environment.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ['HOST: 0.0.0.0', 'PORT: 8787', 'DATA_DIR: /data']
  );
});

test('Compose does not override runtime secrets or pricing with interpolation defaults', () => {
  const compose = fs.readFileSync(composePath, 'utf8');
  const environment = indentedBlock(compose, 'environment', 4);
  const runtimeVariables = [
    'ADMIN_EMAIL',
    'API_MARKET_API_KEY',
    'API_MARKET_BASE_URL',
    'API_MARKET_MODEL',
    'QUICK_BATCH_ENABLED',
    'PRICING_CURRENCY_RATE',
    'PRICING_MARKUP_MULTIPLIER',
    'PRICING_TOTAL_MULTIPLIER',
    'PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER',
    'PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS',
    'PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER',
    'PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS',
    'PRICING_LEGACY_TOTAL_MULTIPLIER',
    'PRICING_VERSION'
  ];

  for (const name of runtimeVariables) {
    assert.equal(environment.includes(`${name}:`), false, `${name} must come from runtime.env or application defaults`);
  }
  assert.equal(environment.includes('${'), false);
});

test('Compose passes sentinel runtime.env values through unchanged', (t) => {
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('docker compose is unavailable');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-compose-'));
  try {
    fs.copyFileSync(composePath, path.join(tempDir, 'compose.yaml'));
    fs.writeFileSync(path.join(tempDir, 'runtime.env'), [
      'ADMIN_EMAIL=sentinel@example.invalid',
      'API_MARKET_API_KEY=sentinel-api-key',
      'QUICK_BATCH_ENABLED=true',
      'PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER=123.5',
      'PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS=654321'
    ].join('\n'));
    const rendered = spawnSync('docker', ['compose', '-f', path.join(tempDir, 'compose.yaml'), 'config', '--format', 'json'], {
      env: { ...process.env, APP_UID: '1001', APP_GID: '1001' },
      encoding: 'utf8'
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    const environment = JSON.parse(rendered.stdout).services['image-generation'].environment;
    assert.equal(environment.ADMIN_EMAIL, 'sentinel@example.invalid');
    assert.equal(environment.API_MARKET_API_KEY, 'sentinel-api-key');
    assert.equal(environment.QUICK_BATCH_ENABLED, 'true');
    assert.equal(environment.PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER, '123.5');
    assert.equal(environment.PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS, '654321');
    assert.equal(environment.HOST, '0.0.0.0');
    assert.equal(environment.PORT, '8787');
    assert.equal(environment.DATA_DIR, '/data');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('README and env example document quick batch without Compose overrides', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, 'runtime.env.example'), 'utf8');
  const compose = fs.readFileSync(composePath, 'utf8');
  assert.match(readme, /`environment` 优先级高于 `env_file`/);
  assert.match(readme, /不会为密钥、上游地址、模型(?:、`QUICK_BATCH_ENABLED`)?或计价变量写入空值\/默认值并覆盖 `runtime\.env`|`QUICK_BATCH_ENABLED` 也应随这些应用配置写入/);
  assert.match(readme, /`QUICK_BATCH_ENABLED=false`（默认）/);
  assert.match(readme, /`QUICK_BATCH_ENABLED=true`/);
  assert.match(readme, /Idempotency-Key/);
  assert.match(readme, /submission unknown|提交结果未知/i);
  assert.match(readme, /tombstone/);
  assert.match(envExample, /^QUICK_BATCH_ENABLED=false$/m);
  assert.match(envExample, /N flat generation logs/);
  assert.match(envExample, /N simultaneous upstream n=1 requests/);
  assert.match(compose, /including QUICK_BATCH_ENABLED, belong in runtime\.env/);
  for (const name of [
    'PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER',
    'PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS',
    'PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER',
    'PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS'
  ]) {
    assert.match(readme, new RegExp(name));
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  }
});
