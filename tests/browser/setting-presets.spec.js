// The Forgotten Realms, Eberron, Exandria and Golarion presets: their calendars
// keep the setting's dates, and a campaign made from one starts with them.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const { watchErrors, expectNoErrors, person, signIn, api, approve } = require("./helpers");

const calOf = key => Engine.prep(JSON.parse(JSON.stringify(Engine.PRESETS[key].calendar)));
const names = (key, cal, d) => Engine.holidaysOn(cal, Engine.PRESETS[key].holidays, d).map(h => h.name);

test("Forgotten Realms: Harptos tendays, festival days, Shieldmeet and Selûne", () => {
  const cal = calOf("harptos");
  // 365 days, 366 with Shieldmeet every fourth year
  expect([1491, 1492, 1500].map(y => Engine.yearLength(cal, y))).toEqual([365, 366, 366]);
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 1492, 0, 1))).toBe("1 Hammer, 1492 DR");
  // festival days sit outside the tendays, so every month starts on a tenday's first day
  const midsummer = Engine.toAbs(cal, 1492, 9, 1);
  expect(Engine.fmtDate(cal, midsummer)).toBe("Midsummer, 1492 DR");
  expect(Engine.weekday(cal, midsummer)).toBeNull();
  expect(names("harptos", cal, midsummer + 1)).toEqual(["Shieldmeet"]);
  expect(Engine.fmtDate(cal, midsummer + 1)).toBe("Shieldmeet, 1492 DR");
  for (const m of [2, 6, 11, 14, 17]) expect(Engine.weekday(cal, Engine.toAbs(cal, 1493, m, 1))).toBe(0);
  // no Shieldmeet in a common year: the day after Midsummer is Eleasis 1
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 1493, 9, 1) + 1)).toBe("1 Eleasis, 1493 DR");
  // Selûne was full at midnight on Hammer 1, 1372 DR, and on the first day of every leap year
  for (const y of [1372, 1492]) expect(Engine.moons(cal, Engine.toAbs(cal, y, 0, 1))[0].label).toBe("Full");
  expect(Engine.season(cal, Engine.toAbs(cal, 1492, 12, 21)).name).toBe("Autumn");
});

test("Eberron: 28-day months that start on Sul, twelve moons and the Five Nations' holidays", () => {
  const cal = calOf("eberron");
  expect(Engine.yearLength(cal, 998)).toBe(336);
  for (let m = 0; m < 12; m++) expect(cal.weekdays[Engine.weekday(cal, Engine.toAbs(cal, 998, m, 1))]).toBe("Sul");
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 998, 9, 25))).toBe("Wir, 25 Sypheros 998 YK");
  expect(names("eberron", cal, Engine.toAbs(cal, 998, 1, 20))).toEqual(["The Day of Mourning"]);
  expect(names("eberron", cal, Engine.toAbs(cal, 998, 10, 11))).toEqual(["Thronehold"]);
  expect(Engine.moons(cal, 0).map(m => m.name)).toHaveLength(12);
});

test("Exandria: eleven months of 328 days, its seasons and holy days", () => {
  const cal = calOf("exandria");
  expect(Engine.yearLength(cal, 835)).toBe(328);
  expect(cal.weekdays).toHaveLength(7);
  expect(Engine.season(cal, Engine.toAbs(cal, 835, 2, 13)).name).toBe("Spring");
  expect(names("exandria", cal, Engine.toAbs(cal, 835, 0, 1))).toEqual(["New Dawn"]);
  expect(names("exandria", cal, Engine.toAbs(cal, 835, 10, 20))).toEqual(["Winter's Crest"]);
  expect(Engine.moons(cal, 0).map(m => m.name)).toEqual(["Catha", "Ruidus"]);
});

test("Golarion: Absalom Reckoning's Leap Day, weekdays and Inner Sea holidays", () => {
  const cal = calOf("golarion");
  // Leap Day ends Calistril every fourth year, with no century rule
  expect([4724, 4725, 4800].map(y => Engine.yearLength(cal, y))).toEqual([366, 365, 366]);
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 4724, 1, 29))).toBe("Oathday, 29 Calistril 4724 AR");
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 4725, 0, 1))).toBe("Wealday, 1 Abadius 4725 AR");
  expect(names("golarion", cal, Engine.toAbs(cal, 4725, 0, 1))).toEqual(["Foundation Day"]);
  // the Breaching Festival is the last Sunday of Desnus
  const breach = Engine.toAbs(cal, 4725, 4, 25);
  expect(cal.weekdays[Engine.weekday(cal, breach)]).toBe("Sunday");
  expect(names("golarion", cal, breach)).toEqual(["Breaching Festival"]);
});

