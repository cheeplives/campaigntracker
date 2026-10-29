// Fan wikis (api/fanwikis.php, static/fanwikis.js): the GM picks the campaign's fan wiki in Settings, an Encyclopedia
// entry adds a credited summary from it, Find Image gets a tab for its pictures, and the About page lists every wiki.
// tests/support/fanwiki-stub.php answers for Wookieepedia (CC BY-SA), Memory Alpha (CC BY-NC) and Greyhawk Online
// (no licence stated), and nothing leaves the machine.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);
const fs = require("fs");
const path = require("path");
// Once tools/fanwiki-kill-switch.sh --non-open has removed the non-open wikis and fair-use pictures, what needs them is skipped.
const NONOPEN = fs.existsSync(path.join(__dirname, "..", "..", "api", "fanwikis-nonopen.php"));

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
  const r = await api(page, "entry_save", { name: "Luke Skywalker", notes: "" }, cid);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { cid, pp, id: r.json.id };
}
async function get(page, action, params) {
  const res = await page.request.get(`api/index.php?${new URLSearchParams({ a: action, ...params })}`);
  return { status: res.status(), json: res.headers()["content-type"]?.includes("json") ? await res.json() : null, res };
}

test.describe("Fan wikis API", () => {
  test("lists the wikis to anyone, each with its licence, open ones apart from the rest", async ({ page }) => {
    const { status, json } = await get(page, "fanwiki_wikis", {});
    expect(status).toBe(200);
    expect(json).toMatchObject({ enabled: true, open_only: !NONOPEN });
    const by = Object.fromEntries(json.wikis.map(w => [w.key, w]));
    expect(by.starwars).toMatchObject({ name: "Wookieepedia", settings: ["Star Wars"], host: "Fandom", license: "CC BY-SA 3.0", open: true, site: "https://starwars.fandom.com/" });
    expect(by.tolkiengateway).toMatchObject({ license: "CC BY-SA 4.0", open: true });
    expect(by.sarna).toMatchObject({ license: "GNU FDL 1.2", open: true });
    // settings added later: each has its own Fandom wiki, under Fandom's CC BY-SA default
    for (const [key, setting] of [["blades-in-the-dark", "Blades in the Dark"], ["deadlands", "Deadlands"], ["avp", "Alien"], ["alienanthology", "Alien"], ["l5r", "Legend of the Five Rings"],
      ["ironkingdoms", "Iron Kingdoms"], ["ravenloft", "Ravenloft"], ["dune", "Dune"], ["witcher", "The Witcher"]])
      expect(by[key], key).toMatchObject({ settings: [setting], host: "Fandom", license: "CC BY-SA 3.0", open: true, site: `https://${key}.fandom.com/` });
    if (!NONOPEN) return expect(json.wikis.every(w => w.open)).toBe(true);
    expect(by.eclipsephaserules).toMatchObject({ settings: ["Eclipse Phase"], license: "CC BY-NC-SA 4.0", open: false });
    expect(by["memory-alpha"]).toMatchObject({ license: "CC BY-NC 4.0", open: false });
    expect(by.greyhawkonline).toMatchObject({ license: null, open: false });
    expect(by.traveller.note).toMatch(/Mongoose/);
  });

  test("text: articles matching the name, then the opening paragraphs with the licence each wiki states", async ({ page, browser }) => {
    const { cid, pp } = await setup(page, browser, "Text");
    const s = await get(page, "fanwiki_search", { cid, wiki: "starwars", q: "Luke" });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.hits).toEqual([{ page: "Luke Skywalker", title: "Luke Skywalker", line: "Luke Skywalker was a Jedi" }, { page: "Luke Skywalker (clone)", title: "Luke Skywalker (clone)", line: "A clone" }]);
    // the infobox, the footnote mark and the table are left out; Fandom's "CC-BY-SA" keeps the list's version
    const sw = await get(pp, "fanwiki_summary", { cid, wiki: "starwars", page: "Luke Skywalker" });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    expect(sw.json).toEqual({ title: "Luke Skywalker", url: "https://starwars.fandom.com/wiki/Luke_Skywalker", wiki: "Wookieepedia",
      paragraphs: ["Luke Skywalker was a Force-sensitive human male who served as a Jedi Master. He grew up on Tatooine.",
        "He later rebuilt the Jedi Order, and trained a new generation of Jedi on the planet Yavin 4."],
      license: "CC BY-SA 3.0", license_url: "https://creativecommons.org/licenses/by-sa/3.0/", fair_use: false, note: null });
    // non-commercial: named as such
    if (NONOPEN) {
      const ma = await get(page, "fanwiki_summary", { cid, wiki: "memory-alpha", page: "Stardate" });
      expect(ma.json).toMatchObject({ license: "CC BY-NC 4.0, non-commercial use", license_url: "https://creativecommons.org/licenses/by-nc/4.0/", fair_use: false });
      // no licence stated (and its api.php found from its main page): personal fair use
      const gh = await get(page, "fanwiki_summary", { cid, wiki: "greyhawkonline", page: "Castle Greyhawk" });
      expect(gh.status, JSON.stringify(gh.json)).toBe(200);
      expect(gh.json).toMatchObject({ url: "https://greyhawkonline.com/wiki/Castle_Greyhawk", license: "personal fair use (no open licence)", license_url: null, fair_use: true });
    }

    expect((await get(page, "fanwiki_summary", { cid, wiki: "starwars", page: "Nobody" })).status).toBe(404);
    expect((await get(page, "fanwiki_search", { cid, wiki: "nowhere", q: "Luke" })).status).toBe(400);
    expect((await get(page, "fanwiki_search", { cid, wiki: "starwars", q: " " })).status).toBe(400);
    const down = await get(page, "fanwiki_search", { cid, wiki: "starwars", q: "broken" });
    expect(down.status).toBe(502);
    expect(down.json.message).toMatch(/^Wookieepedia couldn't be reached just now/);
    // only the campaign's members
    const outsider = await browser.newPage();
    const o = person("Olly");
    await signIn(outsider, o);
    await approve(browser, o.email);
    expect((await get(outsider, "fanwiki_search", { cid, wiki: "starwars", q: "Luke" })).status).toBe(403);
  });

  test("pictures: open ones copied with their credit, the rest kept as personal fair use, thumbnails through the server", async ({ page, browser }) => {
    const { cid, id } = await setup(page, browser, "Pictures");
    const r = await get(page, "fanwiki_images", { cid, wiki: "starwars", q: "Luke" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // the article's pictures first, then matching files; the sound file is left out
    expect(r.json.results.map(i => [i.id, i.open, i.fair_use, i.license])).toEqual([
      NONOPEN ? ["starwars|File:Luke promo.png", false, true, "Personal fair use, not openly licensed"] : null,
      ["starwars|File:X-wing fan drawing.png", true, false, "CC BY-SA"],
    ].filter(Boolean));
    const xwing = r.json.results.find(i => i.title === "X-wing fan drawing");
    expect(xwing).toMatchObject({ source: "fanwiki", title: "X-wing fan drawing", author: "Ann", via: "Wookieepedia",
      landing_url: "https://starwars.fandom.com/wiki/File:X-wing_fan_drawing.png" });
    expect(xwing.full).toBeUndefined();
    const thumb = xwing.thumb;
    expect(thumb).toMatch(/^api\/index\.php\?a=fanwiki_thumb&wiki=starwars&src=/);
    const t = await page.request.get(thumb);
    expect(t.status()).toBe(200);
    expect(t.headers()["content-type"]).toBe("image/png");
    // a thumbnail from anywhere else is refused
    expect((await get(page, "fanwiki_thumb", { wiki: "starwars", src: "https://evil.test/x.png" })).status).toBe(400);

    const pick = picture => api(page, "image_import", { parent_type: "encyclopedia", parent_id: id, source: "fanwiki", id: picture, mode: "copy" }, cid);
    const open = await pick("starwars|File:X-wing fan drawing.png");
    expect(open.status, JSON.stringify(open.json)).toBe(200);
    expect(open.json.file.credit).toMatchObject({ title: "X-wing fan drawing", author: "Ann", license: "CC BY-SA", source: "Wookieepedia",
      source_url: "https://starwars.fandom.com/wiki/File:X-wing_fan_drawing.png" });
    const fair = await pick("starwars|File:Luke promo.png");
    if (!NONOPEN) expect(fair.status).toBe(404);
    else expect(fair.json.file.credit).toMatchObject({ title: "Luke promo", license: "Personal fair use, not openly licensed", license_url: null, source: "Wookieepedia" });
    expect((await pick("starwars|File:Nothing.png")).status).toBe(404);
    expect((await pick("nowhere|File:Luke promo.png")).status).toBe(404);
  });
});

test.describe("Fan wikis in the app", () => {
  test("the GM picks the campaign's wiki in Settings, and an entry adds its summary with the source and licence", async ({ page, browser }) => {
    const errors = watchErrors(page);
    const { cid, id, pp } = await setup(page, browser, "Settings");
    await page.goto(`index.html#/c/${cid}/settings`);
    const pickWiki = page.getByRole("combobox", { name: "Fan wiki" });
    if (NONOPEN) await expect(pickWiki.locator("optgroup[label='Star Trek'] option")).toHaveText(["Memory Alpha (not open)", "Memory Beta (not open)"]);
    await expect(pickWiki).toHaveValue("none");          // nothing in the name or calendar to guess from
    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    await expect(page.getByRole("button", { name: "📚 Generate Summary" })).toBeVisible();
    await expect(page.locator(".fanwiki")).toHaveCount(0);   // no fan wiki yet: no button
    await page.goto(`index.html#/c/${cid}/settings`);
    await pickWiki.selectOption("starwars");
    await page.getByRole("button", { name: "Save campaign settings" }).click();
    await expect(page.locator("#toast", { hasText: "Saved" })).toBeVisible();
    expect((await api(page, "campaign", undefined, cid)).json.campaign.settings.fan_wiki).toBe("starwars");

    await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    const form = page.locator(".enc-form"), box = form.locator(".fanwiki");
    await box.getByRole("button", { name: "🗂️ Summary from Wookieepedia" }).click();
    await expect(box.locator(".enc-wiki-hit strong")).toHaveText(["Luke Skywalker", "Luke Skywalker (clone)"]);
    await box.locator(".enc-wiki-hit").first().click();
    await expect(box.locator("blockquote")).toContainText("He grew up on Tatooine.");
    await expect(box.locator(".fanwiki-terms")).toContainText("Licence: CC BY-SA 3.0");
    await box.getByRole("button", { name: "Add to notes" }).click();
    const editor = form.locator(".notepanel.public .ql-editor");
    await expect(editor).toContainText("He later rebuilt the Jedi Order");
    await expect(editor).toContainText("Source: Luke Skywalker, Wookieepedia, CC BY-SA 3.0");
    await expect(editor.locator("a")).toHaveAttribute("href", "https://starwars.fandom.com/wiki/Luke_Skywalker");

    // Find Image has a tab for the wiki; a picture that isn't open can only be kept as personal fair use
    if (NONOPEN) {
      await page.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
      await page.getByRole("button", { name: "🖼️ Find Image" }).click();
      await page.getByRole("tab", { name: "Wookieepedia" }).click();
      const promo = page.locator(".find-result", { hasText: "Luke promo" });
      await expect(promo).toContainText("Personal fair use, not openly licensed");
      await expect(page.locator(".find-result", { hasText: "X-wing fan drawing" }).getByRole("button", { name: "Use this picture" })).toBeVisible();
      await promo.getByRole("button", { name: "Keep as personal fair use" }).click();
      await expect(page.getByText("Picture added")).toBeVisible();
      await expect(page.getByRole("button", { name: /Luke promo, Personal fair use, not openly licensed, via Wookieepedia/ })).toBeVisible();
    }

    // the player gets the GM's pick too
    await pp.goto(`index.html#/c/${cid}/encyclopedia/${id}`);
    await expect(pp.locator(".fanwiki").getByRole("button", { name: "🗂️ Summary from Wookieepedia" })).toBeVisible();
    expectNoErrors(errors);
  });

  test("Settings suggests a wiki from the campaign's name, used only once saved, and None keeps a game of its own wiki-free", async ({ page, browser }) => {
    test.skip(!NONOPEN, "Memory Alpha is a non-open wiki");
    const gm = person("Gwen");
    await signIn(page, gm);
    await approve(browser, gm.email);
    const cid = await makeCampaign(page, `Star Trek: Lower Decks ${gm.id}`);
    const e = (await api(page, "entry_save", { name: "Stardate", notes: "" }, cid)).json;
    // nothing saved yet: no fan wiki button, though Settings offers Memory Alpha
    await page.goto(`index.html#/c/${cid}/encyclopedia/${e.id}`);
    await expect(page.getByRole("button", { name: "📚 Generate Summary" })).toBeVisible();
    await expect(page.locator(".fanwiki")).toHaveCount(0);
    await page.goto(`index.html#/c/${cid}/settings`);
    const pickWiki = page.getByRole("combobox", { name: "Fan wiki" });
    await expect(pickWiki).toHaveValue("memory-alpha");
    await page.getByRole("button", { name: "Save campaign settings" }).click();
    await expect(page.locator("#toast", { hasText: "Saved" })).toBeVisible();
    await page.goto(`index.html#/c/${cid}/encyclopedia/${e.id}`);
    const box = page.locator(".fanwiki");
    await box.getByRole("button", { name: "🗂️ Summary from Memory Alpha" }).click();
    await box.locator(".enc-wiki-hit").first().click();
    await expect(box.locator(".fanwiki-terms")).toContainText("CC BY-NC 4.0, non-commercial use");
    // None, for a game of its own: no button and no Find Image tab, and Settings keeps None
    await page.goto(`index.html#/c/${cid}/settings`);
    await pickWiki.selectOption("none");
    await page.getByRole("button", { name: "Save campaign settings" }).click();
    await expect(page.locator("#toast", { hasText: "Saved" })).toBeVisible();
    expect((await api(page, "campaign", undefined, cid)).json.campaign.settings.fan_wiki).toBe("none");
    await page.goto(`index.html#/c/${cid}/encyclopedia/${e.id}`);
    await expect(page.getByRole("button", { name: "📚 Generate Summary" })).toBeVisible();
    await expect(page.locator(".fanwiki")).toHaveCount(0);
    await page.goto(`index.html#/c/${cid}/settings`);
    await expect(pickWiki).toHaveValue("none");
  });

  test("the About page lists every fan wiki, the ones that aren't open under No open source", async ({ page }) => {
    await page.goto("index.html#/about");
    const used = page.locator("li", { hasText: "Summary from a fan wiki and Find Image" });
    await expect(used.getByRole("link", { name: "Wookieepedia" })).toHaveAttribute("href", "https://starwars.fandom.com/");
    await expect(used.getByRole("link", { name: "Tolkien Gateway" })).toBeVisible();
    await expect(used.getByRole("link", { name: "Memory Alpha" })).toHaveCount(0);
    if (!NONOPEN) return;
    const closed = page.locator("li", { hasText: "Fan wikis that are not openly licensed" });
    await expect(closed.getByRole("link", { name: "Memory Alpha" })).toBeVisible();
    await expect(closed).toContainText("Greyhawk (no licence stated)");
    await expect(closed).toContainText("personal fair use");
  });
});
