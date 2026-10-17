-- 002_event_shifts_tags.sql — events get a shift range (Shift Start to Shift End)
-- and colour-coded tags.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/002_event_shifts_tags.sql
-- (install.php runs it for you when the events table has no shift_end column.)
-- Fresh installs already get all of this from db/schema.sql.
--
-- Existing events keep working unchanged: an empty shift_end means the event
-- ends in the shift it starts in, and all-day events stay all day.

ALTER TABLE events ADD COLUMN shift_end TINYINT UNSIGNED NULL AFTER shift;

CREATE TABLE IF NOT EXISTS tags (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(40) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
  UNIQUE KEY uq_tag_name (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_tags (
  event_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (event_id, tag_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
