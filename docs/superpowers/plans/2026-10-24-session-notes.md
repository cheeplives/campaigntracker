# Session Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM-only quick-capture box on Current Day for terse in-game notes, a Sessions tab where each session's notes sit beside a summary built from them, and a Markdown export.

**Architecture:** Two new tables behind new `api/index.php` actions, in the Library's patterns (a `has_sessions()` guard, a `version` column for stale saves). The parsing and draft logic is a plain, DOM-free script `static/sessions.js` (`window.Sessions`, also `module.exports`) so it can be tested under Node like `engine.js`; the UI lives in `static/app.js` beside the day page and the Library.

**Tech Stack:** PHP 8 + MySQL/MariaDB, plain browser JS (no build), Quill via `static/richtext.js`, Playwright tests.

**Spec:** `docs/superpowers/specs/2026-10-24-session-notes-design.md`

## Global Constraints

- No user text is ever inserted as HTML; build DOM with `el()`. The draft's HTML is built by escaping each note and goes through `RichText.editor`'s loader and the server's `rich_html_clean()`.
- No new dependencies, no build step; scripts load from `index.html` in order before `app.js`.
- Players are never sent notes, unpublished sessions, or `<aside>` paragraphs (`rich_for()` / `rich_open()`).
- Every control has a `data-tip`; the capture box's shorthand tip text is the spec's, verbatim.
- Migration file `db/migrations/015_sessions.sql`; tables `play_sessions`, `session_notes` exactly as in the spec; `install.php` runs it when `play_sessions` is missing; `db/schema.sql` gets both tables.
- `snote_*` and `session_summary_save` don't bump `campaigns.updated_at`; `session_save` (publish, titles) and `session_delete`, `session_end` do.
- Note text max 1000 characters, depth 0..3, title max 200.

## Review Focus

1. A note saved while offline: it must stay in the box marked *Not saved, retrying* and survive a reload (kept in `localStorage`), then save once, not twice. Test in Task 3.
2. A `>` jump in hours mode or two-shift mode (`>night`, `>14`, `>14:00`) and a shift name that is a prefix of two names: pick the first in day order. Test in Task 1.
3. A player calling `session` for an unpublished session id, or `snote_add` directly: 404 / 403. Test in Task 2.
4. Build draft on a session spanning a year boundary or containing only `!` lines: headings in day order; an empty draft says "Nothing to draft" rather than clearing the editor. Test in Tasks 1 and 4.
5. Two GMs typing notes into the same open session from two tabs: positions must not collide (server assigns `MAX(position)+1`). Test in Task 2.

---

### Task 1: Pure logic — date reader, line marks, jumps, draft

**Files:**
- Modify: `static/engine.js` (add `parseDate`, export it)
- Create: `static/sessions.js`
- Modify: `index.html` (load `static/sessions.js` after `engine.js`)
- Test: `tests/browser/sessions-logic.spec.js` (runs under Node; no page)

**Interfaces:**
- Produces: `E.parseDate(cal, text, nearDay) -> number|null` — "12 Firstmonth", "12 Firstmonth 1492", "Firstmonth 12"; month matched case-insensitively from the start of its name (first in calendar order); year defaults to `fromAbs(cal, nearDay).year`; a year written in an era ("1492 DR") goes through `eraYear`; a day past the month's length → null.
- Produces: `Sessions.mark(text) -> '' | '!' | '?' | '>'` (first non-space character).
- Produces: `Sessions.parseJump(cal, text, stamp, clock) -> number|null` — `text` starts with `>`; returns the absolute shift reached. Forms: `>` (→ `clock`), `>+N`, `>+Nd`, `>+Nw` (`weekLength`), `>+Nm` (`addMonths`), `>shiftname-prefix`, `>HH` / `>HH:MM` in hours mode, `>+N shiftprefix`, a date (`parseDate`), a date then a shift. A day jump without a shift keeps the stamp's shift slot; a shift alone stays on the stamp's day. null when unreadable.
- Produces: `Sessions.stampAt(notes, clock, cal) -> number` — the last jump's `abs_shift` in `notes` (ordered), else `clock`.
- Produces: `Sessions.draftHtml(cal, notes) -> string` (algorithm below) and `Sessions.markdown({ camp, session, notes, gm, withNotes }) -> string` (uses `RichText.toMarkdown`, so only called in the browser).
- Note objects everywhere: `{ id, position, depth, text, abs_shift, is_covered }`.

