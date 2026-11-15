// The panel as an Owlbear Rodeo extension (static/owlbear.js): Owlbear frames panel.html with ?obrref=… and the panel
// then loads Owlbear's SDK. A GM shares a Public panel link with the room, players' panels there open on it by
// themselves, a pass of time is announced over the map, and a right-click on a token looks its name up.
// Owlbear itself can't run here, so the SDK file is swapped for a stand-in that records what the panel asks of it.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const SHARED = "com.gmsalmanac.panel/shared", CHANNEL = "com.gmsalmanac.panel/refresh";

const FAKE_SDK = `window.OBR = (() => {
  const init = window.__obrInit || {};
  const st = window.__obr = { role: init.role || "PLAYER", md: init.md || {}, notes: [], sent: [], menus: [], mdCbs: [], msgCbs: {}, opened: 0 };
  return {
    onReady: cb => setTimeout(cb, 0),
    player: { getRole: async () => st.role, onChange() {} },
    room: {
      getMetadata: async () => st.md,
      setMetadata: async u => { for (const k in u) { if (u[k] === undefined) delete st.md[k]; else st.md[k] = u[k]; } st.mdCbs.forEach(f => f(st.md)); },
      onMetadataChange: f => st.mdCbs.push(f),
    },
    broadcast: { sendMessage: async (c, d, o) => { st.sent.push([c, o && o.destination]); }, onMessage: (c, f) => { st.msgCbs[c] = f; } },
    notification: { show: async t => { st.notes.push(t); return "1"; } },
    contextMenu: { create: async m => { st.menus.push(m); } },
    action: { open: async () => { st.opened++; } },
  };
})();`;
/** A page that stands in for Owlbear's frame: the SDK is the stand-in, with this role and room metadata. */
async function owlbearPage(ctx, init) {
  const p = await ctx.newPage();
  await p.addInitScript(i => { window.__obrInit = i; }, init);
  await p.route("**/static/vendor/owlbear/owlbear-sdk.js", r => r.fulfill({ contentType: "text/javascript", body: FAKE_SDK }));
  return p;
}
const link = async (page, cid, data) => (await api(page, "panel_link_create", { label: "Test", ...data }, cid)).json.link.code;

test("in Owlbear a GM shares a Public link with the room, hears time pass, and looks a token up", async ({ page, browser }) => {
  const gm = person("OwlGM");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Owlbear ${gm.id}`);
  expect((await api(page, "entry_save", { name: "Burnt Ford", notes: "<p>A crossing with a toll.</p>" }, cid)).status).toBe(200);
  const mine = await link(page, cid), pub = await link(page, cid, { scope: "public_panel" });

  const ctx = await newContext(browser);
  const p = await owlbearPage(ctx, { role: "GM" });
  const errors = watchErrors(p);
  await p.goto(`panel.html?obrref=test#k=${mine}`);
  const foot = p.locator(".panel-foot");
  await expect(foot).toContainText("via panel link");

  // a personal link is never put in the room; a Public one is
  await foot.getByRole("button", { name: "Share with this room…" }).click();
  await p.getByRole("dialog").getByRole("textbox").fill(`http://x/panel.html#k=${mine}`);
  await p.getByRole("dialog").getByRole("button", { name: "Share" }).click();
  await expect(p.locator("#toast")).toContainText("personal link");
  expect(await p.evaluate(() => Object.keys(window.__obr.md))).toEqual([]);
  await foot.getByRole("button", { name: "Share with this room…" }).click();
  await p.getByRole("dialog").getByRole("textbox").fill(`http://x/panel.html#k=${pub}`);
  await p.getByRole("dialog").getByRole("button", { name: "Share" }).click();
  await expect(p.locator(".panel-foot").getByRole("button", { name: "Stop sharing with this room" })).toBeVisible();
  const shared = await p.evaluate(k => window.__obr.md[k], SHARED);
  expect(shared.code).toBe(pub);
  expect(shared.site).toMatch(/\/panel\.html$/);

  // a right-click on a token: the action opens and the name is looked up
  const menu = await p.evaluate(() => window.__obr.menus.map(m => ({ id: m.id, label: m.icons[0].label, icon: m.icons[0].icon })));
  expect(menu).toEqual([{ id: "com.gmsalmanac.panel/lookup", label: "Look up in the Almanac", icon: expect.stringMatching(/^http.+\/static\/icons\/owlbear\.svg\?v=2$/) }]);
  await p.evaluate(() => window.__obr.menus[0].onClick({ items: [{ name: "burnt ford", text: { plainText: "" } }] }));
  await expect(p.locator(".tv-lookup")).toContainText("A crossing with a toll.");
  expect(await p.evaluate(() => window.__obr.opened)).toBe(1);

  // time passes in the Almanac: another panel's broadcast makes this one look now, and it says the new date
  const now = (await api(page, "campaign", undefined, cid)).json.campaign.current_shift;
  expect((await api(page, "set_time", { current_shift: now + 1 }, cid)).status).toBe(200);
  await p.evaluate(c => window.__obr.msgCbs[c]({ data: {} }), CHANNEL);
  await expect.poll(() => p.evaluate(() => window.__obr.notes)).toEqual([expect.stringMatching(/^It is now .+\.$/)]);
  expect(await p.evaluate(() => window.__obr.sent)).toEqual([[CHANNEL, "REMOTE"]]);

  await p.locator(".panel-foot").getByRole("button", { name: "Stop sharing with this room" }).click();
  await expect(p.locator(".panel-foot").getByRole("button", { name: "Share with this room…" })).toBeVisible();
  expect(await p.evaluate(() => Object.keys(window.__obr.md))).toEqual([]);
  await expectNoErrors(errors);
});

