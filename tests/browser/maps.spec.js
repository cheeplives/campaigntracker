// The Maps tab: maps (an uploaded image with pins, routes and a scale), tokens and party groups.
const { test, expect } = require("@playwright/test");
const { hexGray, openDrawer, gearAction, openLegend, watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, makePng, tokenUpload, settledBox, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("Maps: a fresh install has the tables, and the campaign says maps are ready", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Maps tables");
  const r = await api(page, "campaign", undefined, cid);
  expect(r.status).toBe(200);
  const maps = sql("SHOW TABLES LIKE 'map_%'");
  expect(maps).toContain("map_pins");
  expect(maps).toContain("map_routes");
  expect(sql("SHOW TABLES LIKE 'party_groups'").trim()).not.toBe("");
  expect(sql("SHOW TABLES LIKE 'tokens'").trim()).not.toBe("");
  expectNoErrors(errors);
});

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
async function upload(page, cid, parentType, parentId, buffer = MAP_PNG) {
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?${new URLSearchParams({ a: "file_upload", cid })}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: parentType, parent_id: String(parentId), file: { name: "map.png", mimeType: "image/png", buffer } },
  });
  return { status: res.status(), json: await res.json() };
}
const getMap = async (page, cid, id) => {
  const res = await page.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id })}`);
  return { status: res.status(), json: await res.json() };
};
const get = async (page, url) => (await page.request.get(url)).status();

test("Maps: a GM adds a map, gives it a picture and a scale; a player sees it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps add");
  const m = await api(page, "map_save", { name: "Sartar" }, cid);
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  const id = m.json.map.id;
  expect(m.json.map).toMatchObject({ name: "Sartar", is_secret: false, width: null, image_url: null });
  const up = await upload(page, cid, "map", id);
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  const withPic = await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  expect(withPic.status, JSON.stringify(withPic.json)).toBe(200);
  expect(withPic.json.map).toMatchObject({ width: 300, height: 200, image_url: up.json.file.url });
  const scaled = await api(page, "map_save", { id, scale_per_px: 0.1, scale_unit: "mi", grid_px: 40, grid_offset_x: 5, grid_offset_y: null }, cid);
  expect(scaled.status, JSON.stringify(scaled.json)).toBe(200);
  expect(scaled.json.map).toMatchObject({ name: "Sartar", width: 300, scale_per_px: 0.1, scale_unit: "mi", grid_px: 40, grid_offset_x: 5, grid_offset_y: null });
  expect((await api(page, "map_save", { id, grid_offset_x: 41 }, cid)).status).toBe(400);

  const list = await api(pp, "maps", undefined, cid);
  expect(list.json.maps.map(x => [x.id, x.name, x.pins])).toEqual([[id, "Sartar", 0]]);
  const seen = await getMap(pp, cid, id);
  expect(seen.status).toBe(200);
  expect(seen.json.map.image_url).toBe(up.json.file.url);
  expect([seen.json.pins, seen.json.routes, seen.json.groups]).toEqual([[], [], []]);
  expect(await get(pp, seen.json.map.image_url)).toBe(200);
  expectNoErrors(errors);
});

test("Maps: a GM-only map is invisible to players", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps secret");
  const id = (await api(page, "map_save", { name: "Secret", is_secret: true }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: up.json.file.id }, cid)).status).toBe(200);
  expect((await api(page, "maps", undefined, cid)).json.maps.map(x => x.name)).toEqual(["Secret"]);
  expect((await api(pp, "maps", undefined, cid)).json.maps).toEqual([]);
  expect((await getMap(pp, cid, id)).status).toBe(404);
  expect(await get(pp, up.json.file.url)).toBe(404);
  expect(await get(page, up.json.file.url)).toBe(200);
});

test("Maps: players can't change maps", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps player");
  const id = (await api(page, "map_save", { name: "Sartar" }, cid)).json.map.id;
  expect((await api(pp, "map_save", { name: "Mine" }, cid)).status).toBe(403);
  expect((await api(pp, "map_save", { id, name: "Mine" }, cid)).status).toBe(403);
  expect((await api(pp, "map_delete", { id }, cid)).status).toBe(403);
  expect((await upload(pp, cid, "map", id)).status).toBe(403);
  const e = await api(page, "entry_save", { name: "Greywater Keep", notes: "<p>A keep.</p>" }, cid);
  const pic = await upload(page, cid, "encyclopedia", e.json.id);
  expect(pic.status, JSON.stringify(pic.json)).toBe(200);
  expect((await api(page, "map_save", { id, image_id: pic.json.file.id }, cid)).status).toBe(400);
  expect((await api(page, "map_save", { id, scale_per_px: 1, scale_unit: "yd" }, cid)).status).toBe(400);
  const bad = await api(page, "map_save", { id, scale_per_px: 1, scale_unit: "yd" }, cid);
  expect(bad.json.message).toBe("Pick feet, metres, miles, kilometres, AU or light-years");
  expect((await api(page, "map_save", { id, scale_per_px: 0, scale_unit: "mi" }, cid)).status).toBe(400);
  expect((await api(page, "map_save", { name: "  " }, cid)).status).toBe(400);
});

test("Maps: Find Image can give a map its picture", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps find");
  const id = (await api(page, "map_save", { name: "Sartar" }, cid)).json.map.id;
  const r = await api(page, "image_import", { parent_type: "map", parent_id: id, source: "openverse", id: "11111111-1111-1111-1111-111111111111", mode: "copy" }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const s = await api(page, "map_save", { id, image_id: r.json.file.id }, cid);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  expect(s.json.map.image_url).toBe(r.json.file.url);
});

test("Maps: deleting a map removes its picture", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps delete");
  const id = (await api(page, "map_save", { name: "Sartar" }, cid)).json.map.id;
  expect((await upload(page, cid, "map", id)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='map' AND parent_id=${id}`).trim()).toBe("1");
  expect((await api(page, "map_delete", { id }, cid)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='map' AND parent_id=${id}`).trim()).toBe("0");
  expect(sql(`SELECT COUNT(*) FROM maps WHERE id=${id}`).trim()).toBe("0");
  expect((await getMap(page, cid, id)).status).toBe(404);
});

test("Maps: a replaced or removed picture is deleted, not left behind", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps orphan");
  const id = (await api(page, "map_save", { name: "Sartar" }, cid)).json.map.id;
  const count = () => sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='map' AND parent_id=${id}`).trim();
  const a = await upload(page, cid, "map", id), b = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: a.json.file.id }, cid)).status).toBe(200);
  expect((await api(page, "map_save", { id, image_id: b.json.file.id }, cid)).status).toBe(200);
  expect(count()).toBe("1");                                  // the first picture went when the second replaced it
  expect(await get(page, a.json.file.url)).toBe(404);
  expect((await api(page, "map_save", { id, image_id: null }, cid)).json.map).toMatchObject({ image_url: null, width: null });
  expect(count()).toBe("0");
  // Removing the picture as a file puts the map back to having none.
  const c = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: c.json.file.id }, cid)).status).toBe(200);
  expect((await api(page, "file_delete", { id: c.json.file.id }, cid)).status).toBe(200);
  expect((await getMap(page, cid, id)).json.map).toMatchObject({ image_url: null, width: null, height: null });
  // A GM-only picture can't be a map's picture.
  const d = await upload(page, cid, "map", id);
  expect((await api(page, "file_update", { id: d.json.file.id, is_secret: true }, cid)).status).toBe(200);
  expect((await api(page, "map_save", { id, image_id: d.json.file.id }, cid)).status).toBe(400);
});

test("Maps: a new grid size alone wraps the stored offsets to fit", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps grid");
  const id = (await api(page, "map_save", { name: "Sartar" }, cid)).json.map.id;
  expect((await api(page, "map_save", { id, grid_px: 40, grid_offset_x: 30 }, cid)).status).toBe(200);
  const r = await api(page, "map_save", { id, grid_px: 20 }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.map).toMatchObject({ grid_px: 20, grid_offset_x: 10, grid_offset_y: null });
  expect((await api(page, "map_save", { id, grid_px: 10, grid_offset_x: 15 }, cid)).status).toBe(400);   // one the request itself supplies
});

test("Maps: a map's grid can be squares or hexes and shown to everyone; anything else is refused", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps grid shape");
  const fresh = (await api(page, "map_save", { name: "Hexland" }, cid)).json.map;
  expect(fresh).toMatchObject({ grid_type: "square", grid_shown: false });
  const r = await api(page, "map_save", { id: fresh.id, grid_px: 50, grid_type: "hex_flat", grid_shown: true }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.map).toMatchObject({ grid_px: 50, grid_type: "hex_flat", grid_shown: true });
  expect((await api(page, "map_save", { id: fresh.id, name: "Hexland 2" }, cid)).json.map).toMatchObject({ grid_type: "hex_flat", grid_shown: true });   // kept when not named
  const bad = await api(page, "map_save", { id: fresh.id, grid_type: "triangle" }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toBe("Pick squares, flat-topped hexes or pointy-topped hexes");
  expect((await api(pp, "maps", undefined, cid)).json.maps[0]).toMatchObject({ grid_type: "hex_flat", grid_shown: true });
  expect((await api(pp, "map_save", { id: fresh.id, grid_type: "square" }, cid)).status).toBe(403);
  const made = (await api(page, "map_save", { name: "Pointy", grid_type: "hex_pointy" }, cid)).json.map;
  expect(made.grid_type).toBe("hex_pointy");
});

// ---- pins and routes ----
/** A public 300x200 map with a picture; returns its id. */
async function mapWithPicture(page, cid, extra = {}) {
  const id = (await api(page, "map_save", { name: "Sartar", ...extra }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: up.json.file.id }, cid)).status).toBe(200);
  return id;
}

