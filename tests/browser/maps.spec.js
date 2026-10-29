// The Maps tab: maps (an uploaded image with pins, routes and a scale), tokens and party groups.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, makePng, tokenUpload, settledBox, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("Maps: a fresh install has the tables, and the campaign says maps are ready", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Maps tables");
  const r = await api(page, "campaign", undefined, cid);
  expect(r.status).toBe(200);
  expect(r.json.maps_ready).toBe(true);
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

// ---- pins and routes ----
/** A public 300x200 map with a picture; returns its id. */
async function mapWithPicture(page, cid, extra = {}) {
  const id = (await api(page, "map_save", { name: "Sartar", ...extra }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  expect((await api(page, "map_save", { id, image_id: up.json.file.id }, cid)).status).toBe(200);
  return id;
}

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
  await clickMap(page, 0.2, 0.5);
  await clickMap(page, 0.6, 0.5);
  await page.getByRole("spinbutton", { name: "Distance" }).fill("40");
  await page.getByRole("dialog", { name: "Set the scale" }).getByLabel("Unit").selectOption("mi");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  await expect(page.locator(".map-scale")).toContainText(/\d/);
  const saved = (await api(page, "maps", undefined, cid)).json.maps[0];
  expect(saved).toMatchObject({ scale_unit: "mi", grid_px: null });
  expect(saved.scale_per_px).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Measure" }).click();
  await clickMap(page, 0.2, 0.3);
  await clickMap(page, 0.6, 0.3);
  await expect(page.locator(".map-measure-total")).toHaveText(/\d+(\.\d)? mi/);
  // forty miles between the two points used for the scale, so the same span measures forty
  await expect(page.locator(".map-measure-total")).toContainText("40 mi");
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
  const img = await page.locator(".map-view img.leaflet-image-layer").boundingBox();
  const box = await page.locator(".map-view .leaflet-container").boundingBox();
  const at = fx => ({ x: ((box.x + box.width * fx - img.x) / img.width) * 300, y: ((box.y + box.height * 0.5 - img.y) / img.height) * 200 });
  const a = at(0.5), b = at(0.9);
  await clickMap(page, 0.5, 0.5);
  await clickMap(page, 0.9, 0.5);
  await page.getByLabel("How many squares").fill("2");
  await page.getByRole("button", { name: "Save scale" }).click();
  await expect(page.locator(".map-scale")).toBeVisible();
  const saved = (await api(page, "maps", undefined, cid)).json.maps[0];
  expect(saved.scale_unit).toBe("ft");
  expect(saved.grid_px).toBeGreaterThan(0);
  const grid = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  expect(Math.abs(saved.grid_px - grid)).toBeLessThan(1);
  expect(Math.abs(saved.grid_offset_x - (a.x % saved.grid_px))).toBeLessThan(1);
  expect(Math.abs(saved.grid_offset_y - (a.y % saved.grid_px))).toBeLessThan(1);
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
  await expect.poll(() => page.locator(".map-view img.leaflet-image-layer").evaluate(i => i.naturalWidth)).toBe(6000);
  expectNoErrors(errors);
});

test("Maps: a GM renames a map, hides it and deletes it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await setup(page, browser, "Maps manage");
  const id = (await api(page, "map_save", { name: "Old name" }, cid)).json.map.id;
  const up = await upload(page, cid, "map", id);
  await api(page, "map_save", { id, image_id: up.json.file.id }, cid);
  await page.goto(`#/c/${cid}/maps/${id}`);
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
  const box = await page.locator(".map-view .leaflet-image-layer").boundingBox();
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

  await startPin(page, 0.7, 0.6);
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
  const box = await line.boundingBox();
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

test("Maps: before the upgrade the Maps and Tokens tabs say what to do", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Maps not ready");
  await page.route("**/api/index.php?*a=campaign&*", async route => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, maps_ready: false } });
  });
  await page.goto(`#/c/${cid}/maps`);
  await expect(page.getByText("Maps need the database upgrade: open install.php on the server and press Install or upgrade.")).toBeVisible();
  await page.goto(`#/c/${cid}/tokens`);
  await expect(page.getByText("Maps need the database upgrade")).toBeVisible();
  expectNoErrors(errors);
});
