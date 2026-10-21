// The year view: every month of the year on one page, stepping a year at a
// time, with days that open the day page and month names that open the month.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

test("year view shows every month and links to months and days", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Yara");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Year ${gm.id}`);
  expect((await api(page, "event_save", { abs_day: 40, title: "Harvest fair" }, cid)).status).toBe(200);
  expect((await api(page, "event_save", { abs_day: 41, title: "Plotting", is_secret: true }, cid)).status).toBe(200);

  await page.goto(`index.html#/c/${cid}/calendar`);
  await page.getByRole("button", { name: "Year", exact: true }).click();
  await expect(page.locator(".calbar h2")).toHaveText("1");

  // Both months of the test calendar, Firstmonth starting on the first weekday, today ringed.
  const months = page.locator(".ymonth");
  await expect(months).toHaveCount(2);
  await expect(months.nth(0).locator(".ym-name")).toHaveText("Firstmonth");
  await expect(months.nth(1).locator(".ym-name")).toHaveText("Secondmonth");
  await expect(months.nth(0)).toHaveClass(/current/);
  await expect(months.nth(0).locator("a.ycell")).toHaveCount(30);
  await expect(months.nth(0).locator(".ygrid-head span")).toHaveCount(5);
  await expect(page.locator(`a.ycell[href$="/day/2"]`)).toHaveClass(/today/);

  // A day with events is marked, with the events in its tooltip.
  const fair = page.locator(`a.ycell[href$="/day/40"]`);
  await expect(fair).toHaveClass(/has-ev/);
  await expect(fair).toHaveAttribute("data-tip", /11 Secondmonth 1[\s\S]*Harvest fair/);
  await expect(page.locator(`a.ycell[href$="/day/41"]`)).toHaveAttribute("data-tip", /🔒 Plotting/);
  await expect(page.locator(`a.ycell[href$="/day/45"]`)).not.toHaveClass(/has-ev/);

  // Step a year on and back.
  await page.locator(".calbar").getByRole("button", { name: "▶" }).click();
  await expect(page.locator(".calbar h2")).toHaveText("2");
  await expect(page.locator(`a.ycell[href$="/day/60"]`)).toBeVisible();
  await page.locator(".calbar").getByRole("button", { name: "◀" }).click();
  await expect(page.locator(".calbar h2")).toHaveText("1");

  // A month's name opens the month view on it; a day opens the day page.
  await page.locator(".ym-name", { hasText: "Secondmonth" }).click();
  await expect(page.locator(".calbar h2")).toHaveText("Secondmonth 1");
  await expect(page.getByRole("button", { name: "Month", exact: true })).toHaveClass(/on/);
  await page.getByRole("button", { name: "Year", exact: true }).click();
  await fair.click();
  await expect(page).toHaveURL(/\/day\/40$/);
  await expect(page.getByText("Harvest fair").first()).toBeVisible();

  expectNoErrors(errors);
});

test("a player's year view never carries secret events", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Yorick"), player = person("Pell");
  const gctx = await browser.newContext();
  const gp = await gctx.newPage();
  await signIn(gp, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(gp, `Year secrets ${gm.id}`);
  await signIn(page, player);
  await approve(browser, player.email);
  expect((await api(gp, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  expect((await api(gp, "event_save", { abs_day: 41, title: "Plotting", is_secret: true }, cid)).status).toBe(200);
  await gctx.close();

  await page.goto(`index.html#/c/${cid}/calendar`);
  await page.getByRole("button", { name: "Year", exact: true }).click();
  const cell = page.locator(`a.ycell[href$="/day/41"]`);
  await expect(cell).toBeVisible();
  await expect(cell).not.toHaveClass(/has-ev/);
  await expect(cell).not.toHaveAttribute("data-tip", /Plotting/);
  expectNoErrors(errors);
});
