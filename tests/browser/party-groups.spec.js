// Party groups: the main group (every player, its region the campaign's current one) and the groups split from it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, mapWithPicture, tokenUpload, settledBox, newContext, closeContexts, moreIn } = require("./helpers");
test.afterEach(closeContexts);

/** A GM with a campaign, `n` players in it (each with a page) and a second and third region. */
async function setup(page, browser, label, n = 3) {
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const players = [];
  for (let i = 0; i < n; i++) {
    const who = person(`Pat${i}`);
    const ctx = await newContext(browser);
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
  const ctx = await newContext(browser);
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

test("Party: only GMs change groups (a player only splits themselves off)", async ({ page, browser }) => {
  const { cid, players, ids } = await setup(page, browser, "Party access", 2);
  const main = (await groups(page, cid))[0];
  const pp = players[0].pp;
  for (const [a, body] of [["group_split", { from_id: main.id, name: "X", members: [ids[1]] }], ["group_save", { id: main.id, name: "X" }],
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
    const att = sql(`INSERT INTO attachments (campaign_id, parent_type, parent_id, kind, original_name, stored_name, mime, size_bytes, width, height) VALUES (${cid}, 'map', ${id}, 'image', 'm.png', '${require("crypto").randomBytes(16).toString("hex")}', 'image/png', 1, 300, 200); SELECT LAST_INSERT_ID();`).trim();
    sql(`UPDATE maps SET image_id=${att}, width=300, height=200 WHERE id=${id}`);
  }
  const bad = await api(page, "group_move", { id: scouts.id, map_id: open, x: 301, y: 10 }, cid);
  expect(bad.status).toBe(400);
  expect(bad.json.message).toBe("That's off the map");
  expect((await api(page, "group_move", { id: scouts.id, map_id: 999999, x: 1, y: 1 }, cid)).status).toBe(404);
  const mv = await api(page, "group_move", { id: scouts.id, map_id: open, x: 120, y: 80 }, cid);
  expect(mv.status, JSON.stringify(mv.json)).toBe(200);
  expect(mv.json.groups[1]).toMatchObject({ map_id: open, x: 120, y: 80 });
  // the trail: a move in the same shift replaces the group's last point, a move in a later shift adds one
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  await api(page, "group_move", { id: scouts.id, map_id: open, x: 130, y: 90 }, cid);
  await api(page, "set_time", { current_shift: now + 1 }, cid);
  await api(page, "group_move", { id: scouts.id, map_id: open, x: 200, y: 150 }, cid);
  const trailOf = async (who, mapId) => (await (await who.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: mapId })}`)).json()).trail;
  const expected = [{ group_id: scouts.id, x: 130, y: 90, abs_shift: now }, { group_id: scouts.id, x: 200, y: 150, abs_shift: now + 1 }];
  expect(await trailOf(page, open)).toEqual(expected);
  expect(await trailOf(pp, open)).toEqual(expected);      // players see the trail on a map they can open
  expect((await api(pp, "trail_clear", { map_id: open, id: scouts.id }, cid)).status).toBe(403);
  expect((await api(page, "trail_clear", { map_id: open, id: scouts.id }, cid)).status).toBe(200);
  expect(await trailOf(page, open)).toEqual([]);
  await api(page, "group_move", { id: scouts.id, map_id: open, x: 120, y: 80 }, cid);
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
  const pic = sql(`INSERT INTO attachments (campaign_id, parent_type, parent_id, kind, original_name, stored_name, mime, size_bytes) VALUES (${cid}, 'token', 0, 'image', 't.png', '${require("crypto").randomBytes(16).toString("hex")}', 'image/png', 1); SELECT LAST_INSERT_ID();`).trim();
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

test("Party: group_join moves one player to another group, and refuses anyone not in the party", async ({ page, browser }) => {
  const { cid, ids } = await setup(page, browser, "Party join", 3);
  const main = (await groups(page, cid))[0];
  const scouts = (await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]] }, cid)).json.groups[1];
  const r = await api(page, "group_join", { id: scouts.id, member: ids[1] }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(sorted(r.json.groups.find(g => g.id === scouts.id).members)).toEqual(sorted([ids[0], ids[1]]));
  expect(r.json.groups.find(g => g.id === main.id).members).toEqual([ids[2]]);
  // joining the group they're in already changes nothing, and they're never listed twice
  expect((await api(page, "group_join", { id: scouts.id, member: ids[1] }, cid)).json.groups.find(g => g.id === scouts.id).members.filter(u => u === ids[1])).toHaveLength(1);
  // not a player, both or neither, or a group of nobody's
  expect((await api(page, "group_join", { id: scouts.id, member: 999999 }, cid)).status).toBe(400);
  expect((await api(page, "group_join", { id: scouts.id }, cid)).status).toBe(400);
  expect((await api(page, "group_join", { id: scouts.id, member: ids[2], character: 1 }, cid)).status).toBe(400);
  expect((await api(page, "group_join", { id: scouts.id, character: 999999 }, cid)).status).toBe(404);
  expect((await api(page, "group_join", { id: 999999, member: ids[2] }, cid)).status).toBe(404);
});

test("Party: a player moves only themselves, starts a group of their own, and a GM can keep a group together", async ({ page, browser }) => {
  const { cid, ids, players } = await setup(page, browser, "Party moves", 3);
  const [p0, p1] = [players[0].pp, players[1].pp];
  const main = (await groups(page, cid))[0];
  const scouts = (await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[2]] }, cid)).json.groups[1];
  expect(scouts.players_can_move).toBe(true);
  // a player moves themselves, never anyone else
  let r = await api(p0, "group_join", { id: scouts.id, member: ids[0] }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(sorted(r.json.groups.find(g => g.id === scouts.id).members)).toEqual(sorted([ids[0], ids[2]]));
  expect((await api(p0, "group_join", { id: scouts.id, member: ids[1] }, cid)).status).toBe(403);
  expect((await api(p0, "group_join", { id: null, member: ids[0] }, cid)).status).toBe(403);   // only a GM takes someone out
  // a group the GM keeps together: no one moves in or out of it
  expect((await api(page, "group_save", { id: scouts.id, players_can_move: false }, cid)).json.groups[1].players_can_move).toBe(false);
  expect((await api(p0, "group_join", { id: main.id, member: ids[0] }, cid)).status).toBe(403);
  expect((await api(p1, "group_join", { id: scouts.id, member: ids[1] }, cid)).status).toBe(403);
  expect((await api(p0, "group_split", { from_id: scouts.id, name: "Me", members: [ids[0]] }, cid)).status).toBe(403);
  await api(page, "group_save", { id: scouts.id, players_can_move: true }, cid);
  // a player starts a group of their own, with only themselves in it
  expect((await api(p1, "group_split", { from_id: main.id, name: "Lone", members: [ids[1], ids[0]] }, cid)).status).toBe(403);
  r = await api(p1, "group_split", { from_id: main.id, name: "Lone", members: [ids[1]] }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.groups.find(g => g.name === "Lone").members).toEqual([ids[1]]);
});

test("Party: every character travels in a group of its own: a player's two split up, and a GM takes one out and back", async ({ page, browser }) => {
  const { cid, ids, players } = await setup(page, browser, "Party chars", 2);
  const [p0, p1] = [players[0].pp, players[1].pp];
  const tpl = (await api(page, "template_save", { name: `Out sheet ${cid}`, game: "Test RPG", layout: { sections: [{ key: "s", title: "S", fields: [{ key: "hp", label: "HP", type: "number" }] }] } })).json.template;
  const pc = (await api(p0, "character_create", { template_id: tpl.id, name: "Benchwarmer" }, cid)).json.character;
  const alt = (await api(p0, "character_create", { template_id: tpl.id, name: "Second Self" }, cid)).json.character;
  const npc = (await api(page, "character_create", { template_id: tpl.id, name: "Stray Dog", kind: "npc", owner_id: 0 }, cid)).json.character;
  // a player's new characters start in the main group and stand for them; a player with no sheet is there as themselves
  let g = await groups(page, cid);
  const main = g[0];
  expect(main.characters.filter(c => c.player_id === ids[0]).map(c => c.name).sort()).toEqual(["Benchwarmer", "Second Self"]);
  expect(main.members).toEqual([ids[1]]);
  expect(main.characters.map(c => c.name)).not.toContain("Stray Dog");
  // the GM splits one of them off: the player's two characters travel apart
  let r = await api(page, "group_split", { from_id: main.id, name: "Scouts", characters: [alt.id] }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const scouts = r.json.groups.find(x => x.name === "Scouts");
  expect(scouts.characters.map(c => c.name)).toEqual(["Second Self"]);
  expect(r.json.groups[0].characters.map(c => c.name)).toContain("Benchwarmer");
  // its player moves either of their own; no one else's
  r = await api(p0, "group_join", { id: scouts.id, character: pc.id }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.groups.find(x => x.id === scouts.id).characters.map(c => c.name).sort()).toEqual(["Benchwarmer", "Second Self"]);
  expect((await api(p1, "group_join", { id: main.id, character: pc.id }, cid)).status).toBe(403);
  expect((await api(page, "group_join", { id: main.id, member: ids[0] }, cid)).status).toBe(400);   // they have a sheet: move a character
  // and starts a group of their own with one of them, never with someone else's
  expect((await api(p0, "group_split", { from_id: scouts.id, name: "Lone", characters: [pc.id, alt.id] }, cid)).status).toBe(403);
  r = await api(p0, "group_split", { from_id: scouts.id, name: "Lone", characters: [alt.id] }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.groups.find(x => x.name === "Lone").characters.map(c => c.name)).toEqual(["Second Self"]);
  // a GM takes one out of the party: in no group, and its player can't walk it back in
  r = await api(page, "group_join", { id: null, character: pc.id }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.groups.flatMap(x => x.characters).map(c => c.name)).not.toContain("Benchwarmer");
  expect(sql(`SELECT party_group_id IS NULL FROM sheet_characters WHERE id=${pc.id}`).trim()).toBe("1");
  expect((await api(p0, "group_join", { id: main.id, character: pc.id }, cid)).status).toBe(403);
  r = await api(page, "group_join", { id: main.id, character: pc.id }, cid);
  expect(r.json.groups[0].characters.map(c => c.name)).toContain("Benchwarmer");
  // a character with no player who wasn't travelling joins, and leaves again
  expect((await api(page, "group_join", { id: main.id, character: npc.id }, cid)).json.groups[0].characters.map(c => c.name)).toContain("Stray Dog");
  expect((await api(page, "group_join", { id: null, character: npc.id }, cid)).json.groups[0].characters.map(c => c.name)).not.toContain("Stray Dog");
  expect((await api(p1, "group_join", { id: main.id, character: npc.id }, cid)).status).toBe(403);
  // a player who leaves the campaign takes their characters out of the party
  expect((await api(page, "member_remove", { user_id: ids[0] }, cid)).status).toBe(200);
  g = await groups(page, cid);
  expect(g.flatMap(x => x.characters).map(c => c.name)).not.toContain("Benchwarmer");
  expect(g.flatMap(x => x.characters).map(c => c.name)).not.toContain("Second Self");
});

test("Party: a player with two characters moves either on Party → Groups, and starts a group with one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, players } = await setup(page, browser, "Party two", 2);
  const pp = players[0].pp;
  const tpl = (await api(page, "template_save", { name: `Two sheet ${cid}`, game: "Test RPG", layout: { sections: [{ key: "s", title: "S", fields: [{ key: "hp", label: "HP", type: "number" }] }] } })).json.template;
  await api(pp, "character_create", { template_id: tpl.id, name: "Ada" }, cid);
  await api(pp, "character_create", { template_id: tpl.id, name: "Bea" }, cid);
  const main = (await groups(page, cid))[0];
  await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [players[1].id] }, cid);
  await pp.goto(`#/c/${cid}/groups`);
  // both are theirs to move, and no one else
  await expect(pp.getByRole("button", { name: /^Move / })).toHaveCount(2);
  await expect(rowOf(pp, "The party").locator(".group-member", { hasText: "Ada" })).toContainText("You");
  await pp.getByRole("button", { name: "Move Bea" }).click();
  await pp.locator("dialog.party-dialog").getByRole("button", { name: "Move", exact: true }).click();
  await expect(rowOf(pp, "Scouts").locator(".group-members")).toContainText("Bea");
  await expect(rowOf(pp, "The party").locator(".group-members")).toContainText("Ada");
  // Start a group: Bea shares Scouts, so she can go off on her own (Ada is alone in hers)
  await pp.getByRole("button", { name: "+ Start a group" }).click();
  const dlg = pp.locator("dialog.party-dialog");
  await dlg.getByLabel("Group name").fill("Bea alone");
  await dlg.getByRole("button", { name: "Start" }).click();
  await expect(rowOf(pp, "Bea alone").locator(".group-members")).toContainText("Bea");
  await expect(pp.getByRole("button", { name: "+ Start a group" })).toBeHidden();   // each is alone now
  expectNoErrors(errors);
});

test("Party: the GM drags someone onto another group, and into and out of the party from the tray", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, players } = await setup(page, browser, "Party drag", 3);
  const tpl = (await api(page, "template_save", { name: `Drag sheet ${cid}`, game: "Test RPG", layout: { sections: [{ key: "s", title: "S", fields: [{ key: "hp", label: "HP", type: "number" }] }] } })).json.template;
  await api(page, "character_create", { template_id: tpl.id, name: "Stray Dog", kind: "npc", owner_id: 0 }, cid);
  const main = (await groups(page, cid))[0];
  await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[2]] }, cid);
  await page.goto(`#/c/${cid}/groups`);
  const dragTo = async (row, target) => {
    // on a phone the groups stack: start with the row near the top of the screen (clear of the edge that scrolls), so the
    // group below it is on screen too
    await row.evaluate(e => { e.scrollIntoView({ block: "start" }); scrollBy(0, -90); });
    const from = await row.locator(".group-grip").boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await dragTo(rowOf(page, "The party").locator(".group-member", { hasText: "Pat0" }), rowOf(page, "Scouts"));
  await expect(rowOf(page, "Scouts").locator(".group-members")).toContainText("Pat0");
  expect(sorted((await groups(page, cid))[1].members)).toEqual(sorted([ids[0], ids[2]]));
  // the tray: Stray Dog isn't travelling; Move… brings it in, and a drag onto the tray takes it out again
  const tray = page.locator(".group-tray");
  await tray.locator("summary").click();
  await tray.getByRole("button", { name: "Move Stray Dog" }).click();
  await page.locator("dialog.party-dialog").getByLabel("Move to").selectOption({ label: "Scouts" });
  await page.locator("dialog.party-dialog").getByRole("button", { name: "Move", exact: true }).click();
  await expect(rowOf(page, "Scouts").locator(".group-members")).toContainText("Stray Dog");
  await dragTo(rowOf(page, "Scouts").locator(".group-member", { hasText: "Stray Dog" }), tray.locator("summary"));
  await expect(rowOf(page, "Scouts").locator(".group-members")).not.toContainText("Stray Dog");
  await expect(tray).toContainText("Stray Dog");
  // a player can move only their own row, and has no tray
  const pp = players[1].pp;
  await pp.goto(`#/c/${cid}/groups`);
  await expect(pp.getByRole("button", { name: /^Move / })).toHaveCount(1);
  await expect(pp.getByRole("button", { name: "Move Pat1" })).toBeVisible();
  await expect(pp.locator(".group-tray")).toBeHidden();
  await expect(pp.getByRole("button", { name: "+ Start a group" })).toBeHidden();   // alone in their group: nothing to start
  expectNoErrors(errors);
});

