// Hide list on Encyclopedia and Library: the list folds to a thin rail so the item picked takes the screen, each tab
// remembers it in this browser apart from the others, the rail brings the list back, and one column has no button.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const width = (page, sel) => page.locator(sel).evaluate(n => n.getBoundingClientRect().width);

test("Hide list folds the Encyclopedia's and the Library's list to a rail, each remembered on its own", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Hide list ${gm.id}`);
  const r = await api(page, "entry_save", { name: "Altdorf", notes: "<p>The capital.</p>" }, cid);
  expect(r.status).toBe(200);
  const t = await api(page, "tome_save", { kind: "book", title: "Codex of Night", description: "Bound in black leather" }, cid);
  expect(t.status).toBe(200);
  await page.goto(`index.html#/c/${cid}/encyclopedia/${r.json.id}`);
  await expect(page.locator(".enc-detail h2")).toHaveText("Altdorf");
  const hide = page.getByRole("button", { name: "Hide the list" });
  if ((page.viewportSize()?.width || 0) <= 900) {
    await expect(hide).toBeHidden(); // one column: the list sits under the entry, nothing to fold
    return;
  }
  const before = await width(page, ".enc-detail");
  await hide.click();
  await expect(page.locator(".enc-page")).toHaveClass(/\blist-hidden\b/);
  const rail = page.getByRole("button", { name: "Show the Encyclopedia list" });
  await expect(rail).toBeVisible();
  await expect(rail).toBeFocused();
  await expect(page.getByRole("searchbox", { name: "Search the Encyclopedia" })).toBeHidden();
  expect(await width(page, ".enc-index")).toBeLessThan(60);
  expect(await width(page, ".enc-detail")).toBeGreaterThan(before + 150);
  // With Wide view on as well, the list stays folded and the entry keeps the room.
  await page.evaluate(() => localStorage.setItem("chronicle:encwide", "1"));
  await page.reload();
  await expect(page.locator(".enc-page")).toHaveClass(/\blist-hidden\b/);
  expect(await width(page, ".enc-detail")).toBeGreaterThan(before + 150);

  // The Library keeps its own setting: its list still shows.
  await page.goto(`index.html#/c/${cid}/library/${t.json.tome.id}`);
  await expect(page.locator(".lib-item")).toHaveCount(1);
  await expect(page.locator(".enc-page")).not.toHaveClass(/\blist-hidden\b/);
  await hide.click();
  await expect(page.getByRole("button", { name: "Show the Library list" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".enc-page")).toHaveClass(/\blist-hidden\b/);
  await page.getByRole("button", { name: "Show the Library list" }).click();
  await expect(page.locator(".lib-item")).toBeVisible();
  await expect(hide).toBeFocused();

  // Back on the Encyclopedia the rail brings the list back, and that sticks too.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${r.json.id}`);
  await page.getByRole("button", { name: "Show the Encyclopedia list" }).click();
  await expect(page.getByRole("searchbox", { name: "Search the Encyclopedia" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".enc-detail h2")).toHaveText("Altdorf");
  await expect(page.locator(".enc-page")).not.toHaveClass(/\blist-hidden\b/);
  expectNoErrors(errors);
});
