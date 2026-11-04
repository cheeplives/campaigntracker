// Every API action, held to who may use it: signed out and waiting-for-approval accounts get nothing, someone outside a
// campaign can't touch it, a player can't use the GMs' actions, and only site admins manage accounts. The actions and
// who may use each are read from api/actions.php, the table the router itself runs on, and every action the code
// answers must be in it.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { person, signIn, approve, makeCampaign, api, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const root = path.join(__dirname, "..", "..");
const read = f => fs.readFileSync(path.join(root, "api", f), "utf8");
/** api/actions.php, one row per action: { name: { who, get, touch, panel, key } }. */
const TABLE = Object.fromEntries([...read("actions.php").matchAll(/^    '(\w+)' => \[(.*)\],$/gm)].map(([, name, row]) =>
  [name, Object.fromEntries([...row.matchAll(/'(\w+)' => ('(\w+)'|true)/g)].map(m => [m[1], m[3] ?? true]))]));
const ACTIONS = Object.keys(TABLE);
const who = w => ACTIONS.filter(a => TABLE[a].who === w);
/** Open to anyone, signed in or not. */
const PUBLIC = who("public");
/** Need an approved account, and no campaign. */
const ACCOUNT = who("account");
/** Site admins only. */
const ADMIN_ONLY = who("admin");
/** A campaign's GMs only, refused to its players before anything else is looked at. */
const GM_ONLY = who("gm");
/** Everything else works on one campaign and needs its members: players and GMs, each action checking the rest. */
const MEMBER = who("member");
const CAMPAIGN = [...MEMBER, ...GM_ONLY];

/** Call $action as whoever $page is, with the method it takes: a read is a GET, a change a POST with the CSRF token. */
async function call(page, action, cid) {
  let r = await api(page, action, undefined, cid);
  if (r.status === 405) r = await api(page, action, {}, cid);
  return r;
}

test.describe("who may use each API action", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

  test("the table lists every action the code answers, and nothing else", () => {
    const index = read("index.php"), dispatch = index.slice(index.indexOf("switch ($action) {"));
    const answered = [...new Set([...dispatch.matchAll(/^    case '(\w+)'/gm)].map(m => m[1])),
      ...read("fanwikis.php").match(/const FANWIKI_ACTIONS = \[([^\]]*)\]/)[1].match(/\w+/g)];
    expect([...answered].sort()).toEqual([...ACTIONS].sort());
    for (const a of ACTIONS) expect(["public", "account", "admin", "gm", "member"], a).toContain(TABLE[a].who);
    expect(PUBLIC.sort()).toEqual(["fanwiki_wikis", "owlbear_manifest", "starter_sources"]);   // a new public action is a choice
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

    const octx = await newContext(browser);
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
    const pctx = await newContext(browser);
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
