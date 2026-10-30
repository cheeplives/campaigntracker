// The exports for virtual tabletops, under Node (static/vtt-calendar.js, static/lore-export.js and static/engine.js need
// no page): every preset calendar as a Seasons & Stars calendar that gives the same dates, weekdays and moons, and the
// Encyclopedia as Markdown, a Foundry journal and a zip.
const zlib = require("zlib");
const { test, expect } = require("@playwright/test");
const path = require("path");
const E = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const V = require(path.join(__dirname, "..", "..", "static", "vtt-calendar.js"));
const Lore = require(path.join(__dirname, "..", "..", "static", "lore-export.js"));

/** Seasons & Stars' date maths, as its calendar-engine.ts and event-recurrence-calculator.ts do it: days from the epoch
 * year's first day for a { year, month (1-based), day } date, and its weekday. */
function seasonsAndStars(cal) {
  const isLeap = y => {
    const L = cal.leapYear;
    if (L.rule === "gregorian") return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (L.rule === "custom") return ((y - (L.offset || 0)) % L.interval + L.interval) % L.interval === 0;
    return false;
  };
  const monthLengths = y => cal.months.map(m => m.days + (isLeap(y) && cal.leapYear.month === m.name ? cal.leapYear.extraDays ?? 1 : 0));
  const inter = y => cal.intercalary.filter(i => !i.leapYearOnly || isLeap(y));
  const yearLength = (y, weekdaysOnly) => monthLengths(y).reduce((a, b) => a + b, 0)
    + inter(y).filter(i => !weekdaysOnly || i.countsForWeekdays !== false).reduce((n, i) => n + (i.days || 1), 0);
  function days(date, weekdaysOnly) {
    let n = 0;
    for (let y = cal.year.epoch; y < date.year; y++) n += yearLength(y, weekdaysOnly);
    for (let y = date.year; y < cal.year.epoch; y++) n -= yearLength(y, weekdaysOnly);
    const lens = monthLengths(date.year), ins = inter(date.year).filter(i => !weekdaysOnly || i.countsForWeekdays !== false);
    for (let m = 1; m < date.month; m++) {
      const name = cal.months[m - 1].name;
      n += ins.filter(i => i.before === name).reduce((s, i) => s + (i.days || 1), 0) + lens[m - 1] + ins.filter(i => i.after === name).reduce((s, i) => s + (i.days || 1), 0);
    }
    n += ins.filter(i => i.before === cal.months[date.month - 1].name).reduce((s, i) => s + (i.days || 1), 0);
    return n + date.day - 1;
  }
  const weekday = date => ((days(date, true) + cal.year.startDay) % cal.weekdays.length + cal.weekdays.length) % cal.weekdays.length;
  /** The moon's phase index (0 new … 4 full) on date, from the start of its reference day. */
  function phase(moon, date) {
    let t = days(date) - days(moon.firstNewMoon);
    t = ((t % moon.cycleLength) + moon.cycleLength) % moon.cycleLength;
    let at = 0;
    for (let i = 0; i < moon.phases.length; i++) { at += moon.phases[i].length; if (t < at) return i; }
    return 0;
  }
  return { days, weekday, phase, isLeap };
}

/** Presets whose calendars Seasons & Stars can hold exactly (no leap rule it can't follow). */
const exact = Object.entries(E.PRESETS).filter(([, p]) => p.calendar && !V.seasonsAndStars({ name: "T", calendar: p.calendar, current_shift: 0 }).lost.some(l => /leap|no days/i.test(l)));

test("every preset calendar becomes a Seasons & Stars calendar with the same dates and weekdays", () => {
  expect(exact.length).toBeGreaterThan(10);
  for (const [key, p] of exact) {
    const c = E.prep(JSON.parse(JSON.stringify(p.calendar)));
    const { calendar: s } = V.seasonsAndStars({ name: key, calendar: p.calendar, current_shift: 0 }, p.holidays || []);
    const ss = seasonsAndStars(s);
    const regular = c.months.map((m, i) => (m.intercalary ? null : i)).filter(i => i !== null);
    for (let d = -800; d < 2400; d += 13) {
      const t = E.fromAbs(c, d);
      if (c.months[t.month].intercalary) continue;
      const date = { year: t.year, month: regular.indexOf(t.month) + 1, day: t.day };
      expect(ss.days(date), `${key} day ${d}`).toBe(d);
      if (c.weekdays.length) expect(ss.weekday(date), `${key} weekday of day ${d}`).toBe(E.weekday(c, d));
    }
    expect(s.months.map(m => m.name)).toEqual(regular.map(i => c.months[i].name));
    expect(s.id).toMatch(/^[a-z0-9-]+$/);
    expect(s.translations.en.label).toBeTruthy();
  }
});

