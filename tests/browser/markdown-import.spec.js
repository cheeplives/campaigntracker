// Settings → Tools → Import from Markdown: notes from an Obsidian vault, a folder of .md files, a zip or our own Markdown
// export become Encyclopedia entries (other names, tags, Category, GM notes) and connections; it can be run again without
// adding anything twice, and only a GM may run it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
const MdImport = require("../../static/mdimport.js");
const LoreExport = require("../../static/lore-export.js");
test.afterEach(closeContexts);

const vault = [
  { path: "Vault/NPCs/Gunther.md", text: "---\ntitle: Gunther Hoffmann\naliases: [Hoffmann, the innkeeper]\ntags:\n  - innkeeper\n  - \"#grey\"\ncategory: person\n---\n# Gunther Hoffmann\nRuns the [[Grey Lady inn|Grey Lady]] with **his** wife. See [[Altdorf#Docks]].\n\n- Owes money\n- [x] Pays late\n\n%% a private comment %%\n![[portrait.png]]\n" },
  { path: "Vault/Places/Grey Lady inn.md", text: "An inn by the docks. Owner: [[Gunther Hoffmann]]. Nobody knows [[Atlantis]].\n" },
  { path: "Vault/Places/Altdorf.md", text: "---\nsecret: true\n---\n# Altdorf\nThe *capital*. <script>alert(1)</script> [site](https://example.com/x) [bad](javascript:void)\n" },
  { path: "Vault/Lore/Calendar.md", text: "# Calendar\nTwelve months.\n" },
  { path: "Vault/.obsidian/workspace.md", text: "# not a note\n" },
];

test("the files are read: front matter, headings, folders, wikilinks and Markdown", () => {
  const p = MdImport.parse(vault);
  const by = n => p.entries.find(e => e.name === n);
  expect(p.entries.map(e => e.name).sort()).toEqual(["Altdorf", "Calendar", "Grey Lady inn", "Gunther Hoffmann"]);   // .obsidian left out
  const g = by("Gunther Hoffmann");
  expect(g).toMatchObject({ aliases: ["Hoffmann", "the innkeeper"], category: "person", is_secret: false });
  expect(g.tags).toEqual(["innkeeper", "grey"]);
  expect(g.notes).toBe("<p>Runs the Grey Lady with <strong>his</strong> wife. See Altdorf.</p><ul><li>Owes money</li><li>Pays late</li></ul>");   // comment and picture gone, the # heading is the name
  // a folder that is a Category sets it; one that isn't becomes a tag; the wrapping folder is dropped
  expect(by("Grey Lady inn").category).toBe("location");
  expect(by("Altdorf")).toMatchObject({ category: "location", is_secret: true });
  expect(by("Calendar")).toMatchObject({ category: "", tags: ["Lore"] });
  // only http(s) links survive, and nothing else of the page does
  expect(by("Altdorf").notes).toBe("<p>The <em>capital</em>. &lt;script&gt;alert(1)&lt;/script&gt; <a href=\"https://example.com/x\">site</a> bad</p>");
  // a link to a note that is there is a connection; to one that isn't is left out and counted
  expect(p.links).toEqual([
    { from: "Gunther Hoffmann", to: "Grey Lady inn", label: "Related to", note: "", secret: false },
    { from: "Gunther Hoffmann", to: "Altdorf", label: "Related to", note: "", secret: false },
  ]);   // the inn's link back to Gunther is the same connection
  expect(p.skipped.links).toBe(1);
  expect(() => MdImport.parse([{ path: "a.txt", text: "x" }])).toThrow("No Markdown");
  expect(MdImport.plan(p)).toMatchObject({ entries: 4, links: 2, secret: 1 });
});

