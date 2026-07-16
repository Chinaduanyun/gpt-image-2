(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const STATUS_MAP = {
    completed: { label: '已完成', className: 'ok', group: 'completed' },
    succeeded: { label: '已完成', className: 'ok', group: 'completed' },
    success: { label: '已完成', className: 'ok', group: 'completed' },
    partial_success: { label: '部分完成', className: 'partial', group: 'partial' },
    partial: { label: '部分完成', className: 'partial', group: 'partial' },
    failed: { label: '失败', className: 'error', group: 'failed' },
    error: { label: '错误', className: 'error', group: 'failed' },
    cancelled: { label: '已取消', className: 'error', group: 'failed' },
    submit_failed_refunded: { label: '提交失败，已退款', className: 'error', group: 'failed' },

    submission_refunded_closed: { label: '提交未确认，已退款并关闭', className: 'error', group: 'failed' },
    attention_required: { label: '需要关注', className: 'unknown', group: 'attention' },
    submission_unknown: { label: '提交状态未知', className: 'unknown', group: 'attention' },
    submitting: { label: '提交中', className: 'loading', group: 'active' },
    submitted: { label: '已提交', className: 'loading', group: 'active' },
    processing: { label: '生成中', className: 'loading', group: 'active' },
    running: { label: '生成中', className: 'loading', group: 'active' },
    pending: { label: '等待中', className: 'loading', group: 'active' }
  };
  ns.classifyLogStatus = (status) => STATUS_MAP[String(status || '').toLowerCase()] || { label: status || '未知状态', className: 'loading', group: 'active' };
  ns.logStatusText = (log) => log.type === 'balance_adjustment' ? '余额调整' : ns.classifyLogStatus(log.status).label;
  ns.settingsText = (log) => {
    if (log.type === 'balance_adjustment') return '-';
    const s = log.settings || {};
    const count = log.requestedImageCount || log.requestedCount || s.n || 1;
    return [log.model || s.model, s.size, s.resolution, s.quality, `${count}张`].filter(Boolean).join(' · ');
  };
  ns.referenceText = (log) => {
    const count = Number(log.referenceImageCount || log.settings?.referenceImageCount || log.settings?.image_urls?.length || log.imageUrlsReferenceCount || 0);
    return count > 0 ? `参考图 ${count} 张` : '';
  };
  ns.costText = (log) => {
    if (log.type === 'balance_adjustment') return `调整 ${ns.formatMicros(log.deltaMicros)}`;
    const billing = log.aggregateBilling || log.aggregate_billing || log.billing || log;
    const estimateLabel = log.priceIsMaximum ? '最高预扣' : '预估';
    const settledSubtotal = Number.isSafeInteger(billing.settledActualCostMicros) ? `已结算小计 ${ns.formatMicros(billing.settledActualCostMicros)}` : '';
    const actual = billing.settled === true && Number.isSafeInteger(billing.actualCostMicros) && billing.actualCostMicros >= 0 ? `最终实际 ${ns.formatMicros(billing.actualCostMicros)}` : '';
    return [`${estimateLabel} ${ns.formatMicros(billing.estimatedCostMicros)}`, `预扣/扣费 ${ns.formatMicros(billing.chargedMicros)}`, settledSubtotal, actual].filter(Boolean).join(' / ');
  };
  ns.balanceText = (log) => log.balanceBeforeMicros === undefined ? '-' : `${ns.formatMicros(log.balanceBeforeMicros)} → ${ns.formatMicros(log.balanceAfterMicros)}`;
  ns.promptText = (log) => log.type === 'balance_adjustment' ? (log.reason || '-') : (log.prompt || '').slice(0, 120);
  ns.findHistoryLog = (logId) => ns.state.myLogs.find((log) => log.id === logId);

  function logChildren(log) {
    return Array.isArray(log.children) ? [...log.children].sort((a, b) => Number(a.index) - Number(b.index)) : [];
  }
  function logCounts(log) {
    const children = logChildren(log);
    if (log.counts) return log.counts;
    return children.reduce((counts, child) => {
      const group = ns.classifyLogStatus(child.status).group;
      if (group === 'completed') counts.succeeded += 1;
      else if (group === 'failed') counts.failed += 1;
      else if (group === 'attention') counts.unknown += 1;
      else if (String(child.status).toLowerCase() === 'processing') counts.processing += 1;
      else counts.pending += 1;
      return counts;
    }, { pending: 0, processing: 0, succeeded: 0, failed: 0, unknown: 0 });
  }
  function batchCountText(log) {
    const requested = Number(log.requestedImageCount || log.requestedCount || log.settings?.n || 0);
    if (!requested || !logChildren(log).length) return '';
    const counts = logCounts(log);
    return `${counts.succeeded || 0}/${requested} 成功${counts.failed ? ` · ${counts.failed} 失败` : ''}${counts.unknown ? ` · ${counts.unknown} 未知` : ''}`;
  }

  ns.getFilteredMyLogs = () => {
    const query = ns.state.historySearch.trim().toLowerCase();
    const filter = ns.state.historyFilter;
    return ns.state.myLogs.filter((log) => {
      const status = ns.classifyLogStatus(log.status);
      const imageUrls = Array.isArray(log.imageUrls) ? log.imageUrls : [];
      if (filter === 'completed' && !imageUrls.length) return false;
      if (filter === 'failed' && !['failed', 'attention'].includes(status.group)) return false;
      if (filter === 'partial' && status.group !== 'partial') return false;
      if (filter === 'active' && status.group !== 'active') return false;
      if (filter === 'with-reference' && !ns.referenceText(log)) return false;
      if (!query) return true;
      const childIds = logChildren(log).map((child) => child.taskId || child.task_id).filter(Boolean);
      const haystack = [log.prompt, log.model, log.taskId, log.batchId, log.batch_id, log.status, ...childIds, ns.settingsText(log), ns.costText(log)].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  };

  function renderChildren(log) {
    const children = logChildren(log);
    if (!children.length) return '';
    return `
      <details class="history-children">
        <summary>子任务详情 · ${ns.escapeHtml(batchCountText(log))}</summary>
        <ol>
          ${children.map((child, index) => {
            const state = ns.classifyLogStatus(child.status);
            const error = ns.toErrorText(child.error) || ns.toErrorText(child.message);
            return `<li><span>第 ${Number(child.index ?? index) + 1} 张</span><strong class="history-child-status ${state.className}">${ns.escapeHtml(state.label)}</strong>${child.taskId || child.task_id ? `<code>${ns.escapeHtml(child.taskId || child.task_id)}</code>` : ''}${error ? `<p>${ns.escapeHtml(error)}</p>` : ''}</li>`;
          }).join('')}
        </ol>
      </details>`;
  }
  function renderHistoryImages(imageUrls) {
    if (!imageUrls.length) return '<div class="history-empty">暂无成功图片</div>';
    return `<div class="history-images">${imageUrls.map((url, index) => {
      const img = `<img src="${ns.escapeHtml(url)}" alt="历史图片 ${index + 1}" loading="lazy" decoding="async" onerror="this.closest('.history-thumb').classList.add('has-image-error');this.alt='历史图片加载失败'" />`;
      // URL 协议不合法时不渲染链接，只显示图片，避免把不可信协议放进 href。
      return ns.isSafeLinkUrl(url)
        ? `<a class="history-thumb" href="${ns.escapeHtml(url)}" target="_blank" rel="noopener" title="打开图片 ${index + 1}">${img}</a>`
        : `<div class="history-thumb">${img}</div>`;
    }).join('')}</div>`;
  }

  ns.renderMyLogs = (logs = null) => {
    if (Array.isArray(logs)) ns.state.myLogs = logs;
    const filtered = ns.getFilteredMyLogs();
    if (!ns.state.myLogs.length) {
      ns.els.myLogsList.innerHTML = '<div class="list-state">暂无作品。生成图片后会出现在这里。<span>当前列表最多显示最近 100 条。</span></div>';
      return;
    }
    if (!filtered.length) {
      ns.els.myLogsList.innerHTML = '<div class="list-state">没有匹配的作品。<span>可搜索 Batch ID、Task ID、提示词或模型。</span></div>';
      return;
    }

    ns.els.myLogsList.innerHTML = filtered.map((log) => {
      const imageUrls = Array.isArray(log.imageUrls) ? log.imageUrls : [];
      const referenceText = ns.referenceText(log);
      const status = ns.classifyLogStatus(log.status);
      const canReuse = (log.type === 'generation' || log.kind === 'batch' || log.kind === 'task') && log.id;
      const billing = log.aggregateBilling || log.aggregate_billing || log.billing || log;
      const childrenSettled = !logChildren(log).length || logChildren(log).every((child) => (child.billing || child).settled === true);
      const canDelete = canReuse && ['completed', 'partial', 'failed'].includes(status.group) && billing.settled === true && childrenSettled;
      const deleteBlocker = status.group === 'attention'
        ? '提交状态尚未确认，不能隐藏。请联系管理员核查；隐藏不会取消任务或退款。'
        : status.group === 'active'
          ? '任务仍在执行，不能隐藏。请等待任务结束或刷新状态。'
          : billing.settled !== true || !childrenSettled
            ? '账务尚未结清，不能隐藏。隐藏不会取消任务或退款。'
            : '此记录当前不能隐藏。';
      const actions = canReuse ? `
        <div class="history-card-actions">
          <button class="secondary compact" type="button" data-history-action="reuse" data-log-id="${ns.escapeHtml(log.id)}">复用</button>
          <button class="secondary compact" type="button" data-history-action="regenerate" data-log-id="${ns.escapeHtml(log.id)}" ${status.group === 'active' || status.group === 'attention' ? 'disabled title="任务尚未安全结束"' : ''}>再生成</button>
          ${imageUrls.length ? `<button class="secondary compact" type="button" data-history-action="reference" data-log-id="${ns.escapeHtml(log.id)}">图片作参考</button>` : ''}
          ${imageUrls.length ? `<button class="secondary compact" type="button" data-history-action="edit" data-log-id="${ns.escapeHtml(log.id)}">编辑此图</button>` : ''}
          ${imageUrls.length >= 2 ? `<button class="secondary compact" type="button" data-history-action="download-zip" data-log-id="${ns.escapeHtml(log.id)}">打包下载</button>` : ''}
          ${canDelete ? `<button class="secondary compact danger-button history-delete-btn" type="button" data-history-action="delete" data-log-id="${ns.escapeHtml(log.id)}">隐藏作品</button>` : `<button class="secondary compact history-delete-btn" type="button" disabled title="${ns.escapeHtml(deleteBlocker)}">不可隐藏</button>`}
        </div>` : '';
      return `
        <article class="history-row">
          <div class="history-topline">
            <strong>${ns.escapeHtml(ns.formatDate(log.createdAt))}</strong>
            <span class="history-status ${status.className}">${ns.escapeHtml(status.label)}</span>
          </div>
          <div class="history-content">
            <div class="history-main">
              <span>${ns.escapeHtml(ns.settingsText(log))}</span>
              ${batchCountText(log) ? `<strong class="batch-count-text">${ns.escapeHtml(batchCountText(log))}</strong>` : ''}
              ${referenceText ? `<span>${ns.escapeHtml(referenceText)}</span>` : ''}
              <span>${ns.escapeHtml(ns.costText(log))}</span>
              <p>${ns.escapeHtml(ns.promptText(log))}</p>
              ${renderChildren(log)}
              ${actions}
            </div>
            ${renderHistoryImages(imageUrls)}
          </div>
        </article>`;
    }).join('');
  };

  function applyHistoryLogToForm(log) {
    if (!log || !['generation', 'batch', 'task'].includes(log.type || log.kind)) return false;
    const settings = log.settings || {};
    ns.els.prompt.value = log.prompt || '';
    ns.setSelectValue(ns.els.model, log.model || settings.model);
    ns.setSelectValue(ns.els.aspectRatio, settings.size);
    ns.setSelectValue(ns.els.resolution, settings.resolution);
    ns.setSelectValue(ns.els.imageCount, log.requestedImageCount || log.requestedCount || settings.n);
    ns.setSelectValue(ns.els.quality, settings.quality);
    ns.setSelectValue(ns.els.outputFormat, settings.output_format);
    if (settings.output_compression !== undefined) ns.els.outputCompression.value = String(settings.output_compression);
    ns.updatePromptStats();
    ns.updateModelUi();
    ns.setStatus('已复用作品的提示词和参数。', 'ok');
    ns.els.prompt.focus();
    return true;
  }

  ns.loadMyLogs = async () => {
    if (!ns.state.session?.token) return;
    const epoch = ns.state.accountEpoch;
    const token = ns.state.session.token;
    ns.els.refreshMyLogsBtn.disabled = true;
    ns.els.myLogsList.innerHTML = '<div class="list-state is-loading">正在加载最近 100 条作品记录...</div>';
    try {
      const result = await ns.requestJson('/api/me/logs?limit=100');
      if (epoch !== ns.state.accountEpoch || token !== ns.state.session?.token) return;
      if (!result.ok) {
        ns.els.myLogsList.innerHTML = `<div class="list-state is-error">${ns.escapeHtml(ns.getErrorMessage(result, '作品库加载失败。'))}<button class="secondary compact" type="button" data-history-action="retry-load">重试</button></div>`;
        return;
      }
      ns.renderMyLogs(result.json?.logs || []);
    } catch (error) {
      ns.els.myLogsList.innerHTML = `<div class="list-state is-error">作品库加载失败：${ns.escapeHtml(error?.message || error)}<button class="secondary compact" type="button" data-history-action="retry-load">重试</button></div>`;
    } finally {
      ns.els.refreshMyLogsBtn.disabled = false;
    }
  };

  ns.deleteHistoryLog = async (logId) => {
    if (!logId) return;
    const ok = window.confirm('确认隐藏这条作品吗？\n\n隐藏作品不等于取消任务或退款。账本会保留用于审计和余额对账；已归档图片可能按服务端策略清理。');
    if (!ok) return;
    const result = await ns.requestJson(`/api/me/logs/${encodeURIComponent(logId)}`, { method: 'DELETE' });
    if (!result.ok) return ns.setStatus(ns.getErrorMessage(result, '隐藏作品失败。执行中、未结算或需关注的任务不能隐藏。'), 'error');
    ns.setStatus('作品已从个人作品库隐藏，账本记录仍保留。', 'ok');
    await ns.loadMyLogs();
  };

  let historySearchTimer = null;
  ns.handleHistorySearch = () => {
    if (historySearchTimer) window.clearTimeout(historySearchTimer);
    // 输入防抖 ~250ms，避免每敲一个字就整列表重渲染。
    historySearchTimer = window.setTimeout(() => {
      historySearchTimer = null;
      ns.state.historySearch = ns.els.historySearchInput?.value || '';
      ns.renderMyLogs();
    }, 250);
  };
  ns.handleHistoryFilter = () => {
    ns.state.historyFilter = ns.els.historyFilterSelect?.value || 'all';
    ns.renderMyLogs();
  };
  ns.handleHistoryClick = async (event) => {
    const button = event.target?.closest('[data-history-action]');
    if (!button) return;
    const action = button.dataset.historyAction;
    if (action === 'retry-load') return ns.loadMyLogs();
    const logId = button.dataset.logId;
    const log = ns.findHistoryLog(logId);
    if (action === 'delete') return ns.deleteHistoryLog(logId);
    if (!log) return;
    if (action === 'reuse') return applyHistoryLogToForm(log);
    if (action === 'reference') return ns.addReferenceUrls(log.imageUrls || [], '历史作品');
    if (action === 'edit') {
      // 一条记录可能有多张图，取第一张同源已归档（可编辑）的载入；都不可编辑则提示。
      const editable = (Array.isArray(log.imageUrls) ? log.imageUrls : []).find((url) => ns.isEditableImageUrl?.(url));
      if (!editable) return ns.setStatus('这条作品的图片未归档或跨域，暂不可编辑。', 'error');
      return ns.startEditFromUrl(editable, 'stored');
    }
    if (action === 'download-zip') return ns.downloadImagesAsZip(log.batchId || log.batch_id || log.taskId || log.task_id || log.id, log.imageUrls || []);
    if (action === 'regenerate') {
      if (ns.hasPendingGeneration()) return ns.setStatus('当前任务尚未安全结束，不能创建新的付费请求。请先刷新当前任务。', 'error');
      if (!applyHistoryLogToForm(log)) return;
      const estimate = ns.estimatePrice();
      if (!estimate.ok) return ns.setStatus(`无法再次生成：${estimate.error || '价格配置异常。'}`, 'error');
      const ok = window.confirm(`将创建一个全新的请求，复制原始张数和参数，并按当前价格预计收费 ${ns.formatMicros(estimate.totalMicros)}。确认继续吗？`);
      if (ok) await ns.handleRun();
    }
  };
})();
