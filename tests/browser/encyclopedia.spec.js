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
  // Title case and sentence starts: an everyday word there is not a name, unless it is also written capitalized mid-sentence.
  const titles = await page.evaluate(() => Nouns.find([
    { text: "Ambush on the road\nBeastmen struck the coach near Weissbruck. Rest came late.", title: true },
    { text: "Battle at the Bridge\nWe held the Bridge until dawn.", title: true },
  ], {}).map(f => f.term));
  expect(titles).toEqual(expect.arrayContaining(["Beastmen", "Weissbruck", "Bridge"]));
  for (const word of ["Ambush", "Rest", "Battle", "We"]) expect(titles).not.toContain(word);
  // Known names are never offered, and the campaign's own names hint at a tag.
  const known = await page.evaluate(() => Nouns.find([{ text: "Pip met Gunther Hoffmann in Reikland." }],
    { known: ["Gunther Hoffmann"], stop: ["Pip"], hints: { Reikland: "Location" } }));
  expect(known.map(f => `${f.term}:${f.tag}`)).toEqual(["Reikland:Location"]);
  // A guess at the tag from the name and the words beside it.
  const tags = await page.evaluate(() => Object.fromEntries(Nouns.find([{ text: "Altdorf", kind: "locations" },
    { text: "Captain Rolf drank at the Grey Lady inn. We prayed to Sigmar. The sword Durendal glowed. The Order of the Silver Flame rode past Nuln." }], {}).map(f => [f.term, f.tag])));
  expect(tags).toMatchObject({ Altdorf: "Location", "Captain Rolf": "Person", "Grey Lady inn": "Location", Sigmar: "Religion", Durendal: "Item", "Order of the Silver Flame": "Group" });
  // A name that overlaps an entry may be another name for it; aliases link too.
  const like = await page.evaluate(() => Nouns.related("Hoffmann", [{ id: 1, name: "Gunther Hoffmann" }, { id: 2, name: "Altdorf", aliases: ["Reikstadt"] }]).map(e => e.id));
  expect(like).toEqual([1]);
  const aliased = await page.evaluate(() => Nouns.linker([{ id: 2, name: "Altdorf", aliases: ["Reikstadt"] }], (e, t) => `[${e.id}:${t}]`).text("to reikstadt").join(""));
  expect(aliased).toBe("to [2:reikstadt]");
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
  await pub.pressSequentially(" runs the inn in Altdorf. Pip slept."); // Pip is a member: never offered
  await sec.click();
  await sec.pressSequentially("The Black Hand pays him.");
  await page.getByRole("button", { name: "Save notes" }).click();

  const dlg = page.locator("dialog.noun-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".noun-row")).toHaveCount(4);
  await expect(nounRow(page, "Altdorf").locator("select")).toHaveValue("Location");
  await expect(nounRow(page, "Black Hand").locator("input[type=checkbox]")).toBeChecked(); // only in the Secret notes
  await expect(nounRow(page, "Gunther").locator("input[type=checkbox]")).not.toBeChecked();
  await expect(nounRow(page, "Grey Lady inn").locator("select")).toHaveValue("Location"); // from the Locations visited list
  await nounRow(page, "Gunther").locator("select").selectOption("Person");
  await nounRow(page, "Grey Lady inn").getByText("Ignore").click();
  await nounRow(page, "Black Hand").getByText("Skip").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.getByText("Added 2 to the Encyclopedia · 1 ignored")).toBeVisible();
  // A skipped name isn't asked about again until the page is reloaded; a scan still finds it.
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Notes saved")).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".notepanel.public .ql-editor")).toContainText("Gunther");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".noun-row")).toHaveCount(1);
  await expect(nounRow(page, "Black Hand").locator("input[type=checkbox]")).toBeChecked();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.getByText("Added 1 to the Encyclopedia")).toBeVisible();

  const { json } = await api(page, "encyclopedia", undefined, cid);
  const byName = Object.fromEntries(json.entries.map(e => [e.name, e]));
  expect(Object.keys(byName).sort()).toEqual(["Altdorf", "Black Hand", "Gunther"]);
  expect(byName["Black Hand"].is_secret).toBe(true);
  expect(byName.Gunther.tags.map(t => t.name)).toEqual(["Person"]);
  expect(byName.Altdorf.tags.map(t => t.name)).toEqual(["Location"]);
  expect(json.ignored).toEqual(["Grey Lady inn"]);
  // the GM's notes are still open in their editors, so the entries they name are listed below them
  await expect(page.locator("[data-box=notes] .enc-mentions a")).toHaveText(["Altdorf", "Gunther", "Black Hand"]);

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
  // What was written about it elsewhere is quoted, and a quote goes into the notes with one click.
  await expect(pp.locator(".enc-found .enc-quote blockquote")).toContainText(["Gunther runs the inn in Altdorf."]);
  await pp.locator(".enc-found").getByRole("button", { name: "Add to notes" }).first().click();
  const editor = pp.locator(".enc-form .notepanel.public .ql-editor");
  await expect(editor).toContainText("Gunther runs the inn in Altdorf.");
  await editor.click();
  await pp.keyboard.press("End");
  await editor.pressSequentially(" Innkeeper of the Grey Lady, friend of Altdorf's watch.");
  await pp.getByRole("button", { name: "Save entry" }).click();
  await expect(pp.getByText("Entry saved")).toBeVisible();
  await expect(pp.locator(".enc-detail h2")).toHaveText("Gunther");
  await expect(pp.locator(".enc-detail .richtext a.enc-link").first()).toHaveText("Altdorf"); // other entries are linked in it
  await expect(pp.locator(".enc-detail .enc-where a")).toContainText(["Public notes"]);
  // the hover text on a link gives the first line of the entry
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator("[data-box=notes] .richtext a.enc-link", { hasText: "Gunther" })).toHaveAttribute("data-tip", /Gunther runs the inn in Altdorf/);
  await pp.goBack();
  await expect(pp.locator(".enc-detail h2")).toHaveText("Gunther");
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
  expect((await api(page, "event_save", { abs_day: 2, title: "Ambush", body: "They met *Captain Rolf* near Marienburg. Rolf limps.", tags: [] }, cid)).status).toBe(200);
  expect((await api(page, "reminder_save", { title: "Pay the toll", body: "At the Kemperbad bridge", due_shift: 20, audience: "gm" }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(page.locator(".enc-detail")).toContainText("Nothing here yet");
  await page.getByRole("button", { name: "🔍 Scan campaign" }).click();
  const dlg = page.locator("dialog.noun-dialog");
  await expect(dlg).toBeVisible();
  for (const n of ["Captain Rolf", "Rolf", "Marienburg", "Kemperbad bridge"]) await expect(nounRow(page, n)).toBeVisible();
  await expect(nounRow(page, "Ambush")).toHaveCount(0); // a title word, and an everyday one
  await expect(nounRow(page, "Kemperbad bridge").locator("input[type=checkbox]")).toBeChecked(); // a GMs-only reminder
  await expect(nounRow(page, "Marienburg").locator("input[value=skip]")).toBeChecked();
  await expect(nounRow(page, "Captain Rolf").locator("select").first()).toHaveValue("Person");
  await nounRow(page, "Marienburg").getByText("Add").click();
  await nounRow(page, "Captain Rolf").getByText("Add").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.locator(".enc-blank .enc-item")).toHaveText([/Captain Rolf/, /Marienburg/]);
  // "Rolf" overlaps the new Captain Rolf entry, so the next scan offers it as another name for him.
  await page.getByRole("button", { name: "🔍 Scan campaign" }).click();
  await expect(nounRow(page, "Rolf").locator("input[value=alias]")).toHaveCount(1);
  await expect(nounRow(page, "Marienburg")).toHaveCount(0);
  await nounRow(page, "Rolf").getByText("Alias").click();
  await expect(nounRow(page, "Rolf").locator("select[aria-label^='Which entry']")).toHaveValue(/\d+/);
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(page.getByText("1 other name added")).toBeVisible();
  const rolf = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.name === "Captain Rolf");
  expect(rolf.aliases).toEqual(["Rolf"]);
  // the alias links to the entry, and can't be the name of another entry
  await page.goto(`index.html#/c/${cid}/day/2`);
  await expect(page.locator(".event a.enc-link")).toHaveText(["Captain Rolf", "Marienburg", "Rolf"]);
  expect((await api(page, "entry_save", { name: "rolf" }, cid)).status).toBe(409);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);

  // The blank entry opens in its editor: tag it with a tag of the GM's own, write GM notes, and save.
  await page.locator(".enc-blank .enc-item", { hasText: "Marienburg" }).click();
  await page.locator(".enc-form input[aria-label='New tag name']").fill("Port");
  await page.locator(".enc-form").getByRole("button", { name: "+ Add tag" }).click();
  const gmNotes = page.locator(".enc-form .notepanel.secret .ql-editor");
  await gmNotes.click();
  await gmNotes.pressSequentially("Smugglers run the docks.");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.locator(".enc-detail .notepanel.secret")).toContainText("Smugglers run the docks.");
  await expect(page.locator(".enc-blank .enc-item")).toHaveText([/Captain Rolf/]); // GM notes alone fill it, for the GM
  await expect(page.locator(".enc-detail .enc-where a")).toHaveText([/event "Ambush"/]);
  const tags = (await api(page, "encyclopedia", undefined, cid)).json.tags.map(t => t.name);
  for (const t of ["Location", "Item", "Person", "Group", "Event", "Religion", "Port"]) expect(tags).toContain(t);
  expect((await api(page, "campaign", undefined, cid)).json.tags.map(t => t.name)).not.toContain("Port"); // apart from the events' tags

  // The event's text now links Marienburg, on its day and in the Events list.
  await page.goto(`index.html#/c/${cid}/events`);
  await expect(page.locator(".evrow a.enc-link")).toHaveText(["Captain Rolf", "Marienburg", "Rolf"]);
  await page.goto(`index.html#/c/${cid}/day/2`);
  await expect(page.locator(".event a.enc-link")).toHaveText(["Captain Rolf", "Marienburg", "Rolf"]);
  expectNoErrors(errors);
});
