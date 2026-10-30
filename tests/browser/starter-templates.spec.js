// The starter library: one JSON file per game in db/starter-templates/, each a valid layout with the source it was
// built from, loaded (and loaded again after changes) by a site admin. They show "Campaign Chronicle" as author;
// anyone can fork one, nobody but an admin can change one.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { person, signIn, approve, api, sql, ADMIN, newContext, closeContexts } = require("./helpers");
const L = require(path.join(__dirname, "..", "..", "static", "sheetlayout.js"));
test.afterEach(closeContexts);

const DIR = path.join(__dirname, "..", "..", "db", "starter-templates");
const files = () => fs.readdirSync(DIR).filter(f => f.endsWith(".json")).sort();

test("Starter files: about forty, each a valid layout with its source, named by its key", () => {
  expect(files().length).toBeGreaterThanOrEqual(30);
  for (const f of files()) {
    expect(f, "file names are the starter key").toMatch(/^[a-z0-9][a-z0-9-]{0,74}\.json$/);
    const t = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    expect(typeof t.name === "string" && t.name.trim() && t.name.length <= 150, `${f}: name`).toBeTruthy();
    expect(typeof t.game === "string" && t.game.trim() && t.game.length <= 100, `${f}: game`).toBeTruthy();
    expect(L.validate(t.layout), f).toEqual([]);
    expect(L.fields(t.layout).size, `${f}: has fields`).toBeGreaterThan(3);
    expect(t.source && typeof t.source.title === "string" && typeof t.source.owner === "string" && /^https?:\/\//.test(t.source.url), `${f}: source`).toBeTruthy();
    // labels only: no rules text
    for (const [, { field }] of L.fields(t.layout)) expect(field.label.length, `${f}: ${field.label}`).toBeLessThanOrEqual(60);
  }
});

test("Starter templates load, and loading again updates", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "chromium", "the server answers the same whatever the browser");
  await signIn(page, ADMIN);
  sql("DELETE FROM sheet_templates WHERE starter_key IS NOT NULL AND id NOT IN (SELECT template_id FROM sheet_characters)");
  const first = await api(page, "starter_templates_load", {});
  expect(first.status).toBe(200);
  const n = Number(sql("SELECT COUNT(*) FROM sheet_templates WHERE starter_key IS NOT NULL").trim());
  expect(n).toBe(files().length);
  expect(first.json.added + first.json.updated + first.json.unchanged).toBe(files().length);
  const again = await api(page, "starter_templates_load", {});
  expect(again.json).toEqual({ ok: true, added: 0, updated: 0, unchanged: files().length });

  const key = files()[0].replace(/\.json$/, "");
  sql(`UPDATE sheet_templates SET layout='{"sections":[]}' WHERE starter_key='${key}'`);
  expect((await api(page, "starter_templates_load", {})).json).toMatchObject({ added: 0, updated: 1 });

  const who = person("Sol");
  const pp = await (await newContext(browser)).newPage();
  await signIn(pp, who);
  await approve(browser, who.email);
  expect((await api(pp, "starter_templates_load", {})).status).toBe(403);
  const list = (await pp.request.get("api/index.php?a=templates")).ok() && (await (await pp.request.get("api/index.php?a=templates")).json()).templates;
  const starter = list.find(t => t.starter);
  expect(starter.author).toBe("Campaign Chronicle");
  expect(starter.can_edit).toBe(false);
  expect((await api(pp, "template_save", { id: starter.id, version: starter.version, name: "Mine now", game: starter.game, layout: { sections: [] } })).status).toBe(403);
  const fork = await api(pp, "template_fork", { id: starter.id });
  expect(fork.status).toBe(200);
  expect(fork.json.template.forked_from.id).toBe(starter.id);
});

test("About lists each starter template's game and source, and says they aren't endorsed", async ({ page }) => {
  await page.goto("index.html#/about");
  const about = page.locator("section.about", { hasText: "Starter templates" });
  await expect(about).toContainText("Not affiliated with or endorsed by the publishers.");
  const first = JSON.parse(fs.readFileSync(path.join(DIR, files()[0]), "utf8"));
  await expect(about).toContainText(first.game);
});
