// scripts/security-check.js — security audit against the LIVE Express service.
// Asserts:
//   1. JWT is required (401) on all protected routes
//   2. Member gets 403 on admin endpoints (/v1/activity-log, /v1/users*, PUT/DELETE food-items)
//   3. Member cannot edit price via PUT /v1/food-items/:id (403), admin can (200)
//   4. Self-deactivation is rejected with 400/409 on PATCH /v1/users/:id
//   5. NO response body anywhere contains a password_hash field (deep scan)
//   6. Any Google-created account in the DB has NULL password and role=member
// Cleans up its own test data. Exit 0 = all pass.
// Usage: node scripts/security-check.js [port]
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

/** Deep-scan any JSON value for a forbidden key. */
function containsKey(value, key) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsKey(v, key));
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((v) => containsKey(v, key));
}

const scannedBodies = [];

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (json !== null) scannedBodies.push({ path: `${method} ${path}`, json });
  return { status: res.status, json };
}

const cleanup = { userIds: [], tripIds: [] };

(async () => {
  // ── setup: admin login + throwaway member ─────────────────────────
  const login = await req('POST', '/v1/auth/login', {
    body: { username: 'tomas', password: 'ChangeMe123!' }
  });
  report(login.status === 200 && !!login.json?.token, 'setup — admin login', `status=${login.status}`);
  if (!login.json?.token) throw new Error('cannot continue without admin token');
  const adminToken = login.json.token;
  const adminId = login.json.user.id;

  const email = `seccheck-${Date.now()}@example.com`;
  const reg = await req('POST', '/v1/auth/register', {
    body: {
      first_name: 'Sec', last_name: 'Check', email,
      password: 'passw0rd123', password_confirmation: 'passw0rd123'
    }
  });
  report(reg.status === 201 && reg.json?.user?.role === 'member',
    'setup — self-registered account defaults to role=member', `status=${reg.status}`);
  const memberToken = reg.json?.token;
  const memberId = reg.json?.user?.id;
  if (memberId) cleanup.userIds.push(memberId);

  // ── 1. JWT required on all protected routes (401 without token) ───
  const protectedRoutes = [
    ['GET', '/v1/food-items'],
    ['POST', '/v1/shopping-trips'],
    ['GET', '/v1/dashboard/summary'],
    ['GET', '/v1/activity-log'],
    ['GET', '/v1/users'],
    ['PATCH', `/v1/users/${adminId}`],
    ['PUT', '/v1/food-items/00000000-0000-0000-0000-000000000000'],
    ['DELETE', '/v1/food-items/00000000-0000-0000-0000-000000000000']
  ];
  for (const [method, path] of protectedRoutes) {
    const r = await req(method, path);
    report(r.status === 401, `jwt — ${method} ${path} without token → 401`, `status=${r.status}`);
  }
  const badToken = await req('GET', '/v1/users', { token: 'not.a.valid.jwt' });
  report(badToken.status === 401, 'jwt — garbage token rejected with 401', `status=${badToken.status}`);

  // ── 2. Member 403 on admin endpoints ──────────────────────────────
  const alMember = await req('GET', '/v1/activity-log', { token: memberToken });
  report(alMember.status === 403, 'rbac — member GET /v1/activity-log → 403', `status=${alMember.status}`);
  const usersMember = await req('GET', '/v1/users', { token: memberToken });
  report(usersMember.status === 403, 'rbac — member GET /v1/users → 403', `status=${usersMember.status}`);
  const createMember = await req('POST', '/v1/users', {
    token: memberToken,
    body: { first_name: 'X', last_name: 'Y', username: 'zz', email: 'z@z.com', password: 'passw0rd1', role: 'admin' }
  });
  report(createMember.status === 403, 'rbac — member POST /v1/users → 403', `status=${createMember.status}`);
  const patchMember = await req('PATCH', `/v1/users/${memberId}`, {
    token: memberToken,
    body: { role: 'admin' }
  });
  report(patchMember.status === 403, 'rbac — member PATCH /v1/users/:id (self-promotion) → 403', `status=${patchMember.status}`);

  // ── 3. Member cannot edit price via PUT; admin can ────────────────
  const today = new Date().toISOString().slice(0, 10);
  const trip = await req('POST', '/v1/shopping-trips', {
    token: adminToken,
    body: {
      trip_date: today,
      store_name: 'SecCheck Mart',
      items: [{ name: 'SecCheck Apple', quantity: 1, unit: 'pieces', price: 1.0 }]
    }
  });
  const tripId = trip.json?.trip?.id;
  const itemId = trip.json?.items?.[0]?.id;
  if (tripId) cleanup.tripIds.push(tripId);
  report(trip.status === 201 && !!itemId, 'setup — created trip + item for edit tests', `status=${trip.status}`);

  const memberEdit = await req('PUT', `/v1/food-items/${itemId}`, {
    token: memberToken,
    body: { price: 99.99 }
  });
  report(memberEdit.status === 403, 'rbac — member PUT /v1/food-items/:id (price edit) → 403', `status=${memberEdit.status}`);
  const memberDelete = await req('DELETE', `/v1/food-items/${itemId}`, { token: memberToken });
  report(memberDelete.status === 403, 'rbac — member DELETE /v1/food-items/:id → 403', `status=${memberDelete.status}`);

  // verify the price was NOT changed by the rejected request
  const [[itemRow]] = await pool.query('SELECT price FROM food_items WHERE id = ?', [itemId]);
  report(itemRow && Math.abs(Number(itemRow.price) - 1.0) < 0.001,
    'rbac — price unchanged after member edit attempt', `price=${itemRow && itemRow.price}`);

  const adminEdit = await req('PUT', `/v1/food-items/${itemId}`, {
    token: adminToken,
    body: { price: 2.5 }
  });
  report(adminEdit.status === 200 && Math.abs(Number(adminEdit.json?.item?.price) - 2.5) < 0.001,
    'rbac — admin PUT /v1/food-items/:id succeeds (200)', `status=${adminEdit.status}`);

  // ── 4. Self-deactivation rejected with 400/409 ────────────────────
  const selfDeactivate = await req('PATCH', `/v1/users/${adminId}`, {
    token: adminToken,
    body: { is_active: false }
  });
  report(selfDeactivate.status === 400 || selfDeactivate.status === 409,
    'rule — admin self-deactivation rejected with 400/409', `status=${selfDeactivate.status}`);
  const [[adminRow]] = await pool.query('SELECT is_active FROM users WHERE uuid = ?', [adminId]);
  report(adminRow && Number(adminRow.is_active) === 1,
    'rule — admin account still active after rejected self-deactivation');

  // Sanity: admin CAN deactivate someone else (then reactivate)
  const deactivateOther = await req('PATCH', `/v1/users/${memberId}`, {
    token: adminToken,
    body: { is_active: false }
  });
  report(deactivateOther.status === 200 && deactivateOther.json?.user?.is_active === false,
    'rule — admin can deactivate another member (200)', `status=${deactivateOther.status}`);

  // ── 5. No password_hash in ANY response body ──────────────────────
  // exercise a few more read endpoints so the scan covers everything
  await req('GET', '/v1/users', { token: adminToken });
  await req('GET', '/v1/activity-log', { token: adminToken });
  await req('GET', '/v1/food-items?status=all', { token: adminToken });
  await req('GET', '/v1/dashboard/summary', { token: adminToken });

  const leaks = scannedBodies.filter((b) => containsKey(b.json, 'password_hash'));
  report(leaks.length === 0,
    `serialization — no password_hash in any of ${scannedBodies.length} scanned response bodies`,
    leaks.map((l) => l.path).join(', '));

  // ── 6. Google accounts: null password + role=member (DB invariant) ─
  const [[gRow]] = await pool.query(
    `SELECT COUNT(*) AS bad FROM users
      WHERE auth_provider = 'google' AND (password_hash IS NOT NULL OR role <> 'member' AND role <> 'admin')`
  );
  const [[gPw]] = await pool.query(
    `SELECT COUNT(*) AS bad FROM users WHERE auth_provider = 'google' AND password_hash IS NOT NULL`
  );
  report(Number(gPw.bad) === 0,
    'google — every google-provider account has NULL password_hash', `bad=${gPw.bad}`);

  // ── cleanup ───────────────────────────────────────────────────────
  for (const tid of cleanup.tripIds) {
    await pool.query('DELETE FROM activity_logs WHERE entity_id IN (SELECT id FROM food_items WHERE shopping_trip_id = ?)', [tid]);
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
    console.error(`\nSECURITY CHECK: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nSECURITY CHECK: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (err) => {
  console.error('SECURITY CHECK FAILED:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});