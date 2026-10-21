-- 011_encyclopedia.sql — the Encyclopedia tab: the people, places, items, groups and the like that turn up in
-- play, each with Public notes everyone reads and GM notes only GMs see (rich text, cleaned by api/richtext.php),
-- tags of their own, and the words the Proper Noun Detector was told not to offer again.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/011_encyclopedia.sql
-- (install.php runs it for you when there is no encyclopedia_entries table.)
-- Fresh installs already get it from db/schema.sql.

-- One row per entry. is_secret entries (and gm_notes) never reach players.
CREATE TABLE IF NOT EXISTS encyclopedia_entries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
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
