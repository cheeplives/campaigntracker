// VTT map files under Node (static/vtt.js needs no page): Universal VTT, a Foundry scene with its picture, MapTool's
// .rpmap and Fantasy Grounds' .mod, read into one shape, and a map written back out as Universal VTT.
const { test, expect } = require("@playwright/test");
const path = require("path");
const zlib = require("zlib");
const VTT = require(path.join(__dirname, "..", "..", "static", "vtt.js"));
const { makePng } = require("./helpers");

const PNG = new Uint8Array(makePng(30, 20));
const file = (name, data) => ({ name, bytes: typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data) });

/** A zip of [name, bytes] pairs; the odd ones deflated, so both ways are read. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach(([name, data], i) => {
    const raw = Buffer.from(typeof data === "string" ? data : data), deflate = i % 2 === 1;
    const body = deflate ? zlib.deflateRawSync(raw) : raw, n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, body); centrals.push(central, n);
    offset += 30 + n.length + body.length;
  });
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const one = async files => { const found = await VTT.readVtt(files); expect(found).toHaveLength(1); return found[0].read(); };

test("a Universal VTT file gives its picture, its grid from the square size and origin, and says walls and lights aren't kept", async () => {
  const uvtt = { format: 0.3, resolution: { map_origin: { x: -0.25, y: 0 }, map_size: { x: 3, y: 2 }, pixels_per_grid: 10 },
    line_of_sight: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]], portals: [{}], lights: [{}, {}], image: Buffer.from(PNG).toString("base64") };
  const m = await one([file("Goblin_Cave.dd2vtt", JSON.stringify(uvtt))]);
  expect(m).toMatchObject({ format: "Universal VTT", name: "Goblin Cave", grid: { type: "square", px: 10, offset_x: 2.5, offset_y: 0 },
    scale: { per_square: 5, unit: "ft", guessed: true }, dropped: { walls: 2, lights: 2 }, notes: [] });
  expect(m.picture).toMatchObject({ type: "image/png", name: "Goblin Cave.png" });
  expect(Array.from(m.picture.bytes)).toEqual(Array.from(PNG));
});

test("a Foundry scene's JSON with its picture gives the grid, scale, hex shape and its notes on the picture", async () => {
  const scene = { name: "Bree", width: 300, height: 200, padding: 0.25, grid: { type: 4, size: 50, distance: 1, units: "mi" },
    background: { src: "maps/bree.png", offsetX: 10, offsetY: 0 },
    notes: [{ x: 100 + 10 + 20, y: 50 + 15, text: "The Prancing Pony" }, { x: 5, y: 5, text: "In the padding" }], walls: [{}] };
  const m = await one([file("fvtt-Scene-bree.json", JSON.stringify(scene)), file("bree.png", PNG)]);
  expect(m).toMatchObject({ format: "Foundry scene", name: "Bree", grid: { type: "hex_flat", px: 50, offset_x: 40, offset_y: 0 },
    scale: { per_square: 1, unit: "mi" }, dropped: { walls: 1, lights: 0 } });
  expect(m.notes).toEqual([{ x: 20, y: 15, label: "The Prancing Pony" }]);   // padding is 100 x 50 (rounded up to squares), less the offset
  // an older scene keeps its grid in flat fields; a gridless one has none
  const old = await one([file("old.json", JSON.stringify({ name: "Old", width: 300, height: 200, img: "x.png", grid: 70, gridType: 1, gridDistance: 5, gridUnits: "ft" })), file("x.png", PNG)]);
  expect(old).toMatchObject({ grid: { type: "square", px: 70 }, scale: { per_square: 5, unit: "ft" } });
  const none = await one([file("flat.json", JSON.stringify({ name: "Flat", width: 300, height: 200, grid: { type: 0, size: 100 } })), file("x.png", PNG)]);
  expect(none.grid).toBe(null);
  await expect(VTT.readVtt([file("alone.json", JSON.stringify(scene))]).then(f => f[0].read())).rejects.toThrow("Pick the scene's picture together with its JSON file");
});

test("a MapTool .rpmap gives the zone's grid, units per square and picture", async () => {
  const content = `<?xml version="1.0"?><net.rptools.maptool.util.PersistenceUtil_-PersistedMap><zone>
    <grid class="net.rptools.maptool.model.HexGridVertical"><offsetX>3</offsetX><offsetY>4</offsetY><size>40</size></grid>
    <unitsPerCell>10.0</unitsPerCell><name>Moria &amp; Beyond</name>
    <backgroundPaint class="net.rptools.maptool.model.drawing.DrawableTexturePaint"><assetId><id>abc123</id></assetId></backgroundPaint>
  </zone></net.rptools.maptool.util.PersistenceUtil_-PersistedMap>`;
  const rp = zip([["content.xml", content], ["assets/abc123", "<asset/>"], ["assets/abc123.png", Buffer.from(PNG)], ["properties.xml", "<x/>"]]);
  const m = await one([file("moria.rpmap", rp)]);
  expect(m).toMatchObject({ format: "MapTool map", name: "Moria & Beyond", grid: { type: "hex_flat", px: 40, offset_x: 3, offset_y: 4 }, scale: { per_square: 10, unit: "ft" } });
  expect(m.picture.type).toBe("image/png");
});

test("a Fantasy Grounds module lists each map picture to pick from, with its grid", async () => {
  const db = `<root version="4.1"><image><category name="" baseicon="0" decalicon="0">
    <id-00001><image type="image"><layers><layer><bitmap>images/Keep.png</bitmap></layer></layers><grid>on</grid><gridsize>25</gridsize><gridoffset>5,6</gridoffset><gridtype>hexrow</gridtype></image><name type="string">The Keep</name></id-00001>
    <id-00002><image type="image"><bitmap>images\\Vale.png</bitmap><gridsize>20,20</gridsize></image><name type="string">Vale</name></id-00002>
    <id-00003><image type="image"><bitmap>images/missing.png</bitmap></image><name type="string">Missing</name></id-00003>
  </category></image></root>`;
  const mod = zip([["db.xml", db], ["images/Keep.png", Buffer.from(PNG)], ["images/Vale.png", Buffer.from(PNG)], ["definition.xml", "<root/>"]]);
  const found = await VTT.readVtt([file("keep.mod", mod)]);
  expect(found.map(f => f.label)).toEqual(["The Keep", "Vale"]);
  expect(await found[0].read()).toMatchObject({ name: "The Keep", grid: { type: "hex_pointy", px: 25, offset_x: 5, offset_y: 6 }, scale: { per_square: 5, unit: "ft", guessed: true } });
  expect(await found[1].read()).toMatchObject({ name: "Vale", grid: { type: "square", px: 20, offset_x: 0, offset_y: 0 } });
});

test("anything else is refused plainly", async () => {
  await expect(VTT.readVtt([file("notes.txt", "hello")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("x.json", "{\"a\":1}")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("x.dd2vtt", "not json")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("x.mod", "PK not really")])).rejects.toThrow(VTT.NOT_VTT);
  const noPic = { resolution: { pixels_per_grid: 10 }, image: Buffer.from("hello there, world").toString("base64") };
  await expect(one([file("x.uvtt", JSON.stringify(noPic))])).rejects.toThrow("No map picture in that file");
  await expect(VTT.readVtt([file("empty.mod", zip([["db.xml", "<root/>"]]))])).rejects.toThrow("No map picture in that file");
});

test("toUvtt writes a map back out as Universal VTT, which reads back the same", async () => {
  const map = { width: 300, height: 200, grid_px: 50, grid_offset_x: 10, grid_offset_y: 0 };
  const json = JSON.parse(VTT.toUvtt(map, PNG));
  expect(json).toMatchObject({ format: 0.3, resolution: { map_origin: { x: -0.2, y: 0 }, map_size: { x: 6, y: 4 }, pixels_per_grid: 50 }, lights: [], portals: [] });
  const back = await one([file("out.dd2vtt", JSON.stringify(json))]);
  expect(back.grid).toMatchObject({ px: 50, offset_x: 10, offset_y: 0 });
  expect(Array.from(back.picture.bytes)).toEqual(Array.from(PNG));
  expect(() => VTT.toUvtt({ width: 300, height: 200, grid_px: null }, PNG)).toThrow("Set grid squares first (Scale → Grid squares)");
});
