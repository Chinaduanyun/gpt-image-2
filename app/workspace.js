(() => {
  const ns = window.ImageGen;
  let registry = new Map(), selected = '', timer, runner = null, revision = 0, unseen = 0;
  let activeCount = 0, limit = 3, restored = false, writeChain = Promise.resolve();
  const owner = () => ns.state.session?.user?.email || '';
  const context = () => ({ epoch: ns.state.accountEpoch, token: ns.state.session?.token, email: owner() });
  const current = (c) => ns.isAccountContextCurrent(c.epoch, c.token, c.email);
  const key = (email = owner()) => `workspace:${email}`;
  function database() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('imageGenWorkspace', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('accounts');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function storage(value, email = owner(), read = false) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('accounts', read ? 'readonly' : 'readwrite');
        const r = read ? tx.objectStore('accounts').get(key(email)) : tx.objectStore('accounts').put(value, key(email));
        let result;
        r.onsuccess = () => { result = r.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('本地存储失败'));
      });
    } finally { db.close(); }
  }
  const editorFields = ['editModel', 'editPrompt', 'editAspectRatio', 'editResolution', 'editAnnotationText', 'editAppendToggle'];
  const fields = ['model', 'aspectRatio', 'resolution', 'quality', 'imageCount', 'outputFormat', 'outputCompression'];
  function captureDraft() {
    const edit = ns.state.edit;
    // Only uploaded image data is durable; stored asset URLs are revalidated before reuse.
    return { prompt: ns.els.prompt.value, fields: Object.fromEntries(fields.map(k => [k, ns.els[k].value])), references: structuredClone(ns.state.referenceImages),
      edit: edit ? { ...edit, image: null, referencesLoading: false, imageLoading: false, strokes: structuredClone(edit.strokes), referenceImages: structuredClone(edit.referenceImages) } : null,
      editPrompt: ns.els.editPrompt?.value || '', editorFields: Object.fromEntries(editorFields.filter(k => ns.els[k]).map(k => [k, k === 'editAppendToggle' ? ns.els[k].checked : ns.els[k].value])) };
  }
  let draft = null, hydrating = null;
  function persist() {
    const email = owner();
    if (!email || !restored) return Promise.reject(new Error('工作区尚未恢复，请稍后重试。'));
    const snapshot = structuredClone({ draft, selected, tasks: [...registry.values()] });
    const next = writeChain.catch(() => {}).then(() => storage(snapshot, email));
    writeChain = next;
    return next;
  }
  async function restoreDraft() {
    const hydration = {}; hydrating = hydration;
    ns.updatePendingUi();
    try {
    ns.resetResult();
    selected = ''; const rev = ++revision; const c = context();
    if (draft) {
      ns.els.prompt.value = draft.prompt || '';
      for (const field of fields) if (draft.fields?.[field] !== undefined) ns.els[field].value = draft.fields[field];
      ns.state.referenceImages = structuredClone(draft.references || []);
      ns.resetEditState?.();
      if (ns.els.editModel) ns.els.editModel.value = draft.editorFields?.editModel || ns.els.model.value;
      for (const [k, value] of Object.entries(draft.editorFields || {})) if (ns.els[k]) { if (k === 'editAppendToggle') ns.els[k].checked = value; else ns.els[k].value = value; }
      if (draft.edit?.sourceUrl) {
        ns.state.edit = { ...structuredClone(draft.edit), image: null, referencesLoading: false, imageLoading: false };
        ns.els.editPrompt.value = draft.editPrompt || '';
        const edit = ns.state.edit;
        if (edit.sourceUrl) {
          let source = edit.sourceUrl;
          if (!source.startsWith('data:image/')) {
            try { source = (await fetchInput({ url: source, fileName: source.split('/').pop() }, c)).value; }
            catch { if (current(c) && revision === rev) ns.resetEditState?.(); source = ''; }
          }
          if (!current(c) || revision !== rev) return;
          await new Promise(resolve => {
            const image = new Image();
            image.onload = () => { if (current(c) && revision === rev && ns.state.edit === edit) { edit.image = image; edit.imageLoading = false; edit.referencesLoading = false; ns.renderEditor?.(); } resolve(); };
            image.onerror = () => { if (current(c) && revision === rev && ns.state.edit === edit) ns.resetEditState?.(); resolve(); };
            image.src = source;
          });
        }
      }
    }
    ns.updatePromptStats(); ns.updateModelUi(); ns.renderReferences(); ns.renderEditor?.();
    } finally {
      if (hydrating === hydration) { hydrating = null; ns.updatePendingUi(); render(); }
    }
  }
  const capsule = document.createElement('button');
  capsule.id = 'taskCapsule'; capsule.className = 'task-capsule'; capsule.type = 'button'; capsule.setAttribute('aria-haspopup', 'dialog');
  const drawer = document.createElement('dialog'); drawer.id = 'taskDrawer'; drawer.className = 'task-drawer'; drawer.setAttribute('aria-label', '任务工作区');
  let returnFocus = null;
  const close = document.createElement('button'); close.textContent = '关闭任务列表'; close.onclick = () => drawer.close();
  const next = document.createElement('button'); next.textContent = '+ 新建下一次'; next.id = 'newDraftBtn';
  const resume = document.createElement('button'); resume.textContent = '返回未完成草稿'; resume.onclick = async () => { await restoreDraft(); await persist().catch(storageError); drawer.close(); };
  const list = document.createElement('div');
  const notice = document.createElement('div'); notice.className = 'task-notice'; notice.setAttribute('role', 'status');
  drawer.append(close, next, resume, list); document.body.append(capsule, drawer, notice);
  capsule.onclick = () => { if (!restored || !owner()) return; returnFocus = document.activeElement; unseen = 0; render(); drawer.showModal(); };
  drawer.addEventListener('cancel', () => { revision++; });
  drawer.addEventListener('close', () => { revision++; if (restored && owner()) (returnFocus?.isConnected ? returnFocus : capsule).focus(); });
  function storageError(e) { ns.setStatus(`工作区保存失败，不能安全提交：${e.message || e}`, 'error'); }
  const detailNext = next.cloneNode(true); detailNext.id = 'detailNewDraftBtn'; ns.els.runBtn.after(detailNext);
  detailNext.onclick = () => next.onclick();
  next.onclick = async () => {
    if (ns.state.isBusy) return;
    if (!selected) draft = captureDraft();
    if (selected && !registry.get(selected)?.taskId && !registry.get(selected)?.batchId && !window.confirm('提交状态未知。原请求和原标识将继续保留，不会重发。确认另开草稿？')) return;
    const specs = draft?.fields || captureDraft().fields;
    draft = { fields: specs, prompt: '', references: [], edit: null };
    ns.resetEditState?.(); await restoreDraft(); await persist().catch(storageError); drawer.close();
  };
  function render() {
    capsule.hidden = !restored || !owner();
    detailNext.hidden = !selected || !restored; detailNext.disabled = ns.state.isBusy;
    capsule.textContent = `任务 ${activeCount}/${limit}${unseen ? ` · ${unseen} 条新完成` : ''}`;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.actionKey : '';
    list.replaceChildren();
    next.disabled = ns.state.isBusy;
    for (const [id, task] of registry) {
      const card = document.createElement('article'); card.className = 'task-card';
      const open = document.createElement('button');
      open.dataset.actionKey = `open:${id}`;
      const labels = { completed: '已完成', partial_success: '部分成功', processing: '生成中', submitting: '提交中', submission_unknown: '提交状态未知', failed: '失败', pending: '等待中' };
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(task.createdAt)) / 1000));
      open.textContent = `${task.prompt || task.settings?.prompt || '请求'} · ${labels[task.status] || '需要关注'} · ${task.completedCount || 0}/${task.requestedCount || 1} · ${Number.isFinite(seconds) ? `已用时 ${Math.floor(seconds / 60)}分${seconds % 60}秒` : ''}`;
      open.onclick = () => openTask(id);
      const copy = document.createElement('button'); copy.textContent = '复制为新请求（含输入）';
      copy.disabled = ns.state.isBusy; copy.dataset.actionKey = `copy:${id}`;
      const url = task.imageUrls?.find(url => url.startsWith('/api/stored-images/'));
      if (url && !task.assetsDeleted) { const img = document.createElement('img'); img.src = url; img.alt = '任务缩略图'; img.width = 72; img.height = 72; card.append(img); }
      copy.onclick = () => copyTask(id);
      card.append(open, copy); list.append(card);
    }
    if (focused) [...list.querySelectorAll('button')].find(el => el.dataset.actionKey === focused)?.focus({ preventScroll: true });
  }
  function showSnapshot(task) {
    ns.els.prompt.value = task.prompt || '';
    const settings = task.settings || {};
    const values = { model: task.model || settings.model, aspectRatio: settings.size, resolution: settings.resolution, quality: settings.quality, imageCount: settings.n, outputFormat: settings.output_format, outputCompression: settings.output_compression };
    for (const [field, value] of Object.entries(values)) if (value !== undefined) ns.els[field].value = value;
    ns.state.referenceImages = []; ns.renderReferences(); ns.updatePromptStats();
  }
  async function openTask(id) {
    if (!restored || ns.state.isBusy || !registry.has(id)) return;
    if (!selected) draft = captureDraft();
    selected = id; revision++; ns.state.result = registry.get(id); showSnapshot(ns.state.result);
    ns.renderResult({ focus: false }); ns.updatePendingUi(); await persist().catch(storageError); drawer.close();
  }
  async function fetchInput(file, c) {
    if (!file.fileName || file.url !== `/api/stored-images/${file.fileName}`) throw new Error('输入图片地址无效');
    const response = await fetch(file.url, { cache: 'no-store', credentials: 'same-origin', headers: { Authorization: `Bearer ${c.token}` } });
    if (!response.ok) throw new Error('输入图片已删除或无权读取');
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > ns.constants.MAX_REFERENCE_IMAGE_BYTES) throw new Error('输入图片格式或大小不符合限制');
    return { id: ns.createIdempotencyKey(), type: 'file', name: '任务输入', value: await ns.referenceFileToDataUrl(blob), bytes: blob.size };
  }
  function requestInputs(task) {
    let files = task.inputFiles || [];
    if (task.kind === 'batch') {
      const children = task.children || [];
      const expected = Math.max(0, ...children.map(child => (child.inputFiles || []).length));
      const child = children[0];
      if (!child || child.assetsDeleted || (child.inputFiles || []).length !== expected) throw new Error('批次输入不完整或已删除，未复制。');
      files = child.inputFiles || [];
    }
    if (files.length > ns.constants.MAX_REFERENCE_IMAGES) throw new Error('参考图超过 16 张，未复制。');
    return files;
  }
  async function copyTask(id) {
    if (ns.state.isBusy) return;
    const c = context(), op = ++revision;
    const valid = () => current(c) && revision === op && !ns.state.isBusy;
    try {
      if (!await sync() || !valid()) return;
      const task = registry.get(id);
      if (!task || task.assetsDeleted) throw new Error('任务输入已删除或不可用');
      const references = [];
      for (const file of requestInputs(task)) {
        const ref = await fetchInput(file, c);
        if (!valid()) return;
        references.push(ref);
        if (references.reduce((sum, item) => sum + item.bytes, 0) > ns.constants.MAX_REFERENCE_TOTAL_BYTES) throw new Error('参考图合计超过 18MB，未复制。');
      }
      if (!valid()) return;
      const settings = task.settings || {};
      draft = { prompt: task.prompt || '', fields: { model: task.model || settings.model, aspectRatio: settings.size, resolution: settings.resolution, quality: settings.quality, imageCount: settings.n, outputFormat: settings.output_format, outputCompression: settings.output_compression }, references, edit: null };
      await restoreDraft();
      if (!current(c)) return;
      await persist(); drawer.close();
    } catch (e) { if (valid()) storageError(e); }
  }
  const oldUpdate = ns.updatePendingUi;
  ns.hasPendingGeneration = () => Boolean(selected);
  ns.updatePendingUi = () => {
    oldUpdate();
    const locked = ns.state.isBusy || Boolean(selected) || Boolean(hydrating);
    ns.els.runBtn.disabled = locked || activeCount >= limit || !restored;
    ns.els.runBtn.textContent = selected ? '任务详情（只读）' : activeCount >= limit ? `进行中请求已达上限 ${limit}` : ns.state.isBusy ? '提交中…' : '生成图片';
    ns.els.prompt.readOnly = Boolean(selected);
    for (const field of fields) ns.els[field].disabled = locked;
    ns.els.referenceUploadBtn.disabled = locked; ns.els.referenceFileInput.disabled = locked;
    ns.els.clearBtn.disabled = locked;
    ns.els.refreshCurrentTaskBtn?.classList.toggle('hidden', !selected);
    render();
  };
  ns.recoverPendingGeneration = async () => sync();
  ns.dismissTasklessSubmissionUnknown = async () => false;
  ns.reuseCurrentResult = () => copyTask(selected);
  ns.regenerateCurrentResult = () => copyTask(selected);
  const useResults = ns.useAllCurrentResultsAsReference;
  ns.useAllCurrentResultsAsReference = async () => {
    if (selected) return ns.setStatus('请先复制为新请求再添加参考图。', 'error');
    return useResults();
  };
  ns.workspaceSubmit = {
    ready: () => restored && !selected && !hydrating && activeCount < limit,
    capture: () => { revision++; draft = captureDraft(); },
    save: async (task) => { registry.set(task.id, { ...task, recovery: registry.get(task.id)?.recovery || structuredClone(task) }); await persist(); },
    remove: async (id) => { registry.delete(id); await persist(); },
    accepted: async (task) => { selected = task.id; revision++; ns.state.result = { ...task }; ns.renderResult({ focus: false }); await persist(); void sync(); },
    unknown: async (id) => {
      const task = registry.get(id);
      if (!task) return;
      selected = id; revision++; ns.state.result = task;
      ns.renderResult({ focus: false }); await persist(); void sync();
    },
    capacity: (error) => { activeCount = error.activeCount; limit = error.limit; }
  };
  function adapt(task, prior) {
    const children = task.kind === 'batch'
      ? task.children.map(child => ({ ...child, imageUrl: child.imageUrls?.[0] || '' }))
      : (task.imageUrls?.length ? task.imageUrls.map((imageUrl, index) => ({ ...task.children?.[0], index, imageUrl, status: 'completed' })) : task.children);
    const successful = children.filter(child => child.imageUrl).length;
    const failed = task.children.filter(child => !child.active && !['completed', 'succeeded', 'success'].includes(child.status)).length;
    const unknown = task.children.filter(child => ['submission_unknown', 'unknown', 'attention_required'].includes(child.status)).length;
    const status = task.kind === 'batch' && !task.active && successful > 0 && failed > 0 ? 'partial_success' : task.status;
    return { ...task, status, completedCount: successful || task.completedCount, recovery: prior?.recovery, children, settings: { ...task.settings, model: task.model }, counts: { succeeded: successful || task.completedCount, failed, unknown } };
  }
  function sync() {
    if (!owner() || !restored) return Promise.resolve(false);
    const c = context();
    if (runner && current(runner.context)) return runner.promise;
    const run = { context: c };
    runner = run;
    run.promise = refresh(c).finally(() => {
      if (runner !== run) return;
      runner = null;
      clearTimeout(timer);
      if (current(c)) timer = setTimeout(sync, document.hidden ? 15000 : 4000);
    });
    return run.promise;
  }
  async function refresh(c) {
    try {
      const feed = await ns.requestJson('/api/me/tasks', { signal: AbortSignal.timeout(20000) });
      if (!current(c) || !feed.ok || !Array.isArray(feed.json?.tasks)) return;
      activeCount = feed.json.activeCount; limit = feed.json.limit;
      const visible = new Set(feed.json.tasks.map(t => t.clientRequestId || t.id));
      for (const [id, task] of registry) if (!visible.has(id) && !task.active) registry.delete(id);
      for (const task of feed.json.tasks) {
        const id = task.clientRequestId || task.id;
        const prior = registry.get(id);
        registry.set(id, adapt(task, prior));
        if (prior?.active && !task.active) {
          unseen++; const button = document.createElement('button'); button.textContent = `任务已结束：${task.prompt.slice(0, 40)} · 查看`;
          button.onclick = () => { if (current(c)) void openTask(id); }; notice.replaceChildren(button);
          ns.loadMe(); ns.loadMyLogs();
        }
        if (selected === id) { ns.state.result = registry.get(id); ns.renderResult({ focus: false }); }
      }
      // One endpoint per active group, serialized; the next feed remains authoritative for settlement/assets.
      for (const task of feed.json.tasks.filter(t => t.active).slice(0, Math.max(1, limit))) {
        if (!current(c)) return;
        const path = task.batchId ? `batches/${encodeURIComponent(task.batchId)}` : task.taskId ? `tasks/${encodeURIComponent(task.taskId)}` : '';
        if (path) await ns.requestJson(`/api/api-market/v1/${path}`, { signal: AbortSignal.timeout(20000) });
      }
      if (current(c)) { await persist(); ns.updatePendingUi(); return true; }
    } catch (e) { if (current(c)) ns.setStatus('任务同步暂不可用；不会自动重发付费请求。', 'error'); }
    return false;
  }
  const reset = ns.resetAccountRuntime;
  ns.resetAccountRuntime = () => {
    if (owner() && restored) { if (!selected) draft = captureDraft(); persist().catch(() => {}); }
    clearTimeout(timer); restored = false; registry = new Map(); selected = ''; draft = null; activeCount = 0; unseen = 0; revision++;
    hydrating = null; runner = null; notice.replaceChildren(); drawer.close(); capsule.hidden = true; detailNext.hidden = true;
    reset(); render();
  };
  ns.restoreStoredResult = () => {}; // Task views never hydrate the composer.
  const legacyRestore = ns.restorePendingRequest;
  ns.restorePendingRequest = async () => {
    const c = context();
    try {
      const saved = await storage(null, c.email, true);
      if (!current(c)) return;
      registry = new Map((saved?.tasks || []).map(t => [t.clientRequestId || t.idempotencyKey || t.id, t]));
      draft = saved?.draft || captureDraft(); selected = saved?.selected || '';
      const legacy = await legacyRestore();
      if (!current(c)) return;
      if (legacy) { const id = legacy.idempotencyKey; if (!registry.has(id)) registry.set(id, { ...legacy, id, clientRequestId: id, prompt: legacy.settings.prompt, active: true, status: legacy.status || 'submission_unknown', imageUrls: [] }); }
      ns.state.pendingRequest = null; restored = true;
      const view = selected;
      await restoreDraft();
      if (view && registry.has(view)) { selected = view; ns.state.result = registry.get(view); showSnapshot(ns.state.result); ns.renderResult({ focus: false }); }
      await persist(); ns.updatePendingUi(); void sync();
    } catch (e) { if (current(c)) storageError(e); }
    return null;
  };
  const saveDraft = () => {
    if (hydrating || !restored || selected || !owner()) return;
    draft = captureDraft(); persist().catch(storageError);
  };
  ns.isWorkspaceReadOnly = () => Boolean(selected);
  ns.saveWorkspaceDraft = () => { revision++; saveDraft(); };
  document.addEventListener('input', () => { if (!selected) revision++; saveDraft(); });
  document.addEventListener('change', () => setTimeout(saveDraft, 0));
  for (const name of ['renderReferences', 'renderEditor']) {
    const original = ns[name];
    if (original) ns[name] = (...args) => { const result = original(...args); saveDraft(); return result; };
  }
  window.addEventListener('focus', () => void sync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
})();
