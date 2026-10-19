(() => {
  const ns = window.ImageGen;
  let registry = new Map(), selected = '', timer, runner = null, revision = 0, draftRevision = 0, unseen = 0;
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
  let draft = null, hydrating = null, restoring = false, restoration = null, editPreparation = null, draftHydrationError = null;
  function persist() {
    const email = owner();
    if (!email || !restored) return Promise.reject(new Error('工作区尚未恢复，请稍后重试。'));
    const snapshot = structuredClone({ draft, selected, tasks: [...registry.values()] });
    const next = writeChain.catch(() => {}).then(() => storage(snapshot, email));
    writeChain = next;
    return next;
  }
  async function restoreDraft({ strict = false } = {}) {
    let finish, assetFailure = false;
    const hydration = { context: context(), promise: new Promise(resolve => { finish = resolve; }) }; hydrating = hydration;
    ns.updatePendingUi();
    try {
    ns.invalidateReferenceReads?.();
    ns.resetResult();
    selected = ''; const rev = ++revision; const c = context();
    if (draft) {
      ns.els.prompt.value = draft.prompt || '';
      for (const field of fields) if (draft.fields?.[field] !== undefined) ns.els[field].value = draft.fields[field];
      ns.state.referenceImages = structuredClone(draft.references || []);
      ns.resetEditState?.();
      if (ns.els.editModel) ns.els.editModel.value = draft.editorFields?.editModel || ns.els.model.value;
      for (const [k, value] of Object.entries(draft.editorFields || {})) if (ns.els[k]) { if (k === 'editAppendToggle') ns.els[k].checked = value; else ns.els[k].value = value; }
      if (ns.els.editPrompt) ns.els.editPrompt.value = draft.editPrompt || '';
      if (draft.edit?.sourceUrl) {
        ns.state.edit = { ...structuredClone(draft.edit), image: null, referencesLoading: false, imageLoading: false };
        const edit = ns.state.edit;
        if (edit.sourceUrl) {
          let source = edit.sourceUrl;
          if (!source.startsWith('data:image/')) {
            try { source = (await fetchInput({ url: source, fileName: source.split('/').pop() }, c)).value; }
            catch (error) { if (strict) { assetFailure = true; throw error; } if (current(c) && revision === rev) ns.resetEditState?.(); source = ''; }
          }
          if (!current(c) || revision !== rev) return;
          await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => { if (current(c) && revision === rev && ns.state.edit === edit) { edit.image = image; edit.imageLoading = false; edit.referencesLoading = false; ns.renderEditor?.(); } resolve(); };
            image.onerror = () => { if (strict) { assetFailure = true; return reject(new Error('草稿底图载入失败，请重试。')); } if (current(c) && revision === rev && ns.state.edit === edit) ns.resetEditState?.(); resolve(); };
            image.src = source;
          });
        }
      }
    }
    if (!current(c) || revision !== rev) return;
    draftHydrationError = null;
    ns.updatePromptStats(); ns.updateModelUi(); ns.renderReferences(); ns.renderEditor?.();
    return true;
    } catch (error) {
      if (assetFailure && current(hydration.context)) {
        draftHydrationError = error;
        ns.renderEditor?.();
        ns.setStatus('草稿底图恢复失败，原草稿已保留。请重试，或明确选择新建草稿。', 'error');
      }
      throw error;
    } finally {
      finish();
      if (hydrating === hydration) { hydrating = null; ns.updatePendingUi(); render(); }
    }
  }
  const capsule = document.createElement('button');
  capsule.id = 'taskCapsule'; capsule.className = 'task-capsule'; capsule.type = 'button'; capsule.setAttribute('aria-haspopup', 'dialog');
  const drawer = document.createElement('dialog'); drawer.id = 'taskDrawer'; drawer.className = 'task-drawer'; drawer.setAttribute('aria-label', '任务工作区');
  let returnFocus = null;
  const close = document.createElement('button'); close.textContent = '×'; close.className = 'task-drawer-close'; close.setAttribute('aria-label', '关闭任务列表'); close.onclick = () => drawer.close();
  const next = document.createElement('button'); next.textContent = '+ 新建下一次'; next.id = 'newDraftBtn';
  const resume = document.createElement('button'); resume.textContent = '返回未完成草稿'; resume.onclick = async () => { if (await ns.prepareWorkspaceEdit()) drawer.close(); };
  const heading = document.createElement('div'); heading.className = 'task-drawer-heading';
  const title = document.createElement('h2'); title.id = 'taskDrawerTitle'; title.textContent = '最近创作';
  const drawerCount = document.createElement('span'); drawerCount.className = 'task-drawer-count';
  heading.append(title, drawerCount, close); drawer.setAttribute('aria-labelledby', title.id);
  const actions = document.createElement('div'); actions.className = 'task-drawer-actions'; actions.append(next, resume);
  const list = document.createElement('div'); list.className = 'task-gallery';
  const notice = document.createElement('div'); notice.className = 'task-notice'; notice.setAttribute('role', 'status');
  drawer.append(heading, actions, list); document.body.append(capsule, drawer, notice);
  capsule.onclick = () => { if (!restored || !owner()) return; returnFocus = document.activeElement; unseen = 0; render(); capsule.setAttribute('aria-expanded', 'true'); drawer.showModal(); };
  drawer.addEventListener('cancel', () => { revision++; });
  drawer.addEventListener('close', () => { revision++; capsule.setAttribute('aria-expanded', 'false'); if (restored && owner()) (returnFocus?.isConnected ? returnFocus : capsule).focus(); });
  function storageError(e) { ns.setStatus(`工作区保存失败，不能安全提交：${e.message || e}`, 'error'); }
  const detailNext = next.cloneNode(true); detailNext.id = 'detailNewDraftBtn'; ns.els.runBtn.after(detailNext);
  detailNext.onclick = () => next.onclick();
  next.onclick = async () => {
    if (ns.state.isBusy || restoring || hydrating || editPreparation) return;
    if (!selected && !draftHydrationError) draft = captureDraft();
    if (selected && !registry.get(selected)?.taskId && !registry.get(selected)?.batchId && !window.confirm('提交状态未知。原请求和原标识将继续保留，不会重发。确认另开草稿？')) return;
    if (!confirmDraftReplacement()) return;
    const specs = draft?.fields || captureDraft().fields;
    draftHydrationError = null;
    draft = { fields: specs, prompt: '', references: [], edit: null };
    ns.resetEditState?.(); await restoreDraft(); await persist().catch(storageError); drawer.close();
  };
  const recoveryPanels = ['status', 'editEmptyStatus'].filter(name => ns.els[name]).map(name => {
    const panel = document.createElement('div'); panel.dataset.workspaceDraftRecovery = 'true'; panel.setAttribute('role', 'alert');
    const message = document.createElement('p');
    const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.retryWorkspaceDraft = 'true'; retry.textContent = '重试恢复草稿';
    retry.onclick = () => ns.prepareWorkspaceEdit();
    const discard = document.createElement('button'); discard.type = 'button'; discard.dataset.replaceWorkspaceDraft = 'true'; discard.textContent = '放弃旧草稿并新建';
    discard.onclick = () => next.onclick();
    panel.append(message, retry, discard); ns.els[name].after(panel);
    return { panel, message, retry, discard };
  });
  function renderDraftRecovery() {
    for (const { panel, message, retry, discard } of recoveryPanels) {
      panel.hidden = !draftHydrationError || !restored || !owner();
      message.textContent = draftHydrationError ? `草稿底图恢复失败：${draftHydrationError.message || draftHydrationError}。原草稿及参考图已保留；可重试、查看任务，或放弃旧草稿后新建。` : '';
      retry.disabled = discard.disabled = ns.state.isBusy || restoring || Boolean(hydrating) || Boolean(editPreparation);
    }
  }
  function confirmDraftReplacement() {
    return !draftHydrationError || window.confirm('旧草稿底图尚未恢复。此操作会放弃旧草稿（含标注和参考图），任务记录仍保留。继续？');
  }
  function promptPreview(value) {
    const letters = Array.from(String(value || '未命名创作').replace(/\s+/g, ' ').trim());
    return letters.slice(0, 15).join('') + (letters.length > 15 ? '…' : '');
  }
  function taskLabel(task) {
    if (['submission_unknown', 'unknown'].includes(task.status)) return '状态待确认';
    if (task.active) return '生成中';
    return task.status === 'partial_success' ? '部分完成' : task.imageUrls?.length ? '已完成' : '未生成图片';
  }
  function taskPicture(task, compact = false, priorImages = new Map()) {
    const visual = document.createElement('span'); visual.className = 'task-picture';
    const url = !task.assetsDeleted && task.imageUrls?.map(value => ns.storedImageThumbnailUrl(value)).find(Boolean);
    if (url) {
      const image = priorImages.get(url) || document.createElement('img');
      if (!priorImages.has(url)) {
        image.src = url; image.alt = ''; image.loading = compact ? 'eager' : 'lazy'; image.decoding = 'async';
        image.addEventListener('error', () => { image.closest('.task-picture')?.classList.add('is-unavailable'); image.remove(); }, { once: true });
      }
      visual.append(image);
    } else {
      visual.classList.add(task.active ? 'is-generating' : 'is-empty');
    }
    // Decorative only; prompt and task status remain accessible on the containing button.
    const placeholder = document.createElement('span'); placeholder.className = 'task-picture-placeholder'; placeholder.setAttribute('aria-hidden', 'true');
    placeholder.innerHTML = '<svg viewBox="0 0 32 32" fill="none"><rect x="5" y="6" width="22" height="20" rx="5" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="m6 23 7-7 5 5 4-4 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    visual.append(placeholder); return visual;
  }
  let capsuleSignature = '', drawerSignature = '';
  const taskCards = new Map();
  function render() {
    renderDraftRecovery();
    capsule.hidden = !restored || !owner();
    detailNext.hidden = !selected || !restored; detailNext.disabled = ns.state.isBusy;
    const tasks = [...registry.entries()].sort((a, b) => Date.parse(b[1].createdAt || '') - Date.parse(a[1].createdAt || ''));
    const recent = tasks.slice(0, 3), latest = recent[0]?.[1];
    const nextCapsuleSignature = JSON.stringify([recent, activeCount, unseen]);
    if (capsuleSignature !== nextCapsuleSignature) {
      capsuleSignature = nextCapsuleSignature;
      const priorCapsuleImages = new Map([...capsule.querySelectorAll('.task-picture')].map(visual => [visual.dataset.taskId, visual.querySelector('img')]));
      const stack = document.createElement('span'); stack.className = 'task-capsule-stack'; stack.setAttribute('aria-hidden', 'true');
      for (const [id, task] of recent.slice().reverse()) {
        const priorImage = priorCapsuleImages.get(id);
        const visual = taskPicture(task, true, priorImage ? new Map([[priorImage.getAttribute('src'), priorImage]]) : new Map());
        visual.dataset.taskId = id; stack.append(visual);
      }
      if (!latest) stack.append(taskPicture({} , true));
      const caption = document.createElement('span'); caption.className = 'task-capsule-caption'; caption.textContent = latest ? promptPreview(latest.prompt || latest.settings?.prompt) : '最近创作';
      const arrow = document.createElement('span'); arrow.className = 'task-capsule-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      capsule.replaceChildren(stack, caption, arrow); capsule.classList.toggle('has-active', activeCount > 0);
      capsule.setAttribute('aria-label', `打开最近任务，${activeCount} 个进行中${unseen ? `，${unseen} 个新完成` : ''}`);
      if (activeCount || unseen) {
        const badge = document.createElement('span'); badge.className = `task-capsule-badge${unseen ? ' is-unread' : ''}`; badge.textContent = String(unseen || activeCount); badge.setAttribute('aria-hidden', 'true'); capsule.append(badge);
      }
    }
    next.disabled = ns.state.isBusy;
    const nextDrawerSignature = JSON.stringify([tasks, selected, ns.state.isBusy]);
    if (drawerSignature === nextDrawerSignature) return;
    drawerSignature = nextDrawerSignature;
    drawerCount.textContent = String(tasks.length); drawerCount.setAttribute('aria-label', `${tasks.length} 个任务`);
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.actionKey : '';
    for (const [id, cached] of taskCards) if (!registry.has(id)) { cached.node.remove(); taskCards.delete(id); }
    let position = list.firstElementChild;
    for (const [id, task] of tasks) {
      const signature = JSON.stringify([task, selected === id, ns.state.isBusy]);
      const cached = taskCards.get(id);
      if (cached?.signature === signature) {
        if (cached.node !== position) list.insertBefore(cached.node, position);
        position = cached.node.nextElementSibling;
        continue;
      }
      const card = document.createElement('article'); card.className = 'task-card'; card.classList.toggle('is-selected', selected === id);
      const open = document.createElement('button'); open.className = 'task-card-open'; open.dataset.actionKey = `open:${id}`;
      const prompt = task.prompt || task.settings?.prompt || '未命名创作';
      open.setAttribute('aria-label', `${promptPreview(prompt)}，${taskLabel(task)}，查看详情`);
      const priorImages = new Map([...(cached?.node.querySelectorAll('img') || [])].map(img => [img.getAttribute('src'), img]));
      const visual = taskPicture(task, false, priorImages);
      const status = document.createElement('span'); status.className = `task-card-status${task.active ? ' is-active' : ''}${task.status === 'submission_unknown' ? ' is-unknown' : ''}`; status.setAttribute('aria-label', taskLabel(task)); status.title = taskLabel(task);
      visual.append(status);
      if (task.requestedCount > 1) { const count = document.createElement('span'); count.className = 'task-card-count'; count.textContent = `${task.completedCount || 0}/${task.requestedCount}`; visual.append(count); }
      const label = document.createElement('span'); label.className = 'task-card-prompt'; label.textContent = promptPreview(prompt);
      open.append(visual, label); open.onclick = () => openTask(id);
      const copy = document.createElement('button'); copy.className = 'task-card-copy'; copy.textContent = '↗'; copy.setAttribute('aria-label', '复制为新请求（含输入）'); copy.title = '复制为新请求（含输入）';
      copy.disabled = ns.state.isBusy; copy.dataset.actionKey = `copy:${id}`; copy.onclick = () => copyTask(id);
      card.append(open, copy);
      if (cached) { if (position === cached.node) position = cached.node.nextElementSibling; cached.node.remove(); }
      list.insertBefore(card, position); position = card.nextElementSibling;
      taskCards.set(id, { signature, node: card });
    }
    while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
    if (!tasks.length) { list.replaceChildren(); const empty = document.createElement('p'); empty.className = 'task-gallery-empty'; empty.textContent = '你的创作会出现在这里'; list.append(empty); }
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
    if (!restored || restoring || hydrating || editPreparation || ns.state.isBusy || !registry.has(id)) return;
    if (!selected && !draftHydrationError) draft = captureDraft();
    ns.invalidateReferenceReads?.();
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
    const expected = task.referenceImageCount;
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('原请求参考图数量未知，无法完整复制。');
    if (expected > ns.constants.MAX_REFERENCE_IMAGES) throw new Error('参考图超过 16 张，未复制。');
    let files = task.inputFiles || [];
    if (task.kind === 'batch') {
      const child = task.children?.[0];
      if (!child || child.assetsDeleted) throw new Error('批次输入不完整或已删除，未复制。');
      if (child.referenceImageCount !== expected) throw new Error('批次原请求参考图数量未知或不一致，未复制。');
      files = child.inputFiles || [];
    }
    if (files.length !== expected) throw new Error('原请求输入不完整或不可用，未复制。');
    return files;
  }
  async function copyTask(id) {
    if (ns.state.isBusy || restoring || hydrating || editPreparation) return;
    if (!confirmDraftReplacement()) return;
    const referenceGeneration = ns.invalidateReferenceReads();
    const c = context(), op = ++revision;
    const valid = () => current(c) && revision === op && ns.isReferenceGenerationCurrent(referenceGeneration) && !ns.state.isBusy;
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
      draftHydrationError = null;
      draft = { prompt: task.prompt || '', fields: { model: task.model || settings.model, aspectRatio: settings.size, resolution: settings.resolution, quality: settings.quality, imageCount: settings.n, outputFormat: settings.output_format, outputCompression: settings.output_compression }, references, edit: null };
      await restoreDraft();
      if (!current(c)) return;
      await persist().catch(storageError); if (current(c)) drawer.close();
    } catch (e) { if (valid()) storageError(e); }
  }
  const oldUpdate = ns.updatePendingUi;
  ns.hasPendingGeneration = () => Boolean(selected);
  ns.isWorkspaceEditLocked = () => !restored || restoring || Boolean(selected) || Boolean(hydrating) || Boolean(editPreparation) || Boolean(draftHydrationError);
  // Editing resumes the saved composer/editor draft, never the selected task snapshot.
  // All entry points share this operation so a late tab activation cannot reset a new image.
  ns.prepareWorkspaceEdit = () => {
    if (editPreparation && current(editPreparation.context)) return editPreparation.promise;
    const c = context();
    const operation = { context: c };
    editPreparation = operation;
    operation.promise = Promise.resolve().then(async () => {
      if (restoring && restoration) await restoration;
      if (hydrating) await hydrating.promise;
      if (!current(c)) return false;
      if (!restored || restoring) throw new Error('工作区尚未恢复，请稍后重试。');
      if (!selected && !draftHydrationError) return true;
      if (ns.state.isBusy || ns.state.edit?.imageLoading || ns.state.edit?.referencesLoading) {
        throw new Error('正在提交或读取图片，请稍候再进入编辑。');
      }
      const view = selected, op = revision + 1, priorHydrationError = draftHydrationError;
      try {
        if (!await restoreDraft({ strict: true }) || !current(c) || revision !== op) throw new Error('草稿已变化，请重新进入编辑。');
        await persist();
        if (!current(c)) return false;
        if (revision !== op || selected) throw new Error('草稿已变化，请重新进入编辑。');
        return true;
      } catch (error) {
        if (current(c) && priorHydrationError) draftHydrationError = priorHydrationError;
        if (current(c) && !selected) {
          selected = view;
          ns.state.result = registry.get(view) || null;
          if (ns.state.result) { showSnapshot(ns.state.result); ns.renderResult({ focus: false }); }
        }
        throw error;
      }
    }).catch(error => {
      if (current(c)) {
        const message = `无法安全进入编辑：${error.message || error}`;
        ns.setEditStatus?.(message, 'error'); ns.setEditEmptyStatus?.(message, 'error');
      }
      return false;
    }).finally(() => {
      if (editPreparation === operation) { editPreparation = null; ns.updatePendingUi(); }
    });
    ns.updatePendingUi();
    return operation.promise;
  };
  ns.applyWorkspaceLocks = () => {
    const locked = ns.state.isBusy || ns.isWorkspaceEditLocked();
    ns.els.runBtn.disabled = locked || activeCount >= limit || !restored || !ns.estimatePrice().ok;
    ns.els.runBtn.textContent = selected ? '查看中 · 请新建下一次' : activeCount >= limit ? `进行中请求已达上限 ${limit}` : ns.state.isBusy ? '提交中…' : '生成图片';
    ns.els.model.title = selected ? '已提交任务的模式不可修改，点击“新建下一次”继续生成。' : '';
    ns.els.prompt.readOnly = ns.isWorkspaceReadOnly();
    for (const field of fields) ns.els[field].disabled = locked;
    const countUnsupported = !ns.isOfficialModel() && !ns.isQuickBatchEnabled();
    if (countUnsupported && !selected) ns.els.imageCount.value = '1';
    ns.els.imageCount.disabled = locked || countUnsupported;
    ns.els.referenceUploadBtn.disabled = locked; ns.els.referenceFileInput.disabled = locked;
    ns.els.clearBtn.disabled = locked;
    ns.els.refreshCurrentTaskBtn?.classList.toggle('hidden', !selected);
  };
  ns.updatePendingUi = () => {
    oldUpdate();
    ns.applyWorkspaceLocks();
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
    ready: () => !ns.isWorkspaceEditLocked() && activeCount < limit,
    blockedReason: () => draftHydrationError ? '草稿底图尚未恢复，请重试恢复，或放弃旧草稿后新建。' : activeCount >= limit ? `进行中请求已达上限 ${limit}，可继续编辑草稿，待任务结束后再提交。` : '工作区尚未准备好，请稍候再提交。',
    capture: () => { revision++; draft = captureDraft(); },
    save: async (task) => { registry.set(task.id, { ...task, recovery: registry.get(task.id)?.recovery || structuredClone(task) }); await persist(); },
    remove: async (id) => { registry.delete(id); await persist(); },
    accepted: async (task) => { ns.invalidateReferenceReads?.(); selected = task.id; revision++; ns.state.result = { ...task }; ns.renderResult({ focus: false }); await persist(); void sync(); },
    unknown: async (id) => {
      const task = registry.get(id);
      if (!task) return;
      ns.invalidateReferenceReads?.();
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
      let completed = false;
      const visible = new Set(feed.json.tasks.map(t => t.clientRequestId || t.id));
      for (const [id, task] of registry) if (!visible.has(id) && !task.active && !task.unresolvedLegacy) registry.delete(id);
      for (const task of feed.json.tasks) {
        const id = task.clientRequestId || task.id;
        const prior = registry.get(id);
        registry.set(id, adapt(task, prior));
        if (prior?.active && !task.active) {
          unseen++; const button = document.createElement('button'); button.textContent = `${promptPreview(task.prompt)} · 查看`;
          button.onclick = () => { if (current(c)) void openTask(id); }; notice.replaceChildren(button);
          ns.notifyGenerationComplete(registry.get(id), `${promptPreview(task.prompt)} · ${taskLabel(registry.get(id))}`);
          completed = true;
        }
        if (selected === id) { ns.state.result = registry.get(id); ns.renderResult({ focus: false }); }
      }
      if (completed) { void ns.loadMe(); ns.markHistoryDirty(); }
      // One endpoint per active group, serialized; the next feed remains authoritative for settlement/assets.
      for (const task of feed.json.tasks.filter(t => t.active).slice(0, Math.max(1, limit))) {
        if (!current(c)) return;
        const path = task.batchId ? `batches/${encodeURIComponent(task.batchId)}` : task.taskId ? `tasks/${encodeURIComponent(task.taskId)}` : '';
        if (path) await ns.requestJson(`/api/api-market/v1/${path}`, { signal: AbortSignal.timeout(20000) });
      }
      if (current(c)) { await persist(); if (!current(c)) return false; ns.updatePendingUi(); return true; }
    } catch (e) { if (current(c)) ns.setStatus('任务同步暂不可用；不会自动重发付费请求。', 'error'); }
    return false;
  }
  const reset = ns.resetAccountRuntime;
  ns.resetAccountRuntime = () => {
    if (owner() && restored) { if (!selected && !hydrating && !restoring && !editPreparation && !draftHydrationError) draft = captureDraft(); persist().catch(() => {}); }
    clearTimeout(timer); restored = false; registry = new Map(); selected = ''; draft = null; draftHydrationError = null; activeCount = 0; unseen = 0; revision++;
    capsuleSignature = ''; drawerSignature = ''; taskCards.clear(); capsule.replaceChildren(); list.replaceChildren();
    hydrating = null; restoring = false; restoration = null; editPreparation = null; runner = null; notice.replaceChildren(); drawer.close(); capsule.hidden = true; detailNext.hidden = true;
    for (const id of ['previewHistoryDetailContent', 'previewHistoryDetailGallery', 'previewHistoryDialogSubtitle']) document.getElementById(id)?.replaceChildren();
    const detailImage = document.getElementById('previewHistoryDetailImage');
    if (detailImage) { detailImage.removeAttribute('src'); detailImage.hidden = true; }
    document.getElementById('previewHistoryOpenOriginal')?.removeAttribute('href');
    document.getElementById('previewHistoryDialog')?.close();
    reset(); render();
  };
  ns.restoreStoredResult = () => {}; // Task views never hydrate the composer.
  const legacyRestore = ns.restorePendingRequest;
  async function restoreWorkspace() {
    const c = context();
    restoring = true; ns.updatePendingUi();
    try {
      const saved = await storage(null, c.email, true);
      if (!current(c)) return;
      registry = new Map((saved?.tasks || []).map(t => [t.clientRequestId || t.idempotencyKey || t.id, t]));
      draft = saved?.draft || captureDraft(); selected = saved?.selected || '';
      const legacy = await legacyRestore();
      if (!current(c)) return;
      if (legacy) {
        const id = legacy.idempotencyKey;
        const status = legacy.status || 'submission_unknown';
        const unresolved = ['active', 'attention'].includes(ns.classifyLogStatus(status).group);
        if (!registry.has(id)) registry.set(id, { ...legacy, id, clientRequestId: id, prompt: legacy.settings.prompt, active: unresolved && Boolean(legacy.taskId || legacy.batchId), status, unresolvedLegacy: unresolved && !legacy.taskId && !legacy.batchId, imageUrls: [] });
        // Preserve full local evidence even if a later authoritative DTO omits request inputs.
        const imported = registry.get(id);
        if (!imported.recovery || (!Array.isArray(imported.recovery.settings?.image_urls) && legacy.legacyRecoveryComplete)) imported.recovery = structuredClone(legacy);
      }
      ns.state.pendingRequest = null; restored = true;
      const view = selected;
      try { await restoreDraft({ strict: true }); }
      catch (error) { if (!current(c)) return; if (!draftHydrationError) throw error; }
      if (!current(c)) return;
      if (view && registry.has(view)) { selected = view; ns.state.result = registry.get(view); showSnapshot(ns.state.result); ns.renderResult({ focus: false }); }
      await persist();
      if (!current(c)) return;
      if (legacy?.legacySourceReadComplete) await ns.consumeLegacyPendingRequest(c.email);
      if (!current(c)) return;
      restoring = false; ns.updatePendingUi(); void sync();
      if (!draftHydrationError && window.location.hash === '#edit') void ns.prepareWorkspaceEdit();
    } catch (e) { if (current(c)) storageError(e); }
    return null;
  }
  ns.restorePendingRequest = () => { restoration = restoreWorkspace(); return restoration; };
  const saveDraft = () => {
    if (hydrating || editPreparation || restoring || draftHydrationError || !restored || selected || !owner()) return writeChain;
    draft = captureDraft();
    const saved = persist();
    saved.catch(storageError);
    return saved;
  };
  ns.isWorkspaceReadOnly = () => Boolean(selected) || Boolean(hydrating) || restoring || Boolean(editPreparation) || Boolean(draftHydrationError);
  ns.getWorkspaceDraftRevision = () => draftRevision;
  ns.invalidateWorkspaceDraftOperation = () => { draftRevision++; };
  ns.saveWorkspaceDraft = () => { revision++; draftRevision++; return saveDraft(); };
  ns.flushWorkspace = () => writeChain;
  document.addEventListener('input', () => { if (!selected) { revision++; draftRevision++; } saveDraft(); });
  document.addEventListener('change', () => { if (!selected) { revision++; draftRevision++; } saveDraft(); });
  for (const name of ['renderReferences', 'renderEditor']) {
    const original = ns[name];
    if (original) ns[name] = (...args) => { const result = original(...args); saveDraft(); return result; };
  }
  window.addEventListener('focus', () => void sync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
})();
