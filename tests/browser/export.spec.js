// The day page's Export button downloads the day as Markdown, and a player's
// file holds only what that player can see.
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

async function exportDay(page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ Export" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.md$/);
  return fs.readFileSync(await dl.path(), "utf8");
}

test("a day exports to Markdown, and players get only what they can see", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Jo"), player = person("Kai");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Export ${gm.id}`);
  // The campaign starts on day 2 (shift 8, Dawn); day 3 is in the future.
  await api(page, "event_save", { abs_day: 2, shift: 1, title: "Market day", body: "Stalls along the river" }, cid);
  await api(page, "event_save", { abs_day: 2, title: "Hidden ambush", is_secret: true }, cid);
  await api(page, "day_update", { abs_day: 2, notes: "The party reached town", gm_notes: "Bandits are watching" }, cid);
  await api(page, "shift_save", { abs_day: 2, shift: 2, activity: "Haggle", gm_notes: "Prices are rigged" }, cid);

  await page.goto(`index.html#/c/${cid}/day/2`);
  const md = await exportDay(page);
  expect(md).toMatch(/^# /);
  for (const s of ["## Notes", "The party reached town", "## GM notes 🔒", "Bandits are watching", "## Shifts", "### Dawn (now)",
    "**Activity:** Haggle", "Prices are rigged", "## Events", "### Market day", "Stalls along the river", "### Hidden ambush 🔒", "GM view"])
    expect(md).toContain(s);
  expect(md).toMatch(/\*\*Forecast\*\* \S/);
  expect(md).not.toContain("**Forecast** not known");

  // The same day as a player.
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/day/2`);
  const pmd = await exportDay(pp);
  for (const s of ["The party reached town", "### Market day", "**Activity:** Haggle", "player view"]) expect(pmd).toContain(s);
  for (const s of ["Hidden ambush", "Bandits are watching", "Prices are rigged", "GM notes"]) expect(pmd).not.toContain(s);
  // Dawn is now; the later shifts' weather stays unknown to players.
  const later = pmd.split("### Midday")[1];
  expect(pmd.split("### Midday")[0]).not.toContain("**Weather** not known yet");
  expect(later).toContain("**Weather** not known yet");
  expect(later).not.toContain("**Visibility**");
  await pctx.close();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
