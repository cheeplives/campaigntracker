// Draft from transcript: on a session's page the GM picks a transcript of the game night (plain text, WebVTT or SubRip),
// says who each speaker is, and Claude (through Anthropic's API, with the GM's own key, kept in their browser) drafts the
// session's notes, summary, rewards and loot. The GM ticks what to keep; only then is any of it put in the page's notes
// box and editors. The transcript goes from the browser straight to Anthropic, never to this site.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
const T = require(path.join(__dirname, "..", "..", "static", "transcript.js"));
test.afterEach(closeContexts);
// The service worker would see the page's requests first, and in WebKit page.route() then never fakes them.
test.use({ serviceWorkers: "block" });

test("Transcript.parse reads Zoom and Teams WebVTT, SubRip, and plain text with or without times", () => {
  const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nGwen (GM): You see the gate of Ravenhold.\n\n2\n00:00:05.000 --> 00:00:07.000\n<v Pip Lee>I draw my bow.</v>\n\n3\n00:00:08.000 --> 00:00:09.000\n<v Pip Lee>And I shoot.</v>\n";
  expect(T.parse(vtt)).toEqual([
    { t: 1, speaker: "Gwen (GM)", text: "You see the gate of Ravenhold." },
    { t: 5, speaker: "Pip Lee", text: "I draw my bow. And I shoot." },   // one speaker's cues in a row are one turn
  ]);
  const srt = "﻿1\r\n00:12:01,000 --> 00:12:04,000\r\nSPEAKER_00: Pizza is here\r\n\r\n2\r\n01:00:05,000 --> 01:00:07,000\r\nsomeone mutters\r\n";
  expect(T.parse(srt)).toEqual([{ t: 721, speaker: "SPEAKER_00", text: "Pizza is here" }, { t: 3605, speaker: "", text: "someone mutters" }]);
  // Otter: a line of name and time, then what they said
  expect(T.parse("Pip  0:12\nI open the door.\nSlowly.\n\nGwen  0:15\nIt creaks.\n")).toEqual([
    { t: 12, speaker: "Pip", text: "I open the door. Slowly." }, { t: 15, speaker: "Gwen", text: "It creaks." }]);
  // a time first, a name alone, and a sentence with a colon in it that is nobody's name
  const txt = "[00:01:02] Pip: I open it\n[00:01:09] Gwen: It creaks.\nPip: ok\nGwen: fine\nPip: twelve\nNote to self: buy milk";
  expect(T.parse(txt).map(x => [x.t, x.speaker, x.text])).toEqual([[62, "Pip", "I open it"], [69, "Gwen", "It creaks."], [null, "Pip", "ok"], [null, "Gwen", "fine"], [null, "Pip", "twelve Note to self: buy milk"]]);
  expect(T.parse("")).toEqual([]);
  expect(T.parse("Just a paragraph of talk with nobody named.")).toEqual([{ t: null, speaker: "", text: "Just a paragraph of talk with nobody named." }]);
});

test("Transcript matches speakers to members, writes the turns out for the model and prices the draft", () => {
  const members = [{ id: 1, display_name: "Gwen", character_name: "" }, { id: 2, display_name: "Pip", character_name: "Kestrel" }, { id: 3, display_name: "Pip Marsh", character_name: "Odo" }];
  expect(T.guess("gwen (GM)", members)).toBe(1);
  expect(T.guess("Kestrel", members)).toBe(2);       // by their character's name
  expect(T.guess("Pip", members)).toBe(2);           // the whole name wins over a shared word
  expect(T.guess("Pip L", members)).toBe(null);      // two Pips: the GM says which
  expect(T.guess("SPEAKER_00", members)).toBe(null);
  expect([T.anonymous("Speaker 2"), T.anonymous("SPEAKER_01"), T.anonymous(""), T.anonymous("Sam")]).toEqual([true, true, true, false]);
  const turns = T.parse("[1:02:03] Gwen: The gate opens.\n[1:02:10] Pip: I go in.\n[1:03:00] Sam: Anyone want pizza?");
  expect(T.speakers(turns).map(s => [s.label, s.turns])).toEqual([["Gwen", 1], ["Pip", 1], ["Sam", 1]]);
  const who = l => ({ Gwen: "Gwen (GM)", Pip: "Pip (plays Kestrel)" })[l] ?? null;
  expect(T.tidy(turns, who)).toBe("[1:02] Gwen (GM): The gate opens.\n[1:02] Pip (plays Kestrel): I go in.");   // Sam is left out
  expect(T.cost("claude-sonnet-5-5", 48000)).toBeCloseTo(0.2, 1);
  expect(T.cost("claude-haiku-5-5", 120000)).toBeGreaterThan(T.cost("claude-haiku-5-5", 60000) * 5);   // over 100,000 tokens Haiku costs five times as much
});

