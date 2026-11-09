// The Characters tab, a character's sheet and its Play view: making a character, filling it in and finding it again,
// hiding a section from the party, quick taps at the table, NPC sheets the players don't see, handing a sheet to
// another player, and two people on one sheet (each named in the other's bar, the GM pressing Edit first, and a
// change showing up on the other open sheet at the next check).
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts, makePng, moreIn } = require("./helpers");
test.afterEach(closeContexts);

const LAYOUT = () => ({ sections: [
  { key: "stats", title: "Stats", fields: [{ key: "str", label: "Strength", type: "number" }, { key: "hp", label: "HP", type: "counter", play: true },
    { key: "luck", label: "Luck", type: "pips", count: 3, play: true }] },
  { key: "background", title: "Background", fields: [{ key: "past", label: "Past", type: "longtext" }] },
] });

/** A GM (Gail) and two players (Pip, Quin) in one campaign, with a template. */
async function party(page, browser) {
  const gm = person("Gail"), p1 = person("Pip"), p2 = person("Quin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Characters ${gm.id}`);
  const pages = {};
  // The service worker would see the players' requests first, and in WebKit page.route() then never fakes them.
  for (const [k, who] of [["p1", p1], ["p2", p2]]) {
    pages[k] = await (await newContext(browser, { serviceWorkers: "block" })).newPage();
    await signIn(pages[k], who);
    await approve(browser, who.email);
    expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
  }
  const tpl = (await api(page, "template_save", { name: `Party sheet ${gm.id}`, game: "Test RPG", layout: LAYOUT() })).json.template;
  const ids = {};
  for (const [k, p] of [["gm", page], ["p1", pages.p1], ["p2", pages.p2]]) ids[k] = (await (await p.request.get("api/auth/me.php")).json()).id;
  return { cid, gm: page, p1: pages.p1, p2: pages.p2, tpl, ids };
}
const make = async (p, cid, body) => (await api(p, "character_create", body, cid)).json.character;
/** A field's saved value, or null while it has none (mysql prints a missing one as NULL). */
const stored = (id, key) => {
  const out = sql(`SELECT JSON_EXTRACT(field_values, '$.${key}') FROM sheet_characters WHERE id=${id}`).trim();
  return out === "" || out === "NULL" ? null : JSON.parse(out);
};
const presenceChecked = p => p.waitForResponse(r => r.url().includes("a=character_presence"));
/** The GM has pressed Edit on character id (through the API). */
const gmEditing = (gm, cid, id) => api(gm, "character_presence", { id, editing: true, since: null }, cid);

test("Characters: a player makes one, fills it in, finds it again, and hides a section", async ({ page, browser }) => {
  const { cid, p1, p2, tpl } = await party(page, browser);
  await p1.goto(`index.html#/c/${cid}/characters`);
  // Sheet templates is in the top bar, so the Characters header keeps to + New character
  await expect(p1.locator("main").getByRole("link", { name: "Sheet templates" })).toHaveCount(0);
  await p1.getByRole("button", { name: "+ New character" }).click();
  await p1.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await p1.getByLabel("Character name").fill("Brannoc");
  await p1.getByRole("button", { name: "Make character" }).click();
  await expect(p1).toHaveURL(/#\/c\/\d+\/characters\/\d+$/);
  const id = Number(p1.url().match(/characters\/(\d+)$/)[1]);
  await expect(p1.getByRole("heading", { name: "Brannoc" })).toBeVisible();
  await expect(p1.locator(".sheet-page")).not.toContainText("null");

  await p1.getByLabel("Strength", { exact: true }).fill("14");
  await p1.getByLabel("Past", { exact: true }).fill("Raised by wolves");
  await p1.getByLabel("Strength", { exact: true }).focus(); // leaving Past sends it
  await expect.poll(() => stored(id, "past")).toBe("Raised by wolves");
  await expect.poll(() => stored(id, "str")).toBe(14);
  await p1.reload();
  await expect(p1.getByLabel("Strength", { exact: true })).toHaveValue("14");
  await expect(p1.getByLabel("Past", { exact: true })).toHaveValue("Raised by wolves");

  await p1.getByRole("button", { name: "Hide the Background section from the party" }).click();
  await expect(p1.getByRole("button", { name: "Show the Background section to the party" })).toBeVisible();
  await p2.goto(`index.html#/c/${cid}/characters/${id}`);
  await expect(p2.getByLabel("Strength", { exact: true })).toHaveValue("14");
  await expect(p2.getByLabel("Strength", { exact: true })).toBeDisabled();
  await expect(p2.getByText("Background")).toHaveCount(0);
  await expect(p2.locator("body")).not.toContainText("wolves");
});

test("Characters: quick taps on the Play view end on the last one, on screen and saved", async ({ page, browser }) => {
  const { cid, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Tapper" });
  await api(p1, "character_field", { id: c.id, key: "hp", value: { cur: 10, max: 20 } }, cid);
  // answers come back slowly, the first slowest
  let n = 0;
  await p1.route("**/api/index.php?a=character_field*", async route => {
    const wait = Math.max(50, 600 - 120 * n++);
    const res = await route.fetch(), body = await res.body();
    await new Promise(r => setTimeout(r, wait));
    await route.fulfill({ response: res, body });
  });
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}/play`);
  const plus = p1.getByRole("button", { name: "HP up one" });
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("10 / 20");
  for (let i = 0; i < 5; i++) await plus.click();
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("15 / 20");
  await expect.poll(() => stored(c.id, "hp"), { timeout: 15000 }).toEqual({ cur: 15, max: 20 });
  await p1.waitForTimeout(800);
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("15 / 20");
  await p1.getByRole("button", { name: "Luck 2" }).click();
  await expect.poll(() => stored(c.id, "luck")).toBe(2);
});

test("Characters: a player sees an NPC's card, but not its sheet", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const npc = await make(gm, cid, { template_id: tpl.id, name: "Old Mag", kind: "npc" });
  await api(gm, "character_field", { id: npc.id, key: "hp", value: { cur: 3, max: 9 } }, cid);
  await p1.goto(`index.html#/c/${cid}/characters`);
  const card = p1.locator(".character-card", { hasText: "Old Mag" });
  await expect(card).toContainText("NPC");
  await expect(card).not.toContainText("HP");
  await p1.getByRole("button", { name: "PCs", exact: true }).click();
  await expect(card).toHaveCount(0);
  await p1.goto(`index.html#/c/${cid}/characters/${npc.id}`);
  await expect(p1.getByText("The GM hasn't shown this sheet to players.")).toBeVisible();
  await expect(p1.getByLabel("Strength", { exact: true })).toHaveCount(0);
});

test("Characters: the GM hands a sheet to another player", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl, ids } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Passed On" });
  await gm.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await gm.getByLabel("Whose sheet").selectOption(String(ids.p2));
  await expect.poll(() => Number(sql(`SELECT owner_id FROM sheet_characters WHERE id=${c.id}`).trim())).toBe(ids.p2);
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p2.getByLabel("Strength", { exact: true })).toBeEnabled();
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p1.getByLabel("Strength", { exact: true })).toBeDisabled();
});

