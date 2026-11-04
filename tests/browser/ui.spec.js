// The shared UI kit: in-page dialogs instead of confirm()/prompt(), and the
// light/dark toggle and colour themes, which are remembered like Sinless's.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("deleting asks in an in-page dialog, and Cancel keeps the item", async ({ page, browser }) => {
  const errors = watchErrors(page);
  page.on("dialog", d => { errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  const gm = person("Jo");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page);
  await page.goto(`index.html#/c/${cid}/regions`);
  await page.getByLabel("More for Home", { exact: true }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete region Home?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".listrow").filter({ hasText: "Home" })).toHaveCount(1);

  await page.getByLabel("More for Home", { exact: true }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".listrow").filter({ hasText: "Home" })).toHaveCount(0);
  expectNoErrors(errors);
});

test("the theme toggle switches light/dark and is remembered", async ({ page }) => {
  await page.goto("index.html");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  expect(["light", "dark"]).toContain(before);
  await page.getByRole("button", { name: "Toggle light / dark mode" }).click();
  const after = before === "light" ? "dark" : "light";
  await expect(html).toHaveAttribute("data-theme", after);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", after);
});

test("a colour theme is picked from the top bar, remembered, and follows the account", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const who = person("Theo");
  await signIn(page, who);
  await approve(browser, who.email);
  await page.goto("index.html");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-scheme", "parchment");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: /Ship's Console/ }).click();
  await expect(html).toHaveAttribute("data-scheme", "console");
  await expect(page.getByRole("button", { name: "Theme: Ship's Console" })).toBeVisible();
  await page.reload();
  await expect(html).toHaveAttribute("data-scheme", "console");

  // A fresh device (no local storage) picks it up from the account once signed in.
  await expect.poll(async () => (await (await page.request.get("api/auth/me.php")).json()).prefs.scheme).toBe("console");
  const ctx = await newContext(browser);
  const other = await ctx.newPage();
  await signIn(other, who);
  await other.goto("index.html");
  await expect(other.locator("html")).toHaveAttribute("data-scheme", "console");
  await ctx.close();
  expectNoErrors(errors);
});

test("fonts are served from this site, not a third party", async ({ page }) => {
  const outside = [];
  page.on("request", r => { if (!r.url().startsWith("http://127.0.0.1")) outside.push(r.url()); });
  await page.goto("index.html");
  await page.evaluate(() => document.fonts.ready);
  expect(outside).toEqual([]);
});

test("the favicon and touch icon are linked and served as images", async ({ page, request }) => {
  await page.goto("index.html");
  const hrefs = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll(ls => ls.map(l => l.href));
  expect(hrefs.length).toBe(3);
  for (const href of [...hrefs, new URL("favicon.ico", page.url()).href]) {
    const res = await request.get(href);
    expect(res.ok(), href).toBe(true);
    expect(res.headers()["content-type"], href).toMatch(/^image\//);
  }
});

test("on an iPad in portrait the tabs are a drawer: » slides them out over the page, picking one slides them back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Jo");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`index.html#/c/${cid}/calendar`);
  const nav = page.locator("nav.tabs");
  const tuck = nav.locator(".legend-tuck");
  await expect(nav).toHaveClass(/\btucked\b/);
  await expect(nav.getByRole("link", { name: "Events", exact: true })).toBeHidden();
  // the page starts beside the 46px rail, not under three rows of tabs
  const top = await page.locator(".nowbar").evaluate(n => n.getBoundingClientRect().top);
  expect(top).toBeLessThan(120);
  await tuck.click();
  await expect(nav).not.toHaveClass(/\btucked\b/);
  await expect(tuck).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("link", { name: "Events", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${cid}/events$`));
  await expect(page.locator("nav.tabs")).toHaveClass(/\btucked\b/);
  // Escape and a tap outside close it too
  await page.locator("nav.tabs .legend-tuck").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("nav.tabs")).toHaveClass(/\btucked\b/);
  await page.locator("nav.tabs .legend-tuck").click();
  await page.mouse.click(700, 700);   // the page beside the drawer
  await expect(page.locator("nav.tabs")).toHaveClass(/\btucked\b/);
  expectNoErrors(errors);
});
