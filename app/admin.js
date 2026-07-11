(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  ns.renderAdminUsers = (users) => {
    ns.els.adminUsersBody.innerHTML = users.map((user) => `
      <tr data-email="${ns.escapeHtml(user.email)}">
        <td>${ns.escapeHtml(user.email)}${user.isAdmin ? ' · 管理员' : ''}</td>
        <td><input class="admin-name-input" type="text" value="${ns.escapeHtml(user.name || '')}" /></td>
        <td>${ns.escapeHtml(ns.formatMicros(user.balanceMicros))}</td>
        <td>${user.active ? '启用' : '禁用'}</td>
        <td><input class="admin-delta-input" type="number" step="0.00001" value="1" /></td>
        <td class="table-actions">
          <button class="secondary compact admin-save-user" type="button">保存</button>
          <button class="secondary compact admin-toggle-user" type="button">${user.active ? '禁用' : '启用'}</button>
          <button class="secondary compact admin-add-balance" type="button">调额</button>
        </td>
      </tr>
    `).join('');
  };
  ns.renderAdminLogs = (logs) => {
    ns.els.adminLogsBody.innerHTML = logs.map((log) => `
      <tr>
        <td>${ns.escapeHtml(ns.formatDate(log.createdAt))}</td>
        <td>${ns.escapeHtml(log.email || '-')}</td>
        <td>${ns.escapeHtml(ns.logStatusText(log))}</td>
        <td>${ns.escapeHtml([ns.settingsText(log), ns.referenceText(log)].filter(Boolean).join(' · '))}</td>
        <td>${ns.escapeHtml(ns.promptText(log))}</td>
        <td>${ns.escapeHtml(ns.costText(log))}</td>
        <td>${ns.escapeHtml(ns.balanceText(log))}</td>
        <td>${ns.escapeHtml(log.taskId || '-')}</td>
      </tr>
    `).join('');
  };
  ns.loadAdminData = async () => {
    if (!ns.state.session?.user?.isAdmin) return;
    const epoch = ns.state.accountEpoch;
    const token = ns.state.session.token;
    ns.els.adminRefreshBtn.disabled = true;
    ns.setAdminStatus('正在加载管理数据...', 'loading');
    ns.els.adminUsersBody.innerHTML = '<tr><td colspan="6">正在加载用户列表...</td></tr>';
    ns.els.adminLogsBody.innerHTML = '<tr><td colspan="8">正在加载最近 100 条消费日志...</td></tr>';
    try {
      const [usersResult, logsResult] = await Promise.all([
        ns.requestJson('/api/admin/users'),
        ns.requestJson('/api/admin/spend-logs?limit=100')
      ]);
      if (epoch !== ns.state.accountEpoch || token !== ns.state.session?.token) return;
      if (usersResult.ok) ns.renderAdminUsers(usersResult.json.users || []);
      else ns.els.adminUsersBody.innerHTML = `<tr><td colspan="6">${ns.escapeHtml(ns.getErrorMessage(usersResult, '用户列表加载失败，请重试。'))}</td></tr>`;
      if (logsResult.ok) ns.renderAdminLogs(logsResult.json.logs || []);
      else ns.els.adminLogsBody.innerHTML = `<tr><td colspan="8">${ns.escapeHtml(ns.getErrorMessage(logsResult, '消费日志加载失败，请重试。'))}</td></tr>`;
      ns.setAdminStatus(usersResult.ok && logsResult.ok ? '管理数据已更新。' : '部分管理数据加载失败，请重试。', usersResult.ok && logsResult.ok ? 'ok' : 'error');
    } catch (error) {
      ns.setAdminStatus(`管理数据加载失败：${error?.message || error}`, 'error');
    } finally {
      ns.els.adminRefreshBtn.disabled = false;
    }
  };
  ns.handleAdminAddUser = async () => {
    const email = ns.els.adminAddEmail.value.trim();
    if (!email) return ns.setAdminStatus('请输入用户邮箱。', 'error');
    const result = await ns.requestJson('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, name: ns.els.adminAddName.value.trim(), balanceMicros: ns.parseUsdInput(ns.els.adminAddBalance.value), active: true }) });
    if (!result.ok) return ns.setAdminStatus(ns.getErrorMessage(result, `添加失败：HTTP ${result.status}`), 'error');
    ns.els.adminAddEmail.value = '';
    ns.els.adminAddName.value = '';
    ns.setAdminStatus('用户已添加。', 'ok');
    await ns.loadAdminData();
  };
  ns.handleAdminUsersClick = async (event) => {
    const row = event.target.closest('tr[data-email]');
    if (!row) return;
    const email = row.dataset.email;
    if (event.target.classList.contains('admin-save-user')) {
      const name = row.querySelector('.admin-name-input').value;
      const result = await ns.requestJson(`/api/admin/users/${encodeURIComponent(email)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name }) });
      ns.setAdminStatus(result.ok ? '用户已保存。' : ns.getErrorMessage(result, '保存失败。'), result.ok ? 'ok' : 'error');
      await ns.loadAdminData();
      return;
    }
    if (event.target.classList.contains('admin-toggle-user')) {
      const active = event.target.textContent.trim() === '启用';
      const result = await ns.requestJson(`/api/admin/users/${encodeURIComponent(email)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ active }) });
      ns.setAdminStatus(result.ok ? '用户状态已更新。' : ns.getErrorMessage(result, '更新失败。'), result.ok ? 'ok' : 'error');
      await ns.loadAdminData();
      return;
    }
    if (event.target.classList.contains('admin-add-balance')) {
      const deltaUsd = row.querySelector('.admin-delta-input').value;
      const result = await ns.requestJson(`/api/admin/users/${encodeURIComponent(email)}/balance`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ deltaMicros: ns.parseUsdInput(deltaUsd), reason: '手动调额' }) });
      ns.setAdminStatus(result.ok ? '余额已调整。' : ns.getErrorMessage(result, '调额失败。'), result.ok ? 'ok' : 'error');
      await ns.loadAdminData();
    }
  };
  ns.toggleAdminPanel = async () => {
    ns.state.adminVisible = !ns.state.adminVisible;
    ns.renderAuthState();
    if (ns.state.adminVisible) await ns.loadAdminData();
  };
})();