test("Characters: the player and the GM on one sheet see each other, and the GM presses Edit first", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Watched" });
  await p1.clock.install();
  await gm.clock.install();
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p1.getByLabel("Strength", { exact: true })).toBeEnabled();
  await gm.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(gm.locator(".sheet-viewers")).toContainText("Watched is also looking at this sheet");   // Pip, by their first PC's name
  await expect(gm.getByLabel("Strength", { exact: true })).toBeDisabled();

  let checked = presenceChecked(p1);
  await p1.clock.fastForward(16000);
  await checked;
  await expect(p1.locator(".sheet-viewers")).toContainText("Gail (GM) is also looking at this sheet");

  await gm.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(gm.getByLabel("Strength", { exact: true })).toBeEnabled();
  await gm.getByLabel("Strength", { exact: true }).fill("9");
  await gm.getByLabel("Strength", { exact: true }).press("Tab");
  await expect.poll(() => stored(c.id, "str")).toBe(9);

  checked = presenceChecked(p1);
  await p1.clock.fastForward(16000);
  await checked;
  await expect(p1.locator(".sheet-viewers")).toContainText("Gail (GM) is editing this sheet");
  await expect(p1.getByLabel("Strength", { exact: true })).toHaveValue("9");

  await gm.getByRole("button", { name: "Done", exact: true }).click();
  await expect(gm.getByLabel("Strength", { exact: true })).toBeDisabled();
});

test("Characters: a save that fails puts the sheet back as the server has it", async ({ page, browser }) => {
  const { cid, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Unlucky" });
  await api(p1, "character_field", { id: c.id, key: "hp", value: { cur: 10, max: 20 } }, cid);
  await p1.route("**/api/index.php?a=character_field*", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "server", message: "Database error" }) }));
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}/play`);
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("10 / 20");
  await p1.getByRole("button", { name: "HP up one" }).click();
  await expect(p1.locator("#toast")).toContainText("Database error");
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("10 / 20");
});

test("Characters: someone else's change doesn't overwrite a tap still being saved", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Slow" });
  await api(p1, "character_field", { id: c.id, key: "hp", value: { cur: 10, max: 20 } }, cid);
  await p1.clock.install();
  const first = presenceChecked(p1);
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}/play`);
  await first;
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("10 / 20");
  await gmEditing(gm, cid, c.id);
  expect((await api(gm, "character_field", { id: c.id, key: "hp", value: { cur: 5, max: 20 } }, cid)).status).toBe(200);
  let release;
  const held = new Promise(r => (release = r));
  await p1.route("**/api/index.php?a=character_field*", async route => { await held; await route.continue(); });
  await p1.getByRole("button", { name: "HP up one" }).click();   // 11, on its way
  const checked = presenceChecked(p1);
  await p1.clock.fastForward(16000);
  await checked;
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("11 / 20");
  release();
  await expect.poll(() => stored(c.id, "hp")).toEqual({ cur: 11, max: 20 });
  await expect(p1.locator(".play-counter", { hasText: "HP" })).toContainText("11 / 20");
});

test("Characters: Use theirs keeps the other person's value, on screen and saved", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Torn" });
  await p1.clock.install();
  const first = presenceChecked(p1);
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await first;
  const str = p1.getByLabel("Strength", { exact: true });
  await expect(str).toBeEnabled();
  // they type 12 and pause (it saves), still in the box, when the GM changes it to 9
  await str.fill("12");
  await p1.clock.runFor(500);
  await expect.poll(() => stored(c.id, "str")).toBe(12);
  await gmEditing(gm, cid, c.id);
  expect((await api(gm, "character_field", { id: c.id, key: "str", value: 9 }, cid)).status).toBe(200);
  await expect(str).toBeFocused();
  const checked = presenceChecked(p1);
  await p1.clock.runFor(16000);
  await checked;
  await expect(p1.getByText("Changed by Gail")).toBeVisible();
  await p1.getByRole("button", { name: "Use theirs" }).click();
  await expect(str).toHaveValue("9");
  await p1.clock.runFor(1000);
  // what was typed is sent first, on leaving the box, and theirs after it: wait for the last to land
  await expect.poll(() => stored(c.id, "str")).toBe(9);
});

test("Characters: a GM whose Edit ran out is put back to reading, and stops showing as editing", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Lapsed" });
  await gm.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await gm.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(gm.getByLabel("Strength", { exact: true })).toBeEnabled();
  await expect.poll(() => sql(`SELECT editing FROM sheet_presence WHERE character_id=${c.id} AND user_id=${ids.gm}`).trim()).toBe("1");
  sql(`DELETE FROM sheet_presence WHERE character_id=${c.id}`);   // as if the page slept past the 40 seconds
  await gm.getByLabel("Strength", { exact: true }).fill("3");
  await gm.getByLabel("Strength", { exact: true }).press("Tab");
  await expect(gm.locator("#toast")).toContainText("Press Edit first");
  await expect(gm.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(gm.getByLabel("Strength", { exact: true })).toBeDisabled();
  await expect.poll(() => sql(`SELECT editing FROM sheet_presence WHERE character_id=${c.id} AND user_id=${ids.gm}`).trim()).toBe("0");
});

test("Characters: the player deletes a character from its sheet; its Encyclopedia entry stays", async ({ page, browser }) => {
  const { cid, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Doomed" });
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p2.getByRole("heading", { name: "Doomed" })).toBeVisible();
  await expect(p2.getByRole("button", { name: "Delete character" })).toHaveCount(0);

  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await moreIn(p1.locator(".sheet-head"), "Delete character");
  await p1.getByRole("button", { name: "Cancel" }).click();
  expect(sql(`SELECT COUNT(*) FROM sheet_characters WHERE id=${c.id}`).trim()).toBe("1");
  await moreIn(p1.locator(".sheet-head"), "Delete character");
  await p1.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(p1).toHaveURL(new RegExp(`#/c/${cid}/characters$`));
  await expect(p1.locator(".character-card", { hasText: "Doomed" })).toHaveCount(0);
  expect(sql(`SELECT COUNT(*) FROM sheet_characters WHERE id=${c.id}`).trim()).toBe("0");
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_entries WHERE id=${c.entry_id}`).trim()).toBe("1");
});

test("Characters: a GM deletes a player's character from its sheet", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Removed" });
  await gm.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await moreIn(gm.locator(".sheet-head"), "Delete character");
  await gm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(gm).toHaveURL(new RegExp(`#/c/${cid}/characters$`));
  expect(sql(`SELECT COUNT(*) FROM sheet_characters WHERE id=${c.id}`).trim()).toBe("0");
});

