// Find Image on Encyclopedia entries: the server searches Openverse, Wikimedia Commons, Pixabay, the museums, Pexels and
// DeviantArt (here tests/support/image-stub.php answers for them), copies only openly or freely licensed pictures,
// credited, and embeds other DeviantArt works without copying them. All, the panel's first choice, searches them all.
const { test, expect } = require("@playwright/test");
const fs = require("fs"), os = require("os"), path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");
const OV_OPEN = "11111111-1111-1111-1111-111111111111", OV_NC = "22222222-2222-2222-2222-222222222222", OV_BIG = "33333333-3333-3333-3333-333333333333";
const DA_CC = "A1B2C3D4-0000-0000-0000-000000000001", DA_ARR = "A1B2C3D4-0000-0000-0000-000000000002", DA_ELSEWHERE = "A1B2C3D4-0000-0000-0000-000000000004";

async function setup(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const r = await api(page, "entry_save", { name: "Greywater Keep", notes: "<p>A ruined keep.</p>" }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { cid, pp, id: r.json.id, gm };
}
async function search(page, cid, source, q) {
  const res = await page.request.get(`api/index.php?${new URLSearchParams({ a: "image_search", cid, source, q })}`);
  return { status: res.status(), json: await res.json() };
}
const pick = (page, cid, id, body) => api(page, "image_import", { parent_type: "encyclopedia", parent_id: id, mode: "copy", ...body }, cid);
/** Pictures the browser loads from outside: the Art Institute's IIIF server, and DeviantArt's for an embed. Playwright
 * doesn't route a request a redirect made, so an embed's picture is answered at the app's redirect, once it is seen to
 * point at DeviantArt. */
async function routeImages(page) {
  await page.route(/^https:\/\/(www\.artic\.edu|ids\.si\.edu)\//, route => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  // Asked through the page's own API client, not route.fetch(), which WebKit lets follow the redirect regardless.
  // A picture can still be loading as the test ends and closes the page (or its browser, which can say so before the
  // page knows it is closed): that request is let go, not a failure.
  await page.route(/\/api\/index\.php\?a=file&/, async route => {
    let res;
    try { res = await page.request.get(route.request().url(), { maxRedirects: 0 }); } catch (err) { if (page.isClosed() || /has been closed/.test(err.message)) return; throw err; }
    if (res.status() === 302 && /^https:\/\/[a-z0-9-]+\.wixmp\.com\//.test(res.headers().location)) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    return route.fulfill({ response: res });
  });
}

test.describe("Find Image API", () => {
  test("each source lists its results in one shape, and says which are openly licensed", async ({ page, browser }) => {
    const { cid, pp } = await setup(page, browser, "Search");
    const ov = await search(page, cid, "openverse", "ruined keep");
    expect(ov.status, JSON.stringify(ov.json)).toBe(200);
    expect(ov.json.results.map(r => [r.id, r.open, r.license])).toEqual([[OV_OPEN, true, "CC BY-SA 4.0"], [OV_NC, false, "CC BY-NC 2.0"], [OV_BIG, true, "CC0 1.0"]]);
    expect(ov.json.results[0]).toMatchObject({ source: "openverse", title: "Ruined keep at dusk", author: "Ann Photo", author_url: "https://www.flickr.com/photos/ann",
      license_url: "https://creativecommons.org/licenses/by-sa/4.0/", landing_url: "https://www.flickr.com/photos/ann/1", via: "Flickr" });
    expect(ov.json.results[0].full).toBeUndefined();          // the full picture's address stays on the server

    const mu = await search(page, cid, "museums", "armour");
    // taken in turn; the Met's, Cleveland's and the Smithsonian's works that aren't public domain are left out
    expect(mu.json.results.map(r => [r.id, r.via, r.open])).toEqual([["aic:27992", "Art Institute of Chicago", true], ["met:436535", "The Met", true],
      ["cma:1517", "Cleveland Museum of Art", true], ["si:edanmdm-nmah_1", "Smithsonian", true], ["eu:/90402/SK_A_1505", "Rijksmuseum (Europeana)", true],
      ["eu:/2048/item_77", "SMK - Statens Museum for Kunst (Europeana)", true]]);
    expect(mu.json.results[2]).toMatchObject({ title: "Helmet for the joust", author: "Kolman Helmschmid", license: "CC0 1.0", landing_url: "https://clevelandart.org/art/1916.1517" });
    expect(mu.json.results[4]).toMatchObject({ title: "Portrait of a Knight", author: "Frans Hals", license: "Public Domain Mark 1.0", landing_url: "https://www.europeana.eu/item/90402/SK_A_1505" });
    expect(mu.json.results[5]).toMatchObject({ license: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/" });
    expect(mu.json.results[3]).toMatchObject({ title: "Suit of armor", author: "Unknown armorer", license: "CC0 1.0",
      thumb: "https://ids.si.edu/ids/deliveryService?id=NMAH-edanmdm-nmah_1&max=400", landing_url: "https://americanhistory.si.edu/collections/object/edanmdm-nmah_1" });
    expect(mu.json.results[0]).toMatchObject({ thumb: "https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/400,/0/default.jpg",
      author_url: "https://www.artic.edu/artists/35", landing_url: "https://www.artic.edu/artworks/27992" });

    // DeviantArt: by tag, the mature work left out, licences from the metadata.
    const da = await search(pp, cid, "deviantart", "Grey keep");
    expect(da.status).toBe(200);
    expect(da.json.results.map(r => [r.id, r.open, r.license])).toEqual([[DA_CC, true, "CC BY 3.0"], [DA_ARR, false, "All rights reserved"], [DA_ELSEWHERE, false, "All rights reserved"]]);
    expect(da.json.results[1]).toMatchObject({ author: "greyartist", author_url: "https://www.deviantart.com/greyartist", landing_url: "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2" });

    // Wikimedia Commons, in its search's own order, with the artist's link taken from Commons' HTML
    const co = await search(page, cid, "commons", "keep");
    expect(co.status, JSON.stringify(co.json)).toBe(200);
    expect(co.json.results.map(r => [r.id, r.open, r.license])).toEqual([["9001", true, "CC BY-SA 4.0"], ["9002", false, "GFDL"], ["9003", true, "Public domain"]]);
    expect(co.json.results[0]).toMatchObject({ title: "Ruined keep in winter", author: "Ann Walker", author_url: "https://commons.wikimedia.org/wiki/User:Ann",
      via: "Wikimedia Commons", landing_url: "https://commons.wikimedia.org/wiki/File:Ruined_keep_in_winter.jpg" });

    // Pixabay and Pexels: free under their own licences, so they may be copied
    const px = await search(page, cid, "pixabay", "castle");
    expect(px.json.results.map(r => [r.id, r.open, r.license, r.via])).toEqual([["5001", true, "Pixabay Content License", "Pixabay"], ["5002", true, "Pixabay Content License", "Pixabay"]]);
    expect(px.json.results[0]).toMatchObject({ title: "Castle, fantasy, dragon", author: "DragonPainter", author_url: "https://pixabay.com/users/DragonPainter-77/",
      license_url: "https://pixabay.com/service/license-summary/", landing_url: "https://pixabay.com/illustrations/castle-5001/" });
    const pe = await search(page, cid, "pexels", "tower");
    expect(pe.json.results).toEqual([expect.objectContaining({ id: "3003", open: true, license: "Pexels License", license_url: "https://www.pexels.com/license/",
      title: "An old stone tower by a river", author: "Pat Lens", author_url: "https://www.pexels.com/@pat", via: "Pexels" })]);

    // Game art: the set shipped with the app, best matches first, its pictures served from the app itself
    const ga = await search(page, cid, "gameart", "orc");
    expect(ga.status, JSON.stringify(ga.json)).toBe(200);
    expect(ga.json.results[0]).toMatchObject({ id: "pauliuw-orc", source: "gameart", title: "Orc", author: "pauliuw", author_url: "https://opengameart.org/users/pauliuw",
      license: "CC0 1.0", open: true, via: "OpenGameArt", landing_url: "https://opengameart.org/content/orc-portrait", thumb: "static/vendor/opengameart/pauliuw-orc.png" });
    expect(ga.json.results[0].local).toBeUndefined();
    const old = await search(page, cid, "gameart", "old woman");
    expect(old.json.results[0].title).toBe("Old woman with white hair");   // both words beat either
    expect((await page.request.get(ga.json.results[0].thumb)).status()).toBe(200);
    expect((await search(page, cid, "gameart", "zzzz")).json.results).toEqual([]);

    expect((await search(page, cid, "openverse", "nothing at all")).json.results).toEqual([]);
    expect((await search(page, cid, "elsewhere", "keep")).status).toBe(400);
    expect((await search(page, cid, "openverse", "  ")).status).toBe(400);
  });

  test("a source that is down says so, and the others still answer", async ({ page, browser }) => {
    const { cid } = await setup(page, browser, "Down");
    const r = await search(page, cid, "openverse", "broken");
    expect(r.status).toBe(502);
    expect(r.json.message).toBe("Openverse couldn't be reached just now. Try again later.");
    expect((await search(page, cid, "museums", "broken")).status).toBe(502);
    const px = await search(page, cid, "pixabay", "broken");
    expect([px.status, px.json.message]).toEqual([502, "Pixabay couldn't be reached just now. Try again later."]);
    expect((await search(page, cid, "openverse", "keep")).status).toBe(200);
  });

  test("only members search, and each may make 30 searches a minute", async ({ page, browser }) => {
    const { cid } = await setup(page, browser, "Limit");
    const outsider = await (await newContext(browser)).newPage();
    const o = person("Olaf");
    await signIn(outsider, o);
    await approve(browser, o.email);
    expect((await search(outsider, cid, "openverse", "keep")).status).toBe(403);
    // the limit counts per clock minute, so a run that crosses into the next minute starts again: of 61 searches, one minute sees more than 30
    let ok = 0, last;
    while (ok < 61 && (last = await search(page, cid, "openverse", "keep")).status === 200) ok++;
    expect(last.status).toBe(429);
    expect(ok).toBeGreaterThanOrEqual(30);
    // each source counts on its own, so All (one search of each) isn't held back by Openverse's count
    expect((await search(page, cid, "commons", "keep")).status).toBe(200);
  });

  test("Pixabay's searches are kept for a day, as its API asks", async ({ page, browser }) => {
    const { cid } = await setup(page, browser, "Cache");
    const words = `castle ${Date.now()} ${Math.random().toString(36).slice(2)}`;
    const log = path.join(os.tmpdir(), "chronicle-test-pixabay.log");
    const asked = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter(l => l === words).length;
    expect((await search(page, cid, "pixabay", words)).json.results).toHaveLength(2);
    expect((await search(page, cid, "pixabay", words)).json.results).toHaveLength(2);
    expect(asked()).toBe(1);
  });

  test("Use this picture copies an open picture with its credit; a closed one is refused", async ({ page, browser }) => {
    const { cid, pp, id } = await setup(page, browser, "Copy");
    const r = await pick(page, cid, id, { source: "openverse", id: OV_OPEN });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.file).toMatchObject({ kind: "image", mime: "image/png", name: "Ruined keep at dusk.png", width: 2, height: 1, embed: null,
      credit: { title: "Ruined keep at dusk", author: "Ann Photo", author_url: "https://www.flickr.com/photos/ann", license: "CC BY-SA 4.0",
        license_url: "https://creativecommons.org/licenses/by-sa/4.0/", source: "Flickr", source_url: "https://www.flickr.com/photos/ann/1" } });
    const img = await page.request.get(r.json.file.url);
    expect(img.status()).toBe(200);
    expect(Buffer.compare(await img.body(), PNG)).toBe(0);

    const nc = await pick(page, cid, id, { source: "openverse", id: OV_NC });
    expect(nc.status).toBe(403);
    expect(nc.json.error).toBe("not_open");
    expect((await pick(page, cid, id, { source: "deviantart", id: DA_ARR })).status).toBe(403);
    expect((await pick(page, cid, id, { source: "openverse", id: "44444444-4444-4444-4444-444444444444" })).status).toBe(404);

    // Past the size limit the thumbnail is kept instead; museums and CC DeviantArt works copy too; players may pick.
    const big = await pick(page, cid, id, { source: "openverse", id: OV_BIG });
    expect(big.status, JSON.stringify(big.json)).toBe(200);
    expect(big.json.file.size).toBe(PNG.length);
    expect((await pick(page, cid, id, { source: "museums", id: "met:436535" })).json.file.credit).toMatchObject({ license: "CC0 1.0", source: "The Met", author: "Jacob Halder" });
    expect((await pick(page, cid, id, { source: "museums", id: "si:edanmdm-nmah_1" })).json.file.credit).toMatchObject({ license: "CC0 1.0", source: "Smithsonian", title: "Suit of armor" });
    expect((await pick(page, cid, id, { source: "museums", id: "cma:1517" })).json.file.credit).toMatchObject({ license: "CC0 1.0", source: "Cleveland Museum of Art", title: "Helmet for the joust" });
    expect((await pick(page, cid, id, { source: "museums", id: "eu:/90402/SK_A_1505" })).json.file.credit).toMatchObject({ license: "Public Domain Mark 1.0", source: "Rijksmuseum (Europeana)", author: "Frans Hals" });
    expect((await pick(page, cid, id, { source: "commons", id: "9001" })).json.file.credit).toMatchObject({ license: "CC BY-SA 4.0", source: "Wikimedia Commons", author: "Ann Walker",
      source_url: "https://commons.wikimedia.org/wiki/File:Ruined_keep_in_winter.jpg" });
    expect((await pick(page, cid, id, { source: "commons", id: "9002" })).status).toBe(403);   // GFDL only
    expect((await pick(page, cid, id, { source: "pixabay", id: "5001" })).json.file.credit).toMatchObject({ license: "Pixabay Content License", source: "Pixabay", author: "DragonPainter",
      license_url: "https://pixabay.com/service/license-summary/" });
    expect((await pick(page, cid, id, { source: "pexels", id: "3003" })).json.file.credit).toMatchObject({ license: "Pexels License", source: "Pexels", author: "Pat Lens" });
    expect((await pick(page, cid, id, { source: "pixabay", id: "999" })).status).toBe(404);
    const ga = await pick(page, cid, id, { source: "gameart", id: "battler-fiellangue" });
    expect(ga.status, JSON.stringify(ga.json)).toBe(200);
    expect(ga.json.file).toMatchObject({ kind: "image", mime: "image/png", credit: { title: "Fiellangue, a lightning serpent", author: "gilgaphoenixignis",
      license: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0/", source: "OpenGameArt", source_url: "https://opengameart.org/content/painted-battlers-pack" } });
    expect((await pick(page, cid, id, { source: "gameart", id: "../index" })).status).toBe(404);
    const mine = await pick(pp, cid, id, { source: "deviantart", id: DA_CC, is_secret: true });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    expect(mine.json.file).toMatchObject({ is_secret: false, credit: { license: "CC BY 3.0", source: "DeviantArt", author: "mistpainter" } });
  });

  test("players can't pick pictures for a GM-only entry; a GM's GM-only pick stays from players", async ({ page, browser }) => {
    const { cid, pp, id } = await setup(page, browser, "Secret");
    const s = await api(page, "entry_save", { name: "The Hidden Vault", is_secret: true }, cid);
    expect((await pick(pp, cid, s.json.id, { source: "openverse", id: OV_OPEN })).status).toBe(404);
    const hidden = await pick(page, cid, id, { source: "openverse", id: OV_OPEN, is_secret: true });
    expect(hidden.json.file.is_secret).toBe(true);
    expect((await pp.request.get(hidden.json.file.url)).status()).toBe(404);
  });

  test("Embed from DeviantArt keeps only the link and sends the browser to DeviantArt's picture, asked again after 6 hours", async ({ page, browser }) => {
    const { cid, pp, id } = await setup(page, browser, "Embed");
    const r = await pick(page, cid, id, { source: "deviantart", id: DA_ARR, mode: "embed" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.file).toMatchObject({ kind: "embed", size: 0, embed: { url: "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2", gone: false },
      credit: { title: "The Grey Keep", author: "greyartist", license: "All rights reserved", source: "DeviantArt" } });
    const first = await pp.request.get(r.json.file.url, { maxRedirects: 0 });
    expect(first.status()).toBe(302);
    const loc = first.headers().location;
    expect(loc).toMatch(/^https:\/\/images-wixmp-stub\.wixmp\.com\/f\/keep\.png\?token=/);
    expect((await pp.request.get(r.json.file.url, { maxRedirects: 0 })).headers().location).toBe(loc);   // within 6 hours: the same

    sql(`UPDATE attachments SET embed_checked_at = NOW() - INTERVAL 7 HOUR WHERE id = ${r.json.file.id}`);
    const later = await pp.request.get(r.json.file.url, { maxRedirects: 0 });
    expect(later.status()).toBe(302);
    expect(later.headers().location).not.toBe(loc);

    // Once oEmbed no longer knows the work, the picture is gone.
    sql(`UPDATE attachments SET embed_url = 'https://www.deviantart.com/greyartist/art/Gone-2', embed_checked_at = NOW() - INTERVAL 7 HOUR WHERE id = ${r.json.file.id}`);
    expect((await pp.request.get(r.json.file.url, { maxRedirects: 0 })).status()).toBe(404);
    const list = await pp.request.get(`api/index.php?${new URLSearchParams({ a: "files", cid, parent_type: "encyclopedia", parent_id: id })}`);
    expect((await list.json()).files[0].embed.gone).toBe(true);

    // An oEmbed picture somewhere other than DeviantArt's own hosts is refused, and only DeviantArt embeds.
    expect((await pick(page, cid, id, { source: "deviantart", id: DA_ELSEWHERE, mode: "embed" })).status).toBe(422);
    expect((await pick(page, cid, id, { source: "openverse", id: OV_OPEN, mode: "embed" })).status).toBe(400);

    // When oEmbed can't be reached, the deviation's own picture from the API is shown until the next recheck.
    const offline = await pick(page, cid, id, { source: "deviantart", id: "A1B2C3D4-0000-0000-0000-000000000005", mode: "embed" });
    expect(offline.status, JSON.stringify(offline.json)).toBe(200);
    expect((await pp.request.get(offline.json.file.url, { maxRedirects: 0 })).headers().location).toBe("https://images-wixmp-stub.wixmp.com/f/offline.png?token=api");
  });
});

// The service worker would see the page's requests for pictures first, and in WebKit page.route() then never fakes them.
test.describe("Find Image panel", () => {
  test.use({ serviceWorkers: "block" });

  test("opens with the entry's name, lists each tab's pictures with their credits, and adds the one picked", async ({ page, browser }) => {
    const errors = watchErrors(page);
    await routeImages(page);
    const { cid, id } = await setup(page, browser, "Panel");
    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    const box = page.locator(".enc-detail .enc-files");
    // The pictures come after the notes and connections, just before Mentioned in.
    await expect(page.locator(".enc-detail .enc-mentioned")).toBeVisible();
    expect(await page.locator(".enc-detail").evaluate(d => {
      const files = d.querySelector(".enc-files"), before = n => !!(n.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [...d.querySelectorAll(".notepanel")].every(before) && before(d.querySelector(".enc-conn, .enc-connections") || d.querySelector(".notepanel"))
        && !before(d.querySelector(".enc-mentioned"));
    })).toBe(true);
    await box.getByRole("button", { name: "Find Image" }).click();
    const panel = box.locator(".find-image");
    await expect(panel.getByRole("searchbox", { name: "Search for pictures" })).toHaveValue("Greywater Keep");
    const where = panel.getByRole("combobox", { name: "Where to search" });
    await expect(where).toHaveValue("all");
    await where.selectOption("openverse");
    const results = panel.locator(".find-result");
    await expect(results).toHaveCount(3);
    const first = results.first();
    await expect(first).toContainText("Ruined keep at dusk");
    await expect(first.getByRole("link", { name: "Ann Photo" })).toHaveAttribute("href", "https://www.flickr.com/photos/ann");
    await expect(first.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
    await expect(first.getByRole("link", { name: "Flickr" })).toHaveAttribute("target", "_blank");
    await expect(results.nth(1).getByRole("button", { name: "Use this picture" })).toHaveCount(0);
    await expect(results.nth(1)).toContainText("Not openly licensed");

    await first.getByRole("button", { name: "Use this picture" }).click();
    await expect(page.getByText("Picture added")).toBeVisible();
    const fig = page.locator(".enc-detail .enc-files .file-pic");
    await expect(fig).toHaveCount(1);
    // Under the picture the credit is only a "?" to hover or tap; the picture at full size has it with its links.
    await expect(fig.locator(".file-credit")).toHaveCount(0);
    await expect(fig.locator("figcaption")).toHaveCount(0);
    await expect(fig.locator(".tip")).toHaveAttribute("data-tip", /^Ruined keep at dusk\.png\nRuined keep at dusk by Ann Photo, CC BY-SA 4\.0, via Flickr\./);
    await fig.locator(".file-thumb").click();
    const credit = page.locator("dialog.file-viewer .file-credit");
    await expect(credit).toContainText("Ruined keep at dusk by Ann Photo, CC BY-SA 4.0, via Flickr");
    await expect(credit.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.file-viewer")).toHaveCount(0);

    // Changing the words searches again; Museums and an empty search.
    const box2 = page.locator(".enc-detail .enc-files");
    await box2.getByRole("button", { name: "Find Image" }).click();
    const panel2 = box2.locator(".find-image");
    await panel2.getByRole("combobox", { name: "Where to search" }).selectOption("museums");
    await expect(panel2.locator(".find-result")).toHaveCount(6);
    await panel2.getByRole("searchbox").fill("nothing here");
    await panel2.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel2).toContainText('Nothing found for "nothing here".');
    await panel2.getByRole("searchbox").fill("");
    await panel2.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel2).toContainText("Type something to search for.");
    expectNoErrors(errors);
  });

  test("a DeviantArt work that isn't openly licensed links to the work and the artist, and can be embedded", async ({ page, browser }) => {
    const errors = watchErrors(page);
    await routeImages(page);
    const { cid, id } = await setup(page, browser, "Deviant");
    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    const box = page.locator(".enc-detail .enc-files");
    await box.getByRole("button", { name: "Find Image" }).click();
    const panel = box.locator(".find-image");
    await panel.getByRole("combobox", { name: "Where to search" }).selectOption("deviantart");
    const grey = panel.locator(".find-result", { hasText: "The Grey Keep" });
    await expect(grey).toBeVisible();
    await expect(grey.getByRole("button", { name: "Use this picture" })).toHaveCount(0);
    const work = grey.getByRole("link", { name: "View on DeviantArt" });
    await expect(work).toHaveAttribute("href", "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2");
    await expect(work).toHaveAttribute("target", "_blank");
    await expect(grey.getByRole("link", { name: "Artist's page" })).toHaveAttribute("href", "https://www.deviantart.com/greyartist");
    await expect(panel.locator(".find-result", { hasText: "Keep in the mist" }).getByRole("button", { name: "Use this picture" })).toBeVisible();

    await grey.getByRole("button", { name: "Embed from DeviantArt" }).click();
    await expect(page.getByText("Picture added")).toBeVisible();
    const fig = page.locator(".enc-detail .enc-files .file-pic");
    await expect(fig).toHaveCount(1);
    await expect(fig.locator(".tip")).toHaveAttribute("data-tip", /\nEmbedded: shown from DeviantArt each time.*\nThe Grey Keep by greyartist on DeviantArt\./);
    await expect.poll(() => fig.locator("img").evaluate(img => img.complete && img.naturalWidth)).toBe(2);
    await fig.locator(".file-thumb").click();
    const viewer = page.locator("dialog.file-viewer");
    await expect(viewer.getByRole("link", { name: "View on DeviantArt" })).toHaveAttribute("href", "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2");
    await expect(viewer.getByRole("link", { name: "Download" })).toHaveCount(0);
    expectNoErrors(errors);
  });
  test("All searches every source at once and mixes their pictures, naming one that can't be reached", async ({ page, browser }) => {
    const errors = watchErrors(page);
    await routeImages(page);
    const { cid, id } = await setup(page, browser, "All");
    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    const box = page.locator(".enc-detail .enc-files");
    await box.getByRole("button", { name: "Find Image" }).click();
    const panel = box.locator(".find-image");
    // 3 from Openverse, 3 from Commons, 2 from Pixabay, 6 from the museums, 1 from Pexels and 3 from DeviantArt (no game art is called "Greywater Keep")
    const results = panel.locator(".find-result");
    await expect(results).toHaveCount(18);
    await expect(panel).not.toContainText("Still looking");
    // taken in turn, the first of each source first
    await expect(results.nth(0)).toContainText("Ruined keep at dusk");
    await expect(results.nth(1)).toContainText("Ruined keep in winter");
    await expect(results.nth(2)).toContainText("Castle, fantasy, dragon");
    await expect(panel.locator(".find-credits").getByRole("link", { name: "Pictures from Pixabay" })).toHaveAttribute("href", "https://pixabay.com/");
    await expect(panel.locator(".find-credits").getByRole("link", { name: "Photos provided by Pexels" })).toHaveAttribute("href", "https://www.pexels.com/");
    const pexels = panel.locator(".find-result", { hasText: "An old stone tower by a river" });
    await pexels.getByRole("button", { name: "Use this picture" }).click();
    await expect(page.getByText("Picture added")).toBeVisible();
    await expect(page.locator(".enc-detail .enc-files .file-pic .tip")).toHaveAttribute("data-tip", /An old stone tower by a river by Pat Lens, Pexels License, via Pexels\./);

    // A source that is down is named; the rest still show.
    const box2 = page.locator(".enc-detail .enc-files");
    await box2.getByRole("button", { name: "Find Image" }).click();
    const panel2 = box2.locator(".find-image");
    await panel2.getByRole("searchbox").fill("broken");
    await panel2.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel2.locator(".find-down")).toHaveText(/^Couldn't reach .*Pixabay.* just now\.$/);
    await panel2.getByRole("searchbox").fill("nothing here");
    await panel2.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel2).toContainText('Nothing found for "nothing here".');
    expectNoErrors(errors.filter(e => !/status of 502/.test(e)));
  });

  test("Game art finds the pictures shipped with the app, and copies one with its credit", async ({ page, browser }) => {
    const errors = watchErrors(page);
    await routeImages(page);   // the panel opens on All, museums included
    const { cid, id } = await setup(page, browser, "Game art");
    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    const box = page.locator(".enc-detail .enc-files");
    await box.getByRole("button", { name: "Find Image" }).click();
    const panel = box.locator(".find-image");
    await panel.getByRole("combobox", { name: "Where to search" }).selectOption("gameart");
    await panel.getByRole("searchbox").fill("cyberpunk woman");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    const first = panel.locator(".find-result").first();
    await expect(first).toContainText("by Hyptosis");
    await first.locator("img").scrollIntoViewIfNeeded();   // thumbnails load lazily, and on a phone it starts below the fold
    await expect.poll(() => first.locator("img").evaluate(i => i.complete && i.naturalWidth)).toBe(192);
    await expect(first.getByRole("link", { name: "OpenGameArt" })).toHaveAttribute("href", "https://opengameart.org/content/cyberpunk-portraits");
    await first.getByRole("button", { name: "Use this picture" }).click();
    await expect(page.getByText("Picture added")).toBeVisible();
    await expect(page.locator(".enc-detail .enc-files .file-pic .tip")).toHaveAttribute("data-tip", /by Hyptosis, CC0 1\.0, via OpenGameArt\./);
    expectNoErrors(errors);
  });

  test("a linked entry name shows the entry's first picture with its tooltip, and a GM-only picture only to GMs", async ({ page, browser, isMobile }) => {
    const errors = watchErrors(page);
    const { cid, id, pp } = await setup(page, browser, "Hover");
    const camp = async p => (await p.request.get(`api/index.php?${new URLSearchParams({ a: "campaign", cid })}`)).json();
    expect((await camp(page)).encyclopedia.find(e => e.id === id).pic).toBeNull();
    const secret = await pick(page, cid, id, { source: "museums", id: "met:436535", is_secret: 1 });
    expect(secret.status, JSON.stringify(secret.json)).toBe(200);
    expect((await camp(page)).encyclopedia.find(e => e.id === id).pic).toContain(`id=${secret.json.file.id}`);
    expect((await camp(pp)).encyclopedia.find(e => e.id === id).pic).toBeNull();
    const open = await pick(page, cid, id, { source: "openverse", id: OV_OPEN });
    expect((await camp(pp)).encyclopedia.find(e => e.id === id).pic).toContain(`id=${open.json.file.id}`);

    // Touch screens have no hover, and a tap on a link follows it, so the picture is a mouse's alone.
    if (isMobile) return expectNoErrors(errors);
    const other = await api(page, "entry_save", { name: "Old Ferry", notes: "<p>It crosses below Greywater Keep.</p>" }, cid);
    await page.goto(`index.html#/c/${cid}/encyclopedia/${other.json.id}`);
    const link = page.locator(".enc-detail .notepanel a.enc-link", { hasText: "Greywater Keep" });
    await expect(link).toHaveAttribute("data-tip-img", new RegExp(`id=${secret.json.file.id}$`));
    // Tooltips follow the mouse only where the browser says it can hover, which headless Firefox may not.
    if (!await page.evaluate(() => matchMedia("(hover: hover)").matches)) return expectNoErrors(errors);
    await page.locator(".enc-detail .enc-mentioned h4 .tip").waitFor();
    await link.hover();
    const img = page.locator("#tipbox.show img");
    await expect(img).toHaveAttribute("src", new RegExp(`id=${secret.json.file.id}$`));
    await expect.poll(() => img.evaluate(i => i.complete && i.naturalWidth)).toBe(2);
    await expect(page.locator("#tipbox")).toContainText("Greywater Keep");
    expectNoErrors(errors);
  });
});