test("moons keep their cycle, with eight phases that add up to it, and are new on the same days", () => {
  for (const [key, p] of exact) {
    const c = E.prep(JSON.parse(JSON.stringify(p.calendar)));
    const { calendar: s } = V.seasonsAndStars({ name: key, calendar: p.calendar, current_shift: 0 });
    const ss = seasonsAndStars(s);
    const regular = c.months.map((m, i) => (m.intercalary ? null : i)).filter(i => i !== null);
    for (const moon of s.moons) {
      expect(moon.phases.map(x => x.icon)).toEqual(["new", "waxing-crescent", "first-quarter", "waxing-gibbous", "full", "waning-gibbous", "last-quarter", "waning-crescent"]);
      expect(moon.phases.reduce((n, x) => n + x.length, 0)).toBeCloseTo(moon.cycleLength, 6);
      const mine = c.moons.find(m => m.name === moon.name);
      if (mine.erratic) continue;
      // Chronicle's new and full days fall in Seasons & Stars' new and full phases, give or take the day either side
      let checked = 0;
      for (let d = 0; d < 400; d++) {
        const t = E.fromAbs(c, d);
        if (c.months[t.month].intercalary) continue;
        const ph = E.moonPhase(mine, d, c).label;
        if (ph !== "New" && ph !== "Full") continue;
        const got = ss.phase(moon, { year: t.year, month: regular.indexOf(t.month) + 1, day: t.day });
        const want = ph === "New" ? 0 : 4;
        expect(Math.min((got - want + 8) % 8, (want - got + 8) % 8), `${key} ${moon.name} day ${d}`).toBeLessThanOrEqual(1);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
  }
});

test("leap rules, festival days, seasons and holidays carry over, and what can't is said", () => {
  const harptos = V.seasonsAndStars({ name: "FR", calendar: E.PRESETS.harptos.calendar, current_shift: 0 }, E.PRESETS.harptos.holidays);
  expect(harptos.calendar.intercalary.find(i => i.name === "Shieldmeet")).toMatchObject({ leapYearOnly: true, days: 1 });
  expect(harptos.calendar.intercalary.find(i => i.name === "Midwinter")).toMatchObject({ after: "Hammer", days: 1, leapYearOnly: false });
  expect(harptos.lost.join(" ")).toContain("festival days themselves are in the calendar by name");

  const greg = V.seasonsAndStars({ name: "G", calendar: E.PRESETS.gregorian.calendar, current_shift: 0 }, E.PRESETS.gregorian.holidays);
  expect(greg.calendar.leapYear).toEqual({ rule: "gregorian", month: "February", extraDays: 1 });
  expect(greg.calendar.events.find(e => e.name === "New Year's Day")).toMatchObject({ recurrence: { type: "fixed", month: 1, day: 1 }, duration: "1d" });
  expect(greg.calendar.seasons.length).toBe(4);
  for (const s of greg.calendar.seasons) for (const k of ["startMonth", "endMonth"]) expect(s[k]).toBeGreaterThanOrEqual(1);

  const glorantha = V.seasonsAndStars({ name: "Gl", calendar: E.PRESETS.glorantha.calendar, current_shift: 0 });
  expect(glorantha.calendar.moons.map(m => m.name)).not.toContain("Red Moon");
  expect(glorantha.lost.join(" ")).toContain("Red Moon");

  // a holiday Seasons & Stars can't repeat, and an nth-weekday one it can
  const custom = { months: [{ name: "One", days: 30 }, { name: "Two", days: 30 }], weekdays: ["A", "B", "C"], epochYear: 1 };
  const r = V.seasonsAndStars({ name: "C", calendar: custom, current_shift: 4 * 35 }, [
    { name: "Moon feast", rule: { type: "moon_phase", moon: 0, phase: 4 } },
    { name: "Second B", rule: { type: "nth_weekday", month: 1, weekday: 1, n: 2 }, is_secret: true },
    { name: "Every third year", rule: { type: "fixed", month: 0, day: 3, every_years: 3, from_year: 2 } }]);
  expect(r.lost.join(" ")).toContain("Moon feast");
  expect(r.calendar.events).toEqual([
    expect.objectContaining({ name: "Second B", recurrence: { type: "ordinal", month: 2, occurrence: 2, weekday: 1 }, visibility: "gm-only" }),
    expect.objectContaining({ name: "Every third year", recurrence: { type: "interval", intervalYears: 3, anchorYear: 2, month: 1, day: 3 }, startYear: 2 })]);
  expect(r.today).toEqual({ year: 1, month: 2, day: 6 });
});

// ------------------------------------------------------------ the Encyclopedia

const entries = [
  { id: 1, name: "Altdorf", category: "location", aliases: ["The Capital"], tags: [{ name: "City" }], notes: "<p>Seat of the <strong>Emperor</strong>.</p><aside>The cult meets here.</aside>",
    gm_notes: "<p>Plague in spring</p>", is_secret: false, links: [{ label: "home of", to: 2, note: "", is_secret: false }, { label: "hides", to: 3, note: "", is_secret: true }],
    files: [{ id: 9, name: "map.png", mime: "image/png", kind: "image", caption: "City map", is_secret: false, credit: { title: "Old map", author: "A. Painter", license: "CC BY 4.0", source: "Openverse" } },
      { id: 10, name: "secret.pdf", mime: "application/pdf", kind: "file", caption: null, is_secret: true }] },
  { id: 2, name: "Gunther: the [Smith]", category: "person", aliases: [], tags: [], notes: "<p>Makes swords</p>", gm_notes: "", is_secret: false, links: [{ label: "lives in", to: 1, note: "since 2510", is_secret: false }], files: [] },
  { id: 3, name: "Cult of Change", category: "group", aliases: [], tags: [], notes: "<p>Very secret</p>", gm_notes: "", is_secret: true, links: [{ label: "hidden in", to: 1, note: "", is_secret: true }], files: [] },
];
const toMarkdown = html => html.replace(/<aside>(.*?)<\/aside>/g, "> 🔒 GM only: $1").replace(/<strong>(.*?)<\/strong>/g, "**$1**").replace(/<\/?p>/g, "");

test("without GM-only things, an export leaves out secret entries, connections, files, notes and paragraphs", () => {
  const open = Lore.pick(entries);
  expect(open.map(e => e.name)).toEqual(["Altdorf", "Gunther: the [Smith]"]);
  expect(open[0].notes).not.toContain("cult");
  expect(open[0].gm_notes).toBe("");
  expect(open[0].links.map(l => l.to)).toEqual([2]);
  expect(open[0].files.map(f => f.name)).toEqual(["map.png"]);
  const all = Lore.pick(entries, { gmOnly: true });
  expect(all.length).toBe(3);
  expect(all[0].notes).toContain("cult");
  expect(all[0].links.length).toBe(2);
});

test("the Markdown pages link to each other and their pictures, credit them, and file names are safe", () => {
  const list = Lore.pick(entries);
  const pics = Lore.plan(list);
  expect(pics.map(p => p.path)).toEqual(["pictures/Altdorf City map.png"]);
  const { files } = Lore.markdown(list, pics, { campaign: "Reik", gm: true, gmOnly: false, toMarkdown, date: "2026-10-30" });
  expect(files.map(f => f.path)).toEqual(["Encyclopedia.md", "Altdorf.md", "Gunther the Smith.md"]);
  const alt = files[1].text;
  expect(alt).toMatch(/^# Altdorf\n\n\*Location · Also called The Capital · Tags: City\*/);
  expect(alt).toContain("![City map](pictures/Altdorf%20City%20map.png)");
  expect(alt).toContain("*Old map by A. Painter, CC BY 4.0, Openverse*");
  expect(alt).toContain("- home of [Gunther: the \\[Smith\\]](Gunther%20the%20Smith.md)");
  expect(alt).not.toContain("GM notes");
  expect(alt).toContain("GM view, without GM-only notes");
  expect(files[0].text).toContain("## Location\n\n- [Altdorf](Altdorf.md)");
  const gm = Lore.markdown(Lore.pick(entries, { gmOnly: true }), [], { campaign: "Reik", gm: true, gmOnly: true, toMarkdown, date: "2026-10-30" }).files;
  expect(gm.find(f => f.path === "Altdorf.md").text).toContain("## 🔒 GM notes\n\nPlague in spring");
  expect(gm.find(f => f.path === "Cult of Change.md").text).toContain("🔒 GM only");
});

test("the Foundry journal has a page per entry linked to each other, and hides what is GM-only from players", () => {
  let n = 0;
  const random = () => ((n++ * 7) % 62) / 62;
  const list = Lore.pick(entries, { gmOnly: true });
  const j = Lore.foundry(list, Lore.plan(list), { campaign: "Reik Campaign", gmOnly: true, random });
  expect(j.name).toBe("Reik Campaign Encyclopedia");
  expect(j.pages.map(p => p.name)).toEqual(["Altdorf", "Altdorf (GM notes)", "Gunther: the [Smith]", "Cult of Change"]);
  for (const p of j.pages) { expect(p._id).toMatch(/^[A-Za-z0-9]{16}$/); expect(p).toMatchObject({ type: "text", text: { format: 1 } }); }
  expect(new Set(j.pages.map(p => p._id)).size).toBe(4);
  const [alt, gmNotes, gunther, cult] = j.pages;
  expect(alt.ownership).toEqual({ default: -1 });
  expect(gmNotes.ownership).toEqual({ default: 0 });
  expect(cult.ownership).toEqual({ default: 0 });
  expect(alt.text.content).toMatch(/<section class="secret" id="secret-[A-Za-z0-9]{16}"><p>The cult meets here.<\/p><\/section>/);
  expect(alt.text.content).toContain(`<img src="chronicle/reik-campaign/pictures/Altdorf City map.png" alt="City map">`);
  expect(alt.text.content).toContain(`home of @UUID[.${gunther._id}]{Gunther: the [Smith]}`);
  expect(gunther.text.content).toContain(`lives in @UUID[.${alt._id}]{Altdorf}: since 2510`);
  expect(Lore.foundryFolder("Reik Campaign")).toBe("chronicle/reik-campaign");
});

test("the zip holds each file whole, as any unzip program reads it", () => {
  const files = [{ path: "Encyclopedia.md", data: "# Hello\n" }, { path: "pictures/Ünïcode name.png", data: new Uint8Array([137, 80, 78, 71, 0, 255]) }];
  const z = Buffer.from(Lore.zip(files, new Date(2026, 9, 30, 12, 0, 0)));
  // read it back by its central directory, as unzip does
  const end = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(z.readUInt16LE(end + 10)).toBe(2);
  let at = z.readUInt32LE(end + 16);
  for (const f of files) {
    expect(z.readUInt32LE(at)).toBe(0x02014b50);
    const size = z.readUInt32LE(at + 24), nameLen = z.readUInt16LE(at + 28), local = z.readUInt32LE(at + 42), crc = z.readUInt32LE(at + 16);
    expect(z.subarray(at + 46, at + 46 + nameLen).toString("utf8")).toBe(f.path);
    expect(z.readUInt16LE(at + 8) & 0x0800).toBe(0x0800);
    const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
    const data = z.subarray(start, start + size), want = Buffer.from(f.data);
    expect(data.equals(want)).toBe(true);
    expect(crc).toBe(zlib.crc32(want));
    at += 46 + nameLen;
  }
});

test("a handout is the entry's name, what it is, its notes and its connections, escaped", () => {
  const e = { ...Lore.pick(entries)[1] };
  const html = Lore.handout(e, new Map([[1, "Altdorf <city>"]]));
  expect(html).toBe("<h2>Gunther: the [Smith]</h2>\n<p><em>Person</em></p>\n<p>Makes swords</p>\n<h3>Connections</h3><ul><li>lives in Altdorf &lt;city&gt;: since 2510</li></ul>");
});