test("Party: a member made a GM drops out of every group on the next read", async ({ page, browser }) => {
  const { cid, ids } = await setup(page, browser, "Party role", 3);
  const main = (await groups(page, cid))[0];
  await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0], ids[1]] }, cid);
  const email = (await api(page, "campaign", undefined, cid)).json.members.find(m => m.id === ids[0]).email;
  expect((await api(page, "member_add", { email, role: "gm" }, cid)).status).toBe(200);
  const g = await groups(page, cid);
  expect(g.flatMap(x => x.members)).not.toContain(ids[0]);
  expect(sorted(g.flatMap(x => x.members))).toEqual(sorted([ids[1], ids[2]]));
  // a GM can't be split off either
  const r = await api(page, "group_split", { from_id: g[0].id, name: "X", members: [ids[0]] }, cid);
  expect(r.status).toBe(400);
});

test("Party: one tab in the Legend over Characters, Groups and Holdings, opening the one used last", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Party tab", 1);
  await page.goto(`#/c/${cid}/party`);
  await expect(page).toHaveURL(/\/characters$/);   // the first time: Characters
  await expect(page.locator(".tabs a.on")).toHaveText("Party");
  await expect(page.locator(".subtabs a")).toHaveText(["Characters", "Groups", "Holdings"]);
  await expect(page.locator(".subtabs a.on")).toHaveText("Characters");
  await expect(page.getByRole("button", { name: "+ New character" })).toBeVisible();
  await page.locator(".subtabs").getByRole("link", { name: "Holdings" }).click();
  await expect(page).toHaveURL(/\/holdings$/);
  await expect(page.locator(".tabs a.on")).toHaveText("Party");
  await expect(page.locator(".gear")).toBeVisible();
  await page.goto(`#/c/${cid}/table`);
  await page.goto(`#/c/${cid}/party`);
  await expect(page).toHaveURL(/\/holdings$/);   // then the one you were on
  expectNoErrors(errors);
});

