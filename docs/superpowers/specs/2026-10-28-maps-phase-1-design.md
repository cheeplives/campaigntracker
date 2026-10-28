# Maps tab, phase 1

GitHub issue #112. A **Maps** tab under World: the GM uploads a map picture, sets its scale, and everyone can zoom,
pan and measure on it. Pins link the map to Encyclopedia entries and Events, players add public pins of their own, and
the party's marker (one per party group, when the party splits) moves when the travel planner's Depart runs.
Decided with Josh on 2026-10-27 and 2026-10-28; the brainstorm is the Claude Doc "Brainstorm: event timeline and
Maps tab". Phase 2 (VTT import and export, grid overlay, Plan this trip) and phase 3 (grid detection, nested maps) come
later and are out of scope here.

## What the user sees

### The Maps tab

- **Where:** World → *Maps*, after Generators. `#/c/<cid>/maps` lists the maps; `#/c/<cid>/maps/<id>` opens one;
  `#/c/<cid>/maps/<id>?pin=<pin id>` opens it centred on that pin with its card open.
- **The list:** a card per map with its name, a thumbnail and "GM only" when it is. GMs get *+ New map*. Players see
  only maps that aren't GM only. An empty list says "No maps yet." (GMs: "No maps yet. Add one with + New map.").
- **New map** (GMs): a name, then the picture, either uploaded (JPEG, PNG, WebP or GIF, through the same upload code as
  Pictures and files: checked by its contents, counted against the campaign's space) or picked with Find Image. Then
  the scale dialog opens.
- **The viewer:** the picture fills the page under the campaign header, with Leaflet's zoom and pan (wheel, pinch,
  drag, the + and − buttons). A scale bar sits bottom left once the map has a scale. A toolbar along the top holds
  *Measure*, *Add pin* and, for GMs, *Scale*, *Rename*, *GM only* and *Delete map*. On a phone the toolbar wraps
  and the map keeps the 16 px gutter.

### Scale

The scale dialog offers two ways, and the map keeps whichever was used last:

1. **Two points:** "Click two places you know the distance between", then "How far apart are they?" with a number
   and a unit (feet, metres, miles, kilometres).
2. **Grid squares:** "One square is [5] [feet]", then "Click the corners of a run of squares" and "How many squares
   is that?". When the file name already says it (`Tavern_30x20.png`: 30 squares across; `..._70px.jpg`: a square is
   70 pixels) the dialog fills the square size in for the GM to confirm. A *Roll20 (70 px = 5 ft)* button fills in
   Roll20's default.

Distances are shown in the reader's units (the account's Metric/Imperial choice, else the campaign's), whatever unit
the scale was set in: imperial in feet below a mile and miles above, metric in metres below a kilometre and kilometres
above. A map with no scale measures nothing and says "Set the scale to measure" (GMs) or "The GM hasn't set this
map's scale yet" (players).

### Measure and routes

*Measure* turns clicks (taps) into a path: the running distance shows beside the last point and in the toolbar.
*Undo point*, *Clear* and, for GMs, *Save route…* (a name, GM only or not). Saved routes are drawn as dashed lines,
listed beside the map with their lengths, and can be renamed, hidden from players or deleted by GMs. Everyone sees
the routes that aren't GM only.

### Pins

*Add pin*, then a click on the map, opens the pin form.

- **Players** add a **note pin**: a label (required) and a short note. It is public: everyone in the campaign sees it,
  with "Added by <character name>". A player can move, edit and delete only their own pins.
- **GMs** add any kind:
  - **Note:** as for players, and it can be GM only.
  - **Encyclopedia entry:** pick an entry (search by name), or type a name that isn't one yet and press *New entry
    here*, which adds an entry of that name with Category Location and pins it. The pin's icon is the entry's
    Category's (Location 📍, Person 👤, Item 🗝️, Group 👥, Vehicle ⛵, as on the Encyclopedia tab; none 📌). The pin's card shows the entry's name and its first line, with a link
    to the entry.
  - **Event:** pick an event, or type a title and press *New event here*, which adds an all-day event of that title on
    the campaign's current day and pins it. The card shows the
    event's date and title, with a link to its day.
  - Any pin can be GM only, and GMs can move, edit and delete every pin.
- A pin linked to a GM-only entry or a secret event is never sent to players, whatever its own flag says. Deleting
  the entry or event deletes its pins.
- Clicking a pin opens its card. Pins are drawn as small labelled markers that keep their size as the map zooms.
- **Add to Encyclopedia** (GMs, on a note pin's card, a player's or their own): adds an Encyclopedia entry named
  after the pin's label, Category Location, with the pin's note as its Public notes, and turns the pin into that
  entry's pin in the same place. When an entry of that name (or other name) already exists, the card offers *Link to
  <entry>* instead, so no duplicate is made. The pin still says "Added by <character name>", and from then on it is
  the GM's to move or change, like every entry pin; the player can still edit the entry's Public notes, as with any
  entry. The new entry goes through the Proper Noun Detector's usual check of the note's text.

### Links back

- An Encyclopedia entry with pins shows "📍 On the map: <map name>" under its name, one link per pin, opening the map
  at that pin.
- An event with a pin shows a 📍 link to the same place in the day view's event list and on the Events page.

### The party, and splitting it

- The campaign has **party groups**. Until a GM splits the party there is one, *The party*, holding every player
  character, and it is the **main group**: its region is the campaign's current region ("Party is here" on Regions),
  so the weather follows it, as now.
