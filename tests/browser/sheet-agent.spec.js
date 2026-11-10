// The sheet agent's scripts (tools/sheet-agent), run under Node: reading a PDF's fields, text and geometry, drawing
// a template at desktop and iPad widths, and checking a starter file. They start their own browser, so they run
// once, in the chromium project.
const { test, expect } = require("@playwright/test");
const fs = require("fs"), os = require("os"), path = require("path");
const TOOLS = path.join(__dirname, "..", "..", "tools", "sheet-agent");
const { width, rows, gutters, extract } = require(path.join(TOOLS, "extract.js"));
const { preview } = require(path.join(TOOLS, "preview.js"));
const { check } = require(path.join(TOOLS, "check.js"));
const SUPPORT = path.join(__dirname, "..", "support");
const STARTERS = path.join(__dirname, "..", "..", "db", "starter-templates");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sheet-agent-"));
const box = (name, x0, y0, x1, y1) => ({ name, rect: [x0, y0, x1, y1] });

test("a box's width on the page becomes half-columns, with a size name where one fits", () => {
  expect(width(51, 612)).toEqual({ cols: 1, size: "small" });
  expect(width(102, 612)).toEqual({ cols: 2, size: "medium" });
  expect(width(153, 612)).toEqual({ cols: 3 });
  expect(width(204, 612)).toEqual({ cols: 4, size: "large" });
  expect(width(560, 612)).toEqual({ cols: 11, size: "full" });
  expect(width(2, 612)).toEqual({ cols: 1, size: "small" });
});

test("fields at the same height are a row, read top to bottom and left to right", () => {
  const f = [box("b", 200, 700, 300, 718), box("a", 50, 701, 150, 719), box("c", 50, 650, 150, 668)];
  expect(rows(f).map(r => r.map(i => f[i].name))).toEqual([["a", "b"], ["c"]]);
});

test("a clear gap down the middle of the page is a gutter between columns", () => {
  const two = [];
  for (let i = 0; i < 4; i++) two.push(box(`l${i}`, 40, 700 - i * 30, 280, 718 - i * 30), box(`r${i}`, 330, 700 - i * 30, 570, 718 - i * 30));
  const g = gutters(two, 612);
  expect(g).toHaveLength(1);
  expect(g[0]).toBeGreaterThan(280);
  expect(g[0]).toBeLessThan(330);
  // one field across the page closes it
  expect(gutters([...two, box("wide", 40, 500, 570, 518)], 612)).toEqual([]);
});

test("Agent: extract reads a fillable PDF's fields, text and pages, with the editor's draft", async ({}, info) => {
  test.skip(info.project.name !== "chromium", "the scripts start their own browser");
  const out = tmp();
  const x = await extract(path.join(SUPPORT, "fillable-sheet.pdf"), out);
  expect(x.pages).toHaveLength(1);
  const p = x.pages[0];
  expect([p.width, p.height]).toEqual([612, 792]);
  expect(p.fields.map(f => f.name)).toEqual(expect.arrayContaining(["CharacterName", "STR", "Check Box 12"]));
  expect(p.fields.find(f => f.name === "CharacterName")).toMatchObject({ type: "text", cols: 4, size: "large" });
  expect(p.headings.map(h => h.str)).toContain("Abilities");
  expect(x.from).toBe("fields");
  expect(x.draft.sections.length).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(out, p.image)).subarray(1, 4).toString()).toBe("PNG");
  expect(JSON.parse(fs.readFileSync(path.join(out, "extract.json"), "utf8")).pages[0].rows.length).toBe(p.rows.length);
});

test("Agent: preview draws each page of a template at desktop and iPad widths and finds nothing wrong with a starter", async ({}, info) => {
  test.skip(info.project.name !== "chromium", "the scripts start their own browser");
  const out = tmp();
  const { shots, problems } = await preview(path.join(STARTERS, "dnd-5e-2024.json"), out);
  // the 2024 starter has two pages, each drawn at both widths
  expect(shots.map(s => `${s.width} ${s.page}`).sort()).toEqual(["1280 Character", "1280 Spells & Gear", "820 Character", "820 Spells & Gear"]);
  for (const s of shots) expect(fs.existsSync(path.join(out, s.image))).toBe(true);
  expect(problems).toEqual([]);
});

test("Agent: preview takes a picture of each page of a template with pages", async ({}, info) => {
  test.skip(info.project.name !== "chromium", "the scripts start their own browser");
  const out = tmp(), file = path.join(out, "wide.json");
  fs.writeFileSync(file, JSON.stringify({ sections: [
    { key: "a", title: "A", page: "Front", fields: [{ key: "n", label: "Name", type: "text" }] },
    { key: "b", title: "B", page: "Back", fields: [{ key: "w", label: "W", type: "text" }] },
  ] }));
  const { shots } = await preview(file, out, [800]);
  expect(shots.map(s => s.page)).toEqual(["Front", "Back"]);
});

