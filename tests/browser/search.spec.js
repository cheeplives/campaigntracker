// The Search page looks through the whole campaign: Encyclopedia entries (names, aliases, tags and notes), events and
// their tags, day notes, the Library and Party Holdings, grouped by kind, and never finds a player anything secret.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign } = require("./helpers");

test("search finds names, notes, events and tomes, and a player never finds a secret", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const gm = person("Wren"), player = person("Ash");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Search ${gm.id}`);
  const ok = async (action, body) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
  await ok("entry_save", { name: "Gunther Hoffmann", aliases: ["the innkeeper"], notes: "<p>Runs the Griffin inn in Bree.</p>", gm_notes: "<p>Secretly a smuggler.</p>", tags: [{ name: "Person" }] });
  await ok("entry_save", { name: "Black Barrow", notes: "<p>A smuggler cave under the hill.</p>", is_secret: true });
  await ok("event_save", { abs_day: 1, title: "Fight at the Griffin", body: "Gunther threw out the bandits", tags: [{ name: "Battle" }] });
  await ok("event_save", { abs_day: 3, title: "Smuggler meeting", body: "Gunther meets the smuggler captain", is_secret: 1 });
  await ok("day_update", { abs_day: 2, region_id: null, notes: "Market day in Bree, the Griffin is full", gm_notes: "A smuggler watches the inn" });
  await ok("tome_save", { kind: "book", title: "Ledger of the Griffin", body: "<p>Ale, bread and a room.</p>" });

  const phone = page.viewportSize().width <= 560;
  // The box with the tabs opens the Search page (a 🔍 tab on a phone, where the page has its own box).
  await page.goto(`index.html#/c/${cid}/today`);
  if (phone) await page.getByRole("link", { name: "Search", exact: true }).click();
  else {
    await page.getByRole("searchbox", { name: "Search the campaign" }).fill("griffin");
    await page.getByRole("searchbox", { name: "Search the campaign" }).press("Enter");
  }
  await expect(page).toHaveURL(/#\/c\/\d+\/search/);
  const box = page.getByRole("searchbox", { name: "Search everything" });
  await box.fill("griffin");
  await expect(page).toHaveURL(/#\/c\/\d+\/search\?q=griffin$/);
  const groups = page.locator(".search-group h3");
  await expect(groups).toHaveText([/^Encyclopedia/, /^Days and events/, /^Library/]);
  const titles = page.locator(".search-row h4");
  // titles that match come first in each group; the days run in date order
  await expect(titles).toHaveText(["Gunther Hoffmann", /Fight at the Griffin$/, /Public notes$/, /Ledger of the Griffin$/]);
  await expect(page.locator(".search-row mark").first()).toHaveText(/griffin/i);

  // Aliases and tags are found too, and every word has to appear.
  await box.fill("innkeeper");
  await expect(titles).toHaveText(["Gunther Hoffmann"]);
  await box.fill("battle bandits");
  await expect(titles).toHaveText([/Fight at the Griffin$/]);
  await box.fill("battle market");
  await expect(page.getByText("Nothing in the campaign matches every word.")).toBeVisible();

  // A GM finds the secrets, marked as such.
  await box.fill("smuggler");
  await expect(titles).toHaveText([/Black Barrow/, /Gunther Hoffmann/, /Smuggler meeting$/, /Secret notes$/]);
  await expect(page.locator(".search-row.secret")).toHaveCount(4);

  // A result opens its page, and Back returns to the same search.
  await page.getByRole("link", { name: /Smuggler meeting/ }).click();
  await expect(page).toHaveURL(/#\/c\/\d+\/day\/3$/);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search everything" })).toHaveValue("smuggler");
  expectNoErrors(errors);

  // A player finds none of it.
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const perrors = watchErrors(pp);
  await signIn(pp, player);
  await approve(browser, player.email);
  await ok("member_add", { email: player.email, role: "player" });
  await pp.goto(`index.html#/c/${cid}/search?q=smuggler`);
  await expect(pp.getByText("Nothing in the campaign matches every word.")).toBeVisible();
  await pp.getByRole("searchbox", { name: "Search everything" }).fill("griffin");
  await expect(pp.locator(".search-row h4")).toHaveText(["Gunther Hoffmann", /Fight at the Griffin$/, /Public notes$/, /Ledger of the Griffin$/]);
  await expect(pp.locator(".search-row.secret")).toHaveCount(0);
  expectNoErrors(perrors);
  await pctx.close();
});

test("pressing / jumps to the search box", async ({ page, browser }) => {
  test.skip(page.viewportSize().width <= 560, "phones have the 🔍 tab instead of the box");
  const gm = person("Rook");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `Slash ${gm.id}`);
  await page.goto(`index.html#/c/${cid}/calendar`);
  await expect(page.getByRole("searchbox", { name: "Search the campaign" })).toBeVisible();
  await page.locator("body").press("/");
  await expect(page.getByRole("searchbox", { name: "Search the campaign" })).toBeFocused();
});
