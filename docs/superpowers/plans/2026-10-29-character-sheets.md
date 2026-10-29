# Character Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players keep their characters in the app: site-wide sheet templates (forkable, draftable from a PDF that is
never stored), characters in each campaign built from them with a Play view for the table, every character tied to an
Encyclopedia entry as a PC or NPC, and a starter library of about 40 games.

**Architecture:** Two new tables and one new column (one new migration, numbered `NNN` below). Their actions live in a new `api/sheets.php`,
called from `api/index.php`'s switch the way `api/scabard.php` is. The browser gets `static/sheetlayout.js` (layout
rules, value coercion and PDF drafting as pure functions; runs under Node in the tests, like `sessions.js`),
`static/pdfimport.js` (pdf.js wrapper: reads form fields, text and page pictures in the browser), and
`static/sheets.js` (Characters tab, sheet, Play view, template library and editor, handed a context object from
`app.js` like `fanwikis.js`). `app.js` gains the tab, routes, the Encyclopedia card and button, and the active
character on the Members tab.

**Tech Stack:** PHP 8 + MySQL, plain JavaScript (no build step), pdf.js 3.11.174 legacy build (Apache 2.0, vendored),
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-character-sheets-design.md`

## Global Constraints

- Migration `db/migrations/NNN_character_sheets.sql`, where `NNN` is the next number free on main **and** in open
  PRs when building starts (021 is taken by maps phase 2, PR #132, and the VTT companion plan adds another; check
  both, and rebase this branch on main first). The same tables in `db/schema.sql`. The step goes in
  `api/upgrade.php` (which `tools/migrate.php`, run by deploy.sh, and install.php both use) and runs when
  `SHOW TABLES LIKE 'characters'` is empty. Before then every sheet action fails with `needs_upgrade` (409), "Character
  sheets need a database upgrade: open install.php and press Install or upgrade", and the tab says so, as the Library
  does.
- Layout JSON: `{ "sections": [ { "key", "title", "fields": [ { "key", "label", "type", "play"?, "summary"?, "min"?,
  "max"?, "count"?, "options"?, "columns"? } ] } ] }`. Keys match `/^[a-z][a-z0-9_]{0,39}$/` and are unique across a
  template's sections and fields together. Types exactly: `text`, `longtext`, `number`, `counter`, `pips`,
  `checkbox`, `choice`, `list`. `count` (pips) 1–30; `options` (choice) 1–50 strings of ≤ 60 chars; `columns` (list)
  1–10 `{ key, label }`. Titles and labels 1–100 chars.
- Limits: 50 sections, 1,000 fields per template, 200 rows per list value, text ≤ 500 chars, longtext ≤ 20,000 chars,
  layout JSON ≤ 1 MB. The same rules are checked in PHP (`sheet_layout_in`) and in `SheetLayout.validate`; the PHP is
  the authority.
- Values by type: text/longtext → string; number → number or null; counter → `{ cur: number|null, max: number|null }`;
  pips → integer 0..count; checkbox → bool; choice → one of options or null; list → array of `{ <column key>: string }`.
- Values are saved one field at a time (`character_field`, last write wins). Settings (name, kind, owner, hidden,
  sheet_public) save with a version check (`character_save`, 409 `stale`, as `tome_save`).
- Visibility: owner and GMs see and edit everything. Other members see the sheet minus hidden keys (a hidden section
  hides all its fields). An NPC with `sheet_public = 0` sends players `values: null`, `sheet_visible: false`. Hidden
  data is left out by the API, never just hidden by the page.
- Template edits: author or site admin only; starter templates (`author_id` NULL) admins only.
- The PDF never leaves the browser: no request carries its bytes. The import dialog and the editor's PDF panel both
  say exactly: "This PDF stays on your device. It isn't uploaded or saved, and it's gone when you close the editor."
- pdf.js loads from `static/vendor/pdfjs/pdf.min.js` with `GlobalWorkerOptions.workerSrc =
  'static/vendor/pdfjs/pdf.worker.min.js'` and `isEvalSupported: false`; no CSP change.
- GM writes and every character write call `touch_campaign($cid)`; template writes don't (they aren't a campaign's).
- About page: `E.SOURCES.pdfjs = { title: 'pdf.js 3.11.174 (static/vendor/pdfjs)', by: 'Mozilla and the pdf.js
  contributors', licence: 'Apache 2.0', url: 'https://github.com/mozilla/pdf.js' }`, under Software and fonts as
  "Reading PDFs when you import a character sheet: <cite>." Plus a "Starter templates" section (Task 9).
- Database change notice for the PR and the thread: "Database change: `db/migrations/NNN_character_sheets.sql` adds
  `sheet_templates`, `characters` and `campaign_members.active_character_id`. deploy.sh runs it automatically
  (`php tools/migrate.php`); if that fails, run it by hand, or open install.php and press Install or upgrade."

## Review Focus

- **A template author changes a field's type** (number → counter, or deletes a choice option) while characters hold
  values: a value that no longer fits must move to Old fields, never be lost or crash the sheet. Tested in Task 2
  (`reconcile`) and Task 4.
- **A player reading hidden data another way:** `characters`, `character`, the `encyclopedia` payload's card fields
  and `campaign_copy` must all leave out hidden keys and private NPC sheets. Tested in Task 4 and Task 8.
- **A member removed from the campaign** who owns characters: their sheets stay, the GM can still edit them and hand
  them to someone else, and the removed member gets 403. Tested in Task 4.
- **A PDF with no fields and no text** (a scan), or one that isn't a PDF: the import says "No form fields or text
  found in this PDF. Start from a blank template, or fork one from the library." and opens nothing. Tested in Task 5.
- **Play view on a phone with a slow connection:** quick taps on + must not drop or reorder (send the resulting value,
  not a delta, and keep the last tap's value on screen). Tested in Task 7.

---

### Task 1: Tables, install step and the upgrade guard

**Files:**
- Create: `db/migrations/NNN_character_sheets.sql`, `api/sheets.php` (`has_sheets()`, `need_sheets()` only for now)
- Modify: `db/schema.sql`, `api/upgrade.php` (a step after the last one: "Added character sheets and the template
  library."),
  `api/index.php` (require `sheets.php`; `'sheets_ready' => has_sheets()` in the `campaign` payload; `CAMPAIGN_COPY`
  entry), `static/app.js` (`S.sheetsReady`, set where `S.libReady` is)
- Test: `tests/browser/sheets.spec.js`, `tests/browser/campaign-copy.spec.js` (its every-table check now covers
  `characters`)

**Interfaces:**
- Produces: `has_sheets(): bool`, `need_sheets(): void`; `campaign.sheets_ready: bool`.

Tables (InnoDB utf8mb4 as the others):

- `sheet_templates`: `id INT UNSIGNED AI PK, name VARCHAR(150) NOT NULL, game VARCHAR(100) NOT NULL, edition
  VARCHAR(60) NOT NULL DEFAULT '', author_id BIGINT UNSIGNED NULL (FK users SET NULL), forked_from_id INT UNSIGNED NULL
  (FK sheet_templates SET NULL), layout MEDIUMTEXT NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 1, is_listed
  TINYINT(1) NOT NULL DEFAULT 1, starter_key VARCHAR(80) NULL UNIQUE, created_at, updated_at`; `KEY (game)`.
- `characters`: `id INT UNSIGNED AI PK, campaign_id (FK campaigns CASCADE), owner_id BIGINT UNSIGNED NULL (FK users
  SET NULL), template_id INT UNSIGNED NOT NULL (FK sheet_templates RESTRICT), entry_id INT UNSIGNED NOT NULL UNIQUE (FK
  encyclopedia_entries RESTRICT), kind ENUM('pc','npc') NOT NULL DEFAULT 'pc', sheet_public TINYINT(1) NOT NULL
  DEFAULT 1, template_version INT UNSIGNED NOT NULL, field_values MEDIUMTEXT NOT NULL, hidden TEXT NOT NULL, version INT
  UNSIGNED NOT NULL DEFAULT 1, created_at, updated_at`.
- `campaign_members.active_character_id INT UNSIGNED NULL` (FK characters SET NULL).
- `CAMPAIGN_COPY`: `['characters', 'maps' => ['entry_id' => 'encyclopedia']]`, after `encyclopedia_relations`;
  `owner_id` becomes the copier, `active_character_id` is not copied.

- [ ] **Step 1: Write the failing tests**: `"Sheets: a fresh install has the tables"` (`sql` finds both tables and the
  column; `campaign` returns `sheets_ready: true`); `"Sheets: before the upgrade, actions say so"` (drop the tables in a
  scratch database as install.spec.js does, `templates` → 409 `needs_upgrade`); campaign-copy's every-table test passes
  with a character in the source (it will once Task 4 exists: mark it `test.fixme` until then).
- [ ] **Step 2: Run** `cd tests && npx playwright test sheets.spec.js --project=chromium` → FAIL.
- [ ] **Step 3: Implement** the migration, schema, install step, guard and copy entry.
- [ ] **Step 4: Run** → PASS; `php -l` on every changed PHP file.
- [ ] **Step 5: Commit** `git commit -m "Character sheets: tables, upgrade step and guard (migration NNN)"`

### Task 2: `static/sheetlayout.js`, the rules

**Files:**
- Create: `static/sheetlayout.js` (global `SheetLayout`, `module.exports` under Node, as `sessions.js`)
- Modify: `index.html` (script tag after `sessions.js`)
- Test: `tests/browser/sheetlayout.spec.js` (Node only, like `sessions-logic.spec.js`)

**Interfaces:**
- Produces:
  - `SheetLayout.TYPES` (the eight type names), `SheetLayout.LIMITS` (the Global Constraints numbers)
  - `SheetLayout.validate(layout) → string[]` (problems in plain words; `[]` when fine)
  - `SheetLayout.newKey(label: string, taken: Set<string>) → string` (`"Hit Points"` → `hit_points`, then
    `hit_points_2`; empty or non-Latin labels → `f_<4 random a-z0-9>`)
  - `SheetLayout.fields(layout) → Map<key, { field, section }>`
  - `SheetLayout.coerce(field, value) → { ok: true, value } | { ok: false }` (per Global Constraints types)
  - `SheetLayout.reconcile(layout, values) → { values, old: [{ key, value }] }` (values kept by key; a value whose key
    is gone, or which `coerce` rejects for its new type, goes to `old`)
  - `SheetLayout.visibleTo(layout, values, hidden: string[], full: bool) → values` (drops hidden field keys and every
    field of a hidden section unless `full`)
  - `SheetLayout.draftFromFormFields(fields: [{ name, type: 'text'|'checkbox'|'radio'|'choice', options?, page, rect:
    [x1,y1,x2,y2] }], labels: [{ str, page, x, y }]) → layout` and `SheetLayout.draftFromText(items: [{ str, page, x,
    y, h }]) → layout` (Task 5 feeds them from pdf.js)

- [ ] **Step 1: Write the failing tests**:
  - `validate` accepts a two-section sample; returns a problem for: duplicate key across a section and a field, type
    `"dice"`, pips `count: 0`, choice with no options, 51 sections, a 101-char label.
  - `newKey("Hit Points", new Set())` → `"hit_points"`; with `hit_points` taken → `"hit_points_2"`; `newKey("力")`
    matches `/^f_[a-z0-9]{4}$/`.
  - `coerce`: counter `{cur: 7, max: 10}` ok; counter `5` → `{ok:false}`; pips 6 with count 5 → not ok; choice
    outside options → not ok; list of 201 rows → not ok; number `"12"` → `{ok:true, value: 12}`.
  - `reconcile`: label renamed, value kept; field deleted → its value in `old`; number field turned to counter with
    value `12` → `old` has `{key, value: 12}`.
  - `visibleTo` with `hidden: ['background']` (a section) drops all its fields; `full: true` keeps them.
  - `draftFromFormFields`: fields `STR` (text) and `Check Box 12` (checkbox) with a label "Athletics" 6 px to the
    checkbox's right → a section `Page 1` with a `number` field "STR" (short all-caps names of ≤ 4 letters become
    numbers) and a checkbox labelled "Athletics"; fields on page 2 go to `Page 2`.
  - `draftFromText`: lines "Name", "Strength", "Dexterity" stacked down the left with a bold-size heading "Abilities"
    above the last two → section "Abilities" with two fields; a run of 40+ words becomes nothing (rules text).
- [ ] **Step 2: Run** `cd tests && npx playwright test sheetlayout.spec.js --project=chromium` → FAIL.
- [ ] **Step 3: Implement.** Drafting heuristics follow the prototype in Josh's `rpg-sheets\_prototype\` (nearest text
  to the left or above within 40 pt labels a junk-named field; text taller than the page's median line by 30%+ starts
  a section). Keep each function short; the heuristics are allowed to be imperfect, the editor fixes them.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Character sheets: layout rules, value coercion and PDF drafting (static/sheetlayout.js)"`

### Task 3: Templates API

**Files:**
- Modify: `api/sheets.php`, `api/index.php` (cases), `tests/browser/access.spec.js` (`templates`, `template`,
  `template_save`, `template_fork`, `template_delete` in ACCOUNT; `starter_templates_load` in ADMIN_ONLY)
- Test: `tests/browser/sheets.spec.js`

**Interfaces:**
- Consumes: `need_sheets()`.
- Produces (all `?a=…`, no campaign):
  - `templates` GET `{ q? }` → `{ templates: template_out[] }`: listed ones, plus your own unlisted; `q` matches name
    or game. Sorted by uses, then name.
  - `template` GET `id` → `{ template: template_out + { layout }, forks: template_out[] }`
  - `template_save` POST `{ id?, name, game, edition?, layout, is_listed?, version? }` → `{ ok, template }`. New: author
    is me. Existing: author or admin (403 "Only its author can change this template. Fork it to make your own"),
    version check (409 `stale`). Layout checked by `sheet_layout_in(mixed $layout): array` (400 with the first problem).
  - `template_fork` POST `{ id }` → `{ ok, template }`: copy with `forked_from_id`, author me, name unchanged, listed.
  - `template_delete` POST `{ id }` → `{ ok }`; 409 "Characters use this template. Unlist it instead" when any
    character uses it. Forks keep working (`forked_from_id` → NULL).
  - `template_out(array $t): array` → `{ id, name, game, edition, author (display name, or "Campaign Chronicle" when
    NULL), mine: bool, can_edit: bool, is_listed, version, uses: int, forks: int, forked_from: {id, name}|null,
    starter: bool, updated_at }`.

- [ ] **Step 1: Write the failing tests**: `"Templates: anyone makes, lists and forks; only the author edits"` (A saves
  a template; B sees it in `templates` with `uses 0, forks 0`; B's `template_save` with A's id → 403; B forks → B's
  copy has `forked_from.id` = A's, A's `forks` is 1 and `template` lists B's fork; A unlists → B's `templates` lacks it,
  but B's fork still shows `forked_from`); `"Templates: bad layouts are refused"` (type `"dice"` → 400 naming it; 1,001
  fields → 400); `"Templates: a stale save is refused"` (two saves from version 1 → second 409 `stale`); `"Templates:
  one in use can't be deleted"` (after Task 4: `test.fixme` until then).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (and access.spec.js). **Step 5: Commit**
  `git commit -m "Character sheets: template library API with forks"`

### Task 4: Characters API

**Files:**
- Modify: `api/sheets.php`, `api/index.php` (cases; `entry_delete` refusal; `member_character` renames the active
  character; `encyclopedia` payload adds `characters`), `tests/browser/access.spec.js` (all below in MEMBER)
- Test: `tests/browser/sheets.spec.js`, `tests/browser/campaign-copy.spec.js` (un-`fixme`)

**Interfaces:**
- Consumes: `template_out`, `SheetLayout` rules mirrored in `sheet_value_in(array $field, mixed $v)` (PHP twin of
  `coerce`).
- Produces (all `?a=…&cid=…`):
  - `characters` GET → `{ characters: character_card[] }`: `{ id, entry_id, name, kind, owner: {id, name}|null,
    owner_in_campaign: bool, template: {id, name, game}, play: [{key,label,type,value}], summary: [{key,label,value}],
    sheet_visible, pic }`, each filtered by visibility.
  - `character` GET `id` → `{ character: { …card, layout, values, old: [{key,value}], hidden (owner/GM only),
    sheet_public, version, can_edit }, template_changed: bool }` (values through `reconcile` against the template's
    current layout; `template_version` updated when owner/GM opens it).
  - `character_create` POST `{ template_id, name, kind?, entry_id? }` → `{ ok, character }`. Without `entry_id`, makes
    a Person entry named `name` (409 "An entry is already called that" if taken, offering `entry_id`). With
    `entry_id` (GMs only), the entry must be a Person with no character. Players make PCs owned by themselves; GMs may
    pass `kind: 'npc'` (owner the GM, `sheet_public` 0) or `owner_id`.
  - `character_field` POST `{ id, key, value }` → `{ ok, value }`: owner or GM; `key` must be in the layout; value
    through `sheet_value_in`; atomic `JSON_SET` on `field_values`.
  - `character_save` POST `{ id, version, name?, kind?, owner_id?, hidden?, sheet_public? }` → `{ ok, character }`:
    owner or GM; only a GM sets `owner_id` to someone else (the owner may set it to a GM: "hand to the GM"); renaming
    renames the entry (and `character_name` of any member whose active character it is); 409 `stale` on version.
  - `character_delete` POST `{ id }` → `{ ok }`: owner or GM; the entry stays.
  - `member_active_character` POST `{ character_id|null }` → `{ ok }`: your own active character, one you own; sets
    `character_name` to its name.
  - `encyclopedia` payload gains `characters: { [entry_id]: { id, kind, sheet_visible } }`.
  - `entry_delete` of an entry with a character → 409 "Delete its character sheet first".

- [ ] **Step 1: Write the failing tests**:
  - `"Characters: a player makes a PC; the party sees it; hidden fields stay hidden"`: P makes a PC from a template
    with sections `stats` (number `str`) and `secrets` (longtext `past`); sets `past`; hides `secrets`; P2's
    `character` has `str` and no `past` key anywhere in the JSON; GM's has both; P2's `character_field` → 403.
  - `"Characters: an NPC sheet is GM-only until shown"`: GM `character_create {kind:'npc'}`; P's `characters` card has
    `sheet_visible: false` and no `play`/`summary` values; P's `character` → `values: null`; after `sheet_public: 1`
    P sees values.
  - `"Characters: every character has an entry, and renames follow"`: create → `encyclopedia` has a Person entry of
    that name with `characters[entry_id]`; `character_save {name}` renames the entry; `entry_delete` of it → 409;
    `character_delete` → entry still there.
  - `"Characters: a GM adds a sheet to an existing NPC entry"`: GM `character_create {entry_id}` works; P's → 403;
    a second sheet on that entry → 409.
  - `"Characters: active character drives the name on notes"`: P `member_active_character`; `members` shows the
    character name; renaming the character changes it; P's `member_character {character_name:'Zed'}` renames the
    character and entry.
  - `"Characters: PC and NPC switch back and forth"`: GM `character_save {kind:'npc', owner_id: GM}` then `{kind:'pc',
    owner_id: P}`; P can edit again.
  - `"Characters: two people change different fields at once"`: P sets `hp`, GM sets `str` from the same opened copy →
    both kept; P's `character_save` with an old version → 409.
  - `"Characters: a template change moves a value that no longer fits to Old fields"`: author turns `str` into a
    counter → P's `character` shows `old: [{key:'str', value: 12}]`.
  - `"Characters: a removed member's sheets stay with the GM"`: GM `member_remove` P → P's `character` → 403; GM edits
    it and `character_save {owner_id: P2}`; card shows the new owner.
  - Un-`fixme` Task 1's copy test and Task 3's delete test.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (sheets, access, campaign-copy,
  encyclopedia, account). **Step 5: Commit** `git commit -m "Character sheets: characters API, PC/NPC, entries and active character"`

### Task 5: pdf.js and the PDF import

**Files:**
- Create: `static/vendor/pdfjs/pdf.min.js`, `static/vendor/pdfjs/pdf.worker.min.js`, `static/vendor/pdfjs/LICENSE`
  (from the `pdfjs-dist@3.11.174` npm package's `legacy/build/`), `static/pdfimport.js` (global `PdfImport`),
  `tests/support/fillable-sheet.pdf` and `tests/support/blank-scan.pdf` (made once with reportlab: two text fields
  "STR", "CharacterName", one checkbox beside the text "Athletics", a heading "Abilities"; and a one-page PDF holding
  only a picture)
- Modify: `index.html` (script tags), `static/engine.js` (`SOURCES.pdfjs`), about page listing
- Test: `tests/browser/sheet-import.spec.js`

**Interfaces:**
- Consumes: `SheetLayout.draftFromFormFields`, `SheetLayout.draftFromText`.
- Produces:
  - `PdfImport.read(file: File) → Promise<{ layout, from: 'fields'|'text', pages: number, doc }>`; rejects with
    `Error('No form fields or text found in this PDF. Start from a blank template, or fork one from the library.')`
    or `Error("That file isn't a PDF.")`.
  - `PdfImport.renderPage(doc, n: number, canvas: HTMLCanvasElement, width: number) → Promise<void>`
  - `PdfImport.close(doc)` (destroys the document; the editor calls it on close)
  - `PdfImport.NOTICE` = the exact sentence from Global Constraints.

- [ ] **Step 1: Write the failing tests**: `"Import: a fillable PDF drafts a template, and the PDF never leaves the
  browser"` (record every request; set the file on the import input; the editor shows fields "STR" and "Athletics";
  no request body contains `%PDF`; the notice text is visible); `"Import: a scan says what to do"` (blank-scan.pdf →
  the exact message, no editor opens); `"Import: a .txt renamed .pdf"` → "That file isn't a PDF."
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (Task 6's editor opens the draft; until it lands, these tests
  drive `PdfImport.read` through `page.evaluate`, then switch to the UI in Task 6). **Step 4: Run** on chromium,
  firefox, webkit → PASS. **Step 5: Commit** `git commit -m "Character sheets: read PDFs in the browser with pdf.js and draft a template"`

### Task 6: Template library and editor

**Files:**
- Create: `static/sheets.js` (global `Sheets`, `Sheets.mount(ctx)` given `{ S, api, post, el, btn, toast, route,
  confirmDlg }` as `fanwikis.js` is)
- Modify: `static/app.js` (routes `#/templates`, `#/templates/<id>`, `#/templates/<id>/edit`, `#/templates/new`; a
  *Sheet templates* link in the account menu and on the Characters tab), `static/style.css`
- Test: `tests/browser/sheet-templates.spec.js`

**Interfaces:**
- Consumes: Task 3 actions, `SheetLayout`, `PdfImport`.
- Produces: `Sheets.renderLibrary()`, `Sheets.renderTemplate(id)`, `Sheets.renderEditor(id|null, { draft? })`,
  `Sheets.renderSheetForm(layout, values, opts)` (shared by the preview here and the sheet in Task 7).

Library: search box, a card per template (name, game and edition, author, "Used by N", "N forks", "Forked from X"
linked), buttons *Use*, *Fork*, *Edit* (when `can_edit`). Template page lists its forks. Editor: sections and fields in
a draggable list (Pointer Events, so touch works as in the Encyclopedia's drag), per field label, type, Play and
Summary switches and the type's settings; *Add section*, *Add field*; live preview beside (below under 760 px);
*Import from PDF* fills an empty template or asks "Replace everything with the draft?"; with a PDF open, a panel shows
its pages (PdfImport.renderPage) under the notice; closing the editor calls `PdfImport.close`.

- [ ] **Step 1: Write the failing tests**: build a template by hand (two sections, a counter flagged Play, a pips
  field count 5), save, see it in the library; fork someone else's and edit the fork; *Edit* is absent on another's
  template; the editor's drag reorders fields on `mobile-chrome`; the Task 5 import tests now go through the UI.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** on chromium, mobile-safari, ipad → PASS.
  **Step 5: Commit** `git commit -m "Character sheets: template library and editor"`

### Task 7: Characters tab, sheet and Play view

**Files:**
- Modify: `static/sheets.js` (`Sheets.renderCharacters()`, `Sheets.renderCharacter(id)`, `Sheets.renderPlay(id)`),
  `static/app.js` (tab `['characters', 'Characters']` in the Party group, its tip "Everyone's characters and their
  sheets", routes `#/c/<cid>/characters[/<id>[/play]]`), `static/style.css`
- Test: `tests/browser/characters.spec.js`

**Interfaces:**
- Consumes: Task 4 actions, `Sheets.renderSheetForm`.

Tab: cards per Global Constraints' `character_card`, PC/NPC filter, *New character* (template picker searching
`templates`, then name; GMs also pick PC/NPC). Sheet: `renderSheetForm` in edit mode, each change sent with
`character_field` on change (debounced 400 ms for typing, at once for taps); eye icons for the owner and GMs; a
settings strip (name, PC/NPC, owner for GMs, *Show sheet to players* for NPCs, *Make this my active character*);
"Old fields" at the bottom when `old` isn't empty; a notice when `template_changed`; an *Encyclopedia entry* link.
Play view: only `play` fields, counters with 48 px + and − buttons, tappable pips, checkboxes as toggles. Each tap sends
the new absolute value; the newest tap's value stays on screen even if an older reply arrives later.

- [ ] **Step 1: Write the failing tests**: a player makes a character, fills fields, reloads and sees them; hides a
  section and the other player doesn't see it on screen; Play view on `mobile-safari`: tapping + five times quickly
  on HP 10/20 ends at 15 on screen and in the database (with responses slowed by `page.route` so they arrive out of
  order); an NPC card shows no stats to a player; the GM hands a sheet to another player.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** on all six projects → PASS. **Step 5: Commit**
  `git commit -m "Character sheets: Characters tab, sheet and Play view"`

### Task 8: Encyclopedia card, Open sheet and the Members tab

**Files:**
- Modify: `static/app.js` (entry view header *Open sheet* button and the character card; list sheet icon and PCs /
  NPCs filter; Members tab and account page show the active character with a picker), `static/style.css`
- Test: `tests/browser/encyclopedia.spec.js`, `tests/browser/account.spec.js`

Card: picture, PC/NPC badge, "Played by <owner>" for PCs, game, Summary fields, whole card links to the sheet. The
header button sits beside the entry name and is visible without scrolling at 390 px. No button, icon or card values
when `sheet_visible` is false for this member.

- [ ] **Step 1: Write the failing tests**: an entry with a character shows *Open sheet* in its header, within the
  first screen on `mobile-safari`, and it opens the sheet; the list's sheet icon opens it; the PCs / NPCs filter;
  a player sees no button on a private NPC; Summary fields hidden by the owner aren't on the card for others; the
  account page's active-character picker sets the name shown on Members.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** on chromium, mobile-safari, ipad → PASS.
  **Step 5: Commit** `git commit -m "Character sheets: Encyclopedia card, Open sheet button and active character"`

### Task 9: Starter library, About page and sources

**Files:**
- Create: `db/starter-templates/<starter_key>.json` (about 40; each `{ name, game, edition, layout, source: { title,
  owner, url, licence|null } }`), `tests/browser/starter-templates.spec.js` (Node: every file passes
  `SheetLayout.validate`, has a `source`, and its key matches its file name)
- Modify: `api/sheets.php` (`starter_templates_load` POST, admins: reads the folder, inserts new `starter_key`s and
  updates changed ones, returns `{ added, updated }`), `static/app.js` (admin button *Load starter templates* on the
  Accounts page), about page (a "Starter templates" section listing each game and its source, with licence attribution
  where `licence` is set, and "Not affiliated with or endorsed by the publishers."), `SOURCES-TO-LICENSE.md` (gitignored:
  one row per non-open source; copy it to the project files folder too)

The JSON files are produced on Josh's PC from his archive: the prototype drafts, then AI cleanup per game against
`SheetLayout.validate` and the Global Constraints types (dot tracks as pips, HP and the like as counters, sections
named, junk labels fixed, Play and Summary flagged). First batch: the ~40 games of the popularity list that have a
sheet in the archive. Labels short; no rules text.

- [ ] **Step 1: Write the failing tests**: the Node check over the folder; `"Starter templates load, and loading again
  updates"` (admin loads → `added` = file count, `templates` shows them with author "Campaign Chronicle"; a non-admin
  → 403; change one file's layout in a temp copy and load again → `updated: 1`; a non-admin can fork but not edit one).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, with the JSON files from the PC run. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Character sheets: starter library of 40 games, About page sources"`

### Task 10: Docs and the PR

**Files:**
- Modify: `README.md` (a Characters and sheet templates paragraph under *Using it*), `tests/README.md` (the new specs
  under *What's covered*)

- [ ] **Step 1:** Write both paragraphs in the files' own voice.
- [ ] **Step 2:** Run the full suite on chromium, mobile-safari and ipad → PASS.
- [ ] **Step 3: Commit** `git commit -m "Character sheets: README and test notes"`
- [ ] **Step 4:** Push and open the PR with the database change notice from Global Constraints in its body and in the
  thread reply.
