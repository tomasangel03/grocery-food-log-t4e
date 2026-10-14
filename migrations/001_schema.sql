-- 001_schema.sql — Household Grocery Food Log (PostgreSQL / Supabase)
-- Safe to re-run: types, tables, and the updated_at trigger are created only if missing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_provider') THEN
    CREATE TYPE auth_provider AS ENUM ('local', 'google');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('admin', 'member');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'food_unit') THEN
    CREATE TYPE food_unit AS ENUM ('kg', 'g', 'L', 'ml', 'pieces', 'pack');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'food_status') THEN
    CREATE TYPE food_status AS ENUM ('available', 'consumed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_action') THEN
    CREATE TYPE activity_action AS ENUM (
      'add_shopping', 'consume_item', 'add_user', 'user_registered',
      'update_role', 'deactivate_user', 'edit_item', 'remove_item', 'edit_note'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
  uuid UUID PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  google_id VARCHAR(255) NULL,
  auth_provider auth_provider NOT NULL DEFAULT 'local',
  role user_role NOT NULL DEFAULT 'member',
  first_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_users_username UNIQUE (username),
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT uq_users_google_id UNIQUE (google_id)
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shopping_trips (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  trip_date DATE NOT NULL,
  store_name VARCHAR(255) NULL,
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_trips_user FOREIGN KEY (user_id) REFERENCES users (uuid)
);

CREATE INDEX IF NOT EXISTS idx_trips_user_date ON shopping_trips (user_id, trip_date);

CREATE TABLE IF NOT EXISTS food_items (
  id UUID PRIMARY KEY,
  shopping_trip_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  quantity NUMERIC(10, 2) NOT NULL,
  unit food_unit NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  purchase_date DATE NOT NULL,
  status food_status NOT NULL DEFAULT 'available',
  note TEXT NULL,
  note_updated_by_user_id UUID NULL,
  note_updated_at TIMESTAMPTZ NULL,
  consumed_by_user_id UUID NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_items_trip FOREIGN KEY (shopping_trip_id) REFERENCES shopping_trips (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_consumer FOREIGN KEY (consumed_by_user_id) REFERENCES users (uuid),
  CONSTRAINT fk_items_note_author FOREIGN KEY (note_updated_by_user_id) REFERENCES users (uuid)
);

CREATE INDEX IF NOT EXISTS idx_items_status_date ON food_items (status, purchase_date);

CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  action_type activity_action NOT NULL,
  action_description TEXT NOT NULL,
  entity_type VARCHAR(50) NULL,
  entity_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users (uuid)
);

CREATE INDEX IF NOT EXISTS idx_logs_user_action_created
  ON activity_logs (user_id, action_type, created_at);

CREATE TABLE IF NOT EXISTS monthly_stats (
  id UUID PRIMARY KEY,
  stat_month CHAR(7) NOT NULL,
  total_spent NUMERIC(12, 2) NOT NULL DEFAULT 0,
  trip_count INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_monthly_stats_month UNIQUE (stat_month)
);
