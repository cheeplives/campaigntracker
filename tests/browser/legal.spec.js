// The privacy policy and terms are plain pages at privacy/ and terms/, readable with no JavaScript (Google's OAuth
// review reads the privacy policy that way), linked from the footer on every page and from About & sources, and pass
// axe in light and dark mode.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors } = require("./helpers");

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the privacy policy and the terms read in full with no script", async ({ page }) => {
    await page.goto("privacy/");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
    for (const h of ["What we collect", "How we use it", "Who else sees it", "Google user data", "Your choices and rights", "Contact"])
      await expect(page.getByRole("heading", { name: h, exact: true })).toBeVisible();
    await expect(page.getByText("Limited Use requirements")).toBeVisible();
    await expect(page.getByRole("link", { name: "admin@gms-almanac.com" }).first()).toHaveAttribute("href", "mailto:admin@gms-almanac.com");
    await page.getByRole("link", { name: "Terms of service" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
    await expect(page).toHaveURL(/\/terms\/$/);
  });
});

test("the footer and About & sources lead to the privacy policy and the terms", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("index.html");
  const foot = page.locator(".footer");
  await foot.getByRole("link", { name: "Privacy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
  await page.goto("index.html");
  await page.locator(".footer").getByRole("link", { name: "Terms" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
  await page.getByRole("link", { name: "Back to GM's Almanac" }).click();
  await page.locator(".footer").getByRole("link", { name: "About & sources" }).click();
  await page.getByRole("link", { name: "privacy policy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
  expectNoErrors(errors);
});

test.describe("axe", () => {
  test.use({ bypassCSP: true });
  for (const mode of ["light", "dark"]) {
    test(`axe finds nothing on the privacy policy and the terms in ${mode} mode`, async ({ page }, testInfo) => {
      test.skip(!["chromium", "ipad"].includes(testInfo.project.name), "the markup is the same in every browser");
      await page.emulateMedia({ colorScheme: mode });
      for (const path of ["privacy/", "terms/"]) {
        await page.goto(path);
        await page.addScriptTag({ path: AXE });
        const r = await page.evaluate(tags => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), TAGS);
        expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`), path).toEqual([]);
      }
    });
  }
});
