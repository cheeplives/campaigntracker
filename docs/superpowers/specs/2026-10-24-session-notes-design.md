# Session notes: quick capture during play, and a summary built from it

Agreed with Josh on 2026-10-24. Josh runs his games with a text file of terse, indented one-liners (a name or a
ship per line, a dice note here and there) and later writes a full prose summary from it. This adds that way of
working to the app: a box on Current Day for the one-liners, a Sessions tab where each session's notes sit beside
its summary, a draft built from the notes, and a Markdown export.

Josh's answers that shaped it: the summary is kept in the app and exportable; he types on a laptop, with a phone
as a nice-to-have; he moves the campaign's day forward only some of the time, so a note's day must be fixable; the
draft is built in the app (no AI, no outside service); and only GMs take notes for now, with room for players later.
Sessions are kept loose because the app is new to his table: nothing has to be set up before typing.

## What exists today

- Current Day is a column of folding boxes (`dayBox()` in `static/app.js`): Weather, Notes, Shifts, Events, Reminders.
- Rich text (`static/richtext.js`, `api/richtext.php`): a Quill editor, an HTML allow-list on both sides, `<aside>`
  for GM-only paragraphs, `rich_open()` to strip them for players, `RichText.toMarkdown()` for exports, and an `@`
  mention picker (`mentionPicker`) inside the editor.
- Every Encyclopedia name in a note is linked when shown (`linkedNote()`), so nothing has to be stored as a link.
- The Library's tomes show the shape of a page with a list on the left and an editor on the right, with a `version`
  column that refuses a save made from an older copy.
- `encyclopedia_sources` is the one list of everything written in the campaign, read by Search, the detector and
  "Mentioned in".
- The day-journal ideas in the project files (`day-journal/03-journal-c-campaign-journal.md`) describe a
  `play_sessions` table. This spec builds that table, smaller, so the Journal tab can grow out of it later.

## Part 1: capturing notes on Current Day

A **Session notes** box (GM only) between Notes and Shifts. It folds like the others (key `session`).

- **The list:** the open session's notes, in order, oldest at the top, scrolling inside the box after about twelve
  lines so the rest of the page stays put. Each line shows its text with Encyclopedia names linked, indented by its
  depth, and a small muted stamp of its in-game day and shift (just the shift when it is the current day).
- **The input:** one line at the bottom, placeholder "What just happened? Enter saves, Tab indents". Enter saves the
  note and clears the line; nothing is lost to a closed tab, since each note is its own save. If the save fails
  (offline), the line stays in the box marked *Not saved, retrying* and is sent again on the next change poll.
- **Indenting:** Tab and Shift+Tab change the depth of the line being typed, and of a note being edited. Depth is 0
  to 3. A new line starts at the previous note's depth (so after an indented detail, the next line is indented too,
  as in Josh's file; Shift+Tab brings it back out). On a phone, ⇥ and ⇤ buttons sit beside
  the input and do the same.
- **Stamps:** a note takes the campaign's `current_shift` (day and shift) and the real time. Advancing the day
  mid-game changes what the next notes get. Tapping a note's stamp opens a small picker to change its day (and
  shift) later.
- **Names:** typing `@` opens the same list as the editors' mention picker (up to eight matching Encyclopedia names
  and aliases, Enter or Tab picks, Escape leaves the `@`). `mentionPicker` is split so it can drive a plain `input`
  as well as a Quill editor. Names are linked on display, never stored as links.
- **Marks:** a line that starts with `!` is a GM aside (dice, rules, "+2 Sensor Roll") and is left out of the draft.
  A line that starts with `?` is a loose end. Both show with a small icon; the character stays in the text so it
  can be edited away.
- **Time jumps:** a line that starts with `>` moves the stamp that the notes after it take, until the next jump:
  - `>+1` the next day, `>+9` nine days on, `>+2w` two weeks on (`d`, `w` and, when the calendar has months, `m`);
  - `>dusk`, `>night`: that shift of the day the stamp is on (the names come from the calendar's shifts, matched
    from the start of the word, so `>du` works; `>14:00` or `>14` when the campaign runs on hours);
  - `>+1 dawn`: the next day at dawn (a day part and a shift part, in that order);
  - `>12 Firstmonth` or `>12 Firstmonth 1492`: a date in the campaign's calendar (a new `E.parseDate(cal, text, nearDay)` in
    `engine.js`, the inverse of `E.fmtDate`: day number, a month name matched from its start, an optional year
    that defaults to the stamp's year; the Calendar can use it for a "go to date" box later);
  - `>` alone: back to the campaign's clock.
  A jump is saved as its own row (its `text` keeps the `>` line, its `abs_shift` is where it landed) and shows as a
  thin divider labelled with the day and shift it reached, never as a note. A jump the box can't read is refused
  with a short message under the input ("Couldn't read that jump; try >+1, >dusk or >12 Firstmonth") and left in
  the input to fix. The divider has a *Set the clock here* button, which calls `set_time` to move the campaign's
  clock (weather, reminders, every open page) to the same day and shift; a jump never moves the clock on its own.
  Opening the box after a reload starts the stamp from the last jump of the open session, or the clock when there
  is none.
