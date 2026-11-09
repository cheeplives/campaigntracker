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
  await expect(page.locator("#undo-toast")).toBeHidden();   // the bar goes with the delete, wherever it sat
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

  // the box you are in is marked for a screen reader too, not by its tint alone
  await page.setViewportSize({ width: 1440, height: 900 });
  await jump.getByRole("link", { name: /^Events/ }).click();
  await expect(jump.locator("a[aria-current]")).toHaveCount(1);

  // nothing is claimed until something changes; then ✓ Saved, or Not saved when the server refuses
  const status = page.locator(".nowbar .save-state");
  await expect(status).toHaveText("");
  const now = page.locator(".tv-now");
  await now.getByRole("button", { name: "+ Note" }).click();
  await now.getByRole("textbox", { name: /^Notes for/ }).fill("The bell tolls");
  await now.getByRole("button", { name: "Add note" }).click();
  await expect(now.getByText("The bell tolls")).toBeVisible();
  await expect(status).toHaveText("✓ Saved");
  await page.route(/a=shift_note_add/, r => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
  await now.getByRole("button", { name: "+ Note" }).click();
  await now.getByRole("textbox", { name: /^Notes for/ }).fill("This one fails");
  await now.getByRole("button", { name: "Add note" }).click();
  await expect(status).toHaveText("Not saved");
  await page.unroute(/a=shift_note_add/);
  expectNoErrors(errors.filter(e => !/status of 500/.test(e)));   // the refused save logs its 500, as it should
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

test("Undo outlives a redraw of the same page, keeps the row hidden, and focus goes to Undo and back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Ula");
  await api(page, "shift_note_add", { abs_day: 2, shift: 0, body: "Going soon" }, cid);
  await page.goto(`index.html#/c/${cid}/table`);
  const now = page.locator(".tv-now");
  const del = now.locator(".enote", { hasText: "Going soon" }).getByRole("button", { name: "Delete" });
  await expect(del).toHaveClass(/danger/);   // Delete is outlined red, like every Delete
  await del.focus();
  await page.keyboard.press("Enter");
  const undo = page.locator("#undo-toast").getByRole("button", { name: /^Undo/ });
  await expect(undo).toBeFocused();

  // a save elsewhere on the page redraws it: the Undo stays, and so does the row's hiding
  await now.getByRole("button", { name: "+ Note" }).click();
  await now.getByRole("textbox", { name: /^Notes for/ }).fill("Another note");
  await now.getByRole("button", { name: "Add note" }).click();
  await expect(now.getByText("Another note")).toBeVisible();
  await expect(now.getByText("Going soon")).toBeHidden();
  await expect(page.locator("#undo-toast.show")).toBeVisible();
  await undo.click();
  await expect(now.getByText("Going soon")).toBeVisible();
  await expect(now.locator(".enote", { hasText: "Going soon" }).getByRole("button", { name: "Delete" })).toBeFocused();
  const day = async () => JSON.stringify(await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json());
  expect(await day()).toContain("Going soon");
  expectNoErrors(errors);
});

