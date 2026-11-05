-- 029_session_undated.sql — a session can have no in-game dates, as one imported from Scabard has: Scabard knows the
-- real-world day a session was played, not the campaign's day, so such a session covers no shifts and shows on none.
--
-- play_sessions.undated: 1 for a session with no in-game dates (first_day and last_day are then only a placeholder).
-- Sessions imported before this change were put on the day of the import, so every shift of that day showed all of
-- them. They are found and marked: three or more sessions on one day with no shift kept, no notes, and the same first
-- and last day are an import's.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/029_session_undated.sql
-- (deploy.sh and install.php run it for you when play_sessions has no undated column.)
-- Fresh installs already get it from db/schema.sql.
ALTER TABLE play_sessions ADD COLUMN undated TINYINT(1) NOT NULL DEFAULT 0 AFTER last_shift;

UPDATE play_sessions s
  JOIN (SELECT campaign_id, first_day FROM play_sessions
        WHERE first_shift IS NULL AND last_day = first_day AND notes_text IS NULL
        GROUP BY campaign_id, first_day HAVING COUNT(*) >= 3) b ON b.campaign_id = s.campaign_id AND b.first_day = s.first_day
SET s.undated = 1
WHERE s.first_shift IS NULL AND s.last_day = s.first_day AND s.notes_text IS NULL
  AND NOT EXISTS (SELECT 1 FROM session_notes n WHERE n.session_id = s.id);
