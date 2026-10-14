// shell.js — shared app shell: sidebar + topbar rendering, JWT guard,
// role-based nav visibility, mobile drawer toggle, logout, authFetch helper.
//
// Usage: <body data-page="dashboard"> ... include this script on every
// authenticated page. The page must contain:
//   <div class="app-shell" id="appShell">
//     <main class="page-main">
//       <div class="page-body"> ...page content... </div>
//     </main>
//   </div>
// The shell injects the <aside> sidebar and <header> topbar automatically.
(function () {
  'use strict';

  var TOKEN_KEY = 'hgfl_token';
  var USER_KEY = 'hgfl_user';

  // ---- 1. Capture OAuth fragment token (Google callback lands on
  //         dashboard.html#token=...) before anything else. ----
  if (window.location.hash && window.location.hash.indexOf('token=') !== -1) {
    var m = window.location.hash.match(/token=([^&]+)/);
    if (m) {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      localStorage.removeItem(USER_KEY); // rebuild from the new token payload
      // Strip the fragment so the token never lingers in the address bar
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  function parseJwt(token) {
    try {
      var base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(atob(base64).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
    } catch (e) {
      return null;
    }
  }

  // ---- 2. JWT guard: redirect to login when missing/expired. ----
  var token = localStorage.getItem(TOKEN_KEY);
  var payload = token ? parseJwt(token) : null;
  if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.replace('login.html');
    return;
  }

  var storedUser = {};
  try { storedUser = JSON.parse(localStorage.getItem(USER_KEY) || '{}'); } catch (e) { storedUser = {}; }

  var user = {
    id: payload.id,
    role: payload.role || 'member',
    username: payload.username || storedUser.username || 'user',
    first_name: storedUser.first_name || '',
    last_name: storedUser.last_name || '',
    email: storedUser.email || ''
  };

  function initials() {
    if (user.first_name || user.last_name) {
      return ((user.first_name[0] || '') + (user.last_name[0] || '')).toUpperCase();
    }
    return (user.username || 'U').slice(0, 2).toUpperCase();
  }
  function displayName() {
    var n = (user.first_name + ' ' + user.last_name).trim();
    return n || user.username;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- 3. Public helpers ----
  window.Shell = { user: user, token: token };

  window.logout = function () {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = 'login.html';
  };

  // fetch wrapper: relative URLs only, Authorization header, 401/403 → login
  window.authFetch = function (path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      'Authorization': 'Bearer ' + localStorage.getItem(TOKEN_KEY)
    });
    if (options.body && !options.headers['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, options).then(function (res) {
      if (res.status === 401) { window.logout(); throw new Error('Session expired'); }
      return res;
    });
  };

  window.toggleSidebar = function () {
    var sb = document.getElementById('appSidebar');
    var bd = document.getElementById('sidebarBackdrop');
    if (!sb) return;
    var open = sb.classList.toggle('open');
    if (bd) bd.classList.toggle('show', open);
  };

  // ---- 4. Render sidebar + topbar ----
  var ICONS = {
    dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    add_grocery: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
    food_log: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z"/><path d="M8 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>',
    activity_log: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg>',
    user_management: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
  };

  function navItem(page, href, label) {
    return '<a class="nav-item" href="' + href + '" data-page="' + page + '">' + ICONS[page] + label + '</a>';
  }

  function renderShell() {
    var shell = document.getElementById('appShell') || document.querySelector('.app-shell');
    var main = shell ? shell.querySelector('.page-main') : null;
    if (!shell || !main) return;

    var isAdmin = user.role === 'admin';

    // Admin-only nav items (Activity Log + User Management): always rendered,
    // but given a hidden / display:none state when the stored user role is
    // member. This is UI gating only — the server-side 403s in
    // middleware/auth.js (requireAdmin) remain the real enforcement.
    var hiddenCls = isAdmin ? '' : ' nav-hidden';
    var hiddenStyle = isAdmin ? '' : ' style="display:none" aria-hidden="true"';
    var adminNav =
      '<a class="nav-item' + hiddenCls + '"' + hiddenStyle + ' href="activity_log.html" data-page="activity_log">' + ICONS.activity_log + 'Activity Log</a>' +
      '<div class="nav-section-label' + hiddenCls + '"' + hiddenStyle + '>Administration</div>' +
      '<a class="nav-item' + hiddenCls + '"' + hiddenStyle + ' href="user_management.html" data-page="user_management">' + ICONS.user_management + 'User Management</a>';

    var aside = document.createElement('aside');
    aside.className = 'sidebar app-sidebar';
    aside.id = 'appSidebar';
    aside.innerHTML =
      '<div class="logo-row">' +
        '<div class="logo-mark">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>' +
        '</div>' +
        '<div class="logo-name">FoodLog</div>' +
      '</div>' +
      '<nav class="side-nav">' +
        navItem('dashboard', 'dashboard.html', 'Dashboard') +
        navItem('add_grocery', 'add_grocery.html', 'Add Grocery') +
        navItem('food_log', 'food_log.html', 'Food Log') +
        adminNav +
      '</nav>' +
      '<div class="user-card">' +
        '<div class="avatar">' + esc(initials()) + '</div>' +
        '<div>' +
          '<div class="u-name">' + esc(displayName()) + '</div>' +
          '<div class="u-mail">' + esc(user.email || user.role) + '</div>' +
        '</div>' +
      '</div>';
    shell.insertBefore(aside, main);

    // Backdrop for the mobile drawer
    var backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.id = 'sidebarBackdrop';
    backdrop.addEventListener('click', window.toggleSidebar);
    shell.appendChild(backdrop);

    var topbar = document.createElement('header');
    topbar.className = 'topbar app-topbar';
    topbar.innerHTML =
      '<div class="topbar-left">' +
        '<button class="btn btn-ghost btn-sm sidebar-toggle" onclick="toggleSidebar()" aria-label="Toggle navigation">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="topbar-actions">' +
        '<div class="user-info">' +
          '<div class="avatar">' + esc(initials()) + '</div>' +
          '<span class="user-name">' + esc(displayName()) + '</span>' +
        '</div>' +
        '<button class="btn btn-ghost" onclick="logout()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
          'Logout' +
        '</button>' +
      '</div>';
    main.insertBefore(topbar, main.firstChild);

    // Mark the active nav item from <body data-page="...">
    var active = document.body.getAttribute('data-page');
    if (active) {
      var item = aside.querySelector('.nav-item[data-page="' + active + '"]');
      if (item) item.classList.add('active');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderShell);
  } else {
    renderShell();
  }
})();