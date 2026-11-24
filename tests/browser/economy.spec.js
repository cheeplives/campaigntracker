// The Economy tab: a GM picks how the campaign pays for things (coins, barter, wealth, favours), fills in everyday
// prices and uploads a price book; prices shift by region; "Can the party afford it?" pays from Party Funds; the ledger
// keeps what was gained and spent, regular costs come off as time passes, and favours stay open until settled.
const { test, expect } = require("@playwright/test");
const { watchErrors, expectNoErrors, person, signIn, api, approve, makeCampaign, newContext, closeContexts, goTab, sql } = require("./helpers");
test.afterEach(closeContexts);

const CONFIG = {
  coins: { on: true, base: { name: "Silver mark", abbr: "sm" }, units: [{ name: "Gold crown", abbr: "", worth: 20 }, { name: "Copper bit", abbr: "bits", worth: 0.1 }] },
  barter: { on: true, unit: "Day's food", goods: [{ name: "Lamp oil", worth: 2 }] },
  wealth: { on: true, levels: ["Destitute", "Poor", "Modest", "Comfortable", "Rich"] },
  favours: { on: true },
};

async function gmAndPlayer(page, browser, label, config = CONFIG) {
  const gm = person("Gwen"), player = person("Pip");
  await signIn(page, gm);
  await approve(browser, gm.email);
  const cid = await makeCampaign(page, `${label} ${gm.id}`);
  const pctx = await newContext(browser);
  const pp = await pctx.newPage();
  await signIn(pp, player);
  await approve(browser, player.email);
  expect((await api(page, "member_add", { email: player.email, role: "player" }, cid)).status).toBe(200);
  if (config) expect((await api(page, "economy_config_save", { config }, cid)).status).toBe(200);
  return { cid, pp };
}
const ok = async (page, action, body, cid) => { const r = await api(page, action, body, cid); expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };

