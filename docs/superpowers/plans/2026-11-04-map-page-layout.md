# Map Page Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the one-map page so the map fills the window and its controls float on it: a grouped toolbar, a ⚙ menu for setup, a sliding drawer, labels shown by zoom, a legend and keyboard shortcuts.

**Architecture:** Everything lives in `static/maps.js` (`one()`), `static/style.css` (the `.map-*` block) and the browser tests. The Leaflet container becomes a child of the stage so the toolbar, hint, panel, measure bar, legend and drawer can be positioned children of the same stage. Every existing control keeps its accessible name, so the existing tests keep finding them; only the controls that move into the ⚙ menu need their tests to open the menu first.

**Tech Stack:** Plain JavaScript (no build step), Leaflet 1.9.4 (`static/vendor/leaflet`), CSS custom properties, Playwright browser tests run against `php -S` and MySQL (see `tests/README.md`).

**Spec:** `docs/superpowers/specs/2026-11-04-map-page-layout-design.md`

## Global Constraints

- No server change: nothing under `api/` is touched.
- Every control keeps its accessible name exactly: `Add pin`, `Quick label`, `Measure/Route`, `Place party`, `Grid`, `Scale`, `Scan for names…`, `Export…`, `Map settings`, `Hide routes and locations`, `Show routes and locations`, `GM only`, `Save route…`, `Plan this trip`, `Undo point`, `Clear`. A shorter visible word goes in the button text and the old name in `aria-label`.
- These class names stay on the same kinds of element, because the tests read them: `.map-view` (the page wrapper), `.map-pin`, `.map-party`, `.map-marker-label`, `.map-note`, `.map-measure-total`, `.map-scale`, `.map-grid`, `.map-route`, `.map-route-ends`, `.map-route-line`, `.map-place`, `.leaflet-container`, `.leaflet-image-layer`.
- Overlays use `background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--line); border-radius: var(--radius)` and no new colour tokens.
- Buttons in overlays are the app's `small` size; touch targets are at least 44px on `(pointer: coarse)`.
- Per-browser memory keys: `chronicle-map-labels-{cid}-{id}` (Labels toggle) and the existing `chronicle-map-side-{cid}` (drawer).
- Copy is as the spec writes it: hint text, menu item names, the legend's five words.
- Run tests from `tests/` with `npx playwright test --project=chromium <spec names>`; the DB env vars are in `tests/README.md`. Run the whole map suite (`maps map-styles map-scan party-groups tokens touch`) before each commit; run `--project=mobile-chrome` where a task says so.

## Review Focus

- A map with no picture yet (`map.image_url` null): the stage shows the "no picture" message and the toolbar hides the picture-only buttons, as today; the drawer, legend and shortcuts must not throw. Test in Task 2.
- A very short window (an iPad in landscape with the keyboard up, about 420px tall): the stage keeps its 320px minimum and the page scrolls rather than squashing the toolbar over the drawer tab. Test in Task 1.
- A pin whose card is open while the drawer is open and the window narrows under 720px: the drawer becomes a bottom sheet without covering the open card's buttons. Test in Task 8.
- Pressing `p` while typing in the drawer's search box or the pin form's name field must type the letter, not start pin mode. Test in Task 7.
- Leaving the page (hash change) while a mode is active removes the keydown listener, so `m` on the next page does nothing. Test in Task 7.

---

### Task 1: The stage fills the window

**Files:**
- Modify: `static/maps.js` (in `one()`: the `host` declaration near line 207, the `fit()` function and `ctx.mount(...)` call near lines 1012–1047)
- Modify: `static/style.css` (`.map-stage`, `.map-body`, `.map-view` rules, lines 1070–1094)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Produces: `stage` (`div.map-stage`, the positioned parent of every overlay) and `host` (`div.map-canvas`, the Leaflet container, a child of `stage`). Later tasks append overlays to `stage`. `stage.style.setProperty('--map-top', px)` is written in `fit()`. A test helper at the top of `tests/browser/maps.spec.js`, used by every later task: `async function makeMapWithPicture(page, cid, name = "Test map") { const id = (await api(page, "map_save", { name }, cid)).json.map.id; const file = await upload(page, cid, "map", id); expect((await api(page, "map_save", { id, image_id: file.id }, cid)).status).toBe(200); return id; }` (`upload()` already exists in that file and returns the file row).

- [ ] **Step 1: Write the failing test** in `tests/browser/maps.spec.js`, after the existing map-rendering test, using that file's `setup()` and `upload()` helpers to make a map with a picture:

