// Small finishes on the maps: Reveal (and log it) for a GM-only map, pin or route; pins found by their label in the
// search page and Ctrl K; an entry's pin opens the entry's editor over the map; and a place with no pin of its own
// offers the map the place it is inside sits on, with Pin it there for a GM.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, makePng, newContext, closeContexts, moreIn } = require("./helpers");
test.afterEach(closeContexts);

const MAP_PNG = makePng(300, 200);
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
async function mapWithPicture(page, cid, name, extra = {}) {
  const id = (await api(page, "map_save", { name, ...extra }, cid)).json.map.id;
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?${new URLSearchParams({ a: "file_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "map", parent_id: String(id), file: { name: "map.png", mimeType: "image/png", buffer: MAP_PNG } },
  });
  const up = await res.json();
  expect((await api(page, "map_save", { id, image_id: up.file.id }, cid)).status).toBe(200);
  return id;
}
const events = async (page, cid) => (await api(page, "events", undefined, cid)).json.events;

test("a GM reveals a GM-only map, pin or route, logged as an event or quietly; players can't", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Map reveal");
  const map = await mapWithPicture(page, cid, "Under the keep", { is_secret: true });
  const pin = (await api(page, "pin_save", { map_id: map, x: 100, y: 80, kind: "note", label: "Hidden stair", is_secret: true }, cid)).json.pin;
  const route = (await api(page, "route_save", { map_id: map, name: "Smugglers' path", points: [{ x: 10, y: 10 }, { x: 200, y: 150 }], is_secret: true }, cid)).json.route;
  // players are refused, and see none of it
  expect((await api(pp, "item_reveal", { kind: "map", id: map }, cid)).status).toBe(403);
  expect((await api(pp, "maps", undefined, cid)).json.maps.map(m => m.id)).not.toContain(map);
  // the API: the map logged, the route quietly; revealing twice is refused
  const r = await api(page, "item_reveal", { kind: "map", id: map, log: true }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((await events(page, cid)).find(e => e.id === r.json.event_id)).toMatchObject({ title: "Revealed: the map Under the keep" });
  expect((await api(page, "item_reveal", { kind: "map", id: map }, cid)).status).toBe(409);
  expect((await api(page, "item_reveal", { kind: "route", id: route.id }, cid)).json.event_id).toBeNull();
  let seen = await (await pp.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: map })}`)).json();
  expect(seen.routes.map(x => x.name)).toEqual(["Smugglers' path"]);
  expect(seen.pins).toHaveLength(0);

  // the pin, from its card: GM only asks Reveal and log it
  await page.goto(`#/c/${cid}/maps/${map}?pin=${pin.id}`);
  const card = page.locator(".map-pin-card");
  await expect(card).toContainText("Hidden stair");
  await moreIn(card, "GM only");
  const ask = page.getByRole("dialog", { name: "Show this pin to the players?" });
  await expect(ask).toContainText('The pin "Hidden stair" stops being GM only');
  await ask.getByRole("button", { name: "Reveal and log it today" }).click();
  await expect(page.locator("#toast")).toContainText("Revealed, and logged");
  expect((await events(page, cid)).map(e => e.title)).toContain("Revealed: Hidden stair on Under the keep");
  seen = await (await pp.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: map })}`)).json();
  expect(seen.pins.map(x => x.label)).toEqual(["Hidden stair"]);
  // making it GM only again asks nothing
  await page.reload();
  await moreIn(page.locator(".map-pin-card"), "GM only");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await (await pp.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: map })}`)).json()).pins.length).toBe(0);
  expectNoErrors(errors);
});

