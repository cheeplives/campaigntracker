// The Generators tab: names, taverns, companies, towns and encounters made in the browser from static/generators.js and
// static/encounters.js, with 📖 Add putting a result in the Encyclopedia (GM only by default for a GM), and 📝 Keep putting an
// encounter in the GM notes of the shift the party is in.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

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
        for (const r of Gen.rumors(g, 6)) { check(`rumor ${g}`, r); if (!/^\p{Lu}.+\.$/u.test(r.name) || !r.title.startsWith("Rumor: ") || !/^Heard from /.test(r.note)) out.push(`rumor ${g}: ${JSON.stringify(r)}`); }
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
  const jaFamily = /^(Sato|Suzuki|Takahashi|Tanaka|Watanabe|Ito|Yamamoto|Nakamura|Kobayashi|Kato|Yoshida|Yamada|Sasaki|Yamaguchi|Matsumoto|Inoue|Kimura|Hayashi|Shimizu|Mori|Ikeda|Hashimoto|Ishikawa|Ogawa|Fujita|Okada|Maeda)$/;
  expect(modern.ja.some(n => jaFamily.test(n.split(" ")[0]))).toBe(true); // family name first
  expect(modern.ja.some(n => jaFamily.test(n.split(" ")[1]))).toBe(false);
  expect(modern.ru.every(n => !/(ov|ev|in)$/.test(n))).toBe(true); // Ivanova, not Ivanov
  // Rumors use the campaign's names they're given, each at most once in a batch, and "The" goes lower case mid-sentence.
  const rum = await page.evaluate(() => Array.from({ length: 30 }, () => Gen.rumors("western", 6, { person: ["Ada Quill"], place: ["Gallows Rock"], group: ["The Iron Combine"] }).map(r => r.name).join("\n")));
  expect(rum.some(b => b.includes("Ada Quill") && b.includes("Gallows Rock"))).toBe(true);
  expect(rum.every(b => (b.match(/Ada Quill/g) || []).length <= 2)).toBe(true); // once a batch, though a rumor may name them twice
  expect(rum.some(b => /\bthe Iron Combine\b/.test(b))).toBe(true);
  // Street names, cyberpunk handles and cyberspace handles, in any genre, each with the real name behind it.
  const aliases = await page.evaluate(() => {
    Gen.seed(11);
    const out = {};
    for (const [k] of Gen.ALIAS_KINDS) out[k] = Gen.GENRES.flatMap(([g]) => Array.from({ length: 40 }, () => Gen.alias(k, g)));
    out.any = Array.from({ length: 60 }, () => Gen.alias("", "fantasy").kind);
    // With a people and gender, the real name is one of theirs; a cyberpunk "Rogue AI" can't be a real name, so it falls back.
    out.dwarf = Array.from({ length: 40 }, () => Gen.alias("street", "fantasy", "dwarf", "f"));
    out.ai = Array.from({ length: 20 }, () => Gen.alias("net", "cyberpunk", "ai"));
    return out;
  });
  for (const k of ["street", "cyber", "net"]) for (const r of aliases[k]) {
    expect(r.kind).toBe(k);
    expect(r.name).not.toMatch(/undefined|NaN|\{|\}/); // "null" is a netrunner word here
    expect(r.name.length).toBeGreaterThan(1);
    expect(r.note).toMatch(/^Real name: \S+ \S+/);
  }
  expect(aliases.street.every(r => /^[A-Z]/.test(r.name))).toBe(true); // street names are written like names
  expect(aliases.net.some(r => /[0-9_.~@:[]/.test(r.name))).toBe(true); // cyberspace handles look like screen names
  expect(new Set(aliases.any).size).toBe(3);
  expect(aliases.dwarf.every(r => r.people === "dwarf")).toBe(true);
  expect(aliases.dwarf.some(r => r.note.includes(", daughter of "))).toBe(true); // a dwarf woman's name, not a generic one
  expect(aliases.ai.every(r => r.people === "" && /^Real name: \S+ \S+$/.test(r.note) && !/[./]/.test(r.note))).toBe(true);
  const t = await page.evaluate(() => [Gen.traits("fantasy", "dwarf"), Gen.traits("scifi", "insectoid")]);
  for (const x of t) { expect(x.look.length).toBeGreaterThan(10); expect(x.quirk).toMatch(/^[A-Z]/); }
  expect(modern.en.some(n => /^(Alex|Avery|Casey|Charlie|Jordan|Morgan|Quinn|Riley|Robin|Sam|Taylor) /.test(n))).toBe(true);
});

