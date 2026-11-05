// Session notes: the GM's running notes during play (one text box on a session's page, saved as it is typed), each
// session's page on the Sessions tab with the summary written from them, Build draft, publishing to players and the
// Markdown export. Players never get the notes, an unpublished session, or the summary's GM-only paragraphs.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, sql, makeCampaign, notNow, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
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
const saveNotes = (page, cid, id, notes_text, base = null) => api(page, "session_notes_save", { id, notes_text, base }, cid);
/** A new session (the open one), and its id. */
const newSession = async (page, cid) => (await api(page, "session_save", {}, cid)).json.session.id;
/** Old note rows, as sessions kept them before the text box: there is no action to add them any more. */
function oldRows(cid, sid, rows) {
  sql(`INSERT INTO session_notes (campaign_id, session_id, position, depth, text, abs_shift) VALUES ${
    rows.map(([text, depth, at], i) => `(${cid}, ${sid}, ${i + 1}, ${depth}, '${text.replace(/'/g, "''")}', ${at})`).join(", ")};`);
}

test("sessions open, end and reopen; only one is open at a time", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Sessions API");
  expect((await api(page, "campaign", undefined, cid)).json.open_session).toBeNull();
  const a = await api(page, "session_save", {}, cid);
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(a.json.session).toMatchObject({ number: 1, title: "", first_day: 2, last_day: null, is_published: false, notes_text: null });
  expect((await api(page, "campaign", undefined, cid)).json.open_session).toMatchObject({ id: a.json.session.id, number: 1 });
  expect((await api(page, "session_end", {}, cid)).status).toBe(200);
  expect((await one(page, cid, a.json.session.id)).json.session.last_day).toBe(2);
  const b = await api(page, "session_save", {}, cid);
  expect(b.json.session).toMatchObject({ number: 2, last_day: null });
  // reopening session 1 ends session 2
  expect((await api(page, "session_save", { id: a.json.session.id, reopen: true }, cid)).status).toBe(200);
  const list = (await api(page, "sessions", undefined, cid)).json.sessions;
  expect(list.map(s => [s.number, s.last_day === null])).toEqual([[2, false], [1, true]]);
});

test("a session keeps the shift it started and ended on, and moves them with its days", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Session shifts");
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  await api(page, "set_time", { current_shift: now + 1 }, cid);
  const s = (await api(page, "session_save", {}, cid)).json.session;
  expect(s).toMatchObject({ first_day: 2, first_shift: now + 1, last_shift: null });
  // two shifts later the session ends there
  await api(page, "set_time", { current_shift: now + 6 }, cid);
  expect((await api(page, "session_end", {}, cid)).status).toBe(200);
  expect((await one(page, cid, s.id)).json.session).toMatchObject({ first_shift: now + 1, last_day: 3, last_shift: now + 6 });
  // a day changed by hand takes the shift with it: the first of the new first day, the last of the new last day
  const moved = await api(page, "session_save", { id: s.id, first_day: 1, last_day: 4 }, cid);
  expect(moved.json.session).toMatchObject({ first_day: 1, first_shift: 4, last_day: 4, last_shift: 19 });
  // a title alone leaves them as they were; reopening clears the end
  expect((await api(page, "session_save", { id: s.id, title: "Night run" }, cid)).json.session).toMatchObject({ first_shift: 4, last_shift: 19 });
  expect((await api(page, "session_save", { id: s.id, reopen: true }, cid)).json.session).toMatchObject({ last_day: null, last_shift: null });
  // a session from before shifts were kept stays on whole days
  sql(`UPDATE play_sessions SET first_shift=NULL WHERE id=${s.id}`);
  await api(page, "session_end", {}, cid);
  expect((await one(page, cid, s.id)).json.session).toMatchObject({ first_shift: null, last_shift: null, last_day: 3 });
});

