// The Maps tab: maps (an uploaded image with pins, routes and a scale), tokens and party groups.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, sql } = require("./helpers");

test("Maps: a fresh install has the tables, and the campaign says maps are ready", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, "Maps tables");
  const r = await api(page, "campaign", undefined, cid);
  expect(r.status).toBe(200);
  expect(r.json.maps_ready).toBe(true);
  const maps = sql("SHOW TABLES LIKE 'map_%'");
  expect(maps).toContain("map_pins");
  expect(maps).toContain("map_routes");
  expect(sql("SHOW TABLES LIKE 'party_groups'").trim()).not.toBe("");
  expect(sql("SHOW TABLES LIKE 'tokens'").trim()).not.toBe("");
  expectNoErrors(errors);
});
