-- 039_content_versions.sql — edit history: every save of an Encyclopedia entry, a Library tome, a session's summary or
-- notes, or a day's notes keeps the text it was saved as, with who saved it and when, so a GM can read an earlier
-- version, see what changed and restore it (api/history.php). The newest 50 per item are kept.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/039_content_versions.sql
-- (deploy.sh and install.php run it for you when there is no content_versions table.)
-- Fresh installs already get the table from db/schema.sql.
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