- [ ] **Step 1: Write failing tests** in `sessions-logic.spec.js`, requiring both files under Node (`sessions.js` must `require('./engine.js')` when `module` exists). Use the helpers' test calendar (two 30-day months, five weekdays) with `timeMode` shifts4, plus copies set to `shifts2` and `hours`. Assertions:
  - `parseDate(cal, "12 Firstmonth", 40)` → `toAbs(cal, 1, 0, 12)`; `"12 sec"` → Secondmonth; `"31 Firstmonth"` → null; `"Firstmonth 3 2"` → year 2.
  - `parseJump(cal, ">+1", 9, 0)` → 13; `">+2w"` from 9 → 9 + 2*5*4; `">dusk"` from 9 (day 2, Midday) → 10; `">+1 dawn"` from 9 → 12; `">"` → clock; `">wibble"` → null; in shifts2 `">night"` → day*2+1; in hours `">14"` and `">14:00"` → day*24+14.
  - `mark("! +2 Sensor")` → `'!'`, `mark("  ? who")` → `'?'`.
  - `draftHtml` on notes `[{d0,"Sensor set off on approach to Jupiter"},{d1,"Listening Station - comm relay satellite"},{d2,"Edited data to remove Tevari"},{d0,"! +2 Sensor Roll"},{d0,"? Who is Essen"}]` all on one day → `<p>Sensor set off on approach to Jupiter. Listening Station - comm relay satellite. Edited data to remove Tevari.</p><aside>Loose ends: Who is Essen</aside>`; notes on two days → each group led by `<h3>` with `fmtDate`; `>` rows and `!` rows never appear; `<`/`&` in a note are escaped; a session of only `!` lines → `''`.
- [ ] **Step 2: Run** `npx playwright test -c <config> browser/sessions-logic.spec.js --project=chromium` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `parseDate` in `engine.js`, then `static/sessions.js`. Draft algorithm: drop `!` and `>` rows; collect `?` rows (text after `?`, trimmed) for the end; walk the rest in order, starting a new paragraph at each depth-0 row and appending deeper rows to the current one (a deeper row with no paragraph yet starts one); a sentence = text trimmed, first letter upper-cased, `.` added unless it ends in `.!?…:;"')`; group paragraphs by `Math.floor(abs_shift / slotsPerDay)` of their first row, emitting `<h3>` per group only when there are 2+ groups; finally one `<aside>Loose ends: a; b</aside>` per loose end (one aside each, joined into a run).
- [ ] **Step 4: Run** the spec — PASS. Also run `engine-parity.spec.js` — PASS.
- [ ] **Step 5: Commit** "Session notes: date reader, time jumps and the draft builder".

### Task 2: Database and API

**Files:**
- Create: `db/migrations/015_sessions.sql` (header comment in the 014 style)
- Modify: `db/schema.sql`, `install.php`, `api/index.php`
- Test: `tests/browser/sessions.spec.js` (API part), `tests/browser/security.spec.js` (refused-for-players list)

