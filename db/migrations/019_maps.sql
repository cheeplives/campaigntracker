-- 019_maps.sql — the Maps tab: maps (an uploaded image with pins, routes, a scale and a grid), tokens (pictures that
-- stand for people, creatures and things) and party groups (who travels together, and where they are).
--
-- Adds maps, map_pins, map_routes, tokens and party_groups. A map's image and a token's picture are attachments
-- (parent_type 'map' and 'token'); there is no foreign key to them, as for tomes, so the code purges them.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/019_maps.sql
-- (install.php runs it for you when there is no maps table.)
-- Fresh installs already get the tables from db/schema.sql.
CREATE TABLE IF NOT EXISTS maps (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  image_id INT UNSIGNED NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  scale_per_px DOUBLE NULL,
  scale_unit VARCHAR(2) NULL,
  grid_px DOUBLE NULL,
  grid_offset_x DOUBLE NULL,
  grid_offset_y DOUBLE NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_pins (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  x DOUBLE NOT NULL,
  y DOUBLE NOT NULL,
  kind ENUM('note','entry','event') NOT NULL,
  entry_id INT UNSIGNED NULL,
  event_id INT UNSIGNED NULL,
  label VARCHAR(150) NOT NULL DEFAULT '',
  note VARCHAR(1000) NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pin_entry (campaign_id, entry_id),
  KEY ix_pin_event (campaign_id, event_id),
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  points_json TEXT NOT NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  image_id INT UNSIGNED NULL,
  kind ENUM('party','character','creature','object') NOT NULL DEFAULT 'creature',
  size_squares TINYINT UNSIGNED NOT NULL DEFAULT 1,
  member_id BIGINT UNSIGNED NULL,
  entry_id INT UNSIGNED NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token_member (campaign_id, member_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS party_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  members_json TEXT NOT NULL,
  region_id INT UNSIGNED NULL,
  map_id INT UNSIGNED NULL,
  x DOUBLE NULL,
  y DOUBLE NULL,
  token_id INT UNSIGNED NULL,
  is_main TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE SET NULL,
  FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
