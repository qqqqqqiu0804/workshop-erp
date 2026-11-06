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
