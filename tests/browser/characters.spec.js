// The Characters tab, a character's sheet and its Play view: making a character, filling it in and finding it again,
// hiding a section from the party, quick taps at the table, NPC sheets the players don't see, handing a sheet to
// another player, and two people on one sheet (each named in the other's bar, the GM pressing Edit first, and a
// change showing up on the other open sheet at the next check).
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
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
  for (const [k, who] of [["p1", p1], ["p2", p2]]) {
    pages[k] = await (await newContext(browser)).newPage();
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
const stored = (id, key) => JSON.parse(sql(`SELECT JSON_EXTRACT(field_values, '$.${key}') FROM characters WHERE id=${id}`).trim() || "null");
const presenceChecked = p => p.waitForResponse(r => r.url().includes("a=character_presence"));
/** The GM has pressed Edit on character id (through the API). */
const gmEditing = (gm, cid, id) => api(gm, "character_presence", { id, editing: true, since: null }, cid);

test("Characters: a player makes one, fills it in, finds it again, and hides a section", async ({ page, browser }) => {
  const { cid, p1, p2, tpl } = await party(page, browser);
  await p1.goto(`index.html#/c/${cid}/characters`);
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
  await expect.poll(() => Number(sql(`SELECT owner_id FROM characters WHERE id=${c.id}`).trim())).toBe(ids.p2);
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
  await expect(gm.locator(".sheet-viewers")).toContainText("Pip is also looking at this sheet");
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
  await p1.waitForTimeout(500);
  expect(stored(c.id, "str")).toBe(9);
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
