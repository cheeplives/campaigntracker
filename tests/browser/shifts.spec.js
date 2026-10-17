// A GM picks baseline actions into a shift's activity and can still type freely.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign } = require("./helpers");

test("shift actions are picked into the activity alongside free text", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Kit");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Actions ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/day/2`);

  const card = page.locator(".shiftcard").first();
  const activity = card.locator("textarea").first();
  await activity.fill("Ana and Bo");
  await card.getByLabel("Add an action").selectOption("Scout ahead");
  await expect(activity).toHaveValue("Ana and Bo; Scout ahead");
  await expect(card).toContainText("Scout ahead: Range ahead");
  await card.getByLabel("Add an action").selectOption("Keep watch");
  await expect(activity).toHaveValue("Ana and Bo; Scout ahead; Keep watch");
  await expect(card.getByLabel("Add an action")).toHaveValue("");
  await card.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Overnight saved")).toBeVisible();
  const r = await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`);
  const s = (await r.json()).shifts.find(x => Number(x.shift) === 0);
  expect(s.activity).toBe("Ana and Bo; Scout ahead; Keep watch");

  // The pass-time box suggests the same actions.
  await expect(page.locator("#pass-actions option")).toHaveCount(await page.evaluate(() => Engine.SHIFT_ACTIONS.length));
  expectNoErrors(errors);
});
