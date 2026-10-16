// The shared UI kit: in-page dialogs instead of confirm()/prompt(), and the
// light/dark toggle, which is remembered like Sinless's.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign } = require("./helpers");

test("deleting asks in an in-page dialog, and Cancel keeps the item", async ({ page, browser }) => {
  const errors = watchErrors(page);
  page.on("dialog", d => { errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  const gm = person("Jo");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page);
  await page.goto(`index.html#/c/${cid}/regions`);
  await page.getByRole("button", { name: "Delete" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete region Home?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".listrow").filter({ hasText: "Home" })).toHaveCount(1);

  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".listrow").filter({ hasText: "Home" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("the theme toggle switches light/dark and is remembered", async ({ page }) => {
  await page.goto("index.html");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  expect(["light", "dark"]).toContain(before);
  await page.getByRole("button", { name: "Toggle light / dark mode" }).click();
  const after = before === "light" ? "dark" : "light";
  await expect(html).toHaveAttribute("data-theme", after);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", after);
});

test("fonts are served from this site, not a third party", async ({ page }) => {
  const outside = [];
  page.on("request", r => { if (!r.url().startsWith("http://127.0.0.1")) outside.push(r.url()); });
  await page.goto("index.html");
  await page.evaluate(() => document.fonts.ready);
  expect(outside).toEqual([]);
});
