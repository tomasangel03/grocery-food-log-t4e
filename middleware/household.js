// Household access for the active household (header X-Household-Id).
const pool = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSystemAdmin(user) {
  return !!user && user.platformRole === 'system_admin';
}

function isStaffRole(role) {
  return role === 'admin' || role === 'co_admin';
}

/**
 * requireHousehold — must run AFTER verifyToken.
 * Members may only open a household they belong to.
 * A system admin may open any household.
 */
async function requireHousehold(req, res, next) {
  const id = req.get('X-Household-Id');
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Select a household' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT h.id, h.name, h.join_code, hm.role
         FROM households h
         LEFT JOIN household_members hm
           ON hm.household_id = h.id AND hm.user_id = ?
        WHERE h.id = ?
        LIMIT 1`,
      [req.user.id, id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Household not found' });
    if (!row.role && !isSystemAdmin(req.user)) {
      return res.status(403).json({ error: 'You are not a member of this household' });
    }
    req.household = {
      id: row.id,
      name: row.name,
      joinCode: row.join_code,
      role: row.role || null
    };
    return next();
  } catch (err) {
    console.error('requireHousehold error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** Founder, co-admin, or system admin. */
function requireHouseholdStaff(req, res, next) {
  if (isSystemAdmin(req.user) || isStaffRole(req.household && req.household.role)) {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

module.exports = {
  UUID_RE,
  isSystemAdmin,
  isStaffRole,
  requireHousehold,
  requireHouseholdStaff
};
