// Character sheets through the API: the tables and their upgrade step, the site-wide template library (forks, only
// the author edits), and characters in a campaign (each with an Encyclopedia entry, PC or NPC, hidden fields, the
// active character's name, who else is on a sheet, and the GM's Edit button).
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const path = require("path");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const ROOT = path.join(__dirname, "..", "..");

test("Sheets: a fresh database has the tables, and the upgrade finds nothing left to do", async ({ page, browser }) => {
  const tables = sql("SHOW TABLES LIKE 'sheet\\_%'; SHOW TABLES LIKE 'characters';").trim().split("\n");
  for (const t of ["sheet_templates", "sheet_presence", "characters"]) expect(tables).toContain(t);
  expect(sql("SHOW COLUMNS FROM campaign_members LIKE 'active_character_id'").trim()).not.toBe("");
  const gm = person("Hob");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Sheets ready");
  expect((await api(page, "campaign", undefined, cid)).json.sheets_ready).toBe(true);
  // The step is listed for older installs, and the test database needs nothing more.
  const env = { ...process.env, CHRONICLE_CONFIG: path.join(ROOT, "tests", "support", "config.test.php") };
  const steps = execFileSync("php", ["-r", `require '${ROOT}/api/upgrade.php'; echo implode("\\n", array_column(upgrade_steps(), 0));`], { env }).toString();
  expect(steps).toContain("023_character_sheets.sql");
  execFileSync("php", [path.join(ROOT, "tools", "migrate.php"), "--check"], { env });
});

/** A small valid layout: Stats (a number and a Play counter) and Background (long text). */
const LAYOUT = () => ({ sections: [
  { key: "stats", title: "Stats", fields: [{ key: "str", label: "Strength", type: "number" }, { key: "hp", label: "HP", type: "counter", play: true }] },
  { key: "background", title: "Background", fields: [{ key: "past", label: "Past", type: "longtext" }] },
] });

/** A read with query parameters, as whoever $page is signed in as. */
async function get(page, action, params = {}, cid) {
  const qs = new URLSearchParams({ a: action, ...(cid ? { cid } : {}), ...params });
  const res = await page.request.get(`api/index.php?${qs}`);
  return { status: res.status(), json: await res.json() };
}

/** Two approved accounts, each on its own page. */
async function twoPeople(page, browser) {
  const a = person("Ada"), b = person("Bram");
  await signIn(page, a);
  await approve(browser, a.email);
  const pb = await (await newContext(browser)).newPage();
  await signIn(pb, b);
  await approve(browser, b.email);
  return { pa: page, pb };
}

test("Templates: anyone makes, lists and forks one; only the author edits it", async ({ page, browser }) => {
  const { pa, pb } = await twoPeople(page, browser);
  const name = `Test RPG ${Date.now()}`;
  const made = await api(pa, "template_save", { name, game: "Test RPG", edition: "1e", layout: LAYOUT() });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const id = made.json.template.id;
  expect(made.json.template).toMatchObject({ name, game: "Test RPG", mine: true, can_edit: true, uses: 0, forks: 0, forked_from: null, version: 1 });

  const listed = (await api(pb, "templates", undefined)).json.templates.find(t => t.id === id);
  expect(listed).toMatchObject({ mine: false, can_edit: false, author: "Ada" });
  const edit = await api(pb, "template_save", { id, name: "Mine now", game: "Test RPG", layout: LAYOUT(), version: 1 });
  expect(edit.status).toBe(403);
  expect(edit.json.message).toBe("Only its author can change this template. Fork it to make your own");

  const fork = await api(pb, "template_fork", { id });
  expect(fork.status).toBe(200);
  expect(fork.json.template).toMatchObject({ name, mine: true, forked_from: { id, name } });
  const full = (await api(pa, "template", undefined)).status; // a GET with no id is refused
  expect(full).toBe(400);
  const one = await get(pa, "template", { id });
  expect(one.json.template.forks).toBe(1);
  expect(one.json.template.layout).toEqual(LAYOUT());
  expect(one.json.forks.map(f => f.id)).toEqual([fork.json.template.id]);

  // Unlisted: gone from B's search, but B's fork still says where it came from.
  expect((await api(pa, "template_save", { id, name, game: "Test RPG", layout: LAYOUT(), is_listed: false, version: 1 })).status).toBe(200);
  const bList = (await api(pb, "templates", undefined)).json.templates;
  expect(bList.find(t => t.id === id)).toBeUndefined();
  expect(bList.find(t => t.id === fork.json.template.id).forked_from).toEqual({ id, name });
  expect((await api(pa, "templates", undefined)).json.templates.find(t => t.id === id)).toBeTruthy(); // its author still sees it
  // Search by game.
  const q = (await get(pb, "templates", { q: "Test RPG" })).json.templates;
  expect(q.length).toBeGreaterThan(0);
  expect(q.every(t => /Test RPG/.test(t.name + t.game))).toBe(true);
});