test("the peek leaves lists of entries alone, adds a note on the spot, and has no Pin on a GM-only entry", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Pel");
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.getByLabel("Pinned in the Legend").check();
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const ilse = await entry(page, cid, "Ilse", "She lives in London.");
  const london = await entry(page, cid, "London", "A city.", { category: "location" });
  const lair = await entry(page, cid, "The Lair", "GM only.", { is_secret: true });
  await api(page, "relations_save", { entry_id: ilse, type: { label: "Resident of", inverse_label: "Has resident" }, side: "from", add: [london] }, cid);
  await entry(page, cid, "Gunther", "Ilse's brother. He hides in The Lair.");

  // a Connections link is a way to go there: no peek
  await page.goto(`index.html#/c/${cid}/encyclopedia/${ilse}`);
  await page.locator(".enc-conn a.enc-link", { hasText: "London" }).click();
  await expect(page).toHaveURL(new RegExp(`/encyclopedia/${london}$`));
  await expect(page.locator(".peek")).toHaveCount(0);

  // a name in prose peeks; + Note adds to that entry without leaving
  const gunther = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.name === "Gunther").id;
  await page.goto(`index.html#/c/${cid}/encyclopedia/${gunther}`);
  await page.locator(".enc-detail .richtext a.enc-link", { hasText: "Ilse" }).click();
  const peek = page.locator(".peek");
  await expect(peek.getByRole("button", { name: "📌 Pin" })).toBeVisible();
  await peek.getByRole("button", { name: "+ Note" }).click();
  await peek.getByRole("textbox", { name: "Note on Ilse" }).fill("Owes the party a favour");
  await peek.getByRole("button", { name: "Save note" }).click();
  await expect(page.locator("#toast")).toContainText("Note added to Ilse");
  await expect(peek).toHaveCount(0);
  expect(page.url()).toContain(`/encyclopedia/${gunther}`);
  expect(JSON.stringify((await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.id === ilse))).toContain("Owes the party a favour");

  // a GM-only entry can't be pinned from its page, nor from its peek
  await page.locator(".enc-detail .richtext a.enc-link", { hasText: "The Lair" }).click();
  await expect(peek).toBeVisible();
  await expect(peek.getByRole("button", { name: "📌 Pin" })).toHaveCount(0);
  expect(lair).toBeTruthy();
  expectNoErrors(errors);
});

test("a pinned session's title never reaches players until it is published", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Ses");
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.getByLabel("Pinned in the Legend").check();
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const sid = (await api(page, "session_save", {}, cid)).json.session.id;
  await api(page, "session_save", { id: sid, title: "The secret heist" }, cid);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await page.getByRole("button", { name: "📌 Pin" }).click();
  await expect(page.locator("nav.tabs a.legend-quick", { hasText: "The secret heist" })).toBeVisible();
  // the pin keeps only the session's id: its title is not in the settings every member is sent
  const camp = await (await page.request.get(`api/index.php?a=campaign&cid=${cid}`)).json();
  expect(camp.campaign.settings.legend_pins).toEqual([{ kind: "session", id: sid }]);

  const pl = person("Pat");
  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await signIn(p2, pl); await approve(browser, pl.email);
  await api(page, "member_add", { email: pl.email, role: "player" }, cid);
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.goto(`index.html#/c/${cid}/table`);
  await expect(p2.locator(".nowbar")).toBeVisible();
  await expect(p2.locator("nav.tabs .legend-quick-h.pinned")).toHaveCount(0);
  expect(await p2.content()).not.toContain("The secret heist");

  await api(page, "session_save", { id: sid, is_published: true }, cid);
  await p2.reload();
  await expect(p2.locator("nav.tabs a.legend-quick", { hasText: "The secret heist" })).toBeVisible();
  await ctx.close();
  expectNoErrors(errors);
});

test("trails: a day page leads back to its month, and an entry's Category step lists that Category", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Tra");
  const yawn = await entry(page, cid, "Yawning Portal", "An inn.", { category: "location" });
  await entry(page, cid, "Durnan", "Its owner.", { category: "person" });
  await page.goto(`index.html#/c/${cid}/encyclopedia/${yawn}`);
  const trail = page.locator(".enc-detail nav.trail");
  await trail.getByRole("link", { name: "Location" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/encyclopedia$`));
  await expect(page.locator(".fchips")).toContainText("Category:");
  await expect(page.locator(".enc-index")).not.toContainText("Durnan");

  await page.goto(`index.html#/c/${cid}/day/2`);
  const dayTrail = page.locator("nav.trail");
  await expect(dayTrail.getByRole("link", { name: "Calendar" })).toBeVisible();
  await dayTrail.getByRole("link").nth(1).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/calendar$`));
  expectNoErrors(errors);
});

test("Ctrl K gives the focus back on Escape, and Tab stays in the box", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmCampaign(page, browser, "Esc");
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  const search = page.getByRole("searchbox", { name: "Search the Encyclopedia" });
  await search.focus();
  await page.keyboard.press("Control+k");
  const box = page.getByRole("dialog", { name: "Jump to" });
  await expect(box).toBeVisible();
  const input = box.getByRole("combobox");
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(search).toBeFocused();
  expectNoErrors(errors);
});
