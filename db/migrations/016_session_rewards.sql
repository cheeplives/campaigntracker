-- 016_session_rewards.sql — a session's Session Rewards and Loot Found, written up under its summary on the Sessions tab.
-- Rich text like the summary (cleaned by api/richtext.php, GM-only paragraphs kept from players), published with it.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/016_session_rewards.sql
-- (install.php runs it for you when play_sessions has no rewards column.)
-- Fresh installs already get it from db/schema.sql.
ALTER TABLE play_sessions
  ADD COLUMN rewards MEDIUMTEXT NULL AFTER summary_format,
  ADD COLUMN loot MEDIUMTEXT NULL AFTER rewards;
