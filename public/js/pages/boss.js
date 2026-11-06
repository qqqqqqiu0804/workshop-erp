'use strict';

window.Pages = window.Pages || {};

// 老板手机只读端：只读驾驶舱。2026-09-09 精细化改造（口径见 docs/老板驾驶舱改造口径说明.md）：
// - 收入/支出改用后端聚合（/api/finance/summary），删除前端对流水逐行二次累加的技术债
// - 「净额」→「余额」；删除「净占用」卡（需求 6/8）
// - 新增：计划达成率（成品口径，绿/红）、年度/月度对比、每日趋势（内联 SVG）、
//         合格率（分母=完工数）、白/夜班、库存物资（成品/原料/刀具/半成品）、零库存标红、交期预警
// - 库存预警卡保留（断料停产 P0 风险），交期预警为新增不替换
// - 仍只读无写：本页不出现任何 API 写调用
Pages['boss'] = {
  money(n) { return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },

  // 对比徽标：涨绿跌红（产量/收入上涨是好事）
  diffBadge(cur, prev) {
    cur = Number(cur) || 0; prev = Number(prev) || 0;
    if (prev <= 0) return '';
    const pct = ((cur - prev) / prev) * 100;
    if (!isFinite(pct)) return '';
    const cls = pct >= 0 ? 'diff-up' : 'diff-down';
    const arrow = pct >= 0 ? '↑' : '↓';
    return ` <span class="${cls}" style="font-size:13px">${arrow}${Math.abs(pct).toFixed(1)}%</span>`;
  },

  // 阶段2 下钻：产量明细展开/收起（按员工 / 机台 / 产品，区间 = 所选月份）
  localYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  async toggleProdDetail(view) {
    const box = view.querySelector('#bs-detail');
    const btn = view.querySelector('#bs-detail-btn');
    if (!box) return;
    if (box.style.display !== 'none') {
      box.style.display = 'none'; box.innerHTML = '';
      if (btn) btn.textContent = '产量明细 ▾';
      return;
    }
    box.style.display = '';
    box.innerHTML = UI.spinner();
    const ym = this.filterYm || this.localYm();
    const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayStr = fmt(new Date());
    const to = (ym === todayStr.slice(0, 7)) ? todayStr : fmt(new Date(y, m, 0));
    const r = await API.get(`/api/stats/production?from=${ym}-01&to=${to}`);
    if (r.error) { box.innerHTML = `<p class="muted">${UI.esc(r.error)}</p>`; return; }
    const d = r.data || {};
    if (btn) btn.textContent = '收起明细 ▴';
    box.innerHTML = `
      <div class="card"><div class="card-title">产量明细（${ym}-01 ~ ${to}，成品口径）</div>
        <p style="margin:4px 0"><b>按员工</b></p>
        ${UI.table([{ key: 'employee', label: '员工' }, { key: 'emp_no', label: '工号' }, { key: 'total', label: '产量', num: true }], d.byEmployee || [])}
        <p style="margin:10px 0 4px"><b>按机台</b></p>
        ${UI.table([{ key: 'machine_number', label: '机台' }, { key: 'machine_name', label: '名称' }, { key: 'team_name', label: '班组' }, { key: 'total', label: '产量', num: true }], d.byMachine || [])}
        <p style="margin:10px 0 4px"><b>按产品</b></p>
        ${UI.table([{ key: 'code', label: '图号' }, { key: 'product', label: '产品' }, { key: 'unit', label: '单位' }, { key: 'total', label: '产量', num: true }], d.byProduct || [])}
      </div>`;
  },

  async render(view) {
    view.innerHTML = UI.spinner();
    try {
      const ym = this.filterYm || '';   // 阶段2 筛选：空 = 当月
      const [sum, cockpit, mats, finSum, arSum, apSum, snaps] = await Promise.all([
        API.get('/api/stats/summary'),
        API.get('/api/stats/cockpit' + (ym ? '?month=' + ym : '')),
        API.get('/api/materials'),
        API.get('/api/finance/summary'),
        API.get('/api/ar/summary/by-customer'),
        API.get('/api/ap/summary/by-supplier'),
        API.get('/api/stats/cockpit/snapshots')
      ]);
      const s = sum.data;
      const c = cockpit.data;
      const monthly = await API.get('/api/stats/production');
      const prodMonthly = (monthly.data.monthly || []).slice(-6);
      const low = (mats.data || []).filter(m => m.is_low);
      const income = Number(finSum.data.ledger_income || 0);
      const expense = Number(finSum.data.ledger_expense || 0);
      const arRows = (arSum.data || []).filter(r => Number(r.balance) > 0.005);
      const apRows = (apSum.data || []).filter(r => Number(r.balance) > 0.005);
      const arBalance = arRows.reduce((a, r) => a + Number(r.balance || 0), 0);
      const apBalance = apRows.reduce((a, r) => a + Number(r.balance || 0), 0);

      const stat = (k, v, cls) => `<div class="stat-card"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`;
      const cmp = c.comparison || {};
      const plan = c.plan || {};
      const q = c.quality || {};
      const del = c.delivery || {};
      const inv = c.inventory || {};
      const wipTotal = (c.wip || []).reduce((a, x) => a + Number(x.qty || 0), 0);
      const shiftMap = {};
      (c.shifts || []).forEach(x => { shiftMap[x.shift] = x.total; });
      const toolTotal = (inv.tool_stock || []).reduce((a, x) => a + Number(x.qty || 0), 0);
      const zeroCount = (inv.zero_stock || []).length;
      const topIncome = (c.funds.income_by_category || []).slice(0, 5);
      const topExpense = (c.funds.expense_by_category || []).slice(0, 5);

      // 阶段2 筛选器：近 6 个月快捷切换
      const monthOptions = (() => {
        const t = new Date(); const arr = [];
        for (let i = 0; i < 6; i++) {
          const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
          const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          arr.push(`<option value="${v}" ${v === ym ? 'selected' : ''}>${v}${i === 0 ? '（本月）' : ''}</option>`);
        }
        return arr.join('');
      })();

      // 计划达成率颜色：≥100% 绿，<100% 红；无计划显示灰
      const rateHtml = plan.rate == null
        ? '<span class="muted">本月无计划任务</span>'
        : `<span class="${plan.rate >= 100 ? 'diff-up' : 'diff-down'}" style="font-size:22px">${plan.rate}%</span>`;

      view.innerHTML = `
        <div class="page-head">
          <h2>老板驾驶舱</h2><span class="sub">只读视图 · 车间局域网访问（手机可直开）</span>
        </div>

        <div class="actions" style="margin-bottom:12px">
          <label class="muted" style="font-size:13px">统计月份：</label>
          <select class="select" id="bs-month" style="max-width:160px">${monthOptions}</select>
          ${ym ? '<button class="btn" id="bs-clear">回到本月</button>' : ''}
        </div>

        <div class="stat-grid" style="margin-bottom:14px">
          ${stat('今日产量', s.today_production, 'primary')}
          ${stat('本月产量', s.month_production, 'accent')}
          ${stat('在职人数', s.active_employees, '')}
          ${stat('低于安全库存', s.low_stock, s.low_stock > 0 ? 'danger' : 'success')}
        </div>

        <div class="stat-grid" style="margin-bottom:14px">
          <div class="stat-card"><div class="k">计划达成率（成品口径${ym ? ' ｜ ' + ym : ' ｜ 本月'}）</div><div class="v">${rateHtml}</div>
            <div class="muted" style="font-size:12px">计划 ${this.money(plan.planned)} ｜ 实际 ${this.money(plan.actual)}</div>
            <div style="margin-top:6px"><button class="btn" id="bs-detail-btn" style="font-size:12px">产量明细 ▾</button></div></div>
          <div class="stat-card"><div class="k">合格率（分母=完工数）</div>
            <div class="v ${q.pass_rate_month != null && q.pass_rate_month < 98 ? 'danger' : 'success'}">${q.pass_rate_month != null ? q.pass_rate_month + '%' : '—'}</div>
            <div class="muted" style="font-size:12px">本月不良 ${this.money(q.ng_month)} ｜ 累计合格率 ${q.pass_rate_all != null ? q.pass_rate_all + '%' : '—'}</div></div>
          <div class="stat-card"><div class="k">年度产量对比（今年 vs 去年）</div>
            <div class="v">${this.money(cmp.year ? cmp.year.this : 0)}</div>
            <div class="muted" style="font-size:12px">去年全年 ${this.money(cmp.year ? cmp.year.last : 0)} ${this.diffBadge(cmp.year ? cmp.year.this : 0, cmp.year ? cmp.year.last : 0)}</div></div>
          <div class="stat-card"><div class="k">月度产量对比（本月 vs 上月）</div>
            <div class="v">${this.money(cmp.month ? cmp.month.this : 0)}</div>
            <div class="muted" style="font-size:12px">上月 ${this.money(cmp.month ? cmp.month.last : 0)} ${this.diffBadge(cmp.month ? cmp.month.this : 0, cmp.month ? cmp.month.last : 0)}</div></div>
        </div>

        <div class="card">
          <div class="card-title">月度产量趋势（近 6 个月）</div>
          ${prodMonthly.length ? UI.barChart(prodMonthly.map(m => ({ label: m.month, value: m.total }))) : '<div class="empty">暂无数据</div>'}
        </div>

        <div class="card">
          <div class="card-title">每日产量趋势（近 30 天，成品口径）</div>
          ${UI.lineChart((c.dailyTrend || []).map(d => ({ label: d.date.slice(5), value: d.total })))}
        </div>

        <div class="card">
          <div class="card-title">今日班次产量（白班 08:00–20:30 ｜ 夜班 20:00–08:00）</div>
          <div class="stat-grid" style="margin-bottom:0">
            ${stat('白班', shiftMap['白班'] != null ? this.money(shiftMap['白班']) : '—', 'primary')}
            ${stat('夜班', shiftMap['夜班'] != null ? this.money(shiftMap['夜班']) : '—', 'accent')}
            ${stat('未分班（历史数据）', shiftMap['未分班'] != null ? this.money(shiftMap['未分班']) : '—', '')}
          </div>
        </div>

        <div id="bs-detail" style="display:none"></div>

        <div class="card">
          <div class="card-title">库存物资（成品 / 半成品 / 原料 / 刀具）</div>
          <div class="stat-grid" style="margin-bottom:0">
            ${stat('成品库存', this.money(inv.fg_total_qty), 'primary')}
            ${stat('半成品（在制）', this.money(wipTotal), wipTotal > 0 ? 'accent' : '')}
            ${stat('刀具库存', toolTotal !== 0 ? this.money(toolTotal) : '未建立分类', toolTotal === 0 ? '' : '')}
            ${stat('零库存物料', zeroCount + ' 项', zeroCount > 0 ? 'danger' : 'success')}
          </div>
          ${(c.wip && c.wip.length) ? `<p class="muted" style="font-size:12px;margin:6px 0 0">在制明细：${c.wip.slice(0, 8).map(x => UI.esc(x.product || x.code) + ' ' + this.money(x.qty)).join(' ｜ ')}</p>` : ''}
        </div>

        <div class="card">
          <div class="card-title">库存预警（${low.length} 项低于安全库存；数字为 0 已标红）</div>
          ${low.length ? UI.table(
            [{ key: 'code', label: '编码' }, { key: 'name', label: '名称' },
             { key: 'current_stock', label: '当前', num: true, render: x => `<span class="${Number(x.current_stock) === 0 ? 'num-zero' : ''}">${x.current_stock}</span>` },
             { key: 'safety_stock', label: '安全线', num: true }],
            low
          ) : '<div class="empty">库存均在安全线以上</div>'}
        </div>

        <div class="card">
          <div class="card-title">订单情况（交期预警：超期红 / 7 天内临近橙 / 采购估算灰）</div>
          ${(del.overdue_sales || []).length || (del.upcoming_sales || []).length || (del.upcoming_purchase || []).length
            ? `<p style="margin:4px 0"><b>客户订单未交货</b></p>
               ${(del.overdue_sales || []).length ? UI.table(
                 [{ key: 'customer', label: '客户' }, { key: 'due_date', label: '交期' }, { key: 'undelivered', label: '未交量', num: true }],
                 del.overdue_sales.map(x => ({ ...x, customer: `<span style="color:var(--danger)">${UI.esc(x.customer || '')}（已超期）</span>` }))
               ) : '<div class="empty">无超期订单</div>'}
               ${(del.upcoming_sales || []).length ? UI.table(
                 [{ key: 'customer', label: '客户' }, { key: 'due_date', label: '交期' }, { key: 'undelivered', label: '未交量', num: true }],
                 del.upcoming_sales.map(x => ({ ...x, customer: `<span style="color:var(--warn)">${UI.esc(x.customer || '')}（临近）</span>` }))
               ) : ''}
               <p style="margin:10px 0 4px"><b>供应商订单未到货</b></p>
               ${(del.upcoming_purchase || []).length ? UI.table(
                 [{ key: 'supplier', label: '供应商' }, { key: 'expect_date', label: '预计到货' }, { key: 'unreceived', label: '未到量', num: true }],
                 del.upcoming_purchase.map(x => ({ ...x, supplier: `${UI.esc(x.supplier || '')}${x.estimated ? ' <span class="muted">（估算）</span>' : ''}` }))
               ) : '<div class="empty">7 天内无应到货订单</div>'}`
            : '<div class="empty">暂无待交付 / 待到货订单</div>'}
        </div>

        <div class="stat-grid" style="margin-bottom:14px">
          ${stat('收入合计', this.money(income), 'success')}
          ${stat('支出合计', this.money(expense), 'danger')}
          ${stat('余额（收入 − 支出）', this.money(income - expense), 'primary')}
        </div>

        <div class="card">
          <div class="card-title">钱从哪来 / 花到哪去（按类别）</div>
          ${(topIncome.length || topExpense.length) ? `
            ${topIncome.length ? `<p style="margin:4px 0"><b>收入来源</b></p>${UI.table(
              [{ key: 'category', label: '类别' }, { key: 'total', label: '金额', num: true }], topIncome)}` : ''}
            ${topExpense.length ? `<p style="margin:10px 0 4px"><b>支出去向</b></p>${UI.table(
              [{ key: 'category', label: '类别' }, { key: 'total', label: '金额', num: true }], topExpense)}` : ''}`
            : '<div class="empty">暂无资金流水</div>'}
        </div>

        <div class="card">
          <div class="card-title">资金往来（应收 / 应付）</div>
          <div class="stat-grid" style="margin-bottom:10px">
            ${stat('应收未收', this.money(arBalance), arBalance > 0 ? 'danger' : 'success')}
            ${stat('应付未付', this.money(apBalance), apBalance > 0 ? 'danger' : 'success')}
          </div>
          ${arRows.length ? `<p style="margin:4px 0"><b>哪些客户未付款</b></p>${UI.table(
            [{ key: 'customer_name', label: '客户' },
             { key: 'total_ar', label: '应收合计', num: true },
             { key: 'total_received', label: '已收', num: true },
             { key: 'balance', label: '未收', num: true, render: x => `<span class="num-zero" style="color:var(--danger)">${this.money(x.balance)}</span>` }],
            arRows.slice(0, 10))}${arRows.length > 10 ? `<p class="muted" style="font-size:12px">仅显示前 10 位，完整明细见「资金往来」页</p>` : ''}` : '<div class="empty">无未收款客户</div>'}
          ${apRows.length ? `<p style="margin:10px 0 4px"><b>哪些供应商未付款</b></p>${UI.table(
            [{ key: 'supplier_name', label: '供应商' },
             { key: 'total_ap', label: '应付合计', num: true },
             { key: 'total_paid', label: '已付', num: true },
             { key: 'balance', label: '未付', num: true, render: x => `<span style="color:var(--danger)">${this.money(x.balance)}</span>` }],
            apRows.slice(0, 10))}${apRows.length > 10 ? `<p class="muted" style="font-size:12px">仅显示前 10 位，完整明细见「资金往来」页</p>` : ''}` : '<div class="empty">无未付款供应商</div>'}
        </div>

        ${(snaps.data && snaps.data.length) ? `<div class="card">
          <div class="card-title">历史快照（每月归档，数据长期有迹可循）</div>
          ${UI.table([
            { key: 'ym', label: '月份' },
            { key: 'p', label: '成品产量', num: true, render: x => this.money(x.m.production) },
            { key: 'r', label: '达成率', num: true, render: x => x.m.plan.rate == null ? '—' : x.m.plan.rate + '%' },
            { key: 'q', label: '合格率', num: true, render: x => x.m.quality.pass_rate == null ? '—' : x.m.quality.pass_rate + '%' },
            { key: 'bal', label: '资金余额（累计）', num: true, render: x => this.money(x.m.funds.balance) },
            { key: 'at', label: '归档时间' },
          ], snaps.data.slice(0, 12).map(s => ({ ym: s.ym, m: s.metrics, at: s.taken_at })))}
        </div>` : ''}

        <p class="muted no-print" style="text-align:center;font-size:12px">
          本页为只读汇总（不提供任何编辑），数据实时取自生产 / 库存 / 资金。产量口径 = 成品（末工序去重）。
        </p>`;

      // —— 阶段2：筛选器与下钻事件绑定 ——
      const mSel = view.querySelector('#bs-month');
      if (mSel) mSel.onchange = (e) => { this.filterYm = e.target.value; this.render(view); };
      const clearBtn = view.querySelector('#bs-clear');
      if (clearBtn) clearBtn.onclick = () => { this.filterYm = ''; this.render(view); };
      const dBtn = view.querySelector('#bs-detail-btn');
      if (dBtn) dBtn.onclick = () => this.toggleProdDetail(view);
    } catch (e) {
      view.innerHTML = `<div class="empty"><div class="big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>加载失败：${UI.esc(e.message)}</div>`;
    }
  }
};
