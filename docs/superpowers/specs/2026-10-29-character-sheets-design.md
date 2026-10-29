# Character sheets

Players keep their characters in the app instead of on paper. A **sheet template** describes one game's sheet as
sections of typed fields; a **character** is one filled-in copy of a template inside a campaign. Templates are shared
across the whole site, can be forked like GitHub repositories, and can be drafted from a PDF that is read in the
browser and never stored. A starter library built from Josh's archive of publicly posted sheets fills the library on
day one. Decided with Josh on 2026-10-29 in the project thread "Build online character sheets from PDFs"; design only,
nothing is built yet.

## What it is for

The main job is **tracking what changes at the table**: HP, conditions, gear, XP. The sheet is the app's own form, in
the app's style, not a copy of the publisher's PDF: every game looks at home in the app, works on a phone, and no
publisher artwork is shown. Feeding sheet values into other parts of the app (encyclopedia, holdings, rules
automation) is out of scope.

### What the archive told us

Josh's archive (`C:\Users\cheep\Claude\rpg-sheets\`, about 2,100 PDFs) was surveyed and two throwaway drafters were
tried on it (`rpg-sheets\form_field_survey.md` and `rpg-sheets\_prototype\REPORT.md`):

- 9% of sheets are truly fillable PDFs (196), with about 150 form fields each. 62% are flat PDFs with a text layer
  and no fields. 25% are scans with no text.
- Drafting from form fields gave a usable draft (75%+ of fields sensibly labelled) for about 6 in 10 fillable sheets:
  Call of Cthulhu almost perfect, D&D 5e mostly right, Monster of the Week poor.
- Drafting from page text alone gave a usable draft for 9 of 20 flat sheets tried (D&D 2024, Reign, Blade Runner,
  Fate, Trophy, Cyberpunk RED and others).
- Drafting takes under a second per sheet. The cost is a person tidying: setting dot tracks and current/max
  counters, naming sections, fixing junk labels. So the **template editor matters more than the importer**.

## What the user sees

### Characters tab

- **Where:** a *Characters* tab in each campaign. `#/c/<cid>/characters` lists them; `#/c/<cid>/characters/<id>`
  opens a sheet; `#/c/<cid>/characters/<id>/play` opens its Play view.
- **The list:** a card per character with its name, player, portrait (from the existing attachments code) and its
  Play fields in small form (an HP bar, conditions). This is also the GM's party-at-a-glance view.
- **New character:** pick a template from the library (search by game), then a name. A player can own several
  characters in a campaign (retainers, a backup); a GM can make characters for NPCs.

### Character sheet

- One column on phones, wider on desktop. Fields are edited in place and saved automatically.
- Every field and section has an eye icon for its owner: **hidden** fields and sections are seen only by the owner
  and GMs. Everything else is open to the whole campaign.
- The owner and GMs can edit; other members only read.
- Fields the template no longer has but that still hold a value appear under **Old fields** at the bottom, so a
  template change never loses data.

### Play view

Only the fields the template flags *Play*, built for a phone at the table: big + and − buttons on counters, tappable
pips and clocks, condition toggles, current/max shown as a bar.

### Character names

- Each member can set an **active character** per campaign. Events, notes and the member list show that character's
  name (what `AUTHOR_SQL` shows today), and renaming the character renames it everywhere.
- A member with no active character keeps today's plain-text `character_name`, so nothing changes for anyone until
  they make a sheet.

### PCs, NPCs and the Encyclopedia

- **Every character has an Encyclopedia entry**, category Person. Making a character makes its entry; a GM can
  also add a sheet to an existing Person entry ("Add character sheet"), turning a known NPC into one with stats. The
  entry holds the story side (public notes, GM notes, aliases, connections, mentions); the sheet holds the numbers.
- **Name:** renaming the character or the entry renames both.
- **PC or NPC:** every character is marked one or the other and can be switched back and forth at any time by its
  owner or a GM. Kind is separate from who owns the sheet: switching a PC to NPC (say, the player left) offers to
  hand the sheet to the GM, and switching an NPC to PC offers to hand it to a player.
- **What the entry shows:** a character card at the top with the portrait, a PC or NPC badge, "Played by <member>"
  for PCs, the game, the template's *Summary* fields (class, level, ancestry and the like, flagged in the template
  editor the way *Play* fields are) and an **Open sheet** link. Hidden fields never show on the card to anyone the
  sheet hides them from.
- **Opening the sheet straight away:** an entry with a character has an **Open sheet** button in its header,
  beside the name, so it is one tap from the entry (and visible without scrolling on a phone). The whole character
  card is also a link to the sheet. In the Encyclopedia list, such entries show a sheet icon that opens the sheet
  directly. The sheet has a matching **Encyclopedia entry** link back. Members the sheet is hidden from (players, for
  an NPC sheet not shown to them) don't get the button.
- **The Encyclopedia list** gets a PCs / NPCs filter alongside the category filter.
- **NPC sheets start hidden from players** (the whole sheet: GMs rarely want stats shown), with a *Show sheet to
  players* switch. The entry itself follows its own GM-only setting as entries do today, so a secret NPC stays
  secret.
- **Deleting a character** deletes the sheet and keeps the entry, so the story isn't lost; the entry's card just goes
  away.

### Template library

- Site-wide, not per campaign, with nothing hidden: every template can be found by every user.
- Searchable by game and edition. Each template shows its author, how many characters use it, how many forks it
  has, and what it was forked from (with a link).
- Buttons: **Use** (make a character from it), **Fork** (an editable copy owned by you, recorded as a fork), and
  **Edit**, for its author and site admins only.
