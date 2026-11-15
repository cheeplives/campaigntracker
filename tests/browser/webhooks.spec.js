// Discord channels: a GM pastes a channel's webhook address and the campaign posts a line there when time passes, an
// event is added, a clock everyone can read fills or a session ends. Only what every player may see is posted, the
// address is never shown whole again, and only Discord's own addresses are taken. The test config sends the posts to a
// file (webhooks.test_outbox) instead of Discord.
const fs = require("fs"), os = require("os"), path = require("path");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const OUTBOX = path.join(os.tmpdir(), "chronicle-test-webhooks.jsonl");
const posts = token => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8") : "").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(p => p.url.includes(token));
const hook = token => `https://discord.com/api/webhooks/123456789012345678/${token}`;
const token = () => `tok${Date.now()}${Math.floor(Math.random() * 1e6)}_abcdefghij`;

test.describe("Discord channels", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

  test("posts what every player may see, and nothing secret", async ({ page, browser }) => {
    const gm = person("HookGM");
    await signIn(page, gm);
    await approve(browser, gm.email);
    const cid = await makeCampaign(page, `Hooks *bold* ${gm.id}`);
    const t = token();
    const made = await api(page, "webhook_save", { label: "#log", url: hook(t) }, cid);
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.webhook).toMatchObject({ label: "#log", events: ["time", "event", "clock", "session"], off: false });
    expect(JSON.stringify(made.json)).not.toContain(t);
    expect(JSON.stringify((await api(page, "webhooks", undefined, cid)).json)).not.toContain(t);

    const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
    expect((await api(page, "set_time", { current_shift: now + 1, label: "Dusk, 3 Firstmonth @everyone" }, cid)).status).toBe(200);
    expect((await api(page, "event_save", { abs_day: 2, title: "The bridge fell" }, cid)).status).toBe(200);
    expect((await api(page, "event_save", { abs_day: 2, title: "Hidden plot", is_secret: true }, cid)).status).toBe(200);
    const shown = (await api(page, "clock_save", { name: "Storm", segments: 4, filled: 0, visibility: "shown" }, cid)).json.clock;
    const secret = (await api(page, "clock_save", { name: "Coup", segments: 4, filled: 0, visibility: "secret" }, cid)).json.clock;
    const vague = (await api(page, "clock_save", { name: "Debt", segments: 4, filled: 0, visibility: "vague" }, cid)).json.clock;
    for (const c of [shown, secret, vague]) expect((await api(page, "clock_tick", { id: c.id, by: 4 }, cid)).status).toBe(200);
    expect((await api(page, "session_save", { title: "Into the hills", first_day: 2 }, cid)).status).toBe(200);
    expect((await api(page, "session_end", {}, cid)).status).toBe(200);

    await expect.poll(() => posts(t).length).toBeGreaterThanOrEqual(4);
    const all = posts(t);
    const text = all.map(p => p.content).join("\n");
    expect(text).toContain("It is now Dusk, 3 Firstmonth \\@everyone.");
    expect(text).toContain("New event: The bridge fell");
    expect(text).toContain("Clock: Storm is at 4 of 4 (full).");
    expect(text).toMatch(/Session \d+: Into the hills has ended\./);
    expect(text).toContain("Hooks \\*bold\\*");
    expect(text).not.toContain("Hidden plot");
    expect(text).not.toContain("Coup");
    expect(text).not.toContain("Debt");
    for (const p of all) expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  test("a channel hears only what it was asked to, takes only Discord addresses, and is the GM's alone", async ({ page, browser }) => {
    const gm = person("HookGM2"), player = person("HookPlayer");
    await signIn(page, gm);
    await approve(browser, gm.email);
    const cid = await makeCampaign(page, `Hooks2 ${gm.id}`);
    for (const url of ["http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx", "https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx",
      "https://discord.com.evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx", "https://discord.com/api/webhooks/../../x", "http://127.0.0.1/"]) {
      expect((await api(page, "webhook_save", { url }, cid)).status, url).toBe(400);
    }
    const t = token();
    const w = (await api(page, "webhook_save", { label: "Events only", url: hook(t), events: ["event"] }, cid)).json.webhook;
    const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
    await api(page, "set_time", { current_shift: now + 2 }, cid);
    await api(page, "event_save", { abs_day: 1, title: "Market day" }, cid);
    await expect.poll(() => posts(t).length).toBe(1);
    expect(posts(t)[0].content).toContain("New event: Market day");

    // Test posts a line; a change keeps the address; removing stops it
    expect((await api(page, "webhook_test", { id: w.id }, cid)).status).toBe(200);
    expect((await api(page, "webhook_save", { id: w.id, label: "Renamed", events: ["time"] }, cid)).json.webhook).toMatchObject({ label: "Renamed", events: ["time"] });
    await api(page, "set_time", { current_shift: now + 3 }, cid);
    await expect.poll(() => posts(t).length).toBe(3);
    expect(posts(t)[2].content).toContain("Time has passed.");
    expect((await api(page, "webhook_delete", { id: w.id }, cid)).status).toBe(200);
    await api(page, "set_time", { current_shift: now + 4 }, cid);

    // a failing channel says so on Test
    const bad = (await api(page, "webhook_save", { url: hook(`FAIL${token()}`) }, cid)).json.webhook;
    const failed = await api(page, "webhook_test", { id: bad.id }, cid);
    expect(failed.status).toBe(502);
    expect((await api(page, "webhooks", undefined, cid)).json.webhooks[0].last_error).toBe("Discord answered 404");

    // players can't see or change the channels, nor a GM of another campaign this one's
    const pctx = await newContext(browser);
    const pp = await pctx.newPage();
    await signIn(pp, player);
    await approve(browser, player.email);
    expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
    expect((await api(pp, "webhooks", undefined, cid)).status).toBe(403);
    expect((await api(pp, "webhook_save", { url: hook(token()) }, cid)).status).toBe(403);
    const other = await makeCampaign(page, `Hooks3 ${gm.id}`);
    expect((await api(page, "webhook_test", { id: bad.id }, other)).status).toBe(404);
    expect((await api(page, "webhook_delete", { id: bad.id }, other)).status).toBe(404);
    await new Promise(r => setTimeout(r, 300));
    expect(posts(t).length).toBe(3);
  });
});

test("a GM adds, tests and removes a channel from At the Table", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("HookGM3");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Hooks UI ${gm.id}`);
  const t = token();
  await page.goto(`index.html#/c/${cid}/table`);
  const box = page.locator(".tv-discord");
  await expect(box).toContainText("No Discord channels yet.");
  await box.getByRole("button", { name: "Add Discord channel…" }).click();
  const d = page.getByRole("dialog", { name: "Add Discord channel" });
  await d.getByLabel("Label").fill("#campaign-log");
  await d.getByLabel("Webhook address").fill(hook(t));
  await d.getByLabel("Clocks filling").uncheck();
  await d.getByRole("button", { name: "Add channel" }).click();
  await expect(box).toContainText("#campaign-log");
  await expect(box).toContainText("time passing, new events, sessions ending");
  await expect(box).not.toContainText(t);
  await box.getByRole("button", { name: "Test" }).click();
  await expect(box).toContainText("last posted");
  expect(posts(t)[0].content).toContain("This channel now hears from GM's Almanac.");
  await box.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(box).toContainText("No Discord channels yet.");
  await expectNoErrors(errors);
});
