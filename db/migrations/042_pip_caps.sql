-- 042_pip_caps.sql — a character's own maximum on a dot or box track (a pips field): Twilight: 2000's six Damage
-- boxes, of which one character can take three and another all six. sheet_characters.pip_caps is a JSON object of
-- field key => how many of the template's pips this character has; the ones past it are greyed out and can't be
-- ticked. NULL (or a key left out) is the template's full count.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/042_pip_caps.sql
-- (deploy.sh and install.php run it for you when sheet_characters has no pip_caps column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE sheet_characters ADD COLUMN pip_caps TEXT NULL AFTER hidden;
