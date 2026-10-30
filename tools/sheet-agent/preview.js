#!/usr/bin/env node
/* preview.js — draw a template the way a character's sheet draws it (Sheets.renderSheetForm, with the site's CSS),
 * take a picture of each page of it at desktop and phone widths, and say what looks wrong: a page wider than the
 * screen, a box narrower than its label, or a label cut short.
 *
 *   node tools/sheet-agent/preview.js <template.json> <out-dir> [--widths 1200,390]
 *
 * <template.json> is a starter file ({ name, game, layout, ... }) or a bare layout ({ sections }). Writes
 * <out-dir>/preview-<width>-<page>.png and <out-dir>/preview.json, and prints the problems. */
'use strict';
const fs = require('fs'), path = require('path');
const { browser, serve, args } = require('./lib');

const SCRIPTS = ['kit.js', 'sheetlayout.js', 'sheetimport.js', 'pdfimport.js', 'sheets.js'];

async function preview(file, outDir, widths = [1200, 390]) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const layout = t.layout || t;
  const site = await serve();
  const b = await browser();
  const shots = [], problems = [];
  try {
    for (const w of widths) {
      const page = await b.newPage({ viewport: { width: w, height: 900 } });
      await page.goto(`${site.url}/tools/sheet-agent/blank.html`);
      for (const s of SCRIPTS) await page.addScriptTag({ url: `/static/${s}` });
      // Sheets is a script-level const, not a window property, so the drawing runs as a script too
      await page.addScriptTag({ content: `document.getElementById('app').append(Sheets.renderSheetForm(${JSON.stringify(layout)}, {}, { mode: 'preview' }));` });
      const tabs = page.locator('.sheet-tabs [role="tab"]');
      const names = (await tabs.count()) ? await tabs.allTextContents() : [''];
      for (let i = 0; i < names.length; i++) {
        if (names[i]) await tabs.nth(i).click();
        const shot = `preview-${w}-${i + 1}.png`;
        await page.screenshot({ path: path.join(outDir, shot), fullPage: true });
        shots.push({ width: w, page: names[i] || null, image: shot });
        const where = `${w}px${names[i] ? `, page "${names[i]}"` : ''}`;
        const found = await page.evaluate(() => {
          const out = [];
          if (document.documentElement.scrollWidth > window.innerWidth) out.push(`the sheet is ${document.documentElement.scrollWidth}px wide, wider than the screen`);
          for (const f of document.querySelectorAll('.sheet-sec:not([hidden]) .sheet-field')) {
            const label = f.querySelector('.sheet-label span');
            if (label && label.scrollWidth > label.clientWidth + 1) out.push(`the label "${label.textContent}" is cut short`);
            if (f.getBoundingClientRect().right > window.innerWidth + 1) out.push(`the box for "${label?.textContent}" runs off the screen`);
          }
          return out;
        });
        problems.push(...found.map(p => `${where}: ${p}`));
      }
      await page.close();
    }
    fs.writeFileSync(path.join(outDir, 'preview.json'), JSON.stringify({ template: path.basename(file), shots, problems }, null, 1));
    return { shots, problems };
  } finally {
    await b.close();
    await site.close();
  }
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  if (a._.length !== 2) {
    console.error('usage: node tools/sheet-agent/preview.js <template.json> <out-dir> [--widths 1200,390]');
    process.exit(2);
  }
  fs.mkdirSync(a._[1], { recursive: true });
  const widths = typeof a.widths === 'string' ? a.widths.split(',').map(Number).filter(n => n > 0) : undefined;
  preview(a._[0], a._[1], widths).then(({ shots, problems }) => {
    console.log(`${shots.length} picture(s) in ${a._[1]}.`);
    console.log(problems.length ? problems.map(p => `- ${p}`).join('\n') : 'Nothing looks wrong.');
  }).catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { preview };
