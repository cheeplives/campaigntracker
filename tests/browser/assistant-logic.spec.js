// The Assistant's thinking, under Node (static/assistant.js needs no page): what a request starts from, the tools
// Claude is given, the loop that answers them, what a proposal must be to be shown, what a request cost, and the
// rich text an accepted proposal becomes.
const { test, expect } = require("@playwright/test");
const path = require("path");
const A = require(path.join(__dirname, "..", "..", "static", "assistant.js"));

const CTX = {
  campaign: { name: "Port Varrow", description: "A salt port" },
  pack: { name: "Grim low fantasy", text: "Mud, debt and hard choices." },
  guide: { prompt: "Agenda: fill the port with trouble.\n\nPrinciples: name everyone.", premise: "Nobody is a hero.", power: "", lines: "", style: "", canon: "", rules: "", secrets: "Brandt cut the pages." },
  entries: [{ id: 1, name: "Mara Hoffmann", category: "person", aliases: ["the innkeeper"], gm_only: false, gist: "Runs the Gilded Eel." },
    { id: 2, name: "The Tallow Ring", category: "group", aliases: [], gm_only: true, gist: "Smugglers." }],
  entries_total: 2,
  sessions: [{ id: 7, number: 1, title: "The cut pages", played_on: "2026-11-01", published: false, gist: "They found the ledger." }],
  links: [[1, "Member of", 2, true], [1, "Knows", 99, false]],
};
const NAMES = new Map([[1, "Mara Hoffmann"], [2, "The Tallow Ring"]]);

test("the campaign text carries the pack, the guide and the index, and marks what players can't see", () => {
  const t = A.campaignText(CTX);
  for (const s of ["Campaign: Port Varrow", "Genre notes (Grim low fantasy)", "Mud, debt and hard choices.", "The GM's campaign guide:\nCampaign prompt:\nAgenda: fill the port with trouble.\n\nPrinciples: name everyone.\n\nPremise and tone:\nNobody is a hero.",
    "GM-only truths (players must never learn these from Public notes):\nBrandt cut the pages.",
    "1 | Mara Hoffmann | person | the innkeeper | Runs the Gilded Eel.", "2 | The Tallow Ring [GM only] | group | - | Smugglers.",
    "7 | Session 1: The cut pages [not published] | 2026-11-01 | They found the ledger.",
    "Mara Hoffmann (1) — Member of — The Tallow Ring (2) [GM only]"]) expect(t).toContain(s);
  expect(t).not.toContain("Game and power level");   // an empty part of the guide is left out
  expect(t).not.toContain("Knows");                  // a connection to an entry that isn't in the index
  expect(A.campaignText(CTX)).toBe(t);               // the same campaign reads the same, so it can be cached
  const bare = A.campaignText({ ...CTX, pack: null, guide: {}, entries: [], sessions: [], links: [] });
  expect(bare).toContain("hasn't written a campaign guide yet");
  expect(bare).toContain("The Encyclopedia has no entries yet.");
});

test("a request caches the campaign, asks for no forced tool, and Haiku sends no fallback", () => {
  const r = A.request("claude-sonnet-5-5", "CAMPAIGN", [{ role: "user", content: "hi" }]);
  expect(r).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default", output_config: { effort: "medium" }, cache_control: { type: "ephemeral" } });
  expect(r.system[0]).toEqual({ type: "text", text: A.SYSTEM });
  expect(r.system[1]).toEqual({ type: "text", text: "CAMPAIGN", cache_control: { type: "ephemeral" } });
  expect(r.tool_choice).toBeUndefined();
  expect(r.thinking).toBeUndefined();
  expect(r.temperature).toBeUndefined();
  expect(r.tools.map(t => t.name)).toEqual(["search_campaign", "read_entry", "read_session", "propose_notes", "propose_entry", "propose_connection"]);
  for (const t of r.tools) {
    expect(t.strict).toBe(true);
    expect(t.input_schema.additionalProperties).toBe(false);
    expect(t.input_schema.required).toEqual(Object.keys(t.input_schema.properties));
  }
  expect(A.request("claude-haiku-5-5", "C", []).fallbacks).toBeUndefined();
  expect(A.request("something-else", "C", []).model).toBe("claude-sonnet-5-5");
});

