// One-shot smoke test: verify the Postgres pool connects and queries.
const pool = require('../db');

(async () => {
  try {
    const [rows] = await pool.query('SELECT current_database() AS db, 1 AS ok');
    console.log('DB smoke test OK:', JSON.stringify(rows[0]));
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('DB smoke test FAILED:', err.message);
    try { await pool.end(); } catch (_) { /* pool may not have opened */ }
    process.exit(1);
  }
})();