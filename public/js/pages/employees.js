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
