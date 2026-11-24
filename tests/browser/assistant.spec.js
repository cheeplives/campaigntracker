// The Assistant: a GM switches it on in Settings, writes the campaign guide, and asks Claude (through Anthropic's API,
// with the GM's own key, kept in their browser) to fill out an entry. Claude reads the campaign through the site's
// GM-only actions and proposes; only what the GM accepts is saved. Anthropic is faked here: no test calls it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
// The service worker would see the page's requests first, and in WebKit page.route() then never fakes them.
test.use({ serviceWorkers: "block" });

const KEY = "sk-ant-api03-" + "x".repeat(40);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
/** A read with parameters, as whoever the page is signed in as. */
async function get(page, action, params, cid) {
  const res = await page.request.get(`api/index.php?${new URLSearchParams({ a: action, cid, ...params })}`);
  return { status: res.status(), json: await res.json() };
}
const GUIDE = { premise: "A salt port. Nobody is a hero.", power: "", lines: "", style: "Terse.", canon: "", rules: "", secrets: "Brandt cut the pages himself." };

/** A GM and a player in a campaign with two entries (one GM only), a connection-free Encyclopedia and one session. */
async function ready(page, browser) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Varrow ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const ok = async (action, body) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  const mara = (await ok("entry_save", { name: "Mara Hoffmann", category: "person", notes: "<p>Innkeeper of the Gilded Eel.</p><aside>She waters the ale.</aside>", gm_notes: "<p>Owes the Ring money.</p>" })).id;
  const ring = (await ok("entry_save", { name: "The Tallow Ring", category: "group", gm_notes: "<p>Smugglers who mark their own with candle stubs.</p>", is_secret: true })).id;
  const sid = (await ok("session_save", { title: "The cut pages" })).session.id;
  return { cid, pp, ok, mara, ring, sid, gm, player };
}
const switchOn = (ok, extra = {}) => ok("campaign_update", { settings: { assistant: { enabled: true, model: "claude-sonnet-5-5", pack: "grim-fantasy", ...extra } } });

