(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const SUCCESS_STATUSES = new Set(['completed', 'succeeded', 'success']);
  const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'error', 'submit_failed_refunded', 'submission_refunded_closed']);
  const BATCH_TERMINAL_STATUSES = new Set(['completed', 'succeeded', 'success', 'partial_success', 'partial', 'failed', 'cancelled', 'error', 'submission_refunded_closed']);
  const UNKNOWN_STATUSES = new Set(['submission_unknown', 'attention_required', 'unknown']);

  // ---- 任务完成浏览器通知 ----
  // Notification 不存在（老 webview）时开关隐藏；权限仅在用户主动开启时才请求；
  // 偏好按账号隔离存 localStorage（沿用 userStorageKey）。
  ns.notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;
  ns.notifyStorageKey = () => ns.userStorageKey?.('imageGenNotify') || '';
  ns.isNotifyEnabled = () => {
    const key = ns.notifyStorageKey();
    return Boolean(key && window.localStorage.getItem(key) === '1');
  };
  ns.setNotifyPref = (enabled) => {
    const key = ns.notifyStorageKey();
    if (!key) return;
    if (enabled) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  };
  ns.renderNotifyToggle = () => {
    const field = ns.els?.notifyToggleField;
    const toggle = ns.els?.notifyToggle;
    if (!field || !toggle) return;
    if (!ns.notificationsSupported()) {
      field.classList.add('hidden');
      return;
    }
    field.classList.remove('hidden');
    const denied = window.Notification.permission === 'denied';
    toggle.checked = ns.isNotifyEnabled() && !denied;
    toggle.disabled = denied;
    field.classList.toggle('is-disabled', denied);
    field.title = denied ? '浏览器已拒绝通知权限，请在站点设置中允许后再开启。' : '';
  };
  ns.handleNotifyToggle = async () => {
    const toggle = ns.els?.notifyToggle;
    if (!toggle || !ns.notificationsSupported()) return;
    if (!toggle.checked) {
      ns.setNotifyPref(false);
      ns.renderNotifyToggle();
      return;
    }
    const epoch = ns.state.accountEpoch, token = ns.state.session?.token, email = ns.state.session?.user?.email;
    let permission = window.Notification.permission;
    if (permission === 'default') {
      try { permission = await window.Notification.requestPermission(); } catch { permission = window.Notification.permission; }
    }
    if (!ns.isAccountContextCurrent(epoch, token, email)) return;
    if (permission === 'granted') {
      ns.setNotifyPref(true);
      ns.setStatus('已开启：任务到达终态且页面在后台时会发送浏览器通知。', 'ok');
    } else {
      ns.setNotifyPref(false);
      if (permission === 'denied') ns.setStatus('通知权限被拒绝，请在浏览器站点设置中允许后再开启。', 'error');
    }
    ns.renderNotifyToggle();
  };
  const notifiedKeys = new Set();
  ns.resetNotifyDedup = () => { notifiedKeys.clear(); };
  // 仅在偏好开启、权限 granted、页面不可见(document.hidden)时发通知；同一终态只发一次。
  ns.notifyGenerationComplete = (result, summary) => {
    if (!ns.notificationsSupported() || !ns.isNotifyEnabled()) return;
    if (window.Notification.permission !== 'granted') return;
    if (typeof document === 'undefined' || !document.hidden) return;
    const email = ns.state.session?.user?.email, epoch = ns.state.accountEpoch, token = ns.state.session?.token;
    if (!email || !token) return;
    const id = `${email}:${result?.clientRequestId || result?.id || result?.batchId || result?.taskId}:${result?.status || ''}`;
    if (notifiedKeys.has(id)) return;
    notifiedKeys.add(id);
    try {
      const notification = new window.Notification('图片生成完成', { body: summary, tag: id });
      notification.onclick = () => {
        if (ns.isAccountContextCurrent(epoch, token, email)) { try { window.focus(); } catch {} }
        notification.close();
      };
    } catch {}
  };

  ns.getProgressConfig = () => ({
    expectedDurationMs: Number(ns.state.publicConfig?.progress?.expectedDurationMs) || 85000,
    softCapPercent: Number(ns.state.publicConfig?.progress?.softCapPercent) || 90,
    hardCapPercent: Number(ns.state.publicConfig?.progress?.hardCapPercent) || 98,
    overtimeCurveSeconds: Number(ns.state.publicConfig?.progress?.overtimeCurveSeconds) || 45
  });
  ns.getSimulatedProgress = (elapsedMs, config = ns.getProgressConfig()) => {
    if (elapsedMs <= config.expectedDurationMs) return Math.min(config.softCapPercent, Math.round((elapsedMs / config.expectedDurationMs) * config.softCapPercent));
    const overtimeSeconds = (elapsedMs - config.expectedDurationMs) / 1000;
    const slowExtra = (config.hardCapPercent - config.softCapPercent) * (1 - Math.exp(-overtimeSeconds / config.overtimeCurveSeconds));
    return Math.min(config.hardCapPercent, Math.round(config.softCapPercent + slowExtra));
  };
  ns.setProgress = (percent) => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    ns.els.progressBar.style.width = `${clamped}%`;
    ns.els.progressPercent.textContent = `${clamped}%`;
    ns.els.progressTrack.setAttribute('aria-valuenow', String(clamped));
  };
  ns.resetGenerationSteps = () => {
    ns.state.currentGenerationStep = '';
    const items = Array.from(ns.els.generationSteps?.querySelectorAll('[data-step]') || []);
    for (const item of items) {
      item.classList.remove('is-done', 'is-active', 'is-error');
      item.removeAttribute('aria-current');
    }
  };
  ns.setGenerationStep = (step, type = 'active') => {
    ns.state.currentGenerationStep = step;
    const order = ns.generationStepOrder || [];
    const activeIndex = order.indexOf(step);
    const items = Array.from(ns.els.generationSteps?.querySelectorAll('[data-step]') || []);
    for (const item of items) {
      const index = order.indexOf(item.dataset.step);
      item.classList.remove('is-done', 'is-active', 'is-error');
      item.removeAttribute('aria-current');
      if (type === 'error' && item.dataset.step === step) item.classList.add('is-error');
      else if (index !== -1 && activeIndex !== -1 && index < activeIndex) item.classList.add('is-done');
      else if (item.dataset.step === step) {
        item.classList.add(type === 'done' ? 'is-done' : 'is-active');
        if (type !== 'done') item.setAttribute('aria-current', 'step');
      }
    }
  };
  ns.stopProgress = () => {
    if (ns.state.progressTimer) window.clearInterval(ns.state.progressTimer);
    ns.state.progressTimer = null;
  };
  // 判定一次提交是否走"便宜渠道多图 → 拆成多个独立单图任务"的批量路径。
  // 双保险：提交前可从参数预判（便宜渠道 && n>1 && 快速批量开启），或响应/记录已标记 kind==='batch'。
  // 官方模型 n>1 是单个上游任务（一个任务出 N 张图），不是批量。
  ns.isBatchSubmission = (settings = {}, kind = '') =>
    String(kind).toLowerCase() === 'batch' ||
    (Number(settings.n) > 1 && settings.model !== 'gpt-image-2-official' && ns.isQuickBatchEnabled());
  ns.startProgress = (requestedCount = 1, isBatch = false) => {
    ns.stopProgress();
    ns.resetGenerationSteps();
    ns.setGenerationStep('submit');
    ns.state.progressStartedAt = Date.now();
    ns.els.progressPanel.className = 'progress-panel';
    ns.els.progressHint.textContent = isBatch
      ? `正在提交 ${requestedCount} 个单图任务。进度按服务端返回的子任务计数更新。`
      : requestedCount > 1
        ? `正在生成 ${requestedCount} 张图片（单任务）。下方百分比是根据耗时估算，不是供应商真实进度。`
        : '正在提交生成任务。下方百分比是根据耗时估算，不是供应商真实进度。';
    ns.els.progressElapsed.textContent = '已用时 0 秒';
    ns.setProgress(isBatch ? 0 : 2);
    ns.state.progressTimer = window.setInterval(() => {
      const elapsedMs = Date.now() - ns.state.progressStartedAt;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      if (!isBatch) ns.setProgress(ns.getSimulatedProgress(elapsedMs));
      ns.els.progressElapsed.textContent = elapsedMs > ns.getProgressConfig().expectedDurationMs
        ? `已用时 ${elapsedSeconds} 秒，已超过预计耗时，请勿重复提交`
        : `已用时 ${elapsedSeconds} 秒`;
    }, 1000);
  };
  ns.completeProgress = (message = '处理完成。') => {
    ns.stopProgress();
    ns.setGenerationStep('done', 'done');
    ns.els.progressPanel.className = 'progress-panel ok';
    ns.els.progressHint.textContent = message;
    ns.els.progressElapsed.textContent = '已完成';
    ns.setProgress(100);
  };
  ns.failProgress = (message = '处理未完成，请查看错误信息。') => {
    ns.stopProgress();
    if (ns.state.currentGenerationStep) ns.setGenerationStep(ns.state.currentGenerationStep, 'error');
    ns.els.progressPanel.className = 'progress-panel error';
    ns.els.progressHint.textContent = message;
    ns.els.progressElapsed.textContent = '未完成';
  };
  ns.resetProgress = () => {
    ns.stopProgress();
    ns.resetGenerationSteps();
    ns.els.progressPanel.className = 'progress-panel hidden';
    ns.els.progressHint.textContent = '单任务通常 80~90 秒；批次按服务端真实子任务计数更新。';
    ns.els.progressElapsed.textContent = '已用时 0 秒';
    ns.setProgress(0);
  };

  ns.hasPendingGeneration = () => Boolean(ns.state.pendingRequest);
  ns.isTasklessSubmissionUnknown = (pending = ns.state.pendingRequest) => Boolean(
    pending &&
    String(pending.status || '').toLowerCase() === 'submission_unknown' &&
    !pending.taskId && !pending.task_id && !pending.batchId && !pending.batch_id
  );
  ns.dismissTasklessSubmissionUnknown = async () => {
    const pending = ns.state.pendingRequest;
    if (!ns.isTasklessSubmissionUnknown(pending)) return false;
    const confirmed = window.confirm('确认清除这条无任务编号的“提交状态未知”请求吗？\n\n这只会移除本设备的恢复锁定，不会退款、删除记录、重试或创建新任务。请先在作品库或由管理员核查。');
    if (!confirmed) return false;
    await ns.clearPendingRequestSafely(pending.ownerEmail || ns.state.session?.user?.email || '');
    return !ns.state.pendingRequest;
  };
  ns.updatePendingUi = () => {
    const pending = ns.hasPendingGeneration();
    const busy = ns.state.isBusy;
    const lockSettings = pending || busy;
    ns.els.runBtn.disabled = busy;
    ns.els.runBtn.textContent = pending ? (busy ? '刷新状态中...' : '刷新当前任务') : (busy ? '处理中...' : '生成图片');
    ns.els.clearBtn.disabled = busy || (pending && !ns.isTasklessSubmissionUnknown());
    ns.els.model.disabled = lockSettings;
    ns.els.aspectRatio.disabled = lockSettings;
    ns.els.resolution.disabled = lockSettings;
    ns.els.imageCount.disabled = lockSettings || (!ns.isOfficialModel() && !ns.isQuickBatchEnabled());
    ns.els.quality.disabled = lockSettings;
    ns.els.outputFormat.disabled = lockSettings;
    ns.els.outputCompression.disabled = lockSettings;
    ns.els.referenceUploadBtn.disabled = lockSettings;
    ns.els.referenceFileInput.disabled = lockSettings;
    if (ns.els.refreshCurrentTaskBtn) ns.els.refreshCurrentTaskBtn.classList.toggle('hidden', !pending);
    // 编辑面板与主生成共用 busy/pending 锁：锁定时禁用编辑提交/上传等控件。
    ns.updateEditControls?.();
  };
  ns.setBusy = (isBusy) => {
    ns.state.isBusy = isBusy;
    ns.updatePendingUi();
    ns.renderReferences();
  };

  ns.getSettings = () => {
    const settings = { model: ns.els.model.value, prompt: ns.els.prompt.value.trim(), n: ns.getImageCount(), size: ns.els.aspectRatio.value, resolution: ns.els.resolution.value };
    if (ns.isOfficialModel()) {
      settings.quality = ns.els.quality.value;
      settings.output_format = ns.els.outputFormat.value;
      if (ns.els.outputFormat.value !== 'png') settings.output_compression = Number(ns.els.outputCompression.value);
    }
    if (ns.state.referenceImages.length) settings.image_urls = ns.state.referenceImages.map((item) => item.value);
    return settings;
  };
  ns.extractTaskId = (result) => result?.task_id || result?.taskId || result?.data?.[0]?.task_id || result?.data?.[0]?.id || result?.data?.task_id || result?.data?.id || result?.id || '';
  ns.extractBatchId = (result) => result?.batch_id || result?.batchId || result?.data?.batch_id || result?.data?.batchId || '';
  ns.normalizeUrlValues = (value) => Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
  ns.extractImageUrls = (result) => {
    const data = result?.data;
    const resultObj = data?.result || result?.result || {};
    const images = resultObj?.images || data?.images || result?.images || [];
    const urls = [];
    for (const image of images) urls.push(...ns.normalizeUrlValues(image?.url || image?.image_url || image?.localUrl));
    if (Array.isArray(data)) {
      for (const item of data) urls.push(...ns.normalizeUrlValues(item?.url || item?.image_url || item?.localUrl));
    }
    urls.push(...ns.normalizeUrlValues(resultObj.url), ...ns.normalizeUrlValues(data?.url), ...ns.normalizeUrlValues(result?.url), ...ns.normalizeUrlValues(result?.imageUrls));
    return Array.from(new Set(urls.filter(Boolean)));
  };
  ns.getTaskStatus = (result) => String(result?.status || result?.data?.status || result?.task_status || result?.data?.task_status || '').toLowerCase();
  ns.extractActualCostMicros = (result) => {
    const billing = result?.billing || result?.aggregateBilling || result?.data?.billing || {};
    return billing.settled === true && Number.isSafeInteger(billing.actualCostMicros) && billing.actualCostMicros >= 0 ? billing.actualCostMicros : null;
  };

  ns.createIdempotencyKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  ns.submitGeneration = (settings, idempotencyKey, signal) => ns.requestJson('/api/api-market/v1/images/generations', {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(settings)
  });
  ns.isGenerationOperationCurrent = (operationToken, ownerEmail) => Boolean(
    operationToken &&
    ns.state.activeOperationToken === operationToken &&
    ns.state.session?.user?.email === ownerEmail
  );
  ns.isAmbiguousSubmissionStatus = (status) => status === 408 || status === 429 || status >= 500;
  ns.clearPendingRequestSafely = async (ownerEmail) => {
    try {
      await ns.savePendingRequest(null, ownerEmail);
    } catch {
      if (ns.state.session?.user?.email === ownerEmail && (!ns.state.pendingRequest?.ownerEmail || ns.state.pendingRequest.ownerEmail === ownerEmail)) {
        ns.state.pendingRequest = null;
        ns.updatePendingUi();
      }
    }
  };

  function normalizeChild(child, fallbackIndex) {
    const status = String(child?.status || child?.task_status || 'pending').toLowerCase();
    const urls = ns.extractImageUrls(child || {});
    return {
      index: Number.isSafeInteger(child?.index) ? child.index : fallbackIndex,
      status,
      taskId: child?.taskId || child?.task_id || '',
      imageUrl: child?.imageUrl || child?.image_url || child?.localImageUrl || urls[0] || '',
      imageUrls: urls,
      error: ns.toErrorText(child?.error) || ns.toErrorText(child?.message),
      billing: child?.billing || null
    };
  }
  ns.normalizeBatchResult = (json, context = {}) => {
    const source = json?.data && !Array.isArray(json.data) ? { ...json, ...json.data } : json || {};
    const requestedCount = Math.max(1, Math.min(4, Number(source.requestedCount || source.requested_count || source.requestedImageCount || context.requestedCount) || 1));
    const rawChildren = Array.isArray(source.children) ? source.children : [];
    const byIndex = new Map(rawChildren.map((child, index) => {
      const normalized = normalizeChild(child, index);
      return [normalized.index, normalized];
    }));
    const children = Array.from({ length: requestedCount }, (_, index) => byIndex.get(index) || normalizeChild(null, index));
    const derived = children.reduce((counts, child) => {
      if (SUCCESS_STATUSES.has(child.status)) counts.succeeded += 1;
      else if (FAILURE_STATUSES.has(child.status)) counts.failed += 1;
      else if (UNKNOWN_STATUSES.has(child.status)) counts.unknown += 1;
      else if (child.status === 'submitting') counts.submitting += 1;
      else if (child.status === 'submitted' || child.status === 'processing' || child.status === 'running' || child.taskId) counts.processing += 1;
      else counts.pending += 1;
      return counts;
    }, { pending: 0, submitting: 0, processing: 0, succeeded: 0, failed: 0, unknown: 0 });
    const counts = { ...derived, ...(source.counts || {}) };
    const imageUrls = children.flatMap((child) => child.imageUrl ? [child.imageUrl] : child.imageUrls).filter(Boolean);
    return {
      kind: 'batch',
      batchId: ns.extractBatchId(source) || context.batchId || '',
      taskId: '',
      prompt: context.prompt || '',
      settings: context.settings || {},
      requestedCount,
      status: String(source.status || 'processing').toLowerCase(),
      counts,
      children,
      imageUrls,
      billing: source.aggregateBilling || source.aggregate_billing || source.billing || null,
      debug: context.debug || null
    };
  };
  ns.normalizeTaskResult = (json, context = {}) => {
    const status = ns.getTaskStatus(json) || context.status || 'processing';
    const imageUrls = ns.extractImageUrls(json);
    const requestedCount = Math.max(1, Math.min(4, Number(context.settings?.n || imageUrls.length || 1)));
    return {
      kind: 'task',
      taskId: ns.extractTaskId(json) || context.taskId || '',
      batchId: '',
      prompt: context.prompt || '',
      settings: context.settings || {},
      requestedCount,
      status,
      counts: {
        pending: SUCCESS_STATUSES.has(status) || FAILURE_STATUSES.has(status) ? 0 : 1,
        processing: SUCCESS_STATUSES.has(status) || FAILURE_STATUSES.has(status) ? 0 : 1,
        succeeded: SUCCESS_STATUSES.has(status) ? imageUrls.length || requestedCount : 0,
        failed: FAILURE_STATUSES.has(status) ? requestedCount : 0,
        unknown: 0
      },
      children: imageUrls.map((url, index) => ({ index, status: 'completed', taskId: context.taskId || '', imageUrl: url, imageUrls: [url], error: '' })),
      imageUrls,
      billing: json?.billing || json?.data?.billing || null,
      debug: context.debug || null
    };
  };

  function updateBatchProgress(result) {
    const counts = result.counts || {};
    const finished = Number(counts.succeeded || 0) + Number(counts.failed || 0) + Number(counts.unknown || 0);
    const requested = result.requestedCount || 1;
    ns.setProgress((finished / requested) * 100);
    ns.els.progressHint.textContent = `已提交 ${requested}/${requested}，成功 ${counts.succeeded || 0}/${requested}，失败 ${counts.failed || 0}/${requested}，状态未知 ${counts.unknown || 0}/${requested}。`;
    ns.announceLive(`批次更新：成功 ${counts.succeeded || 0}，失败 ${counts.failed || 0}，状态未知 ${counts.unknown || 0}，共 ${requested} 张。`);
  }
  function persistAndRender(result, focus = false) {
    ns.state.result = result;
    ns.saveStoredResult();
    ns.renderResult({ focus });
    if (result.kind === 'batch') updateBatchProgress(result);
  }
  function isBatchTerminal(status) {
    return BATCH_TERMINAL_STATUSES.has(String(status || '').toLowerCase());
  }

  async function pollEndpoint(path, context, normalize, terminalCheck) {
    const intervalMs = Number(ns.polling.intervalMs) || 4000;
    const timeoutMs = Number(ns.polling.timeoutMs) || 240000;
    const initialDelayMs = Number(ns.polling.initialDelayMs) || 10000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    ns.state.pollController?.abort();
    ns.state.pollController = controller;
    const wait = async (delayMs) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || controller.signal.aborted) return false;
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(Date.now() < deadline && !controller.signal.aborted);
        }, Math.min(delayMs, remaining));
        const onAbort = () => {
          window.clearTimeout(timer);
          resolve(false);
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    };
    if (initialDelayMs && !await wait(initialDelayMs)) return { ok: false, code: controller.signal.aborted ? 'cancelled' : 'client_wait_timeout' };
    while (Date.now() < deadline) {
      if (context.operationToken && !ns.isGenerationOperationCurrent(context.operationToken, context.ownerEmail)) return { ok: false, code: 'account_changed' };
      let response;
      try {
        response = await ns.requestJson(path, { signal: controller.signal });
      } catch (error) {
        if (error?.name === 'AbortError') return { ok: false, code: 'cancelled' };
        throw error;
      }
      if (context.operationToken && !ns.isGenerationOperationCurrent(context.operationToken, context.ownerEmail)) return { ok: false, code: 'account_changed' };
      if (!response.ok) {
        if ([429, 502, 503, 504].includes(response.status)) {
          ns.setStatus('状态查询暂时繁忙，正在安全重试；不会创建新付费任务。', 'loading');
          if (!await wait(intervalMs)) break;
          continue;
        }
        return { ok: false, error: ns.getErrorMessage(response, `状态查询失败：HTTP ${response.status}`), debug: response.json || response.text };
      }
      const normalized = normalize(response.json || {}, context);
      persistAndRender(normalized);
      if (terminalCheck(normalized)) return { ok: true, result: normalized, debug: response.json };
      if (!await wait(intervalMs)) break;
    }
    const code = controller.signal.aborted ? 'cancelled' : 'client_wait_timeout';
    controller.abort();
    return { ok: false, code };
  }

  ns.pollTask = (taskId, context) => pollEndpoint(
    `/api/api-market/v1/tasks/${encodeURIComponent(taskId)}`,
    { ...context, taskId },
    ns.normalizeTaskResult,
    (result) => SUCCESS_STATUSES.has(result.status) || FAILURE_STATUSES.has(result.status) || UNKNOWN_STATUSES.has(result.status)
  );
  ns.pollBatch = (batchId, context, initialDelayMs) => {
    const previous = ns.polling.initialDelayMs;
    if (initialDelayMs !== undefined) ns.polling.initialDelayMs = initialDelayMs;
    const promise = pollEndpoint(
      `/api/api-market/v1/batches/${encodeURIComponent(batchId)}`,
      { ...context, batchId },
      ns.normalizeBatchResult,
      (result) => isBatchTerminal(result.status) || result.status === 'attention_required'
    );
    ns.polling.initialDelayMs = previous;
    return promise;
  };

  ns.validate = () => {
    if (!ns.state.session?.token) return ns.setStatus('请先登录。', 'error'), false;
    if (!ns.els.prompt.value.trim()) {
      ns.setStatus('请先输入提示词。', 'error');
      ns.els.prompt.focus();
      return false;
    }
    const count = Number(ns.els.imageCount.value);
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
      ns.setStatus('生成张数必须是 1–4 的整数。', 'error');
      ns.els.imageCount.focus();
      return false;
    }
    return true;
  };
  ns.shouldConfirmHighCost = () => ns.isOfficialModel() && (ns.els.quality.value === 'high' || ns.els.resolution.value === '4k' || ns.getImageCount() > 1);

  ns.handleRun = async () => {
    if (ns.hasPendingGeneration()) return ns.recoverPendingGeneration();
    ns.resetGenerationSteps();
    ns.setGenerationStep('validate');
    if (!ns.validate()) {
      ns.setGenerationStep('validate', 'error');
      return;
    }
    const estimate = ns.estimatePrice();
    if (!estimate.ok) {
      ns.setGenerationStep('validate', 'error');
      ns.updatePriceEstimate();
      ns.setStatus(`无法生成：${estimate.error || '价格配置异常。'}`, 'error');
      return;
    }
    const settings = ns.getSettings();
    const confirmLabel = estimate.isMaximum ? `最高预扣 ${ns.formatMicros(estimate.totalMicros)}` : `预计总价 ${ns.formatMicros(estimate.totalMicros)}`;
    const confirmBatch = !ns.isOfficialModel() && settings.n > 1;
    if (!ns.state.publicConfig?.features?.hybridImages && (estimate.isMaximum || ns.shouldConfirmHighCost() || confirmBatch)
      && !window.confirm(`生成 ${settings.n} 张，${confirmLabel}。继续？`)) return;

    await ns.runGeneration(settings);
  };

  // Single paid submission path shared by composer and annotation editor.
  ns.runGeneration = async (settings) => {
    if (ns.state.isBusy || (ns.workspaceSubmit && !ns.workspaceSubmit.ready())) return;
    ns.setBusy(true);
    const ownerEmail = ns.state.session?.user?.email;
    const epoch = ns.state.accountEpoch;
    const token = ns.state.session?.token;
    const current = () => epoch === ns.state.accountEpoch && token === ns.state.session?.token && ownerEmail === ns.state.session?.user?.email;
    const id = ns.createIdempotencyKey();
    let sent = false;
    const save = (task) => ns.workspaceSubmit ? ns.workspaceSubmit.save(task) : ns.savePendingRequest(task, ownerEmail);
    const remove = () => ns.workspaceSubmit ? ns.workspaceSubmit.remove(id) : ns.savePendingRequest(null, ownerEmail);
    try {
      settings = { ...settings };
      if (ns.state.publicConfig?.features?.hybridImages) {
        const price = ns.estimatePrice(settings);
        if (!price.ok || !window.confirm(`生成 ${settings.n || 1} 张，${price.isMaximum ? '最高' : '费用'} ${ns.formatMicros(price.totalMicros)}。继续？`)) return;
        settings.bestEffortAccepted = true;
      }
      if ((ns.estimateRequestBodyBytes?.(settings) || 0) > ns.MAX_UPSTREAM_BODY_BYTES) throw new Error('请求超过 24MB，请减少参考图。');
      ns.workspaceSubmit?.capture();
      const task = { id, clientRequestId: id, idempotencyKey: id, ownerEmail, settings, prompt: settings.prompt, status: 'submission_unknown', active: true, requestedCount: settings.n, imageUrls: [], createdAt: new Date().toISOString() };
      await save(task);
      if (!current()) return;
      sent = true;
      const response = await ns.submitGeneration(settings, id);
      if (!current()) return;
      if (!response.ok) {
        if (!ns.isAmbiguousSubmissionStatus(response.status)) await remove();
        if (response.json?.error?.code === 'active_request_limit') ns.workspaceSubmit?.capacity(response.json.error);
        throw new Error(ns.getErrorMessage(response, '提交失败；不确定的请求保留原标识，不会自动重发。'));
      }
      task.taskId = ns.extractTaskId(response.json); task.batchId = ns.extractBatchId(response.json);
      task.kind = task.batchId ? 'batch' : 'task'; task.status = ns.getTaskStatus(response.json) || 'processing';
      await save(task);
      if (!current()) return;
      await ns.workspaceSubmit?.accepted(task);
      ns.setStatus('请求已接受，可使用“+ 新建下一次”继续创作。', 'ok');
      void ns.loadMe();
    } catch (e) {
      if (current()) {
        if (!sent) await remove().catch(() => {});
        if (sent) await ns.workspaceSubmit?.unknown(id);
        ns.setStatus(`请求未完成：${e.message || e}。原标识会保留，不会自动重发。`, 'error');
      }
    } finally { if (current()) ns.setBusy(false); }
  };
  ns.recoverPendingGeneration = async () => {
    // Workspace replaces this with feed-only reconciliation; never replay an ambiguous POST.
    if (ns.state.pendingRequest?.ownerEmail !== ns.state.session?.user?.email) return;
    ns.setStatus('原请求已保留，请通过任务列表核查；不会自动重发。', 'loading');
  };
})();
