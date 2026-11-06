'use strict';

window.Pages = window.Pages || {};

Pages['quotations'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/quotations');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const statusColor = s => ({
      '草稿': 'tag-gray', '已发出': 'tag-blue', '已转单': 'tag-green', '已作废': 'tag-red'
    }[s] || 'tag-gray');

    const table = UI.table([
      { key: 'quotation_no', label: '报价单号' },
      { key: 'customer_name', label: '客户' },
      { key: 'total_qty', label: '数量', num: true },
      { key: 'total_amount', label: '金额', num: true, render: r => '¥' + Number(r.total_amount || 0).toFixed(2) },
      { key: 'valid_until', label: '有效期至' },
      { key: 'status', label: '状态', render: r => `<span class="tag ${statusColor(r.status)}">${UI.esc(r.status)}</span>` },
      { key: '_act', label: '操作', render: r => `
        <button class="btn-sm" data-action="view" data-id="${r.id}">详情</button>
        ${r.status === '草稿' || r.status === '已发出' ? `<button class="btn-sm" data-action="del" data-id="${r.id}">删</button>` : ''}` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>报价单</h2>
        <button class="btn" data-action="add">+ 新建报价单</button>
      </div>
      <p class="muted">报价单是销售前置：建好报价 → 客户确认后「一键转销售订单」。</p>
      ${table}
    `;

    view.querySelectorAll('[data-action=add]').forEach(b => b.onclick = () => this.openEdit(view, null));
    view.querySelectorAll('[data-action=view]').forEach(b => b.onclick = () => this.openDetail(view, b.dataset.id));
    view.querySelectorAll('[data-action=del]').forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该草稿报价单？')) return;
      try { await API.del('/api/quotations/' + b.dataset.id); UI.toast('已删除', 'success'); this.render(view); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  },

  async openEdit(view, id) {
    const [custs, prods] = await Promise.all([API.get('/api/customers'), API.get('/api/products')]);
    const custOpts = custs.data.map(c => ({ value: String(c.id), label: `${UI.esc(c.name)}${c.owner_role ? ' [' + UI.esc(c.owner_role) + ']' : ''}` }));
    const prodOpts = prods.data.map(p => ({ value: String(p.id), label: `[${UI.esc(p.code)}] ${UI.esc(p.name)}` }));

    const fields = [
      { name: 'customer_id', label: '客户', type: 'select', required: true,
        options: [{ value: '', label: '— 选择客户 —' }].concat(custOpts), value: '' },
      { name: 'valid_until', label: '有效期至', type: 'date', value: '' },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];

    await UI.formModal({
      title: '新建报价单',
      submitText: '保存',
      fields,
      extraHTML: `
        <div class="so-items">
          <div class="so-items-head"><span>报价产品</span><button type="button" class="btn-sm" id="addItem">+ 加一行</button></div>
          <div id="itemRows"></div>
          <div class="muted" id="emptyHint">暂未添加产品</div>
        </div>`,
      onSubmit: async (v) => {
        const items = collectQuoItems();
        if (!items.length) { UI.toast('至少添加一行产品', 'error'); return; }
        try {
          await API.post('/api/quotations', { ...v, items });
          UI.toast('已创建报价单', 'success');
          this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      },
      onMount: () => {
        const rows = document.getElementById('itemRows');
        const hint = document.getElementById('emptyHint');
        const addBtn = document.getElementById('addItem');
        const renderRow = () => {
          const div = document.createElement('div');
          div.className = 'so-item-row';
          div.innerHTML = `
            <select class="si-product">${prodOpts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
            <input class="si-qty" type="number" step="any" placeholder="数量">
            <input class="si-price" type="number" step="any" placeholder="单价">
            <button type="button" class="btn-sm danger si-del">×</button>`;
          div.querySelector('.si-del').onclick = () => { div.remove(); toggle(); };
          rows.appendChild(div); toggle();
        };
        const toggle = () => { hint.style.display = rows.children.length ? 'none' : 'block'; };
        addBtn.onclick = renderRow;
        window.__collectQuoItems = () => Array.from(rows.children).map(div => ({
          product_id: Number(div.querySelector('.si-product').value),
          qty: Number(div.querySelector('.si-qty').value),
          unit_price: div.querySelector('.si-price').value ? Number(div.querySelector('.si-price').value) : null
        })).filter(x => x.product_id && x.qty > 0);
      }
    });
  },

  async openDetail(view, id) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/quotations/' + id);
    const { q, items } = res.data;
    const itemRows = items.map(it => `
      <tr>
        <td>${UI.esc(it.product_code || '')}</td>
        <td>${UI.esc(it.product_name || '')}</td>
        <td class="num">${UI.esc(Number(it.qty))}</td>
        <td class="num">${it.unit_price != null ? '¥' + Number(it.unit_price).toFixed(2) : '—'}</td>
        <td class="num">${it.unit_price != null ? '¥' + (Number(it.qty) * Number(it.unit_price)).toFixed(2) : '—'}</td>
      </tr>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h2>报价单 ${UI.esc(q.quotation_no)}</h2>
        <button class="btn-sm" data-action="back">← 返回</button>
        ${(q.status === '草稿' || q.status === '已发出') ? `<button class="btn" data-action="convert">⇨ 转销售订单</button>` : ''}
      </div>
      <p class="muted">客户：${UI.esc(q.customer_name || '')} ｜ 状态：<b>${UI.esc(q.status)}</b> ｜ 有效期：${UI.esc(q.valid_until || '—')}${q.so_id ? ' ｜ 已转 SO#' + UI.esc(q.so_id) : ''}</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>产品编码</th><th>名称</th><th>数量</th><th>单价</th><th>小计</th></tr></thead>
        <tbody>${itemRows || '<tr><td colspan="5" class="muted">无产品行</td></tr>'}</tbody>
      </table></div>
    `;

    view.querySelector('[data-action=back]').onclick = () => this.render(view);
    const convBtn = view.querySelector('[data-action=convert]');
    if (convBtn) convBtn.onclick = async () => {
      if (!confirm('确认将该报价单转为销售订单？\n（生成销售订单并标记本报价单为「已转单」）')) return;
      try {
        const r = await API.post('/api/quotations/' + id + '/convert');
        UI.toast('已转销售订单 #' + r.data.so_no, 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

function collectQuoItems() { return window.__collectQuoItems ? window.__collectQuoItems() : []; }
