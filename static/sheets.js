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
  const { el, toast, confirmDialog } = KIT;
  const L = SheetLayout;
  let ctx = null;
  /** app.js's helpers: { S, api, post, mount, field }. */
  function mount(c) { ctx = c; }

  const TYPE_NAMES = { text: 'Text', longtext: 'Long text', number: 'Number', counter: 'Counter (current / max)', pips: 'Pips (dots or boxes)',
    checkbox: 'Checkbox', choice: 'Choice from a list', list: 'List (rows and columns)' };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const button = (label, onclick, cls, attrs = {}) => el('button', { type: 'button', class: cls || '', onclick, ...attrs }, label);

  // ------------------------------------------------------------ the PDF open in the editor
  let openDoc = null;
  function closePdf() {
    if (openDoc) PdfImport.close(openDoc);
    openDoc = null;
  }
  // leaving the editor lets go of the PDF: it was never saved, so it is gone
  window.addEventListener('hashchange', () => { if (!/^#\/templates\/(new|\d+\/edit)$/.test(location.hash)) closePdf(); });

  // ------------------------------------------------------------ a sheet drawn from a layout
  /** A sheet: layout's sections and fields with values (by key). opts: { mode: 'edit'|'view'|'preview', hidden: keys
   * hidden from the party, canHide, onChange(key, value), onHide(key, hidden) }. 'view' can't be changed; 'preview'
   * can be tried out but saves nothing. */
  function renderSheetForm(layout, values = {}, opts = {}) {
    const mode = opts.mode || 'preview', off = mode === 'view';
    const hidden = new Set(opts.hidden || []);
    const change = (k, v) => { values[k] = v; opts.onChange?.(k, v); };
    const eye = (key, what) => opts.canHide ? button(hidden.has(key) ? '🙈' : '👁', () => opts.onHide?.(key, !hidden.has(key)), 'icon-btn sheet-eye',
      { 'aria-pressed': String(hidden.has(key)), 'aria-label': hidden.has(key) ? `Show ${what} to the party` : `Hide ${what} from the party`,
        'data-tip': hidden.has(key) ? 'Hidden from the rest of the party. Tap to show it' : 'Seen by the party. Tap to hide it' }) : null;
    const sections = (layout?.sections || []).map(s => el('section', { class: 'sheet-sec' + (hidden.has(s.key) ? ' is-hidden' : ''), 'data-key': s.key },
      el('div', { class: 'sheet-sec-head' }, el('h3', {}, s.title || ''), eye(s.key, `the ${s.title} section`)),
      el('div', { class: 'sheet-fields' }, (s.fields || []).map(f => {
        if (!TYPE_NAMES[f.type]) return null;
        const wide = f.type === 'longtext' || f.type === 'list';
        return el('div', { class: `sheet-field sheet-${f.type}` + (wide ? ' wide' : '') + (hidden.has(f.key) ? ' is-hidden' : ''), 'data-key': f.key },
          el('div', { class: 'sheet-label' }, el('span', {}, f.label), eye(f.key, f.label)),
          control(f, values[f.key], v => change(f.key, v), off));
      }))));
    return el('div', { class: `sheet-form sheet-${mode}` }, sections);
  }
  const numOrNull = s => (String(s).trim() === '' ? null : Number(s));
  /** The input for one field, sending the new value to set(v) as it changes. */
  function control(f, value, set, off) {
    const label = f.label;
    if (f.type === 'text') {
      const i = el('input', { value: value ?? '', maxlength: L.LIMITS.text, 'aria-label': label, disabled: off });
      i.addEventListener('change', () => set(i.value === '' ? null : i.value));
      return i;
    }
    if (f.type === 'longtext') {
      const t = el('textarea', { rows: 4, maxlength: L.LIMITS.longtext, 'aria-label': label, disabled: off });
      t.value = value ?? '';
      t.addEventListener('change', () => set(t.value === '' ? null : t.value));
      return t;
    }
    if (f.type === 'number') {
      const i = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: value ?? '', min: f.min ?? null, max: f.max ?? null, 'aria-label': label, disabled: off });
      i.addEventListener('change', () => set(numOrNull(i.value)));
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
      const n = Math.max(1, Math.min(L.LIMITS.pips, Number(f.count) || 1));
      let filled = Number(value) || 0;
      const box = el('div', { class: 'sheet-pips', role: 'group', 'aria-label': label });
      const draw = () => box.replaceChildren(...Array.from({ length: n }, (_, i) =>
        button('', () => { filled = filled === i + 1 ? i : i + 1; draw(); set(filled); }, 'sheet-pip' + (i < filled ? ' on' : ''),
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
      const s = el('select', { 'aria-label': label, disabled: off }, el('option', { value: '' }, '—'),
        (f.options || []).map(o => el('option', { value: o, selected: o === value }, o)));
      s.addEventListener('change', () => set(s.value === '' ? null : s.value));
      return s;
    }
    // list: rows of the field's columns
    const cols = f.columns || [];
    let rows = Array.isArray(value) ? value.map(r => ({ ...r })) : [];
    const table = el('div', { class: 'sheet-list' });
    const send = () => set(rows.filter(r => cols.some(c => String(r[c.key] ?? '').trim() !== '')));
    const draw = () => table.replaceChildren(
      el('table', { class: 'tbl' }, el('tr', {}, cols.map(c => el('th', {}, c.label)), off ? null : el('th', {})),
        rows.map((r, ri) => el('tr', {}, cols.map(c => {
          const i = el('input', { value: r[c.key] ?? '', maxlength: L.LIMITS.text, 'aria-label': `${label} row ${ri + 1} ${c.label}`, disabled: off });
          i.addEventListener('change', () => { r[c.key] = i.value; send(); });
          return el('td', {}, i);
        }), off ? null : el('td', {}, button('×', () => { rows.splice(ri, 1); draw(); send(); }, 'icon-btn', { 'aria-label': `Remove row ${ri + 1}` }))))),
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
  function card(t) {
    return el('div', { class: 'card template-card' },
      el('div', { class: 'row spread' }, el('a', { href: `#/templates/${t.id}`, class: 'template-name' }, t.name), t.is_listed ? null : el('span', { class: 'small muted' }, 'Unlisted')),
      el('div', { class: 'small' }, metaLine(t)),
      el('div', { class: 'small muted' }, `by ${t.author} · Used by ${t.uses} · ${plural(t.forks, 'fork')}`),
      forkLine(t), actions(t));
  }
  async function renderLibrary() {
    closePdf();
    const list = el('div', { class: 'template-grid' });
    const search = el('input', { type: 'search', placeholder: 'Name or game', 'aria-label': 'Search templates' });
    let seq = 0, timer = 0;
    const load = async () => {
      const n = ++seq;
      const { templates } = await ctx.api('templates', { query: search.value.trim() ? { q: search.value.trim() } : {} });
      if (n !== seq) return;
      list.replaceChildren(...(templates.length ? templates.map(card) : [el('p', { class: 'muted' }, search.value ? 'No template matches that.' : 'No templates yet.')]));
    };
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(err => toast(err.message, true)), 250); });
    ctx.mount(el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h1', {}, 'Sheet templates'), button('+ New template', () => (location.hash = '#/templates/new'), 'primary')),
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
    let previewTimer = 0;
    const refresh = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        preview.replaceChildren(el('h2', {}, 'Preview'), renderSheetForm(layout, {}, { mode: 'preview' }));
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
        text.value = (isList ? (f.columns || []).map(c => c.label) : f.options || []).join('\n');
        text.addEventListener('input', () => {
          const lines = [...new Set(text.value.split('\n').map(s => s.trim()).filter(Boolean))];
          if (!isList) f.options = lines;
          else {
            // a column keeps its key while its label stays, so rows already filled in keep their values
            const old = new Map((f.columns || []).map(c => [c.label, c.key])), taken = new Set();
            f.columns = lines.map(label => {
              const key = old.get(label) && !taken.has(old.get(label)) ? old.get(label) : L.newKey(label, taken);
              taken.add(key);
              return { key, label };
            });
          }
          refresh();
        });
        return el('label', { class: 'field' }, el('span', { class: 'lbl' }, isList ? 'Columns, one per line' : 'Options, one per line'), text);
      }
      return null;
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
        if (f.type === 'pips') f.count = 3;
        if (f.type === 'choice') f.options = [];
        if (f.type === 'list') f.columns = [];
        settings.replaceChildren(...[typeSettings(f)].filter(Boolean));
        refresh();
      });
      const flag = (k, text, tipText) => {
        const c = el('input', { type: 'checkbox', checked: !!f[k] });
        c.addEventListener('change', () => { if (c.checked) f[k] = true; else delete f[k]; refresh(); });
        return el('label', { class: 'small check', 'data-tip': tipText }, c, ` ${text}`);
      };
      const settings = el('div', { class: 'sheet-ed-settings' }, typeSettings(f));
      row.append(el('div', { class: 'sheet-ed-side' }, handle,
          button('×', () => { s.fields.splice(i, 1); fresh.delete(f.key); draw(); }, 'icon-btn', { 'aria-label': `Remove ${f.label}`, 'data-tip': 'Remove this field' })),
        el('div', { class: 'sheet-ed-main' },
          el('div', { class: 'row' }, label, type,
            flag('play', 'Play view', 'Shown on the Play view, for tracking at the table'),
            flag('summary', 'Summary', 'Shown on the character\'s card and Encyclopedia entry')),
          settings));
      return row;
    }
    function draw() {
      list.replaceChildren(...layout.sections.map((s, si) => {
        const title = el('input', { value: s.title, maxlength: L.LIMITS.label, 'aria-label': 'Section title' });
        const sec = el('div', { class: 'sheet-ed-section', 'data-key': s.key });
        title.addEventListener('input', () => {
          s.title = title.value;
          if (fresh.has(s.key)) { freshKey(s, title.value || 'section'); sec.dataset.key = s.key; }
          refresh();
        });
        sec.append(
          el('div', { class: 'row sheet-ed-sec-head' }, title,
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
        el('div', { class: 'card sheet-ed-pane' }, list,
          el('div', { class: 'row' }, button('Add section', () => { addSection(); draw(); }, 'small'), save)),
        el('div', { class: 'card sheet-ed-preview' }, preview)));
    draw();
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

  return { mount, route, renderLibrary, renderTemplate, renderEditor, renderSheetForm, closePdf };
})();
