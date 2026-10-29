# Maps tab, phase 2

GitHub issue #112. Phase 1 (#129) built the Maps tab: maps, scale and measuring, pins, routes, party groups and the
Tokens tab. Phase 2 adds what the brainstorm put next:

1. **VTT files:** import a map, with its grid, from the virtual tabletops Josh named (Foundry, Roll20, Owlbear Rodeo,
   Alchemy, TaleSpire, MapTool, Fantasy Grounds) and from the map makers that feed them, and export a map back out.
2. **A grid overlay:** squares or hexes drawn over the map, lined up with the grid the scale dialog stores.
3. **Plan this trip:** send a measured path or a saved route to the Travel tab, and have Depart move the party's
   marker to where the route ends.

Phase 3 (grid detection on plain pictures, maps inside maps) and the battlemat tokens phase stay out of scope.

## VTT files

### What each program gives us

Universal VTT is the format most of them share: an open JSON file (`.uvtt`, `.dd2vtt`, `.df2vtt`) holding the
picture (base64), its size in squares and the pixels per square. Dungeondraft, Dungeon Alchemist, DungeonFog and
Dungeon Scrawl write it, and Foundry (module), Roll20 (Pro script), Owlbear Rodeo (extension), MapTool (built in)
and Fantasy Grounds (uvtt2fgu) read it.

