// From the code review's performance list: a campaign load reads only the start of each entry's notes for its preview,
// without showing a player the start of a GM-only paragraph the cut runs through, and an entry's page asks only for the
// text that names it.
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("an entry's preview comes from the start of its notes, and a long GM paragraph cut short never reaches a player", async ({ page, browser }) => {
  const gm = person("Zora"), player = person("Abe");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Preview ${gm.id}`);
  const pp = await (await newContext(browser)).newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const long = "Lorem ipsum dolor sit amet. ".repeat(400);   // far past what the preview reads
  await api(page, "entry_save", { name: "Long", notes: `<p>Opens plainly.</p><p>${long}</p>` }, cid);
  // all GM-only for longer than the preview reads, then a public paragraph
  await api(page, "entry_save", { name: "Hidden start", notes: `<aside><p>Secret ${long}</p></aside><p>Public tail.</p>` }, cid);
  await api(page, "entry_save", { name: "Only secret", notes: `<aside><p>Secret ${long}</p></aside>` }, cid);
  const idx = async p => Object.fromEntries((await api(p, "campaign", undefined, cid)).json.encyclopedia.map(e => [e.name, e]));
  const g = await idx(page), pl = await idx(pp);
  expect(g.Long.preview).toMatch(/^Opens plainly\. Lorem ipsum/);
  expect(g.Long.preview.length).toBeLessThanOrEqual(140);
  expect(g["Hidden start"].preview).toMatch(/^Secret/);
  expect(pl["Hidden start"].preview).not.toContain("Secret");
  expect(pl["Hidden start"].blank).toBe(false);          // the public paragraph past the cut still counts
  expect(pl["Only secret"].preview).toBe("");
});

test("an entry's page asks only for the text that names it", async ({ page, browser }) => {
  const gm = person("Bea");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Names ${gm.id}`);
  await api(page, "event_save", { abs_day: 2, title: "Rode to Altdorf" }, cid);
  await api(page, "event_save", { abs_day: 3, title: "Market day" }, cid);
  await api(page, "day_update", { abs_day: 4, notes: "<p>Met the Grey\nLady at the inn.</p>", notes_format: "html" }, cid);
  const q = names => page.request.get(`api/index.php?a=encyclopedia_sources&cid=${cid}&names=${encodeURIComponent(JSON.stringify(names))}`).then(r => r.json());
  const all = (await api(page, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(all.length).toBeGreaterThanOrEqual(3);
  const alt = (await q(["altdorf"])).sources;
  expect(alt.map(s => s.text)).toEqual(["Rode to Altdorf"]);
  expect((await q(["Grey Lady"])).sources).toHaveLength(1);   // across a line break
  expect((await q(["Nowhere"])).sources).toHaveLength(0);
});