test("Characters: a dropdown takes a custom entry, kept and shown again", async ({ page, browser }) => {
  const { cid, p1 } = await party(page, browser);
  const layout = { sections: [{ key: "who", title: "Who", fields: [{ key: "cls", label: "Class", type: "choice", options: ["Fighter", "Mage"] }] }] };
  const tpl = (await api(page, "template_save", { name: "Choosy", game: "Test RPG", layout })).json.template;
  const c = await make(p1, cid, { template_id: tpl.id, name: "Odd One" });
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  const custom = p1.getByLabel("Class, custom entry");
  await expect(custom).toBeHidden();
  await p1.getByLabel("Class", { exact: true }).selectOption("Mage");
  await expect.poll(() => stored(c.id, "cls")).toBe("Mage");
  await p1.getByLabel("Class", { exact: true }).selectOption({ label: "Custom…" });
  await expect(custom).toBeVisible();
  await custom.fill("Witch hunter");
  await custom.press("Tab");
  await expect.poll(() => stored(c.id, "cls")).toBe("Witch hunter");
  await p1.reload();
  await expect(p1.getByLabel("Class, custom entry")).toHaveValue("Witch hunter");
  await expect(p1.getByLabel("Class", { exact: true })).toHaveValue("__custom");
  // a custom entry is a short text: too long is refused
  expect((await api(p1, "character_field", { id: c.id, key: "cls", value: "x".repeat(501) }, cid)).status).toBe(400);
});

test("Characters: a sheet with pages keeps its open page when the sheet is drawn again", async ({ page, browser }) => {
  const { cid, p1 } = await party(page, browser);
  const layout = { sections: [
    { key: "main", title: "Main", fields: [{ key: "lvl", label: "Level", type: "number" }] },
    { key: "spells", title: "Spells", page: "Magic", fields: [{ key: "slots", label: "Slots", type: "text" }] },
  ] };
  const tpl = (await api(page, "template_save", { name: "Paged party", game: "Test RPG", layout })).json.template;
  const c = await make(p1, cid, { template_id: tpl.id, name: "Mage" });
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await p1.getByRole("tab", { name: "Magic" }).click();
  await expect(p1.getByRole("tab", { name: "Magic" })).toHaveAttribute("aria-selected", "true");
  // hiding a section saves and draws the sheet again
  await p1.getByRole("button", { name: "Hide the Spells section from the party" }).click();
  await expect(p1.getByRole("button", { name: "Show the Spells section to the party" })).toBeVisible();
  await expect(p1.getByLabel("Slots", { exact: true })).toBeVisible();
  await expect(p1.getByLabel("Level", { exact: true })).toBeHidden();
});

test("Characters: a Pathbuilder export pasted in fills the sheet, after asking", async ({ page, browser }) => {
  const { cid, p1, p2 } = await party(page, browser);
  const fs = require("fs"), path = require("path");
  const pf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "db", "starter-templates", "pathfinder-2e.json"), "utf8"));
  const tpl = (await api(page, "template_save", { name: `PF import ${Date.now()}`, game: pf.game, layout: pf.layout })).json.template;
  const c = await make(p1, cid, { template_id: tpl.id, name: "Blank" });
  await api(p1, "character_field", { id: c.id, key: "ancestry", value: "Dwarf" }, cid);
  const build = { success: true, build: { name: "Valeros", class: "Fighter", level: 3, ancestry: "Human", heritage: "Versatile Human", background: "Farmhand",
    attributes: { ancestryhp: 8, classhp: 10, bonushp: 0, bonushpPerLevel: 0, speed: 25, speedBonus: 0 },
    abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 12, cha: 10 }, proficiencies: { athletics: 4, fortitude: 4 },
    equipment: [["Rope", 1]], money: { gp: 15 } } };

  // someone else in the party has no Import
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p2.getByRole("heading", { name: "Blank" })).toBeVisible();
  await expect(p2.getByRole("button", { name: "Import" })).toHaveCount(0);

  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await moreIn(p1.locator(".sheet-head"), "Import");
  await p1.getByLabel("Link or JSON to import").fill("not json at all");
  await p1.getByRole("button", { name: "Read it" }).click();
  await expect(p1.locator(".sheet-import")).toContainText("Paste a Pathbuilder 2e Export JSON link");
  await p1.getByLabel("Link or JSON to import").fill(JSON.stringify(build));
  await p1.getByRole("button", { name: "Read it" }).click();
  const dlg = p1.locator("dialog");
  await expect(dlg).toContainText("Valeros");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect(stored(c.id, "ancestry")).toBe("Dwarf");
  await p1.getByRole("button", { name: "Read it" }).click();
  await dlg.getByRole("button", { name: "Fill the sheet" }).click();
  await expect(p1.getByLabel("Ancestry", { exact: true })).toHaveValue("Human");
  expect(stored(c.id, "ancestry")).toBe("Human");
  expect(stored(c.id, "attr_strength")).toBe(4);
  expect(stored(c.id, "sk_athletics")).toBe("Expert");
  expect(stored(c.id, "hp")).toEqual({ cur: 44, max: 44 });
  expect(stored(c.id, "items")).toEqual([{ item: "Rope", qty: "1" }]);
  // the name stays the sheet's own
  await expect(p1.getByRole("heading", { name: "Blank" })).toBeVisible();
});

