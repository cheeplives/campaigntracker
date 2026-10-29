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
