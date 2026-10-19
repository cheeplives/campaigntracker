// Every campaign screen renders for a GM with no script errors, members are
// picked from the registered accounts or added by sign-in email, and players never receive secret events.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

test("a GM creates a campaign and every tab renders", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Greta");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("The Long Road");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "The Long Road" })).toBeVisible();
  await expect(page.locator(".tabs a.on")).toHaveText("Current Day");
  for (const tab of ["Calendar", "Travel", "Party Holdings", "Regions", "Holidays", "Members", "Settings", "Current Day"]) {
    await page.getByRole("navigation").getByRole("link", { name: tab, exact: true }).click();
    await expect(page.locator(".tabs a.on")).toHaveText(tab);
  }
  await page.goto(page.url().replace(/#.*/, "") + "#/account");
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  expectNoErrors(errors);
});

test("a custom calendar gets its own number of months, each with its own length", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Odd Months");
  await page.getByLabel("Calendar preset").selectOption("custom");
  const count = page.getByRole("spinbutton", { name: /Number of months/ });
  await count.fill("3");
  await count.press("Tab");
  await page.getByLabel("Month 1 days").fill("10");
  await page.getByLabel("Month 2 name").fill("Longmonth");
  await page.getByLabel("Month 2 days").fill("40");
  await page.getByLabel("Month 3 days").fill("5");
  await page.getByLabel("Month 3 days").press("Tab");
  await expect(page.getByText("3 months, 55 days a year.")).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Odd Months" })).toBeVisible();
  const cid = page.url().match(/#\/c\/(\d+)/)[1];
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.calendar.months.map(m => [m.name, m.days])).toEqual([["Month 1", 10], ["Longmonth", 40], ["Month 3", 5]]);
  for (const s of json.campaign.calendar.seasons) expect(s.day).toBeLessThanOrEqual([10, 40, 5][s.month]);
  await page.getByRole("navigation").getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page.locator(".tabs a.on")).toHaveText("Calendar");
  expectNoErrors(errors);
});

test("a GM adds a player by email; the player sees the campaign but not its secrets", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Hal"), player = person("Ivy");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Secrets ${gm.id}`);
  await api(page, "event_save", { abs_day: 2, title: "Public fair" }, cid);
  await api(page, "event_save", { abs_day: 2, title: "Hidden ambush", is_secret: true }, cid);

  // Not approved yet: can't be added.
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(404);
  await approve(browser, player.email);

  await page.goto(`index.html#/c/${cid}/members`);
  await page.getByPlaceholder("Search people, or type their sign-in email").fill(player.email);
  await page.getByRole("button", { name: "Add by email" }).click();
  await expect(page.getByText(`(${player.email})`)).toBeVisible();

  const r = await pp.request.get(`api/index.php?a=days&cid=${cid}&from=0&to=10`);
  const titles = (await r.json()).events.map(e => e.title);
  expect(titles).toContain("Public fair");
  expect(titles).not.toContain("Hidden ambush");
  await pctx.close();
  expectNoErrors(errors);
});

test("a GM picks a registered player from the list; only approved non-members are offered, and only to GMs", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit"), player = person("Lark"), waiting = person("Moss");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Picker ${gm.id}`);

  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  const wctx = await browser.newContext();
  await signIn(await wctx.newPage(), waiting);

  const emails = (await api(page, "member_candidates", undefined, cid)).json.users.map(u => u.email);
  expect(emails).toContain(player.email);
  expect(emails).not.toContain(waiting.email);   // not approved
  expect(emails).not.toContain(gm.email);        // already in the campaign

  await page.goto(`index.html#/c/${cid}/members`);
  await page.getByPlaceholder("Search people, or type their sign-in email").fill(player.id);
  const row = page.getByRole("listitem").filter({ hasText: player.email });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(`(${player.email})`)).toBeVisible();

  // Players can't list everyone's accounts.
  expect((await api(pp, "member_candidates", undefined, cid)).status).toBe(403);
  expect((await api(page, "member_candidates", undefined, cid)).json.users.map(u => u.email)).not.toContain(player.email);
  await pctx.close();
  await wctx.close();
  expectNoErrors(errors);
});
