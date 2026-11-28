// NPC stat blocks (docs/superpowers/specs/2026-11-27-npc-stat-blocks-design.md): a second kind of sheet template, in a
// game's own NPC format. A GM adds one to a Person entry, the campaign's dice game picking which; it shows in full on
// the entry's page, where its hit points are ticked and its numbers rolled. Sheets go on as before.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, ADMIN, signIn, api, approve, sql, makeCampaign, newContext, closeContexts } = require("./helpers");
const L = require(path.join(__dirname, "..", "..", "static", "sheetlayout.js"));
const DS = require(path.join(__dirname, "..", "..", "static", "dice-systems.js"));
test.afterEach(closeContexts);

const DIR = path.join(__dirname, "..", "..", "db", "starter-templates");
const blocks = () => fs.readdirSync(DIR).filter(f => f.startsWith("statblock-") && f.endsWith(".json"))
  .map(f => ({ f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));
const BLOCK = () => ({ sections: [
  { key: "top", title: "Overview", compact: true, fields: [
    { key: "kind_line", label: "Type", type: "text", summary: true },
    { key: "ac", label: "AC", type: "number" }, { key: "hp", label: "HP", type: "counter", play: true }, { key: "speed", label: "Speed", type: "text" }] },
  { key: "abil", title: "Abilities", abilities: true, modifier: "dnd", fields: [
    { key: "str", label: "Str", type: "number" }, { key: "dex", label: "Dex", type: "number" }] },
  { key: "acts", title: "Actions", fields: [{ key: "actions", label: "Actions", type: "list", columns: [{ key: "name", label: "Name" }, { key: "text", label: "Text" }] }] },
  { key: "more", title: "More", fields: [{ key: "notes", label: "Notes", type: "longtext" }, { key: "empty", label: "Languages", type: "text" }] },
] });
const dice = game => ({ dice: { player_vis: "all", keep: 100, system: game ? { id: "d20", game, params: { tn: 15, crit: 20, fumble: true } } : null } });
/** A GM, a campaign on dice game `game` (null: free dice), and the starters loaded. */
async function setup(page, browser, game) {
  const gm = person("Greta");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const admin = await (await newContext(browser)).newPage();
  await signIn(admin, ADMIN);
  expect((await api(admin, "starter_templates_load", {})).status).toBe(200);
  const cid = await makeCampaign(page, `Stat blocks ${gm.id}`);
  const s = (await api(page, "campaign", undefined, cid)).json;
  expect((await api(page, "campaign_update", { settings: { ...(s.campaign?.settings || {}), ...dice(game) } }, cid)).status).toBe(200);
  return { gm, cid };
}
const templates = async page => (await (await page.request.get("api/index.php?a=templates")).json()).templates;
const character = async (page, cid, id) => (await (await page.request.get(`api/index.php?a=character&cid=${cid}&id=${id}`)).json()).character;

test("Stat block starters: ten, each valid, for a known dice game, with one for any game", () => {
  const ids = new Set(DS.PRESETS.map(g => g.id));
  expect(blocks().length).toBe(10);
  for (const t of blocks()) {
    expect(t.kind, t.f).toBe("statblock");
    expect(L.validate(t.layout, { statblock: true }), t.f).toEqual([]);
    expect(L.validate(t.layout).some(e => /Holdings/.test(e)), `${t.f}: no Holdings page`).toBe(false);
    if (t.dice_game !== undefined) expect(ids.has(t.dice_game), `${t.f}: ${t.dice_game}`).toBe(true);
    // something to track at the table
    expect([...L.fields(t.layout).values()].some(x => ["counter", "pips"].includes(x.field.type)), `${t.f}: a track`).toBe(true);
  }
  expect(blocks().filter(t => t.dice_game === undefined).map(t => t.f)).toEqual(["statblock-generic.json"]);
  expect(new Set(blocks().map(t => t.dice_game)).size, "one starter a game").toBe(10);
  // the server's list of dice games is the roller's
  const php = fs.readFileSync(path.join(__dirname, "..", "..", "api", "sheets.php"), "utf8").match(/const DICE_GAMES = \[([^\]]+)\]/)[1];
  expect(php.match(/'[a-z0-9]+'/g).map(x => x.slice(1, -1)).sort()).toEqual([...ids].sort());
});

test("An abilities row and a missing Holdings page are a stat block's alone", () => {
  expect(L.validate(BLOCK(), { statblock: true })).toEqual([]);
  expect(L.validate(BLOCK())).toContain("Only a stat block has an abilities row");
  const held = { sections: [...BLOCK().sections, L.holdingsSection(new Set())] };
  expect(L.validate(held, { statblock: true })).toContain("A stat block has no Holdings page");
  const bad = BLOCK();
  bad.sections[0].modifier = "dnd";
  expect(L.validate(bad, { statblock: true }).join()).toMatch(/a modifier is "dnd", on an abilities row/);
});

