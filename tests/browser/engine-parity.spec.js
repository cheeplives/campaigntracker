// engine.js gives exactly the same answers in the browser as under Node, in
// every engine (Sinless runs the same check on rules.js).
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));

/** A fixed workload over the calendar, moon, season, weather, visibility and
 * travel maths. Runs in both places, so it may only use what it is passed. */
function workload(E) {
  const out = {};
  for (const [key, preset] of Object.entries(E.PRESETS)) {
    const cal = JSON.parse(JSON.stringify(preset.calendar));
    E.prep(cal);
    const region = preset.regions[0];
    let prev = null;
    out[key] = [-40, 0, 1, 2, 3, 59, 365, 1000, 7777].map(d => {
      const w = E.genWeather(cal, 12345, region, d, prev, 0);
      prev = w;
      const sw = E.shiftWeather(cal, 12345, region, d, w);
      return {
        date: E.fmtDate(cal, d), weekday: E.weekday(cal, d), season: E.season(cal, d, region.settings?.hemisphere),
        moons: E.moons(cal, d), weather: w, shifts: sw,
        vis: [0, 1, 2, 3].map(s => E.visibility(cal, region, (sw && sw[s]) || w, d, s, null)),
      };
    });
  }
  const trip = (mode, q) => { try { return E.travel(mode, q); } catch (e) { return String(e.message); } };
  out.travel = [
    trip("ground", { distance: 120, speed: 3, shifts: 2, shift_hours: 6, terrain: 1.5 }),
    trip("ground", { distance: 50, speed: 5, shifts: 3, shift_hours: 7.5 }),
    trip("hohmann", { system: "sun", r1: 1, r2: 1.524 }),
    trip("brachistochrone", { distance: 1.5, g: 1 }),
    trip("relativistic", { distance: 4.2, g: 1 }),
    trip("ftl", { fixed_hours: 168 }),
  ];
  out.stars = [E.starDistance(0, 6), E.starDistance(1, 2), E.starDistance(2, 6)];
  return JSON.parse(JSON.stringify(out));
}

test("engine.js: browser matches Node", async ({ page }) => {
  await page.setContent("<!doctype html><title>parity</title>");
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "static", "engine.js") });
  const inBrowser = await page.evaluate(`(${workload.toString()})(window.Engine)`);
  expect(inBrowser).toEqual(workload(Engine));
});

test("Middle-earth: Shire Reckoning dates and weekdays", () => {
  const p = Engine.PRESETS.middleearth;
  const cal = JSON.parse(JSON.stringify(p.calendar));
  Engine.prep(cal);
  // every year starts on Sterday, and Overlithe only comes in leap years
  for (const y of [1418, 1419, 1420, 1500]) {
    expect(Engine.fmtDate(cal, Engine.yearStart(cal, y))).toBe(`Sterday, 2 Yule, ${y} S.R.`);
  }
  expect([1419, 1420, 1500].map(y => Engine.yearLength(cal, y))).toEqual([365, 366, 365]);
  // Bilbo's party, 22 Halimath 1401, was a Thursday (Mersday)
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 1401, 13, 22))).toBe("Mersday, 22 Halimath 1401 S.R.");
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 1420, 8, 1))).toBe("Mid-year's Day, 1420 S.R.");
  expect(Engine.weekday(cal, Engine.toAbs(cal, 1420, 9, 1))).toBeNull();
  const rohan = p.regions.find(r => r.name === "Rohan");
  expect(Engine.climateFor(rohan).koppen).toBe("Dfb");
  for (const r of p.regions) expect(Engine.KOPPEN[r.settings.climate.slice(7)]).toBeTruthy();
});

test("Gregorian and Imperial presets: regions carry Köppen climates in the right hemisphere", () => {
  const P = Engine.PRESETS;
  for (const key of ["gregorian", "gregorian_south", "imperial"]) {
    const regions = P[key].regions;
    expect(regions.filter(r => r.current)).toHaveLength(1);
    for (const r of regions) {
      expect(Engine.KOPPEN[r.settings.climate.slice(7)]).toBeTruthy();
      expect(r.settings.hemisphere).toBe(P[key].calendar.hemisphere);
    }
  }
  const named = (key, name) => Engine.climateFor(P[key].regions.find(r => r.name === name)).koppen;
  expect(named("gregorian", "Sahara")).toBe("BWh");
  expect(named("gregorian_south", "Western Cape (Cape Town)")).toBe("Csb");
  expect(named("imperial", "Reikland")).toBe("Cfb");
  expect(named("imperial", "Tilea")).toBe("Csa");
});
