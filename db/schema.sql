-- Campaign Chronicle schema (MySQL 5.7+ / 8.x or MariaDB 10.3+, InnoDB, utf8mb4).
-- Fresh install: mysql -u <user> -p <database> < db/schema.sql  (or run install.php).
-- Existing install: run the files in db/migrations/ you have not run yet, in order.

-- users: one row per OAuth provider identity, identical to the Sinless app's
-- users table. Point both apps at one database and they share accounts (one sign-in
-- for both); each app keeps its own approvals (Chronicle's are in chronicle_access, and
-- users.status is Sinless's). Keyed on the provider's stable user id, never on email.
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

-- chronicle_access: who may use Campaign Chronicle, apart from users.status, which is Sinless's. A sign-in with no row
-- here asks for access (a 'pending' row); site admins (users.is_admin) are approved on sign-in. Removing someone from
-- Chronicle deletes their row, never the shared users row. See db/migrations/020_chronicle_access.sql.
CREATE TABLE IF NOT EXISTS chronicle_access (
  user_id       BIGINT UNSIGNED NOT NULL,
  status        ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  requested_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
  KEY idx_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

-- user_profiles: the name and pronouns someone sets on their Account page, used in place of users.display_name (their
-- Google or GitHub name, which every sign-in rewrites). Chronicle's own, so Sinless never sees it. Migration 036.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id   BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(150) NULL DEFAULT NULL,   -- NULL: use users.display_name
  pronouns  VARCHAR(40)  NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
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
  active_character_id INT UNSIGNED NULL,             -- their character sheet whose name character_name follows (023)
  PRIMARY KEY (campaign_id, user_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A GM's invitation by email (025): turned into a campaign_members row when that person, approved, next signs in or
-- opens the campaign list, so adding someone by email never tells the GM whether the address has an account.
CREATE TABLE IF NOT EXISTS campaign_invites (
  campaign_id INT UNSIGNED NOT NULL,
  email VARCHAR(191) NOT NULL,                      -- lower-cased sign-in email
  role ENUM('gm','player') NOT NULL DEFAULT 'player',
  token CHAR(32) NULL,                              -- the invite link's code (#/join/<token>), migration 045
  invited_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, email),
  KEY ix_invite_email (email),
  UNIQUE KEY ux_invite_token (token),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
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
  version INT UNSIGNED NOT NULL DEFAULT 1,           -- bumped on each notes save; an older copy's save is refused (025)
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

-- Shift actions (db/migrations/032_shift_actions.sql, 041_shift_action_characters.sql).
-- What each player's character did on a shift (Navigate, Keep watch, Forage...), what each character with no player
-- that travels with the party did (user_id 0, character_id its sheet), and what the party as a whole did (user_id 0,
-- character_id 0): one action each per shift. A session's page and its Build draft list them for the shifts it ran over.
CREATE TABLE IF NOT EXISTS shift_actions (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  shift TINYINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- the player whose character did it; 0: the party, or character_id's
  character_id INT UNSIGNED NOT NULL DEFAULT 0, -- a party character with no player (sheet_characters.id); 0: none
  action VARCHAR(100) NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, abs_day, shift, user_id, character_id),
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
-- activities_json: [{"name": "Tend to Wounds", "members": [user ids], "characters": [sheet_characters ids]}], the
-- characters being ones with no player. group_id: the party group it is for (party_groups.id), NULL for the whole
-- party. gm_notes never reach players.
CREATE TABLE IF NOT EXISTS downtimes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,                        -- short_rest | long_rest | downtime
  group_id INT UNSIGNED NULL,                       -- the party group it is for; NULL: the whole party
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
  category VARCHAR(20) NULL,                        -- location, person, item, group or vehicle; NULL for none
  aliases_json TEXT,                                -- other names for the same thing: ["Hoffmann", "the innkeeper"]
  notes MEDIUMTEXT,
  gm_notes MEDIUMTEXT,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,          -- bumped on each save; an older copy's save is refused (025)
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

-- Words the Feature Highlighter was told to stop offering. The GMs keep one list ('gm') and the players share
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

-- Edit history (see db/migrations/039_content_versions.sql and api/history.php): the earlier versions of an Encyclopedia
-- entry, a Library tome, a session and a day's notes, each the item's text fields as JSON. kind is entry, tome, session
-- or day; ref_id the item's id (the day's absolute day for a day). baseline: what the item held before history began.
CREATE TABLE IF NOT EXISTS content_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  kind VARCHAR(12) NOT NULL,
  ref_id BIGINT NOT NULL,
  data MEDIUMTEXT NOT NULL,
  saved_by BIGINT UNSIGNED NULL,
  saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  baseline TINYINT(1) NOT NULL DEFAULT 0,
  KEY ix_version_item (campaign_id, kind, ref_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (saved_by) REFERENCES users(id) ON DELETE SET NULL
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
  kind VARCHAR(8) NOT NULL DEFAULT 'file',          -- 'image' (shown on the page), 'file' (downloaded) or 'embed' (shown from DeviantArt)
  size_bytes INT UNSIGNED NOT NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  caption VARCHAR(200) NULL,
  -- How the picture sits in a round disc (046): the point kept in the middle (percent across, down) and the zoom
  -- (100-400); NULL: the middle, just filling the circle.
  frame_x TINYINT UNSIGNED NULL,
  frame_y TINYINT UNSIGNED NULL,
  frame_zoom SMALLINT UNSIGNED NULL,
  -- Where a picture found with Find Image came from (see db/migrations/017_attachment_credits.sql); empty for uploads.
  credit_title VARCHAR(200) NULL,
  credit_author VARCHAR(200) NULL,
  credit_author_url VARCHAR(500) NULL,
  credit_license VARCHAR(60) NULL,
  credit_license_url VARCHAR(300) NULL,
  credit_source VARCHAR(60) NULL,
  credit_source_url VARCHAR(500) NULL,
  -- kind 'embed': no file, the picture loads from DeviantArt. embed_src is what its oEmbed last gave, at embed_checked_at.
  embed_url VARCHAR(500) NULL,
  embed_src VARCHAR(1000) NULL,
  embed_checked_at DATETIME NULL,
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

-- Play sessions and their quick notes (see db/migrations/015_sessions.sql).
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
  first_shift BIGINT NULL,                      -- the absolute shift it started on; NULL on sessions from before 027 (whole days)
  last_shift BIGINT NULL,                       -- the absolute shift it ended on; NULL while open, or from before 027
  undated TINYINT(1) NOT NULL DEFAULT 0,        -- 1: no in-game dates (imported from Scabard); covers no shifts (029)
  summary MEDIUMTEXT,
  summary_format VARCHAR(8) NOT NULL DEFAULT 'html',
  rewards MEDIUMTEXT NULL,
  loot MEDIUMTEXT NULL,
  notes_text MEDIUMTEXT NULL,                   -- the GM's notes, one text box (static/sessions.js); NULL: not saved since session_notes
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_session_campaign (campaign_id, number),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The GM's quick notes during a session, from before they were one text box (play_sessions.notes_text): one line each,
-- in order (position). Kept for sessions whose notes_text is NULL; the session's page folds them into its text box. depth 0 to 3 indents a line under the
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

-- Maps, pins, routes, tokens and party groups (see db/migrations/019_maps.sql).
-- tokens comes before party_groups, which points at it.
CREATE TABLE IF NOT EXISTS maps (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  image_id INT UNSIGNED NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  scale_per_px DOUBLE NULL,
  scale_unit VARCHAR(2) NULL,
  grid_px DOUBLE NULL,
  grid_offset_x DOUBLE NULL,
  grid_offset_y DOUBLE NULL,
  grid_type VARCHAR(12) NOT NULL DEFAULT 'square',   -- 'square', 'hex_flat' or 'hex_pointy'
  grid_shown TINYINT(1) NOT NULL DEFAULT 0,         -- the grid is drawn over the map to start with
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_pins (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  x DOUBLE NOT NULL,
  y DOUBLE NOT NULL,
  kind ENUM('note','entry','event') NOT NULL,
  entry_id INT UNSIGNED NULL,
  event_id INT UNSIGNED NULL,
  child_map_id INT UNSIGNED NULL,                -- the map this pin opens (a town pin opens the town's map)
  label VARCHAR(150) NOT NULL DEFAULT '',
  note VARCHAR(1000) NULL,
  icon VARCHAR(16) NULL,                         -- an emoji from MapsTab's PIN_ICONS; null: the kind's own
  color VARCHAR(7) NULL,                         -- #rrggbb from MapsTab's COLOURS; null: no colour
  is_locked TINYINT(1) NOT NULL DEFAULT 0,       -- 1: can't be dragged until unlocked
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pin_entry (campaign_id, entry_id),
  KEY ix_pin_event (campaign_id, event_id),
  KEY ix_pin_child_map (child_map_id),
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (child_map_id) REFERENCES maps(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  points_json TEXT NOT NULL,
  color VARCHAR(7) NULL,                         -- #rrggbb; null: the theme's route colour
  dash VARCHAR(8) NULL,                          -- solid, dashed, dotted or dashdot; null: dashed
  terrain_json VARCHAR(2000) NULL,               -- a travel-time multiplier (1 to 4) for each leg, as a JSON list; null: every leg x1
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  image_id INT UNSIGNED NULL,
  kind ENUM('party','character','creature','object') NOT NULL DEFAULT 'creature',
  size_squares TINYINT UNSIGNED NOT NULL DEFAULT 1,
  member_id BIGINT UNSIGNED NULL,
  entry_id INT UNSIGNED NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token_member (campaign_id, member_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS party_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  members_json TEXT NOT NULL,
  region_id INT UNSIGNED NULL,
  map_id INT UNSIGNED NULL,
  x DOUBLE NULL,
  y DOUBLE NULL,
  token_id INT UNSIGNED NULL,
  is_main TINYINT(1) NOT NULL DEFAULT 0,
  players_can_move TINYINT(1) NOT NULL DEFAULT 1,   -- players may move their characters in and out of it (047)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE SET NULL,
  FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where a party group was put on a map and on what shift (abs_shift), a row each time the GM moves it: the map draws
-- them as the group's trail (db/migrations/027_session_shifts_party_trail.sql).
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

-- A shift a session covers outside its run from first_shift to last_shift: a flashback, or a split party's other half
-- (db/migrations/028_session_extra_shifts.sql).
CREATE TABLE IF NOT EXISTS session_shifts (
  session_id INT UNSIGNED NOT NULL,
  abs_shift BIGINT NOT NULL,
  PRIMARY KEY (session_id, abs_shift),
  FOREIGN KEY (session_id) REFERENCES play_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Clocks (db/migrations/030_clocks.sql).
-- Clocks: a circle cut into segments that fills as something comes closer (a plot, a danger, a long job). Any member makes
-- one; a GM's and a player's are drawn in different colours. visibility: shown (everyone sees how full it is), vague
-- (players see it is there, not how full; its maker and GMs see all) or secret (GMs only; only a GM makes one). The maker
-- and GMs change and fill it. entry_id: the Encyclopedia entry it is about. archived: put away, kept with its history.
CREATE TABLE IF NOT EXISTS clocks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  segments TINYINT UNSIGNED NOT NULL DEFAULT 4,
  filled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  visibility VARCHAR(8) NOT NULL DEFAULT 'shown',
  by_gm TINYINT(1) NOT NULL DEFAULT 1,
  entry_id INT UNSIGNED NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_clock_campaign (campaign_id, archived),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each time a clock is filled or emptied: by how much, where it stood after, and the campaign clock's shift then, so a
-- session can say what moved while it was played.
CREATE TABLE IF NOT EXISTS clock_ticks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  clock_id INT UNSIGNED NOT NULL,
  delta SMALLINT NOT NULL,
  filled_after TINYINT UNSIGNED NOT NULL,
  abs_shift BIGINT NULL,
  user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_tick_clock (clock_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (clock_id) REFERENCES clocks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The die roller (038).
-- A roll: what was typed (expr, its # label included) and the 128-bit seed the server picked with random_int, from which
-- every browser works out the same dice (static/dice.js, engine version `engine`). visibility: all (everyone), gm (the
-- roller and the GMs) or blind (the GMs; the roller sees that they rolled, not what). abs_shift: the campaign clock's
-- shift then. The log keeps the campaign's newest rolls only (Settings → Dice); older ones are deleted as new ones come.
CREATE TABLE IF NOT EXISTS dice_rolls (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  by_gm TINYINT(1) NOT NULL DEFAULT 0,
  expr VARCHAR(200) NOT NULL,
  seed CHAR(32) NOT NULL,
  engine TINYINT UNSIGNED NOT NULL DEFAULT 1,
  visibility VARCHAR(8) NOT NULL DEFAULT 'all',
  abs_shift BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_dice_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Character sheets. sheet_templates are site-wide, not a campaign's: anyone can use or fork one, only its author (or a
-- site admin) changes it; a starter template (starter_key set, from db/starter-templates/) has no author. layout is
-- JSON: sections of typed fields, each with a permanent key (see static/sheetlayout.js).
CREATE TABLE IF NOT EXISTS sheet_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  game VARCHAR(100) NOT NULL,
  edition VARCHAR(60) NOT NULL DEFAULT '',
  author_id BIGINT UNSIGNED NULL,
  forked_from_id INT UNSIGNED NULL,
  layout MEDIUMTEXT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,           -- goes up by one on every save; a save from an older copy is refused
  is_listed TINYINT(1) NOT NULL DEFAULT 1,           -- 0: left out of the library's search, still working for its characters and forks
  starter_key VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_template_starter (starter_key),
  KEY ix_template_game (game),
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (forked_from_id) REFERENCES sheet_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- game_requests: "Request a game" on the Sheet templates page, one row per person per game, counted by game_key on
-- Site Admin's Sheets tab. site_settings: site-wide switches set on Site Admin (game_requests_off). Migration 037.
CREATE TABLE IF NOT EXISTS site_settings (
  name        VARCHAR(60)   NOT NULL,
  value       VARCHAR(2000) NOT NULL DEFAULT '',
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_requests (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  game        VARCHAR(100) NOT NULL,
  game_key    VARCHAR(100) NOT NULL,              -- lower case, spaces squeezed
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_game_request (user_id, game_key),
  KEY ix_game_request_key (game_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- site_reports: problems reported with the Report (!) button in the top bar, read on Site Admin's Reports tab: what
-- they wrote, the page, what the page gathered (context_json), an optional screenshot, and whether it is open, resolved
-- without a fix, or sent to GitHub. Migration 040.
CREATE TABLE IF NOT EXISTS site_reports (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NULL,
  message       TEXT NOT NULL,
  page          VARCHAR(500) NOT NULL DEFAULT '',
  context_json  MEDIUMTEXT NULL,
  shot          MEDIUMBLOB NULL,
  shot_mime     VARCHAR(20) NULL,
  status        ENUM('open','resolved','github') NOT NULL DEFAULT 'open',
  github_url    VARCHAR(300) NULL,
  closed_by     BIGINT UNSIGNED NULL,
  closed_at     DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_site_report_status (status, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A character in a campaign: one filled-in copy of a template, with its own Encyclopedia entry (which holds its name).
-- field_values: JSON keyed by field key; field_stamps: who last changed each field and when, [user id, unix ms];
-- hidden: field and section keys only the owner and GMs see. sheet_public: an NPC's sheet is GM-only until it is 1.
CREATE TABLE IF NOT EXISTS sheet_characters (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NULL,
  template_id INT UNSIGNED NOT NULL,
  entry_id INT UNSIGNED NOT NULL,
  kind ENUM('pc','npc') NOT NULL DEFAULT 'pc',
  party_group_id INT UNSIGNED NULL,                  -- the party group the character travels with, a player's or not (033, 048); null: not travelling
  sheet_public TINYINT(1) NOT NULL DEFAULT 1,
  portrait_id INT UNSIGNED NULL,                    -- its portrait (043): one of its entry's pictures (attachments.id); NULL: the entry's first picture
  template_version INT UNSIGNED NOT NULL,
  field_values MEDIUMTEXT NOT NULL,
  field_stamps MEDIUMTEXT NOT NULL,
  hidden TEXT NOT NULL,
  pip_caps TEXT NULL,                                -- this character's own maximum on its dot/box tracks (042): {field key: pips}; NULL or a key left out: all of them
  version INT UNSIGNED NOT NULL DEFAULT 1,           -- the settings' (name, kind, owner, hidden) version; values save field by field
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_character_entry (entry_id),
  KEY ix_character_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES sheet_templates(id),
  CONSTRAINT fk_character_party_group FOREIGN KEY (party_group_id) REFERENCES party_groups(id) ON DELETE SET NULL,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE CASCADE   -- only with its campaign: entry_delete refuses an entry with a sheet
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who has a sheet open: one row per person per sheet, refreshed every 15 seconds while it is open; rows older than
-- 40 seconds are ignored and cleared as they're found. editing: a GM pressed Edit on a sheet that isn't theirs.
CREATE TABLE IF NOT EXISTS sheet_presence (
  character_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  seen_at DATETIME NOT NULL,
  editing TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, user_id),
  FOREIGN KEY (character_id) REFERENCES sheet_characters(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Panel links (022): a code that lets the At the Table panel, shown inside a VTT or a stream, act as the member who
-- made it (scope panel) or as any player, read-only (public_panel, no user). Only the code's SHA-256 is kept.
CREATE TABLE IF NOT EXISTS connection_keys (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  scope VARCHAR(16) NOT NULL,
  label VARCHAR(80) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  options_json TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  UNIQUE KEY uq_token (token_hash),
  KEY idx_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
