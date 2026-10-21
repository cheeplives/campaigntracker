// Eras name stretches of years (1492 DR): an era's abbreviation labels its years, a
// restart era counts from 1, and one era can count back the years before it (BCE).
const { test, expect } = require("@playwright/test");
const path = require("path");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

test("engine: era labels, restarts and the years before", () => {
  const cal = {
    months: [{ name: "Hammer", days: 30 }], weekdays: [], epochYear: 1, yearSuffix: "OLD",
    eras: [
      { name: "Dale Reckoning", abbr: "DR", start: 1 },
      { name: "Reign of Aldric", abbr: "RA", start: 1500, restart: true },
      { name: "Before the Dales", abbr: "BD", start: 1, before: true },
    ],
  };
  Engine.prep(cal);
  expect([-1, 0, 1, 1492, 1499, 1500, 1526].map(y => Engine.yearLabel(cal, y)))
    .toEqual(["2 BD", "1 BD", "1 DR", "1492 DR", "1499 DR", "1 RA", "27 RA"]);
  // eraYear turns an era's own year number back into the calendar year
  for (const y of [-1, 0, 1, 1492, 1500, 1526]) {
    const { era, year } = Engine.eraOf(cal, y);
    expect(Engine.eraYear(era, year)).toBe(y);
  }
  cal.dateFormat = "{d} {M} {Y}, {E}";
  expect(Engine.fmtDate(cal, Engine.toAbs(cal, 1526, 0, 3))).toBe("3 Hammer 27 RA, Reign of Aldric");
  // an imported file can hold anything: what isn't an era is skipped
  expect(Engine.yearLabel({ ...cal, eras: ["junk", null, { name: "Odd", abbr: "OD", start: "x" }] }, 5)).toBe("5 OD");
  expect(Engine.yearLabel({ ...cal, eras: "junk" }, 5)).toBe("5 OLD");
  // without a "before" era, years before the first era keep the plain suffix
  const noBefore = { ...cal, eras: cal.eras.slice(0, 2) };
  expect(Engine.yearLabel(noBefore, 0)).toBe("0 OLD");
  // the Gregorian preset has no year 0: the year before 1 is 1 BCE
  const greg = JSON.parse(JSON.stringify(Engine.PRESETS.gregorian.calendar));
  Engine.prep(greg);
  expect([0, 1, 2026].map(y => Engine.yearLabel(greg, y))).toEqual(["1 BCE", "1", "2026"]);
});

test("a GM adds eras in Settings, and the calendar labels and date picker use them", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Elm");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Eras ${gm.id}`); // now: year 1

  await page.goto(`./#/c/${cid}/settings`);
  await page.locator('textarea[name="eras"]').fill("Old Age, OA, -50\nNew Age, NA, 1, restart\nBefore Time, BT, -50, before");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByText("Calendar saved")).toBeVisible();
  const { json } = await api(page, "campaign", undefined, cid);
  expect(json.campaign.calendar.eras).toEqual([
    { name: "Old Age", abbr: "OA", start: -50 },
    { name: "New Age", abbr: "NA", start: 1, restart: true },
    { name: "Before Time", abbr: "BT", start: -50, before: true },
  ]);
  // the eras box shows them again as they were typed
  await expect(page.locator('textarea[name="eras"]')).toHaveValue("Old Age, OA, -50\nNew Age, NA, 1, restart\nBefore Time, BT, -50, before");

  await page.goto(`./#/c/${cid}/calendar`);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.locator(".calbar h2")).toHaveText("Firstmonth 1 NA");
  await expect(page.locator(".calbar h2")).toHaveAttribute("data-tip", /New Age: year 1 of the era, calendar year 1/);

  // the date picker takes a year in an era: 10 OA is calendar year 10 before New Age began
  const jump = page.locator(".calbar .jump");
  await expect(jump.getByLabel("Era")).toHaveValue(/\d/);
  await jump.getByLabel("Era").selectOption({ label: "OA" });
  await jump.getByLabel("Year").fill("-10");
  await jump.getByRole("button", { name: "Go" }).click();
  await expect(page.locator(".calbar h2")).toHaveText("Firstmonth -10 OA");
  await jump.getByLabel("Era").selectOption({ label: "BT" });
  await jump.getByLabel("Year").fill("3");
  await jump.getByRole("button", { name: "Go" }).click();
  await expect(page.locator(".calbar h2")).toHaveText("Firstmonth 3 BT");

  // a second "before" era is refused
  await page.goto(`./#/c/${cid}/settings`);
  await page.locator('textarea[name="eras"]').fill("A, A, 1, before\nB, B, 5, before");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByText("Only one era can count the years before")).toBeVisible();
  expectNoErrors(errors);
});
