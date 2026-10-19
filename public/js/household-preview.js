// household-preview.js — in-browser household walkthrough, and the client
// the real pages use when the preview flag is off.
(function () {
  'use strict';

  var PREVIEW_FLAG = 'hgfl_preview';
  var STATE_KEY = 'hgfl_preview_state';
  var ACTIVE_KEY = 'hgfl_household_id';
  var TOKEN_KEY = 'hgfl_token';
  var USER_KEY = 'hgfl_user';
  var CAP = 3;
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function uid(n) {
    var hex = String(n).padStart(12, '0');
    return '00000000-0000-4000-8000-' + hex;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function person(id, username, first, last, email) {
    return { id: id, username: username, first_name: first, last_name: last, email: email };
  }

  var PEOPLE = {
    alex: person(uid(1), 'alex', 'Alex', 'Rivera', 'alex@example.com'),
    jordan: person(uid(2), 'jordan', 'Jordan', 'Lee', 'jordan@example.com'),
    sam: person(uid(3), 'sam', 'Sam', 'Patel', 'sam@example.com'),
    riley: person(uid(4), 'riley', 'Riley', 'Nguyen', 'riley@example.com'),
    tomas: person(uid(5), 'tomas', 'Tomas', 'Angel', 'tomas@example.com'),
    parent: person(uid(6), 'camila', 'Camila', 'Ruiz', 'camila@example.com'),
    neighbor: person(uid(7), 'noah', 'Noah', 'Diaz', 'noah@example.com')
  };

  function member(key, role) {
    var p = PEOPLE[key];
    return {
      id: p.id,
      username: p.username,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      role: role
    };
  }

  function baseDirectory() {
    return [
      {
        id: uid(101),
        name: 'Home',
        join_code: 'K7M2QP4X',
        members: [member('jordan', 'admin'), member('sam', 'co_admin'), member('riley', 'member')]
      },
      {
        id: uid(102),
        name: 'Parents',
        join_code: 'PARENT0A',
        members: [member('parent', 'admin'), member('jordan', 'member')]
      },
      {
        id: uid(103),
        name: 'Apartment',
        join_code: 'APT29LQW',
        members: [member('neighbor', 'admin'), member('sam', 'member')]
      },
      {
        id: uid(104),
        name: 'Tomas household',
        join_code: 'TOMAS001',
        members: [member('tomas', 'admin'), member('riley', 'member')]
      },
      {
        id: uid(105),
        name: 'Weekend house',
        join_code: 'WKND88AZ',
        members: [member('neighbor', 'admin')]
      }
    ];
  }

  function personaState(name) {
    var directory = baseDirectory();
    if (name === 'new') {
      return {
        user: Object.assign({ role: 'member', platform_role: 'user' }, PEOPLE.alex),
        directory: directory,
        activeId: null
      };
    }
    if (name === 'admin') {
      return {
        user: Object.assign({ role: 'member', platform_role: 'user' }, PEOPLE.jordan),
        directory: directory,
        activeId: uid(101)
      };
    }
    if (name === 'coadmin') {
      return {
        user: Object.assign({ role: 'member', platform_role: 'user' }, PEOPLE.sam),
        directory: directory,
        activeId: uid(101)
      };
    }
    if (name === 'full') {
      directory.push({
        id: uid(106),
        name: 'Office kitchen',
        join_code: 'OFFC33KD',
        members: [member('neighbor', 'admin'), member('riley', 'member')]
      });
      return {
        user: Object.assign({ role: 'member', platform_role: 'user' }, PEOPLE.riley),
        directory: directory,
        activeId: uid(101)
      };
    }
    return {
      user: Object.assign({ role: 'admin', platform_role: 'system_admin' }, PEOPLE.tomas),
      directory: directory,
      activeId: uid(104)
    };
  }

  function isPreview() {
    return localStorage.getItem(PREVIEW_FLAG) === '1';
  }

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    if (state.activeId) localStorage.setItem(ACTIVE_KEY, state.activeId);
    else localStorage.removeItem(ACTIVE_KEY);
  }

  function start(persona) {
    localStorage.setItem(PREVIEW_FLAG, '1');
    localStorage.removeItem(TOKEN_KEY);
    var state = personaState(persona || 'new');
    writeState(state);
    return state;
  }

  function stop() {
    localStorage.removeItem(PREVIEW_FLAG);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  }

  function requireState() {
    var state = readState();
    if (!state) state = start('new');
    return state;
  }

  function randomCode(directory) {
    var taken = {};
    directory.forEach(function (h) { taken[h.join_code] = true; });
    var code = '';
    do {
      code = '';
      for (var i = 0; i < 8; i += 1) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (taken[code]);
    return code;
  }

  function findHome(state, id) {
    for (var i = 0; i < state.directory.length; i += 1) {
      if (state.directory[i].id === id) return state.directory[i];
    }
    return null;
  }

  function findByCode(state, code) {
    var normalized = String(code || '').trim().toUpperCase();
    for (var i = 0; i < state.directory.length; i += 1) {
      if (state.directory[i].join_code === normalized) return state.directory[i];
    }
    return null;
  }

  function roleIn(home, userId) {
    if (!home) return null;
    for (var i = 0; i < home.members.length; i += 1) {
      if (home.members[i].id === userId) return home.members[i].role;
    }
    return null;
  }

  function present(home, user, reveal) {
    var role = roleIn(home, user.id);
    var system = user.platform_role === 'system_admin';
    var show = reveal || system || role === 'admin' || role === 'co_admin';
    return {
      id: home.id,
      name: home.name,
      join_code: show ? home.join_code : null,
      role: role,
      member_count: home.members.length,
      is_member: !!role
    };
  }

  function listFrom(state) {
    var memberships = [];
    state.directory.forEach(function (home) {
      if (roleIn(home, state.user.id)) memberships.push(present(home, state.user));
    });
    memberships.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var all = null;
    if (state.user.platform_role === 'system_admin') {
      all = state.directory.map(function (home) { return present(home, state.user, true); });
      all.sort(function (a, b) { return a.name.localeCompare(b.name); });
    }
    return {
      memberships: memberships,
      all: all,
      cap: CAP,
      membership_count: memberships.length,
      platform_role: state.user.platform_role
    };
  }

  function fail(message, status) {
    return { ok: false, status: status || 400, data: { error: message } };
  }

  function ok(data, status) {
    return { ok: true, status: status || 200, data: data };
  }

  function membershipCount(state) {
    return listFrom(state).membership_count;
  }

  var api = {
    isPreview: isPreview,
    start: start,
    stop: stop,
    user: function () {
      var state = readState();
      return state ? state.user : null;
    },
    list: function () {
      if (!isPreview()) return remote('v1/households');
      return Promise.resolve(ok(listFrom(requireState())));
    },
    create: function (name) {
      if (!isPreview()) return remote('v1/households', { method: 'POST', body: { name: name } });
      var state = requireState();
      var trimmed = String(name || '').trim().replace(/\s+/g, ' ');
      if (!trimmed || trimmed.length > 40) return Promise.resolve(fail('Enter a household name up to 40 characters'));
      if (membershipCount(state) >= CAP) {
        return Promise.resolve(fail('You can belong to 3 households. Leave one to create another.', 409));
      }
      var home = {
        id: uid(Date.now() % 1000000000000),
        name: trimmed,
        join_code: randomCode(state.directory),
        members: [Object.assign({ role: 'admin' }, state.user)]
      };
      delete home.members[0].platform_role;
      delete home.members[0].role;
      home.members[0].role = 'admin';
      state.directory.push(home);
      state.activeId = home.id;
      writeState(state);
      return Promise.resolve(ok({ household: present(home, state.user, true) }, 201));
    },
    lookup: function (code) {
      if (!isPreview()) return remote('v1/households/lookup?code=' + encodeURIComponent(code || ''));
      var home = findByCode(requireState(), code);
      if (!home) return Promise.resolve(fail('No household uses that code', 404));
      return Promise.resolve(ok({ household: { id: home.id, name: home.name } }));
    },
    join: function (code) {
      if (!isPreview()) return remote('v1/households/join', { method: 'POST', body: { code: code } });
      var state = requireState();
      var home = findByCode(state, code);
      if (!home) return Promise.resolve(fail('No household uses that code', 404));
      if (roleIn(home, state.user.id)) return Promise.resolve(fail('You are already in this household', 409));
      if (membershipCount(state) >= CAP) {
        return Promise.resolve(fail('You can belong to 3 households. Leave one to join another.', 409));
      }
      home.members.push(Object.assign({ role: 'member' }, {
        id: state.user.id,
        username: state.user.username,
        first_name: state.user.first_name,
        last_name: state.user.last_name,
        email: state.user.email
      }));
      state.activeId = home.id;
      writeState(state);
      return Promise.resolve(ok({ household: present(home, state.user) }, 201));
    },
    members: function (householdId) {
      if (!isPreview()) return remote('v1/households/' + encodeURIComponent(householdId) + '/members');
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var role = roleIn(home, state.user.id);
      if (!role && state.user.platform_role !== 'system_admin') {
        return Promise.resolve(fail('You are not a member of this household', 403));
      }
      return Promise.resolve(ok({ members: clone(home.members) }));
    },
    rename: function (householdId, name) {
      if (!isPreview()) return remote('v1/households/' + encodeURIComponent(householdId), { method: 'PATCH', body: { name: name } });
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var role = roleIn(home, state.user.id);
      if (role !== 'admin' && state.user.platform_role !== 'system_admin') {
        return Promise.resolve(fail('Only the household admin can rename it', 403));
      }
      var trimmed = String(name || '').trim().replace(/\s+/g, ' ');
      if (!trimmed || trimmed.length > 40) return Promise.resolve(fail('Enter a household name up to 40 characters'));
      home.name = trimmed;
      writeState(state);
      return Promise.resolve(ok({ household: { id: home.id, name: home.name } }));
    },
    leave: function (householdId) {
      if (!isPreview()) return remote('v1/households/' + encodeURIComponent(householdId) + '/leave', { method: 'POST', body: {} });
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var role = roleIn(home, state.user.id);
      if (!role) return Promise.resolve(fail('You are not a member of this household', 404));
      if (role === 'admin') {
        return Promise.resolve(fail('Transfer the admin role before you leave. If you are the only member, delete the household.', 409));
      }
      home.members = home.members.filter(function (m) { return m.id !== state.user.id; });
      if (state.activeId === householdId) state.activeId = null;
      writeState(state);
      return Promise.resolve(ok({ left: true }));
    },
    removeMember: function (householdId, userId) {
      if (!isPreview()) {
        return remote('v1/households/' + encodeURIComponent(householdId) + '/members/' + encodeURIComponent(userId), { method: 'DELETE' });
      }
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var callerRole = roleIn(home, state.user.id);
      if (state.user.platform_role !== 'system_admin' && callerRole !== 'admin' && callerRole !== 'co_admin') {
        return Promise.resolve(fail('You cannot remove members', 403));
      }
      var target = null;
      home.members.forEach(function (m) { if (m.id === userId) target = m; });
      if (!target) return Promise.resolve(fail('That person is not in this household', 404));
      if (target.role === 'admin') return Promise.resolve(fail('The household admin cannot be removed', 403));
      if (target.id === state.user.id) return Promise.resolve(fail('Use leave to remove yourself', 400));
      home.members = home.members.filter(function (m) { return m.id !== userId; });
      writeState(state);
      return Promise.resolve(ok({ removed: true }));
    },
    setRole: function (householdId, userId, role) {
      if (!isPreview()) {
        return remote(
          'v1/households/' + encodeURIComponent(householdId) + '/members/' + encodeURIComponent(userId),
          { method: 'PATCH', body: { role: role } }
        );
      }
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var callerRole = roleIn(home, state.user.id);
      if (callerRole !== 'admin' && state.user.platform_role !== 'system_admin') {
        return Promise.resolve(fail('Only the household admin can change the co-admin', 403));
      }
      var target = null;
      home.members.forEach(function (m) { if (m.id === userId) target = m; });
      if (!target) return Promise.resolve(fail('That person is not in this household', 404));
      if (target.role === 'admin') return Promise.resolve(fail('The household admin cannot be demoted here', 403));
      if (role === 'co_admin') {
        var occupied = home.members.some(function (m) { return m.role === 'co_admin' && m.id !== userId; });
        if (occupied) return Promise.resolve(fail('Return the current co-admin to member first', 409));
      }
      target.role = role;
      writeState(state);
      return Promise.resolve(ok({ role: role }));
    },
    transfer: function (householdId, userId) {
      if (!isPreview()) {
        return remote('v1/households/' + encodeURIComponent(householdId) + '/transfer', { method: 'POST', body: { user_id: userId } });
      }
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var founder = null;
      var target = null;
      home.members.forEach(function (m) {
        if (m.role === 'admin') founder = m;
        if (m.id === userId) target = m;
      });
      if (!founder || (founder.id !== state.user.id && state.user.platform_role !== 'system_admin')) {
        return Promise.resolve(fail('Only the household admin can transfer that role', 403));
      }
      if (!target || target.id === founder.id) return Promise.resolve(fail('Choose another member', 400));
      founder.role = 'member';
      target.role = 'admin';
      writeState(state);
      return Promise.resolve(ok({ transferred: true }));
    },
    destroy: function (householdId) {
      if (!isPreview()) return remote('v1/households/' + encodeURIComponent(householdId), { method: 'DELETE' });
      var state = requireState();
      var home = findHome(state, householdId);
      if (!home) return Promise.resolve(fail('Household not found', 404));
      var callerRole = roleIn(home, state.user.id);
      if (callerRole !== 'admin' && state.user.platform_role !== 'system_admin') {
        return Promise.resolve(fail('Only the household admin can delete it', 403));
      }
      if (home.members.length !== 1) {
        return Promise.resolve(fail('Remove every other member before deleting this household', 409));
      }
      state.directory = state.directory.filter(function (h) { return h.id !== householdId; });
      if (state.activeId === householdId) state.activeId = null;
      writeState(state);
      return Promise.resolve(ok({ deleted: true }));
    },
    setActive: function (id) {
      if (isPreview()) {
        var state = requireState();
        state.activeId = id;
        writeState(state);
      } else {
        localStorage.setItem(ACTIVE_KEY, id);
      }
    },
    mockFetch: function (path) {
      var url = String(path || '').split('?')[0];
      if (url.indexOf('v1/dashboard/summary') !== -1) {
        return jsonResult({
          recent_items: [],
          inventory_by_unit: [],
          this_month: { total_items: 0, total_spent: 0, trip_count: 0 },
          recent_consumption: { trip_count: 0, item_count: 0, consumed_count: 0, percent: 0 },
          consumed_this_week: 0
        });
      }
      if (url.indexOf('v1/food-items') !== -1) return jsonResult({ items: [], show_consumed_default: false });
      if (url.indexOf('v1/activity-log') !== -1) return jsonResult({ entries: [], limit: 200, offset: 0 });
      if (url.indexOf('v1/users') !== -1) return jsonResult({ users: [] });
      var membersMatch = url.match(/v1\/households\/([^/]+)\/members$/);
      if (membersMatch) {
        return api.members(decodeURIComponent(membersMatch[1])).then(function (result) {
          return {
            ok: result.ok,
            status: result.status,
            json: function () { return Promise.resolve(result.data); }
          };
        });
      }
      return jsonResult({ error: 'This preview only covers households' }, 404);
    }
  };

  function remote(path, options) {
    options = options || {};
    var headers = { Authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') };
    if (options.body) headers['Content-Type'] = 'application/json';
    var hid = localStorage.getItem(ACTIVE_KEY);
    if (hid) headers['X-Household-Id'] = hid;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      }).catch(function () {
        return { ok: res.ok, status: res.status, data: {} };
      });
    });
  }

  function jsonResult(data, status) {
    return Promise.resolve({
      ok: (status || 200) < 400,
      status: status || 200,
      json: function () { return Promise.resolve(data); }
    });
  }

  window.HouseholdsClient = api;
})();
