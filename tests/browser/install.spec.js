// Installable app: the manifest and icons Chrome needs to offer "Install app", and a service worker that never
// stands between the signed-in person and the server (it only answers with offline.html when there's no connection).
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors } = require("./helpers");

test("Install: the page links a manifest with a name, a start page in scope and 192/512 icons that load", async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto("index.html");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const res = await request.get(href);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBe("Campaign Chronicle");
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("./");
  expect(m.scope).toBe("./");
  for (const size of ["192x192", "512x512"]) expect(m.icons.some((i) => i.sizes === size && i.purpose === "any")).toBe(true);
  expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  for (const i of m.icons) {
    const img = await request.get(i.src);
    expect(img.ok(), i.src).toBe(true);
    expect(img.headers()["content-type"]).toContain(i.type);
  }
  expectNoErrors(errors);
});

test("Install: the title bar colour follows the colour theme and light/dark mode", async ({ page }) => {
  await page.goto("index.html");
  const color = () => page.locator('meta[name="theme-color"]').getAttribute("content");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect.poll(color).toBe("#16140f");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect.poll(color).toBe("#f4eee1");
  await page.evaluate(() => document.documentElement.setAttribute("data-scheme", "console"));
  await expect.poll(color).not.toBe("#f4eee1");
});

test("Install: the service worker leaves the API alone and shows the offline page with no connection", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright inspects service workers only in Chromium");
  await page.goto("index.html");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // API calls and scripts reach the network: nothing the worker could have cached.
  const viaWorker = [];
  page.on("response", (r) => { if (r.fromServiceWorker()) viaWorker.push(r.url()); });
  await page.reload();
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  expect(viaWorker.filter((u) => !u.endsWith("/index.html"))).toEqual([]);
  expect(await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat()))
    .toEqual(expect.arrayContaining(["/offline.html"]));
  expect(await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).length))).reduce((a, b) => a + b, 0))).toBe(2);
  await context.setOffline(true);
  await page.reload().catch(() => {});
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
});
