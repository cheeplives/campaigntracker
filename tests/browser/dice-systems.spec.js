// The dice systems (static/dice-systems.js), under Node: every system and "Start from a game" preset builds dice the
// engine can roll, stores and reads back its numbers, and reads its dice the way its rules say; the odds add up.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Dice = require(path.join(__dirname, "..", "..", "static", "dice.js"));
global.Dice = Dice;
const DS = require(path.join(__dirname, "..", "..", "static", "dice-systems.js"));

/** A rolled result with these dice, term by term: [[values], …]; a value can be {v, rolls, dropped}. */
function fake(terms, extra = 0) {
  const ts = terms.map(t => {
    const dice = t.map(x => (typeof x === "number" ? { v: x, rolls: [x] } : { rolls: [x.v], ...x }))
      .map(d => ({ rerolled: [], dropped: false, success: false, fail: false, exploded: false, extra: false, note: null, ...d }));
    return { sides: 0, dice, value: dice.filter(d => !d.dropped).reduce((s, d) => s + d.v, 0) };
  });
  return { total: ts.reduce((s, t) => s + t.value, 0) + extra, terms: ts, mode: "total" };
}
const read = (id, r, p = {}, ctx = {}) => { const sys = DS.BY_ID[id]; return sys.read(r, DS.params(sys, p), ctx); };

test("every system and preset builds dice that roll, and its numbers go round the @ and back", () => {
  expect(DS.SYSTEMS.length).toBe(18);
  for (const g of DS.GROUPS) expect(DS.SYSTEMS.some(s => s.group === g[0])).toBe(true);
  const setups = [...DS.SYSTEMS.map(s => [s, {}]), ...DS.PRESETS.map(g => [DS.BY_ID[g.system], g.params])];
  for (const [sys, given] of setups) {
    expect(sys).toBeTruthy();
    const p = DS.params(sys, given);
    for (const d of sys.params) if (d.type === "num") { expect(p[d.key]).toBeGreaterThanOrEqual(d.min); expect(p[d.key]).toBeLessThanOrEqual(d.max); }
    const text = DS.rollText(sys, p, "a label");
    expect(Dice.check(text)).toBeNull();
    const res = Dice.roll(text, Dice.newSeed());
    expect(res.label).toBe("a label");
    const back = DS.decode(res.system);
    expect(back.sys.id).toBe(sys.id);
    expect(back.p).toEqual(p);
    for (let k = 0; k < 50; k++) {
      const o = DS.read(Dice.roll(text, Dice.newSeed()), { table: "1-50 Low\n51+ High (good)" });
      expect(o.sys.id).toBe(sys.id);
      expect([null, ...DS.TIERS]).toContain(o.tier);
      expect(o.big).not.toBeUndefined();
    }
  }
  // a roll with no system, or one this page doesn't know, has no reading
  expect(DS.read(Dice.roll("2d6", Dice.newSeed()))).toBeNull();
  expect(DS.read(Dice.roll("2d6 @nosuch x=1", Dice.newSeed()))).toBeNull();
});