test("our own Markdown export reads back: its about line, GM notes and connections, and not its index page", () => {
  const entries = [
    { id: 1, name: "Altdorf", category: "location", aliases: ["The Capital"], tags: [{ name: "city" }], notes: "<p>Big.</p>", gm_notes: "<p>Secret.</p>", is_secret: true, files: [], links: [{ label: "Contains", to: 2, note: "the docks", is_secret: true }] },
    { id: 2, name: "Grey Lady inn", category: "location", aliases: [], tags: [], notes: "<p>An inn.</p>", gm_notes: "", is_secret: false, files: [], links: [{ label: "Located in", to: 1, note: "", is_secret: false }] },
  ];
  const { files } = LoreExport.markdown(entries, [], { campaign: "Test", gm: true, gmOnly: true, date: "2026-11-07", toMarkdown: h => h.replace(/<\/?p>/g, "") });
  const p = MdImport.parse(files.map(f => ({ path: f.path, text: f.text })));
  expect(p.skipped.index).toBe(1);
  expect(p.entries).toHaveLength(2);
  expect(p.entries[0]).toMatchObject({ name: "Altdorf", category: "location", aliases: ["The Capital"], tags: ["city"], is_secret: true, notes: "<p>Big.</p>", gm_notes: "<p>Secret.</p>" });
  expect(p.links).toContainEqual({ from: "Altdorf", to: "Grey Lady inn", label: "Contains", note: "the docks", secret: true });
  expect(p.links).toContainEqual({ from: "Grey Lady inn", to: "Altdorf", label: "Located in", note: "", secret: false });
});

test("a zip is opened, stored or compressed, and only its notes are read", async () => {
  const zip = LoreExport.zip([{ path: "Vault/A.md", data: "# A\nHello" }, { path: "Vault/pic.png", data: new Uint8Array([1, 2, 3]) }, { path: "__MACOSX/Vault/._A.md", data: "x" }, { path: "Vault/B.md", data: "[[A]] é" }]);
  const files = await MdImport.unzip(zip);
  expect(files).toEqual([{ path: "Vault/A.md", text: "# A\nHello" }, { path: "Vault/B.md", text: "[[A]] é" }]);
  await expect(MdImport.unzip(new Uint8Array([1, 2, 3]))).rejects.toThrow("isn't a zip");
  // compressed (what Obsidian's own zips and every OS zip tool write)
  const { deflateRawSync } = require("zlib");
  const data = deflateRawSync(Buffer.from("# Deflated\nBody"));
  const name = Buffer.from("D.md"), le = (n, b) => { const x = Buffer.alloc(b); x.writeUIntLE(n, 0, b); return x; };
  const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(0, 2), le(8, 2), le(0, 4), le(0, 4), le(data.length, 4), le(15, 4), le(name.length, 2), le(0, 2), name, data]);
  const central = Buffer.concat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(8, 2), le(0, 4), le(0, 4), le(data.length, 4), le(15, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(0, 4), name]);
  const end = Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(1, 2), le(1, 2), le(central.length, 4), le(local.length, 4), le(0, 2)]);
  expect(await MdImport.unzip(new Uint8Array(Buffer.concat([local, central, end])))).toEqual([{ path: "D.md", text: "# Deflated\nBody" }]);
});

