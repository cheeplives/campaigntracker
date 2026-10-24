// The session notes' shorthand and draft, under Node (static/sessions.js and static/engine.js need no page): the date
// reader behind ">12 Firstmonth", every form of ">" time jump, the ! ? > marks, and the draft built from the notes.
const { test, expect } = require("@playwright/test");
const path = require("path");
const E = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const Sessions = require(path.join(__dirname, "..", "..", "static", "sessions.js"));

/** The helpers' test calendar: two 30-day months, a five-day week, year 1 first. */
function calendar(extra = {}) {
  const c = { months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1, ...extra };
  E.prep(c);
  return c;
}
const note = (id, text, depth, abs_shift) => ({ id, position: id, depth, text, abs_shift, is_covered: false });

test("parseDate reads a day and a month, with or without a year, and refuses a day the month hasn't got", () => {
  const c = calendar();
  expect(E.parseDate(c, "12 Firstmonth", 40)).toBe(E.toAbs(c, 1, 0, 12));
  expect(E.parseDate(c, "12 sec", 40)).toBe(E.toAbs(c, 1, 1, 12));
  expect(E.parseDate(c, "Firstmonth 3 2", 0)).toBe(E.toAbs(c, 2, 0, 3));
  expect(E.parseDate(c, "3 Firstmonth 2", 0)).toBe(E.toAbs(c, 2, 0, 3));
  expect(E.parseDate(c, "12 Firstmonth", 70)).toBe(E.toAbs(c, 2, 0, 12)); // the year of the day it's near
  expect(E.parseDate(c, "31 Firstmonth", 40)).toBeNull();
  expect(E.parseDate(c, "12 Nomonth", 40)).toBeNull();
  expect(E.parseDate(c, "", 40)).toBeNull();
});

test("parseJump moves the stamp by days, weeks and months, to a shift, a date, or back to the clock", () => {
  const c = calendar(), at = 9; // day 2, Midday
  expect(Sessions.parseJump(c, ">+1", at, 0)).toBe(13);
  expect(Sessions.parseJump(c, ">+9", at, 0)).toBe(at + 36);
  expect(Sessions.parseJump(c, ">+3d", at, 0)).toBe(at + 12);
  expect(Sessions.parseJump(c, ">+2w", at, 0)).toBe(at + 2 * 5 * 4);
  expect(Sessions.parseJump(c, ">+1m", at, 0)).toBe(E.addMonths(c, 2, 1) * 4 + 1);
  expect(Sessions.parseJump(c, ">dusk", at, 0)).toBe(10);
  expect(Sessions.parseJump(c, ">du", at, 0)).toBe(10);
  expect(Sessions.parseJump(c, "> Dawn", at, 0)).toBe(8);
  expect(Sessions.parseJump(c, ">+1 dawn", at, 0)).toBe(12);
  expect(Sessions.parseJump(c, ">12 Firstmonth", at, 0)).toBe(E.toAbs(c, 1, 0, 12) * 4 + 1);
  expect(Sessions.parseJump(c, ">12 Firstmonth overnight", at, 0)).toBe(E.toAbs(c, 1, 0, 12) * 4 + 3);
  expect(Sessions.parseJump(c, ">", at, 5)).toBe(5);
  expect(Sessions.parseJump(c, ">wibble", at, 0)).toBeNull();
  expect(Sessions.parseJump(c, ">+", at, 0)).toBeNull();
  expect(Sessions.parseJump(c, "not a jump", at, 0)).toBeNull();
});

test("parseJump takes Day and Night in two-shift mode and hours in hours mode", () => {
  const two = calendar({ timeMode: "shifts2" });
  expect(Sessions.parseJump(two, ">night", 4, 0)).toBe(5);
  expect(Sessions.parseJump(two, ">+1 day", 5, 0)).toBe(6);
  const hrs = calendar({ timeMode: "hours", hoursPerDay: 24 });
  expect(Sessions.parseJump(hrs, ">14", 30, 0)).toBe(24 + 14);
  expect(Sessions.parseJump(hrs, ">14:00", 30, 0)).toBe(24 + 14);
  expect(Sessions.parseJump(hrs, ">+1 9", 30, 0)).toBe(48 + 9);
  expect(Sessions.parseJump(hrs, ">25", 30, 0)).toBeNull();
});

test("mark reads the first character; stampAt starts from the last jump", () => {
  expect(Sessions.mark("! +2 Sensor Roll")).toBe("!");
  expect(Sessions.mark("  ? who is Essen")).toBe("?");
  expect(Sessions.mark(">+1")).toBe(">");
  expect(Sessions.mark("Spotted the Fang")).toBe("");
  const notes = [note(1, "a", 0, 8), note(2, ">+1", 0, 12), note(3, "b", 0, 12), note(4, ">dusk", 0, 14), note(5, "c", 1, 14)];
  expect(Sessions.stampAt(notes, 3)).toBe(14);
  expect(Sessions.stampAt([note(1, "a", 0, 8)], 3)).toBe(3);
});

