// Seed script: cfg_seed_admin — creates the initial admin user "tomas".
// Idempotent: skips insertion if the username already exists.
'use strict';

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

const DEFAULT_PASSWORD = 'ChangeMe123!';

async function main() {
  try {
    const [rows] = await pool.query(
      'SELECT uuid FROM users WHERE username = ? LIMIT 1',
      ['tomas']
    );

    if (rows.length > 0) {
      console.log('Seed skipped: user "tomas" already exists (uuid=' + rows[0].uuid + ').');
      return;
    }

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    const uuid = uuidv4();

    await pool.query(
      `INSERT INTO users
         (uuid, username, email, password_hash, auth_provider, role, first_name, last_name, is_active)
       VALUES (?, ?, ?, ?, 'local', 'admin', ?, ?, TRUE)`,
      [uuid, 'tomas', 'tomas@example.com', passwordHash, 'Tomas', 'Angel']
    );

    console.log('Seed complete: admin user "tomas" created (uuid=' + uuid + ').');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
