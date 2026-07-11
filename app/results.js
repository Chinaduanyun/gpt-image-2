(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const SUCCESS = new Set(['completed', 'succeeded', 'success']);
  const FAILED = new Set(['failed', 'cancelled', 'error', 'submit_failed_refunded']);
  const UNKNOWN = new Set(['submission_unknown', 'attention_required', 'unknown']);

  ns.showDebug = (debug) => {
    ns.els.debugOutput.textContent = JSON.stringify(debug, null, 2);
    ns.els.debugDetails.classList.remove('hidden');
  };

  function applySettingsToForm(settings = {}) {
    if (settings.prompt !== undefined) ns.els.prompt.value = settings.prompt || '';
    ns.setSelectValue(ns.els.model, settings.model);
    ns.setSelectValue(ns.els.aspectRatio, settings.size || settings.aspectRatio);
    ns.setSelectValue(ns.els.resolution, settings.resolution);
    ns.setSelectValue(ns.els.imageCount, settings.n || settings.imageCount);
    ns.setSelectValue(ns.els.quality, settings.quality);
    ns.setSelectValue(ns.els.outputFormat, settings.output_format || settings.outputFormat);
    if (settings.output_compression !== undefined) ns.els.outputCompression.value = String(settings.output_compression);
    ns.updatePromptStats();
    ns.updateModelUi();
  }

  ns.applyResultToForm = (result) => {
    if (!result) return false;
    applySettingsToForm({ ...(result.settings || {}), prompt: result.prompt || '' });
    ns.setStatus('已复用提示词和参数，可继续调整或重新生成。', 'ok');
    ns.els.prompt.focus();
    return true;
  };

  ns.copyImageLink = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      ns.setStatus('图片链接已复制到剪贴板。', 'ok');
    } catch (error) {
      ns.setStatus(`复制失败：${error?.message || error}`, 'error');
    }
  };

  function aspectRatioValue(size) {
    const match = String(size || '').match(/^(\d+):(\d+)$/);
    return match ? `${match[1]} / ${match[2]}` : '1 / 1';
  }
  function childStatusLabel(child) {
    if (SUCCESS.has(child.status) && child.imageUrl) return '生成成功';
    if (FAILED.has(child.status)) return '生成失败';
    if (UNKNOWN.has(child.status)) return '状态未知';
    if (child.status === 'processing' || child.status === 'running') return '生成中';
    if (child.status === 'submitted') return '已提交';
    if (child.status === 'submitting') return '提交中';
    return '等待处理';
  }
  function createSlotState(child, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'result-slot-state';
    const state = FAILED.has(child.status) ? 'error' : (UNKNOWN.has(child.status) ? 'unknown' : 'loading');
    wrapper.classList.add(state);
    const title = document.createElement('strong');
    title.textContent = `第 ${index + 1} 张 · ${childStatusLabel(child)}`;
    const detail = document.createElement('p');
    detail.textContent = child.error || (state === 'unknown'
      ? '供应商可能已收到请求。系统不会自动重发或退款，请刷新当前任务。'
      : (state === 'error' ? '该子任务已明确失败，成功图片不受影响。' : '此位置会保留到任务返回结果。'));
    wrapper.append(title, detail);
    if (state === 'unknown') {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'secondary compact';
      refresh.dataset.refreshCurrent = 'true';
      refresh.textContent = '刷新状态';
      wrapper.append(refresh);
    }
    return wrapper;
  }
  function createImage(child, index, thumb) {
    const img = document.createElement('img');
    img.src = child.imageUrl;
    img.alt = `生成的图片 ${index + 1}`;
    img.loading = index > 0 ? 'lazy' : 'eager';
    img.decoding = 'async';
    img.addEventListener('load', () => thumb.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => {
      thumb.classList.add('has-image-error');
      const fallback = document.createElement('div');
      fallback.className = 'image-error-state';
      fallback.innerHTML = '<strong>图片加载失败</strong><span>文件可能仍在归档或网络暂时中断。</span>';
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary compact';
      retry.dataset.retryImage = child.imageUrl;
      retry.textContent = '重试加载';
      const open = document.createElement('a');
      open.className = 'button-link secondary compact';
      open.href = child.imageUrl;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = '打开原图';
      actions.append(retry, open);
      fallback.append(actions);
      thumb.append(fallback);
    }, { once: true });
    return img;
  }
  ns.createResultItem = (child, index, settings = {}) => {
    const figure = document.createElement('figure');
    figure.className = 'result-image-card';
    figure.dataset.slotIndex = String(index);
    const thumb = document.createElement('div');
    thumb.className = 'result-thumb result-slot';
    thumb.style.setProperty('--result-aspect-ratio', aspectRatioValue(settings.size));
    if (child.imageUrl) {
      thumb.classList.add('is-loading');
      thumb.appendChild(createImage(child, index, thumb));
    } else {
      thumb.appendChild(createSlotState(child, index));
    }
    const caption = document.createElement('figcaption');
    caption.className = 'result-meta image-actions';
    if (child.imageUrl) {
      const openLink = document.createElement('a');
      openLink.className = 'button-link secondary compact';
      openLink.href = child.imageUrl;
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      openLink.textContent = `打开原图 ${index + 1}`;
      const downloadLink = document.createElement('a');
      downloadLink.className = 'button-link secondary compact';
      downloadLink.href = child.imageUrl;
      downloadLink.download = `imagegen-${ns.state.result?.batchId || ns.state.result?.taskId || 'result'}-${index + 1}`;
      downloadLink.textContent = '下载';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'secondary compact';
      copyBtn.type = 'button';
      copyBtn.dataset.copyUrl = child.imageUrl;
      copyBtn.textContent = '复制链接';
      const referenceBtn = document.createElement('button');
      referenceBtn.className = 'secondary compact';
      referenceBtn.type = 'button';
      referenceBtn.dataset.referenceUrl = child.imageUrl;
      referenceBtn.textContent = '作为参考图';
      caption.append(openLink, downloadLink, copyBtn, referenceBtn);
    } else {
      const status = document.createElement('span');
      status.className = 'slot-caption';
      status.textContent = child.taskId ? `Task ID: ${child.taskId}` : childStatusLabel(child);
      caption.append(status);
    }
    figure.append(thumb, caption);
    return figure;
  };

  function slotChildren(result) {
    const requestedCount = Math.max(1, Number(result.requestedCount || result.settings?.n || result.imageUrls?.length || 1));
    const raw = Array.isArray(result.children) ? result.children : [];
    const byIndex = new Map(raw.map((child, index) => [Number.isSafeInteger(child.index) ? child.index : index, child]));
    const urls = Array.isArray(result.imageUrls) ? result.imageUrls : [];
    return Array.from({ length: requestedCount }, (_, index) => {
      const child = byIndex.get(index);
      if (child) return child;
      if (urls[index]) return { index, status: 'completed', imageUrl: urls[index], taskId: result.taskId || '', error: '' };
      return { index, status: result.status || 'pending', imageUrl: '', taskId: result.taskId || '', error: '' };
    });
  }
  function focusResultIfNeeded(result, options) {
    const successful = result.imageUrls?.length || 0;
    const focusId = `${result.batchId || result.taskId || 'pending'}:${successful}:${result.status}`;
    const shouldFocus = options.focus || (successful > 0 && ns.state.lastResultFocusId !== focusId && window.matchMedia('(max-width: 980px)').matches);
    if (!shouldFocus) return;
    ns.state.lastResultFocusId = focusId;
    window.requestAnimationFrame(() => {
      const title = document.getElementById('resultTitle');
      title?.focus({ preventScroll: true });
      title?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  }

  ns.renderResult = (options = {}) => {
    const result = ns.state.result;
    if (!result) return ns.resetResult();
    const settings = result.settings || {};
    const children = slotChildren(result);
    const successful = children.filter((child) => child.imageUrl).length;
    const failed = Number(result.counts?.failed || children.filter((child) => FAILED.has(child.status)).length);
    const unknown = Number(result.counts?.unknown || children.filter((child) => UNKNOWN.has(child.status)).length);
    ns.els.emptyState.classList.add('hidden');
    ns.els.resultCard.classList.remove('hidden');
    ns.els.resultActions?.classList.remove('hidden');
    ns.els.resultGrid.replaceChildren(...children.map((child, index) => ns.createResultItem(child, index, settings)));
    const countText = result.kind === 'batch' ? `${successful}/${children.length} 成功${failed ? ` · ${failed} 失败` : ''}${unknown ? ` · ${unknown} 未知` : ''}` : `${successful || children.length} 张`;
    ns.els.resultSummary.textContent = `${settings.model || 'API Market'} · ${settings.size || '-'} · ${settings.resolution || '-'} · ${countText}`;
    const id = result.batchId || result.taskId || '';
    ns.els.taskIdText.textContent = id ? `${result.kind === 'batch' ? 'Batch ID' : 'Task ID'}: ${id}` : '请求已保存，等待服务端返回任务编号';
    ns.els.taskIdText.classList.remove('hidden');
    ns.els.useAllResultsAsReferenceBtn.disabled = successful === 0;
    ns.els.regenerateResultBtn.disabled = ns.hasPendingGeneration();
    ns.els.refreshCurrentTaskBtn?.classList.toggle('hidden', !ns.hasPendingGeneration());
    if (result.debug) ns.showDebug(result.debug);
    else {
      ns.els.debugDetails.classList.add('hidden');
      ns.els.debugOutput.textContent = '';
    }
    focusResultIfNeeded(result, options);
  };

  ns.resetResult = (resetState = true) => {
    if (resetState) ns.state.result = null;
    ns.els.emptyState.classList.remove('hidden');
    ns.els.resultCard.classList.add('hidden');
    ns.els.resultActions?.classList.add('hidden');
    ns.els.debugDetails.classList.add('hidden');
    ns.els.resultGrid.replaceChildren();
    ns.els.taskIdText.classList.add('hidden');
    ns.els.taskIdText.textContent = '';
    ns.els.debugOutput.textContent = '';
    ns.els.resultSummary.textContent = 'API Market';
  };

  ns.handleClear = () => {
    if (ns.hasPendingGeneration()) return ns.setStatus('当前任务仍在执行或状态未知，不能清空请求标识。请先刷新当前任务。', 'error');
    ns.els.prompt.value = '';
    ns.updatePromptStats();
    ns.clearReferences();
    ns.clearStoredResult();
    ns.resetResult();
    ns.resetProgress();
    ns.setStatus('等待输入提示词。');
    ns.els.prompt.focus();
  };

  ns.handleResultAction = async (event) => {
    const target = event.target?.closest('[data-copy-url], [data-reference-url], [data-retry-image], [data-refresh-current]');
    if (!target) return;
    if (target.dataset.copyUrl) return ns.copyImageLink(target.dataset.copyUrl);
    if (target.dataset.referenceUrl) return ns.addReferenceUrls([target.dataset.referenceUrl], '生成结果');
    if (target.dataset.refreshCurrent) return ns.recoverPendingGeneration();
    if (target.dataset.retryImage) {
      const card = target.closest('.result-image-card');
      const thumb = card?.querySelector('.result-thumb');
      const oldImage = thumb?.querySelector('img');
      if (thumb && oldImage) {
        thumb.querySelector('.image-error-state')?.remove();
        thumb.classList.remove('has-image-error', 'is-loaded');
        thumb.classList.add('is-loading');
        const retryUrl = `${target.dataset.retryImage}${target.dataset.retryImage.includes('?') ? '&' : '?'}retry=${Date.now()}`;
        oldImage.replaceWith(createImage({ imageUrl: retryUrl }, Number(card.dataset.slotIndex) || 0, thumb));
      }
    }
  };

  ns.handleCopyLink = ns.handleResultAction;
  ns.reuseCurrentResult = () => ns.applyResultToForm(ns.state.result);
  ns.useAllCurrentResultsAsReference = async () => {
    const urls = ns.state.result?.imageUrls || [];
    if (!urls.length) return ns.setReferenceStatus('当前没有可加入参考图的成功结果。', 'error');
    await ns.addReferenceUrls(urls, '生成结果');
  };
  ns.regenerateCurrentResult = async () => {
    if (ns.hasPendingGeneration()) return ns.setStatus('当前任务尚未安全结束，不能创建新的付费请求。请先刷新状态。', 'error');
    if (!ns.applyResultToForm(ns.state.result)) return;
    const estimate = ns.estimatePrice();
    if (!estimate.ok) return ns.setStatus(`无法再次生成：${estimate.error || '价格配置异常。'}`, 'error');
    const ok = window.confirm(`将创建一个全新的请求，使用相同提示词和参数再次生成，按当前价格预计 ${ns.formatMicros(estimate.totalMicros)}。确认继续吗？`);
    if (ok) await ns.handleRun();
  };
})();
