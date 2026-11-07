-- 037_game_requests.sql — "Request a game" on the Sheet templates page, and a place for site-wide switches.
-- game_requests: one row per person per game they asked for a starter sheet for, grouped on Site Admin's Sheets tab by
-- game_key (the name in lower case with its spaces squeezed, so "Blades in the Dark" and "blades  in the dark" count
-- together). site_settings: switches a site admin flips on Site Admin, one row each (game_requests_off: '1' turns
-- the request button off for everyone).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/037_game_requests.sql
-- (deploy.sh and install.php run it for you when there is no game_requests table.)
-- Fresh installs already get it from db/schema.sql.
CREATE TABLE IF NOT EXISTS site_settings (
  name        VARCHAR(60)   NOT NULL,
  value       VARCHAR(2000) NOT NULL DEFAULT '',
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_requests (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  game        VARCHAR(100) NOT NULL,              -- as they typed it
  game_key    VARCHAR(100) NOT NULL,              -- lower case, spaces squeezed: what requests are grouped and counted by
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_game_request (user_id, game_key),
  KEY ix_game_request_key (game_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
