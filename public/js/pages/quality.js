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
