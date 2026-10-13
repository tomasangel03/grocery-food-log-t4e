// One-shot smoke test: verify the MySQL pool connects and queries.
const pool = require('../db');

(async () => {
  try {
    const [rows] = await pool.query('SELECT DATABASE() AS db, 1 AS ok');
    console.log('DB smoke test OK:', JSON.stringify(rows[0]));
    process.exit(0);
  } catch (err) {
    console.error('DB smoke test FAILED:', err.message);
    process.exit(1);
  }
})();