// ---- Party → Groups, Travel's line per group, and the markers on the map

const rowOf = (page, name) => page.locator(".group-card").filter({ has: page.locator(".party-name", { hasText: name }) });

test("Party: the GM splits and merges on Party → Groups", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, players } = await setup(page, browser, "Party card", 3);
  await page.goto(`#/c/${cid}/groups`);
  await expect(page.locator(".tabs a.on")).toHaveText("Party");
  await expect(page.locator(".subtabs a.on")).toHaveText("Groups");
  await expect(page.locator(".group-card")).toHaveCount(1);
  await expect(page.locator(".group-card .group-members")).toContainText("Pat0");
  await page.getByRole("button", { name: "+ New group" }).click();
  const d = page.locator("dialog.party-dialog");
  await d.getByLabel("Group name").fill("Scouts");
  await d.getByLabel("Pat1", { exact: true }).check();
  await d.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator(".group-card")).toHaveCount(2);
  const g = await groups(page, cid);
  expect(g[1]).toMatchObject({ name: "Scouts", members: [players[1].id] });
  await expect(rowOf(page, "Scouts").locator(".group-members")).toContainText("Pat1");
  await expect(rowOf(page, "The party").locator(".group-members")).not.toContainText("Pat1");

  // Move… sends one person to another group, and Travel lists each group in a line
  await rowOf(page, "The party").getByRole("button", { name: "Move Pat2" }).click();
  await page.locator("dialog.party-dialog").getByLabel("Move to").selectOption({ label: "Scouts" });
  await page.locator("dialog.party-dialog").getByRole("button", { name: "Move", exact: true }).click();
  await expect(rowOf(page, "Scouts").locator(".group-members")).toContainText("Pat2");
  expect(sorted((await groups(page, cid))[1].members)).toEqual(sorted([players[1].id, players[2].id]));
  await page.goto(`#/c/${cid}/travel`);
  await expect(page.locator(".party-summary .party-line")).toHaveCount(2);
  await page.locator(".party-summary").getByRole("link", { name: "Groups →" }).click();
  await expect(page).toHaveURL(/\/groups$/);

  await moreIn(rowOf(page, "Scouts"), "Rename");
  await page.locator("dialog .kit-dialog-input").fill("Advance party");
  await page.locator("dialog").getByRole("button", { name: "Save" }).click();
  await expect(rowOf(page, "Advance party")).toHaveCount(1);

  await moreIn(rowOf(page, "Advance party"), "Make main group");
  await expect(rowOf(page, "Advance party").locator(".party-main")).toHaveCount(1);
  expect((await groups(page, cid))[0].name).toBe("Advance party");

  await moreIn(rowOf(page, "Advance party"), "Merge into…");
  await page.locator("dialog.party-dialog").getByLabel("Merge into").selectOption({ label: "The party" });
  await page.locator("dialog.party-dialog").getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.locator(".group-card")).toHaveCount(1);
  const after = await groups(page, cid);
  expect(after).toHaveLength(1);
  expect(sorted(after[0].members)).toEqual(sorted(players.map(p => p.id)));
  expectNoErrors(errors);
});

