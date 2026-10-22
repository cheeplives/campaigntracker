// Settings → Tools exports the calendar as JSON, and the same file imports into
// another campaign's Settings or starts a new campaign on that calendar.
const fs = require("fs");
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

async function exportCalendar(page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ Export calendar" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/-calendar\.json$/);
  return JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
}
/** Click `button` and give its file picker a JSON file holding `obj` (or the text as it is). */
async function importFile(page, button, obj) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: button }).click()]);
  await chooser.setFiles({ name: "calendar.json", mimeType: "application/json", buffer: Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)) });
}
const ok = page => page.getByRole("dialog").getByRole("button", { name: "OK" }).click();

test("a calendar exports to JSON and imports into Settings and a new campaign", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Ines");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Calendar file ${gm.id}`);
  await api(page, "campaign_update", { calendar: { name: "Twin Moons", months: [{ name: "Firstmonth", days: 30 }, { name: "Secondmonth", days: 30 }], weekdays: ["One", "Two", "Three", "Four", "Five"], epochYear: 1,
    moons: [{ name: "Pale", cycle: 20, ref: 0, brightness: 1, color: "#e8e4d8" }] } }, cid);
  await api(page, "holiday_save", { name: "Founding Day", rule: { type: "fixed", month: 1, day: 5 }, color: "#336699", description: "The city's birthday" }, cid);

  // Export: the calendar, its holidays and the date reached (shift 8 is day 2, the 3rd of Firstmonth).
  await page.goto(`index.html#/c/${cid}/settings`);
  const file = await exportCalendar(page);
  expect(file.format).toBe("campaign-chronicle-calendar");
  expect(file.version).toBe(1);
  expect(file.calendar.name).toBe("Twin Moons");
  expect(file.calendar.months.map(m => m.name)).toEqual(["Firstmonth", "Secondmonth"]);
  expect(file.calendar.moons[0].name).toBe("Pale");
  expect(file.calendar.shiftOrder).toBeUndefined();
  expect(file.today).toEqual({ year: 1, month: 0, day: 3 });
  expect(file.holidays).toEqual([{ name: "Founding Day", rule: { type: "fixed", month: 1, day: 5 }, description: "The city's birthday", color: "#336699", is_secret: false }]);

  // Import into another campaign's Settings: the calendar is replaced and the missing holiday added.
  const other = await makeCampaign(page, `Other ${gm.id}`);
  // Only the hash changes, so goto returns before the new campaign's Settings replace the old ones. A click while the page
  // is being swapped can land half on each and open no file picker, so wait for the new campaign's name first.
  await page.goto(`index.html#/c/${other}/settings`);
  await expect(page.getByRole("heading", { name: `Other ${gm.id}` })).toBeVisible();
  await importFile(page, "Import calendar…", "not json");
  await expect(page.locator("#toast")).toHaveText("That file is not JSON.");
  await importFile(page, "Import calendar…", { months: [] });
  await expect(page.locator("#toast")).toHaveText("That file has no months, so it is not a calendar.");
  await importFile(page, "Import calendar…", file);
  await expect(page.getByRole("dialog")).toContainText("Twin Moons");
  await ok(page);
  await expect(page.getByRole("dialog")).toContainText("Founding Day");
  await ok(page);
  await expect(page.locator("#toast")).toHaveText("Imported Twin Moons and 1 holiday");
  let r = (await api(page, "campaign", undefined, other)).json;
  expect(r.campaign.calendar.name).toBe("Twin Moons");
  expect(r.campaign.calendar.moons[0].name).toBe("Pale");
  expect(r.campaign.calendar.timeMode).toBe("shifts4");
  expect(r.holidays.map(h => h.name)).toEqual(["Founding Day"]);
  // A second import doesn't offer the holiday again.
  await importFile(page, "Import calendar…", file);
  await ok(page);
  await expect(page.locator("#toast")).toHaveText("Imported Twin Moons");
  r = (await api(page, "campaign", undefined, other)).json;
  expect(r.holidays.length).toBe(1);

  // A new campaign starts on the file's calendar, its holidays and the date it had reached.
  await page.goto("index.html");
  await page.getByRole("button", { name: "+ New campaign" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Copied calendar");
  await importFile(page, "Import calendar from file…", file);
  await expect(page.getByLabel("Calendar preset")).toHaveValue("file");
  await expect(page.locator("#toast")).toHaveText("Imported Twin Moons and 1 holiday");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Copied calendar" })).toBeVisible();
  const nid = Number(page.url().match(/#\/c\/(\d+)/)[1]);
  r = (await api(page, "campaign", undefined, nid)).json;
  expect(r.campaign.calendar.months.map(m => m.name)).toEqual(["Firstmonth", "Secondmonth"]);
  expect(r.holidays.map(h => h.name)).toEqual(["Founding Day"]);
  expect(Math.floor(Number(r.campaign.current_shift) / 4)).toBe(2);
  expectNoErrors(errors);
});
