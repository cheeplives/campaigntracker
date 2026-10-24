-- 015_sessions.sql — play sessions: the GM's quick notes during a game night (the Session notes box on Current Day)
-- and the summary written from them afterwards (the Sessions tab). Players read a session's summary once it is
-- published; the notes are for GMs only.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/015_sessions.sql
-- (install.php runs it for you when there is no play_sessions table.)
-- Fresh installs already get it from db/schema.sql.

-- One row per game night. number counts the campaign's sessions from 1; a blank title shows as "Session {number}".
-- first_day and last_day are the absolute campaign days it covered; last_day is NULL while the session is open, and a
-- campaign has at most one open session, which the Session notes box on Current Day adds to. summary is rich text
-- (cleaned by api/richtext.php); version goes up on every summary save, so one made from an older copy is refused.
CREATE TABLE IF NOT EXISTS play_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  number INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL DEFAULT '',
  played_on DATE NULL,
  first_day BIGINT NOT NULL,
  last_day BIGINT NULL,
  summary MEDIUMTEXT,
  summary_format VARCHAR(8) NOT NULL DEFAULT 'html',
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_session_campaign (campaign_id, number),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The GM's quick notes during a session, one line each, in order (position). depth 0 to 3 indents a line under the
-- one above. text is plain; a leading ! is a GM aside, ? a loose end and > a time jump (static/sessions.js).
-- abs_shift is the in-game shift the note was taken in (its day is abs_shift / shifts per day). is_covered: ticked
-- once the summary covers it. Only GMs ever get these rows.
CREATE TABLE IF NOT EXISTS session_notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  session_id INT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL,
  depth TINYINT UNSIGNED NOT NULL DEFAULT 0,
  text VARCHAR(1000) NOT NULL,
  abs_shift BIGINT NOT NULL,
  is_covered TINYINT(1) NOT NULL DEFAULT 0,
  client_key VARCHAR(40) NULL,                  -- the browser's name for a note it sends, so a resend after a lost reply saves it once
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_snote_session (session_id, position),
  UNIQUE KEY uq_snote_client (campaign_id, client_key),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES play_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
