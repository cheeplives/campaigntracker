// At the Table's weather: the wind and the ground lead the season line, the GM sets any of a shift's conditions by hand
// from ✎ Day, and everyone gets a general outlook for today and the next two days behind Weather forecast.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("the GM sets this shift's weather, wind and ground by hand, and a player sees them and the forecast", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Wren"), player = person("Ilse");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Wind ${gm.id}`); // now = day 2, Dawn
  expect((await api(page, "days_save", { days: [{ abs_day: 2, weather: { type: "overcast", temp: 10, wind: 1 } }] }, cid)).status).toBe(200);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`index.html#/c/${cid}/table`);
  const top = page.locator(".tv-summary");
  // the wind is always said, calm or not, with its speed, on the season line beside the ground
  await expect(top.locator(".tv-wind .wind")).toContainText(/Calm|Breezy/);
  await expect(top.locator(".tv-wind .wind")).toContainText(/km\/h|mph/);
  await expect(top.locator(".tv-ground .ground")).toBeVisible();

  // ✎ Day: this shift's conditions, each Auto until set
  await top.getByRole("button", { name: "✎ Day" }).click();
  const ed = top.locator(".dayedit");
  await expect(ed.locator('select[aria-label="Wind"] option').first()).toContainText("Auto");
  await expect(ed.locator('input[aria-label="Temperature"]')).toHaveAttribute("placeholder", /^Auto -?\d+$/);
  await expect(ed.locator('select[aria-label="Ground"] option').first()).toContainText(/Auto: \w/);
  await ed.locator('select[aria-label="Weather"]').selectOption("rain");
  await ed.locator('input[aria-label="Temperature"]').fill("4");
  await ed.locator('select[aria-label="Wind"]').selectOption("3");
  await ed.locator('select[aria-label="Ground"]').selectOption("muddy");
  await ed.getByRole("button", { name: "Save day" }).click();
  await expect(top.locator(".tv-wx .wx")).toContainText("Heavy rain");
  await expect(top.locator(".tv-wx .wx")).toContainText("4°C");
  await expect(top.locator(".tv-wind .wind")).toContainText("Gale");
  await expect(top.locator(".tv-ground .ground")).toContainText("Muddy");
  // the forecast button: today and the next two days
  await top.getByText("Weather forecast").click();
  const fc = top.locator(".tv-fc-pop");
  await expect(fc.locator("li")).toHaveCount(3);
  await expect(fc.locator("li").first()).toContainText("Today");
  await expect(fc.locator("li").nth(1)).toContainText("Tomorrow");
  const gmOutlook = await fc.locator("ul").innerText();
  await page.keyboard.press("Escape");
  await expect(fc).toBeHidden();

  // a player without future weather sees what the GM set, and the same outlook
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.setViewportSize({ width: 820, height: 1180 });
  await pp.goto(`index.html#/c/${cid}/table`);
  const ptop = pp.locator(".tv-summary");
  await expect(ptop.locator(".tv-wx .wx")).toContainText("Heavy rain");
  await expect(ptop.locator(".tv-wind .wind")).toContainText("Gale");
  await expect(ptop.locator(".tv-ground .ground")).toContainText("Muddy");
  await ptop.getByText("Weather forecast").click();
  await expect(ptop.locator(".tv-fc-pop li")).toHaveCount(3);
  expect(await ptop.locator(".tv-fc-pop ul").innerText()).toBe(gmOutlook);
  await expect(ptop.getByRole("button", { name: "✎ Day" })).toHaveCount(0);
  expectNoErrors(errors);
  expectNoErrors(perrors);
});
