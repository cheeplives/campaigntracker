// Drafting a sheet template from a PDF in the editor: pdf.js reads a fillable PDF's form fields (or a flat sheet's
// text) in the browser, the editor shows the PDF's pages beside the draft under a notice that it isn't kept, and the
// PDF itself never leaves the page. A scan, with nothing to read, and a file that isn't a PDF each say what to do.
const { test, expect } = require("@playwright/test");
const path = require("path");
const { person, signIn, approve, closeContexts } = require("./helpers");
test.afterEach(closeContexts);

const SUPPORT = path.join(__dirname, "..", "support");
const NOTICE = "This PDF stays on your device. It isn't uploaded or saved, and it's gone when you close the editor.";

/** Sign in, open a new template, and record the body of every request the page sends from here on. */
async function editor(page, browser, name) {
  const who = person(name);
  await signIn(page, who);
  await approve(browser, who.email);
  await page.goto("index.html#/templates/new");
  await expect(page.getByLabel("Template name")).toBeVisible();
  const bodies = [];
  page.on("request", r => bodies.push(r.postDataBuffer() ? r.postDataBuffer().toString("latin1") : ""));
  return bodies;
}
const labels = page => page.locator(".sheet-ed-field input[aria-label='Field label']").evaluateAll(els => els.map(e => e.value));

test("Import: a fillable PDF drafts a template, and the PDF never leaves the browser", async ({ page, browser }) => {
  const bodies = await editor(page, browser, "Ivy");
  await expect(page.getByText(NOTICE).first()).toBeVisible();
  await page.getByLabel("Import from PDF").setInputFiles(path.join(SUPPORT, "fillable-sheet.pdf"));
  await expect.poll(() => labels(page)).toEqual(expect.arrayContaining(["STR", "Athletics", "CharacterName"]));
  await expect(page.locator(".sheet-pdf canvas")).toHaveCount(1);
  await expect(page.locator(".sheet-pdf")).toContainText(NOTICE);
  await page.getByLabel("Template name").fill("From a PDF");
  await page.getByLabel("Game", { exact: true }).fill("Test RPG");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page).toHaveURL(/#\/templates\/\d+$/);
  expect(bodies.some(b => b.includes("From a PDF"))).toBe(true);
  expect(bodies.some(b => b.includes("%PDF"))).toBe(false);
});

test("Import: a scan says what to do", async ({ page, browser }) => {
  await editor(page, browser, "Jory");
  await page.getByLabel("Import from PDF").setInputFiles(path.join(SUPPORT, "blank-scan.pdf"));
  await expect(page.locator("#toast")).toHaveText("No form fields or text found in this PDF. Start from a blank template, or fork one from the library.");
  expect(await labels(page)).toEqual([]);
  await expect(page.locator(".sheet-pdf")).toHaveCount(0);
});

test("Import: a .txt renamed .pdf", async ({ page, browser }) => {
  await editor(page, browser, "Kit");
  await page.getByLabel("Import from PDF").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("Just some notes, not a PDF.\n") });
  await expect(page.locator("#toast")).toHaveText("That file isn't a PDF.");
});
