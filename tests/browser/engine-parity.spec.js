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
        ground: E.groundConditions(cal, 12345, region, d, new Map(), { days: 20 }).map(g => E.groundLabel(g, "C")),
      };
    });
  }
  const trip = (mode, q) => { try { return E.travel(mode, q); } catch (e) { return String(e.message); } };
  out.travel = [
    trip("ground", { distance: 120, speed: 3, shifts: 2, shift_hours: 6, terrain: 1.5 }),
    trip("ground", { distance: 50, speed: 5, shifts: 3, shift_hours: 7.5 }),
    trip("sea", { distance: 300, speed: 9, shifts: 4 }),
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

test("Glorantha: seasons of named weeks, Sacred Time, the Red Moon and holy days", () => {
  const p = Engine.PRESETS.glorantha;
  const cal = JSON.parse(JSON.stringify(p.calendar));
  Engine.prep(cal);
  // 294 days is exactly 42 weeks, so every year starts on Freezeday of Disorder Week in Sea Season
  for (const y of [1, 1625, 1626]) {
    expect(Engine.yearLength(cal, y)).toBe(294);
    expect(Engine.fmtDate(cal, Engine.yearStart(cal, y))).toBe(`Freezeday, Disorder Week, Sea Season, ${y} ST`);
  }
  const storm = Engine.toAbs(cal, 1625, 4, 5 * 7 + 4); // Windsday of Movement Week, Storm Season
  expect(Engine.fmtDate(cal, storm)).toBe("Windsday, Movement Week, Storm Season, 1625 ST");
  expect(Engine.holidaysOn(cal, p.holidays, storm).map(h => h.name)).toContain("Orlanth High Holy Day");
  expect(Engine.season(cal, storm).name).toBe("Storm Season");
  const last = Engine.toAbs(cal, 1625, 5, 14);
  expect(Engine.fmtDate(cal, last)).toBe("Godsday, Second Week, Sacred Time, 1625 ST");
  expect(Engine.holidaysOn(cal, p.holidays, last).map(h => h.name)).toEqual(expect.arrayContaining(["Sacred Time", "Lhankor Mhy High Holy Day"]));
  // the Red Moon is Black on Waterday and Full on Wildday, every week
  for (let d = 0; d < 14; d++) {
    const wd = cal.weekdays[Engine.weekday(cal, d)], label = Engine.moons(cal, d)[0].label;
    if (wd === "Waterday") expect(label).toBe("New");
    if (wd === "Wildday") expect(label).toBe("Full");
  }
  expect(p.regions.filter(r => r.current)).toHaveLength(1);
  for (const r of p.regions) expect(Engine.KOPPEN[r.settings.climate.slice(7)]).toBeTruthy();
  // a calendar without week names leaves {w} out cleanly
  const plain = { ...JSON.parse(JSON.stringify(Engine.PRESETS.custom.calendar)), dateFormat: "{W}, {w}, {M}, {Y}" };
  Engine.prep(plain);
  expect(Engine.fmtDate(plain, 0)).toBe("Firstday, Month 1, 1");
});

test("weeks of any length: weekdays, Nth weekday holidays and week names", () => {
  // a 5-day week over 30-day months: each weekday falls 6 times a month
  const five = { months: [{ name: "Ember", days: 30 }, { name: "Frost", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1 };
  Engine.prep(five);
  expect(Engine.weekLength(five)).toBe(5);
  expect(Engine.maxWeekdaysInMonth(five)).toBe(6);
  expect([0, 4, 5, 30, 31].map(d => Engine.weekday(five, d))).toEqual([0, 4, 0, 0, 1]);
  const sixth = { name: "Sixth Three", rule: { type: "nth_weekday", month: 1, weekday: 2, n: 6, span: 1 } };
  const hit = Engine.toAbs(five, 1, 1, 28);
  expect(Engine.weekday(five, hit)).toBe(2);
  expect(Engine.holidaysOn(five, [sixth], hit).map(h => h.name)).toEqual(["Sixth Three"]);
  expect(Engine.holidaysOn(five, [{ ...sixth, rule: { ...sixth.rule, n: -1 } }], hit)).toHaveLength(1);
  // the Imperial Calendar's 8-day week and Standard Ship Time's 6-day one
  const imperial = JSON.parse(JSON.stringify(Engine.PRESETS.imperial.calendar));
  Engine.prep(imperial);
  expect(Engine.weekLength(imperial)).toBe(8);
  expect(new Set(Array.from({ length: 40 }, (_, d) => Engine.weekday(imperial, d)).filter(w => w !== null)).size).toBe(8);
  const ship = JSON.parse(JSON.stringify(Engine.PRESETS.shipclock.calendar));
  Engine.prep(ship);
  expect(Engine.weekLength(ship)).toBe(6);
  // named weeks follow the week's length, so a 10-day week names days 11 to 20 the second week
  const decade = { months: [{ name: "Germinal", days: 30, weeks: ["First Decade", "Second Decade", "Third Decade"] }],
    weekdays: ["Primidi", "Duodi", "Tridi", "Quartidi", "Quintidi", "Sextidi", "Septidi", "Octidi", "Nonidi", "Décadi"], epochYear: 1, dateFormat: "{W}, {w}, {d} {M}" };
  Engine.prep(decade);
  expect(Engine.fmtDate(decade, 10)).toBe("Primidi, Second Decade, 11 Germinal");
  expect(Engine.fmtDate(decade, 29)).toBe("Décadi, Third Decade, 30 Germinal");
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(Engine.ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
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
