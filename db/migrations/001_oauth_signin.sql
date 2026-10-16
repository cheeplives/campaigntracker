-- 001_oauth_signin.sql — move an existing install from username/password
-- accounts to Google/GitHub sign-in (the Sinless users table).
--
-- Run ONCE on an install created before this change, after backing up:
--   mysql -u <user> -p <database> < db/migrations/001_oauth_signin.sql
-- (install.php runs it for you when it finds the old users table.)
-- Fresh installs already get all of this from db/schema.sql.
--
-- Every existing account becomes an approved 'legacy' account and keeps its
-- campaigns, roles and notes. Passwords are dropped. An admin then enters each
-- player's email under Users; their first Google/GitHub sign-in with that
-- verified email takes over the account.
-- Existing ids stay INT UNSIGNED so the foreign keys that point at them still match.

ALTER TABLE users
  ADD COLUMN provider         VARCHAR(16)  NOT NULL DEFAULT 'legacy' AFTER id,
  ADD COLUMN provider_user_id VARCHAR(191) NULL AFTER provider,
  ADD COLUMN email            VARCHAR(191) NOT NULL DEFAULT '' AFTER provider_user_id,
  MODIFY COLUMN display_name  VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN avatar_url       VARCHAR(512) NOT NULL DEFAULT '' AFTER display_name,
  ADD COLUMN status           ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending' AFTER avatar_url,
  ADD COLUMN approved_at      DATETIME NULL DEFAULT NULL,
  ADD COLUMN last_login_at    DATETIME NULL DEFAULT NULL;

UPDATE users SET provider_user_id = CONCAT('legacy-', id), status = 'approved', approved_at = created_at;

ALTER TABLE users
  MODIFY COLUMN provider         VARCHAR(16)  NOT NULL,
  MODIFY COLUMN provider_user_id VARCHAR(191) NOT NULL,
  DROP COLUMN username,
  DROP COLUMN password_hash,
  ADD UNIQUE KEY uq_provider_identity (provider, provider_user_id),
  ADD KEY idx_status (status);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INT UNSIGNED PRIMARY KEY,
  prefs_json TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        VARCHAR(32)  NOT NULL,
  id            VARCHAR(64)  NOT NULL,
  window_start  INT UNSIGNED NOT NULL,
  hits          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, id),
  KEY idx_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
