// Settings → Tools → Export the whole campaign: one zip with Markdown pages to read, campaign.json with every row and
// the pictures and files. GMs only; the members' accounts and where files are kept never leave the server.
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, mapWithPicture } = require("./helpers");
const Engine = require("../../static/engine.js");
const LoreExport = require("../../static/lore-export.js");
const CampaignExport = require("../../static/campaign-export.js");
test.afterEach(closeContexts);

/** The files of a zip written by LoreExport.zip (nothing compressed): path => bytes. */
function unzip(buf) {
  const out = new Map();
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), start = at + 30 + nameLen + buf.readUInt16LE(at + 28);
    out.set(buf.toString("utf8", at + 30, at + 30 + nameLen), buf.subarray(start, start + size));
    at = start + size;
  }
  return out;
}
const strip = html => String(html).replace(/<aside>([\s\S]*?)<\/aside>/g, "🔒 $1").replace(/<[^>]+>/g, "");

test("the pages are laid out from the rows: every kind of thing, GM-only marked, files once", () => {
  const cal = Engine.PRESETS[Object.keys(Engine.PRESETS)[0]].calendar;
  const data = {
    format: "campaign-chronicle", version: 1, campaign: { name: "Sartar", description: "Dragon Pass", calendar: cal, settings: {}, current_shift: 8 }, people: { 7: "Jo", 9: "Kai" },
    tables: {
      tags: [{ id: 1, name: "Battle" }],
      events: [{ id: 2, abs_day: 5, shift: 2, title: "Ambush", body: "At the ford", is_secret: 1 }, { id: 1, abs_day: 2, shift: null, end_day: 4, title: "Fair", body: "", is_secret: 0 }],
      event_tags: [{ event_id: 2, tag_id: 1 }],
      event_notes: [{ id: 1, event_id: 1, user_id: 9, body: "I won a pig" }],
      days: [{ abs_day: 2, notes: "<p>Arrived</p>", notes_format: "html", gm_notes: "Watched", gm_notes_format: "text", locations: "Apple Lane" }, { abs_day: 3, notes: null, gm_notes: null, locations: null }],
      shifts: [{ abs_day: 2, shift: 1, activity: "Haggle", gm_notes: "Rigged" }],
      shift_notes: [{ id: 1, abs_day: 2, shift: 1, user_id: 9, body: "Bought rope" }],
      encyclopedia_tag_names: [{ id: 1, name: "town" }],
      encyclopedia_entries: [{ id: 1, name: "Apple Lane", category: "location", aliases_json: "[\"The Lane\"]", notes: "<p>A hamlet</p><aside>Haunted</aside>", gm_notes: "<p>Cult</p>", is_secret: 0 },
        { id: 2, name: "Gringle", category: "person", notes: "", is_secret: 1 }],
      encyclopedia_tags: [{ entry_id: 1, tag_id: 1 }],
      encyclopedia_relation_types: [{ id: 1, label: "Lives in", inverse_label: "Home of", symmetric: 0 }],
      encyclopedia_relations: [{ id: 1, from_id: 2, to_id: 1, type_id: 1, note: "above the shop", is_secret: 0 }],
      play_sessions: [{ id: 1, number: 1, title: "The Pawnshop", played_on: "2026-11-01", first_day: 2, last_day: 3, summary: "<p>They held it</p>", summary_format: "html", rewards: "<p>10 L</p>", loot: "", is_published: 1 }],
      session_notes: [{ id: 2, session_id: 1, position: 2, depth: 1, text: "Baboons" }, { id: 1, session_id: 1, position: 1, depth: 0, text: "Night attack" }],
      library_tomes: [{ id: 1, kind: "rich", title: "Cults: of/Prax?", description: "A book", body: "<p>Storm Bull</p>" }],
      holdings: [{ id: 1, name: "The Pawnshop", kind: "property", type_name: "Shop", location: "Apple Lane", description: "Ours now", amount: 1 }],
      holding_storage: [{ id: 1, holding_id: 1, item: "Crystal", weight: "1.50" }],
      party_funds: [{ id: 1, currency: "Lunars", amount: "120.00", location: "Chest" }],
      party_gear: [{ id: 1, item: "Rope", amount: 2, claimed_by: "Kai", location: "" }],
      party_groups: [{ id: 1, name: "The party", is_main: 1 }],
      reminders: [{ id: 1, due_shift: 20, title: "Pay Gringle", body: "50 L", audience: "gm" }],
      clocks: [{ id: 1, name: "The cult rises", description: "", segments: 6, filled: 2, visibility: "secret", by_gm: 1, entry_id: 1, archived: 0 }],
      downtimes: [{ id: 1, kind: "long", title: "A week off", start_shift: 12, end_shift: 40, activities_json: "[]", notes: "Rested", gm_notes: "" }],
      sheet_characters: [{ id: 1, entry_id: 2, kind: "npc", owner_id: null, field_values: "{}" }],
      maps: [{ id: 1, name: "Apple Lane map", image_id: 11, width: 300, height: 200, scale_per_px: 0.5, scale_unit: "m", is_secret: 0 }],
      map_pins: [{ id: 1, map_id: 1, kind: "entry", entry_id: 1, label: "", note: "The crossroads", is_secret: 1 }],
      map_routes: [{ id: 1, map_id: 1, name: "North road", is_secret: 0 }],
      attachments: [{ id: 10, parent_type: "encyclopedia", parent_id: 1, kind: "image", original_name: "lane.png", mime: "image/png", caption: "The lane", credit_title: "Lane", credit_author: "Ann", credit_license: "CC0" },
        { id: 11, parent_type: "map", parent_id: 1, kind: "image", original_name: "lane.png", mime: "image/png" },
        { id: 12, parent_type: "encyclopedia", parent_id: 1, kind: "embed", embed_url: "https://example.com/art" }],
    },
  };
  const r = CampaignExport.build(data, { Engine, LoreExport, toMarkdown: strip, date: "2026-11-10" });
  const file = p => { const f = r.files.find(x => x.path === p); expect(f, p).toBeTruthy(); return f.data; };
  expect(r.fetch).toEqual([{ path: "files/10 lane.png", id: 10, name: "lane.png" }, { path: "files/11 lane.png", id: 11, name: "lane.png" }]);   // an embed is a link, not a file
  expect(JSON.parse(file("campaign.json"))).toEqual(data);

  const readme = file("README.md");
  for (const s of ["# Sartar", "Dragon Pass", "Encyclopedia entries: 2, in [Encyclopedia/Encyclopedia](Encyclopedia/Encyclopedia.md)", "Sessions: 1, in the `Sessions` folder", "Pictures and files: 2", "marked 🔒"]) expect(readme).toContain(s);

  // the Encyclopedia is the Encyclopedia tab's own export, a folder down, with its pictures in files/
  const lane = file("Encyclopedia/Apple Lane.md");
  for (const s of ["# Apple Lane", "Location", "Also called The Lane", "Tags: town", "![The lane](../files/10%20lane.png)", "Lane by Ann, CC0", "A hamlet", "🔒 Haunted", "## 🔒 GM notes", "Cult", "- Home of [Gringle](Gringle.md): above the shop", "(https://example.com/art)"]) expect(lane).toContain(s);
  expect(file("Encyclopedia/Gringle.md")).toContain("- Lives in [Apple Lane](Apple%20Lane.md): above the shop");
  expect(file("Encyclopedia/Gringle.md")).toContain("🔒 GM only");

  const events = file("Events.md");
  expect(events.indexOf("### Fair")).toBeLessThan(events.indexOf("### Ambush 🔒"));   // oldest first
  for (const s of [`## ${Engine.fmtDate(cal, 2)}`, `until ${Engine.fmtDate(cal, 4)}`, "- **Kai:** I won a pig", "Tags: Battle", "At the ford", Engine.shiftNames(cal)[2]]) expect(events).toContain(s);

  const notes = file("Calendar notes.md");
  for (const s of ["**Where:** Apple Lane", "### Public notes", "Arrived", "### Secret notes 🔒", "Watched", `### ${Engine.shiftNames(cal)[1]}`, "**Activity:** Haggle", "**GM notes 🔒:** Rigged", "- **Kai:** Bought rope"]) expect(notes).toContain(s);
  expect(notes).not.toContain(Engine.fmtDate(cal, 3));   // a day with nothing written is left out

  const session = file("Sessions/001 The Pawnshop.md");
  for (const s of ["# Session 1: The Pawnshop", "Played on 2026-11-01", "Published", "## Summary", "They held it", "## Session Rewards", "10 L", "- Night attack\n  - Baboons"]) expect(session).toContain(s);
  expect(session).not.toContain("## Loot Found");

  expect(file("Library/Cults of Prax.md")).toContain("Storm Bull");   // a name no system refuses
  for (const s of ["- The party (main group)", "### The Pawnshop", "Shop · at Apple Lane", "| Crystal | 1.5 |", "| Lunars | 120 | Chest |", "| Rope | 2 | Kai |  |"]) expect(file("Party.md")).toContain(s);
  expect(file("Characters.md")).toContain("| Gringle | NPC |  |");
  expect(file("Reminders.md")).toContain(`- **Pay Gringle** 🔒, due ${Engine.fmtShift(cal, 20)}: 50 L`);
  expect(file("Clocks.md")).toContain("- **The cult rises** (2 of 6, Secret 🔒, about Apple Lane)");
  for (const s of ["## A week off", `${Engine.fmtShift(cal, 12)} to ${Engine.fmtShift(cal, 40)}`, "Rested"]) expect(file("Downtime.md")).toContain(s);
  for (const s of ["## Apple Lane map", "![Apple Lane map](files/11%20lane.png)", "300 × 200 px · 1 px = 0.5 m", "- Apple Lane 🔒: The crossroads", "- North road"]) expect(file("Maps.md")).toContain(s);

  // an empty campaign still gives a front page and its rows
  const empty = CampaignExport.build({ campaign: { name: "New", calendar: cal, current_shift: 0 }, people: {}, tables: {} }, { Engine, LoreExport, toMarkdown: strip, date: "2026-11-10" });
  expect(empty.files.map(f => f.path)).toEqual(["README.md", "campaign.json"]);
});

