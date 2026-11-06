# Maps tab, phase 3

GitHub issue #112. Phases 1 and 2 are merged. Phase 3 is the last: **maps inside maps** and **finding the grid on a
plain picture**.

## Maps inside maps

- A pin can **open a map**: the town pin on the region map opens the town's map. Any kind of pin (note, entry, event)
  can, so a pinned Encyclopedia entry "Bree" can open the Bree map.
- GMs choose it in the pin form (*Opens map*, a list of the campaign's other maps). A pin can't open the map it is on.
  Players can't set it, even on their own pins.
- The pin's card shows **🗺️ Open <map>**. The inner map shows **Inside: <pin> on <map>** under its title, linking back.
  A map reached by several pins names the first.
- Secrecy: a player is never told about a GM-only inner map, not even its name (the pin shows no link); and a GM-only
  outer map is not named as a parent. A GM sees everything.
- Deleting the inner map clears the link and keeps the pin. A campaign copy keeps the links.
- Not done: depth limits or loops need no rule (a link is only a link); a list of each map's inner maps on the Maps tab.

## Finding the grid

- In the scale dialog, **Find the grid** looks for a square grid drawn on the picture and fills in *Pixels per square*.
  It also runs by itself when the dialog opens on a map with no grid and no hint from the file name.
- It runs in the browser on a shrunk copy (at most 1600 px a side), with `MapGeo.detectGrid`: grid lines are long edges, so
  each column and row is scored by how many of its pixels are on an edge; an autocorrelation of those scores finds the
  size, and a fit through each line's own position fixes it to a fraction of a pixel and gives where the first line falls.
- What it finds is **drawn over the picture before anything is saved**, so the GM sees whether it lines up; cancelling or
  typing a different size takes it away. Saving keeps the found size and offset. It suggests; it never saves by itself.
- No grid, or not a regular one: it says so and nothing changes. Hex grids are not detected.

## Database

Migration `db/migrations/031_map_nesting.sql` (and the column in `db/schema.sql`): `map_pins.child_map_id` INT UNSIGNED
NULL, a foreign key to `maps(id)` `ON DELETE SET NULL`. The upgrade runs it when the column is missing. No new data
sources or libraries.
