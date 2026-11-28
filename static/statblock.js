/* statblock.js — an NPC stat block drawn from a stat block template's layout (a sheet template with kind 'statblock').
 *
 * Plain script, no build step. A stat block's layout is an ordinary sheet layout (static/sheetlayout.js); what makes it
 * read like a game's own NPC write-up is how its sections are drawn here:
 *
 *   a compact section       a run of short "Label value" pairs on one line that wraps (AC, HP, Speed)
 *   an abilities section    its fields in a row of columns, the label over the value; with modifier: 'dnd' a score
 *                           shows the modifier it gives, "16 (+3)", and it is the modifier that is rolled
 *   a list alone in its     the section's title as a small rule (Actions), then a paragraph a row, led by the row's
 *   section                 first cell in bold
 *   any other field         a paragraph led by its label in bold
 *
 * A text field marked summary goes in the line under the name. Empty fields, empty lists and sections with nothing in
 * them are left out, except the tracks (counters and pips) for whoever can change them, so hit points can be set.
 *
 *   StatBlock.render(layout, values, opts) -> element
 *     opts: { name, sub: text after the summary line (the template's name), can: may change the tracks,
 *             send(key, value): a track changed, rollOf(field, value): what a field's value rolls (Sheets.rollOf),
 *             roll(x): roll { kind: 'num' | 'dice', value, label }, or null for nobody rolls, caps: { key: pips } }
 *   StatBlock.empty(layout, values) -> true when nothing is filled in
 *   StatBlock.mod(score)            -> the modifier a D&D score gives, as text: "+3", "+0", "−1"
 */
'use strict';

