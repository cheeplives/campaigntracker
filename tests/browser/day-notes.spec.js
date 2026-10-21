// The day page's Notes box: the GM writes Public and Secret notes in a word-processor editor, stored as HTML the
// server cleans to an allow-list and the browser rebuilds from the same list; players read the Public notes only.
// Every box on the page folds, and stays folded in that browser for that account.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

const dayRow = async (page, cid, d = 2) => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=${d}`)).json()).day;

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}

test("the GM formats Public and Secret notes; players read only the Public ones", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Rich notes");
  await page.goto(`index.html#/c/${cid}`);
  const pub = page.locator(".notepanel.public .ql-editor"), sec = page.locator(".notepanel.secret .ql-editor");
  await expect(pub).toBeVisible();

  await pub.click();
  await page.locator(".notepanel.public button.ql-bold").click();
  await pub.pressSequentially("Gunther");
  await page.locator(".notepanel.public button.ql-bold").click();
  await pub.pressSequentially(" runs the inn");
  await pub.press("Enter");
  await page.locator(".notepanel.public select.rt-table").selectOption("insert");
  await expect(page.locator(".notepanel.public .ql-editor table td")).toHaveCount(9);
  await pub.pressSequentially("Rope");
  await sec.click();
  await sec.pressSequentially("The innkeeper is a spy");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByText("Notes saved")).toBeVisible();

  const day = await dayRow(page, cid);
  expect(day.notes_format).toBe("html");
  expect(day.notes).toContain("<strong>Gunther</strong>");
  expect(day.notes).toMatch(/<table>.*<td>Rope<\/td>/);
  expect(day.notes).not.toMatch(/style=|class=|data-row/);
  expect(day.gm_notes_format).toBe("html");
  expect(day.gm_notes).toContain("The innkeeper is a spy");
  // after a reload the editor opens on what was saved
  await expect(page.locator(".notepanel.public .ql-editor strong")).toHaveText("Gunther");
  await expect(page.locator(".notepanel.public .ql-editor td").first()).toHaveText("Rope");

  // The player sees the formatted Public notes, no editor and no Secret notes; the server never sends them.
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator("[data-box=notes] .richtext strong")).toHaveText("Gunther");
  await expect(pp.locator("[data-box=notes] .richtext td").first()).toHaveText("Rope");
  await expect(pp.locator("[data-box=notes] .ql-editor")).toHaveCount(0);
  await expect(pp.locator(".notepanel.secret")).toHaveCount(0);
  const pday = await dayRow(pp, cid);
  expect(pday).not.toHaveProperty("gm_notes");
  expect(JSON.stringify(pday)).not.toContain("spy");

  // Previews in the month grid get plain text, and the export gets Markdown.
  const range = await (await pp.request.get(`api/index.php?a=days&cid=${cid}&from=2&to=2`)).json();
  expect(range.notes[0].items[0].text).toMatch(/^Gunther runs the inn\nRope/);
  expect(JSON.stringify(range.notes)).not.toContain("<");
  await page.reload();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ Export" }).click()]);
  const md = require("fs").readFileSync(await dl.path(), "utf8");
  expect(md).toContain("**Gunther** runs the inn");
  expect(md).toContain("| Rope |  |  |");
  expect(md).toContain("## Secret notes 🔒");
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("notes keep only the allowed formatting, on the server and in the browser", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Clean notes");
  const evil = '<p onclick="window.pwned=1" style="color:red">Hello <b>bold</b></p><img src=x onerror="window.pwned=1">'
    + '<script>window.pwned=1</script><svg onload="window.pwned=1"></svg><style>body{display:none}</style>'
    + '<a href="javascript:window.pwned=1">bad link</a> <a href=" java\tscript:alert(1)">tab link</a> <a href="https://example.com/map">good link</a>'
    + '<iframe src="https://example.com"></iframe><table><tr><td data-row="1" style="x">cell</td></tr></table>';
  expect((await api(page, "day_update", { abs_day: 2, notes: evil, notes_format: "html", gm_notes: "<p>sec<img src=x></p>", gm_notes_format: "html" }, cid)).status).toBe(200);
  const day = await dayRow(page, cid);
  expect(day.notes).toBe('<p>Hello <strong>bold</strong></p>bad link tab link <a href="https://example.com/map">good link</a><table><tr><td>cell</td></tr></table>');
  expect(day.gm_notes).toBe("<p>sec</p>");

  // Even HTML that got past the server (say, written into the database by hand) is rebuilt from the allow-list.
  const { sql } = require("./helpers");
  sql(`UPDATE days SET notes='<p>Hi<img src=x onerror="window.pwned=1"><a href="javascript:window.pwned=1">x</a></p><script>window.pwned=1</script>' WHERE campaign_id=${cid} AND abs_day=2`);
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}`);
  const view = pp.locator("[data-box=notes] .richtext");
  await expect(view).toContainText("Hi");
  await expect(view.locator("img, script")).toHaveCount(0);
  await expect(view.locator("a")).toHaveCount(0);
  expect(await pp.evaluate(() => window.pwned)).toBeUndefined();
  // plain notes saved before the editor existed still show as typed, markup and all as text
  sql(`UPDATE days SET notes='Old note <b>not bold</b>', notes_format='plain' WHERE campaign_id=${cid} AND abs_day=2`);
  await pp.reload();
  await expect(pp.locator("[data-box=notes] .pre")).toHaveText("Old note <b>not bold</b>");
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("every box folds, and stays folded in this browser for this account", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Fold boxes");
  await page.goto(`index.html#/c/${cid}`);
  const shifts = page.locator("[data-box=shifts]");
  await expect(shifts.locator(".shiftcard").first()).toBeVisible();
  await shifts.locator(".daybox-toggle").click();
  await expect(shifts.locator(".shiftcard").first()).toBeHidden();
  await expect(shifts.locator(".daybox-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.locator("[data-box=notes]").locator(".daybox-toggle").click();
  await page.reload();
  await expect(page.locator("[data-box=shifts] .shiftcard").first()).toBeHidden();
  await expect(page.locator("[data-box=notes] .daybox-body")).toBeHidden();
  await expect(page.locator("[data-box=weather] .dayhero")).toBeVisible();
  // Adding an event to a folded Events box unfolds it.
  await page.locator("[data-box=events]").locator(".daybox-toggle").click();
  await page.getByRole("button", { name: "+ Add event" }).click();
  await expect(page.locator("[data-box=events] .daybox-body")).toBeVisible();
  // Unfolding comes back too.
  await page.locator("[data-box=shifts]").locator(".daybox-toggle").click();
  await page.reload();
  await expect(page.locator("[data-box=shifts] .shiftcard").first()).toBeVisible();
  // Another account keeps its own boxes.
  await pp.goto(`index.html#/c/${cid}`);
  await expect(pp.locator("[data-box=notes] .daybox-body")).toBeVisible();
  expectNoErrors(errors);
});
