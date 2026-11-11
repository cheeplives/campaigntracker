// The welcome tutorial (static/tour.js): the first time someone opens a page, a few tips point out its parts. Each page's
// tips show once per person, Skip tutorial turns them all off, and the Account page turns them back on. The test config
// keeps it off by default (so it never covers what other specs click), so each test here turns it on from Account.
const { test, expect } = require("@playwright/test");
const { signIn, approve, api, person, makeCampaign, watchErrors, expectNoErrors } = require("./helpers");

test.use({ bypassCSP: true });   // axe is injected as a script
const AXE = require.resolve("axe-core/axe.min.js");

const tour = page => page.locator("dialog.tour");
const nextBtn = page => tour(page).locator(".tour-buttons .primary");
const prefsTour = async page => (await (await page.request.get("api/auth/me.php")).json()).prefs.tour;

async function newGm(page, browser, name = "Tutee") {
  const who = person(name);
  await signIn(page, who);
  await approve(browser, who.email);
  return who;
}
async function turnOn(page) {
  await page.goto("index.html#/account");
  await expect(page.getByRole("heading", { name: "Welcome tutorial" })).toBeVisible();
  await expect(page.locator(".tour-card-account")).toContainText("The tutorial is off");
  await page.getByRole("button", { name: "Turn the tutorial back on" }).click();
  await expect(page).toHaveURL(/#\/$/);
}
/** Press Next until the last tip's Done, returning each tip's title. */
async function walk(page) {
  const titles = [];
  for (let i = 0; i < 30; i++) {
    await expect(tour(page).locator(".tour-title")).not.toHaveText("");
    titles.push((await tour(page).locator(".tour-title").textContent()).trim());
    const last = (await nextBtn(page).textContent()) === "Done";
    await nextBtn(page).click();
    if (last) break;
  }
  await expect(tour(page)).toHaveCount(0);
  return titles;
}

test("the tutorial walks a newcomer through each page once, and Skip tutorial turns it off until Account turns it on", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await newGm(page, browser);
  const cid = await makeCampaign(page, "Tour town");

  // Off here by the site's default, until the Account page turns it on, which starts with the campaign list.
  await page.goto("index.html#/");
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(tour(page)).toHaveCount(0);
  await turnOn(page);
  await expect(tour(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Campaign Chronicle" })).toBeVisible();
  await expect(nextBtn(page)).toBeFocused();
  await expect(tour(page).getByRole("button", { name: "Back" })).toBeHidden();
  const titles = await walk(page);
  expect(titles).toEqual(expect.arrayContaining(["Welcome to Campaign Chronicle", "Start a campaign", "Your campaigns", "Your account"]));
  await expect.poll(() => prefsTour(page)).toEqual({ state: "on", seen: ["welcome"] });

  // Once only: the list again shows nothing.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(tour(page)).toHaveCount(0);

  // A campaign's first page: its bar and tabs, then the tab's own. A tip points at its part, which is ringed; the keys move
  // through it, and Escape closes this page's tips, which counts as seen.
  await page.goto(`index.html#/c/${cid}/table`);
  await expect(tour(page).locator(".tour-title")).toHaveText("The campaign bar");
  await expect(tour(page).locator(".tour-label")).toHaveText("Your campaign");
  await expect(tour(page).locator(".tour-hole")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(tour(page).locator(".tour-title")).toHaveText("View as player");
  await page.keyboard.press("ArrowLeft");
  await expect(tour(page).locator(".tour-title")).toHaveText("The campaign bar");
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(async () => (await prefsTour(page)).seen.sort()).toEqual(["campaign", "tab-table", "welcome"]);

  // Another tab shows only its own tips.
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(tour(page).locator(".tour-title")).toHaveText("Calendar");
  await expect(tour(page).locator(".tour-label")).toHaveText("Calendar");
  // Skip tutorial ends it everywhere.
  await tour(page).getByRole("button", { name: "Skip tutorial" }).click();
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(async () => (await prefsTour(page)).state).toBe("off");
  await page.goto(`index.html#/c/${cid}/events`);
  await expect(page.getByRole("button", { name: "+ New event" })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(tour(page)).toHaveCount(0);

  // Tips for this page, from the account menu, shows them again even with the tutorial off, and leaves it off.
  await page.locator(".account-menu > summary").click();
  await page.getByRole("button", { name: "Tips for this page" }).click();
  await expect(tour(page).locator(".tour-title")).toHaveText("The campaign bar");
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
  expect((await prefsTour(page)).state).toBe("off");

  // The Account page says it is off, and turns it back on from the start.
  await turnOn(page);
  await expect(page.getByRole("dialog", { name: "Welcome to Campaign Chronicle" })).toBeVisible();
  expect(await prefsTour(page)).toEqual({ state: "on", seen: [] });
  await page.keyboard.press("Escape");
  await page.goto("index.html#/account");
  await expect(page.locator(".tour-card-account")).toContainText("The tutorial is on");
  await page.getByRole("button", { name: "Turn the tutorial off" }).click();
  await expect(page.locator(".tour-card-account")).toContainText("The tutorial is off");
  expect((await prefsTour(page)).state).toBe("off");
  expectNoErrors(errors);
});

test("the server keeps only a tidy tutorial state", async ({ page, browser }) => {
  await newGm(page, browser, "Tidy");
  expect((await api(page, "prefs_save", { tour: { state: "maybe" } })).status).toBe(400);
  expect((await api(page, "prefs_save", { tour: "on" })).status).toBe(400);
  const r = await api(page, "prefs_save", { tour: { state: "on", seen: ["welcome", "welcome", "Bad id!", 7, "tab-calendar"] } });
  expect(r.status).toBe(200);
  expect(r.json.prefs.tour).toEqual({ state: "on", seen: ["welcome", "tab-calendar"] });
  expect((await api(page, "prefs_save", { tour: null })).json.prefs.tour).toBeUndefined();
});

for (const mode of ["light", "dark"]) {
  test(`axe finds nothing on the tutorial's tips in ${mode} mode`, async ({ page, browser }, testInfo) => {
    test.skip(!["chromium", "ipad"].includes(testInfo.project.name), "the markup is the same in every browser: a desk and an iPad are enough");
    await page.emulateMedia({ colorScheme: mode });
    await newGm(page, browser, "Axe");
    const cid = await makeCampaign(page, "Axe tour");
    await api(page, "prefs_save", { tour: { state: "on", seen: [] } });
    const check = async what => {
      if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ path: AXE });
      const r = await page.evaluate(() => window.axe.run(document.querySelector("dialog.tour"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }));
      expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`), what).toEqual([]);
    };
    await page.goto("index.html#/");
    await expect(tour(page)).toBeVisible();
    await check("the welcome tip");
    await nextBtn(page).click();
    await check("a tip pointing at a button");
    await page.goto(`index.html#/c/${cid}/table`);
    await expect(tour(page).locator(".tour-title")).toHaveText("The campaign bar");
    await check("a campaign's first tip");
  });
}