test("Maps: a pin can open another map; a player isn't told of a GM-only one, and the inner map knows where it sits", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps nesting");
  const region = await mapWithPicture(page, cid);
  const town = (await api(page, "map_save", { name: "Bree" }, cid)).json.map.id;
  const vault = (await api(page, "map_save", { name: "Hidden vault", is_secret: true }, cid)).json.map.id;
  const pin = (await api(page, "pin_save", { map_id: region, x: 100, y: 80, kind: "note", label: "Bree town", child_map_id: town }, cid)).json.pin;
  expect(pin.child_map).toEqual({ id: town, name: "Bree" });
  const secretPin = (await api(page, "pin_save", { map_id: region, x: 10, y: 10, kind: "note", label: "Old ruin", child_map_id: vault }, cid)).json.pin;
  expect(secretPin.child_map).toEqual({ id: vault, name: "Hidden vault" });
  const bad = await api(page, "pin_save", { id: pin.id, child_map_id: region }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toBe("A pin can't open the map it is on");
  expect((await api(page, "pin_save", { id: pin.id, child_map_id: 999999 }, cid)).status).toBe(404);
  // a player sees the public link, and nothing of the GM-only map, not even its name
  const seen = (await getMap(pp, cid, region)).json.pins;
  expect(seen.find(p => p.id === pin.id).child_map).toEqual({ id: town, name: "Bree" });
  expect(seen.find(p => p.id === secretPin.id).child_map).toBe(null);
  expect(JSON.stringify(seen)).not.toContain("Hidden vault");
  expect((await api(pp, "pin_save", { id: pin.id, child_map_id: null }, cid)).status).toBe(403);
  // the inner map says where it sits (a player only sees a parent they can see)
  expect((await getMap(page, cid, town)).json.parent).toEqual({ pin_id: pin.id, label: "Bree town", map_id: region, map_name: "Sartar" });
  expect((await getMap(pp, cid, town)).json.parent).toMatchObject({ map_id: region });
  expect((await getMap(page, cid, vault)).json.parent).toMatchObject({ label: "Old ruin" });
  expect((await getMap(page, cid, region)).json.parent).toBe(null);
  // the maps list says where each one sits (and a player isn't told of a GM-only one)
  const list = (await api(page, "maps", undefined, cid)).json.maps;
  expect(list.find(m => m.id === town).inside).toEqual({ pin_id: pin.id, label: "Bree town", map_id: region, map_name: "Sartar" });
  expect(list.find(m => m.id === region).inside).toBe(null);
  expect((await api(pp, "maps", undefined, cid)).json.maps.find(m => m.id === town).inside).toMatchObject({ map_id: region });
  // a GM-only parent map isn't shown to a player
  await api(page, "map_save", { id: region, is_secret: true }, cid);
  expect((await getMap(pp, cid, town)).json.parent).toBe(null);
  await api(page, "map_save", { id: region, is_secret: false }, cid);
  // changing the pin's other fields keeps the link; clearing it removes it; deleting the inner map clears it
  expect((await api(page, "pin_save", { id: pin.id, label: "Bree" }, cid)).json.pin.child_map).toEqual({ id: town, name: "Bree" });
  expect((await api(page, "pin_save", { id: pin.id, child_map_id: null }, cid)).json.pin.child_map).toBe(null);
  await api(page, "pin_save", { id: pin.id, child_map_id: town }, cid);
  expect((await api(page, "map_delete", { id: town }, cid)).status).toBe(200);
  expect((await getMap(page, cid, region)).json.pins.find(p => p.id === pin.id).child_map).toBe(null);
});

