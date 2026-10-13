-- 001_schema.sql — Household Grocery Food Log core schema (MySQL 8.x)

CREATE TABLE IF NOT EXISTS users (
  uuid CHAR(36) NOT NULL PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  google_id VARCHAR(255) NULL,
  auth_provider ENUM('local','google') NOT NULL DEFAULT 'local',
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  first_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  is_active BOOLEAN NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google_id (google_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shopping_trips (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  trip_date DATE NOT NULL,
  store_name VARCHAR(255) NULL,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_trips_user_date (user_id, trip_date),
  CONSTRAINT fk_trips_user FOREIGN KEY (user_id) REFERENCES users (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS food_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  shopping_trip_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  unit ENUM('kg','g','L','ml','pieces','pack') NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  purchase_date DATE NOT NULL,
  status ENUM('available','consumed') NOT NULL DEFAULT 'available',
  note TEXT NULL,
  note_updated_by_user_id CHAR(36) NULL,
  note_updated_at DATETIME NULL,
  consumed_by_user_id CHAR(36) NULL,
  consumed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_items_status_date (status, purchase_date),
  CONSTRAINT fk_items_trip FOREIGN KEY (shopping_trip_id) REFERENCES shopping_trips (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_consumer FOREIGN KEY (consumed_by_user_id) REFERENCES users (uuid),
  CONSTRAINT fk_items_note_author FOREIGN KEY (note_updated_by_user_id) REFERENCES users (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  action_type ENUM('add_shopping','consume_item','add_user','user_registered','update_role','deactivate_user','edit_item','remove_item','edit_note') NOT NULL,
  action_description TEXT NOT NULL,
  entity_type VARCHAR(50) NULL,
  entity_id CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_logs_user_action_created (user_id, action_type, created_at),
  CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;