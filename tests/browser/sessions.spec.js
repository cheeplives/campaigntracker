// Session notes: the GM's running notes during play (the notes box on a session's page), each session's page on the
// Sessions tab with the summary written from them, Build draft, publishing to players and the Markdown export.
// Players never get the notes, an unpublished session, or the summary's GM-only paragraphs.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, notNow } = require("./helpers");

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

test("the first notes from two tabs at once go into one new session", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Sessions race");
  const many = await Promise.all([1, 2, 3, 4, 5, 6].map(i => add(page, cid, `first ${i}`)));
  expect(many.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
  expect(new Set(many.map(r => r.json.session.id)).size).toBe(1);
  expect((await api(page, "sessions", undefined, cid)).json.sessions).toHaveLength(1);
  // the same note sent twice at once is still one note
  const twice = await Promise.all([add(page, cid, "twice", { key: "k-race" }), add(page, cid, "twice", { key: "k-race" })]);
  expect(twice.map(r => r.status)).toEqual([200, 200]);
  expect(twice[0].json.note.id).toBe(twice[1].json.note.id);
});

test("a note moves after a neighbour, so a stale list still puts it in the right place", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Sessions after");
  const ids = [];
  for (const t of ["a", "b", "c", "d"]) ids.push((await add(page, cid, t)).json.note.id);
  const sid = (await api(page, "campaign", undefined, cid)).json.open_session.id;
  expect((await api(page, "snote_move", { id: ids[3], after_id: ids[0] }, cid)).status).toBe(200);
  expect((await one(page, cid, sid)).json.notes.map(n => n.text)).toEqual(["a", "d", "b", "c"]);
  expect((await api(page, "snote_move", { id: ids[2], after_id: 0 }, cid)).status).toBe(200);
  expect((await one(page, cid, sid)).json.notes.map(n => n.text)).toEqual(["c", "a", "d", "b"]);
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
  // the browser resends a note whose reply it never got: it is saved once
  const k1 = await add(page, cid, "resent", { key: "abc123" }), k2 = await add(page, cid, "resent", { key: "abc123" });
  expect(k2.json.note.id).toBe(k1.json.note.id);
  await api(page, "snote_delete", { id: k1.json.note.id }, cid);

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

// ---------------------------------------------------------------- the notes box on a session's page
const SHORTHAND = "Enter starts a new line · Tab / Shift+Tab indents · Ctrl+Enter adds them to the session · @ names an Encyclopedia entry · ! keeps a line out of the summary · ? marks a loose end · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock";
const notesCol = page => page.locator(".sess-notes");
const box = page => notesCol(page).getByRole("textbox", { name: "New notes" });
const rowsOf = page => notesCol(page).locator(".snote, .snote-jump");
/** A session to take notes in, and its page. */
async function openSession(page, cid) {
  const sid = (await api(page, "session_save", {}, cid)).json.session.id;
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(box(page)).toBeVisible();
  return sid;
}
/** Type lines into the notes box (newlines are lines) and press Add to notes; added: wait until they are in the list. */
async function typeAdd(page, text, added = true) {
  await box(page).fill(text);
  await notesCol(page).getByRole("button", { name: "Add to notes" }).click();
  if (added) {
    await expect(box(page)).toHaveValue("");
    await expect(notesCol(page).locator(".snotes")).toContainText(text.trim().split("\n").pop().trim());
  }
}
async function notesOf(page, cid, sid) {
  return (await one(page, cid, sid)).json.notes;
}

test("a session's notes box: Enter makes a line, Tab indents, Add to notes saves a note per line with marks, @ names and edits", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Notes box");
  await api(page, "entry_save", { name: "Dulled Fang" }, cid);
  const sid = await openSession(page, cid);
  await expect(box(page)).toHaveAttribute("data-tip", SHORTHAND);
  await expect(notesCol(page)).toContainText("No notes in this session.");

  await box(page).fill("Spotted the Dulled Fang at Iapetus");
  await box(page).press("Enter");
  await box(page).press("Tab");
  await box(page).pressSequentially("Hera tipped off the Harbormaster");
  await box(page).press("Enter");
  await box(page).pressSequentially("! +2 Sensor Roll");
  await box(page).press("Enter");
  await box(page).pressSequentially("? Who is Essen");
  await expect(box(page)).toHaveValue("Spotted the Dulled Fang at Iapetus\n  Hera tipped off the Harbormaster\n! +2 Sensor Roll\n? Who is Essen");
  await expect(notesCol(page)).toContainText("4 lines not added yet");
  expect(await notesOf(page, cid, sid)).toEqual([]); // Enter and Tab only type
  await notesCol(page).getByRole("button", { name: "Add to notes" }).click();
  await expect(rowsOf(page)).toHaveCount(4);
  await expect(box(page)).toHaveValue("");
  await expect(notesCol(page)).not.toContainText("null");
  await expect(rowsOf(page).nth(0).locator("a.enc-link")).toHaveText("Dulled Fang");
  await expect(rowsOf(page).nth(1)).toHaveClass(/snote-d1/);
  await expect(rowsOf(page).nth(2)).toHaveClass(/snote-d0/);
  await expect(rowsOf(page).nth(2).locator(".snote-mark")).toHaveAttribute("data-tip", /GM aside/);
  await expect(rowsOf(page).nth(3).locator(".snote-mark")).toHaveAttribute("data-tip", /Loose end/);
  expect((await notesOf(page, cid, sid)).map(n => [n.text, n.depth, n.abs_shift])).toEqual([
    ["Spotted the Dulled Fang at Iapetus", 0, 8], ["Hera tipped off the Harbormaster", 1, 8], ["! +2 Sensor Roll", 0, 8], ["? Who is Essen", 0, 8]]);

  // Shift+Tab brings a line back out; Ctrl+Enter adds
  await box(page).fill("  Indented\nPlain");
  await box(page).press("ControlOrMeta+Home");
  await box(page).press("Shift+Tab");
  await expect(box(page)).toHaveValue("Indented\nPlain");
  await box(page).press("ControlOrMeta+Enter");
  await expect(rowsOf(page)).toHaveCount(6);

  // @ lists the Encyclopedia's names, as in the editors
  await box(page).fill("Fitz hacked into the @Dul");
  await expect(notesCol(page).locator(".rt-mentions li").first()).toContainText("Dulled Fang");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("Fitz hacked into the Dulled Fang ");
  await box(page).press("ControlOrMeta+Enter");
  await expect(rowsOf(page)).toHaveCount(7);

  // fix a typo, then delete a line
  await rowsOf(page).nth(0).locator(".snote-text").click();
  const edit = notesCol(page).getByRole("textbox", { name: "Change this note" });
  await edit.fill("Spotted the Dulled Fang at Iapetus Station");
  await edit.press("Enter");
  await expect(rowsOf(page).nth(0)).toContainText("Iapetus Station");
  await rowsOf(page).nth(6).hover(); // a row's tools show on hover (always, on a touch screen)
  await rowsOf(page).nth(6).getByRole("button", { name: "Delete note" }).click();
  await page.locator("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(rowsOf(page)).toHaveCount(6);

  // the shorthand, for a phone where tips don't hover
  await notesCol(page).getByRole("button", { name: "Shorthand" }).click();
  await expect(notesCol(page).locator(".snote-help")).toContainText(">+1 dawn");

  // Current Day has no notes box any more, and a player gets no session until it is published
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator("[data-box=notes]")).toBeVisible();
  await expect(page.locator("[data-box=session]")).toHaveCount(0);
  expect((await one(pp, cid, sid)).status).toBe(404);
  expectNoErrors(errors);
});

