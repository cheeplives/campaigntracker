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

// Connections: London "Has resident" Gunther shows on Gunther's page as "Resident of" London. One fact is one row,
// whichever page it was made on, and players never get a GM-only connection or one that touches a GM-only entry.
async function entry(page, cid, body) {
  const r = await api(page, "entry_save", body, cid);
  expect(r.status).toBe(200);
  return r.json.id;
}
const connRow = (page, label) => page.locator(".enc-conn-row").filter({ has: page.locator(".chip.enc-rel", { hasText: new RegExp(`^${label}$`) }) });

test("the Link dialog connects one entry to many, and each page reads the connection from its own end", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Connections");
  const london = await entry(page, cid, { name: "London", notes: "<p>A big city.</p>", tags: [{ name: "Location" }] });
  const gunther = await entry(page, cid, { name: "Gunther Hoffmann", notes: "<p>Innkeeper.</p>", tags: [{ name: "Person" }] });
  const ilse = await entry(page, cid, { name: "Mother Ilse", notes: "<p>Priestess.</p>", tags: [{ name: "Person" }] });
  const rolf = await entry(page, cid, { name: "Rolf the Spy", notes: "<p>Secret.</p>", is_secret: true });
  await entry(page, cid, { name: "The Grey Lady inn", notes: "<p>An inn.</p>", tags: [{ name: "Location" }] });

  await page.goto(`index.html#/c/${cid}/encyclopedia/${london}`);
  await expect(page.locator(".enc-conns")).toContainText("No connections yet.");
  await page.getByRole("button", { name: "🔗 Link" }).click();
  const dlg = page.locator("dialog.conn-dialog");
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("How London is connected").selectOption({ label: "Has resident ↔ Resident of" });
  await dlg.getByLabel("Show entries with this tag").selectOption({ label: "Person" });
  await expect(dlg.locator(".conn-row", { hasText: "The Grey Lady inn" })).toBeHidden();
  await dlg.getByRole("checkbox", { name: "Gunther Hoffmann" }).check();
  await dlg.getByRole("checkbox", { name: "Mother Ilse" }).check();
  await expect(dlg.locator(".conn-count")).toContainText('2 picked. Each will show "Resident of London" on its page.');
  await dlg.getByRole("button", { name: "Save connections" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(connRow(page, "Has resident")).toContainText("Gunther Hoffmann");
  await expect(connRow(page, "Has resident")).toContainText("Mother Ilse");

  // Gunther's page reads it the other way, and making it from his end finds the same connection.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${gunther}`);
  await expect(connRow(page, "Resident of")).toContainText("London");
  await page.getByRole("button", { name: "🔗 Link" }).click();
  await dlg.getByLabel("How Gunther Hoffmann is connected").selectOption({ label: "Resident of ↔ Has resident" });
  await expect(dlg.locator(".conn-row", { hasText: "London" })).toContainText("connected ✓");
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // A new relationship typed one way round that an existing one has the other way joins it.
  let r = await api(page, "relations_save", { entry_id: ilse, type: { label: "Resident of", inverse_label: "Has resident" }, side: "from", add: [london] }, cid);
  expect(r.status).toBe(200);
  expect(r.json.relations).toHaveLength(2);
  // A symmetric relationship is kept once from either end.
  expect((await api(page, "relations_save", { entry_id: gunther, type: { label: "Ally of", inverse_label: "" }, add: [ilse] }, cid)).status).toBe(200);
  r = await api(page, "relations_save", { entry_id: ilse, type: { label: "Ally of", symmetric: true }, add: [gunther] }, cid);
  expect(r.json.relations).toHaveLength(3);

  // GM only: a ticked connection, one to a secret entry, and a label used only by those never reach players.
  expect((await api(page, "relations_save", { entry_id: london, type: { label: "Secretly funds", inverse_label: "Funded by" }, add: [ilse], is_secret: true }, cid)).status).toBe(200);
  r = await api(page, "relations_save", { entry_id: london, type: { label: "Has resident", inverse_label: "Resident of" }, add: [rolf] }, cid);
  expect(r.json.relations.find(x => x.to_id === rolf).is_secret).toBe(true);
  const seen = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(seen.relations).toHaveLength(3);
  expect(seen.relations.some(x => x.to_id === rolf || x.from_id === rolf)).toBe(false);
  expect(seen.relation_types.map(t => t.label)).not.toContain("Secretly funds");
  expect((await api(pp, "relations_save", { entry_id: london, type: { label: "Has resident", inverse_label: "Resident of" }, add: [rolf] }, cid)).status).toBe(404);
  // Players can connect what they see, and only remove what they made.
  const gmRow = seen.relations.find(x => x.to_id === gunther && x.from_id === london);
  expect((await api(pp, "relation_delete", { id: gmRow.id }, cid)).status).toBe(403);
  r = await api(pp, "relations_save", { entry_id: gunther, type: { label: "Related to", symmetric: true }, add: [london], is_secret: true }, cid);
  expect(r.status).toBe(200);
  const mine = r.json.relations.find(x => x.type_id === r.json.type_id);
  expect(mine.is_secret).toBe(false); // players can't make GM-only connections
  expect((await api(pp, "relation_delete", { id: mine.id }, cid)).status).toBe(200);

  await pp.goto(`index.html#/c/${cid}/encyclopedia/${london}`);
  await expect(connRow(pp, "Has resident")).toContainText("Gunther Hoffmann");
  await expect(pp.locator(".enc-conns")).not.toContainText("Rolf");
  await expect(pp.locator(".enc-conns")).not.toContainText("Secretly funds");
  await page.goto(`index.html#/c/${cid}/encyclopedia/${london}`);
  await expect(connRow(page, "Has resident")).toContainText("Rolf the Spy");
  await expect(connRow(page, "Has resident").locator(".enc-conn.secret")).toContainText("Rolf the Spy");

  // Unticking removes, and deleting an entry takes its connections with it.
  await connRow(page, "Has resident").getByRole("button", { name: "✎" }).click();
  await dlg.getByRole("checkbox", { name: "Mother Ilse" }).uncheck();
  await expect(dlg.locator(".conn-row", { hasText: "Mother Ilse" })).toContainText("will be removed");
  await dlg.getByRole("button", { name: "Save connections" }).click();
  await expect(connRow(page, "Has resident")).not.toContainText("Mother Ilse");
  expect((await api(page, "entry_delete", { id: rolf }, cid)).status).toBe(200);
  r = (await api(page, "encyclopedia", undefined, cid)).json;
  expect(r.relations.some(x => x.to_id === rolf)).toBe(false);
  expectNoErrors(errors);
});

test("the notes suggest connections, and the list searches and filters by them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Suggest");
  const hans = await entry(page, cid, { name: "Hans", notes: "<p>A baker.</p>" });
  await entry(page, cid, { name: "Greta", notes: "<p>Hans's sister. She was born in Altdorf.</p>" });
  const altdorf = await entry(page, cid, { name: "Altdorf", notes: "<p>The capital.</p><p>Residents: Hans, Greta</p>" });
  await entry(page, cid, { name: "Nuln", notes: "<p>Far away.</p>" });

  await page.goto(`index.html#/c/${cid}/encyclopedia/${hans}`);
  const ideas = page.locator(".enc-suggest");
  await expect(ideas.locator("summary")).toHaveText(/Suggested connections \(2\)/);
  await ideas.locator("summary").click();
  await expect(ideas.locator("li[data-id]").first()).toContainText('"Residents" in Altdorf\'s notes');
  await ideas.locator(`li[data-id="${altdorf}"]`).getByRole("button", { name: "Connect…" }).click();
  const dlg = page.locator("dialog.conn-dialog");
  await expect(dlg.getByLabel("How Altdorf is connected")).toHaveValue("new");
  await expect(dlg.getByLabel("New connection, as Altdorf reads it")).toHaveValue("Residents");
  await expect(dlg.getByRole("checkbox", { name: "Hans" })).toBeChecked();
  await dlg.getByRole("checkbox", { name: "Greta" }).check();
  await dlg.getByRole("button", { name: "Save connections" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(connRow(page, "Residents")).toContainText("Altdorf");
  await expect(page.locator(".enc-suggest summary")).toHaveText(/Suggested connections \(1\)/); // Greta's notes name Hans

  // Search finds connections from either end; the chips and "Show in list" filter by them.
  const list = page.locator(".enc-lists section:last-child .enc-item");
  await page.getByLabel("Search the Encyclopedia").fill("residents");
  await expect(list).toHaveCount(3);
  await page.getByLabel("Search the Encyclopedia").fill("");
  await expect(list).toHaveCount(4);
  await page.locator(".enc-relpick button.tagopt", { hasText: "Residents" }).click();
  await expect(list).toHaveCount(3);
  await page.locator(".enc-relpick button.tagopt", { hasText: "Residents" }).click();
  await page.goto(`index.html#/c/${cid}/encyclopedia/${altdorf}`);
  // Only a hash change, so Hans's page (and its own Show in list) is still up until Altdorf's draws.
  await expect(page.locator(".enc-detail h2")).toHaveText("Altdorf");
  await page.getByRole("button", { name: "Show in list" }).click();
  await expect(page.locator(".enc-index")).toContainText("Connected to");
  await expect(list).toHaveCount(3);
  await expect(list.filter({ hasText: "Nuln" })).toHaveCount(0);
  await page.getByRole("button", { name: "× Clear" }).click();
  await expect(list).toHaveCount(4);

  // GMs rename a kind of connection once and every page follows.
  await page.locator(".enc-kinds summary").click();
  const kind = page.locator(`.enc-kind[data-label="Residents"]`);
  await kind.getByLabel("Label from the first end").fill("Has resident");
  await kind.getByLabel("Label from the other end").fill("Resident of");
  await kind.getByRole("button", { name: "Save" }).click();
  await expect(connRow(page, "Has resident")).toContainText("Hans");
  const r = (await api(page, "encyclopedia", undefined, cid)).json;
  expect(r.relations).toHaveLength(2);
  expectNoErrors(errors);
});

test("Generate Summary looks the name up on Wikipedia only when asked, and adds the summary with its source and licence", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Summary ${gm.id}`);
  const { json } = await api(page, "entries_add", { entries: [{ name: "Altdorf" }, { name: "Grey Lady inn" }] }, cid);
  const [altdorf, inn] = json.added;
  // Wikipedia is faked: a search for Altdorf finds two articles, anything else finds none.
  const asked = [];
  let down = false;
  await page.route("https://en.wikipedia.org/**", route => {
    const url = new URL(route.request().url());
    asked.push(url.href);
    if (down) return route.abort();
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    if (url.pathname === "/w/api.php") {
      const hits = url.searchParams.get("gsrsearch") === "Altdorf" ? [
        { pageid: 2, title: "Altdorf bei Nürnberg", index: 2, description: "Town in Bavaria, Germany" },
        { pageid: 1, title: "Altdorf, Uri", index: 1, description: "Municipality in the canton of Uri, Switzerland" },
      ] : [];
      return route.fulfill({ headers: cors, body: JSON.stringify(hits.length ? { query: { pages: hits } } : { batchcomplete: true }) });
    }
    expect(url.pathname).toBe("/api/rest_v1/page/summary/Altdorf%2C_Uri");
    return route.fulfill({ headers: cors, body: JSON.stringify({ type: "standard", title: "Altdorf, Uri",
      extract: "Altdorf is the capital of the Swiss canton of Uri. It is known for <its> statue of William Tell." }) });
  });

  await page.goto(`index.html#/c/${cid}/encyclopedia/${altdorf.id}`);
  const form = page.locator(".enc-form");
  await expect(form.getByRole("button", { name: "📚 Generate Summary" })).toBeVisible();
  expect(asked).toEqual([]); // nothing goes to Wikipedia until the button is pressed
  await form.getByRole("button", { name: "📚 Generate Summary" }).click();
  const box = form.locator(".enc-wiki");
  // the matching articles, in Wikipedia's order, each with its description, so a namesake can be passed over
  await expect(box.locator(".enc-wiki-hit strong")).toHaveText(["Altdorf, Uri", "Altdorf bei Nürnberg"]);
  await expect(box.locator(".enc-wiki-hit").first()).toContainText("Municipality in the canton of Uri, Switzerland");
  await box.locator(".enc-wiki-hit").first().click();
  await expect(box.locator("blockquote")).toContainText("Altdorf is the capital of the Swiss canton of Uri.");
  await box.getByRole("button", { name: "Add to notes" }).click();
  const editor = form.locator(".notepanel.public .ql-editor");
  await expect(editor).toContainText("It is known for <its> statue of William Tell.");
  await expect(editor).toContainText("Source: Altdorf, Uri, Wikipedia, CC BY-SA 4.0");
  await expect(editor.locator("a")).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Altdorf,_Uri");
  await form.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByText("Entry saved")).toBeVisible();
  // the summary is notes like any other, so the detector offers the names in it
  await expect(nounRow(page, "William Tell")).toBeVisible();
  await page.locator("dialog.noun-dialog").getByRole("button", { name: "Not now" }).click();
  const saved = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.id === altdorf.id);
  expect(saved.notes).toContain("It is known for &lt;its&gt; statue of William Tell.");
  expect(saved.notes).toContain('href="https://en.wikipedia.org/wiki/Altdorf,_Uri"');
  await expect(page.locator(".enc-detail .richtext a[href='https://en.wikipedia.org/wiki/Altdorf,_Uri']")).toHaveText("Altdorf, Uri");

  // No article, or no connection: it says so in a line and the notes are left alone.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${inn.id}`);
  await form.getByRole("button", { name: "📚 Generate Summary" }).click();
  await expect(form.locator(".enc-wiki")).toContainText("Wikipedia has no article matching \"Grey Lady inn\"");
  expectNoErrors(errors); // checked before the outage, which every browser logs as a failed load
  down = true;
  await form.getByRole("button", { name: "📚 Generate Summary" }).click();
  await expect(form.locator(".enc-wiki")).toContainText("Could not reach Wikipedia");
  await expect(form.locator(".notepanel.public .ql-editor")).not.toContainText("Source:");
});