```js
test("the map stage fills the window to its bottom edge and never shrinks under 320px", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Stage");
  const mid = await makeMapWithPicture(page, cid);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage");
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  expect(Math.abs(box.y + box.height - 800)).toBeLessThanOrEqual(20);
  await expect(page.locator(".map-view .leaflet-container")).toHaveCount(1);
  await expect(page.locator(".map-view.card")).toHaveCount(0);
  await expect(page.locator(".map-view .map-meta")).toHaveText("0 locations · 0 routes");
  await page.setViewportSize({ width: 1280, height: 420 });
  await expect.poll(async () => (await stage.boundingBox()).height).toBeGreaterThanOrEqual(320);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "fills the window"`
Expected: FAIL (the stage's bottom is well above 800, and `.map-view.card` exists).

- [ ] **Step 3: Implement the stage.** In `one()`: `const stage = el('div', { class: 'map-stage' }); const host = el('div', { class: 'map-canvas' }); stage.append(host);`. Mount `stage` where `host` was mounted (`el('div', { class: 'map-body' }, stage, routeBox)`), drop `card` from the wrapper's class (`class: 'map-view'`), and keep `L.map(host, …)`; change `ro.observe(host)` to `ro.observe(stage)`. Add the meta line to the header row after the title: `el('span', { class: 'map-meta small muted' }, metaText())` where `metaText = () => \`${pins.length} location${pins.length === 1 ? '' : 's'} · ${routes.length} route${routes.length === 1 ? '' : 's'}${hasScale() ? ' · scale set' : ''}\``, refreshed in `refresh()`. In `fit()`, before `invalidateSize`, set `stage.style.setProperty('--map-top', Math.round(stage.getBoundingClientRect().top) + 'px')`. Add `window.addEventListener('resize', fit)` and remove it in `teardown()`.

- [ ] **Step 4: Style it.** In `style.css` replace the `.map-stage` height with `height: max(320px, calc(100vh - var(--map-top, 260px) - 16px))`, keep `position: relative; overflow: hidden; border-radius: var(--radius)`, drop its border. Add `.map-canvas { position: absolute; inset: 0; }` and move the `.leaflet-container` sizing rule to `.map-canvas .leaflet-container`. `.map-body` becomes `position: relative` with no wrap and no gap (the drawer overlays in Task 5; for now `routeBox` may sit after the stage).

- [ ] **Step 5: Run the test and the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups tokens`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: the stage fills the window, with the Leaflet canvas inside it"
```

---

### Task 2: The floating toolbar, hint pill and measure bar

**Files:**
- Modify: `static/maps.js` (the `btn(...)` definitions for `measureBtn`, `addPinBtn`, `labelBtn`, `partyBtn`, `gridBtn`, `undoBtn`, `clearBtn`, `saveRouteBtn`, `planBtn`, `total`; `syncTools()`; the `toolbar.append(...)` line near 1009)
- Modify: `static/style.css` (`.map-toolbar`, `.map-note`, `.map-measure-total`, `.map-toolbar [hidden]`)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `stage` from Task 1.
- Produces: `tbtn(short, name, onclick, tip)`: a `small` button whose text is `short` and whose `aria-label` is `name`. `toolbar` (`div.map-toolbar`) with two child groups `div.map-tool-group`; `note` (`p.map-note`) as the hint pill; `measureBar` (`div.map-measure-bar`). `syncTools()` also sets `note.hidden = note.textContent === ''` and `measureBar.hidden = mode !== 'measure'`.

- [ ] **Step 1: Write the failing test**

```js
test("the toolbar floats on the map in two groups and keeps every control's name", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Toolbar");
  const mid = await makeMapWithPicture(page, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage"), bar = stage.locator(".map-toolbar");
  const s = await stage.boundingBox(), b = await bar.boundingBox();
  expect(b.x).toBeGreaterThanOrEqual(s.x); expect(b.y).toBeGreaterThanOrEqual(s.y); expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width);
  await expect(bar.locator(".map-tool-group")).toHaveCount(2);
  const pin = bar.getByRole("button", { name: "Add pin" });
  await expect(pin).toHaveText(/Pin$/);
  await expect(pin).not.toHaveText(/Add pin/);
  for (const name of ["Quick label", "Measure/Route", "Place party", "Labels"]) await expect(bar.getByRole("button", { name })).toBeVisible();
  for (const name of ["Scale", "Export…", "Scan for names…", "Undo point", "Save route…"]) await expect(bar.getByRole("button", { name })).toHaveCount(0);
  await expect(page.locator(".map-note")).toBeHidden();
  await pin.click();
  await expect(page.locator(".map-note")).toHaveText("Click the map to place the pin");
  const n = await page.locator(".map-note").boundingBox();
  expect(n.y).toBeLessThan(s.y + 60);
  await page.getByRole("button", { name: "Measure/Route" }).click();   // no scale yet: the hint says so and measure mode doesn't start
  await expect(page.locator(".map-measure-bar")).toBeHidden();
});
test("a map with no picture shows the message and no picture-only tools", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Blank");
  const mid = (await api(page, "map_save", { name: "Blank" }, cid)).json.map.id;
  const errors = watchErrors(page);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await expect(page.locator(".map-empty")).toContainText("no picture yet");
  await expect(page.getByRole("button", { name: "Add pin" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Labels" })).toBeHidden();
  expectNoErrors(errors);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd tests && npx playwright test --project=chromium maps -g "toolbar floats|no picture shows"`
Expected: FAIL (`.map-tool-group` count 0; the Scale button is in the toolbar).

- [ ] **Step 3: Implement.** Add `const tbtn = (short, name, onclick, tip) => { const b = btn(short, onclick, 'small', tip); b.setAttribute('aria-label', name); return b; };` and build `addPinBtn` as `tbtn('📍 Pin', 'Add pin', …)`, `labelBtn` as `tbtn('🏷 Label', 'Quick label', …)`, `measureBtn` as `tbtn('📏 Route', 'Measure/Route', …)`, `partyBtn` as `tbtn('🚩 Party', 'Place party', …)`, `gridBtn` as `tbtn('▦ Grid', 'Grid', …)`, and a new `labelsBtn = tbtn('🔤 Labels', 'Labels', …)` whose handler is a no-op until Task 6 (it toggles nothing yet; give it `aria-pressed="false"` and `hidden = !map.image_url`). Wrap the text of each in `<span class="map-tool-word">` only for the word, so Task 8 can hide the words. Assemble `toolbar.append(el('div', { class: 'map-tool-group' }, addPinBtn, labelBtn, measureBtn, partyBtn, partyWhich), el('div', { class: 'map-tool-group' }, labelsBtn, gridBtn))`. Build `measureBar = el('div', { class: 'map-measure-bar' }, total, undoBtn, clearBtn, saveRouteBtn, planBtn)`. Append `toolbar`, `note`, `measureBar` to `stage` instead of the page; keep `panelBox` where it is for now (Task 4 moves it). In `syncTools()` add the two `hidden` lines from Interfaces. The `scaleBtn`, `exportBtn`, `scanBtn`, `opacityBox`, `secretBtn` and `gear` are no longer appended to the toolbar; Task 3 places them (until then append `secretBtn` and `gear` to `stage` top-right so the page still works, and leave `scaleBtn`, `exportBtn`, `scanBtn`, `opacityBox` in the gear menu as plain items).

- [ ] **Step 4: Style.** `.map-toolbar { position: absolute; top: 12px; left: 60px; z-index: 1001; display: flex; gap: 2px; padding: 4px; }` plus the overlay look; `.map-tool-group { display: flex; gap: 2px; }`; `.map-tool-group + .map-tool-group { margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--line); }`; `.map-note { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 1001; margin: 0; padding: 6px 12px; background: var(--accent); color: var(--on-accent); font-weight: 600; border-radius: var(--radius); }`; `.map-note[hidden] { display: none; }`; `.map-measure-bar { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: 1001; display: flex; align-items: center; gap: 6px; padding: 4px 8px; }` with the overlay look. The Leaflet zoom control stays at Leaflet's default top-left (10px); the toolbar's `left: 60px` clears it.

- [ ] **Step 5: Run the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups tokens`
Expected: all PASS (existing tests find the buttons by their accessible names).

- [ ] **Step 6: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: a floating toolbar in two groups, the hint as a pill, the measure bar at the bottom"
```

---

### Task 3: Setup moves into the ⚙ menu

**Files:**
- Modify: `static/maps.js` (the `gear` details near line 999; `scaleBtn`, `exportBtn`, `scanBtn`, `opacityBox`, `secretBtn`)
- Modify: `static/style.css` (`.map-gear`, `.map-gear-menu`)
- Modify: `tests/browser/maps.spec.js`, `tests/browser/map-scan.spec.js`, `tests/browser/map-styles.spec.js` (every click on `Scale`, `Export…`, `Scan for names…` opens the menu first)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `stage` (Task 1).
- Produces: `gear` (`details.map-gear`, summary `aria-label="Map settings"`) in `div.map-corner` at the stage's top-right beside `secretBtn`; menu items in order: `Set scale…` (button `aria-label="Scale"`, text `Set scale…` plus ` · {scaleText}` when `hasScale()`), `opacityBox`, `Scan for names…`, `Export…`, `<hr>`, `swap`, `Rename`, `<hr>`, `Delete map`. A test helper in `tests/browser/helpers.js`: `async function gearAction(page, name) { await page.getByLabel("Map settings").click(); await page.getByRole("button", { name }).click(); }`.

- [ ] **Step 1: Write the failing test**

```js
test("setup lives in the Map settings menu, in order, and players have no menu", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Gear");
  const mid = await makeMapWithPicture(page, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const corner = page.locator(".map-view .map-corner");
  await expect(corner.getByRole("button", { name: "GM only" })).toBeVisible();
  await page.getByLabel("Map settings").click();
  const menu = page.locator(".map-gear-menu");
  const names = await menu.locator("button:visible, label:visible").allTextContents();
  expect(names.map(t => t.trim())).toEqual(["Set scale…", "Scan for names…", "Export…", "Change picture", "Rename", "Delete map"]);   // no grid yet, so no opacity slider
  await menu.getByRole("button", { name: "Scale" }).click();
  await expect(page.getByRole("dialog", { name: "Set the scale" })).toBeVisible();
  await expect(menu).toBeHidden();
  await pp.goto(`index.html#/c/${cid}/maps/${mid}`);
  await expect(pp.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(pp.getByLabel("Map settings")).toHaveCount(0);
  await expect(pp.getByRole("button", { name: "GM only" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "Map settings menu"`
Expected: FAIL (`.map-corner` not found).

- [ ] **Step 3: Implement.** Build `scaleBtn` with text `Set scale…` and `aria-label` `Scale`; add `const scaleText = () => hasScale() ? ' · ' + G.fmtDistance(G.toMetres(map.grid_px || 1, map), system(), G.isSpace(map)) + (map.grid_px ? ' per square' : ' per px') : ''` and refresh the button's text in `syncTools()`. Compose `gear`'s menu as the Interfaces order with `el('hr')` separators and `opacityBox` after `Set scale…`. Append `el('div', { class: 'map-corner' }, secretBtn, gear)` to `stage`. Keep the existing close-on-click behaviour; the `opacityBox` slider must not close the menu (skip `label`/`input` in the click handler that sets `gear.open = false`).

- [ ] **Step 4: Update the tests that reach those controls.** Add `gearAction` to `helpers.js` and export it. In `maps.spec.js` replace each `getByRole("button", { name: "Scale" }).click()` and `getByRole("button", { name: "Export…" }).click()` with `gearAction(page, "Scale")` / `gearAction(page, "Export…")`. In `map-scan.spec.js` replace each `getByRole("button", { name: "Scan for names…" }).click()` with `gearAction(page, "Scan for names…")`; the two assertions that a player has no `Scan for names…` button stay as they are (players have no menu). In `map-styles.spec.js` do the same for any of the three.

- [ ] **Step 5: Style.** `.map-corner { position: absolute; top: 12px; right: 12px; z-index: 1002; display: flex; gap: 6px; }`; `.map-gear > summary` gets the overlay look and 32px height; `.map-gear-menu hr { border: 0; border-top: 1px solid var(--line); margin: 2px 4px; }`.

- [ ] **Step 6: Run the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups tokens`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add static/maps.js static/style.css tests/browser/helpers.js tests/browser/maps.spec.js tests/browser/map-scan.spec.js tests/browser/map-styles.spec.js
git commit -m "Maps: Set scale, Scan for names, Export and the grid opacity move into the ⚙ menu"
```

---

### Task 4: Panels float on the stage

**Files:**
- Modify: `static/maps.js` (`panelBox` placement; `openScale`, `pinForm`, `labelAt` are unchanged)
- Modify: `static/style.css` (`.map-panel-box`, `.map-panel`)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `stage`, `toolbar` (Tasks 1–2).
- Produces: `panelBox` (`div.map-panel-box`) is a child of `stage`, positioned under the toolbar; the panels inside keep `role="dialog"` and their names (`Set the scale`, `Add pin`, `Edit pin`).

- [ ] **Step 1: Write the failing test**

```js
test("the pin form opens on the map under the toolbar and scrolls inside the stage", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Panel");
  const mid = await makeMapWithPicture(page, cid);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage");
  await page.getByRole("button", { name: "Add pin" }).click();
  const canvas = stage.locator(".leaflet-container"), box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * 0.7, y: box.height * 0.6 } });
  const form = page.getByRole("dialog", { name: "Add pin" });
  await expect(form).toBeVisible();
  const s = await stage.boundingBox(), f = await form.boundingBox(), t = await stage.locator(".map-toolbar").boundingBox();
  expect(f.y).toBeGreaterThan(t.y + t.height);
  expect(f.x).toBeGreaterThanOrEqual(s.x);
  expect(f.y + f.height).toBeLessThanOrEqual(s.y + s.height + 1);   // it scrolls inside the stage rather than growing past it
  expect(f.width).toBeLessThanOrEqual(420);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "pin form opens on the map"`
Expected: FAIL (the form sits above the stage).

- [ ] **Step 3: Implement.** Append `panelBox` to `stage` after `toolbar`. CSS: `.map-panel-box { position: absolute; top: 56px; left: 12px; z-index: 1001; width: min(420px, calc(100% - 24px)); max-height: calc(100% - 68px); overflow: auto; }`; `.map-panel { margin: 0; }` with the overlay look (keep `background: var(--stock)` for the form's readability if the translucent panel reads badly over the picture: pick one and keep it for the three panels).

- [ ] **Step 4: Run the test and the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: the scale, pin and Quick label panels float on the map under the toolbar"
```

---

### Task 5: The drawer

**Files:**
- Modify: `static/maps.js` (`renderRoutes()` near lines 668–720; the `routeBox` placement)
- Modify: `static/style.css` (`.map-routes`, `.map-side-*`, `.map-route`, `.map-place`)
- Test: `tests/browser/map-styles.spec.js` (where the fold is already tested), `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `stage`.
- Produces: `routeBox` (`aside.map-routes`) is a child of `stage` with class `open` or `closed`; the fold button keeps its names and `aria-expanded`, has class `map-side-fold` and sits in `routeBox` as its first child; a search `input[type=search][aria-label="Find on this map"]`; `renderRoutes()` takes an optional `query` string it filters rows by, using `G.nameKey(row name).includes(G.nameKey(query))`.

- [ ] **Step 1: Write the failing test** in `maps.spec.js` (make three entry pins named `Boldhome`, `Jonstown`, `Wilmskirk` through `pin_save`, and one route):

```js
test("the drawer slides over the map without resizing it, and its search filters the rows", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Drawer");
  const mid = await makeMapWithPicture(page, cid);
  // …three pins and one route via api(page, "pin_save" / "route_save", …)
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const canvas = page.locator(".map-view .leaflet-container");
  const before = await canvas.boundingBox();
  await expect(page.locator(".map-routes")).toHaveClass(/open/);
  await page.getByRole("button", { name: "Hide routes and locations" }).click();
  await expect(page.locator(".map-routes")).toHaveClass(/closed/);
  expect((await canvas.boundingBox()).width).toBe(before.width);
  await page.getByRole("button", { name: "Show routes and locations" }).click();
  await page.getByLabel("Find on this map").fill("jons");
  await expect(page.locator(".map-place:visible")).toHaveCount(1);
  await expect(page.locator(".map-place:visible")).toContainText("Jonstown");
  await expect(page.locator(".map-route:visible")).toHaveCount(0);
  await page.getByLabel("Find on this map").fill("");
  await expect(page.locator(".map-place:visible")).toHaveCount(3);
  await page.reload();
  await expect(page.locator(".map-routes")).toHaveClass(/open/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "drawer slides"`
Expected: FAIL (no `open` class; folding changes the canvas width).

- [ ] **Step 3: Implement.** Append `routeBox` to `stage`. In `renderRoutes(query = '')`: set `routeBox.className = 'map-routes ' + (st.collapsed ? 'closed' : 'open')`; always render the fold first; when open, render the search input (value kept across redraws in a closure variable `drawerQuery`, `input` event calls `renderRoutes(drawerQuery)` with focus restored), then the two sections with rows filtered by the query. Drop the `host.closest('.map-body')?.classList.toggle('side-collapsed', …)` line and the `invalidateSize` call in the fold handler (the map's size doesn't change). Remove the `map-side-label` vertical text (the tab is enough).

- [ ] **Step 4: Style.** `.map-routes { position: absolute; top: 0; right: 0; bottom: 0; z-index: 1001; width: 300px; max-height: none; display: flex; flex-direction: column; gap: 0; transition: transform .2s; }` with the overlay look (no radius on the right); `.map-routes.closed { transform: translateX(100%); }`; `.map-side-fold { position: absolute; top: 72px; right: 100%; width: 28px; height: 88px; min-width: 0; border-radius: var(--radius) 0 0 var(--radius); }`; `.map-routes.closed .map-side-fold` stays visible (it is outside the translated box's visible area only if `overflow` is visible: set `.map-routes { overflow: visible }` and put the scrolling on an inner `div.map-side-list { flex: 1; overflow-y: auto; }`); `.map-route`, `.map-place { background: none; border: 0; border-radius: 0; padding: 6px 12px; }`; `.map-place:hover, .map-route:hover { background: color-mix(in srgb, var(--text) 7%, transparent); }`; drop `.map-body.side-collapsed` and `.map-routes.collapsed` rules.

- [ ] **Step 5: Run the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups`
Expected: all PASS (the fold's names are unchanged; `map-styles` already checks them).

- [ ] **Step 6: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: Routes and Locations become a drawer over the map's edge, with a search box"
```

---

### Task 6: Labels by zoom, the Labels toggle and the selected pin

**Files:**
- Modify: `static/maps.js` (`marker()` for the selected class; `one()`: `labelsBtn`, `baseZoom`, a `zoomend` handler)
- Modify: `static/style.css` (`.map-marker-label` visibility rules)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `labelsBtn` (Task 2), `stage`.
- Produces: `stage` classes `labels-on` and `zoomed-in`; marker node class `selected` while its popup is open; `labelsWanted()` reads `localStorage['chronicle-map-labels-{cid}-{id}'] === '1'`.

- [ ] **Step 1: Write the failing test** (two entry pins, `Burnt Ford` and `Mirewood`, and a party group placed on the map through `group_move`):

```js
test("pin labels show by zoom, hover, selection and the Labels toggle; the party is always labelled", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Labels");
  const mid = await makeMapWithPicture(page, cid);
  // …two pins via pin_save, the party via group_move onto this map
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const label = page.locator(".map-pin", { hasText: "Burnt Ford" }).locator(".map-marker-label");
  await expect(label).toHaveCSS("opacity", "0");
  await expect(page.locator(".map-party .map-marker-label")).toHaveCSS("opacity", "1");
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).hover();
  await expect(label).toHaveCSS("opacity", "1");
  await page.mouse.move(5, 5);
  await expect(label).toHaveCSS("opacity", "0");
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await expect(page.locator(".map-pin.selected")).toHaveCount(1);
  await expect(label).toHaveCSS("opacity", "1");
  await page.locator(".leaflet-popup-close-button").click();
  await expect(page.locator(".map-pin.selected")).toHaveCount(0);
  const zoomIn = page.locator(".leaflet-control-zoom-in");
  await zoomIn.click(); await zoomIn.click();
  await expect(page.locator(".map-stage")).toHaveClass(/zoomed-in/);
  await expect(label).toHaveCSS("opacity", "1");
  await page.locator(".leaflet-control-zoom-out").click(); await page.locator(".leaflet-control-zoom-out").click();
  await expect(page.locator(".map-stage")).not.toHaveClass(/zoomed-in/);
  await page.getByRole("button", { name: "Labels" }).click();
  await expect(page.getByRole("button", { name: "Labels" })).toHaveAttribute("aria-pressed", "true");
  await expect(label).toHaveCSS("opacity", "1");
  await page.reload();
  await expect(page.getByRole("button", { name: "Labels" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-pin", { hasText: "Mirewood" }).locator(".map-marker-label")).toHaveCSS("opacity", "1");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "labels show by zoom"`
Expected: FAIL (every label has opacity 1).

- [ ] **Step 3: Implement.** In `marker()`, when `onOpen` is given: `m.on('popupopen', () => node.classList.add('selected')); m.on('popupclose', () => node.classList.remove('selected'));`. In `one()` after `fitBounds`: `const baseZoom = lmap.getZoom(); const syncZoom = () => stage.classList.toggle('zoomed-in', lmap.getZoom() >= baseZoom + 1.5); lmap.on('zoomend', syncZoom); syncZoom();` and recompute `baseZoom` in the `requestAnimationFrame` refit. `labelsBtn`'s handler flips the stored flag and calls `syncLabels = () => { stage.classList.toggle('labels-on', labelsWanted()); labelsBtn.setAttribute('aria-pressed', String(labelsWanted())); }`, called once at mount. `Escape` closing an open card is Task 7's keydown listener; this task does not add one.

- [ ] **Step 4: Style.** `.map-marker-label { opacity: 0; pointer-events: none; transition: opacity .12s; }` then `.map-stage.labels-on .map-marker-label, .map-stage.zoomed-in .map-marker-label, .map-marker:hover .map-marker-label, .map-marker:focus-within .map-marker-label, .map-marker.selected .map-marker-label, .map-party .map-marker-label { opacity: 1; }`. Give `.map-marker-label` the overlay look at `font: 700 .72rem/1.3 var(--body)`.

- [ ] **Step 5: Run the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups tokens`
Expected: all PASS. The existing `toContainText("Our camp")` assertions still pass: the text is in the DOM.

- [ ] **Step 6: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: pin labels show by zoom, on hover, when selected or with the Labels toggle; the party is always labelled"
```

---

### Task 7: Legend and keyboard shortcuts

**Files:**
- Modify: `static/maps.js` (`one()`: `legend` element; one `document` keydown listener with an `AbortController`, aborted on `hashchange`)
- Modify: `static/style.css` (`.map-legend`, and `.map-scale`'s place above it)
- Test: `tests/browser/maps.spec.js`

**Interfaces:**
- Consumes: `addPinBtn`, `labelBtn`, `measureBtn`, `partyBtn`, `closePanel()`, `syncTools()`, `lf`.
- Produces: `div.map-legend[aria-label="Legend"]` with five `span.map-legend-item`; `keys(ev)` handler: ignores events whose target matches `input, textarea, select, [contenteditable="true"]` or when `document.querySelector('dialog[open]')` exists; `p` clicks `addPinBtn`, `l` `labelBtn`, `m` `measureBtn`, `t` `partyBtn` (each only if present and not hidden); `Escape` closes an open popup, else leaves the mode via the same code the pressed button runs.

- [ ] **Step 1: Write the failing test**

```js
test("a legend sits bottom-left, and P, L, M, T and Escape drive the modes except while typing", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Keys");
  const mid = await makeMapWithPicture(page, cid);
  // …one pin via pin_save, so the drawer (and its search box) is shown
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const legend = page.getByLabel("Legend");
  await expect(legend.locator(".map-legend-item")).toHaveText(["📍 Place", "📅 Event", "📝 Note", "🚩 Party", "GM only"]);
  const s = await page.locator(".map-stage").boundingBox(), g = await legend.boundingBox();
  expect(g.x - s.x).toBeLessThan(40); expect(s.y + s.height - (g.y + g.height)).toBeLessThan(40);
  await page.keyboard.press("p");
  await expect(page.getByRole("button", { name: "Add pin" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Add pin" })).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Find on this map").fill("");
  await page.getByLabel("Find on this map").press("p");
  await expect(page.getByLabel("Find on this map")).toHaveValue("p");
  await expect(page.getByRole("button", { name: "Add pin" })).toHaveAttribute("aria-pressed", "false");
  await page.goto(`index.html#/c/${cid}/maps`);
  await expect(page.locator(".map-grid, .map-list-head")).toBeVisible();
  await page.keyboard.press("m");   // the listener is gone with the page: nothing to assert but no error
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await expect(page.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(page.getByRole("button", { name: "Measure/Route" })).toHaveAttribute("aria-pressed", "false");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=chromium maps -g "legend sits bottom-left"`
Expected: FAIL (no Legend).

- [ ] **Step 3: Implement.** `const legend = el('div', { class: 'map-legend', 'aria-label': 'Legend' }, ['📍 Place', '📅 Event', '📝 Note', '🚩 Party'].map(t => el('span', { class: 'map-legend-item' }, t)), el('span', { class: 'map-legend-item' }, el('i', { class: 'map-legend-gm', 'aria-hidden': 'true' }), 'GM only'));` appended to `stage`. Move the scale bar: give the Leaflet scale control `position: 'bottomleft'` is already so; add CSS so `.map-legend` sits below it (`bottom: 12px`) and `.leaflet-bottom.leaflet-left` gets `margin-bottom: 44px`. Keyboard: `const keys = new AbortController(); document.addEventListener('keydown', ev => { … }, { signal: keys.signal }); window.addEventListener('hashchange', () => keys.abort(), { once: true });` placed next to the gear's document listener so both go together. Mention the keys in the four buttons' `data-tip` text: append ` (P)`, ` (L)`, ` (M)`, ` (T)`.

- [ ] **Step 4: Style.** `.map-legend { position: absolute; left: 12px; bottom: 12px; z-index: 1001; display: flex; gap: 12px; padding: 5px 10px; font-size: .78rem; }` with the overlay look; `.map-legend-gm { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border: 2px dashed var(--text); border-radius: 50%; vertical-align: -1px; }`; `.map-stage .leaflet-bottom.leaflet-left { margin-bottom: 44px; }`.

- [ ] **Step 5: Run the map suite**

Run: `cd tests && npx playwright test --project=chromium maps map-styles map-scan party-groups tokens`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add static/maps.js static/style.css tests/browser/maps.spec.js
git commit -m "Maps: a legend bottom-left, and P, L, M, T and Escape drive the modes"
```

---

### Task 8: The phone layout

**Files:**
- Modify: `static/style.css` (a `@media (max-width: 720px)` block for `.map-toolbar`, `.map-routes`, `.map-side-fold`, `.map-panel-box`, `.map-legend`; a `(pointer: coarse)` block for 44px targets)
- Test: `tests/browser/maps.spec.js` (a test that runs only on the mobile projects)

**Interfaces:**
- Consumes: the classes from Tasks 2–7.
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

```js
test("on a phone the toolbar is icons only and the drawer is a bottom sheet that leaves an open card usable", async ({ page, browser }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "phone layout");
  const { cid } = await setup(page, browser, "Phone");
  const mid = await makeMapWithPicture(page, cid);
  // …one pin named "Burnt Ford" via pin_save
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const pin = page.getByRole("button", { name: "Add pin" });
  await expect(pin).toBeVisible();
  expect((await pin.boundingBox()).width).toBeLessThan(56);
  expect((await pin.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(pin.locator(".map-tool-word")).toBeHidden();
  const stage = await page.locator(".map-stage").boundingBox(), drawer = await page.locator(".map-routes").boundingBox();
  expect(drawer.width).toBeGreaterThanOrEqual(stage.width - 1);
  expect(drawer.height).toBeLessThanOrEqual(stage.height * 0.5);
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).tap();
  const card = page.locator(".leaflet-popup");
  await expect(card).toBeVisible();
  const c = await card.boundingBox();
  expect(c.y + c.height).toBeLessThanOrEqual(drawer.y + 1);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd tests && npx playwright test --project=mobile-chrome maps -g "on a phone"`
Expected: FAIL (the button still shows its word; the drawer is 300px wide).

- [ ] **Step 3: Style.** In `@media (max-width: 720px)`: `.map-tool-word { display: none; }`; `.map-toolbar .small { width: 44px; height: 44px; padding: 0; justify-content: center; }`; `.map-toolbar { left: 12px; top: 56px; }` (under the zoom control instead of beside it); `.map-routes { top: auto; left: 0; width: 100%; height: 45%; border-left: 0; border-top: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; }`; `.map-routes.closed { transform: translateY(100%); }`; `.map-side-fold { top: auto; right: 12px; bottom: 100%; width: 88px; height: 28px; border-radius: var(--radius) var(--radius) 0 0; }`; `.map-panel-box { width: calc(100% - 24px); top: 108px; }`; `.map-legend { display: none; }` (the drawer's rows carry the icons). Leaflet opens a popup above its marker and pans the map to show it; when the drawer is open the popup can still land under the sheet: on `popupopen`, when the window is 720px or narrower and the drawer is open, call `lmap.panBy([0, drawerHeight / 2])`. In `(pointer: coarse)`: `.map-side-fold { min-height: 44px; }`.

- [ ] **Step 4: Run the mobile and desktop suites**

Run: `cd tests && npx playwright test --project=mobile-chrome --project=mobile-safari maps touch && npx playwright test --project=chromium maps map-styles`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add static/style.css static/maps.js tests/browser/maps.spec.js
git commit -m "Maps on a phone: icon toolbar, the drawer as a bottom sheet"
```

---

### Task 9: Docs and the full run

**Files:**
- Modify: `README.md` (the Maps paragraph under "Using it")
- Modify: `tests/README.md` (the `maps` entry)

- [ ] **Step 1: Update README's Maps paragraph** to describe the page as the spec does: the map fills the window; the toolbar's two groups with the keys P, L, M, T; Labels; ⚙ for Set scale, Scan for names, Export, Change picture, Rename and Delete; the drawer with its search; labels by zoom; the legend; the phone's bottom sheet.

- [ ] **Step 2: Update tests/README's `maps` entry** with one clause per new test from Tasks 1–8.

- [ ] **Step 3: Run every project on the map suites**

Run: `cd tests && npx playwright test maps map-styles map-scan party-groups tokens touch`
Expected: all PASS on chromium, firefox, webkit, mobile-safari, mobile-chrome and ipad.

- [ ] **Step 4: Commit**

```bash
git add README.md tests/README.md
git commit -m "Maps: document the new layout"
```
