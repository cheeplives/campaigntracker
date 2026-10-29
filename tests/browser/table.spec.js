// At the Table (the campaign right now, in big type) and the panel: the same view on panel.html, signed in with a
// panel link's code in the X-Chronicle-Panel header, for a virtual tabletop's frame, OBS or a shared screen.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const PORT = process.env.PORT || "8755", BASE = `http://127.0.0.1:${PORT}/`;

/** A GM with a campaign, and a player in it, each in their own browser context. */
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
/** Make a panel link as whoever page is; returns its code. */
async function makeLink(page, cid, data = {}) {
  const r = await api(page, "panel_link_create", { label: "Test", ...data }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.link;
}
/** Call the API with a panel link's code and no cookie, as the panel does. */
async function panelCall(request, code, action, { query = {}, body } = {}) {
  const qs = new URLSearchParams({ a: action, ...query });
  const opt = { headers: { "X-Chronicle-Panel": code } };
  const r = body === undefined ? await request.get(`api/index.php?${qs}`, opt) : await request.post(`api/index.php?${qs}`, { ...opt, data: body });
  return { status: r.status(), json: await r.json() };
}

test("At the Table sits in the Party group and shows the date, weather, light, moons and the party", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Tamsin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Table ${gm.id}`);
  await page.goto(`index.html#/c/${cid}`);
  const tab = page.locator(".tabs a", { hasText: "At the Table" });
  await expect(tab).toHaveAttribute("data-group", "Party");
  await tab.click();
  await expect(page.locator(".tabs a.on")).toHaveText("At the Table");
  const view = page.locator(".table-view");
  await expect(view.locator(".tv-date")).toContainText("Firstmonth");
  await expect(view.locator(".tv-card")).toHaveCount(4);
  await expect(view.locator(".tv-card", { hasText: "Weather" }).locator(".wx")).toBeVisible();
  await expect(view.locator(".tv-card", { hasText: "Party" })).toContainText("Home");
  // Pass a shift moves the clock, and the view follows
  const before = await view.locator(".tv-shift").textContent();
  await view.getByRole("button", { name: /Pass a shift/ }).click();
  await expect(view.locator(".tv-shift")).not.toHaveText(before);
  expect((await api(page, "campaign", undefined, cid)).json.campaign.current_shift).toBe(9);
  expectNoErrors(errors);
});

test("a note goes on this shift or at the end of an Encyclopedia entry, and an entry can be looked up", async ({ page, browser }) => {
  const { cid, pp } = await table(page, browser, "Notes");
  const e = await api(page, "entry_save", { name: "Coaching Inn", notes: "<p>A walled inn on the road.</p>" }, cid);
  expect(e.status).toBe(200);
  const secret = (await api(page, "entry_save", { name: "Hidden Cult", is_secret: true }, cid)).json.id;

  await pp.goto(`index.html#/c/${cid}/table`);
  const view = pp.locator(".table-view");
  await view.getByLabel("Look up a name in the Encyclopedia").fill("coach");
  await expect(view.locator(".tv-entry h3")).toContainText("Coaching Inn");
  await expect(view.locator(".tv-entry")).toContainText("A walled inn on the road.");
  await view.getByLabel("Look up a name in the Encyclopedia").fill("hidden");
  await expect(view.locator(".tv-lookup")).toContainText("No entry by that name");

  // a shift note, as on Current Day
  await view.getByLabel("Note", { exact: true }).fill("Sore feet");
  await view.getByRole("button", { name: "Save note" }).click();
  await expect(pp.getByText(/Note added to/)).toBeVisible();
  const notes = sql(`SELECT body FROM shift_notes WHERE campaign_id=${cid}`);
  expect(notes).toContain("Sore feet");

  // an entry note, from the looked-up entry's Add a note
  await view.getByLabel("Look up a name in the Encyclopedia").fill("coach");
  await view.getByRole("button", { name: "📝 Add a note" }).click();
  await expect(view.getByRole("radio", { name: "On an Encyclopedia entry" })).toHaveAttribute("aria-checked", "true");
  await expect(view.getByLabel("Entry")).toHaveValue("Coaching Inn");
  await expect(view.getByText("GM only")).toHaveCount(0);   // players can't make a GM-only note
  await view.getByLabel("Note", { exact: true }).fill("Hans owes Kurt <3> shillings");
  await view.getByRole("button", { name: "Save note" }).click();
  await expect(pp.getByText("Note added to Coaching Inn")).toBeVisible();
  const notesNow = sql(`SELECT notes FROM encyclopedia_entries WHERE id=${e.json.id}`);
  expect(notesNow).toContain("<p>A walled inn on the road.</p><p>Hans owes Kurt &lt;3&gt; shillings</p>");
  // a player can't add to a secret entry, or to the GM notes
  expect((await api(pp, "entry_note_add", { id: secret, body: "x" }, cid)).status).toBe(404);
  expect((await api(pp, "entry_note_add", { id: e.json.id, body: "secret?", gm_only: true }, cid)).status).toBe(200);
  expect(sql(`SELECT COALESCE(gm_notes, '') FROM encyclopedia_entries WHERE id=${e.json.id}`).trim()).toBe("");
  // a GM's GM-only note goes in the GM notes
  expect((await api(page, "entry_note_add", { id: e.json.id, body: "He's a cultist", gm_only: true }, cid)).status).toBe(200);
  expect(sql(`SELECT gm_notes FROM encyclopedia_entries WHERE id=${e.json.id}`)).toContain("He's a cultist");
});