test("Templates: bad layouts are refused, naming the problem", async ({ page }) => {
  await signIn(page, person("Cass"));
  await approve(page.context().browser(), (await (await page.request.get("api/auth/me.php")).json()).email);
  const bad = LAYOUT(); bad.sections[0].fields[0].type = "dice";
  const r = await api(page, "template_save", { name: "Bad", game: "X", layout: bad });
  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/dice/);
  const many = { sections: [{ key: "s", title: "S", fields: Array.from({ length: 1001 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" })) }] };
  expect((await api(page, "template_save", { name: "Big", game: "X", layout: many })).status).toBe(400);
  expect((await api(page, "template_save", { name: "", game: "X", layout: LAYOUT() })).status).toBe(400);
});

test("Templates: a save from an older copy is refused", async ({ page }) => {
  await signIn(page, person("Dov"));
  await approve(page.context().browser(), (await (await page.request.get("api/auth/me.php")).json()).email);
  const id = (await api(page, "template_save", { name: "Stale", game: "X", layout: LAYOUT() })).json.template.id;
  expect((await api(page, "template_save", { id, name: "Stale 2", game: "X", layout: LAYOUT(), version: 1 })).json.template.version).toBe(2);
  const r = await api(page, "template_save", { id, name: "Stale 3", game: "X", layout: LAYOUT(), version: 1 });
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("stale");
});

/** A GM and two players in a new campaign, and a template (LAYOUT) the GM made. */
async function party(page, browser) {
  const gm = person("Gail"), p1 = person("Pip"), p2 = person("Quin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Sheets ${gm.id}`);
  const pages = {};
  for (const [k, who] of [["p1", p1], ["p2", p2]]) {
    pages[k] = await (await newContext(browser)).newPage();
    await signIn(pages[k], who);
    await approve(browser, who.email);
    expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
  }
  const tpl = (await api(page, "template_save", { name: `Party ${gm.id}`, game: "Test RPG", layout: LAYOUT() })).json.template;
  const ids = {};
  for (const [k, p] of [["gm", page], ["p1", pages.p1], ["p2", pages.p2]]) ids[k] = (await (await p.request.get("api/auth/me.php")).json()).id;
  return { cid, gm: page, p1: pages.p1, p2: pages.p2, tpl, ids };
}
const make = async (p, cid, body) => {
  const r = await api(p, "character_create", body, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.character;
};
const sheet = async (p, cid, id) => get(p, "character", { id }, cid);
/** The GM presses Edit on a sheet that isn't theirs. */
const gmEdit = (gm, cid, id) => api(gm, "character_presence", { id, editing: true, since: null }, cid);

test("Characters: a player makes a PC; the party sees it; hidden fields stay hidden", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Brannoc" });
  expect(c).toMatchObject({ name: "Brannoc", kind: "pc", sheet_visible: true, can_edit: true, template: { id: tpl.id, game: "Test RPG" } });
  expect((await api(p1, "character_field", { id: c.id, key: "str", value: 14 }, cid)).json).toEqual({ ok: true, value: 14 });
  expect((await api(p1, "character_field", { id: c.id, key: "past", value: "Raised by wolves" }, cid)).status).toBe(200);
  expect((await api(p1, "character_field", { id: c.id, key: "hp", value: { cur: 9, max: 12 } }, cid)).status).toBe(200);
  expect((await api(p1, "character_field", { id: c.id, key: "nope", value: 1 }, cid)).status).toBe(400);
  expect((await api(p1, "character_field", { id: c.id, key: "hp", value: 9 }, cid)).status).toBe(400);
  const v = (await sheet(p1, cid, c.id)).json.character.version;
  expect((await api(p1, "character_save", { id: c.id, version: v, hidden: ["background"] }, cid)).status).toBe(200);

  const seen = await sheet(p2, cid, c.id);
  expect(seen.json.character.values).toEqual({ str: 14, hp: { cur: 9, max: 12 } });
  expect(JSON.stringify(seen.json)).not.toContain("wolves");
  expect(seen.json.character.hidden).toBeUndefined();
  expect(seen.json.character.can_edit).toBe(false);
  expect((await api(p2, "character_field", { id: c.id, key: "str", value: 3 }, cid)).status).toBe(403);
  const card = (await get(p2, "characters", {}, cid)).json.characters.find(x => x.id === c.id);
  expect(card.play).toEqual([{ key: "hp", label: "HP", type: "counter", value: { cur: 9, max: 12 } }]);
  expect((await sheet(gm, cid, c.id)).json.character.values.past).toBe("Raised by wolves");
});

test("Characters: an NPC sheet is GM-only until shown to players", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const n = await make(gm, cid, { template_id: tpl.id, name: "The Countess", kind: "npc" });
  expect(n).toMatchObject({ kind: "npc", sheet_public: false });
  expect((await api(gm, "character_field", { id: n.id, key: "str", value: 18 }, cid)).status).toBe(200);
  const card = (await get(p1, "characters", {}, cid)).json.characters.find(x => x.id === n.id);
  expect(card).toMatchObject({ sheet_visible: false, play: [], summary: [] });
  const s = await sheet(p1, cid, n.id);
  expect(s.json.character.values).toBeNull();
  expect(JSON.stringify(s.json)).not.toContain("18");
  expect((await api(gm, "character_save", { id: n.id, version: n.version, sheet_public: true }, cid)).status).toBe(200);
  expect((await sheet(p1, cid, n.id)).json.character.values).toEqual({ str: 18 });
  // A player can't make an NPC, or a character for someone else.
  expect((await api(p1, "character_create", { template_id: tpl.id, name: "Henchman", kind: "npc" }, cid)).status).toBe(403);
});

test("Characters: every character has an Encyclopedia entry, and renames follow it", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Wren" });
  let enc = (await api(p1, "encyclopedia", undefined, cid)).json;
  const entry = enc.entries.find(e => e.id === c.entry_id);
  expect(entry).toMatchObject({ name: "Wren", category: "person" });
  expect(enc.characters[c.entry_id]).toEqual({ id: c.id, kind: "pc", sheet_visible: true });
  expect((await api(p1, "character_save", { id: c.id, version: c.version, name: "Wren Ashdown" }, cid)).status).toBe(200);
  enc = (await api(p1, "encyclopedia", undefined, cid)).json;
  expect(enc.entries.find(e => e.id === c.entry_id).name).toBe("Wren Ashdown");
  // The same name as another entry is refused.
  expect((await api(gm, "character_create", { template_id: tpl.id, name: "Wren Ashdown" }, cid)).status).toBe(409);
  // The entry can't go while the sheet uses it; deleting the sheet keeps the entry.
  const del = await api(gm, "entry_delete", { id: c.entry_id }, cid);
  expect(del.status).toBe(409);
  expect(del.json.message).toBe("Delete its character sheet first");
  expect((await api(p1, "character_delete", { id: c.id }, cid)).status).toBe(200);
  enc = (await api(p1, "encyclopedia", undefined, cid)).json;
  expect(enc.entries.find(e => e.id === c.entry_id)).toBeTruthy();
  expect(enc.characters[c.entry_id]).toBeUndefined();
  // A template some character uses can't be deleted (Task 3).
  await make(p1, cid, { template_id: tpl.id, name: "Fen" });
  const tdel = await api(gm, "template_delete", { id: tpl.id });
  expect(tdel.status).toBe(409);
  expect(tdel.json.message).toBe("Characters use this template. Unlist it instead");
});

test("Characters: a GM adds a sheet to an NPC entry that already exists", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const e = (await api(gm, "entry_save", { name: "Old Mother Hoff", notes: "" }, cid)).json.id;
  expect((await api(p1, "character_create", { template_id: tpl.id, entry_id: e }, cid)).status).toBe(403);
  const n = await make(gm, cid, { template_id: tpl.id, entry_id: e, kind: "npc" });
  expect(n).toMatchObject({ entry_id: e, name: "Old Mother Hoff" });
  expect((await api(gm, "character_create", { template_id: tpl.id, entry_id: e }, cid)).status).toBe(409);
});

test("Characters: the active character's name is the one shown for its player", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Thorn" });
  expect((await api(p1, "member_active_character", { character_id: c.id }, cid)).status).toBe(200);
  const nameOf = async () => (await api(gm, "campaign", undefined, cid)).json.members.find(m => m.id === ids.p1).character_name;
  expect(await nameOf()).toBe("Thorn");
  expect((await api(p1, "character_save", { id: c.id, version: c.version, name: "Thorn Blackwood" }, cid)).status).toBe(200);
  expect(await nameOf()).toBe("Thorn Blackwood");
  // Typing a character name renames the active character, and its entry.
  expect((await api(p1, "member_character", { character_name: "Zed" }, cid)).status).toBe(200);
  expect(await nameOf()).toBe("Zed");
  expect((await sheet(p1, cid, c.id)).json.character.name).toBe("Zed");
  // Someone else's character can't be your active one.
  const g = await make(gm, cid, { template_id: tpl.id, name: "Guard", kind: "npc" });
  expect((await api(p1, "member_active_character", { character_id: g.id }, cid)).status).toBe(403);
});

test("Characters: PC and NPC switch back and forth, and the sheet changes hands", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Ivo" });
  let r = await api(gm, "character_save", { id: c.id, version: c.version, kind: "npc", owner_id: ids.gm }, cid);
  expect(r.json.character).toMatchObject({ kind: "npc", owner: { id: ids.gm }, sheet_public: false });
  expect((await api(p1, "character_field", { id: c.id, key: "str", value: 1 }, cid)).status).toBe(403);
  r = await api(gm, "character_save", { id: c.id, version: r.json.character.version, kind: "pc", owner_id: ids.p1 }, cid);
  expect(r.json.character).toMatchObject({ kind: "pc", owner: { id: ids.p1 } });
  expect((await api(p1, "character_field", { id: c.id, key: "str", value: 1 }, cid)).status).toBe(200);
  // An owner may hand their sheet to a GM, but not to another player.
  expect((await api(p1, "character_save", { id: c.id, version: r.json.character.version, owner_id: ids.p2 }, cid)).status).toBe(403);
});

