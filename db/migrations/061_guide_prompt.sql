-- 061_guide_prompt.sql — room in the Assistant's campaign guide for the campaign prompt.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/061_guide_prompt.sql
-- (deploy.sh and install.php run it for you while campaign_guides.guide_json is still TEXT.)
-- Fresh installs already get it from db/schema.sql.

-- The guide gains a "prompt" part: a longer brief of up to 12,000 characters (the campaign's agenda, principles and
-- what is in motion, as a Powered by the Apocalypse game gives its GM). With the other parts that can pass what TEXT
-- holds (65,535 bytes) when written in a script that takes several bytes a character, so the column becomes MEDIUMTEXT.
-- No row changes: a guide saved before this simply has no prompt yet.
ALTER TABLE campaign_guides MODIFY guide_json MEDIUMTEXT NOT NULL;
