'use strict';

window.Pages = window.Pages || {};

Pages['boms'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/boms');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'bom_no', label: 'BOM 编号' },
      { key: 'product_code', label: '成品编码' },
      { key: 'product_name', label: '成品名称', render: r => UI.esc(r.product_name || '') + (r.unit ? ` <span class="muted">(${UI.esc(r.unit)})</span>` : '') },
      { key: 'item_count', label: '物料行', num: true },
      { key: 'status', label: '状态' },
      { key: '_act', label: '操作', render: (r) => `
        <button class="btn-sm" data-action="view" data-id="${r.id}">查看/编辑</button>
        <button class="btn-sm danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>工程 BOM</h2>
        <button class="btn" data-action="add">+ 新建 BOM</button>
      </div>
      <p class="muted">单版本 BOM（不做版本管理）。损耗率默认 3%（SRS 验收1）。</p>
      ${table}
    `;

    view.querySelectorAll('[data-action=add]').forEach(b => b.onclick = () => this.openEdit(view, null));
    view.querySelectorAll('[data-action=view]').forEach(b => b.onclick = () => this.openEdit(view, b.dataset.id));
    view.querySelectorAll('[data-action=del]').forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该 BOM？')) return;
      try { await API.del('/api/boms/' + b.dataset.id); UI.toast('已删除', 'success'); this.render(view); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  },

  async openEdit(view, id) {
    let bom = { status: '已审核', items: [] };
    let products = [], materials = [];
    if (id) {
      const res = await API.get('/api/boms/' + id);
      bom = res.data.bom;
      bom.items = res.data.items;
    }
    [products, materials] = await Promise.all([
      API.get('/api/products'),
      API.get('/api/materials')
    ]);
    const prodOpts = products.data.map(p => ({ value: String(p.id), label: `[${UI.esc(p.code)}] ${UI.esc(p.name)}` }));
    const matOpts = materials.data.map(m => ({ value: String(m.id), label: `[${UI.esc(m.code)}] ${UI.esc(m.name)} (${UI.esc(m.unit)})` }));

    const fields = [
      { name: 'product_id', label: '成品', type: 'select', required: true,
        options: [{ value: '', label: '— 选择成品 —' }].concat(prodOpts), value: id ? String(bom.product_id) : '' },
      { name: 'bom_no', label: 'BOM 编号', value: bom.bom_no || '' },
      { name: 'status', label: '状态', type: 'select', options: [{ value: '草稿', label: '草稿' }, { value: '已审核', label: '已审核' }], value: bom.status || '已审核' },
      { name: 'remark', label: '备注', type: 'textarea', value: bom.remark || '' }
    ];

    await UI.formModal({
      title: id ? '编辑 BOM' : '新建 BOM',
      submitText: '保存',
      fields,
      // 物料行用自定义区块
      extraHTML: `
        <div class="bom-items">
          <div class="bom-items-head">
            <span>物料清单</span>
            <button type="button" class="btn-sm" id="addItem">+ 加一行</button>
          </div>
          <div id="itemRows"></div>
          <div class="muted" id="emptyHint">暂未添加物料行</div>
        </div>`,
      onSubmit: async (v) => {
        const items = collectItems();
        const payload = { ...v, items };
        if (id) payload.id = Number(id);
        try {
          await API.post('/api/boms' + (id ? '/' + id : ''), id ? Object.assign(payload, { _method: 'POST' }) : payload);
          // 后端 POST 同时处理新建/更新（id 在 payload 里）
          UI.toast('已保存', 'success');
          this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      },
      onMount: () => this.mountItemEditor(view, bom.items, matOpts)
    });
  },

  mountItemEditor(view, items, matOpts) {
    const rows = document.getElementById('itemRows');
    const hint = document.getElementById('emptyHint');
    const addBtn = document.getElementById('addItem');
    const renderRow = (it) => {
      const div = document.createElement('div');
      div.className = 'bom-item-row';
      div.innerHTML = `
        <select class="bi-material">${matOpts.map(o => `<option value="${o.value}" ${it && String(it.material_id) === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
        <input class="bi-qty" type="number" step="any" placeholder="单耗" value="${it ? it.qty_per : ''}">
        <input class="bi-loss" type="number" step="any" placeholder="损耗率" value="${it ? it.loss_rate : 0.03}">
        <button type="button" class="btn-sm danger bi-del">×</button>`;
      div.querySelector('.bi-del').onclick = () => { div.remove(); toggleHint(); };
      rows.appendChild(div);
      toggleHint();
    };
    const toggleHint = () => { hint.style.display = rows.children.length ? 'none' : 'block'; };
    addBtn.onclick = () => renderRow(null);
    (items || []).forEach(renderRow);
    toggleHint();
    window.__collectBomItems = () => {
      return Array.from(rows.children).map(div => ({
        material_id: Number(div.querySelector('.bi-material').value),
        qty_per: Number(div.querySelector('.bi-qty').value),
        loss_rate: Number(div.querySelector('.bi-loss').value)
      })).filter(x => x.material_id && x.qty_per > 0);
    };
  }
};

function collectItems() { return window.__collectBomItems ? window.__collectBomItems() : []; }