test("Party: a group shows on the maps as one marker, its characters' tokens, or not at all to players", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, players } = await setup(page, browser, "Party display", 2);
  const [p0, p1] = [players[0].pp, players[1].pp];
  const tpl = (await api(page, "template_save", { name: `Display sheet ${cid}`, game: "Test RPG", layout: { sections: [{ key: "s", title: "S", fields: [{ key: "hp", label: "HP", type: "number" }] }] } })).json.template;
  const ada = (await api(p0, "character_create", { template_id: tpl.id, name: "Ada" }, cid)).json.character;
  const bo = (await api(p1, "character_create", { template_id: tpl.id, name: "Bo" }, cid)).json.character;
  await api(page, "character_create", { template_id: tpl.id, name: "Mule", kind: "npc", owner_id: 0, party: true }, cid);
  const mapId = await mapWithPicture(page, cid);
  const main = (await groups(page, cid))[0];
  expect(main.map_display).toBe("marker");
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 150, y: 100 }, cid);

  // the GM picks each character's token on Party → Groups: the map draws a face for each around the marker
  await page.goto(`#/c/${cid}/groups`);
  await page.getByLabel("How The party shows on the maps").selectOption("tokens");
  await expect.poll(async () => (await groups(page, cid))[0].map_display).toBe("tokens");
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".map-party .map-ring-face")).toHaveCount(3);
  // a player leaves their own character off with its eye, never someone else's
  expect((await api(p0, "party_on_map", { character: bo.id, on_map: false }, cid)).status).toBe(403);
  await p0.goto(`#/c/${cid}/groups`);
  await expect(p0.getByRole("button", { name: /^(Hide|Show) .* on the map$/ })).toHaveCount(1);
  await p0.getByRole("button", { name: "Hide Ada on the map" }).click();
  await expect(p0.getByRole("button", { name: "Show Ada on the map" })).toBeVisible();
  expect(sql(`SELECT on_map FROM sheet_characters WHERE id=${ada.id}`).trim()).toBe("0");
  await p1.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(p1.locator(".map-party .map-ring-face")).toHaveCount(2);
  await expect(p1.locator(".map-party .map-ring-face[title='Ada']")).toHaveCount(0);

  // hidden: players lose the marker and its trail; the GM still sees it, faded
  expect((await api(page, "group_save", { id: main.id, map_display: "sideways" }, cid)).status).toBe(400);
  expect((await api(p0, "group_save", { id: main.id, map_display: "hidden" }, cid)).status).toBe(403);
  expect((await api(page, "group_save", { id: main.id, map_display: "hidden" }, cid)).status).toBe(200);
  const seen = await (await p1.request.get(`api/index.php?${new URLSearchParams({ a: "map", cid, id: mapId })}`)).json();
  expect(seen.groups).toHaveLength(0);
  expect(seen.trail).toHaveLength(0);
  expect((await groups(p1, cid))[0]).toMatchObject({ map_id: null, x: null, y: null });
  await p1.reload();
  await expect(p1.locator(".map-stage")).toBeVisible();
  await expect(p1.locator(".map-party")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".map-party.map-party-hidden")).toHaveCount(1);
  await expect(page.locator(".map-party")).toContainText("(hidden)");
  // back to one marker: no ring
  await api(page, "group_save", { id: main.id, map_display: "marker" }, cid);
  await p1.reload();
  await expect(p1.locator(".map-party")).toHaveCount(1);
  await expect(p1.locator(".map-ring-face")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Party: a player sees the markers but can't drag them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, players } = await setup(page, browser, "Party player", 2);
  const mapId = await mapWithPicture(page, cid);
  const main = (await groups(page, cid))[0];
  await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]] }, cid);
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 100, y: 100 }, cid);
  const pp = players[1].pp;

  await pp.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(pp.locator(".map-party")).toHaveCount(1);
  await expect(pp.locator(".map-party")).toContainText("The party");
  await expect(pp.locator(".leaflet-marker-draggable")).toHaveCount(0);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".leaflet-marker-draggable .map-party")).toHaveCount(1);

  // Party → Groups is read-only for a player
  await pp.goto(`#/c/${cid}/groups`);
  await expect(pp.locator(".group-card")).toHaveCount(2);
  await expect(pp.locator(".group-board .kit-menu")).toHaveCount(0);   // no ⋯ for a player
  await expect(pp.getByRole("button", { name: "+ New group" })).toHaveCount(0);
  expect((await api(pp, "group_join", { id: main.id, member: ids[0] }, cid)).status).toBe(403);
  expect((await api(pp, "group_move", { id: main.id, map_id: mapId, x: 5, y: 5 }, cid)).status).toBe(403);
  expectNoErrors(errors);
});

