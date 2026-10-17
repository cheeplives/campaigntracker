// The About page lists where the built-in figures come from, and anyone can
// read it from the footer, signed in or not.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors } = require("./helpers");

test("About & sources: open signed out from the footer, with every travel sample cited", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("index.html");
  await page.getByRole("link", { name: "About & sources" }).click();
  await expect(page.getByRole("heading", { name: "About Campaign Chronicle" })).toBeVisible();
  for (const h of ["Travel planner: sample speeds", "Travel planner: space", "Weather and climate", "Calendars and holidays", "No open source"]) {
    await expect(page.getByRole("heading", { name: h })).toBeVisible();
  }
  // One row per sample speed, each with a source link that opens in a new tab.
  const speeds = page.locator("section", { has: page.getByRole("heading", { name: "Travel planner: sample speeds" }) }).locator("tr");
  const rows = await speeds.count();
  expect(rows).toBeGreaterThan(30);
  for (let i = 1; i < rows; i++) await expect(speeds.nth(i).locator("a[target=_blank]")).toHaveCount(1);
  // Every Köppen class names its station.
  await expect(page.getByRole("link", { name: "London Heathrow, UK" })).toBeVisible();
  // Leaving the page goes back to the sign-in card.
  await page.goto("index.html#/");
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  expectNoErrors(errors);
});
