// Standalone socket-level integration; all endpoints and credentials are local mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const sharp = require('sharp');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'market-http-'));
  const key = path.join(temp, 'key.pem'); const cert = path.join(temp, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const png = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#446688' } }).png().toBuffer();
  let cpaPosts = 0; let marketPosts = 0; let marketGets = 0;
  const provider = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/cpa/v1/images/generations') { cpaPosts++; res.statusCode = 400; res.end('{"error":{"message":"unsupported mock parameter"}}'); return; }
      if (req.method === 'POST' && req.url === '/v1/images/generations') { marketPosts++; assert.equal(req.headers.authorization, 'Bearer market-mock'); assert.equal(JSON.parse(Buffer.concat(chunks)).n, 1); res.end('{"data":[{"task_id":"private-market-task"}]}'); return; }
      if (req.method === 'GET' && req.url === '/v1/tasks/private-market-task') {
        marketGets++;
        res.end(JSON.stringify({ data: { status: marketGets === 1 ? 'processing' : 'completed', cost: 500, result: marketGets === 1 ? {} : { images: [{ url: `data:image/png;base64,${png.toString('base64')}` }] } } })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const origin = `https://127.0.0.1:${provider.address().port}`;
  const data = path.join(temp, 'data'); fs.mkdirSync(data);
  const cpa = path.join(temp, 'cpa.json'); const market = path.join(temp, 'market.json');
  fs.writeFileSync(cpa, JSON.stringify({ baseUrl: `${origin}/cpa/v1`, apiKey: 'cpa-mock' }), { mode: 0o600 });
  fs.writeFileSync(market, JSON.stringify({ baseUrl: origin, apiKey: 'market-mock' }), { mode: 0o600 });
  const root = path.join(__dirname, '..');
  const env = { ...process.env, DATA_DIR: data, IMAGE_PROVIDER_MODE: 'cpa', CPA_CONFIG_FILE: cpa, CPA_ALLOWED_ORIGIN: origin, HYBRID_MARKET_ENABLED: 'true', HYBRID_MARKET_CONFIG_FILE: market, HYBRID_MARKET_ALLOWED_ORIGIN: origin, NODE_EXTRA_CA_CERTS: cert, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', ADMIN_EMAIL: '' };
  const run = (script) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`Local integration failed: ${output}`)));
  });
  try {
    await run(`const s=require('./lib/store'),r=require('./lib/image-task-runner'),a=require('assert/strict');(async()=>{const l={id:'socket1',type:'generation',email:'mock@invalid',estimatedCostMicros:100,chargedMicros:100,settled:false,imageFiles:[],imageUrls:[]};r.initializeHybridLog(l);s.saveDataStore({version:1,users:{'mock@invalid':{email:'mock@invalid',balanceMicros:900}},sessions:{},spendLogs:[l]});await r.startTask('socket1',{model:'gpt-image-2',prompt:'local mock only',n:1});const x=s.loadDataStore().spendLogs[0];a.equal(x.status,'processing');a.equal(x.attempts.at(-1).externalTaskId,'private-market-task');a.equal(x.settled,false);})().catch(e=>{console.error(e);process.exitCode=1;});`);
    await run(`const s=require('./lib/store'),r=require('./lib/image-task-runner'),a=require('assert/strict');(async()=>{await r.recoverTasks(true);const x=s.loadDataStore().spendLogs[0];a.equal(x.status,'completed');a.equal(x.actualCostMicros,100);a.equal(x.imageFiles[0].width,24);a.equal(x.imageFiles[0].height,18);a.equal(JSON.stringify(r.publicLog(x)).includes('private-market-task'),false);})().catch(e=>{console.error(e);process.exitCode=1;});`);
    assert.equal(cpaPosts, 1); assert.equal(marketPosts, 1); assert.equal(marketGets, 2);
    console.log(JSON.stringify({ ok: true, realHttpTransport: true, dependencyInjection: false, separateProcessRestart: true, cpaMockPosts: cpaPosts, marketMockPosts: marketPosts, marketMockGets: marketGets, fixedQuoteMicros: 100, assets: '24x18 png', artifacts: temp }, null, 2));
  } finally { await new Promise((resolve) => provider.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
