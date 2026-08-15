(function () {
  'use strict';

  function logout() {
    fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
      window.location.href = '/login';
    });
  }

  function installSidebar() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    var path = window.location.pathname.replace(/\/$/, '') || '/dashboard';
    var links = [
      ['/', '🏠', 'الرئيسية'],
      ['/dashboard', '🏠', 'لوحة التحكم'],
      ['/employees', '👥', 'الموظفين'],
      ['/attendance', '🕐', 'الحضور والانصراف'],
      ['/payroll', '💰', 'الرواتب'],
      ['/invoices', '📄', 'الفواتير'],
      ['/payments', '💳', 'المدفوعات'],
      ['/projects', '🏗️', 'المشاريع'],
      ['/reports', '📊', 'التقارير'],
      ['/leaves', '📅', 'الإجازات'],
      ['/end-of-service', '🧮', 'نهاية الخدمة'],
      ['/users', '🔐', 'المستخدمون'],
      ['/audit-log', '📝', 'سجل العمليات'],
      ['/settings', '⚙️', 'الإعدادات']
    ];

    var html = '<div class="logo"><h1>IBuild <span>System</span></h1><p>نظام إدارة الشركة</p></div>';
    html += '<nav class="menu" aria-label="القائمة الرئيسية">';
    html += '<div class="menu-title">الرئيسية</div>';

    links.forEach(function (item, index) {
      if (index === 2) html += '<div class="menu-title">إدارة الشركة</div>';
      if (index === 7) html += '<div class="menu-title projects-menu-title">المشاريع</div>';
      if (index === 9) html += '<div class="menu-title">الموارد والنظام</div>';

      var active = item[0] === '/'
        ? path === '/'
        : path === item[0] || path.indexOf(item[0] + '/') === 0;

      html += '<a class="menu-item' + (active ? ' active' : '') + '" href="' + item[0] + '">';
      html += '<span class="menu-icon">' + item[1] + '</span><span>' + item[2] + '</span></a>';
    });

    html += '</nav>';
    html += '<button type="button" class="logout" id="sharedLogout">🚪 <span>تسجيل الخروج</span></button>';
    sidebar.innerHTML = html;

    var logoutButton = document.getElementById('sharedLogout');
    if (logoutButton) logoutButton.addEventListener('click', logout);

    document.documentElement.setAttribute('dir', document.documentElement.getAttribute('dir') || 'rtl');
  }

  function installStyles() {
    if (document.getElementById('ibuild-shared-sidebar-style')) return;
    var style = document.createElement('style');
    style.id = 'ibuild-shared-sidebar-style';
    style.textContent = `
      .sidebar{position:fixed!important;top:0!important;right:0!important;left:auto!important;width:260px!important;height:100vh!important;z-index:10000!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;padding:25px 18px!important;background:#0f172a!important}
      .sidebar .menu{display:flex!important;flex-direction:column!important;flex:1!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;padding:0 2px 85px!important;margin-top:25px!important}
      .sidebar .menu-title{flex:0 0 auto!important;color:#64748b!important;font-size:11px!important;margin:20px 10px 10px!important}
      .sidebar .menu-item{display:flex!important;align-items:center!important;gap:9px!important;width:100%!important;flex:0 0 auto!important;text-decoration:none!important;border:0!important;background:transparent!important;color:#cbd5e1!important;padding:13px 15px!important;margin-bottom:5px!important;border-radius:8px!important;text-align:right!important;font-size:14px!important;cursor:pointer!important}
      .sidebar .menu-item:hover,.sidebar .menu-item.active{background:#2563eb!important;color:#fff!important}
      .sidebar .menu-icon{width:22px!important;display:inline-flex!important;justify-content:center!important;flex:0 0 22px!important}
      .sidebar .logout{position:absolute!important;bottom:18px!important;right:18px!important;left:18px!important;width:calc(100% - 36px)!important;z-index:10001!important;border:1px solid #475569!important;background:#172033!important;color:#fff!important;padding:12px!important;border-radius:9px!important;cursor:pointer!important}
      .sidebar .logout:hover{background:#dc2626!important;border-color:#dc2626!important}
      .main{margin-right:260px!important;margin-left:0!important;min-height:100vh!important}
      html[dir="ltr"] .sidebar{right:auto!important;left:0!important}
      html[dir="ltr"] .main{margin-left:260px!important;margin-right:0!important}
      @media(max-width:700px){.sidebar{width:220px!important;padding:18px 12px!important}.sidebar .logo h1{font-size:21px!important}.sidebar .menu-item{font-size:13px!important;padding:11px 10px!important}.main{margin-right:220px!important}.sidebar .logout{right:12px!important;left:12px!important;width:calc(100% - 24px)!important}html[dir="ltr"] .main{margin-left:220px!important;margin-right:0!important}}
    `;
    document.head.appendChild(style);
  }

  function start() {
    installStyles();
    installSidebar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
