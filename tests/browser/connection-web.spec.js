// The Encyclopedia's connection web and family tree: an entry's neighbours one or two steps out, the whole campaign's
// connections, kinds switched off, a family drawn in generations, and a player never seeing a secret connection. The
// arithmetic (static/web.js) runs under Node; the dialog is checked in every browser, touch ones included.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, pressMore } = require("./helpers");
test.afterEach(closeContexts);
const Web = require(path.join(__dirname, "..", "..", "static", "web.js"));

/** Connections in connIndex's shape for the Node tests: families are [parent, child] and [a, b] partners. */
function world(links) {
  const types = { parent: { id: 1, label: "Parent of", inverse_label: "Child of", symmetric: false, color: "#db2777" },
    partner: { id: 2, label: "Partner of", inverse_label: "", symmetric: true, color: "#be185d" },
    ally: { id: 3, label: "Ally of", inverse_label: "", symmetric: true, color: "#059669" } };
  const names = [...new Set(links.flatMap(l => [l[0], l[1]]))];
  const byId = new Map(names.map((n, i) => [i + 1, { id: i + 1, name: n }]));
  const id = n => names.indexOf(n) + 1;
  const conns = new Map([...byId.keys()].map(k => [k, []]));
  links.forEach(([a, b, t], i) => {
    const T = types[t], r = { id: i + 1, from_id: id(a), to_id: id(b), note: "", is_secret: 0 };
    conns.get(id(a)).push({ r, type: T, side: "from", label: T.label, other: byId.get(id(b)) });
    conns.get(id(b)).push({ r, type: T, side: T.symmetric ? "from" : "to", label: T.symmetric ? T.label : T.inverse_label, other: byId.get(id(a)) });
  });
  return { conns, byId, id };
}

test("the web holds the entries within the steps asked for, and hides a kind of connection", () => {
  const w = world([["Alda", "Bram", "partner"], ["Alda", "Cora", "parent"], ["Cora", "Eve", "ally"], ["Eve", "Fen", "ally"]]);
  const one = Web.neighbourhood(w, w.id("Alda"), 1);
  expect(one.nodes.map(n => n.name)).toEqual(["Alda", "Bram", "Cora"]);
  expect(one.edges).toHaveLength(2);
  const two = Web.neighbourhood(w, w.id("Alda"), 2);
  expect(two.nodes.map(n => `${n.name}${n.depth}`)).toEqual(["Alda0", "Bram1", "Cora1", "Eve2"]);
  // a kind switched off takes with it the entries reached only through it
  const noParents = Web.neighbourhood(w, w.id("Alda"), 2, new Set([1]));
  expect(noParents.nodes.map(n => n.name)).toEqual(["Alda", "Bram"]);
  expect(Web.kinds(two.edges).map(k => `${k.label} ${k.count}`)).toEqual(["Ally of 1", "Parent of 1", "Partner of 1"]);
  // the whole campaign keeps only entries that are connected, and the most connected past the limit
  expect(Web.whole(w).nodes).toHaveLength(5);
  const cut = Web.whole(w, new Set(), 3);
  expect(cut.cut).toBe(2);
  expect(cut.nodes).toHaveLength(3);
});

test("a layout is the same every time, keeps the centre in the middle and stays on the page", () => {
  const w = world([["A", "B", "ally"], ["A", "C", "ally"], ["A", "D", "ally"], ["B", "E", "ally"], ["C", "E", "ally"]]);
  const g = Web.neighbourhood(w, w.id("A"), 2);
  const a = Web.layout(g.nodes, g.edges, { width: 900, height: 600, center: w.id("A") });
  const b = Web.layout(g.nodes, g.edges, { width: 900, height: 600, center: w.id("A") });
  expect([...a]).toEqual([...b]);
  expect(a.get(w.id("A"))).toEqual({ x: 450, y: 300 });
  for (const p of a.values()) { expect(p.x).toBeGreaterThanOrEqual(30); expect(p.x).toBeLessThanOrEqual(870); expect(p.y).toBeGreaterThanOrEqual(30); expect(p.y).toBeLessThanOrEqual(570); }
  // no two entries sit on top of each other
  const pts = [...a.values()];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(20);
});

test("a family is drawn in generations, partners side by side and children under their parents", () => {
  const w = world([["Alda", "Bram", "partner"], ["Alda", "Cora", "parent"], ["Bram", "Cora", "parent"], ["Alda", "Dov", "parent"], ["Bram", "Dov", "parent"],
    ["Cora", "Eve", "parent"], ["Cora", "Fen", "partner"], ["Fen", "Eve", "parent"], ["Gus", "Hal", "ally"]]);
  const f = Web.familyTree(w, w.id("Cora"));
  const at = n => f.nodes.find(x => x.name === n);
  expect(f.nodes.map(n => n.name).sort()).toEqual(["Alda", "Bram", "Cora", "Dov", "Eve", "Fen"]);   // Gus and Hal are not family
  expect(["Alda", "Bram"].map(n => at(n).y)).toEqual([0, 0]);
  expect(["Cora", "Dov", "Fen"].map(n => at(n).y)).toEqual([1, 1, 1]);
  expect(at("Eve").y).toBe(2);
  expect(Math.abs(at("Alda").x - at("Bram").x)).toBe(1);                       // partners are neighbours
  expect(Math.abs(at("Cora").x - at("Fen").x)).toBe(1);
  expect(f.edges.filter(e => e.kind === "partner")).toHaveLength(2);
  expect(f.edges.filter(e => e.kind === "parent")).toHaveLength(6);
  expect(Web.hasFamily(w, w.id("Gus"))).toBe(false);
  expect(Web.hasFamily(w, w.id("Cora"))).toBe(true);
  expect(Web.roleOf("Mother of")).toBe("parent");
  expect(Web.roleOf("Married to")).toBe("partner");
  expect(Web.roleOf("Ally of")).toBeNull();
});

