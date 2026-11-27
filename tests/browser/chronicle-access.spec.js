// GM's Almanac's approvals live in chronicle_access, not in users.status (an older column, and the other app's when the
// database was once shared with another app). An account with no access row asks again. See db/migrations/020_chronicle_access.sql.
const fs = require("fs"), path = require("path");
const { test, expect } = require("@playwright/test");
const { person, ADMIN, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "the server answers the same whatever the browser"));

/** An account with no access here yet (one a shared database brought, say), its old users.status approved. */
function withoutAccess(who) {
  sql(`INSERT INTO users (provider, provider_user_id, email, display_name, status, approved_at) VALUES ('google', '${who.id}', '${who.email}', '${who.name}', 'approved', NOW())`);
  return Number(sql(`SELECT id FROM users WHERE provider_user_id = '${who.id}'`).trim());
}
const access = id => sql(`SELECT status FROM chronicle_access WHERE user_id = ${id}`).trim();
const oldStatus = id => sql(`SELECT status FROM users WHERE id = ${id}`).trim();

test("an account with no access row asks for access on its first sign-in here, and waits", async ({ page, browser }) => {
  const who = person("Ines");
  const id = withoutAccess(who);
  const gm = person("Hale");
  const gp = await (await newContext(browser)).newPage();
  await signIn(gp, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(gp, `Shared ${gm.id}`);
  // Before they ask, Chronicle doesn't know them: a GM's add is only an invitation (the same answer as for anyone, so
  // it tells the GM nothing), and the admin doesn't list them.
  expect((await api(gp, "member_add", { email: who.email, role: "player" }, cid)).json).toMatchObject({ ok: true, invited: true });
  const ap = await (await newContext(browser)).newPage();
  await signIn(ap, ADMIN);
  expect((await api(ap, "users")).json.users.map(u => u.email)).not.toContain(who.email);

  await signIn(page, who);
  expect((await (await page.request.get("api/auth/me.php")).json()).status).toBe("pending");
  expect((await api(page, "campaigns")).json.error).toBe("not_approved");
  expect(access(id)).toBe("pending");
  expect(oldStatus(id)).toBe("approved");                  // the old column is left alone
  expect((await api(ap, "users")).json.users.find(u => u.email === who.email).status).toBe("pending");

  await approve(browser, who.email);
  // once approved, the invitation is taken up as their campaign list opens
  expect((await api(page, "campaigns")).json.campaigns.map(c => c.id)).toContain(cid);
});

test("approving or revoking here leaves the old users.status column alone", async ({ page, browser }) => {
  const who = person("Juno");
  await signIn(page, who);
  const id = Number((await (await page.request.get("api/auth/me.php")).json()).id);
  expect(oldStatus(id)).toBe("pending");
  await approve(browser, who.email);
  expect(access(id)).toBe("approved");
  expect(oldStatus(id)).toBe("pending");
  await approve(browser, who.email, "revoked");
  expect(access(id)).toBe("revoked");
  expect((await api(page, "campaigns")).json.error).toBe("not_approved");
  // and a change to the old column doesn't reach GM's Almanac either
  sql(`UPDATE users SET status = 'approved' WHERE id = ${id}`);
  expect((await api(page, "campaigns")).json.error).toBe("not_approved");
});

test("removing someone from Chronicle keeps their shared account, and they can ask again", async ({ page, browser }) => {
  const who = person("Kai"), gm = person("Lux");
  await signIn(page, who);
  await approve(browser, who.email);
  const id = Number((await (await page.request.get("api/auth/me.php")).json()).id);
  const gp = await (await newContext(browser)).newPage();
  await signIn(gp, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(gp, `Leaving ${gm.id}`);
  await api(gp, "member_add", { email: who.email, role: "player" }, cid);

  const ap = await (await newContext(browser)).newPage();
  await signIn(ap, ADMIN);
  expect((await api(ap, "user_delete", { id })).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM users WHERE id = ${id}`).trim()).toBe("1");
  expect(sql(`SELECT COUNT(*) FROM campaign_members WHERE user_id = ${id}`).trim()).toBe("0");
  expect((await api(ap, "users")).json.users.map(u => u.email)).not.toContain(who.email);
  expect((await api(page, "campaigns")).json.error).toBe("not_approved");

  await signIn(page, who);
  expect(access(id)).toBe("pending");
});

test("migration 020 carries everyone's access over as it was", () => {
  const db = `chronicle_mig_${process.pid}_${Date.now()}`;
  const users = fs.readFileSync(path.join(__dirname, "..", "..", "db", "schema.sql"), "utf8").match(/CREATE TABLE IF NOT EXISTS users \([\s\S]*?\);/)[0];
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "db", "migrations", "020_chronicle_access.sql"), "utf8");
  try {
    const out = sql(`CREATE DATABASE ${db}; USE ${db}; ${users}
      INSERT INTO users (provider, provider_user_id, email, status) VALUES ('google', 'a', 'a@x.test', 'approved'), ('github', 'b', 'b@x.test', 'pending'), ('google', 'c', 'c@x.test', 'revoked');
      ${migration}
      SELECT CONCAT(u.provider_user_id, '=', a.status) FROM users u JOIN chronicle_access a ON a.user_id = u.id ORDER BY u.provider_user_id;`);
    expect(out.trim().split("\n")).toEqual(["a=approved", "b=pending", "c=revoked"]);
  } finally {
    sql(`DROP DATABASE IF EXISTS ${db}`);
  }
});

test("an admin is one the config names: the flag alone, as from another app or an old listing, gives nothing here", async ({ page, browser }) => {
  // an account whose users.is_admin is set (an admin in another app that shared the database, or listed here once) but which
  // admin_identities doesn't name
  const who = person("Flagged");
  await signIn(page, who);
  await approve(browser, who.email);
  const id = (await (await page.request.get("api/auth/me.php")).json()).id;
  sql(`UPDATE users SET is_admin = 1 WHERE id = ${id}`);
  expect((await (await page.request.get("api/auth/me.php")).json()).is_admin).toBe(false);
  expect((await api(page, "users")).status).toBe(403);
  // nor are they a GM of other people's campaigns
  const gp = await (await newContext(browser)).newPage();
  const gm = person("Owner");
  await signIn(gp, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(gp, `Not theirs ${gm.id}`);
  expect((await api(page, "campaign", undefined, cid)).status).toBe(403);
  // the real admin sees them as an ordinary account, and can revoke them
  const ap = await (await newContext(browser)).newPage();
  await signIn(ap, ADMIN);
  const row = (await api(ap, "users")).json.users.find(u => Number(u.id) === Number(id));
  expect(Number(row.is_admin)).toBe(0);
  expect((await api(ap, "user_status", { id, status: "revoked" })).status).toBe(200);
  expect(access(id)).toBe("revoked");
});
