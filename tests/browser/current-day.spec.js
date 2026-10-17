// The Current Day tab opens first, and players only get today's weather up to
// the current shift: the server holds back later shifts and the day's forecast.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

const shift = (type, temp) => ({ type, temp, wind: 1 });
const STORMY = { type: "storm", temp: 20, wind: 2, shift_order: "overnight", shifts: [shift("overcast", 12), shift("rain", 15), shift("storm", 20), shift("rain", 16)] };

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
  expect((await today()).shift_order).toBe("overnight");
  await page.getByRole("button", { name: "Show in calendar" }).click();
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  expectNoErrors(errors);
});

test("players see today's weather only up to the current shift", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Eli"), player = person("Fay");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Shift weather ${gm.id}`); // now = day 2, first shift
  expect((await api(page, "days_save", { days: [1, 2, 3].map(d => ({ abs_day: d, weather: STORMY })) }, cid)).status).toBe(200);

  const pctx = await browser.newContext();
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

  // A copy saved in a different shift order than the calendar's is never handed out.
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: { ...STORMY, shift_order: "dawn" } }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  const { shift_order, ...unmarked } = STORMY;
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: unmarked }] }, cid)).status).toBe(200);
  expect(await day(2)).toBeNull();
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: STORMY }] }, cid)).status).toBe(200);

  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".tabs a.on")).toHaveText("Current Day");
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(3);

  // Two shifts later the player has three shifts' weather, still not the forecast.
  expect((await api(page, "set_time", { current_shift: 10 }, cid)).status).toBe(200);
  const w = await day(2);
  expect(w.shifts).toEqual(STORMY.shifts.slice(0, 3));
  expect(w.type).toBe("storm");
  await pp.reload();
  await expect(pp.locator(".shiftcard").filter({ hasText: "Weather not known yet" })).toHaveCount(1);

  // The GM still gets the whole day, and so do players once the GM allows future weather.
  expect((await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json()).day.weather).toEqual(STORMY);
  expect((await api(page, "campaign_update", { settings: { players_see_future_weather: true } }, cid)).status).toBe(200);
  expect(await day(2)).toEqual(STORMY);
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
