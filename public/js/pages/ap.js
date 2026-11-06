'use strict';

window.Pages = window.Pages || {};

Pages.ap = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [list, sum, invs] = await Promise.all([
      API.get('/api/ap'),
      API.get('/api/ap/summary/by-supplier'),
      API.get('/api/ap/purchase-invoices')
    ]);
    this.draw(view, list.data || [], sum.data || [], invs.data || []);
  },

  draw(view, rows, summary, invs) {
    const apTable = UI.table([
      { key: 'ap_no', label: '应付单号' },
      { key: 'po_no', label: '采购单' },
      { key: 'supplier_name', label: '供应商', render: r => `<b>${UI.esc(r.supplier_name || '')}</b>` },
      { key: 'amount', label: '应付金额', render: r => fmtMoney(r.amount) },
      { key: 'paid', label: '已付', render: r => fmtMoney(r.paid) },
      { key: 'balance', label: '未付', render: r => `<b style="color:${r.balance > 0 ? '#c0392b' : '#2e7d32'}">${fmtMoney(r.balance)}</b>` },
      { key: 'status', label: '状态', render: r => UI.esc(r.status) },
      { label: '操作', render: r => `<button class="btn btn-xs" data-action="payment" data-id="${r.id}" ${r.balance <= 0 ? 'disabled' : ''}>+ 付款</button>` }
    ], rows);

    const sumTable = UI.table([
      { key: 'supplier_name', label: '供应商', render: r => UI.esc(r.supplier_name || '') },
      { key: 'total_ap', label: '应付合计', render: r => fmtMoney(r.total_ap) },
      { key: 'total_paid', label: '已付合计', render: r => fmtMoney(r.total_paid) },
      { key: 'balance', label: '未付余额', render: r => `<b style="color:${r.balance > 0 ? '#c0392b' : '#2e7d32'}">${fmtMoney(r.balance)}</b>` }
    ], summary);

    const invTable = UI.table([
      { key: 'pi_no', label: '登记号' },
      { key: 'po_no', label: '采购单' },
      { key: 'invoice_no', label: '发票号', render: r => UI.esc(r.invoice_no || '-') },
      { key: 'invoice_amount', label: '发票金额', render: r => fmtMoney(r.invoice_amount) },
      { key: 'invoice_qty', label: '发票数量', render: r => r.invoice_qty != null ? r.invoice_qty : '-' },
      { key: 'match_status', label: '三单匹配', render: r => r.match_status === 'matched' ? '<span class="badge badge-completed">一致</span>' : '<span class="badge badge-low">差异</span>' },
      { key: 'match_note', label: '说明', render: r => `<span class="sub">${UI.esc(r.match_note || '')}</span>` }
    ], invs);

    view.innerHTML = `
      <div class="page-head">
        <h2>应付管理</h2><span class="sub">采购到货自动生成应付单；采购发票做 PO/入库/发票三单匹配（P13 资金流闭环）</span>
        <button class="btn btn-primary" data-action="add-invoice" style="margin-left:auto">+ 登记采购发票</button>
      </div>
      <div class="card"><h3>按供应商应付余额</h3>${sumTable}</div>
      <div class="card"><h3>应付单明细</h3>${apTable}</div>
      <div class="card"><h3>采购发票 · 三单匹配</h3>${invTable}</div>`;
    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'payment') return this.openPayment(view, id);
    if (a === 'add-invoice') return this.openInvoice(view);
  },

  async openPayment(view, id) {
    const cur = (await API.get('/api/ap/' + id)).data;
    const pos = (await API.get('/api/purchase-orders')).data || [];
    const poOpts = [{ value: '', label: '（不关联）' }].concat(
      pos.map(p => ({ value: String(p.id), label: p.po_no + (p.supplier_name ? ' · ' + p.supplier_name : '') }))
    );
    const fields = [
      { name: 'amount', label: '付款金额', type: 'number', required: true, value: cur.balance, hint: '未付余额 ' + fmtMoney(cur.balance) },
      { name: 'paid_at', label: '付款日期', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
      { name: 'applied_po_id', label: '关联采购单（选源单，可选）', type: 'select', options: poOpts, value: cur.po_id ? String(cur.po_id) : '' },
      { name: 'remark', label: '备注', value: '' }
    ];
    await UI.formModal({
      title: '登记付款 · ' + cur.ap_no,
      fields,
      onSubmit: async (val) => {
        await API.post('/api/ap/' + id + '/payment', val);
        UI.toast('已登记付款', 'success');
        this.render(view);
      }
    });
  },

  async openInvoice(view) {
    // 拉取可登记的采购单（已到货才有意义，这里列出全部）
    const pos = (await API.get('/api/purchase-orders')).data || [];
    const opts = pos.map(p => ({ value: String(p.id), label: p.po_no + (p.supplier_name ? ' · ' + p.supplier_name : '') }));
    const fields = [
      { name: 'po_id', label: '采购单', type: 'select', required: true, options: opts },
      { name: 'invoice_no', label: '发票号', value: '' },
      { name: 'invoice_date', label: '发票日期', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'invoice_amount', label: '发票金额', type: 'number', required: true, hint: '与采购单金额比对' },
      { name: 'invoice_qty', label: '发票数量', type: 'number', hint: '可选，与采购单数量比对' },
      { name: 'remark', label: '备注', value: '' }
    ];
    await UI.formModal({
      title: '登记采购发票（三单匹配）',
      fields,
      onSubmit: async (val) => {
        await API.post('/api/ap/purchase-invoices', val);
        UI.toast('已登记，系统自动比对 PO/入库单', 'success');
        this.render(view);
      }
    });
  }
};
