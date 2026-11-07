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

test("a dice system: the GM starts from a game in Settings, tries a roll, and players roll it with odds and saved rolls", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Dice system");
  const perrors = watchErrors(pp);
  await page.goto(`index.html#/c/${cid}/settings/dice`);
  const form = page.locator(".dice-settings");
  await expect(form.locator(".dice-set-body")).toBeHidden();   // free dice only, to start with
  await form.locator("#dice-game").selectOption("pf2");
  await expect(form.locator("#dice-system")).toHaveValue("d20");
  await expect(form.locator(".dice-set-params")).toContainText("DC");                       // the game's own name for the target
  await expect(form.locator("#set-d20-margin")).toHaveValue("10");
  await expect(form.locator(".dice-odds-key")).toContainText("Success");
  await form.getByRole("button", { name: "🎲 Try a roll" }).click();
  await expect(form.locator(".dice-try-res small.tier")).toHaveText(/success|failure/i);
  await expect(form.locator(".dice-try-out .die")).toHaveCount(1);
  await form.locator("#set-d20-tn").fill("12");
  await form.locator("#set-d20-tn").dispatchEvent("change");
  await form.getByRole("button", { name: "Save dice settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const sys = (await api(pp, "dice_rolls", undefined, cid)).json.settings.system;
  expect(sys).toMatchObject({ id: "d20", game: "pf2", labels: { tn: "DC" } });
  expect(sys.params).toMatchObject({ tn: 12, margin: 10 });

  // the player's roller has a game roll, with the game's numbers, odds, and a Roll button
  await pp.goto(`index.html#/c/${cid}/table`);
  await pp.locator(".dice-fab").click();
  await expect(pp.locator(".dice-sub")).toHaveText("Pathfinder 2nd edition");
  await expect(pp.getByRole("tab", { name: "Game roll" })).toHaveAttribute("aria-selected", "true");
  await expect(pp.getByRole("spinbutton", { name: "DC" })).toHaveValue("12");
  await pp.getByRole("button", { name: "Modifier up one" }).click();
  await pp.getByRole("button", { name: "Modifier up one" }).click();
  await expect(pp.locator(".dice-sys-n")).toHaveText("1d20+2");
  await expect(pp.locator(".dice-sys .dice-odds-bar span").first()).toBeVisible();
  await pp.getByRole("textbox", { name: "What the roll is for" }).fill("Athletics");
  await pp.locator(".dice-sys-go").click();
  const latest = pp.locator(".dice-e.latest");
  await expect(latest.locator(".dice-e-who")).toContainText("Athletics");
  await expect(latest.locator(".dice-e-out small.tier")).toHaveText(/Critical success|Success|Failure|Critical failure/);
  const roll = (await api(pp, "dice_rolls", undefined, cid)).json.rolls.at(-1);
  expect(roll.expr).toMatch(/^1d20\+2 @d20 mod=2 tn=12 .*margin=10.* # Athletics$/);
  const total = Dice.roll(roll.expr, roll.seed).results[0].total;
  await expect(latest.locator(".dice-e-out b")).toHaveText(String(total));
  await expect(latest.locator(".dice-e-meta")).toContainText(total >= 12 ? "beat 12 by" : "missed 12 by");
  // the GM's log reads the same roll the same way
  await page.goto(`index.html#/c/${cid}/table`);
  await page.locator(".dice-fab").click();
  await expect(page.locator(".dice-e.latest .dice-e-out small.tier")).toHaveText(await latest.locator(".dice-e-out small.tier").textContent());

  // saving a roll: it keeps its numbers, and comes back after a reload
  await pp.getByRole("button", { name: "Modifier down one" }).click();
  pp.once("dialog", () => {});
  await pp.getByRole("button", { name: "☆ Save" }).click();
  const dlg = pp.getByRole("dialog");
  await dlg.getByRole("textbox").fill("Climb");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(pp.locator("#toast")).toContainText('Saved "Climb"');
  await pp.reload();
  await expect(pp.locator(".dice-panel")).toBeVisible();
  await pp.getByRole("button", { name: "Modifier up one" }).click();
  await expect(pp.locator(".dice-sys-n")).toHaveText("1d20+2");
  await pp.getByRole("combobox", { name: "Saved rolls" }).selectOption({ label: "Climb" });
  await expect(pp.locator(".dice-sys-n")).toHaveText("1d20+1");
  await expect(pp.getByRole("textbox", { name: "What the roll is for" })).toHaveValue("Athletics");
  // a free roll can be saved too, and loads into the free box
  await pp.getByRole("tab", { name: "Free roll" }).click();
  await pp.getByRole("textbox", { name: "Free roll" }).fill("8d6 # fireball");
  await pp.getByRole("button", { name: "☆ Save" }).click();
  await expect(dlg.getByRole("textbox")).toHaveValue("fireball");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(pp.locator("#toast")).toContainText('Saved "fireball"');
  await pp.getByRole("tab", { name: "Game roll" }).click();
  await pp.getByRole("combobox", { name: "Saved rolls" }).selectOption({ label: "fireball" });
  await expect(pp.getByRole("tab", { name: "Free roll" })).toHaveAttribute("aria-selected", "true");
  await expect(pp.getByRole("textbox", { name: "Free roll" })).toHaveValue("8d6 # fireball");
  await pp.getByRole("button", { name: "Forget this saved roll" }).click();
  await expect(pp.locator("#toast")).toContainText('Forgot "fireball"');
  await expect(pp.getByRole("combobox", { name: "Saved rolls" }).locator("option")).toHaveCount(2);
  const me = await pp.evaluate(() => fetch("api/auth/me.php").then(r => r.json()));
  expect(me.prefs.dice_saved[cid]).toEqual([{ n: "Climb", e: expect.stringMatching(/^1d20\+1 @d20 mod=1 .* # Athletics$/) }]);

  // saved rolls are kept only for a campaign the person is in, and only so many, so long
  expect((await api(pp, "prefs_save", { dice_saved: { cid: cid + 999, list: [{ n: "x", e: "d6" }] } })).status).toBe(404);
  expect((await api(pp, "prefs_save", { dice_saved: { cid, list: [{ n: "x".repeat(61), e: "d6" }] } })).status).toBe(400);
  expect((await api(pp, "prefs_save", { dice_saved: { cid, list: Array.from({ length: 101 }, (_, k) => ({ n: `r${k}`, e: "d6" })) } })).status).toBe(400);

  // back to free dice only: the roller has no game roll
  await page.goto(`index.html#/c/${cid}/settings/dice`);
  await form.locator("#dice-game").selectOption("");
  await form.getByRole("button", { name: "Save dice settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  expect((await api(pp, "dice_rolls", undefined, cid)).json.settings.system).toBeNull();
  await pp.reload();
  await expect(pp.locator(".dice-panel")).toBeVisible();
  await expect(pp.locator(".dice-modes")).toBeHidden();
  await expect(pp.getByRole("textbox", { name: "Free roll" })).toBeVisible();
  // the old game roll still reads as its system said
  await expect(pp.locator(".dice-e").filter({ hasText: "Athletics" }).locator("small.tier")).toBeVisible();
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("the roller pins beside the page or floats over it, and remembers which on this device", async ({ page, browser }) => {
  test.skip(test.info().project.name !== "chromium", "one desktop size is enough for the switch");
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Dice pin");
  await page.goto(`index.html#/c/${cid}/table`);
  await openDice(page);
  const pin = page.getByRole("button", { name: "Pin the roller beside the page" });
  const appMargin = () => page.locator("#app").evaluate(n => getComputedStyle(n).marginRight);
  await expect(pin).toHaveAttribute("aria-pressed", "true");   // a mouse and keyboard start pinned
  expect(await appMargin()).toBe("380px");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  expect(await appMargin()).toBe("0px");
  const box = await page.locator(".dice-panel").boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(1280 - 10);    // a card off the edge, over the page
  await page.reload();
  await expect(page.locator(".dice-panel")).toBeVisible();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  expect(await appMargin()).toBe("380px");
  expectNoErrors(errors);
});
