// Character sheet layouts under Node (static/sheetlayout.js needs no page): the layout rules, field keys, what a value
// of each field type may hold, values surviving a template change, hidden fields, and drafting a template from what
// pdf.js reads out of a PDF.
const { test, expect } = require("@playwright/test");
const path = require("path");
const L = require(path.join(__dirname, "..", "..", "static", "sheetlayout.js"));

const sample = () => ({ sections: [
  { key: "stats", title: "Stats", fields: [
    { key: "str", label: "Strength", type: "number" },
    { key: "hp", label: "Hit Points", type: "counter", play: true },
    { key: "inspiration", label: "Inspiration", type: "pips", count: 3 },
  ] },
  { key: "background", title: "Background", fields: [
    { key: "past", label: "Past", type: "longtext" },
    { key: "class", label: "Class", type: "choice", options: ["Fighter", "Wizard"], summary: true },
    { key: "gear", label: "Gear", type: "list", columns: [{ key: "item", label: "Item" }, { key: "qty", label: "Qty" }] },
  ] },
] });

test("validate accepts a good layout and names what is wrong with a bad one", () => {
  expect(L.validate(sample())).toEqual([]);
  const dup = sample(); dup.sections[1].fields[0].key = "stats";
  expect(L.validate(dup).join(" ")).toMatch(/stats/);
  const dice = sample(); dice.sections[0].fields[0].type = "dice";
  expect(L.validate(dice).join(" ")).toMatch(/dice/);
  const pips = sample(); pips.sections[0].fields[2].count = 0;
  expect(L.validate(pips).length).toBeGreaterThan(0);
  const choice = sample(); choice.sections[1].fields[1].options = [];
  expect(L.validate(choice).length).toBeGreaterThan(0);
  const many = { sections: Array.from({ length: 51 }, (_, i) => ({ key: `s${i}`, title: `S${i}`, fields: [] })) };
  expect(L.validate(many).length).toBeGreaterThan(0);
  const long = sample(); long.sections[0].fields[0].label = "x".repeat(101);
  expect(L.validate(long).length).toBeGreaterThan(0);
  const badKey = sample(); badKey.sections[0].fields[0].key = "Str";
  expect(L.validate(badKey).length).toBeGreaterThan(0);
  expect(L.validate(null).length).toBeGreaterThan(0);
});

test("newKey makes a key from a label, unique among those taken", () => {
  expect(L.newKey("Hit Points", new Set())).toBe("hit_points");
  expect(L.newKey("Hit Points", new Set(["hit_points"]))).toBe("hit_points_2");
  expect(L.newKey("3rd Level", new Set())).toBe("f_3rd_level");
  expect(L.newKey("力", new Set())).toMatch(/^f_[a-z0-9]{4}$/);
  expect(L.newKey("x".repeat(80), new Set())).toHaveLength(40);
});

test("coerce says what each type of field may hold", () => {
  const f = Object.fromEntries([...L.fields(sample())].map(([k, v]) => [k, v.field]));
  expect(L.coerce(f.hp, { cur: 7, max: 10 })).toEqual({ ok: true, value: { cur: 7, max: 10 } });
  expect(L.coerce(f.hp, 5).ok).toBe(false);
  expect(L.coerce(f.inspiration, 4).ok).toBe(false);
  expect(L.coerce(f.inspiration, 2)).toEqual({ ok: true, value: 2 });
  expect(L.coerce(f.class, "Bard")).toEqual({ ok: true, value: "Bard" });  // a custom entry beside the options
  expect(L.coerce(f.class, "x".repeat(501)).ok).toBe(false);
  expect(L.coerce(f.class, 3).ok).toBe(false);
  expect(L.coerce(f.class, null)).toEqual({ ok: true, value: null });
  expect(L.coerce(f.gear, Array.from({ length: 201 }, () => ({ item: "Rope" }))).ok).toBe(false);
  expect(L.coerce(f.gear, [{ item: "Rope", qty: "2", junk: "x" }])).toEqual({ ok: true, value: [{ item: "Rope", qty: "2" }] });
  expect(L.coerce(f.str, "12")).toEqual({ ok: true, value: 12 });
  expect(L.coerce(f.str, "twelve").ok).toBe(false);
  expect(L.coerce(f.past, "x".repeat(20001)).ok).toBe(false);
  expect(L.coerce({ key: "n", label: "N", type: "text" }, "x".repeat(501)).ok).toBe(false);
  expect(L.coerce({ key: "c", label: "C", type: "checkbox" }, true)).toEqual({ ok: true, value: true });
});

