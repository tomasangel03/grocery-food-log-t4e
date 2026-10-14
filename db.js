// db.js — PostgreSQL connection pool (local Docker now, Supabase later).
// Keeps the mysql2 call shape the routes already use:
//   const [rows] = await pool.query('SELECT ... WHERE id = ?', [id])
//   const conn = await pool.getConnection(); await conn.beginTransaction(); ...
require('dotenv').config();
const { Pool } = require('pg');

function toPg(sql) {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isLocalHost(connectionString) {
  try {
    const host = new URL(connectionString.replace(/^postgres(ql)?:/i, 'http:')).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function wrapClient(client) {
  return {
    async query(sql, params) {
      const result = await client.query(toPg(sql), params);
      return [result.rows];
    },
    async beginTransaction() {
      await client.query('BEGIN');
    },
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    release() {
      client.release();
    }
  };
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'FATAL: DATABASE_URL is not set. For localhost use postgres://foodlog:foodlog@localhost:5432/foodlog'
  );
}

const poolConfig = { connectionString: process.env.DATABASE_URL };
if (!isLocalHost(process.env.DATABASE_URL)) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const rawPool = new Pool(poolConfig);

const pool = {
  async query(sql, params) {
    const result = await rawPool.query(toPg(sql), params);
    return [result.rows];
  },
  async getConnection() {
    const client = await rawPool.connect();
    return wrapClient(client);
  },
  async end() {
    await rawPool.end();
  }
};

module.exports = pool;
