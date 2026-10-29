// Every API action, held to who may use it: signed out and waiting-for-approval accounts get nothing, someone outside a
// campaign can't touch it, a player can't use the GMs' actions, and only site admins manage accounts. The list of
// actions is read from api/index.php and api/fanwikis.php, so a new action fails here until it is put in one of the
// groups below, which is the moment to decide who may use it.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { person, signIn, approve, makeCampaign, api } = require("./helpers");

const root = path.join(__dirname, "..", "..");
const index = fs.readFileSync(path.join(root, "api", "index.php"), "utf8");
const dispatch = index.slice(index.indexOf("switch ($action) {"));
const fanwikis = fs.readFileSync(path.join(root, "api", "fanwikis.php"), "utf8");
const ACTIONS = [
  ...[...dispatch.matchAll(/^    case '(\w+)'/gm)].map(m => m[1]),
  ...fanwikis.match(/const FANWIKI_ACTIONS = \[([^\]]*)\]/)[1].match(/\w+/g),
];

/** Open to anyone, signed in or not. */
const PUBLIC = ["fanwiki_wikis"];
/** Need an approved account, and no campaign. */
const ACCOUNT = ["prefs_save", "campaigns", "campaign_create", "fanwiki_thumb"];
/** Site admins only. */
const ADMIN_ONLY = ["users", "user_status", "user_email", "user_delete"];
/** A campaign's GMs only, refused to its players before anything else is looked at. */
const GM_ONLY = ["campaign_update", "campaign_delete", "campaign_copy", "set_time", "member_candidates", "member_add", "member_remove",
  "region_save", "region_delete", "holiday_save", "holiday_delete", "days_save", "day_update", "shift_save", "shifts_fill",
  "downtime_delete", "secret_reveal", "relation_type_save", "relation_type_delete", "session_save", "session_summary_save",
  "session_end", "session_delete", "snote_add", "snote_bulk", "snote_save", "snote_move", "snote_delete",
  "scabard_import", "scabard_picture"];
/** Everything else works on one campaign and needs its members: players and GMs, each action checking the rest. */
const MEMBER = ACTIONS.filter(a => ![...PUBLIC, ...ACCOUNT, ...ADMIN_ONLY, ...GM_ONLY].includes(a));
const CAMPAIGN = [...MEMBER, ...GM_ONLY];

/** Call $action as whoever $page is, with the method it takes: a read is a GET, a change a POST with the CSRF token. */
async function call(page, action, cid) {
  let r = await api(page, action, undefined, cid);
  if (r.status === 405) r = await api(page, action, {}, cid);
  return r;
}

test.describe("who may use each API action", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

  test("every action is in exactly one group", () => {
    const groups = [...PUBLIC, ...ACCOUNT, ...ADMIN_ONLY, ...GM_ONLY, ...MEMBER];
    expect(new Set(groups).size, "an action is listed twice").toBe(groups.length);
    for (const a of [...PUBLIC, ...ACCOUNT, ...ADMIN_ONLY, ...GM_ONLY]) expect(ACTIONS, `${a} is not an action any more`).toContain(a);
    expect(ACTIONS.length).toBeGreaterThan(80);
    // A new action lands in MEMBER by default; it must use one of the campaign's checks to pass the tests below.
  });

  test("signed out, every action but the public ones is refused", async ({ page }) => {
    for (const a of ACTIONS.filter(a => !PUBLIC.includes(a))) {
      for (const method of ["get", "post"]) {
        const r = await page.request[method](`api/index.php?a=${a}&cid=1`, method === "post" ? { data: {} } : undefined);
        expect(r.status(), `${method.toUpperCase()} ${a}`).toBe(401);
        expect((await r.json()).error, a).toBe("not_authenticated");
      }
    }
    expect((await page.request.get("api/index.php?a=fanwiki_wikis")).status()).toBe(200);
  });

  test("an account waiting for approval is refused everything but the public actions", async ({ page }) => {
    await signIn(page, person("Wren"));
    for (const a of ACTIONS.filter(a => !PUBLIC.includes(a))) {
      const r = await call(page, a, 1);
      expect(r.status, a).toBe(403);
      expect(r.json.error, a).toBe("not_approved");
    }
  });

  test("someone outside a campaign can't use any of its actions, and only admins manage accounts", async ({ page, browser }) => {
    const owner = person("Yara"), outsider = person("Zeke");
    await signIn(page, owner);
    await approve(browser, owner.email);
    const cid = await makeCampaign(page, `Fenced ${owner.id}`);

    const octx = await browser.newContext();
    const op = await octx.newPage();
    await signIn(op, outsider);
    await approve(browser, outsider.email);
    for (const a of CAMPAIGN) {
      const r = await call(op, a, cid);
      expect(r.status, `${a}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(r.json.message, a).toBe("You are not a member of this campaign");
    }
    for (const a of ADMIN_ONLY) {
      const r = await call(op, a);
      expect(r.status, a).toBe(403);
      expect(r.json.error, a).toBe("not_admin");
    }
    await octx.close();
  });

  test("a player can't use the GMs' actions", async ({ page, browser }) => {
    const gm = person("Abel"), player = person("Bree");
    await signIn(page, gm);
    await approve(browser, gm.email);
    const cid = await makeCampaign(page, `Table ${gm.id}`);
    const pctx = await browser.newContext();
    const pp = await pctx.newPage();
    await signIn(pp, player);
    await approve(browser, player.email);
    expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);

    for (const a of GM_ONLY) {
      const r = await call(pp, a, cid);
      expect(r.status, `${a}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(r.json.message, a).toBe("Only the GM can do that");
    }
    // and is still a member: a member action answers them
    expect((await call(pp, "campaign", cid)).status).toBe(200);
    await pctx.close();
  });
});
