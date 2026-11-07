// The die roller: the 🎲 button on every campaign page opens a panel with the table's roll log. One tap rolls a single
// die; the free-roll box takes the ? card's notation. The server picks each roll's seed, so everyone sees the same dice,
// and who sees a roll (everyone, the roller and GMs, or the GMs alone) is the server's to enforce.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, sql } = require("./helpers");
const Dice = require(path.join(__dirname, "..", "..", "static", "dice.js"));
test.afterEach(closeContexts);

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const openDice = async page => {
  await page.locator(".dice-fab").click();
  await expect(page.locator(".dice-panel")).toBeVisible();
};

test("the GM rolls from the quick dice and the free-roll box, and the ? card fills the box", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Dice");
  await page.goto(`index.html#/c/${cid}/table`);
  await openDice(page);
  await expect(page.locator(".dice-log")).toContainText("No rolls yet");

  await page.getByRole("button", { name: "d20", exact: true }).click();
  const latest = page.locator(".dice-e.latest");
  await expect(latest.locator(".dice-e-meta")).toContainText("1d20");
  const n = Number(await latest.locator(".dice-e-out b").textContent());
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(20);

  // the result on the page is the one the stored seed rolls
  const box = page.getByRole("textbox", { name: "Free roll" });
  await box.fill("4d6kh3 + 2 # strength");
  await box.press("Enter");
  await expect(page.locator(".dice-e")).toHaveCount(2);
  await expect(latest.locator(".dice-e-who")).toContainText("strength");
  const rolls = (await api(page, "dice_rolls", undefined, cid)).json.rolls;
  const last = rolls[rolls.length - 1];
  expect(last.expr).toBe("4d6kh3 + 2 # strength");
  expect(last.seed).toMatch(/^[0-9a-f]{32}$/);
  await expect(latest.locator(".dice-e-out b")).toHaveText(String(Dice.roll(last.expr, last.seed).results[0].total));
  await expect(latest.locator(".die")).toHaveCount(4);
  await expect(latest.locator(".die.dropped")).toHaveCount(1);

  // success counting says so
  await box.fill("7d10>=6");
  await page.getByRole("button", { name: "Roll", exact: true }).click();
  await expect(latest.locator(".dice-e-out small")).toHaveText(/success/);

  // a roll that can't be read says why, and isn't sent
  await box.fill("2d6+");
  await box.press("Enter");
  await expect(page.locator(".dice-err")).toContainText("ends too soon");
  await expect(page.locator(".dice-e")).toHaveCount(3);

  // the ? card lists the notation; an example goes into the box
  await page.getByRole("button", { name: "How to write a free roll" }).click();
  const help = page.getByRole("dialog", { name: "Writing a free roll" });
  await expect(help).toContainText("Keep highest / lowest N");
  await expect(help).toContainText("Flip-flop");
  await help.getByRole("button", { name: "6x(4d6kh3)" }).click();
  await expect(help).toBeHidden();
  await expect(box).toHaveValue("6x(4d6kh3)");
  await box.press("Enter");
  await expect(latest.locator(".dice-go-n")).toHaveCount(6);

  // closing keeps the log; the panel opens again as it was left after a reload
  await page.getByRole("button", { name: "Close the dice roller" }).click();
  await expect(page.locator(".dice-panel")).toBeHidden();
  await openDice(page);
  await page.reload();
  await expect(page.locator(".dice-panel")).toBeVisible();
  await expect(page.locator(".dice-e")).toHaveCount(4);
  expectNoErrors(errors);
});