test("the web dialog opens from an entry and from the menu, follows a click, and a player never sees a secret connection", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Wren"), player = person("Ash");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Web ${gm.id}`);
  const ok = async (action, body) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const entry = async (name, extra = {}) => (await ok("entry_save", { name, notes: `<p>${name}.</p>`, ...extra })).id ?? (await ok("encyclopedia")).entries.find(e => e.name === name).id;
  const ids = {};
  for (const n of ["Alda", "Bram", "Cora", "Dov", "Mira"]) ids[n] = await entry(n);
  ids.Vault = await entry("The Vault", { is_secret: true });
  const link = (from, type, add, extra = {}) => ok("relations_save", { entry_id: ids[from], type, add: add.map(n => ids[n]), ...extra });
  await link("Alda", { label: "Partner of", symmetric: true }, ["Bram"]);
  await link("Alda", { label: "Parent of", inverse_label: "Child of" }, ["Cora"]);
  await link("Bram", { label: "Parent of", inverse_label: "Child of" }, ["Cora"]);
  await link("Cora", { label: "Ally of", symmetric: true }, ["Dov"]);
  await link("Dov", { label: "Ally of", symmetric: true }, ["Mira"]);
  await link("Alda", { label: "Ally of", symmetric: true }, ["Mira"], { is_secret: true });

  await page.goto(`index.html#/c/${cid}/encyclopedia/${ids.Cora}`);
  await page.getByRole("button", { name: "🕸 Web" }).click();
  const dlg = page.locator("dialog.web-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("[data-node]")).toHaveCount(4);                       // Cora, her parents and Dov
  await dlg.getByRole("button", { name: "2 steps" }).click();
  await expect(dlg.locator("[data-node]")).toHaveCount(5);                       // and Mira, through Dov or Alda
  // a kind switched off hides what only it reached
  await dlg.locator("[data-kind]", { hasText: "Ally of" }).click();
  await expect(dlg.locator("[data-node]")).toHaveCount(3);
  await dlg.locator("[data-kind]", { hasText: "Ally of" }).click();
  await expect(dlg.locator("[data-node]")).toHaveCount(5);
  // a click says how the entry is connected, and Centre here moves the picture
  await dlg.locator(`[data-node="${ids.Dov}"]`).click();
  await expect(dlg.locator(".web-panel h4")).toHaveText("Dov");
  await expect(dlg.locator(".web-panel")).toContainText("Mira");
  await dlg.getByRole("button", { name: "Centre here" }).click();
  await expect(dlg.locator("h3")).toHaveText("Dov: connections");
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);

  // the family tree is offered where there is family, and not where there is none
  await page.getByRole("button", { name: "🌳 Family" }).click();
  await expect(dlg.locator("h3")).toHaveText("Cora: family");
  await expect(dlg.locator("[data-node]")).toHaveCount(3);                       // Cora and her two parents
  const box = id => dlg.locator(`[data-node="${id}"]`).boundingBox();
  const [a, c] = [await box(ids.Alda), await box(ids.Cora)];
  expect(c.y).toBeGreaterThan(a.y + 20);                                         // children below parents
  await dlg.getByRole("button", { name: "Close" }).click();
  await page.goto(`index.html#/c/${cid}/encyclopedia/${ids.Mira}`);
  await expect(page.getByRole("button", { name: "🌳 Family" })).toHaveCount(0);

  // the whole campaign, from the list's menu
  await pressMore(page, "Encyclopedia", "🕸 Campaign web");
  await expect(dlg.locator("h3")).toContainText("every connection");
  await expect(dlg.locator("[data-node]")).toHaveCount(5);                       // The Vault has no connections
  expect(await dlg.locator("[data-edge]").count()).toBe(6);
  await dlg.getByRole("button", { name: "Close" }).click();
  expectNoErrors(errors);

  // a player's web leaves out the GM-only connection (Alda and Mira)
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  await ok("member_add", { email: player.email, role: "player" });
  await pp.goto(`index.html#/c/${cid}/encyclopedia/${ids.Alda}`);
  await pp.getByRole("button", { name: "🕸 Web" }).click();
  const pd = pp.locator("dialog.web-dialog");
  await expect(pd.locator("[data-node]")).toHaveCount(3);                        // Alda, Bram and Cora, not Mira
  await expect(pd.locator(`[data-node="${ids.Mira}"]`)).toHaveCount(0);
  expectNoErrors(perrors);
});
