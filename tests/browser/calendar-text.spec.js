// The Settings tab's calendar boxes, under Node (static/calendar-text.js needs only the engine): a calendar shown as
// text and read back is the same calendar, festival months, leap days, moons and eras included, and a box that can't be
// read says why.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { calToText, textToCal } = require(path.join(__dirname, "..", "..", "static", "calendar-text.js"));

/** The other fields of the form, as the Settings tab sends them with the boxes. */
const form = (boxes, extra = {}) => ({ cal_name: "Reckoning", epochYear: "1", yearSuffix: "AR", weekdayOffset: "0", dateFormat: "",
  hoursPerDay: "24", cal_lighting: "", leap_every: "4", leap_skip: "0", leap_unskip: "0", cal_hemisphere: "north", ...boxes, ...extra });

test("a calendar shown as text and read back is the same calendar", () => {
  const cal = {
    weekdays: ["Oneday", "Twoday", "Threeday"],
    months: [{ name: "Firstmonth", days: 30 }, { name: "Midfeast", days: 1, intercalary: true, keepWeekday: true },
      { name: "Leapling", days: 0, leapDays: 1, intercalary: true }, { name: "Lastmonth", days: 29, leapDays: 1, weeks: ["Early", "Late"] }],
    moons: [{ name: "Selune", cycle: 30, ref: 2, brightness: 1, color: "#e8e4d8", erratic: false },
      { name: "Blood", cycle: 13, ref: 0, brightness: 0.5, color: "#aa0000", erratic: true, kind: "red_moon" }],
    eras: [{ name: "Old", abbr: "OR", start: 1, before: true }, { name: "New", abbr: "NR", start: 500, restart: true }],
  };
  const t = calToText(cal);
  expect(t.weekdays).toBe("Oneday, Twoday, Threeday");
  expect(t.months.split("\n")).toEqual(["Firstmonth, 30, 0", "Midfeast, 1, 0, festival weekday", "Leapling, 0, 1, festival", "Lastmonth, 29, 1"]);
  const back = textToCal(form(t), cal, []);
  // week names have no box: a month keeps the ones it had under the same name
  expect(back.months).toEqual(cal.months);
  expect(back.moons).toEqual(cal.moons);
  expect(back.eras).toEqual(cal.eras);
  expect(back.weekdays).toEqual(cal.weekdays);
  expect(back.leap).toEqual({ every: 4, skip: 0, unskip: 0 });
  expect(calToText(back)).toEqual(t);
});

test("a box that can't be read says why", () => {
  const base = { months: [{ name: "Firstmonth", days: 30 }] };
  const t = calToText(base);
  expect(() => textToCal(form({ ...t, months: "" }), base, [])).toThrow("Add at least one month");
  expect(() => textToCal(form({ ...t, eras: "Dawn, DA" }), base, [])).toThrow('Era "Dawn" needs a first year');
  expect(() => textToCal(form({ ...t, eras: "A, , 1, before\nB, , 2, before" }), base, [])).toThrow("Only one era can count the years before");
  // no leap rule, and no eras, leave neither behind
  const plain = textToCal(form(t, { leap_every: "0" }), base, []);
  expect(plain.leap).toBeNull();
  expect(plain.eras).toBeUndefined();
});