test("a session's notes save as text; a save from an older copy is refused, and the same text sent again passes", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Notes text API");
  const sid = await newSession(page, cid);
  const first = await saveNotes(page, cid, sid, "Docked at Iapetus\n  Hera called");
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect((await one(page, cid, sid)).json.session.notes_text).toBe("Docked at Iapetus\n  Hera called");
  // a page that still thinks there are no notes, or has an older copy, saves nothing
  const stale = await saveNotes(page, cid, sid, "Something else");
  expect(stale.status).toBe(409);
  expect(stale.json.error).toBe("stale");
  expect((await saveNotes(page, cid, sid, "v2", "not what is there")).status).toBe(409);
  // from the copy the server has: saved; the same text again (a reply lost on the way) passes, whatever its base
  expect((await saveNotes(page, cid, sid, "v2", "Docked at Iapetus\n  Hera called")).status).toBe(200);
  expect((await saveNotes(page, cid, sid, "v2", "Docked at Iapetus\n  Hera called")).status).toBe(200);
  expect((await saveNotes(page, cid, sid, "", "v2")).status).toBe(200);
  expect((await one(page, cid, sid)).json.session.notes_text).toBe("");
  // the notes are the GMs' alone
  expect((await saveNotes(pp, cid, sid, "mine", "")).status).toBe(403);
  // and once saved as text, the old rows aren't sent any more
  oldRows(cid, sid, [["an old line", 0, 8]]);
  expect((await one(page, cid, sid)).json.notes).toEqual([]);
});

