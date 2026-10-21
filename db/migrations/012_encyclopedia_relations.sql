-- 012_encyclopedia_relations.sql — connections between Encyclopedia entries. A relationship type has a label for each
-- direction ("Has resident" from London, "Resident of" from Gunther); a relation joins two entries with one type and
-- shows on both their pages. A type that reads the same both ways ("Ally of") is symmetric and has no inverse label.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/012_encyclopedia_relations.sql
-- (install.php runs it for you when there is no encyclopedia_relations table.)
-- Fresh installs already get it from db/schema.sql.

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