test("a GM downloads the whole campaign as a zip; a player can't", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Jo"), player = person("Kai");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Whole ${gm.id}`);
  const other = await makeCampaign(page, `Other ${gm.id}`);
  expect((await api(page, "entry_save", { name: "Not ours", notes: "<p>Elsewhere</p>" }, other)).status).toBe(200);
  expect((await api(page, "entry_save", { name: "Apple Lane", notes: "<p>A hamlet</p><aside>Haunted</aside>", gm_notes: "<p>Cult</p>" }, cid)).status).toBe(200);
  expect((await api(page, "entry_save", { name: "Gringle", is_secret: true }, cid)).status).toBe(200);
  expect((await api(page, "event_save", { abs_day: 2, shift: 1, title: "Market day", body: "Stalls" }, cid)).status).toBe(200);
  expect((await api(page, "event_save", { abs_day: 2, title: "Hidden ambush", is_secret: true }, cid)).status).toBe(200);
  expect((await api(page, "day_update", { abs_day: 2, notes: "Reached town", gm_notes: "Bandits watch" }, cid)).status).toBe(200);
  await mapWithPicture(page, cid);

  // the rows: this campaign's only, with people named and nothing about accounts or the disk
  const res = await api(page, "campaign_export", undefined, cid);
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ format: "campaign-chronicle", version: 1, campaign: { name: `Whole ${gm.id}` } });
  expect(res.json.tables.encyclopedia_entries.map(e => e.name).sort()).toEqual(["Apple Lane", "Gringle"]);
  expect(res.json.tables.events.map(e => e.title).sort()).toEqual(["Hidden ambush", "Market day"]);
  expect(res.json.tables.attachments).toHaveLength(1);
  expect(Object.values(res.json.people)).toEqual([expect.any(String)]);
  const raw = JSON.stringify(res.json);
  for (const s of ["stored_name", "campaign_id", gm.email, "Not ours"]) expect(raw).not.toContain(s);
  expect(res.json.campaign.calendar.months.length).toBeGreaterThan(0);

  // the button
  await page.goto(`index.html#/c/${cid}/settings/tools`);
  await page.getByRole("button", { name: "Export the whole campaign…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export the whole campaign" });
  await expect(dialog.getByLabel("Include the pictures and files (a bigger download)")).toBeChecked();
  const [dl] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^Whole .* \(Campaign Chronicle \d{4}-\d\d-\d\d\)\.zip$/);
  const zip = unzip(fs.readFileSync(await dl.path()));
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast")).toHaveText("Exported");
  const text = p => { expect([...zip.keys()]).toContain(p); return zip.get(p).toString("utf8"); };
  expect(text("README.md")).toContain("Encyclopedia entries: 2");
  for (const s of ["A hamlet", "Haunted", "## 🔒 GM notes", "Cult"]) expect(text("Encyclopedia/Apple Lane.md")).toContain(s);
  expect(text("Encyclopedia/Gringle.md")).toContain("🔒 GM only");
  for (const s of ["### Market day", "Stalls", "### Hidden ambush 🔒"]) expect(text("Events.md")).toContain(s);
  for (const s of ["Reached town", "### Secret notes 🔒", "Bandits watch"]) expect(text("Calendar notes.md")).toContain(s);
  expect(text("Maps.md")).toContain("## Sartar");
  expect(JSON.parse(text("campaign.json")).tables.maps).toHaveLength(1);
  const pic = [...zip.keys()].filter(k => k.startsWith("files/"));
  expect(pic).toHaveLength(1);
  expect(zip.get(pic[0]).subarray(1, 4).toString()).toBe("PNG");
  expect(text("Maps.md")).toContain(`(${pic[0].split("/").map(encodeURIComponent).join("/")})`);

  // without the files
  await page.getByRole("button", { name: "Export the whole campaign…" }).click();
  await dialog.getByLabel("Include the pictures and files (a bigger download)").uncheck();
  const [dl2] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download" }).click()]);
  const zip2 = unzip(fs.readFileSync(await dl2.path()));
  expect([...zip2.keys()].filter(k => k.startsWith("files/"))).toEqual([]);
  expect([...zip2.keys()]).toContain("campaign.json");

  // a player, and a GM of another campaign, are refused
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  expect((await api(pp, "campaign_export", undefined, cid)).status).toBe(403);
  await pp.goto(`index.html#/c/${cid}/settings`);
  await expect(pp.getByRole("button", { name: "Export the whole campaign…" })).toHaveCount(0);
  expectNoErrors(errors);
});