test("players get only published sessions, never the notes or the summary's GM-only paragraphs", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Sessions privacy");
  const sid = await newSession(page, cid);
  await saveNotes(page, cid, sid, "The Fang is in port");
  const v1 = (await one(page, cid, sid)).json.session.version;
  const saved = await api(page, "session_summary_save", { id: sid, version: v1, summary: "<p>They docked.</p><aside>Essen owns the rock-hopper</aside><script>x</script>" }, cid);
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect(saved.json.session.summary).toBe("<p>They docked.</p><aside>Essen owns the rock-hopper</aside>");
  // a save from the copy before that one is refused
  expect((await api(page, "session_summary_save", { id: sid, version: v1, summary: "<p>old</p>" }, cid)).status).toBe(409);

  expect((await api(pp, "sessions", undefined, cid)).json.sessions).toEqual([]);
  expect((await one(pp, cid, sid)).status).toBe(404);
  expect((await api(pp, "session_save", { id: sid, is_published: true }, cid)).status).toBe(403);
  expect((await api(pp, "campaign", undefined, cid)).json.open_session).toBeUndefined();

  expect((await api(page, "session_save", { id: sid, is_published: true, title: "A Locked Box", played_on: "2024-06-24" }, cid)).status).toBe(200);
  const list = (await api(pp, "sessions", undefined, cid)).json.sessions;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ title: "A Locked Box", played_on: "2024-06-24" });
  expect(list[0].notes_text).toBeUndefined();
  const mine = (await one(pp, cid, sid)).json;
  expect(mine.session.summary).toBe("<p>They docked.</p>");
  expect(mine.session.notes_text).toBeUndefined();
  expect(mine.notes).toBeUndefined();

  // search sources: the player finds the published summary but no notes; the GM finds the notes, marked secret
  const ps = (await api(pp, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(ps.filter(s => s.kind === "session").map(s => s.text)).toEqual(["<p>They docked.</p>"]);
  expect(ps.some(s => s.kind === "session_note")).toBe(false);
  const gs = (await api(page, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(gs.find(s => s.kind === "session_note")).toMatchObject({ id: sid, text: "The Fang is in port", secret: true });
  // a session not yet saved as text: its old rows, one source each
  const old = await newSession(page, cid);
  oldRows(cid, old, [["Essen waits on the dock", 0, 8]]);
  const gs2 = (await api(page, "encyclopedia_sources", undefined, cid)).json.sources;
  expect(gs2.filter(s => s.kind === "session_note").map(s => s.text)).toEqual(["The Fang is in port", "Essen waits on the dock"]);

  // someone outside the campaign gets nothing
  const octx = await newContext(browser), op = await octx.newPage();
  const outsider = person("Ozzy");
  await signIn(op, outsider);
  await approve(browser, outsider.email);
  expect((await api(op, "sessions", undefined, cid)).status).toBe(403);
});

// ---------------------------------------------------------------- the notes box on a session's page
const SHORTHAND = "Saves as you type · Enter starts a new line · Tab / Shift+Tab indents · @ names an Encyclopedia entry · ! keeps a line out of the summary · $ puts it in the summary as a secret · ? marks a loose end · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock";
const notesCol = page => page.locator(".sess-notes");
const box = page => notesCol(page).getByRole("textbox", { name: "Session notes" });
const status = page => notesCol(page).locator(".snote-status");
/** A session to take notes in, and its page. */
async function openSession(page, cid) {
  const sid = await newSession(page, cid);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await expect(box(page)).toBeVisible();
  return sid;
}
/** The notes as the server has them, once it has the text expected. */
const savedAs = async (page, cid, sid, text) => expect.poll(async () => (await one(page, cid, sid)).json.session.notes_text).toBe(text);

test("a session's notes are one box: Enter makes a line, Tab indents, @ names, and it saves as you type", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Notes box");
  await api(page, "entry_save", { name: "Dulled Fang" }, cid);
  const sid = await openSession(page, cid);
  await expect(box(page)).toHaveAttribute("data-tip", SHORTHAND);
  await expect(notesCol(page).getByRole("button", { name: "Add to notes" })).toHaveCount(0);
  await expect(notesCol(page).getByRole("button", { name: "Build draft", exact: true })).toBeVisible();

  await box(page).fill("Spotted the Dulled Fang at Iapetus");
  await box(page).press("Enter");
  await box(page).press("Tab");
  await box(page).pressSequentially("Hera tipped off the Harbormaster");
  await box(page).press("Enter");
  await box(page).pressSequentially("! +2 Sensor Roll");
  await box(page).press("Enter");
  await box(page).pressSequentially("$ Essen is a spy");
  const typed = "Spotted the Dulled Fang at Iapetus\n  Hera tipped off the Harbormaster\n! +2 Sensor Roll\n$ Essen is a spy";
  await expect(box(page)).toHaveValue(typed);
  await savedAs(page, cid, sid, typed);
  await expect(status(page)).toHaveText("Saved");

  // Tab indents the line the caret is on, Shift+Tab brings it back out
  await box(page).press("Tab");
  await expect(box(page)).toHaveValue(typed.replace("\n$ Essen", "\n  $ Essen"));
  await savedAs(page, cid, sid, typed.replace("\n$ Essen", "\n  $ Essen"));
  await box(page).press("Shift+Tab");
  await expect(box(page)).toHaveValue(typed);

  // @ lists the Encyclopedia's names, as in the editors
  await box(page).press("ControlOrMeta+End");
  await box(page).pressSequentially("\nFitz hacked into the @Dul");
  await expect(notesCol(page).locator(".rt-mentions li").first()).toContainText("Dulled Fang");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue(/Fitz hacked into the Dulled Fang $/);

  // a jump it can't read is named under the box (the line stays as typed)
  await box(page).pressSequentially("\n>wibble");
  await expect(notesCol(page).locator(".snote-hint")).toHaveText(/^Line 6: couldn't read that jump/);
  await box(page).fill(typed);
  await expect(notesCol(page).locator(".snote-hint")).toBeHidden();
  await savedAs(page, cid, sid, typed);

  // after a reload it is all there
  await page.reload();
  await expect(box(page)).toHaveValue(typed);

  // the shorthand, for a phone where tips don't hover
  await notesCol(page).getByRole("button", { name: "Shorthand" }).click();
  await expect(notesCol(page).locator(".snote-help")).toContainText(">+1 dawn");
  await expect(notesCol(page).locator(".snote-help")).toContainText("GM-only paragraph");

  // At the Table has no notes box (a day's notes are on its calendar page), and a player gets no session until it is published
  await page.goto(`index.html#/c/${cid}`);
  await expect(page.locator("[data-box=table-shifts]")).toBeVisible();
  await expect(page.locator("[data-box=notes]")).toHaveCount(0);
  await expect(page.locator("[data-box=session]")).toHaveCount(0);
  expect((await one(pp, cid, sid)).status).toBe(404);
  expectNoErrors(errors);
});

test("a session's old note rows and lines never added go into its box, in order with their indents and days", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Notes fold");
  const sid = await newSession(page, cid);
  // as the rows were kept: a jump typed as >+1, a note moved to day 5 by hand, and a > back to a clock since moved on
  oldRows(cid, sid, [["Arrived at Iapetus", 0, 8], ["Listening station is quiet", 1, 8], [">+1", 0, 12], ["Flip and burn", 0, 12],
    ["Moved to day five", 0, 20], ["! +2 Sensor Roll", 1, 20]]);
  // a line typed in the old box and never added, kept in this browser
  await page.goto(`index.html#/c/${cid}/sessions`);
  const uid = (await (await page.request.get("api/auth/me.php")).json()).id;
  await page.evaluate(([u, s]) => localStorage.setItem(`chronicle:snotes-draft:${u}:${s}`, "Typed and never added"), [uid, sid]);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  const folded = "Arrived at Iapetus\n  Listening station is quiet\n>+1\nFlip and burn\n>+2\nMoved to day five\n  ! +2 Sensor Roll\nTyped and never added";
  await expect(box(page)).toHaveValue(folded);
  await savedAs(page, cid, sid, folded);   // saved as text at once
  expect(await page.evaluate(([u, s]) => localStorage.getItem(`chronicle:snotes-draft:${u}:${s}`), [uid, sid])).toBeNull();
  // the old rows stay where they were
  expect(sql(`SELECT COUNT(*) FROM session_notes WHERE session_id=${sid}`).trim()).toBe("6");
  // and the draft still puts each under its day
  await notesCol(page).getByRole("button", { name: "Build draft", exact: true }).click();
  await expect(page.locator(".sess-summary .ql-editor h3")).toHaveCount(3);
  expectNoErrors(errors);
});

// The service worker would see the page's requests first, and in WebKit page.route() then never fakes them.
test.describe("an error page", () => {
  test.use({ serviceWorkers: "block" });

  test("notes the server can't take right now are kept in this browser and saved once it can", async ({ page, browser }) => {
    const { cid } = await gmAndPlayer(page, browser, "Notes errors");
    const sid = await openSession(page, cid);
    let down = true;
    await page.route(/a=session_notes_save/, r => down ? r.fulfill({ status: 503, contentType: "text/html", body: "<h1>Down for maintenance</h1>" }) : r.continue());
    await box(page).fill("During the deploy\n  with a sub line");
    await expect(status(page)).toContainText("Not saved");
    expect((await one(page, cid, sid)).json.session.notes_text).toBeNull();
    // a reload while the server is away: the box still has it
    await page.reload();
    await expect(box(page)).toHaveValue("During the deploy\n  with a sub line");
    down = false;
    await box(page).press("End");
    await box(page).pressSequentially(" too");
    await savedAs(page, cid, sid, "During the deploy\n  with a sub line too");
    await expect(status(page)).toHaveText("Saved");
  });
});

test("notes changed in another tab aren't overwritten: the GM picks which copy to keep", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Notes two tabs");
  const sid = await openSession(page, cid);
  await box(page).fill("From this tab");
  await savedAs(page, cid, sid, "From this tab");
  await saveNotes(page, cid, sid, "From the other tab", "From this tab");   // the other tab's save
  await box(page).fill("From this tab, more");
  await expect(notesCol(page).locator(".snote-err")).toContainText("changed in another tab");
  await page.waitForTimeout(2500);
  expect((await one(page, cid, sid)).json.session.notes_text).toBe("From the other tab");
  await notesCol(page).getByRole("button", { name: "Load the saved notes" }).click();
  await expect(box(page)).toHaveValue("From the other tab");
  // and again, keeping this tab's copy this time
  await saveNotes(page, cid, sid, "Third copy", "From the other tab");
  await box(page).fill("Mine wins");
  await notesCol(page).getByRole("button", { name: "Keep mine" }).click();
  await savedAs(page, cid, sid, "Mine wins");
  await expect(notesCol(page).locator(".snote-err")).toBeHidden();
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
  await savedAs(page, cid, sid, "Top line\n  Under it");
});

