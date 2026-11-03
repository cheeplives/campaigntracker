-- 024_map_styles.sql — Maps phase 3: a pin can have its own icon and colour and be locked in place, and a route its own
-- colour and line (solid, dashed, dotted or dash-dot).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/024_map_styles.sql
-- (deploy.sh and install.php run it for you when map_pins.icon is missing.)
-- Fresh installs already get the columns from db/schema.sql.

ALTER TABLE map_pins
  ADD COLUMN icon VARCHAR(16) NULL AFTER note,
  ADD COLUMN color VARCHAR(7) NULL AFTER icon,
  ADD COLUMN is_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER color;

ALTER TABLE map_routes
  ADD COLUMN color VARCHAR(7) NULL AFTER points_json,
  ADD COLUMN dash VARCHAR(8) NULL AFTER color;
