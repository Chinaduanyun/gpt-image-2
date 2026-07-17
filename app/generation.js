(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const SUCCESS_STATUSES = new Set(['completed', 'succeeded', 'success']);
  const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'error', 'submit_failed_refunded']);
  const BATCH_TERMINAL_STATUSES = new Set(['completed', 'succeeded', 'success', 'partial_success', 'partial', 'failed', 'cancelled', 'error']);
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
    let permission = window.Notification.permission;
    if (permission === 'default') {
      try { permission = await window.Notification.requestPermission(); } catch { permission = window.Notification.permission; }
    }
    if (permission === 'granted') {
      ns.setNotifyPref(true);
      ns.setStatus('已开启：任务到达终态且页面在后台时会发送浏览器通知。', 'ok');
    } else {
      ns.setNotifyPref(false);
      if (permission === 'denied') ns.setStatus('通知权限被拒绝，请在浏览器站点设置中允许后再开启。', 'error');
    }
    ns.renderNotifyToggle();
  };
  let lastNotifiedKey = '';
  ns.resetNotifyDedup = () => { lastNotifiedKey = ''; };
  // 仅在偏好开启、权限 granted、页面不可见(document.hidden)时发通知；同一终态只发一次。
  ns.notifyGenerationComplete = (result, summary) => {
    if (!ns.notificationsSupported() || !ns.isNotifyEnabled()) return;
    if (window.Notification.permission !== 'granted') return;
    if (typeof document === 'undefined' || !document.hidden) return;
    const id = `${result?.batchId || result?.taskId || 'result'}:${result?.status || ''}`;
    if (id === lastNotifiedKey) return;
    lastNotifiedKey = id;
    try {
      const notification = new window.Notification('图片生成完成', { body: summary, tag: id });
      notification.onclick = () => {
        try { window.focus(); } catch {}
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
    (result) => SUCCESS_STATUSES.has(result.status) || FAILURE_STATUSES.has(result.status)
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

  async function finishPolling(pollResult, pending, submitDebug, operationToken) {
    if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    if (!pollResult.ok && ['cancelled', 'account_changed'].includes(pollResult.code)) return;
    await ns.loadMe();
    if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    await ns.loadMyLogs();
    if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    if (ns.state.session?.user?.isAdmin) await ns.loadAdminData();
    if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    if (!pollResult.ok) {
      if (pollResult.code === 'client_wait_timeout') {
        ns.stopProgress();
        ns.els.progressPanel.className = 'progress-panel';
        ns.els.progressHint.textContent = '客户端等待超时，任务仍在后台处理。刷新只查询当前任务，不会再次付费提交。';
        ns.els.progressElapsed.textContent = '后台处理中';
        ns.setStatus('等待超时。请使用“刷新当前任务”或稍后在作品库查看，系统已锁定重复提交。', 'loading');
        ns.showDebug(pollResult.debug || submitDebug);
        return;
      }
      ns.failProgress();
      ns.setStatus(`状态查询失败：${pollResult.error}`, 'error');
      ns.showDebug(pollResult.debug || submitDebug);
      return;
    }
    const result = pollResult.result;
    persistAndRender(result, true);
    if (result.status === 'attention_required') {
      ns.stopProgress();
      ns.els.progressPanel.className = 'progress-panel error';
      ns.els.progressHint.textContent = '部分子任务状态未知，需要继续刷新或人工确认；不会自动重发或退款。';
      ns.setStatus('批次需要关注：状态未知的子任务不会自动重发，以避免重复计费。', 'error');
      ns.notifyGenerationComplete(result, `批次需要关注：${result.counts?.unknown || 0} 张子任务状态未知。`);
      return;
    }
    await ns.clearPendingRequestSafely(pending.ownerEmail);
    if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    if (result.kind === 'batch') {
      const { succeeded = 0, failed = 0, unknown = 0 } = result.counts || {};
      if (SUCCESS_STATUSES.has(result.status)) {
        ns.completeProgress('批次全部完成。');
        ns.setStatus(`批次完成：${succeeded}/${result.requestedCount} 张成功。`, 'ok');
      } else if (result.status === 'partial_success' || result.status === 'partial') {
        ns.completeProgress('批次部分完成，成功图片已保留。');
        ns.setStatus(`批次部分完成：${succeeded}/${result.requestedCount} 张成功，${failed} 张失败，${unknown} 张状态未知。`, 'ok');
      } else {
        ns.failProgress('批次未生成成功图片。');
        ns.setStatus(`批次失败：${failed}/${result.requestedCount} 张失败。`, 'error');
      }
    } else if (SUCCESS_STATUSES.has(result.status) && result.imageUrls.length) {
      ns.completeProgress();
      const actual = ns.extractActualCostMicros({ billing: result.billing });
      ns.setStatus(`图片生成完成，共 ${result.imageUrls.length} 张。${actual === null ? '' : `实际费用 ${ns.formatMicros(actual)}。`}`, 'ok');
    } else {
      ns.failProgress();
      ns.setStatus('生成失败，请查看错误信息或作品库记录。', 'error');
    }
    const counts = result.counts || {};
    const notifyBody = result.kind === 'batch'
      ? `批次结束：${counts.succeeded || 0}/${result.requestedCount} 张成功${counts.failed ? `，${counts.failed} 失败` : ''}${counts.unknown ? `，${counts.unknown} 未知` : ''}。`
      : (SUCCESS_STATUSES.has(result.status) && result.imageUrls.length ? `已生成 ${result.imageUrls.length} 张图片。` : '生成失败，请查看错误信息。');
    ns.notifyGenerationComplete(result, notifyBody);
  }

  async function pollPending(pending, operationToken, initialDelayMs = 0) {
    const context = { prompt: pending.settings.prompt, settings: pending.settings, requestedCount: pending.requestedCount, ownerEmail: pending.ownerEmail, operationToken };
    if (pending.kind === 'batch' && pending.batchId) return ns.pollBatch(pending.batchId, context, initialDelayMs);
    if (pending.taskId) return ns.pollTask(pending.taskId, context);
    return { ok: false, error: '当前请求尚未返回任务编号，将使用原幂等键恢复提交状态。' };
  }

  ns.recoverPendingGeneration = async ({ automatic = false } = {}) => {
    let pending = ns.state.pendingRequest;
    if (!pending) pending = await ns.restorePendingRequest();
    if (!pending || ns.state.isBusy) return;
    const currentEmail = ns.state.session?.user?.email || '';
    if (pending.ownerEmail && pending.ownerEmail !== currentEmail) return;
    pending.ownerEmail = currentEmail;
    if (!pending.batchId && !pending.taskId && UNKNOWN_STATUSES.has(String(pending.status || '').toLowerCase())) {
      ns.setStatus('上游提交状态未知且没有可查询的任务编号。系统不会自动重发；请在作品库中刷新或联系管理员核对。', 'error');
      return;
    }
    const operationToken = ns.createIdempotencyKey();
    ns.state.activeOperationToken = operationToken;
    const submitController = new AbortController();
    ns.state.submitController = submitController;
    ns.setBusy(true);
    if (!automatic) ns.startProgress(pending.requestedCount, ns.isBatchSubmission(pending.settings, pending.kind));
    ns.setStatus('正在使用原请求标识刷新状态，不会创建新的付费任务...', 'loading');
    try {
      let pollResult;
      if (pending.batchId || pending.taskId) {
        pollResult = await pollPending(pending, operationToken, 0);
      } else {
        const replay = await ns.submitGeneration(pending.settings, pending.idempotencyKey, submitController.signal);
        if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
        if (!replay.ok) {
          if (replay.status === 409) throw new Error('幂等键与请求参数冲突，已停止提交。');
          throw new Error(ns.getErrorMessage(replay, `恢复请求失败：HTTP ${replay.status}`));
        }
        const json = replay.json || {};
        pending.kind = json.kind === 'batch' || ns.extractBatchId(json) ? 'batch' : 'task';
        pending.batchId = ns.extractBatchId(json);
        pending.taskId = ns.extractTaskId(json);
        pending.status = ns.getTaskStatus(json);
        await ns.savePendingRequest(pending, pending.ownerEmail);
        if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
        pollResult = await pollPending(pending, operationToken, 0);
      }
      await finishPolling(pollResult, pending, { stage: 'recover', idempotencyKey: pending.idempotencyKey }, operationToken);
    } catch (error) {
      if (ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) ns.setStatus(`恢复任务失败：${error?.message || error}。原请求仍已锁定，可稍后再次刷新。`, 'error');
    } finally {
      if (ns.state.activeOperationToken === operationToken) {
        ns.state.activeOperationToken = '';
        ns.state.submitController = null;
        ns.stopProgress();
        ns.setBusy(false);
      }
    }
  };

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
    const quickBatchNote = !ns.isOfficialModel() && settings.n > 1 ? `\n将同时提交 ${settings.n} 个独立单图任务，每个任务最低收费 ${ns.formatMicros(estimate.minimumPerImageMicros)}。` : '';
    if ((estimate.isMaximum || ns.shouldConfirmHighCost() || quickBatchNote) && !window.confirm(`${confirmLabel}。${quickBatchNote}\n确认生成吗？`)) return;

    await ns.runGeneration(settings);
  };

  // 公共提交/轮询/结果链路：接收已构建好的 settings，负责幂等键、恢复记录落盘、提交、轮询与
  // 结果落地。主生成（handleRun）与标注编辑提交（handleEditSubmit）共用此路径与同一 busy 锁。
  // 调用方需先完成表单校验、价格估算与用户确认。
  ns.runGeneration = async (settings) => {
    // 上游中转通道限制整个请求体 1MB：提交前先估算并拦截，替代神秘的 413。
    // 主要来源是 image_urls 里的 base64 参考图/合成图。
    const bodyBytes = ns.estimateRequestBodyBytes?.(settings) || 0;
    if (bodyBytes > ns.MAX_UPSTREAM_BODY_BYTES) {
      ns.setStatus(`请求体约 ${(bodyBytes / 1024 / 1024).toFixed(2)}MB，超过上游通道 1MB 限制；请减少参考图数量或先压缩图片后重试。`, 'error');
      return;
    }
    let operationToken = '';
    const idempotencyKey = ns.createIdempotencyKey();
    const ownerEmail = ns.state.session?.user?.email || '';
    const accountEpoch = ns.state.accountEpoch;
    const sessionToken = ns.state.session?.token;
    if (accountEpoch !== ns.state.accountEpoch || sessionToken !== ns.state.session?.token || ownerEmail !== ns.state.session?.user?.email) return;
    const pending = { idempotencyKey, settings, requestedCount: settings.n, kind: '', batchId: '', taskId: '', ownerEmail, createdAt: new Date().toISOString() };
    operationToken = ns.createIdempotencyKey();
    ns.state.activeOperationToken = operationToken;
    const submitController = new AbortController();
    ns.state.submitController = submitController;
    try {
      await ns.savePendingRequest(pending, pending.ownerEmail);
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
    } catch (error) {
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      ns.state.pendingRequest = null;
      ns.state.activeOperationToken = '';
      ns.state.submitController = null;
      ns.updatePendingUi();
      ns.setGenerationStep('validate', 'error');
      ns.setStatus(`无法建立安全的请求恢复记录，未提交也未扣费：${error?.message || error}`, 'error');
      return;
    }
    ns.resetResult(false);
    ns.setBusy(true);
    ns.setStatus('正在提交生成任务...', 'loading');
    ns.startProgress(settings.n, ns.isBatchSubmission(settings));
    const placeholder = ns.isBatchSubmission(settings)
      ? ns.normalizeBatchResult({}, { prompt: settings.prompt, settings, requestedCount: settings.n })
      : ns.normalizeTaskResult({}, { prompt: settings.prompt, settings, status: 'submitting' });
    persistAndRender(placeholder);

    let submitDebug = null;
    try {
      ns.setGenerationStep('submit');
      const submitResult = await ns.submitGeneration(settings, idempotencyKey, submitController.signal);
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      submitDebug = { stage: 'submit', status: submitResult.status, request: { ...settings, image_urls: settings.image_urls ? `[${settings.image_urls.length} 张参考图]` : undefined }, response: submitResult.json || submitResult.text, idempotencyKey };
      if (!submitResult.ok) {
        if (submitResult.status === 409) {
          await ns.clearPendingRequestSafely(pending.ownerEmail);
          if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
          ns.failProgress();
          ns.setStatus('提交失败：请求标识与参数冲突，请刷新页面后重试。', 'error');
          return;
        }
        if (ns.isAmbiguousSubmissionStatus(submitResult.status)) {
          ns.stopProgress();
          ns.els.progressPanel.className = 'progress-panel error';
          ns.els.progressHint.textContent = '服务端响应不确定，原请求标识已保留。刷新只会恢复当前请求，不会创建新的付费任务。';
          ns.setStatus(`提交响应不确定（HTTP ${submitResult.status}）。请使用“刷新当前任务”，不要重新生成。`, 'error');
          ns.showDebug(submitDebug);
          await ns.loadMe();
          if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
          await ns.loadMyLogs();
          if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
          return;
        }
        await ns.clearPendingRequestSafely(pending.ownerEmail);
        if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
        ns.failProgress();
        ns.setStatus(`提交失败：${ns.getErrorMessage(submitResult, `HTTP ${submitResult.status}`)}`, 'error');
        ns.showDebug(submitDebug);
        await ns.loadMe();
        if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
        await ns.loadMyLogs();
        if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
        return;
      }
      const json = submitResult.json || {};
      pending.kind = json.kind === 'batch' || ns.extractBatchId(json) ? 'batch' : 'task';
      pending.batchId = ns.extractBatchId(json);
      pending.taskId = ns.extractTaskId(json);
      pending.status = ns.getTaskStatus(json);
      await ns.savePendingRequest(pending, pending.ownerEmail);
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      await ns.loadMe();
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      await ns.loadMyLogs();
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      if (ns.state.session?.user?.isAdmin) await ns.loadAdminData();
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;

      if (pending.kind === 'batch') {
        const initial = ns.normalizeBatchResult(json, { prompt: settings.prompt, settings, requestedCount: settings.n, batchId: pending.batchId, debug: { submit: submitDebug } });
        persistAndRender(initial);
        if (!pending.batchId) throw new Error('批次响应缺少 batch_id；原请求已保留，请勿重新生成。');
      } else {
        const initial = ns.normalizeTaskResult(json, { prompt: settings.prompt, settings, taskId: pending.taskId, status: pending.status || 'processing', debug: { submit: submitDebug } });
        persistAndRender(initial);
        if (!pending.taskId) {
          const message = UNKNOWN_STATUSES.has(pending.status)
            ? '上游提交状态未知且没有 task_id；原请求已锁定，不会自动重发，请在作品库刷新或联系管理员核对。'
            : '任务响应缺少 task_id；原请求已保留，请勿重新生成。';
          throw new Error(message);
        }
      }
      ns.setGenerationStep('queued');
      ns.setGenerationStep('poll');
      ns.setStatus(`${pending.kind === 'batch' ? `批次 ${pending.batchId}` : `任务 ${pending.taskId}`} 已提交，正在查询结果...`, 'loading');
      const pollResult = await pollPending(pending, operationToken);
      await finishPolling(pollResult, pending, submitDebug, operationToken);
    } catch (error) {
      if (!ns.isGenerationOperationCurrent(operationToken, pending.ownerEmail)) return;
      ns.stopProgress();
      ns.els.progressPanel.className = 'progress-panel error';
      const message = error instanceof TypeError ? '网络请求中断。原请求已锁定，请使用“刷新当前任务”，不要重复付费提交。' : `${error?.message || error}`;
      ns.setStatus(message, 'error');
      if (submitDebug) ns.showDebug(submitDebug);
    } finally {
      if (ns.state.activeOperationToken === operationToken) {
        ns.state.activeOperationToken = '';
        ns.state.submitController = null;
        ns.stopProgress();
        ns.setBusy(false);
      }
    }
  };
})();
