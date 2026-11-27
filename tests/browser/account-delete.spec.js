// Site Admin's Delete account: an account deleted for good, as the privacy policy promises on request. The account row
// and everything keyed to it go, what they wrote in other campaigns stays without their name, and the campaigns they
// were the only GM of go with them (named first).
const { test, expect } = require("@playwright/test");
const { person, ADMIN, signIn, api, approve, makeCampaign, sql, newContext, closeContexts, watchErrors, expectNoErrors, moreIn } = require("./helpers");
test.afterEach(closeContexts);

const count = q => sql(`SELECT COUNT(*) FROM ${q}`).trim();

/** A person who runs a campaign alone, plays in someone else's (and wrote an entry there), and sent a problem report. */
async function setUp(page, browser, who, gm) {
  await signIn(page, who);
  await approve(browser, who.email);
  const id = Number((await (await page.request.get("api/auth/me.php")).json()).id);
  const own = await makeCampaign(page, `Alone ${who.id}`);
  expect((await api(page, "report_send", { message: `Something looked wrong ${who.id}` })).status).toBe(200);
  const gp = await (await newContext(browser)).newPage();
  await signIn(gp, gm);
  await approve(browser, gm.email);
  const shared = await makeCampaign(gp, `Shared ${gm.id}`);
  await api(gp, "member_add", { email: who.email, role: "player" }, shared);
  expect((await api(page, "campaigns")).json.campaigns.map(c => Number(c.id))).toContain(shared);
  expect((await api(page, "entry_save", { name: `Note by ${who.id}`, notes: "<p>Mine.</p>" }, shared)).status).toBe(200);
  return { id, own, shared };
}

test("deleting an account removes it and the campaigns it ran alone, and keeps what it wrote elsewhere", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "chromium", "the server answers the same whatever the browser");
  const who = person("Wren"), gm = person("Orla");
  const { id, own, shared } = await setUp(page, browser, who, gm);

  const ap = await (await newContext(browser)).newPage();
  await signIn(ap, ADMIN);
  const check = await (await ap.request.get(`api/index.php?a=user_erase_check&id=${id}`)).json();
  expect(check.campaigns).toEqual([{ id: own, name: `Alone ${who.id}` }]);
  // only with the confirmation, never oneself, and only a site admin
  expect((await api(ap, "user_erase", { id })).status).toBe(400);
  const me = Number((await (await ap.request.get("api/auth/me.php")).json()).id);
  expect((await api(ap, "user_erase", { id: me, confirm: "DELETE" })).status).toBe(400);
  expect((await api(page, "user_erase", { id: me, confirm: "DELETE" })).status).toBe(403);

  const r = await api(ap, "user_erase", { id, confirm: "DELETE" });
  expect(r.status).toBe(200);
  expect(r.json.campaigns).toBe(1);
  expect(count(`users WHERE id = ${id}`)).toBe("0");
  expect(count(`chronicle_access WHERE user_id = ${id}`)).toBe("0");
  expect(count(`campaign_members WHERE user_id = ${id}`)).toBe("0");
  expect(count(`site_reports WHERE message = 'Something looked wrong ${who.id}'`)).toBe("0");
  expect(count(`campaign_invites WHERE email = '${who.email.toLowerCase()}'`)).toBe("0");
  expect(count(`campaigns WHERE id = ${own}`)).toBe("0");
  expect(count(`campaigns WHERE id = ${shared}`)).toBe("1");
  expect(sql(`SELECT COALESCE(created_by, 'none') FROM encyclopedia_entries WHERE campaign_id = ${shared} AND name = 'Note by ${who.id}'`).trim()).toBe("none");
  // signed out with it: their session no longer finds an account, and signing in again is a new one, waiting
  expect((await api(page, "campaigns")).status).toBe(401);
});

test("Site Admin names the campaigns that go with the account, and deletes it once DELETE is typed", async ({ page, browser }, info) => {
  test.skip(!["chromium", "ipad"].includes(info.project.name), "a desk and an iPad");
  const who = person("Tamsin"), gm = person("Ives");
  const { id, own } = await setUp(page, browser, who, gm);

  const ap = await (await newContext(browser)).newPage();
  const errors = watchErrors(ap);
  await signIn(ap, ADMIN);
  await ap.goto("index.html#/admin/users");
  const row = ap.locator("tr").filter({ hasText: who.email });
  await moreIn(row, "Delete account");
  const d = ap.locator("dialog.kit-dialog");
  await expect(d).toContainText(`Alone ${who.id}`);
  await expect(d).toContainText("can't be undone");
  // anything but DELETE leaves it be
  await d.getByRole("textbox").fill("delete it");
  await d.getByRole("button", { name: "Delete" }).click();
  await expect(ap.getByText("Not deleted: type DELETE to confirm")).toBeVisible();
  expect(count(`users WHERE id = ${id}`)).toBe("1");

  await moreIn(row, "Delete account");
  await d.getByRole("textbox").fill("DELETE");
  await d.getByRole("button", { name: "Delete" }).click();
  await expect(ap.getByText(`Deleted ${who.name}'s account and 1 campaign`)).toBeVisible();
  await expect(ap.locator("tr").filter({ hasText: who.email })).toHaveCount(0);
  expect(count(`users WHERE id = ${id}`)).toBe("0");
  expect(count(`campaigns WHERE id = ${own}`)).toBe("0");
  expectNoErrors(errors);
});
