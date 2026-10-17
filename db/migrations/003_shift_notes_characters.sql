-- 003_shift_notes_characters.sql — character names on campaign members, and
-- notes anyone in the campaign can add to a shift.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/003_shift_notes_characters.sql
-- (install.php runs it for you when campaign_members has no character_name.)
-- Fresh installs already get all of this from db/schema.sql.

ALTER TABLE campaign_members
  ADD COLUMN character_name VARCHAR(150) NOT NULL DEFAULT '' AFTER role;

CREATE TABLE IF NOT EXISTS shift_notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  shift TINYINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_shift_notes_day (campaign_id, abs_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
