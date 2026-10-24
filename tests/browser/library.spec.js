// The Library tab: books, journals and notes ("tomes") with a title, a description and a long rich-text body. Every
// member, GM or player, adds tomes and changes any of them; a save from a copy someone else has saved over is refused.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

// A 2×1 PNG, inline so the test needs no image files.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");

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

test("names in tomes, downtime and Party Holdings go to the Proper Noun Detector, on save and in Scan campaign", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Library nouns");
  const row = (p, n) => p.locator(`.noun-row[data-term="${n}"]`);
  // Saving a tome offers the new names in its title, description and contents.
  await pp.goto(`index.html#/c/${cid}/library/new`);
  await pp.locator(".lib-form input[name=title]").fill("A letter from Nuln");
  await pp.locator(".lib-form textarea[name=description]").fill("Found in the satchel.");
  await pp.locator(".lib-form .ql-editor").click();
  await pp.keyboard.type("Magda wrote that the Countess of Averheim is watching us.");
  await pp.getByRole("button", { name: "Add tome" }).click();
  const dlg = pp.locator("dialog.noun-dialog");
  await expect(dlg).toBeVisible();
  for (const n of ["Nuln", "Magda", "Countess of Averheim"]) await expect(row(pp, n)).toBeVisible();
  await expect(row(pp, "A")).toHaveCount(0);
  await expect(row(pp, "Found")).toHaveCount(0);
  // Add Magda now and leave the others for later.
  await row(pp, "Magda").getByText("Add").click();
  await row(pp, "Nuln").getByText("Skip").click();
  await row(pp, "Countess of Averheim").getByText("Skip").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(dlg).toHaveCount(0);

  // Scan campaign reads the Library, downtime and Party Holdings too, and the entry lists where it is mentioned.
  expect((await api(page, "gear_save", { item: "Sword of Teclis", claimed_by: "", location: "Wagon", amount: 1 }, cid)).status).toBe(200);
  expect((await api(page, "holding_save", { name: "The Wandering Goose", kind: "vehicle", location: "Kemperbad docks", description: "Bought from Old Hilde.", amount: 1, stats: {}, tags: [] }, cid)).status).toBe(200);
  expect((await api(page, "downtime_save", { kind: "long_rest", slots: 2, title: "", notes: "Resting at Ubersreik." }, cid)).status).toBe(200);
  await page.goto(`index.html#/c/${cid}/encyclopedia`);
  await page.getByRole("button", { name: "🔍 Scan campaign" }).click();
  await expect(page.locator("dialog.noun-dialog")).toBeVisible();
  for (const n of ["Nuln", "Countess of Averheim", "Sword of Teclis", "Wandering Goose", "Kemperbad docks", "Old Hilde", "Ubersreik"]) await expect(row(page, n)).toBeVisible();
  await expect(row(page, "Long Rest")).toHaveCount(0); // the label a rest writes into the shifts
  await expect(row(page, "Magda")).toHaveCount(0);
  await page.locator("dialog.noun-dialog").getByRole("button", { name: /Save choices|Not now/ }).first().click();
  const magda = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.name === "Magda");
  await page.goto(`index.html#/c/${cid}/encyclopedia/${magda.id}`);
  await page.locator(".enc-form, .enc-detail").first().waitFor();
  await expect(page.locator(".enc-found")).toContainText("Library: A letter from Nuln");
  expectNoErrors(errors);
});

