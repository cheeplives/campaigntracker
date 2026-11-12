-- 053_map_areas.sql — areas drawn on a map: a closed outline (a kingdom, a forest, a district, a weather front) with a
-- name and a colour. entry_id: the Encyclopedia entry it is (the area of a Location); region_id: the weather region it
-- is, so the party's main group put inside it takes that region and its weather. The smallest area holding a point wins
-- where areas overlap. is_secret: GM only.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/053_map_areas.sql
-- (deploy.sh and install.php run it for you when there is no map_areas table.)
-- Fresh installs already get the table from db/schema.sql.
CREATE TABLE IF NOT EXISTS map_areas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  points_json TEXT NOT NULL,
  color VARCHAR(7) NULL,
  entry_id INT UNSIGNED NULL,
  region_id INT UNSIGNED NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_area_map (map_id),
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