test("Maps: a pin's card opens the map inside it, which names the place it is inside", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps inside");
  const region = await mapWithPicture(page, cid);
  const town = await mapWithPicture(page, cid);
  await api(page, "map_save", { id: town, name: "Bree" }, cid);
  // the GM makes the link in the pin form
  await page.goto(`#/c/${cid}/maps/${region}`);
  await expect(page.locator(".map-view .leaflet-container")).toBeVisible();
  const pin = (await api(page, "pin_save", { map_id: region, x: 150, y: 100, kind: "note", label: "Bree town" }, cid)).json.pin;
  await page.goto(`#/c/${cid}/maps/${region}?pin=${pin.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  const form = page.getByRole("dialog", { name: "Edit pin" });
  await expect(form.getByLabel("Opens map").locator("option")).toHaveCount(2);   // No map, Bree (not this map itself)
  await form.getByLabel("Opens map").selectOption({ label: "Bree" });
  await form.getByRole("button", { name: "Save pin" }).click();
  await expect(form).toBeHidden();
  await page.reload();
  await page.getByRole("link", { name: /Open Bree/ }).click();
  await expect(page).toHaveURL(new RegExp(`/maps/${town}$`));
  await expect(page.locator(".map-inside")).toContainText("Inside: Bree town on Sartar");
  await page.locator(".map-inside").getByRole("link", { name: "Sartar" }).click();
  await expect(page).toHaveURL(new RegExp(`/maps/${region}$`));
  expectNoErrors(errors);
});

test("Maps: the scale dialog finds the grid drawn on a picture, shows it before saving, and keeps its offset", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps detect");
  const id = (await api(page, "map_save", { name: "Gridded" }, cid)).json.map.id;
  const png = makePng(600, 400, (x, y) => ((x - 17 + 600) % 50 < 2 || (y - 17 + 400) % 50 < 2) ? 10 : 90 + ((Math.floor(x / 23) * 5 + Math.floor(y / 31) * 9) % 4) * 30);
  const up = await upload(page, cid, "map", id, png);
  expect((await api(page, "map_save", { id, image_id: up.json.file.id }, cid)).status).toBe(200);
  await page.goto(`#/c/${cid}/maps/${id}?scale=1`);
  // it looks by itself on a map with no grid, and draws what it found before anything is saved
  await expect(page.getByLabel("Pixels per square")).toHaveValue(/^(49\.[5-9]|50(\.[0-4])?)/, { timeout: 30000 });
  await expect(page.locator("svg.map-grid pattern")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Find the grid" })).toBeEnabled();
  await page.getByLabel("Distance per square").fill("5");
  await page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit").selectOption("ft");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  const m = (await api(page, "maps", undefined, cid)).json.maps[0];
  expect(Math.abs(m.grid_px - 50)).toBeLessThan(0.6);
  expect(Math.abs(m.grid_offset_x - 17)).toBeLessThan(2.5);
  expect(Math.abs(m.grid_offset_y - 17)).toBeLessThan(2.5);
  // a hex grid is found too, and sets the shape
  const hexMap = (await api(page, "map_save", { name: "Hexland" }, cid)).json.map.id;
  const hup = await upload(page, cid, "map", hexMap, makePng(500, 400, hexGray("hex_pointy", 46, 20, 5)));
  expect((await api(page, "map_save", { id: hexMap, image_id: hup.json.file.id }, cid)).status).toBe(200);
  await page.goto(`#/c/${cid}/maps/${hexMap}?scale=1`);
  await expect(page.getByLabel("Shape")).toHaveValue("hex_pointy", { timeout: 30000 });
  await expect(page.getByLabel("Pixels per square")).toHaveValue(/^(45\.[5-9]|46(\.[0-5])?)/);
  await page.getByLabel("Distance per square").fill("1");
  await page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit").selectOption("mi");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  expect((await api(page, "maps", undefined, cid)).json.maps.find(m => m.id === hexMap)).toMatchObject({ grid_type: "hex_pointy" });
  // a picture with no grid says so when asked, and cancelling takes the preview away
  const plain = await mapWithPicture(page, cid);
  await page.goto(`#/c/${cid}/maps/${plain}?scale=1`);
  await page.getByRole("button", { name: "Grid squares" }).click();
  await page.getByRole("button", { name: "Find the grid" }).click();
  await expect(page.getByText("No grid found on the picture")).toBeVisible();
  await expect(page.locator("svg.map-grid")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: a player adds a public pin; only they and the GM can change it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps pin");
  const mapId = await mapWithPicture(page, cid);
  const made = await api(pp, "pin_save", { map_id: mapId, x: 10, y: 10, label: "Our camp", is_secret: true, kind: "event" }, cid);
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  expect(made.json.pin).toMatchObject({ map_id: mapId, x: 10, y: 10, kind: "note", label: "Our camp", is_secret: false, entry: null, event: null });
  const id = made.json.pin.id;
  expect((await api(pp, "pin_save", { map_id: mapId, x: 5, y: 5, label: "" }, cid)).json.message).toBe("Give the pin a label");

  const pip2 = person("Quill");
  const pctx = await newContext(browser);
  const p2 = await pctx.newPage();
  await signIn(p2, pip2);
  await approve(browser, pip2.email);
  expect((await api(page, "member_add", { email: pip2.email, role: "player" }, cid)).status).toBe(200);
  const other = await api(p2, "pin_save", { id, label: "x" }, cid);
  expect(other.status).toBe(403);
  expect(other.json.message).toBe("You can only change your own pins");
  expect((await api(p2, "pin_delete", { id }, cid)).status).toBe(403);

  const own = await api(pp, "pin_save", { id, label: "Our camp!", x: 20 }, cid);
  expect(own.status, JSON.stringify(own.json)).toBe(200);
  expect(own.json.pin).toMatchObject({ label: "Our camp!", x: 20, y: 10 });
  const gmEdit = await api(page, "pin_save", { id, label: "Camp" }, cid);
  expect(gmEdit.status, JSON.stringify(gmEdit.json)).toBe(200);
  const seen = await getMap(page, cid, mapId);
  expect(seen.json.pins).toHaveLength(1);
  expect(seen.json.pins[0].label).toBe("Camp");
  expect(typeof seen.json.pins[0].author).toBe("string");
  expect(seen.json.pins[0].author).not.toBe("");
  expect((await api(pp, "pin_delete", { id }, cid)).status).toBe(200);
  expect((await getMap(page, cid, mapId)).json.pins).toEqual([]);
  expectNoErrors(errors);
});

test("Maps: a GM pins an entry and an event; secret ones never reach players", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps secret pins");
  const mapId = await mapWithPicture(page, cid);
  const entryId = (await api(page, "entry_save", { name: "Greywater Keep", notes: "<p>A <b>cold</b> keep on the water.</p>" }, cid)).json.id;
  const eventId = (await api(page, "event_save", { abs_day: 3, title: "The ambush" }, cid)).json.id;
  const ep = await api(page, "pin_save", { map_id: mapId, x: 50, y: 60, kind: "entry", entry_id: entryId }, cid);
  expect(ep.status, JSON.stringify(ep.json)).toBe(200);
  expect(ep.json.pin.entry).toMatchObject({ id: entryId, name: "Greywater Keep", first_line: "A cold keep on the water." });
  const vp = await api(page, "pin_save", { map_id: mapId, x: 70, y: 80, kind: "event", event_id: eventId }, cid);
  expect(vp.status, JSON.stringify(vp.json)).toBe(200);
  expect(vp.json.pin.event).toMatchObject({ id: eventId, abs_day: 3, title: "The ambush" });
  expect((await api(page, "pin_save", { map_id: mapId, x: 1, y: 1, kind: "entry" }, cid)).status).toBe(400);
  expect((await api(page, "pin_save", { map_id: mapId, x: 1, y: 1, kind: "entry", entry_id: 99999999 }, cid)).status).toBe(404);

  const seen = await getMap(pp, cid, mapId);
  expect(seen.json.pins.map(p => p.entry?.name ?? p.event?.title).sort()).toEqual(["Greywater Keep", "The ambush"]);
  expect((await api(pp, "maps", undefined, cid)).json.maps[0].pins).toBe(2);
  const idx = (await api(pp, "campaign", undefined, cid)).json.maps_index;
  expect(idx.map(i => [i.map_id, i.map_name, i.entry_id, i.event_id])).toEqual([[mapId, "Sartar", entryId, null], [mapId, "Sartar", null, eventId]]);

  expect((await api(page, "entry_save", { id: entryId, name: "Greywater Keep", is_secret: true }, cid)).status).toBe(200);
  expect((await getMap(pp, cid, mapId)).json.pins.map(p => p.entry)).toEqual([null]);
  expect((await api(pp, "campaign", undefined, cid)).json.maps_index.map(i => i.entry_id)).toEqual([null]);
  expect((await api(pp, "maps", undefined, cid)).json.maps[0].pins).toBe(1);
  expect((await api(page, "maps", undefined, cid)).json.maps[0].pins).toBe(2);

  // a secret event is just as hidden
  expect((await api(page, "event_save", { id: eventId, abs_day: 3, title: "The ambush", is_secret: true }, cid)).status).toBe(200);
  expect((await getMap(pp, cid, mapId)).json.pins).toEqual([]);
  expect((await api(pp, "maps", undefined, cid)).json.maps[0].pins).toBe(0);
  expect((await api(page, "event_save", { id: eventId, abs_day: 3, title: "The ambush", is_secret: false }, cid)).status).toBe(200);
  expect((await api(page, "entry_save", { id: entryId, name: "Greywater Keep", is_secret: false }, cid)).status).toBe(200);

  const hidden = await api(page, "pin_save", { map_id: mapId, x: 5, y: 5, kind: "note", label: "Trap", is_secret: true }, cid);
  expect(hidden.json.pin.is_secret).toBe(true);
  expect((await getMap(pp, cid, mapId)).json.pins.map(p => p.label)).not.toContain("Trap");
  expect((await getMap(page, cid, mapId)).json.pins.map(p => p.label)).toContain("Trap");
  expect((await api(pp, "maps", undefined, cid)).json.maps[0].pins).toBe(2);
  expect((await api(pp, "campaign", undefined, cid)).json.maps_index).toHaveLength(2);
});

test("Maps: a GM turns a player's pin into an Encyclopedia entry", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps to entry");
  const mapId = await mapWithPicture(page, cid);
  const pin = (await api(pp, "pin_save", { map_id: mapId, x: 30, y: 40, label: "Old Mill", note: "Burnt <down> & gone" }, cid)).json.pin;
  const r = await api(page, "pin_to_entry", { id: pin.id }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ ok: true, created: true });
  expect(r.json.pin).toMatchObject({ kind: "entry", entry_id: r.json.entry_id, label: "", created_by: pin.created_by });
  const enc = (await api(page, "campaign", undefined, cid)).json.encyclopedia.find(e => e.name === "Old Mill");
  expect(enc).toMatchObject({ id: r.json.entry_id, category: "location" });
  const notes = sql(`SELECT notes FROM encyclopedia_entries WHERE id=${r.json.entry_id}`);
  expect(notes).toContain("<p>Burnt &lt;down&gt; &amp; gone</p>");
  expect(enc.preview).toContain("Burnt <down>");
  expect((await api(pp, "pin_save", { id: pin.id, label: "x" }, cid)).status).toBe(403);

  const again = (await api(pp, "pin_save", { map_id: mapId, x: 1, y: 1, label: "the old mill" }, cid)).json.pin;
  const r2 = await api(page, "pin_to_entry", { id: again.id }, cid);
  expect(r2.status, JSON.stringify(r2.json)).toBe(200);
  expect(r2.json).toMatchObject({ created: false, entry_id: r.json.entry_id });
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_entries WHERE campaign_id=${cid} AND name LIKE '%mill%'`).trim()).toBe("1");

  const third = (await api(pp, "pin_save", { map_id: mapId, x: 2, y: 2, label: "Anything" }, cid)).json.pin;
  expect((await api(pp, "pin_to_entry", { id: third.id }, cid)).status).toBe(403);
  expect((await api(page, "pin_to_entry", { id: pin.id }, cid)).status).toBe(400);   // already an entry pin
  const other = (await api(page, "entry_save", { name: "Tower" }, cid)).json.id;
  const r3 = await api(page, "pin_to_entry", { id: third.id, entry_id: other }, cid);
  expect(r3.json).toMatchObject({ created: false, entry_id: other });
});

test("Maps: deleting a pinned entry or event deletes its pin", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps pin delete");
  const mapId = await mapWithPicture(page, cid);
  const entryId = (await api(page, "entry_save", { name: "Keep" }, cid)).json.id;
  const eventId = (await api(page, "event_save", { abs_day: 1, title: "Fight" }, cid)).json.id;
  expect((await api(page, "pin_save", { map_id: mapId, x: 1, y: 1, kind: "entry", entry_id: entryId }, cid)).status).toBe(200);
  expect((await api(page, "pin_save", { map_id: mapId, x: 2, y: 2, kind: "event", event_id: eventId }, cid)).status).toBe(200);
  const n = () => sql(`SELECT COUNT(*) FROM map_pins WHERE map_id=${mapId}`).trim();
  expect(n()).toBe("2");
  expect((await api(page, "entry_delete", { id: entryId }, cid)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM map_pins WHERE entry_id=${entryId}`).trim()).toBe("0");
  expect((await api(page, "event_delete", { id: eventId }, cid)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM map_pins WHERE event_id=${eventId}`).trim()).toBe("0");
  expect(n()).toBe("0");
});

test("Maps: pins and routes stay on the map", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps bounds");
  const mapId = await mapWithPicture(page, cid);
  const off = await api(page, "pin_save", { map_id: mapId, x: 301, y: 10, kind: "note", label: "Far" }, cid);
  expect(off.status).toBe(400);
  expect(off.json.message).toBe("That's off the map");
  expect((await api(page, "pin_save", { map_id: mapId, x: 300, y: 200, kind: "note", label: "Corner" }, cid)).status).toBe(200);
  expect((await api(page, "pin_save", { map_id: mapId, x: -1, y: 0, kind: "note", label: "Neg" }, cid)).status).toBe(400);
  const blank = (await api(page, "map_save", { name: "Blank" }, cid)).json.map.id;
  expect((await api(page, "pin_save", { map_id: blank, x: 1, y: 1, kind: "note", label: "No picture" }, cid)).status).toBe(400);

  expect((await api(page, "route_save", { map_id: mapId, name: "Road", points: [[1, 1]] }, cid)).status).toBe(400);
  const many = Array.from({ length: 501 }, (_, i) => [i % 300, 5]);
  expect((await api(page, "route_save", { map_id: mapId, name: "Road", points: many }, cid)).status).toBe(400);
  expect((await api(page, "route_save", { map_id: mapId, name: "Road", points: [[1, 1], [301, 5]] }, cid)).status).toBe(400);
  expect((await api(page, "route_save", { map_id: mapId, name: " ", points: [[1, 1], [5, 5]] }, cid)).status).toBe(400);
  expect((await api(pp, "route_save", { map_id: mapId, name: "Road", points: [[1, 1], [5, 5]] }, cid)).status).toBe(403);

  const ok = await api(page, "route_save", { map_id: mapId, name: "King's Road", points: [[1, 1], [150.5, 99], [300, 200]], is_secret: false }, cid);
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(ok.json.route).toMatchObject({ map_id: mapId, name: "King's Road", points: [[1, 1], [150.5, 99], [300, 200]], is_secret: false });
  const rid = ok.json.route.id;
  expect((await api(page, "route_save", { id: rid, map_id: mapId, name: "Hidden", points: [[0, 0], [9, 9]], is_secret: true }, cid)).json.route.name).toBe("Hidden");
  expect((await getMap(pp, cid, mapId)).json.routes).toEqual([]);
  expect((await getMap(page, cid, mapId)).json.routes.map(r => r.name)).toEqual(["Hidden"]);
  expect((await api(page, "route_save", { id: rid, map_id: mapId, name: "Road", points: [[0, 0], [9, 9]], is_secret: false }, cid)).status).toBe(200);
  expect((await getMap(pp, cid, mapId)).json.routes.map(r => r.name)).toEqual(["Road"]);
  expect((await api(pp, "route_delete", { id: rid }, cid)).status).toBe(403);
  expect((await api(page, "route_delete", { id: rid }, cid)).status).toBe(200);
  expect((await getMap(page, cid, mapId)).json.routes).toEqual([]);
});

test("Maps: pins on GM-only maps and other campaigns' things are not found", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Maps hidden pins");
  const secretMap = await mapWithPicture(page, cid, { is_secret: true });
  const pin = (await api(page, "pin_save", { map_id: secretMap, x: 5, y: 5, kind: "note", label: "Cache" }, cid)).json.pin;
  expect((await api(pp, "pin_save", { id: pin.id, label: "x" }, cid)).status).toBe(404);
  expect((await api(pp, "pin_delete", { id: pin.id }, cid)).status).toBe(404);
  expect((await api(pp, "pin_save", { map_id: secretMap, x: 5, y: 5, label: "Mine" }, cid)).status).toBe(404);
  expect(sql(`SELECT COUNT(*) FROM map_pins WHERE map_id=${secretMap}`).trim()).toBe("1");

  // things of another campaign
  const cid2 = await makeCampaign(page, `Maps other ${Date.now()}`);
  const map2 = await mapWithPicture(page, cid2);
  const entry2 = (await api(page, "entry_save", { name: "Elsewhere Keep" }, cid2)).json.id;
  const event2 = (await api(page, "event_save", { abs_day: 1, title: "Elsewhere" }, cid2)).json.id;
  const here = await mapWithPicture(page, cid);
  expect((await api(page, "pin_save", { map_id: here, x: 1, y: 1, kind: "entry", entry_id: entry2 }, cid)).status).toBe(404);
  expect((await api(page, "pin_save", { map_id: here, x: 1, y: 1, kind: "event", event_id: event2 }, cid)).status).toBe(404);
  expect((await api(page, "pin_save", { map_id: map2, x: 1, y: 1, kind: "note", label: "Wrong" }, cid)).status).toBe(404);

  // a kept position is checked against the map the pin moves to
  const small = (await api(page, "map_save", { name: "Small" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", small, makePng(50, 50));
  expect((await api(page, "map_save", { id: small, image_id: up.json.file.id }, cid)).status).toBe(200);
  const far = (await api(page, "pin_save", { map_id: here, x: 200, y: 150, kind: "note", label: "Far" }, cid)).json.pin;
  const moved = await api(page, "pin_save", { id: far.id, map_id: small }, cid);
  expect(moved.status).toBe(400);
  expect(moved.json.message).toBe("That's off the map");
});

// ---------------------------------------------------------------------------------------------- the Maps tab (the page)

/** Click the map's picture at a fraction of the way across and down (Playwright scrolls to it first). */
async function clickMap(page, fx, fy) {
  const box = await page.locator(".map-view .leaflet-container").boundingBox();
  await page.locator(".map-view .leaflet-container").click({ position: { x: box.width * fx, y: box.height * fy } });
}
/** Click a point of the map's picture itself, a fraction of the way across and down it, wherever the view has put it. */
async function clickPicture(page, fx, fy) {
  const stage = page.locator(".map-view .leaflet-container");
  await stage.scrollIntoViewIfNeeded();
  const img = await settledBox(page.locator(".map-view img.leaflet-image-layer")), box = await stage.boundingBox();
  await stage.click({ position: { x: img.x - box.x + img.width * fx, y: img.y - box.y + img.height * fy } });
}
/** Add a map through the page: + New map, a name, the picture; the scale panel is then open. */
async function newMap(page, name, fileName = "map.png", buffer = MAP_PNG) {
  await page.getByRole("button", { name: "+ New map" }).click();
  await page.getByLabel("Map name").fill(name);
  await page.getByLabel("Map picture").setInputFiles({ name: fileName, mimeType: "image/png", buffer });
  await page.getByRole("button", { name: "Create map" }).click();
  await expect(page.getByRole("dialog", { name: "Set the scale" })).toBeVisible();
}

test("Maps: the tab sits after Generators and lists maps", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps tab");
  await page.goto(`#/c/${cid}/generators`);
  await openLegend(page);
  await expect(page.locator("nav.tabs a", { hasText: "Maps" })).toBeVisible();
  const tabs = await page.locator("nav.tabs a[data-group]").allTextContents();
  expect(tabs[tabs.indexOf("Generators") + 1]).toBe("Maps");
  await page.goto(`#/c/${cid}/maps`);
  await expect(page.getByText("No maps yet. Add one with + New map.")).toBeVisible();
  await pp.goto(`#/c/${cid}/maps`);
  await expect(pp.getByText("No maps yet.", { exact: true })).toBeVisible();
  await expect(pp.getByRole("button", { name: "+ New map" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: a GM adds a map and scales it by two points, then measures", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps scale");
  const camp = (await api(page, "campaign", undefined, cid)).json.campaign;
  expect((await api(page, "campaign_update", { settings: { ...camp.settings, units: "imperial" } }, cid)).status).toBe(200);
  await page.goto(`#/c/${cid}/maps`);
  await newMap(page, "Sartar");
  await expect(page.locator(".map-scale")).toBeHidden();
  await page.getByRole("button", { name: "Two points" }).click();
  await clickPicture(page, 0.2, 0.5);
  await clickPicture(page, 0.6, 0.5);
  await page.getByRole("spinbutton", { name: "Distance" }).fill("40");
  await page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit").selectOption("mi");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  await expect(page.locator(".map-scale")).toContainText(/\d/);
  const saved = (await api(page, "maps", undefined, cid)).json.maps[0];
  expect(saved).toMatchObject({ scale_unit: "mi", grid_px: null });
  expect(saved.scale_per_px).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Measure" }).click();
  await clickPicture(page, 0.2, 0.3);
  await clickPicture(page, 0.6, 0.3);
  await expect(page.locator(".map-measure-total")).toHaveText(/\d+(\.\d)? mi/);
  // forty miles between the two points used for the scale, so the same span measures forty
  await expect(page.locator(".map-measure-total")).toHaveText(/^(39\.[5-9]|40(\.[0-4])?) mi/);   // to a screen pixel, which on a phone is more than a map pixel
  await page.getByRole("button", { name: "Undo point" }).click();
  await expect(page.locator(".map-measure-total")).toHaveText("");
  await clickMap(page, 0.9, 0.3);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".map-measure-total")).toHaveText("");
  expectNoErrors(errors);
});

