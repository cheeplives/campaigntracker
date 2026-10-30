#!/usr/bin/env node
/* extract.js — read a character sheet PDF for the sheet agent: each page's size, its form fields (with their boxes),
 * its text (with positions), a picture of the page, and hints from the geometry: which fields share a row, where a
 * page splits into columns, which text looks like a heading, and how wide each field's box would be on the sheet.
 * Also the editor's own first draft of a layout (SheetLayout.draftFromFormFields, or draftFromText for a flat PDF).
 *
 *   node tools/sheet-agent/extract.js <sheet.pdf> <out-dir> [--scale 1.5]
 *
 * Writes <out-dir>/extract.json and <out-dir>/page-<n>.png. pdf.js (static/vendor/pdfjs) does the reading, in a
 * headless browser, the same as the editor's Import from PDF. PDF coordinates are points from the page's bottom left. */
'use strict';
const fs = require('fs'), path = require('path');
const { browser, serve, args } = require('./lib');

const COLS = 12;

/** The width on the sheet for a box $w points wide on a page $pageW points wide: { cols, size? }, size when a named
 * size fits (small 1, medium 2, large 4, full 11 or more half-columns). */
function width(w, pageW) {
  const cols = Math.max(1, Math.min(COLS, Math.round((w / pageW) * COLS)));
  const size = cols >= 11 ? 'full' : { 1: 'small', 2: 'medium', 4: 'large' }[cols];
  return size ? { cols, size } : { cols };
}

/** $fields ({ rect: [x0, y0, x1, y1] }) grouped into rows, top to bottom, each left to right: arrays of indexes. */
function rows(fields) {
  const order = fields.map((f, i) => i).sort((a, b) => cy(fields[b]) - cy(fields[a]));
  const out = [];
  for (const i of order) {
    const row = out[out.length - 1];
    const tol = Math.max(3, 0.6 * Math.min(h(fields[i]), row ? h(fields[row[0]]) : Infinity));
    if (row && Math.abs(cy(fields[row[0]]) - cy(fields[i])) <= tol) row.push(i);
    else out.push([i]);
  }
  for (const row of out) row.sort((a, b) => fields[a].rect[0] - fields[b].rect[0]);
  return out;
}
const cy = f => (f.rect[1] + f.rect[3]) / 2, h = f => Math.abs(f.rect[3] - f.rect[1]);

/** Where a page of $pageW points splits into columns: the x of each clear gap, 12 points or wider, in the middle
 * 80% of the page that no field crosses, with at least a fifth of the fields on each side. */
function gutters(fields, pageW) {
  if (fields.length < 4) return [];
  const used = new Uint8Array(Math.ceil(pageW) + 1);
  for (const f of fields) for (let x = Math.max(0, Math.floor(f.rect[0])); x <= Math.min(used.length - 1, Math.ceil(f.rect[2])); x++) used[x] = 1;
  const out = [], lo = Math.floor(pageW * 0.1), hi = Math.ceil(pageW * 0.9), min = fields.length / 5;
  for (let x = lo; x < hi; x++) {
    if (used[x]) continue;
    let end = x;
    while (end + 1 < hi && !used[end + 1]) end++;
    const mid = (x + end) / 2;
    const left = fields.filter(f => f.rect[2] <= mid).length, right = fields.length - left;
    if (end - x + 1 >= 12 && left >= min && right >= min) out.push(Math.round(mid));
    x = end;
  }
  return out;
}

/** Text that looks like a heading: noticeably taller than the page's usual text. */
function headings(texts) {
  if (!texts.length) return [];
  const hs = texts.map(t => t.h).sort((a, b) => a - b), median = hs[Math.floor(hs.length / 2)];
  return texts.filter(t => t.h >= median * 1.3 && t.str.length <= 60).map(t => ({ str: t.str, x: t.x, y: t.y, h: t.h }));
}

/** The hints for one page as extract.json gives them. */
function hints(page) {
  const fields = page.fields.map(f => ({ ...f, ...width(f.rect[2] - f.rect[0], page.width), tall: h(f) > 40 }));
  return { ...page, fields, rows: rows(page.fields).map(r => r.map(i => page.fields[i].name)), gutters: gutters(page.fields, page.width), headings: headings(page.texts) };
}

