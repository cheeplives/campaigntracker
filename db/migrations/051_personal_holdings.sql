-- 051_personal_holdings.sql — a character's own holdings: the Holdings page of a character sheet, which looks and works
-- like Party → Holdings and keeps its funds, gear and holding cards in the same tables. character_id names the
-- character (sheet_characters.id) a row belongs to; NULL is the party's, as every row was before. A holding's storage
-- and tags hang off the holding, so they need nothing here. Deleting a character deletes its rows (character_delete).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/051_personal_holdings.sql
-- (deploy.sh and install.php run it for you when party_gear has no character_id column.)
-- Fresh installs already get the columns from db/schema.sql.
ALTER TABLE party_gear ADD COLUMN character_id INT UNSIGNED NULL AFTER campaign_id, ADD INDEX idx_gear_character (character_id);
ALTER TABLE holdings ADD COLUMN character_id INT UNSIGNED NULL AFTER campaign_id, ADD INDEX idx_holdings_character (character_id);
ALTER TABLE party_funds ADD COLUMN character_id INT UNSIGNED NULL AFTER campaign_id, ADD INDEX idx_funds_character (character_id);