test("Party: a GM drags a group's marker and it stays there", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Party drag", 1);
  const mapId = await mapWithPicture(page, cid);
  const main = (await groups(page, cid))[0];
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 100, y: 100 }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  const m = page.locator(".leaflet-marker-draggable").filter({ has: page.locator(".map-party") });
  await m.scrollIntoViewIfNeeded();   // a raw drag doesn't scroll, and on a short phone screen the map is below the fold
  const box = await settledBox(m);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await groups(page, cid))[0].x).toBeGreaterThan(100);
  expect((await groups(page, cid))[0].y).toBeGreaterThan(100);
  expectNoErrors(errors);
});

test("Party: the map draws a group's trail, shift by shift, and the legend hides it", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Party trail", 1);
  const mapId = await mapWithPicture(page, cid);
  const main = (await groups(page, cid))[0];
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 50, y: 50 }, cid);
  await api(page, "set_time", { current_shift: now + 1 }, cid);
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 150, y: 100 }, cid);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator("path.map-trail-dot")).toHaveCount(2);
  await expect(page.locator("path.map-trail-line")).toHaveCount(1);
  // the legend's Trail hides it (a phone has no legend, so the trail just shows there)
  if (await page.locator(".map-legend").isVisible()) {
    const toggle = page.getByRole("button", { name: "Trail" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.locator("path.map-trail-dot")).toHaveCount(0);
    await page.reload();   // remembered in this browser
    await expect(page.locator(".map-party")).toHaveCount(1);
    await expect(page.locator("path.map-trail-dot")).toHaveCount(0);
    await page.getByRole("button", { name: "Trail" }).click();
    await expect(page.locator("path.map-trail-dot")).toHaveCount(2);
  }
  // the GM clears it from the group's card
  await page.locator(".map-party").click();
  await page.getByRole("button", { name: "Clear trail" }).click();
  await page.locator(".kit-dialog").getByRole("button", { name: "Clear trail" }).click();
  await expect(page.locator("path.map-trail-dot")).toHaveCount(0);
  expectNoErrors(errors);
});

