// Report (!): anyone signed in reports a problem from the top bar, with a screenshot of the page and what the page
// gathered by itself; the site admins read it on Site Admin's Reports tab, and resolve it unfixed, send it to GitHub
// (tests/support/github-stub.php stands in for GitHub), reopen or delete it.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { watchErrors, expectNoErrors, person, ADMIN, signIn, approve, api, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("the ! button sends a report with a screenshot, and Site Admin's Reports tab resolves, sends to GitHub and deletes it", async ({ page, browser }, testInfo) => {
  const errors = watchErrors(page);
  const who = person("Rhea");
  await signIn(page, who);
  await approve(browser, who.email);
  await page.goto("index.html#/templates");
  await expect(page.getByRole("heading", { name: "Sheet templates" })).toBeVisible();

  const note = `The dice tray vanished ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole("button", { name: "Report a problem with the site" }).click();
  const d = page.getByRole("dialog", { name: "Report a problem" });
  await expect(d).toBeVisible();
  // The screenshot is taken in the browser and shown before it is sent; the details that go with it are listed.
  await expect(d.getByRole("img", { name: "Screenshot of the page" })).toBeVisible({ timeout: 20_000 });
  await expect(d.getByLabel("Include a screenshot of this page")).toBeChecked();
  await d.getByText("Also sent: the page and your browser").click();
  await expect(d.locator(".report-details")).toContainText("#/templates");
  await expect(d.locator(".report-details")).toContainText("Build");
  // nothing written: it asks first
  await d.getByRole("button", { name: "Send report" }).click();
  await expect(d).toBeVisible();
  await d.getByLabel("What went wrong?").fill(note);
  await d.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report sent. Thank you!")).toBeVisible();
  await expect(d).toBeHidden();
  const id = sql(`SELECT id FROM site_reports WHERE message='${note}'`).trim();
  expect(Number(id)).toBeGreaterThan(0);
  expect(sql(`SELECT shot_mime FROM site_reports WHERE id=${id}`).trim()).toBe("image/jpeg");

  // The server takes only a real picture, and nobody but a site admin reads reports.
  expect((await api(page, "report_send", { message: "x" })).status).toBe(400);
  expect((await api(page, "report_send", { message: "A real report", shot: "data:image/png;base64,AAAA" })).status).toBe(400);
  expect((await api(page, "reports")).status).toBe(403);
  expect((await page.request.get(`api/index.php?a=report_shot&id=${id}`)).status()).toBe(403);

  const ap = await (await newContext(browser)).newPage();
  const adminErrors = watchErrors(ap);
  await signIn(ap, ADMIN);
  await ap.goto("index.html#/admin/reports");
  await expect(ap.locator(".admin-tabs a.on")).toHaveText("Reports");
  const card = ap.locator(".report-card").filter({ hasText: note });
  await expect(card).toContainText("Rhea");
  await expect(card).toContainText("#/templates");
  await expect(card.getByRole("img", { name: `Screenshot sent with report ${id}` })).toBeVisible();
  const shot = await ap.request.get(`api/index.php?a=report_shot&id=${id}`);
  expect(shot.status()).toBe(200);
  expect(shot.headers()["content-type"]).toBe("image/jpeg");
  await card.getByText("Session details").click();
  await expect(card.locator(".report-details")).toContainText("Sheet templates");

  // Resolve unfixed takes it off the Open list; Reopen puts it back.
  await card.getByRole("button", { name: "Resolve unfixed" }).click();
  await expect(card).toHaveCount(0);
  await ap.getByText(/^Resolved unfixed \(\d+\)$/).click();
  await expect(card).toContainText("Resolved unfixed by");
  await card.getByRole("button", { name: "Reopen" }).click();
  await expect(card).toHaveCount(0);
  await ap.getByText(/^Open \(\d+\)$/).click();
  await expect(card).toBeVisible();

  // Send to GitHub opens the issue (here, the stub) without the sender's name or the screenshot, and links it.
  await card.getByRole("button", { name: "Send to GitHub" }).click();
  await expect(ap.getByText("Issue opened on GitHub")).toBeVisible();
  await expect(card).toHaveCount(0);
  const sent = fs.readFileSync(path.join(os.tmpdir(), "chronicle-github-stub.log"), "utf8").trim().split("\n").map(l => JSON.parse(l))
    .filter(r => String(r.data.body).includes(note)).pop();
  expect(sent.url).toBe("https://api.github.com/repos/example/chronicle/issues");
  expect(sent.data.title).toContain("The dice tray vanished");
  expect(sent.data.body).toContain(note);
  expect(sent.data.body).toContain("#/templates");
  expect(sent.data.body).not.toContain("Rhea");
  expect(sent.data.body).not.toContain(who.email);
  expect(sent.data.labels).toEqual(["bug"]);
  await ap.getByText(/^Sent to GitHub \(\d+\)$/).click();
  await expect(card.getByRole("link", { name: "The issue on GitHub" })).toHaveAttribute("href", /^https:\/\/github\.com\/example\/chronicle\/issues\/\d+$/);
  expect((await api(ap, "report_github_link", { id: Number(id), url: "https://evil.example/x" })).status).toBe(400);

  // Delete, after asking.
  await card.getByRole("button", { name: "Delete" }).click();
  await ap.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(card).toHaveCount(0);
  expect(sql(`SELECT COUNT(*) FROM site_reports WHERE id=${id}`).trim()).toBe("0");
  expectNoErrors(errors);
  expectNoErrors(adminErrors);
});
