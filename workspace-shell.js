(() => {
  const viewNames = new Set(['workspace', 'library', 'edit', 'admin']);
  const appShell = document.getElementById('appShell');
  const adminButton = document.getElementById('adminToggleBtn');
  const adminPanel = document.getElementById('adminPanel');
  const historyList = document.getElementById('myLogsList');
  const historyDialog = document.getElementById('previewHistoryDialog');
  const historyDialogClose = document.getElementById('previewHistoryDialogClose');
  const historyDialogSubtitle = document.getElementById('previewHistoryDialogSubtitle');
  const historyDetailImage = document.getElementById('previewHistoryDetailImage');
  const historyDetailEmpty = document.getElementById('previewHistoryDetailEmpty');
  const historyDetailGallery = document.getElementById('previewHistoryDetailGallery');
  const historyOpenOriginal = document.getElementById('previewHistoryOpenOriginal');
  const historyDetailContent = document.getElementById('previewHistoryDetailContent');
  const progressHint = document.getElementById('progressHint');
  const navButtons = [...document.querySelectorAll('[data-preview-nav]')];
  const views = [...document.querySelectorAll('[data-preview-view]')];
  const headings = {
    workspace: document.getElementById('workspaceTitle'),
    library: document.getElementById('libraryTitle'),
    edit: document.getElementById('editTitle'),
    admin: document.getElementById('adminTitle')
  };

  let activeView = 'workspace';
  let eventsBound = false;
  let syncingAdmin = false;
  let activeHistoryRow = null;
  let lastHistoryTrigger = null;
  let detailImages = [];

  const isClassHidden = (element) => !element || element.classList.contains('hidden');
  const isAdminAvailable = () => Boolean(adminButton && !isClassHidden(adminButton));
  const isAdminOpen = () => Boolean(adminPanel && !isClassHidden(adminPanel));
  const hashView = () => {
    const value = window.location.hash.replace(/^#/, '').toLowerCase();
    return viewNames.has(value) ? value : 'workspace';
  };

  function updateHash(name, replace = false) {
    const nextHash = `#${name}`;
    if (window.location.hash === nextHash) return;
    if (replace) window.history.replaceState(null, '', nextHash);
    else window.location.hash = nextHash;
  }

  function updateViewDom(name) {
    activeView = name;
    views.forEach((view) => {
      view.hidden = view.dataset.previewView !== name;
    });
    navButtons.forEach((button) => {
      const selected = button.dataset.previewNav === name;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function focusView(name) {
    const heading = headings[name];
    if (!heading) return;
    window.requestAnimationFrame(() => {
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start'
      });
    });
  }

  function closeAdminIfNeeded() {
    if (!isAdminOpen() || !adminButton) return;
    syncingAdmin = true;
    adminButton.click();
    syncingAdmin = false;
  }

  function openAdminIfNeeded() {
    if (isAdminOpen() || !adminButton) return;
    syncingAdmin = true;
    adminButton.click();
    syncingAdmin = false;
  }

  function isHistoryDialogOpen() {
    return Boolean(historyDialog && (historyDialog.open || historyDialog.hasAttribute?.('open')));
  }

  function closeHistoryDialog({ restoreFocus = true } = {}) {
    if (!historyDialog || !isHistoryDialogOpen()) return;
    if (typeof historyDialog.close === 'function') historyDialog.close();
    else historyDialog.removeAttribute('open');
    if (restoreFocus && lastHistoryTrigger?.focus) lastHistoryTrigger.focus({ preventScroll: true });
    activeHistoryRow = null;
  }

  function activateView(requestedName, options = {}) {
    const { focus = false, updateUrl = true, replaceHash = false } = options;
    let name = viewNames.has(requestedName) ? requestedName : 'workspace';

    if (name !== 'library') closeHistoryDialog({ restoreFocus: false });
    if (name === 'admin') {
      if (!isAdminAvailable()) name = 'workspace';
      else openAdminIfNeeded();
      if (name === 'admin' && !isAdminOpen()) name = 'workspace';
    } else {
      closeAdminIfNeeded();
    }

    updateViewDom(name);
    if (updateUrl) updateHash(name, replaceHash);
    if (focus) focusView(name);
  }

  function handleNavClick(event) {
    const button = event.currentTarget;
    const name = button.dataset.previewNav;

    if (name === 'admin') {
      if (syncingAdmin) return;
      if (isAdminOpen()) activateView('admin', { focus: true });
      else activateView('workspace', { focus: true });
      return;
    }

    activateView(name, { focus: true });
  }

  function handleHashChange() {
    activateView(hashView(), { focus: true, updateUrl: false });
  }

  function appendHistorySummary(row) {
    const date = row.querySelector('.history-topline strong')?.textContent?.trim() || '';
    const statusSource = row.querySelector('.history-status');
    const status = statusSource?.textContent?.trim() || '任务记录';
    const settings = row.querySelector('.history-main > span')?.textContent?.trim() || '查看生成详情';
    const summary = document.createElement('div');
    const statusText = document.createElement('span');
    const settingsText = document.createElement('span');
    const dateText = document.createElement('span');

    summary.className = 'preview-history-summary';
    statusText.className = 'preview-history-summary-status';
    for (const name of ['ok', 'partial', 'unknown', 'error', 'loading']) {
      if (statusSource?.classList.contains(name)) statusText.classList.add(name);
    }
    statusText.textContent = status;
    settingsText.className = 'preview-history-summary-text';
    settingsText.textContent = settings;
    dateText.className = 'preview-history-summary-date';
    dateText.textContent = date;
    summary.append(statusText, settingsText, dateText);
    row.append(summary);
  }

  function enhanceHistoryRows() {
    if (!historyList || typeof historyList.querySelectorAll !== 'function' || typeof document.createElement !== 'function') return;
    historyList.querySelectorAll('.history-row:not([data-preview-enhanced])').forEach((row) => {
      row.dataset.previewEnhanced = 'true';
      const thumbs = [...row.querySelectorAll('.history-thumb')];
      thumbs.forEach((thumb, index) => {
        thumb.dataset.previewHistoryDetail = 'true';
        thumb.dataset.previewImageIndex = String(index);
        thumb.removeAttribute('target');
        thumb.setAttribute('aria-label', `查看作品详情，第 ${index + 1} 张`);
        thumb.title = '查看作品详情';
      });

      const images = row.querySelector('.history-images');
      const empty = row.querySelector('.history-empty');
      const settings = row.querySelector('.history-main > span')?.textContent || '';
      const ratio = settings.match(/(?:^|\s)(\d+):(\d+)(?:\s|$)/);
      if (ratio) {
        const width = Number(ratio[1]);
        const height = Number(ratio[2]);
        if (width > 0 && height > 0) {
          if (images) images.style.aspectRatio = `${width} / ${height}`;
          if (empty) empty.style.aspectRatio = `${width} / ${height}`;
        }
      }
      if (images && thumbs.length > 1) {
        const count = document.createElement('span');
        count.className = 'preview-history-image-count';
        count.textContent = `共 ${thumbs.length} 张`;
        images.append(count);
      }

      if (empty) {
        empty.dataset.previewHistoryDetail = 'true';
        empty.tabIndex = 0;
        empty.setAttribute('role', 'button');
        empty.setAttribute('aria-label', '查看任务详情');
        empty.title = '查看任务详情';
      }
      appendHistorySummary(row);
    });
  }

  function selectDetailImage(index) {
    if (!historyDetailImage || !historyDetailEmpty || !historyOpenOriginal) return;
    const image = detailImages[index];
    const hasImage = Boolean(image?.src);
    historyDetailImage.hidden = !hasImage;
    historyDetailEmpty.hidden = hasImage;
    historyOpenOriginal.classList.toggle('hidden', !hasImage);
    if (hasImage) {
      historyDetailImage.src = image.src;
      historyDetailImage.alt = image.alt || `历史作品图片 ${index + 1}`;
      historyOpenOriginal.href = image.src;
    } else {
      historyDetailImage.removeAttribute('src');
      historyDetailImage.alt = '';
      historyOpenOriginal.removeAttribute('href');
    }
    historyDetailGallery?.querySelectorAll('[data-preview-gallery-index]').forEach((button) => {
      button.classList.toggle('is-active', Number(button.dataset.previewGalleryIndex) === index);
    });
  }

  function renderDetailGallery(selectedIndex) {
    if (!historyDetailGallery) return;
    historyDetailGallery.replaceChildren();
    detailImages.forEach((image, index) => {
      const button = document.createElement('button');
      const thumbnail = document.createElement('img');
      button.type = 'button';
      button.dataset.previewGalleryIndex = String(index);
      button.setAttribute('aria-label', `查看第 ${index + 1} 张图片`);
      thumbnail.src = image.src;
      thumbnail.alt = '';
      button.append(thumbnail);
      historyDetailGallery.append(button);
    });
    historyDetailGallery.hidden = detailImages.length < 2;
    selectDetailImage(selectedIndex);
  }

  function openHistoryDialog(row, trigger, selectedIndex = 0) {
    if (!historyDialog || !historyDetailContent || typeof row?.querySelectorAll !== 'function') return;
    activeHistoryRow = row;
    lastHistoryTrigger = trigger;
    detailImages = [...row.querySelectorAll('.history-thumb img')].map((image) => ({
      src: image.currentSrc || image.src,
      alt: image.alt
    })).filter((image) => image.src);

    const topLine = row.querySelector('.history-topline')?.cloneNode(true);
    const main = row.querySelector('.history-main')?.cloneNode(true);
    historyDetailContent.replaceChildren(...[topLine, main].filter(Boolean));
    if (!topLine && !main) historyDetailContent.textContent = '这条记录暂无可显示的详情。';

    const date = row.querySelector('.history-topline strong')?.textContent?.trim() || '';
    const settings = row.querySelector('.history-main > span')?.textContent?.trim() || '';
    if (historyDialogSubtitle) historyDialogSubtitle.textContent = [settings, date].filter(Boolean).join(' · ') || '查看图片、提示词、参数与任务信息。';

    renderDetailGallery(Math.min(Math.max(selectedIndex, 0), Math.max(detailImages.length - 1, 0)));
    if (!isHistoryDialogOpen()) {
      if (typeof historyDialog.showModal === 'function') historyDialog.showModal();
      else historyDialog.setAttribute('open', '');
    }
    historyDialogClose?.focus({ preventScroll: true });
  }

  function handleHistoryAction(event) {
    const action = event.target?.closest('[data-history-action]')?.dataset?.historyAction;
    if (action === 'reuse' || action === 'regenerate') {
      window.setTimeout(() => activateView('workspace', { focus: true }), 0);
      return;
    }

    const trigger = event.target?.closest('[data-preview-history-detail]');
    if (!trigger) return;
    event.preventDefault?.();
    const row = trigger.closest('.history-row');
    openHistoryDialog(row, trigger, Number(trigger.dataset.previewImageIndex || 0));
  }

  function handleHistoryKeydown(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    const trigger = event.target?.closest('[data-preview-history-detail]');
    if (!trigger || trigger.matches?.('a, button')) return;
    event.preventDefault?.();
    openHistoryDialog(trigger.closest('.history-row'), trigger, 0);
  }

  function handleHistoryDialogClick(event) {
    if (event.target === historyDialog) {
      closeHistoryDialog();
      return;
    }
    const galleryButton = event.target?.closest('[data-preview-gallery-index]');
    if (galleryButton) {
      selectDetailImage(Number(galleryButton.dataset.previewGalleryIndex));
      return;
    }
    const clonedAction = event.target?.closest('[data-history-action]');
    if (!clonedAction || !activeHistoryRow) return;
    const action = clonedAction.dataset.historyAction;
    const logId = clonedAction.dataset.logId;
    const original = [...activeHistoryRow.querySelectorAll('[data-history-action]')].find((button) => (
      button.dataset.historyAction === action && button.dataset.logId === logId
    ));
    if (!original || original.disabled) return;
    closeHistoryDialog({ restoreFocus: false });
    original.click();
  }

  function suppressPreviewProgressHint() {
    if (progressHint?.textContent?.trim() === '正在提交生成任务。下方百分比是根据耗时估算，不是供应商真实进度。') {
      progressHint.textContent = '';
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    navButtons.forEach((button) => button.addEventListener('click', handleNavClick));
    historyList?.addEventListener('click', handleHistoryAction);
    historyList?.addEventListener('keydown', handleHistoryKeydown);
    historyDialog?.addEventListener('click', handleHistoryDialogClick);
    historyDialog?.addEventListener('close', () => {
      activeHistoryRow = null;
    });
    historyDialogClose?.addEventListener('click', () => closeHistoryDialog());
    window.addEventListener('hashchange', handleHashChange);

    enhanceHistoryRows();
    const initial = hashView();
    activateView(initial, {
      updateUrl: true,
      replaceHash: !window.location.hash
    });
  }

  function syncAuthenticatedShell() {
    if (isClassHidden(appShell)) {
      closeHistoryDialog({ restoreFocus: false });
      closeAdminIfNeeded();
      updateViewDom('workspace');
      return;
    }

    bindEvents();
    enhanceHistoryRows();
    if (activeView === 'admin' && (!isAdminAvailable() || !isAdminOpen())) {
      activateView('workspace', { replaceHash: true });
    }
  }

  const shellObserver = new MutationObserver(syncAuthenticatedShell);
  if (appShell) shellObserver.observe(appShell, { attributes: true, attributeFilter: ['class'] });

  const adminObserver = new MutationObserver(() => {
    if (syncingAdmin || isClassHidden(appShell)) return;
    if (!isAdminAvailable() && activeView === 'admin') {
      activateView('workspace', { replaceHash: true });
      return;
    }
    if (isAdminOpen() && activeView !== 'admin') {
      updateViewDom('admin');
      updateHash('admin');
    } else if (!isAdminOpen() && activeView === 'admin') {
      updateViewDom('workspace');
      updateHash('workspace', true);
    }
  });

  const historyObserver = new MutationObserver(enhanceHistoryRows);
  const progressHintObserver = new MutationObserver(suppressPreviewProgressHint);
  if (historyList) historyObserver.observe(historyList, { childList: true });
  if (progressHint) progressHintObserver.observe(progressHint, { childList: true, characterData: true, subtree: true });
  if (adminButton) adminObserver.observe(adminButton, { attributes: true, attributeFilter: ['class'] });
  if (adminPanel) adminObserver.observe(adminPanel, { attributes: true, attributeFilter: ['class'] });

  updateViewDom('workspace');
  syncAuthenticatedShell();
})();