test("draftHtml makes a paragraph of each note and its indented lines, skips ! and >, and puts ? lines at the end GM only", () => {
  const c = calendar();
  const notes = [note(1, "Sensor set off on approach to Jupiter", 0, 9), note(2, "Listening Station - comm relay satellite", 1, 9),
    note(3, "edited data to remove Tevari", 2, 9), note(4, "! +2 Sensor Roll", 0, 9), note(5, "? Who is Essen", 0, 9),
    note(6, "Hera called the Harbormaster", 0, 9)];
  expect(Sessions.draftHtml(c, notes)).toBe(
    "<p>Sensor set off on approach to Jupiter. Listening Station - comm relay satellite. Edited data to remove Tevari.</p>"
    + "<p>Hera called the Harbormaster.</p><aside>Loose ends: Who is Essen</aside>");
});

test("draftHtml heads each in-game day when there are several, escapes the text, and gives nothing for only ! lines", () => {
  const c = calendar();
  const notes = [note(1, "Arrived at <Iapetus> & docked", 0, 9), note(2, ">+9", 0, 45), note(3, "Took a job to Europa!", 0, 45)];
  expect(Sessions.draftHtml(c, notes)).toBe(
    `<h3>${E.fmtDate(c, 2)}</h3><p>Arrived at &lt;Iapetus&gt; &amp; docked.</p><h3>${E.fmtDate(c, 11)}</h3><p>Took a job to Europa!</p>`);
  expect(Sessions.draftHtml(c, [note(1, "! roll", 0, 9), note(2, ">+1", 0, 13)])).toBe("");
  // an indented line with no paragraph yet starts one
  expect(Sessions.draftHtml(c, [note(1, "just a detail", 2, 9)])).toBe("<p>Just a detail.</p>");
});

test("draftHtml keeps the lines under a ! or ? line out of the paragraphs players read", () => {
  const c = calendar();
  const notes = [note(1, "Arrived at the station", 0, 9), note(2, "? Who sent the letter", 0, 9), note(3, "Tevari's seal on it", 1, 9),
    note(4, "! Stealth roll", 0, 9), note(5, "failed by 2", 1, 9), note(6, "Left at dusk", 0, 9)];
  expect(Sessions.draftHtml(c, notes)).toBe("<p>Arrived at the station.</p><p>Left at dusk.</p><aside>Loose ends: Who sent the letter (Tevari's seal on it)</aside>");
});

test("draftHtml puts one heading per day in day order, whatever order the notes are in", () => {
  const c = calendar();
  const notes = [note(1, "on day two", 0, 9), note(2, "back on day one", 0, 5), note(3, "day two again", 0, 10)];
  expect(Sessions.draftHtml(c, notes)).toBe(`<h3>${E.fmtDate(c, 1)}</h3><p>Back on day one.</p><h3>${E.fmtDate(c, 2)}</h3><p>On day two.</p><p>Day two again.</p>`);
});

test("parseLines makes a note of each non-blank line, its depth from the indent, in spaces or tabs", () => {
  const got = Sessions.parseLines("Docked at Iapetus\n\n  Listening station quiet\n    edited the data\n  Harbormaster called\n\tTabbed in\nBack out\n          too deep\n");
  expect(got.map(n => [n.text, n.depth, n.line])).toEqual([["Docked at Iapetus", 0, 1], ["Listening station quiet", 1, 3], ["edited the data", 2, 4],
    ["Harbormaster called", 1, 5], ["Tabbed in", 2, 6], ["Back out", 0, 7], ["too deep", 1, 8]]);
  expect(Sessions.parseLines("a\n b\n  c\n   d\n    e").map(n => n.depth)).toEqual([0, 1, 2, 3, 3]);
  expect(Sessions.parseLines("  \n\n")).toEqual([]);
});

test("draftHtml puts a 🔒 line and the lines under it in a GM-only paragraph, never a plain one", () => {
  const c = calendar();
  const notes = [note(1, "Arrived at the station", 0, 9), note(2, "🔒 Secret notes · 3 Firstmonth", 0, 9), note(3, "Essen is Tevari's agent", 1, 9),
    note(4, "the seal is forged", 1, 9), note(5, "Left at dusk", 0, 9)];
  expect(Sessions.draftHtml(c, notes)).toBe("<p>Arrived at the station.</p><p>Left at dusk.</p><aside>Secret notes · 3 Firstmonth: Essen is Tevari's agent; the seal is forged</aside>");
});
