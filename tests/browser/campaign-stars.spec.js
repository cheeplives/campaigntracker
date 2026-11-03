// Starring on the campaign list: starred campaigns come first, the rest by name, and the stars are each person's own,
// kept with their preferences so they are there after a reload.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const names = page => page.locator(".camp-row .camp-main strong").allTextContents();

test("Campaign list: sorted by name, starred campaigns first, and stars are kept per person", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rhea"), player = person("Oskar");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const ids = {};
  for (const n of ["zephyr road", "Amber Coast", "Mire of Bones"]) ids[n] = await makeCampaign(page, n);

  await page.goto("index.html#/");
  await expect(page.locator(".camp-row")).toHaveCount(3);
  expect(await names(page)).toEqual(["Amber Coast", "Mire of Bones", "zephyr road"]);   // by name, ignoring case

  await page.getByRole("button", { name: "Star zephyr road", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unstar zephyr road", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await names(page)).toEqual(["zephyr road", "Amber Coast", "Mire of Bones"]);
  await page.getByRole("button", { name: "Star Mire of Bones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unstar Mire of Bones", exact: true })).toBeVisible();
  expect(await names(page)).toEqual(["Mire of Bones", "zephyr road", "Amber Coast"]);   // starred ones by name too

  await page.reload();
  await expect(page.locator(".camp-row")).toHaveCount(3);
  expect(await names(page)).toEqual(["Mire of Bones", "zephyr road", "Amber Coast"]);

  await page.getByRole("button", { name: "Unstar Mire of Bones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Star Mire of Bones", exact: true })).toBeVisible();
  expect(await names(page)).toEqual(["zephyr road", "Amber Coast", "Mire of Bones"]);

  // Another member of the same campaign has stars of their own.
  const ctx = await newContext(browser);
  const pp = await ctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  for (const n of Object.keys(ids)) expect((await api(page, "member_add", { email: player.email, role: "player" }, ids[n])).status).toBe(200);
  await pp.goto("index.html#/");
  await expect(pp.locator(".camp-row")).toHaveCount(3);
  expect(await names(pp)).toEqual(["Amber Coast", "Mire of Bones", "zephyr road"]);
  expectNoErrors(errors);
});

test("Campaign list: a star can only be kept on a campaign you belong to", async ({ page, browser }) => {
  const a = person("Ines"), b = person("Bram");
  await signIn(page, a);
  await approve(browser, a.email);
  const mine = await makeCampaign(page, "Mine");
  const ctx = await newContext(browser);
  const other = await ctx.newPage();
  await signIn(other, b);
  await approve(browser, b.email);
  const theirs = await makeCampaign(other, "Theirs");
  const r = await api(page, "prefs_save", { starred: [mine, theirs, "x"] });
  expect(r.status).toBe(200);
  expect(r.json.prefs.starred).toEqual([mine]);
  expect((await api(page, "prefs_save", { starred: "all" })).status).toBe(400);
  // the units and theme are left as they were
  expect((await api(page, "prefs_save", { units: "metric" })).json.prefs).toEqual({ starred: [mine], units: "metric" });
});
