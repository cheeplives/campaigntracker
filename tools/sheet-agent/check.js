#!/usr/bin/env node
/* check.js — would db/starter-templates take this file? The same rules as the starter test
 * (tests/browser/starter-templates.spec.js): the file name is the starter key, a name and a game, a valid layout
 * (SheetLayout.validate, which matches the server's), more than three fields, its source (title, owner, url), and
 * labels only, no rules text.
 *
 *   node tools/sheet-agent/check.js <template.json> [...more]
 *
 * Prints what is wrong with each file, and exits 1 if anything is. */
'use strict';
const fs = require('fs'), path = require('path');
const L = require('../../static/sheetlayout.js');

/** What is wrong with starter file $file, as sentences; none when it's fine. */
function check(file) {
  const out = [], base = path.basename(file);
  if (!/^[a-z0-9][a-z0-9-]{0,74}\.json$/.test(base)) out.push('the file name is the starter key: lower case letters, digits and dashes, 75 at most, then .json');
  let t;
  try {
    t = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [...out, `it isn't JSON: ${e.message}`];
  }
  if (!(typeof t.name === 'string' && t.name.trim() && t.name.length <= 150)) out.push('a name, 150 characters at most');
  if (!(typeof t.game === 'string' && t.game.trim() && t.game.length <= 100)) out.push('a game, 100 characters at most');
  if (t.edition !== undefined && t.edition !== null && typeof t.edition !== 'string') out.push('the edition is text');
  const s = t.source;
  if (!(s && typeof s.title === 'string' && s.title.trim() && typeof s.owner === 'string' && s.owner.trim() && /^https?:\/\//.test(s.url || '')))
    out.push('a source: { title, owner, url } for the sheet it was built from');
  if (!t.layout || typeof t.layout !== 'object') return [...out, 'a layout: { sections: [...] }'];
  out.push(...L.validate(t.layout));
  const fields = L.fields(t.layout);
  if (fields.size <= 3) out.push('more than three fields');
  for (const [, { field }] of fields) if (typeof field.label === 'string' && field.label.length > 60) out.push(`"${field.label.slice(0, 40)}…": a label, not rules text (60 characters at most)`);
  return out;
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/sheet-agent/check.js <template.json> [...more]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const wrong = check(f);
    if (wrong.length) bad++;
    console.log(wrong.length ? `${f}:\n${wrong.map(w => `  - ${w}`).join('\n')}` : `${f}: ok`);
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { check };