test("what is typed waits in the box across a reload until Add to notes, then goes in order with its indents", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Notes held");
  const sid = await openSession(page, cid);
  await box(page).fill("Docked at Iapetus\n  Listening station is quiet\n\n    nobody on the comm\nHera called the Harbormaster");
  await page.waitForTimeout(300);
  await page.reload();
  await expect(box(page)).toHaveValue("Docked at Iapetus\n  Listening station is quiet\n\n    nobody on the comm\nHera called the Harbormaster");
  await expect(notesCol(page)).toContainText("4 lines not added yet");
  expect(await notesOf(page, cid, sid)).toEqual([]);
  await notesCol(page).getByRole("button", { name: "Add to notes" }).click();
  await expect(rowsOf(page)).toHaveCount(4);
  expect((await notesOf(page, cid, sid)).map(n => [n.text, n.depth])).toEqual([["Docked at Iapetus", 0], ["Listening station is quiet", 1], ["nobody on the comm", 2], ["Hera called the Harbormaster", 0]]);
  await page.reload();
  await expect(box(page)).toHaveValue("");
  await expect(rowsOf(page)).toHaveCount(4);
});

test("a > line jumps the notes' day and shift; Set the clock here moves the campaign's clock too", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Notes jumps");
  const sid = await openSession(page, cid);
  await typeAdd(page, "Arrived at Iapetus\n>+1\nFlip and burn\n>dusk\nDebris cloud sunward");
  const jump = notesCol(page).locator(".snote-jump");
  await expect(jump).toHaveCount(2);
  await expect(jump.first()).toContainText("Dawn");
  await expect(jump.first()).toContainText("4 Firstmonth");
  expect((await notesOf(page, cid, sid)).map(n => [n.text, n.abs_shift])).toEqual([["Arrived at Iapetus", 8], [">+1", 12], ["Flip and burn", 12], [">dusk", 14], ["Debris cloud sunward", 14]]);
  expect((await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(8); // a jump alone leaves the clock

  // a jump it can't read names its line, adds nothing, and stays in the box to fix
  await typeAdd(page, "Fine line\n>wibble", false);
  await expect(notesCol(page).locator(".snote-err")).toHaveText("Line 2: couldn't read that jump; try >+1, >dusk or >12 Firstmonth");
  await expect(box(page)).toHaveValue("Fine line\n>wibble");
  expect((await notesOf(page, cid, sid)).length).toBe(5);
  await box(page).fill("");

  // after a reload the stamp carries on from the last jump
  await page.reload();
  await typeAdd(page, "Still at dusk");
  expect((await notesOf(page, cid, sid)).pop().abs_shift).toBe(14);

  await jump.last().getByRole("button", { name: "Set the clock here" }).click();
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(14);
  expectNoErrors(errors);
});

test("notes take a jump typed in another tab", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Notes two tabs");
  const sid = await openSession(page, cid);
  await typeAdd(page, "From this tab");
  await add(page, cid, ">dusk", { abs_shift: 10, session_id: sid }); // the other tab's jump
  await typeAdd(page, "After the other tab's jump");
  expect((await notesOf(page, cid, sid)).pop().abs_shift).toBe(10);
});

