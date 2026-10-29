// Party groups: the main group (every player, its region the campaign's current one) and the groups split from it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

/** A GM with a campaign, `n` players in it (each with a page) and a second and third region. */
async function setup(page, browser, label, n = 3) {
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const players = [];
  for (let i = 0; i < n; i++) {
    const who = person(`Pat${i}`);
    const ctx = await browser.newContext();
    const pp = await ctx.newPage();
    await signIn(pp, who);
    await approve(browser, who.email);
    expect((await api(page, "member_add", { email: who.email, role: "player" }, cid)).status).toBe(200);
    players.push({ pp, who });
  }
  const camp = await api(page, "campaign", undefined, cid);
  const idOf = email => camp.json.members.find(m => m.email === email).id;
  for (const p of players) p.id = idOf(p.who.email);
  const home = camp.json.regions[0].id;
  const b = (await api(page, "region_save", { name: "Beta" }, cid)).json.id;
  const c = (await api(page, "region_save", { name: "Gamma" }, cid)).json.id;
  return { cid, players, ids: players.map(p => p.id), home, b, c };
}
const groups = async (page, cid) => (await api(page, "groups", undefined, cid)).json.groups;
const sorted = a => [...a].sort((x, y) => x - y);

test("Party: a campaign starts with one main group holding every player", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, home, players } = await setup(page, browser, "Party start");
  const g = await api(page, "groups", undefined, cid);
  expect(g.status, JSON.stringify(g.json)).toBe(200);
  expect(g.json.groups).toHaveLength(1);
  expect(g.json.groups[0]).toMatchObject({ name: "The party", is_main: true, region_id: home, map_id: null, x: null, y: null, token_id: null, token_url: null });
  expect(sorted(g.json.groups[0].members)).toEqual(sorted(ids));
  // reading again does not make another
  expect(await groups(players[0].pp, cid)).toHaveLength(1);
  expectNoErrors(errors);
});

test("Party: a player who joins later is in the main group", async ({ page, browser }) => {
  const { cid, ids } = await setup(page, browser, "Party late", 2);
  await groups(page, cid);   // the groups now exist
  const late = person("Late");
  const ctx = await browser.newContext();
  const lp = await ctx.newPage();
  await signIn(lp, late);
  await approve(browser, late.email);
  await api(page, "member_add", { email: late.email, role: "player" }, cid);
  const lateId = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.email === late.email).id;
  const g = await groups(lp, cid);   // even a player's read puts them in
  expect(g).toHaveLength(1);
  expect(sorted(g[0].members)).toEqual(sorted([...ids, lateId]));
});

test("Party: splitting moves members, and merging brings them back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, b } = await setup(page, browser, "Party split");
  const main = (await groups(page, cid))[0];
  const bad = await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [999999] }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toBe("Pick who goes from that group");
  const s = await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0], ids[1]], region_id: b }, cid);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  expect(s.json.groups).toHaveLength(2);
  const [m1, scouts] = s.json.groups;
  expect(m1).toMatchObject({ id: main.id, is_main: true });
  expect(m1.members).toEqual([ids[2]]);
  expect(scouts).toMatchObject({ name: "Scouts", is_main: false, region_id: b });
  expect(sorted(scouts.members)).toEqual(sorted([ids[0], ids[1]]));
  // they have left the main group, so can't be split off from it again
  expect((await api(page, "group_split", { from_id: main.id, name: "Again", members: [ids[0]] }, cid)).status).toBe(400);
  // region defaults to the group split from
  const s2 = await api(page, "group_split", { from_id: main.id, name: "Lone", members: [ids[2]] }, cid);
  expect(s2.json.groups.find(g => g.name === "Lone").region_id).toBe(main.region_id);
  const back = await api(page, "group_merge", { id: s2.json.groups.find(g => g.name === "Lone").id, into_id: main.id }, cid);
  expect(back.json.groups).toHaveLength(2);
  const m = await api(page, "group_merge", { id: scouts.id, into_id: main.id }, cid);
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  expect(m.json.groups).toHaveLength(1);
  expect(m.json.groups[0].is_main).toBe(true);
  expect(sorted(m.json.groups[0].members)).toEqual(sorted(ids));
  expect((await api(page, "group_merge", { id: main.id, into_id: main.id }, cid)).status).toBe(400);
  expectNoErrors(errors);
});

