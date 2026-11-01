// Weather tuning: the game tuning the About page lists (storm, fog and dust in each Köppen class, the simple
// climates' weather mix, visibility by weather, how shifts ease off, the ground model) can be changed for one
// campaign in Settings. Only the changed values are stored, and Reset puts the built-in values back.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, closeContexts } = require("./helpers");
const Engine = require(path.join(__dirname, "..", "..", "static", "engine.js"));
test.afterEach(closeContexts);

test("the engine lays a campaign's tuning over the built-in values and puts them back", () => {
  const E = Engine;
  const cal = JSON.parse(JSON.stringify(E.PRESETS.gregorian.calendar));
  E.prep(cal);
  const region = { id: 1, settings: { climate: "koppen:Cfb" } };
  const roll = () => { let prev = null; return Array.from({ length: 365 }, (_, d) => (prev = E.genWeather(cal, 7, region, d, prev, 0)).type); };
  const ground = () => JSON.stringify(E.groundConditions(cal, 7, region, 120, new Map(), { days: 30 }));
  const before = roll(), groundBefore = ground();
  const storms = list => list.filter(t => t === "storm").length;

  E.setTuning({ koppen: { Cfb: { winter: { storm: 3 }, spring: { storm: 3 }, summer: { storm: 3 }, autumn: { storm: 3 } } }, visibility: { fog: { day: -5 } } });
  expect(storms(roll())).toBeGreaterThan(storms(before) * 2);
  expect(E.WEATHER.fog.day).toBe(-5);

  // out-of-range and unknown values are pulled in or dropped; only real changes are kept
  expect(E.tuningChanges(E.mergeTuning({ koppen: { Cfb: { winter: { storm: 9 } }, Zzz: {} }, shifts: { ease: 0.4, variants: { rain: ["drizzle", "nonsense"] } } })))
    .toEqual({ koppen: { Cfb: { winter: { storm: 3 } } }, shifts: { variants: { rain: ["drizzle"] } } });
  expect(E.tuningProblem({ ground: { wet: { muddy: 10 } } })).toMatch(/higher than the one before/);
  expect(E.tuningProblem({})).toBe("");

  E.setTuning(null);
  expect(roll()).toEqual(before);
  expect(ground()).toBe(groundBefore);
  expect(E.WEATHER.fog.day).toBe(-3);
});

test("a GM tunes the ground in Settings, the day page follows, and Reset puts it back", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Tess");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Tuning ${gm.id}`); // now = day 2, Dawn
  const days = Array.from({ length: 12 }, (_, i) => ({ abs_day: -9 + i, weather: { type: "rain", temp: 12, wind: 1 } }));
  expect((await api(page, "days_save", { days }, cid)).status).toBe(200);

  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator(".kv .ground")).toContainText(/Muddy|Waterlogged/); // twelve days of heavy rain

  await page.goto(`index.html#/c/${cid}/settings`);
  const card = page.locator(".tune-card");
  await expect(card.locator("h2")).toHaveText("Weather tuning");
  await card.locator("summary", { hasText: "Ground conditions" }).click();
  const rain = card.getByLabel("Heavy rain rain", { exact: true });
  await expect(rain).toHaveValue("5");
  await rain.fill("0.2");
  await expect(rain).toHaveClass(/tuned/);
  await expect(card.locator("summary", { hasText: "Ground conditions" })).toContainText("1 changed");

  // steps out of order are refused
  const muddy = card.getByLabel("Muddy from (mm)");
  await muddy.fill("10");
  await card.getByRole("button", { name: "Save weather tuning" }).click();
  await expect(page.locator("#toast")).toContainText("higher than the one before");
  await muddy.fill("50");
  await card.getByLabel("Waterlogged from (mm)").fill("58");

  await card.locator("summary", { hasText: "Storms, fog and dust" }).click();
  await card.getByLabel("Cfb winter storms").fill("2.5");
  await card.getByRole("button", { name: "Save weather tuning" }).click();
  await expect(page.locator("#toast")).toContainText("Weather tuning saved");

  const camp = (await api(page, "campaign", undefined, cid)).json.campaign;
  expect(camp.settings.tuning).toEqual({ koppen: { Cfb: { winter: { storm: 2.5 } } }, ground: { rainfall: { rain: 0.2 }, wet: { muddy: 50, waterlogged: 58 } } });
  await expect(page.locator(".tune-card").getByLabel("Muddy from (mm)")).toHaveClass(/tuned/);

  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator(".kv .ground")).toBeVisible();
  await expect(page.locator(".kv .ground")).not.toContainText(/Muddy|Waterlogged/);

  // reset everything
  await page.goto(`index.html#/c/${cid}/settings`);
  await page.locator(".tune-card").getByRole("button", { name: "Reset all to built-in" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "OK" }).click();
  await expect(page.locator("#toast")).toContainText("Weather tuning reset");
  expect((await api(page, "campaign", undefined, cid)).json.campaign.settings.tuning).toBeUndefined();
  await page.goto(`index.html#/c/${cid}/today`);
  await expect(page.locator(".kv .ground")).toContainText(/Muddy|Waterlogged/);
  expectNoErrors(errors);
});
