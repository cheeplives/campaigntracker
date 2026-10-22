// The Generators tab: names, taverns, companies and towns made in the browser from static/generators.js,
// with 📖 Add putting a result in the Encyclopedia (GM only by default for a GM).
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

test("every generator gives real text in every genre, and a seed repeats it", async ({ page }) => {
  await page.goto("about:blank");
  await page.addScriptTag({ path: require("path").join(__dirname, "..", "..", "static", "generators.js") });
  const bad = await page.evaluate(() => {
    const out = [];
    const check = (what, r) => {
      const text = JSON.stringify(r);
      if (!r.name || /undefined|null|NaN|\{|\}|_/.test(r.name) || /undefined|NaN/.test(text)) out.push(`${what}: ${text}`);
    };
    for (let i = 0; i < 40; i++) {
      for (const [g] of Gen.GENRES) {
        for (const [p] of [["", ""], ...Gen.PEOPLES[g]]) for (const sex of ["", "m", "f", "n"]) check(`name ${g}/${p}`, Gen.name(g, p, sex));
        check(`tavern ${g}`, Gen.tavern(g));
        for (const [s] of Gen.SECTORS) check(`company ${g}/${s}`, Gen.company(g, s));
        for (const [s] of Gen.SIZE_KEYS) {
          const t = Gen.town(g, s);
          check(`town ${g}/${s}`, t);
          if (!(t.population > 0) || t.people.length < 3 || t.places.length < 3 || t.hooks.length !== 2 || t.hooks.some(h => h.includes("{name}"))) out.push(`town ${g}/${s}: ${JSON.stringify(t)}`);
        }
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
  const twice = await page.evaluate(() => [1, 2].map(() => { Gen.seed(42); return [Gen.name("fantasy", "dwarf", "f").name, Gen.town("western", "small").name]; }));
  expect(twice[0]).toEqual(twice[1]);
  // Modern names follow each culture's own order and forms; gender-neutral names come from their own lists.
  const modern = await page.evaluate(() => {
    Gen.seed(7);
    const many = (p, g) => Array.from({ length: 60 }, () => Gen.name("modern", p, g).name);
    return { ja: many("japanese", "m"), ru: many("russian", "f"), en: many("english", "n"), peoples: Gen.PEOPLES.modern.map(([k]) => k) };
  });
  expect(modern.peoples).toEqual(["english", "spanish", "french", "german", "russian", "arabic", "indian", "chinese", "japanese"]);
  expect(modern.ja.every(n => /^(Sato|Suzuki|Takahashi|Tanaka|Watanabe|Ito|Yamamoto|Nakamura|Kobayashi|Kato|Yoshida|Yamada|Sasaki|Yamaguchi|Matsumoto|Inoue|Kimura|Hayashi|Shimizu|Mori|Ikeda|Hashimoto|Ishikawa|Ogawa|Fujita|Okada|Maeda) /.test(n))).toBe(true);
  expect(modern.ru.every(n => !/(ov|ev|in)$/.test(n))).toBe(true); // Ivanova, not Ivanov
  expect(modern.en.some(n => /^(Alex|Avery|Casey|Charlie|Jordan|Morgan|Quinn|Riley|Robin|Sam|Taylor) /.test(n))).toBe(true);
});

test("a GM rolls each generator and adds results to the Encyclopedia; a player adds one too", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Generators ${gm.id}`);

  await page.goto(`index.html#/c/${cid}/generators`);
  await expect(page.locator(".tabs a.on")).toHaveText("Generators");
  const cards = page.locator(".gen-card");
  await expect(cards).toHaveCount(4);
  const names = cards.filter({ has: page.getByRole("heading", { name: "Names" }) });
  await expect(names.locator(".gen-item")).toHaveCount(10);

  // A new genre redraws every card with its own peoples; the choice is remembered.
  await page.getByLabel("Genre", { exact: true }).selectOption("western");
  await expect(page.getByRole("heading", { name: "Saloons & inns" })).toBeVisible();
  await names.getByLabel("Race or people", { exact: true }).selectOption("outlaw");
  await expect(names.locator(".gen-name").first()).toHaveText(/^"[^"]+" \S+ \S+$/); // an outlaw's "Nickname" First Last
  await expect(names.locator(".gen-item .muted")).toHaveCount(0); // just the name, nothing under it
  const before = await names.locator(".gen-name").allTextContents();
  await names.getByRole("button", { name: "🎲 Generate" }).click();
  await expect.poll(async () => (await names.locator(".gen-name").allTextContents()).join()).not.toBe(before.join());
  await page.reload();
  await expect(page.getByLabel("Genre", { exact: true })).toHaveValue("western");
  await expect(names.getByLabel("Race or people", { exact: true })).toHaveValue("outlaw");

  // The town goes in as a GM-only Location with its whole write-up; one of its people as a Person.
  const town = page.locator(".gen-town");
  await town.getByLabel("Size", { exact: true }).selectOption("small");
  await expect(town.locator(".gen-town-title .muted")).toContainText("Mining camp");
  const townName = await town.locator(".gen-town-title h3").textContent();
  await town.locator(".gen-town-title").getByRole("button", { name: `Add ${townName} to the Encyclopedia` }).click();
  await expect(town.locator(".gen-town-title").getByRole("link", { name: "📖 Open" })).toBeVisible();
  const personName = await town.locator(".gen-sub").nth(1).locator(".gen-name").first().textContent();
  await town.locator(".gen-sub").nth(1).locator(".gen-add").first().click();
  await expect(town.locator(".gen-sub").nth(1).getByRole("link", { name: "📖 Open" })).toHaveCount(1);
  const { json } = await api(page, "encyclopedia", undefined, cid);
  const byName = Object.fromEntries(json.entries.map(e => [e.name, e]));
  expect(byName[townName].is_secret).toBe(true);
  expect(byName[townName].tags.map(t => t.name)).toEqual(["Location"]);
  expect(byName[townName].notes).toContain("<h3>Trouble</h3>");
  expect(byName[personName].tags.map(t => t.name)).toEqual(["Person"]);
  expect(byName[personName].notes).toContain(`in ${townName}.`);

  // Unticking GM only adds the next one for everyone.
  await page.getByLabel("Add to the Encyclopedia as GM only").uncheck();
  const company = cards.nth(2);
  const coName = await company.locator(".gen-name").first().textContent();
  await company.locator(".gen-add").first().click();
  await expect(company.getByRole("link", { name: "📖 Open" })).toHaveCount(1);
  await company.getByRole("link", { name: "📖 Open" }).click();
  await expect(page.locator(".enc-detail h2")).toHaveText(coName);

  // A player has no GM-only switch; what they add is public.
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/generators`);
  await expect(pp.getByLabel("Add to the Encyclopedia as GM only")).toHaveCount(0);
  const tav = pp.locator(".gen-card").nth(1);
  const tavName = await tav.locator(".gen-name").first().textContent();
  await tav.locator(".gen-add").first().click();
  await expect(tav.getByRole("link", { name: "📖 Open" })).toHaveCount(1);
  const pj = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(pj.entries.map(e => e.name).sort()).toEqual([coName, tavName].sort());
  expect(JSON.stringify(pj)).not.toContain(townName);
  expectNoErrors(perrors);
  await pctx.close();
  expectNoErrors(errors);
});
