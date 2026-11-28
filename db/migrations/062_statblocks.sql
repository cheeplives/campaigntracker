-- 062_statblocks.sql — NPC stat blocks: a second kind of sheet template.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/062_statblocks.sql
-- (deploy.sh and install.php run it for you while sheet_templates has no kind column.)
-- Fresh installs already get it from db/schema.sql.
-- Afterwards, load the stat block starters: Site Admin → Sheets → Load starter templates.

-- kind: 'sheet' (a character sheet, every template until now) or 'statblock' (a short block in a game's own NPC
-- format, drawn on the NPC's Encyclopedia page). dice_game: the game a stat block is for, as an id from the dice
-- roller's "Start from a game" list (static/dice-systems.js PRESETS, e.g. dnd5e), so a campaign on that game gets it
-- picked; NULL for a sheet and for a stat block for any game.
ALTER TABLE sheet_templates
  ADD COLUMN kind ENUM('sheet','statblock') NOT NULL DEFAULT 'sheet' AFTER edition,
  ADD COLUMN dice_game VARCHAR(20) NULL AFTER kind;
