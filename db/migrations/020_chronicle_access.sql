-- 020_chronicle_access.sql — Campaign Chronicle keeps its own approval list, apart from Sinless's. The two apps still
-- share the users table (one Google or GitHub sign-in for both), but approving, revoking or removing someone in one app
-- no longer lets them into, or shuts them out of, the other. Someone who signs in to Chronicle without a row here asks
-- for access: they get a 'pending' row, the signup alert names Campaign Chronicle, and they wait under Users.
--
-- Everyone in the users table today keeps the access they have: an approved account stays approved here, a waiting one
-- waits, a revoked one stays revoked.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/020_chronicle_access.sql
-- (install.php runs it for you when the chronicle_access table is missing.)
-- Fresh installs already get the table from db/schema.sql.
CREATE TABLE IF NOT EXISTS chronicle_access (
  user_id       BIGINT UNSIGNED NOT NULL,
  status        ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  requested_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
  KEY idx_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO chronicle_access (user_id, status, requested_at, approved_at)
  SELECT id, status, created_at, approved_at FROM users;
