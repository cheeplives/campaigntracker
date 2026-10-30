-- 023_character_sheets.sql — character sheets: the site-wide template library, characters in each campaign (each with
-- its own Encyclopedia entry) and who has a sheet open. Also each member's active character, whose name is written into
-- campaign_members.character_name whenever it is set or renamed.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/023_character_sheets.sql
-- (deploy.sh and install.php run it for you when campaign_members.active_character_id is missing.)
-- Fresh installs already get all of it from db/schema.sql.

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
  sheet_public TINYINT(1) NOT NULL DEFAULT 1,
  template_version INT UNSIGNED NOT NULL,
  field_values MEDIUMTEXT NOT NULL,
  field_stamps MEDIUMTEXT NOT NULL,
  hidden TEXT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,           -- the settings' (name, kind, owner, hidden) version; values save field by field
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_character_entry (entry_id),
  KEY ix_character_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES sheet_templates(id),
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

-- No foreign key: the code clears it when the character is deleted (schema.sql creates campaign_members before characters).
ALTER TABLE campaign_members ADD COLUMN active_character_id INT UNSIGNED NULL AFTER character_name;