test("Party: a group's token is its marker", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await setup(page, browser, "Party token", 1);
  const mapId = await mapWithPicture(page, cid);
  const main = (await groups(page, cid))[0];
  await api(page, "group_move", { id: main.id, map_id: mapId, x: 100, y: 100 }, cid);
  const t = await tokenUpload(page, cid, "Banner");
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  await expect(page.locator(".map-party .map-marker-icon")).toHaveText("🚩");   // the flag
  await expect(page.locator(".map-party img")).toHaveCount(0);

  // assign it with Token in the group's ⋯ on Party → Groups
  await page.goto(`#/c/${cid}/groups`);
  await moreIn(rowOf(page, "The party"), "Token");
  await page.locator("dialog.party-dialog").getByLabel("Token").selectOption({ label: "Banner" });
  await page.locator("dialog.party-dialog").getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await groups(page, cid))[0].token_id).toBe(t.id);
  await page.goto(`#/c/${cid}/maps/${mapId}`);
  const img = page.locator(".map-party img");
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate(i => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".map-party")).toContainText("The party");

  // set back to none, from the Tokens side
  expect((await api(page, "token_save", { id: t.id, group_ids: [] }, cid)).status).toBe(200);
  await page.reload();
  await expect(page.locator(".map-party .map-marker-icon")).toHaveText("🚩");
  expectNoErrors(errors);
});

