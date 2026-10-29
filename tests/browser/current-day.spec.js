// The Current Day tab opens first, and players only get today's weather up to
// the current shift: the server holds back later shifts and the day's forecast.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign , notNow, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const shift = (type, temp) => ({ type, temp, wind: 1 });
const STORMY = { type: "storm", temp: 20, wind: 2, shift_order: "dawn", shifts: [shift("overcast", 12), shift("rain", 15), shift("storm", 20), shift("rain", 16)] };

test("a campaign opens on the Current Day tab, and the GM's browser saves today's shift weather", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Dana");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Today ${gm.id}`);
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(page.locator(".dayhero")).toContainText("Now");
  await expect(page.locator(".dh-step")).toHaveCount(4);
  await expect(page.locator(".shiftcard.now")).toHaveCount(1);
  const today = async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day?.weather;
  await expect.poll(async () => (await today())?.shifts?.length).toBe(4);
  expect((await today()).shift_order).toBe("dawn");
  // The boxes come in order: Weather, Notes, Session notes (GMs), Shifts, Events, Reminders.
  await expect(page.locator(".daybox")).toHaveCount(5);
  expect(await page.locator(".daybox").evaluateAll(b => b.map(x => x.dataset.box))).toEqual(["weather", "shifts", "notes", "events", "reminders"]);
  await expect(page.locator("[data-box=weather] .dayhero")).toBeVisible();
  // The banner shows the current shift, so the conditions list under it leaves out its own Now line.
  await expect(page.locator(".dayconditions .lbl", { hasText: /^Now$/ })).toHaveCount(0);
  // Locations visited sits in the Notes box, saves with the notes and survives a weather re-roll.
  await page.getByLabel("Locations visited").fill("Altdorf; the Grey Lady inn");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Notes saved")).toBeVisible();
  await notNow(page); // the detector offers Altdorf and the Grey Lady inn for the Encyclopedia
  await expect.poll(async () => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.locations).toBe("Altdorf; the Grey Lady inn");
  // The re-roll saves, then redraws the page: wait for the redraw, so the next click doesn't land on a link it replaces.
  await page.getByLabel("Locations visited").evaluate(e => { e.dataset.beforeReroll = "1"; });
  await page.getByRole("button", { name: "🎲 Re-roll weather" }).click();
  await expect(page.locator("[data-before-reroll]")).toHaveCount(0);
  await expect(page.getByLabel("Locations visited")).toHaveValue("Altdorf; the Grey Lady inn");

  // Next and previous day stay on the tab; Return to today comes back.
  await page.getByRole("link", { name: "Next day ▶" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/today/3$`));
  await expect(page.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(page.getByLabel("Locations visited")).toHaveValue("");
  await page.getByRole("link", { name: "Return to today" }).click();
  await expect(page.locator(".dayhero")).toContainText("Now");
  await page.getByRole("button", { name: "Show in calendar" }).click();
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  expectNoErrors(errors);
});

test("players see today's weather only up to the current shift", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Eli"), player = person("Fay");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Shift weather ${gm.id}`); // now = day 2, Dawn
  expect((await api(page, "days_save", { days: [1, 2, 3].map(d => ({ abs_day: d, weather: STORMY })) }, cid)).status).toBe(200);

  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  const day = async d => (await (await pp.request.get(`api/index.php?a=day&cid=${cid}&d=${d}`)).json()).day.weather;
  expect(await day(1)).toEqual(STORMY);                       // past days: everything
  expect(await day(3)).toBeNull();                            // future days: nothing
  expect(await day(2)).toEqual({ ...shift("overcast", 12), season: null, shifts: [shift("overcast", 12)], partial: true });
  const range = (await (await pp.request.get(`api/index.php?a=days&cid=${cid}&from=1&to=3`)).json()).days;
  expect(range.find(x => x.abs_day === 2).weather.shifts).toHaveLength(1);
  expect(JSON.stringify(range.filter(x => x.abs_day >= 2))).not.toContain("storm");

  // A copy saved in the old Overnight-first order (or with no order) is never handed out.
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: { ...STORMY, shift_order: "overnight" } }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  const { shift_order, ...unmarked } = STORMY;
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: unmarked }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: STORMY }] }, cid)).status).toBe(200);

  expect((await api(page, "day_update", { abs_day: 2, notes: "", locations: "Ubersreik market" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(pp.locator("[data-box=notes]")).toContainText("Ubersreik market");      // players read the day's locations
  await expect(pp.locator("[data-box=weather]")).not.toContainText("Ubersreik market"); // no longer in the weather box
  // Days run Dawn first, so at Dawn the player has Dawn's weather and nothing after it.
  await expect(pp.locator(".shiftcard h4").first()).toHaveText(/^Dawn/);
  await expect(pp.locator(".shiftcard").first()).not.toContainText("Weather not known yet");
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(3);

  // Two shifts later the player has three shifts' weather, still not the forecast.
  expect((await api(page, "set_time", { current_shift: 10 }, cid)).status).toBe(200);
  const w = await day(2);
  expect(w.shifts).toEqual(STORMY.shifts.slice(0, 3));
  expect(w.type).toBe("storm");
  await pp.reload();
  await expect(pp.locator(".shiftcard.now h4")).toContainText("Dusk");
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(1);
  await expect(pp.locator(".shiftcard").last()).toContainText("Overnight");
  await expect(pp.locator(".shiftcard").last()).toContainText("Weather not known yet");

  // Stepping through days on the Current Day tab keeps the same rule: nothing for tomorrow, everything for yesterday.
  await expect(pp.getByRole("link", { name: "Return to today" })).toHaveCount(0);
  await pp.getByRole("link", { name: "Next day ▶" }).click();
  await expect(pp).toHaveURL(new RegExp(`#/c/${cid}/today/3$`));
  await expect(pp.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(pp.locator(".dayhero")).toContainText("Weather not known yet");
  await expect(pp.locator(".dh-step-icon")).toHaveText(["?", "?", "?", "?"]);
  await expect(pp.locator(".shiftcard .wx")).toHaveCount(0);
  await pp.getByRole("link", { name: "◀ Previous day" }).click();
  // wait for day 2 to draw, or the second click lands on day 3's link again
  await expect(pp.getByRole("link", { name: "◀ Previous day" })).toHaveAttribute("href", new RegExp(`/today/1$`));
  await pp.getByRole("link", { name: "◀ Previous day" }).click();
  await expect(pp).toHaveURL(new RegExp(`#/c/${cid}/today/1$`));
  await expect(pp.locator(".dayhero")).toContainText("Past day");
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(0);
  await expect(pp.locator(".dayhero")).toContainText("Thunderstorm");     // a past day shows its forecast
  await pp.getByRole("link", { name: "Return to today" }).click();
  await expect(pp.locator(".dayhero")).toContainText("Now");
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(1);

  // The GM still gets the whole day, and so do players once the GM allows future weather.
  expect((await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.weather).toEqual(STORMY);
  expect((await api(page, "campaign_update", { settings: { players_see_future_weather: true } }, cid)).status).toBe(200);
  expect(await day(2)).toEqual(STORMY);
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
