'use strict';

window.Pages = window.Pages || {};

Pages.ar = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [list, sum] = await Promise.all([
      API.get('/api/ar'),
      API.get('/api/ar/summary/by-customer')
    ]);
    this.draw(view, list.data || [], sum.data || []);
  },

  draw(view, rows, summary) {
    const table = UI.table([
      { key: 'ar_no', label: '应收单号' },
      { key: 'so_no', label: '销售单' },
      { key: 'customer_name', label: '客户', render: r => `<b>${UI.esc(r.customer_name || '')}</b>` },
      { key: 'amount', label: '应收金额', render: r => fmtMoney(r.amount) },
      { key: 'received', label: '已收', render: r => fmtMoney(r.received) },
      { key: 'balance', label: '未收', render: r => `<b style="color:${r.balance > 0 ? '#c0392b' : '#2e7d32'}">${fmtMoney(r.balance)}</b>` },
      { key: 'status', label: '状态', render: r => UI.esc(r.status) },
      { label: '操作', render: r => `<button class="btn btn-xs" data-action="receipt" data-id="${r.id}" ${r.balance <= 0 ? 'disabled' : ''}>+ 收款</button>` }
    ], rows);

    const sumTable = UI.table([
      { key: 'customer_name', label: '客户', render: r => UI.esc(r.customer_name || '') },
      { key: 'total_ar', label: '应收合计', render: r => fmtMoney(r.total_ar) },
      { key: 'total_received', label: '已收合计', render: r => fmtMoney(r.total_received) },
      { key: 'balance', label: '未收余额', render: r => `<b style="color:${r.balance > 0 ? '#c0392b' : '#2e7d32'}">${fmtMoney(r.balance)}</b>` }
    ], summary);

    view.innerHTML = `
      <div class="page-head">
        <h2>应收管理</h2><span class="sub">销售发货自动生成应收单，登记收款冲减（P13 资金流闭环）</span>
      </div>
      <div class="card"><h3>按客户应收余额</h3>${sumTable}</div>
      <div class="card"><h3>应收单明细</h3>${table}</div>`;
    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'receipt') return this.openReceipt(view, id);
  },

  async openReceipt(view, id) {
    const cur = (await API.get('/api/ar/' + id)).data;
    const sos = (await API.get('/api/sales-orders')).data || [];
    const soOpts = [{ value: '', label: '（不关联）' }].concat(
      sos.map(o => ({ value: String(o.id), label: o.so_no + (o.customer_name ? ' · ' + o.customer_name : '') }))
    );
    const fields = [
      { name: 'amount', label: '收款金额', type: 'number', required: true, value: cur.balance, hint: '未收余额 ' + fmtMoney(cur.balance) },
      { name: 'paid_at', label: '收款日期', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
      { name: 'applied_so_id', label: '关联销售单（选源单，可选）', type: 'select', options: soOpts, value: cur.so_id ? String(cur.so_id) : '' },
      { name: 'remark', label: '备注', value: '' }
    ];
    await UI.formModal({
      title: '登记收款 · ' + cur.ar_no,
      fields,
      onSubmit: async (val) => {
        await API.post('/api/ar/' + id + '/receipt', val);
        UI.toast('已登记收款', 'success');
        this.render(view);
      }
    });
  }
};
