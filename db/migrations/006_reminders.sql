-- 006_reminders.sql — calendar reminders that pop up when the campaign clock reaches them.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/006_reminders.sql
-- (install.php runs it for you when there is no reminders table.)
-- Fresh installs already get it from db/schema.sql.

-- Reminders on the calendar. due_shift is an absolute shift (abs_day * shifts per day + shift);
-- the reminder pops up for everyone it is meant for once the campaign clock reaches it.
-- audience: me (only whoever made it), gm (the campaign's GMs), all (everyone in the campaign).
CREATE TABLE IF NOT EXISTS reminders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  due_shift BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  audience VARCHAR(8) NOT NULL DEFAULT 'me',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_reminders_campaign (campaign_id, due_shift),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who has dismissed a reminder that popped up, so it doesn't pop up for them again.
CREATE TABLE IF NOT EXISTS reminder_dismissals (
  reminder_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (reminder_id, user_id),
  FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
