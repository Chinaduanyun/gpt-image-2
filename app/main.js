(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  ns.initDefaults = () => {
    ns.setSelectValue(ns.els.model, ns.defaults.model || 'gpt-image-2');
    ns.setSelectValue(ns.els.aspectRatio, ns.defaults.aspectRatio);
    ns.setSelectValue(ns.els.resolution, ns.defaults.resolution);
    ns.setSelectValue(ns.els.quality, ns.defaults.quality);
    ns.setSelectValue(ns.els.outputFormat, ns.defaults.outputFormat);
    ns.setSelectValue(ns.els.imageCount, ns.defaults.imageCount);
    if (ns.defaults.outputCompression !== undefined) ns.els.outputCompression.value = String(ns.defaults.outputCompression);
    ns.updatePromptStats();
    ns.updateModelUi();
    ns.updateAdvancedSummary();
    ns.resetProgress();
    ns.renderReferences();
  };

  ns.bindEvents = () => {
    ns.els.emailInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !ns.els.loginBtn.disabled) ns.handleLogin();
    });
    ns.els.loginBtn.addEventListener('click', ns.handleLogin);
    ns.els.logoutBtn.addEventListener('click', ns.handleLogout);
    ns.els.adminToggleBtn.addEventListener('click', ns.toggleAdminPanel);
    ns.els.adminRefreshBtn.addEventListener('click', ns.loadAdminData);
    ns.els.adminAddUserBtn.addEventListener('click', ns.handleAdminAddUser);
    ns.els.adminUsersBody.addEventListener('click', ns.handleAdminUsersClick);
    ns.els.refreshMyLogsBtn.addEventListener('click', ns.loadMyLogs);
    ns.els.historySearchInput.addEventListener('input', ns.handleHistorySearch);
    ns.els.historyFilterSelect.addEventListener('change', ns.handleHistoryFilter);
    ns.els.prompt.addEventListener('input', ns.updatePromptStats);
    ns.els.model.addEventListener('change', ns.updateModelUi);
    ns.els.aspectRatio.addEventListener('change', ns.updatePriceEstimate);
    ns.els.resolution.addEventListener('change', ns.updatePriceEstimate);
    ns.els.imageCount.addEventListener('change', ns.updatePriceEstimate);
    ns.els.quality.addEventListener('change', ns.updatePriceEstimate);
    ns.els.outputFormat.addEventListener('change', ns.updateModelUi);
    ns.els.outputCompression.addEventListener('input', ns.updateModelUi);
    ns.els.runBtn.addEventListener('click', ns.handleRun);
    ns.els.clearBtn.addEventListener('click', ns.handleClear);
    ns.els.resultGrid.addEventListener('click', ns.handleResultAction);
    ns.els.refreshCurrentTaskBtn?.addEventListener('click', () => ns.recoverPendingGeneration());
    ns.els.reuseResultPromptBtn.addEventListener('click', ns.reuseCurrentResult);
    ns.els.regenerateResultBtn.addEventListener('click', ns.regenerateCurrentResult);
    ns.els.useAllResultsAsReferenceBtn.addEventListener('click', ns.useAllCurrentResultsAsReference);
    ns.els.myLogsList.addEventListener('click', ns.handleHistoryClick);
    ns.els.referenceUploadBtn.addEventListener('click', () => ns.els.referenceFileInput.click());
    ns.els.referenceFileInput.addEventListener('change', ns.addReferenceFiles);
    ns.els.clearReferencesBtn.addEventListener('click', () => {
      ns.clearReferences();
      ns.setReferenceStatus('已清空参考图。', 'ok');
    });
    ns.els.referencePreviewGrid.addEventListener('click', (event) => {
      const id = event.target?.dataset?.referenceId;
      if (id) ns.removeReference(id);
    });
  };

  ns.loadPublicConfig = async () => {
    const result = await ns.requestJson('/api/public-config');
    if (!result.ok || !result.json?.pricing || !result.json?.progress) throw new Error(ns.getErrorMessage(result, '公开配置加载失败。'));
    ns.state.publicConfig = result.json;
  };

  ns.startApp = async () => {
    ns.els.runBtn.disabled = true;
    ns.els.priceDetail.textContent = '正在加载服务端价格配置...';
    try {
      await ns.loadPublicConfig();
      ns.initDefaults();
      ns.bindEvents();
      ns.setBusy(false);
      await ns.restoreSession();
    } catch (error) {
      ns.setStatus(`初始化失败：${error?.message || error}`, 'error');
      ns.els.priceDetail.textContent = '价格配置加载失败，请刷新页面重试。';
    }
  };

  ns.startApp();
})();
