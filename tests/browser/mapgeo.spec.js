// Map distance maths under Node (static/mapgeo.js needs no page): scale from two points or a grid, grid hints from a
// file name, path lengths, distance wording for ground and space maps, and matching pins to entry names.
const { test, expect } = require("@playwright/test");
const path = require("path");
const E = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const MapGeo = require(path.join(__dirname, "..", "..", "static", "mapgeo.js"));
const { AU, LY } = E;

test("scaleFromPoints turns two points and a distance into a scale, and refuses a nonsense pair", () => {
  expect(MapGeo.scaleFromPoints({ x: 0, y: 0 }, { x: 300, y: 400 }, 40, "mi")).toEqual({ scale_per_px: 0.08, scale_unit: "mi" });
  expect(MapGeo.scaleFromPoints({ x: 0, y: 0 }, { x: 3, y: 4 }, 4.2, "ly").scale_unit).toBe("ly");
  expect(() => MapGeo.scaleFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 40, "mi")).toThrow("Pick two different places");
  expect(() => MapGeo.scaleFromPoints({ x: 0, y: 0 }, { x: 300, y: 400 }, 0, "mi")).toThrow("Type a distance above 0");
});

test("scaleFromGrid, isSpace, units and the Roll20 preset", () => {
  expect(MapGeo.scaleFromGrid(70, 5, "ft")).toEqual({ scale_per_px: 5 / 70, scale_unit: "ft", grid_px: 70 });
  expect(MapGeo.isSpace({ scale_unit: "au" })).toBe(true);
  expect(MapGeo.isSpace({ scale_unit: "ly" })).toBe(true);
  expect(MapGeo.isSpace({ scale_unit: "km" })).toBe(false);
  expect(MapGeo.UNIT_M.au).toBe(149597870700);
  expect(MapGeo.UNIT_M.ly).toBe(9460730472580800);
  expect(MapGeo.ROLL20).toEqual({ grid_px: 70, per_square: 5, unit: "ft" });
});

test("gridHint reads squares or pixels from a file name", () => {
  expect(MapGeo.gridHint("Tavern_30x20.png", 2100, 1400)).toEqual({ grid_px: 70, from: "squares" });
  expect(MapGeo.gridHint("Tavern 30×20.png", 2100, 1400)).toEqual({ grid_px: 70, from: "squares" });
  expect(MapGeo.gridHint("Tavern [30X20].png", 2100, 1400)).toEqual({ grid_px: 70, from: "squares" });
  expect(MapGeo.gridHint("Tavern_30x20.png", 2100, 1000)).toBeNull();
  expect(MapGeo.gridHint("cave_70px.jpg", 1, 1)).toEqual({ grid_px: 70, from: "pixels" });
  expect(MapGeo.gridHint("cave 70 px.jpg", 1, 1)).toEqual({ grid_px: 70, from: "pixels" });
  expect(MapGeo.gridHint("map.png", 10, 10)).toBeNull();
  expect(MapGeo.gridHint("1920x1080.png", 1920, 1080)).toBeNull(); // a resolution, not squares
});

test("pathPx and toMetres", () => {
  expect(MapGeo.pathPx([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
  expect(MapGeo.pathPx([{ x: 1, y: 1 }])).toBe(0);
  expect(MapGeo.toMetres(100, { scale_per_px: 0.5, scale_unit: "km" })).toBe(50000);
  expect(MapGeo.toMetres(100, { scale_per_px: null })).toBeNull();
});

test("fmtDistance on ground maps", () => {
  expect(MapGeo.fmtDistance(12.192, "imperial")).toBe("40 ft");
  expect(MapGeo.fmtDistance(4023.36, "imperial")).toBe("2.5 mi");
  expect(MapGeo.fmtDistance(850, "metric")).toBe("850 m");
  expect(MapGeo.fmtDistance(12000, "metric")).toBe("12 km");
  expect(MapGeo.fmtDistance(160934.4, "imperial")).toBe("100 mi");
  expect(MapGeo.fmtDistance(1609344 * 2, "imperial")).toBe("2,000 mi");
});

test("fmtDistance on space maps", () => {
  expect(MapGeo.fmtDistance(4.2 * LY, "metric", true)).toBe("4.2 ly");
  expect(MapGeo.fmtDistance(5.2 * AU, "imperial", true)).toBe("5.2 AU");
  expect(MapGeo.fmtDistance(999 * AU, "metric", true)).toBe("999 AU");
  expect(MapGeo.fmtDistance(1000 * AU, "metric", true)).toBe("0.016 ly");
  expect(MapGeo.fmtDistance(0.5 * AU, "metric", true)).toBe("0.5 AU");
  expect(MapGeo.fmtDistance(0.05 * AU, "metric", true)).toBe("0.05 AU");
  expect(MapGeo.fmtDistance(0.01 * AU, "metric", true)).toBe("0.01 AU");
  expect(MapGeo.fmtDistance(0.0099 * AU, "metric", true)).toBe("1,481,019 km");
  expect(MapGeo.fmtDistance(384400e3, "metric", true)).toBe("384,400 km");
  expect(MapGeo.fmtDistance(384400e3, "imperial", true)).toBe("238,855 mi");
});

test("nameKey and pinFor match a pin to an entry name", () => {
  expect(MapGeo.nameKey("  The   Prancing  PONY ")).toBe("prancing pony");
  const pins = [{ label: "Bree" }, { label: "Inn", entry_name: "The Prancing Pony" }];
  expect(MapGeo.pinFor(pins, "prancing pony")).toBe(pins[1]);
  expect(MapGeo.pinFor(pins, "BREE")).toBe(pins[0]);
  expect(MapGeo.pinFor(pins, "Rivendell")).toBeNull();
});
