-- 041_shift_action_characters.sql — a shift action for each character with no player who travels with the party.
-- shift_actions.character_id: the character (sheet_characters.id) whose action it is, for one no player of the
-- campaign plays (an NPC, or a PC the GM runs) that has Travels with the party ticked. 0 for the party's action
-- (user_id 0) and for a player's (user_id theirs), as before.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/041_shift_action_characters.sql
-- (deploy.sh and install.php run it for you when shift_actions has no character_id column.)
-- Fresh installs already get it from db/schema.sql.
ALTER TABLE shift_actions
  ADD COLUMN character_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER user_id,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (campaign_id, abs_day, shift, user_id, character_id);
