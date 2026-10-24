// Session notes: the GM's quick notes during play (the Session notes box on Current Day), each session's page on the
// Sessions tab with the summary written from them, Build draft, publishing to players and the Markdown export.
// Players never get the notes, an unpublished session, or the summary's GM-only paragraphs.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
/** One session (and, for a GM, its notes), as whoever page is signed in as. */
async function one(page, cid, id) {
  const res = await page.request.get(`api/index.php?a=session&cid=${cid}&id=${id}`);
  return { status: res.status(), json: await res.json() };
}
const add = (page, cid, text, extra = {}) => api(page, "snote_add", { text, depth: 0, abs_shift: 8, ...extra }, cid);

test("notes start a session, join the open one in order, and a new one after End session", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Sessions API");
  expect((await api(page, "campaign", undefined, cid)).json.open_session).toBeNull();

  const a = await add(page, cid, "Spotted the Dulled Fang at Iapetus Station");
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(a.json.session).toMatchObject({ number: 1, title: "", first_day: 2, last_day: null, is_published: false });
  expect(a.json.note).toMatchObject({ position: 1, depth: 0, abs_shift: 8, is_covered: false });
  const b = await add(page, cid, "Hera tipped off the Harbormaster", { depth: 1, abs_shift: 9 });
  expect(b.json.session.id).toBe(a.json.session.id);
  expect(b.json.note).toMatchObject({ position: 2, depth: 1, abs_shift: 9 });
  expect((await api(page, "campaign", undefined, cid)).json.open_session).toMatchObject({ id: a.json.session.id, number: 1 });

  // five at once, from two tabs say: every one gets its own place
  const many = await Promise.all([1, 2, 3, 4, 5].map(i => add(page, cid, `note ${i}`)));
  expect(many.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(new Set(many.map(r => r.json.note.position))).toEqual(new Set([3, 4, 5, 6, 7]));

  expect((await api(page, "session_end", {}, cid)).status).toBe(200);
  const s1 = (await one(page, cid, a.json.session.id));
  expect(s1.status).toBe(200);
  expect(s1.json.session.last_day).toBe(2);
  expect(s1.json.notes.map(n => n.text).slice(0, 2)).toEqual(["Spotted the Dulled Fang at Iapetus Station", "Hera tipped off the Harbormaster"]);
  const c = await add(page, cid, "Took a quick job to Europa", { abs_shift: 44 });
  expect(c.json.session).toMatchObject({ number: 2, first_day: 11 });

  // reopening session 1 ends session 2
  expect((await api(page, "session_save", { id: a.json.session.id, reopen: true }, cid)).status).toBe(200);
  const list = (await api(page, "sessions", undefined, cid)).json.sessions;
  expect(list.map(s => [s.number, s.last_day === null])).toEqual([[2, false], [1, true]]);
  expect(list.find(s => s.number === 1)).toMatchObject({ notes: 7, covered: 0 });
});

test("a note can be changed, ticked, moved to another session or deleted, within the limits", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Sessions edits");
  const a = await add(page, cid, "first");
  const b = await add(page, cid, "second");
  const id = a.json.note.id, sid = a.json.session.id;
  expect((await api(page, "snote_save", { id, text: "First, fixed", depth: 2, abs_shift: 12, is_covered: true }, cid)).json.note)
    .toMatchObject({ text: "First, fixed", depth: 2, abs_shift: 12, is_covered: true });
  expect((await add(page, cid, "x".repeat(1001))).status).toBe(400);
  expect((await add(page, cid, "deep", { depth: 4 })).status).toBe(400);
  expect((await add(page, cid, "   ")).status).toBe(400);

  // reorder: the second note first
  expect((await api(page, "snote_move", { id: b.json.note.id, position: 1 }, cid)).status).toBe(200);
  let s = (await one(page, cid, sid)).json;
  expect(s.notes.map(n => [n.text, n.position])).toEqual([["second", 1], ["First, fixed", 2]]);

  // to another session: it goes on the end there
  await api(page, "session_end", {}, cid);
  const other = (await add(page, cid, "later")).json.session.id;
  expect((await api(page, "snote_move", { id, session_id: other }, cid)).status).toBe(200);
  s = (await one(page, cid, other)).json;
  expect(s.notes.map(n => n.text)).toEqual(["later", "First, fixed"]);

  expect((await api(page, "snote_delete", { id }, cid)).status).toBe(200);
  expect((await api(page, "session_delete", { id: other }, cid)).status).toBe(200);
  expect((await one(page, cid, other)).status).toBe(404);
  expect((await api(page, "snote_save", { id: b.json.note.id, text: "still here" }, cid)).status).toBe(200);
});

test("players get only published sessions, never the notes or the summary's GM-only paragraphs", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Sessions privacy");
  const a = await add(page, cid, "The Fang is in port");
  const sid = a.json.session.id;
  const v1 = (await one(page, cid, sid)).json.session.version;
  const saved = await api(page, "session_summary_save", { id: sid, version: v1, summary: "<p>They docked.</p><aside>Essen owns the rock-hopper</aside><script>x</script>" }, cid);
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect(saved.json.session.summary).toBe("<p>They docked.</p><aside>Essen owns the rock-hopper</aside>");
  // a save from the copy before that one is refused
  expect((await api(page, "session_summary_save", { id: sid, version: v1, summary: "<p>old</p>" }, cid)).status).toBe(409);

  expect((await api(pp, "sessions", undefined, cid)).json.sessions).toEqual([]);
  expect((await one(pp, cid, sid)).status).toBe(404);
  expect((await api(pp, "snote_add", { text: "mine", depth: 0, abs_shift: 8 }, cid)).status).toBe(403);
  expect((await api(pp, "snote_save", { id: a.json.note.id, text: "hacked" }, cid)).status).toBe(403);
  expect((await api(pp, "session_save", { id: sid, is_published: true }, cid)).status).toBe(403);
  expect((await api(pp, "campaign", undefined, cid)).json.open_session).toBeUndefined();

  expect((await api(page, "session_save", { id: sid, is_published: true, title: "A Locked Box", played_on: "2024-06-24" }, cid)).status).toBe(200);
  const list = (await api(pp, "sessions", undefined, cid)).json.sessions;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ title: "A Locked Box", played_on: "2024-06-24" });
  expect(list[0].notes).toBeUndefined();
  const mine = (await one(pp, cid, sid)).json;
  expect(mine.session.summary).toBe("<p>They docked.</p>");
  expect(mine.notes).toBeUndefined();

  // search sources: the player finds the published summary but no notes; the GM finds the notes, marked secret
  const ps = (await api(pp, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(ps.filter(s => s.kind === "session").map(s => s.text)).toEqual(["<p>They docked.</p>"]);
  expect(ps.some(s => s.kind === "session_note")).toBe(false);
  const gs = (await api(page, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(gs.find(s => s.kind === "session_note")).toMatchObject({ id: sid, text: "The Fang is in port", secret: true });

  // someone outside the campaign gets nothing
  const octx = await browser.newContext(), op = await octx.newPage();
  const outsider = person("Ozzy");
  await signIn(op, outsider);
  await approve(browser, outsider.email);
  expect((await api(op, "sessions", undefined, cid)).status).toBe(403);
});