test("a GM sets the economy up: ways to pay, everyday prices, then a price book from a CSV file", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Economy setup", null);
  await page.goto(`index.html#/c/${cid}/table`);
  await goTab(page, "Economy");
  const tabs = await page.locator("nav.tabs a").allTextContents();
  expect(tabs.indexOf("Economy")).toBe(tabs.indexOf("Library") + 1);
  await expect(page.locator(".econ-empty")).toContainText("Nothing is set up yet");
  // a player is told to wait for the GM, and has no Setup
  await pp.goto(`index.html#/c/${cid}/economy`);
  await expect(pp.locator(".econ-empty")).toContainText("The GM hasn't set up");
  await expect(pp.locator(".econ-head .subtabs a")).toHaveText(["Price book", "Ledger", "Favours"]);

  await page.getByRole("link", { name: "Set up the economy" }).click();
  const coins = page.locator(".econ-way[data-way=coins]"), barter = page.locator(".econ-way[data-way=barter]");
  await coins.getByLabel("Use coins").check();
  await coins.getByLabel("Main coin").fill("Silver mark");
  await coins.getByLabel("Short name").fill("sm");
  await coins.getByRole("button", { name: "+ Coin" }).click();
  await coins.getByLabel("Coin, e.g. Gold crown").fill("Gold crown");
  await coins.getByLabel("Worth in main coins").fill("20");
  await barter.getByLabel("Use barter").check();
  await barter.getByLabel("Measured in").fill("Day's food");
  await page.locator(".econ-way[data-way=wealth]").getByLabel("Use wealth").check();
  await page.locator(".econ-way[data-way=favours]").getByLabel("Use favours").check();
  await page.getByRole("button", { name: "Save and go on" }).click();

  // step 2: the everyday items are there with no prices; a price typed in the campaign's coins is kept in the main coin
  const lodging = page.locator(".econ-every-row").filter({ has: page.getByLabel("Coins: Private lodging, 1 night") });
  await expect(lodging).toHaveCount(1);
  await lodging.getByLabel("Coins: Private lodging, 1 night").fill("1 crown 2 sm");
  await lodging.getByLabel("Barter: Private lodging, 1 night").fill("3");
  await lodging.getByLabel("Wealth level: Private lodging, 1 night").selectOption("2");
  await expect.poll(async () => (await api(page, "economy", undefined, cid)).json.items.find(i => i.name === "Private lodging, 1 night")).toMatchObject({ coin_cost: 22, barter_cost: 3, wealth_level: 2, is_everyday: true });
  await expect(lodging.getByLabel("Coins: Private lodging, 1 night")).toHaveValue("1 Gold crown 2 sm");
  await page.getByLabel("New everyday item").fill("Stabling, 1 night");
  await page.getByRole("button", { name: "+ Add" }).click();
  await expect(page.getByLabel("Coins: Stabling, 1 night")).toHaveCount(1);
  await page.getByRole("button", { name: "Next: price book" }).click();

  // step 3: a CSV with a bad row; what was read is shown before anything is added
  const csv = 'Item,Category,Coins,Barter,Wealth,Favour,Availability\n"Rope, 50 ft",Gear,3 sm,2,Poor,,Scarce\nRiding horse,Animals,12 crowns,,Rich,Significant,\nPrivate lodging, 1 night,Lodging,2 sm,,,,\nBroken,Gear,lots,,,,\n';
  await page.getByLabel("Price book file").setInputFiles({ name: "prices.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const d = page.locator(".econ-dialog");
  await expect(d).toContainText("2 items read from prices.csv: 2 new, 0 already in the book");
  await expect(d).toContainText('Row 4: "2 sm" isn\'t a barter price');   // an unquoted comma shifts the row's columns
  await expect(d).toContainText('Row 5: "lots" isn\'t a price in coins');
  await d.getByRole("button", { name: "Add 2 items" }).click();
  await expect(page.locator("#toast")).toContainText("2 added, 0 changed");
  await page.getByRole("link", { name: "Open the price book" }).click();
  const horse = page.locator(".econ-table tr").filter({ hasText: "Riding horse" });
  await expect(horse).toContainText("12 Gold crowns");
  await expect(horse).toContainText("Significant");
  await expect(page.locator(".econ-table tr").filter({ hasText: "Rope, 50 ft" })).toContainText("Scarce");
  // the player now reads the same book, with nothing to change it
  await pp.reload();
  await expect(pp.locator(".econ-table tr").filter({ hasText: "Riding horse" })).toContainText("12 Gold crowns");
  await expect(pp.getByRole("button", { name: "+ New item" })).toHaveCount(0);
  expect((await api(pp, "economy_item_save", { name: "Sneaky" }, cid)).status).toBe(403);
  expect((await api(pp, "economy_config_save", { config: CONFIG }, cid)).status).toBe(403);
  expectNoErrors(errors);
});

test("a shift changes prices in a region, and Can the party afford it? pays from Party Funds into the ledger", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Economy prices");
  const region = Number(sql(`SELECT id FROM regions WHERE campaign_id=${cid}`).trim());
  const meal = (await ok(page, "economy_item_save", { name: "Roast goose dinner", category: "Food and drink", coin_cost: 1, barter_cost: 2, wealth_level: 3 }, cid)).item;
  await ok(page, "economy_item_save", { name: "Forged papers", category: "Services", coin_cost: 160, favour_size: 2, is_secret: true }, cid);
  const fund = (await ok(page, "funds_save", { currency: "Silver marks", location: "Strongbox", amount: 10 }, cid)).id;
  await ok(page, "funds_save", { currency: "Gold crowns", location: "Strongbox", amount: 1 }, cid);

  await page.goto(`index.html#/c/${cid}/economy`);
  const row = page.locator(".econ-table tr").filter({ hasText: "Roast goose dinner" });
  await expect(row).toContainText("1 sm");
  await expect(page.locator(".econ-shifts")).toContainText("Shifts in Home");
  await page.getByRole("button", { name: "+ New shift" }).click();
  const d = page.locator(".econ-dialog");
  await expect(d.getByLabel("Where")).toHaveValue(String(region));   // the region the party is in
  await d.getByLabel("What").selectOption({ label: "Food and drink" });
  await d.getByLabel("Prices times").fill("1.5");
  await d.getByLabel("Availability").selectOption("scarce");
  await d.getByLabel("Why").fill("Winter famine");
  await d.getByLabel("Lasts until").fill("12 Secondmonth");
  await d.getByRole("button", { name: "Add shift" }).click();
  await expect(page.locator(".econ-shift")).toContainText("Food and drink × 1.5, and Scarce");
  await expect(page.locator(".econ-shift")).toContainText("Winter famine · until 12 Secondmonth 1");
  await expect(row).toContainText("1 sm 5 bits");
  await expect(row).toContainText("usually 1 sm");
  await expect(row.locator(".econ-badge")).toHaveText("Scarce");
  // elsewhere the book's own price stands
  await page.getByLabel("Prices in", { exact: true }).selectOption({ label: "Everywhere" });
  await expect(row).not.toContainText("usually");
  await page.getByLabel("Prices in", { exact: true }).selectOption(String(region));

  // the party has 10 sm and a crown (30 sm in all): enough for the meal, and paying takes it off the funds line
  await row.getByRole("button", { name: "Roast goose dinner" }).click();
  const afford = page.locator(".econ-afford");
  await expect(afford).toContainText("Party coins: 1 Gold crown 10 sm");
  await expect(afford.locator(".econ-badge.on").first()).toHaveText("Enough");
  await expect(afford).toContainText("Trade goods: worth 0 Day's food");
  await afford.getByRole("button", { name: "Pay in coins…" }).click();
  await expect(d.getByLabel("Amount")).toHaveValue("1.5");
  await expect(d.getByLabel("What for")).toHaveValue("Roast goose dinner");
  await d.getByRole("button", { name: "Save entry" }).click();
  await expect(afford).toContainText("Party coins: 1 Gold crown 8 sm 5 bits");
  expect((await api(page, "holdings", undefined, cid)).json.funds.find(f => f.id === fund).amount).toBe(8.5);
  await page.locator(".econ-head .subtabs").getByRole("link", { name: "Ledger" }).click();
  const line = page.locator(".econ-entry").first();
  await expect(line.locator(".econ-amt")).toHaveText("− 1.5 sm");
  await expect(line).toContainText("Roast goose dinner");
  await expect(line).toContainText("Party Funds · Strongbox");

  // a player sees the shifted price but not the GM-only item, and can't add a shift
  await pp.goto(`index.html#/c/${cid}/economy`);
  await expect(pp.locator(".econ-table tr").filter({ hasText: "Roast goose dinner" })).toContainText("1 sm 5 bits");
  await expect(pp.locator(".econ-table")).not.toContainText("Forged papers");
  await expect(pp.getByRole("button", { name: "+ New shift" })).toHaveCount(0);
  expect((await api(pp, "economy_shift_save", { multiplier: 2 }, cid)).status).toBe(403);
  expect((await api(pp, "economy_item_delete", { id: meal.id }, cid)).status).toBe(403);
  await expect(page.locator(".econ-table tr.secret")).toHaveCount(0);   // the GM is on the Ledger
  expectNoErrors(errors);
});

