(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  // CRC32（IEEE 802.3 多项式 0xEDB88320）查表实现，首用惰性建表。
  let crcTable = null;
  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }
  ns.crc32 = (bytes) => {
    const table = getCrcTable();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  const encoder = new TextEncoder();
  const toBytes = (data) => data instanceof Uint8Array ? data : new Uint8Array(data);

  // 只做 STORE（不压缩）的 zip：图片本身已压缩，STORE 足够且零依赖。
  // 结构：[本地文件头+数据]* + [中央目录记录]* + EOCD。文件名 UTF-8，
  // 通用位标志 bit 11(0x0800) 置 1 声明 UTF-8 文件名。files: [{ name, data }]。
  ns.buildZip = (files = []) => {
    const entries = [];
    const localChunks = [];
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = toBytes(file.data);
      const crc = ns.crc32(data);
      const header = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);   // local file header signature
      view.setUint16(4, 20, true);           // version needed to extract
      view.setUint16(6, 0x0800, true);       // general purpose bit flag: UTF-8 name
      view.setUint16(8, 0, true);            // compression method: STORE
      view.setUint16(10, 0, true);           // last mod time
      view.setUint16(12, 0, true);           // last mod date
      view.setUint32(14, crc, true);         // crc-32
      view.setUint32(18, data.length, true); // compressed size
      view.setUint32(22, data.length, true); // uncompressed size
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);           // extra field length
      header.set(nameBytes, 30);
      localChunks.push(header, data);
      entries.push({ nameBytes, crc, size: data.length, offset });
      offset += header.length + data.length;
    }

    const centralChunks = [];
    let centralSize = 0;
    for (const entry of entries) {
      const record = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x02014b50, true);   // central directory header signature
      view.setUint16(4, 20, true);           // version made by
      view.setUint16(6, 20, true);           // version needed to extract
      view.setUint16(8, 0x0800, true);       // general purpose bit flag: UTF-8 name
      view.setUint16(10, 0, true);           // compression method: STORE
      view.setUint16(12, 0, true);           // last mod time
      view.setUint16(14, 0, true);           // last mod date
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true);  // compressed size
      view.setUint32(24, entry.size, true);  // uncompressed size
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);           // extra field length
      view.setUint16(32, 0, true);           // file comment length
      view.setUint16(34, 0, true);           // disk number start
      view.setUint16(36, 0, true);           // internal file attributes
      view.setUint32(38, 0, true);           // external file attributes
      view.setUint32(42, entry.offset, true); // relative offset of local header
      record.set(entry.nameBytes, 46);
      centralChunks.push(record);
      centralSize += record.length;
    }

    const eocd = new Uint8Array(22);
    const eview = new DataView(eocd.buffer);
    eview.setUint32(0, 0x06054b50, true);     // end of central dir signature
    eview.setUint16(4, 0, true);              // number of this disk
    eview.setUint16(6, 0, true);              // disk with central directory
    eview.setUint16(8, entries.length, true); // entries on this disk
    eview.setUint16(10, entries.length, true); // total entries
    eview.setUint32(12, centralSize, true);   // central directory size
    eview.setUint32(16, offset, true);        // central directory offset
    eview.setUint16(20, 0, true);             // comment length
    return new Blob([...localChunks, ...centralChunks, eocd], { type: 'application/zip' });
  };

  const EXT_BY_TYPE = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg'
  };
  function extFromContentType(type) {
    const clean = String(type || '').split(';')[0].trim().toLowerCase();
    return EXT_BY_TYPE[clean] || 'png';
  }

  // 逐张同源(credentials)拉图 → buildZip → createObjectURL 触发下载 {id}.zip → revoke。
  // 个别图 fetch 失败(如未归档的跨域远程 URL)则跳过并在完成提示注明。
  ns.downloadImagesAsZip = async (id, urls) => {
    const list = (urls || []).filter(Boolean);
    const safeId = String(id || 'images').replace(/[^\w.-]+/g, '_') || 'images';
    if (!list.length) return ns.setStatus?.('没有可打包下载的图片。', 'error');
    ns.setStatus?.(`正在打包 ${list.length} 张图片...`, 'loading');
    const zipFiles = [];
    let skipped = 0;
    for (const [index, url] of list.entries()) {
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) { skipped += 1; continue; }
        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        const ext = extFromContentType(blob.type || response.headers.get('content-type'));
        zipFiles.push({ name: `${safeId}_${index + 1}.${ext}`, data: new Uint8Array(buffer) });
      } catch {
        skipped += 1;
      }
    }
    if (!zipFiles.length) return ns.setStatus?.(`打包失败：${skipped} 张图片均无法下载（可能未归档或跨域）。`, 'error');
    const objectUrl = URL.createObjectURL(ns.buildZip(zipFiles));
    try {
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${safeId}.zip`;
      document.body?.appendChild?.(anchor);
      anchor.click();
      anchor.remove?.();
    } finally {
      // 延迟 revoke，给浏览器发起下载留出时间后再释放对象 URL。
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }
    ns.setStatus?.(`已打包下载 ${zipFiles.length} 张图片${skipped ? `，${skipped} 张因未归档跳过` : ''}。`, 'ok');
  };
})();