test("Transcript.request and fromAnswer: the transcript is cached for a redraft, Haiku sends no fallback, and an odd answer is tidied", () => {
  const ctx = { campaign: "Vale", cast: ["Gwen (GM): the game master"], names: ["Ravenhold"], slots: ["Dawn", "Day", "Dusk", "Night"], before: "They reached the vale.", notes: "gate" };
  const r = T.request("claude-sonnet-5-5", ctx, "[0:01] Gwen (GM): Hello", "shorter");
  expect(r).toMatchObject({ model: "claude-sonnet-5-5", stream: true, fallbacks: "default" });
  expect(r.output_config.format).toEqual({ type: "json_schema", schema: T.SCHEMA });
  const [doc, ask] = r.messages[0].content;
  expect(doc.cache_control).toEqual({ type: "ephemeral" });
  for (const t of ["Campaign: Vale", "Gwen (GM): the game master", "Ravenhold", "\">dawn\"", "They reached the vale.", "[0:01] Gwen (GM): Hello"]) expect(doc.text).toContain(t);
  expect(ask.text).toContain("shorter");
  expect(T.request("claude-haiku-5-5", ctx, "x", "").fallbacks).toBeUndefined();
  expect(T.request("something-else", ctx, "x", "").model).toBe("claude-sonnet-5-5");
  expect(T.fromAnswer({ title: "  The gate ", notes: [{ at: "0:01", indent: 1, text: " in \n we go " }, { text: "" }, null], summary: "no", rewards: ["xp", ""], left_out: [{ at: "0:09", kind: "table talk", gist: "pizza" }] }))
    .toEqual({ title: "The gate", notes: [{ at: "0:01", indent: true, text: "in we go" }], summary: [], rewards: ["xp"], loot: [], left_out: [{ at: "0:09", kind: "table talk", gist: "pizza" }], speakers: [] });
  expect(T.fromAnswer(null).notes).toEqual([]);
});

test("Transcript.notesText writes the notes box's shorthand, and the editors' text is escaped", () => {
  const notes = [{ text: "Gate opens", indent: true }, { text: "Kestrel goes in", indent: true }, { text: ">+1 dusk" }, { text: ">soon" }, { text: "? Who lit the lamp", indent: true }, { text: "  " }];
  expect(T.notesText(notes, { ok: t => t !== ">soon", extra: [{ at: "0:09", gist: "pizza" }], from: "night.vtt" }))
    .toBe("! From the transcript (night.vtt)\nGate opens\n  Kestrel goes in\n>+1 dusk\n? Who lit the lamp\n! 0:09 pizza");   // nothing is indented under nothing, or under a jump
  expect(T.notesText([])).toBe("");
  expect(T.summaryHtml([{ text: "A <b>bold</b> night & day.", gm_only: false }, { text: "The lamp is cursed.", gm_only: true }]))
    .toBe("<p>A &lt;b&gt;bold&lt;/b&gt; night &amp; day.</p><aside>The lamp is cursed.</aside>");
  expect(T.listHtml(["50 <gp>"])).toBe("<ul><li>50 &lt;gp&gt;</li></ul>");
  expect(T.listHtml([])).toBe("");
});

