// Request a game: anyone signed in asks for a starter sheet from the Sheet templates page, the requests reach Site
// Admin's Sheets tab grouped by game with how many asked, and the site admin can turn the button off for everyone.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, ADMIN, signIn, approve, api, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

// The on/off switch is one setting for the whole site, so this runs in one browser at a time: another browser's run
// turning requests off would break this one.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "one site-wide switch; the server answers the same whatever the browser"));

test("requests from Sheet templates reach Site Admin's Sheets tab, counted by game, and the switch turns them off", async ({ page, browser }) => {
  const errors = watchErrors(page);
  sql("DELETE FROM site_settings WHERE name='game_requests_off'");
  const game = `Skyward Barrow ${Date.now()}`;
  const a = person("Ada"), b = person("Bram");
  await signIn(page, a);
  await approve(browser, a.email);

  // Ada asks from the library: what she searched for is offered as the name.
  await page.goto("index.html#/templates");
  await page.getByLabel("Search templates").fill(game);
  await page.getByRole("button", { name: "Request a game" }).click();
  const box = page.getByRole("dialog").getByRole("textbox");
  await expect(box).toHaveValue(game);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Request sent. Thanks!")).toBeVisible();
  // asking again doesn't count twice
  expect((await api(page, "game_request", { game: `  ${game.toUpperCase()} ` })).json).toMatchObject({ ok: true, already: true });
  expect((await api(page, "game_request", { game: " " })).status).toBe(400);

  // Bram asks for the same game spelt another way; it counts with Ada's.
  const bp = await (await newContext(browser)).newPage();
  await signIn(bp, b);
  await approve(browser, b.email);
  expect((await api(bp, "game_request", { game: game.toLowerCase().replace(" ", "   ") })).json).toMatchObject({ ok: true, already: false });
  // only a site admin reads them
  expect((await api(bp, "game_requests")).status).toBe(403);

  const ap = await (await newContext(browser)).newPage();
  const adminErrors = watchErrors(ap);
  await signIn(ap, ADMIN);
  await ap.goto("index.html#/admin");
  await expect(ap.locator(".admin-tabs a.on")).toHaveText("Users");
  await expect(ap.getByRole("heading", { name: "Users" })).toBeVisible();
  await ap.locator(".admin-tabs").getByRole("link", { name: "Sheets" }).click();
  await expect(ap).toHaveURL(/#\/admin\/sheets$/);
  await expect(ap.getByRole("button", { name: "Load starter templates" })).toBeVisible();
  const row = ap.locator(".game-requests tr").filter({ hasText: game });
  await expect(row.locator("td").first()).toHaveText(game);    // the spelling most people used, Ada's first
  await expect(row.locator("td.num")).toHaveText("2");
  await expect(row).toContainText("Ada");
  await expect(row).toContainText("Bram");

  // Off: the button goes from the library and the server refuses new requests.
  const sw = ap.getByLabel("Let people request games");
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect(ap.getByText("Request a game is off")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sheet templates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New template" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request a game" })).toBeHidden();
  const refused = await api(page, "game_request", { game: "Anything Else" });
  expect(refused.status).toBe(403);
  expect(refused.json.error).toBe("requests_off");
  // the list stays while it's off
  await ap.reload();
  await expect(ap.locator(".game-requests tr").filter({ hasText: game })).toBeVisible();
  await expect(ap.getByLabel("Let people request games")).not.toBeChecked();
  await ap.getByLabel("Let people request games").check();
  await expect(ap.getByText("Request a game is on")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Request a game" })).toBeVisible();

  // Clear takes the game off the list.
  await ap.locator(".game-requests tr").filter({ hasText: game }).getByRole("button", { name: "Clear" }).click();
  await ap.getByRole("dialog").getByRole("button", { name: "Clear" }).click();
  await expect(ap.getByText(`Cleared ${game}`)).toBeVisible();
  await expect(ap.locator(".game-requests tr").filter({ hasText: game })).toHaveCount(0);
  expect(sql(`SELECT COUNT(*) FROM game_requests WHERE game_key='${game.toLowerCase()}'`).trim()).toBe("0");
  // only settings Site Admin knows about can be set
  expect((await api(ap, "site_setting_save", { name: "anything", value: "1" })).status).toBe(400);
  expectNoErrors(errors);
  expectNoErrors(adminErrors);
});
