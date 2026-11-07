// The die roller's engine, under Node (static/dice.js needs nothing else): every line of the ? card reads and rolls as
// it says, the same seed always rolls the same dice, the dice are fair, and a roll that can't be read says why.
const { test, expect } = require("@playwright/test");
const path = require("path");
const Dice = require(path.join(__dirname, "..", "..", "static", "dice.js"));

const SEED = "0123456789abcdef0123456789abcdef";
const one = (expr, seed = SEED) => Dice.roll(expr, seed).results[0];
/** Every die of the first term, as numbers. */
const vals = r => r.terms[0].dice.map(d => d.v);
/** Roll expr with many seeds, calling f on each first result. */
function many(expr, n, f) {
  for (let k = 0; k < n; k++) f(Dice.roll(expr, Dice.newSeed()).results[0]);
}

test("the same roll and seed give the same dice; another seed, other dice", () => {
  const a = Dice.roll("10d20 + 4d6kh3 # check", SEED), b = Dice.roll("10d20 + 4d6kh3 # check", SEED);
  expect(b).toEqual(a);
  expect(a.label).toBe("check");
  const c = Dice.roll("10d20", "f".repeat(32));
  expect(c.results[0].terms[0].dice.map(d => d.v)).not.toEqual(a.results[0].terms[0].dice.map(d => d.v));
  // spaces and capitals don't matter
  expect(Dice.roll(" 10D20+4d6KH3 ", SEED).results).toEqual(a.results);
});

test("plain dice add up, and the maths signs work as typed or as on a keyboard", () => {
  many("3d6+2", 300, r => {
    expect(r.total).toBe(vals(r).reduce((s, v) => s + v, 0) + 2);
    expect(r.total).toBeGreaterThanOrEqual(5);
    expect(r.total).toBeLessThanOrEqual(20);
  });
  expect(one("2*(3+4)-10/3").total).toBe(11);
  expect(one("2×(3+4)−10÷3").total).toBe(11);
  expect(one("-3+5").total).toBe(2);
  many("d%", 200, r => { expect(r.total).toBeGreaterThanOrEqual(1); expect(r.total).toBeLessThanOrEqual(100); });
  many("4dF", 200, r => { for (const v of vals(r)) expect([-1, 0, 1]).toContain(v); });
  many("d66", 200, r => { const v = r.total; expect(Math.floor(v / 10)).toBeGreaterThanOrEqual(1); expect(Math.floor(v / 10)).toBeLessThanOrEqual(6); expect(v % 10).toBeGreaterThanOrEqual(1); expect(v % 10).toBeLessThanOrEqual(6); });
});

test("keep and drop take the highest or lowest dice; adv and dis are 2d20 keeping one", () => {
  many("4d6kh3", 300, r => {
    const v = vals(r).sort((a, b) => b - a);
    expect(r.total).toBe(v[0] + v[1] + v[2]);
    expect(r.terms[0].dice.filter(d => d.dropped)).toHaveLength(1);
  });
  many("4d6dl1", 100, r => { const v = vals(r).sort((a, b) => b - a); expect(r.total).toBe(v[0] + v[1] + v[2]); });
  many("4d6dh1", 100, r => { const v = vals(r).sort((a, b) => a - b); expect(r.total).toBe(v[0] + v[1] + v[2]); });
  many("2d20kl1", 100, r => expect(r.total).toBe(Math.min(...vals(r))));
  many("adv+5", 100, r => expect(r.total).toBe(Math.max(...vals(r)) + 5));
  many("dis", 100, r => expect(r.total).toBe(Math.min(...vals(r))));
});

test("exploding dice roll again on their top face, or what they are told; compounding adds into one die", () => {
  let sawBoom = false;
  many("3d6!", 300, r => {
    const ds = r.terms[0].dice;
    expect(ds.filter(d => !d.extra)).toHaveLength(3);
    for (let k = 0; k < ds.length; k++) {
      if (ds[k].v === 6) { sawBoom = true; expect(ds[k + 1]?.extra).toBe(true); expect(ds[k].exploded).toBe(true); }
    }
  });
  expect(sawBoom).toBe(true);
  many("10d10!>=8", 100, r => {
    const ds = r.terms[0].dice;
    expect(ds.length - 10).toBe(ds.filter(d => d.v >= 8).length);
  });
  let compounded = false;
  many("d6!!", 300, r => {
    const d = r.terms[0].dice[0];
    expect(r.terms[0].dice).toHaveLength(1);
    expect(d.v).toBe(d.rolls.reduce((s, v) => s + v, 0));
    if (d.rolls.length > 1) { compounded = true; expect(d.rolls.slice(0, -1).every(v => v === 6)).toBe(true); }
  });
  expect(compounded).toBe(true);
});

test("rerolls: r keeps rerolling, ro rerolls once", () => {
  many("10d6r1", 200, r => { for (const v of vals(r)) expect(v).not.toBe(1); });
  many("10d6r<3", 200, r => { for (const v of vals(r)) expect(v).toBeGreaterThanOrEqual(3); });
  let kept1 = false;
  many("d20ro1", 2000, r => { const d = r.terms[0].dice[0]; if (d.rerolled.length) expect(d.rerolled).toEqual([1]); if (d.v === 1) kept1 = true; });
  expect(kept1).toBe(true);   // a 1 rerolled once can come up 1 again, and stays
});

