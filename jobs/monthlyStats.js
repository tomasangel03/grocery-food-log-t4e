// jobs/monthlyStats.js — job_monthly_stats (phase 3)
// Runs at 02:00 on the 1st of each month (cron: 0 2 1 * *) and rolls up the
// PREVIOUS calendar month: total spend (shopping_trips.total_amount), trip
// count, and food item count. Results are upserted into monthly_stats so the
// job is idempotent (safe to re-run for the same month).
const cron = require('node-cron');
const { randomUUID } = require('crypto');
const pool = require('../db');

/** First day of last month + first day of this month (exclusive upper bound), as YYYY-MM-DD. */
function lastMonthRange(now = new Date()) {
  const startThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    monthKey: `${startLast.getFullYear()}-${String(startLast.getMonth() + 1).padStart(2, '0')}`,
    from: fmt(startLast),
    to: fmt(startThis)
  };
}

/** Aggregate last month's spend + item counts and upsert into monthly_stats. */
async function runMonthlyRollup(now = new Date()) {
  const { monthKey, from, to } = lastMonthRange(now);

  const [[spend]] = await pool.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS total_spent,
            COUNT(*)                       AS trip_count
       FROM shopping_trips
      WHERE trip_date >= ? AND trip_date < ?`,
    [from, to]
  );
  const [[items]] = await pool.query(
    `SELECT COUNT(*) AS total_items
       FROM food_items
      WHERE purchase_date >= ? AND purchase_date < ?`,
    [from, to]
  );

  await pool.query(
    `INSERT INTO monthly_stats (id, stat_month, total_spent, trip_count, total_items, generated_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON CONFLICT (stat_month) DO UPDATE SET
       total_spent = EXCLUDED.total_spent,
       trip_count = EXCLUDED.trip_count,
       total_items = EXCLUDED.total_items,
       generated_at = NOW()`,
    [randomUUID(), monthKey, Number(spend.total_spent), Number(spend.trip_count), Number(items.total_items)]
  );

  console.log(
    `[monthlyStats] Rolled up ${monthKey}: spent=${spend.total_spent}, trips=${spend.trip_count}, items=${items.total_items}`
  );
  return { monthKey, total_spent: Number(spend.total_spent), trip_count: Number(spend.trip_count), total_items: Number(items.total_items) };
}

/** Schedule the job: 02:00 on the 1st of every month. */
function start() {
  cron.schedule('0 2 1 * *', () => {
    runMonthlyRollup().catch((err) => {
      console.error('[monthlyStats] rollup failed:', err);
    });
  });
  console.log('[monthlyStats] scheduled (0 2 1 * *)');
}

module.exports = { start, runMonthlyRollup };