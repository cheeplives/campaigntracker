/* economy-tab.js — the Economy tab (under World): how the campaign pays for things, and what that comes to.
 *
 * Four halves. Price book: what things cost in coins, barter, wealth or a favour, where the party is, with the
 * shifts that change prices by region and "Can the party afford it?". Ledger: what the party gained, spent, owed
 * and repaid, by in-game day, with its funds, trade goods, wealth and regular costs down the side. Favours: who owes
 * whom. Setup (GMs): the ways to pay, a few everyday prices, and a price book from a CSV file.
 *
 * The sums are in static/economy.js; api/economy.php says who sees and changes what. app.js calls make() once with
 * its shared helpers and state (tabCtx). Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { E, S, api, btn, busy, cal, campaignHeader, clean, confirmDialog, el, field, hideTip, isGM, mount, post, promptDialog, secretTag, select, settings, tip, toast, today } = ctx;
    const X = root.Economy;

    const HALVES = [['', 'Price book', 'What things cost, where the party is'], ['ledger', 'Ledger', 'What the party gained, spent, owed and repaid, day by day'],
      ['favours', 'Favours', 'Who owes the party, and whom the party owes'], ['setup', 'Setup', 'How this campaign pays for things: coins, barter, wealth, favours']];
    const href = half => `#/c/${S.camp.id}/economy${half ? `/${half}` : ''}`;
    const canWrite = () => !S.viewAs;
    const gm = () => isGM() && !S.viewAs;
    const on = k => !!D.config[k]?.on;
    const day = d => E.fmtDate(cal(), d, { noWeekday: true });
    const levels = () => D.config.wealth?.levels || [];
    const levelWord = n => (n === null || n === undefined ? '' : `${n} ${levels()[n] || ''}`.trim());
    const st = { find: '', category: '', region: undefined, picked: null, allShifts: false, kind: 'all', step: 1 };
    let D = null;                    // what the 'economy' action answered
    let redraw = () => {};           // draws the half that is open again, from D

    const load = async () => { D = await api('economy', { query: { cid: S.camp.id } }); return D; };
    const reload = async () => { await load(); redraw(); };
    const badge = (text, cls) => el('span', { class: `econ-badge${cls ? ` ${cls}` : ''}` }, text);
    const availBadge = a => badge(X.availLabel(a), a === 'none' ? 'bad' : '');

    /** The bar across the top of each half: its sub-tabs, then the half's own buttons. */
    function head(at, ...actions) {
      return el('div', { class: 'row evhead party-head econ-head' },
        el('nav', { class: 'subtabs', 'aria-label': 'Economy' }, HALVES.filter(([k]) => k !== 'setup' || gm()).map(([k, l, t]) =>
          el('a', { href: href(k), class: k === at ? 'on' : '', 'aria-current': k === at ? 'page' : null, 'data-tip': t }, l))),
        actions.some(Boolean) ? el('div', { class: 'row evhead-actions' }, ...clean(actions)) : null);
    }
    /** The card a half shows before the GM has set the economy up. */
    const notSetUp = () => el('section', { class: 'card econ-empty' }, el('h2', {}, 'Economy'),
      el('p', {}, gm() ? 'Nothing is set up yet. Pick how this campaign pays for things (coins, barter, a wealth level, favours, or any mix), then fill in a few everyday prices.'
        : 'The GM hasn\'t set up this campaign\'s economy yet. Once they have, the price book, the party\'s ledger and its favours show here.'),
      gm() ? el('div', { class: 'row card-foot' }, el('a', { class: 'button primary', href: href('setup') }, 'Set up the economy')) : null);

    // ------------------------------------------------------------ dialogs
    /** A form in a dialog. rows: what goes in it; save(bad): does the saving, calling bad(message, box) to refuse and
     * returning a value to resolve with. Resolves null when closed. */
    function formDialog(title, rows, { ok = 'Save', cls = '', danger = null } = {}, save) {
      hideTip();
      return new Promise(resolve => {
        const err = el('p', { class: 'bad small', hidden: true, role: 'alert' });
        const go = el('button', { class: 'primary', type: 'submit' }, ok);
        const d = el('dialog', { class: `kit-dialog econ-dialog ${cls}`, 'aria-label': title },
          el('form', { novalidate: true }, el('h3', {}, title), ...clean(rows), err,
            el('div', { class: 'kit-dialog-actions' }, go, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), danger)));
        let result = null;
        d.addEventListener('close', () => { d.remove(); resolve(result); });
        d.querySelector('form').addEventListener('submit', busy(go, async ev => {
          ev.preventDefault();
          err.hidden = true;
          let refused = false;
          const bad = (msg, box) => { refused = true; err.textContent = msg; err.hidden = false; box?.focus(); };
          try {
            const r = await save(bad, ev.submitter);
            if (refused) return;
            result = r ?? true;
            if (!d.dataset.keep) d.close(); else delete d.dataset.keep;
          } catch (e) { bad(e.message); }
        }));
        document.body.append(d);
        d.showModal();
        (d.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea') || go).focus();
      });
    }
    /** A box for an in-game day, written as the calendar writes it. read() gives the day, or null when it can't be read. */
    function dayBox(d) {
      const box = el('input', { value: d === null || d === undefined ? '' : day(d), placeholder: day(today()), autocomplete: 'off' });
      box.read = () => (box.value.trim() === '' ? undefined : E.parseDate(cal(), box.value, today()));
      return box;
    }
    /** A row of choices, one picked: returns the group and value(). */
    function pick(label, options, value) {
      const name = `econ-${label.replace(/\W+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
      const g = el('div', { class: 'econ-pick', role: 'radiogroup', 'aria-label': label }, options.map(([k, l, t]) =>
        el('label', { 'data-tip': t || null }, el('input', { type: 'radio', name, value: k, checked: String(k) === String(value) }), el('span', {}, l))));
      g.value = () => g.querySelector('input:checked')?.value ?? null;
      return g;
    }
    const wealthSelect = (value, none = 'None') => select([['', none], ...levels().map((l, i) => [i, `${i} ${l}`])], value ?? '', { 'aria-label': 'Wealth level' });

    // ------------------------------------------------------------ Setup
    function setupPage() {
      const c = JSON.parse(JSON.stringify(D.config));
      const steps = [[1, 'How things are paid for'], [2, 'Everyday prices'], [3, 'Price book']];
      const stepper = el('ol', { class: 'econ-steps' }, steps.map(([n, l]) => el('li', {},
        el('button', { type: 'button', class: st.step === n ? 'on' : '', 'aria-current': st.step === n ? 'step' : null, disabled: n > 1 && !D.config.set,
          onclick: () => { st.step = n; redraw(); } }, `${n} ${l}`))));
      const body = st.step === 1 || !D.config.set ? setupWays(c) : st.step === 2 ? setupEveryday() : setupBook();
      return el('section', { class: 'econ-page econ-setup' }, el('h2', {}, 'Set up the economy'), stepper, body);
    }
    /** Step 1: the four ways to pay, each turned on or off, with what it needs. Saved together. */
    function setupWays(c) {
      const way = (k, title, what, ...kids) => {
        const card = el('section', { class: 'card econ-way' + (c[k].on ? ' on' : ''), 'data-way': k });
        const toggle = el('input', { type: 'checkbox', checked: !!c[k].on, 'aria-label': `Use ${title.toLowerCase()}` });
        toggle.addEventListener('change', () => { c[k].on = toggle.checked; card.classList.toggle('on', toggle.checked); });
        card.append(el('div', { class: 'row spread' }, el('h3', {}, title), el('label', { class: 'check-row' }, toggle, el('span', { class: 'lbl' }, 'On'))),
          el('p', { class: 'small muted' }, what), ...clean(kids));
        return card;
      };
      const line = (cols, row, placeholders, remove) => el('div', { class: `econ-line cols-${cols.length}` }, cols.map((f, i) => {
        const box = el('input', { value: row[f] ?? '', placeholder: placeholders[i], 'aria-label': placeholders[i], maxlength: f === 'abbr' ? 12 : 200 });
        box.addEventListener('input', () => { row[f] = box.value; });
        return box;
      }), el('button', { type: 'button', class: 'link danger', 'aria-label': 'Remove this line', onclick: remove }, '✕'));
      const list = (rows, cols, placeholders, addLabel, blank) => {
        const box = el('div', { class: 'econ-lines' });
        const draw = () => box.replaceChildren(...rows.map((r, i) => line(cols, r, placeholders, () => { rows.splice(i, 1); draw(); })),
          el('div', { class: 'row' }, btn(addLabel, () => { rows.push(blank()); draw(); box.querySelector('.econ-line:last-of-type input')?.focus(); }, 'small')));
        draw();
        return box;
      };
      const baseName = el('input', { value: c.coins.base.name, maxlength: 60, placeholder: 'e.g. Silver mark' });
      const baseAbbr = el('input', { value: c.coins.base.abbr, maxlength: 12, placeholder: 'e.g. sm' });
      baseName.addEventListener('input', () => { c.coins.base.name = baseName.value; });
      baseAbbr.addEventListener('input', () => { c.coins.base.abbr = baseAbbr.value; });
      const unit = el('input', { value: c.barter.unit, maxlength: 60, placeholder: 'e.g. Day\'s food' });
      unit.addEventListener('input', () => { c.barter.unit = unit.value; });
      if (!c.wealth.levels.length) c.wealth.levels = ['Destitute', 'Poor', 'Modest', 'Comfortable', 'Rich', 'Noble'];
      const lv = el('textarea', { rows: 6, 'aria-label': 'Wealth levels, lowest first' }, c.wealth.levels.join('\n'));
      lv.addEventListener('input', () => { c.wealth.levels = lv.value.split('\n').map(s => s.trim()).filter(Boolean); });
      const save = btn(D.config.set ? 'Save' : 'Save and go on', null, 'primary');
      save.addEventListener('click', busy(save, async () => {
        const first = !D.config.set;
        const r = await post('economy_config_save', { config: c }, S.camp.id);
        D.config = r.config; D.items = r.items;
        toast('Saved');
        if (first) st.step = 2;
        redraw();
      }));
      return el('div', { class: 'econ-ways-wrap' },
        el('p', { class: 'muted' }, 'Turn on any mix. A price can then be given in each one that is on, and the ledger keeps track of each.'),
        el('div', { class: 'econ-ways' },
          way('coins', 'Coins', 'Money, in your world\'s own coins. Every price is kept in the main coin; the others are worth so many of it.',
            el('div', { class: 'grid2' }, field('Main coin', baseName), field('Short name', baseAbbr, 'Written after a price: 2 sm')),
            el('span', { class: 'lbl' }, 'Other coins'),
            list(c.coins.units, ['name', 'abbr', 'worth'], ['Coin, e.g. Gold crown', 'Short', 'Worth in main coins'], '+ Coin', () => ({ name: '', abbr: '', worth: '' }))),
          way('barter', 'Barter', 'No money: goods are swapped. Pick the good everything is measured in, then what the other trade goods are worth in it. The party\'s stock is counted from Gear and Loot.',
            field('Measured in', unit, 'A good everyone wants: a day\'s food, a round of ammunition, a litre of fuel'),
            el('span', { class: 'lbl' }, 'Other trade goods'),
            list(c.barter.goods, ['name', 'worth'], ['Good, e.g. Lamp oil, flask', 'Worth'], '+ Trade good', () => ({ name: '', worth: '' }))),
          way('wealth', 'Wealth', 'A level instead of a purse. A thing has a level too: at or under a character\'s own it is within their means. The app keeps the levels and their changes; any roll is yours.',
            field('Levels, lowest first, one a line', lv)),
          way('favours', 'Favours', 'What is owed between people: a favour is small, significant or major, with a note of what it was for, and stays open until it is called in, repaid or forgiven.')),
        el('div', { class: 'row econ-foot' }, save));
    }
    /** Step 2: the everyday prices, a row each, saved as each box is left. */
    function setupEveryday() {
      const rows = el('div', { class: 'econ-every' });
      const cols = clean(['Item', on('coins') ? 'Coins' : null, on('barter') ? `Barter (${D.config.barter.unit})` : null, on('wealth') ? 'Wealth level' : null, '']);
      rows.style.setProperty('--econ-cols', String(cols.length - 2));
      const row = it => {
        const name = el('input', { value: it.name, maxlength: 200, 'aria-label': 'Item' });
        const coin = on('coins') ? el('input', { value: X.fmtCoins(D.config, it.coin_cost), 'aria-label': `Coins: ${it.name}`, placeholder: `e.g. 2 ${D.config.coins.base.abbr || D.config.coins.base.name}` }) : null;
        const barter = on('barter') ? el('input', { value: it.barter_cost === null ? '' : X.fmtNum(it.barter_cost), 'aria-label': `Barter: ${it.name}`, inputmode: 'decimal' }) : null;
        const wealth = on('wealth') ? wealthSelect(it.wealth_level, '') : null;
        if (wealth) wealth.setAttribute('aria-label', `Wealth level: ${it.name}`);
        const line = el('div', { class: 'econ-every-row', 'data-item': it.id });
        const save = async () => {
          const c = coin ? X.parseCoins(D.config, coin.value) : it.coin_cost, b = barter ? X.parseNum(barter.value) : it.barter_cost;
          if (Number.isNaN(c)) { toast(`"${coin.value}" isn't a price in this campaign's coins`, true); return; }
          if (Number.isNaN(b)) { toast(`"${barter.value}" isn't a number`, true); return; }
          if (!name.value.trim()) { name.value = it.name; return; }
          try {
            const r = await post('economy_item_save', { ...it, name: name.value, coin_cost: c, barter_cost: b, wealth_level: wealth ? (wealth.value === '' ? null : Number(wealth.value)) : it.wealth_level }, S.camp.id);
            Object.assign(it, r.item);
            if (coin) coin.value = X.fmtCoins(D.config, it.coin_cost);
          } catch (e) { toast(e.message, true); }
        };
        [name, coin, barter, wealth].filter(Boolean).forEach(b => b.addEventListener('change', save));
        line.append(...clean([name, coin, barter, wealth, el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${it.name}`, onclick: busy(null, async () => {
          await post('economy_item_delete', { id: it.id }, S.camp.id);
          D.items = D.items.filter(x => x.id !== it.id); line.remove();
        }) }, '✕')]));
        return line;
      };
      rows.append(el('div', { class: 'econ-every-row econ-every-head' }, cols.map(c => el('span', { class: 'lbl' }, c))), ...D.items.filter(i => i.is_everyday).map(row));
      const box = el('input', { maxlength: 200, placeholder: 'Add another everyday item, e.g. Stabling, 1 night', 'aria-label': 'New everyday item' });
      const add = btn('+ Add', null, 'small');
      add.addEventListener('click', busy(add, async () => {
        if (!box.value.trim()) { box.focus(); return; }
        const r = await post('economy_item_save', { name: box.value, is_everyday: true }, S.camp.id);
        D.items.push(r.item); rows.append(row(r.item)); box.value = ''; box.focus();
      }));
      box.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add.click(); } });
      return el('section', { class: 'card' }, el('h3', {}, 'Everyday prices'),
        el('p', { class: 'small muted' }, 'A handful of things everyone buys. Fill in what you know and leave a box empty if it can\'t be had that way. Each box saves as you leave it. These give the whole economy its feel, and a shift in a region ("food costs double in Ostland") multiplies from them.'),
        rows, el('div', { class: 'add-line' }, box, add),
        el('div', { class: 'row card-foot econ-foot' }, btn('Back', () => { st.step = 1; redraw(); }), btn('Next: price book', () => { st.step = 3; redraw(); }, 'primary')));
    }
    /** Step 3: a price book from a file, or by hand. */
    function setupBook() {
      return el('section', { class: 'card' }, el('h3', {}, 'Price book'),
        el('p', {}, `The price book has ${D.items.length} ${D.items.length === 1 ? 'item' : 'items'}. Add more one at a time on the Price book tab, or upload a list.`),
        el('p', { class: 'small muted' }, 'A list is a CSV file, which any spreadsheet program saves. Its first row names the columns: Name, Category, Coins, Barter, Wealth, Favour, Availability, Notes, Secret. Only Name is needed, and the order doesn\'t matter. An item already in the book takes the row\'s prices. Download the file below to see the columns filled in.'),
        el('div', { class: 'row card-foot econ-foot' }, btn('Back', () => { st.step = 2; redraw(); }), uploadButton(), downloadButton(),
          el('a', { class: 'button primary', href: href('') }, 'Open the price book')));
    }
    const downloadButton = () => btn('Download as CSV', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([X.itemsToCSV(D.config, D.items)], { type: 'text/csv' })), download: `${S.camp.name} price book.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }, '', 'The price book as a CSV file, to fill in with a spreadsheet program and upload again');
    /** Upload a price book…: pick a CSV file, see what was read, then add it. */
    function uploadButton() {
      const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', class: 'visually-hidden', 'aria-label': 'Price book file', tabindex: '-1' });
      file.addEventListener('change', busy(null, async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        if (f.size > 2_000_000) { toast('That file is too big for a price book (2 MB at most)', true); return; }
        const read = X.itemsFromRows(D.config, X.parseCSV(await f.text()));
        if (!read.items.length) { await ctx.alertDialog(read.skipped[0]?.why || 'No items were found in that file.', { title: 'Nothing to add' }); return; }
        if (read.items.length > 2000) { toast('At most 2000 rows at a time', true); return; }
        const known = new Set(D.items.map(i => i.name.toLowerCase()));
        const fresh = read.items.filter(i => !known.has(i.name.toLowerCase())).length;
        const went = await formDialog('Upload a price book', [
          el('p', {}, `${read.items.length} ${read.items.length === 1 ? 'item' : 'items'} read from ${f.name}: ${fresh} new, ${read.items.length - fresh} already in the book (their prices will be replaced).`),
          read.skipped.length ? el('div', { class: 'econ-skipped' }, el('p', { class: 'small' }, `${read.skipped.length} ${read.skipped.length === 1 ? 'row was' : 'rows were'} left out:`),
            el('ul', { class: 'small muted' }, read.skipped.slice(0, 8).map(s => el('li', {}, `Row ${s.line}: ${s.why}`)), read.skipped.length > 8 ? el('li', {}, `…and ${read.skipped.length - 8} more`) : null)) : null,
          el('ul', { class: 'small econ-preview' }, read.items.slice(0, 6).map(i => el('li', {}, clean([i.name, i.coin_cost !== undefined ? X.fmtCoins(D.config, i.coin_cost) : null,
            i.barter_cost !== undefined ? X.fmtBarter(D.config, i.barter_cost) : null]).join(' · '))), read.items.length > 6 ? el('li', { class: 'muted' }, `…and ${read.items.length - 6} more`) : null),
        ], { ok: `Add ${read.items.length} ${read.items.length === 1 ? 'item' : 'items'}` }, async () => post('economy_items_import', { rows: read.items }, S.camp.id));
        if (!went) return;
        D.items = went.items;
        toast(`${went.added} added, ${went.changed} changed`);
        redraw();
      }));
      return el('span', { class: 'econ-upload' }, file, btn('Upload a price book…', () => file.click(), '', 'Add items from a CSV file saved from a spreadsheet'));
    }

    // ------------------------------------------------------------ Price book
    const regionOf = () => (st.region === undefined ? (Number(settings().current_region) || null) : st.region);
    const regionName = id => (S.regions || []).find(r => r.id === id)?.name || 'Everywhere';
    const categories = () => [...new Set(D.items.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    /** New item… or Edit: the item's price each way. Resolves with the saved item, or 'deleted'. */
    function itemDialog(it = {}) {
      const name = el('input', { value: it.name || '', maxlength: 200, required: true, placeholder: 'e.g. Riding horse' });
      const cat = el('input', { value: it.category || '', maxlength: 60, list: 'econ-cats', placeholder: 'e.g. Food and drink', autocomplete: 'off' });
      const coin = on('coins') ? el('input', { value: X.fmtCoins(D.config, it.coin_cost), placeholder: `e.g. 2 ${D.config.coins.base.abbr || D.config.coins.base.name}`, autocomplete: 'off' }) : null;
      const barter = on('barter') ? el('input', { value: it.barter_cost === null || it.barter_cost === undefined ? '' : X.fmtNum(it.barter_cost), inputmode: 'decimal', autocomplete: 'off' }) : null;
      const wealth = on('wealth') ? wealthSelect(it.wealth_level) : null;
      const favour = on('favours') ? select([['', 'None'], ...X.SIZES], it.favour_size ?? '') : null;
      const avail = select(X.AVAIL.map(([k, l]) => [k, l === 'None here' ? 'None' : l]), it.availability || 'common');
      const notes = el('input', { value: it.notes || '', maxlength: 500 });
      const every = el('input', { type: 'checkbox', checked: !!it.is_everyday });
      const secret = el('input', { type: 'checkbox', checked: !!it.is_secret });
      const del = it.id ? el('button', { type: 'button', class: 'danger econ-del', onclick: busy(null, async ev => {
        if (!await confirmDialog(`Take "${it.name}" out of the price book?`, { ok: 'Delete', danger: true })) return;
        await post('economy_item_delete', { id: it.id }, S.camp.id);
        const d = ev.target.closest('dialog'); d.returnValue = 'deleted'; D.items = D.items.filter(x => x.id !== it.id); st.picked = null; d.close(); redraw();
      }) }, 'Delete') : null;
      return formDialog(it.id ? `Edit ${it.name}` : 'New item', [
        el('datalist', { id: 'econ-cats' }, categories().map(c => el('option', { value: c }))),
        el('div', { class: 'grid2' }, field('Name', name), field('Category', cat)),
        el('div', { class: 'grid2' },
          coin ? field('Price in coins', coin, `In your coins, e.g. ${X.fmtCoins(D.config, 1.5) || '2'}. Empty: can't be bought with coins`) : null,
          barter ? field(`Barter price, in ${D.config.barter.unit}`, barter, 'Empty: can\'t be bartered for') : null,
          wealth ? field('Wealth level', wealth, 'Within the means of a character at this level or above') : null,
          favour ? field('Or a favour', favour, 'The size of favour that would get it') : null,
          field('Availability', avail, 'How easy it is to find, before any shift'), field('Notes', notes)),
        el('div', { class: 'grid2' }, field('An everyday price', every, 'Listed first, and on Setup'), field('GM only', secret, 'Players don\'t see this item')),
      ], { ok: it.id ? 'Save item' : 'Add item', danger: del }, async bad => {
        if (!name.value.trim()) return bad('Name the item.', name);
        const c = coin ? X.parseCoins(D.config, coin.value) : (it.coin_cost ?? null), b = barter ? X.parseNum(barter.value) : (it.barter_cost ?? null);
        if (Number.isNaN(c) || c < 0) return bad(`"${coin.value}" isn't a price in this campaign's coins.`, coin);
        if (Number.isNaN(b) || b < 0) return bad(`"${barter.value}" isn't a number.`, barter);
        const r = await post('economy_item_save', { id: it.id, name: name.value, category: cat.value, coin_cost: c, barter_cost: b,
          wealth_level: wealth ? (wealth.value === '' ? null : Number(wealth.value)) : (it.wealth_level ?? null),
          favour_size: favour ? (favour.value === '' ? null : Number(favour.value)) : (it.favour_size ?? null),
          availability: avail.value, notes: notes.value, is_everyday: every.checked, is_secret: secret.checked }, S.camp.id);
        const at = D.items.findIndex(x => x.id === r.item.id);
        if (at >= 0) D.items[at] = r.item; else D.items.push(r.item);
        st.picked = r.item.id;
        toast(it.id ? 'Item saved' : 'Item added');
        return r.item;
      });
    }
    /** New shift… or Edit: where, what, by how much, why and until when. */
    function shiftDialog(s = {}) {
      const region = select([['', 'Everywhere'], ...(S.regions || []).map(r => [r.id, r.name])], s.id ? (s.region_id ?? '') : (regionOf() ?? ''));
      const what = el('select', {}, el('option', { value: '' }, 'Everything'),
        categories().length ? el('optgroup', { label: 'A category' }, categories().map(c => el('option', { value: `c:${c}`, selected: !s.item_id && s.category === c }, c))) : null,
        el('optgroup', { label: 'One item' }, D.items.map(i => el('option', { value: `i:${i.id}`, selected: s.item_id === i.id }, i.name))));
      const mult = el('input', { type: 'number', min: 0, max: 1000, step: 'any', value: s.multiplier ?? 1, inputmode: 'decimal' });
      const avail = select([['', 'No change'], ...X.AVAIL.map(([k, l]) => [k, l === 'None here' ? 'None to be had' : l])], s.availability || '');
      const reason = el('input', { value: s.reason || '', maxlength: 200, placeholder: 'e.g. Winter famine' });
      const until = dayBox(s.until_day);
      return formDialog(s.id ? 'Edit shift' : 'New shift', [
        el('p', { class: 'small muted' }, 'A shift changes prices or how easy things are to find in a region, for as long as it lasts.'),
        el('div', { class: 'grid2' }, field('Where', region), field('What', what)),
        el('div', { class: 'grid2' }, field('Prices times', mult, '1.5 is half as much again; 0.5 is half price; 1 leaves prices alone'), field('Availability', avail)),
        el('div', { class: 'grid2' }, field('Why', reason), field('Lasts until', until, `A date as the calendar writes it, e.g. ${day(today() + 30)}. Empty: until you remove it`)),
      ], { ok: s.id ? 'Save shift' : 'Add shift' }, async bad => {
        const u = until.read();
        if (u === null) return bad('That date can\'t be read. Write it like ' + day(today()) + '.', until);
        const m = Number(mult.value);
        if (!Number.isFinite(m) || m < 0) return bad('Prices times a number, 0 or more.', mult);
        const r = await post('economy_shift_save', { id: s.id, region_id: region.value ? Number(region.value) : null, item_id: what.value.startsWith('i:') ? Number(what.value.slice(2)) : null,
          category: what.value.startsWith('c:') ? what.value.slice(2) : '', multiplier: m, availability: avail.value, reason: reason.value, until_day: u ?? null }, S.camp.id);
        const at = D.shifts.findIndex(x => x.id === r.shift.id);
        if (at >= 0) D.shifts[at] = r.shift; else D.shifts.push(r.shift);
        toast('Shift saved');
        return r.shift;
      });
    }
    /** The shifts card beside the price book: the ones at work in the region picked, or all of them. */
    function shiftsCard() {
      const rid = regionOf();
      const live = s => s.until_day === null || s.until_day >= D.today;
      const here = D.shifts.filter(s => live(s) && (s.region_id === null || s.region_id === rid));
      const list = st.allShifts ? D.shifts : here;
      const row = s => el('div', { class: 'econ-shift' + (live(s) ? '' : ' ended'), 'data-shift': s.id },
        el('div', {}, el('strong', {}, X.shiftWords(s, D.items)),
          el('div', { class: 'small muted' }, clean([st.allShifts || s.region_id === null ? regionName(s.region_id) : null, s.reason || null,
            s.until_day === null ? 'no end set' : live(s) ? `until ${day(s.until_day)}` : `ended ${day(s.until_day)}`]).join(' · '))),
        gm() ? el('span', { class: 'row econ-shift-acts' }, btn('Edit', async () => { if (await shiftDialog(s)) redraw(); }, 'small'),
          el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove the shift ${X.shiftWords(s, D.items)}`, onclick: busy(null, async () => {
            await post('economy_shift_delete', { id: s.id }, S.camp.id);
            D.shifts = D.shifts.filter(x => x.id !== s.id); redraw();
          }) }, '✕')) : null);
      return el('section', { class: 'card econ-shifts' },
        el('h3', {}, st.allShifts ? 'Shifts everywhere' : `Shifts in ${regionName(rid)}`, tip('A shift changes prices or availability in a region for a while: a famine, a blockade, a glut. Prices in the book are shown with the shifts for the region picked.')),
        list.length ? list.map(row) : el('p', { class: 'muted small' }, st.allShifts ? 'No shifts yet.' : 'Prices here are as the book has them.'),
        el('div', { class: 'row card-foot' }, gm() ? btn('+ New shift', async () => { if (await shiftDialog()) redraw(); }, 'small', 'Change prices or availability in a region for a while') : null,
          D.shifts.length ? btn(st.allShifts ? 'This region only' : 'All regions', () => { st.allShifts = !st.allShifts; redraw(); }, 'small') : null));
    }
    /** Can the party afford it? The picked item's price against the party's coins, goods, wealth and favours. */
    function affordCard() {
      const it = D.items.find(i => i.id === st.picked);
      if (!it) return el('section', { class: 'card econ-afford' }, el('h3', {}, 'Can the party afford it?'),
        el('p', { class: 'muted small' }, 'Pick an item to check its price against the party\'s funds, trade goods and each character\'s wealth.'));
      const p = X.priceIn(it, D.shifts, regionOf(), D.today);
      const lines = [];
      const acts = [];
      if (p.availability === 'none') lines.push(el('p', {}, badge('None to be had here', 'bad')));
      if (on('coins') && p.coin !== null) {
        const have = X.partyCoins(D.config, D.funds).total, short = p.coin - have;
        lines.push(el('p', {}, `Party coins: ${X.fmtCoins(D.config, have)} `, short > 1e-6 ? badge(`Short ${X.fmtCoins(D.config, short)}`, 'bad') : badge('Enough', 'on')));
        if (canWrite()) acts.push(btn('Pay in coins…', async () => {
          const line = D.funds.find(f => X.coinNamed(D.config, f.currency));
          const u = line ? X.coinNamed(D.config, line.currency) : null;
          if (await entryDialog({ kind: 'coins', spent: true, fund_id: line?.id, amount: u ? Math.round((p.coin / u.worth) * 100) / 100 : p.coin, description: it.name })) reload();
        }, 'small'));
      }
      if (on('barter') && p.barter !== null) {
        const g = X.partyGoods(D.config, D.gear), short = p.barter - g.total;
        lines.push(el('p', {}, `Trade goods: worth ${X.fmtBarter(D.config, g.total)} `, short > 1e-6 ? badge(`Short ${X.fmtNum(short)}`, 'bad') : badge('Enough', 'on')));
        if (canWrite()) acts.push(btn('Pay in goods…', async () => {
          if (await entryDialog({ kind: 'goods', spent: true, unit: D.config.barter.unit, amount: Math.ceil(p.barter), description: it.name })) reload();
        }, 'small'));
      }
      if (on('wealth') && it.wealth_level !== null) {
        const who = [...D.characters.map(c => ({ name: c.name, level: D.wealth[c.id] })), { name: 'The party', level: D.wealth[0] }].filter(w => w.level !== undefined);
        lines.push(el('p', {}, `Wealth ${levelWord(it.wealth_level)}: `, who.length ? who.map(w => badge(`${w.name} (${w.level})`, w.level >= it.wealth_level ? 'on' : '')) : el('span', { class: 'muted' }, 'no one has a wealth level yet')));
      }
      if (on('favours') && it.favour_size) {
        lines.push(el('p', {}, `Or a ${X.sizeLabel(it.favour_size).toLowerCase()} favour`));
        if (canWrite()) acts.push(btn('Owe a favour…', async () => { if (await favourDialog({ owed_to_party: false, size: it.favour_size, description: it.name })) reload(); }, 'small'));
      }
      if (!lines.length) lines.push(el('p', { class: 'muted small' }, 'This item has no price yet.'));
      return el('section', { class: 'card econ-afford' }, el('h3', {}, 'Can the party afford it?'),
        el('p', {}, el('strong', {}, it.name), clean([p.coin !== null && on('coins') ? X.fmtCoins(D.config, p.coin) : null, p.barter !== null && on('barter') ? X.fmtBarter(D.config, p.barter) : null]).map(t => `, ${t}`).join('')),
        it.notes ? el('p', { class: 'small muted' }, it.notes) : null, ...lines,
        el('div', { class: 'row card-foot' }, ...acts, gm() ? btn('Edit item', async () => { if (await itemDialog(it)) redraw(); }, 'small') : null));
    }
    function bookPage() {
      const rid = regionOf();
      const find = el('input', { type: 'search', value: st.find, placeholder: 'Find an item', 'aria-label': 'Find an item', class: 'econ-find' });
      const cat = select([['', 'All categories'], ...categories().map(c => [c, c])], st.category, { 'aria-label': 'Category' });
      const region = select([['', 'Everywhere'], ...(S.regions || []).map(r => [r.id, r.id === Number(settings().current_region) ? `${r.name} (where the party is)` : r.name])], rid ?? '', { 'aria-label': 'Prices in' });
      const body = el('tbody');
      const count = el('p', { class: 'muted small econ-count' });
      const cols = clean(['Item', on('coins') ? 'Coins' : null, on('barter') ? 'Barter' : null, on('wealth') ? 'Wealth' : null, on('favours') ? 'Favour' : null, 'Here']);
      const price = (now, was, fmt) => el('td', { class: 'num' }, now === null ? '' : fmt(now), now !== null && was !== null && Math.abs(now - was) > 1e-6 ? el('span', { class: 'econ-was' }, `usually ${fmt(was)}`) : null);
      const fill = () => {
        const q = st.find.trim().toLowerCase();
        const shown = D.items.filter(i => (!st.category || i.category === st.category) && (!q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)));
        body.replaceChildren(...shown.map(it => {
          const p = X.priceIn(it, D.shifts, rid, D.today);
          const open = el('button', { type: 'button', class: 'econ-item', 'aria-pressed': String(st.picked === it.id), onclick: () => { st.picked = it.id; redraw(); document.querySelector('.econ-afford')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }, it.name);
          return el('tr', { class: (it.is_secret ? 'secret ' : '') + (st.picked === it.id ? 'picked' : ''), 'data-item': it.id }, clean([
            el('td', {}, open, it.is_secret ? secretTag() : null, el('span', { class: 'econ-was' }, clean([it.category, it.is_everyday ? 'everyday price' : null]).join(' · '))),
            on('coins') ? price(p.coin, it.coin_cost, n => X.fmtCoins(D.config, n)) : null,
            on('barter') ? price(p.barter, it.barter_cost, n => X.fmtNum(n)) : null,
            on('wealth') ? el('td', { class: 'num', 'data-tip': it.wealth_level === null ? null : levelWord(it.wealth_level) }, it.wealth_level === null ? '' : String(it.wealth_level)) : null,
            on('favours') ? el('td', {}, it.favour_size ? X.sizeLabel(it.favour_size) : '') : null,
            el('td', {}, availBadge(p.availability))]));
        }));
        count.textContent = !D.items.length ? '' : `${shown.length} of ${D.items.length} ${D.items.length === 1 ? 'item' : 'items'}` + (D.shifts.length && rid ? ` · "usually" is the price before ${regionName(rid)}'s shifts` : '');
      };
      find.addEventListener('input', () => { st.find = find.value; fill(); });
      cat.addEventListener('change', () => { st.category = cat.value; fill(); });
      region.addEventListener('change', () => { st.region = region.value ? Number(region.value) : null; redraw(); });
      fill();
      const table = D.items.length ? el('div', { class: 'econ-table-wrap' }, el('table', { class: 'econ-table' },
        el('thead', {}, el('tr', {}, cols.map((c, i) => el('th', { scope: 'col', class: i > 0 && i < cols.length - 1 && c !== 'Favour' ? 'num' : '',
          'data-tip': c === 'Barter' ? `In ${D.config.barter.unit}` : null }, c)))), body))
        : el('p', { class: 'muted' }, gm() ? 'The price book is empty. Add an item with + New item, or upload a list.' : 'The price book is empty.');
      return el('section', { class: 'econ-page econ-two' },
        el('section', { class: 'card econ-book' }, el('div', { class: 'row econ-filters' }, find, cat, el('label', { class: 'inline' }, el('span', { class: 'lbl' }, 'Prices in'), region)), table, count),
        el('div', { class: 'holdings-col' }, shiftsCard(), affordCard()));
    }

    // ------------------------------------------------------------ Ledger
    let entries = [], more = false;
    const coinShort = unit => { const u = X.coinNamed(D.config, unit); return u ? (u.abbr || unit) : unit; };
    function amountText(e) {
      const sign = e.amount === null ? '' : e.amount < 0 ? '− ' : '+ ';
      if (e.kind === 'coins') return `${sign}${X.fmtNum(Math.abs(e.amount))} ${coinShort(e.unit)}`.trim();
      if (e.kind === 'goods') return `${sign}${X.fmtNum(Math.abs(e.amount))} ${e.unit}`.trim();
      if (e.kind === 'wealth') return e.amount === null ? `Wealth ${e.level_after}` : `Wealth ${e.level_after - e.amount} → ${e.level_after}`;
      return e.kind === 'favour' ? 'Favour' : 'Note';
    }
    const SOURCES = { upkeep: 'Regular cost', reward: 'Reward', funds: 'Party Funds' };
    /** + New entry: coins on a funds line, a trade good, or a note. pre: what to fill in; pre.reward: a session's rewards. */
    function entryDialog(pre = {}) {
      const kinds = [['coins', 'Coins'], on('barter') ? ['goods', 'Trade goods'] : null, ['note', 'Note']].filter(Boolean);
      const kind = pick('Kind', kinds, pre.kind || 'coins');
      const dir = pick('Gained or spent', [['in', 'Gained'], ['out', 'Spent']], pre.spent ? 'out' : (pre.kind ? 'in' : 'out'));
      const amount = el('input', { value: pre.amount ?? '', inputmode: 'decimal', autocomplete: 'off', placeholder: '0' });
      const fund = select([...D.funds.map(f => [f.id, `${f.currency}${f.location ? ` · ${f.location}` : ''} (${X.fmtNum(f.amount)})`]), ['', 'Not on Party Funds']], pre.fund_id ?? (D.funds[0]?.id ?? ''));
      const unit = el('input', { maxlength: 60, placeholder: 'e.g. Gold crowns', value: '' });
      const good = select(X.tradeGoods(D.config).map(g => [g.name, g.name]), pre.unit || D.config.barter?.unit || '');
      const desc = el('input', { value: pre.description || '', maxlength: 500, placeholder: 'What it was for' });
      const when = dayBox(pre.abs_day ?? today());
      const fAmount = field('Amount', amount), fFund = field('Party Funds line', fund, 'The line it comes off or goes on'), fUnit = field('Currency', unit),
        fGood = field('Trade good', good, 'Counted in Gear and Loot'), fDir = el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Gained or spent'), dir);
      const sync = () => {
        const k = kind.value();
        fAmount.hidden = fDir.hidden = k === 'note';
        fFund.hidden = k !== 'coins';
        fUnit.hidden = k !== 'coins' || fund.value !== '';
        fGood.hidden = k !== 'goods';
      };
      kind.addEventListener('change', sync);
      fund.addEventListener('change', sync);
      sync();
      const again = pre.reward ? el('button', { type: 'submit', value: 'again', class: 'econ-again' }, 'Save and add another') : null;
      let saved = 0;
      return formDialog(pre.title || 'New ledger entry', [
        pre.reward ? el('div', { class: 'econ-reward' }, el('span', { class: 'lbl' }, pre.reward.label), el('p', { class: 'pre small' }, pre.reward.text || 'Nothing written under Rewards or Loot for this session.')) : null,
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Kind'), kind),
        el('div', { class: 'grid2' }, fDir, fAmount), el('div', { class: 'grid2' }, fFund, fUnit, fGood),
        field('What for', desc), field('Day', when, 'The in-game day it happened'),
      ], { ok: 'Save entry', danger: again }, async (bad, submitter) => {
        const k = kind.value(), body = { kind: k, description: desc.value, source: pre.reward ? 'reward' : 'hand' };
        const d = when.read();
        if (d === null) return bad('That date can\'t be read. Write it like ' + day(today()) + '.', when);
        body.abs_day = d ?? today();
        if (k !== 'note') {
          const n = X.parseNum(amount.value);
          if (n === null || Number.isNaN(n) || n <= 0) return bad('Give an amount more than 0.', amount);
          if (k === 'goods' && !Number.isInteger(n)) return bad('Goods are counted in whole numbers.', amount);
          body.amount = dir.value() === 'out' ? -n : n;
          if (k === 'coins') { if (fund.value) body.fund_id = Number(fund.value); else body.unit = unit.value; } else body.unit = good.value;
        } else if (!desc.value.trim()) return bad('Say what happened.', desc);
        const r = await post('economy_entry_save', body, S.camp.id);
        saved++;
        toast('Entry saved');
        if (submitter?.value === 'again') {
          // stays open for the next line of the hand-out
          const dlg = submitter.closest('dialog');
          dlg.dataset.keep = '1'; amount.value = ''; desc.value = pre.description || ''; amount.focus();
          await load();
        }
        return r.entry;
      }).then(r => r || (saved ? true : null));
    }
    /** Hand out a session's rewards: its Rewards and Loot, as written, over an entry form that stays open for each line. */
    async function rewardsDialog() {
      const { sessions } = await api('sessions', { query: { cid: S.camp.id } });
      const s = sessions.find(x => !x.undated) || sessions[0];
      if (!s) { toast('There are no sessions yet', true); return null; }
      const full = await api('session', { query: { cid: S.camp.id, id: s.id } });
      const plain = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();
      const text = clean([plain(full.rewards || full.session?.rewards), plain(full.loot || full.session?.loot)]).filter(Boolean).join('\n\n');
      return entryDialog({ title: `Hand out session ${s.number}'s rewards`, kind: 'coins', description: `Reward, session ${s.number}`,
        reward: { label: `Session ${s.number}'s rewards and loot, as written`, text } });
    }
    /** A regular cost: what, how much, from where, how often and when next. */
    function costDialog(c = {}) {
      const name = el('input', { value: c.name || '', maxlength: 200, placeholder: 'e.g. Upkeep: the watchtower' });
      const amount = el('input', { value: c.amount ?? '', inputmode: 'decimal', autocomplete: 'off' });
      const goods = on('barter') ? X.tradeGoods(D.config) : [];
      const from = el('select', {}, D.funds.length ? el('optgroup', { label: 'Party Funds' }, D.funds.map(f => el('option', { value: `f:${f.id}`, selected: c.fund_id === f.id }, `${f.currency}${f.location ? ` · ${f.location}` : ''}`))) : null,
        goods.length ? el('optgroup', { label: 'Trade goods' }, goods.map(g => el('option', { value: `g:${g.name}`, selected: !c.fund_id && c.good === g.name }, g.name))) : null);
      const every = el('input', { type: 'number', min: 1, max: 100000, value: c.every_days || 30, inputmode: 'numeric' });
      const next = dayBox(c.next_day ?? today() + 1);
      const del = c.id ? el('button', { type: 'button', class: 'danger', onclick: busy(null, async ev => {
        await post('economy_cost_delete', { id: c.id }, S.camp.id);
        ev.target.closest('dialog').close(); reload();
      }) }, 'Delete') : null;
      return formDialog(c.id ? `Edit ${c.name}` : 'New regular cost', [
        el('p', { class: 'small muted' }, 'Upkeep, wages, rations: taken off by itself each time the campaign\'s clock reaches the day it is due, with a line in the ledger.'),
        field('What', name), el('div', { class: 'grid2' }, field('Amount each time', amount), field('Paid from', from)),
        el('div', { class: 'grid2' }, field('Every how many days', every), field('Next due', next, `A date as the calendar writes it, e.g. ${day(today() + 1)}`)),
      ], { ok: c.id ? 'Save' : 'Add regular cost', danger: del }, async bad => {
        if (!name.value.trim()) return bad('Name the cost.', name);
        const n = X.parseNum(amount.value);
        if (n === null || Number.isNaN(n) || n <= 0) return bad('Give an amount more than 0.', amount);
        if (!from.value) return bad('Add a line to Party Funds first, on Party → Holdings.', from);
        const d = next.read();
        if (d === null || d === undefined) return bad('That date can\'t be read. Write it like ' + day(today()) + '.', next);
        const r = await post('economy_cost_save', { id: c.id, name: name.value, amount: n, fund_id: from.value.startsWith('f:') ? Number(from.value.slice(2)) : null,
          good: from.value.startsWith('g:') ? from.value.slice(2) : '', every_days: Number(every.value) || 30, next_day: d }, S.camp.id);
        D.costs = r.costs;
        return true;
      });
    }
    /** A character's wealth (or the party's): pick the level, and say why if you like. */
    function wealthDialog(who) {
      const was = D.wealth[who.id];
      const level = wealthSelect(was ?? 0, null);
      level.querySelector('option[value=""]')?.remove();
      const why = el('input', { maxlength: 500, placeholder: 'e.g. Bought a horse above his means' });
      return formDialog(`${who.name}'s wealth`, [field('Level', level), field('Why', why, 'Goes in the ledger with the change')], { ok: 'Save' }, async () => {
        const r = await post('economy_wealth_set', { character_id: who.id, level: Number(level.value), description: why.value }, S.camp.id);
        D.wealth = r.wealth;
        return true;
      });
    }
    function ledgerSide() {
      const coins = X.partyCoins(D.config, D.funds);
      const cards = [el('section', { class: 'card econ-funds' }, el('h3', {}, 'Party Funds'),
        D.funds.length ? el('div', { class: 'econ-fundlist' }, D.funds.map(f => el('div', { class: 'econ-fund' }, el('span', {}, f.currency, f.location ? el('span', { class: 'muted small' }, ` · ${f.location}`) : null), el('strong', {}, X.fmtNum(f.amount)))))
          : el('p', { class: 'muted small' }, 'No funds yet.'),
        on('coins') && D.funds.length ? el('div', { class: 'ledger-total' }, el('span', { class: 'muted' }, 'Coins in all'), el('strong', {}, X.fmtCoins(D.config, coins.total))) : null,
        el('div', { class: 'row card-foot' }, el('a', { class: 'button small', href: `#/c/${S.camp.id}/holdings`, 'data-tip': 'Add a line or change one on Party → Holdings. An amount changed there goes in the ledger too' }, 'Edit on Holdings')))];
      if (on('barter')) {
        const g = X.partyGoods(D.config, D.gear);
        cards.push(el('section', { class: 'card econ-goods' }, el('h3', {}, 'Trade goods'),
          el('p', {}, g.stock.map((s, i) => [i ? ' · ' : '', s.name, ' ', el('strong', {}, X.fmtNum(s.amount))])),
          el('p', { class: 'muted small' }, `Counted from Gear and Loot. Worth ${X.fmtBarter(D.config, g.total)} in all.`)));
      }
      if (on('wealth')) {
        const who = [...D.characters, { id: 0, name: 'The party', can_edit: true }];
        cards.push(el('section', { class: 'card econ-wealth' }, el('h3', {}, 'Wealth', tip('Each character\'s wealth level, and the party\'s own. Its player or a GM changes a character\'s; the change goes in the ledger.')),
          el('div', { class: 'econ-chips' }, who.map(w => {
            const lv = D.wealth[w.id];
            const text = `${w.name}: ${lv === undefined ? 'not set' : levelWord(lv)}`;
            return w.can_edit && canWrite() ? el('button', { type: 'button', class: 'small econ-wealth-chip', onclick: async () => { if (await wealthDialog(w)) reload(); } }, text) : badge(text);
          }))));
      }
      cards.push(el('section', { class: 'card econ-costs' }, el('h3', {}, 'Coming up', tip('Regular costs: upkeep, wages, rations. Each is taken off by itself when the campaign\'s clock reaches the day it is due.')),
        D.costs.length ? D.costs.map(c => el('div', { class: 'econ-cost', 'data-cost': c.id },
          el('div', {}, el('strong', {}, `− ${X.fmtNum(c.amount)} ${c.good || coinShort(c.currency || '')}`.trim()), ` ${c.name}`,
            el('div', { class: 'small muted' }, `${day(c.next_day)}, ${c.next_day <= D.today ? 'due' : `in ${c.next_day - D.today} ${c.next_day - D.today === 1 ? 'day' : 'days'}`} · every ${c.every_days} ${c.every_days === 1 ? 'day' : 'days'}`,
              !c.good && c.fund_id === null ? ' · its funds line is gone' : '')),
          canWrite() ? btn('Edit', async () => { if (await costDialog(c)) redraw(); }, 'small') : null))
          : el('p', { class: 'muted small' }, 'No regular costs.'),
        canWrite() ? el('div', { class: 'row card-foot' }, btn('+ Regular cost', async () => { if (await costDialog()) redraw(); }, 'small', 'Upkeep, wages or rations, taken off by itself as the days pass')) : null));
      return el('div', { class: 'holdings-col' }, cards);
    }
    function ledgerPage() {
      const kinds = [['all', 'All'], ['coins', 'Coins'], on('barter') ? ['goods', 'Goods'] : null, on('wealth') ? ['wealth', 'Wealth'] : null, on('favours') ? ['favour', 'Favours'] : null, ['note', 'Notes']].filter(Boolean);
      const seg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Show' }, kinds.map(([k, l]) => el('button', { type: 'button', class: 'small' + (st.kind === k ? ' on' : ''), 'aria-pressed': String(st.kind === k), onclick: () => { st.kind = k; redraw(); } }, l)));
      const shown = entries.filter(e => st.kind === 'all' || e.kind === st.kind);
      const list = el('div', { class: 'econ-ledger' });
      let last = null;
      for (const e of shown) {
        if (e.abs_day !== last) { list.append(el('h4', { class: 'econ-day' }, E.fmtDate(cal(), e.abs_day))); last = e.abs_day; }
        list.append(el('div', { class: 'econ-entry' + (e.is_secret ? ' secret' : ''), 'data-entry': e.id },
          el('span', { class: 'econ-amt' + (e.amount !== null && e.amount < 0 && e.kind !== 'wealth' ? ' out' : '') }, amountText(e)),
          el('span', { class: 'econ-what' }, e.description || (e.kind === 'coins' || e.kind === 'goods' ? (e.amount < 0 ? 'Spent' : 'Gained') : ''), e.is_secret ? [' ', secretTag()] : null,
            el('span', { class: 'econ-where' }, clean([e.character?.name, e.place ? (e.kind === 'coins' ? `Party Funds · ${e.place}` : e.place) : null]).join(' · '))),
          el('span', { class: 'econ-who' }, SOURCES[e.source] || e.author || '',
            e.mine && canWrite() ? el('button', { type: 'button', class: 'link danger', 'aria-label': `Delete the entry ${amountText(e)} ${e.description}`, 'data-tip': 'Take this line out of the ledger. What it changed stays changed', onclick: busy(null, async () => {
              if (!await confirmDialog('Take this line out of the ledger? The amount it changed stays as it is now.', { ok: 'Delete', danger: true })) return;
              await post('economy_entry_delete', { id: e.id }, S.camp.id);
              entries = entries.filter(x => x.id !== e.id); redraw();
            }) }, '✕') : null)));
      }
      if (!shown.length) list.append(el('p', { class: 'muted' }, entries.length ? 'Nothing of that kind yet.' : 'Nothing in the ledger yet. Add what the party gains and spends with + New entry; an amount changed on Party Funds is noted here too.'));
      const earlier = more ? btn('Show earlier', busy(null, async () => {
        const r = await api('economy_ledger', { query: { cid: S.camp.id, before: Math.min(...entries.map(e => e.id)) } });
        entries = entries.concat(r.entries); more = r.more; redraw();
      }), 'small') : null;
      return el('section', { class: 'econ-page econ-two' },
        el('section', { class: 'card econ-ledger-card' }, el('div', { class: 'row econ-filters' }, seg), list, earlier ? el('div', { class: 'row' }, earlier) : null),
        ledgerSide());
    }

    // ------------------------------------------------------------ Favours
    /** + New favour or Edit: which way it runs, who, how big, what for. */
    function favourDialog(f = {}) {
      const dir = pick('Which way', [['to', 'Owed to the party', 'Someone owes the party, or one of its characters'], ['by', 'The party owes', 'The party, or one of its characters, owes someone']], f.owed_to_party === false ? 'by' : 'to');
      const who = select([['', 'The party'], ...D.characters.map(c => [c.id, c.name])], f.character?.id ?? '');
      const other = el('input', { value: f.other_name || '', maxlength: 200, list: 'econ-names', placeholder: 'A person or a group', autocomplete: 'off' });
      const size = pick('Size', X.SIZES, f.size || 1);
      const desc = el('textarea', { rows: 2, maxlength: 500, placeholder: 'What it was for' }, f.description || '');
      const since = dayBox(f.since_day ?? today());
      const secret = gm() ? el('input', { type: 'checkbox', checked: !!f.is_secret }) : null;
      return formDialog(f.id ? 'Edit favour' : 'New favour', [
        el('datalist', { id: 'econ-names' }, (S.encyclopedia || []).filter(e => ['person', 'group'].includes(e.category) || !e.category).slice(0, 500).map(e => el('option', { value: e.name }))),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Which way'), dir),
        el('div', { class: 'grid2' }, field('On the party\'s side', who), field('With', other, 'A name in the Encyclopedia links to its entry')),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Size'), size),
        field('What for', desc), el('div', { class: 'grid2' }, field('Since', since), secret ? field('GM only', secret, 'The players don\'t see it, or its lines in the ledger, until you reveal it') : null),
      ], { ok: f.id ? 'Save favour' : 'Add favour' }, async bad => {
        if (!other.value.trim()) return bad('Say who the favour is with.', other);
        const d = since.read();
        if (d === null) return bad('That date can\'t be read. Write it like ' + day(today()) + '.', since);
        const r = await post('economy_favour_save', { id: f.id, owed_to_party: dir.value() === 'to', character_id: who.value ? Number(who.value) : null, other_name: other.value,
          size: Number(size.value()), description: desc.value, since_day: d ?? today(), is_secret: !!secret?.checked }, S.camp.id);
        toast(f.id ? 'Favour saved' : 'Favour added');
        return r.favour;
      });
    }
    async function settle(f, status, ask, verb) {
      const note = ask ? await promptDialog(ask, { title: `${verb}: ${f.other_name}`, ok: verb, placeholder: 'Optional' }) : '';
      if (note === null) return;
      await post('economy_favour_settle', { id: f.id, status, note: note || '' }, S.camp.id);
      toast(`Favour ${status === 'open' ? 'opened again' : verb.toLowerCase()}`);
      await reload();
    }
    const sideName = f => f.character?.name || 'the party';
    function favourCard(f) {
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
      const other = f.entry_id ? el('a', { href: `#/c/${S.camp.id}/encyclopedia/${f.entry_id}`, 'data-tip': 'Open its Encyclopedia entry' }, f.other_name) : f.other_name;
      const can = canWrite();
      const acts = clean([
        can && f.owed_to_party ? btn('Call in…', busy(null, () => settle(f, 'called', 'What was asked for?', 'Call in')), 'small', 'The favour is used: say what was asked') : null,
        can && f.owed_to_party ? btn('Forgive', busy(null, () => settle(f, 'forgiven', '', 'Forgiven')), 'small', 'Let it go without calling it in') : null,
        can && !f.owed_to_party ? btn('Repaid…', busy(null, () => settle(f, 'repaid', 'How was it repaid?', 'Repaid')), 'small', 'The debt is paid: say how') : null,
        gm() && f.is_secret ? btn('Reveal to players', busy(null, async () => {
          await post('economy_favour_save', { ...f, character_id: f.character?.id || null, is_secret: false }, S.camp.id);
          await reload();
        }), 'small', 'The players see this favour and its history from now on') : null,
        can && f.mine ? btn('Edit', async () => { if (await favourDialog(f)) reload(); }, 'small') : null,
        can && f.mine ? el('button', { type: 'button', class: 'small danger', onclick: busy(null, async () => {
          if (!await confirmDialog(`Delete this favour with ${f.other_name}, and its lines in the ledger?`, { ok: 'Delete', danger: true })) return;
          await post('economy_favour_delete', { id: f.id }, S.camp.id);
          await reload();
        }) }, 'Delete') : null]);
      return el('article', { class: 'card econ-favour' + (f.is_secret ? ' secret' : ''), 'data-favour': f.id },
        el('div', { class: 'row spread econ-favour-head' }, el('h3', {}, other, f.is_secret ? [' ', secretTag()] : null), badge(X.sizeLabel(f.size), f.size === 3 ? 'on' : '')),
        el('p', {}, f.owed_to_party ? ['Owes ', el('strong', {}, sideName(f)), f.description ? `: ${f.description}` : '.'] : [el('strong', {}, cap(sideName(f))), ' owes them', f.description ? `: ${f.description}` : '.']),
        el('p', { class: 'small muted' }, `Since ${day(f.since_day)}`),
        acts.length ? el('div', { class: 'row card-foot' }, ...acts) : null);
    }
    function favoursPage() {
      const open = D.favours.filter(f => f.status === 'open'), done = D.favours.filter(f => f.status !== 'open');
      const col = (title, list, none) => el('div', { class: 'holdings-col econ-favcol' }, el('h2', {}, title, ' ', el('span', { class: 'econ-n' }, `${list.length} open`)),
        list.length ? list.map(favourCard) : el('p', { class: 'muted' }, none));
      const words = { called: 'Called in', repaid: 'Repaid', forgiven: 'Forgiven' };
      return el('section', { class: 'econ-page' },
        el('div', { class: 'econ-half' }, col('Owed to the party', open.filter(f => f.owed_to_party), 'No one owes the party a favour.'),
          col('The party owes', open.filter(f => !f.owed_to_party), 'The party owes no favours.')),
        done.length ? el('details', { class: 'card econ-settled' }, el('summary', {}, el('h3', {}, 'Settled ', el('span', { class: 'econ-n' }, String(done.length)))),
          done.map(f => el('div', { class: 'econ-entry' + (f.is_secret ? ' secret' : ''), 'data-favour': f.id }, badge(X.sizeLabel(f.size)),
            el('span', { class: 'econ-what' }, f.owed_to_party ? `${f.other_name} owed ${sideName(f)}` : `${sideName(f).charAt(0).toUpperCase()}${sideName(f).slice(1)} owed ${f.other_name}`, f.description ? `: ${f.description}` : '',
              f.is_secret ? [' ', secretTag()] : null,
              el('span', { class: 'econ-where' }, clean([`Since ${day(f.since_day)}`, f.settled_day !== null ? `${words[f.status].toLowerCase()} ${day(f.settled_day)}` : null, f.settled_note || null]).join(' · '))),
            el('span', { class: 'econ-who' }, words[f.status], gm() ? btn('Open again', busy(null, () => settle(f, 'open', '', 'Open again')), 'small link') : null)))) : null);
    }

    // ------------------------------------------------------------ the tab
    async function viewEconomy(half) {
      const at = HALVES.some(([k]) => k === half) ? half : '';
      await load();
      if (at === 'ledger') { const r = await api('economy_ledger', { query: { cid: S.camp.id } }); entries = r.entries; more = r.more; }
      if (at === 'setup' && !gm()) { location.replace(href('')); return; }
      const page = el('div', { class: 'econ-root' });
      const actions = () => {
        if (!D.config.set && at !== 'setup') return [];
        if (at === '') return gm() ? [uploadButton(), btn('+ New item', async () => { if (await itemDialog()) redraw(); }, 'primary new-btn', 'Add a good or a service to the price book')] : [];
        if (at === 'ledger') return canWrite() ? [btn('Hand out rewards…', busy(null, async () => { if (await rewardsDialog()) viewEconomy('ledger'); }), '', 'Put the last session\'s rewards and loot into the ledger, a line at a time'),
          btn('+ New entry', async () => { if (await entryDialog()) viewEconomy('ledger'); }, 'primary new-btn', 'Something the party gained or spent, or a note')] : [];
        if (at === 'favours') return canWrite() ? [btn('+ New favour', async () => { if (await favourDialog()) reload(); }, 'primary new-btn', 'A favour owed to the party, or by it')] : [];
        return [];
      };
      redraw = () => {
        const y = window.scrollY;
        page.replaceChildren(head(at, ...actions()),
          !D.config.set && at !== 'setup' ? notSetUp() : at === 'setup' ? setupPage() : at === 'ledger' ? ledgerPage() : at === 'favours' ? favoursPage() : bookPage());
        window.scrollTo(0, y);
      };
      mount(...campaignHeader('economy'), page);
      redraw();
    }

    return { viewEconomy };
  }
  root.EconomyTab = { make };
})(typeof window !== 'undefined' ? window : globalThis);