test("Maps: a file name with 30x20 fills in the square size", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps grid");
  await page.goto(`#/c/${cid}/maps`);
  await newMap(page, "Keep", "Keep_30x20.png");
  await page.getByRole("button", { name: "Grid squares" }).click();
  await expect(page.getByLabel("Pixels per square")).toHaveValue("10");
  await page.getByRole("button", { name: "Roll20 (70 px = 5 ft)" }).click();
  await expect(page.getByLabel("Pixels per square")).toHaveValue("70");
  await expect(page.getByLabel("Distance per square")).toHaveValue("5");
  await expect(page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit")).toHaveValue("ft");
  // the first click on the grid gives its offset, which is the click's position within a square
  await page.locator(".map-view .leaflet-container").scrollIntoViewIfNeeded();   // so the boxes below are where the clicks land
  const img = await page.locator(".map-view img.leaflet-image-layer").boundingBox();
  const box = await page.locator(".map-view .leaflet-container").boundingBox();
  // on the picture, which is fitted beside the scale panel (on a phone, under it)
  const at = fx => ({ x: 300 * fx, y: 100 });
  const a = at(0.5), b = at(0.9);
  await clickPicture(page, 0.5, 0.5);
  await clickPicture(page, 0.9, 0.5);
  await page.getByLabel("How many squares").fill("2");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  const saved = (await api(page, "maps", undefined, cid)).json.maps[0];
  expect(saved.scale_unit).toBe("ft");
  expect(saved.grid_px).toBeGreaterThan(0);
  const grid = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const near = 1 + 300 / img.width;   // a click lands on a whole screen pixel, which on a narrow phone is more than one map pixel
  expect(Math.abs(saved.grid_px - grid)).toBeLessThan(near);
  expect(Math.abs(saved.grid_offset_x - (a.x % saved.grid_px))).toBeLessThan(near);
  expect(Math.abs(saved.grid_offset_y - (a.y % saved.grid_px))).toBeLessThan(near);
  expectNoErrors(errors);
});

test("Maps: the grid is drawn over the map, each person can hide it, and Measure counts squares", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps overlay");
  const id = await mapWithPicture(page, cid);
  await page.goto(`#/c/${cid}/maps/${id}`);
  await expect(page.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(page.getByRole("button", { name: "Grid", exact: true })).toBeHidden();   // no grid yet
  // the GM sets 20 px squares of 5 ft, shown to everyone, through the scale dialog
  await gearAction(page, "Scale");
  await page.getByRole("button", { name: "Grid squares" }).click();
  await expect(page.getByLabel("Shape")).toHaveValue("square");
  await page.getByLabel("Pixels per square").fill("20");
  await page.getByLabel("Distance per square").fill("5");
  await page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit").selectOption("ft");
  await page.getByLabel("Show the grid to everyone").check();
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  expect((await api(page, "maps", undefined, cid)).json.maps[0]).toMatchObject({ grid_px: 20, grid_type: "square", grid_shown: true });
  await expect(page.locator("svg.map-grid pattern path")).toHaveCount(2);
  await expect(page.locator("svg.map-grid pattern")).toHaveAttribute("width", "20");
  // a player sees it too, and hiding it is theirs alone
  await pp.goto(`#/c/${cid}/maps/${id}`);
  await expect(pp.locator("svg.map-grid")).toHaveCount(1);
  await pp.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(pp.locator("svg.map-grid")).toHaveCount(0);
  await expect(pp.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute("aria-pressed", "false");
  await pp.reload();
  await expect(pp.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(pp.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute("aria-pressed", "false");   // remembered
  await expect(pp.locator("svg.map-grid")).toHaveCount(0);
  await expect(page.locator("svg.map-grid")).toHaveCount(1);
  // measuring says how many squares
  await page.getByRole("button", { name: "Measure" }).click();
  await clickPicture(page, 0.1, 0.5);
  await clickPicture(page, 0.9, 0.5);
  await expect(page.locator(".map-measure-total")).toHaveText(/ · 12 squares$/);   // 240 px across 20 px squares
  // hexes draw a hex tile
  expect((await api(page, "map_save", { id, grid_type: "hex_pointy" }, cid)).status).toBe(200);
  await page.reload();
  await expect(page.locator("svg.map-grid pattern")).toHaveAttribute("width", "20");
  await expect(page.locator("svg.map-grid pattern path").first()).toHaveAttribute("d", /Z/);
  expectNoErrors(errors);
});

test("Maps: a GM imports a Universal VTT file, and a Foundry scene whose notes become GM-only pins", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps import");
  await page.goto(`#/c/${cid}/maps`);
  // Universal VTT: the picture is inside; it says nothing of distance, so 5 ft a square and the scale dialog to check it
  const uvtt = { format: 0.3, resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 6, y: 4 }, pixels_per_grid: 50 }, lights: [{}], image: MAP_PNG.toString("base64") };
  await page.getByRole("button", { name: "+ New map" }).click();
  await page.getByLabel("Import a VTT file").setInputFiles({ name: "Goblin_Cave.dd2vtt", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(uvtt)) });
  await expect(page.getByRole("dialog", { name: "Set the scale" })).toBeVisible();
  await expect(page.locator("#toast")).toContainText("Walls and lights aren't kept.");
  await expect(page.getByLabel("Pixels per square")).toHaveValue("50");
  await expect(page.getByLabel("Distance per square")).toHaveValue("5");
  await expect(page.locator(".map-head h2")).toHaveText("Goblin Cave");
  let maps = (await api(page, "maps", undefined, cid)).json.maps;
  expect(maps[0]).toMatchObject({ name: "Goblin Cave", width: 300, height: 200, grid_px: 50, grid_type: "square", grid_shown: true, scale_unit: "ft" });
  expect(maps[0].scale_per_px).toBeCloseTo(0.1, 6);
  await expect(page.locator("svg.map-grid")).toHaveCount(1);

  // a Foundry scene's JSON and its picture, picked together; the name typed wins over the scene's
  const scene = { name: "Bree", width: 300, height: 200, padding: 0, grid: { type: 1, size: 25, distance: 10, units: "m" }, notes: [{ x: 100, y: 60, text: "Prancing Pony" }] };
  await page.goto(`#/c/${cid}/maps`);
  await page.getByRole("button", { name: "+ New map" }).click();
  await page.getByLabel("Map name").fill("Bree-land");
  await page.getByLabel("Import a VTT file").setInputFiles([
    { name: "fvtt-Scene-bree.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(scene)) },
    { name: "bree.png", mimeType: "image/png", buffer: MAP_PNG }]);
  await expect(page.getByRole("dialog", { name: "Set the scale" })).toBeVisible();
  await expect(page.locator("#toast")).toContainText("1 note became a GM-only pin.");
  maps = (await api(page, "maps", undefined, cid)).json.maps;
  const bree = maps.find(m => m.name === "Bree-land");
  expect(bree).toMatchObject({ grid_px: 25, scale_unit: "m" });
  expect(bree.scale_per_px).toBeCloseTo(0.4, 6);
  const pins = (await getMap(page, cid, bree.id)).json.pins;
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({ x: 100, y: 60, label: "Prancing Pony", kind: "note", is_secret: true });
  expect((await getMap(pp, cid, bree.id)).json.pins).toHaveLength(0);

  // a file that is none of these says so and makes nothing
  await page.goto(`#/c/${cid}/maps`);
  await page.getByRole("button", { name: "+ New map" }).click();
  await page.getByLabel("Import a VTT file").setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{\"a\":1}") });
  await expect(page.locator("#toast")).toContainText("That isn't a Universal VTT file or a Foundry scene");
  expect((await api(page, "maps", undefined, cid)).json.maps).toHaveLength(2);
  expectNoErrors(errors);
});