test("success counting, with failures cancelling", () => {
  many("7d10>=6", 200, r => {
    expect(r.total).toBe(vals(r).filter(v => v >= 6).length);
    expect(Dice.roll("7d10>=6", Dice.newSeed()).results[0].mode).toBe("successes");
  });
  many("7d10>=6f1", 300, r => expect(r.total).toBe(vals(r).filter(v => v >= 6).length - vals(r).filter(v => v === 1).length));
  expect(Dice.summary(Dice.roll("7d10>=6", SEED))).toMatch(/^-?\d+ success(es)?$/);
  expect(one("2d6+3").mode).toBe("total");
});

test("percentile tricks: bonus and penalty dice, flip-flop and swap", () => {
  expect(Dice.swapped(73)).toBe(37);
  expect(Dice.swapped(40)).toBe(4);
  expect(Dice.swapped(5)).toBe(50);
  expect(Dice.swapped(100)).toBe(100);
  expect(Dice.swapped(10)).toBe(1);
  many("d100flip", 300, r => { const d = r.terms[0].dice[0]; expect(d.v).toBe(Math.min(d.rolls[0], Dice.swapped(d.rolls[0]))); });
  many("d100swap", 300, r => { const d = r.terms[0].dice[0]; expect(d.v).toBe(Dice.swapped(d.rolls[0])); });
  // a bonus die shares the units die: every reading ends in the same digit, and the lowest counts (the highest for a penalty)
  many("d100b2", 300, r => {
    const d = r.terms[0].dice[0];
    expect(d.rolls).toHaveLength(3);
    expect(new Set(d.rolls.map(v => v % 10)).size).toBe(1);
    expect(d.v).toBe(Math.min(...d.rolls));
  });
  many("d100p1", 300, r => { const d = r.terms[0].dice[0]; expect(d.v).toBe(Math.max(...d.rolls)); });
  // a bonus die makes 50 or under about three times in four
  let low = 0;
  many("d100b1", 4000, r => { if (r.total <= 50) low++; });
  expect(low / 4000).toBeGreaterThan(0.72);
  expect(low / 4000).toBeLessThan(0.78);
});

test("repeat rolls the whole thing again, and each go is its own result", () => {
  const r = Dice.roll("6x(4d6kh3) # stats", SEED);
  expect(r.repeat).toBe(6);
  expect(r.results).toHaveLength(6);
  expect(r.label).toBe("stats");
  expect(Dice.summary(r).split(", ")).toHaveLength(6);
});

test("the dice are fair: each face of a d6, d20 and d100 comes up about as often", () => {
  for (const sides of [6, 20, 100]) {
    const R = Dice.seeded(Dice.newSeed(), 1e7), n = sides * 6000, count = new Array(sides + 1).fill(0);
    for (let k = 0; k < n; k++) count[R.int(sides)]++;
    // chi-squared against even odds: under its mean plus six of its standard deviations, which a fair die all but never
    // passes, so the test doesn't fail by chance; a die that skipped or doubled a face would be far over
    const want = n / sides, df = sides - 1;
    const chi = count.slice(1).reduce((s, c) => s + (c - want) ** 2 / want, 0);
    expect(chi).toBeLessThan(df + 6 * Math.sqrt(2 * df));
    expect(count[0]).toBe(0);
  }
});

test("a roll that can't be read says why", () => {
  const cases = {
    "": "Type a roll",
    "d": "number of sides",
    "d1": "2 to 1000 sides",
    "101d6": "1 to 100 dice",
    "(2d6": "missing its )",
    "2d6)": "no ( to match",
    "d6!>=1": "explode, forever",
    "d6r<7": "rerolled, forever",
    "3d6f1": "give a success target",
    "d20flip": "for d100",
    "d100b3": "1 or 2 bonus",
    "2d6kh1kl1": "once",
    "3x(2d6": "Repeat goes round",
    "21x(d6)": "1 to 20 times",
    "hello": "Can't read",
    "1/0": "divides by zero",
  };
  for (const [expr, msg] of Object.entries(cases)) {
    const got = expr === "1/0" ? (() => { try { Dice.roll(expr, SEED); return null; } catch (e) { return e.message; } })() : Dice.check(expr);
    expect(got, expr).toContain(msg);
  }
  expect(Dice.check("x".repeat(201))).toContain("too long");
  expect(Dice.check("2d6+3 # anything at all ( ) # !")).toBeNull();
  // a roll that would draw thousands of dice stops instead of hanging the page
  expect(() => Dice.roll("100d2!>=2r1", SEED)).toThrow();
  expect(() => Dice.roll("20x(100d1000)", SEED)).not.toThrow();
  expect(() => Dice.roll("20x(100d1000)+20x(1)", SEED)).toThrow();
});