test("a proposal is tidied, and one that can't be shown is refused", () => {
  expect(A.proposal("propose_notes", { entry_id: 1, field: "gm_notes", mode: "replace", text: "  In the Ring.  ", why: "session\n1" }, NAMES))
    .toEqual({ kind: "notes", entry_id: 1, entry: "Mara Hoffmann", field: "gm_notes", mode: "replace", text: "In the Ring.", why: "session 1" });
  expect(A.proposal("propose_notes", { entry_id: 1, field: "anything", mode: "anything", text: "x", why: "" }, NAMES)).toMatchObject({ field: "notes", mode: "append" });
  expect(A.proposal("propose_notes", { entry_id: 5, field: "notes", mode: "append", text: "x" }, NAMES)).toBeNull();   // no such entry
  expect(A.proposal("propose_notes", { entry_id: 1, field: "notes", mode: "append", text: "  " }, NAMES)).toBeNull();
  expect(A.proposal("propose_entry", { name: " Jost  Hoffmann ", category: "none", public_notes: "", gm_notes: "Her brother.", gm_only: true, why: "" }, NAMES))
    .toEqual({ kind: "entry", name: "Jost Hoffmann", category: null, notes: "", gm_notes: "Her brother.", gm_only: true, why: "" });
  expect(A.proposal("propose_connection", { from_entry_id: 1, to_entry_id: 2, label: "Member of", inverse_label: "Has member", gm_only: true, why: "candle" }, NAMES))
    .toEqual({ kind: "connection", from_id: 1, from: "Mara Hoffmann", to_id: 2, to: "The Tallow Ring", label: "Member of", inverse_label: "Has member", gm_only: true, why: "candle" });
  expect(A.proposal("propose_connection", { from_entry_id: 1, to_entry_id: 1, label: "Knows" }, NAMES)).toBeNull();
  expect(A.proposal("propose_connection", { from_entry_id: 1, to_entry_id: 2, label: "" }, NAMES)).toBeNull();
  expect(A.proposal("delete_everything", {}, NAMES)).toBeNull();
});

test("accepted text becomes paragraphs and lists, escaped, after or in place of what was there", () => {
  expect(A.textHtml("One <b>\nstill one\n\n- a & b\n- c\nafter")).toBe("<p>One &lt;b&gt;<br>still one</p><ul><li>a &amp; b</li><li>c</li></ul><p>after</p>");
  expect(A.textHtml("")).toBe("");
  expect(A.notesHtml("<p>Old</p>", { mode: "append", text: "New" })).toBe("<p>Old</p><p>New</p>");
  expect(A.notesHtml("<p>Old</p>", { mode: "replace", text: "New" })).toBe("<p>New</p>");
  expect(A.notesHtml(null, { mode: "append", text: "New" })).toBe("<p>New</p>");
});

test("a request's cost counts cached tokens at their own prices", () => {
  const use = A.noUse();
  A.addUse(use, { input_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0, output_tokens: 500 });
  A.addUse(use, { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 500 });
  expect(use).toEqual({ input: 3000, written: 10000, read: 10000, output: 1000, calls: 2 });
  expect(A.cost("claude-sonnet-5-5", use)).toBeCloseTo((3000 * 2 + 10000 * 2.5 + 10000 * 0.1 + 1000 * 10) / 1e6, 6);
  expect(A.cost("claude-opus-5-5", use)).toBeCloseTo(2 * (3000 * 2 + 10000 * 2.5 + 10000 * 0.1 + 1000 * 10) / 1e6, 6);
  const big = A.addUse(A.noUse(), { input_tokens: 150000, output_tokens: 1000 });
  expect(A.cost("claude-haiku-5-5", big)).toBeCloseTo(5 * (150000 * 0.1 + 1000 * 0.5) / 1e6, 6);   // over 100,000 tokens a call
  expect([A.costText(0.004), A.costText(0.01), A.costText(0.043), A.costText(1.2)]).toEqual(["under 1 cent", "about 1 cent", "about 4 cents", "about $1.20"]);
});

/** A fetch that answers each call with the next of `answers` ({ status?, body }), and keeps what it was sent. */
function fake(answers) {
  const sent = [];
  const fetchFn = async (url, opt) => {
    sent.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
    const a = answers[sent.length - 1];
    return { ok: (a.status || 200) < 400, status: a.status || 200, json: async () => a.body };
  };
  return { sent, fetchFn };
}
const usage = { input_tokens: 10, output_tokens: 5 };
function io() {
  const log = { steps: [], said: [], proposed: [] };
  return { log, search: async q => ({ q, hits: [{ kind: "entry", id: 2, name: "The Tallow Ring", category: "group", gm_only: true, snippet: "…candle stubs…" }] }),
    readEntry: async id => { if (id !== 1) throw new Error("Entry not found"); return { name: "Mara Hoffmann", text: "Entry 1: Mara Hoffmann" }; },
    readSession: async () => ({ text: "Session 1: The cut pages (id 7)\nSummary" }),
    step: (icon, text) => log.steps.push(text), say: t => log.said.push(t), propose: p => log.proposed.push(p) };
}

