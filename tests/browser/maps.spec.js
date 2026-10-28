// The Maps tab: maps (an uploaded image with pins, routes and a scale), tokens and party groups.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

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

// A w x h PNG, all one colour: the zlib stream of a few hundred identical bytes is tiny.
const zlib = require("zlib");
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;                                                          // filter: none
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const MAP_PNG = makePng(300, 200);

async function setup(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
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
  const pctx = await browser.newContext();
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