test("Templates: a stat block keeps its kind and game through saves and forks; a sheet can't have either", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "chromium", "the server answers the same whatever the browser");
  const who = person("Tess");
  await signIn(page, who);
  await approve(browser, who.email);
  const made = await api(page, "template_save", { name: `Block ${who.id}`, game: "Test RPG", kind: "statblock", dice_game: "coc7", layout: BLOCK() });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  expect(made.json.template).toMatchObject({ kind: "statblock", dice_game: "coc7" });
  expect(made.json.template.layout.sections[1]).toMatchObject({ abilities: true, modifier: "dnd" });
  const t = made.json.template;
  // its game changes; its kind doesn't
  const again = await api(page, "template_save", { id: t.id, version: t.version, name: t.name, game: t.game, dice_game: null, layout: BLOCK() });
  expect(again.json.template).toMatchObject({ kind: "statblock", dice_game: null, version: t.version + 1 });
  expect((await api(page, "template_save", { id: t.id, version: t.version + 1, name: t.name, game: t.game, kind: "sheet", layout: BLOCK() })).status).toBe(400);
  expect((await api(page, "template_save", { id: t.id, version: t.version + 1, name: t.name, game: t.game, dice_game: "pf2", layout: BLOCK() })).status).toBe(200);
  const fork = await api(page, "template_fork", { id: t.id });
  expect(fork.json.template).toMatchObject({ kind: "statblock", dice_game: "pf2", forked_from: { id: t.id } });
  expect(fork.json.template.layout.sections[1].abilities).toBe(true);

  expect((await api(page, "template_save", { name: "Nope", game: "Test RPG", kind: "statblock", dice_game: "nope", layout: BLOCK() })).status).toBe(400);
  expect((await api(page, "template_save", { name: "Nope", game: "Test RPG", kind: "poster", layout: BLOCK() })).status).toBe(400);
  const sheet = { sections: [{ key: "a", title: "A", fields: [{ key: "x", label: "X", type: "number" }] }] };
  expect((await api(page, "template_save", { name: "Nope", game: "Test RPG", dice_game: "coc7", layout: sheet })).status).toBe(400);
  const asSheet = await api(page, "template_save", { name: "Nope", game: "Test RPG", layout: BLOCK() });
  expect(asSheet.status).toBe(400);
  expect(asSheet.json.message).toContain("Only a stat block has an abilities row");
  const plain = await api(page, "template_save", { name: `Sheet ${who.id}`, game: "Test RPG", layout: sheet });
  expect(plain.json.template).toMatchObject({ kind: "sheet", dice_game: null });
});

test("The starters load as stat blocks, and the upgrade from before them adds the columns", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "chromium", "the server answers the same whatever the browser");
  await signIn(page, ADMIN);
  expect((await api(page, "starter_templates_load", {})).status).toBe(200);
  expect(sql("SELECT COUNT(*) FROM sheet_templates WHERE kind='statblock' AND starter_key LIKE 'statblock-%'").trim()).toBe("10");
  expect(sql("SELECT dice_game FROM sheet_templates WHERE starter_key='statblock-dnd5e'").trim()).toBe("dnd5e");
  expect(sql("SELECT COUNT(*) FROM sheet_templates WHERE kind='statblock' AND starter_key NOT LIKE 'statblock-%'").trim()).toBe("0");
  const about = (await (await page.request.get("api/index.php?a=starter_sources")).json()).starters;
  expect(about.filter(s => s.statblock).length).toBe(10);
  // the migration is what schema.sql says: the same two columns
  const mig = fs.readFileSync(path.join(__dirname, "..", "..", "db", "migrations", "062_statblocks.sql"), "utf8");
  expect(mig).toMatch(/ADD COLUMN kind ENUM\('sheet','statblock'\) NOT NULL DEFAULT 'sheet'/);
  expect(mig).toMatch(/ADD COLUMN dice_game VARCHAR\(20\) NULL/);
});

