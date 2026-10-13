// Seed script: cfg_seed_admin — creates the initial admin user "tomas".
// Idempotent: skips insertion if the username already exists.
'use strict';

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_PASSWORD = 'ChangeMe123!';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || process.env.DB_DATABASE
  });

  try {
    const [rows] = await conn.execute(
      'SELECT uuid FROM users WHERE username = ? LIMIT 1',
      ['tomas']
    );

    if (rows.length > 0) {
      console.log('Seed skipped: user "tomas" already exists (uuid=' + rows[0].uuid + ').');
      return;
    }

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    const uuid = uuidv4();

    await conn.execute(
      `INSERT INTO users
         (uuid, username, email, password_hash, auth_provider, role, first_name, last_name, is_active)
       VALUES (?, ?, ?, ?, 'local', 'admin', ?, ?, 1)`,
      [uuid, 'tomas', 'tomas@example.com', passwordHash, 'Tomas', 'Angel']
    );

    console.log('Seed complete: admin user "tomas" created (uuid=' + uuid + ').');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});