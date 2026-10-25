// Settings → Tools → Import from Scabard: a Scabard JSON export becomes Encyclopedia entries (with their tags, other
// names, notes, GM secrets, connections and pictures) and Sessions for the dated session logs; it can be run again
// without adding anything twice, and only a GM may run it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

/** A small export in Scabard's shape: pages with ids, and connections between them by id and name. */
function scabardExport() {
  const page = (id, concept, name, extra = {}) => ({ id, concept, isGoldStar: false, uri: `/campaign/1/${concept.toLowerCase()}/${id}`, page: { name, concept, isSecret: false, ...extra } });
  const conn = (relationship, from, to, r = {}) => ({ relationship, from: from.page.name, fromid: from.id, to: to.page.name, toid: to.id, r: { dateCreatedUnix: 1, ...r } });
  const gunther = page(1, "Character", "Gunther Hoffmann", { aliases: "Hoffmann, the innkeeper, Gunther Hoffmann", briefSummary: "Innkeeper of the Grey Lady",
    description: "<div>Runs the <span>Grey Lady</span> with his <b>wife</b>.</div><ul><li>Owes the Order money</li></ul><p>See <a href=\"/campaign/1/place/3\">Altdorf</a>.</p>",
    gmSecrets: "<p>He is a Chaos cultist.</p>", secrets: "<p>He is a Chaos cultist.</p>", imageURL: "/user/gail/image/gunther_s.webp", largeImageURL: "/user/gail/image/gunther.png" });
  const spy = page(2, "Character", "Secret Spy", { isSecret: true, briefSummary: "Watches the party", gmSecrets: "<p>Works for the Order.</p>" });
  const altdorf = page(3, "Place", "Altdorf", { briefSummary: "The capital", description: "<p>The capital of the Empire.</p>", imageURL: "https://i.pinimg.com/736x/aa/bb/cc/altdorf.jpg" });
  const inn = page(4, "Place", "Grey Lady inn", { description: "<p>An inn by the docks.</p>", imageURL: "/assets/rf_images/place/gone/1.jpg" });
  const order = page(5, "Group", "Order of the Silver Flame", { briefSummary: "Knights" });
  const sword = page(6, "Item", "Durendal", { description: "<p>A sword.</p>" });
  const note = page(7, "Note", "Market days", { briefSummary: "Fourthday is market day" });
  const quest = page(8, "Adventure", "The Enemy Within", { briefSummary: "The long campaign" });
  const log1 = page(9, "Event", "2025-10-05: Final Preparations", { description: "<p>They shopped for the trip.</p>", gmSecrets: "<p>The tail follows them.</p><ul><li>Beat one</li></ul>", imageURL: "/assets/rf_images/event/1_s.jpg" });
  const log2 = page(10, "Event", "2025-10-12: Into the Night", { description: "<p>They left Altdorf.</p>" });
  const storm = page(11, "Event", "Wild Storm", { description: "<p>A storm over the Reik.</p>" });
  const city = page(12, "CCategory", "City");
  const pc = page(13, "CCategory", "NPC");
  const attr = page(14, "Attribute", "Alignment");
  const folder = page(15, "Folder", "Attributes and Categories");
  const tab = page(16, "FlexTab", "2547d6e7", { tabName: "URL", tabType: "text" });
  const longName = page(17, "Character", "L" + "o".repeat(170) + "ng", { briefSummary: "A name too long for here" });
  const nameless = page(18, "Character", "   ");
  const pages = [gunther, spy, altdorf, inn, order, sword, note, quest, log1, log2, storm, city, pc, attr, folder, tab, longName, nameless];
  const conns = [
    ...pages.map(p => ({ relationship: "CONCEPT_OF", fromid: 0, to: p.page.name, toid: p.id, r: {} })),
    conn("PARTICIPANT_OF", gunther, log1), conn("PARTICIPANT_OF", spy, log1), conn("SETTING_OF", altdorf, log1), conn("PROTAGONIST_OF", gunther, log1),
    conn("ENCOUNTER_OF", log1, quest), conn("NEXT_EVENT_OF", log2, log1), conn("CLONE_OF", log2, log1),
    conn("SUBREGION_OF", inn, altdorf), conn("LOCATION_OF", altdorf, gunther), conn("MEMBER_OF", gunther, order), conn("NEIGHBOR_OF", altdorf, inn),
    conn("OWNER_OF", gunther, inn, { isFormer: true, isSecret: false }), conn("SEEKER_OF", spy, sword), conn("RELATED_ITEM_OF", sword, gunther), conn("STEWARD_OF", gunther, inn, { isSecret: true }),
    conn("PARTICIPANT_OF", gunther, storm), conn("FOLDER_OF", folder, city), conn("CATEGORY_OF", city, attr), conn("TAB_OF", tab, gunther),
    conn("PLACE_CATEGORY_OF", city, altdorf), conn("ROLE_OF", pc, gunther), conn("ROLE_OF", pc, log1),
    { relationship: "PLAYER_OF", fromu: "Aosborn", fromid: 99, to: gunther.page.name, toid: gunther.id, r: {} },
    { relationship: "COMMENT_OF", fromid: 98, to: gunther.page.name, toid: gunther.id, r: {} },
    conn("PARTICIPANT_OF", nameless, log1),
  ];
  return { pages, conns };
}

