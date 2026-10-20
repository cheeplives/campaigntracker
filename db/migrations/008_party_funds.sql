-- 008_party_funds.sql — the Party Funds ledger on the Party Holdings tab.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/008_party_funds.sql
-- (install.php runs it for you when there is no party_funds table.)
-- Fresh installs already get it from db/schema.sql.

-- Party Funds (top of the Party Holdings tab's left column): one line per kind of money the
-- party holds, e.g. "Gold pieces" 120. Open to GM and players alike.
CREATE TABLE IF NOT EXISTS party_funds (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  currency VARCHAR(60) NOT NULL,
  amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_funds_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
