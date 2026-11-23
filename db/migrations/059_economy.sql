-- 059_economy.sql — the Economy tab: ways to pay, the price book and its shifts, the ledger, regular costs, wealth
-- and favours.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/059_economy.sql
-- (deploy.sh and install.php run it for you when there is no economy_wealth table.)
-- Fresh installs already get it from db/schema.sql.

-- economy_config: the ways a campaign pays for things, one row per campaign. config_json:
--   {"coins": {"on": true, "base": {"name": "Silver mark", "abbr": "sm"}, "units": [{"name": "Gold crown", "abbr": "crown", "worth": 20}]},
--    "barter": {"on": true, "unit": "Day's food", "goods": [{"name": "Lamp oil, flask", "worth": 2}]},
--    "wealth": {"on": true, "levels": ["Destitute", "Poor", "Modest"]}, "favours": {"on": true}}
-- A unit's worth is in base coins; a trade good's is in the barter unit; a wealth level is its place in the list.
CREATE TABLE IF NOT EXISTS economy_config (
  campaign_id INT UNSIGNED NOT NULL PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The price book: what a thing costs each way (NULL: can't be had that way). coin_cost is in base coins, barter_cost
-- in the barter unit, wealth_level a place in the levels, favour_size 1 small, 2 significant, 3 major.
-- availability: common | scarce | rare | none. is_everyday: one of the few prices Setup asks for first.
CREATE TABLE IF NOT EXISTS economy_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT '',
  coin_cost DECIMAL(18,4) NULL,
  barter_cost DECIMAL(18,4) NULL,
  wealth_level TINYINT UNSIGNED NULL,
  favour_size TINYINT UNSIGNED NULL,
  availability VARCHAR(8) NOT NULL DEFAULT 'common',
  notes VARCHAR(500) NOT NULL DEFAULT '',
  is_everyday TINYINT(1) NOT NULL DEFAULT 0,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_econ_items (campaign_id, name),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A shift: prices or availability changed for a while. region_id NULL: everywhere. item_id: one item; else category
-- ('' : everything). multiplier applies to coin and barter costs; availability, when set, replaces the item's own.
-- until_day: the last day it applies (NULL: until removed).
CREATE TABLE IF NOT EXISTS economy_shifts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  region_id INT UNSIGNED NULL,
  item_id INT UNSIGNED NULL,
  category VARCHAR(60) NOT NULL DEFAULT '',
  multiplier DECIMAL(8,3) NOT NULL DEFAULT 1,
  availability VARCHAR(8) NULL,
  reason VARCHAR(200) NOT NULL DEFAULT '',
  until_day BIGINT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_econ_shifts (campaign_id, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES economy_items(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Favours: the party's side (character_id, NULL: the whole party) and the other side (other_name, and the
-- Encyclopedia entry of that name when there is one). owed_to_party 1: the other side owes the party's; 0: the
-- party's side owes. size 1 small, 2 significant, 3 major. status: open | called | repaid | forgiven.
CREATE TABLE IF NOT EXISTS economy_favours (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  character_id INT UNSIGNED NULL,
  other_name VARCHAR(200) NOT NULL,
  entry_id INT UNSIGNED NULL,
  owed_to_party TINYINT(1) NOT NULL DEFAULT 0,
  size TINYINT UNSIGNED NOT NULL DEFAULT 1,
  description VARCHAR(500) NOT NULL DEFAULT '',
  since_day BIGINT NOT NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'open',
  settled_day BIGINT NULL,
  settled_note VARCHAR(500) NOT NULL DEFAULT '',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_econ_favours (campaign_id, status, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES sheet_characters(id) ON DELETE SET NULL,
  FOREIGN KEY (entry_id) REFERENCES encyclopedia_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The ledger: one line per change, on the in-game day it happened. kind: coins | goods | wealth | favour | note.
-- amount is signed (coins: in the currency named by unit; goods: how many of the good named by unit; wealth: levels
-- up or down, with level_after). place: where it was kept, in words. source: hand | upkeep | reward | favour | funds
-- (an amount changed on Party Funds). fund_id / gear_id: the Party Funds line or Gear and Loot row it changed.
-- character_id: whose it is (NULL: the party's). Deleting a line never undoes the change it recorded.
CREATE TABLE IF NOT EXISTS economy_ledger (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  abs_day BIGINT NOT NULL,
  kind VARCHAR(8) NOT NULL,
  amount DECIMAL(18,4) NULL,
  unit VARCHAR(200) NOT NULL DEFAULT '',
  level_after TINYINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  place VARCHAR(200) NOT NULL DEFAULT '',
  source VARCHAR(8) NOT NULL DEFAULT 'hand',
  fund_id INT UNSIGNED NULL,
  gear_id INT UNSIGNED NULL,
  favour_id INT UNSIGNED NULL,
  character_id INT UNSIGNED NULL,
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_econ_ledger (campaign_id, abs_day, id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (fund_id) REFERENCES party_funds(id) ON DELETE SET NULL,
  FOREIGN KEY (gear_id) REFERENCES party_gear(id) ON DELETE SET NULL,
  FOREIGN KEY (favour_id) REFERENCES economy_favours(id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES sheet_characters(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Regular costs (upkeep, wages, rations): amount is taken from the Party Funds line fund_id, or from the trade good
-- named by good, every every_days days. next_day: the next day it is due; set_time posts each one the clock has
-- reached to the ledger and moves next_day on.
CREATE TABLE IF NOT EXISTS economy_costs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  amount DECIMAL(18,4) NOT NULL,
  fund_id INT UNSIGNED NULL,
  good VARCHAR(200) NOT NULL DEFAULT '',
  every_days INT UNSIGNED NOT NULL DEFAULT 30,
  next_day BIGINT NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_econ_costs (campaign_id, next_day),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (fund_id) REFERENCES party_funds(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A character's wealth level (character_id 0: the party's own), a place in the campaign's wealth levels.
CREATE TABLE IF NOT EXISTS economy_wealth (
  campaign_id INT UNSIGNED NOT NULL,
  character_id INT UNSIGNED NOT NULL,
  level TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, character_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
