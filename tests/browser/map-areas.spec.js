// Areas on maps: a GM draws an outline (a kingdom, a forest, a district), names it, ties it to an Encyclopedia entry
// and a weather region. Players see the ones that aren't GM only. A group of the party moved inside an area that is
// a weather region takes that region, and the campaign does too for the main group; where areas overlap, the
// smallest wins.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, mapWithPicture, newContext, closeContexts, moreIn, sql } = require("./helpers");
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
const mapOf = async (page, cid, id) => (await page.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id })}`)).json();
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("areas: a fresh install has the table; GMs save and delete them, checked; players see only what they may", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Areas API");
  expect(sql("SHOW TABLES LIKE 'map_areas'").trim()).not.toBe("");
  const map = await mapWithPicture(page, cid);
  const beta = (await api(page, "region_save", { name: "Beta" }, cid)).json.id;
  const secretEntry = (await api(page, "entry_save", { name: "The Hidden Vale", category: "location", is_secret: true }, cid)).json.id;

  // checked: too few points, no name, a stranger's region, and players can't save
  expect((await api(page, "area_save", { map_id: map, name: "Line", points: [[1, 1], [5, 5]] }, cid)).status).toBe(400);
  expect((await api(page, "area_save", { map_id: map, name: " ", points: square(0, 0, 10, 10) }, cid)).status).toBe(400);
  expect((await api(page, "area_save", { map_id: map, name: "Nowhere", points: square(0, 0, 10, 10), region_id: 999999 }, cid)).status).toBeGreaterThanOrEqual(400);
  expect((await api(pp, "area_save", { map_id: map, name: "Mine", points: square(0, 0, 10, 10) }, cid)).status).toBe(403);

  const r = await api(page, "area_save", { map_id: map, name: "Reikland", points: square(0, 0, 300, 200), color: "#2e7d32", region_id: beta }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.area).toMatchObject({ name: "Reikland", color: "#2e7d32", region_id: beta, is_secret: false, entry_id: null });
  expect(r.json.area.points).toHaveLength(4);
  const vale = (await api(page, "area_save", { map_id: map, name: "The Hidden Vale", points: square(10, 10, 60, 60), entry_id: secretEntry }, cid)).json.area;
  const lair = (await api(page, "area_save", { map_id: map, name: "Lair", points: square(200, 100, 250, 150), is_secret: true }, cid)).json.area;

  // the GM sees all three, the biggest first; a player sees only Reikland (Lair is GM only, the Vale's entry is)
  expect((await mapOf(page, cid, map)).areas.map(a => a.name)).toEqual(["Reikland", "The Hidden Vale", "Lair"]);
  expect((await mapOf(pp, cid, map)).areas.map(a => a.name)).toEqual(["Reikland"]);
  expect((await api(pp, "campaign", undefined, cid)).json.areas_index.map(a => a.name)).toEqual(["Reikland"]);
  // revealing Lair shows it; an edit keeps what it isn't sent
  expect((await api(page, "item_reveal", { kind: "area", id: lair.id }, cid)).status).toBe(200);
  expect((await mapOf(pp, cid, map)).areas.map(a => a.name)).toContain("Lair");
  const ed = await api(page, "area_save", { id: vale.id, name: "The Vale" }, cid);
  expect(ed.json.area).toMatchObject({ name: "The Vale", entry_id: secretEntry });
  expect(ed.json.area.points).toEqual(vale.points);
  expect((await api(page, "area_delete", { id: lair.id }, cid)).status).toBe(200);
  expect((await mapOf(page, cid, map)).areas.map(a => a.name)).toEqual(["Reikland", "The Vale"]);
  expectNoErrors(errors);
});

test("areas: the party moved into an area that is a weather region takes it, the smallest winning", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Areas weather");
  const map = await mapWithPicture(page, cid);
  const beta = (await api(page, "region_save", { name: "Beta" }, cid)).json.id;
  const gamma = (await api(page, "region_save", { name: "Gamma" }, cid)).json.id;
  await api(page, "area_save", { map_id: map, name: "Reikland", points: square(0, 0, 300, 200), region_id: beta }, cid);
  await api(page, "area_save", { map_id: map, name: "Altdorf", points: square(50, 50, 150, 150), region_id: gamma }, cid);
  await api(page, "area_save", { map_id: map, name: "Old forest", points: square(60, 60, 80, 80) }, cid);   // no region: ignored
  const g = (await api(page, "groups", undefined, cid)).json.groups.find(x => x.is_main);
  const current = async () => (await api(page, "campaign", undefined, cid)).json.campaign.settings.current_region;

  let m = await api(page, "group_move", { id: g.id, map_id: map, x: 70, y: 70 }, cid);
  expect(m.json.entered).toEqual({ area: "Altdorf", region: "Gamma", region_id: gamma });
  expect(await current()).toBe(gamma);
  m = await api(page, "group_move", { id: g.id, map_id: map, x: 250, y: 30 }, cid);
  expect(m.json.entered).toMatchObject({ area: "Reikland", region_id: beta });
  expect(await current()).toBe(beta);
  // a move within the same region says nothing
  expect((await api(page, "group_move", { id: g.id, map_id: map, x: 260, y: 40 }, cid)).json.entered).toBeNull();
  // a region picked by hand (Travel's Arrive in) wins
  expect((await api(page, "group_move", { id: g.id, map_id: map, x: 100, y: 100, keep_region: true }, cid)).json.entered).toBeNull();
  expect(await current()).toBe(beta);

  // the area's card says which weather it brings
  await page.goto(`#/c/${cid}/maps/${map}?area=${(await mapOf(page, cid, map)).areas.find(a => a.name === "Altdorf").id}`);
  const card = page.locator(".map-area-card");
  await expect(card).toContainText("Altdorf");
  await expect(card).toContainText("Weather: Gamma");
  expectNoErrors(errors);
});

