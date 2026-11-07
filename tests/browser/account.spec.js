// The account page: the name and pronouns the app calls you by, and one None / Imperial / Metric choice that sets
// every temperature, distance, depth and speed you see.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, ADMIN, signIn, approve, api, sql, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("the account page sets the name and pronouns the app calls you by, over your Google or GitHub name", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rowan"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Names ${gm.id}`);
  const ctx = await newContext(browser);
  const pp = await ctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const playerName = (await (await pp.request.get("api/auth/me.php")).json()).name;

  // No campaign list here any more: the campaign list itself and the Members tab cover it.
  await pp.goto("index.html#/account");
  await expect(pp.locator(".account-camps")).toHaveCount(0);
  await expect(pp.getByRole("heading", { name: "Your campaigns" })).toHaveCount(0);
  await expect(pp.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", playerName);
  await pp.getByLabel("Name", { exact: true }).fill("  Pippa   Quill ");
  await pp.getByLabel("Pronouns").fill("she/they");
  await pp.getByRole("button", { name: "Save name" }).click();
  await expect(pp.getByText("Name saved")).toBeVisible();
  await expect(pp.locator(".account-menu")).toContainText("Pippa Quill");
  const me = await (await pp.request.get("api/auth/me.php")).json();
  expect(me).toMatchObject({ name: "Pippa Quill", custom_name: "Pippa Quill", pronouns: "she/they", provider_name: playerName });

  // Everyone else sees it too, and a new sign-in from Google or GitHub doesn't undo it.
  await page.goto(`index.html#/c/${cid}/members`);
  const row = page.locator(".listrow.member").filter({ hasText: "Pippa Quill" });
  await expect(row).toContainText("(she/they)");
  await signIn(pp, player);
  expect((await (await pp.request.get("api/auth/me.php")).json()).name).toBe("Pippa Quill");
  const ap = await (await newContext(browser)).newPage();
  await signIn(ap, ADMIN);
  await ap.goto("index.html#/admin");
  const adminRow = ap.locator("tr").filter({ hasText: "Pippa Quill" });
  await expect(adminRow).toContainText("(she/they)");
  await expect(adminRow).toContainText(`name: ${playerName}`);

  // Blank goes back to the provider's name.
  await pp.goto("index.html#/account");
  await pp.reload(); // the new sign-in above gave this page a new session
  await pp.getByLabel("Name", { exact: true }).fill("");
  await pp.getByLabel("Pronouns").fill("");
  await pp.getByRole("button", { name: "Save name" }).click();
  await expect(pp.getByText("Name saved")).toBeVisible();
  expect(await (await pp.request.get("api/auth/me.php")).json()).toMatchObject({ name: playerName, custom_name: null, pronouns: null });
  expect((await api(pp, "profile_save", { name: "x".repeat(151) })).status).toBe(400);
  await ctx.close();
  expectNoErrors(errors);
});

test("one units choice sets temperatures, distances and speeds, and None follows the campaign", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const who = person("Uma");
  await signIn(page, who);
  await approve(browser, who.email);
  const cid = await makeCampaign(page); // campaign default: °C, so Metric
  // the select, not the travel planner's Units radio group, which is still on the page for a moment after a hash-only goto
  const units = page.getByRole("combobox", { name: "Units" });
  const save = async v => {
    await page.goto("index.html#/account");
    await units.selectOption(v);
    await page.getByRole("button", { name: "Save", exact: true }).click();
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

test("the campaign's default units are one Imperial or Metric choice, and an older temperature unit reads as its system", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Ines");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page);

  await page.goto(`index.html#/c/${cid}/settings`);
  const def = page.getByRole("combobox", { name: "Default units" });
  // waits for the campaign to reload after the save, since an earlier "Saved" toast can still be showing
  const saveSettings = () => {
    let updated = false;
    const reloaded = page.waitForResponse(r => (updated ||= r.url().includes("a=campaign_update")) && r.url().includes("a=campaign&"));
    return Promise.all([reloaded, page.getByRole("button", { name: "Save campaign settings" }).click()]);
  };
  await expect(def).toHaveValue("metric");
  await expect(def.locator("option")).toHaveText([/^Imperial/, /^Metric/]);
  await def.selectOption("imperial");
  await saveSettings();
  const settings = async () => (await api(page, "campaign", undefined, cid)).json.campaign.settings;
  expect(await settings()).toMatchObject({ units: "imperial", hide_temps: false });
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(page.locator(".travel-units").getByLabel("Imperial")).toBeChecked();
  await expect(page.locator(".wx").first()).toContainText("°F");

  // Hiding temperatures is its own switch now, and keeps them hidden whatever the units.
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.getByLabel("Show temperatures").uncheck();
  await saveSettings();
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(page.locator(".wx").first()).not.toContainText("°");

  // A campaign saved with the old temperature-only setting: Rankine counts as Imperial, and saving drops it.
  sql(`UPDATE campaigns SET settings_json='{"temp_unit":"R"}' WHERE id=${cid}`);
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.reload();
  await expect(def).toHaveValue("imperial");
  await expect(page.getByLabel("Show temperatures")).toBeChecked();
  await saveSettings();
  const s = await settings();
  expect(s.units).toBe("imperial");
  expect(s.temp_unit).toBeUndefined();
  expectNoErrors(errors);
});
