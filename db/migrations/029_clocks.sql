-- 029_clocks.sql — the Clocks tab, and the Clocks box on At the Table.
--
-- clocks: a GM's or a player's clock (segments, how many are filled, who sees it, the entry it is about).
-- clock_ticks: each fill or empty of a clock, with the campaign clock's shift at the time.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/029_clocks.sql
-- (deploy.sh and install.php run it for you when there is no clocks table.)
-- Fresh installs already get it from db/schema.sql.
-- Clocks: a circle cut into segments that fills as something comes closer (a plot, a danger, a long job). Any member makes
-- one; a GM's and a player's are drawn in different colours. visibility: shown (everyone sees how full it is), vague
-- (players see it is there, not how full; its maker and GMs see all) or secret (GMs only; only a GM makes one). The maker
-- and GMs change and fill it. entry_id: the Encyclopedia entry it is about. archived: put away, kept with its history.
CREATE TABLE IF NOT EXISTS clocks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  segments TINYINT UNSIGNED NOT NULL DEFAULT 4,
  filled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  visibility VARCHAR(8) NOT NULL DEFAULT 'shown',
  by_gm TINYINT(1) NOT NULL DEFAULT 1,
  entry_id INT UNSIGNED NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_clock_campaign (campaign_id, archived),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each time a clock is filled or emptied: by how much, where it stood after, and the campaign clock's shift then, so a
-- session can say what moved while it was played.
CREATE TABLE IF NOT EXISTS clock_ticks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  clock_id INT UNSIGNED NOT NULL,
  delta SMALLINT NOT NULL,
  filled_after TINYINT UNSIGNED NOT NULL,
  abs_shift BIGINT NULL,
  user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_tick_clock (clock_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (clock_id) REFERENCES clocks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