test("a player's panel in Owlbear opens on the room's Public link, and only on a Public one", async ({ page, browser, baseURL }) => {
  const gm = person("OwlGM2");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Owlbear room ${gm.id}`);
  expect((await api(page, "event_save", { abs_day: 0, title: "Secret meeting", is_secret: true }, cid)).status).toBe(200);
  const mine = await link(page, cid), pub = await link(page, cid, { scope: "public_panel" });
  const site = new URL("panel.html", baseURL).href;

  const ctx = await newContext(browser);
  const p = await owlbearPage(ctx, { role: "PLAYER", md: { [SHARED]: { site, code: pub } } });
  const errors = watchErrors(p);
  await p.goto("panel.html?obrref=test");
  await expect(p.locator(".panel-foot")).toContainText("Public panel · shared with this room by the GM");
  await expect(p.locator(".table-view")).toContainText(`Owlbear room ${gm.id}`);
  await expect(p.locator("body")).not.toContainText("Secret meeting");
  await expect(p.locator(".panel-foot").getByRole("button", { name: /Share with this room|Stop sharing/ })).toHaveCount(0);

  // their own link instead, and back to the room's
  await p.locator(".panel-foot").getByRole("button", { name: "Use my own link" }).click();
  await expect(p.locator(".panel-ask")).toContainText("Paste your panel link");
  await p.locator(".panel-ask").getByRole("button", { name: "Use the room's panel" }).click();
  await expect(p.locator(".panel-foot")).toContainText("shared with this room");

  // the GM stops sharing: the panel goes back to asking
  await p.evaluate(k => { delete window.__obr.md[k]; window.__obr.mdCbs.forEach(f => f(window.__obr.md)); }, SHARED);
  await expect(p.locator(".panel-ask")).toContainText("Your GM can share the campaign with this Owlbear Rodeo room");
  // and shares again: it opens by itself
  await p.evaluate(([k, v]) => { window.__obr.md[k] = v; window.__obr.mdCbs.forEach(f => f(window.__obr.md)); }, [SHARED, { site, code: pub }]);
  await expect(p.locator(".panel-foot")).toContainText("shared with this room");
  await expectNoErrors(errors);

  // a personal link someone put in the room, or another site's link, is not taken
  for (const md of [{ [SHARED]: { site, code: mine } }, { [SHARED]: { site: "https://elsewhere.example/panel.html", code: pub } }]) {
    const c2 = await newContext(browser);
    const p2 = await owlbearPage(c2, { role: "PLAYER", md });
    await p2.goto("panel.html?obrref=test");
    await expect(p2.locator(".panel-ask")).toContainText("Paste your panel link");
    await expect(p2.locator(".table-view")).toHaveCount(0);
  }
});

test("outside Owlbear the panel never fetches the Owlbear SDK", async ({ page, browser }) => {
  const gm = person("OwlGM3");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `No owl ${gm.id}`);
  const code = await link(page, cid);
  const ctx = await newContext(browser);
  const p = await ctx.newPage();
  const asked = [];
  p.on("request", r => { if (r.url().includes("vendor/owlbear")) asked.push(r.url()); });
  await p.goto(`panel.html#k=${code}`);
  await expect(p.locator(".panel-foot")).toContainText("via panel link");
  await expect(p.locator(".panel-foot").getByRole("button", { name: "Share with this room…" })).toHaveCount(0);
  expect(asked).toEqual([]);
});