test("Characters: many values at once all fit or none is kept, and only for the sheet's player or a GM", async ({ page, browser }) => {
  const { cid, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Batch" });
  expect((await api(p1, "character_values", { id: c.id, values: { str: 12, luck: 2 } }, cid)).status).toBe(200);
  expect([stored(c.id, "str"), stored(c.id, "luck")]).toEqual([12, 2]);
  const bad = await api(p1, "character_values", { id: c.id, values: { str: 15, luck: 9 } }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toMatch(/Luck/);
  expect(stored(c.id, "str")).toBe(12);
  expect((await api(p2, "character_values", { id: c.id, values: { str: 1 } }, cid)).status).toBe(403);
  expect((await api(p1, "character_values", { id: c.id, values: [] }, cid)).status).toBe(400);
});

test("Characters: an import link is fetched only from Pathbuilder or D&D Beyond", async ({ page, browser }) => {
  const { p1 } = await party(page, browser);
  for (const url of ["https://evil.example/json.php?id=1", "http://127.0.0.1/characters/1", "file:///etc/passwd"]) {
    const r = await api(p1, "sheet_import_fetch", { url });
    expect(r.status, url).toBe(400);
  }
});

/** The names of the Encyclopedia tags on character c's entry, A to Z. */
const entryTags = c => sql(`SELECT t.name FROM encyclopedia_tags et JOIN encyclopedia_tag_names t ON t.id=et.tag_id
  JOIN sheet_characters c ON c.entry_id=et.entry_id WHERE c.id=${c} ORDER BY t.name`).trim().split("\n").filter(Boolean);

test("Characters: each one's Encyclopedia entry is a Person tagged PC or NPC, and the tag follows the switch", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const pc = await make(p1, cid, { template_id: tpl.id, name: "Tagged" });
  const npc = await make(gm, cid, { template_id: tpl.id, name: "Tagged Too", kind: "npc" });
  expect(entryTags(pc.id)).toEqual(["PC"]);
  expect(entryTags(npc.id)).toEqual(["NPC"]);
  expect(sql(`SELECT e.category FROM encyclopedia_entries e JOIN sheet_characters c ON c.entry_id=e.id WHERE c.id=${pc.id}`).trim()).toBe("person");
  expect((await api(gm, "character_save", { id: pc.id, version: pc.version, kind: "npc" }, cid)).status).toBe(200);
  expect(entryTags(pc.id)).toEqual(["NPC"]);
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${npc.entry_id}`);
  await expect(gm.locator("body")).toContainText("NPC");
});

test("Characters: a PC or NPC tag changed in the Encyclopedia changes the sheet's Kind", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl } = await party(page, browser);
  const pc = await make(p1, cid, { template_id: tpl.id, name: "Retagged" });
  const save = (who, tags) => api(who, "entry_save", { id: pc.entry_id, name: "Retagged", tags }, cid);
  const kind = () => sql(`SELECT kind FROM sheet_characters WHERE id=${pc.id}`).trim();

  // the GM swaps PC for NPC on the entry: the sheet is an NPC's now, its other tags kept
  expect((await save(gm, [{ name: "NPC" }, { name: "Hero" }])).status).toBe(200);
  expect(kind()).toBe("npc");
  expect(entryTags(pc.id)).toEqual(["Hero", "NPC"]);

  // taking both off, or putting both on, leaves the Kind as it was and its tag back on
  expect((await save(gm, [{ name: "Hero" }])).status).toBe(200);
  expect(kind()).toBe("npc");
  expect(entryTags(pc.id)).toEqual(["Hero", "NPC"]);
  expect((await save(gm, [{ name: "PC" }, { name: "NPC" }])).status).toBe(200);
  expect(kind()).toBe("npc");
  expect(entryTags(pc.id)).toEqual(["NPC"]);

  // its player can switch it back from the Encyclopedia; another player can't, and the tag is put back
  expect((await save(p1, [{ name: "pc" }])).status).toBe(200);
  expect(kind()).toBe("pc");
  expect(entryTags(pc.id)).toEqual(["PC"]);
  expect((await save(p2, [{ name: "NPC" }])).status).toBe(200);
  expect(kind()).toBe("pc");
  expect(entryTags(pc.id)).toEqual(["PC"]);

  // and the sheet shows the Kind the tag set
  expect((await save(gm, [{ name: "NPC" }])).status).toBe(200);
  await gm.goto(`index.html#/c/${cid}/characters/${pc.id}`);
  await expect(gm.getByLabel("PC or NPC")).toHaveValue("npc");
});

test("Characters: a GM makes a PC with no player, and it travels with the party", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  await gm.goto(`index.html#/c/${cid}/characters`);
  await gm.getByRole("button", { name: "+ New character" }).click();
  await gm.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await gm.getByLabel("Character name").fill("Wanderer");
  await expect(gm.getByLabel("Player", { exact: true })).toHaveValue("0");
  await expect(gm.getByLabel("Travels with the party")).toBeChecked();
  await gm.getByRole("button", { name: "Make character" }).click();
  await expect(gm).toHaveURL(/#\/c\/\d+\/characters\/\d+$/);
  const id = Number(gm.url().match(/characters\/(\d+)$/)[1]);
  await expect(gm.locator(".sheet-page")).toContainText("No player · In the party");
  expect(sql(`SELECT owner_id FROM sheet_characters WHERE id=${id}`).trim()).toBe("NULL");

  // the Travel tab's party card lists it with the players, for the players too
  await p1.goto(`index.html#/c/${cid}/travel`);
  await expect(p1.locator(".party-members")).toContainText("Wanderer");

  // the GM takes it out of the party, then hands it to a player: it is in the party with them, not on its own
  await gm.getByLabel("Travels with the party").uncheck();
  await expect.poll(() => sql(`SELECT party_group_id FROM sheet_characters WHERE id=${id}`).trim()).toBe("NULL");
  await expect(gm.locator(".sheet-page")).not.toContainText("In the party");   // drawn again from the save
  await gm.getByLabel("Travels with the party").check();
  await expect.poll(() => sql(`SELECT party_group_id FROM sheet_characters WHERE id=${id}`).trim()).not.toBe("NULL");
  await expect(gm.locator(".sheet-page")).toContainText("In the party");
  await gm.getByLabel("Whose sheet").selectOption({ label: "Pip" });
  await expect.poll(() => sql(`SELECT party_group_id FROM sheet_characters WHERE id=${id}`).trim()).toBe("NULL");
  // a player's character is in the party with its player: ticked, and the GM can still take it out
  await expect(gm.getByLabel("Travels with the party")).toBeChecked();
});

test("Characters: a GM takes a player's character out of the party, and puts it back", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const pc = await make(p1, cid, { template_id: tpl.id, name: "Sir Benched" });
  const groups = () => sql(`SELECT GROUP_CONCAT(members_json) FROM party_groups WHERE campaign_id=${cid}`).trim();

  await gm.goto(`index.html#/c/${cid}/travel`);
  await expect(gm.locator(".party-members")).toContainText("Sir Benched");
  expect(groups()).toContain(String(ids.p1));

  // the GM unticks it on the sheet: the character, and its player with it, leave the party
  await gm.goto(`index.html#/c/${cid}/characters/${pc.id}`);
  const box = gm.getByLabel("Travels with the party");
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => sql(`SELECT party_out FROM sheet_characters WHERE id=${pc.id}`).trim()).toBe("1");
  await expect(gm.locator(".sheet-page")).toContainText("Out of the party");
  await gm.goto(`index.html#/c/${cid}/travel`);
  await expect(gm.locator(".party-members")).toBeVisible();
  await expect(gm.locator(".party-members")).not.toContainText("Sir Benched");
  expect(groups()).not.toContain(String(ids.p1));

  // a player can't put it back; the GM can, and it rejoins the main group
  const version = Number(sql(`SELECT version FROM sheet_characters WHERE id=${pc.id}`).trim());
  expect((await api(p1, "character_save", { id: pc.id, version, party: true }, cid)).status).toBe(403);
  await gm.goto(`index.html#/c/${cid}/characters/${pc.id}`);
  await gm.getByLabel("Travels with the party").check();
  await expect.poll(() => sql(`SELECT party_out FROM sheet_characters WHERE id=${pc.id}`).trim()).toBe("0");
  await gm.goto(`index.html#/c/${cid}/travel`);
  await expect(gm.locator(".party-members")).toContainText("Sir Benched");

  // the player sees no box on their own sheet
  await p1.goto(`index.html#/c/${cid}/characters/${pc.id}`);
  await expect(p1.getByLabel("PC or NPC")).toBeVisible();
  await expect(p1.getByLabel("Travels with the party")).toHaveCount(0);
});

