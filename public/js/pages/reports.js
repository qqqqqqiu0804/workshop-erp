'use strict';

window.Pages = window.Pages || {};

Pages['reports'] = {
  type: 'production',          // 当前报表类型
  dim: 'product',              // 产量报表维度
  _csv: null,                  // 当前可导出的 CSV 数据集

  async render(view) {
    const tabs = [
      { k: 'production', label: '生产产量' },
      { k: 'inventory', label: '库存现状' },
      { k: 'purchase', label: '采购汇总' },
      { k: 'sales', label: '销售汇总' },
      { k: 'finance', label: '财务概览' }
    ];
    view.innerHTML = `
      <div class="page-head">
        <h2>报表中心</h2><span class="sub">生产 / 库存 / 进销存 / 财务（P8）</span>
      </div>
      <div class="card tab-bar">
        ${tabs.map(t => `<button class="btn btn-sm ${t.k === this.type ? 'btn-primary' : ''}" data-tab="${t.k}">${t.label}</button>`).join('')}
      </div>
      <div id="repBody"><div class="empty">加载中…</div></div>`;

    view.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => { this.type = b.dataset.tab; this.render(view); };
    });
    await this.loadReport(view);
  },

  async loadReport(view) {
    const body = view.querySelector('#repBody');
    body.innerHTML = UI.spinner();
    try {
      if (this.type === 'production') return await this.drawProduction(view, body);
      if (this.type === 'inventory') return await this.drawInventory(view, body);
      if (this.type === 'purchase') return await this.drawPurchase(view, body);
      if (this.type === 'sales') return await this.drawSales(view, body);
      if (this.type === 'finance') return await this.drawFinance(view, body);
    } catch (e) {
      body.innerHTML = `<div class="empty"><div class="big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>${UI.esc(e.message)}</div>`;
    }
  },

  // 通用：过滤栏 + 结果渲染
  toolbar(view, body, inner, onQuery) {
    body.innerHTML = `
      <div class="toolbar no-print">
        ${inner}
        <button class="btn btn-primary" data-act="query">查询</button>
        <div class="spacer"></div>
        <button class="btn" data-act="csv">导出 CSV</button>
        <button class="btn" data-act="print">打印</button>
      </div>
      <div id="repResult"></div>`;
    body.querySelector('[data-act=query]').onclick = onQuery;
    body.querySelector('[data-act=csv]').onclick = () => {
      if (!this._csv) { UI.toast('暂无可导出的数据', 'error'); return; }
      UI.downloadCSV(this._csv.filename, this._csv.headers, this._csv.rows);
      UI.toast('已导出 CSV', 'success');
    };
    body.querySelector('[data-act=print]').onclick = () => window.print();
  },

  // ---------- 生产产量 ----------
  async drawProduction(view, body) {
    const dims = [
      { k: 'product', label: '按产品' }, { k: 'machine', label: '按机台' },
      { k: 'team', label: '按工序组' }, { k: 'employee', label: '按员工' }, { k: 'monthly', label: '按月度' }
    ];
    const wsOpts = `<option value="">全部车间</option><option value="auto">自动车</option><option value="swiss">走心机</option>`;
    const today = DateUtil.today();
    const monthStart = today.slice(0, 7) + '-01';
    this.toolbar(view, body, `
      <select class="select w-auto" id="rDim">${dims.map(d => `<option value="${d.k}" ${d.k === this.dim ? 'selected' : ''}>${d.label}</option>`).join('')}</select>
      <label class="field m-0"><span>起始</span><input class="input w-auto" id="rFrom" type="date" value="${monthStart}"></label>
      <label class="field m-0"><span>截止</span><input class="input w-auto" id="rTo" type="date" value="${today}"></label>
      <select class="select w-auto" id="rWs">${wsOpts}</select>
    `, () => this.drawProduction(view, body));

    const from = body.querySelector('#rFrom').value;
    const to = body.querySelector('#rTo').value;
    const ws = body.querySelector('#rWs').value;
    this.dim = body.querySelector('#rDim').value;
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (ws) q.set('workshop', ws);
    const { data } = await API.get('/api/stats/production?' + q.toString());
    const res = body.querySelector('#repResult');

    let headers, rows, title, chartItems;
    if (this.dim === 'machine') {
      title = '按机台产量';
      headers = [{ key: 'machine_number', label: '机台号' }, { key: 'machine_name', label: '机台名' }, { key: 'team_name', label: '工序组' }, { key: 'total', label: '产量', num: true }];
      rows = data.byMachine; chartItems = data.byMachine.map(r => ({ label: r.machine_name || ('机台' + r.machine_number), value: r.total }));
    } else if (this.dim === 'team') {
      title = '按工序组产量';
      headers = [{ key: 'team', label: '工序组' }, { key: 'total', label: '产量', num: true }];
      rows = data.byTeam; chartItems = data.byTeam.map(r => ({ label: r.team, value: r.total }));
    } else if (this.dim === 'employee') {
      title = '按员工产量';
      headers = [{ key: 'employee', label: '员工' }, { key: 'emp_no', label: '工号' }, { key: 'total', label: '产量', num: true }];
      rows = data.byEmployee; chartItems = data.byEmployee.map(r => ({ label: r.employee, value: r.total }));
    } else if (this.dim === 'monthly') {
      title = '月度产量';
      headers = [{ key: 'month', label: '月份' }, { key: 'total', label: '产量', num: true }];
      rows = data.monthly; chartItems = data.monthly.map(r => ({ label: r.month, value: r.total }));
    } else {
      title = '按产品产量';
      headers = [{ key: 'code', label: '产品编码' }, { key: 'product', label: '产品' }, { key: 'unit', label: '单位' }, { key: 'total', label: '产量', num: true }];
      rows = data.byProduct; chartItems = data.byProduct.map(r => ({ label: r.product || r.code, value: r.total }));
    }
    this._csv = { filename: `生产产量_${this.dim}_${from || ''}_${to || ''}`, headers, rows };

    const fname = `生产产量报表（${from || '起'} 至 ${to || '今'}${ws ? ' · ' + (ws === 'auto' ? '自动车' : '走心机') : ''}）`;
    res.innerHTML = `
      <div class="card"><div class="card-title">${fname}</div>
        <div class="row mb-10">
          <div class="stat-card grow"><div class="k">成品产量合计</div><div class="v primary">${data.totalFinished}</div></div>
          <div class="stat-card grow"><div class="k">工序加工量合计</div><div class="v accent">${data.totalProcessed}</div></div>
        </div>
        ${chartItems && chartItems.length ? UI.barChart(chartItems) : ''}
      </div>
      <div class="card"><div class="card-title">${title}</div>${UI.table(headers, rows)}</div>`;
  },

  // ---------- 库存现状 ----------
  async drawInventory(view, body) {
    this.toolbar(view, body, `<span class="muted">实时库存（含安全库存预警）</span>`, () => this.drawInventory(view, body));
    const { data } = await API.get('/api/materials');
    const rows = data;
    const headers = [
      { key: 'code', label: '物料编码' }, { key: 'name', label: '名称' }, { key: 'spec', label: '规格' },
      { key: 'unit', label: '单位' }, { key: 'current_stock', label: '当前库存', num: true },
      { key: 'safety_stock', label: '安全库存', num: true },
      { key: 'is_low', label: '状态', render: r => r.is_low ? '低于安全库存' : '正常' }
    ];
    this._csv = { filename: '库存现状_' + DateUtil.today(), headers, rows };
    body.querySelector('#repResult').innerHTML = `
      <div class="card"><div class="card-title">原料库存现状</div>
        ${UI.table(headers, rows.map(r => ({ ...r, is_low: r.is_low ? '低于安全库存' : '正常' })))}
        <p class="muted">当前库存为实时派生值（累计入库 − 累计出库），不含安全库存以下预警的冗余存储。</p>
      </div>`;
  },

  // ---------- 采购汇总 ----------
  async drawPurchase(view, body) {
    this.toolbar(view, body, `<span class="muted">采购订单汇总</span>`, () => this.drawPurchase(view, body));
    const { data } = await API.get('/api/purchase-orders');
    const rows = data;
    const headers = [
      { key: 'po_no', label: '采购单号' }, { key: 'supplier_name', label: '供应商' }, { key: 'status', label: '状态' },
      { key: 'order_date', label: '下单日期' }, { key: 'due_date', label: '到货日期' },
      { key: 'total_amount', label: '金额', num: true, render: r => r.total_amount || 0 },
      { key: 'received_total', label: '已到货量', num: true, render: r => r.received_total || 0 }
    ];
    this._csv = { filename: '采购汇总_' + DateUtil.today(), headers, rows };
    body.querySelector('#repResult').innerHTML = `
      <div class="card"><div class="card-title">采购订单汇总（共 ${rows.length} 单）</div>${UI.table(headers, rows)}</div>`;
  },

  // ---------- 销售汇总 ----------
  async drawSales(view, body) {
    this.toolbar(view, body, `<span class="muted">销售订单汇总</span>`, () => this.drawSales(view, body));
    const { data } = await API.get('/api/sales-orders');
    const rows = data;
    const headers = [
      { key: 'so_no', label: '销售单号' }, { key: 'customer_name', label: '客户' }, { key: 'status', label: '状态' },
      { key: 'owner_role', label: '跟单' }, { key: 'total_qty', label: '订单量', num: true },
      { key: 'total_delivered', label: '已发量', num: true }, { key: 'created_at', label: '创建时间' }
    ];
    this._csv = { filename: '销售汇总_' + DateUtil.today(), headers, rows };
    body.querySelector('#repResult').innerHTML = `
      <div class="card"><div class="card-title">销售订单汇总（共 ${rows.length} 单）</div>${UI.table(headers, rows)}</div>`;
  },

  // ---------- 财务概览 ----------
  async drawFinance(view, body) {
    this.toolbar(view, body, `<span class="muted">财务凭证概览</span>`, () => this.drawFinance(view, body));
    const { data } = await API.get('/api/finance');
    const rows = data;
    const income = rows.filter(r => r.type === '收入').reduce((s, r) => s + Number(r.amount || 0), 0);
    const expense = rows.filter(r => r.type === '支出').reduce((s, r) => s + Number(r.amount || 0), 0);
    const headers = [
      { key: 'voucher_no', label: '凭证号' }, { key: 'date', label: '日期' }, { key: 'type', label: '类型' },
      { key: 'category', label: '类别' }, { key: 'customer_name', label: '往来方' },
      { key: 'amount', label: '金额', num: true }, { key: 'remark', label: '备注' }
    ];
    this._csv = { filename: '财务概览_' + DateUtil.today(), headers, rows };
    body.querySelector('#repResult').innerHTML = `
      <div class="card"><div class="card-title">财务概览</div>
        <div class="row mb-10">
          <div class="stat-card grow"><div class="k">收入合计</div><div class="v success">${income.toFixed(2)}</div></div>
          <div class="stat-card grow"><div class="k">支出合计</div><div class="v danger">${expense.toFixed(2)}</div></div>
          <div class="stat-card grow"><div class="k">净额</div><div class="v primary">${(income - expense).toFixed(2)}</div></div>
        </div>
        ${UI.table(headers, rows)}
      </div>`;
  }
};