test("Scan on an entry or a tome runs the Proper Noun Detector over just that one", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid } = await gmAndPlayer(page, browser, "Scan one");
  const row = n => page.locator(`.noun-row[data-term="${n}"]`);
  const dlg = page.locator("dialog.noun-dialog");
  const tome = (await api(page, "tome_save", { kind: "book", title: "Ledger", description: "", body: "<p>We paid Brother Udo in Wurtbad.</p>" }, cid)).json.tome;
  expect((await api(page, "event_save", { abs_day: 2, title: "Raid", body: "Bandits from Grissenwald.", tags: [] }, cid)).status).toBe(200);
  const entry = (await api(page, "entry_save", { name: "Hexe", notes: "<p>She lives near Bögenhafen.</p>", gm_notes: "<p>She serves Tzeentch.</p>", tags: [] }, cid)).json;
  // The tome's scan offers only the names in the tome.
  await page.goto(`index.html#/c/${cid}/library/${tome.id}`);
  await page.locator(".lib-detail").getByRole("button", { name: "🔍 Scan" }).click();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('in "Ledger" that');
  for (const n of ["Brother Udo", "Wurtbad"]) await expect(row(n)).toBeVisible();
  for (const n of ["Grissenwald", "Bögenhafen"]) await expect(row(n)).toHaveCount(0);
  await row("Wurtbad").getByText("Add").click();
  await dlg.getByRole("button", { name: "Save choices" }).click();
  await expect(dlg).toHaveCount(0);
  // The entry's scan reads its Public and GM notes, and nothing else.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${entry.id}`);
  await page.locator(".enc-detail").getByRole("button", { name: "🔍 Scan" }).click();
  await expect(dlg).toBeVisible();
  for (const n of ["Bögenhafen", "Tzeentch"]) await expect(row(n)).toBeVisible();
  for (const n of ["Grissenwald", "Brother Udo", "Wurtbad", "Hexe"]) await expect(row(n)).toHaveCount(0);
  await dlg.getByRole("button", { name: "Not now" }).click();
  // Nothing left to find says so.
  await page.goto(`index.html#/c/${cid}/library/${tome.id}`);
  expect((await api(page, "terms_ignore", { terms: ["Brother Udo", "Ledger"] }, cid)).status).toBe(200);
  await page.reload();
  await page.locator(".lib-detail").getByRole("button", { name: "🔍 Scan" }).click();
  await expect(page.getByText('No names missing: everything the detector finds in "Ledger"')).toBeVisible();
  expectNoErrors(errors);
});

test("anyone in the campaign adds pictures to a tome and takes them off, and deleting the tome deletes them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Library pictures");
  const t = (await api(page, "tome_save", { kind: "book", title: "Bestiary", description: "Monsters of the Drakwald" }, cid)).json.tome;
  // A new tome can't take files until it is saved.
  await pp.goto(`index.html#/c/${cid}/library/new`);
  await expect(pp.locator(".lib-form")).toContainText("once the tome is saved");
  // The player adds a picture to the GM's tome from its page.
  await pp.goto(`index.html#/c/${cid}/library/${t.id}`);
  const box = pp.locator(".lib-detail .enc-files");
  await box.locator("input[type=file]").setInputFiles([{ name: "beastman.png", mimeType: "image/png", buffer: PNG }]);
  const pic = box.locator(".file-pic img");
  await expect(pic).toHaveCount(1);
  await expect.poll(() => pic.evaluate(img => img.complete && img.naturalWidth)).toBe(2);
  // The GM sees it, also from the editor, where it stays while the contents are half written.
  await page.goto(`index.html#/c/${cid}/library/${t.id}`);
  await expect(page.locator(".lib-detail .file-pic img")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".lib-form .file-pic img")).toHaveCount(1);
  const files = (await (await page.request.get(`api/index.php?a=tome&cid=${cid}&id=${t.id}`)).json()).tome.files;
  expect(files.map(f => f.name)).toEqual(["beastman.png"]);
  // A GM's file on a tome can be taken off by a player, as with the tome itself.
  const gmFile = await (async () => {
    const me = await (await page.request.get("api/auth/me.php")).json();
    const res = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, { headers: { "X-CSRF-Token": me.csrf },
      multipart: { parent_type: "library", parent_id: String(t.id), file: { name: "map.png", mimeType: "image/png", buffer: PNG } } });
    expect(res.status()).toBe(200);
    return (await res.json()).file;
  })();
  expect((await api(pp, "file_delete", { id: gmFile.id }, cid)).status).toBe(200);
  // Deleting the tome takes its files with it.
  expect((await api(page, "tome_delete", { id: t.id }, cid)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE parent_type='library' AND parent_id=${t.id}`).trim()).toBe("0");
  expect((await pp.request.get(`api/index.php?a=file&cid=${cid}&id=${files[0].id}`)).status()).toBe(404);
  expectNoErrors(errors);
});
