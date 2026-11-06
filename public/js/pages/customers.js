'use strict';

window.Pages = window.Pages || {};

Pages.customers = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/customers');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'name', label: '客户名' },
      { key: 'type', label: '类型' },
      { key: 'contact', label: '联系人' },
      { key: 'owner_role', label: '归属角色', render: r => r.owner_role ? UI.esc(r.owner_role) : '<span class="muted">全量可见</span>' },
      { key: 'remark', label: '备注' },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>客户</h2><span class="sub">国内/国外客户；归属角色用于 RBAC 客户数据隔离</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增客户</button>
      </div>
      <p class="muted">「归属角色」留空 = 所有角色可见（管理/工程/采购默认全量）；填「跟单A」等则仅该角色在销售订单中可见（验收2）。</p>
      <div class="card">${table}</div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, Number(b.dataset.id));
    if (a === 'del') {
      if (await UI.confirm('删除该客户？')) {
        await API.del('/api/customers/' + b.dataset.id);
        UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let row = {};
    if (id) row = (await API.get('/api/customers/' + id)).data;
    const fields = [
      { name: 'name', label: '客户名', required: true, value: row.name || '' },
      { name: 'type', label: '类型', type: 'select', options: [{ value: '国内', label: '国内' }, { value: '国外', label: '国外' }], value: row.type || '国内' },
      { name: 'contact', label: '联系人', value: row.contact || '' },
      { name: 'owner_role', label: '归属角色（RBAC）', value: row.owner_role || '', placeholder: '如 跟单A，留空=全量' },
      { name: 'remark', label: '备注', type: 'textarea', value: row.remark || '' }
    ];
    await UI.formModal({
      title: id ? '编辑客户' : '新增客户',
      submitText: '保存',
      fields,
      onSubmit: async (v) => {
        try {
          if (id) await API.put('/api/customers/' + id, v);
          else await API.post('/api/customers', v);
          UI.toast('已保存', 'success'); this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  }
};
