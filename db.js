// db.js — MySQL connection pool
// Driven by DATABASE_URL when present; otherwise the injected DB_*/MYSQL_* env vars.
// No localhost/root fallbacks — a missing variable must fail loudly, not point at a phantom local DB.
require('dotenv').config();
const mysql = require('mysql2/promise');

function required(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  throw new Error(
    `FATAL: missing database configuration — none of [${names.join(', ')}] is set in the environment.`
  );
}

let pool;

if (process.env.DATABASE_URL) {
  pool = mysql.createPool(process.env.DATABASE_URL);
} else {
  pool = mysql.createPool({
    host: required(['DB_HOST', 'MYSQL_HOST']),
    port: Number(required(['DB_PORT', 'MYSQL_PORT'])),
    user: required(['DB_USER', 'MYSQL_USER']),
    password: required(['DB_PASSWORD', 'MYSQL_PASSWORD']),
    database: required(['DB_NAME', 'DB_DATABASE', 'MYSQL_DATABASE']),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

module.exports = pool;