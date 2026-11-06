-- 033_party_characters.sql — a character with no player of its own (an NPC hireling, a PC the GM runs for an absent
-- friend) can travel with the party: sheet_characters.party_group_id is the party group it is in. And every character's
-- Encyclopedia entry is tagged PC or NPC, as new characters now are.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/033_party_characters.sql
-- (deploy.sh and install.php run it for you when sheet_characters has no party_group_id column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE sheet_characters ADD COLUMN party_group_id INT UNSIGNED NULL AFTER kind,
  ADD CONSTRAINT fk_character_party_group FOREIGN KEY (party_group_id) REFERENCES party_groups(id) ON DELETE SET NULL;

-- The PC and NPC tags, in each campaign that has characters of that kind (a campaign's own tag of that name is kept).
INSERT IGNORE INTO encyclopedia_tag_names (campaign_id, name, color)
  SELECT DISTINCT campaign_id, 'PC', '#2563eb' FROM sheet_characters WHERE kind='pc';
INSERT IGNORE INTO encyclopedia_tag_names (campaign_id, name, color)
  SELECT DISTINCT campaign_id, 'NPC', '#7c3aed' FROM sheet_characters WHERE kind='npc';

-- Each character's entry gets the tag of its kind (names compare without regard to case).
INSERT IGNORE INTO encyclopedia_tags (entry_id, tag_id)
  SELECT c.entry_id, t.id FROM sheet_characters c
  JOIN encyclopedia_tag_names t ON t.campaign_id=c.campaign_id AND t.name=UPPER(c.kind);
