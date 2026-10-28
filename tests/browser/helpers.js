// Shared setup for the cross-browser specs (same shape as Sinless's helpers.js).
const { execFileSync } = require("child_process");
const { expect } = require("@playwright/test");

/* Collect everything that would show up red in a devtools console. Attach
 * before navigating; assert with expectNoErrors() at the end of the test. */
function watchErrors(page) {
  const errors = [];
  // WebKit logs "Fetch API cannot load <url> due to access control checks." for a same-origin request that a reload or
  // navigation cancels mid-flight, and Playwright reports that log line as a page error. It is not a script error (the
  // app's own catch still runs), so it is dropped for this site's API; anything cross-origin or elsewhere still counts.
  const cancelledFetch = /\/127\.0\.0\.1:\d+\/api\/\S+ due to access control checks\.$/;
  page.on("pageerror", e => { if (!cancelledFetch.test(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", m => {
    // A 401 from the sign-in probe is how a signed-out page learns it is signed out.
    if (m.type() === "error" && !/status of 40[13]/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}
function expectNoErrors(errors) {
  expect(errors, "page errors / console errors").toEqual([]);
}

let seq = 0;
/** A fresh identity per call, so parallel tests never share an account. */
function person(name, extra = {}) {
  const id = `${Date.now()}${process.pid}${++seq}`;
  return { provider: "google", id, email: `${name.toLowerCase()}-${id}@example.test`, name, ...extra };
}
/** The admin listed in support/config.test.php's admin_identities. */
const ADMIN = { provider: "google", id: "admin-1", email: "gm@example.test", name: "Gail the GM" };

/** Sign this page's browser context in as `who`, through the same code path as
 * the OAuth callback (tests/support/login.php). Returns the CSRF token. */
async function signIn(page, who) {
  const res = await page.request.post("tests/support/login.php", { data: who });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).csrf;
}
/** Call the campaign API as whoever this page is signed in as. */
async function api(page, action, body, cid) {
  const me = await (await page.request.get("api/auth/me.php")).json();
  const qs = new URLSearchParams({ a: action, ...(cid ? { cid } : {}) });
  const res = body === undefined
    ? await page.request.get(`api/index.php?${qs}`)
    : await page.request.post(`api/index.php?${qs}`, { data: body, headers: { "X-CSRF-Token": me.csrf } });
  return { status: res.status(), json: await res.json() };
}
/** Approve a user by email, as the admin, from a separate context. */
async function approve(browser, email, status = "approved") {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, ADMIN);
  const { json } = await api(page, "users");
  const u = json.users.find(x => x.email === email);
  // Every spec approves through the one admin account, so a full run goes past the admin's
  // 60 changes a minute (and its writes a minute). Start those counts afresh; signin.spec checks the real limits.
  sql("DELETE FROM rate_limits WHERE bucket IN ('admin', 'write')");
  const r = await api(page, "user_status", { id: u.id, status });
  expect(r.status).toBe(200);
  await ctx.close();
}
/** Run SQL against the test database (for setting up migrated accounts). */
function sql(query) {
  const args = ["-h", process.env.DB_HOST || "127.0.0.1", "-P", process.env.DB_PORT || "3306", "-u", process.env.DB_USER || "root", "-N"];
  if (process.env.DB_PASSWORD) args.push(`-p${process.env.DB_PASSWORD}`);
  return execFileSync("mysql", [...args, process.env.DB_NAME || "chronicle_test"], { input: query }).toString();
}
/** Create a small campaign through the API and return its id. */
async function makeCampaign(page, name = "Test campaign") {
  const r = await api(page, "campaign_create", {
    name, description: "", current_shift: 8,
    calendar: { months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1 },
    settings: {}, regions: [{ name: "Home", settings: { climate: "temperate" }, current: true }], holidays: [],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.id;
}

/** Close the Proper Noun Detector's dialog, which a save that names something new opens, without adding anything. */
async function notNow(page) {
  const d = page.locator("dialog.noun-dialog");
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "Not now" }).click();
  await expect(d).toHaveCount(0);
}

module.exports = { notNow, watchErrors, expectNoErrors, person, ADMIN, signIn, api, approve, sql, makeCampaign };
