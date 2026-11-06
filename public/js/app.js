'use strict';

(function () {
  const view = document.getElementById('view');
  const sidebar = document.getElementById('sidebar');
  const navItems = document.querySelectorAll('.nav-item');
  const authHost = document.getElementById('authHost');

  // 角色 → 可见页面（未列出的页面对所有登录角色可见）
  const ROLE_PAGES = {
    users:        ['老板', '管理'],
    boss:         ['老板', '管理'],
    finance:      ['老板', '管理'],
    accounting:   ['老板', '管理'],   // 会计模块：后端读+写双门禁，非财务角色连看都不能看
    customers:    ['老板', '管理', '跟单', '销售'],
    'sales-orders': ['老板', '管理', '跟单', '销售'],
    quotations:   ['老板', '管理', '跟单', '销售'],
    suppliers:    ['老板', '管理', '采购'],
    'purchase-orders': ['老板', '管理', '采购'],
    'purchase-plans': ['老板', '管理', '采购'],
    boms:        ['老板', '管理', '工程'],
    'bom-import': ['老板', '管理', '工程'],
    employees:    ['老板', '管理'],
    'production-tasks': ['老板', '管理', '车间', '品检'],
    'material-requisitions': ['老板', '管理', '车间', '品检'],
    outsources:   ['老板', '管理', '车间', '品检'],
    quality:      ['老板', '管理', '品检', '车间'],
    'masterdata-import': ['老板', '管理', '工程', '采购', '跟单', '销售'],
  };

  // 各基础档案页（商品/物料/客户/供应商）的导入写角色：仅用于控制「智能导入」按钮可见性，
  // 真实鉴权由后端 requireWriteRole 等效逻辑拦截。
  const IMPORT_WRITE_ROLES = {
    products: ['老板', '管理', '工程'],
    materials: ['老板', '管理', '采购'],
    customers: ['老板', '管理', '跟单', '销售'],
    suppliers: ['老板', '管理', '采购'],
    'finished-goods': ['老板', '管理'],
  };

  // 在档案页页头后注入「智能导入」按钮（类型由 page 决定，按角色可见）
  function injectImportLauncher(page, view) {
    view.querySelectorAll('.import-launcher').forEach(e => e.remove());
    // 页面ID → 导入类型/按钮文案。
    // 注意：本应用「物料档案」在 inventory（原料库存）页、「成品档案」在 products（产品信息）页，
    // 不存在名为 materials 的页面；finished-goods（成品库存）是独立库存台账表，暂不挂导入（见任务 #130）。
    const PAGE_IMPORT = {
      products:  { type: 'products',  label: '商品' },
      inventory: { type: 'materials', label: '物料' },
      customers: { type: 'customers', label: '客户' },
      suppliers: { type: 'suppliers', label: '供应商' },
      'finished-goods': { type: 'finished-goods', label: '成品' },
    };
    const m = PAGE_IMPORT[page];
    if (!m) return;
    const role = (window.currentUser && window.currentUser.role) || null;
    if (!IMPORT_WRITE_ROLES[m.type].includes(role)) return;
    const bar = document.createElement('div');
    bar.className = 'import-launcher no-print';
    bar.style.cssText = 'margin:10px 0';
    bar.innerHTML = `<button class="btn btn-primary" type="button">${window.AppIcons['import']} 智能导入${m.label}</button>`;
    bar.querySelector('button').onclick = () => { window.__importType = m.type; window.navigate('masterdata-import'); };
    const head = view.querySelector('.page-head');
    if (head) head.after(bar); else view.prepend(bar);
  }

  function setToday() {
    const d = new Date();
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    document.getElementById('todayLabel').textContent = `${d.getFullYear()}-${mm}-${dd} 周${wd}`;
  }

  function renderNav() {
    const role = (window.currentUser && window.currentUser.role) || null;
    navItems.forEach(n => {
      const page = n.dataset.page;
      const allowed = !ROLE_PAGES[page] || ROLE_PAGES[page].includes(role);
      n.style.display = allowed ? '' : 'none';
    });
    // P0：隐藏没有任何可见子项的「幽灵分组」（连同其折展开容器）
    document.querySelectorAll('.nav-group-wrap').forEach(w => {
      const box = w.querySelector('.nav-group-items');
      let visible = 0;
      if (box) box.querySelectorAll('.nav-item').forEach(s => { if (s.style.display !== 'none') visible++; });
      w.style.display = visible === 0 ? 'none' : '';
    });
    const bar = document.getElementById('userBar');
    if (window.currentUser) {
      const u = window.currentUser;
      bar.innerHTML = `<span class="ub-user">${UI.esc(u.displayName || u.username)} <span class="ub-role">${UI.esc(u.role)}</span></span>` +
        `<button class="btn btn-sm" id="logoutBtn">退出</button>`;
      bar.querySelector('#logoutBtn').onclick = doLogout;
    } else {
      bar.innerHTML = '';
    }
  }

  async function navigate(page) {
    // 关键修复：view 是常驻容器，仅替换 innerHTML 不会移除其上的事件监听。
    // 委托式页面（采购单/库存/客户等）把 view.onclick 挂上后，切到不重置它的页面
    // （生产任务单/报价单等只绑按钮 onclick）会导致旧处理器泄漏、误劫持 [data-action] 点击。
    // 每次切页先归零，委托页会在自己 render 内重新设置，非委托页保持 null。
    view.onclick = null;
    navItems.forEach(n => {
      const on = n.dataset.page === page;
      n.classList.toggle('active', on);
      if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
    });
    // 展开当前页所在分组（避免激活项被折叠藏住）
    const cur = document.querySelector(`.nav-item[data-page="${page}"]`);
    const gi = cur && cur.closest('.nav-group-items');
    const head = gi && gi.previousElementSibling;
    if (head && head.classList.contains('nav-group')) {
      head.classList.remove('collapsed');
      head.setAttribute('aria-expanded', 'true');
    }
    if (!Pages[page]) { view.innerHTML = '<div class="empty">页面不存在</div>'; return; }
    try {
      await Pages[page].render(view);
      injectImportLauncher(page, view);
    } catch (err) {
      console.error(err);
      view.innerHTML = `<div class="empty"><div class="big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>加载失败：${UI.esc(err.message)}</div>`;
    }
    closeSidebar();
    window.scrollTo(0, 0);
  }

  navItems.forEach(n => n.addEventListener('click', (e) => { e.preventDefault(); navigate(n.dataset.page); }));
  window.navigate = navigate; // 供页面内跳转（如导入向导返回档案页）

  // 分组折叠状态记忆（localStorage）：用过即常驻，刷新后保持
  const NAV_STATE_KEY = 'workshop.nav.collapsed';
  function navLoadState() {
    try { return JSON.parse(localStorage.getItem(NAV_STATE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function navSaveState(state) {
    try { localStorage.setItem(NAV_STATE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function navApplyState() {
    const state = navLoadState();
    document.querySelectorAll('.nav-group').forEach(g => {
      const key = g.dataset.group;
      if (!key || !Object.prototype.hasOwnProperty.call(state, key)) return;
      const collapsed = !!state[key];
      g.classList.toggle('collapsed', collapsed);
      g.setAttribute('aria-expanded', String(!collapsed));
    });
  }
  navApplyState(); // 先按记忆覆盖默认折叠态

  // 分组折叠（手风琴）：点击分组标题展开/收起其下菜单项
  document.querySelectorAll('.nav-group').forEach(g => {
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    const syncAria = () => g.setAttribute('aria-expanded', g.classList.contains('collapsed') ? 'false' : 'true');
    syncAria();
    const toggle = () => {
      const collapsed = g.classList.toggle('collapsed');
      syncAria();
      const state = navLoadState();        // 记忆用户本次操作，刷新后保持
      state[g.dataset.group] = collapsed;
      navSaveState(state);
    };
    g.addEventListener('click', toggle);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  // 首次加载：确保当前激活页所在分组处于展开态（不被默认折叠藏住）
  const activeItem = document.querySelector('.nav-item.active');
  if (activeItem) {
    const gi = activeItem.closest('.nav-group-items');
    const head = gi && gi.previousElementSibling;
    if (head && head.classList.contains('nav-group')) {
      head.classList.remove('collapsed');
      head.setAttribute('aria-expanded', 'true');
    }
  }

  // 移动端抽屉：打开时显示遮罩，点击遮罩或任意导航项后关闭
  const navBackdrop = document.createElement('div');
  navBackdrop.className = 'nav-backdrop';
  navBackdrop.addEventListener('click', closeSidebar);
  document.body.appendChild(navBackdrop);
  function closeSidebar() { sidebar.classList.remove('open'); navBackdrop.classList.remove('show'); }
  document.getElementById('menuToggle').addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    navBackdrop.classList.toggle('show', open);
  });

  /* ---------- 登录层 ---------- */
  function showLogin() {
    authHost.innerHTML = `
      <div class="auth-overlay">
        <form class="auth-card" id="loginForm" aria-label="登录">
          <div class="auth-logo" id="authLogo"></div>
          <h2>五金厂工作台</h2>
          <p class="auth-sub">请登录后再使用</p>
          <label class="sr-only" for="lu">账号</label>
          <input class="input" id="lu" placeholder="账号" autocomplete="username" aria-label="账号" />
          <label class="sr-only" for="lp">密码</label>
          <input class="input" id="lp" type="password" placeholder="密码" autocomplete="current-password" aria-label="密码" />
          <button class="btn btn-primary btn-block" type="submit">登录</button>
          <div class="auth-err" id="authErr"></div>
        </form>
      </div>`;
    const al = authHost.querySelector('#authLogo');
    if (al && window.AppIcons) al.innerHTML = window.AppIcons.brand;
    const form = authHost.querySelector('#loginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = authHost.querySelector('#lu').value.trim();
      const password = authHost.querySelector('#lp').value;
      try {
        const r = await API.post('/api/auth/login', { username, password });
        window.currentUser = r.data;
        authHost.innerHTML = '';
        renderNav();
        navigate('dashboard');
      } catch (err) {
        authHost.querySelector('#authErr').textContent = err.message || '登录失败';
      }
    });
    setTimeout(() => authHost.querySelector('#lu') && authHost.querySelector('#lu').focus(), 50);
  }

  async function doLogout() {
    try { await API.post('/api/auth/logout', {}); } catch (_) {}
    window.currentUser = null;
    renderNav();
    showLogin();
  }

  async function boot() {
    setToday();
    try {
      const r = await API.get('/api/auth/me');
      window.currentUser = r.data;
      renderNav();
      navigate('dashboard');
    } catch (_) {
      window.currentUser = null;
      renderNav();
      showLogin();
    }
  }

  boot();
})();
