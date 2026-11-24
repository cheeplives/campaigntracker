// The Economy tab's sums, under Node (static/economy.js needs no page): coins typed and shown in a campaign's own
// units, what a price is once a region's shifts apply, what the party's funds and trade goods come to, and a price
// book read from and written to a CSV file.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Economy = require(path.join(__dirname, "..", "..", "static", "economy.js"));

/** A campaign with three coins (a Gold crown is 10 Silver marks, a mark is 10 bits), barter in Day's food, and wealth. */
const CONFIG = {
  coins: { on: true, base: { name: "Silver mark", abbr: "sm" }, units: [{ name: "Gold crown", abbr: "", worth: 10 }, { name: "Copper bit", abbr: "bits", worth: 0.1 }] },
  barter: { on: true, unit: "Day's food", goods: [{ name: "Clean water", worth: 0.5 }, { name: "Ammunition", worth: 2 }] },
  wealth: { on: true, levels: ["Destitute", "Poor", "Comfortable", "Rich"] },
  favours: { on: true },
};

test("numbers read and show as whole numbers, plain fractions and two places", () => {
  expect(Economy.fmtNum(1200)).toBe("1,200");
  expect(Economy.fmtNum(0.5)).toBe("1/2");
  expect(Economy.fmtNum(2 / 3)).toBe("2/3");
  expect(Economy.fmtNum(2.456)).toBe("2.46");
  expect(Economy.fmtNum(-3)).toBe("−3");
  expect(Economy.parseNum("1,200")).toBe(1200);
  expect(Economy.parseNum("1/2")).toBe(0.5);
  expect(Economy.parseNum("2.5")).toBe(2.5);
  expect(Economy.parseNum("  ")).toBeNull();
  expect(Economy.parseNum("lots")).toBeNaN();
});

test("coins are shown in the campaign's units, biggest first, and read back from what was typed", () => {
  expect(Economy.coinUnits(CONFIG).map(u => u.name)).toEqual(["Gold crown", "Silver mark", "Copper bit"]);
  expect(Economy.fmtCoins(CONFIG, 1.5)).toBe("1 sm 5 bits");
  expect(Economy.fmtCoins(CONFIG, 25)).toBe("2 Gold crowns 5 sm");
  expect(Economy.fmtCoins(CONFIG, 10)).toBe("1 Gold crown");
  expect(Economy.fmtCoins(CONFIG, 0)).toBe("0 sm");
  expect(Economy.fmtCoins(CONFIG, -3)).toBe("−3 sm");
  expect(Economy.fmtCoins(CONFIG, null)).toBe("");
  expect(Economy.fmtCoins({}, 12)).toBe("12"); // no coins set up: the bare number

  expect(Economy.parseCoins(CONFIG, "2 sm")).toBe(2);
  expect(Economy.parseCoins(CONFIG, "7")).toBe(7); // a bare number is the main coin
  expect(Economy.parseCoins(CONFIG, "1 sm 5 bits")).toBeCloseTo(1.5);
  expect(Economy.parseCoins(CONFIG, "12 crowns")).toBe(120); // one word of a coin's name
  expect(Economy.parseCoins(CONFIG, "1 gold crown, 3 Silver Marks")).toBe(13);
  expect(Economy.parseCoins(CONFIG, "-2 sm")).toBe(-2);
  expect(Economy.parseCoins(CONFIG, "")).toBeNull();
  expect(Economy.parseCoins(CONFIG, "2 pearls")).toBeNaN();
  for (const n of [0.3, 1.5, 12, 123.4]) expect(Economy.parseCoins(CONFIG, Economy.fmtCoins(CONFIG, n))).toBeCloseTo(n);
});

test("the party's coins are its funds lines named like a coin, and its trade goods are counted from gear", () => {
  const funds = [{ currency: "Gold crowns", amount: 3 }, { currency: "sm", amount: 4 }, { currency: "copper bits", amount: 20 }, { currency: "Gems", amount: 2 }];
  const coins = Economy.partyCoins(CONFIG, funds);
  expect(coins.total).toBeCloseTo(36);
  expect(coins.other.map(f => f.currency)).toEqual(["Gems"]);

  const gear = [{ item: "Day's food", amount: 6 }, { item: "clean water", amount: 4 }, { item: "Clean water", amount: 2 }, { item: "Rope", amount: 1 }];
  const goods = Economy.partyGoods(CONFIG, gear);
  expect(goods.stock).toEqual([{ name: "Day's food", worth: 1, amount: 6 }, { name: "Clean water", worth: 0.5, amount: 6 }, { name: "Ammunition", worth: 2, amount: 0 }]);
  expect(goods.total).toBe(9);
  expect(Economy.fmtBarter(CONFIG, 3)).toBe("3 Day's food");
});

