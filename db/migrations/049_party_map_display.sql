-- 049_party_map_display.sql — how each party group shows on the maps, and which characters show there.
-- party_groups.map_display: 'marker' (one flag or the group's token, as before), 'tokens' (the group's marker with each of
-- its characters' tokens in a ring around it) or 'hidden' (players don't see the group on any map; the GM still does).
-- sheet_characters.on_map: 0 leaves that character's token out of its group's ring (the eye on Party → Groups).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/049_party_map_display.sql
-- (deploy.sh and install.php run it for you when party_groups has no map_display column.)
-- Fresh installs already get the columns from db/schema.sql.
ALTER TABLE party_groups ADD COLUMN map_display ENUM('marker','tokens','hidden') NOT NULL DEFAULT 'marker' AFTER players_can_move;
ALTER TABLE sheet_characters ADD COLUMN on_map TINYINT(1) NOT NULL DEFAULT 1 AFTER party_group_id;
