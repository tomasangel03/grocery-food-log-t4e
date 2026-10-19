// middleware/auth.js — JWT verification + role enforcement
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'hgfl-dev-jwt-secret-change-me';

/**
 * verifyToken — validates the Bearer JWT and attaches { id, role, platformRole, username } to req.user.
 * Responds 401 when the token is missing, malformed, or invalid/expired.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');
  const token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      role: payload.role,
      platformRole: payload.platform_role || (payload.role === 'admin' ? 'system_admin' : 'user'),
      username: payload.username
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireAdmin — must run AFTER verifyToken. Responds 403 unless role === 'admin'.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

/** Platform-wide access. Household admin does not satisfy this. */
function requireSystemAdmin(req, res, next) {
  if (!req.user || req.user.platformRole !== 'system_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

module.exports = { verifyToken, requireAdmin, requireSystemAdmin };