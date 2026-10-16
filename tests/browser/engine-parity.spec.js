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
    trip("ground", { distance: 120, speed: 3, hours_per_day: 8, terrain: 1.5 }),
    trip("hohmann", { system: "sun", r1: 1, r2: 1.524 }),
    trip("brachistochrone", { distance: 1.5, g: 1 }),
    trip("relativistic", { distance: 4.2, g: 1 }),
    trip("ftl", { fixed_hours: 168 }),
  ];
  return JSON.parse(JSON.stringify(out));
}

test("engine.js: browser matches Node", async ({ page }) => {
  await page.setContent("<!doctype html><title>parity</title>");
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "static", "engine.js") });
  const inBrowser = await page.evaluate(`(${workload.toString()})(window.Engine)`);
  expect(inBrowser).toEqual(workload(Engine));
});