test("Party: merging the main group makes the other group main", async ({ page, browser }) => {
  const { cid, ids, b, c } = await setup(page, browser, "Party merge main");
  const main = (await groups(page, cid))[0];
  const s = await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]], region_id: b }, cid);
  const scouts = s.json.groups[1];
  const m = await api(page, "group_merge", { id: main.id, into_id: scouts.id }, cid);
  expect(m.json.groups).toHaveLength(1);
  expect(m.json.groups[0]).toMatchObject({ id: scouts.id, is_main: true });
  expect(sorted(m.json.groups[0].members)).toEqual(sorted(ids));
  const camp = await api(page, "campaign", undefined, cid);
  expect(camp.json.campaign.settings.current_region).toBe(b);
});

test("Party: the main group's region is the current region, both ways", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, b, c } = await setup(page, browser, "Party region");
  const main = (await groups(page, cid))[0];
  const settings = async () => (await api(page, "campaign", undefined, cid)).json.campaign.settings;
  expect((await api(page, "campaign_update", { settings: { ...(await settings()), current_region: b } }, cid)).status).toBe(200);
  expect((await groups(page, cid))[0].region_id).toBe(b);
  const sv = await api(page, "group_save", { id: main.id, region_id: c }, cid);
  expect(sv.status, JSON.stringify(sv.json)).toBe(200);
  expect(sv.json.groups[0].region_id).toBe(c);
  expect((await settings()).current_region).toBe(c);
  const s = await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]], region_id: b }, cid);
  const scouts = s.json.groups[1];
  // a non-main group's region leaves the current region alone
  await api(page, "group_save", { id: scouts.id, region_id: b, name: "Advance party" }, cid);
  expect((await settings()).current_region).toBe(c);
  const mk = await api(page, "group_save", { id: scouts.id, is_main: true }, cid);
  expect(mk.status, JSON.stringify(mk.json)).toBe(200);
  expect(mk.json.groups.map(g => [g.name, g.is_main])).toEqual([["Advance party", true], ["The party", false]]);
  expect((await settings()).current_region).toBe(b);
  // a region that isn't this campaign's is refused; null is "no region"
  expect((await api(page, "group_save", { id: scouts.id, region_id: 999999 }, cid)).status).toBe(400);
  expect((await api(page, "group_save", { id: main.id, region_id: null }, cid)).json.groups.find(g => g.id === main.id).region_id).toBe(null);
  expect((await api(page, "group_save", { id: scouts.id, is_main: false }, cid)).status).toBe(400);
  expectNoErrors(errors);
});

test("Party: only GMs change groups", async ({ page, browser }) => {
  const { cid, players, ids } = await setup(page, browser, "Party access", 2);
  const main = (await groups(page, cid))[0];
  const pp = players[0].pp;
  for (const [a, body] of [["group_split", { from_id: main.id, name: "X", members: [ids[0]] }], ["group_save", { id: main.id, name: "X" }],
    ["group_move", { id: main.id, map_id: null }], ["group_merge", { id: main.id, into_id: main.id }]]) {
    const r = await api(pp, a, body, cid);
    expect(r.status, a).toBe(403);
  }
  const r = await api(pp, "groups", undefined, cid);
  expect(r.status).toBe(200);
  expect(r.json.groups).toHaveLength(1);
});

test("Party: a player removed from the campaign leaves their group", async ({ page, browser }) => {
  const { cid, ids } = await setup(page, browser, "Party remove");
  const main = (await groups(page, cid))[0];
  await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0], ids[1]] }, cid);
  const r = await api(page, "member_remove", { user_id: ids[0] }, cid);
  expect(r.status).toBe(200);
  const g = await groups(page, cid);
  expect(g.flatMap(x => x.members)).not.toContain(ids[0]);
  expect(sorted(g.flatMap(x => x.members))).toEqual(sorted([ids[1], ids[2]]));
});

