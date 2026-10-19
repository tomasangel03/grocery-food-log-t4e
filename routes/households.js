// routes/households.js — create, join, rename, and membership for grocery households.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');
const { UUID_RE, isSystemAdmin, isStaffRole } = require('../middleware/household');

const router = express.Router();
router.use(verifyToken);

const MAX_HOUSEHOLDS = 3;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JOIN_WINDOW_MS = 15 * 60 * 1000;
const JOIN_FAIL_LIMIT = 5;
const joinFailures = new Map();

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  return trimmed;
}

function cleanCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) return null;
  return normalized;
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function joinBlocked(userId) {
  const rec = joinFailures.get(userId);
  return !!(rec && rec.resetAt > Date.now() && rec.count >= JOIN_FAIL_LIMIT);
}

function noteJoinFailure(userId) {
  const now = Date.now();
  let rec = joinFailures.get(userId);
  if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + JOIN_WINDOW_MS };
  rec.count += 1;
  joinFailures.set(userId, rec);
}

function revealCode(role, systemAdmin) {
  return systemAdmin || role === 'admin' || role === 'co_admin';
}

function presentHousehold(row, systemAdmin) {
  return {
    id: row.id,
    name: row.name,
    join_code: revealCode(row.role, systemAdmin) ? String(row.join_code).trim() : null,
    role: row.role || null,
    member_count: Number(row.member_count),
    is_member: !!row.role
  };
}

async function membershipCount(conn, userId) {
  const [rows] = await conn.query(
    'SELECT COUNT(*)::int AS n FROM household_members WHERE user_id = ?',
    [userId]
  );
  return Number(rows[0].n);
}

async function loadMembership(conn, householdId, userId) {
  const [rows] = await conn.query(
    `SELECT hm.role, h.name, h.created_by
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
      WHERE hm.household_id = ? AND hm.user_id = ?
      LIMIT 1`,
    [householdId, userId]
  );
  return rows[0] || null;
}

function canFound(req, membership) {
  return isSystemAdmin(req.user) || (membership && membership.role === 'admin');
}

/**
 * GET /v1/households
 * memberships: households the caller belongs to (max 3).
 * all: every household, only for a system admin.
 */