- A template's forks are listed on it, like GitHub's fork list. Pulling later changes from the original into a fork
  is not in this version.

### Template editor

- Sections and fields in a list, dragged to reorder. Each field has a label, a type, a *Play* flag and a *Summary* flag (shown on the character's Encyclopedia card). A live preview
  of the sheet sits beside the list (below it on a phone).
- **Import from PDF:** pick a PDF, and the browser drafts a template from it with pdf.js: from its form fields when
  it has them, otherwise from the text on the page. The draft opens in the editor for tidying.
- While editing, the PDF can be shown next to the editor as a reference.
- **The PDF is never uploaded or stored.** It is read only in the browser and is gone once the editor is closed.
  The import dialog and the editor say so in plain words: "This PDF stays on your device. It isn't uploaded or saved,
  and it's gone when you close the editor."

## Field types

| Type | Holds | Notes |
|---|---|---|
| text | one line | |
| longtext | several lines | plain text |
| number | a number | optional min and max |
| counter | current and max | HP, stress; Play view shows +/− and a bar |
| pips | 0 to N filled | dots, boxes, clocks; N set on the field |
| checkbox | on/off | conditions, proficiencies |
| choice | one of a list | options set on the field |
| list | rows of named columns | gear, spells, contacts |

Each field has a permanent **key** made when the field is created. Labels and positions can change freely; values
are stored by key.

## Rules

- Only a template's author and site admins can change it. Anyone can use or fork it.
- Every template save bumps its version. A save from an older copy is refused, as Library tomes do.
- Characters store values by field key. A renamed or moved field keeps its value; a deleted field's value moves to
  Old fields; a new field starts empty.
- A character's owner and the campaign's GMs can edit it. Hidden fields and sections never reach other members: the
  API leaves them out, it isn't only the page hiding them (as with `is_secret` elsewhere).
- Character saves use the same version check as Library tomes, so two people editing at once can't overwrite each
  other: the later save is refused and the page reloads the newer copy.
- A template in use can't be deleted. Its author can unlist it, which hides it from search but keeps it working for
  characters and forks.

## Database

This is a database change: one new migration (the next free number in `db/migrations/`, mirrored in
`db/schema.sql`). The deploy reply must name it and the step Josh runs, per the project instructions.

- **`sheet_templates`**: id, name, game, edition, `author_id` (users), `forked_from_id` (sheet_templates, NULL),
  `layout` (JSON: sections and fields), `version`, `is_listed`, `is_starter`, created_at, updated_at. Fork and use
  counts are counted on demand, not stored.
- **`characters`**: id, `campaign_id`, `owner_id` (users), `template_id`, `entry_id` (encyclopedia_entries, unique;
  the character's entry, which supplies the name), `kind` ('pc' or 'npc'), `sheet_public` (NPCs: whether players
  see the sheet), `template_version` (the version last shown), `field_values` (JSON keyed by field key), `hidden`
  (JSON list of hidden field and section keys), `version`, created_at, updated_at. Deleted with its campaign; deleting
  the entry is refused while a character uses it.
- **`campaign_members.active_character_id`** (characters, NULL, set NULL when the character is deleted).
  `AUTHOR_SQL` becomes: active character's name, else `character_name`, else display name.

Size limits keep JSON columns small: at most 50 sections, 1,000 fields per template, and 200 rows per list field.
The 2,595-field Monster of the Week file bundles ten playbooks and splits into ten templates.

## Starter library

- **Built outside the app**, on Josh's PC where the archive lives. It starts from the prototype drafts; AI cleanup
  per game then sets types, names sections, fixes junk labels and flags Play fields. The output is template files in
  the `layout` format.
- **First batch:** about 40 games from the popularity list, each reviewed carefully before release. **Second
  batch**, after launch: every other game with a decent draft (probably 150 or more), with lighter review.
- **Loaded** with a one-time admin import. The templates are published under a "Campaign Chronicle" starter author
  with `is_starter` set, so anyone can use or fork them.

## Licensing and sources

- A template holds only field labels and structure: no artwork, logos or rules text, and labels kept short
  ("Sanity", not a rules paragraph). A game's name is used only to say what the template is for, with "Not
  affiliated with or endorsed by the publisher."
- **About page:** a "Starter templates" section names each game a starter template was built from.
- **Open-licensed games** (for example the D&D SRD 5.1 under CC BY 4.0, Fate, Blades in the Dark, the Year Zero SRD
  and the Cypher System Open License) get the attribution their licence asks for.
- **Every other publisher's sheet** a starter template was built from goes into `SOURCES-TO-LICENSE.md`, plus its
  copy in the project files folder: source, owner, contact or terms link, what was used, and where. Josh can then
  ask for permission.
- User-made templates are user-shared content and fall under the takedown process in the commercial plan's legal
  piece.

## Not in this version

- In-app AI drafting of templates (a possible paid-plan feature later, under the entitlements design).
- Pulling changes from an original template into its forks.
- Rendering or filling in the publisher's PDF itself.
- Dice rolling, derived values and formulas (e.g. modifiers from scores).
- Sheet values feeding other parts of the app.
- Field-level secrets beyond the owner's hide toggle.

## Testing

- API: an access test for every new action. Members see others' sheets minus hidden keys, only the owner and GMs can
  edit, only the author or an admin can edit a template, and version conflicts are refused.
- Values survive renaming, moving and deleting template fields.
- Browser (Playwright): make a character from a template, edit it, use Play view counters on a phone-sized screen,
  fork a template and edit the fork, and import a fillable PDF fixture into the editor. The PDF must never reach the
  server: no request carries it.