const KEY = "sk-ant-api03-" + "x".repeat(40);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
/** Anthropic's streamed reply to a draft: the answer in two pieces of text, as server-sent events. */
const stream = answer => {
  const text = JSON.stringify(answer), half = Math.floor(text.length / 2);
  const ev = e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  return ev({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 900, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } } })
    + ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) + ev({ type: "content_block_stop", index: 0 })
    + ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
    + ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, half) } })
    + ev({ type: "ping" })
    + ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(half) } })
    + ev({ type: "content_block_stop", index: 1 })
    + ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 400 } }) + ev({ type: "message_stop" });
};
const VTT = "WEBVTT\n\n00:00:05.000 --> 00:00:09.000\nGwen: The gate of Ravenhold stands open, and a lamp burns in the gatehouse window.\n\n00:00:12.000 --> 00:00:15.000\n<v Pip>Kestrel nocks an arrow and slips inside the gatehouse quietly.</v>\n\n00:09:00.000 --> 00:09:04.000\nSPEAKER_02: Does anyone want the last slice of pizza before it goes cold?\n\n00:10:00.000 --> 00:10:05.000\nUncle Bob: I am only here to watch, do not mind me at all, carry on.\n";
const ANSWER = {
  title: "The open gate",
  notes: [{ at: "0:00", indent: false, text: "Ravenhold's gate stands open" }, { at: "0:00", indent: true, text: "Kestrel slips into the gatehouse" },
    { at: "0:01", indent: false, text: ">+1" }, { at: "0:01", indent: false, text: ">whenever" }, { at: "0:02", indent: false, text: "? Who lit the lamp" }, { at: "0:03", indent: false, text: "$ The lamp is a signal to the raiders" }],
  summary: [{ text: "Kestrel found the gate of Ravenhold open & unguarded.", gm_only: false }, { text: "The lamp was a signal to the raiders.", gm_only: true }],
  rewards: ["The reeve's thanks"], loot: ["A brass key"],
  left_out: [{ at: "0:09", kind: "table talk", gist: "Pizza" }],
  speakers: [{ label: "SPEAKER_02", guess: "Pip" }],
};

async function sessionReady(page, browser) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Transcript ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const pid = (await (await pp.request.get("api/auth/me.php")).json()).id;
  expect((await api(page, "member_character", { user_id: pid, character_name: "Kestrel" }, cid)).status).toBe(200);
  await api(page, "entry_save", { name: "Ravenhold" }, cid);
  const sid = (await api(page, "session_save", {}, cid)).json.session.id;
  return { cid, sid, pp };
}
const one = async (page, cid, id) => { const res = await page.request.get(`api/index.php?a=session&cid=${cid}&id=${id}`); return { status: res.status(), json: await res.json() }; };
const openDialog = async (page, cid, sid) => {
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  if (await page.locator(".sess-tabs").isVisible()) await page.locator(".sess-tabs").getByRole("button", { name: "Notes" }).click();   // a phone shows one column
  await page.getByRole("button", { name: "Draft from transcript…" }).click();
  return page.getByRole("dialog", { name: "Draft from transcript" });
};
const give = (d, text, name = "night.vtt") => d.getByLabel("Transcript file").setInputFiles({ name, mimeType: "text/vtt", buffer: Buffer.from(text) });