| Program | What it can export | What Chronicle imports |
|---|---|---|
| Dungeondraft, Dungeon Alchemist, DungeonFog, Dungeon Scrawl | Universal VTT | the `.uvtt` / `.dd2vtt` / `.df2vtt` file |
| Foundry VTT | a scene's JSON (*Export Data*), with the picture kept separately | the scene JSON together with its picture |
| MapTool | `.rpmap` (a zip of the map's XML and its pictures) | the `.rpmap` file |
| Fantasy Grounds | a module `.mod` (a zip of `db.xml` and its pictures) | a map picked from the `.mod` file |
| Roll20, Owlbear Rodeo, Alchemy, TaleSpire | no map file: a map there is a picture plus grid settings | the plain picture, as now, with the Roll20 70 px button |

TaleSpire builds maps from 3D tiles rather than pictures, so it has nothing to import; it is covered only as far as a
GM exports a screenshot.

### Import

- *+ New map* gets a second way in: **Import a VTT file…**. It takes one file (or, for Foundry, the scene JSON and
  its picture together) and works out the format from the name and contents.
- The file is read **in the browser**: JSON with `JSON.parse`, the zips (`.rpmap`, `.mod`) with a small zip reader
  in `static/vtt.js` using the browser's own `DecompressionStream('deflate-raw')`. The server never unpacks a zip, so
  there is no new PHP extension and no zip bomb to guard against. The picture found inside is then uploaded through
  the same upload code as any map picture (checked by its contents, counted against the campaign's space), and the
  map is saved with its grid.
- What is kept from each:
  - **Universal VTT:** the picture; `pixels_per_grid` as the grid size; `map_origin` as the grid offset. Universal
    VTT has no distance per square, so the scale is set to 5 ft a square and the scale dialog opens for the GM to
    confirm or change it.
  - **Foundry scene:** the picture the GM picks with it; `grid.size` (or the older `grid`), `grid.distance` and
    `grid.units` (or `gridDistance`, `gridUnits`) as the grid and scale; `grid.type` square or hex; `shiftX`/`shiftY`
    as the offset. Scene *Notes* become note pins (label = the note's text, or "Note"), moved back by the scene's
    padding so they land on the picture.
  - **MapTool `.rpmap`:** the zone's grid class (square, or hex either way up), `size`, `offsetX`/`offsetY`, and
    `unitsPerCell` (feet unless the file says otherwise); the picture is the zone's background or, failing that, the
    largest picture in the file.
  - **Fantasy Grounds `.mod`:** every `<image>` record with a picture; when there is more than one, the GM picks which
    (by name). `gridsize` and `gridoffset` give the grid; Fantasy Grounds stores no distance, so 5 ft a square, as for
    Universal VTT.
- Walls, doors and lights in a Universal VTT file are not kept: Chronicle has no use for them. The import says so
  ("Walls and lights aren't kept") when the file had any.
- Anything the file doesn't say is left for the scale dialog, which opens after every import with the grid filled in.
- A file that isn't one of these, or has no picture, says so plainly ("That isn't a Universal VTT, Foundry,
  MapTool or Fantasy Grounds file", "No map picture in that file") and nothing is saved.

### Export

- GMs get **Export…** on a map's toolbar, offering:
  - **Picture:** the map's picture as it was uploaded.
  - **Universal VTT (.dd2vtt):** the picture (base64), the grid and the map size in squares, with no walls or lights.
    This is what Foundry, Roll20, Owlbear Rodeo, MapTool and Fantasy Grounds import. It needs a grid: on a map with
    none, the option says "Set grid squares first (Scale → Grid squares)". A hex grid exports its size (the format
    has no hex flag; the importing program asks).
- The file is built in the browser from the picture it already shows, so nothing new is needed on the server.
- Pins and routes don't fit in Universal VTT, so they stay in Chronicle.

## The grid overlay

- The scale dialog's *Grid squares* way gains a **Shape**: Squares, Hexes (flat top) or Hexes (pointy top). For hexes,
  the size is from one hex's centre to the next (flat side to flat side).
- **Grid** on the toolbar shows or hides the overlay for the person looking, remembered in their browser per map. The
  GM sets whether a map shows its grid to start with (*Show the grid to everyone* in the scale dialog); a map imported
  from a VTT file starts with it shown, since those pictures often have no grid of their own drawn on.
- The overlay is one SVG pattern over the picture's bounds, in picture pixels, so it scales and pans with the map
  and its lines stay one screen pixel wide at every zoom. It is drawn dark with a light edge so it shows on light and
  dark maps alike, under the pins and routes.
- With a grid, *Measure* also says how many squares (or hexes) the path is: "40 ft · 8 squares", the straight-line
  length divided by the grid size, rounded to a whole square.
- The grid offset (where the first line falls) is set as now, by the first click of a run of squares; with the overlay
  shown the GM sees at once whether it lines up.

## Plan this trip

- *Plan this trip* appears beside *Save route…* while measuring (for a path of two or more points), and on each saved
  route in the routes list. It is for GMs, like Depart.
- It opens the Travel tab with:
  - the **distance** filled in, in the planner's units (km or miles; for a space map, AU or light-years and the
    Constant thrust mode);
  - **From** and **To** filled in with the names of the pins nearest the path's start and end, when a pin is close
    (within 3% of the map's longer side, plus 10 pixels; else left empty);
  - a line under the planner, "Planning the trip along <route name> on <map name>" (or "a measured path"), with
    *Reverse* to swap the ends.
- On **Depart**, the travelling group's marker moves to the route's end on that map (the start when reversed), which
  wins over the To pin match from phase 1. Without a route, Depart works as in phase 1.
- A measured path that isn't saved travels in the address (`#/c/<cid>/travel?map=<id>&path=x,y;x,y…`, rounded to
  whole pixels), so the Travel tab needs no new storage; a saved route travels as `route=<id>`.

## Rules

- Only GMs import, export, set the grid shape and default, and plan trips; everyone can show or hide the grid for
  themselves.
- Imported pins are GM only to start with, as the GM hasn't seen them yet; the import says how many it added.
- A GM-only map's route can't be planned by a player (they can't see either).
- Data sources: none. VTT files are the GM's own; reading a file format to move your own maps between programs needs
  no licence, so nothing goes in SOURCES-TO-LICENSE.md. The zip reader is the app's own, using the browser's built-in
  decompression; no new library.

## Database

Migration `db/migrations/021_map_grid.sql` (and the same columns in `db/schema.sql`), run by the upgrade as usual when
`maps.grid_type` is missing:

| Table | New columns |
|---|---|
| `maps` | `grid_type` VARCHAR(12) NOT NULL DEFAULT 'square' ('square', 'hex_flat', 'hex_pointy'), `grid_shown` TINYINT(1) NOT NULL DEFAULT 0 |

Nothing else changes: imports and exports use the existing tables, and Plan this trip passes the path in the address.
Until the upgrade runs, maps work as in phase 1 and the Shape and *Show the grid* choices are hidden.

## Not in phase 2

Grid detection on plain pictures and maps inside maps (phase 3); battlemat tokens; walls, doors, lights and fog of
war; exporting pins as Foundry Notes; tiling very large pictures; terrain per leg of a route.
