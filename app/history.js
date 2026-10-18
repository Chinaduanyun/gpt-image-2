(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  const STATUS_MAP = {
    archiving: { label: '成品归档中', className: 'loading', group: 'active' },
    queued: { label: '等待提交', className: 'loading', group: 'active' },
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

  function isHistoryWork(log) {
    return ['generation', 'batch', 'task'].includes(log.type || log.kind);
  }

  ns.getFilteredMyLogs = () => {
    if (page.status !== 'idle' && ns.state.session?.token) return ns.state.myLogs.filter(isHistoryWork);
    const query = ns.state.historySearch.trim().toLowerCase();
    const filter = ns.state.historyFilter;
    return ns.state.myLogs.filter((log) => {
      if (!isHistoryWork(log)) return false;
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
    const url = imageUrls[0], thumb = ns.storedImageThumbnailUrl?.(url);
    const image = thumb ? `<img src="${ns.escapeHtml(thumb)}" alt="作品封面" loading="lazy" decoding="async" onerror="this.closest('.history-thumb').classList.add('has-image-error');this.removeAttribute('src')" />` : '<span>预览不可用，打开详情查看原图</span>';
    return `<div class="history-images"><a class="history-thumb" href="${ns.escapeHtml(ns.isSafeLinkUrl(url) ? url : '#')}" title="查看作品详情">${image}</a>${imageUrls.length > 1 ? `<span class="preview-history-image-count">共 ${imageUrls.length} 张</span>` : ''}</div>`;
  }

  // Keyed reconciliation keeps unchanged cards (and their decoded thumbnails) alive.
  function reconcileCards(cards) {
    const list = ns.els.myLogsList;
    if (typeof document === 'undefined' || !list.children) { list.innerHTML = cards.map(card => card.html).join(''); return; }
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusAction = focused?.dataset?.historyAction, focusId = focused?.dataset?.logId;
    const focusedRow = focused?.closest('.history-row');
    const focusPreview = focused?.matches('.history-thumb, .history-empty');
    const old = new Map([...list.children].filter(node => node.dataset?.logId).map(node => [node.dataset.logId, node]));
    let position = list.firstElementChild;
    for (const card of cards) {
      let row = old.get(card.id);
      if (!row || row.historySignature !== card.signature) {
        const template = document.createElement('template'); template.innerHTML = card.html.trim();
        const fresh = template.content.firstElementChild;
        if (row) {
          const images = new Map([...row.querySelectorAll('img[src]')].map(img => [img.getAttribute('src'), img]));
          fresh.querySelectorAll('img[src]').forEach(img => { const prior = images.get(img.getAttribute('src')); if (prior) img.replaceWith(prior); });
          // Keep the row identity, including open-dialog and focus references.
          row.removeAttribute('data-preview-enhanced');
          row.replaceChildren(...fresh.childNodes);
          row.dataset.imageUrls = fresh.dataset.imageUrls;
        } else row = fresh;
        row.historySignature = card.signature;
      }
      old.delete(card.id);
      if (row !== position) list.insertBefore(row, position);
      position = row.nextElementSibling;
    }
    while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
    if (focused && !focused.isConnected) {
      if (focusPreview) focusedRow?.querySelector('.history-thumb, .history-empty')?.focus({ preventScroll: true });
      else [...list.querySelectorAll('[data-history-action]')].find(button => button.dataset.historyAction === focusAction && button.dataset.logId === focusId)?.focus({ preventScroll: true });
    }
    ns.syncHistoryDetail?.();
  }

  ns.renderMyLogs = (logs = null) => {
    if (Array.isArray(logs)) ns.state.myLogs = logs;
    const filtered = ns.getFilteredMyLogs();
    if (!ns.state.myLogs.some(isHistoryWork)) {
      ns.els.myLogsList.innerHTML = '<div class="list-state">暂无作品。生成图片后会出现在这里。<span>可搜索全部历史作品。</span></div>';
      return;
    }
    if (!filtered.length) {
      ns.els.myLogsList.innerHTML = '<div class="list-state">没有匹配的作品。<span>可搜索 Batch ID、Task ID、提示词或模型。</span></div>';
      return;
    }

    reconcileCards(filtered.map((log) => {
      const imageUrls = !log.assetsDeleted && Array.isArray(log.imageUrls) ? log.imageUrls : [];
      const referenceText = ns.referenceText(log);
      const status = ns.classifyLogStatus(log.status);
      const canReuse = (log.type === 'generation' || log.kind === 'batch' || log.kind === 'task') && log.id;
      const billing = log.aggregateBilling || log.aggregate_billing || log.billing || log;
      const childrenSettled = !logChildren(log).length || logChildren(log).every((child) => (child.billing || child).settled === true);
      const canDelete = canReuse && ['completed', 'partial', 'failed'].includes(status.group) && billing.settled === true && childrenSettled;
      const standaloneUnknown = log.status === 'submission_unknown'
        && log.kind !== 'batch' && !log.batchId && !log.batch_id && !logChildren(log).length;
      const canHide = canDelete || (canReuse && standaloneUnknown);
      const deleteBlocker = status.group === 'attention'
        ? '批次或其他需关注的记录暂不能隐藏，请联系管理员核查。独立的提交状态未知记录可隐藏，不退款并保留管理员记录。'
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
          ${canDelete ? `<button class="secondary compact danger-button" type="button" data-history-action="delete-assets" data-log-id="${ns.escapeHtml(log.id)}">永久删除图片</button>` : ''}
          ${canHide ? `<button class="secondary compact danger-button history-delete-btn" type="button" data-history-action="delete" data-log-id="${ns.escapeHtml(log.id)}">隐藏作品</button>` : `<button class="secondary compact history-delete-btn" type="button" disabled title="${ns.escapeHtml(deleteBlocker)}">不可隐藏</button>`}
        </div>` : '';
      const html = `
        <article class="history-row" data-log-id="${ns.escapeHtml(log.id)}" data-image-urls="${ns.escapeHtml(JSON.stringify(log.assetsDeleted ? [] : imageUrls))}">
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
              ${log.error ? `<p>${ns.escapeHtml(log.error)}</p>` : ''}
              ${(log.imageFiles || []).map((file) => `<span>实际 ${file.width || '?'} × ${file.height || '?'} · ${ns.escapeHtml(file.format || '')}（质量未验证）</span>`).join('')}
              ${(log.inputFiles || []).map((file, i) => `<a href="/api/stored-images/${encodeURIComponent(file.fileName)}" target="_blank" rel="noopener">已保存参考图 ${i + 1}</a>`).join('')}
              ${renderChildren(log)}
              ${actions}
            </div>
            ${renderHistoryImages(imageUrls)}
          </div>
        </article>`;
      return { id: log.id, signature: JSON.stringify(log), html };
    }));
  };

  async function applyHistoryLogToForm(log) {
    if (ns.isWorkspaceReadOnly?.()) { ns.setStatus('当前为只读任务详情，请先返回草稿再复用历史作品。', 'error'); return false; }
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
    const saved = ns.saveWorkspaceDraft?.();
    const revision = ns.getWorkspaceDraftRevision?.();
    try { await saved; } catch { return false; } // The save API already reports its storage error.
    return revision === ns.getWorkspaceDraftRevision?.();
  }

  let libraryVisible = false, generation = 0, queryGeneration = 0, dirtyRevision = 0, retryAppend = false, request = null, refreshTimer = null;
  let page = { status: 'idle', nextCursor: null, hasMore: false, total: 0, dirty: false, error: '' };
  const control = (id) => typeof document === 'undefined' ? null : document.getElementById(id);
  function pageUi() {
    const more = control('historyLoadMore'), meta = control('historyPageStatus');
    if (meta) meta.textContent = `已加载 ${ns.state.myLogs.length} / ${page.total} 条作品${page.status === 'loading' ? ` · ${page.refreshNotice || '加载中…'}` : page.error ? ` · ${page.error}` : page.dirty ? ' · 有更新待刷新' : ''}`;
    if (more) { more.hidden = !page.hasMore && page.status !== 'error'; more.disabled = page.status === 'loading'; more.textContent = page.status === 'error' ? '加载失败，重试' : '加载更多'; more.onclick = () => ns.requestHistoryPage({ append: page.status === 'error' ? retryAppend : page.hasMore && ns.state.myLogs.length > 0 && !page.dirty }); }
    if (ns.els.refreshMyLogsBtn) ns.els.refreshMyLogsBtn.disabled = page.status === 'loading';
  }
  ns.getHistoryPageState = () => ({ ...page, generation });
  ns.resetHistoryLibrary = () => {
    queryGeneration++; generation++; request?.controller.abort(); request = null;
    window.clearTimeout(refreshTimer); refreshTimer = null;
    page = { status: 'idle', nextCursor: null, hasMore: false, total: 0, dirty: false, error: '' };
    ns.syncHistoryDetail?.(); pageUi();
  };
  ns.requestHistoryPage = ({ append = false, reset = false } = {}) => {
    if (reset) {
      queryGeneration++; generation++; request?.controller.abort(); request = null;
      page = { status: 'idle', nextCursor: null, hasMore: false, total: 0, dirty: false, error: '' };
      ns.renderMyLogs(); ns.syncHistoryDetail?.(); pageUi();
    }
    if (!ns.state.session?.token || !libraryVisible || document.hidden) return Promise.resolve();
    if (request) return request.promise;
    const epoch = ns.state.accountEpoch, token = ns.state.session.token, version = generation, startedDirtyRevision = dirtyRevision;
    const controller = new AbortController();
    const run = { controller, promise: null, mutations: new Map() }; request = run;
    const valid = () => request === run && generation === version && ns.isAccountContextCurrent(epoch, token);
    const old = ns.state.myLogs;
    let appendResults = append, boundary = !reset && !append ? old.at(-1) : null;
    const query = new URLSearchParams({ paged: '1', limit: '24', q: ns.state.historySearch.trim(), filter: ns.state.historyFilter });
    retryAppend = append;
    page.status = 'loading'; page.error = ''; page.refreshNotice = ''; pageUi();
    if (!old.length) ns.els.myLogsList.innerHTML = '<div class="list-state is-loading">正在加载作品…</div>';
    run.promise = (async () => {
      try {
        let cursor = append ? page.nextCursor : null, logs = [], envelope, recoveredCursor = false;
        do {
          if (cursor) query.set('cursor', cursor); else query.delete('cursor');
          const result = await ns.requestJson(`/api/me/logs?${query}`, { signal: controller.signal });
          if (!valid()) return;
          if (!result.ok && result.status === 400 && result.json?.error?.code === 'history_cursor_invalid' && append && cursor && !recoveredCursor) {
            // A server restart expires signed cursors. Recover once, retaining this query/account guard.
            recoveredCursor = true; appendResults = false; boundary = null; logs = []; cursor = null;
            retryAppend = false; page.nextCursor = null; page.hasMore = false;
            page.refreshNotice = '作品列表已更新，正在重新加载首页…'; pageUi();
            continue;
          }
          if (!result.ok || !Array.isArray(result.json?.logs) || !result.json?.page) throw new Error(ns.getErrorMessage(result, '作品库加载失败。'));
          envelope = result.json.page;
          logs.push(...result.json.logs);
          const previousCursor = cursor; cursor = envelope.nextCursor;
          if (!boundary || !envelope.hasMore || logs.some(log => compareHistoryBoundary(log, boundary) >= 0)) break;
          if (!cursor || cursor === previousCursor) throw new Error('分页响应无效，请重试。');
        } while (true);
        if (!valid()) return;
        const unique = new Map((appendResults ? old : []).map(log => [log.id, log]));
        for (const log of logs) unique.set(log.id, log);
        let reconciled = [...unique.values()], total = envelope.total;
        for (const [id, assetsOnly] of run.mutations) {
          const patch = patchHistoryItem(reconciled, id, assetsOnly);
          reconciled = patch.logs; total = Math.max(0, total - Number(patch.removed));
        }
        ns.state.myLogs = reconciled;
        page = { status: 'loaded', nextCursor: envelope.nextCursor, hasMore: envelope.hasMore, total, dirty: startedDirtyRevision !== dirtyRevision, error: '' };
        ns.renderMyLogs(); ns.syncHistoryDetail?.();
      } catch (error) {
        if (!valid() || controller.signal.aborted) return;
        page.status = 'error'; page.error = error.message || '作品库加载失败。';
        if (!ns.state.myLogs.length) ns.els.myLogsList.innerHTML = `<div class="list-state is-error">${ns.escapeHtml(page.error)}<button type="button" class="secondary compact" data-history-action="retry-load">重试</button></div>`;
      } finally {
        if (valid()) { request = null; pageUi(); if (page.dirty && page.status !== 'error') ns.markHistoryDirty(); }
      }
    })();
    return run.promise;
  };
  ns.ensureHistoryLibrary = () => {
    if (libraryVisible && (page.status === 'idle' || page.dirty) && page.status !== 'error') return ns.requestHistoryPage();
    return Promise.resolve();
  };
  let sentinelObserver = null;
  ns.setHistoryLibraryVisible = (visible) => {
    libraryVisible = visible;
    if (!visible) {
      window.clearTimeout(refreshTimer); refreshTimer = null;
      if (request) { generation++; request.controller.abort(); request = null; page.status = ns.state.myLogs.length ? 'loaded' : 'idle'; page.dirty = true; pageUi(); }
      return;
    }
    if (!sentinelObserver && typeof IntersectionObserver !== 'undefined' && control('historyPageSentinel')) {
      let near = false;
      sentinelObserver = new IntersectionObserver(entries => {
        const entering = entries.some(entry => entry.isIntersecting);
        if (entering && !near && libraryVisible && page.status === 'loaded' && page.hasMore) void ns.requestHistoryPage({ append: true });
        near = entering;
      }, { rootMargin: '500px' });
      sentinelObserver.observe(control('historyPageSentinel'));
    }
    return ns.ensureHistoryLibrary();
  };
  ns.markHistoryDirty = () => {
    dirtyRevision++; page.dirty = true; pageUi();
    if (!libraryVisible || document.hidden || request || refreshTimer) return;
    refreshTimer = window.setTimeout(() => { refreshTimer = null; void ns.requestHistoryPage(); }, 100);
  };
  // Legacy notification/refresh callers remain safe while the library is hidden.
  ns.loadMyLogs = () => {
    if (!libraryVisible || document.hidden) { ns.markHistoryDirty(); return Promise.resolve(); }
    return ns.requestHistoryPage();
  };
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => {
    if (!document.hidden) void ns.ensureHistoryLibrary();
    else if (request) { generation++; request.controller.abort(); request = null; page.status = ns.state.myLogs.length ? 'loaded' : 'idle'; page.dirty = true; pageUi(); }
  });

  // Match the server's parsed-time DESC, then batchId/id DESC keyset order.
  function compareHistoryBoundary(log, boundary) {
    const time = Date.parse(log.createdAt || '') || 0, boundaryTime = Date.parse(boundary.createdAt || '') || 0;
    const id = String(log.batchId || log.id || ''), boundaryId = String(boundary.batchId || boundary.id || '');
    return boundaryTime - time || (id < boundaryId ? 1 : id > boundaryId ? -1 : 0);
  }

  function patchHistoryItem(logs, logId, assetsOnly) {
    const present = logs.some(log => log.id === logId);
    const remove = !assetsOnly || ns.state.historyFilter === 'completed';
    return {
      logs: remove ? logs.filter(log => log.id !== logId) : logs.map(log => log.id === logId ? { ...log, imageUrls: [], inputFiles: [], assetsDeleted: true } : log),
      removed: present && remove
    };
  }
  function removeHistoryItem(logId, assetsOnly, mutationQueryGeneration) {
    if (mutationQueryGeneration === queryGeneration) {
      generation++; request?.controller.abort(); request = null;
      page.status = 'loaded'; page.error = '';
    } else {
      // A newer query owns its request/status/cursor. Patch its response only if it contains this item.
      if (request) request.mutations.set(logId, assetsOnly && request.mutations.get(logId) !== false);
      if (!ns.state.myLogs.some(log => log.id === logId)) return;
    }
    const patch = patchHistoryItem(ns.state.myLogs, logId, assetsOnly);
    ns.state.myLogs = patch.logs;
    if (patch.removed) page.total = Math.max(0, page.total - 1);
    ns.renderMyLogs(); ns.syncHistoryDetail?.(); pageUi();
  }

  ns.deleteHistoryLog = async (logId) => {
    if (!logId) return;
    const ok = window.confirm('确认隐藏这条作品吗？\n\n隐藏作品不会取消任务或退款；提交状态未知的独立作品也可隐藏，仍需管理员核查。管理员记录会保留用于审计和余额对账；参考图和成品不会因隐藏而删除。');
    if (!ok) return;
    const epoch = ns.state.accountEpoch, token = ns.state.session?.token, mutationQueryGeneration = queryGeneration;
    const result = await ns.requestJson(`/api/me/logs/${encodeURIComponent(logId)}`, { method: 'DELETE' });
    if (!ns.isAccountContextCurrent(epoch, token)) return;
    if (!result.ok) return ns.setStatus(ns.getErrorMessage(result, '隐藏作品失败。执行中、批次未知或其他未结算任务不能隐藏；独立的提交状态未知作品除外。'), 'error');
    ns.setStatus('作品已从个人作品库隐藏，账本记录仍保留。', 'ok');
    removeHistoryItem(logId, false, mutationQueryGeneration);
  };

  let historySearchTimer = null;
  ns.resetHistorySearch = () => {
    if (historySearchTimer) window.clearTimeout(historySearchTimer);
    historySearchTimer = null;
  };
  ns.handleHistorySearch = () => {
    if (ns.state.session?.token && request) { generation++; request.controller.abort(); request = null; page.status = ns.state.myLogs.length ? 'loaded' : 'idle'; pageUi(); }
    if (historySearchTimer) window.clearTimeout(historySearchTimer);
    // 输入防抖 ~250ms，避免每敲一个字就整列表重渲染。
    historySearchTimer = window.setTimeout(() => {
      historySearchTimer = null;
      ns.state.historySearch = ns.els.historySearchInput?.value || '';
      if (!ns.state.session?.token) return ns.renderMyLogs();
      ns.state.myLogs = [];
      void ns.requestHistoryPage({ reset: true });
    }, 250);
  };
  ns.handleHistoryFilter = () => {
    ns.state.historyFilter = ns.els.historyFilterSelect?.value || 'all';
    if (!ns.state.session?.token) return ns.renderMyLogs();
    ns.state.myLogs = [];
    void ns.requestHistoryPage({ reset: true });
  };
  ns.handleHistoryClick = async (event) => {
    const button = event.target?.closest('[data-history-action]');
    if (!button) return;
    const action = button.dataset.historyAction;
    if (action === 'retry-load') return ns.requestHistoryPage({ append: retryAppend });
    const logId = button.dataset.logId;
    const log = ns.findHistoryLog(logId);
    if (action === 'delete-assets') {
      if (!window.confirm('永久删除此作品的参考图及成品？不可恢复，财务记录仍保留。')) return;
      const epoch = ns.state.accountEpoch, token = ns.state.session?.token, mutationQueryGeneration = queryGeneration;
      const result = await ns.requestJson(`/api/me/logs/${encodeURIComponent(logId)}/assets`, { method: 'DELETE', headers: { 'X-Confirm-Delete': 'permanent' } });
      if (!ns.isAccountContextCurrent(epoch, token)) return;
      if (!result.ok) return ns.setStatus('删除失败。', 'error');
      return removeHistoryItem(logId, true, mutationQueryGeneration);
    }
    if (action === 'delete') return ns.deleteHistoryLog(logId);
    if (!log) return;
    ns.invalidateWorkspaceDraftOperation?.();
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
      const epoch = ns.state.accountEpoch, token = ns.state.session?.token;
      if (!await applyHistoryLogToForm(log) || !ns.isAccountContextCurrent(epoch, token)) return;
      const estimate = ns.estimatePrice();
      if (!estimate.ok) return ns.setStatus(`无法再次生成：${estimate.error || '价格配置异常。'}`, 'error');
      await ns.handleRun();
    }
  };
})();
