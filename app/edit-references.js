(() => {
  const ns = window.ImageGen = window.ImageGen || {};
  const references = () => ns.state.edit?.referenceImages || [];
  const maxReferences = () => ns.constants.MAX_REFERENCE_IMAGES - 1;
  const totalBytes = () => references().reduce((sum, item) => sum + ns.estimateDataUrlBytes(item.value), 0);

  ns.setEditReferenceStatus = (message, type = '') => {
    if (ns.els?.editReferenceStatus) ns.setStatusClass(ns.els.editReferenceStatus, 'status reference-status', message, type);
  };

  ns.updateEditReferenceControls = () => {
    const locked = ns.isEditLocked();
    const uploadDisabled = locked || !ns.editHasImage() || references().length >= maxReferences();
    for (const key of ['editReferenceUploadBtn', 'editReferenceFileInput']) {
      if (ns.els?.[key]) ns.els[key].disabled = uploadDisabled;
    }
    if (ns.els?.editClearReferencesBtn) ns.els.editClearReferencesBtn.disabled = locked || !references().length;
    ns.els?.editReferencePreviewGrid?.querySelectorAll('button').forEach((button) => { button.disabled = locked; });
  };

  ns.renderEditReferences = () => {
    const items = references();
    if (ns.els?.editReferenceCount) ns.els.editReferenceCount.textContent = `${items.length}/${maxReferences()} 张`;
    const grid = ns.els?.editReferencePreviewGrid;
    if (!grid) return;
    grid.classList.toggle('hidden', !items.length);
    grid.replaceChildren(...items.map((item, index) => {
      const figure = document.createElement('figure');
      figure.className = 'input-preview-card reference-preview-card';
      const img = document.createElement('img');
      img.src = item.value;
      img.alt = `图 ${index + 2} · 参考图`;
      const caption = document.createElement('figcaption');
      caption.textContent = `图 ${index + 2} · ${item.name}`;
      caption.title = caption.textContent;
      const remove = document.createElement('button');
      remove.className = 'secondary compact';
      remove.type = 'button';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除图 ${index + 2}：${item.name}`);
      remove.dataset.editReferenceId = item.id;
      figure.append(img, caption, remove);
      return figure;
    }));
    ns.updateEditReferenceControls();
    ns.updateEditPromptStats();
  };

  // 上传和提交都校验实际 data URL 字节；提交时图 1 的合成体积也计入 18MB 总限。
  ns.validateEditImagePayload = (images) => {
    if (!images.length || images.length > ns.constants.MAX_REFERENCE_IMAGES) return '底图加参考图最多 16 张（额外参考图最多 15 张）。';
    let bytes = 0;
    for (const [index, image] of images.entries()) {
      if (!/^data:image\/(png|jpeg|webp);base64,/i.test(image)) return `图 ${index + 1} 格式无效，请重新上传。`;
      const size = ns.estimateDataUrlBytes(image);
      if (!size || size > ns.constants.MAX_REFERENCE_IMAGE_BYTES) return `图 ${index + 1} 不能为空，单张不能超过 5MB。`;
      bytes += size;
    }
    return bytes > ns.constants.MAX_REFERENCE_TOTAL_BYTES ? '底图与参考图合计超过 18MB，请删除或压缩参考图后重试。' : '';
  };

  ns.addEditReferenceFiles = async (fileList) => {
    if (!ns.state.session?.token || ns.isEditLocked()) return;
    if (!ns.editHasImage()) return ns.setEditEmptyStatus('请先上传或选择编辑底图，再添加参考图。', 'error');
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const context = ns.captureEditContext();
    const edit = context.edit;
    edit.referencesLoading = true;
    ns.updateEditControls();
    ns.setEditReferenceStatus('正在读取参考图...', 'loading');
    let added = 0;
    const rejected = [];
    const checkFile = (file, bytes = file.size) => {
      if (references().length >= maxReferences()) return '最多添加 15 张参考图（底图另占 1 张）';
      const error = ns.validateReferenceFile(file);
      if (error) return error;
      if (!bytes || bytes > ns.constants.MAX_REFERENCE_IMAGE_BYTES) return '图片不能为空，单张不超过 5MB';
      if (totalBytes() + bytes > ns.constants.MAX_REFERENCE_TOTAL_BYTES) return '参考图合计超过 18MB，还需为底图留出空间';
      return '';
    };
    try {
      for (const file of files) {
        if (!ns.isEditContextCurrent(context)) return;
        const name = file.name || '剪贴板图片';
        let error = checkFile(file);
        if (error) { rejected.push(`${name}：${error}`); continue; }
        try {
          const value = String(await ns.referenceFileToDataUrl(file));
          if (!ns.isEditContextCurrent(context)) return;
          error = checkFile(file, ns.estimateDataUrlBytes(value));
          if (!error && !/^data:image\/(png|jpeg|webp);base64,/i.test(value)) error = '图片格式无效';
          if (error) { rejected.push(`${name}：${error}`); continue; }
          edit.referenceImages.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, value, name });
          added += 1;
        } catch {
          if (!ns.isEditContextCurrent(context)) return;
          rejected.push(`${name}：文件读取失败`);
        }
      }
    } finally {
      if (ns.isEditContextCurrent(context)) {
        edit.referencesLoading = false;
        if (ns.els?.editReferenceFileInput) ns.els.editReferenceFileInput.value = '';
        ns.renderEditReferences();
        ns.updateEditControls();
        const summary = added ? `已添加 ${added} 张参考图，请在修改说明中用“图 2”“图 3”等指定用途。` : '未添加参考图。';
        ns.setEditReferenceStatus([summary, ...rejected].join('\n'), rejected.length ? 'error' : 'ok');
      }
    }
  };

  ns.removeEditReference = (id) => {
    if (ns.isEditLocked() || !ns.state.edit) return;
    ns.state.edit.referenceImages = references().filter((item) => item.id !== id);
    ns.renderEditReferences();
    ns.setEditReferenceStatus('已删除参考图，图号已重新排列，请核对修改说明中的图号。', 'ok');
  };
  ns.clearEditReferences = () => {
    if (ns.isEditLocked() || !ns.state.edit) return;
    ns.state.edit.referenceImages = [];
    if (ns.els?.editReferenceFileInput) ns.els.editReferenceFileInput.value = '';
    ns.renderEditReferences();
    ns.setEditReferenceStatus('编辑参考图已清空，底图和标注不变。', 'ok');
  };
  ns.bindEditReferenceEvents = () => {
    ns.els?.editReferenceUploadBtn?.addEventListener('click', () => ns.els.editReferenceFileInput?.click());
    ns.els?.editReferenceFileInput?.addEventListener('change', () => ns.addEditReferenceFiles(ns.els.editReferenceFileInput.files));
    ns.els?.editClearReferencesBtn?.addEventListener('click', ns.clearEditReferences);
    ns.els?.editReferencePreviewGrid?.addEventListener('click', (event) => {
      const id = event.target?.closest('[data-edit-reference-id]')?.dataset.editReferenceId;
      if (id) ns.removeEditReference(id);
    });
  };
})();
