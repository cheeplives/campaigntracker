// The account page: the campaigns you belong to, with your role and your character in each, and one
// None / Imperial / Metric choice that sets every temperature, distance, depth and speed you see.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, sql, makeCampaign } = require("./helpers");

test("the account page lists your campaigns with your role, and sets your character in each", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rowan"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const mine = await makeCampaign(page, "Rowan's Table");
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  await makeCampaign(pp, "Pip's Own");
  expect((await api(page, "member_add", { email: player.email, role: "player" }, mine)).status).toBe(200);

  await page.goto("index.html#/account");
  const camps = page.locator(".account-camps li");
  await expect(camps).toHaveCount(1);
  await expect(camps.first()).toContainText("Rowan's Table");
  await expect(camps.first().locator(".role")).toHaveText("GM");

  const pErrors = watchErrors(pp);
  await pp.goto("index.html#/account");
  const rows = pp.locator(".account-camps li");
  await expect(rows).toHaveCount(2);
  const table = rows.filter({ hasText: "Rowan's Table" });
  await expect(table.locator(".role")).toHaveText("Player");
  await expect(rows.filter({ hasText: "Pip's Own" }).locator(".role")).toHaveText("GM");
  const box = pp.getByLabel("Your character in Rowan's Table");
  await box.fill("Brannoc the Bold");
  await box.press("Tab");
  await expect(pp.getByText("Saved")).toBeVisible();

  // It is the same name the Members tab shows and edits.
  await page.goto(`index.html#/c/${mine}/members`);
  await expect(page.locator(".listrow.member").filter({ hasText: "Pip" }).locator(".charname")).toHaveText("Brannoc the Bold");
  await pp.reload();
  await expect(box).toHaveValue("Brannoc the Bold");
  await ctx.close();
  expectNoErrors(errors);
  expectNoErrors(pErrors);
});

test("one units choice sets temperatures, distances and speeds, and None follows the campaign", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const who = person("Uma");
  await signIn(page, who);
  await approve(browser, who.email);
  const cid = await makeCampaign(page); // campaign default: °C, so Metric
  const units = page.getByLabel("Units");
  const save = async v => {
    await page.goto("index.html#/account");
    await units.selectOption(v);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Preferences saved")).toBeVisible();
  };

  await page.goto("index.html#/account");
  await expect(units).toHaveValue("");
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(page.locator(".travel-units").getByLabel("Metric")).toBeChecked();

  await save("imperial");
  expect((await (await page.request.get("api/auth/me.php")).json()).prefs).toEqual({ units: "imperial" });
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(page.locator(".travel-units").getByLabel("Imperial")).toBeChecked();
  await expect(page.locator(".wx").first()).toContainText("°F");

  // An older temperature-only choice reads as its system until a new one is saved over it.
  const { id } = await (await page.request.get("api/auth/me.php")).json();
  sql(`UPDATE user_prefs SET prefs_json='{"temp_unit":"R"}' WHERE user_id=${id}`);
  await page.goto("index.html#/account");
  await page.reload(); // the page reads the account's prefs when it loads
  await expect(units).toHaveValue("imperial");
  await save("");
  expect((await (await page.request.get("api/auth/me.php")).json()).prefs).toEqual({});
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(page.locator(".travel-units").getByLabel("Metric")).toBeChecked();
  await expect(page.locator(".wx").first()).toContainText("°C");
  expect((await api(page, "prefs_save", { units: "kelvin" })).status).toBe(400);
  expectNoErrors(errors);
});
