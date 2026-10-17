-- 004_day_locations.sql — the places the party visited on a day, shown on the
-- day page under the day's region.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/004_day_locations.sql
-- (install.php runs it for you when days has no locations column.)
-- Fresh installs already get it from db/schema.sql.

ALTER TABLE days
  ADD COLUMN locations TEXT NULL AFTER gm_notes;