test("every encounter fills its slots, fits the choices, and rerolls one part at a time", async ({ page }) => {
  await page.goto("about:blank");
  await page.addScriptTag({ path: require("path").join(__dirname, "..", "..", "static", "encounters.js") });
  const r = await page.evaluate(() => {
    const bad = [], cast = { group: ["The Iron Combine"], place: ["Gallows Rock"], person: ["Ada Quill"] };
    let named = 0;
    Enc.seed(3);
    for (let i = 0; i < 40; i++) for (const [g] of Enc.GENRES) for (const [tone] of Enc.TONES) for (const [where] of [["", ""], ...Enc.WHERE[g]]) for (const [when] of Enc.WHEN) {
      const cards = Enc.draw({ genre: g, tone, where, when, cast: i % 2 ? cast : {} });
      if (cards.length !== 3 || new Set(cards.map(c => c.title)).size !== 3) bad.push(`three different cards: ${cards.map(c => c.title)}`);
      for (const c of cards) {
        const text = Enc.text(c);
        if (/[{}]|undefined|null|NaN/.test(text)) bad.push(text);
        if (c.esc.length !== 2 || c.esc[0] === c.esc[1]) bad.push(`two escalations: ${text}`);
        if (![c.situation, c.twist, c.gain, ...c.esc].every(x => /^[A-Z0-9"'].*[.!?]$/.test(x))) bad.push(`sentences: ${text}`);
        if (tone && c.tone !== tone) bad.push(`tone ${tone}: ${text}`);
        if (/Iron Combine|Gallows Rock|Ada Quill/.test(text)) named++;
        if (/\bThe Iron Combine\b/.test(text.replace(/(^|[.:] |\n)The Iron/g, "$1the Iron"))) bad.push(`"the" mid-sentence: ${text}`);
        for (const part of ["twist", "esc", "gain"]) {
          const again = Enc.reroll(c, part);
          if (/[{}]|undefined/.test(Enc.text(again))) bad.push(Enc.text(again));
          if (again.situation !== c.situation || again.who !== c.who) bad.push(`a reroll keeps the rest: ${Enc.text(again)}`);
        }
      }
    }
    const pick = () => { Enc.seed(42); return Enc.draw({ genre: "apoc" }).map(Enc.text).join("\n"); };
    // Escalations happen to the party; they never list what the party could choose to do.
    const choices = Enc.TEMPLATES.filter(t => [t.s, ...t.esc].some(x => /\b(the party (can|could|may|might) |choose|option)/i.test(x))).map(t => t.t);
    return { bad, named, same: pick() === pick(), choices, night: Enc.draw({ genre: "apoc", tone: "hostile", where: "road", when: "night", n: 9 }) };
  });
  expect(r.bad).toEqual([]);
  expect(r.named).toBeGreaterThan(20); // the campaign's own names turn up
  expect(r.same).toBe(true);
  expect(r.choices).toEqual([]);
  // A hostile road at night: only hostile cards, and "twice as many by day" reads as the night's number
  expect(r.night.every(c => c.tone === "hostile")).toBe(true);
  expect(r.night.some(c => c.many === "About as many as the party")).toBe(true);
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
  await expect(cards).toHaveCount(6);
  const names = cards.filter({ has: page.getByRole("heading", { name: /^Names/ }) });
  await expect(names.locator(".gen-item")).toHaveCount(10);
  await expect(names.locator(".gen-item .muted")).toHaveCount(0);

  // Street names and handles are a Kind of name: the real name goes in as the entry's notes.
  await names.getByLabel("Kind of name").selectOption("alias");
  await expect(names.locator(".gen-item .muted").first()).toHaveText(/^(Street name|Cyberpunk handle|Cyberspace handle)\. Real name: /);
  await names.getByLabel("Kind of name").selectOption("net");
  await expect(names.locator(".gen-item .muted").first()).toHaveText(/^Real name: /);
  const handle = await names.locator(".gen-name").first().textContent();
  await names.locator(".gen-add").first().click();
  await expect(names.getByRole("link", { name: "Open", exact: true })).toHaveCount(1);
  const hj = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.name === handle);
  expect(hj.category).toBe("person");
  expect(hj.notes).toContain("Real name: ");
  await names.getByLabel("Kind of name").selectOption("");

  // A new genre redraws every card with its own peoples; the choice is remembered.
  await page.getByLabel("Genre", { exact: true }).selectOption("western");
  await expect(page.getByRole("heading", { name: "Saloons & inns" })).toBeVisible();
  await names.getByLabel("Race or people", { exact: true }).selectOption("outlaw");
  await expect(names.locator(".gen-name").first()).toHaveText(/^"[^"]+" \S+ \S+$/); // an outlaw's "Nickname" First Last
  await expect(names.locator(".gen-item .muted")).toHaveCount(0); // just the name, nothing under it
  // A batch never repeats a name or a family name.
  const fams = (await names.locator(".gen-name").allTextContents()).map(n => n.split(" ").pop());
  expect(new Set(fams).size).toBe(fams.length);
  // The toggle gives each name a look and a quirk, kept as its notes when added to the Encyclopedia.
  await names.getByText("Add a look and a quirk").click();
  await expect(names.locator(".gen-item .muted")).toHaveCount(10);
  await expect(names.locator(".gen-item .muted").first()).toHaveText(/^[A-Z].+\. [A-Z].+\.$/);
  const before = await names.locator(".gen-name").allTextContents();
  await names.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(async () => (await names.locator(".gen-name").allTextContents()).join()).not.toBe(before.join());
  await page.reload();
  await expect(page.getByLabel("Genre", { exact: true })).toHaveValue("western");
  await expect(names.getByLabel("Race or people", { exact: true })).toHaveValue("outlaw");
  await expect(names.getByRole("checkbox", { name: "Add a look and a quirk" })).toBeChecked();

  // The town goes in as a GM-only Location with its whole write-up; one of its people as a Person.
  const town = page.locator(".gen-town");
  await town.getByLabel("Size", { exact: true }).selectOption("small");
  await expect(town.locator(".gen-town-title .muted")).toContainText("Mining camp");
  const townName = await town.locator(".gen-town-title h3").textContent();
  await town.locator(".gen-town-title").getByRole("button", { name: `Add ${townName} to the Encyclopedia` }).click();
  await expect(town.locator(".gen-town-title").getByRole("link", { name: "Open", exact: true })).toBeVisible();
  const personName = await town.locator(".gen-sub").nth(1).locator(".gen-name").first().textContent();
  await town.locator(".gen-sub").nth(1).locator(".gen-add").first().click();
  await expect(town.locator(".gen-sub").nth(1).getByRole("link", { name: "Open", exact: true })).toHaveCount(1);
  const { json } = await api(page, "encyclopedia", undefined, cid);
  const byName = Object.fromEntries(json.entries.map(e => [e.name, e]));
  expect(byName[townName].is_secret).toBe(true);
  expect([byName[townName].category, byName[townName].tags]).toEqual(["location", []]);
  expect(byName[townName].notes).toContain("<h3>Trouble</h3>");
  expect([byName[personName].category, byName[personName].tags]).toEqual(["person", []]);
  expect(byName[personName].notes).toContain(`in ${townName}.`);

  // Unticking GM only adds the next one for everyone.
  await page.getByLabel("Add to the Encyclopedia as GM only").uncheck();
  const company = cards.nth(2);
  const coName = await company.locator(".gen-name").first().textContent();
  await company.locator(".gen-add").first().click();
  await expect(company.getByRole("link", { name: "Open", exact: true })).toHaveCount(1);
  await company.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.locator(".enc-detail h2")).toHaveText(coName);

  // A player has no GM-only switch; what they add is public.
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  await pp.goto(`index.html#/c/${cid}/generators`);
  await expect(pp.getByLabel("Add to the Encyclopedia as GM only")).toHaveCount(0);
  await expect(pp.locator(".gen-enc-card")).toHaveCount(3);
  await expect(pp.getByRole("button", { name: /^Keep / })).toHaveCount(0);
  const tav = pp.locator(".gen-card").nth(1);
  const tavName = await tav.locator(".gen-name").first().textContent();
  await tav.locator(".gen-add").first().click();
  await expect(tav.getByRole("link", { name: "Open", exact: true })).toHaveCount(1);
  const pj = (await api(pp, "encyclopedia", undefined, cid)).json;
  expect(pj.entries.map(e => e.name).sort()).toEqual([coName, tavName].sort());
  // nothing else names the GM-only town (a company named after it, like "Badwater Gulch Herbalists", is fine)
  expect(JSON.stringify(pj).replaceAll(coName, "").replaceAll(tavName, "")).not.toContain(townName);
  expectNoErrors(perrors);
  await pctx.close();

  await page.goto(`index.html#/c/${cid}/generators`);
  // Encounters: three cards that follow the tone; 🎲 draws one part again, and 📝 Keep adds the card to this shift's GM notes.
  const enc = page.locator(".gen-enc");
  await enc.getByLabel("Tone", { exact: true }).selectOption("tense");
  await expect(enc.locator(".gen-enc-card")).toHaveCount(3);
  await expect(enc.locator(".gen-enc-card header .muted").first()).toHaveText(/^Tense · /);
  const first = enc.locator(".gen-enc-card").first();
  const title = await first.locator("h3").textContent();
  const situation = await first.locator(".gen-enc-sit").textContent();
  const twist = await first.locator(".gen-enc-part").first().locator("p").textContent();
  await first.getByRole("button", { name: `Draw another twist for ${title}` }).click();
  await expect(enc.locator(".gen-enc-card").first().locator(".gen-enc-sit")).toHaveText(situation);
  const twist2 = await enc.locator(".gen-enc-card").first().locator(".gen-enc-part").first().locator("p").textContent();
  const kept = enc.locator(".gen-enc-card").first();
  await kept.getByRole("button", { name: `Keep ${title} in this shift's GM notes` }).click();
  await expect(kept.getByText("Kept in this shift's GM notes")).toBeVisible();
  const today = (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=0`)).json()).today;
  const shifts = (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=${today}`)).json()).shifts;
  const noted = shifts.find(x => (x.gm_notes || "").includes(title));
  expect(noted.gm_notes).toContain(situation);
  expect(noted.gm_notes).toContain(`Twist: ${twist2}`);
  expect(noted.gm_notes).toContain("If it escalates:");
  if (twist2 !== twist) expect(noted.gm_notes).not.toContain(twist);
  await page.reload();
  await expect(enc.getByLabel("Tone", { exact: true })).toHaveValue("tense");

  // Rumors name the campaign's own entries (the town and its person are in the Location and Person Categories); one goes in as a Rumor.
  const rumors = cards.filter({ has: page.getByRole("heading", { name: /^Rumors/ }) });
  await expect(rumors.getByRole("checkbox", { name: "Use Encyclopedia names" })).toBeChecked();
  await expect.poll(async () => {
    await rumors.getByRole("button", { name: "Generate", exact: true }).click();
    const text = (await rumors.locator(".gen-rumor").allTextContents()).join("\n");
    return text.includes(townName) || text.includes(personName);
  }, { timeout: 15000 }).toBe(true);
  await expect(rumors.locator(".gen-item .muted").first()).toHaveText(/^Heard from .+\.$/);
  const rumor = await rumors.locator(".gen-rumor").first().textContent();
  await rumors.locator(".gen-add").first().click();
  await expect(rumors.getByRole("link", { name: "Open", exact: true })).toHaveCount(1);
  const entry = (await api(page, "encyclopedia", undefined, cid)).json.entries.find(e => e.tags.some(t => t.name === "Rumor"));
  expect(entry.name).toMatch(/^Rumor: /);
  const plain = entry.notes.replace(/<[^>]+>/g, " ").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  expect(plain).toContain(rumor);
  expect(entry.notes).toContain("Heard from");
  expectNoErrors(errors);
});