test("every setting preset has Köppen regions with one starting region", () => {
  for (const key of ["harptos", "eberron", "exandria", "golarion"]) {
    const regions = Engine.PRESETS[key].regions;
    expect(regions.filter(r => r.current)).toHaveLength(1);
    for (const r of regions) expect(Engine.KOPPEN[r.settings.climate.slice(7)], r.name).toBeTruthy();
  }
});

test("a GM starts a Forgotten Realms campaign, and About & sources cites the four presets", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Elminster");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Dragon Heist");
  await page.getByLabel("Calendar preset").selectOption("harptos");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Dragon Heist" })).toBeVisible();
  const cid = page.url().match(/#\/c\/(\d+)/)[1];
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.calendar.name).toBe("Calendar of Harptos");
  expect(json.campaign.calendar.months.filter(m => !m.intercalary)).toHaveLength(12);
  // the Legend's Setup group starts folded
  const setup = page.locator("nav.tabs .tab-group button", { hasText: "Setup" });
  if (await setup.isVisible()) await setup.click();
  await page.getByRole("navigation").getByRole("link", { name: "Holidays", exact: true }).click();
  await expect(page.getByText("Shieldmeet").first()).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "Regions", exact: true }).click();
  await expect(page.getByText("Waterdeep").first()).toBeVisible();
  // a fresh tab, so a campaign view still loading can't draw over the About page
  const about = await page.context().newPage();
  const aboutErrors = watchErrors(about);
  await about.goto("index.html#/about");
  const calendars = about.locator("section", { has: about.getByRole("heading", { name: "Calendars and holidays" }) });
  for (const link of [/Calendar of Harptos/, /Galifar Calendar/, /Calendar of Exandria/, /Absalom Reckoning/, /Galactic standard calendar/]) {
    await expect(calendars.getByRole("link", { name: link })).toHaveAttribute("target", "_blank");
  }
  expectNoErrors(errors);
  expectNoErrors(aboutErrors);
});

test("Star Wars: the Galactic Standard Calendar's ten months, five-day weeks and festival weeks", () => {
  const cal = calOf("galactic");
  // 10 × 35 days and three five-day festival weeks: 365 days, exactly 73 weeks, so every year starts on Primeday
  expect([-19, 0, 4].map(y => Engine.yearLength(cal, y))).toEqual([365, 365, 365]);
  for (const y of [-19, 0, 4]) expect(cal.weekdays[Engine.weekday(cal, Engine.toAbs(cal, y, 0, 1))]).toBe("Primeday");
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 0, 1, 1))).toBe("Primeday, Month 1, Day 1, 0 ABY");
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, -19, 4, 35))).toBe("Benduday, Month 4, Day 35, 19 BBY");
  // the festival weeks keep the weekdays running
  const life = Engine.toAbs(cal, 0, 7, 3);
  expect(Engine.fmtDate(cal, life)).toBe("Taungsday, Festival of Life, Day 3, 0 ABY");
  expect(names("galactic", cal, life)).toEqual(["Festival of Life"]);
  expect(names("galactic", cal, Engine.toAbs(cal, 0, 11, 5))).toEqual(["Festival of Stars"]);
  expect(cal.seasons).toEqual([]);
  // worlds with Köppen climates, one starting region, plus a ship and open space for transit
  const regions = Engine.PRESETS.galactic.regions;
  expect(regions.filter(r => r.current).map(r => r.name)).toEqual(["Coruscant (Core Worlds)"]);
  for (const r of regions.filter(r => r.settings.climate.startsWith("koppen:"))) expect(Engine.KOPPEN[r.settings.climate.slice(7)], r.name).toBeTruthy();
  expect(regions.map(r => r.settings.climate)).toContain("ship");
});

test("Greyhawk: 28-day months and festival weeks that keep Starday, with both moons full on Richfest 4", () => {
  const cal = calOf("greyhawk");
  expect(Engine.yearLength(cal, 576)).toBe(364);
  for (const m of [0, 1, 4, 8, 12, 15]) expect(cal.weekdays[Engine.weekday(cal, Engine.toAbs(cal, 577, m, 1))]).toBe("Starday");
  const midsummer = Engine.toAbs(cal, 580, 8, 4);
  expect(Engine.moons(cal, midsummer).map(m => m.label)).toEqual(["Full", "Full"]);
  expect(names("greyhawk", cal, midsummer)).toEqual(["Richfest (Midsummer)"]);
});

