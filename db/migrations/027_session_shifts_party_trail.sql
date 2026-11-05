-- 027_session_shifts_party_trail.sql — a session knows the shift it started and ended on, and the party leaves a trail on
-- the maps.
--
-- play_sessions.first_shift / last_shift: the absolute shift (day × shifts per day + shift) the session started and
-- ended on. NULL on sessions from before this change, which go by first_day and last_day as before (the whole day).
-- party_trail: where a party group was put on a map, and on what shift, a row each time the GM moves it. The map draws
-- the rows as the group's trail.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/027_session_shifts_party_trail.sql
-- (deploy.sh and install.php run it for you when play_sessions has no first_shift column.)
-- Fresh installs already get both from db/schema.sql.
CREATE TABLE IF NOT EXISTS party_trail (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  map_id INT UNSIGNED NOT NULL,
  x DOUBLE NOT NULL,
  y DOUBLE NOT NULL,
  abs_shift BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_trail_map (map_id, group_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES party_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE play_sessions
  ADD COLUMN first_shift BIGINT NULL AFTER last_day,
  ADD COLUMN last_shift BIGINT NULL AFTER first_shift;