test("A GM adds the campaign's game's stat block to a Person entry; it shows, tracks and rolls on the entry", async ({ page, browser }) => {
  test.setTimeout(90000);
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "dnd5e");
  const entry = (await api(page, "entry_save", { name: "Captain Mira Voss", category: "person", notes: "<p>Harbourmaster of Saltreach.</p>" }, cid)).json.id;
  await page.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await page.getByRole("button", { name: "Add stat block" }).click();
  const dialog = page.getByRole("dialog", { name: "A stat block for Captain Mira Voss" });
  await expect(dialog).toContainText("D&D 5th edition");
  const pick = dialog.getByLabel("Stat block");
  await expect(pick.locator("option:checked")).toHaveText("D&D 5e stat block (the campaign's game)");
  // then the generic one, then the rest
  await expect(pick.locator("option").nth(1)).toHaveText("Generic stat block");
  // only stat blocks are offered here
  expect(await pick.locator("option").count()).toBe((await templates(page)).filter(t => t.kind === "statblock").length);
  await dialog.getByRole("button", { name: "Add stat block" }).click();
  await expect(page).toHaveURL(/characters\/\d+$/);
  const id = Number(page.url().match(/characters\/(\d+)$/)[1]);
  const ch = await character(page, cid, id);
  expect(ch).toMatchObject({ kind: "npc", statblock: true, owner: null, sheet_public: false });

  // filled in by the GM with no Edit press: the block is the GMs' own
  const set = async (key, value) => expect((await api(page, "character_field", { id, key, value }, cid)).status, key).toBe(200);
  await set("type_line", "Medium human, lawful neutral");
  await set("ac", 17);
  await set("hp", { cur: 44, max: 52 });
  await set("str", 16);
  await set("dex", 9);
  await set("skills", "Athletics +5");
  await set("actions", [{ name: "Longsword", text: "Melee attack +5, reach 5 ft. Hit: 7 (1d8+3) slashing." }, { name: "", text: "" }]);

  await page.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  const block = page.locator(".statblock-card");
  await expect(block.locator(".sb-name")).toHaveCount(0);   // the page's own heading names it
  await expect(block.locator(".sb-sub")).toHaveText("Medium human, lawful neutral · D&D 5e stat block");
  await expect(block.locator(".sb-kv").first()).toContainText("AC 17");
  await expect(block.locator(".sb-abil")).toContainText("16 (+3)");
  await expect(block.locator(".sb-abil")).toContainText("9 (−1)");
  await expect(block.locator("h4.sb-sec")).toHaveText(["Actions"]);   // Traits, Reactions and the rest are empty, so left out
  await expect(block.locator(".sb-row")).toHaveText(["Longsword. Melee attack +5, reach 5 ft. Hit: 7 (1d8+3) slashing."]);
  await expect(block).not.toContainText("Languages");
  // the one-line strip is a full sheet's, and Open sheet with it
  await expect(page.locator(".enc-character")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open sheet" })).toHaveCount(0);
  await expect(block.getByRole("link", { name: "Full stat block" })).toHaveAttribute("href", `#/c/${cid}/characters/${id}`);

  // hit points come down on the entry's page
  const hp = block.getByLabel("HP now");
  await expect(hp).toHaveValue("44");
  await hp.fill("37");
  await hp.blur();
  await expect.poll(async () => (await character(page, cid, id)).values.hp).toEqual({ cur: 37, max: 52 });

  // a score rolls its modifier, and the dice in an action roll as written
  await block.getByRole("button", { name: "Roll Str: 16 (+3)" }).click();
  await expect(page.locator("body")).toContainText("Captain Mira Voss: Str");
  await block.getByRole("button", { name: /^Roll Longsword text: 1d8\+3$/ }).scrollIntoViewIfNeeded();
  await expect(block.getByRole("button", { name: /^Roll Longsword text: \+5$/ })).toBeVisible();
  await expect(block.getByRole("button", { name: "Roll Skills: +5" })).toBeVisible();
  expectNoErrors(errors);
});

test("No game picked, or a game with no stat block: the generic block is picked", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, null);
  const entry = (await api(page, "entry_save", { name: "Old Nan", category: "person", notes: "<p>Keeps the well.</p>" }, cid)).json.id;
  await page.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await page.getByRole("button", { name: "Add stat block" }).click();
  let dialog = page.getByRole("dialog", { name: "A stat block for Old Nan" });
  await expect(dialog).toContainText("no game picked under Settings");
  await expect(dialog.getByLabel("Stat block").locator("option:checked")).toHaveText("Generic stat block");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const s = (await api(page, "campaign", undefined, cid)).json;
  expect((await api(page, "campaign_update", { settings: { ...s.campaign.settings, dice: { ...dice(null).dice, system: { id: "under3d6", game: "gurps", params: { n: 3 } } } } }, cid)).status).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "Add stat block" }).click();
  dialog = page.getByRole("dialog", { name: "A stat block for Old Nan" });
  await expect(dialog).toContainText("There is no stat block for GURPS yet");
  await expect(dialog.getByLabel("Stat block").locator("option:checked")).toHaveText("Generic stat block");
});