test("Characters: the party's characters with no player split off and merge back with their group", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const pc = await make(gm, cid, { template_id: tpl.id, name: "Absent Friend", owner_id: 0, party: true });
  const npc = await make(gm, cid, { template_id: tpl.id, name: "Hireling", kind: "npc", owner_id: 0, party: true });
  const secret = await make(gm, cid, { template_id: tpl.id, name: "Spy", kind: "npc", owner_id: 0, party: true });
  sql(`UPDATE encyclopedia_entries SET is_secret=1 WHERE id=${secret.entry_id}`);
  const lone = await make(gm, cid, { template_id: tpl.id, name: "Stay Home", kind: "npc", owner_id: 0 });
  expect(lone.party_group_id).toBeNull();
  // a player can't make one with no player, or put one in the party
  expect((await api(p1, "character_create", { template_id: tpl.id, name: "Nobody's", owner_id: 0 }, cid)).status).toBe(403);
  expect((await api(p1, "character_create", { template_id: tpl.id, name: "Tagalong", party: true }, cid)).status).toBe(403);

  let groups = (await api(p1, "groups", undefined, cid)).json.groups;
  expect(groups[0].characters.map(c => c.name)).toEqual(["Absent Friend", "Hireling"]);   // the GM-only one isn't sent
  groups = (await api(gm, "groups", undefined, cid)).json.groups;
  expect(groups[0].characters.map(c => c.name)).toEqual(["Absent Friend", "Hireling", "Spy"]);

  await gm.goto(`index.html#/c/${cid}/travel`);
  await gm.getByRole("button", { name: "Split the party…" }).click();
  await gm.getByPlaceholder("e.g. Scouts").fill("Scouts");
  await gm.locator(".party-pick label", { hasText: "Hireling (NPC)" }).locator("input").check();
  await gm.locator(".party-pick label", { hasText: "Pip" }).locator("input").check();
  await gm.getByRole("button", { name: "Split", exact: true }).click();
  await expect(gm.locator(".party-row", { hasText: "Scouts" }).locator(".party-members")).toHaveText("Pip, Hireling (NPC)");
  groups = (await api(gm, "groups", undefined, cid)).json.groups;
  expect(groups[0].characters.map(c => c.name)).toEqual(["Absent Friend", "Spy"]);
  expect(groups[1].members).toEqual([ids.p1]);

  expect((await api(gm, "group_merge", { id: groups[1].id, into_id: groups[0].id }, cid)).status).toBe(200);
  groups = (await api(gm, "groups", undefined, cid)).json.groups;
  expect(groups).toHaveLength(1);
  expect(groups[0].characters.map(c => c.name)).toEqual(["Absent Friend", "Hireling", "Spy"]);
  // a character from another group can't be split off this one
  expect((await api(gm, "group_split", { from_id: groups[0].id, name: "Nope", characters: [lone.id] }, cid)).status).toBe(400);
  void pc;
});

test("Members: a character named the old way is matched up with a sheet, linked or made", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl, ids } = await party(page, browser);
  // the old way: only a name on the Members tab; Quin's name is also already an Encyclopedia entry
  await api(gm, "member_character", { user_id: ids.p1, character_name: "Brannoc" }, cid);
  await api(gm, "member_character", { user_id: ids.p2, character_name: "Quinella" }, cid);
  expect((await api(gm, "entry_save", { name: "Quinella", category: "person" }, cid)).status).toBe(200);
  const sheet = await make(gm, cid, { template_id: tpl.id, name: "Brannoc", owner_id: 0 });

  await gm.goto(`index.html#/c/${cid}/members`);
  const pip = gm.locator(".member", { hasText: "Pip" });
  await expect(pip).toContainText("No sheet yet");
  await moreIn(pip, "Link a character…");
  await expect(gm.getByLabel("Character", { exact: true })).toHaveValue(`c${sheet.id}`);   // the one with its name comes first
  await gm.getByRole("button", { name: "Link", exact: true }).click();
  await expect(pip.getByRole("link", { name: "Brannoc" })).toBeVisible();
  expect(sql(`SELECT owner_id FROM sheet_characters WHERE id=${sheet.id}`).trim()).toBe(String(ids.p1));
  expect(sql(`SELECT active_character_id FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p1}`).trim()).toBe(String(sheet.id));

  // Quin makes their own sheet from their row: it goes on the entry already called Quinella
  await p2.goto(`index.html#/c/${cid}/members`);
  const quin = p2.locator(".member", { hasText: "Quin" });
  await moreIn(quin, "Make a sheet");
  await expect(p2.getByLabel("Character name")).toHaveValue("Quinella");
  await p2.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await p2.getByRole("button", { name: "Make character" }).click();
  await expect(p2).toHaveURL(/#\/c\/\d+\/characters\/\d+$/);
  const qid = Number(p2.url().match(/characters\/(\d+)$/)[1]);
  expect(sql(`SELECT e.name FROM sheet_characters c JOIN encyclopedia_entries e ON e.id=c.entry_id WHERE c.id=${qid}`).trim()).toBe("Quinella");
  expect(sql(`SELECT COUNT(*) FROM encyclopedia_entries WHERE campaign_id=${cid} AND name='Quinella'`).trim()).toBe("1");
  expect(sql(`SELECT active_character_id FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p2}`).trim()).toBe(String(qid));
  // a player can't take a sheet that isn't theirs, or put one on an entry that isn't their character's name
  expect((await api(p2, "member_link_character", { character_id: sheet.id }, cid)).status).toBe(403);
  const other = (await api(gm, "entry_save", { name: "Somebody Else", category: "person" }, cid)).json;
  expect((await api(p2, "character_create", { template_id: tpl.id, entry_id: other.id }, cid)).status).toBe(403);
});