test("Draft from transcript: the GM names the speakers, reviews Claude's draft and adds what is ticked to the session", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, sid, pp } = await sessionReady(page, browser);
  await page.goto("index.html#/");
  await page.evaluate(k => localStorage.setItem("chronicle.anthropicKey", k), KEY);
  const sent = [], ours = [];
  page.on("request", r => { if (r.method() === "POST" && !r.url().includes("anthropic.com")) ours.push(r.postData() || ""); });
  await page.context().route("https://api.anthropic.com/**", async r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    sent.push({ headers: r.request().headers(), body: r.request().postDataJSON() });
    return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: stream(sent.length > 1 ? { ...ANSWER, title: "A shorter gate" } : ANSWER) });
  });
  const d = await openDialog(page, cid, sid);
  await give(d, "{}", "night.json");
  await expect(d.getByRole("alert")).toContainText("night.json isn't a kind it can read yet");
  await give(d, VTT);

  // who is speaking: names are matched to members, and a transcriber's own label is left for Claude
  await expect(d.getByRole("heading")).toHaveText("Who is speaking?");
  await expect(d.getByLabel("Who is Gwen")).toHaveValue(/^\d+$/);
  await expect(d.getByLabel("Who is Gwen").locator("option:checked")).toHaveText("Gwen, the GM");
  await expect(d.getByLabel("Who is Pip").locator("option:checked")).toHaveText("Pip, playing Kestrel");
  await expect(d.getByLabel("Who is SPEAKER_02").locator("option:checked")).toHaveText("Not sure: let Claude work it out");
  await expect(d.getByLabel("Who is Uncle Bob").locator("option:checked")).toHaveText("Someone else (a guest)");
  await d.getByLabel("Who is Uncle Bob").selectOption("out");
  const go = d.getByRole("button", { name: "Draft the session" });
  await expect(go).toBeDisabled();   // until the GM says the table knows
  await expect(d.getByRole("status")).toContainText("will cost your Anthropic account about");
  await d.getByLabel(/Everyone at the table knows/).check();
  await go.click();

  // the request: straight to Anthropic with the GM's key, the cast and the campaign's names with the transcript
  await expect(d.getByRole("heading")).toHaveText("Draft: The open gate");
  expect(sent).toHaveLength(1);
  expect(sent[0].headers["x-api-key"]).toBe(KEY);
  expect(sent[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(sent[0].body).toMatchObject({ model: "claude-sonnet-5-5", stream: true });
  const doc = sent[0].body.messages[0].content[0].text;
  expect(doc).toContain("[0:00] Gwen (GM): The gate of Ravenhold stands open");
  expect(doc).toContain("[0:00] Pip (plays Kestrel): Kestrel nocks an arrow");
  expect(doc).toContain("SPEAKER_02 (unidentified): Does anyone want");
  expect(doc).toContain("Pip (plays Kestrel): a player, whose character is Kestrel");
  expect(doc).toContain("Ravenhold");
  expect(doc).not.toContain("Uncle Bob");   // left out, with everything he said
  expect(doc).not.toContain("only here to watch");

  // the review: a jump the calendar can't read is unticked, what was left out is folded away and unticked
  await expect(d).toContainText("SPEAKER_02 is Pip");
  await expect(d.getByRole("checkbox", { name: ">whenever" })).not.toBeChecked();
  await expect(d.getByRole("checkbox", { name: ">+1" })).toBeChecked();
  await expect(d.locator(".tx-part").filter({ hasText: "Left out" }).last()).not.toHaveAttribute("open", "");
  await d.locator(".tx-part").filter({ hasText: "Left out" }).last().locator("summary").click();
  await d.getByRole("checkbox", { name: "Pizza" }).check();   // pulled back in, as an aside
  await d.getByRole("checkbox", { name: "A brass key" }).uncheck();
  // another go: the same transcript again, with what the GM asked for
  await d.getByLabel("What to change in another draft").fill("shorter");
  await d.getByRole("button", { name: "Draft again" }).click();
  await expect(d.getByRole("heading")).toHaveText("Draft: A shorter gate");
  expect(sent[1].body.messages[0].content[0].text).toBe(doc);
  expect(sent[1].body.messages[0].content[1].text).toContain("shorter");
  await d.getByRole("checkbox", { name: "A brass key" }).uncheck();
  await d.getByRole("button", { name: "Add to the session" }).click();
  await expect(d).toBeHidden();

  // the notes box takes the lines, in its own shorthand, and saves as typing does; the rest waits in the editors
  const box = page.getByLabel("Session notes");
  await expect(box).toHaveValue("! From the transcript (night.vtt)\nRavenhold's gate stands open\n  Kestrel slips into the gatehouse\n>+1\n? Who lit the lamp\n$ The lamp is a signal to the raiders");
  await expect(page.locator(".snote-status")).toHaveText("Saved");
  if (await page.locator(".sess-tabs").isVisible()) await page.locator(".sess-tabs").getByRole("button", { name: "Summary" }).click();
  const editors = page.locator(".sess-editing");
  await expect(editors).toContainText("Kestrel found the gate of Ravenhold open & unguarded.");
  await expect(editors.locator("aside")).toContainText("The lamp was a signal to the raiders.");
  await expect(editors).toContainText("The reeve's thanks");
  await expect(editors).not.toContainText("A brass key");
  await expect(page.locator(".sess-fields input").first()).toHaveValue("A shorter gate");
  let s = (await one(page, cid, sid)).json;
  expect(s.session.summary || "").toBe("");   // nothing but the notes is saved until the GM presses Save
  await page.locator(".sess-sumhead").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  s = (await one(page, cid, sid)).json;
  expect(s.session.summary).toContain("open &amp; unguarded");
  expect(s.session.title).toBe("A shorter gate");
  expect(s.session.is_published).toBe(false);   // and players see none of it until it is published
  expect((await one(pp, cid, sid)).status).toBe(404);
  // the transcript itself never went to this site
  expect(ours.some(b => b.includes("only here to watch") || b.includes("last slice of pizza"))).toBe(false);
  // who the named speakers are is remembered in this browser for the next transcript
  const kept = await page.evaluate(c => JSON.parse(localStorage.getItem(`chronicle:transcript:${c}`)), cid);
  expect(kept.speakers["Uncle Bob"]).toBe("out");
  expect(kept.speakers.SPEAKER_02).toBeUndefined();
  expectNoErrors(errors);
});

