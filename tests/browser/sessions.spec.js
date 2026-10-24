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

// ---------------------------------------------------------------- the Session notes box on Current Day
const SHORTHAND = "Enter saves · Tab / Shift+Tab indents · @ names an Encyclopedia entry · ! keeps a line out of the summary · ? marks a loose end · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock";
const box = page => page.locator("[data-box=session]");
const input = page => box(page).getByRole("textbox", { name: "New note" });
async function type(page, text) {
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("");
}
async function notesOf(page, cid) {
  const open = (await api(page, "campaign", undefined, cid)).json.open_session;
  return open ? (await one(page, cid, open.id)).json.notes : [];
}

test("the GM types notes on Current Day: Enter saves, Tab indents, marks show, and the first note starts a session", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Notes box");
  await api(page, "entry_save", { name: "Dulled Fang" }, cid);
  await page.goto(`index.html#/c/${cid}`);
  await expect(box(page)).toContainText("No session open: your first note starts one");
  await expect(input(page)).toHaveAttribute("data-tip", SHORTHAND);

  await type(page, "Spotted the Dulled Fang at Iapetus");
  await expect(box(page).locator("h3")).toContainText("Session 1");
  await input(page).press("Tab");
  await type(page, "Hera tipped off the Harbormaster");
  await type(page, "! +2 Sensor Roll");
  await input(page).press("Shift+Tab");
  await type(page, "? Who is Essen");
  const rows = box(page).locator(".snote");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator("a.enc-link")).toHaveText("Dulled Fang");
  await expect(rows.nth(1)).toHaveClass(/snote-d1/);
  await expect(rows.nth(2)).toHaveClass(/snote-d1/); // a new line keeps the last one's indent
  await expect(rows.nth(2).locator(".snote-mark")).toHaveAttribute("data-tip", /GM aside/);
  await expect(rows.nth(3)).toHaveClass(/snote-d0/);
  await expect(rows.nth(3).locator(".snote-mark")).toHaveAttribute("data-tip", /Loose end/);
  expect((await notesOf(page, cid)).map(n => [n.text, n.depth, n.abs_shift])).toEqual([
    ["Spotted the Dulled Fang at Iapetus", 0, 8], ["Hera tipped off the Harbormaster", 1, 8], ["! +2 Sensor Roll", 1, 8], ["? Who is Essen", 0, 8]]);

  // @ lists the Encyclopedia's names, as in the editors
  await input(page).fill("Fitz hacked into the @Dul");
  await expect(box(page).locator(".rt-mentions li").first()).toContainText("Dulled Fang");
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("Fitz hacked into the Dulled Fang ");
  await input(page).press("Enter");
  await expect(rows).toHaveCount(5);

  // fix a typo, then delete a line
  await rows.nth(0).locator(".snote-text").click();
  const edit = box(page).getByRole("textbox", { name: "Change this note" });
  await edit.fill("Spotted the Dulled Fang at Iapetus Station");
  await edit.press("Enter");
  await expect(rows.nth(0)).toContainText("Iapetus Station");
  await rows.nth(4).getByRole("button", { name: "Delete note" }).click();
  await page.locator("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(4);
  expect((await notesOf(page, cid))[0].text).toBe("Spotted the Dulled Fang at Iapetus Station");

  // the shorthand, for a phone where tips don't hover
  await box(page).getByRole("button", { name: "Shorthand" }).click();
  await expect(box(page).locator(".snote-help")).toContainText(">+1 dawn");

  // players never see the box
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator("[data-box=notes]")).toBeVisible();
  await expect(box(pp)).toHaveCount(0);
  expectNoErrors(errors);
});

test("a > line jumps the notes' day and shift; Set the clock here moves the campaign's clock too", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Notes jumps");
  await page.goto(`index.html#/c/${cid}`);
  await type(page, "Arrived at Iapetus");
  await type(page, ">+1");
  const jump = box(page).locator(".snote-jump");
  await expect(jump).toHaveCount(1);
  await expect(jump).toContainText("Dawn");
  await expect(jump).toContainText("4 Firstmonth");
  await type(page, "Flip and burn");
  await type(page, ">dusk");
  await type(page, "Debris cloud sunward");
  expect((await notesOf(page, cid)).map(n => [n.text, n.abs_shift])).toEqual([["Arrived at Iapetus", 8], [">+1", 12], ["Flip and burn", 12], [">dusk", 14], ["Debris cloud sunward", 14]]);
  expect((await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(8); // a jump alone leaves the clock

  // a jump it can't read stays in the box to fix
  await input(page).fill(">wibble");
  await input(page).press("Enter");
  await expect(box(page).locator(".snote-err")).toHaveText("Couldn't read that jump; try >+1, >dusk or >12 Firstmonth");
  await expect(input(page)).toHaveValue(">wibble");

  // after a reload the stamp carries on from the last jump
  await page.reload();
  await type(page, "Still at dusk");
  expect((await notesOf(page, cid)).pop().abs_shift).toBe(14);

  await jump.last().getByRole("button", { name: "Set the clock here" }).click();
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(14);
  expectNoErrors(errors);
});

test("a note typed offline waits in the box, survives a reload and is saved once", async ({ page, browser, context }) => {
  const { cid } = await gmAndPlayer(page, browser, "Notes offline");
  await page.goto(`index.html#/c/${cid}`);
  await type(page, "Online note");
  await context.setOffline(true);
  await type(page, "Typed with no signal");
  await expect(box(page).locator(".snote-unsaved")).toContainText("Typed with no signal");
  await expect(box(page).locator(".snote-unsaved")).toContainText("Not saved, retrying");
  await context.setOffline(false);
  await page.reload();
  await expect(box(page).locator(".snote")).toHaveCount(2);
  await expect(box(page).locator(".snote-unsaved")).toHaveCount(0);
  await page.reload();
  await expect(box(page).locator(".snote")).toHaveCount(2);
  expect((await notesOf(page, cid)).map(n => n.text)).toEqual(["Online note", "Typed with no signal"]);
});

test("on a phone the ⇥ and ⇤ buttons indent", async ({ page, browser, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  const { cid } = await gmAndPlayer(page, browser, "Notes phone");
  await page.goto(`index.html#/c/${cid}`);
  await type(page, "Top line");
  await box(page).getByRole("button", { name: "Indent", exact: true }).click();
  await type(page, "Under it");
  await expect(box(page).locator(".snote").nth(1)).toHaveClass(/snote-d1/);
});
