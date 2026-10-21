// Seasons can set sunrise and sunset on their first day. Days in between blend
// from one season's times to the next, the day page shows them, and natural
// light at dawn and dusk (or each hour in hours mode) follows them.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const { watchErrors, expectNoErrors, person, signIn, approve, api } = require("./helpers");

const SEASONS = [
  { name: "Long days", type: "summer", month: 0, day: 1 },
  { name: "Short days", type: "winter", month: 1, day: 1 },
];
const TIMES = [["04:00", "20:00"], ["08:00", "16:00"]];
const calendar = (extra = {}) => ({
  months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1,
  seasons: SEASONS.map((s, i) => ({ ...s, sunrise: TIMES[i][0], sunset: TIMES[i][1] })), ...extra,
});

test("engine: sun times blend between seasons and light dawn and dusk", () => {
  const c = Engine.prep(calendar());
  const clock = d => { const t = Engine.sunTimes(c, d); return `${Engine.fmtClock(t.sunrise)}–${Engine.fmtClock(t.sunset)}`; };
  expect(clock(0)).toBe("04:00–20:00");
  expect(clock(15)).toBe("06:00–18:00"); // half way to the short days
  expect(clock(30)).toBe("08:00–16:00");
  expect(clock(45)).toBe("06:00–18:00"); // and back again, wrapping into the next year
  expect(clock(60)).toBe("04:00–20:00");
  // the other hemisphere takes the times from half a year away
  const south = Engine.sunTimes(c, 0, "south");
  expect(Engine.fmtClock(south.sunrise)).toBe("08:00");
  expect(Engine.sunTimes(c, 0).daylight).toBe(16);

  // A clear, moonless day: long evenings brighten Dusk, short days darken Dawn; an even day changes nothing.
  const region = { settings: { lighting: "natural" } };
  const vis = (d, q) => Engine.visibility(c, region, { type: "clear" }, d, q, null);
  expect(vis(15, 0).score).toBe(3);
  expect(vis(15, 2).parts.join()).not.toMatch(/sun/);
  expect(vis(0, 2).score).toBeGreaterThan(1);
  expect(vis(0, 2).parts.join()).toMatch(/sun 04:00–20:00 \+\d/);
  expect(vis(30, 0).score).toBeLessThan(3);

  // Hours mode: each hour takes the sun's light, twilight either side of the sun.
  const h = Engine.prep(calendar({ timeMode: "hours" }));
  const hours = Engine.shiftNames(h).map((_, i) => Engine.visibility(h, region, { type: "clear" }, 30, i, null).score);
  expect(hours.slice(6, 18).join(",")).toBe("0,2,4,5,5,5,5,5,5,4,2,0");

  // Seasons with no times: no sun times and the old fixed light.
  const plain = Engine.prep({ ...calendar(), seasons: SEASONS });
  expect(Engine.sunTimes(plain, 0)).toBeNull();
  expect([0, 1, 2, 3].map(q => Engine.visibility(plain, region, { type: "clear" }, 0, q, null).parts[0])).toEqual(
    ["Dawn base (3)", "Midday base (5)", "Dusk base (1)", "Overnight base (0)"]);
  expect(Engine.parseClock("6:30")).toBe(6.5);
  expect(Engine.parseClock("")).toBeNull();
});

test("a GM sets sunrise and sunset on the seasons and the day page shows them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const r = await api(page, "campaign_create", {
    name: `Sun ${gm.id}`, description: "", current_shift: 8, calendar: { ...calendar(), seasons: SEASONS },
    settings: {}, regions: [{ name: "Home", settings: { climate: "temperate" }, current: true }], holidays: [],
  });
  expect(r.status).toBe(200);
  const cid = r.json.id;

  // No times yet: the day page has no Sun line.
  await page.goto(`index.html#/c/${cid}/day/2`);
  await expect(page.getByText("Moons")).toBeVisible();
  await expect(page.locator(".kv .sun")).toHaveCount(0);

  await page.goto(`index.html#/c/${cid}/settings`);
  const rows = page.locator(".seasonrow");
  await expect(rows).toHaveCount(2);
  // one time without the other is refused
  await rows.nth(0).getByLabel("Sunrise").fill("04:00");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByText("Long days: give both sunrise and sunset")).toBeVisible();
  await rows.nth(0).getByLabel("Sunset").fill("20:00");
  await rows.nth(1).getByLabel("Sunrise").fill("8:00");
  await rows.nth(1).getByLabel("Sunset").fill("16:00");
  // the season table previews the first of each month
  await expect(page.locator(".seasonmap")).toContainText("☀ 08:00–16:00");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByText("Calendar saved")).toBeVisible();
  const saved = (await api(page, "campaign", undefined, cid)).json.campaign.calendar.seasons;
  expect(saved.map(s => [s.sunrise, s.sunset])).toEqual([["04:00", "20:00"], ["8:00", "16:00"]]);

  // Day 2 is two days into the long days, a little shorter already.
  await page.goto(`index.html#/c/${cid}/day/2`);
  const sun = page.locator(".kv .sun");
  await expect(sun).toContainText("Sunrise 04:16 · Sunset 19:44");
  await expect(sun).toContainText("15h 28m of daylight");
  // Dusk's visibility counts the late sunset
  await expect(page.locator(".vis[data-tip*='sun 04:16–19:44']").first()).toBeAttached();
  expectNoErrors(errors);
});
