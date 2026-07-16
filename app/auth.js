(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  ns.getStoredSession = () => ({ email: window.localStorage.getItem('imageGenEmail') || '', token: window.localStorage.getItem('imageGenToken') || '' });
  ns.storeSession = (token, user) => {
    window.localStorage.setItem('imageGenEmail', user.email);
    window.localStorage.setItem('imageGenToken', token);
  };
  ns.clearStoredSession = (expectedToken = '') => {
    if (expectedToken && window.localStorage.getItem('imageGenToken') !== expectedToken) return false;
    window.localStorage.removeItem('imageGenToken');
    return true;
  };
  ns.clearAllStoredSession = () => {
    window.localStorage.removeItem('imageGenEmail');
    window.localStorage.removeItem('imageGenToken');
  };
  ns.userStorageKey = (name, emailOverride = '') => {
    const email = emailOverride || ns.state.session?.user?.email || ns.getStoredSession().email;
    return email ? `${name}:${email}` : '';
  };
  ns.resultStorageKey = () => ns.userStorageKey('imageGenLastResult');
  ns.pendingStorageKey = (ownerEmail = '') => ns.userStorageKey('imageGenPendingRequest', ownerEmail);

  function settingsWithoutReferencePayload(settings = {}) {
    const { image_urls, ...safeSettings } = settings;
    return { ...safeSettings, referenceImageCount: Array.isArray(image_urls) ? image_urls.length : 0 };
  }
  function openPendingDatabase() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('当前浏览器不支持安全的任务恢复存储。'));
      const request = globalThis.indexedDB.open('imageGenRecovery', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('pending')) request.result.createObjectStore('pending');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('任务恢复存储不可用。'));
    });
  }
  async function writePendingDatabase(key, value) {
    const database = await openPendingDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('pending', 'readwrite');
        const request = value ? transaction.objectStore('pending').put(value, key) : transaction.objectStore('pending').delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('任务恢复状态保存失败。'));
      });
    } finally {
      database.close();
    }
  }
  async function readPendingDatabase(key) {
    const database = await openPendingDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('pending', 'readonly').objectStore('pending').get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('任务恢复状态读取失败。'));
      });
    } finally {
      database.close();
    }
  }

  let lastStoredResultKey = '';
  let lastStoredResultPayload = '';
  ns.saveStoredResult = () => {
    const key = ns.resultStorageKey();
    if (!key || !ns.state.result) return;
    const { debug, ...serializable } = ns.state.result;
    const compact = { ...serializable, settings: settingsWithoutReferencePayload(serializable.settings) };
    // 只在内容（不含易变的 savedAt）与上次写入不同时才落盘：轮询每 4s 触发一次
    // saveStoredResult，内容未变时跳过整段 localStorage 重写。
    const payload = JSON.stringify(compact);
    if (key === lastStoredResultKey && payload === lastStoredResultPayload) return;
    try {
      window.localStorage.setItem(key, JSON.stringify({ ...compact, savedAt: new Date().toISOString() }));
      lastStoredResultKey = key;
      lastStoredResultPayload = payload;
    } catch {
      window.localStorage.removeItem(key);
      lastStoredResultKey = '';
      lastStoredResultPayload = '';
    }
  };
  ns.clearStoredResult = () => {
    const key = ns.resultStorageKey();
    if (key) window.localStorage.removeItem(key);
    lastStoredResultKey = '';
    lastStoredResultPayload = '';
  };
  ns.savePendingRequest = async (pending, ownerEmail) => {
    const owner = String(ownerEmail || '').trim();
    if (!owner) throw new Error('任务恢复记录缺少账号标识。');
    if (pending?.ownerEmail && pending.ownerEmail !== owner) throw new Error('任务恢复记录与账号不匹配。');
    const value = pending ? { ...pending, ownerEmail: owner } : null;
    const key = ns.pendingStorageKey(owner);
    if (ns.state.session?.user?.email === owner) {
      ns.state.pendingRequest = value;
      ns.updatePendingUi?.();
    }
    await writePendingDatabase(key, value);
    if (value) {
      const compact = {
        ...value,
        settings: settingsWithoutReferencePayload(value.settings),
        hasReferencePayload: Array.isArray(value.settings?.image_urls) && value.settings.image_urls.length > 0
      };
      try { window.localStorage.setItem(key, JSON.stringify(compact)); } catch { window.localStorage.removeItem(key); }
    } else {
      window.localStorage.removeItem(key);
    }
  };
  ns.restorePendingRequest = async () => {
    const ownerEmail = ns.state.session?.user?.email || '';
    const key = ns.pendingStorageKey(ownerEmail);
    const epoch = ns.state.accountEpoch;
    ns.state.pendingRequest = null;
    ns.updatePendingUi?.();
    if (!key) return null;
    try {
      let pending = await readPendingDatabase(key);
      if (!pending) {
        const fallback = JSON.parse(window.localStorage.getItem(key) || 'null');
        if (fallback?.hasReferencePayload && !fallback?.batchId && !fallback?.taskId) return null;
        pending = fallback;
      }
      if (!pending?.idempotencyKey || !pending?.settings || (pending.ownerEmail && pending.ownerEmail !== ownerEmail)) return null;
      if (epoch !== ns.state.accountEpoch || ownerEmail !== ns.state.session?.user?.email || key !== ns.pendingStorageKey(ownerEmail)) return null;
      pending = { ...pending, ownerEmail };
      ns.state.pendingRequest = pending;
      ns.updatePendingUi?.();
      return pending;
    } catch {
      try {
        const fallback = JSON.parse(window.localStorage.getItem(key) || 'null');
        if (!fallback?.idempotencyKey || !fallback?.settings || (fallback.hasReferencePayload && !fallback.batchId && !fallback.taskId) || (fallback.ownerEmail && fallback.ownerEmail !== ownerEmail)) return null;
        if (epoch !== ns.state.accountEpoch || ownerEmail !== ns.state.session?.user?.email || key !== ns.pendingStorageKey(ownerEmail)) return null;
        const pending = { ...fallback, ownerEmail };
        ns.state.pendingRequest = pending;
        ns.updatePendingUi?.();
        return pending;
      } catch {
        window.localStorage.removeItem(key);
        return null;
      }
    }
  };
  ns.restoreStoredResult = () => {
    const key = ns.resultStorageKey();
    if (!key) return;
    try {
      const result = JSON.parse(window.localStorage.getItem(key) || 'null');
      if (!result?.settings || (!Array.isArray(result.imageUrls) && !Array.isArray(result.children))) return;
      ns.state.result = { ...result, imageUrls: Array.isArray(result.imageUrls) ? result.imageUrls : [], debug: null };
      if (result.prompt && !ns.els.prompt.value.trim()) {
        ns.els.prompt.value = result.prompt;
        ns.updatePromptStats();
      }
      ns.renderResult();
      ns.setStatus('已恢复上次生成状态。', result.status === 'completed' ? 'ok' : 'loading');
    } catch {
      window.localStorage.removeItem(key);
    }
  };
  ns.resetAccountRuntime = () => {
    ns.state.accountEpoch += 1;
    ns.resetNotifyDedup?.();
    ns.state.pollController?.abort();
    ns.state.submitController?.abort();
    ns.state.pollController = null;
    ns.state.submitController = null;
    ns.stopProgress?.();
    ns.state.isBusy = false;
    ns.state.pendingRequest = null;
    ns.state.activeOperationToken = '';
    ns.state.result = null;
    ns.state.myLogs = [];
    ns.state.referenceImages = [];
    if (ns.els?.prompt) ns.els.prompt.value = '';
    if (ns.els?.referenceFileInput) ns.els.referenceFileInput.value = '';
    ns.updatePromptStats?.();
    ns.renderReferences?.();
    ns.updatePendingUi?.();
  };
  ns.renderAuthState = () => {
    const loggedIn = Boolean(ns.state.session?.token && ns.state.session?.user);
    ns.els.loginPanel.classList.toggle('hidden', loggedIn);
    ns.els.userBar.classList.toggle('hidden', !loggedIn);
    ns.els.appShell.classList.toggle('hidden', !loggedIn);
    ns.els.adminToggleBtn.classList.toggle('hidden', !ns.state.session?.user?.isAdmin);
    ns.els.adminPanel.classList.toggle('hidden', !loggedIn || !ns.state.session?.user?.isAdmin || !ns.state.adminVisible);
    if (loggedIn) {
      ns.els.currentUserEmail.textContent = ns.state.session.user.email;
      ns.els.currentUserBalance.textContent = `余额 ${ns.formatMicros(ns.state.session.user.balanceMicros)}`;
      ns.updatePriceEstimate?.();
    }
    // 完成通知开关的偏好按账号隔离，登录/切换/恢复会话后按当前账号回显。
    ns.renderNotifyToggle?.();
  };
  ns.isAccountContextCurrent = (epoch, token, ownerEmail = '') => Boolean(
    epoch === ns.state.accountEpoch &&
    token && token === ns.state.session?.token &&
    (!ownerEmail || ownerEmail === ns.state.session?.user?.email)
  );
  ns.loadMe = async () => {
    const epoch = ns.state.accountEpoch;
    const token = ns.state.session?.token;
    const result = await ns.requestJson('/api/me');
    // 网关偶发返回非 JSON 的 200 时 result.json 为 null，取 .user 会抛异常并把
    // 已成功的生成误报为失败。缺 user 一律按加载失败处理。
    if (!result.ok || !result.json?.user || !ns.isAccountContextCurrent(epoch, token)) return false;
    ns.state.session.user = result.json.user;
    ns.renderAuthState();
    return true;
  };
  ns.handleLogin = async () => {
    const email = ns.els.emailInput.value.trim();
    if (!email) return ns.setLoginStatus('请输入邮箱。', 'error');
    const attemptId = (Number(ns.state.loginAttemptId) || 0) + 1;
    ns.state.loginAttemptId = attemptId;
    ns.els.loginBtn.disabled = true;
    ns.els.emailInput.disabled = true;
    ns.setLoginStatus('正在验证邮箱...', 'loading');
    try {
      const result = await ns.requestJson('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email }) });
      if (attemptId !== ns.state.loginAttemptId) return;
      if (!result.ok) return ns.setLoginStatus(ns.getErrorMessage(result, `登录失败：HTTP ${result.status}`), 'error');
      if (!result.json?.token || !result.json?.user) return ns.setLoginStatus('登录响应无效（网关未返回有效数据），请稍后重试。', 'error');
      ns.resetAccountRuntime();
      ns.state.session = { token: result.json.token, user: result.json.user };
      ns.storeSession(result.json.token, result.json.user);
      ns.state.adminVisible = false;
      ns.renderAuthState();
      ns.setStatus('登录成功，可以开始生成图片。', 'ok');
      ns.restoreStoredResult();
      const epoch = ns.state.accountEpoch;
      const token = ns.state.session.token;
      const ownerEmail = ns.state.session.user.email;
      await ns.restorePendingRequest();
      if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
      if (ns.state.pendingRequest) await ns.recoverPendingGeneration({ automatic: true });
      if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
      await ns.loadMyLogs();
      if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
      if (ns.state.session.user.isAdmin) await ns.loadAdminData();
      if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
    } catch (error) {
      if (attemptId === ns.state.loginAttemptId) ns.setLoginStatus(`登录失败：${error?.message || error}`, 'error');
    } finally {
      if (attemptId === ns.state.loginAttemptId) {
        ns.els.loginBtn.disabled = false;
        ns.els.emailInput.disabled = false;
      }
    }
  };
  ns.handleLogout = async () => {
    ns.state.pollController?.abort();
    try { await ns.requestJson('/api/auth/logout', { method: 'POST' }); } catch {}
    ns.resetAccountRuntime();
    ns.clearAllStoredSession();
    ns.state.session = null;
    ns.state.adminVisible = false;
    ns.clearReferences();
    ns.resetResult();
    ns.resetProgress();
    ns.renderAuthState();
    ns.setLoginStatus('已退出登录。');
    ns.els.emailInput.value = '';
  };
  ns.restoreSession = async () => {
    const stored = ns.getStoredSession();
    if (stored.email) ns.els.emailInput.value = stored.email;
    if (!stored.token) return ns.renderAuthState();
    ns.resetAccountRuntime();
    ns.state.session = { token: stored.token, user: null };
    const loadEpoch = ns.state.accountEpoch;
    const ok = await ns.loadMe();
    if (!ok) {
      if (!ns.isAccountContextCurrent(loadEpoch, stored.token)) return;
      ns.state.session = null;
      ns.clearStoredSession();
      ns.renderAuthState();
      ns.setLoginStatus('登录已失效，请重新输入邮箱。');
      return;
    }
    const epoch = ns.state.accountEpoch;
    const token = ns.state.session.token;
    const ownerEmail = ns.state.session.user.email;
    ns.restoreStoredResult();
    await ns.restorePendingRequest();
    if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
    if (ns.state.pendingRequest) await ns.recoverPendingGeneration({ automatic: true });
    if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
    await ns.loadMyLogs();
    if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
    if (ns.state.session.user.isAdmin) await ns.loadAdminData();
    if (!ns.isAccountContextCurrent(epoch, token, ownerEmail)) return;
  };
})();
