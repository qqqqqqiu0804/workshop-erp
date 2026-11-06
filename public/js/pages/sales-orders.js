'use strict';

window.Pages = window.Pages || {};

Pages['sales-orders'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/sales-orders');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const statusColor = s => ({
      '待发货': 'tag-gray', '部分发货': 'tag-yellow', '已发货': 'tag-green', '已取消': 'tag-red'
    }[s] || 'tag-gray');

    const table = UI.table([
      { key: 'so_no', label: '订单号' },
      { key: 'customer_name', label: '客户', render: r => UI.esc(r.customer_name || '') + (r.owner_role ? ` <span class="muted">[${UI.esc(r.owner_role)}]</span>` : '') },
      { key: 'total_qty', label: '数量', num: true },
      { key: 'total_delivered', label: '已发', num: true },
      { key: 'status', label: '状态', render: r => `<span class="tag ${statusColor(r.status)}">${UI.esc(r.status)}</span>` },
      { key: 'due_date', label: '交期' },
      { key: '_act', label: '操作', render: r => `
        <button class="btn-sm" data-action="view" data-id="${r.id}">详情/发货</button>
        ${r.status !== '已发货' && r.status !== '已取消' ? `<button class="btn-sm danger" data-action="cancel" data-id="${r.id}">取消</button>` : ''}` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>销售订单</h2>
        <button class="btn" data-action="add">+ 新建订单</button>
      </div>
      ${table}
    `;

    view.querySelectorAll('[data-action=add]').forEach(b => b.onclick = () => this.openEdit(view, null));
    view.querySelectorAll('[data-action=view]').forEach(b => b.onclick = () => this.openDetail(view, b.dataset.id));
    view.querySelectorAll('[data-action=cancel]').forEach(b => b.onclick = async () => {
      if (!confirm('确认取消该订单？')) return;
      try { await API.put('/api/sales-orders/' + b.dataset.id + '/cancel'); UI.toast('已取消', 'success'); this.render(view); }
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
      { name: 'due_date', label: '交期', type: 'date', value: '' },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];

    await UI.formModal({
      title: '新建销售订单',
      submitText: '保存',
      fields,
      extraHTML: `
        <div class="so-items">
          <div class="so-items-head"><span>订单产品</span><button type="button" class="btn-sm" id="addItem">+ 加一行</button></div>
          <div id="itemRows"></div>
          <div class="muted" id="emptyHint">暂未添加产品</div>
        </div>`,
      onSubmit: async (v) => {
        const items = collectSoItems();
        if (!items.length) { UI.toast('至少添加一行产品', 'error'); return; }
        try {
          await API.post('/api/sales-orders', { ...v, items });
          UI.toast('已创建', 'success');
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
        window.__collectSoItems = () => Array.from(rows.children).map(div => ({
          product_id: Number(div.querySelector('.si-product').value),
          qty: Number(div.querySelector('.si-qty').value),
          unit_price: div.querySelector('.si-price').value ? Number(div.querySelector('.si-price').value) : null
        })).filter(x => x.product_id && x.qty > 0);
      }
    });
  },

  async openDetail(view, id) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/sales-orders/' + id);
    const { so, items } = res.data;
    const itemRows = items.map(it => `
      <tr>
        <td>${UI.esc(it.product_code)}</td>
        <td>${UI.esc(it.product_name)}</td>
        <td class="num">${UI.esc(Number(it.qty))}</td>
        <td class="num">${UI.esc(Number(it.delivered_qty))}</td>
        <td class="num">${UI.esc(Number(it.qty) - Number(it.delivered_qty))}</td>
        <td><input type="number" step="any" class="dlv-qty" data-so-item="${it.id}" placeholder="发货量" min="0"></td>
      </tr>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h2>销售订单 ${UI.esc(so.so_no)}</h2>
        <button class="btn-sm" data-action="back">← 返回</button>
        ${so.status !== '已取消' ? `<button class="btn" data-action="plan">生成计划</button>` : ''}
        ${so.status !== '已发货' && so.status !== '已取消' ? `<button class="btn" data-action="deliver">确认发货</button>` : ''}
      </div>
      <p class="muted">客户：${UI.esc(so.customer_name || '')} ｜ 状态：<b>${UI.esc(so.status)}</b> ｜ 交期：${UI.esc(so.due_date || '—')}</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>产品编码</th><th>名称</th><th>数量</th><th>已发</th><th>未发</th><th>本次发货</th></tr></thead>
        <tbody>${itemRows || '<tr><td colspan="6" class="muted">无产品行</td></tr>'}</tbody>
      </table></div>
    `;

    view.querySelector('[data-action=back]').onclick = () => this.render(view);
    const planBtn = view.querySelector('[data-action=plan]');
    if (planBtn) planBtn.onclick = async () => {
      if (!confirm('根据此订单的 BOM 生成采购计划 + 自制任务单？\n（已生成过将直接返回现状）')) return;
      try {
        const r = await API.post('/api/sales-orders/' + id + '/plan');
        if (r.already_planned) {
          UI.toast(`该订单已编排：采购计划 ${r.purchase_plans} 条、自制任务单 ${r.production_tasks} 个`, 'info');
        } else {
          const tn = (r.task_nos || []).join('、');
          UI.toast(`已生成：采购计划 ${r.purchase_plans} 条、自制任务单 ${r.production_tasks} 个${tn ? '\n' + tn : ''}`, 'success');
        }
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
    const deliverBtn = view.querySelector('[data-action=deliver]');
    if (deliverBtn) deliverBtn.onclick = async () => {
      const lines = Array.from(view.querySelectorAll('.dlv-qty')).map(inp => ({
        so_item_id: Number(inp.dataset.soItem),
        qty: Number(inp.value)
      })).filter(x => x.qty > 0);
      if (!lines.length) { UI.toast('请填写发货量', 'error'); return; }
      try {
        await API.post('/api/sales-orders/' + id + '/deliver', { items: lines });
        UI.toast('已发货，库存已扣减', 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

function collectSoItems() { return window.__collectSoItems ? window.__collectSoItems() : []; }
