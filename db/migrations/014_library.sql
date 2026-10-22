-- 014_library.sql — the Library tab: the campaign's books, journals and notes ("tomes"). Each has a title, a short
-- description and a body written in the same word-processor editor as the day notes (rich text, cleaned by
-- api/richtext.php). Every member, GM or player, can add a tome and change any of them.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/014_library.sql
-- (install.php runs it for you when there is no library_tomes table.)
-- Fresh installs already get it from db/schema.sql.

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
