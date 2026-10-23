// The travel planner offers sample speeds and distances, plans overland trips in
// shifts (a quarter of the calendar's day), and the campaign's genre limits the
// modes and samples on offer.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, approve, api, makeCampaign } = require("./helpers");

test("samples fill the planner, trips count shifts, and the genre limits the modes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Rin");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Travel ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/travel`);

  // A campaign with no genre saved keeps every mode.
  const mode = page.locator("select.travel-mode");
  await expect(mode.locator("option")).toHaveCount(8);

  // Each speed mode lists only its own samples, and the first one is filled in.
  const sample = page.getByLabel("Sample", { exact: true });
  await mode.selectOption("air");
  await expect(page.locator("input[name=speed]")).toHaveValue("48");
  await expect(sample.locator("option", { hasText: "Horseback" })).toHaveCount(0);
  await sample.selectOption({ label: "Airliner at cruise (Boeing 787, Mach 0.85): 903 km/h" });
  await page.locator("input[name=distance]").fill("1000");
  await expect(page.locator("input[name=speed]")).toHaveValue("903");
  // One units switch at the top converts every box and relabels the samples.
  const units = { selectOption: v => page.locator(".travel-units").getByLabel(v === "imperial" ? "Imperial" : "Metric").check() };
  await expect(page.locator(".travel-units").getByLabel("Metric")).toBeChecked();
  // The units sit in the planner's header, against its right edge.
  const ub = await page.locator(".travel-units").boundingBox(), cb = await page.locator("form.card").first().boundingBox();
  expect(cb.x + cb.width - (ub.x + ub.width)).toBeLessThan(24);
  await units.selectOption("imperial");
  await expect(page.locator("input[name=speed]")).toHaveValue("561");
  await expect(page.locator("input[name=distance]")).toHaveValue("621");
  await expect(sample.locator("option:checked")).toHaveText("Airliner at cruise (Boeing 787, Mach 0.85): 561 mph");
  await expect(page.getByText("Speed (mph)")).toBeVisible();
  await mode.selectOption("sea");
  await expect(sample.locator("option", { hasText: "Container ship" })).toHaveCount(1);
  await expect(sample.locator("option", { hasText: "Airliner" })).toHaveCount(0);
  await expect(page.locator("select[name=shifts]")).toHaveValue("4");
  await expect(page.locator("select[name=terrain]")).toHaveCount(0);

  // Overland: 60 km at 5 km/h is 12 hours, two 6-hour shifts, done in one day.
  await mode.selectOption("overland");
  await expect(sample.locator("option", { hasText: "Container ship" })).toHaveCount(0);
  await units.selectOption("metric");
  await sample.selectOption({ label: "Walking (typical adult, 1.4 m/s): 5 km/h" });
  await page.locator("input[name=distance]").fill("60");
  // The sample box sits level with the distance box beside it (when they share a row).
  const sb = await sample.boundingBox(), db = await page.locator("input[name=distance]").boundingBox();
  if (Math.abs(sb.y - db.y) < sb.height) expect(Math.abs(sb.y - db.y)).toBeLessThan(2);
  await expect(page.locator("select[name=shifts]")).toHaveValue("2");
  await expect(page.locator("select[name=shifts] option")).toHaveText(["1 shift", "2 shifts", "3 shifts", "4 shifts", "Determine shifts"]);
  // On a wide screen the distance and speed boxes are a quarter narrower than the shifts box, and the sample list wider.
  const wid = async sel => (await page.locator(sel).boundingBox()).width;
  if (await wid("select[name=shifts]") > 150 && (await sample.boundingBox()).y === (await page.locator("select[name=shifts]").boundingBox()).y) {
    expect(await wid("input[name=distance]") / await wid("select[name=shifts]")).toBeCloseTo(0.75, 1);
    expect(await wid("input[name=speed]") / await wid("select[name=shifts]")).toBeCloseTo(0.75, 1);
    expect(await wid("select[aria-label=Sample]")).toBeGreaterThan(await wid("select[name=shifts]"));
  }
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

  // Determine shifts: 100 km at 5 km/h through woods (×2) is 40 hours, 6.67 six-hour shifts, so 7 shifts of travel, passed back to back.
  await page.locator("input[name=distance]").fill("100");
  await page.locator("select[name=terrain]").selectOption("2");
  await page.locator("select[name=shifts]").selectOption("auto");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".result h3")).toHaveText("7 shifts of travel");
  await expect(page.locator(".result")).toContainText("40.0 hours moving at 5/h (terrain ×2) = 6.67 shifts of 6 h");
  await expect(page.locator(".depart")).toContainText("7 shifts (1.8 days)");
  // The choice survives a units switch.
  await units.selectOption("imperial");
  await expect(page.locator("select[name=shifts]")).toHaveValue("auto");
  await units.selectOption("metric");
  await page.locator("select[name=terrain]").selectOption("1");

  // Space: star pickers fill the light-years between two systems.
  await mode.selectOption("relativistic");
  await page.getByLabel("From star").selectOption({ index: 2 }); // Alpha Centauri A/B
  await page.getByLabel("To star").selectOption({ index: 6 }); // Sirius
  await expect(page.locator("input[name=distance]")).toHaveValue("9.62");
  await mode.selectOption("brachistochrone");
  await page.getByLabel("Sample", { exact: true }).selectOption({ label: "Earth to Mars, closest (0.52 AU)" });
  await expect(page.locator("input[name=distance]")).toHaveValue("0.52");
  await expect(page.locator("select[name=unit]")).toHaveValue("AU");
  // Space distances in km switch to miles with the units.
  await page.getByLabel("Sample", { exact: true }).selectOption({ label: "Earth to the Moon (384,400 km)" });
  await units.selectOption("imperial");
  await expect(page.locator("select[name=unit]")).toHaveValue("mi");
  await expect(page.locator("input[name=distance]")).toHaveValue("239000");
  await units.selectOption("metric");

  // Hyperspace: the sample trip's Class 1 time, times the drive's class and the route.
  await mode.selectOption("hyperspace");
  await expect(page.locator("input[name=base_hours]")).toHaveValue("96");
  await page.getByLabel("Sample", { exact: true }).selectOption({ label: "Across a sector: 12.0 h" });
  await expect(page.locator("input[name=base_hours]")).toHaveValue("12");
  await page.locator("select[name=hyperdrive_class]").selectOption("0.5");
  await page.locator("select[name=route]").selectOption("2");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator(".result h3")).toHaveText("Travel time: 12.0 h");
  await expect(page.locator(".result")).toContainText("12.0 h at Class 1 × Class 0.5 drive × route ×2 = 12.0 h in hyperspace");

  // Fantasy: overland, sea and air, with no engines among the samples.
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator("select[name=genre]").selectOption("fantasy");
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(mode.locator("option")).toHaveCount(3);
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "Horseback, at a walk" })).toHaveCount(1);
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "motorway" })).toHaveCount(0);
  await mode.selectOption("air");
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "Golden eagle" })).toHaveCount(1);
  await expect(page.getByLabel("Sample", { exact: true }).locator("option", { hasText: "Airliner" })).toHaveCount(0);

  // Modern: overland, sea, air and orbital transfers.
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator("select[name=genre]").selectOption("modern");
  await page.getByRole("button", { name: "Save campaign settings" }).click();
  await expect(page.locator("#toast")).toHaveText("Saved");
  await page.goto(`index.html#/c/${cid}/travel`);
  await expect(mode.locator("option")).toHaveText(["Overland (on foot, mounted, by road or rail)", "Sea and river (oar, sail, engine)", "Air (wing, airship, aircraft)", "Orbital transfer (Hohmann, minimum fuel)"]);
  expectNoErrors(errors);
});

