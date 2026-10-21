// The Encyclopedia tab and the Proper Noun Detector: saving a note, event, reminder or Locations visited list offers the
// new names in it (capitalized, emphasized or set apart), each to Add, Ignore or Skip; added names become entries with
// Public notes for everyone and GM notes for GMs, tags of their own, and links wherever the name is written.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const nounRow = (page, name) => page.locator(`.noun-row[data-term="${name}"]`);

test("the detector finds names, emphasis and set-apart words, and leaves out common and calendar words", async ({ page, browser }) => {
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Detector ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(page.locator(".enc-index h2")).toHaveText(/Encyclopedia/);
  const found = await page.evaluate(() => Nouns.find([
    { text: "Gunther runs the inn in Altdorf. The party met the Order of the Silver Flame on Firstmonth 3. Walking home, I saw Altdorf's walls.\nToday we rested." },
    { text: '<p>We found <strong>warpstone</strong> and a <em>Black Hand</em> token.</p><p>Gunther said "Old Hans" was gone. GM note: check HP.</p>', format: "html" },
    { text: "Altdorf, the Grey Lady inn; crossroads", kind: "locations" },
  ], { known: ["Nuln"], ignored: ["silver flame"], stop: ["Firstmonth"] }).map(f => f.term));
  for (const name of ["Gunther", "Altdorf", "Order of the Silver Flame", "warpstone", "Black Hand", "Old Hans", "Grey Lady inn"]) expect(found).toContain(name);
  for (const word of ["The", "Walking", "Today", "I", "Firstmonth", "GM", "HP", "crossroads", "We"]) expect(found).not.toContain(word);
  const tagged = await page.evaluate(() => Nouns.find([{ text: "Altdorf", kind: "locations" }], {})[0].tag);
  expect(tagged).toBe("Location");
  // links match whole words, either case of the first letter, the longest name first, and not inside other words
  const parts = await page.evaluate(() => Nouns.linker([{ id: 1, name: "Altdorf" }, { id: 2, name: "Altdorf Bank" }], (e, t) => `[${e.id}:${t}]`)
    .text("altdorf, the Altdorf Bank, Altdorfer"));
  expect(parts.join("")).toBe("[1:altdorf], the [2:Altdorf Bank], Altdorfer");
});

