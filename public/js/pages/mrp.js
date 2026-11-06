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
