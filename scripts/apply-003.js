'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function hostOf(connectionString) {
  try {
    return new URL(connectionString.replace(/^postgres(ql)?:/i, 'http:')).hostname;
  } catch (err) {
    return '';
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const host = hostOf(connectionString);
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const client = new Client({
    connectionString,
    ssl: local ? undefined : { rejectUnauthorized: false }
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003_households.sql'), 'utf8');
  await client.connect();
  const before = await client.query(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM shopping_trips) AS trips,
            (SELECT count(*)::int FROM food_items) AS items,
            (SELECT count(*)::int FROM activity_logs) AS logs`
  );
  await client.query(sql);
  const after = await client.query(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM shopping_trips) AS trips,
            (SELECT count(*)::int FROM food_items) AS items,
            (SELECT count(*)::int FROM activity_logs) AS logs,
            (SELECT count(*)::int FROM shopping_trips WHERE household_id IS NULL) AS trips_without_home,
            (SELECT count(*)::int FROM household_members) AS members,
            (SELECT name FROM households ORDER BY created_at LIMIT 1) AS home_name,
            (SELECT char_length(btrim(join_code::text)) FROM households ORDER BY created_at LIMIT 1) AS code_len,
            (SELECT platform_role::text FROM users WHERE lower(username) = 'tomas') AS tomas_platform,
            (SELECT hm.role::text
               FROM household_members hm
               JOIN users u ON u.uuid = hm.user_id
              WHERE lower(u.username) = 'tomas'
              LIMIT 1) AS tomas_household_role`
  );
  console.log(JSON.stringify({ before: before.rows[0], after: after.rows[0] }));
  await client.end();
}

main().catch((err) => {
  console.error(String(err.message).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://redacted'));
  process.exit(1);
});
