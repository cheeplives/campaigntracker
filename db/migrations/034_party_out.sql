-- 034_party_out.sql — a GM can take a player's character out of the party (it died, left, or sits this arc out) and
-- put it back, with Travels with the party on its sheet: sheet_characters.party_out is 1 while it is out. While a
-- player's active character is out, that player is in none of the party's groups.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/034_party_out.sql
-- (deploy.sh and install.php run it for you when sheet_characters has no party_out column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE sheet_characters ADD COLUMN party_out TINYINT(1) NOT NULL DEFAULT 0 AFTER party_group_id;
