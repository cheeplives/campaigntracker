// Checks from the security review: a GM can't reach into another campaign's events through an event id, a
// player's edit doesn't undo the GM's secret flag, and a player who may not see future weather isn't sent the
// seed that rolls it.
const { test, expect } = require("@playwright/test");
const { person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("a GM can't change the tags of an event in someone else's campaign", async ({ page, browser }) => {
  const owner = person("Nell"), other = person("Olaf");
  await signIn(page, owner);
  await approve(browser, owner.email);
  const cid = await makeCampaign(page, `Tags ${owner.id}`);
  const eid = (await api(page, "event_save", { abs_day: 3, title: "Market day", tags: [{ name: "Fair" }] }, cid)).json.id;

  const octx = await newContext(browser);
  const op = await octx.newPage();
  await signIn(op, other);
  await approve(browser, other.email);
  const mine = await makeCampaign(op, `Mine ${other.id}`);
  const r = await api(op, "event_save", { id: eid, abs_day: 3, title: "Market day", tags: [{ name: "Pwned", color: "#000000" }] }, mine);
  expect(r.status).toBe(404);
  await octx.close();

  const ev = (await api(page, "events", undefined, cid)).json.events.find(e => e.id === eid);
  expect(ev.tags.map(t => t.name)).toEqual(["Fair"]);
});

test("a player's edit keeps the secret flag the GM set on their event", async ({ page, browser }) => {
  const gm = person("Pia"), player = person("Quin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Secret ${gm.id}`);
  await api(page, "campaign_update", { settings: { players_can_add_events: true } }, cid);

  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const eid = (await api(pp, "event_save", { abs_day: 4, title: "Our plan" }, cid)).json.id;

  await api(page, "event_save", { id: eid, abs_day: 4, title: "Our plan", is_secret: true }, cid);
  expect((await api(pp, "event_save", { id: eid, abs_day: 4, title: "Our plan, revised" }, cid)).status).toBe(200);
  expect(sql(`SELECT is_secret FROM events WHERE id = ${eid}`).trim()).toBe("1");
  await pctx.close();
});

test("only those who may see future weather are sent the weather seed", async ({ page, browser }) => {
  const gm = person("Rex"), player = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Seed ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  await api(page, "member_add", { email: player.email, role: "player" }, cid);

  expect(typeof (await api(page, "campaign", undefined, cid)).json.campaign.seed).toBe("number");
  expect((await api(pp, "campaign", undefined, cid)).json.campaign.seed).toBeUndefined();
  await api(page, "campaign_update", { settings: { players_see_future_weather: true } }, cid);
  expect(typeof (await api(pp, "campaign", undefined, cid)).json.campaign.seed).toBe("number");
  await pctx.close();
});

test("the pages' Content-Security-Policy comes from the header alone, the one .htaccess sends", async ({ request }) => {
  // A CSP <meta> tag turns off Chrome's preload scanner, so the 40-odd scripts would load one after another (about
  // 5 s on the live site instead of under 1). The pages carry none; the header is their policy, and the test server
  // sends the same header .htaccess does (tests/support/router.php), so the suite still runs under the live policy.
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, "..", "..");
  const policies = [...fs.readFileSync(path.join(root, ".htaccess"), "utf8").matchAll(/Header always set Content-Security-Policy "([^"]+)"/g)].map(m => m[1]);
  expect(policies).toHaveLength(2);   // the site's, then panel.html's
  for (const [page, csp] of [["index.html", policies[0]], ["panel.html", policies[1]], ["", policies[0]]]) {
    if (page) expect(fs.readFileSync(path.join(root, page), "utf8"), page).not.toMatch(/http-equiv=["']?Content-Security-Policy/i);
    const res = await request.get(page);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-security-policy"], page || "the site's root").toBe(csp);
  }
});

test("the page's CSP keeps the inline style attributes el() writes", async ({ page }) => {
  // style-src stays 'self' 'unsafe-inline': a split into style-src-elem 'self' and style-src-attr made WebKit refuse
  // stylesheets on ordinary pages, which a real iPad would show as broken styling
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("index.html#/about");
  const bg = await page.evaluate(() => {
    const p = document.createElement("span");
    p.setAttribute("style", "background-color: rgb(4, 5, 6)");
    document.body.append(p);
    return getComputedStyle(p).backgroundColor;
  });
  expect(bg).toBe("rgb(4, 5, 6)");
  expect(errors.filter(e => /Content Security Policy/.test(e))).toEqual([]);
});