test("Import to a session on a day's calendar page adds the day's Public and Secret notes to a session's box, secrets under a $ line", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Notes import");
  const today = Math.floor((await api(page, "campaign", undefined, cid)).json.campaign.current_shift / 4);
  expect((await api(page, "day_update", { abs_day: today, notes_format: "html", gm_notes_format: "html",
    notes: "<p>Docked at Iapetus</p><ul><li>Hera called<ul><li>Harbormaster answered</li></ul></li></ul><aside>Essen is a spy</aside>",
    gm_notes: "<p>The seal is forged</p>" }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/day/${today}`);
  await page.getByRole("button", { name: "Import to a session…" }).click();
  const dlg = page.locator("dialog");
  await expect(dlg.getByLabel("Session to add the notes to")).toHaveValue("new");
  await expect(dlg).toContainText("Public notes (3 lines)");
  await expect(dlg).toContainText("Secret notes (2 lines)");
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#toast")).toContainText("Added 6 lines to a new session's notes");
  const list = (await api(page, "sessions", undefined, cid)).json.sessions;
  expect(list).toHaveLength(1);
  const text = (await one(page, cid, list[0].id)).json.session.notes_text;
  expect(text.replace(/ · .*/, "")).toBe("Docked at Iapetus\nHera called\n  Harbormaster answered\n$ Secret notes\n  Essen is a spy\n  The seal is forged");

  // into a session that is there, public notes only, at the end
  await page.getByRole("button", { name: "Import to a session…" }).click();
  await expect(dlg.getByLabel("Session to add the notes to")).toHaveValue(String(list[0].id));
  await dlg.getByLabel(/Secret notes/).uncheck();
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#toast")).toContainText("Added 3 lines to Session 1's notes");
  expect((await one(page, cid, list[0].id)).json.session.notes_text.split("\n")).toHaveLength(9);
  // the draft keeps the secrets out of the plain paragraphs
  await page.goto(`index.html#/c/${cid}/sessions/${list[0].id}`);
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
  const summary = page.locator(".sess-summary .ql-editor").first();
  await expect(summary.locator("aside")).toContainText("Essen is a spy; The seal is forged");
  await expect(summary.locator("p").filter({ hasText: "Essen is a spy" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("Hide list folds the list of sessions to a rail so the session takes the screen, remembered", async ({ page, browser }) => {
  test.skip(page.viewportSize().width <= 900, "one column already");
  const { cid } = await gmAndPlayer(page, browser, "Sessions hide");
  // someone who had Wide view on before keeps the session's room
  await page.goto("index.html");
  await page.evaluate(() => localStorage.setItem("chronicle:sesswide", "1"));
  const sid = await openSession(page, cid);
  await expect(page.locator(".sess-page")).toHaveClass(/list-hidden/);
  await expect(page.getByRole("button", { name: "⇥ Wide view" })).toHaveCount(0);
  const rail = page.getByRole("button", { name: "Show the Sessions list" });
  await rail.click();
  await expect(page.locator(".sess-item").first()).toBeVisible();
  const list = await page.locator(".sess-item").first().boundingBox(), detail = await page.locator(".sess-detail").boundingBox();
  expect(list.x + list.width).toBeLessThan(detail.x + 1); // the list beside the session
  await page.reload();
  await expect(page.locator(".sess-page")).not.toHaveClass(/list-hidden/);
  await page.getByRole("button", { name: "Hide the list" }).click();
  await expect(page.locator(".sess-item")).toBeHidden();
  const wider = await page.locator(".sess-detail").boundingBox();
  expect(wider.width).toBeGreaterThan(detail.width + 150);
  await page.reload();
  await expect(page.locator(".sess-page")).toHaveClass(/list-hidden/);
  expect(sid).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- the Sessions tab
async function sessionWithNotes(page, cid) {
  const sid = await newSession(page, cid);
  await saveNotes(page, cid, sid, "Sensor set off on approach to Jupiter\n  Listening Station - comm relay satellite\n    edited data to remove Tevari\n! +2 Sensor Roll\n? Who is Essen");
  return sid;
}
/** Build draft, under the notes (on a phone, from the Notes tab). */
async function buildDraft(page) {
  if (page.viewportSize().width <= 720 && await page.locator(".sess-notes").isHidden()) await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Build draft", exact: true }).click();
}
const draftText = "Sensor set off on approach to Jupiter. Listening Station - comm relay satellite. Edited data to remove Tevari.";

test("Build draft gathers the shifts the session ran over: activities, players' notes, and GM notes kept GM-only", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Draft shifts");
  await api(page, "set_time", { current_shift: 9 }, cid);                     // Midday of day 2
  const sid = await newSession(page, cid);
  await api(page, "shift_save", { abs_day: 2, shift: 0, activity: "Before we sat down" }, cid);
  await api(page, "shift_save", { abs_day: 2, shift: 1, activity: "Marching to Altdorf", gm_notes: "Ambush waits at the ford" }, cid);
  expect((await api(pp, "shift_note_add", { abs_day: 2, shift: 1, body: "Pip saw a crow" }, cid)).status).toBe(200);
  await api(page, "set_time", { current_shift: 10 }, cid);
  await api(page, "session_end", {}, cid);
  await api(page, "shift_save", { abs_day: 2, shift: 3, activity: "After the session" }, cid);
  await saveNotes(page, cid, sid, "Met the ferryman");
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  await buildDraft(page);
  const summary = page.locator(".sess-summary .ql-editor").first();
  await expect(summary.locator("p").first()).toContainText("Marching to Altdorf. Pip saw a crow.");
  await expect(summary).toContainText("Met the ferryman.");
  await expect(summary).toContainText("Ambush waits at the ford");
  await expect(summary).not.toContainText("Before we sat down");
  await expect(summary).not.toContainText("After the session");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await notNow(page);
  const saved = (await one(page, cid, sid)).json.session.summary;
  expect(saved).toMatch(/<aside[^>]*>Ambush waits at the ford<\/aside>/);   // GM-only
  expectNoErrors(errors);
});

test("a session's page: notes beside the summary, Build draft under them fills it, and the summary saves", async ({ page, browser }) => {
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
  await expect(notesCol.getByRole("textbox", { name: "Session notes" })).toHaveValue(/^Sensor set off/);
  await buildDraft(page);   // a phone then shows the summary it filled
  await expect(summary).toBeVisible();
  await expect(summary.locator("p").first()).toHaveText(draftText);
  await expect(summary.locator("aside")).toHaveText("Loose ends: Who is Essen");

  // a second draft asks before touching what's there
  await buildDraft(page);
  await page.locator("dialog").getByRole("button", { name: "Add below" }).click();
  await expect(summary.locator("p", { hasText: draftText })).toHaveCount(2);
  await buildDraft(page);
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
  await expect(page.locator("#toast")).toHaveText("Saved");
  await notNow(page); // the summary names Jupiter and Tevari: the Proper Noun Detector offers them
  // saved, the summary reads as players see it, and ✎ Edit opens the editors again
  await expect(summary).toBeHidden();
  await expect(page.locator(".sess-summary .sess-read")).toContainText("Hera handled the rest.");
  await page.getByRole("button", { name: "✎ Edit" }).click();
  const saved = (await one(page, cid, sid)).json.session.summary;
  expect(saved).toContain("Hera handled the rest.");
  expect(saved).toContain("<aside>Loose ends: Who is Essen</aside>");
  expect((await one(page, cid, sid)).json.session).toMatchObject({ rewards: "<p>300 XP each and the Harbormaster's favour</p>", loot: "<p>A sealed Tevari ledger and 40 crowns</p>" });

  // a save from a page opened before someone else's save is refused
  await api(page, "session_summary_save", { id: sid, version: (await one(page, cid, sid)).json.session.version, summary: "<p>Elsewhere</p>" }, cid);
  await summary.pressSequentially(" More.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("saved somewhere else");

  // title, date played and publishing: an untitled session shows its Title and Played on, which fold under ✎ Details once it has a title.
  // The one Save saves them too.
  await page.reload();
  await expect(page.getByLabel("Title")).toBeVisible();
  const tb = await page.getByLabel("Title").boundingBox(), pb = await page.getByLabel("Played on").boundingBox();
  if (page.viewportSize().width > 560) expect(Math.abs(tb.y - pb.y)).toBeLessThan(4); // Title and Played on share a row
  await page.getByLabel("Title").fill("A Locked Box");
  await page.getByLabel("Played on").fill("2024-06-24");
  await expect(page.getByRole("button", { name: "Save details" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".sess-detail h2")).toContainText("Session 1: A Locked Box");
  await expect(page.locator(".sess-item.on")).toContainText("Session 1: A Locked Box");
  await expect(page.locator(".sess-bar")).toContainText("Played 2024-06-24");
  expect((await one(page, cid, sid)).json.session).toMatchObject({ title: "A Locked Box", played_on: "2024-06-24", is_published: false });
  await expect(page.getByLabel("Title")).toBeHidden(); // titled now, so the details fold under ✎ Details
  await page.getByRole("button", { name: "✎ Details" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("A Locked Box");
  // away from the day pages, Pass time is a button that opens its row
  await expect(page.locator(".passtime")).toBeHidden();
  await page.getByRole("button", { name: "⏩ Pass time" }).click();
  await expect(page.locator(".passtime")).toBeVisible();
  expectNoErrors(errors.filter(e => !/409/.test(e)));
});

test("a published session is the player's to read and export; a session deletes", async ({ page, browser }) => {
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
  // The GM reads a written session as players do, with the Encyclopedia's names linked and GM-only paragraphs marked;
  // Edit opens the editors, and Save goes back to reading with the new names linked.
  const named = page.locator(".sess-summary .sess-read a.enc-link");
  await expect(named).toHaveText(["Tevari"]);
  await expect(named).toHaveAttribute("href", /\/encyclopedia\/\d+$/);
  await expect(page.locator(".sess-summary .sess-read aside")).toContainText(["Loose ends", "Hidden bonus"]);
  await expect(page.locator(".sess-summary .sess-editing")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeHidden();
  await api(page, "entry_save", { name: "Dulled Fang" }, cid);
  await page.reload();
  await page.getByRole("button", { name: "✎ Edit" }).click();
  await expect(page.locator(".sess-summary .sess-read")).toBeHidden();
  await page.locator(".sess-summary .ql-editor").nth(2).fill("A sealed ledger from the Dulled Fang");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  await notNow(page); // the Proper Noun Detector offers the summary's other names
  await expect(named).toHaveText(["Tevari", "Dulled Fang"]);
  await expect(page.getByRole("button", { name: "✎ Edit" })).toBeVisible();
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
  await page.locator(".sess-more > summary").click(); // Include notes waits in the ⋯ menu
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

  // a second session, then delete it
  await api(page, "session_end", {}, cid);
  const other = await newSession(page, cid);
  await page.goto(`index.html#/c/${cid}/sessions/${other}`);
  // the page can be drawn again just after it opens (the move above changed the campaign), closing the ⋯ menu: open it until it stays
  await expect(async () => {
    if (!await page.locator(".sess-more").evaluate(d => d.open)) await page.locator(".sess-more > summary").click();
    await page.getByRole("button", { name: "Delete session" }).click({ timeout: 2000 });
  }).toPass();
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
  // once there's a summary, the page opens on it
  await api(page, "session_summary_save", { id: sid, version: (await one(page, cid, sid)).json.session.version, summary: "<p>They docked.</p>" }, cid);
  await page.reload();
  await expect(page.locator(".sess-summary")).toBeVisible();
  await expect(page.locator(".sess-notes")).toBeHidden();
});
