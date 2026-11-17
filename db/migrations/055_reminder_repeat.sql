-- 055_reminder_repeat.sql — reminders that repeat every shift until dismissed, and reminders marked done.
-- reminders.repeat_every: once (pops up when the clock reaches due_shift, as before) or shift (pops up on every
-- shift, or hour, from due_shift on until it is dismissed or marked done). reminders.done_at: when whoever may change
-- the reminder marked it done, which stops it for everyone it is for; NULL while it is still live.
-- reminder_dismissals.seen_shift: NULL is dismissed for good (every row before this change); a shift is "seen on this
-- shift", so a repeating reminder comes back once the clock moves past it.
--
-- Run ONCE on an install created before this change:
--   mysql -u <user> -p <database> < db/migrations/055_reminder_repeat.sql
-- (deploy.sh and install.php run it for you when reminders has no repeat_every column.)
-- Fresh installs already get the columns from db/schema.sql.
ALTER TABLE reminders ADD COLUMN repeat_every VARCHAR(8) NOT NULL DEFAULT 'once' AFTER due_shift, ADD COLUMN done_at DATETIME NULL AFTER audience;
ALTER TABLE reminder_dismissals ADD COLUMN seen_shift BIGINT NULL;
