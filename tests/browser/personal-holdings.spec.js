// A character sheet's Holdings page: the character's own funds, gear and holdings, drawn by the same code as Party →
// Holdings and kept in the same tables under the character's id. Its player and the GMs change it; the rest of the
// party see it (locked) unless its player hides it; the party's holdings never show the character's, nor the other way.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, notNow, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const LAYOUT = () => ({ sections: [
  { key: "stats", title: "Stats", fields: [{ key: "str", label: "Strength", type: "number" }] },
  { key: "personal_holdings", title: "Personal Holdings", page: "Holdings", holdings: true, fields: [] },
] });

/** A GM and two players (Pip, Quin) in one campaign, with a template that has a Holdings page, and Pip's character. */
async function party(page, browser) {
  const gm = person("Gail"), p1 = person("Pip"), p2 = person("Quin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Personal holdings ${gm.id}`);
  const pages = {};
  for (const [k, who] of [["p1", p1], ["p2", p2]]) {
    pages[k] = await (await newContext(browser, { serviceWorkers: "block" })).newPage();
    await signIn(pages[k], who);
    await approve(browser, who.email);
    expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
  }
  const tpl = (await api(page, "template_save", { name: `Holdings sheet ${gm.id}`, game: "Test RPG", layout: LAYOUT() })).json.template;
  const ch = (await api(pages.p1, "character_create", { template_id: tpl.id, name: "Brannoc" }, cid)).json.character;
  return { cid, gm: page, p1: pages.p1, p2: pages.p2, ch };
}
/** The holdings of character id, as p reads them. */
async function mine(p, cid, id) {
  const res = await p.request.get(`api/index.php?${new URLSearchParams({ a: "holdings", cid, character_id: id })}`);
  return { status: res.status(), json: await res.json() };
}

test("A character's Holdings page works like Party → Holdings, for that character alone", async ({ page, browser }) => {
  const { cid, gm, p1, p2, ch } = await party(page, browser);
  const errors = watchErrors(p1);
  await p1.goto(`index.html#/c/${cid}/characters/${ch.id}`);
  await p1.getByRole("tab", { name: "Holdings" }).click();
  const sheet = p1.locator(".sheet-holdings");
  await expect(sheet.getByRole("heading", { name: "Personal Funds" })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Gear and Loot" })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: /^Holdings/ })).toBeVisible();
  await expect(p1.getByLabel("Strength", { exact: true })).toBeHidden();

  // money, gear and a holding with its storage, as on the party's page
  await sheet.getByLabel("New currency", { exact: true }).fill("Gold pieces");
  await sheet.locator(".funds").getByRole("button", { name: "+ Add" }).click();
  await expect(sheet.locator(".funds .ledger-rows .ledger-row")).toHaveCount(1);
  await sheet.getByLabel("New item", { exact: true }).fill("Lantern");
  await sheet.locator(".gear").getByRole("button", { name: "+ Add" }).click();
  await expect(sheet.locator(".gear .gear-rows .gear-row")).toHaveCount(1);
  await sheet.locator(".gear-row").getByRole("button", { name: /one more/ }).click();
  await expect.poll(async () => (await mine(p1, cid, ch.id)).json.gear[0]?.amount).toBe(2);
  await sheet.getByRole("button", { name: "+ New holding" }).click();
  const dlg = p1.locator("dialog.hold-dialog");
  await dlg.getByLabel("Holding Name").fill("Old Bess");
  await dlg.getByLabel("Type", { exact: true }).selectOption("animal");
  await dlg.getByRole("button", { name: "Add holding" }).click();
  await notNow(p1); // its name goes to the Feature Highlighter, as on the party's page
  // the sheet stays on its Holdings page, with the new card open
  await expect(p1.getByRole("tab", { name: "Holdings" })).toHaveAttribute("aria-selected", "true");
  const card = sheet.locator(".holding");
  await expect(card).toContainText("Old Bess");
  await card.getByLabel("New item in Old Bess's storage").fill("Saddlebags");
  await card.getByRole("button", { name: "+ Add" }).click();
  await expect.poll(async () => (await mine(p1, cid, ch.id)).json.holdings[0]?.storage.map(s => s.item)).toEqual(["Saddlebags"]);

  const own = (await mine(p1, cid, ch.id)).json;
  expect(own.funds.map(f => f.currency)).toEqual(["Gold pieces"]);
  expect(own.gear.map(g => g.item)).toEqual(["Lantern"]);
  expect(own.holdings.map(h => h.name)).toEqual(["Old Bess"]);
  // the party's are apart
  const partys = (await api(p1, "holdings", undefined, cid)).json;
  expect([partys.funds.length, partys.gear.length, partys.holdings.length]).toEqual([0, 0, 0]);
  expect((await api(p1, "gear_save", { item: "Party rope" }, cid)).status).toBe(200);
  expect((await mine(p1, cid, ch.id)).json.gear.map(g => g.item)).toEqual(["Lantern"]);
  // a row of the character's can't be changed as the party's, nor the other way
  expect((await api(p1, "gear_tick", { id: own.gear[0].id, delta: 1 }, cid)).status).toBe(404);
  const rope = (await api(p1, "holdings", undefined, cid)).json.gear[0];
  expect((await api(p1, "gear_tick", { id: rope.id, delta: 1, character_id: ch.id }, cid)).status).toBe(404);

  // another player sees it, locked, and can't change it
  await p2.goto(`index.html#/c/${cid}/characters/${ch.id}`);
  await p2.getByRole("tab", { name: "Holdings" }).click();
  const theirs = p2.locator(".sheet-holdings");
  await expect(theirs.locator(".gear-row:not(.gear-head) .gear-item")).toHaveValue("Lantern");
  await expect(theirs.locator(".gear-row:not(.gear-head) .gear-item")).toBeDisabled();
  await expect(theirs.getByRole("button", { name: "+ New holding" })).toHaveCount(0);
  await expect(theirs.locator(".add-line")).toHaveCount(0);
  await expect(theirs.locator(".holding")).toContainText("Old Bess");
  expect((await api(p2, "gear_save", { item: "Stolen", character_id: ch.id }, cid)).status).toBe(403);
  // the GM can
  expect((await api(gm, "funds_save", { currency: "Silver", amount: 3, character_id: ch.id }, cid)).status).toBe(200);

  // hidden from the party, the others can't read it at all
  await p1.getByRole("button", { name: "Hide the Personal Holdings section from the party" }).click();
  await expect(p1.getByRole("button", { name: "Show the Personal Holdings section to the party" })).toBeVisible();
  expect((await mine(p2, cid, ch.id)).status).toBe(404);
  expect((await mine(gm, cid, ch.id)).status).toBe(200);

  // deleting the character takes its holdings with it, and leaves the party's
  expect((await api(p1, "character_delete", { id: ch.id }, cid)).status).toBe(200);
  expect(Number(sql(`SELECT (SELECT COUNT(*) FROM party_gear WHERE character_id=${ch.id}) + (SELECT COUNT(*) FROM holdings WHERE character_id=${ch.id}) + (SELECT COUNT(*) FROM party_funds WHERE character_id=${ch.id})`).trim())).toBe(0);
  expect((await api(p1, "holdings", undefined, cid)).json.gear.map(g => g.item)).toEqual(["Party rope"]);
  expectNoErrors(errors);
});

test("Templates: one Holdings section at most, with no fields; a new template starts with one", async ({ page, browser }) => {
  const gm = person("Tess");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const bad = (sections, msg) => api(page, "template_save", { name: "Bad", game: "Test RPG", layout: { sections } }).then(r => {
    expect(r.status).toBe(400);
    expect(r.json.message).toContain(msg);
  });
  const h = (key, fields = []) => ({ key, title: "Holdings", page: "Holdings", holdings: true, fields });
  await bad([h("a"), h("b")], "one Holdings section");
  await bad([h("a", [{ key: "x", label: "X", type: "text" }])], "no fields of its own");

  await page.goto("index.html#/templates/new");
  await expect(page.locator(".sheet-ed-section")).toHaveCount(2);
  await expect(page.locator(".sheet-ed-section").nth(1)).toContainText("The Holdings page");
  await expect(page.getByRole("button", { name: "Add Holdings page" })).toBeHidden();
  await expect(page.locator(".sheet-preview").getByRole("tab", { name: "Holdings" })).toBeVisible();
  await page.locator(".sheet-ed-section").nth(1).getByRole("button", { name: "Remove section" }).click();
  await expect(page.getByRole("button", { name: "Add Holdings page" })).toBeVisible();
});