test("who sees a roll: everyone, the roller and the GMs, or the GMs alone", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Dice vis");
  const roll = (p, body) => api(p, "dice_roll", { engine: 1, ...body }, cid);
  expect((await roll(pp, { expr: "d20 # open", visibility: "all" })).status).toBe(200);
  expect((await roll(pp, { expr: "d20 # mine", visibility: "gm" })).status).toBe(200);
  expect((await roll(pp, { expr: "d20 # blind", visibility: "blind" })).status).toBe(200);
  expect((await roll(page, { expr: "d20 # gm secret", visibility: "gm" })).status).toBe(200);
  expect((await roll(page, { expr: "d20 # gm open", visibility: "all" })).status).toBe(200);

  // a second player sees only the open rolls
  const p2 = person("Quill");
  const qctx = await newContext(browser);
  const qp = await qctx.newPage();
  await signIn(qp, p2);
  await approve(browser, p2.email);
  expect((await api(page, "member_add", { email: p2.email, role: "player" }, cid)).status).toBe(200);
  const labels = rs => rs.map(r => r.expr.split("# ")[1]);
  expect(labels((await api(qp, "dice_rolls", undefined, cid)).json.rolls)).toEqual(["open", "gm open"]);

  // the roller sees their own, and their blind roll without its seed, so their page can't work it out
  const mine = (await api(pp, "dice_rolls", undefined, cid)).json.rolls;
  expect(labels(mine)).toEqual(["open", "mine", "blind", "gm open"]);
  expect(mine.find(r => r.visibility === "blind").seed).toBeNull();
  expect(mine.find(r => r.visibility === "gm").seed).toMatch(/^[0-9a-f]{32}$/);

  // the GM sees everything, seeds and all; a GM's "blind" roll is simply GMs only
  const all = (await api(page, "dice_rolls", undefined, cid)).json.rolls;
  expect(all).toHaveLength(5);
  expect(all.every(r => r.seed)).toBe(true);
  expect((await roll(page, { expr: "d6", visibility: "blind" })).json.roll.visibility).toBe("gm");

  // the change check tells a player of the newest roll they may see, not of a hidden one
  const seen = (await api(pp, "changed", undefined, cid)).json.last_roll;
  expect(seen).toBe(all.find(r => r.expr.includes("gm open")).id);

  // on the player's page: the blind roll shows as rolled for the GM, with no result
  const errorsP = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/table`);
  await pp.locator(".dice-fab").click();
  await expect(pp.locator(".dice-e")).toHaveCount(4);
  const blind = pp.locator(".dice-e", { hasText: "blind" });
  await expect(blind).toContainText("Rolled for the GM");
  await expect(blind.locator(".die")).toHaveCount(0);
  // the player's own choice of who sees it is remembered on this device
  await pp.getByRole("combobox", { name: "Who sees the roll" }).selectOption("gm");
  await pp.getByRole("button", { name: "d6", exact: true }).click();
  await expect(pp.locator(".dice-e.latest")).toHaveClass(/hidden-roll/);
  const lastP = (await api(pp, "dice_rolls", undefined, cid)).json.rolls.pop();
  expect(lastP.visibility).toBe("gm");
  expectNoErrors(errors);
  expectNoErrors(errorsP);
});

test("Settings → Dice: the GM sets who sees players' rolls, locks it, and clears the log", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Dice settings");
  await page.goto(`index.html#/c/${cid}/settings/dice`);
  const form = page.locator(".dice-settings");
  await form.getByLabel("Who sees a player's roll").selectOption("blind");
  await form.getByLabel("Players can't change who sees their rolls").check();
  await form.getByLabel("GM rolls start hidden from players").check();
  await form.getByLabel("Roll log keeps").selectOption("100");
  await form.getByRole("button", { name: "Save dice settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");

  // a locked choice wins over what a player asks for, and the player's page says the GM set it
  const r = await api(pp, "dice_roll", { expr: "d20", engine: 1, visibility: "all" }, cid);
  expect(r.json.roll.visibility).toBe("blind");
  expect((await api(page, "dice_roll", { expr: "d20", engine: 1 }, cid)).json.roll.visibility).toBe("gm");
  await pp.goto(`index.html#/c/${cid}/table`);
  await pp.locator(".dice-fab").click();
  await expect(pp.locator(".dice-vis-fixed")).toHaveText("GM only (set by the GM)");
  await expect(pp.getByRole("combobox", { name: "Who sees the roll" })).toBeHidden();

  // the log keeps the newest 100
  for (let k = 0; k < 102; k++) await api(page, "dice_roll", { expr: `d6 # ${k}`, engine: 1, visibility: "all" }, cid);
  expect(Number(sql(`SELECT COUNT(*) FROM dice_rolls WHERE campaign_id=${cid}`).trim())).toBe(100);
  expect(sql(`SELECT expr FROM dice_rolls WHERE campaign_id=${cid} ORDER BY id LIMIT 1`).trim()).toBe("d6 # 2");   // the two d20s and d6 # 0 and 1 are gone
  const page1 = (await api(page, "dice_rolls", undefined, cid)).json.rolls;
  expect(page1).toHaveLength(50);   // the newest page, oldest first
  expect(page1[page1.length - 1].expr).toBe("d6 # 101");

  // a player can't clear the log; the GM can
  expect((await api(pp, "dice_clear", {}, cid)).status).toBe(403);
  await page.getByRole("button", { name: "Clear the roll log…" }).click();
  await page.getByRole("button", { name: "Clear the log" }).click();
  await expect(page.locator("#toast")).toContainText("empty");
  expect((await api(page, "dice_rolls", undefined, cid)).json.rolls).toHaveLength(0);
  expectNoErrors(errors);
});

test("the server refuses what isn't a roll, an engine it doesn't know, and anyone outside the campaign", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Dice refuse");
  expect((await api(page, "dice_roll", { expr: "", engine: 1 }, cid)).status).toBe(400);
  expect((await api(page, "dice_roll", { expr: "d6\nd6", engine: 1 }, cid)).status).toBe(400);
  expect((await api(page, "dice_roll", { expr: "x".repeat(201), engine: 1 }, cid)).status).toBe(400);
  expect((await api(page, "dice_roll", { expr: "d6", engine: 9 }, cid)).status).toBe(400);
  expect((await api(page, "dice_roll", { expr: "d6", engine: 1, visibility: "nobody" }, cid)).status).toBe(400);
  const out = person("Otto");
  const octx = await newContext(browser);
  const op = await octx.newPage();
  await signIn(op, out);
  await approve(browser, out.email);
  expect((await api(op, "dice_rolls", undefined, cid)).status).toBe(403);
  expect((await api(op, "dice_roll", { expr: "d6", engine: 1 }, cid)).status).toBe(403);
});
