-- 002_partial_consumption.sql — partial use of a food item.
-- Safe to re-run. quantity stays the amount purchased; quantity_remaining is what is left.

ALTER TABLE food_items
  ADD COLUMN IF NOT EXISTS quantity_remaining NUMERIC(10, 2);

UPDATE food_items
SET quantity_remaining = CASE
  WHEN status = 'consumed' THEN 0
  ELSE quantity
END
WHERE quantity_remaining IS NULL;

ALTER TABLE food_items
  ALTER COLUMN quantity_remaining SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_quantity_remaining'
  ) THEN
    ALTER TABLE food_items
      ADD CONSTRAINT chk_items_quantity_remaining CHECK (quantity_remaining >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS consumption_events (
  id UUID PRIMARY KEY,
  food_item_id UUID NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL,
  note TEXT NULL,
  consumed_by_user_id UUID NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_item FOREIGN KEY (food_item_id) REFERENCES food_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_events_user FOREIGN KEY (consumed_by_user_id) REFERENCES users (uuid),
  CONSTRAINT chk_events_quantity CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_events_item_consumed
  ON consumption_events (food_item_id, consumed_at DESC);

INSERT INTO consumption_events (id, food_item_id, quantity, note, consumed_by_user_id, consumed_at)
SELECT gen_random_uuid(),
       fi.id,
       fi.quantity,
       NULL,
       fi.consumed_by_user_id,
       COALESCE(fi.consumed_at, fi.created_at)
FROM food_items fi
WHERE fi.status = 'consumed'
  AND fi.quantity > 0
  AND NOT EXISTS (
    SELECT 1 FROM consumption_events ce WHERE ce.food_item_id = fi.id
  );