test("saving notes offers new names; added ones become entries, linked on the page, and secret ones stay with the GMs", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Encyclopedia");
  await page.goto(`index.html#/c/${cid}`);
  const pub = page.locator(".notepanel.public .ql-editor"), sec = page.locator(".notepanel.secret .ql-editor");
  await expect(pub).toBeVisible();
  await page.locator("textarea[name=locations]").fill("Altdorf, the Grey Lady inn");
  await pub.click();
  await page.locator(".notepanel.public button.ql-bold").click();
  await pub.pressSequentially("Gunther");
  await page.locator(".notepanel.public button.ql-bold").click();
  await pub.pressSequentially(" runs the inn in Altdorf.");
  await sec.click();
  await sec.pressSequentially("The Black Hand pays him.");
  await page.getByRole("button", { name: "Save notes" }).click();

  const dlg = page.locator("dialog.noun-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".noun-row")).toHaveCount(4);
  await expect(nounRow(page, "Altdorf").locator("select")).toHaveValue("Location");
  await expect(nounRow(page, "Black Hand").locator("input[type=checkbox]")).toBeChecked(); // only in the Secret notes
  await expect(nounRow(page, "Gunther").locator("input[type=checkbox]")).not.toBeChecked();
  await nounRow(page, "Gunther").locator("select").selectOption("Person");
  await nounRow(page, "Grey Lady inn").getByText("Ignore").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.getByText("Added 3 to the Encyclopedia · 1 ignored")).toBeVisible();

  const { json } = await api(page, "encyclopedia", undefined, cid);
  const byName = Object.fromEntries(json.entries.map(e => [e.name, e]));
  expect(Object.keys(byName).sort()).toEqual(["Altdorf", "Black Hand", "Gunther"]);
  expect(byName["Black Hand"].is_secret).toBe(true);
  expect(byName.Gunther.tags.map(t => t.name)).toEqual(["Person"]);
  expect(byName.Altdorf.tags.map(t => t.name)).toEqual(["Location"]);
  expect(json.ignored).toEqual(["Grey Lady inn"]);
  // the GM's notes are still open in their editors, so the entries they name are listed below them
  await expect(page.locator("[data-box=notes] .enc-mentions a")).toHaveText(["Altdorf", "Gunther", "Black Hand"]);
  // saving the same notes again finds nothing new
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Notes saved")).toBeVisible();
  await expect(dlg).toHaveCount(0);

  // The player never gets the secret entry, its name, or the GMs' ignored words.
  const perrors = watchErrors(pp);
  const pj = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(pj.entries.map(e => e.name).sort()).toEqual(["Altdorf", "Gunther"]);
  expect(pj.ignored).toEqual([]);
  expect(JSON.stringify(pj)).not.toContain("Black Hand");
  expect(JSON.stringify((await api(pp, "encyclopedia_sources", undefined, cid)).json)).not.toContain("Black Hand");
  expect(JSON.stringify((await api(pp, "campaign", undefined, cid)).json)).not.toContain("Black Hand");

  // Names are linked where the player reads them, and a link opens the entry.
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator(".notes-locs a.enc-link")).toHaveText("Altdorf");
  await expect(pp.locator("[data-box=notes] .richtext strong a.enc-link")).toHaveText("Gunther");
  await pp.locator("[data-box=notes] .richtext a.enc-link", { hasText: "Gunther" }).click();
  await expect(pp).toHaveURL(new RegExp(`#/c/${cid}/encyclopedia/${byName.Gunther.id}$`));
  // A new entry is blank, so it opens in its editor. Players write Public notes but get no GM notes.
  await expect(pp.locator(".enc-blank .enc-item")).toHaveCount(2);
  await expect(pp.locator(".enc-form .notepanel.secret")).toHaveCount(0);
  const editor = pp.locator(".enc-form .notepanel.public .ql-editor");
  await editor.click();
  await editor.pressSequentially("Innkeeper of the Grey Lady, friend of Altdorf's watch.");
  await pp.getByRole("button", { name: "Save entry" }).click();
  await expect(pp.getByText("Entry saved")).toBeVisible();
  await expect(pp.locator(".enc-detail h2")).toHaveText("Gunther");
  await expect(pp.locator(".enc-detail .richtext a.enc-link")).toHaveText("Altdorf"); // other entries are linked in it
  await expect(pp.locator(".enc-detail .enc-where a")).toContainText(["Public notes"]);
  await expect(pp.locator(".enc-blank .enc-item")).toHaveCount(1);
  // what the player saved is checked too: "Grey Lady" is new to them
  await expect(pp.locator("dialog.noun-dialog")).toBeVisible();
  await expect(pp.locator("dialog.noun-dialog input[type=checkbox]")).toHaveCount(0); // no GM only box for players
  await pp.locator("dialog.noun-dialog").getByRole("button", { name: "Not now" }).click();
  await expect(pp.locator("dialog.noun-dialog")).toHaveCount(0);
  expect((await api(pp, "entry_delete", { id: byName.Altdorf.id }, cid)).status).toBe(403); // the GM added it
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("Scan campaign offers every missing name, starting on Skip, and the GM keeps GM notes and tags", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Scan");
  expect((await api(page, "event_save", { abs_day: 2, title: "Ambush", body: "They met *Captain Rolf* near Marienburg.", tags: [] }, cid)).status).toBe(200);
  expect((await api(page, "reminder_save", { title: "Pay the toll", body: "At the Kemperbad bridge", due_shift: 20, audience: "gm" }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(page.locator(".enc-detail")).toContainText("Nothing here yet");
  await page.getByRole("button", { name: "🔍 Scan campaign" }).click();
  const dlg = page.locator("dialog.noun-dialog");
  await expect(dlg).toBeVisible();
  for (const n of ["Captain Rolf", "Marienburg", "Kemperbad"]) await expect(nounRow(page, n)).toBeVisible();
  await expect(nounRow(page, "Kemperbad").locator("input[type=checkbox]")).toBeChecked(); // a GMs-only reminder
  await expect(nounRow(page, "Marienburg").locator("input[value=skip]")).toBeChecked();
  await nounRow(page, "Marienburg").getByText("Add").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.locator(".enc-blank .enc-item")).toHaveText(["Marienburg"]);

  // The blank entry opens in its editor: tag it with a tag of the GM's own, write GM notes, and save.
  await page.locator(".enc-blank .enc-item").click();
  await page.locator(".enc-form input[aria-label='New tag name']").fill("Port");
  await page.locator(".enc-form").getByRole("button", { name: "+ Add tag" }).click();
  const gmNotes = page.locator(".enc-form .notepanel.secret .ql-editor");
  await gmNotes.click();
  await gmNotes.pressSequentially("Smugglers run the docks.");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.locator(".enc-detail .notepanel.secret")).toContainText("Smugglers run the docks.");
  await expect(page.locator(".enc-blank")).toHaveCount(0); // GM notes alone fill it, for the GM
  await expect(page.locator(".enc-detail .enc-where a")).toHaveText([/event "Ambush"/]);
  const tags = (await api(page, "encyclopedia", undefined, cid)).json.tags.map(t => t.name);
  for (const t of ["Location", "Item", "Person", "Group", "Event", "Religion", "Port"]) expect(tags).toContain(t);
  expect((await api(page, "campaign", undefined, cid)).json.tags.map(t => t.name)).not.toContain("Port"); // apart from the events' tags

  // The event's text now links Marienburg, on its day and in the Events list.
  await page.goto(`index.html#/c/${cid}/events`);
  await expect(page.locator(".evrow a.enc-link")).toHaveText("Marienburg");
  await page.goto(`index.html#/c/${cid}/day/2`);
  await expect(page.locator(".event a.enc-link")).toHaveText("Marienburg");
  expectNoErrors(errors);
});