test("a GM imports notes: entries, tags, Category, GM notes and connections, and again without doubling", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Mara");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Markdown ${gm.id}`);
  // An entry the GM wrote by hand stays as it is; one with nothing in it yet is filled in; "Located in" is a starter kind.
  expect((await api(page, "entry_save", { name: "Altdorf", notes: "<p>Our own words.</p>" }, cid)).status).toBe(200);
  expect((await api(page, "entries_add", { entries: [{ name: "Grey Lady inn", category: "location" }] }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/settings/tools`);
  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();

  const pick = async files => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import from Markdown…" }).click()]);
    await chooser.setFiles(files.map(f => ({ name: f.name, mimeType: "text/markdown", buffer: Buffer.from(f.text) })));
  };
  const files = [
    { name: "Gunther.md", text: vault[0].text },
    { name: "Grey Lady inn.md", text: "An inn by the docks. Owner: [[Gunther Hoffmann]].\n\n## Connections\n\n- Located in [Altdorf](Altdorf.md): by the river 🔒\n" },
    { name: "Altdorf.md", text: "---\ntags: [city]\naliases: The Capital\n---\n# Altdorf\nThe capital.\n\n## 🔒 GM notes\n\nA cult sits under it.\n" },
  ];
  // Not notes: refused before anything is sent.
  const [bad] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import from Markdown…" }).click()]);
  await bad.setFiles([{ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(page.locator("#toast")).toHaveText("Pick Markdown (.md) files, or a zip of them");

  await pick(files);
  const dialog = page.getByRole("dialog", { name: "Import from Markdown" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".scabard-plan")).toContainText("3 Encyclopedia entries: 1 person, 2 with no Category");
  await expect(dialog.locator(".scabard-plan")).toContainText("3 connections");
  await dialog.getByRole("button", { name: "Import" }).click();
  const report = page.getByRole("dialog", { name: "Imported from Markdown" });
  await expect(report).toBeVisible({ timeout: 30_000 });
  const text = await report.locator(".kit-dialog-msg").textContent();
  expect(text).toContain("Entries: 1 added, 1 filled in, 1 kept as they were.");
  expect(text).toContain("3 connections and 3 tags added.");   // Gunther↔inn, inn→Altdorf, Gunther→Altdorf; innkeeper, grey, city
  await report.getByRole("button", { name: "OK" }).click();

  const enc = (await api(page, "encyclopedia", undefined, cid)).json;
  const by = n => enc.entries.find(e => e.name === n);
  const g = by("Gunther Hoffmann");
  expect(g).toMatchObject({ category: "person", aliases: ["Hoffmann", "the innkeeper"] });
  expect(g.tags.map(t => t.name).sort()).toEqual(["grey", "innkeeper"]);
  expect(g.notes).toContain("<strong>his</strong>");
  expect(by("Altdorf").notes).toBe("<p>Our own words.</p>");           // kept as it was
  expect(by("Altdorf").gm_notes).toBeFalsy();
  expect(by("Altdorf").tags.map(t => t.name)).toEqual(["city"]);       // but its tag is added
  expect(by("Grey Lady inn").notes).toContain("An inn by the docks.");  // filled in
  const between = (a, b) => enc.relations.filter(r => (r.from_id === by(a).id && r.to_id === by(b).id) || (r.from_id === by(b).id && r.to_id === by(a).id));
  expect(enc.relations).toHaveLength(3);
  expect(between("Grey Lady inn", "Gunther Hoffmann")).toHaveLength(1);   // linked from both ends, one connection
  const located = between("Grey Lady inn", "Altdorf");
  expect(located).toHaveLength(1);
  expect(located[0]).toMatchObject({ note: "by the river", is_secret: true });
  // "Located in" is the starter kind, written from the inn's end: the connection runs Altdorf → inn as "Contains" if that is how the kind reads
  const kind = enc.relation_types.find(t => t.id === located[0].type_id);
  expect([kind.label, kind.inverse_label]).toContain("Located in");
  expect(located[0].from_id).toBe(by(kind.label === "Located in" ? "Grey Lady inn" : "Altdorf").id);

  // Again: nothing doubles.
  await pick(files);
  await page.getByRole("dialog", { name: "Import from Markdown" }).getByRole("button", { name: "Import" }).click();
  const again = page.getByRole("dialog", { name: "Imported from Markdown" });
  await expect(again).toBeVisible({ timeout: 30_000 });
  expect(await again.locator(".kit-dialog-msg").textContent()).toContain("Entries: 0 added, 0 filled in, 3 kept as they were.");
  await again.getByRole("button", { name: "OK" }).click();
  const after = (await api(page, "encyclopedia", undefined, cid)).json;
  expect(after.entries).toHaveLength(enc.entries.length);
  expect(after.relations).toHaveLength(3);
  expectNoErrors(errors);
});

test("only a GM may import, and the batches are checked", async ({ page, browser }) => {
  const gm = person("Nia");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Markdown limits ${gm.id}`);
  expect((await api(page, "md_import", { entries: Array.from({ length: 201 }, (_, i) => ({ name: `E${i}` })) }, cid)).status).toBe(400);
  const ok = await api(page, "md_import", { entries: [{ name: "Solo", notes: "<p>Hi</p><script>x</script>", tags: ["a"] }, { name: "  " }, { name: "L".repeat(400) }] }, cid);
  expect(ok.status).toBe(200);
  expect(ok.json.entries.added).toBe(2);
  expect(ok.json.skipped.entries).toBe(1);
  const enc = (await api(page, "encyclopedia", undefined, cid)).json;
  expect(enc.entries.find(e => e.name === "Solo").notes).toBe("<p>Hi</p>");
  // a player is refused
  const playerPage = await (await newContext(browser)).newPage();
  const player = person("Pip");
  await signIn(playerPage, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  expect((await api(playerPage, "md_import", { entries: [{ name: "Nope" }] }, cid)).status).toBe(403);
});