test("Iron Kingdoms: thirteen 28-day months with a Longest Night every third year", () => {
  const cal = calOf("ironkingdoms");
  expect([602, 603, 604, 606].map(y => Engine.yearLength(cal, y))).toEqual([364, 365, 364, 365]);
  expect(cal.months).toHaveLength(13);
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 604, 12, 25))).toBe("Gorim, 25 Ashtoven, 604 AR");
  expect(names("ironkingdoms", cal, Engine.toAbs(cal, 604, 6, 14))).toEqual(["Summer Solstice"]);
});

test("Dark Sun: 375 days of 30-day months and five-day festival weeks outside the six-day week", () => {
  const cal = calOf("darksun");
  expect(Engine.yearLength(cal, 5)).toBe(375);
  expect(Engine.weekday(cal, Engine.toAbs(cal, 5, 4, 1))).toBeNull();
  expect(cal.weekdays).toHaveLength(6);
  expect(Engine.moons(cal, 0).map(m => m.name)).toEqual(["Ral", "Guthay"]);
});

test("Rokugan, Traveller and the Witcher keep their year lengths", () => {
  expect(Engine.yearLength(calOf("rokugan"), 1123)).toBe(336);
  const t = calOf("traveller");
  expect(Engine.yearLength(t, 1105)).toBe(365);
  expect(Engine.fmtDate(t, Engine.toAbs(t, 1105, 0, 1))).toBe("Holiday, 1105 IC");
  expect(Engine.fmtDate(t, Engine.toAbs(t, 1105, 1, 1))).toBe("Wonday, Week 1, 1105 IC");
  const w = calOf("witcher");
  expect([1271, 1272, 1273].map(y => Engine.yearLength(w, y))).toEqual([365, 366, 365]);
});

test("setting drop-downs list the presets alphabetically, Custom last", () => {
  const labels = Engine.presetOptions().map(([, l]) => l);
  expect(labels.at(-1)).toMatch(/^Custom/);
  const rest = labels.slice(0, -1);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  for (const k of ["greyhawk", "ironkingdoms", "darksun", "rokugan", "traveller", "witcher"]) {
    const r = Engine.PRESETS[k].regions;
    expect(r.filter(x => x.current)).toHaveLength(1);
    for (const x of r.filter(x => x.settings.climate.startsWith("koppen:"))) expect(Engine.KOPPEN[x.settings.climate.slice(7)], x.name).toBeTruthy();
  }
});

test("a Glorantha campaign shows the Red Moon red and black, and each region sees the phase of its own land", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Argrath");
  await signIn(page, gm);
  await approve(browser, gm.email);
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Dragon Pass");
  await page.getByLabel("Calendar preset").selectOption("glorantha");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Dragon Pass" })).toBeVisible();
  const cid = page.url().match(/#\/c\/(\d+)/)[1];
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.calendar.moons[0].kind).toBe("red_moon");
  // The year starts on Freezeday, when Dragon Pass sees the Red Moon Crescent-Going; Glamour sees it Full.
  const day = Math.floor(json.campaign.current_shift / 4);
  await page.goto(`index.html#/c/${cid}/day/${day}`);
  const moons = page.locator(".kv div", { has: page.locator(".lbl", { hasText: "Moons" }) });
  await expect(moons).toContainText("Red Moon: Crescent-Going");
  await expect(moons.locator(".moon-glyph svg path")).toHaveAttribute("fill", "#c8513a");
  await expect(moons.locator(".moon-glyph svg circle")).toHaveAttribute("fill", "#111");
  // A region's form picks the land it sees the Red Moon from.
  const glamour = json.regions.find(r => r.name.startsWith("Peloria"));
  expect(glamour.settings.moon_shift).toBe("full");
  await page.goto(`index.html#/c/${cid}/regions`);
  await page.locator(".listrow", { hasText: "Ralios" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Red Moon seen as from")).toHaveValue("1");
  await page.getByLabel("Red Moon seen as from").selectOption("full");
  await page.getByRole("button", { name: "Save region" }).click();
  await expect.poll(async () => (await api(page, "campaign", undefined, cid)).json.regions.find(r => r.name === "Ralios").settings.moon_shift).toBe("full");
  await page.locator(".listrow", { hasText: "Ralios" }).getByRole("button", { name: "Party is here" }).click();
  await expect(page.locator("#toast")).toContainText("Party moved to Ralios");
  // a day not yet recorded is where the party is now (a recorded day keeps the region it was in)
  await page.goto(`index.html#/c/${cid}/day/${day + 7}`);
  await expect(moons).toContainText("Red Moon: Full (100%)");
  expectNoErrors(errors);
});
