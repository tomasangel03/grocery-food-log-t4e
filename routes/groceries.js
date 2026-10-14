// routes/groceries.js — shopping trips + food inventory endpoints (all JWT-protected)
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All grocery/inventory routes require an authenticated user
router.use(verifyToken);

const VALID_UNITS = ['kg', 'g', 'L', 'ml', 'pieces', 'pack'];

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToAmount(cents) {
  return (cents / 100).toFixed(2);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * validateItem — enforces rule_item_fields_valid on a single trip item.
 * Returns an error string or null when valid.
 */
function validateItem(item, index) {
  const label = `Item ${index + 1}`;
  if (!item || typeof item !== 'object') return `${label}: invalid item payload`;
  if (typeof item.name !== 'string' || item.name.trim().length === 0) {
    return `${label}: name is required`;
  }
  const qty = Number(item.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return `${label}: quantity must be a positive number`;
  }
  if (!VALID_UNITS.includes(item.unit)) {
    return `${label}: unit must be one of ${VALID_UNITS.join(', ')}`;
  }
  const price = Number(item.price);
  if (!Number.isFinite(price) || price < 0) {
    return `${label}: price must be a non-negative number`;
  }
  if (item.purchase_date != null && item.purchase_date !== '' && !isValidDateStr(item.purchase_date)) {
    return `${label}: purchase_date must be a valid date (YYYY-MM-DD)`;
  }
  return null;
}

/**
 * POST /v1/shopping-trips
 * Creates a shopping trip + its food items in a single transaction,
 * computes total_amount as the sum of item prices, and writes an
 * add_shopping activity entry (evt_activity_on_shopping).
 */
router.post('/shopping-trips', async (req, res) => {
  const { trip_date, store_name, items } = req.body || {};

  if (!isValidDateStr(trip_date)) {
    return res.status(400).json({ error: 'trip_date is required (YYYY-MM-DD)' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one food item is required' });
  }
  for (let i = 0; i < items.length; i++) {
    const err = validateItem(items[i], i);
    if (err) return res.status(400).json({ error: err });
  }

  const tripId = crypto.randomUUID();
  const totalAmount = items.reduce((sum, it) => sum + Number(it.price), 0);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO shopping_trips (id, user_id, trip_date, store_name, total_amount) VALUES (?, ?, ?, ?, ?)',
      [tripId, req.user.id, trip_date, store_name ? String(store_name).trim() : null, totalAmount.toFixed(2)]
    );

    const createdItems = [];
    for (const it of items) {
      const itemId = crypto.randomUUID();
      // purchase_date defaults to the trip date (design: add_item_purchase_date)
      const purchaseDate = isValidDateStr(it.purchase_date) ? it.purchase_date : trip_date;
      await conn.query(
        `INSERT INTO food_items
           (id, shopping_trip_id, name, quantity, quantity_remaining, unit, price, purchase_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
        [itemId, tripId, it.name.trim(), Number(it.quantity), Number(it.quantity), it.unit, Number(it.price), purchaseDate]
      );
      createdItems.push({
        id: itemId,
        shopping_trip_id: tripId,
        name: it.name.trim(),
        quantity: Number(it.quantity),
        quantity_remaining: Number(it.quantity),
        unit: it.unit,
        price: Number(it.price),
        purchase_date: purchaseDate,
        status: 'available'
      });
    }

    // evt_activity_on_shopping — "X added N items on date"
    await conn.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'add_shopping', ?, 'shopping_trip', ?)`,
      [
        crypto.randomUUID(),
        req.user.id,
        `${req.user.username} added ${items.length} item${items.length === 1 ? '' : 's'} on ${trip_date}`,
        tripId
      ]
    );

    await conn.commit();

    return res.status(201).json({
      trip: {
        id: tripId,
        user_id: req.user.id,
        trip_date,
        store_name: store_name ? String(store_name).trim() : null,
        total_amount: Number(totalAmount.toFixed(2))
      },
      items: createdItems
    });
  } catch (err) {
    await conn.rollback();
    console.error('POST /shopping-trips failed:', err);
    return res.status(500).json({ error: 'Failed to save shopping trip' });
  } finally {
    conn.release();
  }
});

/**
 * GET /v1/food-items
 * Lists inventory joined with the adder's username.
 * Filters: status (default 'available' per rule_consumed_excluded, unless
 * FEATURE_SHOW_CONSUMED_DEFAULT is enabled → 'all'), from/to purchase-date
 * range, userId (who added), name search (q or name), and price with
 * priceOp gte or lte. Each row includes unfiltered trip progress counts.
 */
router.get('/food-items', async (req, res) => {
  try {
    const showConsumedDefault = /^(1|true|yes|on)$/i.test(process.env.FEATURE_SHOW_CONSUMED_DEFAULT || '');
    let status = req.query.status || (showConsumedDefault ? 'all' : 'available');
    if (!['available', 'consumed', 'all'].includes(status)) {
      return res.status(400).json({ error: "status must be 'available', 'consumed' or 'all'" });
    }

    const where = [];
    const params = [];

    if (status !== 'all') {
      where.push('fi.status = ?');
      params.push(status);
    }
    if (req.query.from) {
      if (!isValidDateStr(req.query.from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
      where.push('fi.purchase_date >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      if (!isValidDateStr(req.query.to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
      where.push('fi.purchase_date <= ?');
      params.push(req.query.to);
    }
    if (req.query.userId) {
      where.push('st.user_id = ?');
      params.push(req.query.userId);
    }
    const search = req.query.q || req.query.name;
    if (search) {
      where.push('fi.name LIKE ?');
      params.push(`%${search}%`);
    }
    if (req.query.price != null && String(req.query.price).trim() !== '') {
      const price = Number(req.query.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      const priceOp = req.query.priceOp;
      if (priceOp !== 'gte' && priceOp !== 'lte') {
        return res.status(400).json({ error: "priceOp must be 'gte' or 'lte'" });
      }
      where.push(priceOp === 'gte' ? 'fi.price >= ?' : 'fi.price <= ?');
      params.push(price);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT fi.id, fi.shopping_trip_id, fi.name, fi.quantity, fi.quantity_remaining, fi.unit, fi.price,
              fi.purchase_date, fi.status, fi.consumed_by_user_id, fi.consumed_at,
              fi.note, fi.note_updated_by_user_id, fi.note_updated_at,
              st.trip_date, st.created_at AS trip_created_at, st.store_name, st.user_id AS added_by_user_id,
              u.username AS added_by_username,
              cu.username AS consumed_by_username,
              nu.username AS note_updated_by_username,
              prog.trip_item_count, prog.trip_consumed_count,
              COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'id', ce.id,
                    'quantity', ce.quantity,
                    'note', ce.note,
                    'consumed_at', ce.consumed_at,
                    'consumed_by_username', eu.username
                  )
                  ORDER BY ce.consumed_at DESC
                )
                FROM consumption_events ce
                LEFT JOIN users eu ON eu.uuid = ce.consumed_by_user_id
                WHERE ce.food_item_id = fi.id
              ), '[]'::json) AS consumptions
         FROM food_items fi
         JOIN shopping_trips st ON st.id = fi.shopping_trip_id
         JOIN users u ON u.uuid = st.user_id
         LEFT JOIN users cu ON cu.uuid = fi.consumed_by_user_id
         LEFT JOIN users nu ON nu.uuid = fi.note_updated_by_user_id
         LEFT JOIN (
           SELECT shopping_trip_id,
                  COUNT(*)::int AS trip_item_count,
                  COUNT(*) FILTER (WHERE status = 'consumed')::int AS trip_consumed_count
             FROM food_items
            GROUP BY shopping_trip_id
         ) prog ON prog.shopping_trip_id = fi.shopping_trip_id
         ${whereSql}
         ORDER BY st.trip_date DESC, st.created_at DESC, fi.created_at DESC`,
      params
    );

    for (const row of rows) {
      row.consumptions = asArray(row.consumptions);
      row.trip_item_count = Number(row.trip_item_count || 0);
      row.trip_consumed_count = Number(row.trip_consumed_count || 0);
    }

    // Expose the flag so the UI can default its status filter to "All items"
    return res.json({ items: rows, show_consumed_default: showConsumedDefault });
  } catch (err) {
    console.error('GET /food-items failed:', err);
    return res.status(500).json({ error: 'Failed to load food items' });
  }
});

/**
 * PATCH /v1/food-items/:id/consume
 * Logs a partial amount. Body: { quantity, note? }.
 * Remaining quantity drops by that amount. Status becomes consumed only when
 * nothing is left. Rejects with 409 once the item is already used up
 * (rule_no_double_consume) and writes a consume_item activity entry.
 */
router.patch('/food-items/:id/consume', async (req, res) => {
  const body = req.body || {};
  if (body.quantity == null || body.quantity === '') {
    return res.status(400).json({ error: 'quantity is required' });
  }
  const qtyCents = toCents(body.quantity);
  if (qtyCents == null || qtyCents <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }
  if (body.note != null && body.note !== '' && typeof body.note !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }
  const trimmedNote = body.note == null ? '' : String(body.note).trim();
  if (trimmedNote.length > 1000) {
    return res.status(400).json({ error: 'note must be 1000 characters or fewer' });
  }
  const note = trimmedNote.length === 0 ? null : trimmedNote;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, name, unit, status, quantity_remaining FROM food_items WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Food item not found' });
    }
    const item = rows[0];
    const remCents = toCents(item.quantity_remaining);
    if (item.status === 'consumed' || remCents <= 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'Item is already consumed' });
    }
    if (qtyCents > remCents) {
      await conn.rollback();
      return res.status(400).json({
        error: `Only ${centsToAmount(remCents)} ${item.unit} left`
      });
    }

    const newRemCents = remCents - qtyCents;
    const fullyUsed = newRemCents === 0;
    if (fullyUsed) {
      await conn.query(
        `UPDATE food_items
            SET quantity_remaining = 0,
                status = 'consumed',
                consumed_by_user_id = ?,
                consumed_at = NOW()
          WHERE id = ?`,
        [req.user.id, item.id]
      );
    } else {
      await conn.query(
        'UPDATE food_items SET quantity_remaining = ? WHERE id = ?',
        [centsToAmount(newRemCents), item.id]
      );
    }

    const eventId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO consumption_events
         (id, food_item_id, quantity, note, consumed_by_user_id, consumed_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [eventId, item.id, centsToAmount(qtyCents), note, req.user.id]
    );

    const leftLabel = fullyUsed
      ? 'none left'
      : `${centsToAmount(newRemCents)} ${item.unit} left`;
    const noteBit = note ? ` Note: ${note.length > 80 ? `${note.slice(0, 80)}…` : note}` : '';
    await conn.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'consume_item', ?, 'food_item', ?)`,
      [
        crypto.randomUUID(),
        req.user.id,
        `${req.user.username} consumed ${centsToAmount(qtyCents)} ${item.unit} of "${item.name}" (${leftLabel}).${noteBit}`,
        item.id
      ]
    );

    await conn.commit();

    const [updated] = await pool.query(
      `SELECT id, shopping_trip_id, name, quantity, quantity_remaining, unit, price, purchase_date,
              status, consumed_by_user_id, consumed_at
         FROM food_items WHERE id = ?`,
      [item.id]
    );
    return res.json({
      item: updated[0],
      event: {
        id: eventId,
        quantity: Number(centsToAmount(qtyCents)),
        note
      }
    });
  } catch (err) {
    await conn.rollback();
    console.error('PATCH /food-items/:id/consume failed:', err);
    return res.status(500).json({ error: 'Failed to consume item' });
  } finally {
    conn.release();
  }
});

/**
 * PATCH /v1/food-items/:id/note
 * Any authenticated household member can write/update the free-text note while
 * the item is still available. Once the item is consumed the note is frozen
 * (409). Every change writes an 'edit_note' activity entry with old → new text.
 */
router.patch('/food-items/:id/note', async (req, res) => {
  const raw = (req.body || {}).note;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return res.status(400).json({ error: 'note must be a string' });
  }
  let note = raw == null ? '' : String(raw).trim();
  if (note.length > 1000) {
    return res.status(400).json({ error: 'note must be 1000 characters or fewer' });
  }
  const noteValue = note.length === 0 ? null : note;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, name, status, note FROM food_items WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Food item not found' });
    }
    const item = rows[0];

    if (item.status === 'consumed') {
      await conn.rollback();
      return res.status(409).json({ error: 'This item has been consumed — its note can no longer be edited' });
    }

    const previous = item.note == null ? '' : String(item.note);
    if (previous === (noteValue == null ? '' : noteValue)) {
      await conn.rollback();
      return res.json({ item: { id: item.id, note: noteValue }, unchanged: true });
    }

    await conn.query(
      'UPDATE food_items SET note = ?, note_updated_by_user_id = ?, note_updated_at = NOW() WHERE id = ?',
      [noteValue, req.user.id, item.id]
    );

    const shorten = (s) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
    const description =
      `${req.user.username} updated the note on "${item.name}": ` +
      `"${previous ? shorten(previous) : '(empty)'}" → "${noteValue ? shorten(noteValue) : '(empty)'}"`;

    await conn.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'edit_note', ?, 'food_item', ?)`,
      [crypto.randomUUID(), req.user.id, description, item.id]
    );

    await conn.commit();

    const [updated] = await pool.query(
      `SELECT id, name, status, note, note_updated_by_user_id, note_updated_at
         FROM food_items WHERE id = ?`,
      [item.id]
    );
    return res.json({ item: updated[0] });
  } catch (err) {
    await conn.rollback();
    console.error('PATCH /food-items/:id/note failed:', err);
    return res.status(500).json({ error: 'Failed to save note' });
  } finally {
    conn.release();
  }
});

/**
 * PUT /v1/food-items/:id
 * Admin-only edit (rule_admin_only_edit) of name/quantity/price.
 * Writes an edit_item activity entry.
 */
router.put('/food-items/:id', requireAdmin, async (req, res) => {
  const { name, quantity, price } = req.body || {};

  const sets = [];
  const params = [];
  const changes = [];
  let pendingQty = null;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    sets.push('name = ?');
    params.push(name.trim());
    changes.push(`name → "${name.trim()}"`);
  }
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive number' });
    }
    sets.push('quantity = ?');
    params.push(qty);
    changes.push(`quantity → ${qty}`);
    pendingQty = qty;
  }
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }
    sets.push('price = ?');
    params.push(p);
    changes.push(`price → ${p}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'Provide at least one of name, quantity, price' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, name, status, quantity, quantity_remaining FROM food_items WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Food item not found' });
    }
    const original = rows[0];

    if (pendingQty != null) {
      const purchasedCents = toCents(original.quantity);
      const remainingCents = toCents(original.quantity_remaining);
      const consumedCents = purchasedCents - remainingCents;
      const newCents = toCents(pendingQty);
      if (newCents < consumedCents) {
        await conn.rollback();
        return res.status(400).json({ error: 'quantity cannot be less than the amount already consumed' });
      }
      const newRemainingCents = newCents - consumedCents;
      sets.push('quantity_remaining = ?');
      params.push(centsToAmount(newRemainingCents));
      if (newRemainingCents === 0) {
        sets.push("status = 'consumed'");
        if (original.status !== 'consumed') {
          sets.push('consumed_by_user_id = ?');
          params.push(req.user.id);
          sets.push('consumed_at = NOW()');
        }
      } else if (original.status === 'consumed') {
        sets.push("status = 'available'");
        sets.push('consumed_by_user_id = NULL');
        sets.push('consumed_at = NULL');
      }
    }

    await conn.query(
      `UPDATE food_items SET ${sets.join(', ')} WHERE id = ?`,
      [...params, original.id]
    );

    await conn.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'edit_item', ?, 'food_item', ?)`,
      [
        crypto.randomUUID(),
        req.user.id,
        `${req.user.username} edited "${original.name}" (${changes.join(', ')})`,
        original.id
      ]
    );

    await conn.commit();

    const [updated] = await pool.query(
      `SELECT id, shopping_trip_id, name, quantity, quantity_remaining, unit, price, purchase_date,
              status, consumed_by_user_id, consumed_at
         FROM food_items WHERE id = ?`,
      [original.id]
    );
    return res.json({ item: updated[0] });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /food-items/:id failed:', err);
    return res.status(500).json({ error: 'Failed to edit item' });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /v1/food-items/:id
 * Admin-only removal (rule_admin_only_edit — "edit or remove a food item entry").
 * Writes a remove_item activity entry.
 */
router.delete('/food-items/:id', requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, name FROM food_items WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Food item not found' });
    }
    const item = rows[0];

    await conn.query('DELETE FROM food_items WHERE id = ?', [item.id]);

    await conn.query(
      `INSERT INTO activity_logs (id, user_id, action_type, action_description, entity_type, entity_id)
       VALUES (?, ?, 'remove_item', ?, 'food_item', ?)`,
      [crypto.randomUUID(), req.user.id, `${req.user.username} removed "${item.name}"`, item.id]
    );

    await conn.commit();
    return res.json({ deleted: true, id: item.id });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE /food-items/:id failed:', err);
    return res.status(500).json({ error: 'Failed to remove item' });
  } finally {
    conn.release();
  }
});

module.exports = router;