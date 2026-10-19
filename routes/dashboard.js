// routes/dashboard.js — dashboard summary (JWT-protected)
// GET /v1/dashboard/summary:
//   - recent 10 food items (newest first)
//   - available inventory count grouped by unit
//   - total items purchased this month + total spent this month (shopping_trips.total_amount)
const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');
const { requireHousehold } = require('../middleware/household');

const router = express.Router();

router.get('/dashboard/summary', verifyToken, requireHousehold, async (req, res) => {
  try {
    const householdId = req.household.id;

    const [recentItems] = await pool.query(
      `SELECT fi.id, fi.name, fi.quantity, fi.unit, fi.price, fi.purchase_date,
              fi.status, fi.consumed_at, fi.created_at,
              st.store_name, st.trip_date
         FROM food_items fi
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
        WHERE st.household_id = ?
        ORDER BY fi.created_at DESC, fi.id DESC
        LIMIT 10`,
      [householdId]
    );

    const [inventoryByUnit] = await pool.query(
      `SELECT fi.unit,
              COUNT(*)                 AS item_count,
              SUM(fi.quantity_remaining) AS total_quantity
         FROM food_items fi
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
        WHERE fi.status = 'available'
          AND st.household_id = ?
        GROUP BY fi.unit
        ORDER BY fi.unit`,
      [householdId]
    );

    const [[spendRow]] = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_spent,
              COUNT(*)                       AS trip_count
         FROM shopping_trips
        WHERE household_id = ?
          AND trip_date >= date_trunc('month', CURRENT_DATE)::date`,
      [householdId]
    );
    const [[itemsRow]] = await pool.query(
      `SELECT COUNT(*) AS total_items
         FROM food_items fi
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
        WHERE st.household_id = ?
          AND fi.purchase_date >= date_trunc('month', CURRENT_DATE)::date`,
      [householdId]
    );

    const [[consumptionRow]] = await pool.query(
      `WITH last_trips AS (
         SELECT id
           FROM shopping_trips
          WHERE household_id = ?
          ORDER BY trip_date DESC, created_at DESC
          LIMIT 5
       )
       SELECT COUNT(fi.id)::int AS item_count,
              COUNT(fi.id) FILTER (WHERE fi.status = 'consumed')::int AS consumed_count,
              (SELECT COUNT(*)::int FROM last_trips) AS trip_count
         FROM last_trips lt
         LEFT JOIN food_items fi ON fi.shopping_trip_id = lt.id`,
      [householdId]
    );

    const [[weekRow]] = await pool.query(
      `SELECT COUNT(*)::int AS consumed_this_week
         FROM consumption_events ce
         JOIN food_items fi ON fi.id = ce.food_item_id
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
        WHERE st.household_id = ?
          AND ce.consumed_at >= NOW() - INTERVAL '7 days'`,
      [householdId]
    );

    const itemCount = Number(consumptionRow.item_count || 0);
    const consumedCount = Number(consumptionRow.consumed_count || 0);

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
      },
      recent_consumption: {
        trip_count: Number(consumptionRow.trip_count || 0),
        item_count: itemCount,
        consumed_count: consumedCount,
        percent: itemCount === 0 ? 0 : Math.round((consumedCount / itemCount) * 100)
      },
      consumed_this_week: Number(weekRow.consumed_this_week || 0)
    });
  } catch (err) {
    console.error('GET /v1/dashboard/summary error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;