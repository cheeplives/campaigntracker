// Drafting a sheet template from a PDF in the browser: pdf.js reads a fillable PDF's form fields (or a flat sheet's
// text) and the PDF itself never leaves the page. A scan, with nothing to read, and a file that isn't a PDF each say
// what to do instead.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { person, signIn, approve, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const SUPPORT = path.join(__dirname, "..", "support");

/** Sign in, and record the body of every request the page sends from here on. */
async function ready(page, browser, name) {
  const who = person(name);
  await signIn(page, who);
  await approve(browser, who.email);
  await page.goto("./");
  await page.waitForFunction(() => window.PdfImport && window.SheetLayout);
  const bodies = [];
  page.on("request", r => bodies.push(r.postDataBuffer() ? r.postDataBuffer().toString("latin1") : ""));
  return bodies;
}

/** Hand $file to PdfImport.read through a file input, as the import button does; its layout, or the error's message. */
async function read(page, file) {
  await page.evaluate(() => {
    const input = Object.assign(document.createElement("input"), { type: "file", id: "pdf-test-input" });
    document.body.append(input);
  });
  await page.setInputFiles("#pdf-test-input", file);
  return page.evaluate(async () => {
    try {
      const r = await PdfImport.read(document.getElementById("pdf-test-input").files[0]);
      const out = { from: r.from, pages: r.pages, labels: r.layout.sections.flatMap(s => s.fields.map(f => [f.label, f.type])) };
      PdfImport.close(r.doc);
      return out;
    } catch (e) { return { error: e.message }; }
  });
}

test("Import: a fillable PDF drafts a template, and the PDF never leaves the browser", async ({ page, browser }) => {
  const bodies = await ready(page, browser, "Ivy");
  const r = await read(page, path.join(SUPPORT, "fillable-sheet.pdf"));
  expect(r.from).toBe("fields");
  expect(r.pages).toBe(1);
  expect(r.labels).toEqual(expect.arrayContaining([["STR", "number"], ["Athletics", "checkbox"], ["CharacterName", "text"]]));
  expect(bodies.some(b => b.includes("%PDF"))).toBe(false);
  expect(await page.evaluate(() => PdfImport.NOTICE)).toBe("This PDF stays on your device. It isn't uploaded or saved, and it's gone when you close the editor.");
});

test("Import: a scan says what to do", async ({ page, browser }) => {
  await ready(page, browser, "Jory");
  expect(await read(page, path.join(SUPPORT, "blank-scan.pdf")))
    .toEqual({ error: "No form fields or text found in this PDF. Start from a blank template, or fork one from the library." });
});

test("Import: a .txt renamed .pdf", async ({ page, browser }) => {
  await ready(page, browser, "Kit");
  expect(await read(page, { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("Just some notes, not a PDF.\n") }))
    .toEqual({ error: "That file isn't a PDF." });
});
