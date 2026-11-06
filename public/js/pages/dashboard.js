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
