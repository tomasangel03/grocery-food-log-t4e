// routes/dashboard.js — dashboard summary (JWT-protected)
// GET /v1/dashboard/summary:
//   - recent 10 food items (newest first)
//   - available inventory count grouped by unit
//   - total items purchased this month + total spent this month (shopping_trips.total_amount)
const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

router.get('/dashboard/summary', verifyToken, async (req, res) => {
  try {
    // Recent 10 food items with their trip context
    const [recentItems] = await pool.query(
      `SELECT fi.id, fi.name, fi.quantity, fi.unit, fi.price, fi.purchase_date,
              fi.status, fi.consumed_at, fi.created_at,
              st.store_name, st.trip_date
         FROM food_items fi
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
        ORDER BY fi.created_at DESC, fi.id DESC
        LIMIT 10`
    );

    // Available inventory grouped by unit
    const [inventoryByUnit] = await pool.query(
      `SELECT unit,
              COUNT(*)      AS item_count,
              SUM(quantity) AS total_quantity
         FROM food_items
        WHERE status = 'available'
        GROUP BY unit
        ORDER BY unit`
    );

    // This month's totals (calendar month, from the 1st)
    const [[spendRow]] = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_spent,
              COUNT(*)                       AS trip_count
         FROM shopping_trips
        WHERE trip_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    );
    const [[itemsRow]] = await pool.query(
      `SELECT COUNT(*) AS total_items
         FROM food_items
        WHERE purchase_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    );

    return res.json({
      recent_items: recentItems,
      inventory_by_unit: inventoryByUnit.map((r) => ({
        unit: r.unit,
        item_count: Number(r.item_count),
        total_quantity: Number(r.total_quantity)
      })),
      this_month: {
        total_items: Number(itemsRow.total_items),
        total_spent: Number(spendRow.total_spent),
        trip_count: Number(spendRow.trip_count)
      }
    });
  } catch (err) {
    console.error('GET /v1/dashboard/summary error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;