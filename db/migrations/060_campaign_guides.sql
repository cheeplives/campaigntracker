-- 060_campaign_guides.sql — the Assistant's campaign guide: what a GM wants the assistant to always know about a campaign.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/060_campaign_guides.sql
-- (deploy.sh and install.php run it for you when there is no campaign_guides table.)
-- Fresh installs already get it from db/schema.sql.

-- campaign_guides: one row per campaign, read and written by GMs only (api/assistant.php). It is kept apart from
-- campaigns.settings_json because every member is sent the settings, and a guide holds GM-only truths. guide_json:
--   {"premise": "…", "power": "…", "lines": "…", "style": "…", "canon": "…", "rules": "…", "secrets": "…"}
-- each a few paragraphs of plain text. version: bumped on each save; an older copy's save is refused.
CREATE TABLE IF NOT EXISTS campaign_guides (
  campaign_id INT UNSIGNED NOT NULL PRIMARY KEY,
  guide_json TEXT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
