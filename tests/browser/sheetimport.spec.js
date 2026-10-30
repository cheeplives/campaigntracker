// Importing a character from another tool, under Node (static/sheetimport.js needs no page): a Pathbuilder 2e export
// and a D&D Beyond character read onto the starter templates' fields, and only what fits a sheet's own fields kept.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const I = require(path.join(__dirname, "..", "..", "static", "sheetimport.js"));
const L = require(path.join(__dirname, "..", "..", "static", "sheetlayout.js"));
const starter = name => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "db", "starter-templates", `${name}.json`), "utf8")).layout;

/** What Pathbuilder 2e's Export JSON gives, cut down to the parts read. */
const PATHBUILDER = () => ({ success: true, build: {
  name: "Valeros", class: "Fighter", level: 3, ancestry: "Human", heritage: "Versatile Human", background: "Farmhand", deity: "Not set",
  languages: ["Common", "Elven"], keyability: "str",
  attributes: { ancestryhp: 8, classhp: 10, bonushp: 0, bonushpPerLevel: 0, speed: 25, speedBonus: 5 },
  abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 12, cha: 9 },
  proficiencies: { classDC: 2, perception: 4, fortitude: 4, reflex: 4, will: 2, medium: 2, heavy: 0, acrobatics: 2, athletics: 4, arcana: 0, thievery: 8 },
  feats: [["Shield Block", null, "General Feat", 1], ["Power Attack", null, "Class Feat", 1]],
  lores: [["Farming", 2]],
  equipment: [["Rope", 1], ["Rations", 4]],
  weapons: [{ name: "Longsword", display: "+1 Longsword", attack: 9, die: "d8", damageBonus: 4, damageType: "S" }],
  money: { cp: 3, sp: 12, gp: 15, pp: 0 },
  acTotal: { acTotal: 18 },
  spellCasters: [], focusPoints: 0, xp: 120,
} });

/** What D&D Beyond's character service gives, cut down to the parts read. */
const DDB = () => ({ success: true, data: {
  name: "Mira", race: { fullName: "Wood Elf", baseRaceName: "Elf" }, background: { definition: { name: "Outlander" } },
  classes: [{ level: 3, definition: { name: "Ranger" }, subclassDefinition: { name: "Hunter" } }, { level: 1, definition: { name: "Rogue" }, subclassDefinition: null }],
  stats: [1, 2, 3, 4, 5, 6].map((id, i) => ({ id, value: [12, 15, 13, 10, 14, 8][i] })),
  bonusStats: [1, 2, 3, 4, 5, 6].map(id => ({ id, value: id === 1 ? 1 : null })),
  overrideStats: [1, 2, 3, 4, 5, 6].map(id => ({ id, value: id === 6 ? 11 : null })),
  modifiers: {
    race: [{ type: "bonus", subType: "dexterity-score", value: 2 }, { type: "bonus", subType: "wisdom-score", value: 1 }],
    class: [{ type: "proficiency", subType: "strength-saving-throws" }, { type: "proficiency", subType: "dexterity-saving-throws" },
      { type: "proficiency", subType: "stealth" }, { type: "expertise", subType: "sleight-of-hand" }],
    background: [{ type: "proficiency", subType: "survival" }, { type: "proficiency", subType: "animal-handling" }],
    item: [], feat: [],
  },
  baseHitPoints: 30, bonusHitPoints: 2, overrideHitPoints: null, removedHitPoints: 5, temporaryHitPoints: 3,
  currentXp: 2700, inspiration: true,
  currencies: { cp: 1, sp: 2, ep: 0, gp: 40, pp: 1 },
  inventory: [{ definition: { name: "Longbow" }, quantity: 1 }, { definition: { name: "Arrows" }, quantity: 20 }],
  traits: { personalityTraits: "Quiet", ideals: "Freedom", bonds: "My forest", flaws: "Stubborn", appearance: "Green cloak" },
  notes: { backstory: "Raised by rangers" },
} });

test("tells a Pathbuilder export from a D&D Beyond character, and neither from anything else", () => {
  expect(I.detect(PATHBUILDER())).toBe("pathbuilder");
  expect(I.detect(DDB())).toBe("dndbeyond");
  expect(I.detect({ hello: 1 })).toBe(null);
  expect(I.detect(null)).toBe(null);
});