test("reconcile keeps values by key, and moves what no longer fits to old fields", () => {
  const values = { str: 12, hp: { cur: 5, max: 10 }, gone: "x" };
  const renamed = sample(); renamed.sections[0].fields[0].label = "STR";
  expect(L.reconcile(renamed, values)).toEqual({ values: { str: 12, hp: { cur: 5, max: 10 } }, old: [{ key: "gone", value: "x" }] });
  const changed = sample(); changed.sections[0].fields[0].type = "counter";
  const r = L.reconcile(changed, { str: 12 });
  expect(r.values).toEqual({});
  expect(r.old).toEqual([{ key: "str", value: 12 }]);
});

test("visibleTo leaves out hidden fields and every field of a hidden section, unless shown in full", () => {
  const values = { str: 12, past: "Orphan", class: "Wizard" };
  expect(L.visibleTo(sample(), values, ["background"], false)).toEqual({ str: 12 });
  expect(L.visibleTo(sample(), values, ["str"], false)).toEqual({ past: "Orphan", class: "Wizard" });
  expect(L.visibleTo(sample(), values, ["background"], true)).toEqual(values);
});

test("draftFromFormFields turns a fillable PDF's fields into a layout, labelling junk names from nearby text", () => {
  const layout = L.draftFromFormFields([
    { name: "STR", type: "text", page: 1, rect: [50, 700, 80, 720] },
    { name: "Check Box 12", type: "checkbox", page: 1, rect: [50, 650, 60, 660] },
    { name: "Notes", type: "text", page: 2, rect: [50, 700, 300, 720] },
  ], [{ str: "Athletics", page: 1, x: 66, y: 652 }]);
  expect(L.validate(layout)).toEqual([]);
  expect(layout.sections.map(s => s.title)).toEqual(["Page 1", "Page 2"]);
  expect(layout.sections[0].fields.map(f => [f.label, f.type])).toEqual([["STR", "number"], ["Athletics", "checkbox"]]);
  expect(layout.sections[1].fields[0].label).toBe("Notes");
});

test("draftFromText turns a flat sheet's labels into fields, with large text as section titles and no rules text", () => {
  const items = [
    { str: "Name", page: 1, x: 40, y: 760, h: 10 },
    { str: "Abilities", page: 1, x: 40, y: 720, h: 16 },
    { str: "Strength", page: 1, x: 40, y: 700, h: 10 },
    { str: "Dexterity", page: 1, x: 40, y: 680, h: 10 },
    { str: "When you roll a 6 on any die you may roll it again and add it to the total, and keep going until you stop rolling sixes, which is how the dice explode in this game and in many others like it.", page: 1, x: 40, y: 600, h: 10 },
  ];
  const layout = L.draftFromText(items);
  expect(L.validate(layout)).toEqual([]);
  expect(layout.sections.map(s => [s.title, s.fields.map(f => f.label)])).toEqual([["Page 1", ["Name"]], ["Abilities", ["Strength", "Dexterity"]]]);
});

test("validate takes an optional VTT mapping on a field: a system and a path for each VTT", () => {
  const ok = sample(); ok.sections[0].fields[1].vtt = { foundry: { system: "dnd5e", path: "system.attributes.hp.value" } };
  expect(L.validate(ok)).toEqual([]);
  for (const vtt of [{ foundry: { system: "dnd5e" } }, { Foundry: { system: "dnd5e", path: "a.b" } }, { foundry: { system: "dnd5e", path: "a b;" } },
    { foundry: "system.hp" }, [], { foundry: { system: "x".repeat(61), path: "a" } }]) {
    const bad = sample(); bad.sections[0].fields[1].vtt = vtt;
    expect(L.validate(bad).join(" "), JSON.stringify(vtt)).toMatch(/VTT/);
  }
});

test("a field's box size is small, medium or large", () => {
  for (const size of ["small", "medium", "large"]) {
    const ok = sample(); ok.sections[0].fields[0].size = size;
    expect(L.validate(ok)).toEqual([]);
  }
  const bad = sample(); bad.sections[0].fields[0].size = "huge";
  expect(L.validate(bad).join(" ")).toMatch(/size/);
});