test("the ledger keeps coins, goods, wealth and notes; a regular cost comes off as time passes; a player adds and deletes their own", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Economy ledger");
  const fund = (await ok(page, "funds_save", { currency: "Silver marks", location: "Strongbox", amount: 50 }, cid)).id;
  await page.goto(`index.html#/c/${cid}/economy/ledger`);
  await expect(page.locator(".econ-ledger")).toContainText("Nothing in the ledger yet");

  // goods: a trade good the party hasn't got yet becomes a Gear and Loot row
  await page.getByRole("button", { name: "+ New entry" }).click();
  const d = page.locator(".econ-dialog");
  await d.getByLabel("Trade goods").check();
  await d.getByLabel("Gained", { exact: true }).check();
  await d.getByLabel("Amount").fill("12");
  await d.getByLabel("What for").fill("Bought rations in Altdorf");
  await d.getByRole("button", { name: "Save entry" }).click();
  await expect(page.locator(".econ-entry").first().locator(".econ-amt")).toHaveText("+ 12 Day's food");
  await expect(page.locator(".econ-goods")).toContainText("Day's food 12");
  expect((await api(page, "holdings", undefined, cid)).json.gear.find(g => g.item === "Day's food").amount).toBe(12);

  // an amount changed by hand on Party Funds is noted too
  await ok(page, "funds_save", { id: fund, currency: "Silver marks", location: "Strongbox", amount: 42 }, cid);
  // wealth: the party's own level, set and then changed
  await page.reload();
  await page.locator(".econ-wealth").getByRole("button", { name: "The party: not set" }).click();
  await d.getByLabel("Level").selectOption("3");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".econ-wealth")).toContainText("The party: 3 Comfortable");
  await ok(page, "economy_wealth_set", { character_id: 0, level: 2, description: "Lost the lawsuit" }, cid);

  // a regular cost: 5 sm every 2 days from tomorrow; four days on, it has come off twice
  await page.locator(".econ-costs").getByRole("button", { name: "+ Regular cost" }).click();
  await d.getByLabel("What", { exact: true }).fill("Upkeep: the watchtower");
  await d.getByLabel("Amount each time").fill("5");
  await d.getByLabel("Every how many days").fill("2");
  await d.getByRole("button", { name: "Add regular cost" }).click();
  await expect(page.locator(".econ-cost")).toContainText("− 5 sm Upkeep: the watchtower");
  await expect(page.locator(".econ-cost")).toContainText("in 1 day · every 2 days");
  await ok(page, "set_time", { current_shift: 8 + 4 * 4 }, cid);
  await page.reload();
  const upkeep = page.locator(".econ-entry").filter({ hasText: "Upkeep: the watchtower" });
  await expect(upkeep).toHaveCount(2);
  await expect(upkeep.first().locator(".econ-amt")).toHaveText("− 5 sm");
  await expect(upkeep.first().locator(".econ-who")).toContainText("Regular cost");
  await expect(page.locator(".econ-funds")).toContainText("32");
  await expect(page.locator(".econ-cost")).toContainText("in 1 day");
  await expect(page.locator(".econ-entry").filter({ hasText: "Changed on Party Funds" }).locator(".econ-amt")).toHaveText("− 8 sm");
  await expect(page.locator(".econ-entry").filter({ hasText: "Lost the lawsuit" }).locator(".econ-amt")).toHaveText("Wealth 3 → 2");
  // the filter keeps to one kind
  await page.locator(".econ-filters").getByRole("button", { name: "Wealth" }).click();
  await expect(page.locator(".econ-entry")).toHaveCount(2);
  await page.locator(".econ-filters").getByRole("button", { name: "All" }).click();

  // a player writes a note and deletes it; the GM's lines are not theirs to delete
  await pp.goto(`index.html#/c/${cid}/economy/ledger`);
  await pp.getByRole("button", { name: "+ New entry" }).click();
  const pd = pp.locator(".econ-dialog");
  await pd.getByLabel("Note", { exact: true }).check();
  await pd.getByLabel("What for").fill("Pip owes the party a round");
  await pd.getByRole("button", { name: "Save entry" }).click();
  const note = pp.locator(".econ-entry").filter({ hasText: "Pip owes the party a round" });
  await expect(note.locator(".econ-amt")).toHaveText("Note");
  await expect(pp.locator(".econ-entry").filter({ hasText: "Upkeep" }).first().getByRole("button")).toHaveCount(0);
  const theirs = (await api(page, "economy_ledger", undefined, cid)).json.entries.find(e => e.description === "Bought rations in Altdorf").id;
  expect((await api(pp, "economy_entry_delete", { id: theirs }, cid)).status).toBe(403);
  await note.getByRole("button").click();
  await pp.locator("dialog[open]").getByRole("button", { name: "Delete" }).click();
  await expect(note).toHaveCount(0);
  expectNoErrors(errors);
});

