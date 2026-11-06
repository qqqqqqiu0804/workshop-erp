'use strict';

/**
 * 会计模块页（M0 核心骨架）。
 * 最小闭环：开账 → 录期初 → 录凭证（借贷必相等）→ 审核 → 记账 → 试算平衡 → 关账。
 * 权限：后端读+写双门禁，仅 老板/管理；其余角色导航入口已隐藏、接口亦 403。
 *
 * 说明：期初/凭证的多行分录编辑器用 UI.showModal（自定义 HTML + 自接管保存按钮），
 * 因 UI.formModal 仅支持 select/textarea/input 三类控件，无法承载可增删的动态行。
 *
 * 注意：本文件会被 build-pages.js 顺序拼接进 pages.bundle.js，
 * 顶层（行首）禁止声明 const/let/function/class，避免与其它页面重名。
 */

window.Pages = window.Pages || {};

Pages['accounting'] = {
  accState: {
    periods: [],
    accounts: [],
    periodId: null,
    tab: 'vouchers',
    vouchers: [],
    balances: null,
  },

  money(n) {
    return Number(n || 0).toFixed(2);
  },

  periodLabel(p) {
    return `${p.year}-${String(p.month).padStart(2, '0')}${p.status === 'closed' ? '（已关账）' : ''}`;
  },

  currentPeriod() {
    return this.accState.periods.find(p => p.id === this.accState.periodId) || null;
  },

  detailOptions() {
    return this.accState.accounts.filter(a => a.is_detail === 1)
      .map(a => ({ value: a.code, label: `${a.code} ${a.name}${a.enable_qty ? '（数量）' : ''}` }));
  },

  async render(view) {
    view.innerHTML = UI.spinner();
    const [p, a] = await Promise.all([
      API.get('/api/accounting/periods'),
      API.get('/api/accounting/accounts'),
    ]);
    this.accState.periods = p.data || [];
    this.accState.accounts = a.data || [];
    const open = this.accState.periods.filter(x => x.status === 'open');
    const last = open.length ? open[open.length - 1] : (this.accState.periods[this.accState.periods.length - 1] || null);
    this.accState.periodId = last ? last.id : this.accState.periodId;
    await this.reloadTabData();
    this.draw(view);
  },

  async reloadTabData() {
    const pid = this.accState.periodId;
    if (!pid) return;
    const [v, b] = await Promise.all([
      API.get('/api/accounting/vouchers?period_id=' + pid),
      API.get('/api/accounting/balances/trial-balance?period_id=' + pid),
    ]);
    this.accState.vouchers = v.data || [];
    this.accState.balances = b.data ? { rows: b.data, totals: b.totals, balanced: b.balanced } : null;
  },

  draw(view) {
    const st = this.accState;
    const p = this.currentPeriod();
    const noPeriod = !p;

    view.innerHTML = `
      <div class="page-head">
        <h2>会计</h2>
        <div class="actions">
          <select id="acc-period" class="select">
            ${st.periods.map(x => `<option value="${x.id}" ${x.id === st.periodId ? 'selected' : ''}>${this.periodLabel(x)}</option>`).join('') || '<option value="">（无期间）</option>'}
          </select>
          <button class="btn" id="acc-new-period">＋ 开账</button>
          ${p && p.status !== 'closed' ? `<button class="btn" id="acc-carry">期末结转</button>` : ''}
          ${p ? `<button class="btn" id="acc-close">${p.status === 'closed' ? '反结账' : '关账'}</button>` : ''}
        </div>
      </div>
      <p class="muted">复式借贷记账：《小企业会计准则》科目体系 + 工厂特色明细（在制品 / 委外加工费 / 模具）。
        借贷必须相等才能保存；关账后该期不可再改，需反结账。余额与报表实时计算。</p>
      ${noPeriod ? '<p class="muted">尚无会计期间，请先「开账」。</p>' : `
      <div class="tabs no-print">
        <button class="tab ${st.tab === 'vouchers' ? 'active' : ''}" data-tab="vouchers">凭证</button>
        <button class="tab ${st.tab === 'opening' ? 'active' : ''}" data-tab="opening">期初余额</button>
        <button class="tab ${st.tab === 'balances' ? 'active' : ''}" data-tab="balances">试算平衡</button>
        <button class="tab ${st.tab === 'ledgers' ? 'active' : ''}" data-tab="ledgers">账簿</button>
        <button class="tab ${st.tab === 'reports' ? 'active' : ''}" data-tab="reports">报表</button>
        <button class="tab ${st.tab === 'invoices' ? 'active' : ''}" data-tab="invoices">发票</button>
        <button class="tab ${st.tab === 'payroll' ? 'active' : ''}" data-tab="payroll">工资</button>
        <button class="tab ${st.tab === 'assets' ? 'active' : ''}" data-tab="assets">资产</button>
        <button class="tab ${st.tab === 'migration' ? 'active' : ''}" data-tab="migration">旧账迁移</button>
        <button class="tab ${st.tab === 'accounts' ? 'active' : ''}" data-tab="accounts">科目表</button>
      </div>
      <div id="acc-body"></div>`}
    `;

    view.querySelectorAll('.tab').forEach(b => {
      b.onclick = () => { this.accState.tab = b.dataset.tab; this.draw(view); };
    });
    const sel = view.querySelector('#acc-period');
    if (sel) sel.onchange = async () => {
      this.accState.periodId = Number(sel.value);
      await this.reloadTabData();
      this.draw(view);
    };
    const nbp = view.querySelector('#acc-new-period');
    if (nbp) nbp.onclick = () => this.openNewPeriod(view);
    const cb = view.querySelector('#acc-close');
    if (cb) cb.onclick = () => this.toggleClose(view, p);
    const cfb = view.querySelector('#acc-carry');
    if (cfb) cfb.onclick = () => this.carryForward(view, p);

    if (!noPeriod) this.drawTab(view);
  },

  drawTab(view) {
    const host = view.querySelector('#acc-body');
    if (!host) return;
    const t = this.accState.tab;
    if (t === 'vouchers') return this.drawVouchers(host, view);
    if (t === 'opening') return this.drawOpening(host, view);
    if (t === 'balances') return this.drawBalances(host);
    if (t === 'ledgers') return this.drawLedgers(host, view);
    if (t === 'reports') return this.drawReports(host, view);
    if (t === 'invoices') return this.drawInvoices(host, view);
    if (t === 'payroll') return this.drawPayroll(host, view);
    if (t === 'assets') return this.drawAssets(host, view);
    if (t === 'migration') return this.drawMigration(host, view);
    return this.drawAccounts(host, view);
  },

  /* ---------- 开账 / 关账 ---------- */
  async openNewPeriod(view) {
    const now = new Date();
    await UI.formModal({
      title: '开账（新建会计期间）',
      fields: [
        { name: 'year', label: '年份', type: 'number', required: true, value: String(now.getFullYear()) },
        { name: 'month', label: '月份', type: 'number', required: true, value: String(now.getMonth() + 1) },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/periods', { year: Number(vals.year), month: Number(vals.month) });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已开账', 'success');
        this.accState.periodId = r.data.id;
        await this.render(view);
      },
    });
  },

  async toggleClose(view, p) {
    if (p.status === 'closed') {
      if (!(await UI.confirm('反结账后该期可再次录入凭证，确认？'))) return;
      const r = await API.post(`/api/accounting/periods/${p.id}/reopen`, {});
      if (r.error) return UI.toast(r.error, 'error');
    } else {
      if (!(await UI.confirm('关账前要求试算平衡；关账后该期凭证不可再改，确认关账？'))) return;
      const r = await API.post(`/api/accounting/periods/${p.id}/close`, {});
      if (r.error) return UI.toast(r.error, 'error');
    }
    UI.toast('已更新', 'success');
    await this.render(view);
  },

  /* ---------- 动态行编辑器（期初 / 凭证共用） ---------- */
  /* 渲染到 container，返回读取当前行的 getter。keys 支持 account_code/summary/debit/credit/qty */
  rowEditor(container, opts, rows, keys) {
    const blank = {};
    keys.forEach(k => { blank[k] = ''; });
    const data = (Array.isArray(rows) && rows.length ? rows : [blank]).map(r => ({ ...blank, ...r }));

    const cell = (r, i, k, cls) =>
      `<input class="${cls || 'input'}" data-i="${i}" data-k="${k}" value="${k === 'summary' ? UI.esc(r[k] || '') : (r[k] === undefined ? '' : r[k])}" inputmode="decimal">`;

    const render = () => {
      container.innerHTML = `
        <table class="table">
          <thead><tr>
            <th style="width:38%">科目</th>
            ${keys.includes('summary') ? '<th>摘要</th>' : ''}
            <th>借方</th>
            <th>贷方</th>
            ${keys.includes('qty') ? '<th>数量</th>' : ''}
            <th></th>
          </tr></thead>
          <tbody>
            ${data.map((r, i) => `<tr>
              <td><select class="select" data-i="${i}" data-k="account_code">
                ${opts.map(o => `<option value="${o.value}" ${String(o.value) === String(r.account_code) ? 'selected' : ''}>${UI.esc(o.label)}</option>`).join('')}
              </select></td>
              ${keys.includes('summary') ? `<td>${cell(r, i, 'summary', 'input')}</td>` : ''}
              <td>${cell(r, i, 'debit')}</td>
              <td>${cell(r, i, 'credit')}</td>
              ${keys.includes('qty') ? `<td>${cell(r, i, 'qty')}</td>` : ''}
              <td><button type="button" class="btn tiny" data-del="${i}">删除</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <button type="button" class="btn" id="rowAdd">＋ 加一行</button>
        <div class="muted" id="rowTip" style="margin-top:8px"></div>
      `;
      container.querySelectorAll('select,input').forEach(el => {
        const onChange = () => { data[Number(el.dataset.i)][el.dataset.k] = el.value; updateTip(); };
        el.onchange = onChange;
        el.oninput = onChange;
      });
      container.querySelectorAll('[data-del]').forEach(b => {
        b.onclick = () => { data.splice(Number(b.dataset.del), 1); if (!data.length) data.push({ ...blank }); render(); };
      });
      container.querySelector('#rowAdd').onclick = () => { data.push({ ...blank }); render(); };
      updateTip();
    };

    const updateTip = () => {
      const sd = data.reduce((s, r) => s + (Number(r.debit) || 0), 0);
      const sc = data.reduce((s, r) => s + (Number(r.credit) || 0), 0);
      const tip = container.querySelector('#rowTip');
      if (!tip) return;
      const balanced = Math.abs(sd - sc) < 0.001;
      tip.innerHTML = `借方合计 <b>${sd.toFixed(2)}</b> ｜ 贷方合计 <b>${sc.toFixed(2)}</b> ｜ 差额 <b style="color:${balanced ? 'green' : 'red'}">${(sd - sc).toFixed(2)}</b>${balanced ? '' : '（差额必须为 0 才能保存）'}`;
    };

    render();
    return () => data;
  },

  /* 给 showModal 追加一个「保存」按钮（其自带 footer 只有关闭，关闭即取消） */
  addSaveButton(overlay, label) {
    const foot = overlay.querySelector('.modal-foot');
    if (foot) foot.insertAdjacentHTML('afterbegin', `<button class="btn btn-primary" id="accOk">${label}</button>`);
    return overlay.querySelector('#accOk');
  },

  closeModal(overlay) {
    // 走自带关闭按钮，确保 UI.dialog 注册的清理逻辑（键盘/遮罩）一并执行
    const btn = overlay.querySelector('[data-act="close"]');
    if (btn) btn.click(); else overlay.remove();
  },

  /* ---------- 科目表 ---------- */
  drawAccounts(host, view) {
    const cats = { asset: '资产', liability: '负债', equity: '权益', cost: '成本', income: '收入', expense: '费用' };
    const rows = this.accState.accounts;
    const byCat = {};
    rows.forEach(a => { (byCat[a.category] = byCat[a.category] || []).push(a); });

    const table = UI.table([
      { key: 'code', label: '编码' },
      { key: 'name', label: '科目名称', render: r => UI.esc(r.name) },
      { key: 'balance_dir', label: '余额方向' },
      { key: 'aux', label: '辅助核算', render: r => UI.esc(r.aux || '—') },
      { key: 'enable_qty', label: '数量金额', render: r => (r.enable_qty ? `<span class="tag tag-green">是${r.unit ? ' / ' + UI.esc(r.unit) : ''}</span>` : '—') },
    ], rows);

    host.innerHTML = `
      <div class="page-head"><h3>科目表（${rows.length} 条）</h3>
        <div class="actions"><button class="btn primary" id="acc-add-account">＋ 新增科目</button></div>
      </div>
      <div class="stat-row">
        ${Object.keys(cats).map(c => `<div class="card stat"><div class="stat-label">${cats[c]}</div><div class="stat-val">${(byCat[c] || []).length}</div></div>`).join('')}
      </div>
      ${table}
    `;
    host.querySelector('#acc-add-account').onclick = () => this.openNewAccount(view);
  },

  async openNewAccount(view) {
    await UI.formModal({
      title: '新增会计科目',
      fields: [
        { name: 'code', label: '科目编码', required: true, value: '' },
        { name: 'name', label: '科目名称', required: true, value: '' },
        { name: 'category', label: '大类', type: 'select', required: true, options: [
          { value: 'asset', label: '资产' }, { value: 'liability', label: '负债' }, { value: 'equity', label: '权益' },
          { value: 'cost', label: '成本' }, { value: 'income', label: '收入' }, { value: 'expense', label: '费用' },
        ], value: 'asset' },
        { name: 'balance_dir', label: '余额方向', type: 'select', options: [{ value: '借', label: '借' }, { value: '贷', label: '贷' }], value: '借' },
        { name: 'enable_qty', label: '数量金额核算', type: 'select', options: [{ value: '0', label: '否' }, { value: '1', label: '是' }], value: '0' },
        { name: 'unit', label: '计量单位', value: '' },
        { name: 'aux', label: '辅助核算（customer/supplier/dept，逗号分隔）', value: '' },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/accounts', {
          code: vals.code.trim(), name: vals.name.trim(), category: vals.category,
          balance_dir: vals.balance_dir, enable_qty: Number(vals.enable_qty),
          unit: vals.unit, aux: vals.aux,
        });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已新增科目', 'success');
        await this.render(view);
      },
    });
  },

  /* ---------- 期初余额 ---------- */
  async drawOpening(host, view) {
    const pid = this.accState.periodId;
    const cur = await API.get('/api/accounting/opening?period_id=' + pid);
    const rows = cur.data || [];
    const sd = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const sc = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    const ok = Math.abs(sd - sc) < 0.001;

    const table = UI.table([
      { key: 'account_code', label: '科目编码' },
      { key: 'debit', label: '期初借方', render: r => this.money(r.debit) },
      { key: 'credit', label: '期初贷方', render: r => this.money(r.credit) },
      { key: 'qty', label: '数量', render: r => (r.qty ? String(r.qty) : '—') },
    ], rows);

    host.innerHTML = `
      <div class="page-head"><h3>期初余额</h3>
        <div class="actions"><button class="btn primary" id="acc-edit-opening">${rows.length ? '重录期初' : '录入期初'}</button></div>
      </div>
      <p class="muted">仅首期需要录入；后续各期期初由上期期末自动推导。借贷合计必须相等。</p>
      ${rows.length ? `<div class="stat-row">
        <div class="card stat"><div class="stat-label">期初借方合计</div><div class="stat-val">¥${this.money(sd)}</div></div>
        <div class="card stat"><div class="stat-label">期初贷方合计</div><div class="stat-val">¥${this.money(sc)}</div></div>
        <div class="card stat"><div class="stat-label">平衡状态</div><div class="stat-val"><span class="tag ${ok ? 'tag-green' : 'tag-red'}">${ok ? '平衡' : '不平衡'}</span></div></div>
      </div>${table}` : '<p class="muted">本期尚未录入期初余额。</p>'}
    `;
    host.querySelector('#acc-edit-opening').onclick = () => this.openOpeningForm(view, rows);
  },

  openOpeningForm(view, existing) {
    const p = this.currentPeriod();
    const rows = (existing && existing.length) ? existing : [{ account_code: '', debit: '', credit: '', qty: '' }];
    const overlay = UI.showModal({
      title: `${p.year}-${String(p.month).padStart(2, '0')} 期初余额（覆盖式保存）`,
      html: '<div id="accRows"></div>',
      maxWidth: 920,
    });
    const getRows = this.rowEditor(
      overlay.querySelector('#accRows'), this.detailOptions(), rows,
      ['account_code', 'debit', 'credit', 'qty']
    );
    this.addSaveButton(overlay, '保存期初').onclick = async () => {
      const balances = getRows().filter(r => r.account_code).map(r => ({
        account_code: r.account_code,
        debit: Number(r.debit) || 0,
        credit: Number(r.credit) || 0,
        qty: Number(r.qty) || 0,
      }));
      if (!balances.length) return UI.toast('至少录入一行', 'error');
      const r = await API.post('/api/accounting/opening', { period_id: this.accState.periodId, balances });
      if (r.error) return UI.toast(r.error, 'error');
      this.closeModal(overlay);
      UI.toast('期初已保存', 'success');
      await this.render(view);
    };
  },

  /* ---------- 凭证 ---------- */
  drawVouchers(host, view) {
    const p = this.currentPeriod();
    const closed = p && p.status === 'closed';
    const statusTag = s => ({ draft: 'tag-yellow', audited: 'tag-blue', posted: 'tag-green' }[s] || 'tag-gray');
    const statusName = { draft: '草稿', audited: '已审', posted: '已记账' };

    const table = UI.table([
      { key: 'voucher_no', label: '凭证号' },
      { key: 'date', label: '日期' },
      { key: 'type', label: '类型' },
      { key: 'summary', label: '摘要', render: r => UI.esc(r.summary || '—') },
      { key: 'status', label: '状态', render: r => `<span class="tag ${statusTag(r.status)}">${statusName[r.status] || r.status}</span>` },
      { key: '_act', label: '操作', render: r => {
          if (r.status === 'draft') return `<button class="btn tiny" data-audit="${r.id}">审核</button>`;
          if (r.status === 'audited') return `<button class="btn tiny primary" data-post="${r.id}">记账</button>`;
          return '—';
        } },
    ], this.accState.vouchers);

    host.innerHTML = `
      <div class="page-head"><h3>记账凭证</h3>
        <div class="actions"><button class="btn primary" id="acc-add-voucher" ${closed ? 'disabled' : ''}>＋ 新增凭证</button></div>
      </div>
      ${closed ? '<p class="muted">该期已关账，如需修改请先「反结账」。</p>' : ''}
      ${this.accState.vouchers.length ? table : '<p class="muted">本期暂无凭证。</p>'}
    `;
    const add = host.querySelector('#acc-add-voucher');
    if (add && !closed) add.onclick = () => this.openVoucherForm(view);
    host.querySelectorAll('[data-audit]').forEach(b => {
      b.onclick = async () => {
        const r = await API.post(`/api/accounting/vouchers/${b.dataset.audit}/audit`, {});
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已审核', 'success');
        await this.render(view);
      };
    });
    host.querySelectorAll('[data-post]').forEach(b => {
      b.onclick = async () => {
        const r = await API.post(`/api/accounting/vouchers/${b.dataset.post}/post`, {});
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已记账', 'success');
        await this.render(view);
      };
    });
  },

  openVoucherForm(view) {
    const p = this.currentPeriod();
    const defaultDate = `${p.year}-${String(p.month).padStart(2, '0')}-01`;
    const overlay = UI.showModal({
      title: '新增记账凭证（借贷必须相等）',
      html: `
        <div class="form-grid">
          <div class="field"><label>凭证日期</label><input class="input" id="accDate" type="date" value="${defaultDate}"></div>
          <div class="field"><label>类型</label><select class="select" id="accType">
            <option value="记">记</option><option value="收">收</option><option value="付">付</option><option value="转">转</option>
          </select></div>
          <div class="field"><label>摘要</label><input class="input" id="accSummary" value=""></div>
        </div>
        <div id="accRows"></div>`,
      maxWidth: 980,
    });
    const getRows = this.rowEditor(
      overlay.querySelector('#accRows'), this.detailOptions(), [{}, {}],
      ['account_code', 'summary', 'debit', 'credit', 'qty']
    );
    this.addSaveButton(overlay, '保存凭证').onclick = async () => {
      const entries = getRows().filter(r => r.account_code).map(r => ({
        account_code: r.account_code,
        summary: r.summary || '',
        debit: Number(r.debit) || 0,
        credit: Number(r.credit) || 0,
        qty: Number(r.qty) || 0,
      }));
      if (entries.length < 2) return UI.toast('至少两行分录', 'error');
      const r = await API.post('/api/accounting/vouchers', {
        period_id: this.accState.periodId,
        date: overlay.querySelector('#accDate').value,
        type: overlay.querySelector('#accType').value,
        summary: overlay.querySelector('#accSummary').value,
        entries,
      });
      if (r.error) return UI.toast(r.error, 'error');
      this.closeModal(overlay);
      UI.toast(`已保存 ${r.data.voucher_no}`, 'success');
      await this.render(view);
    };
  },

  /* ---------- 试算平衡 ---------- */
  drawBalances(host) {
    const b = this.accState.balances;
    if (!b || !b.rows.length) {
      host.innerHTML = '<div class="page-head"><h3>试算平衡</h3></div><p class="muted">本期尚无发生额或期初余额。</p>';
      return;
    }
    const table = UI.table([
      { key: 'code', label: '编码' },
      { key: 'name', label: '科目', render: r => UI.esc(r.name) },
      { key: 'opening_debit', label: '期初借方', render: r => this.money(r.opening_debit) },
      { key: 'opening_credit', label: '期初贷方', render: r => this.money(r.opening_credit) },
      { key: 'period_debit', label: '本期借方', render: r => this.money(r.period_debit) },
      { key: 'period_credit', label: '本期贷方', render: r => this.money(r.period_credit) },
      { key: 'closing_debit', label: '期末借方', render: r => this.money(r.closing_debit) },
      { key: 'closing_credit', label: '期末贷方', render: r => this.money(r.closing_credit) },
    ], b.rows);

    host.innerHTML = `
      <div class="page-head"><h3>试算平衡</h3></div>
      <div class="stat-row">
        <div class="card stat"><div class="stat-label">期末借方合计</div><div class="stat-val">¥${this.money(b.totals.debit)}</div></div>
        <div class="card stat"><div class="stat-label">期末贷方合计</div><div class="stat-val">¥${this.money(b.totals.credit)}</div></div>
        <div class="card stat"><div class="stat-label">是否平衡</div><div class="stat-val"><span class="tag ${b.balanced ? 'tag-green' : 'tag-red'}">${b.balanced ? '平衡' : '不平衡'}</span></div></div>
      </div>
      ${table}
    `;
  },

  /* ---------- 期末结转 ---------- */
  async carryForward(view, p) {
    if (!(await UI.confirm('期末结转将生成「转」字草稿凭证：损益类科目余额结转至本年利润（12月再结转至利润分配）。生成后需审核并记账方可生效，确认？'))) return;
    const r = await API.post(`/api/accounting/periods/${p.id}/carryforward`, {});
    if (r.error) return UI.toast(r.error, 'error');
    if (r.data && r.data.skipped) return UI.toast('无损益余额，无需结转', 'success');
    UI.toast(`已生成结转凭证：${r.data.vouchers.map(v => v.voucher_no).join('、')}`, 'success');
    await this.render(view);
  },

  /* ---------- 账簿（M1） ---------- */
  async drawLedgers(host, view) {
    const pid = this.accState.periodId;
    if (!this.accState.ledgerKind) this.accState.ledgerKind = 'general';
    const kinds = [
      { k: 'general', label: '总账' }, { k: 'detail', label: '明细账' },
      { k: 'journal', label: '日记账' }, { k: 'cashbook', label: '现金日记账' },
      { k: 'bankbook', label: '银行日记账' }, { k: 'qty', label: '数量金额账' },
      { k: 'multi', label: '多栏账' },
    ];
    const kind = this.accState.ledgerKind;

    let accountPick = '';
    if (kind === 'detail' || kind === 'multi') {
      accountPick = `<div class="field"><label>科目</label><select class="select" id="lg-account">
        ${this.detailOptions().map(o => `<option value="${o.value}">${UI.esc(o.label)}</option>`).join('')}
      </select></div>`;
    }

    host.innerHTML = `
      <div class="page-head"><h3>账簿</h3>
        <div class="actions">
          <select class="select" id="lg-kind">
            ${kinds.map(x => `<option value="${x.k}" ${x.k === kind ? 'selected' : ''}>${x.label}</option>`).join('')}
          </select>
          ${accountPick}
          <button class="btn primary" id="lg-load">查询</button>
        </div>
      </div>
      <p class="muted">账簿由已记账凭证实时生成，改凭证账簿同步变化。</p>
      <div id="lg-out"></div>
    `;
    const kindSel = host.querySelector('#lg-kind');
    kindSel.onchange = () => { this.accState.ledgerKind = kindSel.value; this.drawLedgers(host, view); };
    const loadBtn = host.querySelector('#lg-load');
    loadBtn.onclick = () => this.loadLedger(view, host, kind);
    await this.loadLedger(view, host, kind);
  },

  async loadLedger(view, host, kind) {
    const pid = this.accState.periodId;
    const out = host.querySelector('#lg-out');
    if (kind === 'general') {
      const r = await API.get('/api/accounting/ledgers/general?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      out.innerHTML = UI.table([
        { key: 'code', label: '编码' }, { key: 'name', label: '科目', render: x => UI.esc(x.name) },
        { key: 'opening_debit', label: '期初借', render: x => this.money(x.opening_debit) },
        { key: 'opening_credit', label: '期初贷', render: x => this.money(x.opening_credit) },
        { key: 'period_debit', label: '本期借', render: x => this.money(x.period_debit) },
        { key: 'period_credit', label: '本期贷', render: x => this.money(x.period_credit) },
        { key: 'closing_debit', label: '期末借', render: x => this.money(x.closing_debit) },
        { key: 'closing_credit', label: '期末贷', render: x => this.money(x.closing_credit) },
      ], r.data || []);
    } else if (kind === 'journal') {
      const r = await API.get('/api/accounting/ledgers/journal?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      out.innerHTML = (r.data || []).map(v => `
        <div class="card" style="margin-bottom:10px">
          <div class="card-head"><b>${UI.esc(v.voucher_no)}</b> ｜ ${v.date} ｜ ${v.type} ｜ ${UI.esc(v.summary || '')}</div>
          ${UI.table([
            { key: 'account_code', label: '科目' },
            { key: 'summary', label: '摘要', render: e => UI.esc(e.summary || '') },
            { key: 'debit', label: '借方', render: e => this.money(e.debit) },
            { key: 'credit', label: '贷方', render: e => this.money(e.credit) },
          ], v.entries || [])}
        </div>`).join('') || '<p class="muted">本期无已记账凭证。</p>';
    } else if (kind === 'cashbook' || kind === 'bankbook') {
      const r = await API.get('/api/accounting/ledgers/' + (kind === 'cashbook' ? 'cash' : 'bank') + '?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      out.innerHTML = this.bookHtml(r.data);
    } else if (kind === 'qty') {
      const r = await API.get('/api/accounting/ledgers/qty?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      out.innerHTML = (r.data || []).map(acc => `
        <div class="card" style="margin-bottom:10px">
          <div class="card-head"><b>${acc.account_code} ${UI.esc(acc.account_name)}</b>（${UI.esc(acc.unit || '')}）</div>
          ${UI.table([
            { key: 'date', label: '日期' }, { key: 'voucher_no', label: '凭证号' },
            { key: 'summary', label: '摘要', render: e => UI.esc(e.summary || '') },
            { key: 'qty', label: '数量', render: e => String(e.qty) },
            { key: 'price', label: '单价', render: e => this.money(e.price) },
            { key: 'debit', label: '借方', render: e => this.money(e.debit) },
            { key: 'credit', label: '贷方', render: e => this.money(e.credit) },
            { key: 'balance_qty', label: '结存数量', render: e => String(e.balance_qty) },
          ], acc.lines || [])}
        </div>`).join('') || '<p class="muted">无数量金额核算科目发生额。</p>';
    } else if (kind === 'multi') {
      const code = host.querySelector('#lg-account').value;
      if (!code) return;
      const r = await API.get('/api/accounting/ledgers/multi-column?period_id=' + pid + '&account_code=' + encodeURIComponent(code));
      if (r.error) return UI.toast(r.error, 'error');
      const d = r.data || {};
      const cols = d.columns || [];
      const cellAmt = (row, c) => {
        const cell = row.cells && row.cells[c.code];
        return cell ? (Number(cell.debit) || 0) + (Number(cell.credit) || 0) : 0;
      };
      const head = cols.map(c => `<th>${UI.esc(c.code)} ${UI.esc(c.name)}</th>`).join('');
      const body = (d.rows || []).map(row => `<tr>
        <td>${UI.esc(row.date)}</td><td>${UI.esc(row.voucher_no)}</td>
        <td>${UI.esc(row.summary || '')}</td>
        <td>${this.money(row.debit)}</td><td>${this.money(row.credit)}</td>
        ${cols.map(c => { const a = cellAmt(row, c); return `<td>${a ? this.money(a) : ''}</td>`; }).join('')}
      </tr>`).join('');
      const foot = cols.map(c => `<td>${this.money((Number(c.debit) || 0) + (Number(c.credit) || 0))}</td>`).join('');
      out.innerHTML = `
        <div class="card">
          <div class="card-head"><b>多栏账 · ${UI.esc(d.account ? (d.account.code + ' ' + d.account.name) : '')}</b></div>
          <p class="muted">按对方科目横向分栏；复合分录按对方科目金额比例分摊。</p>
          <table class="table">
            <thead><tr><th>日期</th><th>凭证号</th><th>摘要</th><th>借方</th><th>贷方</th>${head}</tr></thead>
            <tbody>${body || '<tr><td colspan="5">本期无数据</td></tr>'}</tbody>
            <tfoot><tr><th colspan="5">合计</th>${foot}</tr></tfoot>
          </table>
        </div>`;
    } else if (kind === 'detail') {
      const code = host.querySelector('#lg-account').value;
      if (!code) return;
      const r = await API.get('/api/accounting/ledgers/detail?period_id=' + pid + '&account_code=' + encodeURIComponent(code));
      if (r.error) return UI.toast(r.error, 'error');
      const d = r.data || {};
      out.innerHTML = `
        <p class="muted">${d.account_code} ${UI.esc(d.account_name)} ｜ 期初净额 ${this.money(d.opening_net)}</p>
        ${UI.table([
          { key: 'date', label: '日期' }, { key: 'voucher_no', label: '凭证号' },
          { key: 'summary', label: '摘要', render: e => UI.esc(e.summary || '') },
          { key: 'debit', label: '借方', render: e => this.money(e.debit) },
          { key: 'credit', label: '贷方', render: e => this.money(e.credit) },
          { key: 'balance', label: '余额', render: e => this.money(e.balance) + ' ' + e.balance_dir },
        ], d.lines || [])}
      `;
    }
  },

  bookHtml(d) {
    if (!d) return '<p class="muted">无数据。</p>';
    return `
      <div class="card">
        <div class="card-head"><b>${d.account_code} ${UI.esc(d.account_name)}</b> ｜ 期初 ${this.money(d.opening_net)}</div>
        ${UI.table([
          { key: 'date', label: '日期' }, { key: 'voucher_no', label: '凭证号' },
          { key: 'summary', label: '摘要', render: e => UI.esc(e.summary || '') },
          { key: 'debit', label: '借方', render: e => this.money(e.debit) },
          { key: 'credit', label: '贷方', render: e => this.money(e.credit) },
          { key: 'balance', label: '余额', render: e => this.money(e.balance) + ' ' + e.balance_dir },
        ], d.lines || [])}
      </div>`;
  },

  /* ---------- 报表（M1） ---------- */
  async drawReports(host, view) {
    const pid = this.accState.periodId;
    if (!this.accState.reportKind) this.accState.reportKind = 'balance';
    host.innerHTML = `
      <div class="page-head"><h3>报表</h3>
        <div class="actions">
          <select class="select" id="rp-kind">
            <option value="balance" ${this.accState.reportKind === 'balance' ? 'selected' : ''}>资产负债表</option>
            <option value="income" ${this.accState.reportKind === 'income' ? 'selected' : ''}>利润表</option>
            <option value="cashflow" ${this.accState.reportKind === 'cashflow' ? 'selected' : ''}>现金流量表</option>
          </select>
          <button class="btn primary" id="rp-load">查询</button>
        </div>
      </div>
      <div id="rp-out"></div>
    `;
    host.querySelector('#rp-kind').onchange = (e) => { this.accState.reportKind = e.target.value; this.drawReports(host, view); };
    host.querySelector('#rp-load').onclick = () => this.loadReport(host, this.accState.reportKind);
    await this.loadReport(host, this.accState.reportKind);
  },

  async loadReport(host, kind) {
    const pid = this.accState.periodId;
    const out = host.querySelector('#rp-out');
    if (kind === 'balance') {
      const r = await API.get('/api/accounting/reports/balance-sheet?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      const d = r.data;
      const sec = (title, arr) => arr.length ? `<tr><td colspan="2" class="muted"><b>${title}</b></td></tr>` + arr.map(x => `<tr><td>${x.code} ${UI.esc(x.name)}</td><td style="text-align:right">${this.money(x.amount)}</td></tr>`).join('') : '';
      out.innerHTML = `
        <table class="table">
          <thead><tr><th>资产</th><th style="text-align:right">金额</th></tr></thead>
          <tbody>
            ${sec('流动资产', d.assets.current)}
            ${sec('非流动资产', d.assets.noncurrent)}
            <tr class="strong"><td>资产总计</td><td style="text-align:right">${this.money(d.assets.total)}</td></tr>
          </tbody>
        </table>
        <table class="table">
          <thead><tr><th>负债与所有者权益</th><th style="text-align:right">金额</th></tr></thead>
          <tbody>
            ${sec('流动负债', d.liabilities.current)}
            ${sec('非流动负债', d.liabilities.noncurrent)}
            <tr class="strong"><td>负债合计</td><td style="text-align:right">${this.money(d.liabilities.total)}</td></tr>
            ${sec('所有者权益', d.equity.lines)}
            <tr class="strong"><td>所有者权益合计</td><td style="text-align:right">${this.money(d.equity.total)}</td></tr>
            <tr class="strong"><td>负债和所有者权益总计</td><td style="text-align:right">${this.money(d.total_liabilities_equity)}</td></tr>
          </tbody>
        </table>
        <p class="${d.balanced ? 'tag tag-green' : 'tag tag-red'}">${d.balanced ? '资产 = 负债 + 权益，报表平衡' : '报表不平衡！'}</p>
      `;
    } else if (kind === 'income') {
      const r = await API.get('/api/accounting/reports/income-statement?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      const d = r.data;
      const row = (label, val) => `<tr><td>${label}</td><td style="text-align:right">${this.money(val)}</td></tr>`;
      out.innerHTML = `
        <p class="muted">${d.period_label} ${d.ytd ? '（本年累计）' : '（本月）'}</p>
        <table class="table">
          <tbody>
            ${row('营业收入', d.revenue)}
            ${row('营业成本', -d.cost)}
            ${row('税金及附加', -d.tax)}
            ${row('销售费用', -d.sellExp)}
            ${row('管理费用', -d.manageExp)}
            ${row('财务费用', -d.finExp)}
            ${row('投资收益', d.invest)}
            <tr class="strong"><td>营业利润</td><td style="text-align:right">${this.money(d.operate_profit)}</td></tr>
            ${row('营业外收入', d.nonbizIncome)}
            ${row('营业外支出', -d.nonbizExp)}
            <tr class="strong"><td>利润总额</td><td style="text-align:right">${this.money(d.total_profit)}</td></tr>
            ${row('所得税费用', -d.incomeTax)}
            <tr class="strong"><td>净利润</td><td style="text-align:right">${this.money(d.net_profit)}</td></tr>
          </tbody>
        </table>
      `;
    } else if (kind === 'cashflow') {
      const r = await API.get('/api/accounting/reports/cash-flow?period_id=' + pid);
      if (r.error) return UI.toast(r.error, 'error');
      const d = r.data;
      const cfRow = (label, val) => `<tr><td>${label}</td><td style="text-align:right">${this.money(val)}</td></tr>`;
      const grp = (title, list) => list.length
        ? `<tr><td colspan="2" class="muted"><b>${title}</b></td></tr>` + list.map(x => cfRow(UI.esc(x.name), x.amount)).join('')
        : '';
      const items = d.items || [];
      out.innerHTML = `
        <p class="muted">${d.period_label} ｜ ${UI.esc(d.method || '')}</p>
        <table class="table">
          <tbody>
            ${grp('一、经营活动产生的现金流量', items.filter(x => x.group === '经营'))}
            <tr class="strong"><td>经营活动产生的现金流量净额</td><td style="text-align:right">${this.money(d.operating)}</td></tr>
            ${grp('二、投资活动产生的现金流量', items.filter(x => x.group === '投资'))}
            <tr class="strong"><td>投资活动产生的现金流量净额</td><td style="text-align:right">${this.money(d.investing)}</td></tr>
            ${grp('三、筹资活动产生的现金流量', items.filter(x => x.group === '筹资'))}
            <tr class="strong"><td>筹资活动产生的现金流量净额</td><td style="text-align:right">${this.money(d.financing)}</td></tr>
            <tr class="strong"><td>现金及现金等价物净增加额</td><td style="text-align:right">${this.money(d.net_increase)}</td></tr>
            ${cfRow('加：期初现金及现金等价物余额', d.cash_opening)}
            ${cfRow('期末现金及现金等价物余额', d.cash_closing)}
          </tbody>
        </table>
        <p class="muted">${UI.esc(d.note || '')}</p>
      `;
    }
  },

  /* ---------- 发票与资金（M2） ---------- */

  todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // 发票生成凭证后即时审核+记账（小厂老板/管理身兼制单与审核）
  async genInvoiceVoucher(view, kind, id) {
    const r = await API.post(`/api/accounting/invoices/${kind}/${id}/voucher`, {});
    if (r.error) return UI.toast(r.error, 'error');
    await API.post(`/api/accounting/vouchers/${r.data.id}/audit`, {});
    await API.post(`/api/accounting/vouchers/${r.data.id}/post`, {});
    UI.toast(`已生成并记账凭证 ${r.data.voucher_no}`, 'success');
    this.drawInvoices(view.querySelector('#acc-body'), view);
  },

  drawInvoices(host, view) {
    if (!this.accState.invKind) this.accState.invKind = 'sales';
    const kinds = [
      { k: 'sales', label: '销项发票' }, { k: 'purchase', label: '进项发票' },
      { k: 'expense', label: '费用单据' }, { k: 'risk', label: '风险分析' },
      { k: 'summary', label: '资金一览' }, { k: 'bank', label: '银行流水' },
    ];
    const kind = this.accState.invKind;
    host.innerHTML = `
      <div class="page-head"><h3>发票与资金（M2）</h3></div>
      <div class="tabs no-print">
        ${kinds.map(x => `<button class="tab ${x.k === kind ? 'active' : ''}" data-k="${x.k}">${x.label}</button>`).join('')}
      </div>
      <div id="inv-body"></div>`;
    host.querySelectorAll('.tab').forEach(b => {
      b.onclick = () => { this.accState.invKind = b.dataset.k; this.drawInvoices(host, view); };
    });
    const body = host.querySelector('#inv-body');
    if (kind === 'sales') return this.loadInvSales(body, view);
    if (kind === 'purchase') return this.loadInvPurchase(body, view);
    if (kind === 'expense') return this.loadInvExpense(body, view);
    if (kind === 'risk') return this.loadInvRisk(body, view);
    if (kind === 'summary') return this.loadInvSummary(body, view);
    return this.loadInvBank(body, view);
  },

  async loadInvSales(host, view) {
    const r = await API.get('/api/accounting/invoices/sales');
    if (r.error) return UI.toast(r.error, 'error');
    const rows = r.data || [];
    const table = UI.table([
      { key: 'invoice_no', label: '票号' },
      { key: 'invoice_date', label: '日期' },
      { key: 'customer_id', label: '客户ID' },
      { key: 'invoice_type', label: '类型' },
      { key: 'subtotal', label: '不含税', render: x => this.money(x.subtotal) },
      { key: 'tax_amount', label: '税额', render: x => this.money(x.tax_amount) },
      { key: 'total', label: '价税合计', render: x => this.money(x.total) },
      { key: 'status', label: '状态', render: x => `<span class="tag ${x.status === '已作废' ? 'tag-red' : 'tag-green'}">${x.status}</span>` },
      { key: '_act', label: '操作', render: x => x.voucher_id
        ? `<span class="tag tag-blue">凭证#${x.voucher_id}</span>`
        : (x.status === '已作废' ? '—' : `<button class="btn tiny primary" data-gen="${x.id}">生成凭证</button> <button class="btn tiny" data-void="${x.id}">作废</button>`) },
    ], rows);
    host.innerHTML = `<div class="actions" style="margin:10px 0"><button class="btn primary" id="inv-add-sales">＋ 新增销项发票</button></div>${rows.length ? table : '<p class="muted">暂无销项发票。</p>'}`;
    host.querySelector('#inv-add-sales').onclick = () => this.openSalesForm(view);
    host.querySelectorAll('[data-gen]').forEach(b => b.onclick = () => this.genInvoiceVoucher(view, 'sales', b.dataset.gen));
    host.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
      if (!(await UI.confirm('确认作废该销项发票？'))) return;
      const rr = await API.post(`/api/accounting/invoices/sales/${b.dataset.void}/void`, {});
      if (rr.error) return UI.toast(rr.error, 'error');
      UI.toast('已作废', 'success'); this.drawInvoices(view.querySelector('#acc-body'), view);
    });
  },

  async openSalesForm(view) {
    await UI.formModal({
      title: '新增销项发票',
      fields: [
        { name: 'invoice_no', label: '发票号码', required: true, value: '' },
        { name: 'invoice_date', label: '开票日期', type: 'date', required: true, value: this.todayStr() },
        { name: 'customer_id', label: '客户ID', type: 'number', required: true, value: '' },
        { name: 'invoice_type', label: '发票类型', type: 'select', options: [{ value: '普票', label: '普票' }, { value: '专票', label: '专票' }], value: '普票' },
        { name: 'subtotal', label: '不含税金额', type: 'number', required: true, value: '' },
        { name: 'tax_rate', label: '税率(%)', type: 'number', value: '13' },
        { name: 'due_days', label: '信用期(天)', type: 'number', value: '30' },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/invoices/sales', {
          invoice_no: vals.invoice_no.trim(), invoice_date: vals.invoice_date, customer_id: Number(vals.customer_id),
          invoice_type: vals.invoice_type, subtotal: Number(vals.subtotal), tax_rate: Number(vals.tax_rate), due_days: Number(vals.due_days || 0),
        });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已登记销项发票', 'success');
        this.drawInvoices(view.querySelector('#acc-body'), view);
      },
    });
  },

  async loadInvPurchase(host, view) {
    const r = await API.get('/api/accounting/invoices/purchase');
    if (r.error) return UI.toast(r.error, 'error');
    const rows = r.data || [];
    const table = UI.table([
      { key: 'invoice_no', label: '票号' },
      { key: 'invoice_date', label: '日期' },
      { key: 'supplier_id', label: '供应商ID' },
      { key: 'asset_account', label: '资产科目' },
      { key: 'subtotal', label: '不含税', render: x => this.money(x.subtotal) },
      { key: 'tax_amount', label: '税额', render: x => this.money(x.tax_amount) },
      { key: 'total', label: '价税合计', render: x => this.money(x.total) },
      { key: 'status', label: '状态', render: x => `<span class="tag ${x.status === '已作废' ? 'tag-red' : 'tag-green'}">${x.status}</span>` },
      { key: '_act', label: '操作', render: x => x.voucher_id
        ? `<span class="tag tag-blue">凭证#${x.voucher_id}</span>`
        : (x.status === '已作废' ? '—' : `<button class="btn tiny primary" data-gen="${x.id}">生成凭证</button> <button class="btn tiny" data-void="${x.id}">作废</button>`) },
    ], rows);
    host.innerHTML = `<div class="actions" style="margin:10px 0"><button class="btn primary" id="inv-add-purchase">＋ 新增进项发票</button></div>${rows.length ? table : '<p class="muted">暂无进项发票。</p>'}`;
    host.querySelector('#inv-add-purchase').onclick = () => this.openPurchaseForm(view);
    host.querySelectorAll('[data-gen]').forEach(b => b.onclick = () => this.genInvoiceVoucher(view, 'purchase', b.dataset.gen));
    host.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
      if (!(await UI.confirm('确认作废该进项发票？'))) return;
      const rr = await API.post(`/api/accounting/invoices/purchase/${b.dataset.void}/void`, {});
      if (rr.error) return UI.toast(rr.error, 'error');
      UI.toast('已作废', 'success'); this.drawInvoices(view.querySelector('#acc-body'), view);
    });
  },

  async openPurchaseForm(view) {
    await UI.formModal({
      title: '新增进项发票',
      fields: [
        { name: 'invoice_no', label: '发票号码', required: true, value: '' },
        { name: 'invoice_date', label: '开票日期', type: 'date', required: true, value: this.todayStr() },
        { name: 'supplier_id', label: '供应商ID', type: 'number', required: true, value: '' },
        { name: 'invoice_type', label: '发票类型', type: 'select', options: [{ value: '普票', label: '普票' }, { value: '专票', label: '专票' }], value: '普票' },
        { name: 'subtotal', label: '不含税金额', type: 'number', required: true, value: '' },
        { name: 'tax_rate', label: '税率(%)', type: 'number', value: '13' },
        { name: 'asset_account', label: '借方资产科目', type: 'select', options: [{ value: '1403', label: '1403 原材料' }, { value: '1405', label: '1405 库存商品' }, { value: '1409', label: '1409 在制品' }], value: '1403' },
        { name: 'due_days', label: '信用期(天)', type: 'number', value: '30' },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/invoices/purchase', {
          invoice_no: vals.invoice_no.trim(), invoice_date: vals.invoice_date, supplier_id: Number(vals.supplier_id),
          invoice_type: vals.invoice_type, subtotal: Number(vals.subtotal), tax_rate: Number(vals.tax_rate),
          asset_account: vals.asset_account, due_days: Number(vals.due_days || 0),
        });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已登记进项发票', 'success');
        this.drawInvoices(view.querySelector('#acc-body'), view);
      },
    });
  },

  async loadInvExpense(host, view) {
    const r = await API.get('/api/accounting/invoices/expense');
    if (r.error) return UI.toast(r.error, 'error');
    const rows = r.data || [];
    const table = UI.table([
      { key: 'expense_no', label: '单号' },
      { key: 'expense_date', label: '日期' },
      { key: 'category', label: '类别', render: x => UI.esc(x.category || '—') },
      { key: 'amount', label: '金额', render: x => this.money(x.amount) },
      { key: 'fee_account', label: '费用科目' },
      { key: 'payment_account', label: '付款科目' },
      { key: '_act', label: '操作', render: x => x.voucher_id
        ? `<span class="tag tag-blue">凭证#${x.voucher_id}</span>`
        : `<button class="btn tiny primary" data-gen="${x.id}">生成凭证</button>` },
    ], rows);
    host.innerHTML = `<div class="actions" style="margin:10px 0"><button class="btn primary" id="inv-add-expense">＋ 新增费用单据</button></div>${rows.length ? table : '<p class="muted">暂无费用单据。</p>'}`;
    host.querySelector('#inv-add-expense').onclick = () => this.openExpenseForm(view);
    host.querySelectorAll('[data-gen]').forEach(b => b.onclick = () => this.genInvoiceVoucher(view, 'expense', b.dataset.gen));
  },

  async openExpenseForm(view) {
    await UI.formModal({
      title: '新增费用单据',
      fields: [
        { name: 'expense_no', label: '单据号', required: true, value: '' },
        { name: 'expense_date', label: '日期', type: 'date', required: true, value: this.todayStr() },
        { name: 'dept_id', label: '部门ID', type: 'number', value: '' },
        { name: 'category', label: '类别', value: '' },
        { name: 'amount', label: '金额', type: 'number', required: true, value: '' },
        { name: 'fee_account', label: '费用科目', type: 'select', options: [{ value: '5602', label: '5602 管理费用' }, { value: '5601', label: '5601 销售费用' }, { value: '5603', label: '5603 财务费用' }], value: '5602' },
        { name: 'payment_account', label: '付款科目', type: 'select', options: [{ value: '1002', label: '1002 银行存款' }, { value: '1001', label: '1001 库存现金' }, { value: '2241', label: '2241 其他应付款' }], value: '1002' },
        { name: 'summary', label: '摘要', value: '' },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/invoices/expense', {
          expense_no: vals.expense_no.trim(), expense_date: vals.expense_date, dept_id: vals.dept_id ? Number(vals.dept_id) : null,
          category: vals.category, amount: Number(vals.amount), fee_account: vals.fee_account, payment_account: vals.payment_account, summary: vals.summary,
        });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已登记费用单据', 'success');
        this.drawInvoices(view.querySelector('#acc-body'), view);
      },
    });
  },

  async loadInvRisk(host, view) {
    host.innerHTML = `<div class="actions" style="margin:10px 0"><button class="btn primary" id="inv-scan">扫描风险</button></div><div id="risk-out"></div>`;
    host.querySelector('#inv-scan').onclick = async () => {
      const r = await API.post('/api/accounting/invoices/risk/scan', {});
      if (r.error) return UI.toast(r.error, 'error');
      UI.toast(`扫描完成，发现 ${r.data.length} 条风险`, r.data.length ? 'error' : 'success');
      const logs = r.data || [];
      host.querySelector('#risk-out').innerHTML = logs.length
        ? UI.table([
          { key: 'invoice_type', label: '发票类型' },
          { key: 'invoice_id', label: '发票ID' },
          { key: 'risk_type', label: '风险类型', render: x => `<span class="tag tag-red">${x.risk_type}</span>` },
          { key: 'detail', label: '说明', render: x => UI.esc(x.detail) },
          { key: 'detected_at', label: '检测时间' },
        ], logs)
        : '<p class="muted">未发现风险。</p>';
    };
  },

  async loadInvSummary(host, view) {
    const r = await API.get('/api/accounting/invoices/summary');
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data; const s = d.sales, p = d.purchase;
    host.innerHTML = `
      <div class="stat-row">
        <div class="card stat"><div class="stat-label">销项张数</div><div class="stat-val">${s.count}</div></div>
        <div class="card stat"><div class="stat-label">销项价税合计</div><div class="stat-val">¥${this.money(s.total)}</div></div>
        <div class="card stat"><div class="stat-label">销项税额</div><div class="stat-val">¥${this.money(s.tax)}</div></div>
        <div class="card stat"><div class="stat-label">进项张数</div><div class="stat-val">${p.count}</div></div>
        <div class="card stat"><div class="stat-label">进项价税合计</div><div class="stat-val">¥${this.money(p.total)}</div></div>
        <div class="card stat"><div class="stat-label">进项税额</div><div class="stat-val">¥${this.money(p.tax)}</div></div>
      </div>
      <div class="page-head"><h4>按客户（应收）</h4></div>
      ${UI.table([{ key: 'customer_id', label: '客户ID' }, { key: 'count', label: '张数' }, { key: 'total', label: '价税合计', render: x => this.money(x.total) }], d.by_customer)}
      <div class="page-head"><h4>按供应商（应付）</h4></div>
      ${UI.table([{ key: 'supplier_id', label: '供应商ID' }, { key: 'count', label: '张数' }, { key: 'total', label: '价税合计', render: x => this.money(x.total) }], d.by_supplier)}
    `;
  },

  parseBankInput(text) {
    if (text.startsWith('[')) {
      try { return JSON.parse(text); } catch (_) { return []; }
    }
    const out = [];
    text.split('\n').forEach(line => {
      const parts = line.split(',').map(x => x.trim());
      if (parts.length < 4) return;
      out.push({ trans_date: parts[0], summary: parts[1], direction: parts[2] === '贷' ? '贷' : '借', amount: Number(parts[3]) });
    });
    return out;
  },

  async loadInvBank(host, view) {
    host.innerHTML = `
      <p class="muted">银企互联（简化版）：粘贴银行流水后导入，系统按「日期±10天 + 金额」自动匹配银行存款凭证（未达账列于下方）。支持 CSV（日期,摘要,方向(借/贷),金额）或 JSON 数组。</p>
      <div class="actions" style="margin:8px 0">
        <button class="btn primary" id="inv-bank-import">导入流水</button>
        <button class="btn" id="inv-bank-refresh">刷新未达账</button>
      </div>
      <textarea id="inv-bank-text" class="input" rows="6" placeholder="2026-01-05,收A公司货款,贷,50000&#10;2026-01-08,付电费,借,3200"></textarea>
      <div id="bank-out" style="margin-top:10px"></div>`;
    const refresh = async () => {
      const u = await API.get('/api/accounting/bank/unmatched');
      const all = await API.get('/api/accounting/bank/statements');
      const unmatched = (u.data || []).length, total = (all.data || []).length;
      host.querySelector('#bank-out').innerHTML = `<p class="muted">已导入 ${total} 笔，未达账 ${unmatched} 笔。</p>` +
        ((u.data || []).length ? UI.table([
          { key: 'trans_date', label: '日期' }, { key: 'summary', label: '摘要', render: x => UI.esc(x.summary || '') },
          { key: 'direction', label: '方向' }, { key: 'amount', label: '金额', render: x => this.money(x.amount) },
          { key: 'bank_account', label: '账户' },
        ], u.data) : '<p class="muted">无未达账。</p>');
    };
    host.querySelector('#inv-bank-import').onclick = async () => {
      const text = host.querySelector('#inv-bank-text').value.trim();
      if (!text) return UI.toast('请先粘贴流水', 'error');
      const items = this.parseBankInput(text);
      if (!items.length) return UI.toast('解析失败，请检查格式', 'error');
      const r = await API.post('/api/accounting/bank/import', { items });
      if (r.error) return UI.toast(r.error, 'error');
      UI.toast(`导入 ${r.data.imported} 笔，匹配 ${r.data.matched} 笔`, 'success');
      await refresh();
    };
    host.querySelector('#inv-bank-refresh').onclick = refresh;
    await refresh();
  },

  /* ---------- 工资（M3） ---------- */

  drawPayroll(host, view) {
    if (!this.accState.payKind) this.accState.payKind = 'sheets';
    const kinds = [
      { k: 'sheets', label: '月度工资单' }, { k: 'profiles', label: '工资档案' },
      { k: 'social', label: '五险一金' }, { k: 'deductions', label: '专项附加扣除' },
      { k: 'summary', label: '工资统计' },
    ];
    const kind = this.accState.payKind;
    host.innerHTML = `
      <div class="page-head"><h3>工资（M3）</h3></div>
      <p class="muted">个税按<b>累计预扣法</b>估算（起征点 5000/月 + 七级超额累进 + 专项附加扣除）；
        计件产量默认按<b>成品口径</b>（末工序去重）。五险一金只做计算，不实际代扣代缴。</p>
      <div class="tabs no-print">
        ${kinds.map(x => `<button class="tab ${x.k === kind ? 'active' : ''}" data-k="${x.k}">${x.label}</button>`).join('')}
      </div>
      <div id="pay-body"></div>`;
    host.querySelectorAll('.tab').forEach(b => {
      b.onclick = () => { this.accState.payKind = b.dataset.k; this.drawPayroll(host, view); };
    });
    const body = host.querySelector('#pay-body');
    if (kind === 'profiles') return this.loadPayProfiles(body, view);
    if (kind === 'social') return this.loadPaySocial(body, view);
    if (kind === 'deductions') return this.loadPayDeductions(body, view);
    if (kind === 'summary') return this.loadPaySummary(body, view);
    return this.loadPaySheets(body, view);
  },

  async loadPaySheets(host, view) {
    const pid = this.accState.periodId;
    const refresh = async () => {
      const r = await API.get(`/api/accounting/payroll/sheets?period_id=${pid}`);
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      const table = UI.table([
        { key: 'emp_no', label: '工号' },
        { key: 'employee_name', label: '姓名' },
        { key: 'base_amount', label: '基本', num: true },
        { key: 'piece_qty', label: '计件量', num: true },
        { key: 'piece_amount', label: '计件工资', num: true },
        { key: 'overtime_amount', label: '加班', num: true },
        { key: 'gross_amount', label: '应发', num: true },
        { key: 'social_personal', label: '社保个人', num: true },
        { key: 'tax_amount', label: '个税', num: true },
        { key: 'net_amount', label: '实发', num: true },
        { key: 'status', label: '状态' },
        { key: '_act', label: '操作', render: x => x.voucher_id
          ? `<span class="tag tag-blue">凭证#${x.voucher_id}</span>`
          : (x.status === '草稿'
            ? `<button class="btn tiny primary" data-ap="${x.id}">审批</button>`
            : `<button class="btn tiny primary" data-pay="${x.id}">发放</button>`) },
      ], rows);
      host.innerHTML = `
        <div class="actions" style="margin:10px 0">
          <button class="btn primary" id="pay-gen">生成本月工资单</button>
          <button class="btn" id="pay-gen-force">强制重算（草稿）</button>
        </div>
        ${rows.length ? table : '<p class="muted">本期暂无工资单，点「生成本月工资单」。</p>'}`;
      host.querySelector('#pay-gen').onclick = async () => {
        const rr = await API.post('/api/accounting/payroll/sheets/generate', { period_id: pid });
        if (rr.error) return UI.toast(rr.error, 'error');
        UI.toast(`已生成 ${rr.data.created} 张`, 'success');
        await refresh();
      };
      host.querySelector('#pay-gen-force').onclick = async () => {
        const rr = await API.post('/api/accounting/payroll/sheets/generate', { period_id: pid, force: '1' });
        if (rr.error) return UI.toast(rr.error, 'error');
        UI.toast(`已生成 ${rr.data.created} 张`, 'success');
        await refresh();
      };
      host.querySelectorAll('[data-ap]').forEach(b => b.onclick = async () => {
        const rr = await API.post(`/api/accounting/payroll/sheets/${b.dataset.ap}/approve`, {});
        if (rr.error) return UI.toast(rr.error, 'error');
        UI.toast('已审批', 'success'); await refresh();
      });
      host.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => {
        if (!(await UI.confirm('确认发放并生成凭证？'))) return;
        const rr = await API.post(`/api/accounting/payroll/sheets/${b.dataset.pay}/pay`, {});
        if (rr.error) return UI.toast(rr.error, 'error');
        await API.post(`/api/accounting/vouchers/${rr.data.voucher_id}/audit`, {});
        await API.post(`/api/accounting/vouchers/${rr.data.voucher_id}/post`, {});
        UI.toast(`已发放并记账 ${rr.data.voucher_no}`, 'success');
        await refresh();
      });
    };
    await refresh();
  },

  async loadPayProfiles(host, view) {
    const refresh = async () => {
      const r = await API.get('/api/accounting/payroll/profiles');
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      host.innerHTML = `
        <div class="actions" style="margin:10px 0"><button class="btn primary" id="pf-add">＋ 新增/编辑档案</button></div>
        ${rows.length ? UI.table([
          { key: 'emp_no', label: '工号' },
          { key: 'employee_name', label: '姓名' },
          { key: 'base_salary', label: '基本工资', num: true },
          { key: 'piece_rate', label: '计件单价', num: true },
          { key: 'piece_basis', label: '计件口径', render: x => x.piece_basis === 'process' ? '工序加工量' : '成品' },
          { key: 'overtime_rate', label: '加班单价', num: true },
          { key: 'salary_subject', label: '工资科目' },
          { key: 'status', label: '状态' },
        ], rows) : '<p class="muted">暂无工资档案。</p>'}`;
      host.querySelector('#pf-add').onclick = () => this.openPayProfileForm(view);
    };
    await refresh();
  },

  async openPayProfileForm(view) {
    const emp = await API.get('/api/employees');
    const opts = (emp.data || []).map(e => ({ value: String(e.id), label: `${e.emp_no || e.id} ${e.name}` }));
    await UI.formModal({
      title: '员工工资档案',
      fields: [
        { name: 'employee_id', label: '员工', type: 'select', required: true, options: opts },
        { name: 'base_salary', label: '基本工资（元/月）', type: 'number', value: '0' },
        { name: 'piece_rate', label: '计件单价（元/件）', type: 'number', value: '0' },
        { name: 'piece_basis', label: '计件口径', type: 'select', options: [{ value: 'finished', label: '成品（末工序去重）' }, { value: 'process', label: '工序加工量' }] },
        { name: 'overtime_rate', label: '加班单价（元/小时）', type: 'number', value: '0' },
        { name: 'social_insurance_base', label: '社保基数（留空=按应发）', type: 'number' },
        { name: 'salary_subject', label: '工资科目', value: '400102' },
        { name: 'social_subject', label: '公司社保科目', value: '5602' },
        { name: 'payment_account', label: '发放科目', value: '1002' },
      ],
      onSubmit: async (vals) => {
        const r = await API.post('/api/accounting/payroll/profiles', { ...vals, employee_id: Number(vals.employee_id) });
        if (r.error) return UI.toast(r.error, 'error');
        UI.toast('已保存', 'success');
        this.drawPayroll(view.querySelector('#acc-body'), view);
      },
    });
  },

  async loadPaySocial(host, view) {
    const year = (this.currentPeriod() || {}).year || new Date().getFullYear();
    const items = ['养老', '医疗', '失业', '工伤', '生育', '公积金'];
    const refresh = async () => {
      const r = await API.get(`/api/accounting/payroll/social?year=${year}`);
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      host.innerHTML = `
        <div class="actions" style="margin:10px 0"><button class="btn primary" id="si-add">＋ 配置险种</button></div>
        <p class="muted">当前年度 ${year}。未配置则社保按 0 计算。</p>
        ${rows.length ? UI.table([
          { key: 'item_type', label: '险种' },
          { key: 'company_rate', label: '公司比例', render: x => (Number(x.company_rate) * 100).toFixed(2) + '%' },
          { key: 'personal_rate', label: '个人比例', render: x => (Number(x.personal_rate) * 100).toFixed(2) + '%' },
          { key: 'base_min', label: '基数下限', num: true },
          { key: 'base_max', label: '基数上限', num: true },
        ], rows) : '<p class="muted">该年度未配置五险一金。</p>'}`;
      host.querySelector('#si-add').onclick = () => UI.formModal({
        title: `五险一金配置（${year}）`,
        fields: [
          { name: 'item_type', label: '险种', type: 'select', required: true, options: items.map(x => ({ value: x, label: x })) },
          { name: 'company_rate', label: '公司比例（如 0.16 = 16%）', type: 'number', required: true, value: '0' },
          { name: 'personal_rate', label: '个人比例（如 0.08 = 8%）', type: 'number', required: true, value: '0' },
          { name: 'base_min', label: '基数下限（0=不限）', type: 'number', value: '0' },
          { name: 'base_max', label: '基数上限（0=不限）', type: 'number', value: '0' },
        ],
        onSubmit: async (vals) => {
          const rr = await API.post('/api/accounting/payroll/social', { ...vals, year });
          if (rr.error) return UI.toast(rr.error, 'error');
          UI.toast('已保存', 'success'); await refresh();
        },
      });
    };
    await refresh();
  },

  async loadPayDeductions(host, view) {
    const year = (this.currentPeriod() || {}).year || new Date().getFullYear();
    const types = ['子女教育', '继续教育', '大病医疗', '住房贷款利息', '住房租金', '赡养老人', '3岁以下婴幼儿照护'];
    const refresh = async () => {
      const r = await API.get(`/api/accounting/payroll/tax-deductions?year=${year}`);
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      host.innerHTML = `
        <div class="actions" style="margin:10px 0"><button class="btn primary" id="td-add">＋ 登记扣除</button></div>
        <p class="muted">年度 ${year}，金额为<b>每月</b>扣除标准（元/月）。</p>
        ${rows.length ? UI.table([
          { key: 'employee_id', label: '员工ID', num: true },
          { key: 'item_type', label: '扣除项' },
          { key: 'amount', label: '月额', num: true },
          { key: 'note', label: '备注' },
          { key: '_act', label: '操作', render: x => `<button class="btn tiny" data-del="${x.id}">删除</button>` },
        ], rows) : '<p class="muted">该年度无专项附加扣除记录。</p>'}`;
      host.querySelector('#td-add').onclick = () => UI.formModal({
        title: '专项附加扣除',
        fields: [
          { name: 'employee_id', label: '员工ID', type: 'number', required: true },
          { name: 'item_type', label: '扣除项', type: 'select', required: true, options: types.map(x => ({ value: x, label: x })) },
          { name: 'amount', label: '月额（元）', type: 'number', required: true, value: '0' },
          { name: 'note', label: '备注', type: 'textarea' },
        ],
        onSubmit: async (vals) => {
          const rr = await API.post('/api/accounting/payroll/tax-deductions', { ...vals, year, employee_id: Number(vals.employee_id) });
          if (rr.error) return UI.toast(rr.error, 'error');
          UI.toast('已保存', 'success'); await refresh();
        },
      });
      host.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        await API.del(`/api/accounting/payroll/tax-deductions/${b.dataset.del}`);
        await refresh();
      });
    };
    await refresh();
  },

  async loadPaySummary(host, view) {
    const pid = this.accState.periodId;
    const r = await API.get(`/api/accounting/payroll/summary?period_id=${pid}`);
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data || {};
    host.innerHTML = `
      <div class="stat-grid" style="margin:10px 0">
        <div class="stat-card"><div class="k">人数</div><div class="v">${d.count || 0}</div></div>
        <div class="stat-card"><div class="k">应发合计</div><div class="v primary">${this.money(d.gross)}</div></div>
        <div class="stat-card"><div class="k">代扣个税</div><div class="v">${this.money(d.tax)}</div></div>
        <div class="stat-card"><div class="k">实发合计</div><div class="v accent">${this.money(d.net)}</div></div>
      </div>
      <div class="stat-grid" style="margin:10px 0">
        <div class="stat-card"><div class="k">社保个人</div><div class="v">${this.money(d.social_personal)}</div></div>
        <div class="stat-card"><div class="k">社保公司</div><div class="v">${this.money(d.social_company)}</div></div>
        <div class="stat-card"><div class="k">计件工资</div><div class="v">${this.money(d.piece)}</div></div>
        <div class="stat-card"><div class="k">人均应发</div><div class="v">${this.money(d.avg_gross)}</div></div>
      </div>
      <div class="card"><div class="card-title">计件排行（Top 10）</div>
        ${(d.top_piece || []).length ? UI.table([
          { key: 'employee_name', label: '姓名' },
          { key: 'piece_qty', label: '计件量', num: true },
          { key: 'piece_amount', label: '计件工资', num: true },
        ], d.top_piece) : '<p class="muted">本期无数据。</p>'}
      </div>`;
  },

  /* ---------- 固定资产（M3） ---------- */

  drawAssets(host, view) {
    if (!this.accState.assetKind) this.accState.assetKind = 'cards';
    const kinds = [
      { k: 'cards', label: '资产卡片' }, { k: 'categories', label: '资产类别' },
      { k: 'depreciation', label: '折旧计提' }, { k: 'report', label: '资产报表' },
    ];
    const kind = this.accState.assetKind;
    host.innerHTML = `
      <div class="page-head"><h3>固定资产（M3）</h3></div>
      <p class="muted">支持<b>直线法</b>与<b>双倍余额递减法</b>；当月新增的资产<b>次月</b>起计提；
        累计折旧与净值实时计算。折旧生成「转」字草稿凭证（借折旧费用 / 贷 1602 累计折旧）。</p>
      <div class="tabs no-print">
        ${kinds.map(x => `<button class="tab ${x.k === kind ? 'active' : ''}" data-k="${x.k}">${x.label}</button>`).join('')}
      </div>
      <div id="asset-body"></div>`;
    host.querySelectorAll('.tab').forEach(b => {
      b.onclick = () => { this.accState.assetKind = b.dataset.k; this.drawAssets(host, view); };
    });
    const body = host.querySelector('#asset-body');
    if (kind === 'categories') return this.loadAssetCategories(body, view);
    if (kind === 'depreciation') return this.loadDepreciation(body, view);
    if (kind === 'report') return this.loadAssetReport(body, view);
    return this.loadAssetCards(body, view);
  },

  async loadAssetCards(host, view) {
    const refresh = async () => {
      const r = await API.get('/api/accounting/assets/assets');
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      host.innerHTML = `
        <div class="actions" style="margin:10px 0"><button class="btn primary" id="as-add">＋ 新增资产</button></div>
        ${rows.length ? UI.table([
          { key: 'code', label: '编号' },
          { key: 'name', label: '名称' },
          { key: 'category_name', label: '类别' },
          { key: 'purchase_date', label: '购入日期' },
          { key: 'original_value', label: '原值', num: true },
          { key: 'useful_life_years', label: '年限', num: true },
          { key: 'depreciation_method', label: '折旧方法' },
          { key: 'accumulated_depreciation', label: '累计折旧', num: true },
          { key: 'net_value', label: '净值', num: true },
          { key: 'status', label: '状态' },
          { key: '_act', label: '操作', render: x => x.status === '已处置' ? '—'
            : `<button class="btn tiny" data-dis="${x.id}">处置</button>` },
        ], rows) : '<p class="muted">暂无固定资产。</p>'}`;
      host.querySelector('#as-add').onclick = () => UI.formModal({
        title: '新增固定资产',
        fields: [
          { name: 'code', label: '资产编号', required: true },
          { name: 'name', label: '资产名称', required: true },
          { name: 'purchase_date', label: '购入日期 YYYY-MM-DD', required: true, value: this.todayStr() },
          { name: 'original_value', label: '原值', type: 'number', required: true, value: '0' },
          { name: 'residual_rate', label: '残值率（0.05=5%）', type: 'number', value: '0.05' },
          { name: 'useful_life_years', label: '使用年限（年）', type: 'number', value: '10' },
          { name: 'depreciation_method', label: '折旧方法', type: 'select', options: [{ value: '直线法', label: '直线法' }, { value: '双倍余额递减法', label: '双倍余额递减法' }] },
          { name: 'depreciation_subject_code', label: '折旧费用科目', value: '5602' },
          { name: 'location', label: '存放位置' },
        ],
        onSubmit: async (vals) => {
          const rr = await API.post('/api/accounting/assets/assets', vals);
          if (rr.error) return UI.toast(rr.error, 'error');
          UI.toast('已新增', 'success'); await refresh();
        },
      });
      host.querySelectorAll('[data-dis]').forEach(b => b.onclick = async () => {
        if (!(await UI.confirm('确认处置该资产？处置后不再计提折旧。'))) return;
        const rr = await API.post(`/api/accounting/assets/${b.dataset.dis}/dispose`, { dispose_date: this.todayStr() });
        if (rr.error) return UI.toast(rr.error, 'error');
        UI.toast('已处置', 'success'); await refresh();
      });
    };
    await refresh();
  },

  async loadAssetCategories(host, view) {
    const refresh = async () => {
      const r = await API.get('/api/accounting/assets/categories');
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      host.innerHTML = `
        <div class="actions" style="margin:10px 0"><button class="btn primary" id="ac-add">＋ 新增类别</button></div>
        ${rows.length ? UI.table([
          { key: 'code', label: '编码' },
          { key: 'name', label: '名称' },
          { key: 'depreciation_method_default', label: '默认折旧法' },
          { key: 'useful_life_default', label: '默认年限', num: true },
          { key: 'residual_rate_default', label: '默认残值率' },
        ], rows) : '<p class="muted">暂无资产类别。</p>'}`;
      host.querySelector('#ac-add').onclick = () => UI.formModal({
        title: '资产类别',
        fields: [
          { name: 'code', label: '编码', required: true },
          { name: 'name', label: '名称', required: true },
          { name: 'depreciation_method_default', label: '默认折旧法', type: 'select', options: [{ value: '直线法', label: '直线法' }, { value: '双倍余额递减法', label: '双倍余额递减法' }] },
          { name: 'useful_life_default', label: '默认年限（年）', type: 'number', value: '10' },
          { name: 'residual_rate_default', label: '默认残值率', type: 'number', value: '0.05' },
        ],
        onSubmit: async (vals) => {
          const rr = await API.post('/api/accounting/assets/categories', vals);
          if (rr.error) return UI.toast(rr.error, 'error');
          UI.toast('已保存', 'success'); await refresh();
        },
      });
    };
    await refresh();
  },

  async loadDepreciation(host, view) {
    const pid = this.accState.periodId;
    const refresh = async () => {
      const r = await API.get(`/api/accounting/assets/depreciation?period_id=${pid}`);
      if (r.error) return UI.toast(r.error, 'error');
      const rows = r.data || [];
      const total = rows.reduce((a, x) => a + Number(x.depreciation_amount || 0), 0);
      host.innerHTML = `
        <div class="actions" style="margin:10px 0">
          <button class="btn primary" id="dp-run">计提本期折旧并生成凭证</button>
          <span class="muted">本期合计 ${this.money(total)}</span>
        </div>
        ${rows.length ? UI.table([
          { key: 'code', label: '资产编号' },
          { key: 'name', label: '名称' },
          { key: 'depreciation_method', label: '折旧方法' },
          { key: 'depreciation_amount', label: '本期折旧', num: true },
          { key: 'accumulated_after', label: '累计折旧', num: true },
          { key: 'voucher_id', label: '凭证' },
        ], rows) : '<p class="muted">本期尚未计提折旧。</p>'}`;
      host.querySelector('#dp-run').onclick = async () => {
        const rr = await API.post('/api/accounting/assets/depreciation/run', { period_id: pid });
        if (rr.error) return UI.toast(rr.error, 'error');
        if (!rr.data.voucher_id) return UI.toast('本期无需计提（未到计提月份或已提足）', 'success');
        await API.post(`/api/accounting/vouchers/${rr.data.voucher_id}/audit`, {});
        await API.post(`/api/accounting/vouchers/${rr.data.voucher_id}/post`, {});
        UI.toast(`已计提并记账 ${rr.data.voucher_no}`, 'success');
        await refresh();
      };
    };
    await refresh();
  },

  async loadAssetReport(host, view) {
    const r = await API.get('/api/accounting/assets/summary');
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data || {};
    const lc = d.ledger_check || {};
    host.innerHTML = `
      <div class="stat-grid" style="margin:10px 0">
        <div class="stat-card"><div class="k">资产数</div><div class="v">${d.count || 0}</div></div>
        <div class="stat-card"><div class="k">原值合计</div><div class="v primary">${this.money(d.original)}</div></div>
        <div class="stat-card"><div class="k">累计折旧</div><div class="v">${this.money(d.accumulated)}</div></div>
        <div class="stat-card"><div class="k">净值合计</div><div class="v accent">${this.money(d.net)}</div></div>
      </div>
      <div class="card"><div class="card-title">按类别汇总</div>
        ${(d.by_category || []).length ? UI.table([
          { key: 'category', label: '类别' },
          { key: 'count', label: '数量', num: true },
          { key: 'original', label: '原值', num: true },
          { key: 'accumulated', label: '累计折旧', num: true },
          { key: 'net', label: '净值', num: true },
        ], d.by_category) : '<p class="muted">暂无数据。</p>'}
      </div>
      <div class="card"><div class="card-title">与总账核对</div>
        ${UI.table([
          { key: 'k', label: '项目' },
          { key: 'v', label: '金额' },
        ], [
          { k: '1601 固定资产（账载）', v: this.money(lc.asset_subject_1601) },
          { k: '资产卡片原值合计', v: this.money(d.original) },
          { k: '1602 累计折旧（账载）', v: this.money(lc.accum_depreciation_1602) },
          { k: '资产卡片累计折旧', v: this.money(d.accumulated) },
        ])}
        <p class="muted">差异应仅在「折旧凭证尚未记账」时出现；记账后原值差、累计折旧差应归零。</p>
      </div>`;
  },

  /* ---------- 旧账迁移与切换（M4） ---------- */

  async drawMigration(host, view) {
    host.innerHTML = `
      <div class="page-head"><h3>旧账迁移与切换</h3>
        <div class="actions">
          <button class="btn" id="mg-preview">预检</button>
          <button class="btn primary" id="mg-run">执行迁移</button>
          <button class="btn" id="mg-verify">校验对齐</button>
          <button class="btn" id="mg-seal">封存 / 解封</button>
        </div>
      </div>
      <p class="muted">把旧「资金往来 / 应收 / 应付」数据迁入会计账。<b>预检</b>只统计不写库，可反复执行；
      <b>迁移</b>幂等（同一笔只迁一次，生成的凭证直接记账）；完成后<b>校验</b>新旧余额是否对齐，确认无误再<b>封存</b>旧表（封存可逆）。</p>
      <div id="mg-state" class="card"></div>
      <div id="mg-out"></div>
    `;
    host.querySelector('#mg-preview').onclick = () => this.migPreview(host);
    host.querySelector('#mg-run').onclick = () => this.migRun(host);
    host.querySelector('#mg-verify').onclick = () => this.migVerify(host);
    host.querySelector('#mg-seal').onclick = () => this.migSeal(host);
    await this.migState(host);
  },

  async migState(host) {
    const box = host.querySelector('#mg-state');
    if (!box) return;
    const r = await API.get('/api/accounting/migration/state');
    if (r.error) { box.innerHTML = `<p class="muted">读取状态失败：${UI.esc(r.error)}</p>`; return; }
    const d = r.data || {};
    box.innerHTML = `
      <div class="card-title">迁移状态</div>
      <p>封存状态：<span class="${d.sealed ? 'tag tag-red' : 'tag tag-green'}">${d.sealed ? '已封存（旧表只读）' : '未封存（旧表可写）'}</span></p>
      <p class="muted">已迁移 ${d.migrated_rows || 0} 行${d.target_period_id ? ` ｜ 目标期间 #${d.target_period_id}` : ''}${d.sealed_at ? ` ｜ 封存于 ${UI.esc(d.sealed_at)}` : ''}</p>
    `;
  },

  async migPreview(host) {
    const out = host.querySelector('#mg-out');
    const r = await API('POST', '/api/accounting/migration/preview', { period_id: this.accState.periodId });
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data || {};
    const lr = d.legacy_rows || {};
    const rows = Object.keys(lr).map(k => ({
      t: k, total: lr[k].total, ok: lr[k].mappable, bad: lr[k].unmappable, amt: this.money(lr[k].amount),
    }));
    out.innerHTML = `
      <div class="card">
        <div class="card-title">预检结果（未写入任何数据）</div>
        ${rows.length ? UI.table([
          { key: 't', label: '旧表' }, { key: 'total', label: '行数' },
          { key: 'ok', label: '可迁' }, { key: 'bad', label: '不可迁' }, { key: 'amt', label: '金额合计' },
        ], rows) : '<p class="muted">旧表无数据。</p>'}
        <p>预计生成凭证：<b>${d.estimated_vouchers || 0}</b> 张${
          d.vouchers_by_type ? '（' + Object.keys(d.vouchers_by_type).map(k => k + ' ' + d.vouchers_by_type[k]).join(' / ') + '）' : ''
        }</p>
        ${(d.unmappable_sample && d.unmappable_sample.length)
          ? `<p class="muted">不可迁示例：${d.unmappable_sample.slice(0, 5).map(x => x.table + '#' + x.id + ' ' + UI.esc(x.reason)).join('；')}</p>` : ''}
        <p class="muted">${(d.warnings || []).map(w => '• ' + UI.esc(w)).join('<br>')}</p>
      </div>`;
  },

  async migRun(host) {
    const pid = this.accState.periodId;
    if (!pid) return UI.toast('请先在右上角选择会计期间', 'error');
    if (!confirm('确认执行迁移？将按旧单据生成历史凭证并直接记账。同一笔不会重复迁移。')) return;
    const out = host.querySelector('#mg-out');
    const r = await API('POST', '/api/accounting/migration/run', { period_id: pid });
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data || {};
    out.innerHTML = `
      <div class="card">
        <div class="card-title">迁移完成</div>
        <p>新增凭证：<b>${d.created}</b> 张 ｜ 跳过（已迁移）：${d.skipped} ｜ 期初写入：${d.opening_written} 行</p>
        ${(d.failed && d.failed.length)
          ? `<p class="muted">失败 ${d.failed.length} 项：${d.failed.slice(0, 3).map(f => f.table + '#' + f.id + ' ' + UI.esc(f.reason)).join('；')}</p>` : ''}
        ${d.unmappable ? `<p class="muted">另有 ${d.unmappable} 项不可迁，详见预检。</p>` : ''}
      </div>`;
    await this.migState(host);
  },

  async migVerify(host) {
    const out = host.querySelector('#mg-out');
    const r = await API.get('/api/accounting/migration/verify?period_id=' + this.accState.periodId);
    if (r.error) return UI.toast(r.error, 'error');
    const d = r.data || {};
    const line = (t, o) => `<tr><td>${t}</td><td style="text-align:right">${this.money(o.legacy)}</td>
      <td style="text-align:right">${this.money(o.accounting)}</td>
      <td style="text-align:right">${this.money(o.diff)}</td>
      <td>${o.aligned ? '一致' : '不一致'}</td></tr>`;
    out.innerHTML = `
      <div class="card">
        <div class="card-title">新旧余额对齐校验</div>
        <table class="table">
          <thead><tr><th>项目</th><th>旧表余额</th><th>会计账余额</th><th>差异</th><th>结论</th></tr></thead>
          <tbody>${d.ar ? line('应收账款', d.ar) : ''}${d.ap ? line('应付账款', d.ap) : ''}</tbody>
        </table>
        <p class="muted">${d.aligned ? '新旧余额一致，可以封存旧表。' : '存在差异：请检查是否有单据未迁移（跑一次预检看不可迁原因）。'}</p>
      </div>`;
  },

  async migSeal(host) {
    const r0 = await API.get('/api/accounting/migration/state');
    const sealed = r0.data && r0.data.sealed;
    if (sealed) {
      if (!confirm('旧表当前已封存。确认解封（恢复旧表可写）？')) return;
      const r = await API('POST', '/api/accounting/migration/unseal', {});
      if (r.error) return UI.toast(r.error, 'error');
      UI.toast('已解封，旧表恢复可写', 'success');
    } else {
      if (!confirm('确认封存？封存后「资金往来 / 应收 / 应付」只能看不能改，后续请改用会计模块记账。此操作可解封回滚。')) return;
      const r = await API('POST', '/api/accounting/migration/seal', { note: '会计页封存' });
      if (r.error) return UI.toast(r.error, 'error');
      UI.toast('已封存，旧表转为只读', 'success');
    }
    await this.migState(host);
  },
};
