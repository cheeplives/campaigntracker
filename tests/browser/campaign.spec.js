// Every campaign screen renders for a GM with no script errors, members are
// added by sign-in email, and players never receive secret events.
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
  for (const tab of ["Calendar", "Travel", "Regions", "Holidays", "Members", "Settings", "Current Day"]) {
    await page.getByRole("navigation").getByRole("link", { name: tab, exact: true }).click();
    await expect(page.locator(".tabs a.on")).toHaveText(tab);
  }
  await page.goto(page.url().replace(/#.*/, "") + "#/account");
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
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
  await page.getByPlaceholder("Their sign-in email").fill(player.email);
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText(`(${player.email})`)).toBeVisible();

  const r = await pp.request.get(`api/index.php?a=days&cid=${cid}&from=0&to=10`);
  const titles = (await r.json()).events.map(e => e.title);
  expect(titles).toContain("Public fair");
  expect(titles).not.toContain("Hidden ambush");
  await pctx.close();
  expectNoErrors(errors);
});
