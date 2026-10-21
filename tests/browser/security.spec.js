// Checks from the security review: a GM can't reach into another campaign's events through an event id, a
// player's edit doesn't undo the GM's secret flag, and a player who may not see future weather isn't sent the
// seed that rolls it.
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

test("a GM can't change the tags of an event in someone else's campaign", async ({ page, browser }) => {
  const owner = person("Nell"), other = person("Olaf");
  await signIn(page, owner);
  await approve(browser, owner.email);
  const cid = await makeCampaign(page, `Tags ${owner.id}`);
  const eid = (await api(page, "event_save", { abs_day: 3, title: "Market day", tags: [{ name: "Fair" }] }, cid)).json.id;

  const octx = await browser.newContext();
  const op = await octx.newPage();
  await signIn(op, other);
  await approve(browser, other.email);
  const mine = await makeCampaign(op, `Mine ${other.id}`);
  const r = await api(op, "event_save", { id: eid, abs_day: 3, title: "Market day", tags: [{ name: "Pwned", color: "#000000" }] }, mine);
  expect(r.status).toBe(404);
  await octx.close();

  const ev = (await api(page, "events", undefined, cid)).json.events.find(e => e.id === eid);
  expect(ev.tags.map(t => t.name)).toEqual(["Fair"]);
});

test("a player's edit keeps the secret flag the GM set on their event", async ({ page, browser }) => {
  const gm = person("Pia"), player = person("Quin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Secret ${gm.id}`);
  await api(page, "campaign_update", { settings: { players_can_add_events: true } }, cid);

  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const eid = (await api(pp, "event_save", { abs_day: 4, title: "Our plan" }, cid)).json.id;

  await api(page, "event_save", { id: eid, abs_day: 4, title: "Our plan", is_secret: true }, cid);
  expect((await api(pp, "event_save", { id: eid, abs_day: 4, title: "Our plan, revised" }, cid)).status).toBe(200);
  expect(sql(`SELECT is_secret FROM events WHERE id = ${eid}`).trim()).toBe("1");
  await pctx.close();
});

test("only those who may see future weather are sent the weather seed", async ({ page, browser }) => {
  const gm = person("Rex"), player = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Seed ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  await api(page, "member_add", { email: player.email, role: "player" }, cid);

  expect(typeof (await api(page, "campaign", undefined, cid)).json.campaign.seed).toBe("number");
  expect((await api(pp, "campaign", undefined, cid)).json.campaign.seed).toBeUndefined();
  await api(page, "campaign_update", { settings: { players_see_future_weather: true } }, cid);
  expect(typeof (await api(pp, "campaign", undefined, cid)).json.campaign.seed).toBe("number");
  await pctx.close();
});
