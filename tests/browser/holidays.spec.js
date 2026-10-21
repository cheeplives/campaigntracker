// More holiday rules: the Nth-from-last weekday of a month, every Nth year, moon phases,
// and holidays that run only between two years or a set number of times.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const { watchErrors, expectNoErrors, person, signIn, approve, api } = require("./helpers");

/** The same small calendar as makeCampaign(): two 30-day months, a 5-day week, from year 1, plus a 10-day moon. */
const CALENDAR = {
  months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }],
  weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1,
  moons: [{ name: "Pale", cycle: 10, ref: 0, color: "#dddddd" }],
};
function prepped() {
  const cal = JSON.parse(JSON.stringify(CALENDAR));
  Engine.prep(cal);
  return cal;
}
/** Every day in years 1 to `years` the holiday falls on, as dates. */
function days(cal, rule, years = 8) {
  const out = [];
  for (let d = 0; d < 60 * years; d++) if (Engine.holidayActive(cal, { rule }, d)) out.push(Engine.fmtDate(cal, d, { noWeekday: true }));
  return out;
}

test("engine: last and Nth-from-last weekday of a month", () => {
  const cal = prepped();
  // Day 1 of year 1 is a One, so Secondmonth's Fives are its 5th, 10th … 30th
  expect(days(cal, { type: "nth_weekday", month: 1, weekday: 4, n: -1 }, 1)).toEqual(["30 Secondmonth 1"]);
  expect(days(cal, { type: "nth_weekday", month: 1, weekday: 4, n: -2 }, 1)).toEqual(["25 Secondmonth 1"]);
  expect(days(cal, { type: "nth_weekday", month: 1, weekday: 4, n: -6 }, 1)).toEqual(["5 Secondmonth 1"]);
  // there's no 7th-from-last when a weekday comes 6 times
  expect(days(cal, { type: "nth_weekday", month: 1, weekday: 4, n: -7 }, 1)).toEqual([]);
});

test("engine: every Nth year, between two years, and a set number of times", () => {
  const cal = prepped();
  const fixed = { type: "fixed", month: 0, day: 3 };
  expect(days(cal, { ...fixed, every_years: 3 })).toEqual(["3 Firstmonth 1", "3 Firstmonth 4", "3 Firstmonth 7"]);
  expect(days(cal, { ...fixed, every_years: 2, from_year: 2 })).toEqual(["3 Firstmonth 2", "3 Firstmonth 4", "3 Firstmonth 6", "3 Firstmonth 8"]);
  expect(days(cal, { ...fixed, from_year: 3, until_year: 5 })).toEqual(["3 Firstmonth 3", "3 Firstmonth 4", "3 Firstmonth 5"]);
  expect(days(cal, { ...fixed, until_year: 2 })).toEqual(["3 Firstmonth 1", "3 Firstmonth 2"]);
  expect(days(cal, { ...fixed, times: 2, from_year: 6 })).toEqual(["3 Firstmonth 6", "3 Firstmonth 7"]);
  expect(days(cal, { ...fixed, every_years: 2, times: 2, from_year: 2 })).toEqual(["3 Firstmonth 2", "3 Firstmonth 4"]);
  // a span carries on past the end of the year it started in
  expect(days(cal, { type: "fixed", month: 1, day: 30, span: 2, from_year: 1, until_year: 1 })).toEqual(["30 Secondmonth 1", "1 Firstmonth 2"]);
  // every N days counts its times from the first occurrence
  expect(days(cal, { type: "every_n", start: 10, interval: 25, times: 3 })).toEqual(["11 Firstmonth 1", "6 Secondmonth 1", "1 Firstmonth 2"]);
  expect(days(cal, { type: "every_n", start: 10, interval: 50, from_year: 2, until_year: 3 })).toEqual(["1 Firstmonth 2", "21 Secondmonth 2", "11 Secondmonth 3"]);
  // a holiday saved before limits existed still runs every year
  expect(days(cal, fixed, 3)).toEqual(["3 Firstmonth 1", "3 Firstmonth 2", "3 Firstmonth 3"]);
});

