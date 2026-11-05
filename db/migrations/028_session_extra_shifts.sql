-- 028_session_extra_shifts.sql — a session can take in shifts outside its one run: a flashback, or the other half of a
-- split party played on another night.
--
-- session_shifts: a shift (absolute: day × shifts per day + shift) a session covers besides the run from its first to its
-- last shift. Build draft gathers these too, and the shift shows the session's chip.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/028_session_extra_shifts.sql
-- (deploy.sh and install.php run it for you when there is no session_shifts table.)
-- Fresh installs already get it from db/schema.sql.
CREATE TABLE IF NOT EXISTS session_shifts (
  session_id INT UNSIGNED NOT NULL,
  abs_shift BIGINT NOT NULL,
  PRIMARY KEY (session_id, abs_shift),
  FOREIGN KEY (session_id) REFERENCES play_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
