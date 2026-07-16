(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  ns.parseUsdInput = (value) => Math.round((Number(value) || 0) * (Number(ns.state.publicConfig?.pricing?.microsPerUnit) || 1000000));
  ns.formatDate = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  };
  // 仅允许把 http:/https: 或以 / 开头的同源相对路径放进 <a href>；拦截 javascript:、
  // data:、vbscript: 等可执行/可注入协议。协议相对地址 //host 按 http(s) 解析视为合法。
  ns.isSafeLinkUrl = (url) => {
    const text = String(url ?? '').trim();
    if (!text) return false;
    if (text.startsWith('/') && !text.startsWith('//')) return true;
    try {
      const parsed = new URL(text, (typeof window !== 'undefined' && window.location?.href) || 'http://localhost/');
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };
  ns.escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  ns.setSelectValue = (select, value) => {
    if (!value) return;
    const exists = Array.from(select.options).some((option) => option.value === String(value));
    if (exists) select.value = String(value);
  };
  ns.setStatusClass = (el, baseClass, message, type = '') => {
    el.textContent = message;
    el.className = [baseClass, type].filter(Boolean).join(' ');
    if (type === 'error') el.setAttribute('role', 'alert');
    else el.removeAttribute('role');
  };
  ns.announceLive = (message) => {
    if (!ns.els.resultLive || !message || message === ns.state.lastLiveAnnouncement) return;
    ns.state.lastLiveAnnouncement = message;
    ns.els.resultLive.textContent = message;
  };
  ns.setStatus = (message, type = '') => ns.setStatusClass(ns.els.status, 'status', message, type);
  ns.setLoginStatus = (message, type = '') => ns.setStatusClass(ns.els.loginStatus, 'status', message, type);
  ns.setAdminStatus = (message, type = '') => ns.setStatusClass(ns.els.adminStatus, 'status', message, type);
  ns.setReferenceStatus = (message, type = '') => ns.setStatusClass(ns.els.referenceStatus, 'status reference-status', message, type);
  ns.authHeaders = () => ns.state.session?.token ? { Authorization: `Bearer ${ns.state.session.token}` } : {};
  ns.getErrorMessage = (result, fallback) => {
    const error = result?.json?.error;
    if (typeof error === 'string') return error;
    return error?.message || result?.json?.message || result?.json?.data?.error?.message || fallback;
  };
  ns.requestJson = async (path, options = {}) => {
    const requestToken = ns.state.session?.token || '';
    const headers = { ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}), ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const result = { ok: response.ok, status: response.status, text, json };
    if (response.status === 401 && path !== '/api/auth/login' && requestToken && requestToken === ns.state.session?.token) {
      ns.resetAccountRuntime?.();
      ns.clearStoredSession(requestToken);
      ns.state.session = null;
      ns.renderAuthState();
    }
    return result;
  };
})();