test("Maps: a GM exports the picture, and a gridded map as Universal VTT that reads back the same", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps export");
  const id = await mapWithPicture(page, cid, { name: "Keep: Upper/Lower" });
  await page.goto(`#/c/${cid}/maps/${id}`);
  await gearAction(page, "Export…");
  await expect(page.getByRole("button", { name: "Universal VTT (.dd2vtt)" })).toBeDisabled();   // no grid yet
  await expect(page.getByRole("dialog", { name: "Export the map" })).toContainText("Set grid squares first (⚙ → Set scale… → Grid squares)");
  const [pic] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: "Export the map" }).getByRole("button", { name: "Picture", exact: true }).click()]);
  expect(pic.suggestedFilename()).toBe("Keep Upper Lower.png");
  expect(Buffer.compare(require("fs").readFileSync(await pic.path()), MAP_PNG)).toBe(0);

  expect((await api(page, "map_save", { id, grid_px: 50, grid_offset_x: 10, grid_offset_y: 0, scale_per_px: 0.1, scale_unit: "ft" }, cid)).status).toBe(200);
  await page.reload();
  await gearAction(page, "Export…");
  const [uv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Universal VTT (.dd2vtt)" }).click()]);
  expect(uv.suggestedFilename()).toBe("Keep Upper Lower.dd2vtt");
  const json = JSON.parse(require("fs").readFileSync(await uv.path(), "utf8"));
  expect(json.resolution).toEqual({ map_origin: { x: -0.2, y: 0 }, map_size: { x: 6, y: 4 }, pixels_per_grid: 50 });
  expect(Buffer.compare(Buffer.from(json.image, "base64"), MAP_PNG)).toBe(0);
  // the Foundry scene carries the pins as Notes, and the grid, scale and picture name
  expect((await api(page, "pin_save", { map_id: id, x: 120, y: 80, kind: "note", label: "The Prancing Pony" }, cid)).status).toBe(200);
  await page.reload();
  await gearAction(page, "Export…");
  const [fv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Foundry scene (.json)" }).click()]);
  expect(fv.suggestedFilename()).toBe("Keep Upper Lower.json");
  const scene = JSON.parse(require("fs").readFileSync(await fv.path(), "utf8"));
  expect(scene).toMatchObject({ name: "Keep: Upper/Lower", width: 300, height: 200, padding: 0, grid: { type: 1, size: 50, distance: 5, units: "ft" }, background: { src: "Keep Upper Lower.png", offsetX: -10, offsetY: 0 } });
  expect(scene.notes).toMatchObject([{ x: 110, y: 80, text: "The Prancing Pony" }]);
  // players have no Export
  await pp.goto(`#/c/${cid}/maps/${id}`);
  await expect(pp.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(pp.getByRole("button", { name: "Export…" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: an unscaled map says so when measuring", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps unscaled");
  const id = (await api(page, "map_save", { name: "Bare" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  await page.goto(`#/c/${cid}/maps/${id}`);
  await page.getByRole("button", { name: "Measure" }).click();
  await expect(page.getByText("Set the scale to measure")).toBeVisible();
  await pp.goto(`#/c/${cid}/maps/${id}`);
  await pp.getByRole("button", { name: "Measure" }).click();
  await expect(pp.getByText("The GM hasn't set this map's scale yet")).toBeVisible();
  await expect(pp.getByRole("button", { name: "Scale" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: a large picture opens", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps large");
  const id = (await api(page, "map_save", { name: "Huge" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id, makePng(6000, 4000));
  expect(up.status, JSON.stringify(up.json)).toBe(200);
  await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  await page.goto(`#/c/${cid}/maps/${id}`);
  // 24 million pixels is drawn in tiles, not as one picture
  await expect(page.locator(".map-view .map-big-picture canvas").first()).toBeVisible();
  await expect(page.locator(".map-view img.leaflet-image-layer")).toHaveCount(0);
  await expect.poll(() => page.locator(".map-view .map-big-picture canvas").count()).toBeGreaterThan(0);
  // and the tiles hold the picture (the test picture is grey): the middle tile is not blank
  const grey = await page.locator(".map-view .map-big-picture canvas").first().evaluate(c => { const d = c.getContext("2d").getImageData(128, 128, 1, 1).data; return [d[0], d[3]]; });
  expect(grey).toEqual([127, 255]);
  // the grid and pins still sit on it: a pin lands at the clicked place
  await api(page, "pin_save", { map_id: id, x: 3000, y: 2000, kind: "note", label: "Middle" }, cid);
  await page.reload();
  await expect(page.locator(".map-pin", { hasText: "Middle" })).toBeVisible();
  expectNoErrors(errors);
  // a picture under that size keeps its single image
  const small = await mapWithPicture(page, cid);
  await page.goto(`#/c/${cid}/maps/${small}`);
  await expect(page.locator(".map-view img.leaflet-image-layer")).toHaveCount(1);
});

test("Maps: a GM renames a map, hides it and deletes it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps manage");
  const id = (await api(page, "map_save", { name: "Old name" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  await page.goto(`#/c/${cid}/maps/${id}`);
  await expect(page.getByRole("button", { name: "Rename" })).toBeHidden();   // in the ⚙ menu
  await page.getByLabel("Map settings").click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("New name").fill("Fresh name");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.goto(`#/c/${cid}/maps`);
  await expect(page.locator(".map-card", { hasText: "Fresh name" })).toBeVisible();
  await pp.goto(`#/c/${cid}/maps`);
  await expect(pp.locator(".map-card", { hasText: "Fresh name" })).toBeVisible();
  await page.locator(".map-card", { hasText: "Fresh name" }).click();
  await page.getByRole("button", { name: "GM only" }).click();
  await expect(page.getByRole("button", { name: "GM only" })).toHaveAttribute("aria-pressed", "true");
  await pp.reload();
  await expect(pp.getByText("No maps yet.", { exact: true })).toBeVisible();
  await page.getByLabel("Map settings").click();
  await page.getByRole("button", { name: "Delete map" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/maps$`));
  await expect(page.getByText("No maps yet. Add one with + New map.")).toBeVisible();
  expect((await api(page, "maps", undefined, cid)).json.maps).toHaveLength(0);
  expectNoErrors(errors);
});

test("Maps: marker() draws a labelled marker and the coordinates map to the picture's pixels", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps marker");
  await page.goto(`#/c/${cid}/maps`);
  const out = await page.evaluate(() => {
    const host = document.createElement("div");
    host.style.cssText = "width:300px;height:200px";
    document.body.append(host);
    const map = L.map(host, { crs: L.CRS.Simple, minZoom: -5, attributionControl: false });
    map.setView(MapsTab.toLatLng(150, 100), 0);
    const layer = L.layerGroup().addTo(map);
    const m = MapsTab.marker(layer, { x: 150, y: 100, icon: "📍", label: "Inn", className: "test-pin", draggable: false, onOpen: () => document.createTextNode("Hello") });
    return { ll: MapsTab.toLatLng(10, 20), xy: MapsTab.toXY({ lat: -20, lng: 10 }), isMarker: m instanceof L.Marker,
      label: host.querySelector(".map-marker.test-pin .map-marker-label")?.textContent, icon: host.querySelector(".map-marker-icon")?.textContent };
  });
  expect(out).toMatchObject({ ll: [-20, 10], xy: { x: 10, y: 20 }, isMarker: true, label: "Inn", icon: "📍" });
  expectNoErrors(errors);
});

test("Maps: leaving a map and coming back leaves one map on the page and no errors", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps leave");
  const id = (await api(page, "map_save", { name: "Twice" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  for (let i = 0; i < 2; i++) {
    await page.goto(`#/c/${cid}/maps/${id}`);
    await expect(page.locator(".map-view .leaflet-container")).toHaveCount(1);
    await page.goto(`#/c/${cid}/today`);
    await expect(page.locator(".leaflet-container")).toHaveCount(0);
  }
  await page.goto(`#/c/${cid}/maps/${id}`);
  await expect(page.locator(".leaflet-container")).toHaveCount(1);
  await page.waitForTimeout(300);
  expectNoErrors(errors);
});

// ---- pins and routes on the map ----
/** A click at (fx, fy) of the map's picture itself, which the container is wider than. */
async function clickPic(page, fx, fy) {
  await page.locator(".map-view .leaflet-container").scrollIntoViewIfNeeded();
  const box = await settledBox(page.locator(".map-view .leaflet-image-layer"));   // a card opening may still be panning the map
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}
const pinForm = page => page.getByRole("dialog", { name: "Add pin" });
/** Add pin, then a click on the map at (fx, fy) of its size. */
async function startPin(page, fx = 0.5, fy = 0.5) {
  await page.getByRole("button", { name: "Add pin", exact: true }).click();
  await clickPic(page, fx, fy);
  await expect(pinForm(page)).toBeVisible();
}

test("Maps: a player adds a public pin the GM sees", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps player pin");
  const mapId = await mapWithPicture(page, cid);
  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await startPin(pp);
  await expect(pinForm(pp).getByLabel("GM only")).toHaveCount(0);
  await expect(pinForm(pp).getByRole("button", { name: "Encyclopedia entry" })).toHaveCount(0);
  await expect(pinForm(pp).getByRole("button", { name: "Event" })).toHaveCount(0);
  await pinForm(pp).getByLabel("Label").fill("Our camp");
  await pinForm(pp).getByLabel("Note").fill("By the ford");
  await pinForm(pp).getByRole("button", { name: "Add pin" }).click();
  await expect(pp.locator(".map-pin")).toContainText("Our camp");
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".map-pin")).toContainText("Our camp");
  await page.locator(".map-pin").click();
  await expect(page.locator(".leaflet-popup")).toContainText("Added by Pip");
  await expect(page.locator(".leaflet-popup")).toContainText("By the ford");
  expectNoErrors(errors);
});

test("Maps: a GM pins a new entry and an existing event, and the entry links back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps GM pins");
  const mapId = await mapWithPicture(page, cid);
  const day = (await api(page, "campaign", undefined, cid)).json.campaign.current_day ?? 0;
  const ev = await api(page, "event_save", { abs_day: day, title: "Council at dawn", shift: null }, cid);
  expect(ev.status, JSON.stringify(ev.json)).toBe(200);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await startPin(page, 0.3, 0.3);
  await pinForm(page).getByRole("button", { name: "Encyclopedia entry" }).click();
  await pinForm(page).getByLabel("Entry name").fill("Weathertop");
  await pinForm(page).getByRole("button", { name: "New entry here" }).click();
  await expect(page.locator(".map-pin")).toHaveCount(1);
  await expect(page.locator(".map-pin .map-marker-icon")).toHaveText("📍");
  await expect(page.locator(".map-pin")).toContainText("Weathertop");
  await page.goto(`#/c/${cid}/encyclopedia`);
  await expect(page.locator("section[data-cat=location]")).toContainText("Weathertop");   // listed under the Location Category
  await page.getByRole("link", { name: /Weathertop/ }).first().click();
  await expect(page.locator("select[name=category]")).toHaveValue("location");
  const back = page.getByRole("link", { name: "📍 On the map: Sartar" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.locator(".leaflet-popup")).toContainText("Weathertop");
  await expect(page.locator(".leaflet-popup").getByRole("link", { name: /Weathertop/ })).toBeVisible();

  await startPin(page, 0.55, 0.65);   // clear of the open card and of the drawer, on an iPad held upright too
  await pinForm(page).getByRole("button", { name: "Event" }).click();
  await pinForm(page).getByLabel("Event title").fill("Council");
  await pinForm(page).getByRole("button", { name: /Council at dawn/ }).click();
  await pinForm(page).getByRole("button", { name: "Add pin" }).click();
  await expect(page.locator(".map-pin")).toHaveCount(2);
  await page.goto(`#/c/${cid}/day/${day}`);
  await expect(page.getByRole("link", { name: "📍 On the map: Sartar" })).toBeVisible();
  await page.goto(`#/c/${cid}/events`);
  await page.getByRole("link", { name: "📍 On the map: Sartar" }).click();
  await expect(page.locator(".leaflet-popup")).toContainText("Council at dawn");
  expectNoErrors(errors);
});

test("Maps: a GM saves a route and a player sees its length", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps routes");
  const mapId = await mapWithPicture(page, cid, { scale_per_px: 0.1, scale_unit: "mi" });
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.getByRole("button", { name: "Measure" }).click();
  await clickPic(page, 0.1, 0.5);
  await clickPic(page, 0.5, 0.5);
  await clickPic(page, 0.5, 0.8);
  await page.getByRole("button", { name: "Save route…" }).click();
  await page.getByLabel("Route name").fill("Old North Road");
  await page.getByRole("dialog", { name: "Save route" }).getByRole("button", { name: "Save route" }).click();
  const row = page.locator(".map-route", { hasText: "Old North Road" });
  await expect(row).toContainText(/\d+(\.\d)? (km|mi)/);
  await expect(page.locator("path.map-route-line")).toHaveCount(1);
  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(pp.locator(".map-route", { hasText: "Old North Road" })).toContainText(/\d+(\.\d)? (km|mi)/);
  await expect(pp.locator(".map-route").getByRole("button", { name: "Delete" })).toHaveCount(0);
  await openDrawer(page);
  await row.getByRole("button", { name: "GM only" }).click();
  await expect(row.getByRole("button", { name: "GM only" })).toHaveAttribute("aria-pressed", "true");
  await pp.reload();
  await expect(pp.locator(".map-view .leaflet-container")).toHaveCount(1);
  await expect(pp.locator(".map-route")).toHaveCount(0);
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".map-route")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: Add to Encyclopedia from a player's pin", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps add to enc");
  const mapId = await mapWithPicture(page, cid);
  await api(pp, "pin_save", { map_id: mapId, x: 30, y: 40, label: "Burnt Ford", note: "Where we crossed" }, cid);
  await api(pp, "pin_save", { map_id: mapId, x: 90, y: 40, label: "The old mill" }, cid);
  await api(page, "entry_save", { name: "Old Mill" }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await page.getByRole("button", { name: "Add to Encyclopedia" }).click();
  await expect(page.locator(".map-pin .map-marker-icon", { hasText: "📍" })).toHaveCount(1);
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);   // the old card went with the redraw
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await expect(page.locator(".leaflet-popup")).toContainText("Added by Pip");
  await expect(page.locator(".leaflet-popup").getByRole("link", { name: /Burnt Ford/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".map-pin", { hasText: "The old mill" }).click();
  await expect(page.getByRole("button", { name: "Add to Encyclopedia" })).toHaveCount(0);
  await page.getByRole("button", { name: "Link to Old Mill" }).click();
  await expect(page.locator(".map-pin .map-marker-icon", { hasText: "📌" })).toHaveCount(1);   // an entry without a Category
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_entries WHERE campaign_id=${cid}`).trim()).toBe("2");
  expectNoErrors(errors);
});

test("Maps: a player can't move or delete the GM's pins", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps no touch");
  const mapId = await mapWithPicture(page, cid);
  await api(page, "pin_save", { map_id: mapId, x: 30, y: 40, label: "Keep out", kind: "note" }, cid);
  await api(pp, "pin_save", { map_id: mapId, x: 90, y: 40, label: "Mine" }, cid);
  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(pp.locator(".map-pin")).toHaveCount(2);
  await pp.locator(".map-pin", { hasText: "Keep out" }).click();
  await expect(pp.locator(".leaflet-popup")).toContainText("Keep out");
  await expect(pp.locator(".leaflet-popup").getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(pp.locator(".leaflet-popup").getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(pp.locator(".leaflet-marker-draggable")).toHaveCount(1);   // only their own
  await expect(pp.locator(".leaflet-marker-draggable .map-marker-label")).toHaveText("Mine");
  expectNoErrors(errors);
});

test("Maps: a new entry from a pin's note goes through the detector; a GM-only entry warns", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps detector");
  const mapId = await mapWithPicture(page, cid);
  await api(pp, "pin_save", { map_id: mapId, x: 30, y: 40, label: "Burnt Ford", note: "We met Gareth Stormborn here" }, cid);
  await api(pp, "pin_save", { map_id: mapId, x: 90, y: 40, label: "Hidden Vault" }, cid);
  await api(page, "entry_save", { name: "Hidden Vault", is_secret: true }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await page.getByRole("button", { name: "Add to Encyclopedia" }).click();
  await expect(page.locator("dialog.noun-dialog").getByLabel("Name for Gareth Stormborn")).toBeVisible();
  await page.locator("dialog.noun-dialog").getByRole("button", { name: "Not now" }).click();
  await page.locator(".map-pin", { hasText: "Hidden Vault" }).click();
  await page.getByRole("button", { name: "Link to Hidden Vault" }).click();
  await expect(page.getByText(/players won't see the pin until the entry is shown to them/)).toBeVisible();
  expectNoErrors(errors);
});

test("Maps: a GM drags a pin and it stays there; ?pin= opens its card", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps drag");
  const mapId = await mapWithPicture(page, cid);
  const pin = (await api(page, "pin_save", { map_id: mapId, x: 100, y: 100, label: "Drag me" }, cid)).json.pin;
  await page.goto(`#/c/${cid}/maps/${mapId}?pin=${pin.id}`);
  await expect(page.locator(".leaflet-popup")).toContainText("Drag me");   // ?pin= opens the card
  await page.locator(".leaflet-popup-close-button").click();
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);
  const m = page.locator(".leaflet-marker-draggable").first();
  await m.scrollIntoViewIfNeeded();   // a raw drag doesn't scroll, and on a short phone screen the map is below the fold
  const box = await settledBox(m);   // opening the card panned the map
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await getMap(page, cid, mapId)).json.pins[0].x).toBeGreaterThan(100);
  expectNoErrors(errors);
});

test("Maps: a ?pin= link to a pin the reader can't see says so", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps hidden pin");
  const mapId = await mapWithPicture(page, cid);
  const pin = (await api(page, "pin_save", { map_id: mapId, x: 30, y: 40, label: "Secret", kind: "note", is_secret: true }, cid)).json.pin;
  await pp.goto(`#/c/${cid}/maps/${mapId}?pin=${pin.id}`);
  await expect(pp.locator(".map-note")).toHaveText("That pin is not on this map");
  await expect(pp.locator(".leaflet-popup")).toHaveCount(0);
  await page.goto(`#/c/${cid}/maps/${mapId}?pin=999999`);
  await expect(page.locator(".map-note")).toHaveText("That pin is not on this map");
  expectNoErrors(errors);
});

test("Maps: a route's name is shown as text in its tooltip, never as markup", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps route tip");
  const mapId = await mapWithPicture(page, cid);
  await api(page, "route_save", { map_id: mapId, name: "A <b>bold</b> & B", points: [[10, 100], [290, 100]] }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  const line = page.locator(".map-route-line");
  await expect(line).toHaveCount(1);
  await line.scrollIntoViewIfNeeded();   // a raw tap or hover doesn't scroll, and on a short phone screen the map is below the fold
  const box = await settledBox(line);
  const mid = [box.x + box.width / 2, box.y + box.height / 2];
  if (test.info().project.use.hasTouch) await page.touchscreen.tap(...mid);   // a touch screen opens it on tap
  else await page.mouse.move(...mid);                                      // a pointer on hover
  const tip = page.locator(".leaflet-tooltip.map-tip");
  await expect(tip).toHaveText("A <b>bold</b> & B");
  await expect(tip.locator("b")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Maps: pinning a note labelled with an accented name reuses the entry of the unaccented one", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps accents");
  const mapId = await mapWithPicture(page, cid);
  const cafe = (await api(page, "entry_save", { name: "Cafe" }, cid)).json.id;
  const pin = (await api(page, "pin_save", { map_id: mapId, x: 5, y: 5, label: "Caf\u00e9" }, cid)).json.pin;
  const r = await api(page, "pin_to_entry", { id: pin.id }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ created: false, entry_id: cafe });
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_entries WHERE campaign_id=${cid}`).trim()).toBe("1");
});

test("Maps: a player opening a GM-only map's address sees Map not found", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps not found");
  const id = await mapWithPicture(page, cid, { is_secret: true });
  await pp.goto(`#/c/${cid}/maps/${id}`);
  await expect(pp.locator(".card p").first()).toHaveText("Map not found");
  await pp.goto(`#/c/${cid}/maps/999999`);
  await expect(pp.locator(".card p").first()).toHaveText("Map not found");
  expectNoErrors(errors);
});

test("Maps: a picture a map or token shows can't be made GM only by itself", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Maps picture secret");
  const mapId = await mapWithPicture(page, cid);
  const imageId = Number(sql(`SELECT image_id FROM maps WHERE id=${mapId}`).trim());
  const r = await api(page, "file_update", { id: imageId, is_secret: true }, cid);
  expect(r.status).toBe(400);
  expect(r.json.message).toBe("This picture is in use; hide the map or token instead");
  const token = await tokenUpload(page, cid, "Pip");
  const tid = Number(sql(`SELECT image_id FROM tokens WHERE id=${token.id}`).trim());
  expect((await api(page, "file_update", { id: tid, is_secret: true }, cid)).status).toBe(400);
  expect((await api(page, "file_update", { id: imageId, caption: "ok" }, cid)).status).toBe(200);
});

test("Maps: a route or location can be hidden from the picture on this device, and shown again", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps hide");
  const m = await api(page, "map_save", { name: "Sartar" }, cid);
  const id = m.json.map.id;
  const up = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: up.json.file.id }, cid)).status).toBe(200);
  expect((await api(page, "pin_save", { map_id: id, x: 50, y: 50, kind: "note", label: "Camp" }, cid)).status).toBe(200);
  expect((await api(page, "route_save", { map_id: id, name: "King's Road", points: [[10, 10], [200, 150]] }, cid)).status).toBe(200);

  await page.goto(`index.html#/c/${cid}/maps/${id}`);
  await expect(page.locator(".map-pin")).toHaveCount(1);
  await expect(page.locator("path.map-route-line")).toHaveCount(1);
  await openDrawer(page);

  await page.getByRole("checkbox", { name: "Show King's Road on the map" }).uncheck();
  await expect(page.locator("path.map-route-line")).toHaveCount(0);
  await expect(page.locator(".map-pin")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Show Camp on the map" }).uncheck();
  await expect(page.locator(".map-pin")).toHaveCount(0);

  // kept on this device for this map, and the lists still show both
  await page.reload();
  await expect(page.locator(".map-pin")).toHaveCount(0);
  await expect(page.locator("path.map-route-line")).toHaveCount(0);
  await expect(page.locator(".map-place", { hasText: "Camp" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show King's Road on the map" })).not.toBeChecked();

  await page.getByRole("checkbox", { name: "Show Camp on the map" }).check();
  await expect(page.locator(".map-pin")).toHaveCount(1);
  expectNoErrors(errors);
});

// ---------------------------------------------------------------------------------------------- the page's layout
/** Note pins named `names` on map `mid`, spread over its picture. */
async function notePins(page, cid, mid, names) {
  for (const [i, label] of names.entries()) {
    expect((await api(page, "pin_save", { map_id: mid, x: 60 + i * 80, y: 60 + (i % 2) * 70, kind: "note", label }, cid)).status).toBe(200);
  }
}

test("Map page: the map stage fills the window to its bottom edge and never shrinks under 320px", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Stage");
  const mid = await mapWithPicture(page, cid);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage");
  await expect(stage).toBeVisible();
  await expect.poll(async () => { const box = await stage.boundingBox(); return Math.abs(box.y + box.height - 800); }).toBeLessThanOrEqual(20);
  await expect(page.locator(".map-view .leaflet-container")).toHaveCount(1);
  await expect(page.locator(".map-view.card")).toHaveCount(0);
  await expect(page.locator(".map-view .map-meta")).toHaveText("0 locations · 0 routes");
  await page.setViewportSize({ width: 1280, height: 420 });
  // rounded: at a fractional offset Firefox reports a 320px box as 319.99998
  await expect.poll(async () => Math.round((await stage.boundingBox()).height * 100) / 100).toBeGreaterThanOrEqual(320);
});

test("Map page: the toolbar floats on the map in two groups and keeps every control's name", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Toolbar");
  const mid = await mapWithPicture(page, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage"), bar = stage.locator(".map-toolbar");
  await expect(bar).toBeVisible();
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
  const n = await page.locator(".map-note").boundingBox(), t = await bar.boundingBox();
  expect(n.y).toBeLessThan(t.y + t.height + 24);   // at the top of the map, just under the toolbar
  await page.getByRole("button", { name: "Measure/Route" }).click();   // no scale yet: the hint says so and measure mode doesn't start
  await expect(page.locator(".map-measure-bar")).toBeHidden();
});

test("Map page: a map with no picture shows the message and no picture-only tools", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Blank");
  const mid = (await api(page, "map_save", { name: "Blank" }, cid)).json.map.id;
  const errors = watchErrors(page);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await expect(page.locator(".map-empty")).toContainText("no picture yet");
  await expect(page.getByRole("button", { name: "Add pin" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Labels" })).toBeHidden();
  await page.keyboard.press("p");
  await page.keyboard.press("Escape");
  expectNoErrors(errors);
});

test("Map page: setup lives in the Map settings menu, in order, and players have no menu", async ({ page, browser }) => {
  const { cid, pp } = await setup(page, browser, "Gear");
  const mid = await mapWithPicture(page, cid);
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

test("Map page: the pin form opens on the map under the toolbar and scrolls inside the stage", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Panel");
  const mid = await mapWithPicture(page, cid);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const stage = page.locator(".map-view .map-stage");
  await page.getByRole("button", { name: "Add pin" }).click();
  await clickPic(page, 0.7, 0.6);
  const form = page.getByRole("dialog", { name: "Add pin" });
  await expect(form).toBeVisible();
  const s = await stage.boundingBox(), f = await form.boundingBox(), t = await stage.locator(".map-toolbar").boundingBox();
  expect(f.y).toBeGreaterThan(t.y + t.height);
  expect(f.x).toBeGreaterThanOrEqual(s.x);
  expect(f.y + f.height).toBeLessThanOrEqual(s.y + s.height + 1);   // it scrolls inside the stage rather than growing past it
  expect(f.width).toBeLessThanOrEqual(420);
  // with Icon and colour open it is taller than the stage, and its Add pin and Cancel stay in sight at its foot
  await form.getByText("Icon and colour").click();
  const save = form.getByRole("button", { name: "Add pin" });
  const b = await save.boundingBox(), f2 = await form.boundingBox();
  expect(b.y + b.height).toBeLessThanOrEqual(f2.y + f2.height + 1);
  expect(b.y).toBeGreaterThanOrEqual(f2.y);
  expect(b.y + b.height).toBeLessThanOrEqual(600);   // on the screen, not under its foot
  await save.click({ trial: true });   // nothing lies over it
});

test("Map page: the drawer slides over the map without resizing it, and its search filters the rows", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Drawer");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Boldhome", "Jonstown", "Wilmskirk"]);
  expect((await api(page, "route_save", { map_id: mid, name: "King's Road", points: [[10, 10], [200, 150]] }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const canvas = page.locator(".map-view .leaflet-container");
  await openDrawer(page);
  const before = await canvas.boundingBox();
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

test("Map page: the drawer has a solid background, and a tick on each group hides or shows all of it at once", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Group ticks");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford", "Mirewood", "Old Mill"]);
  await api(page, "route_save", { map_id: mid, name: "East Road", points: [[20, 20], [200, 20]] }, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await openDrawer(page);
  const bg = await page.locator(".map-routes").evaluate(n => getComputedStyle(n).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");   // the map's picture doesn't show through the rows
  const all = page.getByRole("checkbox", { name: "Show all locations" });
  await expect(all).toBeChecked();
  await expect(page.locator(".map-pin")).toHaveCount(3);
  await all.uncheck();
  await expect(page.locator(".map-pin")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Show Mirewood on the map" })).not.toBeChecked();
  await expect(page.locator(".map-side-sec").filter({ hasText: "Locations" })).toHaveAttribute("open", "");   // the tick doesn't fold the group
  await expect(page.locator(".map-route-line")).not.toHaveCount(0);   // routes are a group of their own
  await page.getByRole("checkbox", { name: "Show Mirewood on the map" }).check();
  await expect(page.locator(".map-pin")).toHaveCount(1);
  await expect(all).not.toBeChecked();
  await all.check();
  await expect(page.locator(".map-pin")).toHaveCount(3);
  // every tick sits at the right, clear of the group's fold arrow at the left
  const sum = await page.locator(".map-side-sec").filter({ hasText: "Locations" }).locator("summary").boundingBox(), t = await all.boundingBox();
  expect(t.x).toBeGreaterThan(sum.x + sum.width / 2);
  const row = await page.locator(".map-place-row", { hasText: "Mirewood" }).boundingBox(), rt = await page.getByRole("checkbox", { name: "Show Mirewood on the map" }).boundingBox();
  expect(rt.x).toBeGreaterThan(row.x + row.width / 2);
  await page.getByRole("checkbox", { name: "Show all routes" }).uncheck();
  await expect(page.getByRole("checkbox", { name: "Show East Road on the map" })).not.toBeChecked();
});

test("Map page: the toolbar folds away to one button, and stays as left", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Fold tools");
  const mid = await mapWithPicture(page, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const pin = page.getByRole("button", { name: "Add pin", exact: true });
  await expect(pin).toBeVisible();
  await page.getByRole("button", { name: "Hide the toolbar" }).click();
  await expect(pin).toBeHidden();
  await expect(page.getByRole("button", { name: "Labels" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show the toolbar" })).toBeVisible();
  await expect(pin).toBeHidden();
  await page.keyboard.press("p");   // its keys still work while it is folded
  await expect(page.locator('button[aria-label="Add pin"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show the toolbar" }).click();
  await expect(pin).toBeVisible();
});

test("Map page: measuring, a click on a pin lays the point on it, so a route starts and ends at locations", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Snap");
  const mid = await mapWithPicture(page, cid, { scale_per_px: 0.1, scale_unit: "mi" });
  await notePins(page, cid, mid, ["Burnt Ford", "Mirewood"]);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await page.getByRole("button", { name: "Measure" }).click();
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await page.locator(".map-pin", { hasText: "Mirewood" }).click();
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);   // no card opens while measuring
  await page.getByRole("button", { name: "Save route…" }).click();
  await page.getByLabel("Route name").fill("Ford road");
  await page.getByRole("dialog", { name: "Save route" }).getByRole("button", { name: "Save route" }).click();
  await openDrawer(page);
  await expect(page.locator(".map-route", { hasText: "Ford road" }).locator(".map-route-ends")).toHaveText("Burnt Ford → Mirewood");
  const route = (await getMap(page, cid, mid)).json.routes[0];
  expect(route.points).toEqual([[60, 60], [140, 130]]);   // exactly the pins' points
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();   // out of measuring, a click opens the card again
  await expect(page.locator(".leaflet-popup")).toBeVisible();
});

test("Map page: the mode hint never covers the form open under the toolbar", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Hint");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford"]);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await page.getByRole("button", { name: "Quick label" }).click();
  await expect(page.locator(".map-note")).toContainText("Click a place on the map");
  const pic = await settledBox(page.locator(".map-view img.leaflet-image-layer"));
  await page.mouse.click(pic.x + pic.width * 0.6, pic.y + pic.height * 0.7);
  const form = page.locator(".map-label-form");
  await expect(form).toBeVisible();
  await expect(page.locator(".map-note")).toBeVisible();   // the hint still says how to finish
  const f = await settledBox(page.locator(".map-panel-box")), n = await settledBox(page.locator(".map-note"));
  const overlap = !(n.y >= f.y + f.height || n.y + n.height <= f.y || n.x >= f.x + f.width || n.x + n.width <= f.x);
  expect(overlap).toBe(false);
  await expect(form.getByRole("button", { name: "Pin it" })).toBeVisible();
  await form.getByRole("button", { name: "Skip" }).click();   // its buttons take a click, nothing over them
  await expect(form).toHaveCount(0);
});

test("Map page: pin labels show by zoom, hover, selection and the Labels toggle; the party is always labelled", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "Labels");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford", "Mirewood"]);
  const g = (await api(page, "groups", undefined, cid)).json.groups[0];
  expect((await api(page, "group_move", { id: g.id, map_id: mid, x: 250, y: 160 }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const ford = page.locator(".map-pin", { hasText: "Burnt Ford" }), label = ford.locator(".map-marker-label");
  await expect(label).toHaveCSS("opacity", "0");
  await expect(page.locator(".map-party .map-marker-label")).toHaveCSS("opacity", "1");
  await ford.hover();
  await expect(label).toHaveCSS("opacity", "1");
  await page.mouse.move(5, 5);
  await expect(label).toHaveCSS("opacity", "0");
  await ford.click();
  await expect(page.locator(".map-pin.selected")).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(label).toHaveCSS("opacity", "1");
  await page.locator(".leaflet-popup-close-button").click();
  await expect(page.locator(".map-pin.selected")).toHaveCount(0);
  // one step at a time: Leaflet drops a zoom asked for while the last one is still animating
  const zoom = async button => { await page.locator(button).click(); await page.waitForTimeout(350); await expect(page.locator(".map-view .leaflet-zoom-anim")).toHaveCount(0); };
  const zoomIn = () => zoom(".leaflet-control-zoom-in"), zoomOut = () => zoom(".leaflet-control-zoom-out");
  await zoomIn(); await zoomIn();
  await expect(page.locator(".map-stage")).toHaveClass(/zoomed-in/);
  await expect(label).toHaveCSS("opacity", "1");
  await zoomOut(); await zoomOut();
  await expect(page.locator(".map-stage")).not.toHaveClass(/zoomed-in/);
  await page.getByRole("button", { name: "Labels" }).click();
  await expect(page.getByRole("button", { name: "Labels" })).toHaveAttribute("aria-pressed", "true");
  await expect(label).toHaveCSS("opacity", "1");
  await page.reload();
  await expect(page.getByRole("button", { name: "Labels" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-pin", { hasText: "Mirewood" }).locator(".map-marker-label")).toHaveCSS("opacity", "1");
  // Labels turned off stays off close up too, and after a reload
  await page.getByRole("button", { name: "Labels" }).click();
  await expect(page.getByRole("button", { name: "Labels" })).toHaveAttribute("aria-pressed", "false");
  await zoomIn(); await zoomIn();
  await expect(page.locator(".map-stage")).toHaveClass(/zoomed-in/);
  await expect(label).toHaveCSS("opacity", "0");
  await page.reload();
  await zoomIn(); await zoomIn();
  await expect(page.locator(".map-pin", { hasText: "Mirewood" }).locator(".map-marker-label")).toHaveCSS("opacity", "0");
});

test("Map page: a legend sits bottom-left, and P, L, M, T and Escape drive the modes except while typing", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Keys");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Camp"]);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const legend = page.getByLabel("Legend");
  await expect(legend.locator(".map-legend-item")).toHaveText(["📍 Place", "📅 Event", "📝 Note", "🚩 Party", "GM only"]);
  if (page.viewportSize().width > 720) {
    const s = await page.locator(".map-stage").boundingBox(), g = await legend.boundingBox();
    expect(g.x - s.x).toBeLessThan(40); expect(s.y + s.height - (g.y + g.height)).toBeLessThan(40);
  } else await expect(legend).toBeHidden();   // a phone keeps its small screen for the map
  await openDrawer(page);
  const pin = page.getByRole("button", { name: "Add pin" });
  await page.keyboard.press("p");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("t");
  await expect(page.getByRole("button", { name: "Place party" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Place party" })).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Find on this map").fill("");
  await page.getByLabel("Find on this map").press("p");
  await expect(page.getByLabel("Find on this map")).toHaveValue("p");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await page.goto(`index.html#/c/${cid}/maps`);
  await expect(page.locator(".map-list-head")).toBeVisible();
  await page.keyboard.press("m");   // the listener went with the page: nothing happens, and nothing throws
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await expect(page.locator(".map-view .leaflet-container")).toBeVisible();
  await expect(page.getByRole("button", { name: "Measure/Route" })).toHaveAttribute("aria-pressed", "false");
  expectNoErrors(errors);
});

test("Map page: on a phone the toolbar is icons only and the drawer is a bottom sheet that folds away for an open card or a tool", async ({ page, browser }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "phone layout");
  const { cid } = await setup(page, browser, "Phone");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford"]);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  const pin = page.getByRole("button", { name: "Add pin" });
  await expect(pin).toBeVisible();
  expect((await pin.boundingBox()).width).toBeLessThan(56);
  expect((await pin.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(pin.locator(".map-tool-word")).toBeHidden();
  await expect(page.locator(".map-routes")).toHaveClass(/closed/);   // on a phone it starts closed, leaving the map whole
  await openDrawer(page);
  await page.locator(".map-stage").scrollIntoViewIfNeeded();
  const stage = await page.locator(".map-stage").boundingBox(), drawer = await settledBox(page.locator(".map-routes"));
  expect(drawer.width).toBeGreaterThanOrEqual(stage.width - 1);
  expect(drawer.height).toBeLessThanOrEqual(stage.height * 0.5);
  await page.locator(".map-place", { hasText: "Burnt Ford" }).tap();   // its row in the sheet centres the map on it and opens its card
  const card = page.locator(".leaflet-popup");
  await expect(card).toBeVisible();
  // the card wants more of the map than the sheet leaves, so the sheet folds away while it is open, and comes back after
  await expect(page.locator(".map-routes")).toHaveClass(/closed/);
  const box = await settledBox(card), st = await page.locator(".map-stage").boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(st.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(st.y + st.height + 1);
  await page.locator(".leaflet-popup-close-button").tap();
  await expect(page.locator(".map-routes")).toHaveClass(/open/);
  // so does a tool
  const addPin = page.getByRole("button", { name: "Add pin", exact: true });
  await addPin.tap();
  await expect(page.locator(".map-routes")).toHaveClass(/closed/);
  await addPin.tap();
  await expect(page.locator(".map-routes")).toHaveClass(/open/);
});

test("At the Table: the party card shows the map around the party, and a GM's new event can be pinned where the party is", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Table map");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford"]);                  // at 60, 60
  const g = (await api(page, "groups", undefined, cid)).json.groups[0];
  expect((await api(page, "group_move", { id: g.id, map_id: mid, x: 70, y: 70 }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}`);
  const mini = page.locator(".tv-party .mini-map");
  await expect(mini).toBeVisible();
  await expect(mini.locator(".mm-flag")).toHaveCount(1);
  await expect(mini.locator(".mm-pin")).toHaveCount(1);
  await expect(mini).toHaveAttribute("href", `#/c/${cid}/maps/${mid}`);
  // + Event on the floating bar, pinned at the party's marker
  await page.locator(".tv-bar").getByRole("button", { name: "+ Event" }).click();
  const form = page.locator(".tv-bar-pop form.event:not(.reminder)");
  await form.getByLabel("Title").fill("Ambush at the ford");
  await form.getByLabel(/Pin it where the party is/).check();
  await form.getByRole("button", { name: "Add event" }).click();
  await expect(page.locator("#toast")).toHaveText("Event saved");
  await expect.poll(async () => (await getMap(page, cid, mid)).json.pins.find(p => p.kind === "event")?.event?.title).toBe("Ambush at the ford");
  const pin = (await getMap(page, cid, mid)).json.pins.find(p => p.kind === "event");
  expect([pin.x, pin.y]).toEqual([70, 70]);
  expectNoErrors(errors);
});

test("Map page: moving the main group offers to log it on the clock's shift, by the pin it is at", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Log move");
  const mid = await mapWithPicture(page, cid);
  await notePins(page, cid, mid, ["Burnt Ford"]);
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  const d = Math.floor(now / 4), i = now % 4;
  await api(page, "shift_save", { abs_day: d, shift: i, activity: "Breakfast", gm_notes: "Spy watches" }, cid);
  await page.goto(`index.html#/c/${cid}/maps/${mid}`);
  await page.locator(".map-pin", { hasText: "Burnt Ford" }).click();
  await page.locator(".leaflet-popup").getByRole("button", { name: "Party is here" }).click();
  const note = page.locator(".map-note");
  await expect(note).toContainText('moved. Log "Moved to Burnt Ford"');
  await note.getByRole("button", { name: "Log it", exact: true }).click();
  await expect(note).toBeEmpty();
  const shift = async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=${d}`)).json()).shifts.find(s => Number(s.shift) === i);
  await expect.poll(async () => (await shift()).activity).toBe("Breakfast\nMoved to Burnt Ford");
  expect((await shift()).gm_notes).toBe("Spy watches");                 // the rest of the shift is kept
  expectNoErrors(errors);
});

test("Sessions: a session's page shows the pinned places it names, on their map", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Session places");
  const mid = await mapWithPicture(page, cid);
  const entry = async name => (await api(page, "entry_save", { name, category: "location", notes: "<p>A place.</p>" }, cid)).json.id;
  const ford = await entry("Burnt Ford"), mire = await entry("Mirewood");
  await entry("Nowhere Pinned");
  expect((await api(page, "pin_save", { map_id: mid, x: 60, y: 60, kind: "entry", entry_id: ford }, cid)).status).toBe(200);
  expect((await api(page, "pin_save", { map_id: mid, x: 200, y: 120, kind: "entry", entry_id: mire }, cid)).status).toBe(200);
  const sid = (await api(page, "session_save", {}, cid)).json.session.id;
  await api(page, "session_notes_save", { id: sid, notes_text: "Crossed at Burnt Ford\nNowhere Pinned was empty", base: null }, cid);
  await api(page, "session_summary_save", { id: sid, version: 1, summary: "<p>They reached Mirewood.</p>" }, cid);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  const places = page.locator(".sess-places");
  await expect(places.locator(".mini-map")).toBeVisible();
  await expect(places.locator(".mm-pin")).toHaveCount(2);
  await expect(places.locator(".sess-place-list a")).toHaveText(["📍 Burnt Ford", "📍 Mirewood"]);
  // a player reads the published summary: only Mirewood is named there
  await api(page, "session_save", { id: sid, is_published: true }, cid);
  await pp.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(pp.locator(".sess-places .sess-place-list a")).toHaveText(["📍 Mirewood"]);
  expectNoErrors(errors);
});

test("Trail: At the Table says where the party was the shift before, and the day's Locations visited offers the pins it passed", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Was near");
  const mid = await mapWithPicture(page, cid);
  const ford = (await api(page, "entry_save", { name: "Burnt Ford", category: "location" }, cid)).json.id;
  expect((await api(page, "pin_save", { map_id: mid, x: 60, y: 60, kind: "entry", entry_id: ford }, cid)).status).toBe(200);
  await notePins(page, cid, mid, ["Camp"]);                                    // a note pin at 60, 60 too, but no entry: never offered
  const g = (await api(page, "groups", undefined, cid)).json.groups[0];
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  await api(page, "group_move", { id: g.id, map_id: mid, x: 62, y: 61, stops: [] }, cid);
  // a stop can't be on or after the clock
  expect((await api(page, "group_move", { id: g.id, map_id: mid, x: 250, y: 160, stops: [{ x: 1, y: 1, abs_shift: now }] }, cid)).status).toBe(400);
  await api(page, "set_time", { current_shift: now + 1 }, cid);
  await api(page, "group_move", { id: g.id, map_id: mid, x: 250, y: 160 }, cid);
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator(".tv-side.prev")).toContainText("Was near Burnt Ford");
  await expect(pp.goto(`index.html#/c/${cid}`)).resolves.toBeTruthy();
  await expect(pp.locator(".tv-side.prev")).toContainText("Was near Burnt Ford");   // players see the trail too
  // the day's Locations visited offers Burnt Ford from the trail, though no shift names it
  await page.locator(".tv-summary").getByRole("button", { name: "✎ Day" }).click();
  await expect(page.locator(".loc-suggest")).toContainText("+ Burnt Ford");
  await page.locator(".loc-suggest").getByRole("button", { name: "+ Burnt Ford" }).click();
  await expect(page.getByLabel("Locations visited")).toHaveValue("Burnt Ford");
  expectNoErrors(errors);
});
