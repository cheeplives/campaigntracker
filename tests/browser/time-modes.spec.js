// Each campaign keeps time in four shifts, two shifts (Day and Night) or hours.
// Switching moves the clock, shift activities, notes and timed events to the
// same time of day, and the day page, pass-time box and travel planner follow.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

test("engine: slots, names and travel in each time mode", () => {
  const cal = mode => { const c = { months: [{ name: "M", days: 30 }], weekdays: [], timeMode: mode }; Engine.prep(c); return c; };
  expect(Engine.slotsPerDay(cal(undefined))).toBe(4);
  expect(Engine.shiftNames(cal("shifts2"))).toEqual(["Day", "Night"]);
  const hours = cal("hours");
  expect(Engine.slotsPerDay(hours)).toBe(24);
  expect(Engine.shiftNames(hours).slice(0, 2)).toEqual(["00:00", "01:00"]);
  // Hours before dawn take the overnight weather and light, then Dawn, Midday and Dusk six hours each.
  expect(Engine.shiftNames(hours).map((_, h) => Engine.slotQuarter(hours, h)).join("")).toBe("333333000000111111222222");
  expect(Engine.visibility(hours, null, null, 0, 13, null).score).toBe(5);
  expect(Engine.visibility(hours, null, null, 0, 2, null).score).toBe(0);
  // 12 hours moving at 8 hours a day: a full day, then 4 more hours.
  const t = Engine.travel("overland", { distance: 60, speed: 5, shifts: 8, slots_per_day: 24, shift_hours: 1, slot: "hour" });
  expect(t.hours).toBe(28);
  expect(t.lines).toEqual(["12.0 hours moving at 5/h", "8 hours on the move a day → 1.2 days"]);
  expect(Engine.hoursToShifts(cal("shifts2"), 30)).toBe(3);
});

test("switching time mode moves the clock, activities and events to the same time of day", async ({ page, browser }) => {
  const gm = person("Tam");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Modes ${gm.id}`); // now: Dawn of day 2
  await api(page, "shift_save", { abs_day: 2, shift: 0, activity: "Breakfast" }, cid);
  await api(page, "shift_save", { abs_day: 2, shift: 1, activity: "Market" }, cid);
  await api(page, "shift_note_add", { abs_day: 2, shift: 2, body: "Sunset was red" }, cid);
  await api(page, "event_save", { abs_day: 2, shift: 2, shift_end: 3, title: "Feast" }, cid);
  await api(page, "event_save", { abs_day: 2, title: "Fair" }, cid);
  const calendar = async () => (await api(page, "campaign", undefined, cid)).json.campaign;
  // A rest from Midday of day 2 to Dawn of day 3, and a short rest that cost no shift at Dawn of day 2.
  sql(`INSERT INTO downtimes (campaign_id, kind, start_shift, end_shift, slots) VALUES (${cid}, 'long_rest', 9, 12, 4), (${cid}, 'short_rest', 8, 8, 0)`);
  const rests = () => sql(`SELECT start_shift, end_shift, slots FROM downtimes WHERE campaign_id = ${cid} ORDER BY id`).trim().split("\n");

  // Four shifts to hours: Dawn is 06:00, Midday 12:00, and the overnight shift runs to 05:00 the next day.
  let c = await calendar();
  expect((await api(page, "campaign_update", { calendar: { ...c.calendar, timeMode: "hours" } }, cid)).status).toBe(200);
  expect((await calendar()).current_shift).toBe(2 * 24 + 6);
  const rows = () => sql(`SELECT abs_day, shift, activity FROM shifts WHERE campaign_id = ${cid} ORDER BY abs_day, shift`).trim().split("\n");
  expect(rows()).toEqual(["2\t6\tBreakfast", "2\t12\tMarket"]);
  const events = () => sql(`SELECT title, abs_day, IFNULL(end_day, '-'), IFNULL(shift, '-'), IFNULL(shift_end, '-') FROM events WHERE campaign_id = ${cid} ORDER BY id`).trim().split("\n");
  expect(events()).toEqual(["Feast\t2\t3\t18\t5", "Fair\t2\t-\t-\t-"]);
  expect(sql(`SELECT abs_day, shift FROM shift_notes WHERE campaign_id = ${cid}`).trim()).toBe("2\t18");
  expect(rests()).toEqual(["60\t83\t24", "54\t54\t0"]);

  // Hours to two shifts: the morning's activities join in Day, the evening is Night.
  c = await calendar();
  await api(page, "campaign_update", { calendar: { ...c.calendar, timeMode: "shifts2" } }, cid);
  expect((await calendar()).current_shift).toBe(2 * 2);
  expect(rows()).toEqual(["2\t0\tBreakfast\\nMarket"]); // mysql -N prints the newline as \n
  expect(events()).toEqual(["Feast\t2\t-\t1\t1", "Fair\t2\t-\t-\t-"]);
  expect(sql(`SELECT abs_day, shift FROM shift_notes WHERE campaign_id = ${cid}`).trim()).toBe("2\t1");

  // Two shifts back to four: Day starts at Dawn and Night at Dusk.
  c = await calendar();
  await api(page, "campaign_update", { calendar: { ...c.calendar, timeMode: "shifts4" } }, cid);
  expect((await calendar()).current_shift).toBe(2 * 4);
  expect(events()).toEqual(["Feast\t2\t-\t2\t3", "Fair\t2\t-\t-\t-"]);

  // A slot past the end of the day is refused.
  expect((await api(page, "shift_save", { abs_day: 2, shift: 4, activity: "x" }, cid)).status).toBe(400);
});

test("in hours mode the day, pass-time box and travel planner count hours", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Ola");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Clock ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator("select[name=time_mode]").selectOption("hours");
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".now-date")).toContainText("06:00");

  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator("[data-box=shifts] .daybox-toggle")).toHaveText("Hours");
  await expect(page.locator(".shiftcard")).toHaveCount(24);
  await expect(page.locator(".shiftcard.now h4")).toContainText("06:00");
  await expect(page.getByLabel("Unit").locator("option").first()).toHaveText("hour(s)");
  await page.getByRole("button", { name: "Pass time ▶" }).click();
  await expect(page.locator(".now-date")).toContainText("07:00");

  await page.goto(`index.html#/c/${cid}/travel`);
  await page.locator("select.travel-mode").selectOption("overland");
  await expect(page.locator("select[name=shifts]")).toHaveValue("8");
  await expect(page.locator("select[name=shifts] option").first()).toHaveText("1 hour");
  await page.locator("input[name=distance]").fill("60");
  await page.locator("input[name=speed]").fill("5");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".depart")).toContainText("28 hours (1.2 days)");
  expectNoErrors(errors);
});
