// Maps, phase 3 (issue #112's follow-ups): pins with their own icon and colour, locked in place; routes with their own
// colour and line, starting and ending at pins; the side panel's Routes and Locations, folding away; the party put
// anywhere on the map, and a new location where it stands; the grid's opacity; the ⚙ menu.
const { test, expect } = require("@playwright/test");
const { openDrawer, gearAction, watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, mapWithPicture, settledBox, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

async function setup(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
async function clickPic(page, fx, fy) {
  await page.locator(".map-view .leaflet-container").scrollIntoViewIfNeeded();
  const box = await settledBox(page.locator(".map-view .leaflet-image-layer"));
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}
const pinForm = page => page.getByRole("dialog", { name: "Add pin" });

test("Map pins: a GM's new pin starts as an Encyclopedia entry, with an icon and colour, and shows under Locations", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Pin styles");
  const mapId = await mapWithPicture(page, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Add pin", exact: true }).click();
  await clickPic(page, 0.4, 0.4);
  await expect(pinForm(page).getByRole("button", { name: "Encyclopedia entry" })).toHaveAttribute("aria-pressed", "true");
  await expect(pinForm(page).getByLabel("Entry name")).toBeFocused();
  await pinForm(page).getByText("Icon and colour").click();
  await pinForm(page).getByRole("button", { name: "Castle" }).click();
  await pinForm(page).getByRole("button", { name: "Red" }).click();
  await pinForm(page).getByLabel("Entry name").fill("Boldhome");
  await expect(pinForm(page).getByRole("button", { name: "Castle" })).toHaveAttribute("aria-pressed", "true");
  await expect(pinForm(page).getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "true");
  const sent = page.waitForRequest(r => r.url().includes("a=pin_save"));
  await pinForm(page).getByRole("button", { name: "New entry here" }).click();
  const body = (await sent).postDataJSON();
  expect([body.kind, body.icon, body.color]).toEqual(["entry", "🏰", "#d64541"]);
  const pin = page.locator(".map-pin", { hasText: "Boldhome" });
  await expect(pin.locator(".map-marker-icon")).toHaveText("🏰");
  await expect(pin).toHaveClass(/has-colour/);
  await expect(pin.locator(".map-marker-icon")).toHaveClass(/tinted/);   // the icon itself takes the colour, no disc behind it
  const p = (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json()).pins[0];
  expect([p.kind, p.icon, p.color, p.is_locked]).toEqual(["entry", "🏰", "#d64541", false]);

  // the side panel lists it under Locations; a player sees it there too
  const side = page.getByRole("complementary", { name: "Routes" });
  await openDrawer(page);
  await expect(side.locator(".map-place")).toHaveText(["🏰Boldhome"]);
  await side.locator(".map-place", { hasText: "Boldhome" }).click();
  await expect(page.locator(".leaflet-popup")).toContainText("Boldhome");
  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await openDrawer(pp);
  await expect(pp.locator(".map-place", { hasText: "Boldhome" })).toBeVisible();
  await pp.getByRole("button", { name: "Hide routes and locations" }).click();   // out of the way of the picture (on a phone, a sheet over it)
  // a player's own pin is still a note, with no kinds to pick
  await pp.getByRole("button", { name: "Add pin", exact: true }).click();
  await clickPic(pp, 0.7, 0.7);
  await expect(pinForm(pp).getByLabel("Label")).toBeVisible();
  await expect(pinForm(pp).getByRole("button", { name: "Encyclopedia entry" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Map pins: a locked pin can't be dragged or moved until it is unlocked", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Pin lock");
  const mapId = await mapWithPicture(page, cid);
  const id = (await api(page, "pin_save", { map_id: mapId, x: 150, y: 100, kind: "note", label: "Ford" }, cid)).json.pin.id;
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.locator(".map-pin", { hasText: "Ford" }).click();
  await page.locator(".leaflet-popup").getByRole("button", { name: "Lock" }).click();
  await expect(page.locator("#toast")).toContainText("Pin locked in place");
  await expect(page.locator(".map-pin.locked")).toHaveCount(1);
  expect((await api(page, "pin_save", { id, x: 10, y: 10 }, cid)).status).toBe(409);
  // dragging it does nothing
  const box = await page.locator(".map-pin", { hasText: "Ford" }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 40, { steps: 6 }); await page.mouse.up();
  const after = (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json()).pins[0];
  expect([after.x, after.y, after.is_locked]).toEqual([150, 100, true]);
  // unlocked and moved in one save is fine
  const r = await api(page, "pin_save", { id, is_locked: false, x: 20, y: 30 }, cid);
  expect([r.status, r.json.pin.x, r.json.pin.is_locked]).toEqual([200, 20, false]);
  expect((await api(page, "pin_save", { id, color: "red" }, cid)).status).toBe(400);
  expectNoErrors(errors);
});

test("Map routes: a colour and a line of their own, and start and end pins; the side panel folds away", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Route styles");
  const mapId = await mapWithPicture(page, cid, { scale_per_px: 0.1, scale_unit: "mi" });
  await api(page, "pin_save", { map_id: mapId, x: 20, y: 180, kind: "note", label: "Jonstown" }, cid);
  await api(page, "pin_save", { map_id: mapId, x: 280, y: 20, kind: "note", label: "Wilmskirk" }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Measure/Route" }).click();
  await clickPic(page, 0.3, 0.5);
  await clickPic(page, 0.6, 0.5);
  await page.getByRole("button", { name: "Save route…" }).click();
  const d = page.getByRole("dialog", { name: "Save route" });
  await expect(d.getByLabel("Starts at")).toHaveValue("");   // no pin near its start
  await d.getByLabel("Route name").fill("Jonstown road");
  await d.getByLabel("Route colour").selectOption({ label: "Blue" });
  await d.getByLabel("Line").selectOption("dotted");
  await d.getByLabel("Starts at").selectOption({ label: "📝 Jonstown" });
  await d.getByLabel("Ends at").selectOption({ label: "📝 Wilmskirk" });
  await d.getByRole("button", { name: "Save route" }).click();
  const row = page.locator(".map-route", { hasText: "Jonstown road" });
  await expect(row.locator(".map-route-ends")).toHaveText("Jonstown → Wilmskirk");
  await expect(page.locator("path.map-route-line")).toHaveAttribute("stroke", "#3a7bd5");
  await expect(page.locator("path.map-route-line")).toHaveAttribute("stroke-dasharray", "1 7");
  let route = (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json()).routes[0];
  // both ends were far from the pins, so the route is drawn on to each
  expect([route.color, route.dash, route.points.length, route.points[0], route.points[3]]).toEqual(["#3a7bd5", "dotted", 4, [20, 180], [280, 20]]);

  await openDrawer(page);
  await row.getByRole("button", { name: "Edit" }).click();
  const e = page.getByRole("dialog", { name: "Edit the route" });
  await expect(e.getByLabel("Starts at")).toHaveValue(/\d+/);   // now found at its end
  await e.getByLabel("Line").selectOption("solid");
  await e.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("path.map-route-line")).not.toHaveAttribute("stroke-dasharray", /./);
  route = (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json()).routes[0];
  expect([route.dash, route.points.length]).toEqual(["solid", 4]);
  expect((await api(page, "route_save", { id: route.id, dash: "wavy" }, cid)).status).toBe(400);

  // the drawer slides away to the right, and stays away after a reload; its sections fold too
  const side = page.getByRole("complementary", { name: "Routes" });
  await openDrawer(page);
  await side.locator("summary", { hasText: "Locations" }).click();
  await expect(side.locator(".map-place").first()).toBeHidden();
  await side.getByRole("button", { name: "Hide routes and locations" }).click();
  await expect(side).toHaveClass(/closed/);
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Routes" })).toHaveClass(/closed/);
  await page.getByRole("button", { name: "Show routes and locations" }).click();
  await expect(page.locator(".map-route", { hasText: "Jonstown road" })).toBeVisible();
  await expect(page.locator(".map-place").first()).toBeHidden();   // Locations stayed folded
  expectNoErrors(errors);
});

test("Map party: a GM puts the party anywhere, then pins a new location where it stands", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Party anywhere");
  const mapId = await mapWithPicture(page, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Place party" }).click();
  await clickPic(page, 0.5, 0.25);
  await expect(page.locator("#toast")).toContainText("The party moved");
  await expect(page.locator(".map-party")).toHaveCount(1);
  const g = (await api(page, "groups", undefined, cid)).json.groups[0];
  expect(g.map_id).toBe(mapId);
  expect(Math.abs(g.x - 150)).toBeLessThan(8);
  expect(Math.abs(g.y - 50)).toBeLessThan(8);
  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(pp.locator(".map-party")).toHaveCount(1);
  await expect(pp.getByRole("button", { name: "Place party" })).toHaveCount(0);

  await page.locator(".map-party").click();
  await page.locator(".leaflet-popup").getByRole("button", { name: "New location here" }).click();
  await pinForm(page).getByLabel("Entry name").fill("Nameless shrine");
  await pinForm(page).getByRole("button", { name: "New entry here" }).click();
  await expect(page.locator(".map-pin", { hasText: "Nameless shrine" })).toBeVisible();
  const pin = (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${mapId}`)).json()).pins[0];
  expect([pin.kind, pin.x, pin.y]).toEqual(["entry", g.x, g.y]);
  expectNoErrors(errors);
});

test("Map tools: the grid's opacity is each person's own, and the ⚙ menu holds picture, rename and delete", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Grid opacity");
  const mapId = await mapWithPicture(page, cid, { grid_px: 20, scale_per_px: 0.25, scale_unit: "ft", grid_shown: true });
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  const slider = page.getByLabel("Grid opacity");
  await expect(slider).toBeHidden();   // it is in the ⚙ menu
  await page.getByLabel("Map settings").click();
  await expect(slider).toBeVisible();
  await slider.fill("40");
  await expect(page.locator(".map-gear-menu")).toBeVisible();   // moving the slider leaves the menu open
  await expect(page.locator(".map-grid")).toHaveCSS("opacity", "0.4");
  await page.reload();
  await expect(page.locator(".map-grid")).toHaveCSS("opacity", "0.4");
  await page.getByRole("button", { name: "Grid", exact: true }).click();   // hidden: no slider
  await page.getByLabel("Map settings").click();
  await expect(page.getByLabel("Grid opacity")).toBeHidden();
  await page.getByLabel("Map settings").click();

  await expect(page.getByRole("button", { name: "Delete map" })).toBeHidden();
  await page.getByLabel("Map settings").click();
  const menu = page.locator(".map-gear-menu");
  await expect(menu.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Delete map" })).toBeVisible();
  await expect(menu.getByText("Change picture")).toBeVisible();
  await page.locator(".map-head h2").click();   // a click elsewhere closes it
  await expect(menu).toBeHidden();
  expectNoErrors(errors);
});

test("Map pins: the badge follows the campaign's genre, and the pin card is slim with its kind and who added it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Pin genre");
  const mapId = await mapWithPicture(page, cid);
  await api(page, "pin_save", { map_id: mapId, x: 150, y: 100, kind: "note", label: "Ford" }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".map-stage")).toHaveClass(/map-genre-(fantasy|modern|scifi)/);
  const pin = page.locator(".map-pin", { hasText: "Ford" });
  const badge = async () => pin.evaluate(el => getComputedStyle(el.querySelector(".map-marker-icon")).filter);
  const before = await badge();
  await page.locator(".map-stage").evaluate(el => { el.className = "map-stage map-genre-fantasy"; });
  const fantasy = await badge();
  await page.locator(".map-stage").evaluate(el => { el.className = "map-stage map-genre-modern"; });
  expect(await badge()).not.toBe(fantasy);
  expect(before).toBeTruthy();
  await pin.click();
  const card = page.locator(".leaflet-popup .mpc-head");
  await expect(card).toContainText("Ford");
  await expect(card.locator(".mpc-sub")).toContainText("Note");
  expect((await page.locator(".leaflet-popup-content-wrapper").boundingBox()).width).toBeLessThan(330);
  expectNoErrors(errors);
});

test("Map settings: the GM can delete all of a map's pins, or all of its routes, and a player can't", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Map clear");
  const mapId = await mapWithPicture(page, cid);
  const other = await mapWithPicture(page, cid);
  for (const [x, y, label] of [[50, 50, "Ford"], [90, 60, "Keep"]]) await api(page, "pin_save", { map_id: mapId, x, y, kind: "note", label }, cid);
  await api(page, "pin_save", { map_id: other, x: 50, y: 50, kind: "note", label: "Elsewhere" }, cid);
  await api(page, "route_save", { map_id: mapId, name: "Road", points: [[10, 10], [80, 80]] }, cid);
  const state = async id => (await (await page.request.get(`api/index.php?a=map&cid=${cid}&id=${id}`)).json());
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".map-pin")).toHaveCount(2);

  await gearAction(page, "Delete all pins…");
  await page.getByRole("button", { name: "Delete 2 pins" }).click();
  await expect(page.locator(".map-pin")).toHaveCount(0);
  expect((await state(mapId)).pins).toHaveLength(0);
  expect((await state(mapId)).routes).toHaveLength(1);   // routes untouched
  expect((await state(other)).pins).toHaveLength(1);     // and so are other maps

  await gearAction(page, "Delete all routes…");
  await page.getByRole("button", { name: "Delete 1 route" }).click();
  await expect.poll(async () => (await state(mapId)).routes.length).toBe(0);

  expect((await api(pp, "map_clear", { map_id: other, pins: true, routes: true }, cid)).status).toBe(403);
  expect((await state(other)).pins).toHaveLength(1);
  expectNoErrors(errors);
});
