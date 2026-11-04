// The shared UI kit: in-page dialogs instead of confirm()/prompt(), and the
// light/dark toggle and colour themes, which are remembered like Sinless's.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign, newContext, closeContexts } = require("./helpers");
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

test("Encyclopedia, Library and Sessions share one list-and-reader layout, and with nothing picked offer a few to start from", async ({ page, browser, viewport }) => {
  const errors = watchErrors(page);
  const gm = person("Lister");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page);
  await api(page, "entry_save", { name: "Altdorf", notes: "<p>A city.</p>" }, cid);
  await api(page, "tome_save", { kind: "book", title: "Ledger", body: "<p>Ale.</p>" }, cid);
  await api(page, "session_save", {}, cid);
  const oneColumn = viewport.width <= 900;
  for (const [tab, title, add, start] of [["encyclopedia", "Encyclopedia", "+ New entry", "Altdorf"], ["library", "Library", "+ New tome", "Ledger"], ["sessions", "Sessions", "+ New session", "Session 1"]]) {
    await page.goto(`index.html#/c/${cid}/${tab}`);
    const head = page.locator(".enc-index .lp-head");
    await expect(head.locator("h2")).toHaveText(new RegExp(title));
    await expect(head.locator(".lp-actions").getByText(add)).toBeVisible();
    const startItem = page.locator(".lp-empty .lp-start-item", { hasText: start });
    if (oneColumn) { await expect(page.locator(".lp-empty")).toBeHidden(); continue; }
    // the reader offers it, and following it opens it there
    await startItem.click();
    await expect(page).toHaveURL(new RegExp(`/${tab}/\\d+$`));
    await expect(page.locator(".enc-index .enc-item.on")).toContainText(start);
  }
  // the Encyclopedia's rarer actions wait behind its ⋯
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await expect(page.getByRole("button", { name: "🔍 Scan campaign" })).toBeHidden();
  await page.getByLabel("More for Encyclopedia", { exact: true }).click();
  await expect(page.getByRole("button", { name: "🔍 Scan campaign" })).toBeVisible();
  await expect(page.getByRole("button", { name: "⬇ Export…" })).toBeVisible();
  expectNoErrors(errors);
});
