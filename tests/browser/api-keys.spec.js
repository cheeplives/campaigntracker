// API keys: a key for a program (a Foundry module, a bot, a script), sent in the X-Chronicle-Key header with no cookie.
// It acts as the member who made it in its own campaign, on a short list of actions, read-only unless made read/write,
// and any site may call with one (CORS). docs/API.md documents what it can do.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const PORT = process.env.PORT || "8755", BASE = `http://127.0.0.1:${PORT}/`;

async function table(page, browser, name) {
  const gm = person(`${name}GM`), player = person(`${name}Player`);
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${name} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, gm, player, pp };
}
async function makeKey(page, cid, data = {}) {
  const r = await api(page, "panel_link_create", { scope: "api", label: "Script", ...data }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.link;
}
/** Call the API with a key and no cookie, as a program does. */
async function keyCall(request, key, action, { query = {}, body, header = "X-Chronicle-Key" } = {}) {
  const qs = new URLSearchParams({ a: action, ...query });
  const opt = { headers: { [header]: key } };
  const r = body === undefined ? await request.get(`api/index.php?${qs}`, opt) : await request.post(`api/index.php?${qs}`, { ...opt, data: body });
  return { status: r.status(), json: await r.json(), headers: r.headers() };
}

test.describe("API keys", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

  test("a read-only key reads its own campaign as its maker, with no one's email, and changes nothing", async ({ page, browser, playwright }) => {
    const { cid, gm, player, pp } = await table(page, browser, "KeyRead");
    const other = await makeCampaign(page, `Other ${gm.id}`);
    const bare = await playwright.request.newContext({ baseURL: BASE });
    const k = await makeKey(page, cid);
    expect(k).toMatchObject({ scope: "api", write: false });
    expect(k.code).toMatch(/^[0-9a-f]{64}$/);
    expect(sql(`SELECT token_hash FROM connection_keys WHERE id=${k.id}`).trim()).not.toBe(k.code);

    const who = await keyCall(bare, k.code, "panel_whoami", { query: { cid: other } });
    expect(who.json).toMatchObject({ campaign_id: cid, role: "gm", link: { scope: "api", write: false } });
    const camp = await keyCall(bare, k.code, "campaign", { query: { cid: other } });
    expect(camp.json.campaign.id).toBe(cid);
    expect(typeof camp.json.campaign.current_shift).toBe("number");
    expect(JSON.stringify(camp.json.members)).not.toContain(player.email);
    expect(JSON.stringify(camp.json.members)).not.toContain(gm.email);
    for (const [a, query] of [["changed"], ["day", { d: 2 }], ["days", { from: 0, to: 3 }], ["events"], ["reminders"], ["encyclopedia"], ["groups"], ["maps"]]) {
      const r = await keyCall(bare, k.code, a, { query });
      expect(r.status, `${a}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    // writing with a read-only key, or anything off the list, is refused
    const ro = await keyCall(bare, k.code, "shift_note_add", { body: { abs_day: 2, shift: 0, body: "Nope" } });
    expect(ro.status).toBe(401);
    expect(ro.json.message).toBe("This API key is read-only.");
    for (const a of ["campaign_update", "member_add", "panel_link_create", "entry_save", "campaigns", "users", "days_save"]) {
      const r = await keyCall(bare, k.code, a, { body: {} });
      expect(r.status, a).toBe(401);
      expect(r.json.error, a).toBe("panel_not_allowed");
    }
    // a key is no panel link, a panel link no key, and both at once is refused
    const link = (await api(pp, "panel_link_create", { label: "Panel" }, cid)).json.link;
    expect((await keyCall(bare, link.code, "campaign")).json.error).toBe("bad_panel_link");
    expect((await keyCall(bare, k.code, "campaign", { header: "X-Chronicle-Panel" })).json.error).toBe("bad_panel_link");
    const both = await bare.get(`api/index.php?a=campaign`, { headers: { "X-Chronicle-Key": k.code, "X-Chronicle-Panel": link.code } });
    expect(both.status()).toBe(401);
    // revoked: it stops
    expect((await api(page, "panel_link_revoke", { id: k.id }, cid)).status).toBe(200);
    expect((await keyCall(bare, k.code, "campaign")).json.error).toBe("bad_panel_link");
    await bare.dispose();
  });

  test("a read/write key changes what its maker may: a GM's passes time, a player's adds notes but can't", async ({ page, browser, playwright }) => {
    const { cid, pp } = await table(page, browser, "KeyWrite");
    const bare = await playwright.request.newContext({ baseURL: BASE });
    const g = (await makeKey(page, cid, { write: true })).code, p = (await makeKey(pp, cid, { write: true })).code;
    expect((await keyCall(bare, g, "set_time", { body: { current_shift: 21 } })).status).toBe(200);
    expect((await keyCall(bare, g, "campaign")).json.campaign.current_shift).toBe(21);
    expect((await keyCall(bare, p, "set_time", { body: { current_shift: 40 } })).status).toBe(403);
    expect((await keyCall(bare, p, "shift_note_add", { body: { abs_day: 5, shift: 1, body: "From a bot" } })).status).toBe(200);
    expect(sql(`SELECT u.email FROM shift_notes n JOIN users u ON u.id=n.user_id WHERE n.body='From a bot'`).trim()).toContain("keywriteplayer");
    const ev = await keyCall(bare, g, "event_save", { body: { abs_day: 5, title: "Ford crossed" } });
    expect(ev.status, JSON.stringify(ev.json)).toBe(200);
    expect((await keyCall(bare, p, "events")).json.events.map(e => e.title)).toContain("Ford crossed");
    const entry = (await api(page, "entry_save", { name: "The Ford", notes: "<p>Shallow.</p>" }, cid)).json.id;
    expect((await keyCall(bare, p, "entry_note_add", { body: { id: entry, body: "Watch for trolls" } })).status).toBe(200);
    // the player leaves: their key stops
    const pid = Number(sql(`SELECT user_id FROM connection_keys WHERE token_hash=SHA2('${p}', 256)`).trim());
    expect((await api(page, "member_remove", { user_id: pid }, cid)).status).toBe(200);
    expect((await keyCall(bare, p, "campaign")).status).toBe(401);
    await bare.dispose();
  });

  test("any site may call with a key (CORS), and nothing without one is opened", async ({ page, browser, playwright }) => {
    const { cid } = await table(page, browser, "KeyCors");
    const bare = await playwright.request.newContext({ baseURL: BASE });
    const k = (await makeKey(page, cid)).code;
    const pre = await bare.fetch("api/index.php?a=campaign", { method: "OPTIONS", headers: { Origin: "https://foundry.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-chronicle-key" } });
    expect(pre.status()).toBe(204);
    expect(pre.headers()["access-control-allow-origin"]).toBe("*");
    expect(pre.headers()["access-control-allow-headers"]).toContain("X-Chronicle-Key");
    expect(pre.headers()["access-control-allow-credentials"]).toBeUndefined();
    const r = await keyCall(bare, k, "campaign");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    // an error with a key is readable too, so a program can say what is wrong
    expect((await keyCall(bare, "b".repeat(64), "campaign")).headers["access-control-allow-origin"]).toBe("*");
    // without the key header: no CORS, and a preflight for anything else is refused as before
    expect((await page.request.get(`api/index.php?a=campaign&cid=${cid}`)).headers()["access-control-allow-origin"]).toBeUndefined();
    const other = await bare.fetch("api/index.php?a=campaign", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-csrf-token" } });
    expect(other.status()).toBe(405);
    expect(other.headers()["access-control-allow-origin"]).toBeUndefined();
    await bare.dispose();
  });
});

test("a member makes an API key at the table, sees it once with how to send it, and it is listed", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await table(page, browser, "KeyUi");
  await page.goto(`index.html#/c/${cid}/table`);
  await page.getByRole("button", { name: "New API key…" }).click();
  const d = page.getByRole("dialog", { name: "New API key" });
  await d.getByLabel("Label").fill("Foundry module");
  await d.getByLabel("Access").selectOption("write");
  await d.getByRole("button", { name: "Make key" }).click();
  await expect(d.getByRole("heading")).toHaveText('"Foundry module" is ready');
  const key = await d.getByLabel("API key").inputValue();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  await expect(d.locator("pre")).toContainText(`X-Chronicle-Key: ${key}`);
  await d.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tv-link")).toContainText("Foundry module · API key, read and write");
  expectNoErrors(errors);
});
