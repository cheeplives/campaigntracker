// Sign-in works like Sinless's: Google/GitHub buttons, new accounts wait for an
// admin, approval lets them in, revoking locks them out, and accounts from the
// username/password days are taken over by matching email.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, ADMIN, signIn, api, approve, sql } = require("./helpers");

test("signed out: shows the sign-in card with both providers", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("index.html#/c/1/calendar");
  await expect(page.getByRole("heading", { name: "Campaign Chronicle" })).toBeVisible();
  const google = page.getByRole("link", { name: "Sign in with Google" });
  await expect(google).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  // The return path keeps where they were going, hash included.
  const href = await google.getAttribute("href");
  expect(decodeURIComponent(href)).toContain("return=/index.html#/c/1/calendar");
  expectNoErrors(errors);
});

test("the campaign API refuses anyone not signed in", async ({ page }) => {
  const r = await page.request.get("api/index.php?a=campaigns");
  expect(r.status()).toBe(401);
  expect((await r.json()).error).toBe("not_authenticated");
});

test("a new account waits for approval, then gets in", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const who = person("Pat");
  await signIn(page, who);
  await page.goto("index.html");
  await expect(page.getByRole("heading", { name: "Awaiting approval" })).toBeVisible();
  await expect(page.getByText(`Signed in as ${who.email}`)).toBeVisible();
  expect((await api(page, "campaigns")).json.error).toBe("not_approved");

  await approve(browser, who.email);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your campaigns" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pat" })).toBeVisible();
  expectNoErrors(errors);
});

test("a revoked account is locked out", async ({ page, browser }) => {
  const who = person("Rex");
  await signIn(page, who);
  await approve(browser, who.email);
  await approve(browser, who.email, "revoked");
  await page.goto("index.html");
  await expect(page.getByRole("heading", { name: "Access removed" })).toBeVisible();
  expect((await api(page, "campaigns")).status).toBe(403);
});

test("the admin identity is approved and made admin on first sign-in", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, ADMIN);
  await page.goto("index.html#/admin");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
  expectNoErrors(errors);
});

test("an account from before OAuth is taken over by its linked email", async ({ page }) => {
  const who = person("Lena");
  sql(`INSERT INTO users (provider, provider_user_id, email, display_name, status) VALUES ('legacy', 'legacy-${who.id}', '', 'Old Lena', 'approved');
       INSERT INTO campaigns (name, calendar_json, settings_json) VALUES ('Lena''s old campaign ${who.id}', '{"months":[{"name":"M","days":30}],"weekdays":["A"]}', '{}');
       INSERT INTO campaign_members (campaign_id, user_id, role) SELECT c.id, u.id, 'player' FROM campaigns c, users u WHERE c.name = 'Lena''s old campaign ${who.id}' AND u.provider_user_id = 'legacy-${who.id}';`);

  // The admin links the email from the Users screen, through the in-page dialog.
  const adminCtx = await page.context().browser().newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, ADMIN);
  await admin.goto("index.html#/admin");
  const row = admin.getByRole("row").filter({ hasText: "Old Lena" });
  await row.getByRole("button", { name: "Link email" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByRole("textbox").fill(who.email);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText(who.email);
  await adminCtx.close();

  await signIn(page, who);
  await page.goto("index.html");
  await expect(page.getByRole("link", { name: /Lena's old campaign/ })).toBeVisible();
  expect(sql(`SELECT provider FROM users WHERE provider_user_id = '${who.id}'`).trim()).toBe("google");
});

test("sign-in starts are rate-limited per IP in the database", async ({ page }) => {
  sql("DELETE FROM rate_limits WHERE bucket = 'login'");
  let last = 0;
  for (let i = 0; i < 21; i++) {
    last = (await page.request.get("api/auth/login.php?provider=google", { maxRedirects: 0 })).status();
  }
  expect(last).toBe(429);
  sql("DELETE FROM rate_limits WHERE bucket = 'login'");
});
