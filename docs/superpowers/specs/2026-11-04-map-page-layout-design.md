# Map page layout: the map is the page

The one-map page of the Maps tab (`static/maps.js` `one()`), laid out so the map owns the screen and the controls sit
on it, grouped by how often they are used. Agreed with Josh on 2026-11-04 from the mockup at
https://claude.ai/artifact/5WrTJo7dkaA79hsZG5F6hi (three artboards: the page, what moved where, the phone).

## What is wrong today

Eight equal, large buttons in one row mix the modes a GM uses constantly (Add pin, Place party) with once-per-map setup
(Scale, Scan for names…, Export…). The map sits in a bordered card at 65% of the window with dead space under the
picture, while the right rail is nearly empty. Every pin shows a white label chip at every zoom, twenty chips over a
painted map that already carries its own names. Routes, the hint line, the measured total and the scale form all take
rows above the map, pushing it down.

## The page

- **Header row** (unchanged in content): `← Maps`, the map's name as `h2`, then a muted meta line: `{pins} locations ·
  {routes} routes` plus `· scale set` once the map has one. No card around the page: the `.card` class comes off the
  `.map-view` wrapper. The class name `map-view` stays on the wrapper (the tests find the map through it).
- **The stage** fills the window from the header row to the bottom: `height: calc(100vh - var(--map-top) - 16px)`, never
  under 320px, where `maps.js` writes `--map-top` (the stage's distance from the top of the window) on the stage element
  from `getBoundingClientRect().top` each time the existing `ResizeObserver` fires. The Leaflet container is a child of
  the stage (`.map-canvas`), so overlays can be the stage's other children; today the stage is the Leaflet container.
- **Everything else is an overlay on the stage**, each a positioned child of the stage with a `z-index` above Leaflet's
  controls (1000) and below the app's dialogs:
  - top-left: Leaflet's zoom control (kept), then the toolbar;
  - top-centre: the hint pill (`.map-note`, kept as the element the tests read), shown only while it has text;
  - top-right: the GM-only lock, then the ⚙ menu;
  - below the toolbar: the current panel (`.map-panel-box`: the scale form, the pin form, the Quick label form), as
    a floating card up to 420px wide that scrolls inside the stage when taller than it;
  - bottom-left: the legend, with the scale bar above it;
  - bottom-centre: the measure bar, only in measure mode: `.map-measure-total`, Undo point, Clear, Save route…, Plan
    this trip;
  - right edge: the drawer and its tab.
- Overlay surfaces use one look: `background: color-mix(in srgb, var(--panel) 92%, transparent)`, `border: 1px solid
  var(--line)`, `border-radius: var(--radius)`, a soft shadow. No new colours.

## The toolbar

One floating bar of `small`-sized buttons in two groups split by a 1px separator.

| Visible | Accessible name (unchanged, as `aria-label`) | Who | Does |
|---|---|---|---|
| 📍 Pin | Add pin | all | as today |
| 🏷 Label | Quick label | GM, Encyclopedia ready | as today |
| 📏 Route | Measure/Route | all | as today |
| 🚩 Party | Place party | GM | as today; the group `<select>` appears beside it in party mode as now |
| ─ | | | |
| 🔤 Labels | Labels | all | toggles every pin label on, remembered per browser per map (`chronicle-map-labels-{cid}-{id}`) |
| ▦ Grid | Grid | all, when the map has a grid | as today |

Below 720px the words are hidden and the buttons are 44px squares with their emoji; the accessible names are unchanged.

The toolbar loses: Scan for names…, Scale, Export…, the grid opacity slider, Undo point, Clear, Save route…, Plan this
trip and the total (these move to the measure bar or the ⚙ menu). An active mode shows the button pressed
(`aria-pressed`, as now) and the hint pill.

## The ⚙ menu

The existing `details.map-gear` (accessible name `Map settings`), GM only, now holds in this order: **Set scale…**
(accessible name `Scale`, opens the scale panel; its label shows the current scale after a `·` when there is one, for
example `Set scale… · 1 sq = 5 mi`), **Grid opacity** (the existing slider, only while the grid is shown), **Scan for
names…**, **Export…**, a rule, **Change picture**, **Rename**, a rule, **Delete map**. Choosing an item closes the menu,
as now.

## The drawer

`aside.map-routes` becomes a drawer over the stage's right edge: 300px wide (100% below 720px, as a bottom sheet of 45%
of the stage's height), sliding in and out with `transform`, never changing the map's size. Its tab is the existing
fold button (accessible names `Hide routes and locations` / `Show routes and locations`, `aria-expanded`) drawn on the
drawer's outer edge, 28px wide, so a collapsed drawer costs 28px. The open/closed state and the folded sections are
remembered as today (`chronicle-map-side-{cid}`).

Inside, top to bottom: a search box (`aria-label` `Find on this map`) that hides the route and location rows whose name
doesn't contain the typed text (case-insensitive, matched the way `MapGeo.nameKey` matches names); the **Routes** and
**Locations** sections as today (`details`, counts, the same rows with the same classes `.map-route` and `.map-place`),
restyled as flat rows without a card border each. A location row still centres the map on its pin and opens its card.

## Labels by zoom

A pin's label (`.map-marker-label`) is in the DOM always (tests and screen readers read it) but is shown only when:

1. the stage has class `labels-on` (the Labels toggle), or
2. the stage has class `zoomed-in`: the map's zoom is at least 1.5 above the zoom `fitBounds` gave it when the page
   opened (`baseZoom`), kept up to date on Leaflet's `zoomend`, or
3. the marker is hovered or has focus, or
4. the marker's card is open (class `selected` on the marker node from `popupopen` to `popupclose`), or
5. the marker is a party marker (`.map-party`): the party is always labelled.

Hidden means `opacity: 0; pointer-events: none` with a 120ms transition, so a label never shifts layout.

## Legend

A small panel bottom-left, under the scale bar: `📍 Place`, `📅 Event`, `📝 Note`, `🚩 Party`, and `GM only` beside a
dashed-outline swatch. It has `aria-label` `Legend`. It is drawn for everyone and is not interactive. Below 720px it is
left out (the drawer's rows carry the same icons) to keep the small screen for the map.

## Keyboard

While the page is open and focus is not in an input, textarea, select, contenteditable or an open dialog: `p` presses
Add pin, `l` Quick label (GM), `m` Measure/Route, `t` Place party (GM), `Escape` leaves the current mode (and closes
the panel, as the mode buttons do when pressed again). The listener is removed when the page is left, the way the ⚙
menu's document listener is.

## Players and the panel

Players get the same page without the modes they can't use (Quick label, Place party), without ⚙ and the lock, and
with the legend and drawer. At the Table (`panel.html`) is untouched: it has no toolbar.

## Out of scope

Changing the pins' shapes or icons, clustering, route colours, and any server change. Nothing here touches
`api/`.
