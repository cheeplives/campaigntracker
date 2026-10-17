-- 005_downtime.sql — rests and downtime, the cards on the Downtime tab.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/005_downtime.sql
-- (install.php runs it for you when there is no downtimes table.)
-- Fresh installs already get it from db/schema.sql.

-- Rests and downtime (the Downtime tab), one card each. Times are absolute shifts
-- (abs_day * shifts per day + shift), first and last inclusive; a short rest that
-- costs no shift has start_shift = end_shift = the shift it was taken in and slots = 0.
-- activities_json: [{"name": "Tend to Wounds", "members": [user ids]}]. gm_notes never reach players.
CREATE TABLE IF NOT EXISTS downtimes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,                        -- short_rest | long_rest | downtime
  title VARCHAR(200) NOT NULL DEFAULT '',
  start_shift BIGINT NOT NULL,
  end_shift BIGINT NOT NULL,
  slots INT NOT NULL DEFAULT 0,                     -- shifts the rest uses up; 0 for a short rest that costs none
  activities_json TEXT,
  notes TEXT,
  gm_notes TEXT,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_downtimes_campaign (campaign_id, start_shift),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
