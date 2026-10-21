-- 010_day_notes_rich_text.sql — the day's Public and Secret notes (days.notes and
-- days.gm_notes) can hold rich text from the word-processor editor: HTML cleaned
-- to a strict allow-list by api/richtext.php. The *_format columns say which
-- notes are rich ('html'); existing notes stay 'plain' and show as before.
-- MEDIUMTEXT because markup makes a note longer.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/010_day_notes_rich_text.sql
-- (install.php runs it for you when days has no notes_format column.)
-- Fresh installs already get it from db/schema.sql.

ALTER TABLE days
  MODIFY notes MEDIUMTEXT NULL,
  MODIFY gm_notes MEDIUMTEXT NULL,
  ADD COLUMN notes_format VARCHAR(8) NOT NULL DEFAULT 'plain' AFTER notes,
  ADD COLUMN gm_notes_format VARCHAR(8) NOT NULL DEFAULT 'plain' AFTER gm_notes;