test("Draft from transcript: without a key it points to the account page, and a refused key says so", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, sid } = await sessionReady(page, browser);
  let d = await openDialog(page, cid, sid);
  await expect(d).toContainText("your own Anthropic API key, which isn't saved in this browser yet");
  await d.getByLabel("Transcript text").fill("Gwen: The gate of Ravenhold stands open tonight.\nPip: Kestrel goes in.\nGwen: It is dark inside.");
  await d.getByRole("button", { name: "Use the pasted text" }).click();
  await d.getByLabel(/Everyone at the table knows/).check();
  await expect(d.getByRole("button", { name: "Draft the session" })).toBeDisabled();
  await d.getByRole("link", { name: "Add your Anthropic API key on your account page" }).click();
  await expect(page.getByRole("heading", { name: "Your Anthropic key" })).toBeVisible();

  await page.evaluate(k => localStorage.setItem("chronicle.anthropicKey", k), KEY);
  await page.context().route("https://api.anthropic.com/**", r => (r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) })));
  d = await openDialog(page, cid, sid);
  await d.getByLabel("Transcript text").fill("Gwen: The gate of Ravenhold stands open tonight.\nPip: Kestrel goes in.\nGwen: It is dark inside.");
  await d.getByRole("button", { name: "Use the pasted text" }).click();
  await d.getByLabel("Model").selectOption("claude-haiku-5-5");
  await d.getByLabel(/Everyone at the table knows/).check();
  await d.getByRole("button", { name: "Draft the session" }).click();
  await expect(d.getByRole("status")).toHaveText("Anthropic didn't accept your API key. Check it on your account page.");
  await expect(d.getByRole("button", { name: "Try again" })).toBeVisible();
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Session notes")).toHaveValue("");   // nothing was added
  expect(errors.filter(e => !/401/.test(String(e)))).toEqual([]);   // the browser logs the refused request itself
});
