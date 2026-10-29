-- 021_map_grid.sql — Maps phase 2: a map's grid can be squares or hexes, and the GM can have it drawn over the map for
-- everyone to start with (each person can still show or hide it for themselves).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/021_map_grid.sql
-- (deploy.sh and install.php run it for you when maps.grid_type is missing.)
-- Fresh installs already get the columns from db/schema.sql.

ALTER TABLE maps
  ADD COLUMN grid_type VARCHAR(12) NOT NULL DEFAULT 'square' AFTER grid_offset_y,
  ADD COLUMN grid_shown TINYINT(1) NOT NULL DEFAULT 0 AFTER grid_type;