test("Party: Party is here on a pin's card moves a group, asking which when there are several", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, players } = await setup(page, browser, "Party pin", 2);
  const mapId = await mapWithPicture(page, cid);
  const pin = (await api(page, "pin_save", { map_id: mapId, x: 150, y: 90, label: "Bree" }, cid)).json.pin;
  await page.goto(`#/c/${cid}/maps/${mapId}?pin=${pin.id}`);
  await page.locator(".leaflet-popup").getByRole("button", { name: "Party is here" }).click();   // one group: no question
  await expect.poll(async () => (await groups(page, cid))[0]).toMatchObject({ map_id: mapId, x: 150, y: 90 });

  const main = (await groups(page, cid))[0];
  const scouts = (await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]] }, cid)).json.groups[1];
  const far = (await api(page, "pin_save", { map_id: mapId, x: 20, y: 30, label: "Far" }, cid)).json.pin;
  await page.goto(`#/c/${cid}/maps/${mapId}?pin=${far.id}`);
  await page.locator(".leaflet-popup").getByLabel("Which group").selectOption({ label: "Scouts" });
  await page.locator(".leaflet-popup").getByRole("button", { name: "Party is here" }).click();
  await expect.poll(async () => (await groups(page, cid)).find(g => g.id === scouts.id)).toMatchObject({ map_id: mapId, x: 20, y: 30 });
  expect((await groups(page, cid))[0]).toMatchObject({ x: 150, y: 90 });
  // a player's pin card has no such button
  await players[1].pp.goto(`#/c/${cid}/maps/${mapId}?pin=${pin.id}`);
  await expect(players[1].pp.locator(".leaflet-popup")).toContainText("Bree");
  await expect(players[1].pp.locator(".leaflet-popup").getByRole("button", { name: "Party is here" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Party: Party is here on Regions moves the main group", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, c } = await setup(page, browser, "Party regions", 1);
  await page.goto(`#/c/${cid}/regions`);
  await page.locator(".listrow").filter({ hasText: "Gamma" }).getByRole("button", { name: "Party is here" }).click();
  await expect(page.locator("#toast")).toContainText("Party moved to Gamma");
  expect((await groups(page, cid))[0].region_id).toBe(c);
  await page.goto(`#/c/${cid}/groups`);
  await expect(rowOf(page, "The party").locator(".party-region")).toHaveText("Gamma");
  expectNoErrors(errors);
});

test("Party: a side group's trip leaves the main party's region and shifts alone", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ids, home, b, c } = await setup(page, browser, "Party trip", 2);
  const main = (await groups(page, cid))[0];
  await api(page, "group_save", { id: main.id, region_id: b }, cid);
  const scouts = (await api(page, "group_split", { from_id: main.id, name: "Scouts", members: [ids[0]], region_id: home }, cid)).json.groups[1];
  const camp0 = (await api(page, "campaign", undefined, cid)).json.campaign;
  await page.goto(`#/c/${cid}/travel`);
  await page.getByRole("button", { name: "Calculate" }).click();
  await page.locator(".depart").getByLabel("Who is travelling").selectOption({ label: "Scouts" });
  await page.locator(".depart").getByLabel("From", { exact: true }).fill("Bree");
  await page.locator(".depart").getByLabel("To", { exact: true }).fill("Weathertop");
  await page.locator(".depart").getByLabel("Region on arrival").selectOption({ label: "Gamma" });
  await page.getByRole("button", { name: /Depart/ }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  const camp = (await api(page, "campaign", undefined, cid)).json.campaign;
  expect(camp.current_shift).toBeGreaterThan(camp0.current_shift);
  expect(camp.settings.current_region).toBe(b);
  const g = await groups(page, cid);
  expect(g.find(x => x.id === scouts.id).region_id).toBe(c);
  expect(g[0].region_id).toBe(b);
  const ev = (await api(page, "events", undefined, cid)).json.events.find(e => e.title.startsWith("In transit (Scouts)"));
  expect(ev.title).toBe("In transit (Scouts): Bree → Weathertop");
  const r = await page.request.get(`api/index.php?${new URLSearchParams({ a: "days", cid, from: Math.floor(camp0.current_shift / 4) - 1, to: Math.floor(camp.current_shift / 4) + 1 })}`);
  expect(JSON.stringify((await r.json()).shifts)).not.toContain("In transit");
  expectNoErrors(errors);
});
