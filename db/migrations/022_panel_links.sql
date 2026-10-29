-- 022_panel_links.sql — panel links: the At the Table panel shown inside a virtual tabletop (Owlbear Rodeo, Foundry) or
-- a stream overlay, where Chronicle's sign-in cookie can't reach. A signed-in member makes a link; the page sends its
-- code in a header, and the link sees what its maker sees (scope 'panel'), or, made by a GM, only what every player
-- sees, read-only (scope 'public_panel', user_id NULL). Only the code's SHA-256 is stored. The API keys planned for
-- scripts and the Foundry module will be more scopes in the same table.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/022_panel_links.sql
-- (deploy.sh and install.php run it for you when there is no connection_keys table.)
-- Fresh installs already get the table from db/schema.sql.
CREATE TABLE IF NOT EXISTS connection_keys (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  scope VARCHAR(16) NOT NULL,
  label VARCHAR(80) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  options_json TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  UNIQUE KEY uq_token (token_hash),
  KEY idx_campaign (campaign_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
