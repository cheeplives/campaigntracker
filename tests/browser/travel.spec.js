// The travel planner offers sample speeds and distances, plans overland trips in
// shifts (a quarter of the calendar's day), and the campaign's genre limits the
// modes and samples on offer.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, makeCampaign } = require("./helpers");

test("samples fill the planner, trips count shifts, and the genre limits the modes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Travel ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/travel`);

  // A campaign with no genre saved keeps every mode.
  const mode = page.locator("select.travel-mode");
  await expect(mode.locator("option")).toHaveCount(5);

  // Overland: a sample fills the speed; 60 km at 5 km/h is 12 hours, two 6-hour shifts, done in one day.
  const sample = page.getByLabel("Sample", { exact: true });
  await sample.selectOption({ label: "Airliner at cruise: 850 km/h · 528 mph" });
  await expect(page.locator("input[name=speed]")).toHaveValue("850");
  await page.getByLabel("Sample units").selectOption("mi");
  await expect(page.locator("input[name=speed]")).toHaveValue("528");
  await page.getByLabel("Sample units").selectOption("km");
  await sample.selectOption({ label: "Walking / marching (average adult): 5 km/h · 3.11 mph" });
  await expect(page.locator("select[name=shifts]")).toHaveValue("2");
  await expect(page.locator("input[name=hours_per_day]")).toHaveCount(0);
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".result")).toContainText("12.0 hours moving at 5/h = 2.0 shifts of 6 h");
  await expect(page.locator(".result h3")).toHaveText("Travel time: 12.0 h");
  await expect(page.locator(".depart")).toContainText("2 shifts (0.5 days)");
  // Four shifts a day, 120 km: 24 hours moving, one day.
  await page.locator("input[name=distance]").fill("120");
  await page.locator("select[name=shifts]").selectOption("4");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".depart")).toContainText("4 shifts (1.0 days)");
  // Over two days at two shifts a day, the night between counts: 24 h moving = 4 shifts, arriving at the end of day 2's second shift.
  await page.locator("select[name=shifts]").selectOption("2");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".depart")).toContainText("6 shifts (1.5 days)");

  // Space: star pickers fill the light-years between two systems.
  await mode.selectOption("relativistic");
  await page.getByLabel("From star").selectOption({ index: 2 }); // Alpha Centauri A/B
  await page.getByLabel("To star").selectOption({ index: 6 }); // Sirius
  await expect(page.locator("input[name=distance]")).toHaveValue("9.54");
  await mode.selectOption("brachistochrone");
  await page.getByLabel("Sample", { exact: true }).selectOption({ label: "Earth to Mars, closest (0.52 AU)" });
  await expect(page.locator("input[name=distance]")).toHaveValue("0.52");
  await expect(page.locator("select[name=unit]")).toHaveValue("AU");

  // Fantasy: overland only, and no engines among the samples.
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator("select[name=genre]").selectOption("fantasy");
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(mode.locator("option")).toHaveCount(1);
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "Horseback, at a walk" })).toHaveCount(1);
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "Airliner" })).toHaveCount(0);

  // Modern: overland and orbital transfers.
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator("select[name=genre]").selectOption("modern");
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(mode.locator("option")).toHaveText(["Overland / sea / air (speed × shifts a day)", "Orbital transfer (Hohmann, minimum fuel)"]);
  expectNoErrors(errors);
});
