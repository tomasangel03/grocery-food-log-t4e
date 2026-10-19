// shell.js — shared app shell: sidebar + topbar, JWT guard, household switcher.
//
// Usage: <body data-page="dashboard"> and load js/household-preview.js before
// this script. The page must contain:
//   <div class="app-shell" id="appShell">
//     <main class="page-main">
//       <div class="page-body"> ...page content... </div>
//     </main>
//   </div>
(function () {
  'use strict';

  var TOKEN_KEY = 'hgfl_token';
  var USER_KEY = 'hgfl_user';
  var ACTIVE_KEY = 'hgfl_household_id';
  var client = window.HouseholdsClient;
  var preview = client && client.isPreview();

  if (!preview && window.location.hash && window.location.hash.indexOf('token=') !== -1) {
    var hashMatch = window.location.hash.match(/token=([^&]+)/);
    if (hashMatch) {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(hashMatch[1]));
      localStorage.removeItem(USER_KEY);
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

  var token = null;
  var user;

  if (preview) {
    var previewUser = (client.user && client.user()) || {};
    user = {
      id: previewUser.id,
      role: previewUser.role || 'member',
      platform_role: previewUser.platform_role || 'user',
      username: previewUser.username || 'preview',
      first_name: previewUser.first_name || '',
      last_name: previewUser.last_name || '',
      email: previewUser.email || ''
    };
  } else {
    token = localStorage.getItem(TOKEN_KEY);
    var payload = token ? parseJwt(token) : null;
    if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.replace('login.html');
      return;
    }
    var storedUser = {};
    try { storedUser = JSON.parse(localStorage.getItem(USER_KEY) || '{}'); } catch (e) { storedUser = {}; }
    user = {
      id: payload.id,
      role: payload.role || storedUser.role || 'member',
      platform_role: payload.platform_role || storedUser.platform_role || (payload.role === 'admin' ? 'system_admin' : 'user'),
      username: payload.username || storedUser.username || 'user',
      first_name: storedUser.first_name || '',
      last_name: storedUser.last_name || '',
      email: storedUser.email || ''
    };
  }

  function initials() {
    if (user.first_name || user.last_name) {
      return ((user.first_name[0] || '') + (user.last_name[0] || '')).toUpperCase();
    }
    return (user.username || 'U').slice(0, 2).toUpperCase();
  }
  function displayName() {
    var n = ((user.first_name || '') + ' ' + (user.last_name || '')).trim();
    return n || user.username;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function roleLabel(role) {
    if (role === 'admin') return 'Admin';
    if (role === 'co_admin') return 'Co-admin';
    if (role === 'member') return 'Member';
    return 'Viewing';
  }

  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  window.Shell = {
    user: user,
    token: token,
    ready: readyPromise,
    household: null,
    households: null,
    canEditItems: false,
    canViewActivity: false,
    isSystemAdmin: user.platform_role === 'system_admin',
    preview: preview
  };

  window.logout = function () {
    if (preview && client) client.stop();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    window.location.href = preview ? 'preview.html' : 'login.html';
  };

  function bearerFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY)
    });
    if (options.body && !options.headers['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }
    var hid = localStorage.getItem(ACTIVE_KEY);
    if (hid) options.headers['X-Household-Id'] = hid;
    return fetch(path, options);
  }

  window.authFetch = function (path, options) {
    return readyPromise.then(function () {
      if (preview) return client.mockFetch(path, options);
      return bearerFetch(path, options).then(function (res) {
        if (res.status === 401) { window.logout(); throw new Error('Session expired'); }
        return res;
      });
    });
  };

  window.toggleSidebar = function () {
    var sb = document.getElementById('appSidebar');
    var bd = document.getElementById('sidebarBackdrop');
    if (!sb) return;
    var open = sb.classList.toggle('open');
    if (bd) bd.classList.toggle('show', open);
  };

  var ICONS = {
    dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    add_grocery: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
    food_log: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z"/><path d="M8 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>',
    households: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
    activity_log: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg>',
    user_management: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
  };

  function navItem(page, href, label) {
    return '<a class="nav-item" href="' + href + '" data-page="' + page + '">' + ICONS[page] + label + '</a>';
  }

  function hiddenBits(show) {
    return show ? { cls: '', style: '' } : { cls: ' nav-hidden', style: ' style="display:none" aria-hidden="true"' };
  }

  function menuRow(home) {
    var active = Shell.household && Shell.household.id === home.id;
    var code = home.join_code ? '<span class="hh-code">' + esc(home.join_code) + '</span>' : '';
    return '<button type="button" class="hh-option' + (active ? ' active' : '') + '" data-id="' + esc(home.id) + '">' +
      '<span class="hh-option-main"><span class="hh-option-name">' + esc(home.name) + '</span>' + code + '</span>' +
      '<span class="hh-role">' + esc(roleLabel(home.role)) + '</span>' +
      (active ? '<span class="hh-check" aria-hidden="true">✓</span>' : '') +
    '</button>';
  }

  function switcherHtml() {
    var data = Shell.households || { memberships: [], all: null, cap: 3, membership_count: 0 };
    var active = Shell.household;
    var label = active ? esc(active.name) : 'Choose household';
    var memberships = data.memberships || [];
    var atCap = (data.membership_count || 0) >= (data.cap || 3);
    var html = '<div class="hh-switch" id="hhSwitch">' +
      '<button type="button" class="hh-switch-btn" id="hhSwitchBtn" aria-haspopup="listbox" aria-expanded="false">' +
        '<span class="hh-switch-name">' + label + '</span>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' +
      '</button>' +
      '<div class="hh-menu" id="hhMenu" hidden>';

    if (Shell.isSystemAdmin) {
      html += '<div class="hh-menu-label">Your households (' + memberships.length + '/' + (data.cap || 3) + ')</div>';
    }
    if (memberships.length === 0) {
      html += '<div class="hh-menu-empty">You are not in a household yet.</div>';
    }
    memberships.forEach(function (home) { html += menuRow(home); });

    if (Shell.isSystemAdmin && data.all) {
      var others = data.all.filter(function (home) { return !home.is_member; });
      html += '<div class="hh-menu-label">All households</div>';
      if (others.length === 0) html += '<div class="hh-menu-empty">No other households yet.</div>';
      others.forEach(function (home) { html += menuRow(home); });
    }

    if (atCap) {
      html += '<div class="hh-add disabled" title="Leave a household to free a slot">Add household — you are in 3 already</div>';
    } else {
      html += '<a class="hh-add" href="onboarding.html?add=1">Add household</a>';
    }
    html += '</div></div>';
    return html;
  }

  function bindSwitcher() {
    var btn = document.getElementById('hhSwitchBtn');
    var menu = document.getElementById('hhMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.querySelectorAll('.hh-option').forEach(function (option) {
      option.addEventListener('click', function () {
        var id = option.getAttribute('data-id');
        if (client) client.setActive(id);
        else localStorage.setItem(ACTIVE_KEY, id);
        window.location.reload();
      });
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !document.getElementById('hhSwitch').contains(e.target)) {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function renderShell() {
    var shell = document.getElementById('appShell') || document.querySelector('.app-shell');
    var main = shell ? shell.querySelector('.page-main') : null;
    if (!shell || !main) return;
    if (shell.querySelector('.app-sidebar')) return;

    var logBits = hiddenBits(Shell.canViewActivity);
    var systemBits = hiddenBits(Shell.isSystemAdmin);
    var adminNav =
      '<a class="nav-item' + logBits.cls + '"' + logBits.style + ' href="activity_log.html" data-page="activity_log">' + ICONS.activity_log + 'Activity Log</a>' +
      '<div class="nav-section-label' + systemBits.cls + '"' + systemBits.style + '>Administration</div>' +
      '<a class="nav-item' + systemBits.cls + '"' + systemBits.style + ' href="user_management.html" data-page="user_management">' + ICONS.user_management + 'User Management</a>';

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
        navItem('households', 'households.html', 'Households') +
        adminNav +
      '</nav>' +
      '<div class="user-card">' +
        '<div class="avatar">' + esc(initials()) + '</div>' +
        '<div>' +
          '<div class="u-name">' + esc(displayName()) + '</div>' +
          '<div class="u-mail">' + esc(user.email || user.username) + '</div>' +
        '</div>' +
      '</div>';
    shell.insertBefore(aside, main);

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
        switcherHtml() +
      '</div>' +
      '<div class="topbar-actions">' +
        '<div class="user-info">' +
          '<div class="avatar">' + esc(initials()) + '</div>' +
          '<span class="user-name">' + esc(displayName()) + '</span>' +
        '</div>' +
        '<button class="btn btn-ghost" onclick="logout()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
          (preview ? 'Exit preview' : 'Logout') +
        '</button>' +
      '</div>';
    main.insertBefore(topbar, main.firstChild);

    if (preview) {
      var banner = document.createElement('div');
      banner.className = 'preview-banner';
      banner.textContent = 'Design preview — nothing is saved. Grocery numbers on this screen are empty sample data.';
      main.insertBefore(banner, topbar.nextSibling);
    }

    var active = document.body.getAttribute('data-page');
    if (active) {
      var item = aside.querySelector('.nav-item[data-page="' + active + '"]');
      if (item) item.classList.add('active');
    }
    bindSwitcher();
  }

  function applySession(me, data) {
    if (me) {
      user.id = me.id || user.id;
      user.username = me.username || user.username;
      user.first_name = me.first_name || '';
      user.last_name = me.last_name || '';
      user.email = me.email || '';
      user.role = me.role || user.role;
      user.platform_role = me.platform_role || user.platform_role;
      Shell.user = user;
      localStorage.setItem(USER_KEY, JSON.stringify(me));
    }
    var memberships = (data && data.memberships) || [];
    var all = data && data.all;
    var isSystem = ((data && data.platform_role) || user.platform_role) === 'system_admin';
    Shell.isSystemAdmin = isSystem;
    Shell.households = data || { memberships: [], all: null, cap: 3, membership_count: 0 };
    var pool = isSystem && all ? all : memberships;
    var stored = localStorage.getItem(ACTIVE_KEY);
    var activeHome = null;
    pool.forEach(function (home) { if (home.id === stored) activeHome = home; });
    if (!activeHome) activeHome = memberships[0] || pool[0] || null;
    Shell.household = activeHome;
    if (activeHome) localStorage.setItem(ACTIVE_KEY, activeHome.id);
    else localStorage.removeItem(ACTIVE_KEY);
    var staff = isSystem || (activeHome && (activeHome.role === 'admin' || activeHome.role === 'co_admin'));
    Shell.canEditItems = !!staff;
    Shell.canViewActivity = !!staff;

    var gate = document.body.getAttribute('data-household-gate');
    var hasSomewhere = memberships.length > 0 || (isSystem && all && all.length > 0);
    if (gate !== 'off' && !hasSomewhere) {
      window.location.replace('onboarding.html');
      return;
    }
    readyResolve();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderShell);
    else renderShell();
  }

  if (preview) {
    client.list().then(function (result) {
      if (!result.ok) {
        window.location.replace('preview.html');
        return;
      }
      applySession(client.user(), result.data);
    });
  } else {
    bearerFetch('v1/auth/me').then(function (res) {
      if (res.status === 401) { window.logout(); return null; }
      return res.json().then(function (body) { return { res: res, body: body }; });
    }).then(function (meResult) {
      if (!meResult || !meResult.res.ok) return;
      return bearerFetch('v1/households').then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Could not load households');
          applySession(meResult.body.user, data);
        });
      });
    }).catch(function () {
      readyResolve();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderShell);
      else renderShell();
    });
  }
})();