test("a Pathbuilder export fills the Pathfinder 2e starter sheet", () => {
  const v = I.read(PATHBUILDER());
  expect(v.name).toBe("Valeros");
  expect(v.values).toMatchObject({
    ancestry: "Human", heritage: "Versatile Human", background: "Farmhand", class: "Fighter", level: 3, xp: 120,
    attr_strength: 4, attr_dexterity: 2, attr_constitution: 2, attr_intelligence: 0, attr_wisdom: 1, attr_charisma: -1,
    ac: 18, armor_rank: "Trained", fort_rank: "Expert", reflex_rank: "Expert", will_rank: "Trained", class_dc_rank: "Trained",
    perception_rank: "Expert", sk_acrobatics: "Trained", sk_athletics: "Expert", sk_arcana: "Untrained", sk_thievery: "Legendary",
    hp: { cur: 44, max: 44 },   // 8 + (10 + 2) × 3
    speed: 30, languages: "Common, Elven",
    money_copper: 3, money_silver: 12, money_gold: 15, money_platinum: 0,
  });
  expect(v.values.deity).toBeUndefined();   // Pathbuilder's "Not set"
  expect(v.values.lores).toEqual([{ lore: "Farming", rank: "Trained" }]);
  expect(v.values.feat_list).toEqual([{ level: "1", type: "General Feat", feat: "Shield Block" }, { level: "1", type: "Class Feat", feat: "Power Attack" }]);
  expect(v.values.items).toEqual([{ item: "Rope", qty: "1" }, { item: "Rations", qty: "4" }]);
  expect(v.values.strike_list).toEqual([{ weapon: "+1 Longsword", attack: "+9", damage: "1d8+4 S" }]);
});

test("a D&D Beyond character fills either D&D 5e starter sheet", () => {
  const v = I.read(DDB());
  expect(v.name).toBe("Mira");
  expect(v.values).toMatchObject({
    class: "Ranger 3 / Rogue 1", class_level: "Ranger (Hunter) 3 / Rogue 1", subclass: "Hunter", level: 4,
    species: "Wood Elf", race: "Wood Elf", background: "Outlander", xp: 2700, inspiration: true, heroic_inspiration: true,
    ab_strength: 13, ab_dexterity: 17, ab_constitution: 13, ab_intelligence: 10, ab_wisdom: 15, ab_charisma: 11,
    save_strength: true, save_dexterity: true, save_wisdom: false,
    sk_stealth: true, sk_sleight_of_hand: true, sk_survival: true, sk_animal_handling: true, sk_arcana: false,
    hp: { cur: 31, max: 36 },   // 30 + 2 + 1 (Con +1) × 4, less 5 taken
    temp_hp: 3, coin_cp: 1, coin_sp: 2, coin_ep: 0, coin_gp: 40, coin_pp: 1,
    traits: "Quiet", ideals: "Freedom", bonds: "My forest", flaws: "Stubborn", appearance: "Green cloak", backstory: "Raised by rangers",
  });
  expect(v.values.equipment).toEqual([{ item: "Longbow", qty: "1" }, { item: "Arrows", qty: "20" }]);
});

test("only the values a sheet has a field for, and that fit it, are kept", () => {
  for (const [name, data] of [["pathfinder-2e", PATHBUILDER()], ["dnd-5e-2014", DDB()], ["dnd-5e-2024", DDB()]]) {
    const layout = starter(name), fields = L.fields(layout);
    const { values, count } = I.fit(layout, I.read(data).values);
    expect(count, name).toBeGreaterThan(20);
    for (const [k, v] of Object.entries(values)) {
      expect(fields.has(k), `${name} ${k}`).toBe(true);
      expect(L.coerce(fields.get(k).field, v).ok, `${name} ${k}`).toBe(true);
    }
  }
  // a field of another type is left alone, and so is a list column the sheet hasn't got
  const layout = { sections: [{ key: "a", title: "A", fields: [{ key: "level", label: "Level", type: "pips", count: 2 },
    { key: "items", label: "Items", type: "list", columns: [{ key: "item", label: "Item" }] }] }] };
  const { values } = I.fit(layout, I.read(PATHBUILDER()).values);
  expect(values).toEqual({ items: [{ item: "Rope" }, { item: "Rations" }] });
});

test("a link to a Pathbuilder export or a D&D Beyond character is read; anything else isn't", () => {
  expect(I.link("https://pathbuilder2e.com/json.php?id=123456")).toEqual({ source: "pathbuilder", id: "123456" });
  expect(I.link("https://www.dndbeyond.com/characters/98765432")).toEqual({ source: "dndbeyond", id: "98765432" });
  expect(I.link("https://www.dndbeyond.com/profile/someone/characters/98765432")).toEqual({ source: "dndbeyond", id: "98765432" });
  expect(I.link("dndbeyond.com/characters/42/builder")).toEqual({ source: "dndbeyond", id: "42" });
  for (const bad of ["https://evil.example/json.php?id=1", "https://pathbuilder2e.com/json.php?id=abc", "not a link", ""]) expect(I.link(bad), bad).toBe(null);
});