test("run answers every tool Claude calls in one message, hands its turn back unchanged, and resolves its reply", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const calls = [
    { type: "tool_use", id: "t1", name: "search_campaign", input: { query: "candle" } },
    { type: "tool_use", id: "t2", name: "read_entry", input: { entry_id: 1 } },
    { type: "tool_use", id: "t3", name: "read_entry", input: { entry_id: 44 } },
    { type: "tool_use", id: "t4", name: "read_session", input: { session_id: 7 } },
    { type: "tool_use", id: "t5", name: "propose_notes", input: { entry_id: 1, field: "gm_notes", mode: "append", text: "In the Ring.", why: "candle stub" } },
    { type: "tool_use", id: "t6", name: "propose_entry", input: { name: "mara hoffmann", category: "person", public_notes: "x", gm_notes: "", gm_only: false, why: "" } },
    { type: "tool_use", id: "t7", name: "propose_connection", input: { from_entry_id: 1, to_entry_id: 9, label: "Knows", inverse_label: "", gm_only: false, why: "" } },
  ];
  const { sent, fetchFn } = fake([
    { body: { content: [thinking, { type: "text", text: "Let me look." }, ...calls], stop_reason: "tool_use", usage } },
    { body: { content: [{ type: "text", text: "One card for you." }], stop_reason: "end_turn", usage } },
  ]);
  const messages = [{ role: "user", content: "Fill out Mara" }], i = io();
  const r = await A.run({ apiKey: "sk-ant-x", model: "claude-sonnet-5-5", campaign: "CAMPAIGN", messages, io: i, names: NAMES, fetchFn });
  expect(r.text).toBe("One card for you.");
  expect(r.use).toMatchObject({ input: 20, output: 10, calls: 2 });
  expect(sent).toHaveLength(2);
  expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect(sent[0].headers).toMatchObject({ "x-api-key": "sk-ant-x", "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true", "anthropic-beta": "server-side-fallback-2026-07-01" });
  // Claude's turn went back exactly as it came, reasoning included, followed by one message with every tool's answer
  expect(sent[1].body.messages[1]).toEqual({ role: "assistant", content: [thinking, { type: "text", text: "Let me look." }, ...calls] });
  const results = sent[1].body.messages[2];
  expect(results.role).toBe("user");
  expect(results.content.map(c => [c.type, c.tool_use_id, !!c.is_error])).toEqual([["tool_result", "t1", false], ["tool_result", "t2", false], ["tool_result", "t3", true],
    ["tool_result", "t4", false], ["tool_result", "t5", false], ["tool_result", "t6", true], ["tool_result", "t7", true]]);
  expect(results.content[0].content).toContain("Entry 2: The Tallow Ring (group) [GM only]");
  expect(results.content[2].content).toContain("Entry not found");
  expect(results.content[5].content).toContain("already an entry called");
  expect(i.log.said).toEqual(["Let me look."]);
  expect(i.log.steps).toEqual(["Searched the campaign for \"candle\"", "Read Mara Hoffmann", "Read Session 1: The cut pages"]);
  expect(i.log.proposed).toEqual([{ kind: "notes", entry_id: 1, entry: "Mara Hoffmann", field: "gm_notes", mode: "append", text: "In the Ring.", why: "candle stub" }]);
  expect(messages).toHaveLength(4);   // the GM's message, Claude's turn, the tools' answers, Claude's reply
});

test("run takes a failed request back off the conversation, and says what went wrong in plain words", async () => {
  const tool = { content: [{ type: "tool_use", id: "t1", name: "read_session", input: { session_id: 7 } }], stop_reason: "tool_use", usage };
  for (const [answers, message] of [
    [[{ body: tool }, { status: 529, body: { error: { message: "overloaded" } } }], /busy or having trouble/],
    [[{ status: 401, body: {} }], /didn't accept your API key/],
    [[{ body: { content: [], stop_reason: "refusal", usage } }], /declined/],
    [[{ body: { content: [], stop_reason: "max_tokens", usage } }], /ran too long/],
    [Array.from({ length: A.MAX_TURNS }, () => ({ body: tool })), /more steps/],
  ]) {
    const messages = [{ role: "user", content: "hello" }];
    const { sent, fetchFn } = fake(answers);
    const err = await A.run({ apiKey: "k", model: "claude-haiku-5-5", campaign: "C", messages, io: io(), names: NAMES, fetchFn }).catch(e => e);
    expect(err.message).toMatch(message);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
    expect(sent[0].headers["anthropic-beta"]).toBeUndefined();   // Haiku has no fallback to ask for
    expect(err.use.calls).toBe(answers.filter(a => !a.status).length);   // what was used before it failed is still counted
  }
  await expect(A.run({ apiKey: "", model: "x", campaign: "C", messages: [], io: io(), names: NAMES })).rejects.toThrow(/Add your Anthropic API key/);
});
