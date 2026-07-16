const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

// edit.js 在独立 vm realm 里创建的对象原型与宿主不同，assert/strict 的 deepEqual 会因
// 原型不一致失败；比较前先展开成宿主 realm 的普通对象。
const plain = (value) => ({ ...value });

// edit.js 只在 IIFE 里往 window.ImageGen 挂函数，载入时不碰 DOM，可直接在沙箱里跑。
function loadEdit() {
  const ns = { state: {} };
  const window = {
    ImageGen: ns,
    location: { href: 'https://studio.example.com/', origin: 'https://studio.example.com' }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/edit.js'), 'utf8'), {
    window, document: {}, Math, Number, String, Date, JSON, URL
  });
  return ns;
}

test('isEditableImageUrl only allows same-origin archived images and local data uploads', () => {
  const ns = loadEdit();
  // 同源已归档：可编辑
  assert.equal(ns.isEditableImageUrl('/api/stored-images/abc.png'), true);
  assert.equal(ns.isEditableImageUrl('https://studio.example.com/api/stored-images/abc.png'), true);
  // 本地上传 data URL：可编辑
  assert.equal(ns.isEditableImageUrl('data:image/png;base64,AAAA'), true);
  assert.equal(ns.isEditableImageUrl('data:image/webp;base64,AAAA'), true);
  // 跨域远程 http(s)：不可编辑（会污染 canvas）
  assert.equal(ns.isEditableImageUrl('https://cdn.other.com/x.png'), false);
  assert.equal(ns.isEditableImageUrl('http://cdn.other.com/api/stored-images/x.png'), false);
  // 可注入/非法协议：不可编辑
  assert.equal(ns.isEditableImageUrl('javascript:alert(1)'), false);
  assert.equal(ns.isEditableImageUrl('data:text/html,<script>'), false);
  assert.equal(ns.isEditableImageUrl(''), false);
  assert.equal(ns.isEditableImageUrl(null), false);
});

test('stroke coordinates round-trip between display and natural space', () => {
  const ns = loadEdit();
  const display = { width: 400, height: 300 };
  const natural = { width: 4000, height: 3000 };
  const displayPoint = { x: 100, y: 150 };
  const naturalPoint = ns.toNaturalPoint(displayPoint, display, natural);
  assert.deepEqual(plain(naturalPoint), { x: 1000, y: 1500 });
  const back = ns.toDisplayPoint(naturalPoint, natural, display);
  assert.deepEqual(plain(back), { x: 100, y: 150 });
  // 退化尺寸不抛错，返回 0。
  assert.deepEqual(plain(ns.toNaturalPoint({ x: 5, y: 5 }, { width: 0, height: 0 }, natural)), { x: 0, y: 0 });
});

test('stroke width tiers scale with the natural short side', () => {
  const ns = loadEdit();
  assert.equal(ns.strokeWidthForTier(0, 1000), 8);   // 0.8%
  assert.equal(ns.strokeWidthForTier(1, 1000), 16);  // 1.6%
  assert.equal(ns.strokeWidthForTier(2, 1000), 30);  // 3%
  // 4K 短边也看得见（绝对像素随原图放大）。
  assert.equal(ns.strokeWidthForTier(1, 2160), 35);
  // 至少 1px。
  assert.equal(ns.strokeWidthForTier(0, 10), 1);
  // 越界档位回退到默认档。
  assert.equal(ns.strokeWidthForTier(9, 1000), 16);
});

test('estimateDataUrlBytes approximates decoded size from base64 length', () => {
  const ns = loadEdit();
  // 8 个 base64 字符（无 padding）≈ 6 字节。
  assert.equal(ns.estimateDataUrlBytes('data:image/png;base64,AAAAAAAA'), 6);
  // 带 padding 的扣减。
  assert.equal(ns.estimateDataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(ns.estimateDataUrlBytes('data:image/png;base64,AAA='), 2);
  assert.equal(ns.estimateDataUrlBytes(''), 0);
});

test('planComposeStep walks PNG -> WebP -> downscale ladder then fails at the floor', () => {
  const ns = loadEdit();
  const limit = 100;
  const minLongSide = 40;
  const factor = 0.8;
  const opts = { limit, minLongSide, factor };

  // PNG 在限内：直接接受。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'png', width: 200, height: 100, bytes: 80, ...opts })),
    { action: 'accept', stage: 'png', width: 200, height: 100 }
  );
  // PNG 超限：转 WebP，尺寸不变。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'png', width: 200, height: 100, bytes: 150, ...opts })),
    { action: 'encode', stage: 'webp', width: 200, height: 100 }
  );
  // WebP 在限内：接受。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'webp', width: 200, height: 100, bytes: 90, ...opts })),
    { action: 'accept', stage: 'webp', width: 200, height: 100 }
  );
  // WebP 超限：长边 ×0.8 缩放并重编码为 downscale。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'webp', width: 200, height: 100, bytes: 150, ...opts })),
    { action: 'encode', stage: 'downscale', width: 160, height: 80 }
  );
  // downscale 仍超限：继续缩。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'downscale', width: 160, height: 80, bytes: 150, ...opts })),
    { action: 'encode', stage: 'downscale', width: 128, height: 64 }
  );
  // 已到长边下限仍超限：失败。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'downscale', width: 40, height: 20, bytes: 150, ...opts })),
    { action: 'fail' }
  );
  // 长边恰好等于下限、在限内：接受。
  assert.deepEqual(
    plain(ns.planComposeStep({ stage: 'downscale', width: 40, height: 20, bytes: 90, ...opts })),
    { action: 'accept', stage: 'downscale', width: 40, height: 20 }
  );
});

test('planComposeStep never downscales below the 1024 long-side floor', () => {
  const ns = loadEdit();
  const step = ns.planComposeStep({ stage: 'webp', width: 1100, height: 900, bytes: 10 * 1024 * 1024 });
  assert.equal(step.action, 'encode');
  assert.equal(step.stage, 'downscale');
  assert.equal(Math.max(step.width, step.height), 1024);
});

test('buildEditPrompt appends annotation only when the toggle is on', () => {
  const ns = loadEdit();
  const note = ns.EDIT_DEFAULT_ANNOTATION;
  assert.equal(ns.buildEditPrompt('把菜换成汤圆', note, true), `把菜换成汤圆\n${note}`);
  assert.equal(ns.buildEditPrompt('把菜换成汤圆', note, false), '把菜换成汤圆');
  // 开关开但话术为空：不拼空行。
  assert.equal(ns.buildEditPrompt('把菜换成汤圆', '   ', true), '把菜换成汤圆');
  // 用户输入为空但话术在：只留话术。
  assert.equal(ns.buildEditPrompt('', note, true), note);
  assert.equal(ns.buildEditPrompt('  ', '', false), '');
});

test('validateEditPrompt enforces non-empty and the 8000 character ceiling', () => {
  const ns = loadEdit();
  assert.equal(ns.validateEditPrompt('   ').ok, false);
  assert.equal(ns.validateEditPrompt('改一下').ok, true);
  const atLimit = 'a'.repeat(8000);
  assert.equal(ns.validateEditPrompt(atLimit).ok, true);
  const over = 'a'.repeat(8001);
  const result = ns.validateEditPrompt(over);
  assert.equal(result.ok, false);
  assert.match(result.error, /8001\/8000/);
});
