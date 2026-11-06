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
