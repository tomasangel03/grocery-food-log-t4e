// routes/auth.js — local authentication: login + self-registration
// flow_authentication: lookup by username, bcrypt.compare, is_active check, issue JWT (id + role)
// flow_self_registration: validate unique email across providers, password strength +
//   confirmation match, create member (auth_provider='local'), log 'user_registered', issue JWT
const express = require('express');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const pool = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'hgfl-dev-jwt-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);

/** Sign a session JWT carrying the user id and role (per step_auth_session). */
function signToken(user) {
  return jwt.sign(
    {
      id: user.uuid,
      role: user.role,
      platform_role: user.platform_role || 'user',
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Public-safe user shape — NEVER includes password_hash. */
function publicUser(user) {
  return {
    id: user.uuid,
    username: user.username,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    platform_role: user.platform_role || 'user',
    auth_provider: user.auth_provider,
    is_active: !!user.is_active
  };
}

/**
 * Password strength (rule_password_hashed / step_reg_validate):
 * at least 8 chars, with at least one letter and one digit.
 */
function passwordStrengthError(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}

/** Derive a unique username from the email local part (schema requires username NOT NULL). */
async function deriveUniqueUsername(preferred, email) {
  let base = (preferred || String(email).split('@')[0] || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 90);
  if (!base) base = 'user';

  let candidate = base;
  let suffix = 0;
  // Try base, base1, base2, ... until free
  // (bounded loop; unique index on username is the final guarantee)
  for (let i = 0; i < 50; i++) {
    const [rows] = await pool.query('SELECT 1 FROM users WHERE username = ? LIMIT 1', [candidate]);
    if (rows.length === 0) return candidate;
    suffix += 1;
    candidate = `${base}${suffix}`;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * POST /v1/auth/login
 * Body: { username, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const [rows] = await pool.query(
      'SELECT uuid, username, email, password_hash, role, platform_role, first_name, last_name, auth_provider, is_active FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    const user = rows[0];

    // Uniform error for unknown user / wrong password (avoid user enumeration)
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const token = signToken(user);
    return res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /v1/auth/login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/auth/register
 * Body: { first_name, last_name, email, password, password_confirmation, username? }
 * Creates a local member account (rule_register_default_member).
 */
router.post('/register', async (req, res) => {
  try {
    const {
      first_name: firstName,
      last_name: lastName,
      email,
      password,
      password_confirmation: passwordConfirmation,
      username: preferredUsername
    } = req.body || {};

    // Field-level validation errors (step_reg_validate → step_reg_errors)
    const errors = {};
    if (!firstName || !String(firstName).trim()) errors.first_name = 'First name is required';
    if (!lastName || !String(lastName).trim()) errors.last_name = 'Last name is required';

    const emailNorm = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      errors.email = 'A valid email address is required';
    }

    const strengthError = passwordStrengthError(password);
    if (strengthError) errors.password = strengthError;

    if (password !== passwordConfirmation) {
      errors.password_confirmation = 'Passwords do not match';
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    // rule_unique_email_providers: email must be unique across ALL auth providers
    const [existing] = await pool.query('SELECT 1 FROM users WHERE email = ? LIMIT 1', [emailNorm]);
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Validation failed',
        errors: { email: 'An account with this email already exists' }
      });
    }

    const username = await deriveUniqueUsername(preferredUsername, emailNorm);
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const userId = randomUUID();

    await pool.query(
      `INSERT INTO users (uuid, username, email, password_hash, google_id, auth_provider, role, first_name, last_name, is_active)
       VALUES (?, ?, ?, ?, NULL, 'local', 'member', ?, ?, TRUE)`,
      [userId, username, emailNorm, passwordHash, String(firstName).trim(), String(lastName).trim()]
    );

    // Audit trail: user_registered
    await pool.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'user_registered', ?, 'user', ?)`,
      [
        randomUUID(),
        userId,
        `New member registered: ${String(firstName).trim()} ${String(lastName).trim()} (${username})`,
        userId
      ]
    );

    const user = {
      uuid: userId,
      username,
      email: emailNorm,
      role: 'member',
      platform_role: 'user',
      first_name: String(firstName).trim(),
      last_name: String(lastName).trim(),
      auth_provider: 'local',
      is_active: 1
    };

    const token = signToken(user);
    return res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    // Race on unique constraints (username/email)
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email or username already exists' });
    }
    console.error('POST /v1/auth/register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Google OAuth 2.0 (flow_google_signin / int_google_oauth)
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_OAUTH_REDIRECT_URL = process.env.GOOGLE_OAUTH_REDIRECT_URL || '';

/** Build an OAuth2 client from the configured Google credentials. */
function googleClient() {
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL);
}

/**
 * Build a browser-facing page URL. Server-side redirects reach the browser
 * OUTSIDE the reverse proxy, so they must be absolute paths including the
 * public prefix (BASE_PATH) — the one legitimate use of BASE_PATH.
 */
function pageUrl(pathAndQuery) {
  const base = (process.env.BASE_PATH || '').replace(/\/+$/, '');
  return `${base}/${pathAndQuery.replace(/^\/+/, '')}`;
}

const USER_SELECT_FIELDS =
  'uuid, username, email, password_hash, google_id, auth_provider, role, platform_role, first_name, last_name, is_active';

/**
 * GET /v1/auth/google
 * step_g_start: redirect the browser to Google's consent screen.
 */
router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URL) {
    return res.redirect(pageUrl('login.html?error=google_not_configured'));
  }
  const authUrl = googleClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account'
  });
  return res.redirect(authUrl);
});

/**
 * GET /v1/auth/google/callback
 * Exchanges the authorization code for a verified Google profile, then:
 *   1. match existing user by google_id → sign in
 *   2. else match by email → link google_id, sign in
 *   3. else auto-create a Member account (auth_provider='google', NO password
 *      per rule_google_no_password / rule_register_default_member) and write
 *      a 'user_registered' activity_logs row.
 * Issues a JWT and redirects to the dashboard; cancel/failure redirects back
 * to the login page with an error query param.
 */
router.get('/google/callback', async (req, res) => {
  const loginError = (code) => res.redirect(pageUrl(`login.html?error=${encodeURIComponent(code)}`));

  try {
    const { code, error } = req.query || {};
    if (error || !code) {
      // User cancelled the consent screen or Google returned an error
      return loginError('google_cancelled');
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URL) {
      return loginError('google_not_configured');
    }

    const client = googleClient();
    const { tokens } = await client.getToken(String(code));
    if (!tokens || !tokens.id_token) {
      return loginError('google_failed');
    }

    // Verify the ID token signature + audience and extract the profile
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    });
    const profile = ticket.getPayload() || {};
    const googleId = profile.sub;
    const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (!googleId || !email) {
      return loginError('google_failed');
    }

    // 1) Match by google_id
    let [rows] = await pool.query(
      `SELECT ${USER_SELECT_FIELDS} FROM users WHERE google_id = ? LIMIT 1`,
      [googleId]
    );
    let user = rows[0] || null;

    // 2) Match by email → link the Google account
    if (!user) {
      [rows] = await pool.query(
        `SELECT ${USER_SELECT_FIELDS} FROM users WHERE email = ? LIMIT 1`,
        [email]
      );
      user = rows[0] || null;
      if (user) {
        await pool.query('UPDATE users SET google_id = ? WHERE uuid = ?', [googleId, user.uuid]);
        user.google_id = googleId;
      }
    }

    // 3) Auto-create a Member account from the Google profile
    if (!user) {
      const firstName =
        (profile.given_name || '').trim() ||
        String(profile.name || 'Google').trim().split(/\s+/)[0];
      const lastName =
        (profile.family_name || '').trim() ||
        (String(profile.name || '').trim().split(/\s+/).slice(1).join(' ') || 'User');

      const username = await deriveUniqueUsername(null, email);
      const userId = randomUUID();

      await pool.query(
        `INSERT INTO users (uuid, username, email, password_hash, google_id, auth_provider, role, first_name, last_name, is_active)
         VALUES (?, ?, ?, NULL, ?, 'google', 'member', ?, ?, TRUE)`,
        [userId, username, email, googleId, firstName, lastName]
      );

      await pool.query(
        `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
         VALUES (?, ?, 'user_registered', ?, 'user', ?)`,
        [
          randomUUID(),
          userId,
          `New member registered via Google: ${firstName} ${lastName} (${username})`,
          userId
        ]
      );

      user = {
        uuid: userId,
        username,
        email,
        password_hash: null,
        google_id: googleId,
        auth_provider: 'google',
        role: 'member',
        platform_role: 'user',
        first_name: firstName,
        last_name: lastName,
        is_active: 1
      };
    }

    if (!user.is_active) {
      return loginError('account_deactivated');
    }

    const token = signToken(user);
    // Token in the URL fragment so it never hits server logs; the dashboard
    // page picks it up client-side and stores it.
    return res.redirect(pageUrl(`dashboard.html#token=${encodeURIComponent(token)}`));
  } catch (err) {
    console.error('GET /v1/auth/google/callback error:', err);
    return loginError('google_failed');
  }
});

const { verifyToken } = require('../middleware/auth');

/**
 * GET /v1/auth/me
 * Fresh profile, including platform_role, for the signed-in user.
 */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT uuid, username, email, role, platform_role, first_name, last_name, auth_provider, is_active
         FROM users WHERE uuid = ? LIMIT 1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('GET /v1/auth/me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;