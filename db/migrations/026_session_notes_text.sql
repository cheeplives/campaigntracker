-- 026_session_notes_text.sql — a session's notes become one text box on its page (play_sessions.notes_text), saved as
-- the GM types, in place of a row per line in session_notes. The text keeps the shorthand (static/sessions.js): a line
-- per note, indented lines under the line above, ! ? > and $ at the start of a line.
--
-- Nothing is moved here: session_notes keeps its rows. While a session's notes_text is NULL the page writes its rows
-- out as the box's text, and saves that the first time the session is opened.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/026_session_notes_text.sql
-- (deploy.sh and install.php run it for you when play_sessions has no notes_text column.)
-- Fresh installs already get it from db/schema.sql.
ALTER TABLE play_sessions
  ADD COLUMN notes_text MEDIUMTEXT NULL AFTER loot;