test("engine: moon-phase holidays fall once a cycle, on the day the moon shows that phase", () => {
  const cal = prepped();
  const full = days(cal, { type: "moon_phase", moon: 0, phase: 4 }, 2);
  expect(full).toHaveLength(12);
  for (let d = 0; d < 120; d++) {
    if (Engine.holidayActive(cal, { rule: { type: "moon_phase", moon: 0, phase: 4 } }, d)) expect(Engine.moons(cal, d)[0].label).toBe("Full");
  }
  // only in one month, and only from year 2
  expect(days(cal, { type: "moon_phase", moon: 0, phase: 4, month: 1 }, 2)).toEqual(full.filter(x => x.includes("Secondmonth")));
  expect(days(cal, { type: "moon_phase", moon: 0, phase: 4, from_year: 2 }, 2)).toEqual(full.filter(x => x.endsWith(" 2")));
  // a span runs on from the day of the phase
  expect(days(cal, { type: "moon_phase", moon: 0, phase: 0, span: 2 }, 1)).toHaveLength(12);
  // a moon that's since been removed matches nothing
  expect(days(cal, { type: "moon_phase", moon: 3, phase: 4 }, 1)).toEqual([]);
});

test("a GM adds holidays with the new rules and the calendar shows them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Bryn");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const r = await api(page, "campaign_create", {
    name: `Holidays ${gm.id}`, description: "", current_shift: 8, calendar: CALENDAR,
    settings: {}, regions: [{ name: "Home", settings: { climate: "temperate" }, current: true }], holidays: [],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const cid = r.json.id;
  await page.goto(`index.html#/c/${cid}/holidays`);

  // The second-to-last Five of Secondmonth, every 2 years, 3 times from year 1
  await page.getByRole("button", { name: "+ New holiday" }).click();
  let form = page.locator("form.card").filter({ hasText: "New holiday" });
  await form.locator("input[name=name]").fill("Tithe Day");
  await form.locator("select[name=type]").selectOption("nth_weekday");
  await form.locator("select[name=n]").selectOption("-2");
  await expect(form.locator("select[name=n] option:checked")).toHaveText("2nd to last");
  await form.locator("select[name=weekday]").selectOption("4");
  await form.locator("select[name=month]").selectOption("1");
  await expect(form.locator("input[name=from_year]")).toBeHidden();
  await form.locator("input[name=every_years]").fill("2");
  await expect(form.locator("input[name=from_year]")).toBeVisible();
  await form.locator("select[name=limit]").selectOption("times");
  await expect(form.locator("input[name=until_year]")).toBeHidden();
  await form.locator("input[name=times]").fill("3");
  await form.locator("input[name=from_year]").fill("1");
  await form.getByRole("button", { name: "Save holiday" }).click();
  await expect(page.locator(".listrow").filter({ hasText: "Tithe Day" })).toContainText("Every 2 years: 2nd to last Five of Secondmonth, 3 times from 1");

  // Every full moon of Pale in Firstmonth, between years 1 and 4
  await page.getByRole("button", { name: "+ New holiday" }).click();
  form = page.locator("form.card").filter({ hasText: "New holiday" });
  await form.locator("input[name=name]").fill("Moonfeast");
  await form.locator("select[name=type]").selectOption("moon_phase");
  await expect(form.locator("input[name=every_years]")).toBeHidden();
  // moon phases can't count times
  await expect(form.locator("select[name=limit] option[value=times]")).toBeHidden();
  await form.locator("select[name=phase]").selectOption("4");
  await form.locator("select[name=moon_month]").selectOption("0");
  await form.locator("select[name=limit]").selectOption("years");
  await form.locator("input[name=from_year]").fill("1");
  await form.locator("input[name=until_year]").fill("4");
  await form.getByRole("button", { name: "Save holiday" }).click();
  await expect(page.locator(".listrow").filter({ hasText: "Moonfeast" })).toContainText("Every full moon of Pale in Firstmonth, from 1 to 4");

  const camp = await api(page, "campaign", undefined, cid);
  const rules = Object.fromEntries(camp.json.holidays.map(h => [h.name, h.rule]));
  expect(rules["Tithe Day"]).toEqual({ type: "nth_weekday", span: 1, month: 1, weekday: 4, n: -2, every_years: 2, times: 3, from_year: 1 });
  expect(rules["Moonfeast"]).toEqual({ type: "moon_phase", span: 1, moon: 0, phase: 4, month: 0, from_year: 1, until_year: 4 });

  // The calendar opens on today in year 1, so Firstmonth's full moons carry the holiday
  const cal = prepped();
  const fulls = [];
  for (let d = 0; d < 30; d++) if (Engine.holidayActive(cal, { rule: rules["Moonfeast"] }, d)) fulls.push(d);
  expect(fulls).toHaveLength(3);
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(page.locator(".daycell").filter({ hasText: "Moonfeast" })).toHaveCount(3);
  expectNoErrors(errors);
});
