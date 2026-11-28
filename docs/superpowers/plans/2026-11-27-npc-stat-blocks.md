# NPC stat blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM adds a stat block in the campaign's game's own NPC format to a Person entry, and it shows, tracks and rolls on the entry's page.

**Architecture:** A stat block is a sheet template with `kind = 'statblock'` and an optional `dice_game` (a dice preset id). An NPC's block is an ordinary `sheet_characters` row. A new `static/statblock.js` draws a layout as a block; `encyclopedia-tab.js` shows it in place of the one-line strip.

**Tech Stack:** PHP 8 + MySQL 8 (api/), plain browser JS with no build step (static/), Playwright (tests/browser).

**Spec:** `docs/superpowers/specs/2026-11-27-npc-stat-blocks-design.md`

## Global Constraints

- Lamplight look (AGENTS.md): theme tokens only, Spectral buttons in the two sizes, no raw emoji, no gradients; the block's left edge is `--secret` (it means NPC).
- Desktop and iPad portrait (820) and landscape (1180) first; a phone must not overflow.
- Starters hold field names only: no rules text, labels 60 characters at most.
- Every starter has a `source` (title, owner, url, licence) for the About page; non-open ones also go in `SOURCES-TO-LICENSE.md` (gitignored; copy to `/mnt/project-files/`).
- Dice preset ids come from `static/dice-systems.js` PRESETS: `dnd5e pf2 coc7 pbta blades savage yze t2k4`.
- Sheets (`kind = 'sheet'`) behave exactly as before.

## Review Focus

- A stat block template forked or edited keeps `kind` and `dice_game`, and its `abilities`/`modifier` section keys.
- A player on a hidden NPC sees no block and no values; on a shown one sees it without edit controls.
- An NPC with a full sheet still shows the strip; a PC is never offered a stat block template in the sheet pickers.
- A campaign whose dice game has no stat block (`gurps`), or free dice, gets the generic block picked.
- Empty fields and empty lists are left out of the block; a brand-new blank block still shows something to press (Full stat block).

---

### Task 1: Database and template rules

**Files:** Create `db/migrations/062_statblocks.sql`. Modify `db/schema.sql` (sheet_templates), `api/upgrade.php` (step), `api/sheets.php`, `static/sheetlayout.js`. Test: `tests/browser/statblocks.spec.js`, `tests/browser/sheetlayout.spec.js`.

**Interfaces — Produces:**
- Columns `sheet_templates.kind ENUM('sheet','statblock') NOT NULL DEFAULT 'sheet'`, `dice_game VARCHAR(20) NULL`.
- `sheet_layout_in($layout, bool $statblock = false)`: keeps section `abilities: true` and `modifier: 'dnd'` only when `$statblock`; fails with `Only a stat block has an abilities row` otherwise. `SheetLayout.validate(layout, { statblock })` gives the same message.
- `template_out` adds `kind`, `dice_game`. `template_save` takes `kind` (fixed after creation) and `dice_game` (must be in `DICE_GAMES`, a PHP const list of the 35 preset ids; NULL for a sheet). `template_fork` copies both.
- `character_card` adds `statblock: bool`; `characters_by_entry` passes it on.
- `character_field`/`character_values`: a GM needs no "Press Edit first" on a stat block character with no owner.
- `starter_templates_load` reads `kind` and `dice_game` from the file and updates them when they differ.

- [ ] Tests (API, chromium only): save a template with `kind: 'statblock', dice_game: 'dnd5e'` → 200 and echoed; `dice_game: 'nope'` → 400; a sheet with `abilities` section → 400; fork keeps both; migration file runs on a database without the columns (`tools/test-all.sh` upgrade step covers it).
- [ ] Implement, run, commit.

### Task 2: Starters, About and licence notes