test("favours: owed to the party and by it, a secret one only the GM sees until revealed, called in with a note", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { cid, pp } = await gmAndPlayer(page, browser, "Economy favours");
  await page.goto(`index.html#/c/${cid}/economy/favours`);
  await expect(page.locator(".econ-favcol").first()).toContainText("No one owes the party a favour");

  await page.getByRole("button", { name: "+ New favour" }).click();
  const d = page.locator(".econ-dialog");
  await d.getByLabel("With").fill("Captain Aldric Voss");
  await d.getByLabel("Major").check();
  await d.getByLabel("What for").fill("they brought his daughter back");
  await d.getByRole("button", { name: "Add favour" }).click();
  const voss = page.locator(".econ-favour").filter({ hasText: "Captain Aldric Voss" });
  await expect(voss).toContainText("Owes the party: they brought his daughter back");
  await expect(voss.locator(".econ-badge")).toHaveText("Major");

  await page.getByRole("button", { name: "+ New favour" }).click();
  await d.getByLabel("The party owes").check();
  await d.getByLabel("With").fill("Baron von Keller");
  await d.getByLabel("Significant").check();
  await d.getByLabel("GM only").check();
  await d.getByRole("button", { name: "Add favour" }).click();
  const baron = page.locator(".econ-favour").filter({ hasText: "Baron von Keller" });
  await expect(baron).toHaveClass(/secret/);
  await expect(baron).toContainText("The party owes them");

  // the player sees the open favour, not the secret one or its ledger line, and can't make a secret one
  await pp.goto(`index.html#/c/${cid}/economy/favours`);
  await expect(pp.locator(".econ-favour")).toHaveCount(1);
  await expect(pp.locator(".econ-favour")).toContainText("Captain Aldric Voss");
  const seen = (await api(pp, "economy_ledger", undefined, cid)).json.entries.map(e => e.description);
  expect(seen).toEqual(["Major favour owed to the party by Captain Aldric Voss: they brought his daughter back"]);
  expect((await api(pp, "economy_favour_save", { other_name: "Nobody", is_secret: true }, cid)).status).toBe(403);
  // the player calls the captain's favour in
  await pp.locator(".econ-favour").getByRole("button", { name: "Call in…" }).click();
  await pp.locator("dialog[open] input").fill("an escort through the Reikwald");
  await pp.locator("dialog[open]").getByRole("button", { name: "Call in" }).click();
  await expect(pp.locator(".econ-favour")).toHaveCount(0);
  await pp.locator(".econ-settled summary").click();
  await expect(pp.locator(".econ-settled")).toContainText("Captain Aldric Voss owed the party");
  await expect(pp.locator(".econ-settled")).toContainText("an escort through the Reikwald");

  // the GM reveals the baron's; the player then sees it and its history
  await page.reload();
  await page.locator(".econ-favour").filter({ hasText: "Baron von Keller" }).getByRole("button", { name: "Reveal to players" }).click();
  await expect(page.locator(".econ-favour.secret")).toHaveCount(0);
  await pp.reload();
  await expect(pp.locator(".econ-favour")).toContainText("Baron von Keller");
  expect((await api(pp, "economy_ledger", undefined, cid)).json.entries.map(e => e.description)).toContain("Significant favour owed to Baron von Keller by the party");
  // deleting a favour takes its ledger lines with it; a player can't delete the GM's
  const id = (await api(page, "economy", undefined, cid)).json.favours.find(f => f.other_name === "Baron von Keller").id;
  expect((await api(pp, "economy_favour_delete", { id }, cid)).status).toBe(403);
  await ok(page, "economy_favour_delete", { id }, cid);
  expect((await api(page, "economy_ledger", undefined, cid)).json.entries.map(e => e.description).join()).not.toContain("Baron");
  expectNoErrors(errors);
});