**Interfaces:**
- Produces API actions exactly as in the spec's table. Responses:
  - `sessions` → `{ sessions: [{ id, number, title, played_on, first_day, last_day, is_published, version, notes?: count, covered?: count }] }` newest (number) first; players: published only, no counts.
  - `session` (GET `id`) → `{ session: {…, summary }, notes?: [note] }`; player: 404 unless published; summary through `rich_for`.
  - `session_save` → `{ ok, session }`; fields `id?`, `title`, `played_on` (YYYY-MM-DD or null), `first_day`, `last_day` (null allowed), `is_published`, `reopen` (bool).
  - `session_summary_save` (`id`, `version`, `summary`) → `{ ok, session }`; 409 `stale` naming nobody ("Saved in another tab after you opened it…").
  - `session_end` (`id?`, default the open one) → `{ ok }`; `session_delete` (`id`) → `{ ok }`.
  - `snote_add` (`text`, `depth`, `abs_shift`, `session_id?`) → `{ ok, note, session }`; no open session → creates one (number next, title '', played_on today, first_day = floor(abs_shift / spd)).
  - `snote_save` (`id`, any of `text`, `depth`, `abs_shift`, `is_covered`) → `{ ok, note }`; `snote_move` (`id`, `position?`, `session_id?`) → `{ ok }` (moving to another session appends at its end; a position renumbers that session's notes 1..n in a transaction); `snote_delete` (`id`) → `{ ok }`.
  - `campaign` adds `sessions_ready` and, for GMs, `open_session` (`{ id, number, title } | null`).
  - `encyclopedia_sources` adds `{ kind:'session', id, title }` summaries (`rich_open`, secret = !published; GMs also `rich_secrets` as secret) and, GMs only, `{ kind:'session_note', id: session id, title, short:true }` per note, secret.
- Open session = `last_day IS NULL`; at most one: `session_save` with `reopen` and `snote_add`'s auto-create end any other first.

- [ ] **Step 1: Write failing API tests** in `sessions.spec.js` (helpers' `gmAndPlayer` pattern from `day-notes.spec.js`): `snote_add` with no session creates session 1 and returns it; a second `snote_add` joins it with position 2; parallel `Promise.all` of five `snote_add` gives positions 1..5 distinct; `session_end` then `snote_add` starts session 2; player gets 403 on `snote_add`, 404 on `session` for an unpublished id, `sessions` empty; after `session_save {is_published:true}` the player gets the summary without its `<aside>`; `session_summary_save` with an old version → 409; `snote_move` to session 2 appends; `session_delete` removes its notes; text > 1000 → 400; depth 4 → 400; `campaign` reports `open_session`.
- [ ] **Step 2: Run** — FAIL (unknown action).
- [ ] **Step 3: Implement** migration, schema, install step, helpers (`has_sessions`, `need_sessions`, `session_row`, `session_out`, `snote_out`, `open_session`), the actions (reads added to `$readActions`; `session_save`, `session_end`, `session_delete` added to `$touchActions`), `campaign` fields, sources. Positions: `INSERT … SELECT COALESCE(MAX(position),0)+1` inside a transaction with `SELECT … FOR UPDATE` on the session row.
- [ ] **Step 4: Run** the spec, `security.spec.js`, `install.spec.js` — PASS.
- [ ] **Step 5: Commit** "Sessions: tables, migration 015 and the API".

### Task 3: The Session notes box on Current Day

**Files:**
- Modify: `static/richtext.js` (split `mentionPicker` into a core taking an adapter, plus `RichText.inputMentions(input, holder, m)`)
- Modify: `static/app.js` (new `sessionBox(d)` placed after `notesBox(d, row)` in `viewDay` for GMs when `S.sessionsReady`; `S.openSession` from `loadCampaign`)
- Modify: `static/style.css` (`.snotes`, `.snote`, `.snote-d1..3` indents, `.snote-jump` divider, `.snote-unsaved`, `.snote-input` row, phone buttons)
- Test: `tests/browser/sessions.spec.js` (UI part)

**Interfaces:**
- Consumes: `Sessions.mark`, `Sessions.parseJump`, `Sessions.stampAt`; actions from Task 2.
- Produces: `snoteRow(note, opts) -> Element` (shared with Task 4; `opts.tick` adds the covered checkbox, `opts.move` the *Move to…* control), `snoteInput(session, notes, onAdded) -> Element`.
- Mention adapter: `{ before(): string /* text before caret */, replace(start, end, text), anchor(): {top,left} }`; the Quill path keeps its behaviour (inline-secrets tests stay green).

- [ ] **Step 1: Write failing UI tests**: GM on Current Day types "Spotted the Dulled Fang" Enter, Tab, "Hera tipped the Harbormaster" Enter → two rows, second indented (`.snote-d1`), heading names Session 1; `>+1` Enter → a divider reading the next day's date and new notes stamped that day; `>wibble` → message "Couldn't read that jump; try >+1, >dusk or >12 Firstmonth" and the input keeps the text; divider's *Set the clock here* moves the banner's date, a jump alone does not (`campaign.current_shift` unchanged); `! roll` and `? Essen` rows show their icons with tips; `@Dul` lists "Dulled Fang" (entry made via API) and Enter writes it; editing a row (click, change, Enter) saves; ✕ with confirm deletes; input `data-tip` equals the spec's text; the `?` button opens the popover with the same list; offline (`context.setOffline(true)`) a note shows *Not saved, retrying*, survives `page.reload()`, and after going online and the next poll it saves exactly once; player sees no `[data-box=session]`; mobile-chrome: ⇥ button indents.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Pending notes live in `localStorage` key `chronicle:snotes-pending:<uid>:<cid>` as `[{ key, text, depth, abs_shift }]`; flushed on box render and from `checkForChanges`; each carries a client `key` and is removed only after the server answers. Row edit uses `snote_save`; reorder by drag (desktop, `draggable`) and ▲▼ (`pointer: coarse`) via `snote_move`.
- [ ] **Step 4: Run** the spec plus `inline-secrets.spec.js`, `day-notes.spec.js`, `current-day.spec.js` — PASS.
- [ ] **Step 5: Commit** "Current Day: Session notes box for quick notes during play".

### Task 4: The Sessions tab, draft, publish and export

**Files:**
- Modify: `static/app.js` (`TAB_GROUPS` Play gets `['sessions', 'Sessions']`, `TAB_TIPS.sessions`, route `sessions`, `viewSessions(sel)`, `sessionPage(s, notes)`, `sourceLabel` kinds `session` / `session_note`, `SEARCH_GROUPS` + `searchGroupOf` → group `session` "Sessions")
- Modify: `static/style.css` (`.sess-page` two columns, `.sess-tabs` on phones)
- Modify: `tests/README.md` (a **sessions** line), `README.md` feature list if it has one
- Test: `tests/browser/sessions.spec.js` (tab part), `tests/browser/search.spec.js` (a session result)

**Interfaces:**
- Consumes: `snoteRow`, `snoteInput` (Task 3), `Sessions.draftHtml`, `Sessions.markdown`, API (Task 2).

- [ ] **Step 1: Write failing tests**: Sessions tab sits after Events; the list shows "Session 1", date played and days covered; the page shows notes and the editor; *Build draft* on an empty editor fills it with the expected paragraph and ticks the used notes ("3 of 4 covered"; the `?` note counts as used, `!` doesn't); on a filled editor asks Replace / Add below; Save then reload keeps it; stale save shows the reload offer; *Published* makes it appear for the player, who sees linked names and no "Loose ends"; *Export Markdown* downloads `Session 1 - <title>.md` whose text starts with `# Session 1` and, with *Include notes*, ends with a `## Notes` nested list; *Move to…* moves a note to session 2; *Delete* asks and removes; Search finds a word from a published summary for the player and a note's word only for the GM; phone layout shows *Notes* / *Summary* tabs.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in the Library's layout (`enc-page`, `enc-index`, `enc-detail`), with the not-installed card when `!S.sessionsReady`.
- [ ] **Step 4: Run** `sessions.spec.js`, `search.spec.js`, `campaign.spec.js` (every tab renders) — PASS.
- [ ] **Step 5: Commit** "Sessions tab: notes beside the summary, Build draft, publish and export".

### Task 5: Whole-suite check and PR

- [ ] Run the full suite in chromium and mobile-chrome; fix anything red.
- [ ] Bump `APP_VERSION`; copy the spec and plan to the project files; push; open the PR with the database-change note (migration `015_sessions.sql`, run install.php).
