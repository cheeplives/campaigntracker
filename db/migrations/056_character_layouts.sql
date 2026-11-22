-- 056_character_layouts.sql — a character sheet keeps its own copy of its template's layout.
-- Until now every sheet read its template's layout as it was at that moment, so a template's author could change
-- what every sheet using it showed (and which of its hidden fields stayed hidden) in campaigns they had no part in.
-- sheet_characters.layout is the sheet's own copy, taken when it is made; a later change to the template reaches it
-- when its player or a GM chooses "Update to the new template" (or at once on the sheets the template's author plays
-- or runs). template_version is the template version the copy came from. NULL reads as the template's layout.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/056_character_layouts.sql
-- (deploy.sh and install.php run it for you when sheet_characters has no layout column.)
-- Fresh installs already get the column from db/schema.sql.
ALTER TABLE sheet_characters ADD COLUMN layout MEDIUMTEXT NULL AFTER template_version;
UPDATE sheet_characters c JOIN sheet_templates t ON t.id=c.template_id SET c.layout=t.layout, c.template_version=t.version WHERE c.layout IS NULL;
