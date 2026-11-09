// The site-wide UX pass: Undo for deletes, peek cards on names, Ctrl K, the campaign bar's jump links and Saved status,
// the Encyclopedia's filter chips, Back keeping a list's place, and Recent and Pinned in the Legend (off unless turned on).
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

async function gmCampaign(page, browser, name) {
  const gm = person(name);
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `UX ${gm.id}`);
  return { gm, cid };
}
const entry = async (page, cid, name, notes, extra = {}) => (await api(page, "entry_save", { name, notes: `<p>${notes}</p>`, tags: [], ...extra }, cid)).json.id;

test("a deleted note goes at once, Undo brings it back, and without Undo it is gone from the server", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Una");
  await api(page, "shift_note_add", { abs_day: 2, shift: 0, body: "Keep me" }, cid);
  await api(page, "shift_note_add", { abs_day: 2, shift: 0, body: "Drop me" }, cid);
  await page.goto(`index.html#/c/${cid}/table`);
  const now = page.locator(".tv-now");
  await expect(now.getByText("Drop me")).toBeVisible();

  // no "Are you sure?": the note goes, and the toast offers Undo
  await now.locator(".enote", { hasText: "Drop me" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(now.getByText("Drop me")).toBeHidden();
  const bar = page.locator("#undo-toast");
  await expect(bar).toContainText('Deleted the note "Drop me"');
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(now.getByText("Drop me")).toBeVisible();

  // again, then leave the page: the delete goes through before the next page is drawn
  await now.locator(".enote", { hasText: "Drop me" }).getByRole("button", { name: "Delete" }).click();
  await expect(now.getByText("Drop me")).toBeHidden();
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(page.locator(".nowbar")).toBeVisible();
  const day = async () => JSON.stringify(await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json());
  await expect.poll(day).not.toContain("Drop me");
  expect(await day()).toContain("Keep me");
  expectNoErrors(errors);
});

test("a name written in a note opens a peek card; Open goes to it, Escape closes it, Ctrl-click still goes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Pia");
  const manor = await entry(page, cid, "Trollskull Manor", "A run-down tavern the party now owns.", { category: "location" });
  const renaer = await entry(page, cid, "Renaer", "He gave the party Trollskull Manor.");
  await page.goto(`index.html#/c/${cid}/encyclopedia/${renaer}`);
  const link = page.locator(".enc-detail .richtext a.enc-link", { hasText: "Trollskull Manor" });
  await link.click();
  const peek = page.locator(".peek");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("A run-down tavern the party now owns.");
  await expect(peek).toContainText("Location");
  expect(page.url()).toContain(`/encyclopedia/${renaer}`);   // still on the page it was opened from
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);

  await link.click();
  await peek.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/encyclopedia/${manor}$`));
  await expect(page.locator(".peek")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Ctrl K jumps to an entry by name, and ? lists the keys", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Kit");
  const id = await entry(page, cid, "Xanathar Guild", "A thieves' guild.", { category: "group" });
  await page.goto(`index.html#/c/${cid}/table`);
  await expect(page.locator(".nowbar")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Control+k");
  const box = page.getByRole("dialog", { name: "Jump to" });
  await expect(box).toBeVisible();
  await page.keyboard.type("xana");
  await expect(box.getByRole("option").first()).toContainText("Xanathar Guild");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/encyclopedia/${id}$`));
  await expect(box).toHaveCount(0);

  // a roll typed into the box is offered as one
  await page.keyboard.press("Control+k");
  await page.keyboard.type("2d6+3");
  await expect(page.getByRole("option", { name: /Roll 2d6\+3/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("?");
  await expect(page.locator("dialog[open]")).toContainText("Search the whole campaign");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  expectNoErrors(errors);
});

test("At the Table's campaign bar links to its boxes and opens a folded one; the bar says Saved after a change", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Jo");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`index.html#/c/${cid}/table`);
  const jump = page.locator(".nowbar .jump-links");
  await expect(jump.getByRole("link", { name: "Now" })).toBeVisible();
  const events = page.locator('section.daybox[data-box="table-events"]');
  await expect(events).toHaveClass(/folded/);
  await jump.getByRole("link", { name: /^Events/ }).click();
  await expect(events).not.toHaveClass(/folded/);

  // a narrow screen gets one Jump to ▾ menu instead
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(jump.getByRole("link", { name: "Now" })).toBeHidden();
  await expect(jump.locator(".jump-menu > summary")).toBeVisible();

  const status = page.locator(".nowbar .save-state");
  await expect(status).toHaveText("✓ Saved");
  expectNoErrors(errors);
});

test("the Encyclopedia shows the filters in force as chips, and ✕ drops one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Fil");
  await entry(page, cid, "Durnan", "Owner of the Yawning Portal.", { category: "person" });
  await entry(page, cid, "Waterdeep", "The City of Splendors.", { category: "location" });
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await page.locator(".enc-catpick > summary").click();
  await page.locator('.enc-catpick input[value="location"]').uncheck();
  await page.keyboard.press("Escape");
  const chips = page.locator(".fchips");
  await expect(chips).toContainText("Category:");
  await expect(page.locator(".enc-index")).not.toContainText("Waterdeep");
  await chips.getByRole("button", { name: "Drop the Category filter" }).click();
  await expect(chips).toBeHidden();
  await expect(page.locator(".enc-index")).toContainText("Waterdeep");
  expectNoErrors(errors);
});

test("Recent and Pinned stay out of the Legend until the campaign turns them on; a GM's pin shows for players", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Rex");
  const a = await entry(page, cid, "Stone of Golorr", "An aboleth turned to stone.");
  const b = await entry(page, cid, "Floon", "Missing.");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const id of [a, b]) { await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`); await expect(page.locator(".enc-detail h2")).toBeVisible(); }
  await expect(page.locator("nav.tabs .legend-quick")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "📌 Pin" })).toHaveCount(0);

  await page.goto(`index.html#/c/${cid}/settings`);
  await page.getByLabel("Recent in the Legend").check();
  await page.getByLabel("Pinned in the Legend").check();
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");

  await page.goto(`index.html#/c/${cid}/encyclopedia/${a}`);
  await expect(page.locator("nav.tabs a.legend-quick", { hasText: "Floon" })).toBeVisible();   // Recent
  await page.getByRole("button", { name: "📌 Pin" }).click();
  await expect(page.locator("nav.tabs .legend-quick-h.pinned")).toBeVisible();
  await expect(page.locator("nav.tabs a.legend-quick", { hasText: "Stone of Golorr" })).toBeVisible();

  const pl = person("Pip");
  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await signIn(p2, pl); await approve(browser, pl.email);
  await api(page, "member_add", { email: pl.email, role: "player" }, cid);
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.goto(`index.html#/c/${cid}/table`);
  await expect(p2.locator("nav.tabs a.legend-quick", { hasText: "Stone of Golorr" })).toBeVisible();
  await ctx.close();
  expectNoErrors(errors);
});
