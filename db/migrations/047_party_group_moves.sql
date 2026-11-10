-- 047_party_group_moves.sql — players can arrange the party on Party → Groups: move their own character to another group
-- and start a group of their own. party_groups.players_can_move is 1 while the players may move in and out of that group;
-- a GM turns it off from the group's ⋯ menu (a scene where the party can't simply walk over to the others).
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/047_party_group_moves.sql
-- (deploy.sh and install.php run it for you when party_groups has no players_can_move column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE party_groups ADD COLUMN players_can_move TINYINT(1) NOT NULL DEFAULT 1 AFTER is_main;
