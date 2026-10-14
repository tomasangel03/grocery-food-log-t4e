// scripts/qa-browser.js — full browser-flow QA against the LIVE service.
// Simulates every user journey from the step: page loads for both roles,
// login/register, dashboard stats, multi-item trip, consume, admin edit
// modal (PUT) + remove (DELETE), activity log entries, user management
// (role change, deactivate/reactivate, self-deactivate block), and member
// denial on admin endpoints. Cleans up all test data.
// Usage: node scripts/qa-browser.js [port]
'use strict';
require('dotenv').config();
const pool = require('../db');

const PORT = process.argv[2] || process.env.PORT || 45059;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function report(pass, label, extra) {
  if (pass) console.log(`PASS: ${label}`);
  else { failures++; console.error(`FAIL: ${label}${extra ? ' — ' + extra : ''}`); }
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function page(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  return { status: res.status, text };
}

const cleanup = { userIds: [], tripIds: [] };

(async () => {
  // ══ 1. Static pages load (what the browser fetches) ═══════════════
  const pages = ['/login.html', '/register.html', '/dashboard.html', '/add_grocery.html',
    '/food_log.html', '/activity_log.html', '/user_management.html',
    '/js/shell.js', '/css/global.css', '/css/auth.css'];
  for (const p of pages) {
    const r = await page(p);
    report(r.status === 200 && r.text.length > 100, `page loads — GET ${p}`, `status=${r.status}`);
  }
  // No absolute-path URLs that would escape the proxy prefix
  for (const p of pages.filter(x => x.endsWith('.html'))) {
    const r = await page(p);
    const bad = r.text.match(/(href|src|fetch\(\s*['"])=?['"]\/(?!\/)/g);
    report(!bad, `no absolute-path urls in ${p}`, bad && bad.join(','));
  }
  // Activity log UI includes the remove_item filter + icon mapping
  const alPage = await page('/activity_log.html');
  report(alPage.text.includes('value="remove_item"') && alPage.text.includes('remove_item:'),
    'activity log UI — remove_item filter option + TYPE_META present');
  // Shell hides admin nav for members (nav-hidden gating present)
  const shellJs = await page('/js/shell.js');
  report(shellJs.text.includes('nav-hidden') && shellJs.text.includes("user.role === 'admin'"),
    'shell.js — role-gated admin nav present');
  // Admin pages bounce members client-side
  for (const p of ['/activity_log.html', '/user_management.html']) {
    const r = await page(p);
    report(r.text.includes("Shell.user.role !== 'admin'") && r.text.includes("window.location.replace('dashboard.html')"),
      `member client-side redirect present in ${p}`);
  }

  // ══ 2. Admin login (seeded 'tomas') ════════════════════════════════
  const login = await req('POST', '/v1/auth/login', { body: { username: 'tomas', password: 'ChangeMe123!' } });
  report(login.status === 200 && login.json?.user?.role === 'admin' && !!login.json?.token,
    'admin login — tomas gets 200 + admin JWT', `status=${login.status}`);
  if (!login.json?.token) throw new Error('cannot continue without admin token');
  const adminToken = login.json.token;
  const adminId = login.json.user.id;

  // Bad password rejected
  const badLogin = await req('POST', '/v1/auth/login', { body: { username: 'tomas', password: 'wrong-pass-1' } });
  report(badLogin.status === 401, 'login — wrong password rejected 401', `status=${badLogin.status}`);

  // ══ 3. Member self-registration ════════════════════════════════════
  const email = `qa-member-${Date.now()}@example.com`;
  const reg = await req('POST', '/v1/auth/register', {
    body: { first_name: 'QA', last_name: 'Member', email, password: 'qapass123', password_confirmation: 'qapass123' }
  });
  report(reg.status === 201 && reg.json?.user?.role === 'member',
    'register — self-registration creates member', `status=${reg.status} body=${JSON.stringify(reg.json)}`);
  const memberToken = reg.json?.token;
  const memberId = reg.json?.user?.id;
  const memberUsername = reg.json?.user?.username;
  if (memberId) cleanup.userIds.push(memberId);

  // Weak password / mismatch rejected
  const weak = await req('POST', '/v1/auth/register', {
    body: { first_name: 'A', last_name: 'B', email: `w${Date.now()}@x.com`, password: 'short', password_confirmation: 'short' }
  });
  report(weak.status === 400 && !!weak.json?.errors?.password, 'register — weak password rejected 400', `status=${weak.status}`);
  const dup = await req('POST', '/v1/auth/register', {
    body: { first_name: 'QA', last_name: 'Dup', email, password: 'qapass123', password_confirmation: 'qapass123' }
  });
  report(dup.status === 409, 'register — duplicate email rejected 409', `status=${dup.status}`);

  // ══ 4. Add shopping trip with multiple items (as member) ═══════════
  const today = new Date().toISOString().slice(0, 10);
  const trip = await req('POST', '/v1/shopping-trips', {
    token: memberToken,
    body: {
      trip_date: today, store_name: 'QA Mart',
      items: [
        { name: 'QA Milk', quantity: 2, unit: 'L', price: 3.5 },
        { name: 'QA Apples', quantity: 1.5, unit: 'kg', price: 4.2 },
        { name: 'QA Eggs', quantity: 12, unit: 'pieces', price: 5.0 }
      ]
    }
  });
  const tripId = trip.json?.trip?.id;
  if (tripId) cleanup.tripIds.push(tripId);
  report(trip.status === 201 && trip.json?.items?.length === 3
    && Math.abs(Number(trip.json?.trip?.total_amount) - 12.7) < 0.001,
    'trip — 3 items created, total 12.70', `status=${trip.status}`);
  const [itemA, itemB, itemC] = trip.json?.items || [];

  // ══ 5. Dashboard stats (both roles) ════════════════════════════════
  for (const [who, tok] of [['admin', adminToken], ['member', memberToken]]) {
    const dash = await req('GET', '/v1/dashboard/summary', { token: tok });
    report(dash.status === 200 && Array.isArray(dash.json?.recent_items)
      && Array.isArray(dash.json?.inventory_by_unit) && dash.json?.this_month,
      `dashboard summary — ${who} gets 200 with all sections`, `status=${dash.status}`);
  }
  // Food log list (what food_log.html loads)
  const fl = await req('GET', '/v1/food-items?status=all', { token: memberToken });
  report(fl.status === 200 && (fl.json?.items || []).some(i => i.name === 'QA Milk')
    && typeof fl.json?.show_consumed_default === 'boolean',
    'food log — list includes new items + show_consumed_default flag', `status=${fl.status}`);

  // ══ 6. Consume flow ════════════════════════════════════════════════
  const consume = await req('PATCH', `/v1/food-items/${itemA.id}/consume`, {
    token: memberToken,
    body: { quantity: Number(itemA.quantity) }
  });
  report(consume.status === 200 && consume.json?.item?.status === 'consumed',
    'consume — member marks item consumed', `status=${consume.status}`);
  const dbl = await req('PATCH', `/v1/food-items/${itemA.id}/consume`, {
    token: memberToken,
    body: { quantity: 1 }
  });
  report(dbl.status === 409, 'consume — double consume rejected 409', `status=${dbl.status}`);

  // ══ 7. Admin edit modal (PUT) + remove (DELETE) ════════════════════
  const edit = await req('PUT', `/v1/food-items/${itemB.id}`, {
    token: adminToken, body: { name: 'QA Apples (edited)', quantity: 2, price: 5.55 }
  });
  report(edit.status === 200 && edit.json?.item?.name === 'QA Apples (edited)'
    && Number(edit.json?.item?.price) === 5.55,
    'admin edit — PUT updates name/quantity/price', `status=${edit.status} body=${JSON.stringify(edit.json)}`);
  const editMember = await req('PUT', `/v1/food-items/${itemB.id}`, { token: memberToken, body: { name: 'hax' } });
  report(editMember.status === 403, 'admin edit — member PUT rejected 403', `status=${editMember.status}`);

  const del = await req('DELETE', `/v1/food-items/${itemC.id}`, { token: adminToken });
  report(del.status === 200 && del.json?.deleted === true, 'admin remove — DELETE works', `status=${del.status}`);
  const delMember = await req('DELETE', `/v1/food-items/${itemB.id}`, { token: memberToken });
  report(delMember.status === 403, 'admin remove — member DELETE rejected 403', `status=${delMember.status}`);

  // ══ 8. Activity log — entries + admin-only access ═══════════════════
  const al = await req('GET', '/v1/activity-log?limit=50', { token: adminToken });
  const types = (al.json?.entries || []).map(e => e.action_type);
  report(al.status === 200 && ['add_shopping', 'consume_item', 'edit_item', 'remove_item', 'user_registered']
    .every(t => types.includes(t)),
    'activity log — contains add_shopping/consume/edit/remove/registered entries',
    `status=${al.status} types=${[...new Set(types)].join(',')}`);
  const alFiltered = await req('GET', '/v1/activity-log?actionType=remove_item', { token: adminToken });
  report(alFiltered.status === 200 && (alFiltered.json?.entries || []).every(e => e.action_type === 'remove_item')
    && (alFiltered.json?.entries || []).length > 0,
    'activity log — remove_item filter works', `status=${alFiltered.status}`);
  const alMember = await req('GET', '/v1/activity-log', { token: memberToken });
  report(alMember.status === 403, 'activity log — member rejected 403', `status=${alMember.status}`);

  // ══ 9. User management — role change / deactivate / reactivate ═════
  const usersMember = await req('GET', '/v1/users', { token: memberToken });
  report(usersMember.status === 403, 'users — member rejected 403', `status=${usersMember.status}`);

  const promote = await req('PATCH', `/v1/users/${memberId}`, { token: adminToken, body: { role: 'admin' } });
  report(promote.status === 200 && promote.json?.user?.role === 'admin',
    'user mgmt — role change member→admin', `status=${promote.status}`);
  const demote = await req('PATCH', `/v1/users/${memberId}`, { token: adminToken, body: { role: 'member' } });
  report(demote.status === 200 && demote.json?.user?.role === 'member',
    'user mgmt — role change admin→member', `status=${demote.status}`);

  const deact = await req('PATCH', `/v1/users/${memberId}`, { token: adminToken, body: { is_active: false } });
  report(deact.status === 200 && deact.json?.user?.is_active === false,
    'user mgmt — deactivate member', `status=${deact.status}`);
  const deadLogin = await req('POST', '/v1/auth/login', { body: { username: memberUsername, password: 'qapass123' } });
  report(deadLogin.status === 403, 'user mgmt — deactivated member login blocked 403', `status=${deadLogin.status}`);
  const react = await req('PATCH', `/v1/users/${memberId}`, { token: adminToken, body: { is_active: true } });
  report(react.status === 200 && react.json?.user?.is_active === true,
    'user mgmt — reactivate member', `status=${react.status}`);

  const selfDeact = await req('PATCH', `/v1/users/${adminId}`, { token: adminToken, body: { is_active: false } });
  report(selfDeact.status === 400, 'user mgmt — self-deactivation blocked 400', `status=${selfDeact.status}`);

  // Member cannot change roles either
  const memberPatch = await req('PATCH', `/v1/users/${adminId}`, { token: memberToken, body: { role: 'member' } });
  report(memberPatch.status === 403, 'user mgmt — member PATCH rejected 403', `status=${memberPatch.status}`);

  // Unauthenticated access denied everywhere
  const noAuth = await req('GET', '/v1/food-items');
  report(noAuth.status === 401, 'auth — unauthenticated API access rejected 401', `status=${noAuth.status}`);

  // ══ cleanup ═════════════════════════════════════════════════════════
  for (const tid of cleanup.tripIds) {
    await pool.query('DELETE FROM activity_logs WHERE entity_id IN (SELECT id FROM food_items WHERE shopping_trip_id = ?)', [tid]);
    await pool.query("DELETE FROM activity_logs WHERE action_type IN ('edit_item','consume_item','remove_item') AND action_description LIKE '%QA %'");
    await pool.query('DELETE FROM food_items WHERE shopping_trip_id = ?', [tid]);
    await pool.query('DELETE FROM activity_logs WHERE entity_id = ?', [tid]);
    await pool.query('DELETE FROM shopping_trips WHERE id = ?', [tid]);
  }
  for (const uid of cleanup.userIds) {
    await pool.query('DELETE FROM activity_logs WHERE user_id = ? OR entity_id = ?', [uid, uid]);
    await pool.query('DELETE FROM users WHERE uuid = ?', [uid]);
  }
  await pool.end();

  if (failures > 0) {
    console.error(`\nQA: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nQA: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (err) => {
  console.error('QA FAILED:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});