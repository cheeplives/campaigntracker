# NPC stat blocks: design

Asked for by Josh on 2026-11-27, after a brainstorm with three approaches and mockups (`npc-statblocks/` in the
project files). Josh picked approach B and approved the starting list of games.

## Why

A GM wants an NPC's numbers on the NPC's Encyclopedia page, written the way their game writes NPCs: a 5e stat block
for a 5e campaign, characteristics and percentages for Call of Cthulhu, HP, instinct and moves for Dungeon World. Today
the only way to give an NPC numbers is a full player character sheet. For 5e that is 16 sections of class, backstory,
spell slots and coins, and the entry shows only a one-line strip that links away to it. A stat block is short, sits on
the entry where the GM reads about the NPC, and holds what the GM needs at the table: hit points to tick down and
numbers to roll.

## Goals

- **Stat block templates**: a second kind of sheet template, laid out like a game's own NPC write-up. Each one is
  linked to a game from the dice system's *Start from a game* list.
- **The first set of starters**: a generic block, then D&D 5e, Pathfinder 2e, Call of Cthulhu 7e, Dungeon World
  (for PbtA), Blades in the Dark, Savage Worlds, Year Zero Engine, and Twilight: 2000 4e.
- **The campaign's game picks the block.** The game picked under Settings → Dice decides which stat block a new NPC
  starts with. A campaign with *Free dice only*, *Something else*, or a game with no stat block gets the generic one.
- **On the entry page**: the block shows in full under the NPC's name. Hit points and other tracks can be changed
  there, and numbers and dice can be rolled on the campaign's dice roller. *Full stat block* opens it on its own
  page, the same character page every sheet has, to edit it.
- **GMs can make their own** in Sheet templates, as they can sheets now, and fork a starter.

## Not in this change

- **No ready-made creatures.** Every block starts blank. A library of monsters from open sources (5e SRD 5.2 under
  CC BY 4.0, Pathfinder under ORC) can come later.
- **No combat tracker or initiative order**, and no stat blocks in At the Table or the encounter cards yet.
- **No turning a full sheet into a stat block**, or back. An NPC that already has a full sheet keeps it, and its strip
  shows as it does today.
- **Person entries only**, as with sheets today. A creature is a Person entry. Stat blocks for groups (a bandit gang)
  or vehicles are left for later.
- **One sheet or stat block per entry**, as now.
- No text from any rulebook. A template holds only field names, which are game terms.

## Anti-goals

- A stat block must not turn into a second, smaller character sheet with its own rules. It is a sheet template with a
  different look on the entry, built on the same machinery: the same values, tracking, hiding, rolling, versions and
  player view.
- It must not make NPCs with a full sheet worse, or move the *Add character sheet* path for PCs.

## Approaches considered

- **A. A cut-down view of the full sheet.** Tick "Stat block" on fields of an existing template, like *Summary*.
  No database change, but every NPC still needs a full PC sheet, and a PC sheet's fields aren't an NPC's (class and
  level instead of CR, no Actions). Not picked.
- **B. Stat block templates per game (picked).** Small templates in each game's own NPC format, with a generic one
  as the fallback, built on the existing sheet machinery. Costs one migration.
- **C. Quick stats as Person facts.** Typed boxes in the entry's facts. No database change, but nothing to track or
  roll. Not picked.

## Design

### Templates

- `sheet_templates` gains `kind` (`sheet` or `statblock`, default `sheet`) and `dice_game` (a *Start from a game*
  id such as `dnd5e`, or NULL for the generic block and for sheets).
- Starter files say the same in their JSON: `"kind": "statblock", "dice_game": "dnd5e"`. They live with the other
  starters in `db/starter-templates/` with a `statblock-` prefix (`statblock-generic.json`, `statblock-dnd5e.json`...)
  and load through Site Admin's *Load starter templates* as now.
- A layout is an ordinary layout with the same field types. The stat block look comes from how the entry draws it
  (below), not from new field types. Two new optional section keys, `abilities` (true) and `modifier` (`"dnd"`), are
  checked in `static/sheetlayout.js` and `api/sheets.php` alike, and allowed only on a stat block.
- A fork keeps its template's `kind` and `dice_game`.
- The template editor gains a *Kind* choice (Sheet or Stat block) and, for a stat block, the game it is for. The
  Sheet templates page lists stat blocks as their own group, so a GM looking for a PC sheet isn't shown them first.

### Choosing a block for an NPC

- A Person entry with no sheet shows **Add stat block** to a GM, beside today's *Add character sheet*. (Builder's
  call: which of the two is the visible button and which goes in the ⋯ menu. The mockup shows Add stat block.)
- Add stat block opens a short dialog with one picker of stat block templates. The campaign's game's starter is
  picked first, then the GM's own stat blocks for that game, then the generic block, then every other stat block.
- Stat block templates are offered only here. *Add character sheet* and the Characters tab's new character list show
  sheets only. (A stat block character can still be switched to PC in its settings, as any character can.)
- It makes an NPC character (`kind = npc`, no player, hidden from players until shown, as NPC sheets are now).

### On the entry page

- An entry whose character uses a stat block template shows the block in full in place of today's one-line strip.
  An entry with a full sheet keeps the strip.
