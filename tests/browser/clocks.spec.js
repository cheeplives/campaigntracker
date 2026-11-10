// Clocks: circles of segments that fill as something comes closer. Any member makes one; a player's is drawn apart from
// a GM's. Its maker and GMs fill it; a secret clock is the GM's alone, and a vague one hides how full it is from players
// who didn't make it. Running clocks show in a box on At the Table.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, goTab, pressMore } = require("./helpers");
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

test("the GM makes a clock on the Clocks tab and fills it by pressing a segment and +", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Clocks");
  await page.goto(`index.html#/c/${cid}/table`);
  await goTab(page, "Clocks");
  const tabs = await page.locator("nav.tabs a").allTextContents();
  expect(tabs.indexOf("Clocks")).toBe(tabs.indexOf("Sessions") + 1);
  await expect(page.locator(".clock-page")).toContainText("No clocks yet");

  await page.getByRole("button", { name: "+ New clock" }).click();
  const d = page.locator(".clock-dialog");
  await d.getByLabel("Name").fill("The cult finishes the ritual");
  await d.getByLabel("Description").fill("Fills each night the party dawdles.");
  await d.getByRole("button", { name: "6", exact: true }).click();
  await expect(d.locator(".clock-preview .clock-seg")).toHaveCount(6);
  await d.getByRole("button", { name: "Add clock" }).click();
  const card = page.locator(".clock-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".clock-count")).toHaveText("0 of 6");
  await expect(card.locator(".clock-face")).not.toHaveClass(/player/);

  await card.getByRole("button", { name: "Set The cult finishes the ritual to 3 of 6" }).click();
  await expect(card.locator(".clock-count")).toHaveText("3 of 6");
  await card.getByRole("button", { name: "+", exact: true }).click();
  await expect(card.locator(".clock-count")).toHaveText("4 of 6");
  await expect(card.locator(".clock-seg.on")).toHaveCount(4);
  await card.locator(".clock-log summary").click();
  await expect(card.locator(".clock-log li")).toHaveCount(2);
  await expect(card.locator(".clock-log li").first()).toContainText("filled 1 → 4");

  // The player sees it, and its count, but can't fill it.
  await pp.goto(`index.html#/c/${cid}/clocks`);
  const pcard = pp.locator(".clock-card");
  await expect(pcard.locator(".clock-count")).toHaveText("4 of 6");
  await expect(pcard.getByRole("button", { name: "+", exact: true })).toHaveCount(0);
  const id = (await api(page, "clocks", undefined, cid)).json.clocks[0].id;
  expect((await api(pp, "clock_tick", { id, by: 1 }, cid)).status).toBe(403);
  expect((await api(pp, "clock_delete", { id }, cid)).status).toBe(403);
  expectNoErrors(errors);
});

test("a player makes their own clock, drawn in the player colour, and fills it; secret and vague clocks hide from players", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Player clocks");
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/clocks`);
  await pp.getByRole("button", { name: "+ New clock" }).click();
  const d = pp.locator(".clock-dialog");
  await expect(d.locator("input[name=clock-vis]")).toHaveCount(2);   // no Secret for a player
  await d.getByLabel("Name").fill("Pay off the guild");
  await d.getByRole("button", { name: "4", exact: true }).click();
  await d.getByRole("button", { name: "Add clock" }).click();
  const card = pp.locator(".clock-card");
  await expect(card).toHaveClass(/player/);
  await expect(card.locator(".clock-face")).toHaveClass(/player/);
  await expect(card.locator(".clock-who")).toHaveText("Player");
  await card.getByRole("button", { name: "+", exact: true }).click();
  await expect(card.locator(".clock-count")).toHaveText("1 of 4");
  expect((await api(pp, "clock_save", { name: "Nope", segments: 4, visibility: "secret" }, cid)).status).toBe(403);

  // The GM makes a secret clock and a vague one.
  expect((await api(page, "clock_save", { name: "Hidden plot", segments: 8, filled: 2, visibility: "secret" }, cid)).status).toBe(200);
  expect((await api(page, "clock_save", { name: "Storm rolls in", segments: 6, filled: 5, visibility: "vague" }, cid)).status).toBe(200);
  const seen = (await api(pp, "clocks", undefined, cid)).json.clocks;
  expect(seen.map(c => c.name).sort()).toEqual(["Pay off the guild", "Storm rolls in"]);
  const storm = seen.find(c => c.name === "Storm rolls in");
  expect(storm.filled).toBeNull();
  expect(storm.ticks).toEqual([]);
  await pp.reload();
  await expect(pp.locator(".clock-card")).toHaveCount(2);
  await expect(pp.locator(".clock-card", { hasText: "Storm rolls in" }).locator(".clock-count")).toHaveText("6 segments · how full is hidden");
  await expect(pp.locator(".clock-card", { hasText: "Storm rolls in" }).locator(".clock-q")).toHaveText("?");

  // The GM sees and fills the player's clock too; the filter narrows to player clocks.
  await page.goto(`index.html#/c/${cid}/clocks`);
  await expect(page.locator(".clock-card")).toHaveCount(3);
  await page.locator(".tagopt", { hasText: "Player clocks" }).click();
  await expect(page.locator(".clock-card")).toHaveCount(1);
  await page.locator(".clock-card").getByRole("button", { name: "+", exact: true }).click();
  await expect(page.locator(".clock-card .clock-count")).toHaveText("2 of 4");
  expectNoErrors(perrors);
});

test("At the Table has a Clocks box of the running clocks, and putting one away takes it off", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Table clocks");
  const { json } = await api(page, "clock_save", { name: "Rival crew", segments: 4, filled: 1 }, cid);
  await page.goto(`index.html#/c/${cid}/table`);
  const box = page.locator(".daybox[data-box=clocks]");
  await expect(box.locator(".daybox-sum")).toHaveText("1 running");
  await box.locator(".daybox-toggle").click();
  await expect(box.locator(".clock-mini")).toHaveCount(1);
  await box.getByRole("button", { name: "+", exact: true }).click();
  await expect(box.locator(".clock-mini .small.muted")).toHaveText("2 of 4");
  await box.getByRole("button", { name: "Set Rival crew to 4 of 4" }).click();
  await expect(box.locator(".daybox-sum")).toHaveText("1 running, 1 full");

  // The player's At the Table shows it, with no + to press.
  await pp.goto(`index.html#/c/${cid}/table`);
  const pbox = pp.locator(".daybox[data-box=clocks]");
  await pbox.locator(".daybox-toggle").click();
  await expect(pbox.locator(".clock-mini")).toContainText("Rival crew");
  await expect(pbox.getByRole("button", { name: "+", exact: true })).toHaveCount(0);

  // Put away, it leaves the box but stays on the tab under Put away.
  await page.goto(`index.html#/c/${cid}/clocks`);
  await page.locator(".seg button", { hasText: "Full" }).click();
  await pressMore(page, "Rival crew", "Put away");
  await expect(page.locator(".clock-card")).toHaveCount(0);
  await page.locator(".seg button", { hasText: "Put away" }).click();
  await expect(page.locator(".clock-card")).toContainText("Rival crew");
  await page.goto(`index.html#/c/${cid}/table`);
  await expect(page.locator(".daybox[data-box=clocks] .daybox-sum")).toHaveText("None running");
  expect(json.clock.by_gm).toBe(true);
  expectNoErrors(errors);
});