test.describe("panel links", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

  test("members make and revoke their own; only GMs make public ones; only the code's hash is kept", async ({ page, browser }) => {
    const { cid, pp } = await table(page, browser, "Links");
    const mine = await makeLink(pp, cid, { label: "Owlbear" });
    expect(mine.code).toMatch(/^[0-9a-f]{64}$/);
    expect(mine.scope).toBe("panel");
    expect(sql(`SELECT token_hash FROM connection_keys WHERE id=${mine.id}`).trim()).not.toBe(mine.code);
    expect((await api(pp, "panel_link_create", { scope: "public_panel", label: "Stream" }, cid)).status).toBe(403);
    const pub = await makeLink(page, cid, { scope: "public_panel", label: "Stream", overlay: true });
    expect(pub.overlay).toBe(true);
    // a player lists only their own; the GM lists everyone's, without the codes
    expect((await api(pp, "panel_links", undefined, cid)).json.links.map(k => k.label)).toEqual(["Owlbear"]);
    const all = (await api(page, "panel_links", undefined, cid)).json.links;
    expect(all.map(k => k.label).sort()).toEqual(["Owlbear", "Stream"]);
    expect(JSON.stringify(all)).not.toContain(mine.code);
    // a player can't revoke the GM's; the GM can revoke the player's
    expect((await api(pp, "panel_link_revoke", { id: pub.id }, cid)).status).toBe(403);
    expect((await api(page, "panel_link_revoke", { id: mine.id }, cid)).status).toBe(200);
    expect((await panelCall(page.request, mine.code, "panel_whoami")).status).toBe(401);
  });

  test("a link reaches only its own campaign and its short list of actions, as its maker", async ({ page, browser, playwright }) => {
    const { cid, gm, pp } = await table(page, browser, "Reach");
    const other = await makeCampaign(page, `Other ${gm.id}`);
    const bare = await playwright.request.newContext({ baseURL: BASE });
    const p = (await makeLink(pp, cid)).code, g = (await makeLink(page, cid)).code;

    const who = await panelCall(bare, p, "panel_whoami", { query: { cid: other } });
    expect(who.status).toBe(200);
    expect(who.json.campaign_id).toBe(cid);   // the cid asked for is ignored
    expect(who.json.role).toBe("player");
    for (const a of ["campaign", "changed", "days", "reminders", "encyclopedia", "groups", "maps"]) {
      const r = await panelCall(bare, p, a, { query: { from: 0, to: 3 } });
      expect(r.status, `${a}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    expect((await panelCall(bare, p, "campaign", { query: { cid: other } })).json.campaign.id).toBe(cid);
    // not on the list: refused, even for a GM's link
    for (const a of ["events", "campaign_update", "member_add", "panel_link_create", "entry_save", "campaigns", "users"]) {
      const r = await panelCall(bare, g, a, a === "events" ? {} : { body: {} });
      expect(r.status, a).toBe(401);
      expect(r.json.error, a).toBe("panel_not_allowed");
    }
    // a player's link adds notes as the player, needs no CSRF token, and can't pass time
    expect((await panelCall(bare, p, "shift_note_add", { body: { abs_day: 2, shift: 0, body: "From the panel" } })).status).toBe(200);
    expect(sql(`SELECT u.email FROM shift_notes n JOIN users u ON u.id=n.user_id WHERE n.body='From the panel'`).trim()).toContain("reachplayer");
    expect((await panelCall(bare, p, "set_time", { body: { current_shift: 20 } })).status).toBe(403);
    expect((await panelCall(bare, g, "set_time", { body: { current_shift: 9 } })).status).toBe(200);
    // a nonsense or unknown code
    expect((await panelCall(bare, "nope", "campaign")).json.error).toBe("bad_panel_link");
    expect((await panelCall(bare, "a".repeat(64), "campaign")).json.error).toBe("bad_panel_link");
    // removed from the campaign: the link stops
    const pid = Number(sql(`SELECT user_id FROM connection_keys WHERE token_hash=SHA2('${p}', 256)`).trim());
    expect((await api(page, "member_remove", { user_id: pid }, cid)).status).toBe(200);
    expect((await panelCall(bare, p, "campaign")).json.error).toBe("bad_panel_link");
    await bare.dispose();
  });

  test("a public link sees only what every player sees, can't change anything, and stops with its GM", async ({ page, browser, playwright }) => {
    const { cid, pp } = await table(page, browser, "Public");
    const bare = await playwright.request.newContext({ baseURL: BASE });
    expect((await api(page, "event_save", { abs_day: 2, title: "Secret meeting", is_secret: true }, cid)).status).toBe(200);
    expect((await api(page, "event_save", { abs_day: 2, title: "Market day" }, cid)).status).toBe(200);
    expect((await api(page, "entry_save", { name: "Hidden Cult", is_secret: true, gm_notes: "<p>GM eyes</p>" }, cid)).status).toBe(200);
    expect((await api(page, "entry_save", { name: "Altdorf", notes: "<p>Big city</p>", gm_notes: "<p>Plague</p>" }, cid)).status).toBe(200);
    expect((await api(page, "reminder_save", { due_shift: 10, title: "GMs only", audience: "gm" }, cid)).status).toBe(200);
    const code = (await makeLink(page, cid, { scope: "public_panel" })).code;

    const camp = await panelCall(bare, code, "campaign");
    expect(camp.json.role).toBe("player");
    expect(camp.json.campaign.seed).toBeUndefined();
    const all = JSON.stringify([camp.json, (await panelCall(bare, code, "days", { query: { from: 0, to: 5 } })).json,
      (await panelCall(bare, code, "encyclopedia")).json, (await panelCall(bare, code, "reminders")).json]);
    expect(all).toContain("Market day");
    expect(all).toContain("Big city");
    for (const s of ["Secret meeting", "Hidden Cult", "GM eyes", "Plague", "GMs only"]) expect(all, s).not.toContain(s);
    for (const a of ["shift_note_add", "entry_note_add", "set_time", "days_save"]) expect((await panelCall(bare, code, a, { body: {} })).status, a).toBe(401);
    expect((await panelCall(bare, code, "panel_whoami")).json.name).toBeNull();
    // the GM who made it stops being a GM here: it stops too
    sql(`UPDATE campaign_members SET role='player' WHERE campaign_id=${cid} AND user_id=(SELECT created_by FROM connection_keys WHERE token_hash=SHA2('${code}', 256))`);
    expect((await panelCall(bare, code, "campaign")).json.error).toBe("bad_panel_link");
    await bare.dispose();
  });

  test("the Owlbear Rodeo manifest is open to anyone and opens the panel", async ({ request }) => {
    const r = await request.get("api/index.php?a=owlbear_manifest");
    expect(r.status()).toBe(200);
    expect(r.headers()["access-control-allow-origin"]).toBe("*");
    const m = await r.json();
    expect(m.manifest_version).toBe(1);
    expect(m.name.length).toBeLessThanOrEqual(45);
    expect(m.description.length).toBeLessThanOrEqual(128);
    expect(m.action.popover).toMatch(/^https?:\/\/.+\/panel\.html$/);
  });

  test("only panel.html may be framed by another site (.htaccess)", () => {
    const ht = fs.readFileSync(path.join(__dirname, "..", "..", ".htaccess"), "utf8");
    expect(ht).toMatch(/frame-ancestors 'none'/);
    const block = ht.match(/<Files "panel\.html">([\s\S]*?)<\/Files>/);
    expect(block, "a <Files \"panel.html\"> block").toBeTruthy();
    expect(block[1]).toContain("Header always unset X-Frame-Options");
    expect(block[1]).toContain("frame-ancestors *");
    expect(ht.match(/frame-ancestors \*/g)).toHaveLength(1);
  });
});

test("the panel opens in another site's frame with only a link, follows the GM, and asks again once revoked", async ({ page, browser }) => {
  const { cid } = await table(page, browser, "Frame");
  const link = await makeLink(page, cid, { label: "Owlbear" });
  // a browser with no Chronicle cookie at all, on another origin (localhost, not 127.0.0.1) framing the panel
  const ctx = await newContext(browser);
  const vtt = await ctx.newPage();
  const errors = watchErrors(vtt);
  await vtt.goto(`http://localhost:${PORT}/offline.html`);
  await vtt.evaluate(src => { document.body.innerHTML = ""; const f = document.createElement("iframe"); f.src = src; f.style.cssText = "width:420px;height:900px"; document.body.append(f); },
    `${BASE}panel.html#k=${link.code}`);
  const panel = vtt.frameLocator("iframe");
  await expect(panel.locator(".tv-date")).toContainText("Firstmonth");
  await expect(panel.locator(".panel-foot")).toContainText("via panel link");
  await expect(panel.getByRole("button", { name: /Pass a shift/ })).toBeVisible();
  const before = await panel.locator(".tv-shift").textContent();
  // the GM passes time in Chronicle; the panel catches up when it next checks
  expect((await api(page, "set_time", { current_shift: 13 }, cid)).status).toBe(200);
  const frame = vtt.frames().find(f => f.url().includes("panel.html"));
  await frame.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(panel.locator(".tv-shift")).not.toHaveText(before);
  // the code isn't left in the address
  expect(frame.url()).not.toContain(link.code);
  // revoked: it asks for a new link
  expect((await api(page, "panel_link_revoke", { id: link.id }, cid)).status).toBe(200);
  await frame.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(panel.getByText("Paste your panel link")).toBeVisible();
  await expect(panel.locator(".panel-ask .error")).toContainText("revoked");
  expectNoErrors(errors);
});

test("a public link with overlay is see-through and shows only the date, weather, light and moons", async ({ page, browser }) => {
  const gm = person("Orla");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Overlay ${gm.id}`);
  const link = await makeLink(page, cid, { scope: "public_panel", overlay: true });
  const ctx = await newContext(browser);
  const obs = await ctx.newPage();
  await obs.goto(`panel.html#k=${link.code}&overlay=1`);
  await expect(obs.locator(".tv-date")).toBeVisible();
  await expect(obs.locator("html")).toHaveClass(/panel-overlay/);
  expect(await obs.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(obs.locator(".tv-sec").first()).toBeHidden();
  await expect(obs.locator(".tv-gm")).toHaveCount(0);   // a public link is a player: no Pass time
});

test("the GM makes a panel link from At the Table and copies it once", async ({ page, browser }) => {
  const gm = person("Corin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Make ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/table`);
  const box = page.locator(".tv-links");
  await expect(box).toContainText("No panel links yet");
  await expect(box).toContainText("api/index.php?a=owlbear_manifest");
  await box.getByRole("button", { name: "New panel link…" }).click();
  const dlg = page.locator("dialog.kit-dialog");
  await dlg.getByLabel("Label").fill("Twitch");
  await dlg.getByLabel("Kind").selectOption("public_panel");
  await dlg.getByText("Overlay style").click();
  await dlg.getByRole("button", { name: "Make link" }).click();
  await expect(dlg.getByLabel("Panel link")).toHaveValue(/panel\.html#k=[0-9a-f]{64}&overlay=1$/);
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tv-links .tv-link")).toContainText("Twitch");
  await expect(page.locator(".tv-links .tv-link")).toContainText("Public, overlay");
  page.once("dialog", () => {});
  await page.locator(".tv-links .tv-link").getByRole("button", { name: "Revoke" }).click();
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator(".tv-links")).toContainText("No panel links yet");
});
