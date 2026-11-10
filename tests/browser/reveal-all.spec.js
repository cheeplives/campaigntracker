// Reveal beyond an entry's paragraphs: a whole GM-only entry or event in one click (an entry can log "Revealed: name" on
// today's events), a day's Secret notes joining its Public notes, and the GM-only paragraphs of a session's summary,
// rewards and loot.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, pressMore } = require("./helpers");
test.afterEach(closeContexts);

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pp = await (await newContext(browser)).newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
const get = async (who, qs) => (await (await who.request.get(`api/index.php?${qs}`)).json());

test("a whole GM-only entry is revealed in one click, with or without a line on today's events", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "RevealEntry");
  const a = (await api(page, "entry_save", { name: "Black Barrow", notes: "<p>A mound.</p><aside>Hollow.</aside>", gm_notes: "<p>The truth.</p>", is_secret: true }, cid)).json.id;
  const b = (await api(page, "entry_save", { name: "Quiet Ford", notes: "<p>A crossing.</p>", is_secret: true }, cid)).json.id;
  const seen = async (who, id) => (await get(who, `a=encyclopedia&cid=${cid}`)).entries.find(e => e.id === id);
  expect(await seen(pp, a)).toBeUndefined();

  await page.goto(`index.html#/c/${cid}/encyclopedia/${a}`);
  // Reveal entry waits in the entry's ⋯ menu (the page may be drawn again once after it opens, closing the menu: open it until it stays)
  await expect(async () => {
    await page.locator(".enc-detail").getByLabel(/^More for /).click({ timeout: 2000 });
    await page.getByRole("button", { name: "Reveal entry" }).click({ timeout: 2000 });
  }).toPass();
  await page.getByRole("button", { name: "Reveal and log it today" }).click();
  await expect(page.getByText("Revealed, and logged on today's events")).toBeVisible();
  await page.locator(".enc-detail").getByLabel(/^More for /).click();   // public now: the menu no longer offers it
  await expect(page.getByRole("button", { name: "Reveal entry" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const shown = await seen(pp, a);
  expect(shown.name).toBe("Black Barrow");
  expect(shown.notes).toBe("<p>A mound.</p>");              // its GM-only paragraph and GM notes stay hidden
  expect(shown.gm_notes ?? "").toBe("");
  const { events } = await get(pp, `a=events&cid=${cid}`);
  expect(events.map(e => [e.title, e.tags.map(t => t.name)])).toEqual([["Revealed: Black Barrow", ["Revealed"]]]);

  await page.goto(`index.html#/c/${cid}/encyclopedia/${b}`);
  // Reveal entry waits in the entry's ⋯ menu (the page may be drawn again once after it opens, closing the menu: open it until it stays)
  await expect(async () => {
    await page.locator(".enc-detail").getByLabel(/^More for /).click({ timeout: 2000 });
    await page.getByRole("button", { name: "Reveal entry" }).click({ timeout: 2000 });
  }).toPass();
  await page.getByRole("button", { name: "Just reveal" }).click();
  await expect(page.getByText("Revealed to the players")).toBeVisible();
  await page.locator(".enc-detail").getByLabel(/^More for /).click();
  await expect(page.getByRole("button", { name: "Reveal entry" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await seen(pp, b)).name).toBe("Quiet Ford");
  expect((await get(pp, `a=events&cid=${cid}`)).events).toHaveLength(1);

  // already public, a player, a stranger's id, and the wrong kind are refused
  expect((await api(page, "item_reveal", { kind: "entry", id: b }, cid)).status).toBe(409);
  expect((await api(pp, "item_reveal", { kind: "entry", id: a }, cid)).status).toBe(403);
  expect((await api(page, "item_reveal", { kind: "entry", id: 999999 }, cid)).status).toBe(404);
  expect((await api(page, "item_reveal", { kind: "tome", id: 1 }, cid)).status).toBe(400);
  // and it is a version in its history
  const hist = (await get(page, `a=history_list&cid=${cid}&kind=entry&ref=${a}`)).versions;
  expect((await get(page, `a=history_get&cid=${cid}&id=${hist[0].id}`)).version.data.is_secret).toBe(0);
  expectNoErrors(errors);
});

test("a GM-only event is revealed from its card, and players then see it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "RevealEvent");
  const ev = (await api(page, "event_save", { abs_day: 2, title: "The cult meets", body: "Under the mill.", is_secret: true }, cid)).json.id;
  expect((await get(pp, `a=events&cid=${cid}`)).events).toHaveLength(0);
  await page.goto(`index.html#/c/${cid}/day/2`);
  await pressMore(page, "The cult meets", "Reveal");
  await page.getByRole("button", { name: "Reveal", exact: true }).last().click();
  await expect(page.getByText("Revealed to the players")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal" })).toHaveCount(0);
  expect((await get(pp, `a=events&cid=${cid}`)).events.map(e => e.title)).toEqual(["The cult meets"]);
  expect((await api(page, "item_reveal", { kind: "event", id: ev }, cid)).status).toBe(409);
  expect((await api(pp, "item_reveal", { kind: "event", id: ev }, cid)).status).toBe(403);
  expectNoErrors(errors);
});

test("GM-only paragraphs of a session's summary, rewards and loot, and a day's Secret notes, are revealed", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "RevealSession");
  const sid = (await api(page, "session_save", {}, cid)).json.session.id;
  await api(page, "session_summary_save", { id: sid, version: 1, summary: "<p>They docked.</p><aside>Essen owns the rock-hopper.</aside>", rewards: "<p>50 gp</p><aside>A map in the lining.</aside>", loot: "<p>Rope</p><aside>A cursed ring.</aside>" }, cid);
  expect((await api(page, "session_save", { id: sid, is_published: true, title: "The docks" }, cid)).status).toBe(200);
  expect((await api(page, "day_update", { abs_day: 2, version: 0, notes: "Rain.", notes_format: "plain", gm_notes: "<p>The spy slipped away.</p>", gm_notes_format: "html" }, cid)).status).toBe(200);
  const session = async who => (await get(who, `a=session&cid=${cid}&id=${sid}`)).session;
  expect((await session(pp)).summary).toBe("<p>They docked.</p>");

  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(page.getByRole("button", { name: "Reveal" })).toHaveCount(3);
  for (const text of ["Essen owns the rock-hopper.", "A map in the lining.", "A cursed ring."]) {
    await page.locator("aside", { hasText: text }).getByRole("button", { name: "Reveal" }).click();
    await page.getByRole("button", { name: "Just reveal" }).click();
    await expect(page.getByText("Revealed to the players")).toBeVisible();
    await expect(page.locator("aside", { hasText: text })).toHaveCount(0);
  }
  const shown = await session(pp);
  expect(shown.summary).toBe("<p>They docked.</p><p>Essen owns the rock-hopper.</p>");
  expect(shown.rewards).toBe("<p>50 gp</p><p>A map in the lining.</p>");
  expect(shown.loot).toBe("<p>Rope</p><p>A cursed ring.</p>");

  // a day's Secret notes join its Public notes
  expect((await get(pp, `a=day&cid=${cid}&d=2`)).day.notes).toBe("Rain.");
  await page.goto(`index.html#/c/${cid}/day/2`);
  await pressMore(page, "this day's notes", "Reveal secret notes");
  await page.getByRole("button", { name: "Reveal and log it today" }).click();
  await expect(page.getByText("Revealed, and logged on this day's events")).toBeVisible();
  expect((await get(pp, `a=day&cid=${cid}&d=2`)).day.notes).toBe("<p>Rain.</p><p>The spy slipped away.</p>");
  const mine = (await get(page, `a=day&cid=${cid}&d=2`)).day;
  expect(mine.gm_notes || "").toBe("");
  await expect(page.getByRole("button", { name: "Reveal secret notes" })).toHaveCount(0);
  expect((await get(pp, `a=events&cid=${cid}`)).events.map(e => e.title)).toContain("Revealed: secret notes for day 2");
  // nothing secret left, no such day, a stale page, the wrong field, and a player are all refused
  expect((await api(page, "item_reveal", { kind: "day", id: 2 }, cid)).status).toBe(409);
  expect((await api(page, "item_reveal", { kind: "day", id: 77 }, cid)).status).toBe(404);
  expect((await api(page, "secret_reveal", { kind: "day", id: 2, which: [{ index: 0, text: "x" }] }, cid)).status).toBe(400);
  expect((await api(page, "secret_reveal", { kind: "session", id: sid, field: "loot", which: [{ index: 0, text: "Something else" }] }, cid)).status).toBe(409);
  expect((await api(page, "secret_reveal", { kind: "session", id: sid, field: "notes_text", which: [{ index: 0, text: "x" }] }, cid)).status).toBe(400);
  expect((await api(pp, "item_reveal", { kind: "day", id: 2 }, cid)).status).toBe(403);
  expectNoErrors(errors);
});
