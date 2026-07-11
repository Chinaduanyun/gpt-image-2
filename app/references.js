(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const remainingSlots = () => ns.constants.MAX_REFERENCE_IMAGES - ns.state.referenceImages.length;
  const totalReferenceBytes = () => ns.state.referenceImages.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  const captureAccountContext = () => ({ epoch: ns.state.accountEpoch, ownerEmail: ns.state.session?.user?.email || '' });
  const isAccountContextCurrent = (context) => context.epoch === ns.state.accountEpoch
    && context.ownerEmail === (ns.state.session?.user?.email || '');

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  ns.addReferenceImage = (item) => {
    if (remainingSlots() <= 0) return false;
    ns.state.referenceImages.push({ id: makeId(), type: item.type, value: item.value, name: item.name || '', bytes: item.bytes || 0 });
    return true;
  };

  async function urlToDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > ns.constants.MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error('图片格式或大小不符合参考图限制。');
    }
    return { value: await fileToDataUrl(blob), bytes: blob.size };
  }

  ns.addReferenceFromUrl = async (url, name = '参考图', accountContext = captureAccountContext()) => {
    if (!isAccountContextCurrent(accountContext)) return false;
    if (remainingSlots() <= 0) {
      ns.setReferenceStatus('参考图数量已达上限。', 'error');
      return false;
    }

    const text = String(url || '').trim();
    if (!text) return false;

    try {
      const parsed = new URL(text, window.location.href);
      if (parsed.origin === window.location.origin) {
        const dataUrl = await urlToDataUrl(parsed.toString());
        if (!isAccountContextCurrent(accountContext)) return false;
        return ns.addReferenceImage({ type: 'file', value: dataUrl.value, name, bytes: dataUrl.bytes });
      }
    } catch {
    }

    return isAccountContextCurrent(accountContext)
      ? ns.addReferenceImage({ type: 'url', value: text, name, bytes: 0 })
      : false;
  };

  ns.addReferenceUrls = async (urls, sourceLabel = '图片') => {
    const accountContext = captureAccountContext();
    let added = 0;
    let skipped = 0;
    for (const [index, url] of Array.from(new Set(urls || [])).entries()) {
      if (!isAccountContextCurrent(accountContext)) return added;
      if (remainingSlots() <= 0) {
        skipped += 1;
        continue;
      }
      try {
        if (await ns.addReferenceFromUrl(url, `${sourceLabel} ${index + 1}`, accountContext)) added += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (!isAccountContextCurrent(accountContext)) return added;
    ns.renderReferences();
    const message = [`已添加 ${added} 张为参考图`];
    if (skipped) message.push(`${skipped} 张因数量、格式或大小限制被跳过`);
    ns.setReferenceStatus(`${message.join('，')}。`, added ? 'ok' : 'error');
    return added;
  };

  ns.renderReferences = () => {
    const count = ns.state.referenceImages.length;
    ns.els.referenceCount.textContent = `${count}/${ns.constants.MAX_REFERENCE_IMAGES} 张`;
    ns.els.referenceUploadBtn.disabled = ns.state.isBusy;
    ns.els.clearReferencesBtn.disabled = count === 0 || ns.state.isBusy;
    ns.els.referencePreviewGrid.classList.toggle('hidden', count === 0);
    ns.els.referencePreviewGrid.replaceChildren(...ns.state.referenceImages.map((item, index) => {
      const figure = document.createElement('figure');
      figure.className = 'input-preview-card reference-preview-card';
      const img = document.createElement('img');
      img.src = item.value;
      img.alt = `参考图 ${index + 1}`;
      const caption = document.createElement('figcaption');
      caption.textContent = item.name || (item.type === 'url' ? 'URL 参考图' : '本地参考图');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'secondary compact';
      removeBtn.type = 'button';
      removeBtn.dataset.referenceId = item.id;
      removeBtn.textContent = '删除';
      removeBtn.disabled = ns.state.isBusy;
      figure.append(img, caption, removeBtn);
      return figure;
    }));
    if (!count) ns.setReferenceStatus('支持 PNG、JPEG、WebP；单张不超过 5MB，本地文件合计不超过 18MB，最多 16 张。');
  };

  ns.addReferenceFiles = async () => {
    const accountContext = captureAccountContext();
    const files = Array.from(ns.els.referenceFileInput.files || []);
    if (!files.length) {
      ns.setReferenceStatus('请选择本地参考图。', 'error');
      return;
    }

    let added = 0;
    const rejected = [];
    for (const file of files) {
      if (!isAccountContextCurrent(accountContext)) return;
      if (remainingSlots() <= 0) {
        rejected.push(`${file.name}：超过 16 张数量上限`);
        continue;
      }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        rejected.push(`${file.name}：仅支持 PNG、JPEG、WebP`);
        continue;
      }
      if (file.size > ns.constants.MAX_REFERENCE_IMAGE_BYTES) {
        rejected.push(`${file.name}：单张超过 5MB`);
        continue;
      }
      if (totalReferenceBytes() + file.size > ns.constants.MAX_REFERENCE_TOTAL_BYTES) {
        rejected.push(`${file.name}：本地文件合计将超过 18MB`);
        continue;
      }
      try {
        const value = await fileToDataUrl(file);
        if (!isAccountContextCurrent(accountContext)) return;
        if (ns.addReferenceImage({ type: 'file', value, name: file.name, bytes: file.size })) added += 1;
      } catch {
        rejected.push(`${file.name}：文件读取失败`);
      }
    }

    ns.els.referenceFileInput.value = '';
    ns.renderReferences();
    const summary = added ? `已添加 ${added} 张本地参考图。` : '未添加参考图。';
    if (!rejected.length) return ns.setReferenceStatus(summary, added ? 'ok' : 'error');
    ns.els.referenceStatus.className = `status reference-status ${added ? '' : 'error'}`.trim();
    ns.els.referenceStatus.setAttribute('role', 'alert');
    ns.els.referenceStatus.replaceChildren(document.createTextNode(`${summary} 以下文件被拒绝：`), Object.assign(document.createElement('ul'), {
      innerHTML: rejected.map((message) => `<li>${ns.escapeHtml(message)}</li>`).join('')
    }));
  };

  ns.removeReference = (id) => {
    ns.state.referenceImages = ns.state.referenceImages.filter((item) => item.id !== id);
    ns.renderReferences();
    ns.setReferenceStatus('已删除参考图。', 'ok');
  };

  ns.clearReferences = () => {
    ns.state.referenceImages = [];
    if (ns.els.referenceFileInput) ns.els.referenceFileInput.value = '';
    ns.renderReferences();
  };
})();
