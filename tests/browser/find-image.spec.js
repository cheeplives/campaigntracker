// Find Image on Encyclopedia entries: the server searches Openverse, two museums and DeviantArt (here
// tests/support/image-stub.php answers for them), copies only openly licensed pictures, credited, and embeds other
// DeviantArt works without copying them.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAD0lEQVQImWNgYGBgYGAAAAAHAAHV3tbYAAAAAElFTkSuQmCC", "base64");
const OV_OPEN = "11111111-1111-1111-1111-111111111111", OV_NC = "22222222-2222-2222-2222-222222222222", OV_BIG = "33333333-3333-3333-3333-333333333333";
const DA_CC = "A1B2C3D4-0000-0000-0000-000000000001", DA_ARR = "A1B2C3D4-0000-0000-0000-000000000002", DA_ELSEWHERE = "A1B2C3D4-0000-0000-0000-000000000004";

async function setup(page, browser, label) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await browser.newContext();
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
  await page.route(/\/api\/index\.php\?a=file&/, async route => {
    const res = await page.request.get(route.request().url(), { maxRedirects: 0 });
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
    expect(mu.json.results.map(r => [r.id, r.via, r.open])).toEqual([["aic:27992", "Art Institute of Chicago", true], ["met:436535", "The Met", true],
      ["si:edanmdm-nmah_1", "Smithsonian", true]]);   // the Smithsonian's record with no CC0 picture is left out
    expect(mu.json.results[2]).toMatchObject({ title: "Suit of armor", author: "Unknown armorer", license: "CC0 1.0",
      thumb: "https://ids.si.edu/ids/deliveryService?id=NMAH-edanmdm-nmah_1&max=400", landing_url: "https://americanhistory.si.edu/collections/object/edanmdm-nmah_1" });
    expect(mu.json.results[0]).toMatchObject({ thumb: "https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/400,/0/default.jpg",
      author_url: "https://www.artic.edu/artists/35", landing_url: "https://www.artic.edu/artworks/27992" });

    // DeviantArt: by tag, the mature work left out, licences from the metadata.
    const da = await search(pp, cid, "deviantart", "Grey keep");
    expect(da.status).toBe(200);
    expect(da.json.results.map(r => [r.id, r.open, r.license])).toEqual([[DA_CC, true, "CC BY 3.0"], [DA_ARR, false, "All rights reserved"], [DA_ELSEWHERE, false, "All rights reserved"]]);
    expect(da.json.results[1]).toMatchObject({ author: "greyartist", author_url: "https://www.deviantart.com/greyartist", landing_url: "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2" });

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
    expect((await search(page, cid, "openverse", "keep")).status).toBe(200);
  });

  test("only members search, and each may make 30 searches a minute", async ({ page, browser }) => {
    const { cid } = await setup(page, browser, "Limit");
    const outsider = await (await browser.newContext()).newPage();
    const o = person("Olaf");
    await signIn(outsider, o);
    await approve(browser, o.email);
    expect((await search(outsider, cid, "openverse", "keep")).status).toBe(403);
    let last;
    for (let i = 0; i < 31; i++) last = await search(page, cid, "openverse", "keep");
    expect(last.status).toBe(429);
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
    await box.getByRole("button", { name: "🖼️ Find Image" }).click();
    const panel = box.locator(".find-image");
    await expect(panel.getByRole("searchbox", { name: "Search for pictures" })).toHaveValue("Greywater Keep");
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
    const credit = fig.locator(".file-credit");
    await expect(credit).toContainText("Ruined keep at dusk by Ann Photo, CC BY-SA 4.0, via Flickr");
    await expect(credit.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");

    // Changing the words searches again; Museums and an empty search.
    const box2 = page.locator(".enc-detail .enc-files");
    await box2.getByRole("button", { name: "🖼️ Find Image" }).click();
    const panel2 = box2.locator(".find-image");
    await panel2.getByRole("tab", { name: "Museums" }).click();
    await expect(panel2.locator(".find-result")).toHaveCount(3);
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
    await box.getByRole("button", { name: "🖼️ Find Image" }).click();
    const panel = box.locator(".find-image");
    await panel.getByRole("tab", { name: "DeviantArt" }).click();
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
    await expect(fig).toContainText("Embedded");
    await expect(fig.locator(".file-credit")).toContainText("The Grey Keep by greyartist on DeviantArt");
    await expect.poll(() => fig.locator("img").evaluate(img => img.complete && img.naturalWidth)).toBe(2);
    await fig.locator(".file-thumb").click();
    const viewer = page.locator("dialog.file-viewer");
    await expect(viewer.getByRole("link", { name: "View on DeviantArt" })).toHaveAttribute("href", "https://www.deviantart.com/greyartist/art/The-Grey-Keep-2");
    await expect(viewer.getByRole("link", { name: "Download" })).toHaveCount(0);
    expectNoErrors(errors);
  });
});
