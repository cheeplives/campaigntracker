-- 025_versions_invites.sql — from the code review: Encyclopedia entries and day notes carry a version, so a save from an
-- older copy is refused instead of overwriting someone else's words (as tomes already do), and a GM's invitation by
-- email waits in campaign_invites until that person has an approved account and signs in.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/025_versions_invites.sql
-- (deploy.sh and install.php run it for you when encyclopedia_entries.version is missing.)
-- Fresh installs already get the columns and the table from db/schema.sql.

ALTER TABLE encyclopedia_entries
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER is_secret;

ALTER TABLE days
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER locations;

CREATE TABLE IF NOT EXISTS campaign_invites (
  campaign_id INT UNSIGNED NOT NULL,
  email VARCHAR(191) NOT NULL,                      -- lower-cased sign-in email
  role ENUM('gm','player') NOT NULL DEFAULT 'player',
  invited_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, email),
  KEY ix_invite_email (email),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