test("the assistant's actions: GMs only, off until switched on, and the guide is kept with its history", async ({ page, browser }) => {
  test.skip(test.info().project.name !== "chromium", "the server answers the same whatever the browser");
  const { cid, pp, ok, mara, ring, sid } = await ready(page, browser);

  // a player is refused all of it, and the guide is not in what the campaign sends its members
  for (const a of ["assistant", "assistant_context", "assistant_read", "assistant_search"]) expect((await get(pp, a, { kind: "entry", id: mara, q: "ale" }, cid)).status, a).toBe(403);
  expect((await api(pp, "assistant_guide_save", { guide: GUIDE, version: 0 }, cid)).status).toBe(403);

  // the guide: blank until saved, checked against the copy the form was drawn from, bounded
  let g = (await get(page, "assistant", {}, cid)).json;
  expect(g.version).toBe(0);
  expect(g.guide.premise).toBe("");
  expect(g.packs.map(p => p.key)).toContain("grim-fantasy");
  expect(g.packs.map(p => p.key)).not.toContain("README");
  g = await ok("assistant_guide_save", { guide: { ...GUIDE, nonsense: "dropped" }, version: 0 });
  expect(g.version).toBe(1);
  expect(g.guide).toEqual(GUIDE);
  expect((await api(page, "assistant_guide_save", { guide: GUIDE, version: 0 }, cid)).status).toBe(409);
  expect((await api(page, "assistant_guide_save", { guide: { ...GUIDE, premise: "x".repeat(2001) }, version: 1 }, cid)).status).toBe(400);
  expect(JSON.stringify((await get(pp, "campaign", {}, cid)).json)).not.toContain("Brandt cut the pages");

  // its history: a later save is a second version, and a restore puts the first back
  sql(`UPDATE content_versions SET saved_at = saved_at - INTERVAL 1 HOUR WHERE campaign_id=${cid}`);
  await ok("assistant_guide_save", { guide: { ...GUIDE, premise: "A cheerful port." }, version: 1 });
  const versions = (await get(page, "history_list", { kind: "guide", ref: cid }, cid)).json.versions;
  expect(versions).toHaveLength(2);
  expect((await get(pp, "history_list", { kind: "guide", ref: cid }, cid)).status).toBe(403);
  await ok("history_restore", { id: versions[1].id });
  g = (await get(page, "assistant", {}, cid)).json;
  expect(g.guide.premise).toBe(GUIDE.premise);
  expect(g.version).toBe(3);

  // reading waits for the switch
  for (const a of ["assistant_context", "assistant_read", "assistant_search"]) {
    const r = await get(page, a, { kind: "entry", id: mara, q: "ale" }, cid);
    expect([r.status, r.json.error], a).toEqual([403, "assistant_off"]);
  }
  await switchOn(ok);
  await ok("relations_save", { entry_id: mara, type: { label: "Member of", inverse_label: "Has member" }, add: [ring], is_secret: true });

  // what a request starts from
  const c = (await get(page, "assistant_context", {}, cid)).json;
  expect(c.pack.name).toBe("Grim low fantasy");
  expect(c.pack.text).toContain("Magic is rare");
  expect(c.guide).toEqual(GUIDE);
  expect(c.entries).toEqual([
    { id: mara, name: "Mara Hoffmann", category: "person", aliases: [], gm_only: false, gist: "Innkeeper of the Gilded Eel. [GM only] She waters the ale." },
    { id: ring, name: "The Tallow Ring", category: "group", aliases: [], gm_only: true, gist: "Smugglers who mark their own with candle stubs." }]);
  expect(c.sessions).toMatchObject([{ id: sid, number: 1, title: "The cut pages", published: false }]);
  expect(c.links).toEqual([[mara, "Member of", ring, true]]);

  // one entry and one session in full, and a search across both
  const e = (await get(page, "assistant_read", { kind: "entry", id: mara }, cid)).json;
  for (const s of [`Entry ${mara}: Mara Hoffmann`, "Category: person", `- Mara Hoffmann (${mara}) — Member of — The Tallow Ring (${ring}) [GM only]`, "Public notes:\nInnkeeper of the Gilded Eel.\n[GM only] She waters the ale.",
    "GM notes (players never see these):\nOwes the Ring money."]) expect(e.text).toContain(s);
  expect(e).toMatchObject({ name: "Mara Hoffmann", version: 1, gm_notes: "<p>Owes the Ring money.</p>" });
  await ok("session_summary_save", { id: sid, version: 1, summary: "<p>The party found two pages cut from the ledger.</p>" });
  await ok("session_notes_save", { id: sid, notes_text: "$ Brandt did it", base: null });
  const s = (await get(page, "assistant_read", { kind: "session", id: sid }, cid)).json.text;
  for (const t of ["Session 1: The cut pages", "Not published", "two pages cut from the ledger", "$ Brandt did it"]) expect(s).toContain(t);
  expect((await get(page, "assistant_read", { kind: "entry", id: 99999999 }, cid)).status).toBe(404);
  const hits = (await get(page, "assistant_search", { q: "candle" }, cid)).json.hits;
  expect(hits).toEqual([{ kind: "entry", id: ring, name: "The Tallow Ring", category: "group", gm_only: true, snippet: "Smugglers who mark their own with candle stubs." }]);
  expect((await get(page, "assistant_search", { q: "brandt" }, cid)).json.hits).toMatchObject([{ kind: "session", id: sid, gm_only: true }]);
  expect((await get(page, "assistant_search", { q: "a" }, cid)).status).toBe(400);
  expect((await get(page, "assistant_search", { q: "100%" }, cid)).json.hits).toEqual([]);   // a % is a character, not a wildcard

  // a copy of the campaign carries the guide; a copy of its setup starts without one
  const full = (await ok("campaign_copy", { name: "Copy of Varrow" })).id;
  expect((await get(page, "assistant", {}, full)).json.guide).toEqual(GUIDE);
  const setup = (await ok("campaign_copy", { name: "Varrow again", setup: true })).id;
  expect((await get(page, "assistant", {}, setup)).json.version).toBe(0);
});