test("a custom region typed on the day page or the travel planner is added to the campaign's regions", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Sol");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Custom regions ${gm.id}`);

  // Day page: pick Custom, name it, save the day.
  await page.goto(`index.html#/c/${cid}/day/2`);
  await page.locator("select[name=region_id]").selectOption("custom");
  await page.getByLabel("Custom region name").fill("Sunken Road");
  await page.getByRole("button", { name: "Save day" }).click();
  await expect(page.locator("#toast")).toHaveText("Day saved");
  let { json } = await api(page, "campaign", undefined, cid);
  const road = json.regions.find(r => r.name === "Sunken Road");
  expect(road, JSON.stringify(json.regions)).toBeTruthy();
  expect(road.settings.climate).toBe("temperate");
  const day = await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=2`)).json();
  expect(Number(day.day.region_id)).toBe(road.id);

  // Travel planner: a custom arrival region is created and the party ends up there.
  await page.goto(`index.html#/c/${cid}/travel`);
  await page.getByRole("button", { name: "Calculate" }).click();
  const arrive = page.locator(".depart select").nth(1);
  await expect(arrive.locator("option", { hasText: "Sunken Road" })).toHaveCount(1);
  await arrive.selectOption("custom");
  await page.locator(".depart").getByLabel("Custom region name").nth(1).fill("Harbour Town");
  // From and To join the first and last days' Locations visited, after what the day already lists and not twice.
  const dayOf = c => Math.floor(c.current_shift / 4);
  const startDay = dayOf((await api(page, "campaign", undefined, cid)).json.campaign);
  await api(page, "day_update", { abs_day: startDay, locations: "Old Mill" }, cid);
  await page.locator(".depart").getByLabel("From", { exact: true }).fill("Riverford");
  await page.locator(".depart").getByLabel("To", { exact: true }).fill("Old Mill");
  await page.getByRole("button", { name: /Depart/ }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  ({ json } = await api(page, "campaign", undefined, cid));
  const locs = async d => (await (await page.request.get(`api/index.php?a=day&cid=${cid}&d=${d}`)).json()).day.locations;
  const endDay = dayOf(json.campaign);
  if (endDay === startDay) expect(await locs(startDay)).toBe("Old Mill, Riverford");
  else {
    expect(await locs(startDay)).toBe("Old Mill, Riverford");
    expect(await locs(endDay)).toBe("Old Mill");
  }
  const town = json.regions.find(r => r.name === "Harbour Town");
  expect(town, JSON.stringify(json.regions)).toBeTruthy();
  expect(json.campaign.settings.current_region).toBe(town.id);
  expectNoErrors(errors);
});
