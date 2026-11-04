// From the code review: an Encyclopedia entry or a day's notes saved from an older copy is refused instead of
// overwriting someone else's words (as tomes are), and one account can't grow the database without bound: campaigns
// per account, rows per campaign and a day's worth of saves all have a ceiling (limits in the config).
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const userId = email => Number(sql(`SELECT id FROM users WHERE email = '${email}'`).trim());

test("an entry saved from an older copy is refused, and a fresh one goes through", async ({ page, browser }) => {
  const gm = person("Una"), player = person("Vic");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Stale ${gm.id}`);
  const pp = await (await newContext(browser)).newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

  const { id, version } = (await api(page, "entry_save", { name: "Altdorf", notes: "<p>A city.</p>" }, cid)).json;
  expect(version).toBe(1);
  // both open it; the player saves first
  const seen = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.id === id);
  expect(seen.version).toBe(1);
  const mine = await api(pp, "entry_save", { id, version: 1, name: "Altdorf", notes: "<p>A city on the Reik.</p>" }, cid);
  expect(mine.json.version).toBe(2);
  const late = await api(page, "entry_save", { id, version: 1, name: "Altdorf", notes: "<p>The capital.</p>" }, cid);
  expect(late.status).toBe(409);
  expect(late.json.error).toBe("stale");
  expect(sql(`SELECT notes FROM encyclopedia_entries WHERE id = ${id}`).trim()).toBe("<p>A city on the Reik.</p>");
  // a line added from At the Table counts as a save too
  await api(pp, "entry_note_add", { id, body: "Rain again" }, cid);
  expect((await api(page, "entry_save", { id, version: 2, name: "Altdorf", notes: "<p>x</p>" }, cid)).status).toBe(409);
  expect((await api(page, "entry_save", { id, version: 3, name: "Altdorf", notes: "<p>The capital.</p>" }, cid)).json.version).toBe(4);
});

test("a day's notes saved from an older copy are refused; the weather saves without a check", async ({ page, browser }) => {
  const gm = person("Wes");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Day ${gm.id}`);
  // a day with no row yet is version 0
  expect((await api(page, "day_update", { abs_day: 5, version: 0, notes: "First", locations: "" }, cid)).json.version).toBe(1);
  const day = await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=5`)).json();
  expect(day.day.version).toBe(1);
  // the weather, saved by the GM's browser, changes no version and isn't checked
  expect((await api(page, "day_update", { abs_day: 5, weather: { t: 3 } }, cid)).json.version).toBe(1);
  // a co-GM's tab saves; the first tab's older copy is refused
  expect((await api(page, "day_update", { abs_day: 5, version: 1, notes: "Second" }, cid)).json.version).toBe(2);
  const late = await api(page, "day_update", { abs_day: 5, version: 1, notes: "Third" }, cid);
  expect(late.status).toBe(409);
  expect(late.json.error).toBe("stale");
  expect(sql(`SELECT notes FROM days WHERE campaign_id = ${cid} AND abs_day = 5`).trim()).toBe("Second");
});

test("an account has room for 50 campaigns of its own", async ({ page, browser }) => {
  const gm = person("Xan");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `First ${gm.id}`);
  const uid = userId(gm.email);
  sql(`INSERT INTO campaigns (name, calendar_json, settings_json, seed, created_by)
    SELECT CONCAT('Filler ', n), '{}', '{}', 1, ${uid} FROM (WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 49) SELECT n FROM s) t`);
  const r = await api(page, "campaign_create", { name: "One more", calendar: {}, settings: {} });
  expect(r.status).toBe(403);
  expect(r.json.error).toBe("campaign_limit");
  expect((await api(page, "campaign_copy", { name: "A copy" }, cid)).json.error).toBe("campaign_limit");
  sql(`DELETE FROM campaigns WHERE created_by = ${uid} AND name LIKE 'Filler %'`);
});

test("a campaign has room for so many days, and a day's saves have a ceiling", async ({ page, browser }) => {
  const gm = person("Yves");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Rows ${gm.id}`);
  sql(`SET SESSION cte_max_recursion_depth = 50000;
    INSERT INTO days (campaign_id, abs_day) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 39999) SELECT ${cid}, n FROM s`);
  expect((await api(page, "days_save", { days: [{ abs_day: 50000, weather: {} }] }, cid)).status).toBe(200);   // the 40,000th
  const over = await api(page, "days_save", { days: [{ abs_day: 50001, weather: {} }] }, cid);
  expect(over.status).toBe(413);
  expect(over.json.error).toBe("row_limit");
  expect((await api(page, "day_update", { abs_day: 50002, notes: "x" }, cid)).json.error).toBe("row_limit");
  // a day already there can still change
  expect((await api(page, "day_update", { abs_day: 7, notes: "Still fine" }, cid)).status).toBe(200);
  sql(`DELETE FROM days WHERE campaign_id = ${cid}`);

  // 50 MB of saves a day: past it, a save is refused until tomorrow
  const uid = userId(gm.email);
  sql(`INSERT INTO rate_limits (bucket, id, window_start, hits) VALUES ('write_kb', 'u${uid}', FLOOR(UNIX_TIMESTAMP() / 86400) * 86400, 51200)
    ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), hits = VALUES(hits)`);
  const r = await api(page, "event_save", { abs_day: 3, title: "Too much" }, cid);
  expect(r.status).toBe(429);
  expect(r.json.message).toMatch(/until tomorrow/);
  sql(`DELETE FROM rate_limits WHERE bucket = 'write_kb' AND id = 'u${uid}'`);
});
