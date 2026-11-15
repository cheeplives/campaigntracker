// The Encyclopedia's Export button (Markdown or a Foundry journal, as a zip with the pictures), Copy as handout on an
// entry, and the calendar for Foundry's Seasons & Stars on the Settings tab. A player's export holds only what that
// player can see, and a GM's leaves out GM-only things unless asked.
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, pressMore } = require("./helpers");
test.afterEach(closeContexts);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");

/** The files in a zip, by name, read from its central directory. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const out = {};
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const size = buf.readUInt32LE(at + 24), nameLen = buf.readUInt16LE(at + 28), local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[buf.subarray(at + 46, at + 46 + nameLen).toString("utf8")] = buf.subarray(start, start + size);
    at += 46 + nameLen;
  }
  return out;
}
async function exportZip(page, { format, gmOnly } = {}) {
  await pressMore(page, "Encyclopedia", "Export…");
  const d = page.getByRole("dialog", { name: "Export the Encyclopedia" });
  if (format) await d.getByLabel("Format").selectOption(format);
  if (gmOnly) await d.getByLabel(/Include GM-only/).check();
  const [dl] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download" }).click()]);
  await expect(d).toHaveCount(0);
  return { name: dl.suggestedFilename(), files: unzip(fs.readFileSync(await dl.path())) };
}

async function campaign(page, browser) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Reik ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const save = async body => (await api(page, "entry_save", body, cid)).json.id;
  const altdorf = await save({ name: "Altdorf", category: "location", notes: "<p>Seat of the <strong>Emperor</strong>.</p><aside>The cult meets here.</aside>", gm_notes: "<p>Plague in spring</p>" });
  const gunther = await save({ name: "Gunther", category: "person", notes: "<p>Makes swords.</p>" });
  const cult = await save({ name: "Cult of Change", notes: "<p>Very secret.</p>", is_secret: true });
  expect((await api(page, "relations_save", { entry_id: gunther, type: { label: "Resident of", inverse_label: "Has resident" }, side: "from", add: [altdorf] }, cid)).status).toBe(200);
  expect((await api(page, "relations_save", { entry_id: cult, type: { label: "Hides in", inverse_label: "Hides" }, side: "from", add: [altdorf] }, cid)).status).toBe(200);
  const me = await (await page.request.get("api/auth/me.php")).json();
  const up = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, { headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "encyclopedia", parent_id: String(altdorf), caption: "City map", file: { name: "map.png", mimeType: "image/png", buffer: PNG } } });
  expect(up.status()).toBe(200);
  return { cid, pp, altdorf, gunther };
}

test("the Encyclopedia exports as linked Markdown pages with their pictures, and a player's holds only what they can see", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await campaign(page, browser);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  let { name, files } = await exportZip(page);
  expect(name).toMatch(/^Reik .* Encyclopedia\.zip$/);
  expect(Object.keys(files).sort()).toEqual(["Altdorf.md", "Encyclopedia.md", "Gunther.md", "pictures/Altdorf City map.png"]);
  expect(files["pictures/Altdorf City map.png"].equals(PNG)).toBe(true);
  const alt = files["Altdorf.md"].toString("utf8");
  expect(alt).toContain("# Altdorf");
  expect(alt).toContain("Seat of the **Emperor**.");
  expect(alt).toContain("![City map](pictures/Altdorf%20City%20map.png)");
  expect(alt).toContain("- Has resident [Gunther](Gunther.md)");
  for (const secret of ["cult", "Plague", "Hides"]) expect(alt).not.toContain(secret);

  // with GM-only things ticked: the secret entry, the paragraph, the GM notes and the connection come too
  ({ files } = await exportZip(page, { gmOnly: true }));
  expect(Object.keys(files)).toContain("Cult of Change.md");
  const gmAlt = files["Altdorf.md"].toString("utf8");
  for (const secret of ["The cult meets here", "## 🔒 GM notes", "Plague in spring", "Hides [Cult of Change](Cult%20of%20Change.md)"]) expect(gmAlt).toContain(secret);

  // a player never had them, so has no box to tick
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/encyclopedia`);
  await pressMore(pp, "Encyclopedia", "Export…");
  await expect(pp.getByRole("dialog").getByLabel(/Include GM-only/)).toHaveCount(0);
  await pp.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  ({ files } = await exportZip(pp));
  expect(Object.keys(files)).not.toContain("Cult of Change.md");
  expect(JSON.stringify(Object.values(files).map(b => b.toString("utf8")))).not.toMatch(/cult meets|Plague|Hides/);
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("the Foundry export is a journal with a page per entry, linked, and the pictures under the folder it names", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await campaign(page, browser);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  const { name, files } = await exportZip(page, { format: "foundry", gmOnly: true });
  expect(name).toMatch(/Encyclopedia for Foundry\.zip$/);
  const json = Object.keys(files).find(f => f.endsWith(".json"));
  expect(json).toMatch(/Encyclopedia \(Foundry journal\)\.json$/);
  const j = JSON.parse(files[json].toString("utf8"));
  expect(j.pages.map(p => p.name).sort()).toEqual(["Altdorf", "Altdorf (GM notes)", "Cult of Change", "Gunther"]);
  const pic = Object.keys(files).find(f => f.endsWith(".png"));
  expect(pic).toMatch(/^chronicle\/reik-[^/]+\/pictures\/Altdorf City map\.png$/);
  const alt = j.pages.find(p => p.name === "Altdorf");
  expect(alt.text.content).toContain(`<img src="${pic}"`);
  expect(alt.text.content).toContain(`@UUID[.${j.pages.find(p => p.name === "Gunther")._id}]{Gunther}`);
  expect(alt.text.content).toMatch(/<section class="secret" id="secret-\w{16}">/);
  expect(j.pages.find(p => p.name === "Cult of Change").ownership).toEqual({ default: 0 });
  expectNoErrors(errors);
});

test("Copy as handout puts the entry, formatted, on the clipboard without its GM-only paragraph", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, altdorf } = await campaign(page, browser);
  // the clipboard as the page hands it over (reading the real one needs permissions only Chromium grants to tests)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async ([item]) => {
      window.copied = { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
    } } });
  });
  await page.goto(`index.html#/c/${cid}/encyclopedia/${altdorf}`);
  await page.locator(".enc-detail").getByLabel(/^More for /).click();   // Copy as handout waits in the entry's ⋯ menu
  await page.getByRole("button", { name: "Copy as handout" }).click();
  await expect(page.getByText("Copied. Paste it into a handout or a note")).toBeVisible();
  const got = await page.evaluate(() => window.copied);
  expect(got.html).toContain("<h2>Altdorf</h2>");
  expect(got.html).toContain("<strong>Emperor</strong>");
  expect(got.html).toContain("Has resident Gunther");
  expect(got.html).not.toMatch(/cult|Plague|Hides/);
  expect(got.text).toContain("# Altdorf");
  expectNoErrors(errors);
});

test("Settings downloads the calendar for Seasons & Stars and says what date to set", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Calendar ${gm.id}`);
  const camp = (await api(page, "campaign", undefined, cid)).json.campaign;
  await page.goto(`index.html#/c/${cid}/settings/tools`);
  await page.getByRole("button", { name: "For Foundry…" }).click();
  const d = page.getByRole("dialog", { name: "Calendar for Foundry" });
  await expect(d).toContainText("Then set Foundry's date to");
  const [dl] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/-seasons-and-stars\.json$/);
  const cal = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  expect(cal.id).toMatch(/^chronicle-/);
  expect(cal.months.map(m => m.name)).toEqual(camp.calendar.months.filter(m => !m.intercalary).map(m => m.name));
  expect(cal.weekdays.length).toBeGreaterThan(0);
  expectNoErrors(errors);
});

// ---------------------------------------------------------------- Roll20
// Roll20 itself can't run here: the Mod script (static/vtt/roll20-almanac-import.js) runs under Node against a stand-in
// for the handful of Roll20 calls it makes.
const vm = require("vm"), path = require("path");
function roll20Game() {
  const objs = new Map(), chat = [], ready = [], handlers = {};
  let n = 0;
  const handout = props => {
    const o = { id: `-H${++n}`, props: { ...props }, async: {},
      get(k, cb) { if (cb) cb(o.async[k] || ""); else return o.props[k]; },
      set(k, v) { if (typeof k === "object") Object.assign(o.props, k); else if (k === "notes" || k === "gmnotes") o.async[k] = v; else o.props[k] = v; } };
    objs.set(o.id, o);
    return o;
  };
  const ctx = { state: {}, log() {}, setTimeout: fn => fn(),
    on(ev, fn) { if (ev === "ready") ready.push(fn); else handlers[ev] = fn; },
    findObjs: q => [...objs.values()].filter(o => o.props.name === q.name),
    getObj: (t, id) => objs.get(id), createObj: (t, props) => handout(props),
    sendChat: (who, text) => chat.push(text), playerIsGM: id => id === "gm" };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "static", "vtt", "roll20-almanac-import.js"), "utf8"), ctx);
  ready.forEach(f => f());
  return { objs, chat, handout, say: (content, playerid = "gm") => handlers["chat:message"]({ type: "api", content, playerid, who: "Someone" }),
    named: name => [...objs.values()].filter(o => o.props.name === name) };
}

test("the Encyclopedia exports for Roll20, and the Mod script makes linked handouts of it, GM-only things kept from players", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "the file is the same whatever the browser");
  const errors = watchErrors(page);
  const { cid } = await campaign(page, browser);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  const get = async gmOnly => {
    await pressMore(page, "Encyclopedia", "Export…");
    const d = page.getByRole("dialog", { name: "Export the Encyclopedia" });
    await d.getByLabel("Format").selectOption("roll20");
    await expect(d.getByRole("link", { name: "GM's Almanac Import script" })).toHaveAttribute("href", "static/vtt/roll20-almanac-import.js");
    if (gmOnly) await d.getByLabel(/Include GM-only/).check();
    const [dl] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download" }).click()]);
    await expect(d).toHaveCount(0);
    expect(dl.suggestedFilename()).toMatch(/Encyclopedia for Roll20\.txt$/);
    return fs.readFileSync(await dl.path(), "utf8");
  };
  expect((await page.request.get("static/vtt/roll20-almanac-import.js")).status()).toBe(200);

  // without GM-only things: nothing secret is in the file at all
  const open = await get(false);
  expect(open).toMatch(/^ALMANAC1:[A-Za-z0-9+/=]+\n$/);
  const plain = Buffer.from(open.trim().slice(9), "base64").toString("utf8");
  for (const s of ["Cult of Change", "The cult meets here", "Plague in spring"]) expect(plain, s).not.toContain(s);

  // with them, pasted into a handout the way Roll20's editor leaves it (wrapped in tags, broken over lines)
  const full = (await get(true)).trim();
  const game = roll20Game();
  game.say("!almanac import");
  expect(game.chat.pop()).toContain('There is no handout named "Almanac Import"');
  game.say("!almanac import", "player");
  expect(game.chat.pop()).toContain("Only the GM");
  const src = game.handout({ name: "Almanac Import" });
  src.async.gmnotes = "<p>not it</p>";
  game.say("!almanac import");
  expect(game.chat.pop()).toContain("doesn't hold a GM's Almanac export");
  src.async.gmnotes = `<p>${full.slice(0, 80)}</p>\n<p>${full.slice(80, 400)}<br>${full.slice(400)}&nbsp;</p>`;
  game.say("!almanac import");
  expect(game.chat.pop()).toContain("Done: 3 new handouts, 0 updated.");

  const [altdorf] = game.named("Altdorf"), [gunther] = game.named("Gunther"), [cult] = game.named("Cult of Change");
  expect(altdorf.props.inplayerjournals).toBe("all");
  expect(cult.props.inplayerjournals).toBe("");
  // players read the notes; the GM-only paragraph, the GM notes and the link to the secret entry are in GM Notes only
  expect(altdorf.async.notes).toContain("Seat of the <strong>Emperor</strong>.");
  expect(altdorf.async.notes).toContain(`Has resident <a href="http://journal.roll20.net/handout/${gunther.id}">Gunther</a>`);
  for (const s of ["The cult meets here", "Plague in spring", "Cult of Change", cult.id]) expect(altdorf.async.notes, s).not.toContain(s);
  expect(altdorf.async.gmnotes).toContain("The cult meets here");
  expect(altdorf.async.gmnotes).toContain("Plague in spring");
  expect(altdorf.async.gmnotes).toContain(`<a href="http://journal.roll20.net/handout/${cult.id}">Cult of Change</a>`);
  expect(gunther.async.notes).toContain(`Resident of <a href="http://journal.roll20.net/handout/${altdorf.id}">Altdorf</a>`);

  // again: the same handouts are updated, not doubled; --hidden keeps all of them from players; forget starts afresh
  game.say("!almanac import --hidden");
  expect(game.chat.pop()).toContain("Done: 0 new handouts, 3 updated.");
  expect(game.named("Altdorf")).toHaveLength(1);
  expect(altdorf.props.inplayerjournals).toBe("");
  game.say("!almanac forget");
  game.say("!almanac import Almanac Import");
  expect(game.chat.pop()).toContain("Done: 3 new handouts, 0 updated.");
  expect(game.named("Altdorf")).toHaveLength(2);
  game.say("!almanac");
  expect(game.chat.pop()).toContain("!almanac import");
  await expectNoErrors(errors);
});
