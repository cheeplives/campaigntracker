// Pictures and files on Encyclopedia entries: a portrait on a character, a map on a location. Pictures show on the
// entry's page and open full size; other files download. Uploads are checked by their contents, and a file is only
// ever sent to someone who may see its entry: never a GM-only file, or any file on a secret entry, to a player.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

// A 2×1 PNG and a 1×1 GIF, inline so the test needs no image files.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");
const GIF = Buffer.from("R0lGODdhAQABAIAAAP8AAAAAACwAAAAAAQABAAACAkQBADs=", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

async function gmAndPlayer(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(pp, "campaign", undefined, cid)).status).toBe(403);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  return { cid, pp };
}
/** Upload through the API as whoever page is signed in as. */
async function upload(page, cid, entryId, name, buffer, mimeType, extra = {}) {
  const me = await (await page.request.get("api/auth/me.php")).json();
  const res = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, {
    headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "encyclopedia", parent_id: String(entryId), file: { name, mimeType, buffer }, ...extra },
  });
  return { status: res.status(), json: await res.json() };
}
async function entry(page, cid, name, extra = {}) {
  const r = await api(page, "entry_save", { name, notes: `<p>${name} is here.</p>`, ...extra }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.id;
}

test("a GM adds a portrait and a handout to an entry; the picture shows and opens full size, the file downloads, and players see both", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Pictures");
  const id = await entry(page, cid, "Gunther");
  await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
  const box = page.locator(".enc-detail .enc-files");
  await expect(box.getByText("No pictures or files yet")).toBeVisible();
  await box.locator("input[type=file]").setInputFiles([
    { name: "gunther.png", mimeType: "image/png", buffer: PNG },
    { name: "Wanted poster.pdf", mimeType: "application/pdf", buffer: PDF },
  ]);
  await expect(page.getByText("2 files added")).toBeVisible();
  const pic = box.locator(".file-pic img");
  await expect(pic).toHaveCount(1);
  await expect.poll(() => pic.evaluate(img => img.complete && img.naturalWidth)).toBe(2);
  await expect(box.locator(".file-list a")).toHaveText("📄 Wanted poster.pdf");

  // The full-size viewer, where the caption is changed.
  await box.locator(".file-thumb").click();
  const viewer = page.locator("dialog.file-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".file-cap")).toContainText("gunther.png");
  await expect(viewer.locator(".file-cap")).toContainText("2×1");
  await viewer.getByRole("button", { name: "✎ Caption" }).click();
  await page.getByRole("textbox", { name: "Caption" }).fill("Gunther, sketched by Ilse");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  // Only the picture shows under the entry; its caption is in the "?" on its corner.
  await expect(box.locator(".file-pic figcaption")).toHaveCount(0);
  await expect(box.locator(".file-pic .tip")).toHaveAttribute("data-tip", "Gunther, sketched by Ilse");

  // A player reads both, and the picture loads for them too. The PDF is sent as a download, never shown inline.
  const perrors = watchErrors(pp);
  await pp.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
  const pbox = pp.locator(".enc-detail .enc-files");
  await expect(pbox.locator(".file-pic .tip")).toHaveAttribute("data-tip", "Gunther, sketched by Ilse");
  await expect.poll(() => pbox.locator(".file-pic img").evaluate(img => img.complete && img.naturalWidth)).toBe(2);
  const { json } = await api(pp, "encyclopedia", undefined, cid);
  const pdf = json.files.find(f => f.name === "Wanted poster.pdf");
  const res = await pp.request.get(pdf.url);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="Wanted poster.pdf"/);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(Buffer.compare(await res.body(), PDF)).toBe(0);
  // The player didn't add them, so they can't remove or change them.
  await expect(pbox.getByRole("button", { name: "×" })).toHaveCount(0);
  expect((await api(pp, "file_delete", { id: pdf.id }, cid)).status).toBe(403);
  expect((await api(pp, "file_update", { id: pdf.id, caption: "mine now" }, cid)).status).toBe(403);
  // But a player can add their own, and remove it again.
  const mine = await upload(pp, cid, id, "doodle.gif", GIF, "image/gif");
  expect(mine.status, JSON.stringify(mine.json)).toBe(200);
  expect(mine.json.file.is_secret).toBe(false);
  expect((await api(pp, "file_delete", { id: mine.json.file.id }, cid)).status).toBe(200);
  expect((await pp.request.get(mine.json.file.url)).status()).toBe(404);

  // The GM removes the PDF from the page.
  await page.locator(".enc-detail .file-list").getByRole("button", { name: "×" }).click();
  await page.locator("dialog.kit-dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("File removed")).toBeVisible();
  await expect(box.locator(".file-list")).toHaveCount(0);
  expect((await pp.request.get(pdf.url)).status()).toBe(404);
  expectNoErrors(errors);
  expectNoErrors(perrors);
});

test("GM-only files, and every file on a secret entry, never reach players or anyone outside the campaign", async ({ page, browser }) => {
  const { cid, pp } = await gmAndPlayer(page, browser, "Secret files");
  const open = await entry(page, cid, "Altdorf");
  const secret = await entry(page, cid, "Black Hand", { is_secret: true });
  const map = await upload(page, cid, open, "altdorf.png", PNG, "image/png", { caption: "City map" });
  const plan = await upload(page, cid, open, "the plan.png", PNG, "image/png", { is_secret: "1" });
  const token = await upload(page, cid, secret, "token.gif", GIF, "image/gif");
  for (const r of [map, plan, token]) expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(plan.json.file.is_secret).toBe(true);

  // The GM gets all three.
  expect((await api(page, "encyclopedia", undefined, cid)).json.files.map(f => f.name).sort()).toEqual(["altdorf.png", "the plan.png", "token.gif"]);
  // The player gets only the map: the others are neither listed nor sent.
  const pj = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(pj.files.map(f => f.name)).toEqual(["altdorf.png"]);
  expect(JSON.stringify(pj)).not.toContain("the plan");
  const listed = await pp.request.get(`api/index.php?a=files&cid=${cid}&parent_type=encyclopedia&parent_id=${open}`);
  expect((await listed.json()).files.map(f => f.name)).toEqual(["altdorf.png"]);
  expect((await pp.request.get(`api/index.php?a=files&cid=${cid}&parent_type=encyclopedia&parent_id=${secret}`)).status()).toBe(404);
  expect((await pp.request.get(map.json.file.url)).status()).toBe(200);
  expect((await pp.request.get(plan.json.file.url)).status()).toBe(404);
  expect((await pp.request.get(token.json.file.url)).status()).toBe(404);
  // A player can't upload to a secret entry, or set GM only on their own upload.
  expect((await upload(pp, cid, secret, "x.png", PNG, "image/png")).status).toBe(404);
  const theirs = await upload(pp, cid, open, "x.png", PNG, "image/png", { is_secret: "1" });
  expect(theirs.json.file.is_secret).toBe(false);
  expect((await api(pp, "file_update", { id: theirs.json.file.id, is_secret: true }, cid)).json.file.is_secret).toBe(false);

  // Making the map GM only, or the whole entry secret, takes it from the player at once.
  expect((await api(page, "file_update", { id: map.json.file.id, is_secret: true }, cid)).status).toBe(200);
  expect((await pp.request.get(map.json.file.url)).status()).toBe(404);
  expect((await api(page, "file_update", { id: map.json.file.id, is_secret: false }, cid)).status).toBe(200);
  expect((await pp.request.get(map.json.file.url)).status()).toBe(200);
  expect((await api(page, "entry_save", { id: open, name: "Altdorf", is_secret: true }, cid)).status).toBe(200);
  expect((await pp.request.get(map.json.file.url)).status()).toBe(404);

  // Someone outside the campaign, or signed out, gets nothing.
  const octx = await browser.newContext();
  const op = await octx.newPage();
  const other = person("Olaf");
  await signIn(op, other);
  await approve(browser, other.email);
  expect((await op.request.get(map.json.file.url)).status()).toBe(403);
  const sctx = await browser.newContext();
  expect((await (await sctx.newPage()).request.get(map.json.file.url)).status()).toBe(401);
  // A file of one campaign can't be fetched through another campaign's id.
  const cid2 = await makeCampaign(page, `Other ${Date.now()}`);
  expect((await page.request.get(`api/index.php?a=file&cid=${cid2}&id=${map.json.file.id}`)).status()).toBe(404);

  // The GM's page shows the 🔒 on the GM-only picture and on everything on the secret entry.
  await page.goto(`index.html#/c/${cid}/encyclopedia/${secret}`);
  await expect(page.locator(".enc-detail .file-pic.secret")).toHaveCount(1);

  // Deleting an entry takes its files with it, from the database and from the disk.
  const stored = sql(`SELECT stored_name FROM attachments WHERE id=${token.json.file.id}`).trim();
  expect(stored).toMatch(/^[0-9a-f]{32}$/);
  expect((await api(page, "entry_delete", { id: secret }, cid)).status).toBe(200);
  expect(sql(`SELECT COUNT(*) FROM attachments WHERE id=${token.json.file.id}`).trim()).toBe("0");
  expect((await page.request.get(token.json.file.url)).status()).toBe(404);
  const fs = require("fs"), os = require("os"), path = require("path");
  expect(fs.existsSync(path.join(os.tmpdir(), "chronicle-test-uploads", stored))).toBe(false);
});

test("uploads are checked by their contents, size and type, and served so the browser can't run them", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Upload checks");
  const id = await entry(page, cid, "Nuln");
  const refused = async (name, buffer, mimeType, status, message) => {
    const r = await upload(page, cid, id, name, buffer, mimeType);
    expect(r.status, `${name}: ${JSON.stringify(r.json)}`).toBe(status);
    if (message) expect(r.json.message).toMatch(message);
  };
  // Scripts and markup, whatever they are called.
  await refused("map.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", 415, /can't be uploaded/);
  await refused("evil.php", Buffer.from("<?php echo 'hi';"), "application/x-php", 415);
  await refused("page.html", Buffer.from("<html><script>alert(1)</script></html>"), "text/html", 415);
  await refused("notes.txt", Buffer.from("<!doctype html><script>alert(1)</script>"), "text/plain", 415);
  // A picture that isn't one, or is another kind than its name says.
  await refused("fake.png", Buffer.from("<html><script>alert(1)</script></html>"), "image/png", 415, /isn't a working .png picture/);
  await refused("really-a-gif.png", GIF, "image/png", 415);
  await refused("fake.pdf", Buffer.from("not a pdf"), "application/pdf", 415);
  await refused("empty.png", Buffer.alloc(0), "image/png", 400);
  // Over the size limit (2 MB in the test config), and over the campaign's total (6 MB).
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1048576 + 10)]);
  await refused("big.png", big, "image/png", 413, /too big/);
  const chunk = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1900000, 32)]);
  for (let i = 0; i < 3; i++) expect((await upload(page, cid, id, `part${i}.pdf`, chunk, "application/pdf")).status).toBe(200);
  await refused("part3.pdf", chunk, "application/pdf", 413, /using all of its 6 MB/);
  // A file's name is kept for the download, without folders or characters a file name can't have.
  const txt = await upload(page, cid, id, "../../etc/pass:wd.txt", Buffer.from("Hello Nuln"), "text/plain");
  expect(txt.status, JSON.stringify(txt.json)).toBe(200);
  expect(txt.json.file.name).toBe("pass_wd.txt");
  expect(txt.json.file.kind).toBe("file");
  const res = await page.request.get(txt.json.file.url);
  expect(res.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(res.headers()["content-disposition"]).toMatch(/^attachment;/);
  // A picture is shown inline, sandboxed, and only revalidated from the cache.
  const pic = await upload(page, cid, id, "nuln.png", PNG, "image/png");
  const shown = await page.request.get(pic.json.file.url);
  expect(shown.headers()["content-type"]).toBe("image/png");
  expect(shown.headers()["content-disposition"]).toMatch(/^inline;/);
  expect(shown.headers()["content-security-policy"]).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  expect(shown.headers()["cache-control"]).toBe("private, no-cache");
  const again = await page.request.get(pic.json.file.url, { headers: { "If-None-Match": shown.headers()["etag"] } });
  expect(again.status()).toBe(304);
  // Uploads need the security token like every other change.
  const noToken = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, {
    multipart: { parent_type: "encyclopedia", parent_id: String(id), file: { name: "x.png", mimeType: "image/png", buffer: PNG } } });
  expect(noToken.status()).toBe(403);
  // Only the parents the app knows.
  const me = await (await page.request.get("api/auth/me.php")).json();
  const odd = await page.request.post(`api/index.php?a=file_upload&cid=${cid}`, { headers: { "X-CSRF-Token": me.csrf },
    multipart: { parent_type: "users", parent_id: "1", file: { name: "x.png", mimeType: "image/png", buffer: PNG } } });
  expect(odd.status()).toBe(400);
});