const StatBlock = (() => {
  const { el } = KIT;
  const blank = v => v === null || v === undefined || v === '' || v === false
    || (Array.isArray(v) && !v.some(r => r && Object.values(r).some(c => String(c ?? '').trim() !== '')))
    || (typeof v === 'object' && !Array.isArray(v) && (v.cur ?? null) === null && (v.max ?? null) === null);
  const filled = (f, values) => !blank(values?.[f.key]) && !(f.type === 'pips' && !values[f.key]);
  const isTrack = f => f.type === 'counter' || f.type === 'pips' || (f.type === 'checkbox' && f.play);
  const signed = n => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);
  const mod = score => signed(Math.floor((Number(score) - 10) / 2));

  function empty(layout, values) {
    return !(layout?.sections || []).some(s => (s.fields || []).some(f => filled(f, values)));
  }

  // dice ("1d8+3"), and in a list's cells a bonus ("+5") or a chance ("45%"), written in a bit of text
  const DICE = /\d*d(?:\d+|%)(?:\s*[+\-−]\s*\d+(?![\w%]))*/gi;
  const BONUS = /(?<![\w)])[+\-−]\d+(?![\w%])|\b\d{1,3}%/g;

  function render(layout, values = {}, opts = {}) {
    const can = !!opts.can, roll = opts.roll || null, caps = opts.caps || {};
    /** A value that rolls: a button reading as the value itself. */
    const rollBtn = (text, x, label) => el('button', { type: 'button', class: 'link sb-roll', 'aria-label': `Roll ${label}: ${text}`, 'data-tip': `Roll ${label} on the dice roller`,
      onclick: () => roll({ ...x, label }) }, text);
    /** Text with the dice in it (and, in a list's cell, the bonuses and chances) made into rolls. */
    function rolling(text, label, cell = false) {
      const s = String(text ?? '');
      if (!roll || typeof Dice === 'undefined') return [s];
      const hits = [];
      for (const m of s.matchAll(DICE)) { const d = Dice.find(m[0]); if (d) hits.push({ at: m.index, len: m[0].length, x: { kind: 'dice', value: d } }); }
      if (cell) for (const m of s.matchAll(BONUS)) {
        if (hits.some(h => m.index >= h.at && m.index < h.at + h.len)) continue;
        hits.push({ at: m.index, len: m[0].length, x: { kind: 'num', value: Number(m[0].replace('−', '-').replace('%', '')) } });
      }
      hits.sort((a, b) => a.at - b.at);
      const out = [];
      let from = 0;
      for (const h of hits) {
        if (h.at < from) continue;
        if (h.at > from) out.push(s.slice(from, h.at));
        out.push(rollBtn(s.slice(h.at, h.at + h.len), h.x, label));
        from = h.at + h.len;
      }
      if (from < s.length) out.push(s.slice(from));
      return out;
    }

    /** A counter: the number now in a box for whoever can change it, then "/ most". */
    function counter(f) {
      const v = values[f.key] || {};
      if (!can) return el('span', {}, `${v.cur ?? '–'}${(v.max ?? null) !== null ? ` / ${v.max}` : ''}`);
      const cur = el('input', { type: 'number', inputmode: 'numeric', class: 'sb-cur', value: v.cur ?? '', 'aria-label': `${f.label} now` });
      cur.addEventListener('change', () => {
        const now = cur.value === '' || !Number.isFinite(Number(cur.value)) ? null : Number(cur.value);
        values[f.key] = { cur: now, max: (values[f.key] || {}).max ?? null };
        opts.send?.(f.key, values[f.key]);
      });
      return el('span', { class: 'sb-track' }, cur, (v.max ?? null) !== null ? el('span', {}, `/ ${v.max}`) : null);
    }
    /** Pips: the dots, ticked by whoever can change them. */
    function pips(f) {
      const n = f.count, most = Math.min(n, caps[f.key] ?? n);
      let on = Math.min(Number(values[f.key]) || 0, most);
      const box = el('span', { class: 'sheet-pips sb-pips', role: 'group', 'aria-label': f.label });
      const draw = () => box.replaceChildren(...Array.from({ length: most }, (_, i) => el('button', { type: 'button', class: 'sheet-pip' + (i < on ? ' on' : ''),
        'aria-label': `${f.label} ${i + 1}`, 'aria-pressed': String(i < on), disabled: !can,
        onclick: () => { on = on === i + 1 ? i : i + 1; values[f.key] = on; draw(); opts.send?.(f.key, on); } })));
      draw();
      return box;
    }
    /** A tick box kept at the table (Shaken): a toggle for whoever can change it. */
    function toggle(f) {
      const b = el('button', { type: 'button', class: 'small sb-toggle' + (values[f.key] ? ' on' : ''), 'aria-pressed': String(!!values[f.key]),
        onclick: () => { values[f.key] = !values[f.key]; b.setAttribute('aria-pressed', String(!!values[f.key])); b.classList.toggle('on', !!values[f.key]); opts.send?.(f.key, !!values[f.key]); } }, f.label);
      return b;
    }
    /** A field's value as it reads in a line. */
    function value(f, sec) {
      const v = values[f.key];
      if (f.type === 'counter') return counter(f);
      if (f.type === 'pips') return pips(f);
      if (f.type === 'number') {
        const text = sec.modifier === 'dnd' && !blank(v) ? `${v} (${mod(v)})` : String(v ?? '–');
        const x = blank(v) || !roll ? null : sec.modifier === 'dnd' ? { kind: 'num', value: Math.floor((Number(v) - 10) / 2) } : opts.rollOf?.(f, v);
        return x ? rollBtn(text, x, f.label) : el('span', {}, text);
      }
      // a bonus or a chance in a short line of text rolls too (Skills: Athletics +5)
      return el('span', {}, rolling(v ?? '–', f.label, f.type === 'text'));
    }
    const shown = f => !f.summary && (filled(f, values) || (can && isTrack(f)));

    const parts = [];
    for (const sec of layout?.sections || []) {
      if (sec.holdings) continue;
      const fields = (sec.fields || []).filter(shown);
      if (!fields.length) continue;
      if (sec.abilities) {
        // every score of the row shows once one is filled in, so the columns keep their places
        const all = sec.fields.filter(f => !f.summary);
        // seven or more go on two rows (Call of Cthulhu's eight characteristics, four and four)
        const n = Math.min(6, all.length > 6 ? Math.ceil(all.length / 2) : all.length);
        parts.push(el('div', { class: `sb-abil sb-n${n}` },
          all.map(f => el('div', {}, el('b', {}, f.label), value(f, sec)))));
        continue;
      }
      if (sec.compact) {
        parts.push(el('div', { class: 'sb-kv' }, fields.map(f => (f.type === 'checkbox'
          ? (can && f.play ? toggle(f) : el('span', {}, el('b', {}, f.label)))
          : el('span', { class: isTrack(f) ? 'sb-pair sb-has-track' : 'sb-pair' }, el('b', {}, f.label), ' ', value(f, sec))))));
        continue;
      }
      const alone = sec.fields.length === 1 && sec.fields[0].type === 'list';
      if (alone) parts.push(el('h4', { class: 'sb-sec' }, sec.title));
      for (const f of fields) {
        if (f.type === 'list') {
          const cols = f.columns || [];
          const rows = (values[f.key] || []).filter(r => r && cols.some(c => String(r[c.key] ?? '').trim() !== ''));
          if (!alone) parts.push(el('p', { class: 'sb-p' }, el('b', {}, `${f.label}.`)));
          for (const r of rows) {
            const name = String(r[cols[0].key] ?? '').trim();
            const rest = cols.slice(1).map(c => [c, String(r[c.key] ?? '').trim()]).filter(([, t]) => t !== '');
            parts.push(el('p', { class: 'sb-p sb-row' },
              cols.length > 1 ? el('b', {}, `${name || '–'}.`) : rolling(name, f.label, true),
              rest.flatMap(([c, t], i) => [i ? ', ' : ' ', ...rolling(t, `${name || f.label} ${c.label.toLowerCase()}`, true)])));
          }
        } else if (f.type === 'checkbox') parts.push(el('p', { class: 'sb-p' }, can && f.play ? toggle(f) : el('b', {}, f.label)));
        else if (isTrack(f)) parts.push(el('p', { class: 'sb-p sb-has-track' }, el('b', {}, f.label), ' ', value(f, sec)));
        else parts.push(el('p', { class: 'sb-p' + (f.type === 'longtext' ? ' sb-long' : '') }, el('b', {}, `${f.label}.`), ' ', ...rolling(values[f.key], f.label, f.type === 'text')));
      }
    }
    // rules between the runs of pairs and the rows of scores, as a printed stat block has them
    const body = [];
    parts.forEach((p, i) => {
      const lined = n => n && (n.classList.contains('sb-kv') || n.classList.contains('sb-abil'));
      if (i && (lined(p) || lined(parts[i - 1])) && !p.classList.contains('sb-sec')) body.push(el('div', { class: 'sb-rule' }));
      body.push(p);
    });
    const summary = (layout?.sections || []).flatMap(s => s.fields || []).filter(f => f.summary && filled(f, values) && typeof values[f.key] !== 'object').map(f => String(values[f.key]));
    const sub = [summary.join(', '), opts.sub].filter(Boolean).join(' · ');
    return el('div', { class: 'statblock' },
      opts.name ? el('h3', { class: 'sb-name' }, opts.name) : null,
      sub ? el('div', { class: 'sb-sub' }, sub) : null,
      body.length ? body : el('p', { class: 'muted small sb-blank' }, 'Nothing is filled in yet.'));
  }

  return { render, empty, mod };
})();
