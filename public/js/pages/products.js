'use strict';

window.Pages = window.Pages || {};

Pages.products = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/products');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'code', label: '产品编码' },
      { key: 'name', label: '名称' },
      { key: 'category', label: '分类' },
      { key: 'spec', label: '规格' },
      { key: 'unit', label: '单位' },
      { key: 'remark', label: '备注' },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>产品信息</h2><span class="sub">五金件产品基础信息维护</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增产品</button>
      </div>
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
      if (await UI.confirm('删除该产品？已关联的生产记录将保留但产品名显示为缺失。')) {
        await API.del('/api/products/' + b.dataset.id);
        UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let v = { unit: '件' };
    if (id) v = (await API.get('/api/products/' + id)).data;
    const fields = [
      { name: 'code', label: '产品编码', required: true, value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'category', label: '分类', value: v.category },
      { name: 'spec', label: '规格', value: v.spec },
      { name: 'unit', label: '单位', value: v.unit },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑产品' : '新增产品', fields, onSubmit: async (val) => {
      if (id) await API.put('/api/products/' + id, val);
      else await API.post('/api/products', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  }
};