/** Click Import from Scabard and give its file picker a JSON file holding `obj` (or the text as it is). */
async function pickFile(page, obj) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "⬆ Import from Scabard…" }).click()]);
  await chooser.setFiles({ name: "campaign.123.json", mimeType: "application/json", buffer: Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)) });
}
const byName = (list, name) => list.find(e => e.name === name);

test("a Scabard export becomes entries, tags, other names, notes, connections, sessions and pictures, and runs again without doubling", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gail");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Scabard ${gm.id}`);
  // A name the Proper Noun Detector added first, with nothing written yet: the import fills it in.
  expect((await api(page, "entries_add", { entries: [{ name: "Durendal", tags: [{ name: "Item" }] }] }, cid)).status).toBe(200);
  // A tome's secret aside has nothing to do with it; a kept entry with notes stays as it is.
  expect((await api(page, "entry_save", { name: "Order of the Silver Flame", notes: "<p>Our own notes on the Order.</p>" }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/settings`);
  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();

  // Not an export: refused before anything is sent.
  await pickFile(page, "not json");
  await expect(page.locator("#toast")).toHaveText("That isn't a JSON file");
  await pickFile(page, { months: [] });
  await expect(page.locator("#toast")).toContainText("isn't a Scabard export");

  // The dialog says what is in the file before anything is written.
  await pickFile(page, scabardExport());
  const dialog = page.getByRole("dialog", { name: "Import from Scabard" });
  await expect(dialog).toBeVisible();
  const plan = dialog.locator(".scabard-plan");
  await expect(plan).toContainText("10 Encyclopedia entries: 3 Person, 2 Location, 1 Group, 1 Item, 1 Note, 1 Adventure, 1 Event");
  await expect(plan).toContainText("2 session logs, each a Session played on its date");
  await expect(plan).toContainText("Left out: 2 categories, 1 attributes, 1 folders, 1 tabs");
  await expect(plan).toContainText("3 pictures on Scabard");
  // Session logs as entries instead: the plan follows the choice.
  await dialog.getByLabel("What dated events become").selectOption("entries");
  await expect(plan).toContainText("12 Encyclopedia entries");
  await expect(plan).not.toContainText("session log");
  await dialog.getByLabel("What dated events become").selectOption("sessions");
  await dialog.getByRole("button", { name: "Import" }).click();

  const report = page.getByRole("dialog", { name: "Imported from Scabard" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  const text = await report.locator(".kit-dialog-msg").textContent();
  expect(text).toContain("Entries: 8 added, 1 filled in, 1 kept as they were.");
  expect(text).toContain("Sessions: 2 added, 0 kept.");
  // Connections: Subregion, Location, Member, Neighbor, Owner, Seeker, Related item, Steward, and Participant in Wild Storm: 9.
  // Tags: a kind on each of the 10 entries but Durendal (Item already) = 9, plus City and NPC = 11 (NPC on a session has nowhere to go).
  // Lines: Player, and Participants, Setting, Protagonists and Part of on the session.
  expect(text).toMatch(/9 connections, 11 tags and 5 lines of notes added/);
  expect(text).toContain("Pictures: 1 copied, 2 not fetched (Altdorf (not on Scabard), Grey Lady inn).");
  expect(text).toContain("1 connection named a page that isn't in the file.");
  await report.getByRole("button", { name: "OK" }).click();
  await expect(report).toBeHidden();

  // The entries, as the GM sees them.
  let enc = (await api(page, "encyclopedia", undefined, cid)).json;
  const g = byName(enc.entries, "Gunther Hoffmann");
  expect(g.aliases).toEqual(["Hoffmann", "the innkeeper"]);
  expect(g.notes).toContain("<p>Innkeeper of the Grey Lady</p>");
  expect(g.notes).toContain("<p>Runs the Grey Lady with his <strong>wife</strong>.</p>");   // div → p, span unwrapped
  expect(g.notes).toContain("<li>Owes the Order money</li>");
  expect(g.notes).toContain("<p>See Altdorf.</p>");                                         // a Scabard link becomes text
  expect(g.notes).toMatch(/<p>Player: Aosborn<\/p>$/);
  expect(g.gm_notes).toBe("<p>He is a Chaos cultist.</p>");
  expect(g.is_secret).toBe(false);
  expect(g.tags.map(t => t.name).sort()).toEqual(["NPC", "Person"]);
  expect(byName(enc.entries, "Secret Spy").is_secret).toBe(true);
  expect(byName(enc.entries, "Altdorf").tags.map(t => t.name).sort()).toEqual(["City", "Location"]);
  expect(byName(enc.entries, "Altdorf").notes).toBe("<p>The capital</p><p>The capital of the Empire.</p>");   // the summary first, then the description
  expect(byName(enc.entries, "Secret Spy").notes).toBe("<p>Watches the party</p>");
  expect(byName(enc.entries, "Durendal").notes).toBe("<p>A sword.</p>");                    // the blank entry, filled in
  expect(byName(enc.entries, "Order of the Silver Flame").notes).toBe("<p>Our own notes on the Order.</p>"); // kept
  expect(byName(enc.entries, "Market days").tags.map(t => t.name)).toEqual(["Note"]);
  expect(byName(enc.entries, "The Enemy Within").tags.map(t => t.name)).toEqual(["Adventure"]);
  expect(byName(enc.entries, "Wild Storm").tags.map(t => t.name)).toEqual(["Event"]);       // undated: an entry
  expect(byName(enc.entries, "L" + "o".repeat(149))).toBeTruthy();                           // 150 characters at most
  expect(enc.entries.some(e => e.name.startsWith("2025-"))).toBe(false);
  // Connections read from the right end, former ones say so, and a secret one or one touching a secret entry is GM only.
  const label = (from, to) => enc.relations.filter(r => r.from_id === byName(enc.entries, from).id && r.to_id === byName(enc.entries, to).id)
    .map(r => { const t = enc.relation_types.find(x => x.id === r.type_id); return `${t.label}/${t.inverse_label}${r.note ? ` (${r.note})` : ""}${r.is_secret ? " 🔒" : ""}`; });
  expect(label("Altdorf", "Grey Lady inn")).toEqual(expect.arrayContaining(["Contains/Located in", "Neighbor of/"]));     // SUBREGION_OF flipped onto the starter kind
  expect(label("Altdorf", "Gunther Hoffmann")).toEqual(["Has resident/Resident of"]);
  expect(label("Order of the Silver Flame", "Gunther Hoffmann")).toEqual(["Has member/Member of"]);                     // MEMBER_OF, on the starter kind from the group's end
  expect(label("Gunther Hoffmann", "Grey Lady inn")).toEqual(expect.arrayContaining(["Owns/Owned by (Former)", "Steward of/Has steward 🔒"]));
  expect(label("Secret Spy", "Durendal")).toEqual(["Seeks/Sought by 🔒"]);
  expect(label("Durendal", "Gunther Hoffmann")).toEqual(["Related to/"]);
  expect(label("Gunther Hoffmann", "Wild Storm")).toEqual(["Participant in/Has participant"]);
  expect(enc.relations).toHaveLength(9);
  // The picture, credited to Scabard; the one hosted elsewhere and the one Scabard no longer has are not.
  const pic = enc.files.find(f => f.parent_id === g.id);
  expect(pic.kind).toBe("image");
  expect(pic.name).toBe("Gunther Hoffmann.png");
  expect(pic.credit).toMatchObject({ source: "Scabard", source_url: "https://www.scabard.com/campaign/1/character/1", title: "Gunther Hoffmann" });
  expect(enc.files.filter(f => f.parent_id !== g.id)).toEqual([]);

  // The sessions: dated, titled, closed, published, with the secrets as GM-only paragraphs and the cast as lines.
  const sessions = (await api(page, "sessions", undefined, cid)).json.sessions;
  expect(sessions.map(s => [s.number, s.title, s.played_on, s.is_published, s.last_day !== null])).toEqual([[2, "Into the Night", "2025-10-12", true, true], [1, "Final Preparations", "2025-10-05", true, true]]);
  const full = (await page.request.get(`api/index.php?a=session&cid=${cid}&id=${sessions[1].id}`).then(r => r.json())).session;
  expect(full.summary).toContain("<p>They shopped for the trip.</p>");
  expect(full.summary).toContain("<aside><p>The tail follows them.</p></aside><aside><ul><li>Beat one</li></ul></aside>");
  expect(full.summary).toContain("<p>Participants: Gunther Hoffmann, Secret Spy</p>");
  expect(full.summary).toContain("<p>Setting: Altdorf</p>");
  expect(full.summary).toContain("<p>Protagonists: Gunther Hoffmann</p>");
  expect(full.summary).toContain("<p>Part of: The Enemy Within</p>");

  // A player gets none of the GM's side.
  const player = person("Pip");
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const penc = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(byName(penc.entries, "Secret Spy")).toBeUndefined();
  expect(byName(penc.entries, "Gunther Hoffmann").gm_notes).toBeUndefined();
  expect(penc.relations.some(r => r.is_secret)).toBe(false);
  expect(penc.relations).toHaveLength(7);
  const psummary = (await pp.request.get(`api/index.php?a=session&cid=${cid}&id=${sessions[1].id}`).then(r => r.json())).session.summary;
  expect(psummary).not.toContain("tail follows");
  expect(psummary).toContain("Participants: Gunther Hoffmann, Secret Spy");
  // Only a GM imports.
  const { pages, conns } = scabardExport();
  expect((await api(pp, "scabard_import", { pages: pages.slice(0, 2), conns: [] }, cid)).status).toBe(403);
  expect((await api(pp, "scabard_picture", { name: "Altdorf", urls: ["https://www.scabard.com/x.png"] }, cid)).status).toBe(403);
  await pctx.close();

  // Run again: everything is kept, nothing doubles.
  await pickFile(page, scabardExport());
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(report).toBeVisible({ timeout: 30_000 });
  const again = await report.locator(".kit-dialog-msg").textContent();
  expect(again).toContain("Entries: 0 added, 0 filled in, 10 kept as they were.");
  expect(again).toContain("Sessions: 0 added, 2 kept.");
  expect(again).toMatch(/0 connections, 0 tags and 0 lines of notes added/);
  expect(again).toContain("Pictures: 0 copied, 1 already there");
  await report.getByRole("button", { name: "OK" }).click();
  enc = (await api(page, "encyclopedia", undefined, cid)).json;
  expect(enc.relations).toHaveLength(9);
  expect(enc.files).toHaveLength(1);
  expect(byName(enc.entries, "Gunther Hoffmann").notes.match(/Player: Aosborn/g)).toHaveLength(1);
  const again1 = (await page.request.get(`api/index.php?a=session&cid=${cid}&id=${sessions[1].id}`).then(r => r.json())).session.summary;
  expect(again1.match(/Participants:/g)).toHaveLength(1);
  expect((await api(page, "sessions", undefined, cid)).json.sessions).toHaveLength(2);

  // The Encyclopedia tab shows what came in.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${g.id}`);
  await expect(page.locator(".enc-detail")).toContainText("Runs the Grey Lady with his wife.");
  await expect(page.locator(".enc-detail")).toContainText("Member of");
  expectNoErrors(errors);
});

test("the reader splits dated names, counts the plan and batches by size", async ({ page }) => {
  await page.goto("index.html");
  const r = await page.evaluate(() => {
    const data = Scabard.parse(JSON.stringify({ pages: [
      { id: 1, concept: "Event", uri: "/campaign/1/event/1", page: { name: "2025-10-05: Final Preparations", description: "<p>x</p>" } },
      { id: 2, concept: "Event", uri: "/campaign/1/event/2", page: { name: "2025-13-05 Not a date" } },
      { id: 3, concept: "Character", uri: "/campaign/1/character/3", page: { name: "  Figol   Stonebeard ", imageURL: "/a.png", largeImageURL: "" } },
      { id: 4, concept: "Place", uri: "/campaign/1/place/4", page: { name: "" } },
    ], conns: [
      { relationship: "PARTICIPANT_OF", from: "Figol Stonebeard", fromid: 3, to: "2025-10-05: Final Preparations", toid: 1, r: { isSecret: true } },
      { relationship: "CONCEPT_OF", fromid: 0, to: "Figol Stonebeard", toid: 3, r: {} },
    ] }));
    return { data, plan: Scabard.plan(data), planEntries: Scabard.plan(data, { sessions: false }),
      split: [Scabard.sessionOf("2025-10-05: Final Preparations"), Scabard.sessionOf("2025-10-05 - Into the Night"), Scabard.sessionOf("2025-10-05"), Scabard.sessionOf("2025-02-30: Never"), Scabard.sessionOf("Wild Storm")],
      order: Scabard.order([{ concept: "Event", name: "2025-12-01: B" }, { concept: "Character", name: "C" }, { concept: "Event", name: "2025-01-01: A" }]).map(p => p.name),
      batches: Scabard.batches([{ a: "x".repeat(10) }, { a: "y".repeat(10) }, { a: "z".repeat(10) }], 300, 40).map(b => b.length),
      byCount: Scabard.batches([1, 2, 3, 4, 5], 2).map(b => b.length) };
  });
  expect(r.data.pages.map(p => p.name)).toEqual(["2025-10-05: Final Preparations", "2025-13-05 Not a date", "Figol Stonebeard"]);
  expect(r.data.pages[2].images).toEqual(["/a.png"]);
  expect(r.data.conns).toEqual([{ from: "Figol Stonebeard", to: "2025-10-05: Final Preparations", fromc: "Character", toc: "Event", relationship: "PARTICIPANT_OF", fromu: "", secret: true, former: false }]);
  expect(r.plan).toMatchObject({ entries: 2, kinds: { Event: 1, Person: 1 }, sessions: 1, connections: 1, pictures: 1 });
  expect(r.planEntries).toMatchObject({ entries: 3, kinds: { Event: 2, Person: 1 }, sessions: 0 });
  expect(r.split).toEqual([{ date: "2025-10-05", title: "Final Preparations" }, { date: "2025-10-05", title: "Into the Night" }, { date: "2025-10-05", title: "" }, null, null]);
  expect(r.order).toEqual(["C", "2025-01-01: A", "2025-12-01: B"]);
  expect(r.batches).toEqual([2, 1]);
  expect(r.byCount).toEqual([2, 2, 1]);
});
