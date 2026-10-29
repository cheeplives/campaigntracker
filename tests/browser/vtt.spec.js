// VTT map files under Node (static/vtt.js needs no page): Universal VTT and a Foundry scene with its picture, read into
// one shape, and a map written back out as Universal VTT.
const { test, expect } = require("@playwright/test");
const path = require("path");
const VTT = require(path.join(__dirname, "..", "..", "static", "vtt.js"));
const { makePng } = require("./helpers");

const PNG = new Uint8Array(makePng(30, 20));
const file = (name, data) => ({ name, bytes: typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data) });

const one = files => VTT.readVtt(files);

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
  await expect(VTT.readVtt([file("alone.json", JSON.stringify(scene))])).rejects.toThrow("Pick the scene's picture together with its JSON file");
});

test("anything else is refused plainly", async () => {
  await expect(VTT.readVtt([file("notes.txt", "hello")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("x.json", "{\"a\":1}")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("x.dd2vtt", "not json")])).rejects.toThrow(VTT.NOT_VTT);
  await expect(VTT.readVtt([file("keep.mod", "PK not really")])).rejects.toThrow(VTT.NOT_VTT);   // Fantasy Grounds and MapTool files aren't read
  await expect(VTT.readVtt([file("moria.rpmap", "PK not really")])).rejects.toThrow(VTT.NOT_VTT);
  const noPic = { resolution: { pixels_per_grid: 10 }, image: Buffer.from("hello there, world").toString("base64") };
  await expect(one([file("x.uvtt", JSON.stringify(noPic))])).rejects.toThrow("No map picture in that file");
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