- The Travel tab starts with a *Where the party is* card listing the groups: name, members, region and map. GMs get
  *Split the party…* (a name, the members who go, and a region, which starts as the group's they leave), *Rename*,
  *Make main group* and *Merge into…* (its members join the group picked, and it is gone).
- Each group can have a **marker** on one map: a flag with its name, or the group's **token** (shown round, with the
  name under it) when one from the Tokens tab is assigned to it, there or with *Token* on its row in the Travel
  card. GMs drag it, or use *Party is here* on a pin's
  card (asking which group when there is more than one). Players see the markers and can't move them.
- **Depart** on the Travel tab asks *Who is travelling* when there is more than one group (the main group first). On
  arrival:
  - the group's region becomes *Region on arrival* (for the main group that is the campaign's current region, as now);
  - its marker moves to the pin on its current map whose label or linked entry name matches *To* (case and a leading
    "The" ignored). The To box suggests those names. No match leaves the marker where it was;
  - the clock moves for everyone, as it must, and the travel event names the group when it isn't the main one
    ("In transit (Scouts): Bree → Weathertop"). Only the main group's trip labels the passed shifts and rolls the
    travel region's weather.
- *Party is here* on Regions moves the main group, so the two never disagree.

### The Tokens tab

- **Where:** Setup → *Tokens*, after Members, for GMs only (players don't see the tab). `#/c/<cid>/tokens`.
- **The library:** every token the GM has loaded, as round pictures in a grid with their names, filtered by kind
  (Party, Character, Creature, Object) and a name search. Each says what it is assigned to.
- **Add tokens:** *Upload tokens…* takes many pictures at once (JPEG, PNG, WebP or GIF, the usual upload checks and
  the campaign's space); each becomes a token named after its file (`Goblin_archer.png` → "Goblin archer"), kind
  Creature, size 1. *Find Image…* adds one from the picture search.
- **Each token** has a name, a kind, a size in squares (1 for Tiny to Medium, 2 Large, 3 Huge, 4 Gargantuan; used
  on battlemats later), GM only, and what it is **assigned** to, any of:
  - a **party group**: it becomes that group's marker on the map (phase 1 uses this);
  - a **member's character**: shown beside the name on the Members tab; one token per character;
  - an **Encyclopedia entry** (a person, group, vehicle…): shown beside the entry's name.
  Assignments are what a battlemat will use later to place "Pip's token" or "a Goblin archer" in one click.
- **Delete** asks first, removes the picture and clears its assignments (a group falls back to the flag).
- A GM-only token's picture never reaches players, even where it is assigned; a token assigned to a GM-only entry is
  shown to players only once the entry isn't GM only.

## Rules

- Only GMs add, change or delete maps, routes and party groups, set a map's scale or move markers.
- Every member adds note pins; players' pins are never GM only.
- A GM-only map, and everything on it, is never sent to players. A player who opens its address gets "Map not found".
- Maps, pins and routes keep coordinates in the picture's own pixels (x right, y down from the top left), so they stay
  put at every zoom and on every screen.
- Data sources: none new. Maps are the GM's own pictures. Leaflet 1.9.4 (BSD 2-Clause) is bundled under
  `static/vendor/leaflet` and credited on the About page under Software and fonts, beside Quill.

## Database

Migration `db/migrations/019_maps.sql`, run by install.php's *Install or upgrade* when there is no `maps` table, and the
same tables in `db/schema.sql`:

| Table | Columns |
|---|---|
| `maps` | id, campaign_id, name, image_id (attachments.id, NULL until a picture is added), width, height (pixels), scale_per_px DOUBLE NULL, scale_unit ('ft', 'm', 'mi', 'km') NULL, grid_px DOUBLE NULL, grid_offset_x, grid_offset_y DOUBLE NULL (where the first grid line falls; for tokens and the grid overlay later), is_secret, created_by, created_at |
| `map_pins` | id, map_id, campaign_id, x, y (DOUBLE), kind ('note', 'entry', 'event'), entry_id NULL, event_id NULL, label, note, is_secret, created_by, created_at |
| `map_routes` | id, map_id, campaign_id, name, points_json, is_secret, created_by, created_at |
| `party_groups` | id, campaign_id, name, members_json (user ids), region_id NULL, map_id NULL, x, y NULL, token_id NULL (tokens.id), is_main, created_at |
| `tokens` | id, campaign_id, name, image_id (attachments.id, parent_type 'token'), kind ('party', 'character', 'creature', 'object'), size_squares, member_id NULL, entry_id NULL, is_secret, created_by, created_at |

The map's picture is an attachments row with `parent_type` 'map', so it is checked, stored, counted and purged as every
other file is.

## Tokens later: what phase 1 keeps ready

Character and monster tokens on a battlemat are their own later phase, because the hard part isn't drawing them but
moving them live while several people watch. Phase 1 is shaped so that phase only adds, and changes nothing here:

- **One marker layer.** Pins, party markers and tokens are all drawn by one `marker()` function in maps.js (a
  position in picture pixels, a picture or an icon, a label, a size, who may drag it, what a drag saves). Tokens
  reuse it; nothing is redrawn differently.
- **The grid is stored now.** `grid_px` and the grid offset are kept from the scale dialog, so tokens can snap to
  squares and be sized in squares (1 for Medium, 2 for Large) without a migration to `maps`.
- **The token library comes now.** The Tokens tab already holds the pictures, names, sizes and who each belongs to,
  so the battlemat phase only places them.
- **What the tokens phase adds:** a `map_tokens` table (a token from the library placed on a map: x, y, a label of its
  own such as "Goblin 3", GM only, a layer order), players dragging their own token, snap to
  grid, and a faster refresh on an open map (a `map_changed` poll every couple of seconds, or server-sent events)
  so moves show up for everyone. That last one is the real work, and it's better done once tokens are built.

## Not in phase 1

Tiling very large pictures, VTT files, the grid overlay, *Plan this trip*, grid detection, maps inside maps, fog of
war, search results for pins, thumbnails on the day page, and character or monster tokens (above).