test("Party: groups on maps, bounds, tokens and GM-only maps", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, players, ids } = await setup(page, browser, "Party maps", 2);
  const pp = players[0].pp;
  const main = (await groups(page, cid))[0];
  const s = await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]] }, cid);
  const scouts = s.json.groups[1];
  const open = (await api(page, "map_save", { name: "Open" }, cid)).json.map.id;
  const secret = (await api(page, "map_save", { name: "Hidden", is_secret: true }, cid)).json.map.id;
  for (const id of [open, secret]) {   // a picture gives a map its size
    const att = sql(`INSERT INTO attachments (campaign_id, parent_type, parent_id, kind, original_name, stored_name, mime, size_bytes, width, height) VALUES (${cid}, 'map', ${id}, 'image', 'm.png', '${"a".repeat(31)}${id % 10}', 'image/png', 1, 300, 200); SELECT LAST_INSERT_ID();`).trim();
    sql(`UPDATE maps SET image_id=${att}, width=300, height=200 WHERE id=${id}`);
  }
  const bad = await api(page, "group_move", { id: scouts.id, map_id: open, x: 301, y: 10 }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toBe("That's off the map");
  expect((await api(page, "group_move", { id: scouts.id, map_id: 999999, x: 1, y: 1 }, cid)).status).toBe(404);
  const mv = await api(page, "group_move", { id: scouts.id, map_id: open, x: 120, y: 80 }, cid);
  expect(mv.status, JSON.stringify(mv.json)).toBe(200);
  expect(mv.json.groups[1]).toMatchObject({ map_id: open, x: 120, y: 80 });
  await api(page, "group_move", { id: main.id, map_id: secret, x: 10, y: 20 }, cid);
  // the map's own groups; a player doesn't get the one on the GM-only map, nor where it is
  const res = await pp.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: open })}`);
  expect((await res.json()).groups.map(g => g.name)).toEqual(["Scouts"]);
  const gres = await pp.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: secret })}`);
  expect(gres.status()).toBe(404);
  const gmSecret = await page.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: secret })}`);
  expect((await gmSecret.json()).groups.map(g => g.name)).toEqual(["The party"]);
  const seen = await groups(pp, cid);
  expect(seen.find(g => g.is_main)).toMatchObject({ map_id: null, x: null, y: null });
  expect(seen.find(g => !g.is_main)).toMatchObject({ map_id: open, x: 120, y: 80 });
  expect((await groups(page, cid)).find(g => g.is_main)).toMatchObject({ map_id: secret, x: 10, y: 20 });
  // off the map again
  expect((await api(page, "group_move", { id: scouts.id, map_id: null }, cid)).json.groups[1]).toMatchObject({ map_id: null, x: null, y: null });
  // a token's picture: a token of this campaign only, and a GM-only token's is hidden from players
  expect((await api(page, "group_save", { id: scouts.id, token_id: 999999 }, cid)).status).toBe(400);
  const pic = sql(`INSERT INTO attachments (campaign_id, parent_type, parent_id, kind, original_name, stored_name, mime, size_bytes) VALUES (${cid}, 'token', 0, 'image', 't.png', '${"b".repeat(32)}', 'image/png', 1); SELECT LAST_INSERT_ID();`).trim();
  const tok = sql(`INSERT INTO tokens (campaign_id, name, image_id, kind) VALUES (${cid}, 'Banner', ${pic}, 'party'); SELECT LAST_INSERT_ID();`).trim();
  const withTok = await api(page, "group_save", { id: scouts.id, token_id: Number(tok) }, cid);
  expect(withTok.status, JSON.stringify(withTok.json)).toBe(200);
  const g = withTok.json.groups[1];
  expect(g.token_id).toBe(Number(tok));
  expect(g.token_url).toContain(`id=${pic}`);
  expect((await groups(pp, cid)).find(x => x.id === scouts.id).token_url).toBe(g.token_url);
  sql(`UPDATE tokens SET is_secret=1 WHERE id=${tok}`);
  expect((await groups(pp, cid)).find(x => x.id === scouts.id).token_url).toBe(null);
  expect((await groups(page, cid)).find(x => x.id === scouts.id).token_url).toBe(g.token_url);
  expect((await api(page, "group_save", { id: scouts.id, token_id: null }, cid)).json.groups[1]).toMatchObject({ token_id: null, token_url: null });
  expectNoErrors(errors);
});
