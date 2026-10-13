// scripts/smoke-auth.js — one-shot verification of routes/auth.js + middleware/auth.js
require('dotenv').config();
const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const authRouter = require('../routes/auth');

assert.strictEqual(typeof verifyToken, 'function', 'verifyToken export missing');
assert.strictEqual(typeof requireAdmin, 'function', 'requireAdmin export missing');
assert.strictEqual(typeof authRouter, 'function', 'auth router export missing');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/v1/auth', authRouter);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
        const json = await res.json();
        resolve({ status: res.status, json });
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

(async () => {
  // 1. Login with seeded admin
  const login = await request('POST', '/v1/auth/login', { username: 'tomas', password: 'wrong-password' });
  assert.strictEqual(login.status, 401, 'wrong password should 401');

  // 2. Register a throwaway member
  const email = `smoke-${Date.now()}@example.com`;
  const reg = await request('POST', '/v1/auth/register', {
    first_name: 'Smoke',
    last_name: 'Test',
    email,
    password: 'passw0rd123',
    password_confirmation: 'passw0rd123'
  });
  assert.strictEqual(reg.status, 201, `register should 201, got ${reg.status}: ${JSON.stringify(reg.json)}`);
  assert.ok(reg.json.token, 'register returns token');
  assert.strictEqual(reg.json.user.role, 'member', 'default role member');
  assert.strictEqual(reg.json.user.password_hash, undefined, 'password_hash must not leak');

  const payload = jwt.verify(reg.json.token, process.env.JWT_SECRET || 'hgfl-dev-jwt-secret-change-me');
  assert.ok(payload.id && payload.role === 'member', 'JWT carries id + role');

  // 3. Login as the new member
  const login2 = await request('POST', '/v1/auth/login', {
    username: reg.json.user.username,
    password: 'passw0rd123'
  });
  assert.strictEqual(login2.status, 200, 'member login should 200');
  assert.strictEqual(login2.json.user.password_hash, undefined, 'password_hash must not leak on login');

  // 4. Duplicate email rejected
  const dup = await request('POST', '/v1/auth/register', {
    first_name: 'Dup', last_name: 'User', email,
    password: 'passw0rd123', password_confirmation: 'passw0rd123'
  });
  assert.strictEqual(dup.status, 409, 'duplicate email should 409');

  // 5. Activity log row exists
  const [logs] = await pool.query(
    "SELECT action_type FROM activity_logs WHERE user_id = ? AND action_type = 'user_registered'",
    [payload.id]
  );
  assert.strictEqual(logs.length, 1, 'user_registered activity log row exists');

  // 6. Middleware behaviour (unit-level)
  let statusCode = null;
  const fakeRes = { status(c) { statusCode = c; return this; }, json() { return this; } };
  verifyToken({ headers: {} }, fakeRes, () => { statusCode = 'next'; });
  assert.strictEqual(statusCode, 401, 'missing token → 401');

  let adminStatus = null;
  const fakeRes2 = { status(c) { adminStatus = c; return this; }, json() { return this; } };
  requireAdmin({ user: { role: 'member' } }, fakeRes2, () => { adminStatus = 'next'; });
  assert.strictEqual(adminStatus, 403, 'member hitting admin route → 403');
  requireAdmin({ user: { role: 'admin' } }, fakeRes2, () => { adminStatus = 'next'; });
  assert.strictEqual(adminStatus, 'next', 'admin passes requireAdmin');

  // Clean up throwaway rows
  await pool.query('DELETE FROM activity_logs WHERE user_id = ?', [payload.id]);
  await pool.query('DELETE FROM users WHERE uuid = ?', [payload.id]);

  console.log('SMOKE AUTH: ALL CHECKS PASSED');
  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error('SMOKE AUTH FAILED:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});