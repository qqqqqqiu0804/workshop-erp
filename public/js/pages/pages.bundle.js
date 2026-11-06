/* ===== 本文件由 build-pages.js 自动生成，请勿直接编辑；改页面后运行 npm run build:pages ===== */

/* ===== /js/pages/dashboard.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages.dashboard = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [sum, mats] = await Promise.all([
      API.get('/api/stats/summary'),
      API.get('/api/materials')
    ]);
    const s = sum.data || {};
    const low = (mats.data || []).filter(m => m.is_low);

    const cards = [
      { k: '在职员工', v: s.active_employees, c: 'primary' },
      { k: '产品种类', v: s.products, c: 'primary' },
      { k: '物料种类', v: s.materials, c: 'primary' },
      { k: '今日产量', v: s.today_production, c: 'success' },
      { k: '本月产量', v: s.month_production, c: 'success' },
      { k: '库存预警', v: s.low_stock, c: 'danger' }
    ].map(c => `
      <div class="stat-card">
        <div class="k">${c.k}</div>
        <div class="v ${c.c}">${UI.esc(c.v)}</div>
      </div>`).join('');

    const lowRows = low.length ? low.map(m => `
      <tr><td>${UI.esc(m.name)}</td><td>${UI.esc(m.code)}</td>
      <td class="num">${UI.esc(Number(m.current_stock))} ${UI.esc(m.unit)}</td>
      <td class="num">${UI.esc(Number(m.safety_stock))}</td>
      <td><span class="badge badge-low">低于安全库存</span></td></tr>`).join('')
      : `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">库存充足</td></tr>`;

    view.innerHTML = `
      <div class="page-head"><h2>仪表盘</h2><span class="sub">车间今日整体概况</span></div>
      <div class="stat-grid">${cards}</div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">库存预警 <span class="sub">当前库存低于安全库存的物料</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>物料名称</th><th>编码</th><th class="num">当前库存</th><th class="num">安全库存</th><th>状态</th></tr></thead>
            <tbody>${lowRows}</tbody>
          </table>
        </div>
      </div>`;
  }
};

/* ===== /js/pages/employees.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages.employees = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [emps, teams] = await Promise.all([
      API.get('/api/employees'),
      API.get('/api/teams')
    ]);
    this.teams = teams.data || [];
    this.draw(view, emps.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'emp_no', label: '工号' },
      { key: 'name', label: '姓名' },
      { key: 'position', label: '岗位' },
      { key: 'team', label: '工序组', render: r => UI.esc(r.team_name || r.team || '—') },
      { key: 'phone', label: '电话' },
      { key: 'status', label: '状态', render: r => `<span class="badge ${r.status === '在职' ? '' : 'badge-warn'}">${UI.esc(r.status)}</span>` },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>员工管理</h2><span class="sub">维护车间人员基础信息与在职状态</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增员工</button>
      </div>
      <div class="card">${table}</div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const action = b.dataset.action, id = b.dataset.id;
    if (action === 'add') return this.openForm(view, null);
    if (action === 'edit') return this.openForm(view, Number(id));
    if (action === 'del') {
      if (await UI.confirm('确定删除该员工？此操作不可恢复，其关联业务记录将一并删除。')) {
        await API.del('/api/employees/' + id);
        UI.toast('已删除', 'success');
        this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let values = { status: '在职' };
    if (id) {
      const r = await API.get('/api/employees/' + id);
      values = r.data;
    }
    const teamOptions = [{ value: '', label: '— 未分组 —' }]
      .concat((this.teams || []).map(t => ({ value: t.id, label: t.name })));
    const fields = [
      { name: 'emp_no', label: '工号', required: true, value: values.emp_no },
      { name: 'name', label: '姓名', required: true, value: values.name },
      { name: 'position', label: '岗位', value: values.position },
      { name: 'team_id', label: '工序组', type: 'select', value: values.team_id || '',
        options: teamOptions },
      { name: 'phone', label: '电话', value: values.phone },
      { name: 'status', label: '状态', type: 'select', value: values.status || '在职',
        options: [{ value: '在职', label: '在职' }, { value: '离职', label: '离职' }] }
    ];
    const saved = await UI.formModal({
      title: id ? '编辑员工' : '新增员工',
      fields,
      onSubmit: async (v) => {
        // team_id 数字；同时带出组名写入 team 文本列（兼容旧字段）
        v.team_id = v.team_id === '' ? null : Number(v.team_id);
        const t = (this.teams || []).find(x => x.id === v.team_id);
        v.team = t ? t.name : '';
        if (id) await API.put('/api/employees/' + id, v);
        else await API.post('/api/employees', v);
        UI.toast('已保存', 'success');
        this.render(view);
      }
    });
    void saved;
  }
};

/* ===== /js/pages/products.js ===== */
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