async function extract(pdf, outDir, scale = 1.5) {
  const site = await serve({ '/__sheet.pdf': path.resolve(pdf) });
  const b = await browser();
  try {
    const page = await b.newPage();
    await page.goto(`${site.url}/tools/sheet-agent/blank.html`);
    await page.addScriptTag({ url: '/static/vendor/pdfjs/pdf.min.js' });
    await page.addScriptTag({ url: '/static/sheetlayout.js' });
    const read = await page.evaluate(async scale => {
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.js';
      const doc = await pdfjs.getDocument({ url: '/__sheet.pdf', isEvalSupported: false, enableXfa: false }).promise;
      const pages = [], all = [], allTexts = [], radios = new Map();
      for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n), vp = p.getViewport({ scale: 1 });
        const fields = [], texts = [];
        for (const a of await p.getAnnotations()) {
          if (a.subtype !== 'Widget' || !a.fieldName) continue;
          const base = { name: a.fieldName, page: n, rect: a.rect.map(v => Math.round(v * 10) / 10) };
          let f = null;
          if (a.fieldType === 'Tx') f = { ...base, type: 'text', multiline: !!a.multiLine };
          else if (a.fieldType === 'Btn' && a.checkBox) f = { ...base, type: 'checkbox' };
          else if (a.fieldType === 'Btn' && a.radioButton) f = { ...base, type: 'radio', options: a.buttonValue != null ? [String(a.buttonValue)] : [] };
          else if (a.fieldType === 'Ch') f = { ...base, type: 'choice', options: (a.options || []).map(o => o.displayValue ?? o.exportValue) };
          if (!f) continue;
          if (f.type === 'radio') {
            const g = radios.get(f.name);
            if (g) { g.options.push(...f.options); continue; }
            radios.set(f.name, f);
          }
          fields.push(f); all.push(f);
        }
        for (const it of (await p.getTextContent()).items) {
          const str = String(it.str || '').trim();
          if (!str) continue;
          const [, , c, d, x, y] = it.transform;
          const t = { str, page: n, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round((it.width || 0) * 10) / 10, h: Math.round((it.height || Math.hypot(c, d)) * 10) / 10 };
          texts.push(t); allTexts.push(t);
        }
        const view = p.getViewport({ scale }), canvas = document.createElement('canvas');
        canvas.width = Math.floor(view.width); canvas.height = Math.floor(view.height);
        await p.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        pages.push({ n, width: Math.round(vp.width), height: Math.round(vp.height), fields, texts, png: canvas.toDataURL('image/png').split(',')[1] });
        p.cleanup();
      }
      let draft = null, from = 'fields';
      if (all.length) draft = SheetLayout.draftFromFormFields(all, allTexts);
      if (!draft || !draft.sections.length) { draft = SheetLayout.draftFromText(allTexts); from = 'text'; }
      return { pages, draft, from };
    }, scale);
    fs.mkdirSync(outDir, { recursive: true });
    const pages = read.pages.map(({ png, ...p }) => {
      const image = `page-${p.n}.png`;
      fs.writeFileSync(path.join(outDir, image), Buffer.from(png, 'base64'));
      return { ...hints(p), image };
    });
    const out = { pdf: path.basename(pdf), pages, from: read.from, draft: read.draft };
    fs.writeFileSync(path.join(outDir, 'extract.json'), JSON.stringify(out, null, 1));
    return out;
  } finally {
    await b.close();
    await site.close();
  }
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  if (a._.length !== 2) {
    console.error('usage: node tools/sheet-agent/extract.js <sheet.pdf> <out-dir> [--scale 1.5]');
    process.exit(2);
  }
  extract(a._[0], a._[1], Number(a.scale) || 1.5).then(out => {
    const fields = out.pages.reduce((n, p) => n + p.fields.length, 0), texts = out.pages.reduce((n, p) => n + p.texts.length, 0);
    console.log(`${out.pages.length} page(s), ${fields} form field(s), ${texts} piece(s) of text; draft from ${out.from}: ` +
      `${out.draft.sections.length} section(s). Wrote ${path.join(a._[1], 'extract.json')} and the page pictures.`);
  }).catch(e => { console.error(e.message || e); process.exit(1); });
}

module.exports = { extract, width, rows, gutters, headings, hints };
