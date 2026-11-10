/* sheets.js — character sheet templates in the browser: the site-wide library (search, forks, Use), a template's
 * page, and the editor (sections and fields, dragged into order by mouse or touch, a live preview, and drafting from
 * a PDF that stays in the browser). renderSheetForm draws a sheet from a layout, for the preview here and for
 * characters' sheets.
 *
 * Plain script, no build step. app.js hands it what it needs once (Sheets.mount) and sends it the #/templates
 * routes (Sheets.route). The rules for a layout are SheetLayout's (static/sheetlayout.js), the same as the server's.
 * A PDF opened in the editor is read by PdfImport (static/pdfimport.js) and never uploaded; leaving the editor lets
 * go of it. */
'use strict';

const Sheets = (() => {
  const { el, toast, confirmDialog, promptDialog } = KIT;
  const L = SheetLayout, I = SheetImport;
  let ctx = null;
  /** app.js's helpers: { S, api, post, mount, field, campaignHeader, isGM, route }. */
  function mount(c) { ctx = c; }

  const TYPE_NAMES = { text: 'Text', longtext: 'Long text', number: 'Number', counter: 'Counter (current / max)', pips: 'Pips (dots or boxes)',
    checkbox: 'Checkbox', choice: 'Choice from a list', list: 'List (rows and columns)' };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** replaceChildren, leaving out the null and false kids (which it would print as text). */
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  const button = (label, onclick, cls, attrs = {}) => el('button', { type: 'button', class: cls || '', onclick, ...attrs }, label);

  // ------------------------------------------------------------ the PDF open in the editor
  let openDoc = null;
  function closePdf() {
    if (openDoc) PdfImport.close(openDoc);
    openDoc = null;
  }
  // leaving the editor lets go of the PDF: it was never saved, so it is gone
  window.addEventListener('hashchange', () => { if (!/^#\/templates\/(new|\d+\/edit)$/.test(location.hash)) closePdf(); });

  // ------------------------------------------------------------ rolling from a sheet
  // Numbers that are never rolled (an age, a level, coins, armour, hit points): no 🎲 beside them.
  const NOT_ROLLED = /\b(age|height|weight|size|siz|xp|exp|experience( points)?|level|lvl|rank|tier|gold|silver|copper|platinum|electrum|gp|sp|cp|pp|ep|coins?|money|cash|credits|wealth|speed|move(ment)?|run|armou?r( class| rating| bonus| penalty)?|ac|ar|defen[cs]e|hit points|hp|health|wounds|damage taken|temporary hp|encumbrance|load|year|years|total( spent)?|max( ranks)?|points?|spent|cost|ranks|dc|passive)\b/i;
  /** What a field holds that can be rolled: a number (not one of NOT_ROLLED), or dice written in its text. */
  function rollOf(f, value) {
    if (f.type === 'number' || f.type === 'pips') {
      if (NOT_ROLLED.test(f.label || '')) return undefined;          // never rolled: no button at all
      return value === null || value === undefined || value === '' ? null : { kind: 'num', value: Number(value) };
    }
    if (f.type === 'text' || f.type === 'choice') {
      const d = typeof Dice !== 'undefined' ? Dice.find(value) : null;
      return d ? { kind: 'dice', value: d } : null;
    }
    return undefined;
  }
  /** The 🎲 beside a field that rolls it: roll(x) gets { kind, value, label, field }. Text shows it only while it has
   * dice in it (it.update() checks again after a change). null for a field that is never rolled. */
  function rollButton(f, read, roll, label = f.label) {
    if (rollOf(f, read()) === undefined) return null;
    const b = button('🎲', () => {
      const x = rollOf(f, read());
      if (!x) return toast(`Fill in ${label} first`, true);
      roll({ ...x, label, field: f.label });
    }, 'icon-btn sheet-roll', { 'aria-label': `Roll ${label}`, 'data-tip': f.type === 'number' || f.type === 'pips' ? `Roll ${label} on the dice roller` : `Roll the dice in ${label}` });
    b.update = () => { if (f.type === 'text' || f.type === 'choice') b.hidden = !rollOf(f, read()); };
    b.update();
    return b;
  }

  // ------------------------------------------------------------ a sheet drawn from a layout
  /** A sheet: layout's sections and fields with values (by key). opts: { mode: 'edit'|'view'|'preview', hidden: keys
   * hidden from the party, canHide, onChange(key, value), onHide(key, hidden), onRoll(x), caps: { key: pips } the
   * character's own maximum on a dot/box track, onCap(key, n) }. 'view' can't be changed; 'preview' can be tried out
   * but saves nothing. With onRoll, numbers and dice on the sheet have a 🎲 that rolls them (rollButton). With onCap,
   * each track has a Max picker under it (Track maximums on a character's sheet). */
  function renderSheetForm(layout, values = {}, opts = {}) {
    const mode = opts.mode || 'preview', off = mode === 'view', live = mode === 'edit';
    const hidden = new Set(opts.hidden || []);
    const dice = new Map();   // the 🎲 of each field that has one
    const change = (k, v) => { values[k] = v; opts.onChange?.(k, v); dice.get(k)?.update(); };
    const roll = opts.onRoll || null;
    const caps = opts.caps || {};
    const eye = (key, what) => opts.canHide ? button(hidden.has(key) ? '🙈' : '👁', () => opts.onHide?.(key, !hidden.has(key)), 'icon-btn sheet-eye',
      { 'aria-pressed': String(hidden.has(key)), 'aria-label': hidden.has(key) ? `Show ${what} to the party` : `Hide ${what} from the party`,
        'data-tip': hidden.has(key) ? 'Hidden from the rest of the party. Tap to show it' : 'Seen by the party. Tap to hide it' }) : null;
    const slots = new Map();
    const sections = (layout?.sections || []).map(s => el('section', { class: 'sheet-sec' + (hidden.has(s.key) ? ' is-hidden' : '') + (s.compact ? ' compact' : '')
        + (s.width && s.width !== 'full' ? ` w-${s.width}` : ''), 'data-key': s.key },
      el('div', { class: 'sheet-sec-head' }, el('h3', {}, s.title || ''), eye(s.key, `the ${s.title} section`)),
      el('div', { class: 'sheet-fields' }, (s.fields || []).map(f => {
        if (!TYPE_NAMES[f.type]) return null;
        // its width in half-columns: medium is two, small one, large four, or the number the template gives; full is all
        const wide = f.type === 'longtext' || f.type === 'list' || f.size === 'full';
        const cols = wide ? null : Number.isInteger(f.cols) ? f.cols : { small: 1, large: 4 }[f.size] ?? null;
        // Track maximums: a Max picker under the track, in its box (a fourth row would break the sections' grid)
        const picker = f.type === 'pips' && opts.onCap ? capPicker(f, caps[f.key], n => opts.onCap(f.key, n)) : null;
        const slot = el('div', { class: 'sheet-control' }, control(f, values[f.key], v => change(f.key, v), off, live, roll, caps[f.key]), picker);
        const die = roll ? rollButton(f, () => values[f.key], roll) : null;
        if (die) dice.set(f.key, die);
        const note = el('div', { class: 'sheet-conflict', hidden: true });
        slots.set(f.key, { f, slot, note, picker });
        return el('div', { class: `sheet-field sheet-${f.type}` + (wide ? ' wide' : '') + (hidden.has(f.key) ? ' is-hidden' : ''), 'data-key': f.key, 'data-cols': cols },
          el('div', { class: 'sheet-label' }, el('span', {}, f.label), die, eye(f.key, f.label)), slot, note);
      }))));
    // pages: a tab for each, only the open one's sections shown
    const pages = L.pages(layout);
    let tabs = null;
    if (pages.length > 1) {
      const secOf = new Map((layout.sections || []).map((s, i) => [s, sections[i]]));
      let open = pages.find(p => p.name === opts.page) || pages[0];
      tabs = el('div', { class: 'seg sheet-tabs', role: 'tablist', 'aria-label': 'Pages' });
      const show = () => {
        tabs.replaceChildren(...pages.map(p => button(p.name, () => { open = p; opts.onPage?.(p.name); show(); }, p === open ? 'on' : '',
          { role: 'tab', 'aria-selected': String(p === open) })));
        for (const p of pages) for (const sec of p.sections) secOf.get(sec).hidden = p !== open;
      };
      show();
    }
    const form = el('div', { class: `sheet-form sheet-${mode}` }, tabs, el('div', { class: 'sheet-secs' }, sections));
    /** Show a value someone else saved, in place of what the field shows. */
    form.setValue = (key, v) => {
      const x = slots.get(key);
      if (!x) return;
      values[key] = v;
      x.note.hidden = true;
      fill(x.slot, control(x.f, v, nv => change(key, nv), off, live, roll, caps[key]), x.picker);
      dice.get(key)?.update();
    };
    /** Someone else changed a field this person is typing in: let them pick. */
    form.conflict = (key, v, by, send) => {
      const x = slots.get(key);
      if (!x) return;
      x.note.hidden = false;
      // theirs is sent too, as leaving the box to press this button sends what was typed
      x.note.replaceChildren(el('span', { class: 'small' }, `Changed by ${by}`),
        button('Use theirs', () => { form.setValue(key, v); send(v); }, 'small'),
        button('Keep mine', () => {
          x.note.hidden = true;
          const box = x.slot.querySelector('input, textarea, select');
          if (box) box.dispatchEvent(new Event('change')); else send(values[key]);
        }, 'small'));
    };
    /** Whether someone is typing in this field now. */
    form.typing = key => !!slots.get(key)?.slot.contains(document.activeElement);
    return form;
  }
  const numOrNull = s => (String(s).trim() === '' ? null : Number(s));
  const pipCount = f => Math.max(1, Math.min(L.LIMITS.pips, Number(f.count) || 1));
  /** How many of a track's pips this character has: its own maximum, or all of them. */
  const pipCap = (f, cap) => (Number.isInteger(cap) && cap >= 0 && cap < pipCount(f) ? cap : pipCount(f));
  /** Track maximums: how many of a dot/box track's pips this character has, from all of them down to none. */
  function capPicker(f, cap, set) {
    const n = pipCount(f), now = pipCap(f, cap);
    const s = el('select', { 'aria-label': `${f.label} maximum` }, Array.from({ length: n + 1 }, (_, i) => n - i).map(i =>
      el('option', { value: i, selected: i === now }, i === n ? `All ${n}` : String(i))));
    s.addEventListener('change', () => set(Number(s.value)));
    return el('label', { class: 'sheet-cap small' }, 'Max ', s, ` of ${n}`);
  }
  /** The input for one field, sending the new value to set(v) as it changes. */
  const CUSTOM = '__custom';
  function control(f, value, set, off, live, roll = null, cap = null) {
    const label = f.label;
    // while typing, the value is sent 400 ms after the last key, as well as on leaving the box
    const typed = (node, read) => {
      let t = 0;
      node.addEventListener('change', () => { clearTimeout(t); set(read()); });
      if (live) node.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set(read()), 400); });
    };
    if (f.type === 'text') {
      const i = el('input', { value: value ?? '', maxlength: L.LIMITS.text, 'aria-label': label, disabled: off });
      typed(i, () => (i.value === '' ? null : i.value));
      return i;
    }
    if (f.type === 'longtext') {
      const t = el('textarea', { rows: 4, maxlength: L.LIMITS.longtext, 'aria-label': label, disabled: off });
      t.value = value ?? '';
      typed(t, () => (t.value === '' ? null : t.value));
      return t;
    }
    if (f.type === 'number') {
      const i = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: value ?? '', min: f.min ?? null, max: f.max ?? null, 'aria-label': label, disabled: off });
      typed(i, () => numOrNull(i.value));
      return i;
    }
    if (f.type === 'counter') {
      const v = value || {};
      const cur = el('input', { type: 'number', inputmode: 'numeric', value: v.cur ?? '', 'aria-label': `${label} now`, disabled: off });
      const max = el('input', { type: 'number', inputmode: 'numeric', value: v.max ?? '', 'aria-label': `${label} most`, disabled: off });
      const send = () => set({ cur: numOrNull(cur.value), max: numOrNull(max.value) });
      cur.addEventListener('change', send);
      max.addEventListener('change', send);
      return el('div', { class: 'sheet-counter-box' }, cur, el('span', { class: 'muted' }, '/'), max);
    }
    if (f.type === 'pips') {
      // the pips past this character's own maximum are greyed out and can't be ticked
      const n = pipCount(f), most = pipCap(f, cap);
      let filled = Math.min(Number(value) || 0, most);
      const box = el('div', { class: 'sheet-pips', role: 'group', 'aria-label': most < n ? `${label}, ${most} of ${n} available` : label });
      const draw = () => box.replaceChildren(...Array.from({ length: n }, (_, i) => i >= most
        ? button('', null, 'sheet-pip capped', { 'aria-label': `${label} ${i + 1}, not available`, disabled: true, 'data-tip': `Past this character's maximum of ${most}` })
        : button('', () => { filled = filled === i + 1 ? i : i + 1; draw(); set(filled); }, 'sheet-pip' + (i < filled ? ' on' : ''),
          { 'aria-label': `${label} ${i + 1}`, 'aria-pressed': String(i < filled), disabled: off })));
      draw();
      return box;
    }
    if (f.type === 'checkbox') {
      const c = el('input', { type: 'checkbox', checked: !!value, 'aria-label': label, disabled: off });
      c.addEventListener('change', () => set(c.checked));
      return c;
    }
    if (f.type === 'choice') {
      // Custom… opens a box beside the list for anything the options don't have
      // a number kept from before the field was a list (a template changed a number to a rating) shows as typed
      if (typeof value === 'number') value = String(value);
      const opts = f.options || [], own = typeof value === 'string' && value !== '' && !opts.includes(value);
      const s = el('select', { 'aria-label': label, disabled: off }, el('option', { value: '' }, '—'),
        opts.map(o => el('option', { value: o, selected: o === value }, o)), el('option', { value: CUSTOM, selected: own }, 'Custom…'));
      const box = el('input', { value: own ? value : '', maxlength: L.LIMITS.text, 'aria-label': `${label}, custom entry`, placeholder: 'Type your own', disabled: off, hidden: !own });
      typed(box, () => (box.value === '' ? null : box.value));
      s.addEventListener('change', () => {
        box.hidden = s.value !== CUSTOM;
        if (s.value !== CUSTOM) return set(s.value === '' ? null : s.value);
        box.focus();
        if (box.value !== '') set(box.value);
      });
      return el('div', { class: 'sheet-choice' }, s, box);
    }
    // list: rows of the field's columns
    const cols = f.columns || [];
    let rows = Array.isArray(value) ? value.map(r => ({ ...r })) : [];
    const table = el('div', { class: 'sheet-list' });
    const send = () => set(rows.filter(r => cols.some(c => String(r[c.key] ?? '').trim() !== '')));
    // with roll, a row with dice in it (an attack's damage, a spell's) has a 🎲 that rolls the first dice it has,
    // named by the row's first cell
    // without dice, a row with a number in a column called Rating (an ability's, a background's) rolls that number on
    // the campaign's game roll, as a number field does; a QuestWorlds rating with masteries, 5M or 4M2, is 25 or 44
    const ratingCol = cols.find(c => /^rating$/i.test(String(c.label || '').trim()));
    const ratingOf = r => {
      const m = ratingCol && String(r[ratingCol.key] ?? '').trim().match(/^([+-]?\d{1,3})(?:\s*M(\d?))?$/i);
      return m ? Number(m[1]) + (m[0].match(/M/i) ? 20 * (Number(m[2]) || 1) : 0) : null;
    };
    const rowDice = (r, ri) => {
      if (!roll || typeof Dice === 'undefined') return null;
      const hit = () => cols.map(c => [c, Dice.find(r[c.key])]).find(([, d]) => d);
      const name = () => String(r[cols[0]?.key] ?? '').trim();
      const b = button('🎲', () => {
        const h = hit(), n = h ? null : ratingOf(r);
        if (h) roll({ kind: 'dice', value: h[1], label: [name() || `${label} row ${ri + 1}`, h[0] !== cols[0] ? h[0].label : null].filter(Boolean).join(', ') });
        else if (n !== null) roll({ kind: 'num', value: n, label: name() || `${label} row ${ri + 1}`, field: ratingCol.label });
      }, 'icon-btn sheet-roll');
      b.update = () => {
        const h = hit(), n = h ? null : ratingOf(r);
        b.hidden = !h && n === null;
        b.setAttribute('aria-label', h ? `Roll ${h[1]}${name() ? ` for ${name()}` : ''}` : n !== null ? `Roll ${name() || 'this row'}'s rating` : 'Nothing to roll');
      };
      b.update();
      return b;
    };
    // column widths by what they hold (SheetLayout.columnWidths): a narrow column (Weight, Uses, Damage) is a fixed
    // few characters, a wide one twice a normal one, and the normal ones (Item, Name, Notes) share what is left. A wide
    // column spans two equal <col>s; below its least width the table scrolls sideways rather than squeezing.
    // A narrow column fits its heading's longest word (a heading wraps between words), and a little more for each
    // value it holds (ST / Rcl, 1/2D / Max), 4 to 7rem.
    const widths = L.columnWidths(cols), span = w => (w === 'wide' ? 2 : 1);
    const narrowRem = c => {
      const label = String(c.label), parts = label.split(/\s+\/\s+|\s*&\s*/).length;
      return Math.min(7, Math.max(4 + 1.5 * (parts - 1), 0.6 * Math.max(...label.split(/\s+/).map(x => x.length)) + 0.75));
    };
    const shares = widths.reduce((n, w) => n + (w === 'narrow' ? 0 : span(w)), 0), buttons = (roll ? 1 : 0) + (off ? 0 : 1);
    const fixed = cols.reduce((n, c, i) => n + (widths[i] === 'narrow' ? narrowRem(c) : 0), 0) + buttons * 2.5;
    const draw = () => fill(table,
      el('table', { class: 'tbl sheet-list-table', style: { minWidth: `${fixed + shares * 7}rem` } },
        el('colgroup', {}, cols.flatMap((c, i) => (widths[i] === 'narrow' ? [el('col', { class: 'sheet-col-narrow', style: { width: `${narrowRem(c)}rem` } })]
          : Array.from({ length: span(widths[i]) }, () => el('col', {})))),
          roll ? el('col', { class: 'sheet-col-btn' }) : null, off ? null : el('col', { class: 'sheet-col-btn' })),
        el('tr', {}, cols.map((c, ci) => el('th', { colspan: span(widths[ci]), 'data-width': widths[ci] }, c.label)), roll ? el('th', {}) : null, off ? null : el('th', {})),
        rows.map((r, ri) => {
          const die = rowDice(r, ri);
          return el('tr', {}, cols.map((c, ci) => {
            const i = el('input', { value: r[c.key] ?? '', maxlength: L.LIMITS.text, 'aria-label': `${label} row ${ri + 1} ${c.label}`, disabled: off });
            i.addEventListener('change', () => { r[c.key] = i.value; send(); die?.update(); });
            return el('td', { colspan: span(widths[ci]) }, i);
          }), roll ? el('td', { class: 'sheet-roll-cell' }, die) : null,
          off ? null : el('td', {}, button('×', () => { rows.splice(ri, 1); draw(); send(); }, 'icon-btn', { 'aria-label': `Remove row ${ri + 1}` })));
        })),
      off || rows.length >= L.LIMITS.rows ? null : button('+ Row', () => { rows.push({}); draw(); }, 'small'));
    draw();
    return table;
  }

  // ------------------------------------------------------------ library
  const metaLine = t => [t.game, t.edition].filter(Boolean).join(' · ');
  /** Use: make a character from template t in one of the user's campaigns. */
  async function useTemplate(t) {
    const { campaigns } = await ctx.api('campaigns');
    const mine = campaigns.filter(c => c.member);
    if (!mine.length) return toast('Join or start a campaign first, then make a character there', true);
    const camp = el('select', { 'aria-label': 'Campaign' }, mine.map(c => el('option', { value: c.id }, c.name)));
    const name = el('input', { maxlength: 150, 'aria-label': 'Character name', required: true, placeholder: 'Their name' });
    const kind = el('select', { 'aria-label': 'PC or NPC' }, el('option', { value: 'pc' }, 'PC (a player character)'), el('option', { value: 'npc' }, 'NPC (GM only until shown)'));
    const kindField = ctx.field('Kind', kind);
    const fit = () => { kindField.hidden = mine.find(c => String(c.id) === camp.value)?.role !== 'gm'; if (kindField.hidden) kind.value = 'pc'; };
    camp.addEventListener('change', fit);
    fit();
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': `Use ${t.name}` },
      el('form', { method: 'dialog' }, el('h3', {}, `Use ${t.name}`), ctx.field('Campaign', camp), ctx.field('Name', name), kindField,
        el('div', { class: 'kit-dialog-actions' }, el('button', { value: 'ok', class: 'primary' }, 'Make character'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel'))));
    d.addEventListener('close', async () => {
      d.remove();
      if (d.returnValue !== 'ok') return;
      try {
        const r = await ctx.post('character_create', { template_id: t.id, name: name.value, kind: kind.value }, Number(camp.value));
        location.hash = `#/c/${camp.value}/characters/${r.character.id}`;
      } catch (err) { toast(err.message, true); }
    });
    document.body.append(d);
    d.showModal();
    name.focus();
  }
  async function fork(t) {
    try {
      const r = await ctx.post('template_fork', { id: t.id });
      toast(`Forked. This copy is yours to change`);
      location.hash = `#/templates/${r.template.id}/edit`;
    } catch (err) { toast(err.message, true); }
  }
  /** The buttons for a template: Use, Fork, and Edit for its author. */
  const actions = t => el('div', { class: 'row' },
    button('Use', () => useTemplate(t).catch(err => toast(err.message, true)), 'small primary', { 'data-tip': 'Make a character with this sheet in one of your campaigns' }),
    button('Fork', () => fork(t), 'small', { 'data-tip': 'Make your own copy to change. The original stays as it is' }),
    t.can_edit ? button('Edit', () => (location.hash = `#/templates/${t.id}/edit`), 'small') : null);
  const forkLine = t => t.forked_from ? el('span', { class: 'small muted' }, 'Forked from ', el('a', { href: `#/templates/${t.forked_from.id}` }, t.forked_from.name)) : null;
  const byline = t => el('div', { class: 'small muted' }, `by ${t.author} · Used by ${t.uses} · ${plural(t.forks, 'fork')}`);
  const unlisted = t => t.is_listed ? null : el('span', { class: 'small muted' }, 'Unlisted');
  /** One card per template, except that editions of one game by one author share a card with an Edition dropdown. */
  function card(group) {
    if (group.length === 1) {
      const t = group[0];
      return el('div', { class: 'card template-card' },
        el('div', { class: 'row spread' }, el('a', { href: `#/templates/${t.id}`, class: 'template-name' }, t.name), unlisted(t)),
        el('div', { class: 'small' }, metaLine(t)), byline(t), forkLine(t), actions(t));
    }
    const box = el('div', { class: 'card template-card template-editions' });
    const pick = el('select', { 'aria-label': `${group[0].game} edition` }, group.map((t, i) => el('option', { value: i }, t.edition)));
    const body = el('div', { class: 'template-edition-body' });
    const title = el('a', { class: 'template-name' }, group[0].game);
    const show = () => {
      const t = group[Number(pick.value)];
      title.href = `#/templates/${t.id}`;
      fill(body, el('div', { class: 'small' }, t.name), byline(t), forkLine(t), actions(t));
    };
    pick.addEventListener('change', show);
    // open on the most used edition; on a tie, the last in the list, which is usually the newest
    pick.value = String(group.reduce((best, t, i) => (t.uses >= group[best].uses ? i : best), 0));
    show();
    box.append(
      el('div', { class: 'row spread' }, title, el('span', { class: 'small muted' }, `${group.length} editions`)),
      el('label', { class: 'template-edition small' }, 'Edition ', pick), body);
    return box;
  }
  /** Gather the editions of a game: same game (any case) and same author, each with its own edition. A template with no
   *  edition, or one of two with the same edition, keeps its own card. Cards go A to Z by what they show first: the game for a shared card, else the name. */
  function editionGroups(templates) {
    const groups = [], byKey = new Map();
    for (const t of templates) {
      const key = t.game && t.edition ? `${t.starter ? "" : t.author}\u0000${t.game.trim().toLowerCase()}` : null;
      const g = key && byKey.get(key);
      if (g && !g.some(o => o.edition.trim().toLowerCase() === t.edition.trim().toLowerCase())) { g.push(t); continue; }
      const fresh = [t];
      if (key && !g) byKey.set(key, fresh);
      groups.push(fresh);
    }
    const ed = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    // oldest first: by the year in the edition, as in "Revised (1998)", then A to Z; an edition with no year goes last
    const year = t => Number((t.edition || '').match(/\b(19|20)\d\d/)?.[0] || 9999);
    for (const g of groups) g.sort((a, b) => year(a) - year(b) || ed.compare(a.edition || '', b.edition || ''));
    const title = g => (g.length > 1 ? g[0].game : g[0].name);
    return groups.sort((a, b) => ed.compare(title(a), title(b)));
  }
  async function renderLibrary() {
    closePdf();
    const list = el('div', { class: 'template-grid' });
    const search = el('input', { type: 'search', placeholder: 'Name or game', 'aria-label': 'Search templates' });
    let seq = 0, timer = 0;
    // Request a game: a name typed here reaches the site admin's Sheets tab. Shown only while requests are on.
    const request = button('Request a game', async () => {
      const game = await promptDialog('Which game would you like a starter sheet for? The site admin sees every request, with how many people asked for each game.',
        { title: 'Request a game', value: search.value.trim(), placeholder: 'Game name, and edition if it matters', ok: 'Send request' });
      if (game === null) return;
      if (game.trim().length < 2) return toast('Type the name of the game', true);
      try {
        const r = await ctx.post('game_request', { game: game.trim() });
        toast(r.already ? 'You have already asked for that game' : 'Request sent. Thanks!');
      } catch (err) { toast(err.message, true); }
    }, '', { 'data-tip': 'Ask for a starter template for a game that isn\'t here yet' });
    request.style.display = 'none';
    const load = async () => {
      const n = ++seq;
      const { templates, requests_on } = await ctx.api('templates', { query: search.value.trim() ? { q: search.value.trim() } : {} });
      if (n !== seq) return;
      request.style.display = requests_on ? '' : 'none';
      list.replaceChildren(...(templates.length ? editionGroups(templates).map(card) : [el('p', { class: 'muted' }, search.value ? 'No template matches that.' : 'No templates yet.')]));
    };
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(err => toast(err.message, true)), 250); });
    ctx.mount(el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h1', {}, 'Sheet templates'),
        el('div', { class: 'row', style: { marginTop: '0' } }, request, button('+ New template', () => (location.hash = '#/templates/new'), 'primary new-btn'))),
      el('p', { class: 'muted' }, 'Every character sheet starts from a template. Anyone can use or fork any template here; only its author changes it.'),
      search), list);
    await load();
  }
  async function renderTemplate(id) {
    closePdf();
    const { template: t, forks } = await ctx.api('template', { query: { id } });
    const del = t.can_edit ? button('Delete', async () => {
      if (!await confirmDialog(`Delete the template "${t.name}"? Its forks stay.`, { ok: 'Delete', danger: true })) return;
      try { await ctx.post('template_delete', { id: t.id }); toast('Deleted'); location.hash = '#/templates'; } catch (err) { toast(err.message, true); }
    }, 'small danger') : null;
    ctx.mount(
      el('div', { class: 'card' },
        el('a', { href: '#/templates', class: 'small' }, '← All templates'),
        el('h1', {}, t.name),
        el('div', {}, metaLine(t)),
        el('div', { class: 'small muted row' }, el('span', {}, `by ${t.author}`), el('span', {}, `Used by ${t.uses}`), el('span', {}, plural(t.forks, 'fork')),
          t.is_listed ? null : el('span', {}, 'Unlisted')),
        forkLine(t),
        el('div', { class: 'row' }, actions(t), del)),
      el('div', { class: 'card sheet-preview' }, el('h2', {}, 'Preview'), renderSheetForm(t.layout, {}, { mode: 'preview' })),
      el('div', { class: 'card template-forks' }, el('h2', {}, 'Forks'),
        forks.length ? el('ul', {}, forks.map(f => el('li', {}, el('a', { href: `#/templates/${f.id}` }, f.name), el('span', { class: 'small muted' }, ` by ${f.author}`))))
          : el('p', { class: 'muted' }, 'No forks yet.')));
  }

  // ------------------------------------------------------------ editor
  /** The editor for template id, or a new one. */
  async function renderEditor(id) {
    closePdf();
    let t = { name: '', game: '', edition: '', is_listed: true, layout: { sections: [] } };
    if (id) {
      t = (await ctx.api('template', { query: { id } })).template;
      if (!t.can_edit) { location.hash = `#/templates/${id}`; return; }
    }
    const layout = JSON.parse(JSON.stringify(t.layout));
    // keys made in this editor follow their label until saved; saved keys never change, since values are kept by them
    const fresh = new Set();
    const allKeys = () => new Set(layout.sections.flatMap(s => [s.key, ...s.fields.map(f => f.key)]));
    const freshKey = (obj, label) => {
      const taken = allKeys();
      taken.delete(obj.key);
      fresh.delete(obj.key);
      obj.key = L.newKey(label, taken);
      fresh.add(obj.key);
    };
    const addSection = () => { const s = { key: '', title: 'New section', fields: [] }; layout.sections.push(s); freshKey(s, s.title); };
    if (!layout.sections.length) addSection();

    const name = el('input', { value: t.name, maxlength: 150, 'aria-label': 'Template name', required: true });
    const game = el('input', { value: t.game, maxlength: 100, 'aria-label': 'Game', required: true, placeholder: 'e.g. Mothership' });
    const edition = el('input', { value: t.edition || '', maxlength: 60, 'aria-label': 'Edition', placeholder: 'optional' });
    const listed = el('input', { type: 'checkbox', checked: t.is_listed });
    const list = el('div', { class: 'sheet-ed-list' });
    const errors = el('ul', { class: 'sheet-ed-errors', 'aria-live': 'polite' });
    const preview = el('div', { class: 'sheet-preview' });
    const pdfPanel = el('div', { class: 'sheet-pdf-slot' });
    let previewTimer = 0, previewPage = null;
    const refresh = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        preview.replaceChildren(el('h2', {}, 'Preview'), renderSheetForm(layout, {}, { mode: 'preview', page: previewPage, onPage: p => { previewPage = p; } }));
        errors.replaceChildren(...L.validate(layout).slice(0, 8).map(e => el('li', {}, e)));
      }, 60);
    };

    // dragging a field's handle (mouse, pen or finger) moves it, within its section or to another
    function startDrag(ev, row) {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      row.classList.add('dragging');
      // the row under the pointer, by position, so a tooltip or the moving row itself can't get in the way
      const move = e => {
        const y = e.clientY;
        const target = [...list.querySelectorAll('.sheet-ed-field')].find(r => { const b = r.getBoundingClientRect(); return r !== row && y >= b.top && y < b.bottom; });
        if (target) {
          const r = target.getBoundingClientRect();
          target.parentNode.insertBefore(row, y < r.top + r.height / 2 ? target : target.nextSibling);
          return;
        }
        const box = [...list.querySelectorAll('.sheet-ed-section')].find(sec => { const b = sec.getBoundingClientRect(); return y >= b.top && y < b.bottom; })
          ?.querySelector('.sheet-ed-fields');
        if (box && !box.querySelector('.sheet-ed-field')) box.append(row);
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        row.classList.remove('dragging');
        orderFromPage();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    }
    /** Take the fields' order from the page, after a drag. */
    function orderFromPage() {
      const byKey = new Map(layout.sections.flatMap(s => s.fields.map(f => [f.key, f])));
      for (const sec of list.querySelectorAll('.sheet-ed-section')) {
        const s = layout.sections.find(x => x.key === sec.dataset.key);
        s.fields = [...sec.querySelectorAll('.sheet-ed-field')].map(r => byKey.get(r.dataset.key));
      }
      draw();
    }
    const moveIn = (arr, i, by) => { const j = i + by; if (j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; };

    /** The settings a field's type needs. */
    function typeSettings(f) {
      if (f.type === 'pips') {
        const n = el('input', { type: 'number', min: 1, max: L.LIMITS.pips, value: f.count ?? 3, 'aria-label': 'Pips', class: 'num-sm' });
        n.addEventListener('input', () => { f.count = Math.round(Number(n.value)) || 0; refresh(); });
        return el('label', { class: 'small' }, 'Pips ', n);
      }
      if (f.type === 'number') {
        const box = (k, lbl) => {
          const i = el('input', { type: 'number', step: 'any', value: f[k] ?? '', 'aria-label': lbl, class: 'num-sm' });
          i.addEventListener('input', () => { if (i.value === '') delete f[k]; else f[k] = Number(i.value); refresh(); });
          return el('label', { class: 'small' }, `${lbl} `, i);
        };
        return el('span', { class: 'row' }, box('min', 'Min'), box('max', 'Max'));
      }
      if (f.type === 'choice' || f.type === 'list') {
        const isList = f.type === 'list';
        const text = el('textarea', { rows: 3, 'aria-label': isList ? 'Columns' : 'Options', placeholder: 'One per line' });
        // a list column's own width goes after its label in brackets: Weight [narrow], Notes [wide]
        const WIDTH_TAG = /\s*\[(narrow|normal|wide)\]$/i;
        text.value = (isList ? (f.columns || []).map(c => c.label + (c.width ? ` [${c.width}]` : '')) : f.options || []).join('\n');
        text.addEventListener('input', () => {
          const lines = [...new Set(text.value.split('\n').map(s => s.trim()).filter(Boolean))];
          if (!isList) f.options = lines;
          else {
            // a column keeps its key while its label stays, so rows already filled in keep their values
            const old = new Map((f.columns || []).map(c => [c.label, c.key])), taken = new Set();
            f.columns = lines.map(line => {
              const width = (line.match(WIDTH_TAG)?.[1] || '').toLowerCase(), label = line.replace(WIDTH_TAG, '') || line;
              const key = old.get(label) && !taken.has(old.get(label)) ? old.get(label) : L.newKey(label, taken);
              taken.add(key);
              return width ? { key, label, width } : { key, label };
            });
          }
          refresh();
        });
        return el('label', { class: 'field' }, el('span', { class: 'lbl' }, isList ? 'Columns, one per line' : 'Options, one per line'), text,
          isList ? el('span', { class: 'small muted' }, 'Short columns such as Weight, Uses or Damage are drawn narrow by themselves. To choose, add [narrow], [normal] or [wide] after a label.') : null);
      }
      return null;
    }
    /** How wide the field's box is on the sheet; long text and lists always run the full width. */
    function sizePick(f) {
      if (f.type === 'longtext' || f.type === 'list') return null;
      const now = Number.isInteger(f.cols) ? 'custom' : f.size || 'medium';
      const pick = el('select', { 'aria-label': 'Box size' }, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['full', 'Full width'], ['custom', 'Custom']]
        .map(([v, t]) => el('option', { value: v, selected: v === now }, t)));
      const cols = el('input', { type: 'number', min: 1, max: L.COLS, step: 1, value: f.cols ?? 3, 'aria-label': 'Half-columns', class: 'num-sm', hidden: now !== 'custom',
        'data-tip': `How many half-columns wide, 1 to ${L.COLS}: a medium box is 2` });
      const setCols = () => { f.cols = Math.round(Number(cols.value)) || 0; refresh(); };
      cols.addEventListener('input', setCols);
      pick.addEventListener('change', () => {
        delete f.size; delete f.cols;
        cols.hidden = pick.value !== 'custom';
        if (pick.value === 'custom') return setCols();
        if (pick.value !== 'medium') f.size = pick.value;
        refresh();
      });
      return el('label', { class: 'small', 'data-tip': 'Small is half the usual width, large twice it, full the whole row' }, 'Size ', pick, cols);
    }
    function fieldRow(s, f, i) {
      const row = el('div', { class: 'sheet-ed-field', 'data-key': f.key });
      const handle = el('span', { class: 'drag-handle', role: 'button', tabindex: 0, 'aria-label': `Move ${f.label}`, 'data-tip': 'Drag to move. Or focus it and use the arrow keys' }, '⠿');
      handle.addEventListener('pointerdown', ev => startDrag(ev, row));
      handle.addEventListener('keydown', ev => {
        const by = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
        if (!by) return;
        ev.preventDefault();
        if (moveIn(s.fields, i, by)) { draw(); list.querySelector(`.sheet-ed-field[data-key="${f.key}"] .drag-handle`)?.focus(); }
      });
      const label = el('input', { value: f.label, maxlength: L.LIMITS.label, 'aria-label': 'Field label' });
      label.addEventListener('input', () => {
        f.label = label.value;
        if (fresh.has(f.key)) { freshKey(f, label.value || 'field'); row.dataset.key = f.key; }
        refresh();
      });
      const type = el('select', { 'aria-label': 'Field type' }, L.TYPES.map(ty => el('option', { value: ty, selected: ty === f.type }, TYPE_NAMES[ty])));
      type.addEventListener('change', () => {
        f.type = type.value;
        for (const k of ['count', 'options', 'columns', 'min', 'max']) delete f[k];
        if (f.type === 'longtext' || f.type === 'list') delete f.size;
        if (f.type === 'pips') f.count = 3;
        if (f.type === 'choice') f.options = [];
        if (f.type === 'list') f.columns = [];
        settings.replaceChildren(...[sizePick(f), typeSettings(f)].filter(Boolean));
        refresh();
      });
      const flag = (k, text, tipText) => {
        const c = el('input', { type: 'checkbox', checked: !!f[k] });
        c.addEventListener('change', () => { if (c.checked) f[k] = true; else delete f[k]; refresh(); });
        return el('label', { class: 'small check', 'data-tip': tipText }, c, ` ${text}`);
      };
      const settings = el('div', { class: 'sheet-ed-settings' }, sizePick(f), typeSettings(f));
      row.append(el('div', { class: 'sheet-ed-side' }, handle,
          button('×', () => { s.fields.splice(i, 1); fresh.delete(f.key); draw(); }, 'icon-btn', { 'aria-label': `Remove ${f.label}`, 'data-tip': 'Remove this field' })),
        el('div', { class: 'sheet-ed-main' },
          el('div', { class: 'row' }, label, type,
            flag('play', 'Play view', 'Shown on the Play view, for tracking at the table'),
            flag('summary', 'Summary', 'Shown on the character\'s card and Encyclopedia entry')),
          settings));
      return row;
    }
    // the page names already in use, offered in each section's Page box
    const pageOptions = el('datalist', { id: 'sheet-ed-pages' });
    const pageList = () => pageOptions.replaceChildren(...[...new Set(layout.sections.map(s => s.page).filter(Boolean))].map(p => el('option', { value: p })));
    function draw() {
      pageList();
      list.replaceChildren(...layout.sections.map((s, si) => {
        const title = el('input', { value: s.title, maxlength: L.LIMITS.label, 'aria-label': 'Section title' });
        const sec = el('div', { class: 'sheet-ed-section', 'data-key': s.key });
        title.addEventListener('input', () => {
          s.title = title.value;
          if (fresh.has(s.key)) { freshKey(s, title.value || 'section'); sec.dataset.key = s.key; }
          refresh();
        });
        const page = el('input', { value: s.page || '', maxlength: L.LIMITS.label, 'aria-label': 'Page', placeholder: 'Page (optional)', list: 'sheet-ed-pages', class: 'sheet-ed-page',
          'data-tip': 'Sections on a named page show under its tab. Leave it empty for the first page' });
        page.addEventListener('input', () => { if (page.value.trim()) s.page = page.value; else delete s.page; pageList(); refresh(); });
        const width = el('select', { 'aria-label': 'Section width', 'data-tip': 'Beside other sections on a wide screen; the full width on a phone' },
          [['full', 'Full width'], ['half', 'Half'], ['third', 'Third'], ['two-thirds', 'Two thirds']].map(([v, t]) => el('option', { value: v, selected: v === (s.width || 'full') }, t)));
        width.addEventListener('change', () => { if (width.value === 'full') delete s.width; else s.width = width.value; refresh(); });
        const compact = el('input', { type: 'checkbox', checked: !!s.compact });
        compact.addEventListener('change', () => { if (compact.checked) s.compact = true; else delete s.compact; refresh(); });
        sec.append(
          el('div', { class: 'row sheet-ed-sec-head' }, title, page, width,
            el('label', { class: 'small check', 'data-tip': 'Each field on a line, its label beside its box, like a skill list' }, compact, ' Compact rows'),
            button('↑', () => { if (moveIn(layout.sections, si, -1)) draw(); }, 'icon-btn', { 'aria-label': `Move ${s.title} up`, disabled: si === 0 }),
            button('↓', () => { if (moveIn(layout.sections, si, 1)) draw(); }, 'icon-btn', { 'aria-label': `Move ${s.title} down`, disabled: si === layout.sections.length - 1 }),
            button('Remove section', async () => {
              if (s.fields.length && !await confirmDialog(`Remove the section "${s.title}" and its ${plural(s.fields.length, 'field')}?`, { ok: 'Remove', danger: true })) return;
              layout.sections.splice(si, 1);
              draw();
            }, 'small')),
          el('div', { class: 'sheet-ed-fields' }, s.fields.map((f, i) => fieldRow(s, f, i))),
          button('Add field', () => {
            const f = { key: '', label: 'New field', type: 'text' };
            s.fields.push(f);
            freshKey(f, f.label);
            draw();
            list.querySelector(`.sheet-ed-field[data-key="${f.key}"] input[aria-label="Field label"]`)?.select();
          }, 'small'));
        return sec;
      }));
      refresh();
    }

    // drafting from a PDF: read in the browser, never uploaded, let go of when the editor closes
    const pdfInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'visually-hidden' });
    pdfInput.addEventListener('change', async () => {
      const file = pdfInput.files[0];
      pdfInput.value = '';
      if (!file) return;
      const filled = layout.sections.some(s => s.fields.length);
      if (filled && !await confirmDialog('Replace everything with the draft?', { ok: 'Replace', danger: true })) return;
      let r;
      try { r = await PdfImport.read(file); } catch (err) { return toast(err.message, true); }
      closePdf();
      openDoc = r.doc;
      layout.sections = r.layout.sections;
      fresh.clear();
      for (const k of allKeys()) fresh.add(k);
      draw();
      toast(r.from === 'fields' ? 'Drafted from the PDF\'s form fields. Check the labels and types' : 'Drafted from the PDF\'s text. Check the labels and types');
      const pages = el('div', { class: 'sheet-pdf-pages' });
      pdfPanel.replaceChildren(el('div', { class: 'card sheet-pdf' },
        el('div', { class: 'row spread' }, el('h2', {}, file.name), button('Close PDF', () => { closePdf(); pdfPanel.replaceChildren(); }, 'small')),
        el('p', { class: 'small notice' }, PdfImport.NOTICE), pages));
      const shown = Math.min(r.pages, 30);
      for (let n = 1; n <= shown && openDoc === r.doc; n++) {
        const canvas = el('canvas', { 'aria-label': `Page ${n} of the PDF` });
        pages.append(canvas);
        await PdfImport.renderPage(r.doc, n, canvas, Math.min(560, pages.clientWidth || 560)).catch(() => {});
      }
      if (r.pages > shown) pages.append(el('p', { class: 'small muted' }, `The first ${shown} of ${r.pages} pages.`));
    });

    const save = button(id ? 'Save template' : 'Save template', async () => {
      const problems = L.validate(layout);
      if (!name.value.trim()) return toast('Give the template a name', true);
      if (!game.value.trim()) return toast('Say which game it is for', true);
      if (problems.length) return toast(problems[0], true);
      save.disabled = true;
      try {
        const r = await ctx.post('template_save', { ...(id ? { id, version: t.version } : {}), name: name.value, game: game.value, edition: edition.value,
          is_listed: listed.checked, layout });
        toast('Saved');
        closePdf();
        location.hash = `#/templates/${r.template.id}`;
      } catch (err) { toast(err.message, true); } finally { save.disabled = false; }
    }, 'primary');

    ctx.mount(
      el('div', { class: 'card' },
        el('a', { href: id ? `#/templates/${id}` : '#/templates', class: 'small' }, id ? '← Back to the template' : '← All templates'),
        el('h1', {}, id ? `Edit ${t.name}` : 'New sheet template'),
        el('div', { class: 'grid3' }, ctx.field('Name', name), ctx.field('Game', game), ctx.field('Edition', edition)),
        el('label', { class: 'small check', 'data-tip': 'Unlisted templates are left out of the library for others, but anyone with the link can still use them' }, listed, ' Listed in the library'),
        el('div', { class: 'row' },
          el('label', { class: 'button small' }, 'Import from PDF', pdfInput),
          el('span', { class: 'small muted' }, PdfImport.NOTICE)),
        errors),
      pdfPanel,
      el('div', { class: 'sheet-ed' },
        el('div', { class: 'card sheet-ed-pane' }, list, pageOptions,
          el('div', { class: 'row' }, button('Add section', () => { addSection(); draw(); }, 'small'), save)),
        el('div', { class: 'card sheet-ed-preview' }, preview)));
    draw();
  }

  // ------------------------------------------------------------ characters in a campaign
  const cid = () => ctx.S.camp.id;
  const me = () => ctx.S.user.id;
  const memberName = m => m.character_name || m.display_name;
  const kindName = k => (k === 'npc' ? 'NPC' : 'PC');

  /** Values sent one at a time for each field, the newest last: a field's next value waits for the answer to the one
   * before, and only the newest waiting value goes, so the server ends on the last tap even on a slow connection. */
  function fieldSender(id, onError) {
    const waiting = new Map(), busy = new Set(), sent = new Map();
    async function pump(key) {
      if (busy.has(key)) return;
      busy.add(key);
      try {
        while (waiting.has(key)) {
          const v = waiting.get(key);
          waiting.delete(key);
          if (sent.has(key) && sent.get(key) === JSON.stringify(v)) continue;
          try {
            await ctx.post('character_field', { id, key, value: v }, cid());
            sent.set(key, JSON.stringify(v));
          } catch (err) {
            // nothing more goes; the page is drawn again from what the server has
            waiting.clear();
            onError(err);
          }
        }
      } finally { busy.delete(key); }
    }
    return {
      send(key, v) { waiting.set(key, v); pump(key); },
      known(key, v) { sent.set(key, JSON.stringify(v)); },
      /** Whether a value of this field is waiting or on its way: what the server says now is about to be replaced. */
      pending: key => waiting.has(key) || busy.has(key),
    };
  }

  // who else is on the sheet: asked at once, then every 15 seconds, while the sheet or its Play view is open
  const POLL_MS = 15000;
  let presence = null;
  function stopPresence() {
    if (presence) clearTimeout(presence.timer);
    presence = null;
  }
  window.addEventListener('hashchange', () => { if (presence && !location.hash.startsWith(presence.hash)) stopPresence(); });
  /** Start checking in on character ch: onViewers(list) and onChanges(changes) get what each check brings. */
  function startPresence(ch, { editing, onViewers, onChanges }) {
    stopPresence();
    const p = presence = { hash: `#/c/${cid()}/characters/${ch.id}`, timer: 0, stamp: null, editing: !!editing };
    const tick = async () => {
      clearTimeout(p.timer);
      if (presence !== p) return;
      try {
        const r = await ctx.post('character_presence', { id: ch.id, editing: p.editing, since: p.stamp }, cid());
        if (presence !== p) return;
        if (p.stamp !== null) onChanges(r.changes || {});
        p.stamp = r.stamp;
        onViewers(r.viewers || []);
      } catch { /* the next check tries again */ }
      if (presence === p) p.timer = setTimeout(tick, POLL_MS);
    };
    p.check = tick;
    tick();
    return p;
  }
  function viewersBar() {
    const bar = el('div', { class: 'sheet-viewers', role: 'status', 'aria-live': 'polite', hidden: true });
    bar.show = viewers => {
      bar.hidden = !viewers.length;
      bar.replaceChildren(...viewers.map(v => el('div', {}, `${v.name}${v.role === 'gm' ? ' (GM)' : ''} is ${v.editing ? 'editing' : 'also looking at'} this sheet`)));
    };
    return bar;
  }

  /** A value short enough for a card, or null: a list's rows by their first column ("Sword, Shield, Rations"), long
   * text cut short, anything else structured left to the sheet. */
  function cardValue(v) {
    if (v === null || v === undefined || v === '' || v === false) return null;
    if (Array.isArray(v)) {
      const names = v.map(r => (r && typeof r === 'object' ? Object.values(r).find(x => String(x ?? '').trim()) : r))
        .filter(x => x !== null && x !== undefined && String(x).trim()).map(x => String(x).trim());
      return names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '') : null;
    }
    if (typeof v === 'object') return null;
    const t = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return !t ? null : t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }
  /** "Level 2" for a number, the value alone for words ("Fighter"). */
  const cardPair = (label, v, raw) => (typeof raw === 'number' || /^[+\-−]?\d/.test(v) ? `${label} ${v}` : v);
  const CARD_LINES = 4;   // the most Play fields a card lists under its bars, past which it says how many more
  /** What a card shows of a sheet: its Summary fields as one line under the name (who they are: Fighter · Level 2),
   * then its Play fields (how they are doing): counters as bars, tracks as dots, ticked boxes as chips, and a few
   * short values, lists as their rows' names. Never the raw data; the rest is on the sheet. */
  function cardStats(c) {
    if (!c.sheet_visible) return el('p', { class: 'small muted' }, 'Sheet hidden by the GM');
    const inSummary = new Set(c.summary.map(f => f.key));
    const bars = [], lines = [], chips = [];
    for (const f of c.play) {
      if (inSummary.has(f.key)) continue;
      if (f.type === 'counter') {
        const v = f.value || {}, pct = v.max ? Math.max(0, Math.min(100, (v.cur / v.max) * 100)) : 0;
        if (v.cur == null && v.max == null) continue;
        bars.push(el('div', { class: 'card-stat' }, el('span', { class: 'small' }, `${f.label} ${v.cur ?? '–'}${v.max != null ? ` / ${v.max}` : ''}`),
          v.max ? el('div', { class: 'stat-bar' }, el('span', { style: { width: `${pct}%` } })) : null));
      } else if (f.type === 'pips') {
        // a track's own maximum (Track maximums): the pips past it greyed out
        const most = Number.isInteger(f.cap) ? f.cap : (f.count || 0), v = Math.min(Number(f.value) || 0, most);
        bars.push(el('div', { class: 'card-stat small' }, `${f.label} `, '●'.repeat(v) + '○'.repeat(Math.max(0, most - v)),
          most < (f.count || 0) ? el('span', { class: 'pip-capped', 'aria-label': `${f.count - most} not available` }, '○'.repeat(f.count - most)) : null));
      }
      else if (f.type === 'checkbox') { if (f.value) chips.push(el('span', { class: 'chip card-cond' }, f.label)); }
      else {
        const v = cardValue(f.value);
        if (v) lines.push(el('div', { class: 'card-stat small', title: v }, Array.isArray(f.value) ? `${f.label}: ${v}` : cardPair(f.label, v, f.value)));
      }
    }
    const more = lines.length - CARD_LINES;
    return el('div', { class: 'card-stats' }, bars, chips.length ? el('div', { class: 'row card-conds' }, chips) : null,
      lines.slice(0, CARD_LINES), more > 0 ? el('div', { class: 'small muted' }, `+${more} more on the sheet`) : null);
  }
  /** A character's Summary fields as one short line: "Fighter · Level 2". */
  function summaryLine(c) {
    if (!c.sheet_visible) return null;
    const parts = c.summary.map(f => { const v = cardValue(f.value); return v ? { text: cardPair(f.label, v, f.value), full: `${f.label}: ${v}` } : null; }).filter(Boolean);
    return parts.length ? el('div', { class: 'character-summary', title: parts.map(p => p.full).join('\n') }, parts.map(p => p.text).join(' · ')) : null;
  }
  /** A character's portrait, or its initials in a circle where it has none. */
  function portrait(c, cls = '') {
    const initials = String(c.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    return c.pic ? el('img', { src: c.pic, alt: '', class: `character-pic ${cls}`, loading: 'lazy' })
      : el('span', { class: `character-pic character-initials ${cls}`, 'aria-hidden': 'true' }, initials);
  }
  function characterCard(c) {
    const href = `#/c/${cid()}/characters/${c.id}`;
    return el('div', { class: 'card character-card', 'data-kind': c.kind },
      el('div', { class: 'row character-card-head' }, el('a', { href, tabindex: -1, 'aria-hidden': 'true' }, portrait(c)),
        el('div', {}, el('a', { href, class: 'character-name' }, c.name),
          el('div', { class: 'small muted' }, [kindName(c.kind), c.owner?.name || 'No player', c.party_group_id ? 'In the party' : c.owner_is_player && c.party_out ? 'Out of the party' : null, c.template.game].filter(Boolean).join(' · ')),
          summaryLine(c))),
      cardStats(c),
      // at the card's foot, so every card's buttons line up whatever is above them
      el('div', { class: 'row character-card-foot' }, el('a', { href, class: 'button small' }, 'Sheet'),
        c.sheet_visible && c.has_play ? el('a', { href: `${href}/play`, class: 'button small' }, 'Play') : null,
        ctx.isGM() && c.can_edit ? partyToggle(c) : null));
  }
  /** A GM's Party switch on a character's card: the sheet's Travels with the party. A player's character is in the party
   * with its player (off takes them out of every party group); one with no player travels with the main group. */
  function partyToggle(c) {
    const on = () => (c.owner_is_player ? !c.party_out : !!c.party_group_id);
    const box = el('input', { type: 'checkbox', checked: on() });
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        const res = await ctx.post('character_save', { id: c.id, version: c.version, party: box.checked }, cid());
        Object.assign(c, res.character);
        toast(on() ? `${c.name} travels with the party` : `${c.name} is out of the party`);
        ctx.route();   // the card's line under the name says In the party or not
      } catch (err) {
        box.checked = on();
        toast(err.message, true);
        if (err.status === 409) ctx.route();
      } finally { box.disabled = false; }
    });
    return el('label', { class: 'small check character-party', 'data-tip': c.owner_is_player
      ? 'Travels with the party. Its player is in the party while this is their active character; untick to take them out of every party group'
      : 'Travels with the party: listed with the party\'s players on Travel and the maps, gets its own action each shift At the Table, and goes where the party goes' },
    box, ' Party');
  }
  const FILTER_KEY = 'chronicle:characters-filter';
  async function renderCharacters() {
    stopPresence();
    const { characters } = await ctx.api('characters', { query: { cid: cid() } });
    let filter = 'all';
    try { filter = localStorage.getItem(FILTER_KEY) || 'all'; } catch { /* private window */ }
    const list = el('div', { class: 'character-grid' });
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
    const draw = () => {
      seg.replaceChildren(...[['all', 'All'], ['pc', 'PCs'], ['npc', 'NPCs']].map(([k, l]) =>
        button(l, () => { filter = k; try { localStorage.setItem(FILTER_KEY, k); } catch { /* private window */ } draw(); }, filter === k ? 'on' : '', { 'aria-pressed': String(filter === k) })));
      const shown = characters.filter(c => filter === 'all' || c.kind === filter);
      list.replaceChildren(...(shown.length ? shown.map(characterCard) : [el('p', { class: 'muted' }, characters.length ? 'None of those.' : 'No characters yet. Make one with New character.')]));
    };
    draw();
    ctx.mount(...ctx.campaignHeader('characters'),
      el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, 'Characters'),
        button('+ New character', () => newCharacter().catch(err => toast(err.message, true)), 'primary new-btn', { 'data-tip': 'Make a PC or an NPC from a sheet template' })), seg),
      list);
  }
  /** A GM's Player and party boxes for a new character: who plays it (no one, a player or a GM) and, for one no player
   * plays, whether it travels with the party (on to start for a PC, off for an NPC, until the GM ticks it). */
  function whoPlays(kind, ownerId = 0) {
    const S = ctx.S;
    const owner = el('select', { 'aria-label': 'Player' }, el('option', { value: 0 }, 'No player (the GM runs it)'),
      S.members.filter(m => m.role === 'player').map(m => el('option', { value: m.id, selected: Number(m.id) === ownerId }, memberName(m))),
      S.members.filter(m => m.role === 'gm').map(m => el('option', { value: m.id, selected: Number(m.id) === ownerId }, `${memberName(m)} (GM)`)));
    const party = el('input', { type: 'checkbox', 'aria-label': 'Travels with the party' });
    const partyRow = el('label', { class: 'small check', 'data-tip': 'Listed with the party\'s players on Travel and the maps, and goes where the party goes. A player\'s own character is in the party with them' },
      party, ' Travels with the party');
    let touched = false;
    party.addEventListener('change', () => { touched = true; });
    const sync = () => {
      const role = S.members.find(m => Number(m.id) === Number(owner.value))?.role;
      partyRow.hidden = role === 'player';
      if (!touched) party.checked = kind.value === 'pc' && !Number(owner.value);
    };
    owner.addEventListener('change', sync);
    kind.addEventListener('change', sync);
    sync();
    return { nodes: [ctx.field('Player', owner), partyRow],
      values: () => ({ owner_id: Number(owner.value), party: !partyRow.hidden && party.checked }) };
  }
  /** Pick a template and a name; GMs also pick PC or NPC, who plays it, and whether it travels with the party.
   * preset (from the Members tab): the name and owner_id to start from; an entry already called that name gets the sheet. */
  async function newCharacter(preset = null) {
    const { templates } = await ctx.api('templates');
    if (!templates.length) return toast('There are no templates yet. Make one in Sheet templates first', true);
    const search = el('input', { type: 'search', placeholder: 'Name or game', 'aria-label': 'Search templates' });
    const pick = el('select', { 'aria-label': 'Template', size: Math.min(8, templates.length + 1), required: true });
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const keep = pick.value;
      pick.replaceChildren(...templates.filter(t => !q || `${t.name} ${t.game}`.toLowerCase().includes(q))
        .map(t => el('option', { value: t.id, selected: String(t.id) === keep }, `${t.name} — ${metaLine(t)}`)));
    };
    search.addEventListener('input', fill);
    fill();
    const name = el('input', { maxlength: 150, 'aria-label': 'Character name', required: true, placeholder: 'Their name', value: preset?.name || '' });
    const kind = el('select', { 'aria-label': 'PC or NPC' }, el('option', { value: 'pc' }, 'PC (a player character)'), el('option', { value: 'npc' }, 'NPC (GM only until shown)'));
    const who = ctx.isGM() ? whoPlays(kind, Number(preset?.owner_id) || 0) : null;
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'New character' },
      el('form', { method: 'dialog' }, el('h3', {}, 'New character'),
        search, ctx.field('Template', pick), ctx.field('Name', name), who ? [ctx.field('Kind', kind), who.nodes] : null,
        el('div', { class: 'kit-dialog-actions' }, el('button', { value: 'ok', class: 'primary' }, 'Make character'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel'))));
    d.addEventListener('close', async () => {
      d.remove();
      if (d.returnValue !== 'ok') return;
      try {
        const r = await ctx.post('character_create', { template_id: Number(pick.value), name: name.value, kind: kind.value, ...(who ? who.values() : {}),
          ...(preset ? { use_entry: true } : {}) }, cid());
        if (ctx.reloadCampaign) await ctx.reloadCampaign();   // the member list carries each one's active character
        location.hash = `#/c/${cid()}/characters/${r.character.id}`;
      } catch (err) { toast(err.message, true); }
    });
    document.body.append(d);
    d.showModal();
    (preset ? search : name).focus();
  }

  /** Make member uid play a Person entry: its character (characterId), or for an entry with none a new PC sheet on
   * template templateId. It becomes their active character, whose name the app shows for them. With no sheet and no
   * template, the entry's name is just their character's name (the old way), until a sheet is made for it. */
  async function linkToMember({ entryId, name = '', characterId = null, templateId = null, uid }) {
    let id = characterId;
    if (!id && !templateId) {
      await ctx.post('member_character', { user_id: uid, character_name: name }, cid());
      return null;
    }
    if (!id) id = (await ctx.post('character_create', { template_id: templateId, entry_id: entryId, kind: 'pc', owner_id: uid }, cid())).character.id;
    await ctx.post('member_link_character', { user_id: uid, character_id: id }, cid());
    return id;
  }
  /** The template for a sheet made while linking: None (no sheet yet, the first choice), or one of the templates. */
  async function templatePick() {
    const { templates } = await ctx.api('templates');
    return el('select', { 'aria-label': 'Template' }, el('option', { value: '' }, 'None (no sheet yet)'),
      templates.map(t => el('option', { value: t.id }, `${t.name} — ${metaLine(t)}`)));
  }
  /** A GM links Person entry e to a member of the campaign, who then plays it (a sheet is made for an entry without one). */
  async function linkMember(e) {
    const S = ctx.S;
    const ch = S.encChars?.[e.id] || null;
    const pick = ch ? null : await templatePick();
    const people = [...S.members.filter(m => m.role === 'player'), ...S.members.filter(m => m.role === 'gm')];
    const who = el('select', { 'aria-label': 'Member', required: true }, people.map(m =>
      el('option', { value: m.id, selected: ch ? Number(m.id) === ch.owner?.id : (m.character_name || '').toLowerCase() === e.name.toLowerCase() }, `${m.display_name}${m.role === 'gm' ? ' (GM)' : ''}${m.character_name ? ` — now ${m.character_name}` : ''}`)));
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': `Link ${e.name} to a member` },
      el('form', { method: 'dialog' }, el('h3', {}, `Who plays ${e.name}?`),
        el('p', { class: 'small muted' }, `${e.name} becomes their character, and the name the app shows for them.${ch ? '' : ' Pick a template to give it a character sheet now, or None to add one later.'}`),
        ctx.field('Member', who), pick ? ctx.field('Template', pick) : null,
        el('div', { class: 'kit-dialog-actions' }, el('button', { value: 'ok', class: 'primary' }, 'Link'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel'))));
    d.addEventListener('close', async () => {
      d.remove();
      if (d.returnValue !== 'ok' || !who.value) return;
      try {
        await linkToMember({ entryId: e.id, name: e.name, characterId: ch?.id || null, templateId: pick?.value ? Number(pick.value) : null, uid: Number(who.value) });
        await ctx.reloadCampaign();
        ctx.route();
      } catch (err) { toast(err.message, true); }
    });
    document.body.append(d);
    d.showModal();
  }

  /** A GM gives Encyclopedia entry e a character sheet: pick a template, and PC or NPC (NPC to start). */
  async function addToEntry(e) {
    const { templates } = await ctx.api('templates');
    if (!templates.length) return toast('There are no templates yet. Make one in Sheet templates first', true);
    const pick = el('select', { 'aria-label': 'Template', required: true }, templates.map(t => el('option', { value: t.id }, `${t.name} — ${metaLine(t)}`)));
    const kind = el('select', { 'aria-label': 'PC or NPC' }, el('option', { value: 'npc' }, 'NPC (GM only until shown)'), el('option', { value: 'pc' }, 'PC (a player character)'));
    const who = whoPlays(kind);
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': `A character sheet for ${e.name}` },
      el('form', { method: 'dialog' }, el('h3', {}, `A character sheet for ${e.name}`), ctx.field('Template', pick), ctx.field('Kind', kind), who.nodes,
        el('div', { class: 'kit-dialog-actions' }, el('button', { value: 'ok', class: 'primary' }, 'Add sheet'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel'))));
    d.addEventListener('close', async () => {
      d.remove();
      if (d.returnValue !== 'ok') return;
      try {
        const r = await ctx.post('character_create', { template_id: Number(pick.value), entry_id: e.id, kind: kind.value, ...who.values() }, cid());
        location.hash = `#/c/${cid()}/characters/${r.character.id}`;
      } catch (err) { toast(err.message, true); }
    });
    document.body.append(d);
    d.showModal();
  }

  /** The settings strip: name, PC or NPC, whose sheet, shown to players, the active character. */
  function settingsStrip(ch, mine, save) {
    const S = ctx.S, gm = ctx.isGM();
    const name = el('input', { value: ch.name, maxlength: 150, 'aria-label': 'Character name' });
    name.addEventListener('change', () => save({ name: name.value }));
    const kind = el('select', { 'aria-label': 'PC or NPC' }, el('option', { value: 'pc', selected: ch.kind === 'pc' }, 'PC'), el('option', { value: 'npc', selected: ch.kind === 'npc' }, 'NPC'));
    kind.addEventListener('change', () => save({ kind: kind.value }));
    const people = S.members.filter(m => gm || m.role === 'gm' || Number(m.id) === me());
    if (ch.owner && !people.some(m => Number(m.id) === ch.owner.id)) people.push({ id: ch.owner.id, display_name: `${ch.owner.name} (left the campaign)`, role: 'player' });
    const owner = el('select', { 'aria-label': 'Whose sheet' }, gm || !ch.owner ? el('option', { value: 0, selected: !ch.owner }, 'No player (the GM runs it)') : null,
      people.map(m => el('option', { value: m.id, selected: Number(m.id) === ch.owner?.id }, `${memberName(m)}${m.role === 'gm' ? ' (GM)' : ''}`)));
    owner.addEventListener('change', () => save({ owner_id: Number(owner.value) }));
    // a character no player of the campaign plays can travel with the party (a player's is in it with them)
    // a player's character is in the party with its player until a GM takes it out (and them with it)
    const party = el('input', { type: 'checkbox', checked: ch.owner_is_player ? !ch.party_out : !!ch.party_group_id });
    party.addEventListener('change', () => save({ party: party.checked }));
    const shown = el('input', { type: 'checkbox', checked: ch.sheet_public });
    shown.addEventListener('change', () => save({ sheet_public: shown.checked }));
    const active = S.members.find(m => Number(m.id) === me())?.active_character_id;
    return el('div', { class: 'row sheet-settings' },
      ctx.field('Name', name), ctx.field('Kind', kind), ctx.field('Player', owner),
      ch.kind === 'npc' ? el('label', { class: 'small check', 'data-tip': 'NPC sheets are for GMs only until this is on' }, shown, ' Show sheet to players') : null,
      gm ? el('label', { class: 'small check', 'data-tip': ch.owner_is_player
        ? 'Its player is in the party while this is their active character. Untick to take them out of every party group (they died, left, or sit this arc out); tick to put them back in the main group'
        : 'Listed with the party\'s players on Travel and the maps, and goes where the party goes' },
        party, ' Travels with the party') : null,
      mine ? (Number(active) === ch.id ? el('span', { class: 'small muted' }, 'Your active character')
        : button('Make this my active character', async () => {
          try {
            await ctx.post('member_active_character', { character_id: ch.id }, cid());
            const m = S.members.find(x => Number(x.id) === me());
            if (m) { m.active_character_id = ch.id; m.character_name = ch.name; }
            toast(`${ch.name} is now the name shown for you here`);
            ctx.route();
          } catch (err) { toast(err.message, true); }
        }, 'small', { 'data-tip': 'Events, notes and the member list show this character\'s name for you' })) : null);
  }

  /** Import: a Pathbuilder 2e export or a D&D Beyond character, by link, file or pasted JSON, onto this sheet's fields. */
  function importPanel(ch) {
    const box = el('textarea', { rows: 3, 'aria-label': 'Link or JSON to import', placeholder: 'A Pathbuilder 2e Export JSON link, a public D&D Beyond character link, or the JSON itself' });
    const file = el('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'JSON file to import' });
    const msg = el('p', { class: 'small', role: 'status' });
    const go = async text => {
      msg.textContent = '';
      text = text.trim();
      let json = null;
      try {
        if (I.link(text)) {
          msg.textContent = 'Fetching…';
          json = (await ctx.post('sheet_import_fetch', { url: text })).json;
        } else {
          try { json = JSON.parse(text); } catch { throw new Error('Paste a Pathbuilder 2e Export JSON link, a public D&D Beyond character link, or the JSON from either'); }
        }
        const read = I.read(json), from = I.detect(json) === 'pathbuilder' ? 'Pathbuilder 2e export' : 'D&D Beyond character';
        const { values, count } = I.fit(ch.layout, read.values);
        if (!count) throw new Error(`Nothing in that ${from} matches this sheet's fields. Imports fill the starter ${I.detect(json) === 'pathbuilder' ? 'Pathfinder 2e' : 'D&D 5e'} template and forks that keep its fields`);
        msg.textContent = '';
        if (!await confirmDialog(`Fill ${plural(count, 'field')} from ${read.name ? `${read.name}'s` : 'the'} ${from}? What is in those fields now is replaced; the rest stay as they are.`, { ok: 'Fill the sheet' })) return;
        await ctx.post('character_values', { id: ch.id, values }, cid());
        toast(`Filled ${plural(count, 'field')}`);
        ctx.route();
      } catch (err) { msg.textContent = err.message; }
    };
    file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (f) go(await f.text()); });
    return el('div', { class: 'card sheet-import', hidden: true },
      el('h3', {}, 'Import a character'),
      el('p', { class: 'small muted' }, 'From Pathbuilder 2e (Menu > Export > Export JSON, then copy the link) or D&D Beyond (the character\'s page link; its privacy must be Public). The values land on the fields of the starter Pathfinder 2e or D&D 5e template. The name stays this sheet\'s.'),
      box, el('div', { class: 'row' }, button('Read it', () => go(box.value), 'primary small'), el('label', { class: 'small' }, 'or a file ', file)), msg);
  }

  /** A character's sheet, or (play) its Play view. */
  /** The Portrait box on a sheet, for its player and the GMs: the pictures on the character's Encyclopedia entry to pick
   * from, Upload a picture (which goes on the entry too) and Find Image. done(character) after each change. */
  function portraitPanel(ch, done) {
    const box = el('div', { class: 'card sheet-portrait-panel', hidden: true });
    const status = el('p', { class: 'small muted', role: 'status' });
    const use = async fileId => {
      status.textContent = 'Saving…';
      try {
        const res = await ctx.post('character_portrait', { id: ch.id, file_id: fileId }, cid());
        Object.assign(ch, { pic: res.character.pic, portrait_id: res.character.portrait_id });
        status.textContent = '';
        toast(fileId ? 'Portrait set' : 'Portrait is the entry\'s first picture again');
        done(ch);
        load();
      } catch (err) { status.textContent = ''; toast(err.message, true); }
    };
    async function load() {
      let r;
      try { r = await ctx.api('files', { query: { cid: cid(), parent_type: 'encyclopedia', parent_id: ch.entry_id } }); }
      catch (err) { return fill(box, el('p', { class: 'small muted' }, err.message)); }
      const pics = r.files.filter(f => f.kind === 'image' || (f.kind === 'embed' && !f.embed?.gone));
      const up = r.uploads || {};
      const input = el('input', { type: 'file', accept: 'image/*', class: 'file-input', 'aria-label': 'Upload a portrait' });
      input.addEventListener('change', async () => {
        const f = input.files[0];
        input.value = '';
        if (!f) return;
        if (up.max_bytes && f.size > up.max_bytes) return toast(`${f.name} is too big`, true);
        status.textContent = `Uploading ${f.name}…`;
        try { const file = await ctx.uploadFile('encyclopedia', ch.entry_id, f); await use(file.id); }
        catch (err) { status.textContent = ''; toast(err.message, true); }
      });
      const findSlot = el('div', { class: 'find-slot' });
      const chosen = ch.portrait_id;
      fill(box,
        el('div', { class: 'row spread' }, el('h3', {}, 'Portrait'), button('Close', () => { box.hidden = true; }, 'small')),
        el('p', { class: 'small muted' }, 'Shown on the character\'s card, at the top of the sheet and in the Play view. Pictures added here go on its Encyclopedia entry too.'),
        pics.length ? el('div', { class: 'portrait-picks', role: 'group', 'aria-label': 'Pictures on the entry' }, pics.map((f, i) => {
          const on = chosen ? f.id === chosen : i === 0;
          return el('button', { type: 'button', class: 'portrait-pick' + (on ? ' on' : ''), 'aria-pressed': String(on), 'aria-label': `Use ${f.caption || f.name}`,
            onclick: () => { if (!on) use(f.id); } }, el('img', { src: f.url, alt: '', loading: 'lazy', referrerpolicy: f.embed ? 'no-referrer' : null }));
        })) : el('p', { class: 'small muted' }, 'No pictures yet.'),
        el('div', { class: 'row' },
          up.ready ? el('label', { class: 'button small primary file-add', 'data-tip': 'Upload a picture (JPEG, PNG, GIF, WebP) for the portrait' }, input, '📎 Upload a picture') : null,
          up.ready && ctx.findImage ? button('🖼️ Find Image', () => {
            findSlot.firstChild ? findSlot.replaceChildren() : findSlot.replaceChildren(ctx.findImage('encyclopedia', ch.entry_id, ch.name, { copyOnly: true, onAdded: file => use(file.id) }));
          }, 'small', { 'data-tip': 'Search open picture libraries and museums for a portrait, credited' }) : null,
          chosen && pics.length > 1 ? button('Use the first picture', () => use(0), 'small', { 'data-tip': 'Go back to the first picture on the Encyclopedia entry' }) : null,
          !up.ready && up.problem ? el('span', { class: 'small muted' }, up.problem) : null),
        status, findSlot);
    }
    box.toggle = () => { box.hidden = !box.hidden; if (!box.hidden) { fill(box, el('p', { class: 'small muted' }, 'Loading…')); load(); } };
    return box;
  }
  async function renderCharacter(id, play = false) {
    stopPresence();
    const r = await ctx.api('character', { query: { cid: cid(), id } });
    const ch = r.character;
    const mine = ch.owner?.id === me();
    const gmOnOthers = ch.can_edit && !mine;   // a GM on a sheet that isn't theirs presses Edit first
    let editing = false;
    const values = ch.values ? { ...ch.values } : {};
    let hidden = ch.hidden || [];
    let caps = ch.pip_caps || {};
    let capping = false;   // Track maximums is open: a Max picker under each dot/box track
    const hasTracks = [...L.fields(ch.layout).values()].some(x => x.field.type === 'pips');
    let openPage = null;   // the sheet's open page, kept when it is drawn again
    // a refused or failed save: say why, and draw the sheet again from the server (a GM whose Edit ran out is back to reading)
    const sender = fieldSender(ch.id, err => {
      toast(err.message, true);
      if (presence) presence.editing = false;
      if (location.hash.startsWith(`#/c/${cid()}/characters/${ch.id}`)) ctx.route();
    });
    for (const [k, v] of Object.entries(values)) sender.known(k, v);
    const bar = viewersBar();
    const body = el('div');
    const imports = importPanel(ch);
    const href = `#/c/${cid()}/characters/${ch.id}`;
    const editBtn = gmOnOthers ? button('Edit', async () => {
      editing = !editing;
      if (presence) { presence.editing = editing; await presence.check(); }
      draw();
    }, 'small') : null;
    let form = null;
    const capsBtn = ch.can_edit && !play && hasTracks && ch.sheet_visible ? button('Track maximums', () => { capping = !capping; draw(); }, 'small',
      { 'aria-pressed': 'false', 'data-tip': 'Set how many dots or boxes of each track this character has, such as 3 of 6 Damage boxes' }) : null;

    async function save(changes) {
      try {
        const res = await ctx.post('character_save', { id: ch.id, version: ch.version, ...changes }, cid());
        Object.assign(ch, res.character);
        if ('hidden' in changes) hidden = changes.hidden;
        if ('pip_caps' in changes) {
          caps = ch.pip_caps || {};
          // a track ticked past its new maximum came down to it
          for (const k of Object.keys(changes.pip_caps)) if (ch.values && k in ch.values) { values[k] = ch.values[k]; sender.known(k, values[k]); }
        }
        if ('name' in changes || 'kind' in changes || 'owner_id' in changes || 'party' in changes) return ctx.route();
        draw();
      } catch (err) {
        toast(err.message, true);
        if (err.status === 409) ctx.route();
      }
    }
    const canChange = () => mine || (gmOnOthers && editing);
    // its player and the GMs roll from it on the dice roller, named for the character (the log already names the
    // roller's active character as who rolled)
    const playing = () => Number(ctx.S.members?.find(m => Number(m.id) === me())?.active_character_id) === ch.id;
    const rollHere = ctx.rollFromSheet && (mine || ch.can_edit)
      ? x => ctx.rollFromSheet({ ...x, label: playing() ? x.label : `${ch.name}: ${x.label}` }) : null;
    function draw() {
      if (editBtn) { editBtn.textContent = editing ? 'Done' : 'Edit'; editBtn.className = editing ? 'small primary' : 'small'; }
      if (!ch.sheet_visible) return body.replaceChildren(el('p', { class: 'muted' }, 'The GM hasn\'t shown this sheet to players.'));
      if (capsBtn) capsBtn.setAttribute('aria-pressed', String(capping));
      if (play) return body.replaceChildren(playView(ch, values, canChange(), (k, v) => sender.send(k, v), rollHere, caps));
      form = renderSheetForm(ch.layout, values, {
        mode: canChange() ? 'edit' : 'view', hidden, canHide: mine, page: openPage, onPage: p => { openPage = p; },
        onChange: (k, v) => sender.send(k, v),
        onHide: (k, on) => save({ hidden: on ? [...new Set([...hidden, k])] : hidden.filter(x => x !== k) }),
        onRoll: rollHere, caps,
        onCap: capping ? (k, n) => save({ pip_caps: { [k]: n } }) : null,
      });
      fill(body,
        ch.can_edit ? settingsStrip(ch, mine, save) : null,
        // Track maximums lives in the ⋯ menu, so the way out of it is a Done right on the notice, not back in the menu
        capping ? el('div', { class: 'notice sheet-caps-note row spread' }, el('span', {}, `Pick how many of each dot or box track ${ch.name} has. The rest are greyed out on the sheet and can't be ticked.`),
          button('Done', () => { capping = false; draw(); }, 'small primary', { 'data-tip': 'Finished setting the maximums' })) : null,
        form,
        ch.old?.length ? el('div', { class: 'card sheet-old' }, el('h3', {}, 'Old fields'),
          el('p', { class: 'small muted' }, 'Values the template no longer has a place for. They are kept, so nothing is lost.'),
          el('dl', {}, ch.old.map(o => [el('dt', {}, o.key.replace(/~old\d*$/, ' (before)')), el('dd', {}, typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value))]))) : null);
    }
    draw();
    const links = el('div', { class: 'row' },
      el('a', { href: `#/c/${cid()}/characters`, class: 'small' }, '← Characters'),
      play ? el('a', { href, class: 'small' }, 'Full sheet') : (ch.sheet_visible ? el('a', { href: `${href}/play`, class: 'small' }, 'Play view') : null),
      el('a', { href: `#/c/${cid()}/encyclopedia/${ch.entry_id}`, class: 'small' }, 'Encyclopedia entry'));
    // the portrait beside the name: its player and the GMs tap it to pick or upload one
    const portraits = ch.can_edit ? portraitPanel(ch, () => face.replaceChildren(portrait(ch, 'big'), el('span', { class: 'portrait-edit', 'aria-hidden': 'true' }, '✎'))) : null;
    const face = ch.can_edit
      ? button([portrait(ch, 'big'), el('span', { class: 'portrait-edit', 'aria-hidden': 'true' }, '✎')], () => portraits.toggle(), 'sheet-portrait',
        { 'aria-label': ch.pic ? 'Change the portrait' : 'Add a portrait', 'data-tip': ch.pic ? 'Change the portrait' : 'Add a portrait: upload one, or pick a picture on the Encyclopedia entry' })
      : el('div', { class: 'sheet-portrait' }, portrait(ch, 'big'));
    ctx.mount(...ctx.campaignHeader('characters'),
      el('div', { class: `card sheet-page${play ? ' play-page' : ''}` }, links,
        el('div', { class: 'sheet-head' }, face, el('div', { class: 'sheet-head-main' },
        // Edit is the everyday press; the maximums, an import and Delete wait in the shared ⋯ (KIT.menu)
        el('div', { class: 'row spread' }, el('h1', {}, ch.name), el('div', { class: 'row' }, editBtn, (() => {
          const more = KIT.menu({ label: '⋯', ariaLabel: `More for ${ch.name}`, tip: 'More: the maximums, an import, delete', cls: 'more-menu', items: [capsBtn,
            ch.can_edit && !play ? button('Import', () => { imports.hidden = !imports.hidden; }, 'small', { 'data-tip': 'Fill this sheet from Pathbuilder 2e or D&D Beyond' }) : null,
            el('hr'),
            ch.can_edit ? button('Delete character', async () => {
              if (!await confirmDialog(`Delete ${ch.name}'s sheet? Everything filled in on it goes. The Encyclopedia entry stays.`, { ok: 'Delete', danger: true })) return;
              try {
                await ctx.post('character_delete', { id: ch.id }, cid());
                for (const m of ctx.S.members) if (Number(m.active_character_id) === ch.id) m.active_character_id = null;
                toast(`${ch.name}'s sheet is deleted`);
                location.hash = `#/c/${cid()}/characters`;
              } catch (err) { toast(err.message, true); }
            }, 'small danger', { 'data-tip': 'Delete this sheet. Its Encyclopedia entry stays' }) : null] });
          return more.querySelector('.kit-menu-list').childElementCount ? more : null;
        })())),
        el('div', { class: 'small muted' }, [kindName(ch.kind), ch.owner?.name || 'No player', ch.party_group_id ? 'In the party' : ch.owner_is_player && ch.party_out ? 'Out of the party' : null, `${ch.template.name} (${ch.template.game})`].filter(Boolean).join(' · ')),
        summaryLine(ch))),
        portraits,
        r.template_changed ? el('p', { class: 'notice' }, 'This sheet\'s template has changed since it was last opened. Anything that no longer fits is under Old fields.') : null,
        bar, imports, body));
    if (!location.hash.startsWith(href)) return;   // left while it loaded
    startPresence(ch, {
      editing,
      onViewers: bar.show,
      onChanges: changes => {
        let redraw = false;
        for (const [k, { value, by }] of Object.entries(changes)) {
          if (sender.pending(k)) continue;   // this page's own newer value is on its way
          sender.known(k, value);
          if (form && !play && form.typing(k)) {
            if (JSON.stringify(values[k]) !== JSON.stringify(value)) form.conflict(k, value, by, v => sender.send(k, v));
          } else if (form && !play) form.setValue(k, value);
          else { values[k] = value; redraw = true; }
        }
        if (redraw) draw();
      },
    });
  }

  /** Only the Play fields, for a phone at the table: big + and − on counters, tappable pips, toggles. Each tap shows
   * and sends the new value at once. */
  function playView(ch, values, can, send, roll = null, caps = {}) {
    const fields = L.fields(ch.layout);
    const playFields = [...fields.values()].map(x => x.field).filter(f => f.play);
    if (!playFields.length) return el('p', { class: 'muted' }, 'This template has no Play fields. Its author can mark fields Play in the template editor.');
    const set = (k, v) => { values[k] = v; send(k, v); };
    return el('div', { class: 'play-grid' }, playFields.map(f => {
      if (f.type === 'counter') {
        const box = el('div', { class: 'play-counter' });
        const draw = () => {
          const v = values[f.key] || {}, cur = Number(v.cur) || 0, max = v.max ?? null;
          const pct = max ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
          const step = by => { set(f.key, { cur: cur + by, max }); draw(); };
          fill(box, el('div', { class: 'play-label' }, f.label),
            el('div', { class: 'play-row' },
              button('−', () => step(-1), 'play-btn', { 'aria-label': `${f.label} down one`, disabled: !can }),
              el('div', { class: 'play-value' }, `${cur}${max !== null ? ` / ${max}` : ''}`),
              button('+', () => step(1), 'play-btn', { 'aria-label': `${f.label} up one`, disabled: !can })),
            max ? el('div', { class: 'stat-bar big' }, el('span', { style: { width: `${pct}%` } })) : null);
        };
        draw();
        return box;
      }
      if (f.type === 'checkbox') {
        const t = button(f.label, () => { set(f.key, !values[f.key]); t.setAttribute('aria-pressed', String(!!values[f.key])); t.classList.toggle('on', !!values[f.key]); },
          'play-toggle' + (values[f.key] ? ' on' : ''), { 'aria-pressed': String(!!values[f.key]), disabled: !can });
        return t;
      }
      const die = roll ? rollButton(f, () => values[f.key], roll) : null;
      return el('div', { class: 'play-other' }, el('div', { class: 'play-label' }, f.label, die),
        control(f, values[f.key], v => { set(f.key, v); die?.update(); }, !can, true, roll, caps[f.key]));
    }));
  }

  /** #/c/<cid>/characters[/<id>[/play]] */
  async function campaignRoute(parts) {
    const [id, sub] = parts;
    if (id && /^\d+$/.test(id)) return renderCharacter(Number(id), sub === 'play');
    return renderCharacters();
  }

  /** #/templates[/new | /<id> | /<id>/edit] */
  async function route(parts) {
    const [a, b] = parts;
    if (!a) return renderLibrary();
    if (a === 'new') return renderEditor(null);
    if (/^\d+$/.test(a) && b === 'edit') return renderEditor(Number(a));
    if (/^\d+$/.test(a)) return renderTemplate(Number(a));
    return renderLibrary();
  }

  return { mount, route, campaignRoute, newCharacter, renderLibrary, renderTemplate, renderEditor, renderSheetForm, renderCharacters, renderCharacter, addToEntry, linkMember, linkToMember, templatePick, closePdf, stopPresence };
})();
