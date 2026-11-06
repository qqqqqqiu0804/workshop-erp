'use strict';

window.Pages = window.Pages || {};

Pages['users'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/auth/users');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const roleBadge = r => `<span class="tag ${r.is_active ? 'tag-green' : 'tag-red'}">${UI.esc(r.role)}</span>`;
    const table = UI.table([
      { key: 'username', label: '账号' },
      { key: 'display_name', label: '姓名', render: r => UI.esc(r.display_name || '—') },
      { key: 'role', label: '角色', render: r => roleBadge(r) },
      { key: 'is_active', label: '状态', render: r => r.is_active ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-red">停用</span>' },
      { key: '_act', label: '操作', render: r => `
        <button class="btn-sm" data-action="pw" data-id="${r.id}">改密</button>
        <button class="btn-sm ${r.is_active ? 'danger' : ''}" data-action="toggle" data-id="${r.id}" data-on="${r.is_active}">${r.is_active ? '停用' : '启用'}</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>用户管理</h2>
        <button class="btn" data-action="add">+ 新建账号</button>
      </div>
      <p class="muted">账号权限：老板/管理可看全部；跟单/销售仅看本人客户；采购仅看采购；工程仅看 BOM。密码用 scrypt 加密存储。</p>
      ${table}
    `;

    view.querySelectorAll('[data-action=add]').forEach(b => b.onclick = () => this.openCreate(view));
    view.querySelectorAll('[data-action=pw]').forEach(b => b.onclick = () => this.openPw(view, b.dataset.id));
    view.querySelectorAll('[data-action=toggle]').forEach(b => b.onclick = async () => {
      const on = b.dataset.on === '1';
      if (!confirm(on ? '确认停用该账号？' : '确认启用该账号？')) return;
      try { await API.put('/api/auth/users/' + b.dataset.id, { is_active: on ? 0 : 1 }); UI.toast('已更新', 'success'); this.render(view); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  },

  async openCreate(view) {
    const roleOpts = ['老板', '管理', '工程', '采购', '跟单', '销售', '车间', '品检'].map(r => ({ value: r, label: r }));
    await UI.formModal({
      title: '新建账号',
      submitText: '创建',
      fields: [
        { name: 'username', label: '账号', required: true, value: '' },
        { name: 'password', label: '初始密码', type: 'text', required: true, value: '', placeholder: '至少 6 位' },
        { name: 'display_name', label: '姓名', value: '' },
        { name: 'role', label: '角色', type: 'select', required: true,
          options: roleOpts, value: '跟单' }
      ],
      onSubmit: async (v) => {
        try { await API.post('/api/auth/users', v); UI.toast('账号已创建', 'success'); this.render(view); }
        catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async openPw(view, id) {
    await UI.formModal({
      title: '修改密码',
      submitText: '保存',
      fields: [
        { name: 'password', label: '新密码', type: 'text', required: true, value: '', placeholder: '至少 6 位' }
      ],
      onSubmit: async (v) => {
        try { await API.put('/api/auth/users/' + id, { password: v.password }); UI.toast('密码已更新', 'success'); this.render(view); }
        catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  }
};
