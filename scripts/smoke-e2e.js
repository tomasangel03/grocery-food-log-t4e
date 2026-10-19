// scripts/smoke-e2e.js — Step 13: end-to-end smoke test of all flows against the RUNNING service.
// Usage: node scripts/smoke-e2e.js <port>
'use strict';
require('dotenv').config();
const assert = require('assert');
const pool = require('../db');

const PORT = process.argv[2] || process.env.SMOKE_PORT || 45059;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, path, { token, body, raw, householdId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (householdId) headers['X-Household-Id'] = householdId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (raw) {
    return { status: res.status, text: await res.text() };
  }
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

let passed = 0;
function ok(cond, label, extra) {
  assert.ok(cond, `FAIL: ${label}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`PASS: ${label}`);
}

const cleanup = { userIds: [], tripIds: [] };

(async () => {
  // ── (1) admin login ─────────────────────────────────────────────
  const login = await req('POST', '/v1/auth/login', {
    body: { username: 'tomas', password: 'ChangeMe123!' }
  });
  ok(login.status === 200, '(1) admin login returns 200', JSON.stringify(login.json));
  ok(!!login.json.token, '(1) admin login returns a JWT');
  const adminToken = login.json.token;
  const adminId = login.json.user.id || login.json.user.uuid;
  ok(!!adminId, '(1) admin login returns user id');

  // ── (2) self-registration → member + user_registered audit row ──
  const email = `smoke-e2e-${Date.now()}@example.com`;
  const reg = await req('POST', '/v1/auth/register', {
    body: {
      first_name: 'Smoke', last_name: 'EndToEnd', email,
      password: 'passw0rd123', password_confirmation: 'passw0rd123'
    }
  });
  ok(reg.status === 201, '(2) register returns 201', JSON.stringify(reg.json));
  ok(reg.json.user.role === 'member', "(2) new user defaults to role='member'");
  const memberToken = reg.json.token;
  const memberId = reg.json.user.id || reg.json.user.uuid;
  cleanup.userIds.push(memberId);
  const [regLog] = await pool.query(
    "SELECT id FROM activity_logs WHERE user_id = ? AND action_type = 'user_registered'",
    [memberId]
  );
  ok(regLog.length === 1, '(2) user_registered activity row written (DB verified)');

  const homes = await req('GET', '/v1/households', { token: adminToken });
  const householdId = homes.json.memberships[0].id;
  const joinCode = String(homes.json.memberships[0].join_code).trim();
  ok(joinCode.length === 8, '(2b) household code is 8 characters');
  const joined = await req('POST', '/v1/households/join', { token: memberToken, body: { code: joinCode } });
  ok(joined.status === 201, '(2b) member joins the household', JSON.stringify(joined.json));

  // ── (3) shopping trip with 2 items ──────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const trip = await req('POST', '/v1/shopping-trips', {
    token: adminToken,
    householdId,
    body: {
      trip_date: today,
      store_name: 'Smoke Mart',
      items: [
        { name: 'Smoke Milk', quantity: 2, unit: 'L', price: 3.5 },
        { name: 'Smoke Bread', quantity: 1, unit: 'pieces', price: 2.25 }
      ]
    }
  });
  ok(trip.status === 201, '(3) trip creation returns 201', JSON.stringify(trip.json));
  const tripId = trip.json.trip.id;
  cleanup.tripIds.push(tripId);
  ok(Math.abs(Number(trip.json.trip.total_amount) - 5.75) < 0.001,
    '(3) computed total_amount = 5.75', `got ${trip.json.trip.total_amount}`);
  ok(trip.json.items.length === 2 && trip.json.items.every(i => i.status === 'available'),
    "(3) 2 food_items created with status='available'");
  const [tripLog] = await pool.query(
    "SELECT id FROM activity_logs WHERE entity_id = ? AND action_type = 'add_shopping'",
    [tripId]
  );
  ok(tripLog.length === 1, '(3) add_shopping activity row written (DB verified)');

  // ── (4) GET /v1/food-items defaults to available ────────────────
  const list = await req('GET', '/v1/food-items', { token: adminToken, householdId });
  ok(list.status === 200, '(4) food-items list returns 200');
  ok(list.json.items.length > 0 && list.json.items.every(i => i.status === 'available'),
    '(4) default listing contains only available items');
  const smokeItems = list.json.items.filter(i => i.shopping_trip_id === tripId);
  ok(smokeItems.length === 2, '(4) both new trip items appear in the default listing');

  // ── (5) consume once-only rule ──────────────────────────────────
  const targetItem = smokeItems[0];
  const consume1 = await req('PATCH', `/v1/food-items/${targetItem.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: Number(targetItem.quantity) }
  });
  ok(consume1.status === 200, '(5) first consume returns 200', JSON.stringify(consume1.json));
  ok(consume1.json.item.status === 'consumed', "(5) item status set to 'consumed'");
  ok(consume1.json.item.consumed_by_user_id === memberId, '(5) consumed_by recorded');
  ok(!!consume1.json.item.consumed_at, '(5) consumed_at recorded');
  const consume2 = await req('PATCH', `/v1/food-items/${targetItem.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: 1 }
  });
  ok(consume2.status === 409, '(5) second consume returns 409', `got ${consume2.status}`);

  // ── (6) activity log admin-only ─────────────────────────────────
  const alMember = await req('GET', '/v1/activity-log', { token: memberToken, householdId });
  ok(alMember.status === 403, '(6) member hitting activity-log gets 403', `got ${alMember.status}`);
  const alAdmin = await req('GET', '/v1/activity-log', { token: adminToken, householdId });
  ok(alAdmin.status === 200 && Array.isArray(alAdmin.json.entries) && alAdmin.json.entries.length > 0,
    '(6) admin gets activity-log entries');

  // ── (7) role upgrade + self-deactivation rejection ──────────────
  const upgrade = await req('PATCH', `/v1/users/${memberId}`, {
    token: adminToken,
    householdId, body: { role: 'admin' }
  });
  ok(upgrade.status === 200 && upgrade.json.user.role === 'admin',
    '(7) member upgraded to admin', JSON.stringify(upgrade.json));
  const [roleLog] = await pool.query(
    "SELECT id FROM activity_logs WHERE entity_id = ? AND action_type = 'update_role'",
    [memberId]
  );
  ok(roleLog.length === 1, '(7) update_role activity row written (DB verified)');
  const selfDeact = await req('PATCH', `/v1/users/${adminId}`, {
    token: adminToken,
    householdId, body: { is_active: false }
  });
  ok(selfDeact.status >= 400 && selfDeact.status < 500,
    '(7) admin self-deactivation rejected', `got ${selfDeact.status}: ${JSON.stringify(selfDeact.json)}`);
  const [[adminRow]] = await pool.query('SELECT is_active FROM users WHERE uuid = ?', [adminId]);
  ok(Number(adminRow.is_active) === 1, '(7) admin remains active after rejected self-deactivation');

  // ── (8) dashboard summary ───────────────────────────────────────
  const dash = await req('GET', '/v1/dashboard/summary', { token: adminToken, householdId });
  ok(dash.status === 200, '(8) dashboard summary returns 200');
  ok(Array.isArray(dash.json.recent_items) && dash.json.recent_items.length > 0,
    '(8) summary includes recent items');
  ok(Array.isArray(dash.json.inventory_by_unit),
    '(8) summary includes available inventory counts (by unit)');
  ok(dash.json.this_month && typeof dash.json.this_month.total_spent === 'number'
      && dash.json.this_month.total_spent >= 5.75,
    '(8) summary includes monthly spend covering the smoke trip',
    JSON.stringify(dash.json.this_month));

  // ── (9) page rendering ──────────────────────────────────────────
  const loginPage = await req('GET', '/login.html', { raw: true });
  ok(loginPage.status === 200 && loginPage.text.includes('login-shell'),
    '(9) /login.html returns 200 with .login-shell markup');
  const dashPage = await req('GET', '/dashboard.html', { raw: true });
  ok(dashPage.status === 200 && dashPage.text.includes('app-shell'),
    '(9) /dashboard.html returns 200 with .app-shell markup');

  // ── cleanup of throwaway smoke data ─────────────────────────────
  for (const tid of cleanup.tripIds) {
    await pool.query('DELETE FROM activity_logs WHERE entity_id IN (SELECT id FROM food_items WHERE shopping_trip_id = ?)', [tid]);
    await pool.query('DELETE FROM food_items WHERE shopping_trip_id = ?', [tid]);
    await pool.query('DELETE FROM activity_logs WHERE entity_id = ?', [tid]);
    await pool.query('DELETE FROM shopping_trips WHERE id = ?', [tid]);
  }
  for (const uid of cleanup.userIds) {
    await pool.query('DELETE FROM activity_logs WHERE user_id = ? OR entity_id = ?', [uid, uid]);
    await pool.query('DELETE FROM household_members WHERE user_id = ?', [uid]);
    await pool.query('DELETE FROM users WHERE uuid = ?', [uid]);
  }

  console.log(`\nSMOKE E2E: ALL ${passed} ASSERTIONS PASSED`);
  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error('SMOKE E2E FAILED:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});