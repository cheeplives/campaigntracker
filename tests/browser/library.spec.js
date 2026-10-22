// The Library tab: books, journals and notes ("tomes") with a title, a description and a long rich-text body. Every
// member, GM or player, adds tomes and changes any of them; a save from a copy someone else has saved over is refused.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

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

test("the Library sits under the Encyclopedia, and a player writes a tome the GM reads and changes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Library");
  await pp.goto(`index.html#/c/${cid}/library`);
  await expect(pp.locator("nav.tabs a.on")).toHaveText("Library");
  const tabs = await pp.locator("nav.tabs a").allTextContents();
  expect(tabs.indexOf("Library")).toBe(tabs.indexOf("Encyclopedia") + 1);
  await expect(pp.locator(".lib-detail")).toContainText("Nothing on the shelves yet");

  // The player adds a journal.
  await pp.getByRole("link", { name: "+ New tome" }).click();
  await pp.locator(".lib-form .seg label", { hasText: "Journal" }).click();
  await pp.locator(".lib-form input[name=title]").fill("Pip's Road Diary");
  await pp.locator(".lib-form textarea[name=description]").fill("Kept on the way to Altdorf.");
  const body = pp.locator(".lib-form .ql-editor");
  await body.click();
  await pp.keyboard.type("Day one. ");
  await pp.keyboard.press("ControlOrMeta+b");
  await pp.keyboard.type("Rain");
  await pp.keyboard.press("ControlOrMeta+b");
  await pp.keyboard.type(" all day.");
  await pp.getByRole("button", { name: "Add tome" }).click();
  await expect(pp.locator(".lib-detail h2")).toHaveText("Pip's Road Diary");
  await expect(pp.locator(".lib-detail .lib-kind")).toContainText("Journal");
  await expect(pp.locator(".lib-detail .lib-blurb")).toHaveText("Kept on the way to Altdorf.");
  await expect(pp.locator(".lib-body strong")).toHaveText("Rain");
  await expect(pp.locator(".lib-item")).toHaveCount(1);
  await expect(pp.locator(".lib-detail")).toContainText("Added by Pip");

  // The GM opens it and changes it; the player's page then shows who changed it.
  const id = Number(pp.url().split("/").pop());
  await page.goto(`index.html#/c/${cid}/library/${id}`);
  await expect(page.locator(".lib-body")).toContainText("Rain all day.");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".lib-form .ql-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("GM: the bridge is out.");
  await page.getByRole("button", { name: "Save tome" }).click();
  await expect(page.locator(".lib-body")).toContainText("the bridge is out");
  await pp.reload();
  await expect(pp.locator(".lib-body")).toContainText("the bridge is out");
  await expect(pp.locator(".lib-detail")).toContainText("last changed by Gwen");

  // Search and the kind filter narrow the list.
  expect((await api(page, "tome_save", { kind: "book", title: "Codex of Night", description: "Bound in black leather" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/library`);
  await expect(pp.locator(".lib-item")).toHaveCount(2);
  await pp.locator(".enc-index input[type=search]").fill("leather");
  await expect(pp.locator(".lib-item")).toHaveText([/Codex of Night/]);
  await pp.locator(".enc-index input[type=search]").fill("");
  await pp.locator(".tagopt", { hasText: "Journals" }).click();
  await expect(pp.locator(".lib-item")).toHaveText([/Pip's Road Diary/]);
  expectNoErrors(errors);
});

test("a save from an older copy is refused, the body is cleaned, and only the author or a GM deletes", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Library rules");
  const made = await api(page, "tome_save", { kind: "note", title: "  Ransom   note ", body: '<p onclick="x()">Pay <img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">now</a></p>' }, cid);
  expect(made.status).toBe(200);
  const t = made.json.tome;
  expect(t.title).toBe("Ransom note");
  expect(t.body).toBe("<p>Pay now</p>");
  expect(t.version).toBe(1);

  // The player saves first; the GM's save from version 1 is then refused, naming who saved.
  expect((await api(pp, "tome_save", { id: t.id, version: 1, kind: "note", title: "Ransom note", body: "<p>Pay double</p>" }, cid)).status).toBe(200);
  const stale = await api(page, "tome_save", { id: t.id, version: 1, kind: "note", title: "Ransom note", body: "<p>Mine</p>" }, cid);
  expect(stale.status).toBe(409);
  expect(stale.json.message || stale.json.error).toMatch(/Pip saved this tome/);
  const now = await (await page.request.get(`api/index.php?a=tome&cid=${cid}&id=${t.id}`)).json();
  expect(now.tome.body).toBe("<p>Pay double</p>");
  expect(now.tome.version).toBe(2);

  expect((await api(page, "tome_save", { kind: "scroll", title: "x" }, cid)).status).toBe(400);
  expect((await api(page, "tome_save", { kind: "book", title: "   " }, cid)).status).toBe(400);

  // The player can't delete the GM's tome, but can delete their own; the GM can delete anyone's.
  expect((await api(pp, "tome_delete", { id: t.id }, cid)).status).toBe(403);
  const mine = (await api(pp, "tome_save", { kind: "book", title: "Pip's book" }, cid)).json.tome;
  expect((await api(pp, "tome_delete", { id: mine.id }, cid)).status).toBe(200);
  expect((await api(page, "tome_delete", { id: t.id }, cid)).status).toBe(200);
  expect((await api(page, "library", undefined, cid)).json.tomes).toEqual([]);

  // Someone outside the campaign gets nothing.
  const outsider = person("Ozzy");
  const octx = await browser.newContext();
  const op = await octx.newPage();
  await signIn(op, outsider);
  await approve(browser, outsider.email);
  expect((await api(op, "library", undefined, cid)).status).toBe(403);
  expect((await api(op, "tome_save", { kind: "book", title: "Intruder" }, cid)).status).toBe(403);
});
