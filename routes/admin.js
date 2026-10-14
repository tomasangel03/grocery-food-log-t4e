// routes/admin.js — admin-only endpoints (rule_admin_only_activity_view / rule_admin_only_user_mgmt)
//   GET   /v1/activity-log  — newest first, optional userId + actionType filters (Members → 403)
//   GET   /v1/users         — household members incl. role, auth_provider, status
//   POST  /v1/users         — create member (bcrypt password) + 'add_user' activity (evt_activity_on_user_mgmt)
//   PATCH /v1/users/:id     — role change / is_active toggle; rejects self-deactivation (rule_no_self_deactivate);
//                             writes 'update_role' / 'deactivate_user' activity rows
const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const pool = require('../db');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const VALID_ACTION_TYPES = [
  'add_shopping',
  'consume_item',
  'add_user',
  'user_registered',
  'update_role',
  'deactivate_user',
  'edit_item',
  'remove_item',
  'edit_note'
];

// Every route in this router is admin-only
router.use(verifyToken, requireAdmin);

/** Write an immutable activity row (rule: Activity Log Entries Are Immutable — insert only). */
async function logActivity(userId, actionType, description, entityType, entityId) {
  await pool.query(
    `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), userId, actionType, description, entityType, entityId]
  );
}

/** Public-safe user shape — never exposes password_hash or google_id. */
function publicUser(u) {
  return {
    id: u.uuid,
    username: u.username,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    role: u.role,
    auth_provider: u.auth_provider,
    is_active: !!u.is_active,
    created_at: u.created_at
  };
}

/**
 * GET /v1/activity-log
 * Query params: userId (uuid), actionType (enum), limit (<=200), offset
 * Newest first. Members are rejected with 403 by requireAdmin above.
 */
router.get('/activity-log', async (req, res) => {
  try {
    const { userId, actionType } = req.query || {};
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const params = [];
    if (userId) {
      where.push('al.user_id = ?');
      params.push(String(userId));
    }
    if (actionType) {
      if (!VALID_ACTION_TYPES.includes(String(actionType))) {
        return res.status(400).json({
          error: `Invalid actionType. Must be one of: ${VALID_ACTION_TYPES.join(', ')}`
        });
      }
      where.push('al.action_type = ?');
      params.push(String(actionType));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT al.id, al.user_id, u.username, u.first_name, u.last_name,
              al.action_type, al.action_description, al.entity_type, al.entity_id, al.created_at
         FROM activity_logs al
         JOIN users u ON u.uuid = al.user_id
         ${whereSql}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({ entries: rows, limit, offset });
  } catch (err) {
    console.error('GET /v1/activity-log error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/users — household members table (name, username, email, role, auth provider, status)
 */
router.get('/users', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT uuid, username, email, first_name, last_name, role, auth_provider, is_active, created_at
         FROM users
        ORDER BY created_at ASC`
    );
    return res.json({ users: rows.map(publicUser) });
  } catch (err) {
    console.error('GET /v1/users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/users — create a household member (um_add_modal fields:
 * first name, last name, username, email, initial password, role).
 * Writes an 'add_user' activity row per evt_activity_on_user_mgmt.
 */
router.post('/users', async (req, res) => {
  try {
    const {
      first_name: firstName,
      last_name: lastName,
      username,
      email,
      password,
      role
    } = req.body || {};

    const errors = {};
    if (!firstName || !String(firstName).trim()) errors.first_name = 'First name is required';
    if (!lastName || !String(lastName).trim()) errors.last_name = 'Last name is required';
    if (!username || !String(username).trim()) errors.username = 'Username is required';

    const emailNorm = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      errors.email = 'A valid email address is required';
    }
    if (typeof password !== 'string' || password.length < 8) {
      errors.password = 'Initial password must be at least 8 characters long';
    }
    const roleNorm = role === 'admin' ? 'admin' : role === 'member' ? 'member' : null;
    if (!roleNorm) errors.role = "Role must be 'admin' or 'member'";

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    const usernameNorm = String(username).trim().toLowerCase();
    const [existing] = await pool.query(
      'SELECT username, email FROM users WHERE username = ? OR email = ? LIMIT 1',
      [usernameNorm, emailNorm]
    );
    if (existing.length > 0) {
      const clash = existing[0];
      return res.status(409).json({
        error: 'Validation failed',
        errors:
          clash.email === emailNorm
            ? { email: 'An account with this email already exists' }
            : { username: 'This username is already taken' }
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const userId = randomUUID();

    await pool.query(
      `INSERT INTO users (uuid, username, email, password_hash, google_id, auth_provider, role, first_name, last_name, is_active)
       VALUES (?, ?, ?, ?, NULL, 'local', ?, ?, ?, TRUE)`,
      [userId, usernameNorm, emailNorm, passwordHash, roleNorm, String(firstName).trim(), String(lastName).trim()]
    );

    await logActivity(
      req.user.id,
      'add_user',
      `Added member ${String(firstName).trim()} ${String(lastName).trim()} (${usernameNorm}) with role ${roleNorm}`,
      'user',
      userId
    );

    return res.status(201).json({
      user: publicUser({
        uuid: userId,
        username: usernameNorm,
        email: emailNorm,
        first_name: String(firstName).trim(),
        last_name: String(lastName).trim(),
        role: roleNorm,
        auth_provider: 'local',
        is_active: 1
      })
    });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email or username already exists' });
    }
    console.error('POST /v1/users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /v1/users/:id — role change (um_role_dd) and/or is_active toggle (um_deactivate_btn).
 * rule_no_self_deactivate: an admin cannot deactivate their own account.
 * Writes 'update_role' / 'deactivate_user' activity rows.
 */
router.patch('/users/:id', async (req, res) => {
  try {
    const targetId = String(req.params.id);
    const { role, is_active: isActive } = req.body || {};

    if (role === undefined && isActive === undefined) {
      return res.status(400).json({ error: 'Provide role and/or is_active to update' });
    }
    if (role !== undefined && role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: "Role must be 'admin' or 'member'" });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }

    // rule_no_self_deactivate
    if (isActive === false && targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const [rows] = await pool.query(
      `SELECT uuid, username, email, first_name, last_name, role, auth_provider, is_active, created_at
         FROM users WHERE uuid = ? LIMIT 1`,
      [targetId]
    );
    const target = rows[0];
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sets = [];
    const params = [];
    const activities = [];

    if (role !== undefined && role !== target.role) {
      sets.push('role = ?');
      params.push(role);
      activities.push({
        type: 'update_role',
        desc: `Changed role of ${target.username} from ${target.role} to ${role}`
      });
    }
    if (isActive !== undefined && Boolean(target.is_active) !== isActive) {
      sets.push('is_active = ?');
      params.push(isActive);
      activities.push({
        type: 'deactivate_user',
        desc: isActive
          ? `Reactivated member ${target.username}`
          : `Deactivated member ${target.username}`
      });
    }

    if (sets.length > 0) {
      await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE uuid = ?`, [...params, targetId]);
      for (const a of activities) {
        await logActivity(req.user.id, a.type, a.desc, 'user', targetId);
      }
    }

    const [updatedRows] = await pool.query(
      `SELECT uuid, username, email, first_name, last_name, role, auth_provider, is_active, created_at
         FROM users WHERE uuid = ? LIMIT 1`,
      [targetId]
    );
    return res.json({ user: publicUser(updatedRows[0]) });
  } catch (err) {
    console.error('PATCH /v1/users/:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;