test("numbers out of range, unknown choices and odd text are put right", () => {
  const sys = DS.BY_ID.pool;
  const p = DS.params(sys, { n: 999, t: "abc", d: 7, ones: "1", botch: "nope" });
  expect(p.n).toBe(60);
  expect(p.t).toBe(6);
  expect(p.d).toBe(10);
  expect(p.ones).toBe(true);
  expect(p.botch).toBe("none");
  const duality = DS.params(DS.BY_ID.duality, { first: "Ho#pe@\nx" });
  expect(duality.first).toBe("Hopex");
  // a label can't start a new system or a second label
  expect(DS.rollText(DS.BY_ID.d20, DS.params(DS.BY_ID.d20), "a @b")).toMatch(/# a b$/);
});

test("single die + modifier: naturals, a DC, and Pathfinder 2e's degrees", () => {
  expect(read("d20", fake([[20]], 0), { tn: 25 })).toMatchObject({ tier: "crit", words: "Critical success" });
  expect(read("d20", fake([[1]], 30), { tn: 15 })).toMatchObject({ tier: "botch" });
  expect(read("d20", fake([[12]], 3), { tn: 15 })).toMatchObject({ tier: "good", note: "beat 15 by 0" });
  expect(read("d20", fake([[11]], 3), { tn: 15 })).toMatchObject({ tier: "bad", note: "missed 15 by 1" });
  const pf2 = { tn: 15, margin: 10 };
  expect(read("d20", fake([[15]], 10), pf2).tier).toBe("crit");     // beat by 10
  expect(read("d20", fake([[2]], 3), pf2).tier).toBe("botch");      // missed by 10
  expect(read("d20", fake([[20]], -10), pf2).tier).toBe("good");    // a failure, a natural 20 steps it up one
  expect(read("d20", fake([[1]], 24), pf2).tier).toBe("good");      // a critical, a natural 1 steps it down one
  // advantage keeps the higher die, and the reading takes the kept one
  expect(read("d20", fake([[{ v: 3, dropped: true }, 20]]), { tn: 15, adv: "adv" }).tier).toBe("crit");
});

test("bands, roll-under and percentile read as their games do", () => {
  expect(read("pbta", fake([[3, 3]], 0)).words).toBe("Miss");
  expect(read("pbta", fake([[4, 3]], 0)).words).toBe("Weak hit");
  expect(read("pbta", fake([[6, 3]], 1)).words).toBe("Strong hit");
  expect(read("action", fake([[4], [3, 9]]), { stat: 2 })).toMatchObject({ big: 6, words: "Weak hit" });
  expect(read("action", fake([[6], [9, 9]]), { stat: 5, adds: 3 })).toMatchObject({ big: 10, words: "Strong hit, a match" });
  expect(read("duality", fake([[7], [7]]))).toMatchObject({ tier: "crit" });
  expect(read("duality", fake([[9], [4]]), { tn: 12 }).words).toBe("Success with Hope");
  expect(read("fudge", fake([[1, 1, 0, 1]], 2), { skill: 2, opp: 2 })).toMatchObject({ words: "Succeed with style", big: "+5" });
  // Call of Cthulhu: regular, hard, extreme; a fumble under 50 is 96+
  const coc = v => read("percent", fake([[v]]), { skill: 40 });
  expect(coc(1).words).toBe("Critical success");
  expect(coc(8).words).toBe("Extreme success");
  expect(coc(20).words).toBe("Hard success");
  expect(coc(40).words).toBe("Regular success");
  expect(coc(41).words).toBe("Failure");
  expect(coc(96).words).toBe("Fumble");
  // Warhammer: success levels, doubles
  expect(read("percent", fake([[23]]), { skill: 45, mode: "sl" }).words).toBe("Success, +2 SL");
  expect(read("percent", fake([[33]]), { skill: 45, mode: "sl", doubles: true }).words).toBe("Success, +1 SL, critical");
  expect(read("percent", fake([[66]]), { skill: 45, mode: "sl", doubles: true }).tier).toBe("botch");
  // GURPS 3d6 under: 3 and 4 always critical, 18 always a critical failure
  expect(read("under3d6", fake([[1, 1, 2]]), { skill: 9 }).tier).toBe("crit");
  expect(read("under3d6", fake([[6, 6, 6]]), { skill: 20 }).tier).toBe("botch");
  expect(read("under3d6", fake([[4, 4, 4]]), { skill: 12 }).words).toBe("Success");
  expect(read("under20", fake([[13]]), { stat: 12 }).words).toBe("Failure");
  expect(read("under20", fake([[12]]), { stat: 12, exact: true }).tier).toBe("crit");
});

test("pools count successes, botches and glitches; highest die, roll-offs, keeps, sets and symbols", () => {
  const v20 = { d: 10, t: 6, ones: true, botch: "wod" };
  expect(read("pool", fake([[7, 8, 1, 3]]), v20)).toMatchObject({ big: 1, tier: "good" });
  expect(read("pool", fake([[2, 1, 3]]), v20)).toMatchObject({ words: "Botch", tier: "botch" });
  expect(read("pool", fake([[1, 1, 1, 6]]), { d: 6, t: 5, botch: "glitch", n: 4 }).words).toMatch(/glitch/);
  expect(read("pool", fake([[10, 8, 3]]), { d: 10, t: 7, dbl: 10 }).big).toBe(3);   // Exalted: a 10 counts twice
  expect(read("pool", fake([[8, 9, 10, 8, 9]]), { t: 8, exc: 5 })).toMatchObject({ tier: "crit" });
  expect(read("highest", fake([[2, 5]]), { n: 2 }).words).toBe("Partial success");
  expect(read("highest", fake([[6, 6]]), { n: 2 }).words).toBe("Critical");
  expect(read("highest", fake([[3, 6]]), { n: 2 }).words).toBe("Full success");
  expect(read("highest", fake([[{ v: 6, dropped: true }, 2]]), { n: 0 }).words).toBe("Bad outcome");
  expect(read("rolloff", fake([[9, 7, 2], [8, 3]]), { a: 3, b: 2 })).toMatchObject({ big: 1, words: "You win: 1 victory" });
  expect(read("rolloff", fake([[9, 4], [9, 5]]), { a: 2, b: 2 }).words).toMatch(/They win/);
  expect(read("keep", fake([[10, 9, 8, { v: 2, dropped: true }]]), { tn: 15 }).words).toBe("Success, 2 raises");
  expect(read("sets", fake([[3, 3, 7, 7, 7]]))).toMatchObject({ big: "3×7", words: "also 2×3" });
  expect(read("sets", fake([[1, 2, 3]])).words).toBe("No set");
  // narrative symbols: 2 ability d8 (faces 4 = ✓✓, 5 = ▲), 1 difficulty d8 (face 2 = ✗)
  const sym = read("symbols", fake([[4, 5], [2]]), { ab: 2, pr: 0, di: 1 });
  expect(sym).toMatchObject({ big: "1✓", words: "Success, 1 advantage", tier: "good" });
  expect(sym.faces).toEqual([["✓✓", "▲"], ["✗"]]);
  expect(read("step", fake([[{ v: 1 }], [{ v: 1 }]]), { trait: 8 }).tier).toBe("botch");
  expect(read("step", fake([[9], [3]]), { trait: 8, tn: 4 }).words).toBe("Success, 1 raise");
  expect(read("oracle", fake([[44]]), { odds: 50 }).words).toBe("Yes, and a twist");
});

test("a result table reads its rows and tiers; open-ended d100 explodes on 96+", () => {
  const rows = DS.tableRows("1-5 Failure (bad)\n6–10 Partial (partial)\n11 to 15 Fine\n16+ Great (crit)\nnot a row");
  expect(rows.map(r => r.text)).toEqual(["Failure", "Partial", "Fine", "Great"]);
  const table = "1-5 Failure (bad)\n6–10 Partial (partial)\n11 to 15 Fine\n16+ Great (crit)";
  expect(read("table", fake([[3]], -10), {}, { table })).toMatchObject({ words: "Failure", tier: "bad" });   // below the first row
  expect(read("table", fake([[12]]), {}, { table })).toMatchObject({ words: "Fine", tier: null });
  expect(read("table", fake([[90]]), {}, { table })).toMatchObject({ words: "Great", tier: "crit" });
  expect(DS.BY_ID.table.build(DS.params(DS.BY_ID.table, { open: true }))).toBe("1d100!>=96");
});

test("the odds add up, and match the maths where it is simple", () => {
  for (const sys of DS.SYSTEMS) {
    const o = DS.odds(sys, DS.params(sys), { table: "1-50 Low (bad)\n51+ High (good)" }, 400);
    if (!o) continue;
    const sum = DS.TIERS.reduce((s, t) => s + o[t], 0);
    expect(sum).toBeLessThanOrEqual(1.0001);
  }
  const d20 = DS.BY_ID.d20;
  const o = DS.odds(d20, DS.params(d20, { tn: 11 }), {}, 20000);
  expect(o.crit).toBeCloseTo(0.05, 1);
  expect(o.botch).toBeCloseTo(0.05, 1);
  expect(o.good).toBeCloseTo(0.45, 1);
  const pb = DS.odds(DS.BY_ID.pbta, DS.params(DS.BY_ID.pbta), {}, 20000);
  expect(pb.good).toBeCloseTo(6 / 36, 1);
  expect(pb.partial).toBeCloseTo(15 / 36, 1);
  // a plain d20 with no target has no odds to show
  expect(DS.odds(d20, DS.params(d20, { tn: 0, crit: 0, fumble: false }), {}, 200)).toBeNull();
});

test("a campaign's system comes from its settings, or there is none", () => {
  expect(DS.campaignSystem(null)).toBeNull();
  expect(DS.campaignSystem({ system: null })).toBeNull();
  expect(DS.campaignSystem({ system: { id: "nope" } })).toBeNull();
  const c = DS.campaignSystem({ system: { id: "pool", params: { n: "8" }, labels: { n: "Dice pool" }, game: "v20" } });
  expect(c.sys.id).toBe("pool");
  expect(c.p.n).toBe(8);
  expect(c.labels.n).toBe("Dice pool");
  expect(c.game).toBe("v20");
});
