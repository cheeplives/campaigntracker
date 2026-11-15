-- 054_campaign_webhooks.sql — a campaign's Discord channels (At the Table → Use in a VTT or on stream → Discord): the
-- webhook address a GM pasted, what the channel hears about (time passing, new events, clocks filling, sessions
-- ending), and how the last send went. A channel that fails 10 times in a row is switched off until it is tested.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/054_campaign_webhooks.sql
-- (deploy.sh and install.php run it for you when there is no campaign_webhooks table.)
-- Fresh installs already get the table from db/schema.sql.
CREATE TABLE IF NOT EXISTS campaign_webhooks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  label VARCHAR(80) NOT NULL,
  url VARCHAR(400) NOT NULL,
  events_json TEXT NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at DATETIME NULL,
  last_error VARCHAR(190) NULL,
  fails INT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