- The drawing, by field and section:
  - A section marked `compact` is a run of short `label value` pairs on one line that wraps (AC, HP, Speed).
  - Six numbers in a section with `"abilities": true` show as a row of six columns. For a game whose modifier comes
    from the score (5e), the block shows `16 (+3)`. The template says how with `"modifier": "dnd"`; without it the
    number shows as is.
  - A `list` whose first column is a name shows each row as a paragraph led by the name in bold (Actions, Moves,
    Strikes). Empty lists and empty fields are left out.
  - `longtext` is a paragraph, led by its label in bold.
  - Section titles are small rules (Actions, Reactions), as in the mockup.
- Counters (HP, Sanity) and pips can be changed right on the block by whoever can edit the sheet. Everything else is
  edited on the full page (*Full stat block*).
- Rolling: numbers roll as on sheets today. Dice written in text and in list cells (`1d8+3`) roll too. List cells
  don't roll today, so that is new, and it is limited to the stat block view.
- The block has the NPC edge (the `--secret` colour on its left side, as NPC chips use now). Players see the block
  only when the sheet is shown to them, and hidden fields stay hidden, as now.
- Desktop and iPad portrait and landscape first. The six-column ability row wraps to three columns below about
  520px.

### The first starters

The fields for each, as a guide. The builder sets keys, sizes and which sections are compact.

| Starter | Game id | Fields |
|---|---|---|
| Generic | none | Threat (Minion, Tough, Dangerous, Deadly), Health (counter), Defence, Good at, Bad at, Attacks (name, notes), Wants, Notes |
| D&D 5e | `dnd5e` | Size, type and alignment; AC; HP (counter) and hit dice; Speed; Initiative; Str to Cha; Saves; Skills; Resistances and immunities; Senses; Languages; CR; Traits, Actions, Bonus actions, Reactions, Legendary actions (name, text) |
| Pathfinder 2e | `pf2` | Level; Traits; Perception; Languages; Skills; Str to Cha modifiers; Items; AC; Fort, Ref, Will; HP (counter); Immunities, weaknesses, resistances; Speed; Strikes (name, bonus, damage, traits); Abilities (name, text) |
| Call of Cthulhu 7e | `coc7` | STR, CON, SIZ, DEX, APP, INT, POW, EDU; HP, Magic points (counters); Sanity; Damage bonus; Build; Move; Attacks per round; Attacks (name, %, damage); Skills (name, %); Armour; Spells; Sanity loss |
| Dungeon World / PbtA | `pbta` | HP (counter); Armour; Damage; Tags; Special qualities; Instinct; Moves (one per row) |
| Blades in the Dark | `blades` | Tier or quality; Description; Traits; Wants; Preferred methods; Harm to put them down (pips) |
| Savage Worlds | `savage` | Wild Card; Agility, Smarts, Spirit, Strength, Vigor (die choices); Skills; Pace; Parry; Toughness; Wounds (pips, 3); Edges; Hindrances; Gear; Special abilities (name, text) |
| Year Zero Engine | `yze` | Strength, Agility, Wits, Empathy; Skills; Health (pips); Armour; Attacks (name, dice, damage, range); Talents |
| Twilight: 2000 4e | `t2k4` | Experience; STR, AGL, INT, EMP (step dice A to D); Skills; Coolness under fire; Hit capacity, Stress capacity (counters); Armour; Weapons (name, damage, range, ammo) |

### Data and licences

- Each starter carries a `source` as the PC starters do, and so shows on the About page (`starter_sources`).
- Open: 5e SRD 5.2 (CC BY 4.0), Pathfinder 2e (ORC), Dungeon World (CC BY 3.0), Blades in the Dark SRD (CC BY 3.0),
  Year Zero Engine (Free League's YZE SRD licence). Credit as each licence asks.
- Not open: Call of Cthulhu 7e (Chaosium), Savage Worlds (Pinnacle), Twilight: 2000 4e (Free League; the YZE SRD
  licence doesn't name it). Only field names, which are game terms, are used. They still go on the About page and in
  `SOURCES-TO-LICENSE.md` (and its copy in the project files), as the project rule asks, so Josh can ask the owners.
  The *Twilight Encounters* PDF in the project files is not used.

### Database change

- **Migration `062_statblocks.sql`**: `ALTER TABLE sheet_templates ADD kind ENUM('sheet','statblock') NOT NULL DEFAULT
  'sheet', ADD dice_game VARCHAR(20) NULL`. `db/schema.sql` makes the same columns for fresh installs, and
  `upgrade_steps()` runs it when `sheet_templates.kind` is missing. Existing templates become `sheet`.
- **Steps for Josh after deploy**: `deploy.sh` runs the migration (or `install.php`). Then Site Admin → *Load starter
  templates* adds the nine stat block starters.
- No change to `sheet_characters`: an NPC's stat block is a character row like any other.

### Tests

- PHP: a template's `kind` and `dice_game` are checked (a sheet can't have a `dice_game`; the game must be a known
  id); starter files with them load.
- Browser (`tests/browser/`): a GM adds a stat block to a Person entry in a 5e campaign and gets the 5e block picked;
  a campaign on free dice gets the generic one; HP changes on the entry and saves; a dice cell rolls; a player doesn't
  see a hidden NPC's block and sees a shown one; an NPC with a full sheet still shows the strip. Accessibility spec
  over the entry with a block, light and dark.

## Left to the builder

- Field keys, sizes and section split of each starter, within the table above.
- Which of *Add stat block* and *Add character sheet* is the visible button.
- How the template editor shows the Kind and game choices.
- The exact wording of the picker's group labels.