router.get('/households', async (req, res) => {
  try {
    const systemAdmin = isSystemAdmin(req.user);
    const [mine] = await pool.query(
      `SELECT h.id, h.name, h.join_code, hm.role,
              (SELECT COUNT(*)::int FROM household_members m WHERE m.household_id = h.id) AS member_count
         FROM households h
         JOIN household_members hm ON hm.household_id = h.id AND hm.user_id = ?
        ORDER BY lower(h.name), h.id`,
      [req.user.id]
    );
    let all = null;
    if (systemAdmin) {
      const [rows] = await pool.query(
        `SELECT h.id, h.name, h.join_code, hm.role,
                (SELECT COUNT(*)::int FROM household_members m WHERE m.household_id = h.id) AS member_count
           FROM households h
           LEFT JOIN household_members hm ON hm.household_id = h.id AND hm.user_id = ?
          ORDER BY lower(h.name), h.id`,
        [req.user.id]
      );
      all = rows.map((row) => presentHousehold(row, true));
    }
    return res.json({
      memberships: mine.map((row) => presentHousehold(row, systemAdmin)),
      all,
      cap: MAX_HOUSEHOLDS,
      membership_count: mine.length,
      platform_role: systemAdmin ? 'system_admin' : 'user'
    });
  } catch (err) {
    console.error('GET /v1/households error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/households
 * Body: { name }. The code is generated here. The creator becomes the admin.
 */
router.post('/households', async (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ error: 'Enter a household name up to 40 characters' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const count = await membershipCount(conn, req.user.id);
    if (count >= MAX_HOUSEHOLDS) {
      await conn.rollback();
      return res.status(409).json({
        error: 'You can belong to 3 households. Leave one to create another.'
      });
    }

    const householdId = crypto.randomUUID();
    let inserted = false;
    let joinCode = null;
    for (let attempt = 0; attempt < 8 && !inserted; attempt += 1) {
      joinCode = randomCode();
      try {
        await conn.query(
          `INSERT INTO households (id, name, join_code, created_by)
           VALUES (?, ?, ?, ?)`,
          [householdId, name, joinCode, req.user.id]
        );
        inserted = true;
      } catch (err) {
        if (!err || err.code !== '23505') throw err;
      }
    }
    if (!inserted) {
      await conn.rollback();
      return res.status(500).json({ error: 'Could not assign a household code. Try again.' });
    }

    await conn.query(
      `INSERT INTO household_members (household_id, user_id, role)
       VALUES (?, ?, 'admin')`,
      [householdId, req.user.id]
    );
    await conn.commit();

    return res.status(201).json({
      household: {
        id: householdId,
        name,
        join_code: joinCode,
        role: 'admin',
        member_count: 1,
        is_member: true
      }
    });
  } catch (err) {
    await conn.rollback();
    if (err && err.code === '23514') {
      return res.status(409).json({
        error: 'You can belong to 3 households. Leave one to create another.'
      });
    }
    console.error('POST /v1/households error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * GET /v1/households/lookup?code=
 * Returns the household name only, so the person can confirm before joining.
 */
router.get('/households/lookup', async (req, res) => {
  if (joinBlocked(req.user.id)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const code = cleanCode(req.query.code);
  if (!code) {
    noteJoinFailure(req.user.id);
    return res.status(400).json({ error: 'Enter the 8-character household code' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM households WHERE join_code = ? LIMIT 1',
      [code]
    );
    if (rows.length === 0) {
      noteJoinFailure(req.user.id);
      return res.status(404).json({ error: 'No household uses that code' });
    }
    return res.json({ household: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    console.error('GET /v1/households/lookup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/households/join
 * Body: { code }. Joins as a member.
 */
router.post('/households/join', async (req, res) => {
  if (joinBlocked(req.user.id)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const code = cleanCode(req.body && req.body.code);
  if (!code) {
    noteJoinFailure(req.user.id);
    return res.status(400).json({ error: 'Enter the 8-character household code' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [homes] = await conn.query(
      'SELECT id, name FROM households WHERE join_code = ? LIMIT 1',
      [code]
    );
    if (homes.length === 0) {
      noteJoinFailure(req.user.id);
      await conn.rollback();
      return res.status(404).json({ error: 'No household uses that code' });
    }
    const home = homes[0];
    const existing = await loadMembership(conn, home.id, req.user.id);
    if (existing) {
      await conn.rollback();
      return res.status(409).json({ error: 'You are already in this household' });
    }
    const count = await membershipCount(conn, req.user.id);
    if (count >= MAX_HOUSEHOLDS) {
      await conn.rollback();
      return res.status(409).json({
        error: 'You can belong to 3 households. Leave one to join another.'
      });
    }
    await conn.query(
      `INSERT INTO household_members (household_id, user_id, role)
       VALUES (?, ?, 'member')`,
      [home.id, req.user.id]
    );
    await conn.commit();
    const [countRows] = await pool.query(
      'SELECT COUNT(*)::int AS n FROM household_members WHERE household_id = ?',
      [home.id]
    );
    return res.status(201).json({
      household: {
        id: home.id,
        name: home.name,
        join_code: null,
        role: 'member',
        member_count: Number(countRows[0].n),
        is_member: true
      }
    });
  } catch (err) {
    await conn.rollback();
    if (err && err.code === '23514') {
      return res.status(409).json({
        error: 'You can belong to 3 households. Leave one to join another.'
      });
    }
    console.error('POST /v1/households/join error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * GET /v1/households/:id/members
 * Anyone who can open the household can see who is in it.
 */
router.get('/households/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid household' });
  try {
    const allowed = await callerCanOpen(req, req.params.id);
    if (allowed.error) return res.status(allowed.error.status).json({ error: allowed.error.message });
    const [rows] = await pool.query(
      `SELECT u.uuid, u.username, u.email, u.first_name, u.last_name, hm.role, hm.joined_at
         FROM household_members hm
         JOIN users u ON u.uuid = hm.user_id
        WHERE hm.household_id = ?
        ORDER BY CASE hm.role WHEN 'admin' THEN 0 WHEN 'co_admin' THEN 1 ELSE 2 END,
                 lower(u.first_name), lower(u.username)`,
      [req.params.id]
    );
    return res.json({
      members: rows.map((row) => ({
        id: row.uuid,
        username: row.username,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        role: row.role,
        joined_at: row.joined_at
      }))
    });
  } catch (err) {
    console.error('GET /v1/households/:id/members error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function callerCanOpen(req, householdId) {
  const [rows] = await pool.query(
    `SELECT h.id, hm.role
       FROM households h
       LEFT JOIN household_members hm
         ON hm.household_id = h.id AND hm.user_id = ?
      WHERE h.id = ?
      LIMIT 1`,
    [req.user.id, householdId]
  );
  if (rows.length === 0) return { error: { status: 404, message: 'Household not found' } };
  if (!rows[0].role && !isSystemAdmin(req.user)) {
    return { error: { status: 403, message: 'You are not a member of this household' } };
  }
  return { role: rows[0].role || null };
}

/**
 * PATCH /v1/households/:id
 * Body: { name }. Founder or system admin.
 */
router.patch('/households/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid household' });
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Enter a household name up to 40 characters' });
  try {
    const membership = await loadMembership(pool, req.params.id, req.user.id);
    const [exists] = await pool.query('SELECT id FROM households WHERE id = ? LIMIT 1', [req.params.id]);
    if (exists.length === 0) return res.status(404).json({ error: 'Household not found' });
    if (!canFound(req, membership)) {
      return res.status(403).json({ error: 'Only the household admin can rename it' });
    }
    await pool.query('UPDATE households SET name = ? WHERE id = ?', [name, req.params.id]);
    return res.json({ household: { id: req.params.id, name } });
  } catch (err) {
    console.error('PATCH /v1/households/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/households/:id/leave
 * Frees a membership slot. The founding admin must transfer or delete instead.
 */
router.post('/households/:id/leave', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid household' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const membership = await loadMembership(conn, req.params.id, req.user.id);
    if (!membership) {
      await conn.rollback();
      return res.status(404).json({ error: 'You are not a member of this household' });
    }
    if (membership.role === 'admin') {
      await conn.rollback();
      return res.status(409).json({
        error: 'Transfer the admin role before you leave. If you are the only member, delete the household.'
      });
    }
    await conn.query(
      'DELETE FROM household_members WHERE household_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    await conn.commit();
    return res.json({ left: true });
  } catch (err) {
    await conn.rollback();
    console.error('POST /v1/households/:id/leave error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /v1/households/:id
 * Founder only, and only when they are the sole member.
 */
router.delete('/households/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid household' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT hm.user_id, hm.role
         FROM household_members hm
        WHERE hm.household_id = ?
        FOR UPDATE`,
      [req.params.id]
    );
    if (rows.length === 0) {
      const [home] = await conn.query('SELECT id FROM households WHERE id = ?', [req.params.id]);
      await conn.rollback();
      if (home.length === 0) return res.status(404).json({ error: 'Household not found' });
      return res.status(409).json({ error: 'Only the household admin can delete it, and only when they are the only member' });
    }
    const founder = rows.find((row) => row.role === 'admin');
    const callerIsFounder = founder && founder.user_id === req.user.id;
    if (!callerIsFounder && !isSystemAdmin(req.user)) {
      await conn.rollback();
      return res.status(403).json({ error: 'Only the household admin can delete it' });
    }
    if (rows.length !== 1 || !founder) {
      await conn.rollback();
      return res.status(409).json({ error: 'Remove every other member before deleting this household' });
    }
    await conn.query('DELETE FROM households WHERE id = ?', [req.params.id]);
    await conn.commit();
    return res.json({ deleted: true });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE /v1/households/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * POST /v1/households/:id/transfer
 * Body: { user_id }. Founder becomes a member. The chosen person becomes admin.
 */
router.post('/households/:id/transfer', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid household' });
  const targetId = req.body && req.body.user_id;
  if (!targetId || !UUID_RE.test(targetId)) {
    return res.status(400).json({ error: 'Choose a member to receive the admin role' });
  }
  if (targetId === req.user.id && !isSystemAdmin(req.user)) {
    return res.status(400).json({ error: 'Choose another member' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members] = await conn.query(
      `SELECT user_id, role FROM household_members WHERE household_id = ? FOR UPDATE`,
      [req.params.id]
    );
    if (members.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Household not found' });
    }
    const founder = members.find((row) => row.role === 'admin');
    if (!founder) {
      await conn.rollback();
      return res.status(409).json({ error: 'This household has no admin' });
    }
    if (founder.user_id !== req.user.id && !isSystemAdmin(req.user)) {
      await conn.rollback();
      return res.status(403).json({ error: 'Only the household admin can transfer that role' });
    }
    const target = members.find((row) => row.user_id === targetId);
    if (!target) {
      await conn.rollback();
      return res.status(404).json({ error: 'That person is not in this household' });
    }
    if (target.user_id === founder.user_id) {
      await conn.rollback();
      return res.status(400).json({ error: 'Choose another member' });
    }
    await conn.query(
      `UPDATE household_members SET role = 'member'
        WHERE household_id = ? AND user_id = ?`,
      [req.params.id, founder.user_id]
    );
    await conn.query(
      `UPDATE household_members SET role = 'admin'
        WHERE household_id = ? AND user_id = ?`,
      [req.params.id, target.user_id]
    );
    await conn.commit();
    return res.json({ transferred: true });
  } catch (err) {
    await conn.rollback();
    console.error('POST /v1/households/:id/transfer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * PATCH /v1/households/:id/members/:userId
 * Body: { role: 'co_admin' | 'member' }. Founder only. One co-admin.
 * Cannot change the founding admin.
 */
router.patch('/households/:id/members/:userId', async (req, res) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId)) {
    return res.status(400).json({ error: 'Invalid member' });
  }
  const role = req.body && req.body.role;
  if (role !== 'co_admin' && role !== 'member') {
    return res.status(400).json({ error: "Role must be 'co_admin' or 'member'" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members] = await conn.query(
      `SELECT user_id, role FROM household_members WHERE household_id = ? FOR UPDATE`,
      [req.params.id]
    );
    if (members.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Household not found' });
    }
    const founder = members.find((row) => row.role === 'admin');
    if (!founder || (founder.user_id !== req.user.id && !isSystemAdmin(req.user))) {
      await conn.rollback();
      return res.status(403).json({ error: 'Only the household admin can change the co-admin' });
    }
    const target = members.find((row) => row.user_id === req.params.userId);
    if (!target) {
      await conn.rollback();
      return res.status(404).json({ error: 'That person is not in this household' });
    }
    if (target.role === 'admin') {
      await conn.rollback();
      return res.status(403).json({ error: 'The household admin cannot be demoted here' });
    }
    if (role === 'co_admin') {
      const current = members.find((row) => row.role === 'co_admin' && row.user_id !== target.user_id);
      if (current) {
        await conn.rollback();
        return res.status(409).json({ error: 'Return the current co-admin to member first' });
      }
    }
    if (target.role === role) {
      await conn.rollback();
      return res.json({ unchanged: true, role });
    }
    await conn.query(
      'UPDATE household_members SET role = ? WHERE household_id = ? AND user_id = ?',
      [role, req.params.id, target.user_id]
    );
    await conn.commit();
    return res.json({ role });
  } catch (err) {
    await conn.rollback();
    console.error('PATCH household member error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /v1/households/:id/members/:userId
 * Founder or co-admin. Nobody can remove the founding admin.
 */
router.delete('/households/:id/members/:userId', async (req, res) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId)) {
    return res.status(400).json({ error: 'Invalid member' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [members] = await conn.query(
      `SELECT user_id, role FROM household_members WHERE household_id = ? FOR UPDATE`,
      [req.params.id]
    );
    if (members.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Household not found' });
    }
    const caller = members.find((row) => row.user_id === req.user.id);
    if (!isSystemAdmin(req.user) && !isStaffRole(caller && caller.role)) {
      await conn.rollback();
      return res.status(403).json({ error: 'You cannot remove members' });
    }
    const target = members.find((row) => row.user_id === req.params.userId);
    if (!target) {
      await conn.rollback();
      return res.status(404).json({ error: 'That person is not in this household' });
    }
    if (target.role === 'admin') {
      await conn.rollback();
      return res.status(403).json({ error: 'The household admin cannot be removed' });
    }
    if (caller && caller.role === 'co_admin' && target.role === 'co_admin') {
      await conn.rollback();
      return res.status(403).json({ error: 'A co-admin cannot remove the co-admin. Leave the household instead.' });
    }
    if (target.user_id === req.user.id) {
      await conn.rollback();
      return res.status(400).json({ error: 'Use leave to remove yourself' });
    }
    await conn.query(
      'DELETE FROM household_members WHERE household_id = ? AND user_id = ?',
      [req.params.id, target.user_id]
    );
    await conn.commit();
    return res.json({ removed: true });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE household member error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;
