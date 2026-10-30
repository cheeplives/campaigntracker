// The About page lists where the built-in figures come from, and anyone can
// read it from the footer, signed in or not.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors } = require("./helpers");

test("About & sources: open signed out from the footer, with every travel sample cited", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("index.html");
  await page.getByRole("link", { name: "About & sources" }).click();
  await expect(page.getByRole("heading", { name: "About Campaign Chronicle" })).toBeVisible();
  for (const h of ["Travel planner: sample speeds", "Travel planner: space", "Weather and climate", "Calendars and holidays", "Software and fonts", "No open source"]) {
    await expect(page.getByRole("heading", { name: h })).toBeVisible();
  }
  // One row per sample speed, each with a source link that opens in a new tab.
  const speeds = page.locator("section", { has: page.getByRole("heading", { name: "Travel planner: sample speeds" }) }).locator("tr");
  const rows = await speeds.count();
  expect(rows).toBeGreaterThan(30);
  for (let i = 1; i < rows; i++) await expect(speeds.nth(i).locator("a[target=_blank]")).toHaveCount(1);
  // Every Köppen class names its station.
  await expect(page.getByRole("link", { name: "London Heathrow, UK" })).toBeVisible();
  // Wind speeds, the bundled editor and the fonts are credited too.
  await expect(page.getByRole("link", { name: "Beaufort scale" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Quill 2 rich text editor/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Leaflet 1\.9\.4 map viewer/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inter typeface" })).toBeVisible();
  // and Wikipedia, for the summaries Generate Summary adds to Encyclopedia entries
  await expect(page.getByText(/Generate Summary on an Encyclopedia entry/)).toContainText("CC BY-SA 4.0");
  // and the picture libraries Find Image searches, with DeviantArt also under No open source
  const find = page.locator("li", { hasText: "Find Image on an Encyclopedia entry" });
  await expect(find.getByRole("link", { name: "Openverse" })).toHaveAttribute("href", "https://openverse.org/");
  await expect(find.getByRole("link", { name: /The Met/ })).toBeVisible();
  await expect(find.getByRole("link", { name: /Art Institute of Chicago/ })).toBeVisible();
  await expect(find.getByRole("link", { name: /Smithsonian/ })).toBeVisible();
  await expect(find.getByRole("link", { name: "DeviantArt" })).toBeVisible();
  await expect(page.locator("li", { hasText: "DeviantArt, through its API and oEmbed" })).toBeVisible();
  // and where Import on a character's sheet reads from
  const imp = page.locator("li", { hasText: "Import on a character's sheet" });
  await expect(imp.getByRole("link", { name: "Pathbuilder 2e" })).toHaveAttribute("href", "https://pathbuilder2e.com/");
  await expect(imp.getByRole("link", { name: "D&D Beyond" })).toHaveAttribute("href", "https://www.dndbeyond.com/");
  // Leaving the page goes back to the sign-in card.
  await page.goto("index.html#/");
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  expectNoErrors(errors);
});
