// Places inside places, and the days the party was at one: a Location's page reads its "Contains" / "Located in"
// connections as a tree (In …, Inside …, + Place inside), the Encyclopedia's list sets a place under the place it is
// inside, and Visits lists the days whose Locations visited name the place or a place inside it. No table of its own.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

test("a place inside a place: the trail, the tree, the nested list, + Place inside and the visits", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Gwen");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Places ${gm.id}`);
  const make = async (name, category = "location") => (await api(page, "entry_save", { name, category, notes: `<p>${name}.</p>` }, cid)).json.id;
  const inside = async (outer, inner) => expect((await api(page, "relations_save", { entry_id: outer, type: { label: "Contains", inverse_label: "Located in" }, add: [inner] }, cid)).status).toBe(200);
  const empire = await make("The Empire"), reikland = await make("Reikland"), altdorf = await make("Altdorf"), inn = await make("Grey Lady inn");
  const marienburg = await make("Marienburg");
  await inside(empire, reikland); await inside(reikland, altdorf); await inside(altdorf, inn);
  // a loop must not hang the page: the Empire put inside the inn
  await inside(inn, empire);
  expect((await api(page, "day_update", { abs_day: 2, locations: "Altdorf" }, cid)).status).toBe(200);
  expect((await api(page, "day_update", { abs_day: 5, locations: "the Grey Lady inn, then Marienburg" }, cid)).status).toBe(200);
  expect((await api(page, "day_update", { abs_day: 9, locations: "Marienburg" }, cid)).status).toBe(200);

  await page.goto(`/#/c/${cid}/encyclopedia/${altdorf}`);
  // the trail up, outermost first (the loop stops where it closes)
  await expect(page.locator(".enc-inside a")).toHaveText(["Grey Lady inn", "The Empire", "Reikland"]);
  // what is inside it
  const tree = page.locator(".enc-places");
  await expect(tree.getByRole("heading", { name: "Inside Altdorf" })).toBeVisible();
  await expect(tree.locator(`li[data-id="${inn}"]`)).toContainText("Grey Lady inn");
  // the days it was visited: by name, and through the inn inside it
  const visits = page.locator(".enc-visits");
  await expect(visits.locator("li")).toHaveCount(2);
  await expect(visits).not.toContainText("null");
  await expect(visits.locator('li[data-day="5"]')).toContainText("at Grey Lady inn");
  await expect(visits.locator('li[data-day="2"] small')).toHaveCount(0);
  await expect(visits.locator(".enc-visit-sum")).toContainText("2 days");
  // the list sets each place under the one it is inside
  const depth = id => page.locator(`a.enc-item[href$="/encyclopedia/${id}"]`).first().getAttribute("data-depth");
  expect(await depth(marienburg)).toBeNull();
  const depths = [await depth(empire), await depth(reikland), await depth(altdorf), await depth(inn)].map(d => Number(d || 0));
  expect([...depths].sort()).toEqual([0, 1, 2, 3]);   // one chain, wherever the loop is cut

  // Marienburg: nothing inside yet, visited twice; + Place inside adds a Location under it
  await page.goto(`/#/c/${cid}/encyclopedia/${marienburg}`);
  await expect(page.locator(".enc-inside")).toHaveCount(0);
  await expect(page.locator(".enc-places")).toContainText("Nothing inside it yet.");
  await expect(page.locator(".enc-visits li")).toHaveCount(2);
  await page.getByRole("button", { name: "+ Place inside" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Suiddock");
  await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
  // it opens the new entry (in its editor, as it has nothing written yet)
  await expect(page).toHaveURL(new RegExp(`/encyclopedia/(?!${marienburg}$)\\d+$`));
  const enc = (await api(page, "encyclopedia", undefined, cid)).json;
  const dock = enc.entries.find(e => e.name === "Suiddock");
  expect(dock.category).toBe("location");
  expect(enc.relations.some(r => r.from_id === marienburg && r.to_id === dock.id)).toBe(true);
  await page.goto(`/#/c/${cid}/encyclopedia/${marienburg}`);
  await expect(page.locator(`.enc-places li[data-id="${dock.id}"]`)).toContainText("Suiddock");

  // a person has neither box
  const gunther = await make("Gunther", "person");
  await page.goto(`/#/c/${cid}/encyclopedia/${gunther}`);
  await expect(page.locator(".enc-conns")).toBeVisible();
  await expect(page.locator(".enc-places, .enc-visits")).toHaveCount(0);
  expectNoErrors(errors);
});