test("A player sees a stat block only once it is shown, and can't change it; a full sheet keeps its strip", async ({ page, browser }) => {
  const { cid } = await setup(page, browser, "coc7");
  const who = person("Pip");
  const pp = await (await newContext(browser)).newPage();
  await signIn(pp, who);
  await approve(browser, who.email);
  expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
  const all = await templates(page);
  const coc = all.find(t => t.kind === "statblock" && t.dice_game === "coc7" && t.starter);
  const entry = (await api(page, "entry_save", { name: "Inspector Hale", category: "person" }, cid)).json.id;
  const made = await api(page, "character_create", { template_id: coc.id, entry_id: entry, kind: "npc", owner_id: 0 }, cid);
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const id = made.json.character.id;
  expect((await api(page, "character_field", { id, key: "hp", value: { cur: 12, max: 12 } }, cid)).status).toBe(200);
  expect((await api(page, "character_field", { id, key: "str", value: 7731 }, cid)).status).toBe(200);

  await pp.goto(`index.html#/c/${cid}/encyclopedia/${entry}`);
  await expect(pp.getByRole("heading", { name: "Inspector Hale", exact: true })).toBeVisible();
  await expect(pp.locator(".statblock-card")).toHaveCount(0);
  expect(JSON.stringify(await character(pp, cid, id))).not.toMatch(/(?<!\d)7731(?!\d)/);
  await expect(pp.getByRole("button", { name: "Add stat block" })).toHaveCount(0);

  expect((await api(page, "character_save", { id, version: made.json.character.version, sheet_public: true }, cid)).status).toBe(200);
  await pp.reload();
  const block = pp.locator(".statblock-card");
  await expect(block).toContainText("7731");
  await expect(block).toContainText("12 / 12");
  await expect(block.getByLabel("HP now")).toHaveCount(0);
  await expect(block.locator("button.sb-roll")).toHaveCount(0);
  expect((await api(pp, "character_field", { id, key: "hp", value: { cur: 1, max: 12 } }, cid)).status).toBe(403);

  // an NPC with a full sheet: the strip and Open sheet, as before, and a GM still presses Edit on it
  const sheet = all.find(t => t.kind === "sheet" && t.starter);
  const other = (await api(page, "entry_save", { name: "The Countess", category: "person" }, cid)).json.id;
  const full = (await api(page, "character_create", { template_id: sheet.id, entry_id: other, kind: "npc", owner_id: 0 }, cid)).json.character;
  expect(full.statblock).toBe(false);
  const firstKey = [...L.fields((await character(page, cid, full.id)).layout).keys()][0];
  expect((await api(page, "character_field", { id: full.id, key: firstKey, value: null }, cid)).json.error).toBe("not_editing");
  await page.goto(`index.html#/c/${cid}/encyclopedia/${other}`);
  await expect(page.locator(".enc-character")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open sheet" })).toBeVisible();
  await expect(page.locator(".statblock-card")).toHaveCount(0);
  // the pickers for a character's sheet offer no stat block
  await page.goto(`index.html#/c/${cid}/characters`);
  await page.getByRole("button", { name: /New character/ }).first().click();
  const pick = page.getByRole("dialog", { name: "New character" }).getByLabel("Template", { exact: true });
  await expect(pick.locator("option").first()).toBeAttached();
  expect(await pick.locator("option", { hasText: "stat block" }).count()).toBe(0);
});

test("Sheet templates: stat blocks have their own list, and a new one is made in the editor for a dice game", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { gm } = await setup(page, browser, null);
  await page.goto("index.html#/templates");
  const kinds = page.getByRole("group", { name: "Kind of template" });
  await expect(page.locator(".template-card").first()).toBeVisible();
  await expect(page.locator(".template-card", { hasText: "Generic stat block" })).toHaveCount(0);
  await kinds.getByRole("button", { name: "NPC stat blocks" }).click();
  await expect(page.locator(".template-card", { hasText: "Generic stat block" })).toBeVisible();
  await expect(page.locator(".template-card", { hasText: "D&D 5e (2024)" })).toHaveCount(0);

  await page.getByRole("button", { name: "+ New stat block" }).click();
  await expect(page.getByRole("heading", { name: "New stat block template" })).toBeVisible();
  const name = `Keeper's block ${gm.id}`;
  await page.getByLabel("Template name").fill(name);
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  await page.getByLabel("Dice game").selectOption("coc7");
  await page.getByLabel("Abilities row").selectOption("row");
  await expect(page.getByRole("button", { name: "Add Holdings page" })).toBeHidden();
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator("body")).toContainText("NPC stat block · picked for campaigns whose dice are set to Call of Cthulhu 7th edition");
  const t = (await templates(page)).find(x => x.name === name);
  expect(t).toMatchObject({ kind: "statblock", dice_game: "coc7" });
  const full = (await (await page.request.get(`api/index.php?a=template&id=${t.id}`)).json()).template;
  expect(full.layout.sections[0].abilities).toBe(true);
  expect(full.layout.sections.some(s => s.holdings)).toBe(false);
  expectNoErrors(errors);
});
