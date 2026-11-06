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