test("Agent: preview finds boxes in a row line up when one label wraps to two lines", async ({}, info) => {
  test.skip(info.project.name !== "chromium", "the scripts start their own browser");
  const out = tmp(), file = path.join(out, "wrap.json");
  fs.writeFileSync(file, JSON.stringify({ sections: [{ key: "h", title: "Health", fields: [
    { key: "luck", label: "Luck", type: "counter", cols: 3 },
    { key: "sw", label: "Seriously Wounded (-2 to all actions)", type: "number", cols: 3 },
    { key: "ds", label: "Death Save", type: "number", cols: 3 },
  ] }] }));
  const { problems } = await preview(file, out, [820]);
  expect(problems).toEqual([]);
});

test("Agent: check passes every starter file, and names what's wrong with a bad one", () => {
  for (const f of fs.readdirSync(STARTERS).filter(f => f.endsWith(".json"))) expect(check(path.join(STARTERS, f)), f).toEqual([]);
  const out = tmp(), bad = path.join(out, "Bad Name.json");
  fs.writeFileSync(bad, JSON.stringify({ name: "", game: "X", layout: { sections: [{ key: "a", title: "A", fields: [
    { key: "n", label: "This is a very long label that is really a sentence of rules text, not a label", type: "text", cols: 20 }] }] } }));
  const wrong = check(bad).join("\n");
  expect(wrong).toMatch(/file name/);
  expect(wrong).toMatch(/a name/);
  expect(wrong).toMatch(/a source/);
  expect(wrong).toMatch(/half-columns/);
  expect(wrong).toMatch(/more than three fields/);
  expect(wrong).toMatch(/not rules text/);
});

test("Agent: a table's short columns are narrow by their label, its names and notes are not, and a column's own width wins", () => {
  const L = require(path.join(TOOLS, "..", "..", "static", "sheetlayout.js"));
  const w = labels => L.columnWidths(labels.map((label, i) => (typeof label === "string" ? { key: `c${i}`, label } : { key: `c${i}`, ...label })));
  expect(w(["Item", "Weight", "Uses"])).toEqual(["normal", "narrow", "narrow"]);
  expect(w(["Weapon", "Dmg.", "Range", "Notes"])).toEqual(["normal", "narrow", "narrow", "normal"]);
  expect(w(["Skill", "%", "Attack Bonus", "Weight (kg)", "AP", "Progress (0-3)"])).toEqual(["normal", "narrow", "narrow", "narrow", "narrow", "narrow"]);
  // a name, a description or a long label stays normal, even with a number word in it
  expect(w(["Spell Name", "Range/Area of Effect", "Damage & Type", "Spec 1", "I'm a…"])).toEqual(["normal", "normal", "normal", "normal", "normal"]);
  // every column narrow: the first names the row
  expect(w(["Ammunition", "Count"])).toEqual(["normal", "narrow"]);
  // the template's own width wins over the label
  expect(w([{ label: "Level", width: "normal" }, "Wounds", { label: "Head", width: "narrow" }, { label: "Notes", width: "wide" }])).toEqual(["normal", "narrow", "narrow", "wide"]);
  expect(L.validate({ sections: [{ key: "s", title: "S", fields: [{ key: "l", label: "L", type: "list", columns: [{ key: "a", label: "A", width: "tiny" }] }] }] }).join(" ")).toMatch(/narrow, normal or wide/);
});

test("Agent: a sheet draws a table's name column wider than its narrow Weight and Uses, at desktop and iPad widths", async () => {
  const { browser, serve } = require(path.join(TOOLS, "lib.js"));
  const site = await serve(), b = await browser();
  try {
    const layout = { sections: [{ key: "g", title: "Gear", width: "third", fields: [{ key: "gear", label: "Gear", type: "list",
      columns: [{ key: "item", label: "Item" }, { key: "weight", label: "Weight" }, { key: "uses", label: "Uses" }] }] }] };
    for (const w of [1280, 1180, 820]) {
      const page = await b.newPage({ viewport: { width: w, height: 900 } });
      await page.goto(`${site.url}/tools/sheet-agent/blank.html`);
      for (const s of ["kit.js", "discpic.js", "sheetlayout.js", "sheetimport.js", "pdfimport.js", "sheets.js"]) await page.addScriptTag({ url: `/static/${s}` });
      await page.addScriptTag({ content: `document.getElementById('app').append(Sheets.renderSheetForm(${JSON.stringify(layout)}, { gear: [{ item: "Sword", weight: "1" }] }, { mode: 'edit' }));` });
      const box = async c => (await page.getByLabel(`Gear row 1 ${c}`).boundingBox()).width;
      const [item, weight, uses] = [await box("Item"), await box("Weight"), await box("Uses")];
      expect(item, `${w}px`).toBeGreaterThan(weight * 1.3);
      expect(item, `${w}px`).toBeGreaterThan(uses * 1.3);
      await page.close();
    }
  } finally {
    await b.close();
    await site.close();
  }
});
