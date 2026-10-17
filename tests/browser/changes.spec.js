// An open campaign page notices when a GM changes the campaign and offers a Refresh,
// without reloading on its own (so nothing a player is typing is lost).
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

test("a player's open page offers a Refresh after the GM changes the calendar", async ({ page, browser }) => {
  const gm = person("Gus"), player = person("Hana");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Changes ${gm.id}`);

  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const errors = watchErrors(pp);
  await pp.clock.install();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/calendar`);
  await expect(pp.locator(".tabs a.on")).toHaveText("Calendar");

  // Nothing has changed yet: no banner. A player's own note doesn't announce itself either.
  const before = (await api(pp, "changed", undefined, cid)).json.changed;
  expect((await api(pp, "shift_note_add", { abs_day: 2, shift: 0, body: "Mine" }, cid)).json.ok).toBe(true);
  expect((await api(pp, "changed", undefined, cid)).json.changed).toBe(before);
  await pp.clock.runFor(31_000);
  await expect(pp.locator("#change-banner")).toHaveCount(0);

  // The GM saves an event (a second later, so the stamp moves): the player's page offers a Refresh.
  await pp.waitForTimeout(1100);
  expect((await api(page, "event_save", { abs_day: 2, title: "Ambush at the ford" }, cid)).status).toBe(200);
  await pp.clock.runFor(31_000);
  await expect(pp.locator("#change-banner")).toContainText("The GM updated the calendar.");
  await pp.getByRole("button", { name: "Refresh" }).click();
  await expect(pp.locator("#change-banner")).toHaveCount(0);
  await expect(pp.locator(".tabs a.on")).toHaveText("Calendar");
  await expect(pp.getByText("Ambush at the ford")).not.toHaveCount(0); // the phone's month grid hides event titles
  expectNoErrors(errors);
  await pctx.close();
});

test("the GM's own saves don't announce themselves on the GM's page", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Ida");
  await page.clock.install();
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Own changes ${gm.id}`);
  await page.goto(`index.html#/c/${cid}`);
  await page.getByLabel("Locations visited").fill("The old mill");
  await page.getByRole("button", { name: "Save day" }).click();
  await expect(page.getByText("Day saved")).toBeVisible();
  await page.clock.runFor(31_000);
  await expect(page.locator("#change-banner")).toHaveCount(0);
  expectNoErrors(errors);
});