test("Characters: a player's first PC becomes their character, named by it", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const first = await make(p1, cid, { template_id: tpl.id, name: "First" });
  await make(p1, cid, { template_id: tpl.id, name: "Second" });
  expect(sql(`SELECT CONCAT(active_character_id, ' ', character_name) FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p1}`).trim()).toBe(`${first.id} First`);
  // a GM handing a no-player sheet to a player with none makes it theirs too
  const handed = await make(gm, cid, { template_id: tpl.id, name: "Handed", owner_id: 0 });
  expect((await api(gm, "character_save", { id: handed.id, version: handed.version, owner_id: ids.p1 }, cid)).status).toBe(200);
  expect(sql(`SELECT active_character_id FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p1}`).trim()).toBe(String(first.id));
});

test("Members: a GM links a member to a Person in the Encyclopedia, which gets a sheet", async ({ page, browser }) => {
  const { cid, gm, tpl, ids } = await party(page, browser);
  await api(gm, "member_character", { user_id: ids.p1, character_name: "Old Name" }, cid);
  const entry = (await api(gm, "entry_save", { name: "Ser Aldric", category: "person" }, cid)).json.id;
  await gm.goto(`index.html#/c/${cid}/members`);
  const pip = gm.locator(".member", { hasText: "Pip" });
  await moreIn(pip, "Link a character…");
  await gm.getByLabel("Character", { exact: true }).selectOption(`e${entry}`);
  await gm.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await gm.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  await expect(pip.getByRole("link", { name: "Ser Aldric" })).toBeVisible();
  const id = sql(`SELECT id FROM sheet_characters WHERE entry_id=${entry}`).trim();
  expect(sql(`SELECT owner_id FROM sheet_characters WHERE id=${id}`).trim()).toBe(String(ids.p1));
  expect(sql(`SELECT CONCAT(active_character_id, ' ', character_name) FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p1}`).trim()).toBe(`${id} Ser Aldric`);
});

test("Linking a member to a Person entry with no sheet makes none by default: the entry's name is their character's", async ({ page, browser }) => {
  const { cid, gm, tpl, ids } = await party(page, browser);
  const entry = (await api(gm, "entry_save", { name: "Nessa", category: "person", notes: "<p>A bard.</p>" }, cid)).json.id;
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await gm.getByRole("button", { name: "Link a member…" }).click();
  const template = gm.getByLabel("Template", { exact: true });
  await expect(template).toHaveValue("");   // None, the first choice
  await expect(template.locator("option").first()).toHaveText("None (no sheet yet)");
  await gm.getByLabel("Member", { exact: true }).selectOption(String(ids.p1));
  await gm.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  await expect.poll(() => sql(`SELECT character_name FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p1}`).trim()).toBe("Nessa");
  expect(sql(`SELECT COUNT(*) FROM sheet_characters WHERE entry_id=${entry}`).trim()).toBe("0");

  // the Members tab shows it with no sheet yet; Make a sheet later puts the sheet on that entry
  await gm.goto(`index.html#/c/${cid}/members`);
  const pip = gm.locator(".member", { hasText: "Pip" });
  await expect(pip).toContainText("Nessa");
  await expect(pip).toContainText("No sheet yet");
  await moreIn(pip, "Link a character…");
  await expect(gm.getByLabel("Character", { exact: true })).toHaveValue(`e${entry}`);
  await expect(gm.getByLabel("Template", { exact: true })).toHaveValue("");
  await gm.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await gm.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  await expect(pip.getByRole("link", { name: "Nessa" })).toBeVisible();
  expect(sql(`SELECT owner_id FROM sheet_characters WHERE entry_id=${entry}`).trim()).toBe(String(ids.p1));
});

test("Encyclopedia: a GM links a Person entry to a member from its page or its editor", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  // an entry with no sheet: picking the member and a template makes the sheet, theirs and active
  const entry = (await api(gm, "entry_save", { name: "Mira", category: "person", notes: "<p>A scout.</p>" }, cid)).json.id;
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await gm.getByRole("button", { name: "Link a member…" }).click();
  await gm.getByLabel("Member", { exact: true }).selectOption(String(ids.p2));
  await gm.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await gm.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  await expect.poll(() => sql(`SELECT owner_id FROM sheet_characters WHERE entry_id=${entry}`).trim()).toBe(String(ids.p2));
  await expect(gm.getByRole("link", { name: "Open sheet" }).first()).toBeVisible();
  const id = sql(`SELECT id FROM sheet_characters WHERE entry_id=${entry}`).trim();
  expect(sql(`SELECT active_character_id FROM campaign_members WHERE campaign_id=${cid} AND user_id=${ids.p2}`).trim()).toBe(id);

  // an entry with a sheet, from its editor: the sheet goes to the member picked, with no template to pick
  const pc = await make(gm, cid, { template_id: tpl.id, name: "Torvald", owner_id: 0 });
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${pc.entry_id}`);
  // (the first link's page may still be drawn again once, closing an editor opened too soon: open it until it stays)
  await expect(async () => {
    if (!await gm.locator(".enc-form").count()) await gm.getByRole("button", { name: "Edit", exact: true }).click();
    await gm.locator(".enc-form").getByRole("button", { name: "Link a member…" }).click({ timeout: 2000 });
  }).toPass();
  await expect(gm.getByLabel("Template", { exact: true })).toHaveCount(0);
  await gm.getByLabel("Member", { exact: true }).selectOption(String(ids.p1));
  await gm.getByRole("dialog").getByRole("button", { name: "Link", exact: true }).click();
  await expect.poll(() => sql(`SELECT owner_id FROM sheet_characters WHERE id=${pc.id}`).trim()).toBe(String(ids.p1));

  // only for a Person (or no Category), and only for GMs
  const place = (await api(gm, "entry_save", { name: "Ferry", category: "location", notes: "<p>Wet.</p>" }, cid)).json.id;
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${place}`);
  await expect(gm.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(gm.getByRole("button", { name: "Link a member…" })).toHaveCount(0);
  await p1.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await expect(p1.getByRole("link", { name: "Open sheet" }).first()).toBeVisible();
  await expect(p1.getByRole("button", { name: "Link a member…" })).toHaveCount(0);
});

