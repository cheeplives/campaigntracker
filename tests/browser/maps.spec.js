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