// The service worker would see the page's requests first, and in WebKit page.route() then never fakes them.
test.describe("an error page", () => {
  test.use({ serviceWorkers: "block" });

  test("notes the server can't take right now stay in the box, and a retry after a lost reply adds them once", async ({ page, browser }) => {
    const { cid } = await gmAndPlayer(page, browser, "Notes errors");
    const sid = await openSession(page, cid);
    let mode = "down";   // down: the server is away; lost: it takes the notes but the reply never arrives; ok: as normal
    await page.route(/a=snote_bulk/, async r => {
      if (mode === "down") return r.fulfill({ status: 503, contentType: "text/html", body: "<h1>Down for maintenance</h1>" });
      if (mode === "lost") { await r.fetch(); return r.fulfill({ status: 503, contentType: "text/html", body: "<h1>Gateway timeout</h1>" }); }
      return r.continue();
    });
    await typeAdd(page, "During the deploy\n  with a sub line", false);
    await expect(notesCol(page).locator(".snote-err")).toContainText("Not added");
    await expect(box(page)).toHaveValue("During the deploy\n  with a sub line");
    mode = "lost";
    await notesCol(page).getByRole("button", { name: "Add to notes" }).click();
    await expect(notesCol(page).locator(".snote-err")).toContainText("Not added"); // a fresh error: each add clears the last
    expect((await notesOf(page, cid, sid)).length).toBe(2); // the server did take them
    mode = "ok";
    // pressing Add twice at once sends the lines once
    const addButton = notesCol(page).getByRole("button", { name: "Add to notes" });
    await addButton.evaluate(b => { b.click(); b.click(); });
    await expect(box(page)).toHaveValue("");
    await expect(rowsOf(page)).toHaveCount(2);
    expect((await notesOf(page, cid, sid)).map(n => n.text)).toEqual(["During the deploy", "with a sub line"]);
  });
});