/* ===== /js/pages/inventory.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages.inventory = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [mats, mv] = await Promise.all([
      API.get('/api/materials'),
      API.get('/api/materials/movements?limit=100')
    ]);
    this.draw(view, mats.data, mv.data);
  },

  draw(view, rows, movements) {
    const table = UI.table([
      { key: 'name', label: '物料名称' },
      { key: 'code', label: '编码' },
      { key: 'spec', label: '规格' },
      { key: 'unit', label: '单位' },
      { key: 'current_stock', label: '当前库存', num: true, render: r => `<b class="${r.is_low ? 'badge-low' : ''}" style="${r.is_low ? 'color:var(--danger)' : ''}">${UI.esc(Number(r.current_stock))}</b>` },
      { key: 'safety_stock', label: '安全库存', num: true },
      { label: '状态', render: r => r.is_low ? `<span class="badge badge-low">预警</span>` : `<span class="badge badge-completed">正常</span>` },
      { label: '操作', render: r => `
        <button class="btn btn-xs btn-success" data-action="in" data-id="${r.id}">入库</button>
        <button class="btn btn-xs" data-action="out" data-id="${r.id}">出库</button>
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    const mvRows = movements.map(m => `
      <tr><td>${m.type === 'in' ? '<span class="badge badge-completed">入库</span>' : '<span class="badge badge-producing">出库</span>'}</td>
      <td>${UI.esc(m.material_name)}</td>
      <td class="num">${UI.esc(Number(m.qty))} ${UI.esc(m.unit || '')}</td>
      <td>${UI.esc(m.date)}</td>
      <td>${UI.esc(m.counterparty || '')}</td>
      <td>${UI.esc(m.operator || '')}</td></tr>`).join('')
      || `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">暂无出入库记录</td></tr>`;

    view.innerHTML = `
      <div class="page-head">
        <h2>原料库存</h2><span class="sub">物料入库 / 出库与实时库存预警</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增物料</button>
      </div>
      <div class="card">${table}</div>

      <div class="card">
        <div class="card-title">出入库流水 <span class="sub">最近记录</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>类型</th><th>物料</th><th class="num">数量</th><th>日期</th><th>对方/用途</th><th>经手人</th></tr></thead>
          <tbody>${mvRows}</tbody></table></div>
      </div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, id);
    if (a === 'del') {
      if (await UI.confirm('删除该物料？其出入库记录也会删除。')) {
        await API.del('/api/materials/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
      return;
    }
    if (a === 'in') return this.openStock(view, id, 'in');
    if (a === 'out') return this.openStock(view, id, 'out');
  },

  async openForm(view, id) {
    let v = { unit: '个', safety_stock: 0 };
    if (id) v = (await API.get('/api/materials/' + id)).data;
    const fields = [
      { name: 'code', label: '物料编码', required: true, value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'spec', label: '规格', value: v.spec },
      { name: 'unit', label: '单位', value: v.unit },
      { name: 'safety_stock', label: '安全库存', type: 'number', min: 0, step: 'any', value: v.safety_stock },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑物料' : '新增物料', fields, onSubmit: async (val) => {
      if (id) await API.put('/api/materials/' + id, val);
      else await API.post('/api/materials', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  },

  async openStock(view, id, kind) {
    const mat = (await API.get('/api/materials/' + id)).data;
    const fields = kind === 'in'
      ? [
          { name: 'qty', label: '入库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'unit_price', label: '单价(可选)', type: 'number', min: 0, step: 'any' },
          { name: 'supplier', label: '供应商', value: '' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ]
      : [
          { name: 'qty', label: '出库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'purpose', label: '用途', value: '' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ];
    await UI.formModal({
      title: `${kind === 'in' ? '入库' : '出库'}：${mat.name}`,
      fields,
      onSubmit: async (val) => {
        if (kind === 'in') await API.post(`/api/materials/${id}/stock-in`, val);
        else await API.post(`/api/materials/${id}/stock-out`, val);
        UI.toast(kind === 'in' ? '入库成功' : '出库成功', 'success');
        this.render(view);
      }
    });
  }
};

/* ===== /js/pages/finished-goods.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['finished-goods'] = {
  curLoc: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    const [fgs, locs, mv] = await Promise.all([
      API.get('/api/finished-goods' + (this.curLoc ? '?location_id=' + this.curLoc : '')),
      API.get('/api/finished-goods/locations'),
      API.get('/api/finished-goods/movements?limit=100')
    ]);
    this.draw(view, fgs.data, locs.data, mv.data);
  },

  draw(view, rows, locs, movements) {
    const locOpts = [{ value: '', label: '全部库位' }].concat(
      locs.map(l => ({ value: String(l.id), label: `${l.code} ${l.name}` }))
    );
    const table = UI.table([
      { key: 'code', label: '成品编码' },
      { key: 'name', label: '名称' },
      { key: 'spec', label: '规格' },
      { key: 'unit', label: '单位' },
      { key: 'location_name', label: '库位', render: r => r.location_code
        ? `${UI.esc(r.location_code)} ${UI.esc(r.location_name || '')}` : '<span class="muted">未定位</span>' },
      { key: 'current_stock', label: '当前库存', num: true, render: r => `<b>${UI.esc(Number(r.current_stock))}</b>` },
      { key: 'status', label: '状态' },
      { label: '操作', render: r => `
        <button class="btn btn-xs btn-success" data-action="in" data-id="${r.id}">入库</button>
        <button class="btn btn-xs" data-action="out" data-id="${r.id}">出库</button>
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    const mvRows = movements.map(m => `
      <tr><td>${m.type === 'in' ? '<span class="badge badge-completed">入库</span>' : '<span class="badge badge-producing">出库</span>'}</td>
      <td>${UI.esc(m.fg_name)}</td>
      <td class="num">${UI.esc(Number(m.qty))} ${UI.esc(m.unit || '')}</td>
      <td>${UI.esc(m.date)}</td>
      <td>${UI.esc(m.counterparty || '')}</td>
      <td>${UI.esc(m.operator || '')}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">暂无出入库记录</td></tr>';

    const locSel = locOpts.map(o =>
      `<option value="${UI.esc(o.value)}" ${String(o.value) === String(this.curLoc) ? 'selected' : ''}>${UI.esc(o.label)}</option>`
    ).join('');

    view.innerHTML = `
      <div class="page-head">
        <h2>成品库存</h2><span class="sub">成品入库 / 出库 / 库位 / 盘点（实时库存）</span>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          <select class="select" id="locFilter">${locSel}</select>
          <button class="btn" data-action="locs">库位管理</button>
          <button class="btn" data-action="count">新建盘点单</button>
          <button class="btn btn-primary" data-action="add">+ 新增成品</button>
        </div>
      </div>
      <div class="card">${table}</div>
      <div class="card">
        <div class="card-title">出入库流水 <span class="sub">最近记录</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>类型</th><th>成品</th><th class="num">数量</th><th>日期</th><th>对方/用途</th><th>经手人</th></tr></thead>
          <tbody>${mvRows}</tbody></table></div>
      </div>`;

    view.querySelector('#locFilter').onchange = (e) => { this.curLoc = e.target.value; this.render(view); };
    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, id);
    if (a === 'locs') return this.openLocations(view);
    if (a === 'count') return this.openCount(view);
    if (a === 'del') {
      if (await UI.confirm('删除该成品？其出入库记录也会删除。')) {
        await API.del('/api/finished-goods/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
      return;
    }
    if (a === 'in') return this.openStock(view, id, 'in');
    if (a === 'out') return this.openStock(view, id, 'out');
  },

  async openForm(view, id) {
    let v = { unit: '个', status: '在库' };
    if (id) v = (await API.get('/api/finished-goods/' + id)).data;
    const [locs, prods] = await Promise.all([
      API.get('/api/finished-goods/locations'),
      API.get('/api/products')
    ]);
    const locOpts = [{ value: '', label: '（未定位）' }].concat(
      locs.data.map(l => ({ value: String(l.id), label: `${UI.esc(l.code)} ${UI.esc(l.name)}` }))
    );
    const prodOpts = [{ value: '', label: '（不关联产品）' }].concat(
      prods.data.map(p => ({ value: String(p.id), label: `[${UI.esc(p.code)}] ${UI.esc(p.name)}` }))
    );
    const fields = [
      { name: 'code', label: '成品编码', required: true, value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'spec', label: '规格', value: v.spec },
      { name: 'unit', label: '单位', value: v.unit },
      { name: 'product_id', label: '关联产品', type: 'select', options: prodOpts, value: v.product_id ? String(v.product_id) : '' },
      { name: 'location_id', label: '默认库位', type: 'select', options: locOpts, value: v.location_id ? String(v.location_id) : '' },
      { name: 'status', label: '状态', type: 'select', options: [{ value: '在库', label: '在库' }, { value: '停用', label: '停用' }], value: v.status },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑成品' : '新增成品', fields, onSubmit: async (val) => {
      val.location_id = val.location_id ? Number(val.location_id) : null;
      val.product_id = val.product_id ? Number(val.product_id) : null;
      if (id) await API.put('/api/finished-goods/' + id, val);
      else await API.post('/api/finished-goods', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  },

  async openStock(view, id, kind) {
    const fg = (await API.get('/api/finished-goods/' + id)).data;
    const fields = kind === 'in'
      ? [
          { name: 'qty', label: '入库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'unit_price', label: '单价(可选)', type: 'number', min: 0, step: 'any' },
          { name: 'source', label: '来源', value: '完工入库' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ]
      : [
          { name: 'qty', label: '出库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'purpose', label: '用途', value: '' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ];
    await UI.formModal({ title: `${kind === 'in' ? '入库' : '出库'}：${fg.name}`, fields, onSubmit: async (val) => {
      if (kind === 'in') await API.post(`/api/finished-goods/${id}/stock-in`, val);
      else await API.post(`/api/finished-goods/${id}/stock-out`, val);
      UI.toast(kind === 'in' ? '入库成功' : '出库成功', 'success');
      this.render(view);
    }});
  },

  async openLocations(view) {
    const locs = (await API.get('/api/finished-goods/locations')).data;
    const rows = locs.map(l =>
      `<tr><td>${UI.esc(l.code)}</td><td>${UI.esc(l.name)}</td><td>${UI.esc(l.area || '')}</td><td>${UI.esc(l.remark || '')}</td></tr>`
    ).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">暂无库位，先新增</td></tr>';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:640px">
        <div class="modal-head">库位管理 <span class="sub">成品堆放分区</span></div>
        <div class="modal-body">
          <div class="table-wrap"><table class="table"><thead><tr><th>编码</th><th>名称</th><th>区域</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></div>
          <div class="form-grid" style="margin-top:12px">
            <input class="input" id="lc_code" placeholder="库位编码(如 A-01)" />
            <input class="input" id="lc_name" placeholder="名称(如 A区01架)" />
            <input class="input" id="lc_area" placeholder="区域(如 成品区)" />
            <input class="input" id="lc_remark" placeholder="备注" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="close">关闭</button>
          <button class="btn btn-primary" data-act="add">+ 新增库位</button>
        </div>
      </div>`;
    document.getElementById('modalHost').appendChild(overlay);
    overlay.querySelector('[data-act=close]').onclick = () => overlay.remove();
    overlay.querySelector('[data-act=add]').onclick = async () => {
      const code = overlay.querySelector('#lc_code').value.trim();
      const name = overlay.querySelector('#lc_name').value.trim();
      if (!code || !name) { UI.toast('编码和名称必填', 'error'); return; }
      try {
        await API.post('/api/finished-goods/locations', {
          code, name,
          area: overlay.querySelector('#lc_area').value.trim(),
          remark: overlay.querySelector('#lc_remark').value.trim()
        });
        UI.toast('已新增', 'success');
        overlay.remove();
        this.openLocations(view);
      } catch (err) { UI.toast(err.message, 'error'); }
    };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  },

  async openCount(view) {
    const fields = [
      { name: 'date', label: '盘点日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'operator', label: '盘点人', value: '' },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];
    await UI.formModal({ title: '新建盘点单', fields, submitText: '生成快照', onSubmit: async (val) => {
      const head = (await API.post('/api/inventory-count', val)).data;
      this.openCountDetail(view, head.id);
    }});
  },

  async openCountDetail(view, countId) {
    const { head, items } = (await API.get('/api/inventory-count/' + countId)).data;
    const rows = items.map(it => `
      <tr>
        <td>${UI.esc(it.fg_code)}</td>
        <td>${UI.esc(it.fg_name)}</td>
        <td class="num">${UI.esc(Number(it.book_qty))}</td>
        <td><input class="input" type="number" step="any" id="act_${it.id}" value="${it.actual_qty !== null ? it.actual_qty : ''}" placeholder="实点" style="width:90px"/></td>
        <td class="num" id="diff_${it.id}">${it.diff !== null ? UI.esc(Number(it.diff)) : ''}</td>
      </tr>`).join('');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:760px">
        <div class="modal-head">盘点单 ${UI.esc(head.count_no)} <span class="sub">状态：${UI.esc(head.status)}</span></div>
        <div class="modal-body">
          <div class="table-wrap"><table class="table"><thead><tr><th>编码</th><th>名称</th><th class="num">账面</th><th>实点</th><th class="num">差异</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="close">关闭</button>
          <button class="btn" data-act="save">保存实点</button>
          <button class="btn btn-primary" data-act="apply">应用差异(调库存)</button>
        </div>
      </div>`;
    document.getElementById('modalHost').appendChild(overlay);
    overlay.querySelector('[data-act=close]').onclick = () => overlay.remove();
    overlay.querySelector('[data-act=save]').onclick = async () => {
      const payload = { items: items.map(it => ({ id: it.id, book_qty: it.book_qty, actual_qty: overlay.querySelector('#act_' + it.id).value })) };
      await API.put('/api/inventory-count/' + countId + '/items', payload);
      UI.toast('已保存实点', 'success');
      overlay.remove();
      this.openCountDetail(view, countId);
    };
    overlay.querySelector('[data-act=apply]').onclick = async () => {
      if (!await UI.confirm('应用差异将自动调整库存（溢余入库 / 盘亏出库），确认？')) return;
      try {
        await API.post('/api/inventory-count/' + countId + '/apply', { date: head.date, operator: head.operator });
        UI.toast('差异已应用', 'success');
        overlay.remove();
        this.render(view);
      } catch (err) { UI.toast(err.message, 'error'); }
    };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  }
};

/* ===== /js/pages/suppliers.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages.suppliers = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/suppliers');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'code', label: '编码' },
      { key: 'name', label: '名称', render: r => `<b>${UI.esc(r.name)}</b>` },
      { key: 'type', label: '类型', render: r => `<span class="badge">${UI.esc(r.type)}</span>` },
      { key: 'contact', label: '联系人' },
      { key: 'tax_no', label: '税号' },
      { key: 'po_count', label: '采购单数', num: true },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>供应商</h2><span class="sub">采购来源主数据（取代原料入库的自由文本供应商）</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增供应商</button>
      </div>
      <div class="card">${table}</div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, id);
    if (a === 'del') {
      if (await UI.confirm('删除该供应商？其采购单也将删除。')) {
        await API.del('/api/suppliers/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let v = { type: '材料' };
    if (id) v = (await API.get('/api/suppliers/' + id)).data;
    const fields = [
      { name: 'code', label: '编码', value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'type', label: '类型', type: 'select', value: v.type, options: [
        { value: '材料', label: '材料' }, { value: '外协', label: '外协' }, { value: '其他', label: '其他' }
      ] },
      { name: 'contact', label: '联系人', value: v.contact },
      { name: 'tax_no', label: '税号', value: v.tax_no },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑供应商' : '新增供应商', fields, onSubmit: async (val) => {
      if (id) await API.put('/api/suppliers/' + id, val);
      else await API.post('/api/suppliers', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  }
};

/* ===== /js/pages/purchase-orders.js ===== */
'use strict';

window.Pages = window.Pages || {};

/* 轻量自定义弹窗（不带 showModal 的默认关闭按钮，自己控制脚注） */
function poModal({ title, html, maxWidth }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:${maxWidth || 720}px">
    <div class="modal-head">${UI.esc(title)}</div>
    <div class="modal-body">${html}</div></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modalHost').appendChild(overlay);
  return overlay;
}

function poStatusBadge(s) {
  const map = { '待到货': 'badge-pending', '部分到货': 'badge-producing', '已到货': 'badge-completed', '作废': 'badge-warn' };
  return `<span class="badge ${map[s] || ''}">${UI.esc(s)}</span>`;
}