test("a GM switches the assistant on, writes the guide, and accepts what Claude proposes for an entry", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { cid, pp, ok, mara, ring } = await ready(page, browser);
  const entries = async () => (await get(page, "encyclopedia", {}, cid)).json;

  // off: no button on an entry. Settings, Assistant switches it on, with a genre pack and a guide
  await page.goto(`index.html#/c/${cid}/encyclopedia/${mara}`);
  await expect(page.getByRole("heading", { name: "Mara Hoffmann", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Assistant" })).toHaveCount(0);
  await page.evaluate(k => localStorage.setItem("chronicle.anthropicKey", k), KEY);
  await page.goto(`index.html#/c/${cid}/settings/assistant`);
  const form = page.locator("form.asst-set");
  await expect(form.getByLabel("Premise and tone")).toBeVisible();
  await form.getByLabel("Assistant on for this campaign").check();
  await form.getByLabel("Genre pack").selectOption({ label: "Grim low fantasy" });
  await form.getByLabel("Premise and tone").fill(GUIDE.premise);
  await form.getByLabel("GM-only truths").fill(GUIDE.secrets);
  await form.getByRole("button", { name: "Save assistant settings" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  await expect(form.getByLabel("Premise and tone")).toHaveValue(GUIDE.premise);
  await expect(form.getByLabel("Assistant on for this campaign")).toBeChecked();
  await expect(form.getByRole("button", { name: "History" })).toBeVisible();
  expect((await get(page, "assistant", {}, cid)).json.guide).toMatchObject({ premise: GUIDE.premise, secrets: GUIDE.secrets });

  // Anthropic, faked: first it reads and proposes, then it replies
  const sent = [], ours = [];
  page.on("request", r => { if (r.method() === "POST" && !r.url().includes("anthropic.com")) ours.push(r.postData() || ""); });
  const turns = [
    { content: [{ type: "thinking", thinking: "", signature: "s1" }, { type: "text", text: "Reading the Ring first." },
      { type: "tool_use", id: "t1", name: "search_campaign", input: { query: "candle" } },
      { type: "tool_use", id: "t2", name: "read_entry", input: { entry_id: ring } },
      { type: "tool_use", id: "t3", name: "propose_notes", input: { entry_id: mara, field: "gm_notes", mode: "append", text: "Gave Brannoch a candle stub, the Ring's mark.\n\n- Wants her brother out\n- Will deny it", why: "The Tallow Ring's entry" } },
      { type: "tool_use", id: "t4", name: "propose_entry", input: { name: "Jost Hoffmann", category: "person", public_notes: "", gm_notes: "Mara's brother, a boatman in debt to the Ring.", gm_only: true, why: "New: you told me about him" } },
      { type: "tool_use", id: "t5", name: "propose_connection", input: { from_entry_id: mara, label: "Member of", inverse_label: "Has member", to_entry_id: ring, gm_only: true, why: "Her GM notes" } }],
      stop_reason: "tool_use", usage: { input_tokens: 400, cache_creation_input_tokens: 3000, output_tokens: 300 } },
    { content: [{ type: "text", text: "Three cards for you. **Jost** is new.\n\n- Accept what fits\n- Discard the rest" }], stop_reason: "end_turn", usage: { input_tokens: 900, cache_read_input_tokens: 3000, output_tokens: 60 } },
    { content: [{ type: "text", text: "Is she loyal to the Ring?" }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 10 } },
  ];
  await page.context().route("https://api.anthropic.com/**", async r => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    sent.push({ headers: r.request().headers(), body: r.request().postDataJSON() });
    if (sent.length === 4) return r.fulfill({ status: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: { message: "invalid x-api-key" } }) });
    return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(turns[Math.min(sent.length, turns.length) - 1]) });
  });

  // the entry's page: the button opens the panel, which offers a start
  await page.goto(`index.html#/c/${cid}/encyclopedia/${mara}`);
  await page.getByRole("button", { name: "Assistant" }).click();
  const panel = page.getByRole("complementary", { name: "Assistant" });
  await expect(panel.locator(".asst-read")).toHaveText("About Mara Hoffmann and whatever else it needs to read");
  await expect(panel).toContainText("Nothing is saved until you accept it");
  await panel.getByRole("button", { name: "Fill out this entry" }).click();

  // what went to Anthropic: straight from the browser with the GM's key, the campaign in the system prompt, the entry with the request
  await expect(panel.locator(".asst-msg").last()).toContainText("Three cards for you. Jost is new.");
  await expect(panel.locator(".asst-msg").last().locator("li")).toHaveText(["Accept what fits", "Discard the rest"]);
  expect(sent).toHaveLength(2);
  expect(sent[0].headers["x-api-key"]).toBe(KEY);
  expect(sent[0].headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(sent[0].body).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });
  const campaign = sent[0].body.system[1].text;
  for (const t of ["Genre notes (Grim low fantasy)", GUIDE.premise, GUIDE.secrets, `${mara} | Mara Hoffmann | person`, `${ring} | The Tallow Ring [GM only] | group`, "Session 1: The cut pages"]) expect(campaign).toContain(t);
  const first = sent[0].body.messages[0].content;
  expect(first).toContain("The GM has this entry open on the page:");
  expect(first).toContain("GM notes (players never see these):\nOwes the Ring money.");
  expect(first).toContain("The GM says: Fill out this entry.");
  expect(sent[1].body.messages).toHaveLength(3);
  expect(sent[1].body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "s1" });
  const results = sent[1].body.messages[2].content;
  expect(results.map(c => c.tool_use_id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  expect(results[0].content).toContain("The Tallow Ring");
  expect(results[1].content).toContain("Smugglers who mark their own with candle stubs.");
  expect(sent[1].body.system[1].text).toBe(campaign);   // the same text again, so it is read from the cache
  // neither the key nor the conversation went to this site
  for (const body of ours) { expect(body).not.toContain(KEY); expect(body).not.toContain("Fill out this entry"); }

  // the panel: what it did, the three cards (each GM only), and what it cost
  await expect(panel.locator(".asst-steps span")).toHaveText(["Read Mara Hoffmann", "Searched the campaign for \"candle\"", "Read The Tallow Ring"]);
  const cards = panel.locator(".asst-prop");
  await expect(cards).toHaveCount(3);
  await expect(cards).toHaveClass([/secret/, /secret/, /secret/]);
  await expect(cards.nth(0).locator(".lbl")).toHaveText("GM notes for Mara Hoffmann");
  await expect(cards.nth(1).locator(".lbl")).toHaveText("New entry: Jost Hoffmann, person");
  await expect(cards.nth(2)).toContainText("Mara Hoffmann Member of The Tallow Ring");
  await expect(panel.locator(".asst-use")).toContainText("This conversation: about 1 cent on your Anthropic key");
  expect((await entries()).entries.find(e => e.id === mara).gm_notes).toBe("<p>Owes the Ring money.</p>");   // nothing saved yet
  expect(await page.locator(".asst-panel svg.ico").count()).toBeGreaterThan(3);   // icons are drawn, never raw emoji
  expect(await panel.evaluate(n => /\p{Extended_Pictographic}/u.test(n.textContent.replace(/✕/g, "")))).toBe(false);

  // Edit first, then Accept: the text is added after what the GM notes held, and the page behind shows it
  await cards.nth(0).getByRole("button", { name: "Edit first" }).click();
  const box = cards.nth(0).getByRole("textbox");
  await expect(box).toHaveValue(/^Gave Brannoch a candle stub/);
  await box.fill("Gave Brannoch a candle stub.\n\n- Wants her brother out");
  await cards.nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(cards.nth(0)).toContainText("Saved to Mara Hoffmann");
  let e = (await entries()).entries.find(x => x.id === mara);
  expect(e.gm_notes).toBe("<p>Owes the Ring money.</p><p>Gave Brannoch a candle stub.</p><ul><li>Wants her brother out</li></ul>");
  expect(e.notes).toContain("She waters the ale.");   // the Public notes, GM-only paragraph and all, are as they were
  await expect(page.locator(".enc-detail")).toContainText("Gave Brannoch a candle stub.");

  // Create entry and Add connection
  await cards.nth(1).getByRole("button", { name: "Create entry" }).click();
  await expect(cards.nth(1)).toContainText("Created Jost Hoffmann");
  await cards.nth(2).getByRole("button", { name: "Add connection" }).click();
  await expect(cards.nth(2)).toContainText("Connected Mara Hoffmann and The Tallow Ring");
  const all = await entries();
  const jost = all.entries.find(x => x.name === "Jost Hoffmann");
  expect(jost).toMatchObject({ category: "person", is_secret: true, gm_notes: "<p>Mara's brother, a boatman in debt to the Ring.</p>" });
  expect(all.relations).toMatchObject([{ from_id: mara, to_id: ring, is_secret: true }]);
  // the player sees none of it: no new entry, no connection, no GM notes, no button
  const theirs = (await get(pp, "encyclopedia", {}, cid)).json;
  expect(theirs.entries.map(x => x.name)).toEqual(["Mara Hoffmann"]);
  expect(theirs.relations).toEqual([]);
  await pp.goto(`index.html#/c/${cid}/encyclopedia/${mara}`);
  await expect(pp.getByRole("heading", { name: "Mara Hoffmann", exact: true })).toBeVisible();
  await expect(pp.getByRole("button", { name: "Assistant" })).toHaveCount(0);
  await expect(pp.locator(".asst-panel")).toHaveCount(0);

  // a follow-up carries the conversation, tells Claude the new entry's id, and doesn't send the entry again
  await panel.getByLabel("Message to the assistant").fill("Ask me one thing");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.locator(".asst-msg").last()).toHaveText("Is she loyal to the Ring?");
  const next = sent[2].body.messages;
  expect(next).toHaveLength(5);
  expect(next[4].content).toBe(`The GM accepted the new entry "Jost Hoffmann": its id is ${jost.id}.\n\nThe GM says: Ask me one thing`);

  // a refused key is said plainly, and the message can be sent again
  await panel.getByLabel("Message to the assistant").fill("And another");
  await panel.getByLabel("Message to the assistant").press("Enter");
  await expect(panel.locator(".asst-note.bad")).toHaveText("Anthropic didn't accept your API key. Check it on your account page.");
  await panel.getByLabel("Message to the assistant").fill("And another");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sent.length).toBe(5);
  expect(sent[4].body.messages).toHaveLength(7);   // the failed message was taken back off, so the turns still alternate

  // New request forgets the conversation; closing puts the page back; off in Settings takes the button away
  await panel.getByRole("button", { name: "New request" }).click();
  await expect(panel.locator(".asst-me")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Suggest connections" })).toBeVisible();
  await panel.getByRole("button", { name: "Close the assistant" }).click();
  await expect(page.locator(".asst-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assistant" })).toHaveAttribute("aria-expanded", "false");
  await ok("campaign_update", { settings: { assistant: { enabled: false } } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mara Hoffmann", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Assistant" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("a session's page has the assistant too, and without a key it says where to add one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, ok, sid } = await ready(page, browser);
  await switchOn(ok);
  await page.goto(`index.html#/c/${cid}/sessions/${sid}`);
  // a phone shows the notes or the summary, one at a time; the assistant is with the summary
  const summaryTab = page.getByRole("button", { name: "Summary", exact: true });
  await expect(page.locator(".sess-cols")).toBeVisible();
  if (await summaryTab.isVisible()) await summaryTab.click();
  await page.getByRole("button", { name: "Assistant" }).click();
  const panel = page.getByRole("complementary", { name: "Assistant" });
  await expect(panel.locator(".asst-read")).toHaveText("About the session on this page and whatever else it needs to read");
  await expect(panel).toContainText("The assistant uses your own Anthropic API key");
  await expect(panel.getByRole("link", { name: "Add your key on your account page" })).toHaveAttribute("href", "#/account");
  await expect(panel.getByLabel("Message to the assistant")).toBeDisabled();
  // the panel fits the screen it is on, and leaving the campaign closes it
  const box = await panel.boundingBox(), view = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(view.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { location.hash = "#/"; });
  await expect(page.locator(".asst-panel")).toHaveCount(0);
  expectNoErrors(errors);
});
