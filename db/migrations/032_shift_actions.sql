-- 032_shift_actions.sql — each player's action on a shift, and the party's, picked At the Table.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/032_shift_actions.sql
-- (deploy.sh and install.php run it for you when there is no shift_actions table.)
-- Fresh installs already get it from db/schema.sql.
-- What each player's character did on a shift (Navigate, Keep watch, Forage...), and what the party as a whole did
-- (user_id 0): one action each per shift. A session's page and its Build draft list them for the shifts it ran over.
CREATE TABLE IF NOT EXISTS shift_actions (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  shift TINYINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- the player whose character did it; 0: the party as a whole
  action VARCHAR(100) NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, abs_day, shift, user_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
