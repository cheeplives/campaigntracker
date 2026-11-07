-- 036_user_profiles.sql — the name and pronouns someone sets on their Account page, which Chronicle calls them by in
-- place of the name from their Google or GitHub account. Kept apart from the users table, which Sinless shares and
-- rewrites on every sign-in, so a sign-in never undoes it and Sinless never sees it.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/036_user_profiles.sql
-- (deploy.sh and install.php run it for you when there is no user_profiles table.)
-- Fresh installs already get it from db/schema.sql.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id   BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(150) NULL DEFAULT NULL,   -- NULL: use users.display_name (from Google or GitHub)
  pronouns  VARCHAR(40)  NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