test("on a phone the ⇥ and ⇤ buttons indent", async ({ page, browser, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  const { cid } = await gmAndPlayer(page, browser, "Notes phone");
  const sid = await openSession(page, cid);
  await box(page).fill("Top line\nUnder it");
  await notesCol(page).getByRole("button", { name: "Indent", exact: true }).click();
  await expect(box(page)).toHaveValue("Top line\n  Under it");
  await notesCol(page).getByRole("button", { name: "Outdent", exact: true }).click();
  await expect(box(page)).toHaveValue("Top line\nUnder it");
  await notesCol(page).getByRole("button", { name: "Indent", exact: true }).click();
  await notesCol(page).getByRole("button", { name: "Add to notes" }).click();
  await expect(rowsOf(page).nth(1)).toHaveClass(/snote-d1/);
  expect((await notesOf(page, cid, sid)).map(n => n.depth)).toEqual([0, 1]);
});

test("Import to a session on Current Day copies the day's Public and Secret notes into a session, secrets under a 🔒 line", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Notes import");
  const today = Math.floor((await api(page, "campaign", undefined, cid)).json.campaign.current_shift / 4);
  expect((await api(page, "day_update", { abs_day: today, notes_format: "html", gm_notes_format: "html",
    notes: "<p>Docked at Iapetus</p><ul><li>Hera called<ul><li>Harbormaster answered</li></ul></li></ul><aside>Essen is a spy</aside>",
    gm_notes: "<p>The seal is forged</p>" }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}`);
  await page.getByRole("button", { name: "Import to a session…" }).click();
  const dlg = page.locator("dialog");
  await expect(dlg.getByLabel("Session to add the notes to")).toHaveValue("new");
  await expect(dlg).toContainText("Public notes (3 lines)");
  await expect(dlg).toContainText("Secret notes (2 lines)");
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#toast")).toContainText("Added 6 notes to a new session");
  const list = (await api(page, "sessions", undefined, cid)).json.sessions;
  expect(list).toHaveLength(1);
  const notes = (await one(page, cid, list[0].id)).json.notes;
  expect(notes.map(n => [n.text.replace(/ · .*/, ""), n.depth])).toEqual([["Docked at Iapetus", 0], ["Hera called", 0], ["Harbormaster answered", 1],
    ["🔒 Secret notes", 0], ["Essen is a spy", 1], ["The seal is forged", 1]]);
  expect(new Set(notes.map(n => n.abs_shift))).toEqual(new Set([today * 4]));

  // into a session that is there, public notes only
  await page.getByRole("button", { name: "Import to a session…" }).click();
  await expect(dlg.getByLabel("Session to add the notes to")).toHaveValue(String(list[0].id));
  await dlg.getByLabel(/Secret notes/).uncheck();
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#toast")).toContainText("Added 3 notes to Session 1");
  expect((await one(page, cid, list[0].id)).json.notes).toHaveLength(9);
  // the draft keeps the secrets out of the plain paragraphs
  await page.goto(`index.html#/c/${cid}/sessions/${list[0].id}`);
  if (page.viewportSize().width <= 720) await page.getByRole("button", { name: "Summary", exact: true }).click();
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
  const summary = page.locator(".sess-summary .ql-editor").first();
  await expect(summary.locator("aside")).toContainText("Essen is a spy; The seal is forged");
  await expect(summary.locator("p").filter({ hasText: "Essen is a spy" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("the Sessions tab has a wide view, remembered, with the list of sessions along the top", async ({ page, browser }) => {
  test.skip(page.viewportSize().width <= 900, "one column already");
  const { cid } = await gmAndPlayer(page, browser, "Sessions wide");
  const sid = await openSession(page, cid);
  const wideBtn = page.getByRole("button", { name: "⇥ Wide view" });
  await wideBtn.click();
  await expect(page.locator(".sess-page")).toHaveClass(/wide/);
  await expect(page.getByRole("button", { name: "⇤ Narrow view" })).toHaveAttribute("aria-pressed", "true");
  const list = await page.locator(".sess-item").first().boundingBox(), detail = await page.locator(".sess-detail").boundingBox();
  expect(list.y + list.height).toBeLessThan(detail.y + 1); // the list sits above the session
  await page.reload();
  await expect(page.locator(".sess-page")).toHaveClass(/wide/);
  await page.getByRole("button", { name: "⇤ Narrow view" }).click();
  await expect(page.locator(".sess-page")).not.toHaveClass(/wide/);
  expect(sid).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- the Sessions tab
async function sessionWithNotes(page, cid) {
  const first = await add(page, cid, "Sensor set off on approach to Jupiter");
  const sid = first.json.session.id;
  for (const [text, depth] of [["Listening Station - comm relay satellite", 1], ["edited data to remove Tevari", 2], ["! +2 Sensor Roll", 0], ["? Who is Essen", 0]])
    await add(page, cid, text, { depth });
  return sid;
}
const draftText = "Sensor set off on approach to Jupiter. Listening Station - comm relay satellite. Edited data to remove Tevari.";

test("a session's page: notes beside the summary, Build draft ticks what it used, and the summary saves", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Sessions tab");
  const sid = await sessionWithNotes(page, cid);
  await page.goto(`index.html#/c/${cid}/sessions`);
  await expect(page.locator(".tabs a.on")).toHaveText("Sessions");
  const tabs = await page.locator(".tabs a").allTextContents();
  expect(tabs.indexOf("Sessions")).toBe(tabs.indexOf("Events") + 1);
  await expect(page.locator(".sess-item")).toHaveCount(1);
  await expect(page.locator(".sess-item")).toContainText("Session 1");
  await page.locator(".sess-item").click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/sessions/${sid}$`));

  const notesCol = page.locator(".sess-notes"), summary = page.locator(".sess-summary .ql-editor").first();
  await expect(notesCol.locator(".snote")).toHaveCount(5);
  await expect(notesCol.locator("h3")).toContainText("0 of 5 covered");
  const narrow = page.viewportSize().width <= 720; // a phone shows one column at a time
  if (narrow) await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(summary).toBeVisible();
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
  await expect(summary.locator("p").first()).toHaveText(draftText);
  await expect(summary.locator("aside")).toHaveText("Loose ends: Who is Essen");
  await expect(notesCol.locator("h3")).toContainText("4 of 5 covered"); // everything but the ! line

  // a second draft asks before touching what's there
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
  await page.locator("dialog").getByRole("button", { name: "Add below" }).click();
  await expect(summary.locator("p", { hasText: draftText })).toHaveCount(2);
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
  await page.locator("dialog").getByRole("button", { name: "Replace" }).click();
  await expect(summary.locator("p", { hasText: draftText })).toHaveCount(1);

  await summary.locator("p").first().click();
  await summary.press("End");
  await summary.pressSequentially(" Hera handled the rest.");
  // Session Rewards and Loot Found sit under the summary, and one Save keeps all three
  await expect(page.locator(".sess-summary h3")).toHaveText([/^Summary/, /^Session Rewards/, /^Loot Found/]);
  await page.locator(".sess-summary .ql-editor").nth(1).fill("300 XP each and the Harbormaster's favour");
  await page.locator(".sess-summary .ql-editor").nth(2).fill("A sealed Tevari ledger and 40 crowns");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await notNow(page); // the summary names Jupiter and Tevari: the Proper Noun Detector offers them
  const saved = (await one(page, cid, sid)).json.session.summary;
  expect(saved).toContain("Hera handled the rest.");
  expect(saved).toContain("<aside>Loose ends: Who is Essen</aside>");
  expect((await one(page, cid, sid)).json.session).toMatchObject({ rewards: "<p>300 XP each and the Harbormaster's favour</p>", loot: "<p>A sealed Tevari ledger and 40 crowns</p>" });

  // a save from a page opened before someone else's save is refused
  await api(page, "session_summary_save", { id: sid, version: (await one(page, cid, sid)).json.session.version, summary: "<p>Elsewhere</p>" }, cid);
  await summary.pressSequentially(" More.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("saved somewhere else");

  // title, date played and publishing
  const tb = await page.getByLabel("Title").boundingBox(), pb = await page.getByLabel("Played on").boundingBox();
  if (page.viewportSize().width > 560) expect(Math.abs(tb.y - pb.y)).toBeLessThan(4); // Title and Played on share a row
  await page.getByLabel("Title").fill("A Locked Box");
  await page.getByLabel("Played on").fill("2024-06-24");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.locator(".sess-detail h2")).toContainText("Session 1: A Locked Box");
  expect((await one(page, cid, sid)).json.session).toMatchObject({ title: "A Locked Box", played_on: "2024-06-24", is_published: false });
  expectNoErrors(errors.filter(e => !/409/.test(e)));
});

test("a published session is the player's to read and export; notes move between sessions; a session deletes", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Sessions publish");
  await api(page, "entry_save", { name: "Tevari" }, cid);
  const sid = await sessionWithNotes(page, cid);
  const v = (await one(page, cid, sid)).json.session.version;
  await api(page, "session_summary_save", { id: sid, version: v, summary: `<p>${draftText}</p><aside>Loose ends: Who is Essen</aside>`,
    rewards: "<p>300 XP each</p><aside>Hidden bonus for Hera</aside>", loot: "<p>A sealed ledger</p>" }, cid);
  await api(page, "session_save", { id: sid, title: "A Locked Box", played_on: "2024-06-24" }, cid);

  await pp.goto(`index.html#/c/${cid}/sessions`);
  await expect(pp.locator(".sess-item")).toHaveCount(0);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await page.getByLabel("Published", { exact: true }).check();
  await expect(page.getByText("Published for players")).toBeVisible();

  await pp.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(pp.locator(".sess-detail h2")).toContainText("Session 1: A Locked Box");
  await expect(pp.locator(".sess-detail .richtext a.enc-link")).toHaveText("Tevari");
  await expect(pp.locator(".sess-detail")).not.toContainText("Loose ends");
  await expect(pp.locator(".sess-notes")).toHaveCount(0);
  const [dl] = await Promise.all([pp.waitForEvent("download"), pp.getByRole("button", { name: /Export/ }).click()]);
  expect(dl.suggestedFilename()).toBe("Session 1 - A Locked Box.md");
  const md = require("fs").readFileSync(await dl.path(), "utf8");
  expect(md.startsWith("# Session 1: A Locked Box\n")).toBe(true);
  expect(md).toContain(draftText);
  expect(md).not.toContain("Essen");
  await expect(pp.locator(".sess-extra[data-box=rewards]")).toContainText("300 XP each");
  await expect(pp.locator(".sess-extra[data-box=rewards]")).not.toContainText("Hidden bonus");
  await expect(pp.locator(".sess-extra[data-box=loot]")).toContainText("A sealed ledger");
  expect(md).toContain("## Session Rewards\n\n300 XP each");
  expect(md).toContain("## Loot Found\n\nA sealed ledger");
  expect(md).not.toContain("Hidden bonus");

  // the GM's export can take the notes as a list
  await page.getByLabel("Include notes").check();
  const [gdl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export/ }).click()]);
  const gmd = require("fs").readFileSync(await gdl.path(), "utf8");
  expect(gmd).toContain("GM only: Loose ends: Who is Essen");
  expect(gmd).toMatch(/## Notes\n\n- Sensor set off on approach to Jupiter\n   - Listening Station - comm relay satellite\n      - edited data to remove Tevari/);

  // the player finds the summary in Search, but not the notes
  await pp.goto(`index.html#/c/${cid}/search?q=Listening`);
  await expect(pp.locator(".search-group", { hasText: "Sessions" })).toContainText("A Locked Box");
  await pp.goto(`index.html#/c/${cid}/search?q=Sensor+Roll`);
  await expect(pp.getByText("Nothing in the campaign matches every word.")).toBeVisible();

  // move a note to a second session, then delete that session
  await api(page, "session_end", {}, cid);
  const other = (await add(page, cid, "Took a quick job to Europa")).json.session.id;
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await page.reload(); // the page was already open there: load the new session into its Move to list
  await page.locator(".sess-notes .snote").first().hover();
  await page.locator(".sess-notes .snote").first().getByLabel("Move to another session").selectOption(String(other));
  await expect(page.locator(".sess-notes .snote")).toHaveCount(4);
  expect((await one(page, cid, other)).json.notes.map(n => n.text)).toEqual(["Took a quick job to Europa", "Sensor set off on approach to Jupiter"]);
  await page.goto(`index.html#/c/${cid}/sessions/${other}`);
  await page.getByRole("button", { name: "Delete session" }).click();
  await page.locator("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/sessions$`));
  await expect(page.locator(".sess-item")).toHaveCount(1);
});

test("on a phone a session's notes and summary are two tabs", async ({ page, browser }) => {
  test.skip(page.viewportSize().width > 720, "phone layout; a tablet shows both columns");
  const { cid } = await gmAndPlayer(page, browser, "Sessions phone");
  const sid = await sessionWithNotes(page, cid);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(page.locator(".sess-notes")).toBeVisible();
  await expect(page.locator(".sess-summary")).toBeHidden();
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.locator(".sess-summary")).toBeVisible();
  await expect(page.locator(".sess-notes")).toBeHidden();
});