test("pins are found by their label in Search and Ctrl K, GM-only ones by GMs only", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Map search");
  const map = await mapWithPicture(page, cid, "Reikland");
  const well = (await api(page, "pin_save", { map_id: map, x: 50, y: 50, kind: "note", label: "Wishing well", note: "Coins glint at the bottom" }, cid)).json.pin;
  await api(page, "pin_save", { map_id: map, x: 60, y: 60, kind: "note", label: "Wishing tree", is_secret: true }, cid);

  await pp.goto(`#/c/${cid}/search?q=glint`);
  const group = pp.locator(".search-group", { hasText: "Maps" });
  await expect(group.locator(".search-row")).toHaveCount(1);
  await expect(group).toContainText("Wishing well · Reikland");
  await pp.goto(`#/c/${cid}/search?q=wishing`);
  await expect(pp.locator(".search-group", { hasText: "Maps" }).locator(".search-row")).toHaveCount(1);
  await page.goto(`#/c/${cid}/search?q=wishing`);
  await expect(page.locator(".search-group", { hasText: "Maps" }).locator(".search-row")).toHaveCount(2);

  // Ctrl K: the pin's label, and the map's name
  await pp.goto(`#/c/${cid}/table`);
  await expect(pp.locator(".nowbar")).toBeVisible();
  await pp.locator("body").click({ position: { x: 5, y: 300 } });
  await pp.keyboard.press("Control+k");
  const box = pp.getByRole("dialog", { name: "Jump to" });
  await pp.keyboard.type("wishing");
  await expect(box.getByRole("option", { name: /Wishing well/ })).toBeVisible();
  await expect(box.getByRole("option", { name: /Wishing tree/ })).toHaveCount(0);
  await box.getByRole("option", { name: /Wishing well/ }).click();
  await expect(pp).toHaveURL(new RegExp(`/maps/${map}\\?pin=${well.id}$`));
  await expect(pp.locator(".map-pin-card")).toContainText("Wishing well");
  await pp.keyboard.press("Control+k");
  await pp.keyboard.type("reikl");
  await expect(pp.getByRole("dialog", { name: "Jump to" }).getByRole("option", { name: /Reikland/ })).toBeVisible();
  expectNoErrors(errors);
});

test("an entry's pin opens the entry's editor over the map, and a place with no pin offers the map it sits in", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Map places");
  const empire = await mapWithPicture(page, cid, "The Empire");
  const city = await mapWithPicture(page, cid, "Altdorf city");
  const altdorf = (await api(page, "entry_save", { name: "Altdorf", category: "location", notes: "<p>The capital.</p>" }, cid)).json.id;
  const pin = (await api(page, "pin_save", { map_id: empire, x: 150, y: 100, kind: "entry", entry_id: altdorf, child_map_id: city }, cid)).json.pin;

  // the editor over the map: saving keeps the map open
  await page.goto(`#/c/${cid}/maps/${empire}?pin=${pin.id}`);
  await page.locator(".map-pin-card").getByRole("button", { name: "Entry here" }).click();
  const d = page.getByRole("dialog", { name: "Edit Altdorf" });
  await expect(d.locator("input[name=name]")).toHaveValue("Altdorf");
  await d.getByLabel("Other names").fill("The Imperial capital");
  await d.getByRole("button", { name: "Save entry" }).click();
  await expect(d).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/maps/${empire}`));
  const saved = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.id === altdorf);
  expect(saved.aliases).toEqual(["The Imperial capital"]);

  // + Place inside Altdorf: the GM is offered Altdorf's own map to pin the new place on
  await page.goto(`#/c/${cid}/encyclopedia/${altdorf}`);
  await page.getByRole("button", { name: "+ Place inside" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Grey Lady inn");
  await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
  const ask = page.getByRole("dialog").filter({ hasText: "Pin it on Altdorf city now?" });
  await ask.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveURL(/\/encyclopedia\/\d+$/);
  const inn = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.name === "Grey Lady inn");
  // a new entry with nothing written opens in its editor: give it a line, so its page shows
  expect((await api(page, "entry_save", { id: inn.id, version: inn.version, name: inn.name, notes: "<p>An inn.</p>" }, cid)).status).toBe(200);
  await page.goto(`#/c/${cid}/encyclopedia/${inn.id}`);
  await page.reload();
  // its page names the map, and Pin it there opens it ready to pin
  const hint = page.locator(".enc-inside-map");
  await expect(hint.getByRole("link", { name: /Altdorf city/ })).toBeVisible();
  await hint.getByRole("link", { name: "Pin it there" }).click();
  await expect(page).toHaveURL(new RegExp(`/maps/${city}$`));
  await expect(page.locator(".map-view")).toContainText("Click the map where Grey Lady inn is");
  await page.locator(".map-view .leaflet-container").click();   // the middle of the stage, on the picture
  const form = page.getByRole("dialog", { name: "Add pin" });
  await expect(form.getByLabel("Entry name")).toHaveValue("Grey Lady inn");   // already picked
  await form.getByRole("button", { name: "Add pin" }).click();
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.maps_index.filter(p => p.entry_id === inn.id).map(p => p.map_id)).toEqual([city]);
  // now pinned, its page links its own pin and no longer offers the hint
  await page.goto(`#/c/${cid}/encyclopedia/${inn.id}`);
  await expect(page.getByRole("link", { name: /On the map: Altdorf city/ })).toBeVisible();
  await expect(page.locator(".enc-inside-map")).toHaveCount(0);
  expectNoErrors(errors);
});
