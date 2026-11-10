-- 048_party_by_character.sql — the party is made of characters, not players. Every character, a player's as well as one
-- with no player, travels with the party group in sheet_characters.party_group_id, or with none (null: not travelling).
-- So a player with two characters can have them in different groups. Before this a player's active character went
-- where its player was in party_groups.members_json, and party_out took them out of the party.
--
-- This copies each player's place onto their active character: the group the player is in, or the main group for one
-- in no group yet, unless the GM took it out (party_out). A player's other characters start out of the party. Then
-- party_out goes, since party_group_id now says it. members_json keeps only the players with no character sheet
-- (the app tidies that the first time it reads the groups).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/048_party_by_character.sql
-- (deploy.sh and install.php run it for you while sheet_characters still has its party_out column.)
-- Fresh installs already get the table without party_out from db/schema.sql.
UPDATE sheet_characters c
  JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id AND m.role='player' AND m.active_character_id=c.id
  JOIN party_groups g ON g.campaign_id=c.campaign_id AND JSON_CONTAINS(g.members_json, CAST(c.owner_id AS JSON))
  SET c.party_group_id=g.id
  WHERE c.party_out=0 AND c.party_group_id IS NULL;

UPDATE sheet_characters c
  JOIN campaign_members m ON m.campaign_id=c.campaign_id AND m.user_id=c.owner_id AND m.role='player' AND m.active_character_id=c.id
  JOIN party_groups g ON g.campaign_id=c.campaign_id AND g.is_main=1
  SET c.party_group_id=g.id
  WHERE c.party_out=0 AND c.party_group_id IS NULL;

ALTER TABLE sheet_characters DROP COLUMN party_out;
