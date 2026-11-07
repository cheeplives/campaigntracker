-- 040_site_reports.sql — the Report (!) button in the top bar, and Site Admin's Reports tab.
-- site_reports: one row per problem someone reported. message is what they wrote; page the address they were on;
-- context_json what the page gathered on its own (build, browser, screen, the campaign open, recent errors and failed
-- requests); shot the screenshot of the page, when they kept it (a JPEG or PNG, at most about 1.5 MB). status: open,
-- resolved (closed without a fix: "Resolve unfixed"), or github (sent to GitHub as an issue, github_url its address).
-- A report outlives the account that sent it (user_id goes NULL), so a removed player's report can still be read.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/040_site_reports.sql
-- (deploy.sh and install.php run it for you when there is no site_reports table.)
-- Fresh installs already get it from db/schema.sql.
CREATE TABLE IF NOT EXISTS site_reports (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NULL,
  message       TEXT NOT NULL,
  page          VARCHAR(500) NOT NULL DEFAULT '',
  context_json  MEDIUMTEXT NULL,
  shot          MEDIUMBLOB NULL,
  shot_mime     VARCHAR(20) NULL,
  status        ENUM('open','resolved','github') NOT NULL DEFAULT 'open',
  github_url    VARCHAR(300) NULL,
  closed_by     BIGINT UNSIGNED NULL,
  closed_at     DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_site_report_status (status, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
