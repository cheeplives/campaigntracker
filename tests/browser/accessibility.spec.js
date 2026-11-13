// Accessibility (WCAG 2.1 AA, the standard the ADA's web guidance points to): axe-core finds nothing on the main pages, in
// light and dark mode, and the things axe can't see work: the skip link, a title for each page, and where focus goes when
// the page changes.
const { test, expect } = require("@playwright/test");
const { signIn, api, makeCampaign, ADMIN, watchErrors, expectNoErrors, goTab, person, approve } = require("./helpers");

// axe is injected as a script, which the app's Content Security Policy would refuse
test.use({ bypassCSP: true });

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axeFindings(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(tags => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), TAGS);
  return r.violations.map(v => `${v.id}: ${v.help}\n    ${v.nodes.slice(0, 5).map(n => `${n.target.join(" ")}${n.failureSummary ? ` (${n.failureSummary.split("\n").slice(1).join(" ").trim()})` : ""}`).join("\n    ")}`);
}

async function campaignWithThings(page) {
  const cid = await makeCampaign(page, "Saltmarsh");
  await api(page, "entry_save", { name: "The Ford", notes: "<p>Shallow.</p>" }, cid);
  await api(page, "event_save", { abs_day: 2, shift: 1, title: "Market day", body: "Stalls" }, cid);
  await api(page, "clock_save", { name: "Doom", segments: 8, filled: 2, visibility: "public" }, cid);
  await api(page, "gear_save", { item: "Rope", claimed_by: "", location: "Wagon", amount: 1 }, cid);
  return cid;
}

const TABS = ["table", "calendar", "day/2", "events", "sessions", "clocks", "characters", "groups", "holdings", "travel", "downtime",
  "encyclopedia", "library", "generators", "maps", "regions", "holidays", "members", "tokens", "settings"];

for (const mode of ["light", "dark"]) {
  test(`axe finds nothing on the main pages in ${mode} mode`, async ({ page }, testInfo) => {
    test.skip(!["chromium", "ipad"].includes(testInfo.project.name), "the markup is the same in every browser: a desk and an iPad are enough");
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: mode });
    const errors = watchErrors(page);
    await page.goto("index.html#/");
    expect(await axeFindings(page), "the sign-in page").toEqual([]);
    await signIn(page, ADMIN);
    const cid = await campaignWithThings(page);
    const found = {};
    let n = 0;
    for (const at of ["#/", "#/new", "#/account", "#/admin", "#/templates", "#/about", ...TABS.map(t => `#/c/${cid}/${t}`)]) {
      await page.goto(`index.html?page=${++n}${at}`);   // a fresh load each time, so nothing of the page before is left to scan
      await expect(page.locator("#app h1, #app h2").first()).toBeVisible();
      const v = await axeFindings(page);
      if (v.length) found[at] = v;
    }
    expect(found).toEqual({});
    expectNoErrors(errors);
  });
}

// Each colour theme beyond the default is checked on a few pages that between them show every kind of surface and text
for (const scheme of ["lamplight"]) {
  for (const mode of ["light", "dark"]) {
    test(`axe finds nothing in the ${scheme} theme in ${mode} mode`, async ({ page, browser }, testInfo) => {
      test.skip(!["chromium", "ipad"].includes(testInfo.project.name), "the markup is the same in every browser: a desk and an iPad are enough");
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: mode });
      const errors = watchErrors(page);
      const who = person("Lena");
      await signIn(page, who);
      await approve(browser, who.email);
      await api(page, "prefs_save", { scheme });
      const cid = await campaignWithThings(page);
      const found = {};
      let n = 0;
      for (const at of ["#/", "#/account", ...["table", "calendar", "clocks", "encyclopedia", "settings"].map(t => `#/c/${cid}/${t}`)]) {
        await page.goto(`index.html?page=${++n}${at}`);
        await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme);
        await expect(page.locator("#app h1, #app h2").first()).toBeVisible();
        const v = await axeFindings(page);
        if (v.length) found[at] = v;
      }
      expect(found).toEqual({});
      expectNoErrors(errors);
    });
  }
}

test("each page has its own title, and moving to another page puts focus on its content", async ({ page }) => {
  await signIn(page, ADMIN);
  const cid = await campaignWithThings(page);
  await page.goto(`index.html#/c/${cid}/table`);
  await expect(page).toHaveTitle("At the Table · Saltmarsh · GM's Almanac");
  await goTab(page, "Calendar");
  await expect(page).toHaveTitle("Calendar · Saltmarsh · GM's Almanac");
  await expect(page.locator("#app")).toBeFocused();
  await expect(page.locator("#page-announcer")).toHaveText("Calendar · Saltmarsh · GM's Almanac");
  // the tab you are on is marked as the current page for a screen reader, not only by its colour
  await expect(page.locator("nav.tabs a[aria-current=page]")).toHaveText(/Calendar/);
  await page.goto("index.html#/account");
  await expect(page).toHaveTitle("Account · GM's Almanac");
});

test("the skip link is the first stop for Tab and jumps to the page's content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile") || testInfo.project.name === "ipad", "Tab moves focus on a desk, with a keyboard");
  // WebKit only lets Tab reach links with Option held, as Safari does; Playwright's WebKit follows the same rule
  const tab = testInfo.project.name === "webkit" ? "Alt+Tab" : "Tab";
  await signIn(page, ADMIN);
  const cid = await campaignWithThings(page);
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(page.locator("#app h1")).toBeVisible();
  await page.keyboard.press(tab);
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/calendar$`));   // the address, which is the page here, is left alone
});
