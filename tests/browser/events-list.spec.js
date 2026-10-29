// The Events tab lists every event in the campaign, searchable by its text,
// notes and tags, filterable by tag and by past or upcoming, and never shows
// players a secret event.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("the Events tab searches every event and filters by tag", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Wren"), player = person("Ash");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Events list ${gm.id}`); // today is day 2
  const save = async ev => (await api(page, "event_save", ev, cid)).json.id;
  await save({ abs_day: 0, title: "Ambush on the road", body: "Bandits from the hills", tags: [{ name: "Battle" }] });
  const fair = await save({ abs_day: 2, end_day: 4, title: "Harvest fair", body: "Stalls and a juggler", tags: [{ name: "Festival" }] });
  await save({ abs_day: 9, shift: 1, title: "Duel at noon", tags: [{ name: "Battle" }, { name: "Intrigue", color: "#9333ea" }] });
  await save({ abs_day: 12, title: "The baron's plot", body: "Poison in the wine", is_secret: 1 });
  await api(page, "note_add", { event_id: fair, body: "Pip won the pie contest" }, cid);

  await page.goto(`index.html#/c/${cid}/today`);
  await page.getByRole("link", { name: "Events", exact: true }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/events$/);
  const rows = page.locator(".evrow");
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road", "Harvest fair", "Duel at noon", /The baron's plot/]);
  await expect(page.getByText("4 events")).toBeVisible();
  await expect(rows.filter({ hasText: "Harvest fair" })).toContainText("Today");
  await expect(rows.filter({ hasText: "The baron's plot" }).locator(".secret-tag")).toBeVisible();

  // Search reaches titles, details and notes, and every word must match.
  const search = page.getByRole("searchbox", { name: "Search events" });
  await search.fill("pie");
  await expect(rows.locator("h4")).toHaveText(["Harvest fair"]);
  await expect(page.getByText("1 of 4 events")).toBeVisible();
  await search.fill("bandits");
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road"]);
  await expect(rows.locator("mark")).toHaveText(["Bandits"]);
  await search.fill("duel  NOON");
  await expect(rows.locator("h4")).toHaveText(["Duel at noon"]);
  await search.fill("duel fair");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("No events match")).toBeVisible();
  await search.fill("");

  // Tags: one narrows the list, a second widens it to either.
  await page.getByRole("button", { name: "Battle", exact: true }).click();
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road", "Duel at noon"]);
  await page.getByRole("button", { name: "Festival", exact: true }).click();
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road", "Harvest fair", "Duel at noon"]);
  await page.getByRole("button", { name: "Clear tags" }).click();
  await expect(rows).toHaveCount(4);

  // Past and upcoming, and newest first. A multi-day event running today counts as upcoming.
  await page.getByRole("combobox", { name: "When" }).selectOption("upcoming");
  await expect(rows.locator("h4")).toHaveText(["Harvest fair", "Duel at noon", /The baron's plot/]);
  await page.getByRole("combobox", { name: "Order" }).selectOption("desc");
  await expect(rows.locator("h4")).toHaveText([/The baron's plot/, "Duel at noon", "Harvest fair"]);
  await page.getByRole("combobox", { name: "When" }).selectOption("past");
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road"]);

  // The filters are kept when coming back to the tab, and a row opens its day.
  await page.getByRole("link", { name: "Ambush on the road" }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/day\/0$/);
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "When" })).toHaveValue("past");
  await expect(rows.locator("h4")).toHaveText(["Ambush on the road"]);
  expectNoErrors(errors);

  // A player never receives the secret event, from the page or the API.
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  const { json } = await api(pp, "events", undefined, cid);
  expect(json.events.map(e => e.title)).toEqual(["Ambush on the road", "Harvest fair", "Duel at noon"]);
  expect(json.events[1].notes).toEqual(["Pip won the pie contest"]);
  await pp.goto(`index.html#/c/${cid}/events`);
  await expect(pp.locator(".evrow")).toHaveCount(3);
  await pp.getByRole("searchbox", { name: "Search events" }).fill("poison");
  await expect(pp.locator(".evrow")).toHaveCount(0);
  await pctx.close();

  // Someone outside the campaign gets nothing.
  const octx = await newContext(browser);
  const op = await octx.newPage();
  const outsider = person("Nob");
  await signIn(op, outsider);
  await approve(browser, outsider.email);
  expect((await api(op, "events", undefined, cid)).status).toBe(403);
  await octx.close();
});

test("going Back while a day is still loading leaves the Events tab drawn", async ({ page, browser }) => {
  const gm = person("Wren");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Events back ${gm.id}`);
  await api(page, "event_save", { abs_day: 0, title: "Ambush on the road" }, cid);
  await page.goto(`index.html#/c/${cid}/events`);
  const titles = page.locator(".evrow h4");
  await expect(titles).toHaveText(["Ambush on the road"]);
  // a slow day page that finishes after Back must not draw over the Events tab
  await page.route(/[?&]a=day(&|$)/, async r => { await new Promise(res => setTimeout(res, 1500)); await r.continue(); });
  await page.getByRole("link", { name: "Ambush on the road" }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/day\/0$/);
  await page.goBack();
  await expect(titles).toHaveText(["Ambush on the road"]);
  await page.waitForTimeout(2000);
  await expect(titles).toHaveText(["Ambush on the road"]);
});