test("the economy is copied with a campaign, its ledger pointing at the copy's own funds", async ({ page, browser }) => {
  const { cid } = await gmAndPlayer(page, browser, "Economy copy");
  const fund = (await ok(page, "funds_save", { currency: "Silver marks", location: "Strongbox", amount: 20 }, cid)).id;
  await ok(page, "economy_item_save", { name: "Rope", coin_cost: 3 }, cid);
  await ok(page, "economy_entry_save", { kind: "coins", amount: -3, fund_id: fund, description: "Rope" }, cid);
  await ok(page, "economy_cost_save", { name: "Wages", amount: 2, fund_id: fund, every_days: 7 }, cid);
  await ok(page, "economy_favour_save", { other_name: "Old Petra", size: 1 }, cid);
  const copy = (await ok(page, "campaign_copy", { name: "Economy copied" }, cid)).id;
  const e = (await api(page, "economy", undefined, copy)).json;
  expect(e.config.coins.base.name).toBe("Silver mark");
  expect(e.items.map(i => i.name)).toContain("Rope");
  expect(e.favours.map(f => f.other_name)).toEqual(["Old Petra"]);
  expect(e.funds).toHaveLength(1);
  expect(e.funds[0].id).not.toBe(fund);
  expect(e.costs[0].fund_id).toBe(e.funds[0].id);
  expect((await api(page, "economy_ledger", undefined, copy)).json.entries).toHaveLength(2);
  expect(sql(`SELECT COUNT(*) FROM economy_ledger l JOIN party_funds f ON f.id=l.fund_id WHERE l.campaign_id=${copy} AND f.campaign_id=${copy}`).trim()).toBe("1");
  // a copy of the setup alone takes the ways to pay and the price book, not the ledger or the favours
  const setup = (await ok(page, "campaign_copy", { name: "Economy setup only", setup: true }, cid)).id;
  const s = (await api(page, "economy", undefined, setup)).json;
  expect(s.items.map(i => i.name)).toContain("Rope");
  expect(s.favours).toEqual([]);
  expect((await api(page, "economy_ledger", undefined, setup)).json.entries).toEqual([]);
});
