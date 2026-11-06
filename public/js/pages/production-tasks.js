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