Pages['purchase-orders'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/purchase-orders');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'po_no', label: '采购单号', render: r => `<b>${UI.esc(r.po_no)}</b>` },
      { key: 'supplier_name', label: '供应商' },
      { key: 'order_date', label: '下单日期' },
      { key: 'status', label: '状态', render: r => poStatusBadge(r.status) },
      { key: 'ordered_total', label: '订购', num: true, render: r => `${UI.esc(Number(r.ordered_total))}` },
      { key: 'received_total', label: '已到', num: true, render: r => `<b>${UI.esc(Number(r.received_total))}</b>` },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="view" data-id="${r.id}">明细</button>
        ${r.status !== '作废' ? `<button class="btn btn-xs btn-success" data-action="receive" data-id="${r.id}">到货</button>` : ''}
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>采购单</h2><span class="sub">采购来源 → 到货入库（回写已收、实时库存）</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新建采购单</button>
      </div>
      <div class="card">${table}</div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openCreate(view);
    if (a === 'view') return this.openView(view, id);
    if (a === 'receive') return this.openReceive(view, id);
    if (a === 'del') {
      if (await UI.confirm('删除该采购单？其明细将一并删除。')) {
        await API.del('/api/purchase-orders/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openCreate(view) {
    const [sups, mats] = await Promise.all([API.get('/api/suppliers'), API.get('/api/materials')]);
    if (!sups.data.length) { UI.toast('请先到「供应商」页新增供应商', 'error'); return; }
    if (!mats.data.length) { UI.toast('请先有材料档案', 'error'); return; }
    const supOpts = sups.data.map(s => `<option value="${s.id}">${UI.esc(s.name)}</option>`).join('');
    const matOpts = mats.data.map(m => `<option value="${m.id}">${UI.esc(m.name)}（${UI.esc(m.code)}）</option>`).join('');
    const rowHtml = () => `
      <div class="po-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <select class="select po-mat" style="flex:3">${matOpts}</select>
        <input class="input po-qty" type="number" min="0" step="any" placeholder="数量" style="flex:1;width:auto" />
        <input class="input po-price" type="number" min="0" step="any" placeholder="单价" style="flex:1;width:auto" />
        <button class="btn btn-xs btn-danger po-rm">删</button>
      </div>`;
    let counter = 0;
    const overlay = poModal({ title: '新建采购单', maxWidth: 760, html: `
      <div class="form-grid">
        <div class="field" style="grid-column:1/2"><label>供应商<span class="req">*</span></label><select class="select" id="poSup">${supOpts}</select></div>
        <div class="field"><label>下单日期<span class="req">*</span></label><input class="input" id="poDate" type="date" value="${DateUtil.today()}" /></div>
        <div class="field"><label>期望到货</label><input class="input" id="poExpect" type="date" /></div>
        <div class="field" style="grid-column:1/-1"><label>备注</label><input class="input" id="poRemark" placeholder="可选" /></div>
      </div>
      <div class="card-title" style="margin:12px 0 8px">采购明细 <button class="btn btn-xs" id="poAdd">+ 添加明细</button></div>
      <div id="poItems">${rowHtml()}</div>
      <div class="modal-foot" style="margin-top:12px">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="ok">创建采购单</button>
      </div>` });
    counter++;
    const container = overlay.querySelector('#poItems');
    overlay.querySelector('#poAdd').addEventListener('click', () => { container.insertAdjacentHTML('beforeend', rowHtml()); });
    container.addEventListener('click', (e) => {
      if (e.target.classList.contains('po-rm')) { const row = e.target.closest('.po-row'); if (container.children.length > 1) row.remove(); }
    });
    overlay.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (act === 'cancel') { overlay.remove(); return; }
      if (act === 'ok') {
        const supplier_id = overlay.querySelector('#poSup').value;
        const order_date = overlay.querySelector('#poDate').value;
        const expect_date = overlay.querySelector('#poExpect').value;
        const remark = overlay.querySelector('#poRemark').value;
        const items = [...container.querySelectorAll('.po-row')].map(r => ({
          material_id: r.querySelector('.po-mat').value,
          qty: r.querySelector('.po-qty').value,
          unit_price: r.querySelector('.po-price').value
        })).filter(it => it.qty !== '' && Number(it.qty) > 0);
        if (!items.length) { UI.toast('请至少填一条有数量的明细', 'error'); return; }
        try {
          const po = await API.post('/api/purchase-orders', { supplier_id, order_date, expect_date, remark, items });
          overlay.remove(); UI.toast('采购单已创建：' + po.data.po_no, 'success'); this.render(view);
        } catch (err) { UI.toast(err.message || '创建失败', 'error'); }
      }
    });
  },

  async openView(view, id) {
    const po = (await API.get('/api/purchase-orders/' + id)).data;
    const rows = po.items.map(it => `
      <tr><td>${UI.esc(it.material_name)}</td><td>${UI.esc(it.material_code || '')}</td>
      <td class="num">${UI.esc(Number(it.qty))}</td><td class="num">${UI.esc(Number(it.received_qty))}</td>
      <td>${UI.esc(it.unit_price != null ? Number(it.unit_price) : '—')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">无明细</td></tr>';
    poModal({ title: `采购单明细：${po.po_no}`, maxWidth: 640, html: `
      <div class="kv" style="margin-bottom:10px">
        <span>供应商：<b>${UI.esc(po.supplier_name)}</b></span>
        <span>下单：${UI.esc(po.order_date)}</span>
        <span>状态：${poStatusBadge(po.status)}</span>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>物料</th><th>编码</th><th class="num">订购</th><th class="num">已收</th><th>单价</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` });
  },

  async openReceive(view, id) {
    const po = (await API.get('/api/purchase-orders/' + id)).data;
    if (po.status === '作废') { UI.toast('作废单不可到货', 'error'); return; }
    const rowsHtml = po.items.map(it => `
      <div class="rcv-row" data-item="${it.id}" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <div style="flex:3"><div>${UI.esc(it.material_name)}（${UI.esc(it.material_code || '')}）</div>
          <div class="muted" style="font-size:12px">订购 ${UI.esc(Number(it.qty))}${UI.esc(it.unit || '')} / 已收 ${UI.esc(Number(it.received_qty))}</div></div>
        <input class="input rcv-qty" type="number" min="0" step="any" style="flex:1;width:auto"
          value="${Math.max(0, Number(it.qty) - Number(it.received_qty))}" placeholder="本次到货" />
      </div>`).join('') || '<div class="muted">无明细</div>';
    const overlay = poModal({ title: `到货登记：${po.po_no}`, maxWidth: 640, html: `
      <div class="form-grid">
        <div class="field"><label>到货日期<span class="req">*</span></label><input class="input" id="rcvDate" type="date" value="${DateUtil.today()}" /></div>
        <div class="field"><label>经手人</label><input class="input" id="rcvOp" /></div>
      </div>
      <div class="field" style="margin:6px 0"><label>备注</label><input class="input" id="rcvRemark" /></div>
      <div class="card-title" style="margin:8px 0">到货明细（默认填剩余未到量）</div>
      <div id="rcvItems">${rowsHtml}</div>
      <div class="modal-foot" style="margin-top:12px">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-primary" data-act="ok">确认到货</button>
      </div>` });
    overlay.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (act === 'cancel') { overlay.remove(); return; }
      if (act === 'ok') {
        const date = overlay.querySelector('#rcvDate').value;
        const operator = overlay.querySelector('#rcvOp').value;
        const remark = overlay.querySelector('#rcvRemark').value;
        const items = [...overlay.querySelectorAll('.rcv-row')].map(r => ({
          po_item_id: r.dataset.item,
          qty: r.querySelector('.rcv-qty').value
        })).filter(it => it.qty !== '' && Number(it.qty) > 0);
        if (!items.length) { UI.toast('请至少填一条到货数量', 'error'); return; }
        try {
          await API.post(`/api/purchase-orders/${id}/receive`, { date, operator, remark, items });
          overlay.remove(); UI.toast('到货已登记，库存已更新', 'success'); this.render(view);
        } catch (err) { UI.toast(err.message || '到货失败', 'error'); }
      }
    });
  }
};

/* ===== /js/pages/production-tasks.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['production-tasks'] = {
  filterStatus: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    await this.drawList(view);
  },

  statusBadge(s) {
    const map = { '待开工': 'badge-producing', '进行中': 'badge-producing', '已完成': 'badge-completed', '已作废': 'badge' };
    return `<span class="badge ${map[s] || 'badge'}">${UI.esc(s)}</span>`;
  },

  bar(pct, accent) {
    return `<div class="bar-track"><div class="bar-fill ${accent ? 'accent' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;
  },

  async drawList(view) {
    const q = this.filterStatus ? '?status=' + encodeURIComponent(this.filterStatus) : '';
    const list = await API.get('/api/production-tasks' + q);
    const rows = list.data || [];
    const tableRows = rows.map(t => {
      const plan = Number(t.plan_qty), fin = Number(t.finished_qty);
      const pct = plan > 0 ? Math.round(fin / plan * 100) : 0;
      const prod = t.product_name || (t.product_code ? ('[' + t.product_code + ']') : '（未关联产品）');
      return `<tr data-id="${t.id}">
        <td>${UI.esc(t.task_no)}</td>
        <td>${UI.esc(prod)}</td>
        <td class="num">${UI.esc(plan)} ${UI.esc(t.unit || '')}</td>
        <td class="num">${UI.esc(fin)}</td>
        <td class="min-w-140">${this.bar(pct, pct >= 100)}<span class="sub">${pct}%</span></td>
        <td>${this.statusBadge(t.status)}</td>
        <td>${UI.esc(t.due_date || '—')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted empty-row">暂无任务单，点「+ 新建任务单」建立第一张</td></tr>';

    const statusOpts = ['', '待开工', '进行中', '已完成', '已作废']
      .map(s => `<option value="${s}" ${s === this.filterStatus ? 'selected' : ''}>${s || '全部状态'}</option>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h2>生产任务单</h2><span class="sub">任务单 + 逐道工序报工（P1）</span>
        <div class="inline-ops">
          <select class="select" id="ptStatus">${statusOpts}</select>
          <button class="btn btn-primary" data-action="add">+ 新建任务单</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>任务单号</th><th>产品</th><th class="num">计划</th><th class="num">已完工</th><th>进度</th><th>状态</th><th>交期</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#ptStatus').onchange = e => { this.filterStatus = e.target.value; this.drawList(view); };
    view.querySelector('tbody').onclick = e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.openDetail(view, Number(tr.dataset.id));
    };
    view.querySelector('[data-action=add]').onclick = () => this.openCreate(view);
  },

  async openCreate(view) {
    const [products, teams] = await Promise.all([API.get('/api/products'), API.get('/api/teams')]);
    const prodOpts = [{ value: '', label: '（不关联 / 后补）' }]
      .concat((products.data || []).map(p => ({ value: String(p.id), label: `${UI.esc(p.code)} ${UI.esc(p.name)}` })));
    const teamOpts = (teams.data || [])
      .filter(t => ['auto', 'swiss', 'inspect', 'pack'].includes(t.slug))
      .map(t => ({ value: t.slug, label: t.name }));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const ops = []; // { name, team_slug, planned_qty }
    let opBody;

    const renderOps = () => {
      const rows = ops.map((o, i) => `<tr>
        <td><input class="input w-120" id="op_name_${i}" value="${UI.esc(o.name)}" placeholder="如 自动车"/></td>
        <td><select class="select" id="op_team_${i}">${teamOpts.map(t => `<option value="${t.value}" ${t.value === o.team_slug ? 'selected' : ''}>${UI.esc(t.label)}</option>`).join('')}</select></td>
        <td><input class="input w-90" type="number" step="any" id="op_qty_${i}" value="${o.planned_qty}"/></td>
        <td><button class="btn btn-xs btn-danger" data-delop="${i}">删</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">尚未添加工序</td></tr>';
      opBody.innerHTML = `<table class="table"><thead><tr><th>工序名</th><th>归属车间</th><th>计划量</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
      overlay.querySelectorAll('[data-delop]').forEach(b => b.onclick = () => {
        ops.splice(Number(b.dataset.delop), 1); renderOps();
      });
    };

    overlay.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-head">新建生产任务单</div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field"><label>产品</label><select class="select" id="pt_product">${prodOpts.map(o => `<option value="${o.value}">${UI.esc(o.label)}</option>`).join('')}</select></div>
            <div class="field"><label>计划产量<span class="req">*</span></label><input class="input" type="number" step="any" id="pt_plan" placeholder="如 1000"/></div>
            <div class="field"><label>单位</label><input class="input" id="pt_unit" value="件"/></div>
            <div class="field"><label>交期</label><input class="input" type="date" id="pt_due"/></div>
            <div class="field"><label>优先级</label><select class="select" id="pt_prio"><option>普通</option><option>急</option></select></div>
            <div class="field"><label>备注</label><input class="input" id="pt_remark" placeholder="可选"/></div>
          </div>
          <div class="mt-12"><b>工序路线</b>
            <button class="btn btn-xs" id="pt_addop">+ 添加工序</button>
            <span class="sub">留空则默认 自动车 → 走心机 → 品检 → 包装</span>
          </div>
          <div id="pt_ops" class="mt-8"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-primary" data-act="ok">创建</button>
        </div>
      </div>`;
    document.getElementById('modalHost').appendChild(overlay);
    opBody = overlay.querySelector('#pt_ops');
    renderOps();

    overlay.querySelector('#pt_addop').onclick = () => {
      ops.push({ name: '', team_slug: teamOpts[0] ? teamOpts[0].value : 'auto', planned_qty: '' });
      renderOps();
    };
    overlay.querySelector('[data-act=cancel]').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('[data-act=ok]').onclick = async () => {
      ops.forEach((o, i) => {
        o.name = overlay.querySelector('#op_name_' + i).value.trim();
        o.team_slug = overlay.querySelector('#op_team_' + i).value;
        o.planned_qty = overlay.querySelector('#op_qty_' + i).value;
      });
      const plan = Number(overlay.querySelector('#pt_plan').value);
      if (!(plan > 0)) { UI.toast('计划产量必须大于 0', 'error'); return; }
      const payload = {
        product_id: overlay.querySelector('#pt_product').value ? Number(overlay.querySelector('#pt_product').value) : null,
        plan_qty: plan,
        unit: overlay.querySelector('#pt_unit').value || '件',
        due_date: overlay.querySelector('#pt_due').value || null,
        priority: overlay.querySelector('#pt_prio').value,
        remark: overlay.querySelector('#pt_remark').value || null,
        operations: ops.filter(o => o.name && Number(o.planned_qty) > 0)
          .map(o => ({ name: o.name, team_slug: o.team_slug, planned_qty: Number(o.planned_qty) }))
      };
      try {
        await API.post('/api/production-tasks', payload);
        UI.toast('任务单已创建', 'success');
        overlay.remove();
        this.drawList(view);
      } catch (err) { UI.toast(err.message, 'error'); }
    };
  },

  async openDetail(view, id) {
    view.innerHTML = UI.spinner();
    const { data } = await API.get('/api/production-tasks/' + id);
    const task = data.task, ops = data.operations, recent = data.recent;

    const opCards = ops.map(o => {
      const planned = Number(o.planned_qty), rep = Number(o.reported_qty);
      const pct = planned > 0 ? Math.round(rep / planned * 100) : 0;
      return `<div class="sub-block">
        <div class="flex-between">
          <b>第${o.seq}道 · ${UI.esc(o.name)}</b>
          <span class="sub">${UI.esc(rep)} / ${UI.esc(planned)} ${UI.esc(task.unit)}</span>
        </div>
        ${this.bar(pct, pct >= 100)}
        <div class="mt-8"><button class="btn btn-xs btn-success" data-action="report" data-op="${o.id}">＋ 报工</button></div>
      </div>`;
    }).join('') || '<div class="empty">无工序</div>';

    const recRows = recent.map(r => `<tr>
      <td>${UI.esc(r.date)}</td>
      <td>第${UI.esc(r.op_seq)}道 ${UI.esc(r.op_name)}</td>
      <td>${UI.esc(r.machine_name || (machineCircle(r.machine_number) + ' 号'))}</td>
      <td>${UI.esc(r.team_name || '')}</td>
      <td>${UI.esc(r.employee || '—')}</td>
      <td class="num">${UI.esc(Number(r.qty))}</td>
      <td>${UI.esc(r.remark || '')}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted empty-row">暂无报工记录</td></tr>';

    view.innerHTML = `
      <div class="page-head">
        <h2>任务单 ${UI.esc(task.task_no)}</h2> ${this.statusBadge(task.status)}
        <div class="inline-ops">
          <button class="btn" data-action="back">← 返回</button>
          ${task.status !== '已完成' && task.status !== '已作废' ? '<button class="btn btn-primary" data-action="complete">完工入库</button>' : ''}
        </div>
      </div>
      <div class="card"><div class="card-title">基本信息</div>
        产品：${UI.esc(task.product_name || '（未关联）')} ｜ 计划：${UI.esc(Number(task.plan_qty))} ${UI.esc(task.unit)} ｜ 交期：${UI.esc(task.due_date || '—')} ｜ 优先级：${UI.esc(task.priority)} ｜ 备注：${UI.esc(task.remark || '—')}
      </div>
      <div class="card"><div class="card-title">工序路线与报工</div>${opCards}</div>
      <div class="card"><div class="card-title">报工记录</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>日期</th><th>工序</th><th>机台</th><th>车间</th><th>员工</th><th class="num">产量</th><th>备注</th></tr></thead><tbody>${recRows}</tbody></table></div>
      </div>`;

    view.querySelector('[data-action=back]').onclick = () => this.drawList(view);
    const comp = view.querySelector('[data-action=complete]');
    if (comp) comp.onclick = () => this.openComplete(view, id);
    view.querySelectorAll('[data-action=report]').forEach(b => b.onclick = () => this.openReport(view, id, Number(b.dataset.op)));
  },

  async openReport(view, taskId, opId) {
    const [machines, employees] = await Promise.all([
      API.get('/api/machines'),
      API.get('/api/employees?status=在职')
    ]);
    const machOpts = (machines.data || []).map(m => ({
      value: String(m.id),
      label: `${m.name || (machineCircle(m.number) + ' 号')}（${m.team_name || ''}）`
    }));
    const empOpts = (employees.data || []).map(e => ({ value: String(e.id), label: `${e.name}（${e.emp_no}）` }));
    // 班次默认按当前时间推断（白班 08:00–20:00；20:00–20:30 交接重叠段由人工选择，拍板口径）
    const h = new Date().getHours();
    const defaultShift = (h >= 8 && h < 20) ? '白班' : '夜班';
    const fields = [
      { name: 'machine_id', label: '机台', type: 'select', required: true, options: machOpts },
      { name: 'employee_id', label: '员工', type: 'select', options: [{ value: '', label: '— 不指定 —' }].concat(empOpts) },
      { name: 'qty', label: '本次产量', type: 'number', required: true, min: 0, step: 'any' },
      { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'shift', label: '班次', type: 'select', value: defaultShift, options: [
        { value: '白班', label: '白班（08:00–20:30）' },
        { value: '夜班', label: '夜班（20:00–08:00）' },
      ] },
      { name: 'remark', label: '备注', type: 'textarea' }
    ];
    await UI.formModal({
      title: '工序报工',
      fields,
      onSubmit: async (v) => {
        v.machine_id = Number(v.machine_id);
        v.employee_id = v.employee_id ? Number(v.employee_id) : null;
        v.qty = Number(v.qty);
        await API.post(`/api/production-tasks/${taskId}/operations/${opId}/report`, v);
        UI.toast('报工成功', 'success');
        this.openDetail(view, taskId);
      }
    });
  },

  async openComplete(view, id) {
    const [employees, detail] = await Promise.all([
      API.get('/api/employees?status=在职'),
      API.get(`/api/production-tasks/${id}`)
    ]);
    // 智能默认：若已有报工记录，预选最近一条报工的员工（经手人常=最后报工者）
    let defaultOperator = '';
    const recent = (detail.data && detail.data.recent) || [];
    const lastReporter = recent.find(r => r.employee_id);
    if (lastReporter) {
      const emp = (employees.data || []).find(e => String(e.id) === String(lastReporter.employee_id));
      if (emp) defaultOperator = emp.name;
    }
    const empOpts = (employees.data || []).map(e => ({ value: e.name, label: `${e.name}（${e.emp_no}）` }));
    const fields = [
      { name: 'date', label: '入库日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'operator', label: '经手人', type: 'select', options: [{ value: '', label: '— 不指定 —' }].concat(empOpts), value: defaultOperator },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];
    await UI.formModal({
      title: '完工入库',
      submitText: '确认入库',
      fields,
      onSubmit: async (v) => {
        try {
          await API.post(`/api/production-tasks/${id}/complete`, v);
          UI.toast('已完工入库', 'success');
          this.openDetail(view, id);
        } catch (err) { UI.toast(err.message, 'error'); }
      }
    });
  }
};

/* ===== /js/pages/reports.js ===== */
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

/* ===== /js/pages/customers.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages.customers = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/customers');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'name', label: '客户名' },
      { key: 'type', label: '类型' },
      { key: 'contact', label: '联系人' },
      { key: 'owner_role', label: '归属角色', render: r => r.owner_role ? UI.esc(r.owner_role) : '<span class="muted">全量可见</span>' },
      { key: 'remark', label: '备注' },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>客户</h2><span class="sub">国内/国外客户；归属角色用于 RBAC 客户数据隔离</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增客户</button>
      </div>
      <p class="muted">「归属角色」留空 = 所有角色可见（管理/工程/采购默认全量）；填「跟单A」等则仅该角色在销售订单中可见（验收2）。</p>
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
      if (await UI.confirm('删除该客户？')) {
        await API.del('/api/customers/' + b.dataset.id);
        UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let row = {};
    if (id) row = (await API.get('/api/customers/' + id)).data;
    const fields = [
      { name: 'name', label: '客户名', required: true, value: row.name || '' },
      { name: 'type', label: '类型', type: 'select', options: [{ value: '国内', label: '国内' }, { value: '国外', label: '国外' }], value: row.type || '国内' },
      { name: 'contact', label: '联系人', value: row.contact || '' },
      { name: 'owner_role', label: '归属角色（RBAC）', value: row.owner_role || '', placeholder: '如 跟单A，留空=全量' },
      { name: 'remark', label: '备注', type: 'textarea', value: row.remark || '' }
    ];
    await UI.formModal({
      title: id ? '编辑客户' : '新增客户',
      submitText: '保存',
      fields,
      onSubmit: async (v) => {
        try {
          if (id) await API.put('/api/customers/' + id, v);
          else await API.post('/api/customers', v);
          UI.toast('已保存', 'success'); this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  }
};

/* ===== /js/pages/boms.js ===== */
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

/* ===== /js/pages/bom-import.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['bom-import'] = {
  file: null,        // 当前选中的 File 对象（预览/提交复用）
  preview: null,     // 预览结果

  async render(view) {
    view.innerHTML = `
      <div class="page-head">
        <h2>BOM 批量导入</h2><span class="sub">按成品编码 + 物料编码批量建 BOM（P7）</span>
        <div style="margin-left:auto" class="no-print">
          <input type="file" id="bomFile" accept=".xlsx,.xls,.csv" style="display:none" />
          <button class="btn btn-primary" data-action="choose">选择 Excel</button>
          <button class="btn" data-action="preview" disabled style="opacity:.6">预览</button>
          <button class="btn btn-success" data-action="commit" disabled style="opacity:.6">确认导入</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">导入说明</div>
        <p class="muted" style="margin:0">
          Excel 首行为表头，支持列：<b>成品编码</b>（必填，须已存在于「产品信息」）、<b>物料编码</b>（必填，须已存在于「原料库存」）、
          <b>单耗</b>（必填，单件成品耗用该物料数量，&gt;0）、<b>损耗率</b>（可选，小数 0.03 表示 3%，默认 0.03）、成品名称/物料名称/备注（可选）。<br/>
          同一成品的多行将合并为一个 BOM 的多个物料行；<b>成品若已有 BOM 则整单跳过</b>（需先删除旧 BOM 再导入）。<br/>
          <b>工序路线</b>：本导入仅建 BOM 物料清单，工序路线由系统在生成生产任务单时按默认（自动车→走心机→品检→包装）生成。
        </p>
      </div>
      <div id="prevBox"><div class="empty">选择 Excel 后点「预览」</div></div>`;

    const fileInput = view.querySelector('#bomFile');
    view.querySelector('[data-action=choose]').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      this.file = fileInput.files[0] || null;
      const previewBtn = view.querySelector('[data-action=preview]');
      const commitBtn = view.querySelector('[data-action=commit]');
      if (this.file) {
        previewBtn.disabled = false; previewBtn.style.opacity = '1';
        commitBtn.disabled = true; commitBtn.style.opacity = '.6';
        this.preview = null;
        view.querySelector('#prevBox').innerHTML = `<div class="empty">已选「${UI.esc(this.file.name)}」，点「预览」</div>`;
      }
    };
    view.querySelector('[data-action=preview]').onclick = () => this.doPreview(view);
    view.querySelector('[data-action=commit]').onclick = () => this.doCommit(view);
  },

  async doPreview(view) {
    if (!this.file) return;
    const fd = new FormData();
    fd.append('file', this.file);
    try {
      const res = await fetch('/api/bom-import/preview', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '预览失败');
      this.preview = data.data;
      this.renderPreview(view);
      const commitBtn = view.querySelector('[data-action=commit]');
      commitBtn.disabled = false; commitBtn.style.opacity = '1';
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },

  renderPreview(view) {
    const p = this.preview;
    if (!p) return;
    const headers = [
      { key: 'row', label: '行' }, { key: 'product_code', label: '成品编码' }, { key: 'material_code', label: '物料编码' },
      { key: 'qty_per', label: '单耗', num: true }, { key: 'loss_rate', label: '损耗率' },
      { key: 'status', label: '校验' }
    ];
    const rows = p.rows.map(r => ({
      ...r,
      status: r.ok ? '通过' : '失败：' + r.error
    }));
    view.querySelector('#prevBox').innerHTML = `
      <div class="card no-print">
        <div class="card-title">预览结果</div>
        <div class="row" style="margin-bottom:10px">
          <div class="stat-card" style="flex:1"><div class="k">总行数</div><div class="v">${p.summary.total}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">有效</div><div class="v success">${p.summary.valid}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">无效</div><div class="v danger">${p.summary.invalid}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">涉及成品</div><div class="v primary">${p.summary.products}</div></div>
        </div>
        ${p.summary.invalid > 0 ? '<p class="muted" style="color:var(--danger)">存在无效行，确认导入时仅写入有效行，请先修正 Excel 后重新预览。</p>' : ''}
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr>${headers.map(h => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr style="${r.ok ? '' : 'background:#fdecea'}">
            <td>${r.row}</td><td>${UI.esc(r.product_code)}</td><td>${UI.esc(r.material_code)}</td>
            <td class="num">${UI.esc(r.qty_per)}</td><td>${UI.esc(r.loss_rate)}</td><td>${UI.esc(r.status)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  },

  async doCommit(view) {
    if (!this.file || !this.preview) return;
    if (this.preview.summary.invalid > 0) {
      const ok = await UI.confirm(`有 ${this.preview.summary.invalid} 行无效将被跳过，仅导入 ${this.preview.summary.valid} 行有效数据？`);
      if (!ok) return;
    } else if (!await UI.confirm('确认导入？将按预览结果写入 BOM。')) return;
    const fd = new FormData();
    fd.append('file', this.file);
    try {
      const res = await fetch('/api/bom-import/commit', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      const d = data.data;
      UI.toast(`导入完成：新建 ${d.created} 个 BOM，${d.items_inserted} 个物料行${d.skipped ? '，跳过 ' + d.skipped + ' 个已有 BOM' : ''}`, 'success');
      // 清空，回到初始态
      this.file = null; this.preview = null;
      this.render(view);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }
};

/* ===== /js/pages/masterdata-import.js ===== */
'use strict';

window.Pages = window.Pages || {};

// 各类型展示用列（数据校验步骤的表格列）
const MD_VIEW = {
  products: {
    label: '商品', pk: 'code',
    cols: [
      { k: 'code', l: '商品编码' }, { k: 'name', l: '商品名称' },
      { k: 'category', l: '类别' }, { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' },
    ],
  },
  materials: {
    label: '物料', pk: 'code',
    cols: [
      { k: 'code', l: '物料编码' }, { k: 'name', l: '物料名称' },
      { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' }, { k: 'safety_stock', l: '安全库存' },
    ],
  },
  customers: {
    label: '客户', pk: 'name',
    cols: [
      { k: 'name', l: '客户名称' }, { k: 'type', l: '类型' }, { k: 'contact', l: '联系人' },
    ],
  },
  suppliers: {
    label: '供应商', pk: 'name',
    cols: [
      { k: 'code', l: '供应商编码' }, { k: 'name', l: '供应商名称' },
      { k: 'contact', l: '联系人' }, { k: 'type', l: '类型' }, { k: 'tax_no', l: '税号' },
    ],
  },
  'finished-goods': {
    label: '成品库存', pk: 'code',
    cols: [
      { k: 'code', l: '成品库存编码' }, { k: 'name', l: '成品名称' },
      { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' },
      { k: 'location_code', l: '库位' }, { k: 'status', l: '状态' },
    ],
  },
};

Pages['masterdata-import'] = {
  step: 1,
  type: null,
  file: null,
  preview: null,
  mode: 'add',

  render(view) {
    this.type = window.__importType || 'products';
    this.step = 1; this.file = null; this.preview = null; this.mode = 'add';
    const v = MD_VIEW[this.type];
    const steps = ['上传文件', '字段匹配', '基础资料检查', '数据校验', '正式引入'];
    view.innerHTML = `
      <div class="page-head">
        <h2>${v.label} 智能导入</h2>
        <span class="sub">金蝶风 5 步向导</span>
        <div class="ml-auto no-print">
          <button class="btn" data-action="back">返回${v.label}页</button>
        </div>
      </div>
      <div class="wizard-steps">
        ${steps.map((s, i) => `<div class="wstep" data-i="${i + 1}"><span class="wn">${i + 1}</span>${s}</div>`).join('')}
      </div>
      <div id="wizBody"></div>
      <div class="card no-print mt-12">
        模板下载：<a href="/templates/${this.type}.xlsx" download>${v.label}导入模板.xlsx</a>
        <span class="muted">（按模板表头填表，列名后的 <code># key</code> 用于系统精确识别）</span>
      </div>`;
    view.querySelector('[data-action=back]').onclick = () => window.navigate(this.type);
    this.paintSteps();
    this.renderStep(view);
  },

  paintSteps() {
    document.querySelectorAll('.wstep').forEach(el => {
      const i = Number(el.dataset.i);
      el.classList.toggle('active', i === this.step);
      el.classList.toggle('done', i < this.step);
    });
  },

  renderStep(view) {
    this.paintSteps();
    const body = view.querySelector('#wizBody');
    if (this.step === 1) return this.renderUpload(view, body);
    if (this.step === 2) return this.renderMatch(view, body);
    if (this.step === 3) return this.renderCheck(view, body);
    if (this.step === 4) return this.renderValidate(view, body);
    if (this.step === 5) return this.renderCommit(view, body);
  },

  renderUpload(view, body) {
    body.innerHTML = `
      <div class="card">
        <div class="dropzone" id="drop">拖拽 Excel 文件到此处，或
          <button class="btn btn-primary" id="pick" type="button">选择文件</button>
        </div>
        <input type="file" id="file" accept=".xlsx,.xls" class="d-none" />
        <div id="fileInfo" class="muted mt-10"></div>
        <div class="mt-14 no-print">
          <button class="btn btn-primary" id="next1" disabled>下一步</button>
        </div>
      </div>`;
    const fileInput = body.querySelector('#file');
    const drop = body.querySelector('#drop');
    const info = body.querySelector('#fileInfo');
    const next = body.querySelector('#next1');
    body.querySelector('#pick').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      this.file = fileInput.files[0] || null;
      if (this.file) { info.textContent = `已选：${this.file.name}（${this.file.size} 字节）`; next.disabled = false; }
    };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      this.file = e.dataTransfer.files[0] || null;
      if (this.file) { info.textContent = `已选：${this.file.name}（${this.file.size} 字节）`; next.disabled = false; }
    };
    next.onclick = () => this.doPreview(view);
  },

  async doPreview(view) {
    if (!this.file) return;
    const fd = new FormData();
    fd.append('file', this.file);
    fd.append('type', this.type);
    try {
      const res = await fetch('/api/import-masterdata/preview', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '预览失败');
      this.preview = d.data;
      this.step = 2;
      this.renderStep(view);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },

  renderMatch(view, body) {
    const p = this.preview;
    const rows = p.columns.map(c => `
      <tr>
        <td>${c.excelCol}</td>
        <td>${UI.esc(c.excelName)}</td>
        <td>${c.matched ? UI.esc(c.fieldLabel) : '<span class="text-danger">未匹配</span>'}</td>
        <td>${c.matched ? '<span class="badge badge-completed">已匹配</span>' : '<span class="badge badge-warn">未匹配</span>'}</td>
      </tr>`).join('');
    const miss = p.requiredMissing.length
      ? `<p class="text-danger">以下必填项未匹配，请检查 Excel 表头：${p.requiredMissing.join('、')}</p>` : '';
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">字段匹配结果</div>
        <p class="muted">系统按列名后的 <code># key</code> 标识符（或中文名）自动匹配，无需手动调整。</p>
        ${miss}
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Excel列</th><th>Excel列名</th><th>匹配系统字段</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" id="next2" ${p.requiredMissing.length ? 'disabled' : ''}>下一步</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 1; this.renderStep(view); };
    body.querySelector('#next2').onclick = () => { this.step = 3; this.renderStep(view); };
  },

  renderCheck(view, body) {
    const p = this.preview;
    const s = p.summary;
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">基础资料检查 · 引入模式</div>
        <div class="row my-10">
          <label class="radio"><input type="radio" name="mode" value="add" ${this.mode === 'add' ? 'checked' : ''}/> 新增（已存在的${p.pkLabel}将跳过）</label>
          <label class="radio"><input type="radio" name="mode" value="overwrite" ${this.mode === 'overwrite' ? 'checked' : ''}/> 覆盖新增（已存在的${p.pkLabel}将更新非键字段）</label>
        </div>
      </div>
      <div class="card"><div class="row">
        ${stat('总行数', s.total, '')}
        ${stat('有效', s.valid, 'success')}
        ${stat('无效', s.invalid, 'danger')}
        ${stat('将新增', s.willAdd, 'primary')}
        ${stat('将覆盖', s.willUpdate, 'primary')}
      </div>
      ${s.invalid > 0 ? '<p class="text-danger">存在无效行，将在数据校验步骤跳过。</p>' : ''}
      </div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" data-action="next">下一步</button>
      </div>`;
    body.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => { this.mode = r.value; });
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 2; this.renderStep(view); };
    body.querySelector('[data-action=next]').onclick = () => { this.step = 4; this.renderStep(view); };
  },

  renderValidate(view, body) {
    const p = this.preview;
    const v = MD_VIEW[this.type];
    const head = `<th>行</th><th>${v.pk === 'code' ? '编码' : '名称'}</th>${v.cols.filter(c => c.k !== v.pk).map(c => `<th>${c.l}</th>`).join('')}<th>校验</th>`;
    const rows = p.rows.map(r => {
      const cells = v.cols.filter(c => c.k !== v.pk).map(c => `<td>${UI.esc(r[c.k])}</td>`).join('');
      return `<tr class="${r.ok ? '' : 'row-bad'}">
        <td>${r.row}</td><td>${UI.esc(r[v.pk])}</td>${cells}
        <td>${r.ok ? (r.exists ? '将覆盖' : '通过') : '失败：' + UI.esc(r.error)}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">数据校验</div>
        <p class="muted">逐行校验结果，红色为无效行（将在导入时跳过）。</p>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" id="next4">下一步</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 3; this.renderStep(view); };
    body.querySelector('#next4').onclick = async () => {
      if (this.preview.summary.invalid > 0) {
        const ok = await UI.confirm(`有 ${this.preview.summary.invalid} 行无效将被跳过，继续？`);
        if (!ok) return;
      }
      this.step = 5; this.renderStep(view);
    };
  },

  renderCommit(view, body) {
    const p = this.preview;
    body.innerHTML = `
      <div class="card"><div class="card-title">正式引入</div>
        <p class="muted">将${p.summary.valid} 条有效数据按「${this.mode === 'add' ? '新增' : '覆盖新增'}」模式写入${MD_VIEW[this.type].label}档案。</p>
        <div id="commitResult"></div>
      </div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-success" id="doCommit">确认导入</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 4; this.renderStep(view); };
    body.querySelector('#doCommit').onclick = () => this.doCommit(view);
  },

  async doCommit(view) {
    if (!this.file || !this.preview) return;
    if (!await UI.confirm('确认导入？将按预览结果写入数据库。')) return;
    const fd = new FormData();
    fd.append('file', this.file);
    fd.append('type', this.type);
    fd.append('mode', this.mode);
    try {
      const res = await fetch('/api/import-masterdata/commit', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '导入失败');
      const r = d.data;
      const box = view.querySelector('#commitResult');
      box.innerHTML = `<div class="ok-box">导入完成：新增 ${r.inserted} 条，覆盖更新 ${r.updated} 条，跳过 ${r.skipped} 条。</div>
        <div class="mt-14 no-print">
          <button class="btn" id="again">再导入一个</button>
          <button class="btn btn-primary" id="goback">返回${MD_VIEW[this.type].label}页</button>
        </div>`;
      box.querySelector('#again').onclick = () => this.render(view);
      box.querySelector('#goback').onclick = () => window.navigate(this.type);
      this.step = 5; this.paintSteps();
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },
};

function stat(k, v, cls) {
  return `<div class="stat-card grow"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
}

/* ===== /js/pages/sales-orders.js ===== */
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

/* ===== /js/pages/mrp.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['mrp'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const prods = await API.get('/api/products');
    const prodOpts = prods.data.map(p => ({ value: String(p.id), label: `[${UI.esc(p.code)}] ${UI.esc(p.name)}` }));

    view.innerHTML = `
      <div class="page-head"><h2>MRP 物料需求运算</h2></div>
      <p class="muted">输入计划生产量与成品，按 BOM 展开物料需求（含 3% 损耗、向上取整），输出采购缺口（验收1）。</p>
      <div class="mrp-form">
        <label>成品：<select id="mrpProduct">${[{ value: '', label: '— 选择成品 —' }].concat(prodOpts).map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select></label>
        <label>计划产量：<input type="number" id="mrpQty" step="any" placeholder="如 1000"></label>
        <button class="btn" id="mrpCalc">运算</button>
      </div>
      <div id="mrpResult"></div>
    `;

    view.querySelector('#mrpCalc').onclick = async () => {
      const pid = view.querySelector('#mrpProduct').value;
      const qty = view.querySelector('#mrpQty').value;
      if (!pid || !qty || Number(qty) <= 0) { UI.toast('请选择成品并填写产量', 'error'); return; }
      const box = view.querySelector('#mrpResult');
      box.innerHTML = UI.spinner();
      try {
        const res = await API.post('/api/mrp/calc', { product_id: Number(pid), qty: Number(qty) });
        this.drawResult(box, res.data);
      } catch (e) { box.innerHTML = `<p class="error">${UI.esc(e.message)}</p>`; }
    };
  },

  drawResult(box, d) {
    if (!d.lines.length) {
      box.innerHTML = `<p class="muted">该成品 BOM 暂无物料行。</p>`;
      return;
    }
    const rows = d.lines.map(l => `
      <tr>
        <td>${UI.esc(l.material_code)}</td>
        <td>${UI.esc(l.material_name)}</td>
        <td>${UI.esc(l.unit)}</td>
        <td class="num">${UI.esc(Number(l.qty_per))}</td>
        <td class="num">${UI.esc(Math.round(l.loss_rate * 100))}%</td>
        <td class="num">${UI.esc(Number(l.gross_need))}</td>
        <td class="num"><b>${UI.esc(l.plan_purchase)}</b></td>
        <td class="num">${UI.esc(Number(l.current_stock))}</td>
        <td class="num ${l.shortage > 0 ? 'danger' : ''}"><b>${UI.esc(l.shortage)}</b></td>
      </tr>`).join('');

    box.innerHTML = `
      <h3>成品：${UI.esc(d.product.name)} ｜ 计划产量 ${UI.esc(Number(d.plan_qty))} ${UI.esc(d.product.unit)} ｜ BOM ${UI.esc(d.bom_no)}</h3>
      <p class="muted">需补采购的物料种类：<b>${d.total_shortage_materials}</b> 种</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>物料编码</th><th>名称</th><th>单位</th><th>单耗</th><th>损耗</th><th>含损总需</th><th>建议采购</th><th>现有库存</th><th>缺口</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    `;
  }
};

/* ===== /js/pages/purchase-plans.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['purchase-plans'] = {
  filterStatus: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    await this.drawList(view);
  },

  statusBadge(s) {
    const map = {
      '待采购': 'badge-producing', '已转采购': 'badge-completed', '已关闭': 'badge'
    };
    return `<span class="badge ${map[s] || 'badge'}">${UI.esc(s)}</span>`;
  },

  async drawList(view) {
    const q = this.filterStatus ? '?status=' + encodeURIComponent(this.filterStatus) : '';
    const [list, sups] = await Promise.all([
      API.get('/api/purchase-plans' + q),
      API.get('/api/suppliers')
    ]);
    const rows = (list.data || []).map(r => ({ ...r, plan_qty: Number(r.plan_qty), current_stock: Number(r.current_stock) }));
    const supOpts = (sups.data || []).map(s => ({ value: String(s.id), label: s.name }));

    const statusOpts = ['', '待采购', '已转采购', '已关闭']
      .map(s => `<option value="${s}" ${s === this.filterStatus ? 'selected' : ''}>${s || '全部状态'}</option>`).join('');

    const tableRows = rows.map(r => {
      const lowCls = r.current_stock < r.plan_qty ? 'num warn' : 'num';
      const chk = r.status === '待采购'
        ? `<input type="checkbox" class="pp-sel" data-id="${r.id}" data-mat="${r.material_id}"/>`
        : '<span class="muted">—</span>';
      return `<tr data-id="${r.id}">
        <td style="text-align:center">${chk}</td>
        <td>${UI.esc(r.material_code || '')} ${UI.esc(r.material_name || '')}${r.spec ? `<span class="muted"> ${UI.esc(r.spec)}</span>` : ''}</td>
        <td class="num">${UI.esc(r.plan_qty)} ${UI.esc(r.unit || '')}</td>
        <td class="${lowCls}">${UI.esc(r.current_stock)}</td>
        <td>${this.statusBadge(r.status)}</td>
        <td>${r.sales_order_id ? `<a href="#" class="muted" data-so="${r.sales_order_id}">SO#${r.sales_order_id}</a>` : '<span class="muted">手工</span>'}</td>
        <td class="muted">${UI.esc(r.remark || '')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:16px">暂无采购计划</td></tr>';

    const selCount = rows.filter(r => r.status === '待采购').length;

    view.innerHTML = `
      <div class="page-head">
        <h2>采购计划</h2><span class="sub">销售单 MRP 自动生成的物料缺口（P5）</span>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select class="select" id="ppStatus">${statusOpts}</select>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <span class="sub">将选中的 <b id="selCnt">0</b> 条待采购计划，指派供应商后转成一张采购单：</span>
          <select class="select" id="ppSup"><option value="">— 选择供应商 —</option>${supOpts.map(o => `<option value="${o.value}">${UI.esc(o.label)}</option>`).join('')}</select>
          <button class="btn btn-primary" data-action="convert" disabled>转采购单</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th style="text-align:center">选</th><th>物料</th><th class="num">建议采购</th><th class="num">当前库存</th><th>状态</th><th>来源</th><th>备注</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#ppStatus').onchange = e => { this.filterStatus = e.target.value; this.drawList(view); };

    const selEls = Array.from(view.querySelectorAll('.pp-sel'));
    const updateCnt = () => {
      const n = view.querySelectorAll('.pp-sel:checked').length;
      view.querySelector('#selCnt').textContent = n;
      view.querySelector('[data-action=convert]').disabled = n === 0;
    };
    selEls.forEach(c => c.onchange = updateCnt);

    view.querySelectorAll('[data-so]').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      // 跳转到销售订单页并定位（简单提示）
      UI.toast('来源销售订单 #' + a.dataset.so + '，可在「销售订单」页查看', 'info');
    });

    view.querySelector('[data-action=convert]').onclick = async () => {
      const checked = view.querySelectorAll('.pp-sel:checked');
      if (!checked.length) { UI.toast('请先勾选待采购计划', 'error'); return; }
      const supId = view.querySelector('#ppSup').value;
      if (!supId) { UI.toast('请选择供应商', 'error'); return; }
      const planIds = Array.from(checked).map(c => Number(c.dataset.id));
      if (!confirm(`将 ${planIds.length} 条计划转成一张采购单？`)) return;
      try {
        const r = await API.post('/api/purchase-plans/convert', { supplier_id: Number(supId), plan_ids: planIds });
        UI.toast(`已生成采购单 ${r.data.po_no}（${r.data.items} 个物料行）`, 'success');
        this.drawList(view);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

/* ===== /js/pages/material-requisitions.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['material-requisitions'] = {
  filterStatus: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    await this.drawList(view);
  },

  statusBadge(s) {
    const map = { '待发料': 'badge-producing', '已发料': 'badge-completed', '已关闭': 'badge' };
    return `<span class="badge ${map[s] || 'badge'}">${UI.esc(s)}</span>`;
  },

  async drawList(view) {
    const q = this.filterStatus ? '?status=' + encodeURIComponent(this.filterStatus) : '';
    const list = await API.get('/api/material-requisitions' + q);
    const rows = (list.data || []);
    const statusOpts = ['', '待发料', '已发料', '已关闭']
      .map(s => `<option value="${s}" ${s === this.filterStatus ? 'selected' : ''}>${s || '全部状态'}</option>`).join('');

    const tableRows = rows.map(r => {
      const prod = r.product_name ? `[${UI.esc(r.product_code)}] ${UI.esc(r.product_name)}` : '（未关联）';
      return `<tr data-id="${r.id}">
        <td>${UI.esc(r.requisition_no)}</td>
        <td>${UI.esc(r.task_no || '—')}</td>
        <td>${prod}</td>
        <td class="num">${UI.esc(r.item_count)}</td>
        <td>${this.statusBadge(r.status)}</td>
        <td>${UI.esc(r.date || '')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="muted empty-row">暂无领料单，点「从生产任务单生成备料」创建</td></tr>';

    view.innerHTML = `
      <div class="page-head">
        <h2>生产领料备料</h2><span class="sub">按任务单 BOM 展开应领清单，确认发料扣库存（P6）</span>
        <div class="inline-ops">
          <select class="select" id="mrStatus">${statusOpts}</select>
          <button class="btn btn-primary" data-action="gen">＋ 从生产任务单生成备料</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>领料单号</th><th>任务单</th><th>产品</th><th class="num">物料行</th><th>状态</th><th>日期</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#mrStatus').onchange = e => { this.filterStatus = e.target.value; this.drawList(view); };
    view.querySelector('tbody').onclick = e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.openDetail(view, Number(tr.dataset.id));
    };
    view.querySelector('[data-action=gen]').onclick = () => this.openGenerate(view);
  },

  async openGenerate(view) {
    const tasks = await API.get('/api/production-tasks');
    // 仅待开工/进行中 可选（已完工一般已备过料）
    const cand = (tasks.data || []).filter(t => ['待开工', '进行中'].includes(t.status));
    if (!cand.length) { UI.toast('没有可备料的生产任务单（需 待开工/进行中 且已关联产品）', 'error'); return; }
    const taskOpts = cand.map(t => ({
      value: String(t.id),
      label: `${t.task_no} ｜ ${t.product_name || (t.product_code ? '[' + t.product_code + ']' : '未关联')} ｜ 计划 ${t.plan_qty}${t.unit || ''}`
    }));
    const fields = [
      { name: 'production_task_id', label: '生产任务单', type: 'select', required: true,
        options: [{ value: '', label: '— 选择任务单 —' }].concat(taskOpts) },
      { name: 'operator', label: '备料人', type: 'text', value: '' },
      { name: 'date', label: '备料日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];
    await UI.formModal({
      title: '从生产任务单生成领料单',
      submitText: '生成领料单',
      fields,
      onSubmit: async (v) => {
        try {
          const r = await API.post('/api/material-requisitions/generate-from-task', {
            production_task_id: Number(v.production_task_id),
            operator: v.operator || null,
            date: v.date,
            remark: v.remark || null
          });
          if (r.already_exists) {
            UI.toast('该任务单已有领料单，直接打开', 'info');
            this.openDetail(view, r.requisition_id);
            return;
          }
          UI.toast(`已生成领料单 ${r.requisition_no}（${r.items} 个物料行）`, 'success');
          this.openDetail(view, r.requisition_id);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async openDetail(view, id) {
    view.innerHTML = UI.spinner();
    const { data } = await API.get('/api/material-requisitions/' + id);
    const req = data.req, task = data.task, product = data.product, items = data.items || [];

    const itemRows = items.map(it => {
      const lowCls = it.current_stock < it.req_qty ? 'warn' : '';
      const editable = req.status === '待发料';
      const pickInput = editable
        ? `<input class="input pick-qty w-90" type="number" step="any" min="0" data-iid="${it.id}" value="${UI.esc(it.picked_qty)}"/>`
        : `<span class="num">${UI.esc(it.picked_qty)}</span>`;
      return `<tr data-iid="${it.id}">
        <td>${UI.esc(it.material_code || '')} ${UI.esc(it.material_name || '')}${it.spec ? `<span class="muted"> ${UI.esc(it.spec)}</span>` : ''}</td>
        <td class="num">${UI.esc(it.req_qty)} ${UI.esc(it.unit || '')}</td>
        <td class="num ${lowCls}">${UI.esc(it.current_stock)}</td>
        <td class="text-center">${pickInput}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="muted empty-row">无物料行</td></tr>';

    view.innerHTML = `
      <div class="page-head">
        <h2>领料单 ${UI.esc(req.requisition_no)}</h2> ${this.statusBadge(req.status)}
        <div class="inline-ops">
          <button class="btn" data-action="back">← 返回</button>
          ${req.status === '待发料' ? `<button class="btn" data-action="savepick">保存实领</button>` : ''}
          ${req.status === '待发料' ? `<button class="btn btn-primary" data-action="issue">确认发料</button>` : ''}
        </div>
      </div>
      <div class="card"><div class="card-title">基本信息</div>
        任务单：${UI.esc(task ? task.task_no : '—')} ｜ 产品：${UI.esc(product ? ('[' + product.code + '] ' + product.name) : '—')}
        ｜ 日期：${UI.esc(req.date || '—')} ｜ 备料人：${UI.esc(req.operator || '—')} ｜ 备注：${UI.esc(req.remark || '—')}
      </div>
      <div class="card"><div class="card-title">应领 / 实领明细</div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>物料</th><th class="num">应领量</th><th class="num">当前库存</th><th class="text-center">实领量</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table></div>
        <p class="muted">说明：应领量按 BOM × 计划产量（含 3% 损耗）计算；实领可少于应领（库存不足时先领现有量，缺口待到货后补领）。</p>
      </div>`;

    view.querySelector('[data-action=back]').onclick = () => this.drawList(view);
    const saveBtn = view.querySelector('[data-action=savepick]');
    if (saveBtn) saveBtn.onclick = async () => {
      const rows = Array.from(view.querySelectorAll('.pick-qty')).map(inp => ({
        id: Number(inp.dataset.iid), picked_qty: Number(inp.value)
      })).filter(x => Number.isFinite(x.picked_qty));
      try {
        await API.put('/api/material-requisitions/' + id + '/items', { items: rows });
        UI.toast('实领量已保存', 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
    const issueBtn = view.querySelector('[data-action=issue]');
    if (issueBtn) issueBtn.onclick = async () => {
      // 先保存实领再发料
      const rows = Array.from(view.querySelectorAll('.pick-qty')).map(inp => ({
        id: Number(inp.dataset.iid), picked_qty: Number(inp.value)
      })).filter(x => Number.isFinite(x.picked_qty));
      try {
        await API.put('/api/material-requisitions/' + id + '/items', { items: rows });
        if (!confirm('确认发料？将按实领量扣减原料库存。')) return;
        const r = await API.post('/api/material-requisitions/' + id + '/issue', {});
        UI.toast(`已发料（${r.issued_lines} 个物料行扣库存）`, 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

/* ===== /js/pages/outsources.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['outsources'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/outsources');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const statusColor = s => ({
      '待发': 'tag-gray', '已发': 'tag-yellow', '已回': 'tag-green', '已取消': 'tag-red'
    }[s] || 'tag-gray');

    const table = UI.table([
      { key: 'outsource_no', label: '外发单号' },
      { key: 'process_name', label: '外发工序' },
      { key: 'supplier_name', label: '外发厂商' },
      { key: 'target', label: '外发对象', render: r => r.product_name ? `成品：${UI.esc(r.product_name)}` : `物料：${UI.esc(r.material_name || '')}` },
      { key: 'qty', label: '数量' },
      { key: 'unit_price', label: '单价', render: r => r.unit_price != null ? '¥' + Number(r.unit_price).toFixed(2) : '—' },
      { key: 'status', label: '状态', render: r => `<span class="tag ${statusColor(r.status)}">${UI.esc(r.status)}</span>` },
      { key: 'expected_return', label: '期望回厂' },
      { key: 'ops', label: '操作', render: (r) => `
        <button class="btn-sm" data-act="send" data-id="${r.id}" ${r.status !== '待发' ? 'disabled' : ''}>发料</button>
        <button class="btn-sm" data-act="return" data-id="${r.id}" ${r.status !== '已发' ? 'disabled' : ''}>回收</button>
        <button class="btn-sm" data-act="edit" data-id="${r.id}">编辑</button>
        <button class="btn-sm danger" data-act="del" data-id="${r.id}">删</button>
      ` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>外发管理</h2>
        <button class="btn" id="newBtn">+ 新建外发单</button>
      </div>
      <p class="muted">外包订单（热处理/氧化/电镀等），由跟单管理、监督回厂（验收4）。发料扣原料库存，回收入成品/原料库。</p>
      ${table}
    `;

    view.querySelector('#newBtn').onclick = () => this.openForm(view);
    view.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        if (act === 'send') this.openSend(view, id);
        else if (act === 'return') this.openReturn(view, id);
        else if (act === 'edit') this.openForm(view, id);
        else if (act === 'del') this.del(view, id);
      };
    });
  },

  async openForm(view, id) {
    let v = {};
    if (id) v = (await API.get('/api/outsources/' + id)).data;
    const suppliers = (await API.get('/api/suppliers')).data;
    const products = (await API.get('/api/products')).data;
    const materials = (await API.get('/api/materials')).data;
    const supOpts = suppliers.map(s => ({ value: String(s.id), label: UI.esc(s.name) }));
    const prodOpts = [{ value: '', label: '（无）' }].concat(products.map(p => ({ value: String(p.id), label: `${UI.esc(p.code)} ${UI.esc(p.name)}` })));
    const matOpts = [{ value: '', label: '（无）' }].concat(materials.map(m => ({ value: String(m.id), label: `${UI.esc(m.code)} ${UI.esc(m.name)}` })));
    const sos = (await API.get('/api/sales-orders')).data || [];
    const soOpts = [{ value: '', label: '（全厂成本池 / 不归单）' }].concat(
      sos.map(o => ({ value: String(o.id), label: `${UI.esc(o.so_no)} ${UI.esc(o.customer_name || '')}` }))
    );
    const fields = [
      { name: 'process_name', label: '外发工序', required: true, value: v.process_name, placeholder: '如 热处理 / 氧化 / 电镀' },
      { name: 'supplier_id', label: '外发厂商', type: 'select', required: true, options: supOpts, value: v.supplier_id ? String(v.supplier_id) : '' },
      { name: 'so_id', label: '关联销售订单(成本归单)', type: 'select', options: soOpts, value: v.so_id ? String(v.so_id) : '' },
      { name: 'product_id', label: '外发成品', type: 'select', options: prodOpts, value: v.product_id ? String(v.product_id) : '' },
      { name: 'material_id', label: '外发物料(半成品)', type: 'select', options: matOpts, value: v.material_id ? String(v.material_id) : '' },
      { name: 'qty', label: '数量', type: 'number', value: v.qty },
      { name: 'unit_price', label: '外发单价(元/件)', type: 'number', value: v.unit_price != null ? v.unit_price : '' },
      { name: 'sent_date', label: '送料日期', type: 'date', value: v.sent_date || '' },
      { name: 'expected_return', label: '期望回厂', type: 'date', value: v.expected_return || '' },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark || '' }
    ];
    await UI.formModal({
      title: id ? '编辑外发单' : '新建外发单',
      fields,
      onSubmit: async (val) => {
        val.qty = Number(val.qty) || 0;
        val.unit_price = val.unit_price ? Number(val.unit_price) : null;
        val.supplier_id = Number(val.supplier_id);
        val.so_id = val.so_id ? Number(val.so_id) : null;
        val.product_id = val.product_id ? Number(val.product_id) : null;
        val.material_id = val.material_id ? Number(val.material_id) : null;
        if (!val.product_id && !val.material_id) throw new Error('须选成品或物料之一');
        if (id) await API.put('/api/outsources/' + id, val);
        else await API.post('/api/outsources', val);
        UI.toast('已保存', 'success'); this.render(view);
      }
    });
  },

  async openSend(view, id) {
    const o = (await API.get('/api/outsources/' + id)).data;
    const fields = [
      { name: 'date', label: '发料日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'qty', label: o.material_id ? '发料数量' : '（成品外发不扣库存）', type: 'number', value: o.qty, disabled: !o.material_id },
      { name: 'operator', label: '经手人', value: '' }
    ];
    await UI.formModal({
      title: '外发发料 · ' + o.outsource_no,
      submitText: '确认发料',
      fields,
      onSubmit: async (val) => {
        try {
          await API.post('/api/outsources/' + id + '/send', { date: val.date, qty: val.qty ? Number(val.qty) : undefined, operator: val.operator || null });
          UI.toast('已发料', 'success'); this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async openReturn(view, id) {
    const o = (await API.get('/api/outsources/' + id)).data;
    const fields = [
      { name: 'date', label: '回收日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'qty', label: '回收数量', type: 'number', required: true, value: o.qty },
      { name: 'operator', label: '经手人', value: '' },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];
    await UI.formModal({
      title: '外发回收 · ' + o.outsource_no,
      submitText: '确认回收入库',
      fields,
      onSubmit: async (val) => {
        try {
          await API.post('/api/outsources/' + id + '/return', { date: val.date, qty: Number(val.qty), operator: val.operator || null, remark: val.remark || null });
          UI.toast('已回收入库', 'success'); this.render(view);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async del(view, id) {
    if (!confirm('确认删除该外发单？')) return;
    await API.delete('/api/outsources/' + id);
    UI.toast('已删除', 'success'); this.render(view);
  }
};

/* ===== /js/pages/quality.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['quality'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [list, stats] = await Promise.all([
      API.get('/api/quality'),
      API.get('/api/quality/stats/summary')
    ]);
    this.draw(view, list.data, stats.data);
  },

  draw(view, rows, stats) {
    const typeLabel = { '进料': '进料检验', '过程': '过程检验', '成品': '成品检验', '外发回收': '外发回收检验' };
    // 合格率看板
    const cards = (stats || []).map(s => `
      <div class="card stat">
        <div class="stat-label">${typeLabel[s.type] || s.type}</div>
        <div class="stat-val">${s.pass_rate}%</div>
        <div class="stat-sub">检验 ${s.total_check} / 不良 ${s.total_ng} / 不合格单 ${s.ng_orders}</div>
      </div>
    `).join('') || '<p class="muted">暂无检验数据</p>';

    const resultColor = r => r === '不合格' ? 'tag-red' : 'tag-green';

    const table = UI.table([
      { key: 'type', label: '类型', render: r => typeLabel[r.type] || r.type },
      { key: 'ref', label: '关联', render: r => r.task_id ? `任务#${r.task_id}` : r.so_id ? `订单#${r.so_id}` : r.outsource_id ? `外发#${r.outsource_id}` : r.material_id ? `物料#${r.material_id}` : r.finished_good_id ? `成品#${r.finished_good_id}` : '—' },
      { key: 'qty_check', label: '检验数' },
      { key: 'qty_ng', label: '不良数' },
      { key: 'result', label: '结果', render: r => `<span class="tag ${resultColor(r.result)}">${UI.esc(r.result)}</span>` },
      { key: 'inspector', label: '检验员', render: r => UI.esc(r.inspector || '—') },
      { key: 'date', label: '日期' },
      { key: 'ops', label: '操作', render: r => `
        <button class="btn-sm" data-act="edit" data-id="${r.id}">编辑</button>
        <button class="btn-sm danger" data-act="del" data-id="${r.id}">删</button>
      ` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>品质管理</h2>
        <button class="btn" id="newBtn">+ 登记检验</button>
      </div>
      <p class="muted">不良品返工处理、工序级追溯支撑（验收8）。进料/过程/成品/外发回收四类检验，按类型统计合格率。</p>
      <div class="cards-row">${cards}</div>
      ${table}
    `;

    view.querySelector('#newBtn').onclick = () => this.openForm(view);
    view.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (btn.dataset.act === 'edit') this.openForm(view, id);
        else if (btn.dataset.act === 'del') this.del(view, id);
      };
    });
  },

  async openForm(view, id) {
    let v = { type: '进料', date: DateUtil.today(), qty_check: 0, qty_ng: 0 };
    if (id) v = (await API.get('/api/quality/' + id)).data;
    const fields = [
      { name: 'type', label: '检验类型', type: 'select', required: true, options: [
        { value: '进料', label: '进料检验' }, { value: '过程', label: '过程检验' },
        { value: '成品', label: '成品检验' }, { value: '外发回收', label: '外发回收检验' }
      ], value: v.type },
      { name: 'task_id', label: '关联任务单ID(可选)', value: v.task_id || '' },
      { name: 'so_id', label: '关联销售订单ID(可选)', value: v.so_id || '' },
      { name: 'outsource_id', label: '关联外发单ID(可选)', value: v.outsource_id || '' },
      { name: 'qty_check', label: '检验总数', type: 'number', required: true, value: v.qty_check },
      { name: 'qty_ng', label: '不良数', type: 'number', value: v.qty_ng },
      { name: 'result', label: '结果', type: 'select', options: [{ value: '合格', label: '合格' }, { value: '不合格', label: '不合格' }], value: v.result },
      { name: 'inspector', label: '检验员', value: v.inspector || '' },
      { name: 'date', label: '日期', type: 'date', required: true, value: v.date },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark || '' }
    ];
    await UI.formModal({
      title: id ? '编辑检验记录' : '登记检验',
      fields,
      onSubmit: async (val) => {
        val.qty_check = Number(val.qty_check) || 0;
        val.qty_ng = Number(val.qty_ng) || 0;
        val.task_id = val.task_id ? Number(val.task_id) : null;
        val.so_id = val.so_id ? Number(val.so_id) : null;
        val.outsource_id = val.outsource_id ? Number(val.outsource_id) : null;
        if (val.qty_ng > val.qty_check) throw new Error('不良数不能大于检验数');
        if (id) await API.put('/api/quality/' + id, val);
        else await API.post('/api/quality', val);
        UI.toast('已保存', 'success'); this.render(view);
      }
    });
  },

  async del(view, id) {
    if (!confirm('确认删除该检验记录？')) return;
    await API.delete('/api/quality/' + id);
    UI.toast('已删除', 'success'); this.render(view);
  }
};

/* ===== /js/pages/finance.js ===== */
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

/* ===== /js/pages/accounting.js ===== */
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

/* ===== /js/pages/ar.js ===== */
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

/* ===== /js/pages/ap.js ===== */
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

/* ===== /js/pages/boss.js ===== */
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

/* ===== /js/pages/quotations.js ===== */
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

/* ===== /js/pages/users.js ===== */
'use strict';

window.Pages = window.Pages || {};

Pages['users'] = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/auth/users');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const roleBadge = r => `<span class="tag ${r.is_active ? 'tag-green' : 'tag-red'}">${UI.esc(r.role)}</span>`;
    const table = UI.table([
      { key: 'username', label: '账号' },
      { key: 'display_name', label: '姓名', render: r => UI.esc(r.display_name || '—') },
      { key: 'role', label: '角色', render: r => roleBadge(r) },
      { key: 'is_active', label: '状态', render: r => r.is_active ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-red">停用</span>' },
      { key: '_act', label: '操作', render: r => `
        <button class="btn-sm" data-action="pw" data-id="${r.id}">改密</button>
        <button class="btn-sm ${r.is_active ? 'danger' : ''}" data-action="toggle" data-id="${r.id}" data-on="${r.is_active}">${r.is_active ? '停用' : '启用'}</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>用户管理</h2>
        <button class="btn" data-action="add">+ 新建账号</button>
      </div>
      <p class="muted">账号权限：老板/管理可看全部；跟单/销售仅看本人客户；采购仅看采购；工程仅看 BOM。密码用 scrypt 加密存储。</p>
      ${table}
    `;

    view.querySelectorAll('[data-action=add]').forEach(b => b.onclick = () => this.openCreate(view));
    view.querySelectorAll('[data-action=pw]').forEach(b => b.onclick = () => this.openPw(view, b.dataset.id));
    view.querySelectorAll('[data-action=toggle]').forEach(b => b.onclick = async () => {
      const on = b.dataset.on === '1';
      if (!confirm(on ? '确认停用该账号？' : '确认启用该账号？')) return;
      try { await API.put('/api/auth/users/' + b.dataset.id, { is_active: on ? 0 : 1 }); UI.toast('已更新', 'success'); this.render(view); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  },

  async openCreate(view) {
    const roleOpts = ['老板', '管理', '工程', '采购', '跟单', '销售', '车间', '品检'].map(r => ({ value: r, label: r }));
    await UI.formModal({
      title: '新建账号',
      submitText: '创建',
      fields: [
        { name: 'username', label: '账号', required: true, value: '' },
        { name: 'password', label: '初始密码', type: 'text', required: true, value: '', placeholder: '至少 6 位' },
        { name: 'display_name', label: '姓名', value: '' },
        { name: 'role', label: '角色', type: 'select', required: true,
          options: roleOpts, value: '跟单' }
      ],
      onSubmit: async (v) => {
        try { await API.post('/api/auth/users', v); UI.toast('账号已创建', 'success'); this.render(view); }
        catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async openPw(view, id) {
    await UI.formModal({
      title: '修改密码',
      submitText: '保存',
      fields: [
        { name: 'password', label: '新密码', type: 'text', required: true, value: '', placeholder: '至少 6 位' }
      ],
      onSubmit: async (v) => {
        try { await API.put('/api/auth/users/' + id, { password: v.password }); UI.toast('密码已更新', 'success'); this.render(view); }
        catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  }
};
