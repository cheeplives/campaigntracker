// Tablets and touch screens: everything a mouse user reads in a tooltip can be
// tapped open, menus close on a tap elsewhere, and no tab hides off the edge.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign } = require("./helpers");

async function gmCampaign(page, browser, name) {
  const gm = person(name);
  await signIn(page, gm);
  await approve(browser, gm.email);
  return makeCampaign(page);
}

test("on a touch screen a tooltip opens on tap and closes on a second tap or a tap elsewhere", async ({ page, browser, hasTouch }) => {
  test.skip(!hasTouch, "touch screens only");
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Tess");
  await page.goto(`index.html#/c/${cid}/today`);
  const tipbox = page.locator("#tipbox");
  const weather = page.locator(".kv .wx");
  await expect(weather).toBeVisible();

  await weather.tap();
  await expect(tipbox).toHaveClass("show");
  await expect(tipbox).toContainText("forecast");
  await weather.tap();
  await expect(tipbox).not.toHaveClass("show");

  await weather.tap();
  await expect(tipbox).toHaveClass("show");
  await page.locator(".calbar h2").tap();
  await expect(tipbox).not.toHaveClass("show");

  // a tooltip on something inside a link still follows the link: the day page shows the rest
  await page.goto(`index.html#/c/${cid}/calendar`);
  const cell = page.locator("a.daycell.today");
  await cell.locator(".dnum").tap();
  await expect(page).toHaveURL(/\/day\/\d+$/);
  expectNoErrors(errors);
});

test("the theme menu closes on a tap or click outside it", async ({ page, browser, hasTouch, viewport }) => {
  const errors = watchErrors(page);
  await gmCampaign(page, browser, "Tam");
  await page.goto("index.html");
  const press = l => (hasTouch ? l.tap() : l.click());
  await press(page.getByRole("button", { name: /^Theme:/ }));
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // plain page background in the bottom-left corner, well away from the menu at the top right
  const [x, y] = [4, viewport.height - 4];
  await (hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  await expect(menu).toBeHidden();
  expectNoErrors(errors);
});

test("the campaign tabs stay on screen as the page scrolls", async ({ page, browser, viewport }) => {
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Pinned");
  await page.goto(`index.html#/c/${cid}/today`);
  const on = page.locator("nav.tabs a.on");
  await expect(on).toHaveText("Current Day");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const box = await on.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // and nothing on the page sits over it
  expect(await on.evaluate(a => { const r = a.getBoundingClientRect(); return a.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
  expectNoErrors(errors);
});

test("every campaign tab is on screen at tablet and desktop widths", async ({ page, browser, viewport }) => {
  test.skip(viewport.width <= 560, "phones keep one row of tabs that scrolls sideways");
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Tab");
  await page.goto(`index.html#/c/${cid}/today`);
  const tabs = page.locator("nav.tabs a");
  await expect(tabs.last()).toHaveText("Settings");
  for (const box of await tabs.evaluateAll(as => as.map(a => a.getBoundingClientRect().right)))
    expect(box).toBeLessThanOrEqual(viewport.width);
  expectNoErrors(errors);
});

test("the Legend groups its tabs under Play, Party, World and Setup", async ({ page, browser, viewport }) => {
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Groups");
  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator("nav.tabs a").last()).toHaveText("Settings");
  // each heading sits just before its group's first tab
  const order = await page.locator("nav.tabs > *").allTextContents();
  for (const [g, first] of [["Play", "Current Day"], ["Party", "Travel"], ["World", "Encyclopedia"], ["Setup", "Regions"]])
    expect(order[order.indexOf(g) + 1]).toBe(first);
  // headings show in the side Legend; across the top they are a thin divider
  const heading = page.locator("nav.tabs .tab-group", { hasText: "World" });
  if (viewport.width > 1000) await expect(heading).toBeVisible();
  else expect((await heading.boundingBox()).width).toBeLessThanOrEqual(2);
  expectNoErrors(errors);
});

test("the Legend's groups fold, Setup starts folded, and they stay as left", async ({ page, browser, viewport }) => {
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Fold");
  await page.goto(`index.html#/c/${cid}/today`);
  const tab = name => page.locator("nav.tabs a", { hasText: name });
  if (viewport.width <= 1000) {
    // across the top nothing folds: every tab is there
    await expect(tab("Settings")).toHaveCount(1);
    if (viewport.width > 560) await expect(tab("Settings")).toBeVisible();
    await expect(page.locator(".tab-group button").first()).toBeHidden();
    expectNoErrors(errors);
    return;
  }
  const toggle = g => page.locator("nav.tabs .tab-group button", { hasText: g });
  await expect(tab("Calendar")).toBeVisible();
  await expect(tab("Regions")).toBeHidden();
  await expect(toggle("Setup")).toHaveAttribute("aria-expanded", "false");
  await toggle("Setup").click();
  await expect(tab("Regions")).toBeVisible();
  await toggle("Play").click();
  await expect(toggle("Play")).toHaveAttribute("aria-expanded", "false");
  // the open page's tab stays in view in a folded group
  await expect(tab("Current Day")).toBeVisible();
  await expect(tab("Calendar")).toBeHidden();
  // remembered after a reload, and on another page
  await page.reload();
  await expect(tab("Regions")).toBeVisible();
  await expect(tab("Current Day")).toBeVisible();
  await expect(tab("Events")).toBeHidden();
  await tab("Encyclopedia").click();
  await expect(tab("Current Day")).toBeHidden();
  await expect(tab("Regions")).toBeVisible();
  await toggle("Setup").click();
  await expect(tab("Regions")).toBeHidden();
  await page.goto(`index.html#/c/${cid}/settings`);
  await expect(tab("Settings")).toBeVisible();
  await expect(tab("Regions")).toBeHidden();
  expectNoErrors(errors);
});

test("the Legend has no heading and tucks away to the left, and stays as left", async ({ page, browser, viewport }) => {
  const errors = watchErrors(page);
  const cid = await gmCampaign(page, browser, "Tuck");
  await page.goto(`index.html#/c/${cid}/today`);
  const nav = page.locator("nav.tabs"), tuck = page.locator("nav.tabs .legend-tuck"), today = page.locator("nav.tabs a.on");
  await expect(today).toHaveText("Current Day");
  expect(await nav.evaluate(n => getComputedStyle(n, "::before").content)).toBe("none");
  if (viewport.width <= 1000) {
    await expect(tuck).toBeHidden();
    expectNoErrors(errors);
    return;
  }
  const pageLeft = () => page.locator(".nowbar").evaluate(n => n.getBoundingClientRect().left);
  const before = await pageLeft();
  await tuck.click();
  await expect(tuck).toHaveAttribute("aria-expanded", "false");
  await expect(today).toBeHidden();
  await expect(page.locator("nav.tabs .tab-search")).toBeHidden();
  expect(await pageLeft()).toBeLessThan(before - 100);
  await page.reload();
  await expect(tuck).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("nav.tabs a.on")).toBeHidden();
  await tuck.click();
  await expect(page.locator("nav.tabs a.on")).toBeVisible();
  await page.reload();
  await expect(page.locator("nav.tabs a.on")).toBeVisible();
  expectNoErrors(errors);
});
