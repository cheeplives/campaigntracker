-- Campaign Chronicle schema (MySQL 5.7+ / 8.x or MariaDB 10.3+, InnoDB, utf8mb4).
-- Fresh install: mysql -u <user> -p <database> < db/schema.sql  (or run install.php).
-- Existing install: run the files in db/migrations/ you have not run yet, in order.

-- users: one row per OAuth provider identity, identical to the Sinless app's
-- users table. Point both apps at one database and they share accounts and the
-- approval queue. Keyed on the provider's stable user id, never on email.
-- New sign-ups land as 'pending' until an admin approves them.
-- provider 'legacy' marks an account from before OAuth sign-in (see
-- db/migrations/001_oauth_signin.sql); it is claimed by the first sign-in whose
-- verified email matches the email an admin entered for it.
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider          VARCHAR(16)  NOT NULL,              -- 'google' | 'github' | 'legacy'
  provider_user_id  VARCHAR(191) NOT NULL,              -- stable id at the provider
  email             VARCHAR(191) NOT NULL,
  display_name      VARCHAR(191) NOT NULL DEFAULT '',
  avatar_url        VARCHAR(512) NOT NULL DEFAULT '',
  status            ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  is_admin          TINYINT(1)   NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME     NULL DEFAULT NULL,
  last_login_at     DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_identity (provider, provider_user_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fixed-window counters for lib.php rate_limit(), also identical to Sinless's.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        VARCHAR(32)  NOT NULL,
  id            VARCHAR(64)  NOT NULL,
  window_start  INT UNSIGNED NOT NULL,
  hits          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, id),
  KEY idx_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  prefs_json TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaigns (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  calendar_json MEDIUMTEXT NOT NULL,
  settings_json TEXT NOT NULL,
  current_shift BIGINT NOT NULL DEFAULT 0,
  seed INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('gm','player') NOT NULL DEFAULT 'player',
  character_name VARCHAR(150) NOT NULL DEFAULT '',   -- shown instead of the player's name on their events and notes
  PRIMARY KEY (campaign_id, user_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS regions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  settings_json TEXT NOT NULL,
  description TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS holidays (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  rule_json TEXT NOT NULL,
  description TEXT,
  color VARCHAR(16) NOT NULL DEFAULT '#b8860b',
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per in-game day that has stored weather or notes.
CREATE TABLE IF NOT EXISTS days (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  region_id INT UNSIGNED NULL,
  weather_json TEXT,
  notes MEDIUMTEXT,
  notes_format VARCHAR(8) NOT NULL DEFAULT 'plain',   -- 'plain' text, or 'html': rich text cleaned by api/richtext.php
  gm_notes MEDIUMTEXT,
  gm_notes_format VARCHAR(8) NOT NULL DEFAULT 'plain',
  locations TEXT,
  PRIMARY KEY (campaign_id, abs_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Four shifts per day: 0 dawn, 1 midday, 2 dusk, 3 overnight (the night after the day).
-- Campaigns from before that order are moved over on first use (dawn_first() in api/index.php).
CREATE TABLE IF NOT EXISTS shifts (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  shift TINYINT UNSIGNED NOT NULL,
  activity TEXT,
  gm_notes TEXT,
  visibility_override TINYINT NULL,
  PRIMARY KEY (campaign_id, abs_day, shift),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Free notes on a shift, separate from its events. Any member can add them.
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

CREATE TABLE IF NOT EXISTS events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  end_day BIGINT NULL,
  shift TINYINT UNSIGNED NULL,                      -- first shift; NULL = all day
  shift_end TINYINT UNSIGNED NULL,                  -- last shift (on end_day if set); NULL = same as shift
  title VARCHAR(200) NOT NULL,
  body TEXT,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_events_day (campaign_id, abs_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Event tags ("Battle", "Festival"...), per campaign, each with a colour.
-- The starter tags in api/index.php are offered to every campaign and get a row
-- here the first time an event uses them.
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

CREATE TABLE IF NOT EXISTS event_notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- Party Holdings tab. party_gear is the Gear and Loot list: one row per item, all free text
-- but the count. holdings are the cards beside it: vehicles, animals, buildings, assets or a
-- type the party names (kind 'custom', named by type_name). stats_json holds the fields of
-- its kind, e.g. {"top_speed": "60 mph", "fuel_type": "Diesel"}; see HOLDING_KINDS in api/index.php.
-- Every member of the campaign, GM or player, can add, change and remove both.
CREATE TABLE IF NOT EXISTS party_gear (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  item VARCHAR(200) NOT NULL DEFAULT '',
  claimed_by VARCHAR(200) NOT NULL DEFAULT '',
  location VARCHAR(200) NOT NULL DEFAULT '',
  amount INT NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_gear_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS holdings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  kind VARCHAR(16) NOT NULL,                        -- vehicle | animal | building | asset | custom
  type_name VARCHAR(60) NOT NULL DEFAULT '',        -- the type a custom holding is, e.g. "Ship"
  location VARCHAR(200) NOT NULL DEFAULT '',
  description TEXT,
  amount INT NOT NULL DEFAULT 1,
  stats_json TEXT,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_holdings_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Holdings have their own tags, kept apart from the events' list in tags.
CREATE TABLE IF NOT EXISTS holding_tag_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(40) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
  UNIQUE KEY uq_holding_tag_name (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which tags each holding carries.
CREATE TABLE IF NOT EXISTS holding_tags (
  holding_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (holding_id, tag_id),
  FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES holding_tag_names(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What is kept in each holding (the Storage box on its card): one line per item and its weight.
-- Weights are plain numbers, added up and compared with the number in the holding's Cargo field.
CREATE TABLE IF NOT EXISTS holding_storage (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  holding_id INT UNSIGNED NOT NULL,
  item VARCHAR(200) NOT NULL,
  weight DECIMAL(14,2) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_storage_holding (holding_id, id),
  FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- Party Funds (top of the Party Holdings tab's left column): one line per kind of money the
-- party holds and where it is kept, e.g. "Gold pieces" in "Bank of Altdorf", 120. Open to GM and players alike.
CREATE TABLE IF NOT EXISTS party_funds (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  currency VARCHAR(60) NOT NULL,
  location VARCHAR(200) NOT NULL DEFAULT '',
  amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_funds_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The Encyclopedia tab: people, places, items and the like that turn up in play, with Public notes everyone reads and
-- GM notes only GMs see (rich text, cleaned by api/richtext.php). is_secret entries never reach players.
CREATE TABLE IF NOT EXISTS encyclopedia_entries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  aliases_json TEXT,                                -- other names for the same thing: ["Hoffmann", "the innkeeper"]
  notes MEDIUMTEXT,
  gm_notes MEDIUMTEXT,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_entry_name (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Encyclopedia entries have their own tags (Location, Person, Item...), apart from the events' and holdings'.
CREATE TABLE IF NOT EXISTS encyclopedia_tag_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(40) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
  UNIQUE KEY uq_entry_tag_name (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS encyclopedia_tags (
  entry_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (entry_id, tag_id),
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES encyclopedia_tag_names(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Words the Proper Noun Detector was told to stop offering. The GMs keep one list ('gm') and the players share
-- another ('player'), so a word a GM turned down from secret notes is never shown to players.
CREATE TABLE IF NOT EXISTS encyclopedia_ignored (
  campaign_id INT UNSIGNED NOT NULL,
  scope VARCHAR(8) NOT NULL,
  term VARCHAR(150) NOT NULL,
  PRIMARY KEY (campaign_id, scope, term),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Connections between Encyclopedia entries (see db/migrations/012_encyclopedia_relations.sql).
-- The campaign's relationships. label reads from the "from" entry, inverse_label from the "to" entry ('' when symmetric).
CREATE TABLE IF NOT EXISTS encyclopedia_relation_types (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  label VARCHAR(40) NOT NULL,
  inverse_label VARCHAR(40) NOT NULL DEFAULT '',
  symmetric TINYINT(1) NOT NULL DEFAULT 0,
  color VARCHAR(16) NOT NULL DEFAULT '#6b7280',
  UNIQUE KEY uq_relation_type (campaign_id, label, inverse_label),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per connection, from_id being the entry it was made on. A symmetric type keeps a pair once, in either order
-- (the API checks both). is_secret: GMs only; a
-- connection that touches a secret entry is never sent to players either.
CREATE TABLE IF NOT EXISTS encyclopedia_relations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  from_id INT UNSIGNED NOT NULL,
  to_id INT UNSIGNED NOT NULL,
  type_id INT UNSIGNED NOT NULL,
  note VARCHAR(200) NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_relation (from_id, to_id, type_id),
  KEY ix_relation_to (to_id),
  KEY ix_relation_campaign (campaign_id, type_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (from_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (type_id) REFERENCES encyclopedia_relation_types(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pictures and files attached to Encyclopedia entries and the like (see db/migrations/013_attachments.sql).
-- One row per file. is_secret: GMs only; a file on a secret entry is never sent to players either.
CREATE TABLE IF NOT EXISTS attachments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  parent_type VARCHAR(16) NOT NULL,
  parent_id INT UNSIGNED NOT NULL,
  stored_name CHAR(32) NOT NULL,                    -- the file's name on disk: 32 random hex characters
  original_name VARCHAR(200) NOT NULL,              -- as uploaded, for the download
  mime VARCHAR(100) NOT NULL,                       -- worked out from the file's contents, never taken from the browser
  kind VARCHAR(8) NOT NULL DEFAULT 'file',          -- 'image' (shown on the page) or 'file' (downloaded)
  size_bytes INT UNSIGNED NOT NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  caption VARCHAR(200) NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attachment_stored (stored_name),
  KEY ix_attachment_parent (campaign_id, parent_type, parent_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The Library: the campaign's books, journals and notes (see db/migrations/014_library.sql).
-- kind: 'book', 'journal' or 'note'. version goes up by one on every save, so a save made from an older copy
-- (someone else saved in between) is refused instead of overwriting their words.
CREATE TABLE IF NOT EXISTS library_tomes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'book',
  title VARCHAR(200) NOT NULL,
  description VARCHAR(1000) NULL,
  body MEDIUMTEXT,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_tome_campaign (campaign_id, title),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
