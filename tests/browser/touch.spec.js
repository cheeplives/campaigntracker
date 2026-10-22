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
