// Ground conditions: snow lying after a cold snap and mud after days of rain, worked out from the weather of the
// days before, shown with the day's weather; players get nothing for days they may not see the weather of yet.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

const days = (from, to, weather) => Array.from({ length: to - from + 1 }, (_, i) => ({ abs_day: from + i, weather }));

test("the day page shows snow cover after a cold snap and mud after days of rain", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gus"), player = person("Hal");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Ground ${gm.id}`); // now = day 2, Dawn

  expect((await api(page, "days_save", { days: [...days(-3, 1, { type: "blizzard", temp: -8, wind: 3 }), ...days(2, 3, { type: "overcast", temp: -6, wind: 1 })] }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator(".kv")).toContainText("Ground now");
  await expect(page.locator(".kv .ground")).toContainText(/snow, \d+ cm/i);
  await expect(page.locator(".dayhero .ground")).toContainText(/snow/i);
  await expect(page.locator(".shiftcard .ground")).toHaveCount(4);
  await expect(page.locator(".kv .ground")).toHaveAttribute("data-tip", /Last snowfall: yesterday/);

  expect((await api(page, "days_save", { days: days(-5, 3, { type: "rain", temp: 12, wind: 1 }) }, cid)).status).toBe(200);
  await page.reload();
  await expect(page.locator(".kv .ground")).toContainText(/Muddy|Waterlogged/);
  await expect(page.locator(".kv .ground")).toHaveAttribute("data-tip", /Rain or snowmelt on 7 of the last 7 days/);

  // A player without future weather gets the ground only as far as the clock has come.
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/today`);
  await expect(pp.locator(".kv .ground")).toContainText(/Muddy|Waterlogged/);
  await expect(pp.locator(".shiftcard .ground")).toHaveCount(1);
  await pp.goto(`index.html#/c/${cid}/today/3`);
  await expect(pp.locator(".dayhero")).toContainText("Weather not known yet");
  await expect(pp.locator(".ground")).toHaveCount(0);
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