test("Encyclopedia: an entry's editor has every button its page has, and a Person entry offers Add character sheet, then Open sheet", async ({ page, browser }) => {
  const { cid, gm, tpl } = await party(page, browser);
  const blank = (await api(gm, "entry_save", { name: "Hoffmann", category: "person" }, cid)).json.id;
  // a blank entry opens straight in its editor: the button is there, and only while the Category is Person (or none);
  // the editor has everything the page has: Copy as handout, Scan and the connections
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${blank}`);
  const form = gm.locator(".enc-form");
  await expect(form.getByRole("button", { name: "📋 Copy as handout" })).toBeVisible();
  await expect(form.getByRole("button", { name: "🔍 Scan" })).toBeVisible();
  await expect(form.getByRole("heading", { name: "Connections" })).toBeVisible();
  const add = gm.getByRole("button", { name: "Add character sheet" });
  await expect(add).toBeVisible();
  await gm.locator("select[name=category]").selectOption("location");
  await expect(add).toBeHidden();
  await gm.locator("select[name=category]").selectOption("person");
  await add.click();
  await gm.getByLabel("Template", { exact: true }).selectOption(String(tpl.id));
  await gm.getByRole("button", { name: "Add sheet" }).click();
  await expect(gm).toHaveURL(/#\/c\/\d+\/characters\/\d+$/);
  // with notes it opens on its page, which has the button too; once it has a sheet, both say Open sheet
  const written = (await api(gm, "entry_save", { name: "Greta", category: "person", notes: "<p>Runs the ferry.</p>" }, cid)).json.id;
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${written}`);
  await expect(gm.getByRole("button", { name: "Add character sheet" })).toBeVisible();
  await gm.goto(`index.html#/c/${cid}/encyclopedia/${blank}`);
  await expect(gm.getByRole("link", { name: "Open sheet" })).toBeVisible();
  await gm.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(gm.locator(".enc-form").getByRole("link", { name: "Open sheet" })).toBeVisible();
});

test("Characters: a card shows a short summary, lists by their rows' names, and never the raw data", async ({ page, browser }) => {
  const { cid, p1 } = await party(page, browser);
  const layout = { sections: [{ key: "s", title: "S", fields: [
    { key: "cls", label: "Class", type: "text", summary: true }, { key: "lvl", label: "Level", type: "number", summary: true },
    { key: "hp", label: "Hit Points", type: "counter", play: true }, { key: "armor", label: "Armor", type: "number", play: true },
    { key: "gear", label: "Gear", type: "list", play: true, columns: [{ key: "item", label: "Item" }, { key: "weight", label: "Weight" }] },
    { key: "past", label: "Past", type: "longtext" }] }] };
  const tpl = (await api(page, "template_save", { name: `Card sheet ${Date.now()}`, game: "Test RPG", layout })).json.template;
  const c = await make(p1, cid, { template_id: tpl.id, name: "Marshal Wright" });
  const values = { cls: "Fighter", lvl: 2, hp: { cur: 15, max: 15 }, armor: 2, past: "Long story",
    gear: [{ item: "Sword", weight: "1" }, { item: "Shield", weight: "1" }, { item: "Rations", weight: "1" }, { item: "Rope", weight: "1" }] };
  sql(`UPDATE sheet_characters SET field_values='${JSON.stringify(values)}' WHERE id=${c.id}`);
  await p1.goto(`index.html#/c/${cid}/characters`);
  const card = p1.locator(".character-card", { hasText: "Marshal Wright" });
  await expect(card.locator(".character-summary")).toHaveText("Fighter · Level 2");
  await expect(card).toContainText("Hit Points 15 / 15");
  await expect(card).toContainText("Armor 2");
  await expect(card).toContainText("Gear: Sword, Shield, Rations +1 more");
  await expect(card).not.toContainText("{");
  await expect(card).not.toContainText("Long story");
  await expect(card.locator(".character-initials")).toHaveText("MW");   // no portrait yet
});

test("Characters: a player uploads a portrait on the sheet; it shows on the card, and the GM can pick another of the entry's pictures", async ({ page, browser }) => {
  const { cid, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Portia" });
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await p1.getByRole("button", { name: "Add a portrait" }).click();
  const panel = p1.locator(".sheet-portrait-panel");
  await expect(panel).toContainText("No pictures yet.");
  await panel.locator("input[type=file]").setInputFiles({ name: "portia.png", mimeType: "image/png", buffer: makePng(8, 8, () => 40) });
  await expect(panel.locator(".portrait-pick")).toHaveCount(1);
  await expect(p1.locator(".sheet-head img.character-pic")).toBeVisible();
  const first = sql(`SELECT portrait_id FROM sheet_characters WHERE id=${c.id}`).trim();
  expect(Number(first)).toBeGreaterThan(0);
  // the picture went on the character's Encyclopedia entry
  expect(sql(`SELECT parent_id FROM attachments WHERE id=${first}`).trim()).toBe(String(c.entry_id));

  await p1.goto(`index.html#/c/${cid}/characters`);
  await expect(p1.locator(".character-card", { hasText: "Portia" }).locator("img.character-pic")).toHaveAttribute("src", new RegExp(`id=${first}$`));

  // a second picture on the entry, picked by the GM from the sheet
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await p1.getByRole("button", { name: "Change the portrait" }).click();
  await p1.locator(".sheet-portrait-panel input[type=file]").setInputFiles({ name: "second.png", mimeType: "image/png", buffer: makePng(8, 8, () => 200) });
  await expect(p1.locator(".sheet-portrait-panel .portrait-pick")).toHaveCount(2);
  const second = Number(sql(`SELECT portrait_id FROM sheet_characters WHERE id=${c.id}`).trim());
  expect(second).not.toBe(Number(first));
  await page.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await page.getByRole("button", { name: "Change the portrait" }).click();
  await page.locator(".sheet-portrait-panel .portrait-pick").first().click();
  await expect.poll(() => sql(`SELECT portrait_id FROM sheet_characters WHERE id=${c.id}`).trim()).toBe(first);

  // only a picture on its own entry, and only by its player or a GM
  const other = (await api(page, "entry_save", { name: "Elsewhere", notes: "" }, cid)).json.id;
  const me = await (await page.request.get("api/auth/me.php")).json();
  const up = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, { headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "encyclopedia", parent_id: String(other), file: { name: "x.png", mimeType: "image/png", buffer: makePng(4, 4) } } });
  const stray = (await up.json()).file.id;
  expect((await api(page, "character_portrait", { id: c.id, file_id: stray }, cid)).status).toBe(404);
  // removing the portrait's picture goes back to the entry's first picture
  expect((await api(page, "file_delete", { id: Number(first) }, cid)).status).toBe(200);
  expect(sql(`SELECT portrait_id FROM sheet_characters WHERE id=${c.id}`).trim()).toBe("NULL");
  const card = (await api(p1, "characters", undefined, cid)).json.characters.find(x => x.id === c.id);
  expect(card.pic).toMatch(new RegExp(`id=${second}$`));
});