test("a shift changes a price in its region until its last day, and the most exact one sets availability", () => {
  const meal = { id: 1, name: "Hot meal", category: "Food and drink", coin_cost: 2, barter_cost: 1, availability: "common" };
  const rope = { id: 2, name: "Rope", category: "Gear", coin_cost: 1, barter_cost: null, availability: "common" };
  const famine = { region_id: 5, item_id: null, category: "Food and drink", multiplier: 1.5, availability: "scarce", reason: "Famine", until_day: 40 };
  const tax = { region_id: null, item_id: null, category: "", multiplier: 2, availability: "", reason: "War tax", until_day: null };
  const gone = { region_id: 5, item_id: 1, category: "", multiplier: 1, availability: "none", reason: "Cook fled", until_day: null };

  expect(Economy.priceIn(meal, [], 5, 10)).toMatchObject({ coin: 2, barter: 1, availability: "common", shifted: false });
  expect(Economy.priceIn(meal, [famine], 5, 10)).toMatchObject({ coin: 3, barter: 1.5, availability: "scarce", shifted: true, reasons: ["Famine"] });
  expect(Economy.priceIn(meal, [famine], 6, 10).shifted).toBe(false); // another region
  expect(Economy.priceIn(meal, [famine], null, 10).shifted).toBe(false); // no region picked
  expect(Economy.priceIn(meal, [famine], 5, 40).coin).toBe(3); // its last day
  expect(Economy.priceIn(meal, [famine], 5, 41).shifted).toBe(false); // ended
  expect(Economy.priceIn(rope, [famine], 5, 10).shifted).toBe(false); // another category
  expect(Economy.priceIn(rope, [tax], 5, 10)).toMatchObject({ coin: 2, barter: null, availability: "common", priceShifted: true });
  // shifts multiply together, and the one for this item sets availability over the category's
  expect(Economy.priceIn(meal, [gone, famine, tax], 5, 10)).toMatchObject({ coin: 6, barter: 3, availability: "none" });
  expect(Economy.priceIn(meal, [gone], 5, 10)).toMatchObject({ coin: 2, shifted: true, priceShifted: false });

  expect(Economy.shiftWords(famine, [meal])).toBe("Food and drink × 1.5, and Scarce");
  expect(Economy.shiftWords(tax, [meal])).toBe("Everything × 2");
  expect(Economy.shiftWords(gone, [meal])).toBe("Hot meal none to be had");
});

test("a CSV file is read with commas, semicolons or tabs, and quotes hold commas and line breaks", () => {
  expect(Economy.parseCSV('Name,Coins\r\n"Rope, 50 feet",1\r\n\r\n"A ""fine"" meal",2\n')).toEqual([["Name", "Coins"], ["Rope, 50 feet", "1"], ['A "fine" meal', "2"]]);
  expect(Economy.parseCSV("Name;Coins\nRope;1,5")).toEqual([["Name", "Coins"], ["Rope", "1,5"]]);
  expect(Economy.parseCSV("Name\tCoins\nRope\t1")).toEqual([["Name", "Coins"], ["Rope", "1"]]);
  expect(Economy.parseCSV('Name,Notes\nRope,"two\nlines"')).toEqual([["Name", "Notes"], ["Rope", "two\nlines"]]);
  expect(Economy.parseCSV("")).toEqual([]);
});

test("a price book is read from a file's rows by its column names, and rows it can't read are named", () => {
  const rows = Economy.parseCSV([
    "Item,Type,Silver mark,Day's food,Wealth,Favour,Rarity,Details,GM only",
    "Hot meal,Food and drink,2 bits,1/2,Poor,Small,common,Stew,",
    "Guide,Services,1 crown,3 Day's food,2,2,Scarce,,yes",
    "Mystery,,lots,,,,,,",
    ",Gear,1,,,,,,",
    "Palace,,,,Royal,,,,",
    "Sword,Gear,5,,,,legendary,,",
    "Plain thing,,,,,,,,",
  ].join("\n"));
  const got = Economy.itemsFromRows(CONFIG, rows);
  expect(got.columns).toEqual(["name", "category", "coin_cost", "barter_cost", "wealth_level", "favour_size", "availability", "notes", "is_secret"]);
  expect(got.items).toEqual([
    { name: "Hot meal", category: "Food and drink", coin_cost: 0.2, barter_cost: 0.5, wealth_level: 1, favour_size: 1, availability: "common", notes: "Stew" },
    { name: "Guide", category: "Services", coin_cost: 10, barter_cost: 3, wealth_level: 2, favour_size: 2, availability: "scarce", is_secret: true },
    { name: "Plain thing", availability: "common" },
  ]);
  expect(got.skipped).toEqual([
    { line: 4, why: '"lots" isn\'t a price in coins' },
    { line: 5, why: "No name" },
    { line: 6, why: '"Royal" isn\'t a wealth level' },
    { line: 7, why: '"legendary" isn\'t Common, Scarce, Rare or None' },
  ]);
  expect(Economy.itemsFromRows(CONFIG, [["Thing I want", "Cost"], ["Rope", "1"]]).skipped).toEqual([{ line: 1, why: "The first row needs a column called Name or Item" }]);
  expect(Economy.itemsFromRows(CONFIG, [])).toEqual({ items: [], skipped: [], columns: [] });
});

test("the price book written to a file reads back the same", () => {
  const items = [
    { name: 'Rope, "good"', category: "Gear", coin_cost: 1.5, barter_cost: 2, wealth_level: 1, favour_size: 3, availability: "rare", notes: "50 feet", is_secret: true },
    { name: "Bed", category: "", coin_cost: null, barter_cost: null, wealth_level: null, favour_size: null, availability: "none", notes: "", is_secret: false },
  ];
  const csv = Economy.itemsToCSV(CONFIG, items);
  expect(csv.split("\r\n")[0]).toBe("Name,Category,Coins,Barter,Wealth,Favour,Availability,Notes,Secret");
  expect(csv).toContain('"Rope, ""good""",Gear,1 sm 5 bits,2,Poor,Major,Rare,50 feet,yes');
  const back = Economy.itemsFromRows(CONFIG, Economy.parseCSV(csv));
  expect(back.skipped).toEqual([]);
  expect(back.items).toEqual([
    { name: 'Rope, "good"', category: "Gear", coin_cost: 1.5, barter_cost: 2, wealth_level: 1, favour_size: 3, availability: "rare", notes: "50 feet", is_secret: true },
    { name: "Bed", availability: "none" },
  ]);
});
