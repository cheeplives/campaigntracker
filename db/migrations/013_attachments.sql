-- 013_attachments.sql — pictures and files attached to things in a campaign: a portrait on a character's Encyclopedia
-- entry, a map on a location's. parent_type says what a file hangs off ('encyclopedia' for an entry; more kinds can
-- join without changing the table) and parent_id which one. The file itself is kept on disk outside the web root under
-- stored_name (random, no extension) and is only ever sent by api/index.php?a=file after the same checks as its parent.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/013_attachments.sql
-- (install.php runs it for you when there is no attachments table.)
-- Fresh installs already get it from db/schema.sql.

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