test("areas: a GM draws one on the map, names it and ties it to an entry, which links back; Search finds it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Areas draw");
  const map = await mapWithPicture(page, cid);
  const entry = (await api(page, "entry_save", { name: "Sylvania", category: "location" }, cid)).json.id;
  await page.goto(`#/c/${cid}/maps/${map}`);
  const stage = page.locator(".map-view .leaflet-container");
  await expect(page.locator(".map-view img.leaflet-image-layer")).toBeVisible();
  await page.getByRole("button", { name: "Draw area" }).click();
  const box = await stage.boundingBox();
  const at = (dx, dy) => stage.click({ position: { x: box.width / 2 + dx, y: box.height / 2 + dy } });
  await at(-40, -30); await at(40, -30); await at(40, 30); await at(-40, 30);
  await at(-40, -30);   // the first corner again closes it
  const d = page.getByRole("dialog", { name: "Save area" });
  await d.getByLabel("Area name").fill("Sylvania");
  await expect(d.getByLabel("Encyclopedia entry")).toHaveValue(String(entry));   // picked by its name
  await d.getByRole("button", { name: "Save area" }).click();
  await expect(page.locator("#toast")).toContainText("Area saved");
  await expect(page.locator(".map-area-label")).toContainText("Sylvania");
  const saved = (await mapOf(page, cid, map)).areas;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ name: "Sylvania", entry_id: entry });
  expect(saved[0].points).toHaveLength(4);

  // its card, from a click on it
  await stage.click();   // the middle of the stage, inside it
  await expect(page.locator(".map-area-card")).toContainText("Sylvania");
  // made GM only from the card's menu, and players lose it
  await moreIn(page.locator(".map-area-card"), "GM only");
  await expect(page.locator("#toast")).toContainText("GM only");
  expect((await mapOf(pp, cid, map)).areas).toHaveLength(0);

  // the entry's page links to the map with the area in view; Ctrl K finds it
  await page.goto(`#/c/${cid}/encyclopedia/${entry}`);
  await page.reload();
  const link = page.getByRole("link", { name: /An area on: Sartar/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator(".map-area-card")).toContainText("Sylvania");
  // and the search page finds the area by its name, under Maps
  await page.goto(`#/c/${cid}/search?q=sylvania`);
  await expect(page.locator(".search-results")).toContainText("Sylvania · area on Sartar");
  expectNoErrors(errors);
});
