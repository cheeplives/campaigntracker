-- Campaign Chronicle schema (MySQL 5.7+ / 8.x or MariaDB 10.3+, InnoDB, utf8mb4).
-- Fresh install: mysql -u <user> -p <database> < db/schema.sql  (or run install.php).
-- Existing install: run the files in db/migrations/ you have not run yet, in order.

-- users: one row per OAuth provider identity, identical to the Sinless app's
-- users table. Point both apps at one database and they share accounts and the
-- approval queue. Keyed on the provider's stable user id, never on email.
-- New sign-ups land as 'pending' until an admin approves them.
-- provider 'legacy' marks an account from before OAuth sign-in (see
-- db/migrations/001_oauth_signin.sql); it is claimed by the first sign-in whose
-- verified email matches the email an admin entered for it.
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider          VARCHAR(16)  NOT NULL,              -- 'google' | 'github' | 'legacy'
  provider_user_id  VARCHAR(191) NOT NULL,              -- stable id at the provider
  email             VARCHAR(191) NOT NULL,
  display_name      VARCHAR(191) NOT NULL DEFAULT '',
  avatar_url        VARCHAR(512) NOT NULL DEFAULT '',
  status            ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
  is_admin          TINYINT(1)   NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME     NULL DEFAULT NULL,
  last_login_at     DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_identity (provider, provider_user_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fixed-window counters for lib.php rate_limit(), also identical to Sinless's.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        VARCHAR(32)  NOT NULL,
  id            VARCHAR(64)  NOT NULL,
  window_start  INT UNSIGNED NOT NULL,
  hits          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, id),
  KEY idx_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  prefs_json TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaigns (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  calendar_json MEDIUMTEXT NOT NULL,
  settings_json TEXT NOT NULL,
  current_shift BIGINT NOT NULL DEFAULT 0,
  seed INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('gm','player') NOT NULL DEFAULT 'player',
  PRIMARY KEY (campaign_id, user_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS regions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  settings_json TEXT NOT NULL,
  description TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS holidays (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  rule_json TEXT NOT NULL,
  description TEXT,
  color VARCHAR(16) NOT NULL DEFAULT '#b8860b',
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per in-game day that has stored weather or notes.
CREATE TABLE IF NOT EXISTS days (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  region_id INT UNSIGNED NULL,
  weather_json TEXT,
  notes TEXT,
  gm_notes TEXT,
  PRIMARY KEY (campaign_id, abs_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Four shifts per day: 0 dawn, 1 midday, 2 dusk, 3 overnight (the night after the day).
-- Campaigns from before that order are moved over on first use (dawn_first() in api/index.php).
CREATE TABLE IF NOT EXISTS shifts (
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  shift TINYINT UNSIGNED NOT NULL,
  activity TEXT,
  gm_notes TEXT,
  visibility_override TINYINT NULL,
  PRIMARY KEY (campaign_id, abs_day, shift),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  end_day BIGINT NULL,
  shift TINYINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_events_day (campaign_id, abs_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