test("Characters: someone who isn't its player or a GM can't change a portrait", async ({ page, browser }) => {
  const { cid, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Mine" });
  expect((await api(p2, "character_portrait", { id: c.id, file_id: 0 }, cid)).status).toBe(403);
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p2.getByRole("heading", { name: "Mine" })).toBeVisible();
  await expect(p2.getByRole("button", { name: "Add a portrait" })).toHaveCount(0);
});

test("Characters cards: Play shows on a blank sheet, a GM's Party switch, and every card's buttons on one line", async ({ page, browser }) => {
  const { cid, p1, tpl } = await party(page, browser);
  await page.setViewportSize({ width: 1180, height: 900 });
  // a long game name wraps the line under the name on one card, not the others
  const long = (await api(page, "template_save", { name: `Long ${cid}`, game: "A Game With A Very Long Name Indeed That Wraps", layout: LAYOUT() })).json.template;
  const kat = await make(page, cid, { template_id: tpl.id, name: "Katrina", kind: "pc", owner_id: 0, party: false });
  await make(page, cid, { template_id: long.id, name: "Hodor", kind: "npc", owner_id: 0, party: false });
  await make(page, cid, { template_id: tpl.id, name: "Wright", kind: "pc", owner_id: 0, party: false });
  await page.goto(`index.html#/c/${cid}/characters`);
  const card = n => page.locator(".character-card").filter({ has: page.getByRole("link", { name: n, exact: true }) });
  // nothing filled in yet, and Play is still there
  await expect(card("Katrina").getByRole("link", { name: "Play" })).toBeVisible();
  // the buttons sit at the same height on every card in the row
  const tops = await page.locator(".character-card").evaluateAll(cs => cs.map(c => Math.round(c.querySelector(".character-card-foot").getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // the GM's Party switch puts it in the party and takes it out again
  const sw = card("Katrina").getByLabel("Party");
  await expect(sw).not.toBeChecked();
  await sw.check();
  await expect(page.locator("#toast")).toHaveText("Katrina travels with the party");
  await expect(card("Katrina")).toContainText("In the party");
  expect(sql(`SELECT party_group_id IS NOT NULL FROM sheet_characters WHERE id=${kat.id}`).trim()).toBe("1");
  await card("Katrina").getByLabel("Party").uncheck();
  await expect(page.locator("#toast")).toHaveText("Katrina is out of the party");
  expect(sql(`SELECT party_group_id IS NULL FROM sheet_characters WHERE id=${kat.id}`).trim()).toBe("1");
  // a player has no switch
  await p1.goto(`index.html#/c/${cid}/characters`);
  await expect(p1.locator(".character-card").first()).toBeVisible();
  await expect(p1.locator(".character-party")).toHaveCount(0);
});

test("Characters: a track's maximum is the character's own: the pips past it are greyed out, can't be ticked, and the party sees it", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Capped" });
  await api(p1, "character_field", { id: c.id, key: "luck", value: 3 }, cid);
  await p1.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p1.getByRole("button", { name: "Luck 3", exact: true })).toHaveAttribute("aria-pressed", "true");
  // the Max pickers show only while Track maximums is open
  await expect(p1.getByLabel("Luck maximum")).toHaveCount(0);
  await moreIn(p1.locator(".sheet-head"), "Track maximums");
  await expect(p1.getByLabel("Luck maximum")).toHaveValue("3");
  await p1.getByLabel("Luck maximum").selectOption("2");
  await expect(p1.getByRole("button", { name: "Luck 3, not available" })).toBeDisabled();
  // ticked past the new maximum: it comes down to it, on screen and saved
  await expect(p1.getByRole("button", { name: "Luck 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => stored(c.id, "luck")).toBe(2);
  await p1.getByRole("button", { name: "Done" }).click();
  await expect(p1.getByLabel("Luck maximum")).toHaveCount(0);
  await p1.reload();
  await expect(p1.getByRole("button", { name: "Luck 3, not available" })).toBeDisabled();
  await p1.getByRole("button", { name: "Luck 1", exact: true }).click();
  await expect.poll(() => stored(c.id, "luck")).toBe(1);

  // the server holds to it too
  expect((await api(p1, "character_field", { id: c.id, key: "luck", value: 3 }, cid)).status).toBe(400);
  expect((await api(p1, "character_field", { id: c.id, key: "luck", value: 2 }, cid)).status).toBe(200);
  // only a track takes a maximum, and only up to its pips
  const v = () => sql(`SELECT version FROM sheet_characters WHERE id=${c.id}`).trim();
  expect((await api(p1, "character_save", { id: c.id, version: Number(v()), pip_caps: { str: 2 } }, cid)).status).toBe(400);
  expect((await api(p1, "character_save", { id: c.id, version: Number(v()), pip_caps: { luck: 4 } }, cid)).status).toBe(400);
  // the party sees which are out of reach, on the sheet, the Play view and the card
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}`);
  await expect(p2.getByRole("button", { name: "Luck 3, not available" })).toBeDisabled();
  await expect(p2.getByRole("button", { name: "Track maximums" })).toHaveCount(0);
  await p2.goto(`index.html#/c/${cid}/characters/${c.id}/play`);
  await expect(p2.getByRole("button", { name: "Luck 3, not available" })).toBeDisabled();
  await p2.goto(`index.html#/c/${cid}/characters`);
  await expect(p2.locator(".character-card", { hasText: "Capped" })).toContainText("Luck ●●○");
  // a GM changes it too, and All puts every pip back
  expect((await api(gm, "character_save", { id: c.id, version: Number(v()), pip_caps: { luck: null } }, cid)).status).toBe(200);
  await p1.reload();
  await expect(p1.getByRole("button", { name: "Luck 3", exact: true })).toBeEnabled();
  expect(sql(`SELECT pip_caps FROM sheet_characters WHERE id=${c.id}`).trim()).toBe("NULL");
});
