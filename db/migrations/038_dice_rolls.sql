-- 038_dice_rolls.sql — the die roller (the 🎲 button on every campaign page) and its shared roll log.
--
-- dice_rolls: each roll anyone makes: what was typed, the seed the server picked for it, and who may see it.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/038_dice_rolls.sql
-- (deploy.sh and install.php run it for you when there is no dice_rolls table.)
-- Fresh installs already get it from db/schema.sql.
-- A roll: what was typed (expr, its # label included) and the 128-bit seed the server picked with random_int, from which
-- every browser works out the same dice (static/dice.js, engine version `engine`). visibility: all (everyone), gm (the
-- roller and the GMs) or blind (the GMs; the roller sees that they rolled, not what). abs_shift: the campaign clock's
-- shift then. The log keeps the campaign's newest rolls only (Settings → Dice); older ones are deleted as new ones come.
CREATE TABLE IF NOT EXISTS dice_rolls (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  by_gm TINYINT(1) NOT NULL DEFAULT 0,
  expr VARCHAR(200) NOT NULL,
  seed CHAR(32) NOT NULL,
  engine TINYINT UNSIGNED NOT NULL DEFAULT 1,
  visibility VARCHAR(8) NOT NULL DEFAULT 'all',
  abs_shift BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_dice_campaign (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