- **Tooltips:** the input's tooltip (`data-tip`, as every control in the app) lists the shorthand: "Enter saves ·
  Tab / Shift+Tab indents · @ names an Encyclopedia entry · ! keeps a line out of the summary · ? marks a loose end
  · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock". A small `?` button beside the
  input shows the same list in a popover for phones, where tooltips don't hover. Each mark's icon on a saved line
  has a tooltip naming it ("Loose end: not in the summary, listed under Loose ends", and so on), and the divider's
  tooltip says what it does and that *Set the clock here* also moves the campaign's clock.
- **Editing:** a click on a note turns it into an input (Enter saves, Escape leaves it); ✕ deletes it after a
  confirm. Notes can be dragged to reorder on desktop; ▲ ▼ buttons do it on a phone.
- **Sessions in the box:** the heading reads "Session notes · Session 12" with *Open session →* (the session's page)
  and *End session* on the right. When no session is open, the first note saved starts one (see Part 2), and the
  heading says so: "No session open: your first note starts one".

Players never see this box or its notes.

## Part 2: the Sessions tab and the draft

A **Sessions** tab in the Play group after Events (`[['sessions', 'Sessions']]`, tip "Each game night's quick notes
and the summary written from them"). Route `#/c/{cid}/sessions` and `#/c/{cid}/sessions/{id}`.

**The list** (everyone): sessions newest first, each a row with its number and title, the real date played, the
in-game days it covered (first and last day, in the campaign's calendar) and, for GMs, how many notes it has and
whether the summary is published. Players see only published sessions. A GM has *+ Session* for starting one by
hand (title, date played, first day, all with defaults).

**A session's page** uses the Library's left-and-right layout (`enc-page`): the list stays on the left, the session
on the right. On a phone the list gives way to the session, with a back link.

GM view, in two columns on a desktop and two tabs (*Notes*, *Summary*) on a phone:

- **Header:** title (editable), number, date played, first and last day (each editable in place), *Published* toggle,
  *Export Markdown*, *Delete*. Ending a session from Current Day fills in the last day; an ended session can be
  reopened with *Reopen* (which ends any other open one).
- **Notes column:** the session's notes as on Current Day, with the same editing, plus a checkbox per note. A ticked
  note is one the summary covers. *Build draft* ticks every note it uses; the GM ticks the rest by hand while writing.
  The column's heading counts "7 of 23 covered". A note can be moved to another session (*Move to…* on its row) so a
  session typed into by mistake, or two sessions that were one night, can be put right. Deleting a session with notes
  asks, and deletes them too.
- **Summary column:** the rich-text editor (`RichText.editor`, with mentions and the 🔒 secret button), *Save*, and
  *Build draft*. Saves carry the session's `version`; a save from an older copy is refused and the page offers to
  reload (as tomes do).

**Build draft** makes rich text from the notes, in the browser, and puts it in the editor. If the editor already has
text it asks: *Replace* or *Add below*. The draft:

1. Takes the notes in order, dropping `!` lines and `>` jumps (the jumps have already done their work as the
   stamps on the notes that follow them).
2. Groups them by in-game day. With more than one day, each group starts with a heading (`<h3>`) of the day in the
   campaign's calendar ("5 Firstmonth 1492, Tuesday"). A group with one day needs no heading.
3. Turns each depth-0 note into a paragraph. Its indented notes (any depth) are appended to that paragraph as
   sentences, each with its first letter capitalised and a full stop added when it has no end punctuation. So
   "Sensor set off on approach to Jupiter / Listening Station - comm relay satellite. / Edited data to remove
   Tevari" becomes one paragraph of three sentences, which is the shape Josh's summary gives it.
4. Puts every `?` note, without its `?`, in a GM-only paragraph (`<aside>`) at the end headed "Loose ends", so the
   follow-ups travel with the summary but never reach players.
5. Leaves names as text: the summary links them when shown, like every other note.

Nothing leaves the app. There is no AI or external service, so no new data source for the About page.

Player view: the summary only, shown with `linkedNote()` (names linked, GM-only paragraphs already removed by the
server), under the header's title, date played and days covered.

## Part 3: data, API, access and export

**Database change: yes.** One migration, `db/migrations/015_sessions.sql` (renumber if something lands first), two
tables, added to `db/schema.sql` and to `install.php` (run when there is no `play_sessions` table). After deploy
Josh opens `install.php` signed in as a site admin and presses *Install or upgrade*, or runs the file with `mysql`.

```sql
CREATE TABLE IF NOT EXISTS play_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  number INT UNSIGNED NOT NULL,                 -- next after the campaign's highest
  title VARCHAR(200) NOT NULL DEFAULT '',       -- blank shows as "Session {number}"
  played_on DATE NULL,                          -- real-world date
  first_day BIGINT NOT NULL,                    -- absolute campaign day
  last_day BIGINT NULL,                         -- NULL while the session is open
  summary MEDIUMTEXT,
  summary_format VARCHAR(8) NOT NULL DEFAULT 'html',
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_session_campaign (campaign_id, number),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT UNSIGNED NOT NULL,
  session_id INT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL,               -- order within the session
  depth TINYINT UNSIGNED NOT NULL DEFAULT 0,    -- 0 to 3
  text VARCHAR(1000) NOT NULL,                  -- plain text; a leading ! or ? is a mark, a leading > a time jump
  abs_shift BIGINT NOT NULL,                    -- the in-game shift it was taken in (day = abs_shift / shifts per day)
  is_covered TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_snote_session (session_id, position),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES play_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`created_by` on a note is what later lets players keep their own notes (a `visibility` column would join it then).

**API** (`api/index.php`, same patterns as the Library and reminders):

| Action | Who | Does |
|---|---|---|
| `sessions` (read) | all | the campaign's sessions; players get published ones only, without notes or note counts |
| `session` (read) | all | one session; GMs get its notes too; a player's copy is refused unless published, and its summary goes through `rich_open()` |
| `session_save` | GM | new (defaults: next number, today, current day) or changed title, played_on, first_day, last_day, is_published; `reopen` clears `last_day` and ends any other open session |
| `session_summary_save` | GM | summary (cleaned by `api/richtext.php`) with `version`; 409 when stale |
| `session_end` | GM | sets `last_day` to the current day |
| `session_delete` | GM | after the browser's confirm; notes go with it |
| `snote_add` | GM | text, depth, `abs_shift` (the box's stamp: the last jump's, or the clock's); `session_id` optional: none means the open session, or a new one; returns the note and the session (so the box learns a session it started). The browser reads `>` jumps (`engine.js`), so the server stores a jump like any line |
| `snote_save` | GM | text, depth, abs_shift, is_covered |
| `snote_move` | GM | new position and/or `session_id` |
| `snote_delete` | GM | |

Every GM write calls `touch_campaign()` except `snote_*` and `session_summary_save`, which are the GM's own typing
and would otherwise make every open page show the change banner all night (players can't see what changed anyway;
publishing a session does touch). `X-View-As: player` refuses the writes like every other.

**Search, detector, Mentioned in:** `encyclopedia_sources` adds each session's summary (`kind` `session`, with its
title; `secret` while unpublished) and, for GMs, each note (`kind` `session_note`, secret, short). Search results for
them open the session's page.

**Export Markdown** (session page, GM and players): a file `Session 12 - A Locked Box.md` with a `#` title, an italic
byline (date played, days covered) and the summary through `RichText.toMarkdown()`; for a GM, GM-only paragraphs are
kept as `> **GM only:**` quotes as the day export does, and a *Include notes* checkbox appends the notes as a nested
Markdown list under `## Notes`. It reuses `static/day-export.js`'s helpers.

**Phone:** the Current Day box is the same with ⇥ ⇤ ▲ ▼ buttons; the session page's two columns become two tabs;
the sessions list and a session swap as the Library's do. Nothing needs a hover.

**Testing:** `tests/browser/sessions.spec.js`: typing starts a session; Enter saves and Tab indents; stamps follow the
current shift and can be changed; `!` and `?` marks; every form of `>` jump, a bad one refused, the divider, and
*Set the clock here* moving the clock while a jump alone does not; the tooltips and the `?` popover; a player never receives notes, the box, or an unpublished
session (API and page); Build draft's grouping, sentences and loose ends; a stale summary save gets a 409; moving a
note between sessions; the export's text; the phone layout. `tests/browser/security.spec.js` gains the new write
actions in its player-refused list. The whole suite is run before the PR.

## Out of scope (for later)

- Players' own notes (the table is ready for it).
- The full Journal tab, "Story so far" view and character diaries from the day-journal ideas, which would read these
  sessions.
- A "Session 12" chip on each day's page, and jumping between sessions' days.
- Moving anything out of Current Day; Josh will see how the box sits in play first.