**Files:** Create `db/starter-templates/statblock-{generic,dnd5e,pf2,coc7,pbta,blades,savage,yze,t2k4}.json`. Modify `tests/browser/starter-templates.spec.js` (the Holdings rule applies to sheets only; stat blocks have no Holdings section), `static/app.js` (About: stat block starters listed under their own heading), `SOURCES-TO-LICENSE.md`.

- [ ] Each file: `name` ("D&D 5e stat block"), `game`, `edition`, `kind`, `dice_game`, `source`, `layout` per the spec's table. `name` of the generic one: "Generic stat block", game "Any game".
- [ ] Test: every `statblock-*.json` validates with `{ statblock: true }`, has a known `dice_game` or none, and exactly one has none.
- [ ] Run starter-templates spec, commit.

### Task 3: Drawing a block

**Files:** Create `static/statblock.js`. Modify `index.html` (script tag before sheets.js), `static/style.css` (`.statblock*`). Test: `tests/browser/statblocks.spec.js`.

**Interfaces — Produces:** `StatBlock.render(layout, values, { name, sub, can, send(key, value), roll(x) | null, caps })` → `HTMLElement` (`div.statblock`). `StatBlock.empty(layout, values)` → bool. `StatBlock.mod(score)` → `"+3"` (floor((score − 10) / 2)).
- compact section → `.sb-kv` run; `abilities` section → `.sb-abil` grid; `list` → `.sb-row` paragraphs led by the first column in bold, other cells joined by ", "; `longtext`/`text` outside a compact section → paragraph led by its label; `counter` → number input `cur` + ` / max` (disabled without `can`); `pips` → the dots; `checkbox` shows its label only when ticked.
- Numbers roll through `roll({ kind: 'num', value, label })`; dice found by `Dice.find` in text and list cells roll through `roll({ kind: 'dice', value, label })`. Rolled values are buttons with `aria-label="Roll <label>"`.

- [ ] Tests, implement, commit.

### Task 4: Adding a block and showing it on the entry

**Files:** Modify `static/sheets.js` (`addStatBlock(e)`, `entryBlock(e, ch)`, pickers show sheets only, a stat block character's page needs no Edit press for a GM), `static/encyclopedia-tab.js` (button, block in place of the strip), `static/app.js` (the entry editor's button).

**Interfaces — Produces:** `Sheets.addStatBlock(e)`: dialog "A stat block for <name>", one `select[aria-label="Stat block"]` ordered: the campaign's game's starter, the member's own blocks for that game, the generic block, the rest; posts `character_create { template_id, entry_id, kind: 'npc', owner_id: 0 }` and redraws the entry. `Sheets.entryBlock(ch)` → element that loads `character` and draws `StatBlock.render`, with a foot row: "Full stat block" (link to the character page).
- The campaign's game: `DiceSystems.campaignSystem(S.camp.settings.dice)?.game`.

- [ ] Browser tests: the five in the spec's Tests section. Implement, commit.

### Task 5: Template editor and library

**Files:** Modify `static/sheets.js` (`renderEditor`: `#/templates/new?kind=statblock`, a "For the dice game" select for a stat block, no Holdings page added; `renderLibrary`: a Sheets / Stat blocks segmented filter, "+ New stat block" in the header's menu; preview of a stat block uses `StatBlock.render`).

- [ ] Browser test: make a stat block template in the editor for `coc7`, see it under Stat blocks and not under Sheets. Implement, commit.

### Task 6: Checks, screenshots, pull request

- [ ] `tools/test-all.sh browser/statblocks.spec.js browser/starter-templates.spec.js browser/sheet-templates.spec.js browser/sheets.spec.js browser/characters.spec.js browser/sheetlayout.spec.js browser/encyclopedia.spec.js browser/about.spec.js browser/accessibility.spec.js browser/button-sizes.spec.js --project=chromium --project=ipad`
- [ ] Screenshots at desktop, iPad portrait and landscape into `/mnt/project-files/npc-statblocks/built/`.
- [ ] Open the pull request with the attribution header, say the database change, subscribe to its activity.