test("Characters: two people change different fields at once; settings refuse an old copy", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Sable" });
  await gmEdit(gm, cid, c.id);
  expect((await api(p1, "character_field", { id: c.id, key: "hp", value: { cur: 4, max: 10 } }, cid)).status).toBe(200);
  expect((await api(gm, "character_field", { id: c.id, key: "str", value: 16 }, cid)).status).toBe(200);
  expect((await sheet(p1, cid, c.id)).json.character.values).toEqual({ hp: { cur: 4, max: 10 }, str: 16 });
  expect((await api(p1, "character_save", { id: c.id, version: c.version, name: "Sable Two" }, cid)).status).toBe(200);
  const stale = await api(gm, "character_save", { id: c.id, version: c.version, name: "Sable Three" }, cid);
  expect(stale.status).toBe(409);
  expect(stale.json.error).toBe("stale");
});

test("Characters: a template change moves a value that no longer fits to old fields", async ({ page, browser }) => {
  const { cid, gm, p1, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Moss" });
  await api(p1, "character_field", { id: c.id, key: "str", value: 12 }, cid);
  const changed = LAYOUT(); changed.sections[0].fields[0].type = "counter";
  expect((await api(gm, "template_save", { id: tpl.id, name: tpl.name, game: "Test RPG", layout: changed, version: tpl.version })).status).toBe(200);
  const s = (await sheet(p1, cid, c.id)).json;
  expect(s.template_changed).toBe(true);
  expect(s.character.old).toEqual([{ key: "str", value: 12 }]);
  expect(s.character.values).toEqual({});
  expect((await sheet(p1, cid, c.id)).json.template_changed).toBe(false); // seen now
});

test("Characters: a removed member's sheets stay, for the GM to edit and hand on", async ({ page, browser }) => {
  const { cid, gm, p1, tpl, ids } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Lark" });
  expect((await api(gm, "member_remove", { user_id: ids.p1 }, cid)).status).toBe(200);
  expect((await sheet(p1, cid, c.id)).status).toBe(403);
  const card = (await get(gm, "characters", {}, cid)).json.characters.find(x => x.id === c.id);
  expect(card).toMatchObject({ owner: { id: ids.p1 }, owner_in_campaign: false });
  await gmEdit(gm, cid, c.id);
  expect((await api(gm, "character_field", { id: c.id, key: "str", value: 10 }, cid)).status).toBe(200);
  const r = await api(gm, "character_save", { id: c.id, version: c.version, owner_id: ids.p2 }, cid);
  expect(r.json.character.owner.id).toBe(ids.p2);
});

test("Characters: who else is on a sheet, and the GM's Edit button", async ({ page, browser }) => {
  const { cid, gm, p1, p2, tpl } = await party(page, browser);
  const c = await make(p1, cid, { template_id: tpl.id, name: "Rook" });
  const first = (await api(p1, "character_presence", { id: c.id, editing: false, since: null }, cid)).json;
  expect(first.viewers).toEqual([]);
  // Without pressing Edit, the GM can look but not change a player's sheet.
  await api(gm, "character_presence", { id: c.id, editing: false, since: null }, cid);
  const no = await api(gm, "character_field", { id: c.id, key: "str", value: 9 }, cid);
  expect(no.status).toBe(409);
  expect(no.json).toMatchObject({ error: "not_editing", message: "Press Edit first" });
  await gmEdit(gm, cid, c.id);
  expect((await api(gm, "character_field", { id: c.id, key: "str", value: 9 }, cid)).status).toBe(200);
  const next = (await api(p1, "character_presence", { id: c.id, editing: false, since: first.stamp }, cid)).json;
  expect(next.viewers).toEqual([{ name: "Gail", role: "gm", editing: true }]);
  expect(next.changes).toEqual({ str: { value: 9, by: "Gail" } });
  // Another player can't claim to be editing.
  await api(p2, "character_presence", { id: c.id, editing: true, since: null }, cid);
  expect((await api(p1, "character_presence", { id: c.id, editing: false, since: next.stamp }, cid)).json.viewers)
    .toContainEqual({ name: "Quin", role: "player", editing: false });
  // Someone not seen for over 40 seconds isn't listed.
  sql(`UPDATE sheet_presence SET seen_at = NOW() - INTERVAL 41 SECOND WHERE character_id=${c.id}`);
  expect((await api(p1, "character_presence", { id: c.id, editing: false, since: null }, cid)).json.viewers).toEqual([]);
});
