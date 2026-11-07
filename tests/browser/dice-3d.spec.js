// The 3D dice (static/dice-3d.js), under Node: every shape has the faces a real die has, numbered the way a real one
// is, and turning a die to land on a value puts that value on top, upright, for every value of every die. A roll's
// dice become the right 3D dice (a d100 is a tens die and a units die, Fudge dice are marked d6s), and the server keeps
// only a real colour and pattern as a player's dice.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { pathToFileURL } = require("url");
const Dice = require(path.join(__dirname, "..", "..", "static", "dice.js"));
const { person, signIn, api, approve, makeCampaign, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

global.window = global.window || {};
require(path.join(__dirname, "..", "..", "static", "dice-3d.js"));
const D3 = global.window.Dice3D;
const lib = () => import(pathToFileURL(path.join(__dirname, "..", "..", "static", "vendor", "three", "three.dice.min.mjs")).href);

test("each shape has a real die's faces, and opposite faces add up to one more than the sides", () => {
  const faces = { 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 20: 20 };
  for (const [sides, n] of Object.entries(faces)) {
    const sh = D3.shape(Number(sides));
    expect(sh.faces.length).toBe(n);
    if (Number(sides) === 4) continue;
    expect(sh.faces.map(f => f.value).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
    for (const f of sh.faces) {
      const opp = sh.faces.find(g => g.n[0] * f.n[0] + g.n[1] * f.n[1] + g.n[2] * f.n[2] < -0.999);
      expect(opp.value + f.value).toBe(n + 1);
    }
  }
});

test("a die turned to land on a value shows that value on top, the right way up", async () => {
  const T = await lib();
  for (const sides of [4, 6, 8, 10, 12, 20]) {
    for (let v = 1; v <= sides; v++) {
      for (let k = 0; k < 3; k++) {             // a face is picked at random where several show the same thing
        const top = D3.topAfter(T, sides, v, null);
        if (sides === 4) { expect(top).toBe(String(v)); continue; }
        expect(top.text).toBe(String(v));
        expect(top.flat).toBeGreaterThan(0.999);   // lying flat on that face
        expect(top.upright).toBeGreaterThan(0.85); // its number points up the screen, give or take a small turn
      }
    }
  }
  const { FUDGE, D3: d3, TENS, UNITS } = D3.LABELS;
  for (const v of [-1, 0, 1]) expect(D3.topAfter(T, 6, v, FUDGE).text).toBe(v > 0 ? "+" : v < 0 ? "−" : "");
  for (const v of [1, 2, 3]) expect(D3.topAfter(T, 6, v, d3).text).toBe(String(v));
  for (let v = 0; v <= 9; v++) {
    expect(D3.topAfter(T, 10, v, TENS).text).toBe(`${v}0`);
    expect(D3.topAfter(T, 10, v, UNITS).text).toBe(String(v));
  }
});

test("a roll's dice become the 3D dice that show it", () => {
  const plan = expr => D3.plan(Dice.roll(expr, Dice.newSeed()));
  const p = plan("1d4+2d6+1d8+1d10+1d12+1d20");
  expect(p.map(d => d.sides)).toEqual([4, 6, 6, 8, 10, 12, 20]);

  // a d100 is a tens die and a units die that read as the roll (00 and 0 is 100)
  for (let k = 0; k < 20; k++) {
    const res = Dice.roll("d100", Dice.newSeed());
    const [tens, units] = D3.plan(res);
    expect([tens.label, units.label]).toEqual(["tens", "units"]);
    const v = res.results[0].terms[0].dice[0].v;
    expect((tens.value * 10 + units.value) || 100).toBe(v);
  }
  // bonus dice: one tens die each, one units die
  expect(plan("d100b2").map(d => d.label)).toEqual(["tens", "tens", "tens", "units"]);
  // Fudge dice, a d66 as two d6s, a d3 as a d6 numbered 1 to 3 twice; a d2 or a d7 has no shape, so isn't thrown
  expect(plan("4dF").every(d => d.sides === 6 && d.label === "F")).toBe(true);
  const d66 = Dice.roll("d66", Dice.newSeed());
  const two = D3.plan(d66);
  expect(two.map(d => d.value)).toEqual([Math.floor(d66.results[0].total / 10), d66.results[0].total % 10]);
  expect(plan("2d3").map(d => d.label)).toEqual(["d3", "d3"]);
  expect(plan("d2+d7")).toEqual([]);
  // dropped dice are thrown too, dimmed; more than 30 dice is only the flat dice
  const kept = plan("4d6kh3");
  expect(kept.filter(d => d.dim)).toHaveLength(1);
  expect(plan("31d6")).toEqual([]);
  expect(plan("30d6")).toHaveLength(30);
});

test("a player's dice colours: kept on their account, sent with each of their rolls, and only a real colour and pattern", async ({ page, browser }) => {
  const pip = person("Pip");
  await signIn(page, pip);
  await approve(browser, pip.email);
  const cid = await makeCampaign(page, `Looks ${pip.id}`);
  const bad = [{ body: "red", ink: "#ffffff", tex: "" }, { body: "#112233", ink: "#ffffff", tex: "lava" }, { body: "#112233" }, "green"];
  for (const look of bad) expect((await api(page, "prefs_save", { dice_look: look })).status).toBe(400);
  const ok = await api(page, "prefs_save", { dice_look: { body: "#1E7A4C", ink: "#fff6d8", tex: "wood" } });
  expect(ok.status).toBe(200);
  expect(ok.json.prefs.dice_look).toEqual({ body: "#1e7a4c", ink: "#fff6d8", tex: "wood" });
  expect((await api(page, "dice_roll", { expr: "1d20", engine: Dice.VERSION }, cid)).status).toBe(200);
  let rolls = (await api(page, "dice_rolls", undefined, cid)).json.rolls;
  expect(rolls[rolls.length - 1].look).toEqual({ body: "#1e7a4c", ink: "#fff6d8", tex: "wood" });
  // back to the theme's dice
  expect((await api(page, "prefs_save", { dice_look: null })).json.prefs.dice_look).toBeUndefined();
  rolls = (await api(page, "dice_rolls", undefined, cid)).json.rolls;
  expect(rolls[rolls.length - 1].look).toBeNull();
});
