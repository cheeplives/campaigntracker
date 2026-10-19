-- 006_party_holdings.sql — the Party Holdings tab: the Gear and Loot list, the holding cards and their Storage.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/006_party_holdings.sql
-- (install.php runs it for you when there is no holdings table.)
-- Fresh installs already get it from db/schema.sql.

-- Party Holdings tab. party_gear is the Gear and Loot list: one row per item, all free text
-- but the count. holdings are the cards beside it: vehicles, animals, buildings, assets or a
-- type the party names (kind 'custom', named by type_name). stats_json holds the fields of
-- its kind, e.g. {"top_speed": "60 mph", "fuel_type": "Diesel"}; see HOLDING_KINDS in api/index.php.
-- Every member of the campaign, GM or player, can add, change and remove both.
CREATE TABLE IF NOT EXISTS party_gear (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  item VARCHAR(200) NOT NULL DEFAULT '',
  claimed_by VARCHAR(200) NOT NULL DEFAULT '',
  location VARCHAR(200) NOT NULL DEFAULT '',
  amount INT NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_gear_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS holdings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  kind VARCHAR(16) NOT NULL,                        -- vehicle | animal | building | asset | custom
  type_name VARCHAR(60) NOT NULL DEFAULT '',        -- the type a custom holding is, e.g. "Ship"
  location VARCHAR(200) NOT NULL DEFAULT '',
  description TEXT,
  amount INT NOT NULL DEFAULT 1,
  stats_json TEXT,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_holdings_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Holdings have their own tags, kept apart from the events' list in tags.
CREATE TABLE IF NOT EXISTS holding_tag_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(40) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
  UNIQUE KEY uq_holding_tag_name (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which tags each holding carries.
CREATE TABLE IF NOT EXISTS holding_tags (
  holding_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (holding_id, tag_id),
  FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES holding_tag_names(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What is kept in each holding (the Storage box on its card): one line per item and its weight.
-- Weights are plain numbers, added up and compared with the number in the holding's Cargo field.
CREATE TABLE IF NOT EXISTS holding_storage (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  holding_id INT UNSIGNED NOT NULL,
  item VARCHAR(200) NOT NULL,
  weight DECIMAL(14,2) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_storage_holding (holding_id, id),
  FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
