const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadZip() {
  const ns = {};
  const window = { ImageGen: ns, setTimeout };
  const context = {
    window, TextEncoder, Blob, DataView, Uint8Array, Uint32Array,
    Array, Object, Number, String, Math,
    URL, document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/zip.js'), 'utf8'), context);
  return ns;
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test('crc32 matches known IEEE 802.3 vectors', () => {
  const ns = loadZip();
  const enc = new TextEncoder();
  assert.equal(ns.crc32(new Uint8Array(0)), 0);
  assert.equal(ns.crc32(enc.encode('123456789')) >>> 0, 0xCBF43926);
  assert.equal(ns.crc32(enc.encode('The quick brown fox jumps over the lazy dog')) >>> 0, 0x414FA339);
});

test('buildZip produces a STORE archive with valid headers, entry count and UTF-8 names', async () => {
  const ns = loadZip();
  const enc = new TextEncoder();
  const files = [
    { name: 'batch_1.png', data: enc.encode('hello') },
    { name: '作品_2.jpg', data: enc.encode('second file bytes') }
  ];
  const blob = ns.buildZip(files);
  assert.equal(blob.type, 'application/zip');
  const bytes = await blobBytes(blob);
  const view = new DataView(bytes.buffer);

  // 首块是本地文件头签名 PK\x03\x04
  assert.equal(view.getUint32(0, true), 0x04034b50);
  // 首个本地头：STORE、通用位标志 bit 11(UTF-8) 置位、CRC 与 buildZip 内部一致
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
  assert.equal(view.getUint16(8, true), 0); // compression method = STORE
  assert.equal(view.getUint32(14, true) >>> 0, ns.crc32(files[0].data) >>> 0);
  assert.equal(view.getUint32(18, true), files[0].data.length); // compressed == uncompressed (STORE)
  assert.equal(view.getUint32(22, true), files[0].data.length);

  // EOCD 位于末尾 22 字节
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 8, true), files.length);  // entries on this disk
  assert.equal(view.getUint16(eocd + 10, true), files.length); // total entries
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50); // central directory signature
  assert.equal(centralSize, bytes.length - centralOffset - 22); // 尺寸自洽

  // 中央目录首条携带 UTF-8 文件名字节 batch_1.png
  const nameLen = view.getUint16(centralOffset + 28, true);
  const nameBytes = bytes.slice(centralOffset + 46, centralOffset + 46 + nameLen);
  assert.equal(new TextDecoder().decode(nameBytes), 'batch_1.png');

  // 中文文件名以 UTF-8 字节出现在归档中
  const raw = Buffer.from(bytes).toString('binary');
  assert.ok(raw.includes(Buffer.from('作品_2.jpg', 'utf8').toString('binary')));
});

test('buildZip on an empty file list yields a bare valid EOCD with zero entries', async () => {
  const ns = loadZip();
  const bytes = await blobBytes(ns.buildZip([]));
  assert.equal(bytes.length, 22);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x06054b50);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(16, true), 0);
});
