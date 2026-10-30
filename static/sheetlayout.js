/* sheetlayout.js — the rules of a character sheet template's layout, what each type of field may hold, and the draft
 * template made from a PDF.
 *
 * Plain script, no build step, and no page needed, so the same file runs under Node in the tests. A layout is
 * { sections: [{ key, title, fields: [{ key, label, type, play?, summary?, min?, max?, count?, options?, columns? }] }] };
 * keys are permanent (values are stored by key) and unique across a template's sections and fields together.
 * api/sheets.php checks the same rules and is the authority; these give the editor its messages and the drafts.
 * The drafts come from what static/pdfimport.js reads with pdf.js: a fillable PDF's form fields and the text near
 * them, or a flat PDF's lines of text. They're allowed to be imperfect: the editor is where they're tidied. */
'use strict';
(function (root) {
  const TYPES = ['text', 'longtext', 'number', 'counter', 'pips', 'checkbox', 'choice', 'list'];
  const LIMITS = { sections: 50, fields: 1000, label: 100, option: 60, options: 50, columns: 10, pips: 30, rows: 200, text: 500, longtext: 20000 };
  const KEY = /^[a-z][a-z0-9_]{0,39}$/;
  // how wide a field's box is on the sheet: small is half the usual, large twice it (long text and lists run the full width)
  const SIZES = ['small', 'medium', 'large'];

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const okLabel = s => typeof s === 'string' && s.trim().length >= 1 && s.length <= LIMITS.label;

  /** What is wrong with a layout, in plain words; [] when nothing is. */
  /** A field's optional mapping to a VTT's character data: { foundry: { system: 'dnd5e', path: 'system.attributes.hp.value' } }. */
  function okVtt(v) {
    if (!isObj(v) || Array.isArray(v) || Object.keys(v).length > 8) return false;
    return Object.entries(v).every(([name, m]) => /^[a-z][a-z0-9_]{0,19}$/.test(name) && isObj(m)
      && typeof m.system === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(m.system) && typeof m.path === 'string' && /^[A-Za-z0-9_.[\]-]{1,200}$/.test(m.path));
  }

  function validate(layout) {
    if (!isObj(layout) || !Array.isArray(layout.sections)) return ['A template needs a list of sections'];
    const out = [], keys = new Set();
    const key = (k, what) => {
      if (typeof k !== 'string' || !KEY.test(k)) out.push(`${what} has a key that isn't lower-case letters, digits and _ (starting with a letter, 40 at most): ${JSON.stringify(k)}`);
      else if (keys.has(k)) out.push(`The key "${k}" is used twice`);
      else keys.add(k);
    };
    if (layout.sections.length > LIMITS.sections) out.push(`A template can have ${LIMITS.sections} sections at most`);
    let n = 0;
    for (const s of layout.sections) {
      if (!isObj(s)) { out.push('A section is not a section'); continue; }
      key(s.key, `Section "${s.title}"`);
      if (!okLabel(s.title)) out.push(`Section titles are 1 to ${LIMITS.label} characters`);
      if (!Array.isArray(s.fields)) { out.push(`Section "${s.title}" needs a list of fields`); continue; }
      for (const f of s.fields) {
        n++;
        if (!isObj(f)) { out.push('A field is not a field'); continue; }
        const name = `Field "${f.label}"`;
        key(f.key, name);
        if (!okLabel(f.label)) out.push(`Field labels are 1 to ${LIMITS.label} characters`);
        if (!TYPES.includes(f.type)) { out.push(`${name} has a type this app doesn't know: ${JSON.stringify(f.type)}`); continue; }
        if (f.type === 'pips' && !(Number.isInteger(f.count) && f.count >= 1 && f.count <= LIMITS.pips)) out.push(`${name} needs 1 to ${LIMITS.pips} pips`);
        if (f.type === 'choice' && !(Array.isArray(f.options) && f.options.length >= 1 && f.options.length <= LIMITS.options
          && f.options.every(o => typeof o === 'string' && o.trim() && o.length <= LIMITS.option))) out.push(`${name} needs 1 to ${LIMITS.options} options of ${LIMITS.option} characters at most`);
        if (f.type === 'list') {
          if (!(Array.isArray(f.columns) && f.columns.length >= 1 && f.columns.length <= LIMITS.columns)) out.push(`${name} needs 1 to ${LIMITS.columns} columns`);
          else {
            const ck = new Set();
            for (const c of f.columns) {
              if (!isObj(c) || typeof c.key !== 'string' || !KEY.test(c.key) || ck.has(c.key) || !okLabel(c.label)) out.push(`${name} has a column without a proper key and label`);
              else ck.add(c.key);
            }
          }
        }
        for (const b of ['min', 'max']) if (f[b] !== undefined && f[b] !== null && !Number.isFinite(f[b])) out.push(`${name}: ${b} must be a number`);
        if (f.size !== undefined && !SIZES.includes(f.size)) out.push(`${name}: a box size is small, medium or large`);
        if (f.vtt !== undefined && !okVtt(f.vtt)) out.push(`${name}: each VTT mapping needs a lower-case VTT name, a system and a data path (letters, digits, _ . - [ ])`);
      }
    }
    if (n > LIMITS.fields) out.push(`A template can have ${LIMITS.fields} fields at most`);
    return out;
  }

  /** A key made from a label: "Hit Points" → hit_points, then hit_points_2 when that is taken. */
  function newKey(label, taken = new Set()) {
    let base = String(label || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) {
      do base = 'f_' + Math.random().toString(36).slice(2, 6).padEnd(4, '0'); while (taken.has(base));
      return base;
    }
    if (!/^[a-z]/.test(base)) base = 'f_' + base;
    base = base.slice(0, 40).replace(/_+$/, '');
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const k = `${base.slice(0, 40 - String(i).length - 1)}_${i}`;
      if (!taken.has(k)) return k;
    }
  }

  /** Every field by key: Map key → { field, section }. */
  function fields(layout) {
    const m = new Map();
    for (const s of layout?.sections || []) for (const f of s.fields || []) m.set(f.key, { field: f, section: s });
    return m;
  }

  const num = v => {
    if (v === null || v === '' || v === undefined) return { ok: true, value: null };
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  };
  const NO = { ok: false };

  /** Whether a value fits a field of its type, and the value as stored. */
  function coerce(field, v) {
    switch (field?.type) {
      case 'text': case 'longtext': {
        if (v === null || v === undefined) return { ok: true, value: '' };
        if (typeof v !== 'string') return NO;
        return v.length <= LIMITS[field.type] ? { ok: true, value: v } : NO;
      }
      case 'number': return num(v);
      case 'counter': {
        if (!isObj(v)) return NO;
        const c = num(v.cur), m = num(v.max);
        return c.ok && m.ok ? { ok: true, value: { cur: c.value, max: m.value } } : NO;
      }
      case 'pips': return Number.isInteger(v) && v >= 0 && v <= field.count ? { ok: true, value: v } : NO;
      case 'checkbox': return typeof v === 'boolean' ? { ok: true, value: v } : NO;
      // one of its options, or a custom entry typed in its place
      case 'choice': return v === null || (typeof v === 'string' && v.length <= LIMITS.text) ? { ok: true, value: v } : NO;
      case 'list': {
        if (!Array.isArray(v) || v.length > LIMITS.rows) return NO;
        const cols = (field.columns || []).map(c => c.key), rows = [];
        for (const r of v) {
          if (!isObj(r)) return NO;
          const row = {};
          for (const k of cols) {
            if (r[k] === undefined || r[k] === null) continue;
            if (typeof r[k] !== 'string' && typeof r[k] !== 'number') return NO;
            const s = String(r[k]);
            if (s.length > LIMITS.text) return NO;
            row[k] = s;
          }
          rows.push(row);
        }
        return { ok: true, value: rows };
      }
      default: return NO;
    }
  }

  /** A character's values against its template's layout now: kept by key, and what no longer fits set aside. */
  function reconcile(layout, values) {
    const f = fields(layout), out = {}, old = [];
    for (const [k, v] of Object.entries(values || {})) {
      const c = f.has(k) ? coerce(f.get(k).field, v) : NO;
      if (c.ok) out[k] = c.value; else old.push({ key: k, value: v });
    }
    return { values: out, old };
  }

  /** The values someone may see: without hidden fields or the fields of hidden sections, unless they see it in full. */
  function visibleTo(layout, values, hidden, full) {
    if (full) return { ...values };
    const h = new Set(hidden || []), out = {};
    for (const s of layout?.sections || []) {
      if (h.has(s.key)) continue;
      for (const fl of s.fields || []) if (!h.has(fl.key) && Object.prototype.hasOwnProperty.call(values || {}, fl.key)) out[fl.key] = values[fl.key];
    }
    return out;
  }

  // ---- Drafts from a PDF ----

  // Form-field names a PDF maker gave automatically, which say nothing about what the field is.
  const JUNK = /^(check ?box|checkbox|text|text ?field|field|button|untitled|radio( ?button)?|group|dropdown|combo ?box|list ?box)?[\s._-]*[\d.\s_-]*$/i;
  const clip = s => String(s).replace(/\s+/g, ' ').trim().slice(0, LIMITS.label);

  /** A layout from a fillable PDF's form fields ({ name, type: text|checkbox|radio|choice, options?, page, rect }) and
   * the words on its pages ({ str, page, x, y }): a section per page, fields top to bottom, a junk-named field labelled
   * by the nearest words within 40 points. Short all-capital names (STR, DEX, HP) become numbers. */
  function draftFromFormFields(formFields, labels = []) {
    const pages = new Map(), seen = new Set();
    for (const f of formFields || []) {
      if (!f || seen.has(f.name)) continue;
      seen.add(f.name);
      if (!pages.has(f.page)) pages.set(f.page, []);
      pages.get(f.page).push(f);
    }
    const taken = new Set(), sections = [];
    let n = 0;
    for (const page of [...pages.keys()].sort((a, b) => a - b)) {
      if (sections.length >= LIMITS.sections) break;
      const title = `Page ${page}`, s = { key: newKey(title, taken), title, fields: [] };
      taken.add(s.key);
      const sorted = pages.get(page).sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
      for (const f of sorted) {
        if (n >= LIMITS.fields) break;
        const name = clip(String(f.name || '').split('.').pop());
        let label = name && !JUNK.test(name) ? name : '';
        if (!label) {
          const cx = (f.rect[0] + f.rect[2]) / 2, cy = (f.rect[1] + f.rect[3]) / 2;
          let best = null, bd = 40;
          for (const l of labels) {
            if (l.page !== page || !String(l.str).trim()) continue;
            const d = Math.hypot(l.x - cx, l.y - cy);
            if (d < bd) { bd = d; best = l; }
          }
          label = best ? clip(best.str) : '';
        }
        if (!label) label = name || `Field ${n + 1}`;
        const field = { key: newKey(label, taken), label };
        taken.add(field.key);
        const opts = (f.options || []).map(o => clip(o).slice(0, LIMITS.option)).filter(Boolean).slice(0, LIMITS.options);
        if (f.type === 'checkbox') field.type = 'checkbox';
        else if ((f.type === 'choice' || f.type === 'radio') && opts.length) Object.assign(field, { type: 'choice', options: [...new Set(opts)] });
        else if (f.type === 'radio') field.type = 'checkbox';
        else field.type = /^[A-Z]{2,4}$/.test(name) ? 'number' : 'text';
        s.fields.push(field);
        n++;
      }
      if (s.fields.length) sections.push(s);
    }
    return { sections };
  }

  /** A layout from a flat PDF's lines of text ({ str, page, x, y, h }): each short line a text field, a line 30% taller
   * than the page's usual one a section title, and long runs of words (rules text) left out. */
  function draftFromText(items) {
    const pages = new Map();
    for (const it of items || []) {
      const str = clip(String(it?.str || '').replace(/[:_.\s]+$/, ''));
      if (!str || !/\p{L}/u.test(str) || str.split(' ').length > 8 || str.length > 60) continue;
      if (!pages.has(it.page)) pages.set(it.page, []);
      pages.get(it.page).push({ ...it, str });
    }
    const taken = new Set(), sections = [];
    let n = 0;
    for (const page of [...pages.keys()].sort((a, b) => a - b)) {
      const list = pages.get(page).sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const hs = list.map(i => i.h || 0).sort((a, b) => a - b), median = hs[Math.floor(hs.length / 2)] || 0;
      let s = null;
      const open = title => { s = { key: newKey(title, taken), title, fields: [], labels: new Set() }; taken.add(s.key); sections.push(s); };
      open(`Page ${page}`);
      for (const it of list) {
        if (median && it.h >= median * 1.3) { open(it.str); continue; }
        if (n >= LIMITS.fields || s.labels.has(it.str.toLowerCase())) continue;
        s.labels.add(it.str.toLowerCase());
        const f = { key: newKey(it.str, taken), label: it.str, type: 'text' };
        taken.add(f.key);
        s.fields.push(f);
        n++;
      }
    }
    return { sections: sections.filter(s => s.fields.length).slice(0, LIMITS.sections).map(({ labels, ...s }) => s) };
  }

  const SheetLayout = { TYPES, LIMITS, validate, newKey, fields, coerce, reconcile, visibleTo, draftFromFormFields, draftFromText };
  if (typeof module !== 'undefined' && module.exports) module.exports = SheetLayout;
  else root.SheetLayout = SheetLayout;
})(typeof window !== 'undefined' ? window : globalThis);
