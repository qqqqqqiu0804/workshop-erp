'use strict';

window.Pages = window.Pages || {};

Pages['finance'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [orders, summary] = await Promise.all([
      API.get('/api/finance/orders'),
      API.get('/api/finance/summary')
    ]);
    this.draw(view, orders.data, summary.data);
  },

  draw(view, orders, summary) {
    const s = summary || {};
    const sumCards = `
      <div class="card stat"><div class="stat-label">订单总收入</div><div class="stat-val">¥${(s.total_revenue || 0).toFixed(2)}</div></div>
      <div class="card stat"><div class="stat-label">总成本(台账支出)</div><div class="stat-val">¥${(s.total_cost || 0).toFixed(2)}</div></div>
      <div class="card stat"><div class="stat-label">毛利</div><div class="stat-val">¥${(s.profit || 0).toFixed(2)}</div></div>
      <div class="card stat"><div class="stat-label">综合毛利率</div><div class="stat-val">${(s.gross_margin_pct || 0)}%</div></div>
    `;

    const marginColor = m => m >= 30 ? 'tag-green' : m >= 10 ? 'tag-yellow' : 'tag-red';

    const table = UI.table([
      { key: 'so_no', label: '订单号' },
      { key: 'customer_name', label: '客户', render: r => UI.esc(r.customer_name || '—') },
      { key: 'status', label: '状态' },
      { key: 'revenue', label: '订单收入', render: r => '¥' + Number(r.revenue || 0).toFixed(2) },
      { key: 'material_cost', label: '材料成本', render: r => '¥' + Number(r.material_cost || 0).toFixed(2) },
      { key: 'outsource_cost', label: '外发成本', render: r => '¥' + Number(r.outsource_cost || 0).toFixed(2) },
      { key: 'labor_cost', label: '人工成本', render: r => '¥' + Number(r.labor_cost || 0).toFixed(2) },
      { key: 'other_cost', label: '其他成本', render: r => '¥' + Number(r.other_cost || 0).toFixed(2) },
      { key: 'total_cost', label: '总成本', render: r => '¥' + Number(r.total_cost || 0).toFixed(2) },
      { key: 'profit', label: '毛利', render: r => '¥' + Number(r.profit || 0).toFixed(2) },
      { key: 'gross_margin_pct', label: '毛利率', render: r => `<span class="tag ${marginColor(r.gross_margin_pct)}">${r.gross_margin_pct}%</span>` },
    ], orders || []);

    view.innerHTML = `
      <div class="page-head">
        <h2>财务 / 成本核算</h2>
        <div class="actions">
          <button class="btn primary" id="btn-add-ledger">＋ 记一笔</button>
        </div>
      </div>
      <p class="muted">独立做账（验收6）：按订单分批核算成本 + 自动毛利率。收入取自销售订单签订金额，成本取自财务台账（材料/外发/人工/其他支出）。</p>
      <div class="stat-row">${sumCards}</div>
      <h3>按订单核算</h3>
      ${orders && orders.length ? table : '<p class="muted">暂无销售订单，先到「销售订单」开单。</p>'}
    `;

    view.querySelector('#btn-add-ledger')?.addEventListener('click', () => this.openLedger(view));
  },

  async openLedger(view) {
    const sos = (await API.get('/api/sales-orders')).data || [];
    const soOpts = [{ value: '', label: '（全厂 / 不直接归单）' }].concat(
      sos.map(o => ({ value: String(o.id), label: `${o.so_no} ${o.customer_name || ''}` }))
    );
    const fields = [
      { name: 'date', label: '记账日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'type', label: '类型', type: 'select', required: true, options: [{ value: '收入', label: '收入' }, { value: '支出', label: '支出' }], value: '支出' },
      { name: 'category', label: '类别', type: 'select', required: true, options: [{ value: '物料', label: '物料' }, { value: '外发', label: '外发' }, { value: '人工', label: '人工' }, { value: '其他', label: '其他' }], value: '物料' },
      { name: 'so_id', label: '关联订单', type: 'select', options: soOpts, value: '' },
      { name: 'amount', label: '金额', type: 'number', required: true, value: '' },
      { name: 'remark', label: '备注', value: '' }
    ];
    await UI.formModal({
      title: '记一笔（独立做账）',
      submitText: '保存',
      fields,
      onSubmit: async (v) => {
        v.amount = Number(v.amount);
        v.so_id = v.so_id ? Number(v.so_id) : null;
        try {
          await API.post('/api/finance', v);
          UI.toast('已记账', 'success');
          this.render(view);
        } catch (err) { UI.toast(err.message, 'error'); }
      }
    });
  }
};
