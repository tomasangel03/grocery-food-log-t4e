-- 003_households.sql — households, memberships, and scoping existing groceries.
-- Safe to re-run. Existing users and shopping trips are kept and attached to
-- one household owned by the seeded user "tomas".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_role') THEN
    CREATE TYPE platform_role AS ENUM ('system_admin', 'user');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'household_role') THEN
    CREATE TYPE household_role AS ENUM ('admin', 'co_admin', 'member');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_role platform_role NOT NULL DEFAULT 'user';

UPDATE users
   SET platform_role = 'system_admin'
 WHERE lower(username) = 'tomas';

CREATE TABLE IF NOT EXISTS households (
  id UUID PRIMARY KEY,
  name VARCHAR(40) NOT NULL,
  join_code CHAR(8) NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_households_join_code UNIQUE (join_code),
  CONSTRAINT fk_households_creator FOREIGN KEY (created_by) REFERENCES users (uuid),
  CONSTRAINT chk_households_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT chk_households_join_code CHECK (join_code ~ '^[A-Z0-9]{8}$')
);

DROP TRIGGER IF EXISTS households_set_updated_at ON households;
CREATE TRIGGER households_set_updated_at
  BEFORE UPDATE ON households
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS household_members (
  household_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role household_role NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (household_id, user_id),
  CONSTRAINT fk_members_household FOREIGN KEY (household_id) REFERENCES households (id) ON DELETE CASCADE,
  CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users (uuid) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_household_one_admin
  ON household_members (household_id) WHERE role = 'admin';

CREATE UNIQUE INDEX IF NOT EXISTS uq_household_one_coadmin
  ON household_members (household_id) WHERE role = 'co_admin';

CREATE INDEX IF NOT EXISTS idx_members_user ON household_members (user_id);

CREATE OR REPLACE FUNCTION enforce_household_membership_cap()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
      FROM household_members
     WHERE user_id = NEW.user_id
       AND household_id <> NEW.household_id
  ) >= 3 THEN
    RAISE EXCEPTION 'A person can belong to at most 3 households'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS household_members_cap ON household_members;
CREATE TRIGGER household_members_cap
  BEFORE INSERT OR UPDATE OF user_id ON household_members
  FOR EACH ROW
  EXECUTE FUNCTION enforce_household_membership_cap();

ALTER TABLE shopping_trips
  ADD COLUMN IF NOT EXISTS household_id UUID;

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS household_id UUID;

-- One home for everything that already exists. Re-runs reuse that household.
DO $$
DECLARE
  tomas_id UUID;
  home_id UUID;
  new_code TEXT;
BEGIN
  SELECT uuid INTO tomas_id FROM users WHERE lower(username) = 'tomas' LIMIT 1;
  IF tomas_id IS NULL THEN
    RAISE EXCEPTION 'User "tomas" is required before household migration';
  END IF;

  SELECT id INTO home_id
    FROM households
   WHERE created_by = tomas_id
     AND name = 'Tomas household'
   LIMIT 1;

  IF home_id IS NULL THEN
    home_id := md5(random()::text || clock_timestamp()::text)::uuid;
    LOOP
      new_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM households WHERE join_code = new_code);
    END LOOP;
    INSERT INTO households (id, name, join_code, created_by)
    VALUES (home_id, 'Tomas household', new_code, tomas_id);
  END IF;

  INSERT INTO household_members (household_id, user_id, role)
  SELECT home_id, tomas_id, 'admin'
   WHERE NOT EXISTS (
     SELECT 1 FROM household_members
      WHERE household_id = home_id AND user_id = tomas_id
   );

  INSERT INTO household_members (household_id, user_id, role)
  SELECT home_id, u.uuid, 'member'
    FROM users u
   WHERE u.uuid <> tomas_id
     AND NOT EXISTS (
       SELECT 1 FROM household_members hm
        WHERE hm.household_id = home_id AND hm.user_id = u.uuid
     );

  UPDATE shopping_trips SET household_id = home_id WHERE household_id IS NULL;
  UPDATE activity_logs SET household_id = home_id WHERE household_id IS NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_trips_household'
  ) THEN
    ALTER TABLE shopping_trips
      ADD CONSTRAINT fk_trips_household
      FOREIGN KEY (household_id) REFERENCES households (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_logs_household'
  ) THEN
    ALTER TABLE activity_logs
      ADD CONSTRAINT fk_logs_household
      FOREIGN KEY (household_id) REFERENCES households (id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE shopping_trips ALTER COLUMN household_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_household_date ON shopping_trips (household_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_logs_household_created ON activity_logs (household_id, created_at DESC);

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
