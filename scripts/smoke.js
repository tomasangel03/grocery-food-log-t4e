// scripts/smoke.js — API smoke test against the LIVE Express service.
// Covers: login, register, POST /v1/shopping-trips, PATCH consume,
// dashboard summary, activity-log, users. Cleans up its own test data.
// Usage: node scripts/smoke.js [port]
'use strict';
require('dotenv').config();
const pool = require('../db');

const PORT = process.argv[2] || process.env.SMOKE_PORT || 45059;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function report(pass, label, extra) {
  if (pass) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.error(`FAIL: ${label}${extra ? ' — ' + extra : ''}`);
  }
}

async function req(method, path, { token, body, householdId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (householdId) headers['X-Household-Id'] = householdId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const cleanup = { userIds: [], tripIds: [] };

(async () => {
  // ── login ────────────────────────────────────────────────────────
  const login = await req('POST', '/v1/auth/login', {
    body: { username: 'tomas', password: 'ChangeMe123!' }
  });
  report(login.status === 200 && !!login.json?.token && login.json?.user?.role === 'admin',
    'login — POST /v1/auth/login returns 200 + JWT (admin)',
    `status=${login.status} body=${JSON.stringify(login.json)}`);
  if (!login.json?.token) throw new Error('cannot continue without admin token');
  const adminToken = login.json.token;
  const adminId = login.json.user.id;

  // ── register ─────────────────────────────────────────────────────
  const email = `smoke-${Date.now()}@example.com`;
  const reg = await req('POST', '/v1/auth/register', {
    body: {
      first_name: 'Smoke', last_name: 'Test', email,
      password: 'passw0rd123', password_confirmation: 'passw0rd123'
    }
  });
  report(reg.status === 201 && reg.json?.user?.role === 'member' && !!reg.json?.token,
    'register — POST /v1/auth/register returns 201 + member JWT',
    `status=${reg.status} body=${JSON.stringify(reg.json)}`);
  const memberToken = reg.json?.token;
  const memberId = reg.json?.user?.id;
  if (memberId) cleanup.userIds.push(memberId);

  const homes = await req('GET', '/v1/households', { token: adminToken });
  const householdId = homes.json?.memberships?.[0]?.id;
  const joinCode = homes.json?.memberships?.[0]?.join_code;
  report(homes.status === 200 && !!householdId && String(joinCode || '').trim().length === 8,
    'households — admin has a household with an 8-character code',
    `status=${homes.status}`);
  const joined = await req('POST', '/v1/households/join', {
    token: memberToken,
    householdId,
    body: { code: String(joinCode || '').trim() }
  });
  report(joined.status === 201 && joined.json?.household?.role === 'member',
    'households — new member joins with the code',
    `status=${joined.status} body=${JSON.stringify(joined.json)}`);

  // ── POST /v1/shopping-trips ──────────────────────────────────────
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
  const tripId = trip.json?.trip?.id;
  if (tripId) cleanup.tripIds.push(tripId);
  report(trip.status === 201 && trip.json?.items?.length === 2
      && Math.abs(Number(trip.json?.trip?.total_amount) - 5.75) < 0.001,
    'trip creation — POST /v1/shopping-trips returns 201, 2 items, total 5.75',
    `status=${trip.status} body=${JSON.stringify(trip.json)}`);

  // ── PATCH consume ────────────────────────────────────────────────
  const milk = trip.json?.items?.[0];
  const bread = trip.json?.items?.[1];
  const partial = await req('PATCH', `/v1/food-items/${milk?.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: 1, note: 'breakfast' }
  });
  report(partial.status === 200 && partial.json?.item?.status === 'available'
      && Number(partial.json?.item?.quantity_remaining) === 1,
    'consume — partial amount stays available with 1 remaining',
    `status=${partial.status} body=${JSON.stringify(partial.json)}`);
  const finish = await req('PATCH', `/v1/food-items/${milk?.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: 1 }
  });
  report(finish.status === 200 && finish.json?.item?.status === 'consumed'
      && !!finish.json?.item?.consumed_at,
    'consume — using the rest marks the item consumed',
    `status=${finish.status} body=${JSON.stringify(finish.json)}`);
  const consumeAgain = await req('PATCH', `/v1/food-items/${milk?.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: 1 }
  });
  report(consumeAgain.status === 409,
    'consume — double consume rejected with 409',
    `status=${consumeAgain.status}`);
  const tooMuch = await req('PATCH', `/v1/food-items/${bread?.id}/consume`, {
    token: memberToken,
    householdId,
    body: { quantity: 5 }
  });
  report(tooMuch.status === 400,
    'consume — amount above what is left is rejected with 400',
    `status=${tooMuch.status}`);
  const priced = await req('GET', '/v1/food-items?status=all&price=3&priceOp=gte', { token: adminToken, householdId });
  const pricedIds = (priced.json?.items || []).map((item) => item.id);
  report(priced.status === 200 && pricedIds.includes(milk?.id) && !pricedIds.includes(bread?.id),
    'price filter — gte 3 keeps the 3.50 item and drops the 2.25 item',
    `status=${priced.status}`);

  // ── dashboard summary ────────────────────────────────────────────
  const dash = await req('GET', '/v1/dashboard/summary', { token: adminToken, householdId });
  report(dash.status === 200
      && Array.isArray(dash.json?.recent_items)
      && Array.isArray(dash.json?.inventory_by_unit)
      && typeof dash.json?.this_month?.total_spent === 'number'
      && typeof dash.json?.recent_consumption?.percent === 'number'
      && typeof dash.json?.consumed_this_week === 'number',
    'dashboard summary — GET /v1/dashboard/summary returns 200 with all sections',
    `status=${dash.status} body=${JSON.stringify(dash.json)}`);

  // ── activity-log ─────────────────────────────────────────────────
  const alAdmin = await req('GET', '/v1/activity-log', { token: adminToken, householdId });
  report(alAdmin.status === 200 && Array.isArray(alAdmin.json?.entries) && alAdmin.json.entries.length > 0,
    'activity-log — GET /v1/activity-log returns 200 with entries (admin)',
    `status=${alAdmin.status}`);
  const alMember = await req('GET', '/v1/activity-log', { token: memberToken, householdId });
  report(alMember.status === 403,
    'activity-log — member is rejected with 403',
    `status=${alMember.status}`);

  // ── users ────────────────────────────────────────────────────────
  const users = await req('GET', '/v1/users', { token: adminToken });
  report(users.status === 200 && Array.isArray(users.json?.users)
      && users.json.users.some(u => u.id === adminId),
    'users — GET /v1/users returns 200 with the household list (admin)',
    `status=${users.status}`);
  const usersMember = await req('GET', '/v1/users', { token: memberToken });
  report(usersMember.status === 403,
    'users — member is rejected with 403',
    `status=${usersMember.status}`);

  // ── cleanup throwaway data ───────────────────────────────────────
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
  await pool.end();

  if (failures > 0) {
    console.error(`\nSMOKE: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nSMOKE: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (err) => {
  console.error('SMOKE FAILED:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});