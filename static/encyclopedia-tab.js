/* encyclopedia-tab.js — The Encyclopedia tab: the entry list and pages, linking names in notes to entries, the Feature Highlighter's
 * offers, and the Encyclopedia for virtual tabletops.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { DOWNTIME_KINDS, E, ENC_CATEGORIES, S, api, attachmentsCard, btn, busy, byline, cal, campaignHeader, clean, confirmDialog, connIndex, connectionsCard, el, encCat, encCatNamed, entryForm, hideTip, isGM, listPage, lockBox, mapLinks, mount, multiPick, post, readerEmpty, relationKinds, route, secretTag, select, shiftNames, tagChip, tagsOf, tip, toast, vs } = ctx;

    // ------------------------------------------------------------ encyclopedia
    // The Encyclopedia tab keeps the people, places, items and the like that turn up in play. Each save of a note,
    // event, reminder or Locations visited list runs the Feature Highlighter (static/encyclopedia.js) over what was
    // saved and offers the new names it finds; whoever saved says Add, Ignore (never offer it again) or Skip (ask next
    // time). Names of entries are linked wherever they are written, as the text is shown: the stored text never changes.
    let encLinkMemo = null;
    /** The linker for the entries this member can see, rebuilt when the list changes. */
    function encLinker() {
      if (encLinkMemo?.list !== S.encyclopedia) {
        encLinkMemo = { list: S.encyclopedia, linker: Nouns.linker(S.encyclopedia, (e, text) => el('a', { class: 'enc-link' + (e.is_secret ? ' secret' : ''),
          href: `#/c/${S.camp.id}/encyclopedia/${e.id}`, 'data-tip': `📖 ${e.name}${e.is_secret ? ' (GM only)' : ''}${e.preview ? `: ${e.preview}` : '. Nothing written about it yet'}`,
          'data-tip-img': e.pic || null }, text)) };
      }
      return encLinkMemo.linker;
    }
    /** Text with every Encyclopedia name in it linked to its entry. */
    const linked = t => encLinker().text(t);
    /** A stored note as RichText.view() shows it, with the Encyclopedia's names linked. */
    function linkedNote(text, format, cls) {
      const node = RichText.view(text, format, cls);
      if (format === 'html') encLinker().tree(node); else node.replaceChildren(...linked(text));
      return node;
    }
    /** GMs: a 🔓 Reveal button on each run of GM-only paragraphs in a shown entry, tome, session field or day's notes (kind
     * 'entry', 'tome', 'session' with extra { field }, or 'day' with the absolute day as id), which makes them public and
     * can note it as an event on the current day. */
    function revealButtons(node, kind, id, extra = {}) {
      if (!isGM()) return node;
      const all = [...node.querySelectorAll('aside')];
      all.forEach((a, i) => {
        if (a.previousElementSibling?.nodeName === 'ASIDE') return;  // the button goes on the first of a run
        const run = [];
        for (let x = a, j = i; x && x.nodeName === 'ASIDE' && all[j] === x; x = x.nextElementSibling, j++) run.push({ index: j, text: x.textContent.trim() });
        a.prepend(btn('🔓 Reveal', async () => {
          const v = await KIT.dialog({ title: 'Reveal to the players?', message: run.length > 1 ? `These ${run.length} paragraphs become public now.` : 'This paragraph becomes public now.',
            buttons: [{ value: 'log', label: 'Reveal and log it today', cls: 'primary', focus: true }, { value: 'quiet', label: 'Just reveal' }, { value: 'cancel', label: 'Cancel' }] });
          if (v !== 'log' && v !== 'quiet') return;
          try {
            await post('secret_reveal', { kind, id, ...extra, which: run, log: v === 'log' }, S.camp.id);
            toast(v === 'log' ? 'Revealed, and logged on today\'s events' : 'Revealed to the players');
            route();
          } catch (err) { toast(err.message, true); }
        }, 'small rt-reveal', 'Make this GM-only text public: players see it from now on'));
      });
      return node;
    }
    /** For text still open in an editor, where links can't go: a line of links to the entries it mentions. */
    function mentionRow(...texts) {
      const seen = new Set(), list = [];
      for (const [t, format] of texts.map(x => (Array.isArray(x) ? x : [x, 'plain']))) {
        for (const e of encLinker().mentions(Nouns.plain(t, format))) if (!seen.has(e.id)) { seen.add(e.id); list.push(e); }
      }
      if (!list.length) return null;
      return el('div', { class: 'enc-mentions small' }, el('span', { class: 'muted', 'data-tip': 'Encyclopedia entries named in this text. Open one to read or add to it' }, '📖 '),
        list.map(e => el('a', { class: 'enc-link' + (e.is_secret ? ' secret' : ''), href: `#/c/${S.camp.id}/encyclopedia/${e.id}` }, e.name)));
    }
    /** Words the campaign already has names for, which the detector never offers: the calendar's months, weekdays, shifts,
     * moons, seasons and eras, the members' names and character names, the names of the event and Encyclopedia tags, and the
     * Long Rest, Short Rest and Downtime labels a rest writes into the shifts. */
    function knownWords() {
      const c = cal();
      const people = S.members.flatMap(m => [m.character_name, m.display_name]).filter(Boolean);
      return [...(c.months || []).map(m => m.name), ...(c.weekdays || []), ...shiftNames(), ...(c.moons || []).map(m => m.name),
        ...(c.seasons || []).map(s => s.name), ...(c.eras || []).flatMap(e => [e?.name, e?.abbr]),
        ...people, ...people.flatMap(n => n.split(/\s+/)), ...S.tags.map(t => t.name), ...S.encTags.map(t => t.name),
        ...Object.values(DOWNTIME_KINDS).map(k => k.label), ...E.SHIFT_ACTIONS.map(a => a.name)].filter(Boolean);
    }
    /** Names the campaign knows the kind of: its regions are Locations and its holidays Events. */
    function knownKinds() {
      const h = {};
      for (const r of S.regions) h[r.name] = 'Location';
      for (const x of S.holidays) h[x.name] = 'Event';
      return h;
    }
    /** The @ list in rich text editors: the Encyclopedia names this member can see, and a new entry made on the spot. */
    function encMentions() {
      return {
        list: () => S.encyclopedia,
        create: async name => {
          try {
            const { id } = await post('entry_save', { name }, S.camp.id);
            S.encyclopedia = [...S.encyclopedia, { id, name, aliases: [], is_secret: false, blank: true, preview: '' }].sort((a, b) => a.name.localeCompare(b.name));
            toast(`${name} added to the Encyclopedia`);
            return true;
          } catch (err) { toast(err.message, true); return false; }
        },
      };
    }
    const detectorOpts = () => ({ known: S.encyclopedia.flatMap(Nouns.namesOf), ignored: [...S.encIgnored, ...encSkipped], stop: knownWords(), hints: knownKinds() });
    // Names skipped in the dialog (or left with Not now) aren't offered again until the page is reloaded; Scan campaign still lists them.
    const encSkipped = new Set();
    /** Run the detector over what was just saved and offer what it finds. sources: see Nouns.find(). */
    async function offerNouns(sources) {
      // a rich text note's GM-only paragraphs are read as secret, so names found only there start as GM only
      sources = sources.flatMap(s => {
        if (s.format !== 'html') return [s];
        const { open, secret } = RichText.split(s.text);
        return [{ ...s, text: open }, { ...s, text: secret, secret: true }];
      });
      const found = Nouns.find(sources.filter(s => s.text && String(s.text).trim()), detectorOpts());
      if (found.length) await nounDialog(found.slice(0, 40));
    }
    /** Ask about each name found: Add it to the Encyclopedia (with a tag, and as GM only for a GM), Ignore it from now on,
     * or Skip it this time. scan: the full check of the campaign (or of one entry or tome, named by where), where every
     * name starts on Skip. */
    function nounDialog(found, { scan = false, where = 'the campaign' } = {}) {
      return new Promise(resolve => {
        hideTip();
        const cid = S.camp.id;
        // a Category, or else a tag: the detector's guess is either ("Person", "Religion")
        const tagOpts = [['', 'No category'], ...ENC_CATEGORIES.map(([, n, i]) => [n, `${i} ${n}`]),
          ...S.encTags.filter(t => !encCatNamed(t.name)).map(t => [t.name, `Tag: ${t.name}`])];
        const rows = found.map((f, i) => {
          const name = el('input', { value: f.term, maxlength: 150, 'aria-label': `Name for ${f.term}`, class: 'grow' });
          const tag = select(tagOpts, f.tag || '', { 'aria-label': `Category or tag for ${f.term}` });
          const secret = isGM() ? el('input', { type: 'checkbox', checked: f.secret, 'aria-label': `${f.term} is GM only` }) : null;
          // "Hoffmann" beside an entry for Gunther Hoffmann: it may be another name for that entry rather than a new one.
          const like = Nouns.related(f.term, S.encyclopedia);
          const aliasOf = like.length ? select(like.map(e => [e.id, e.name]), like[0].id, { 'aria-label': `Which entry ${f.term} is another name for` }) : null;
          const choices = [['add', 'Add', 'Add it to the Encyclopedia'], like.length ? ['alias', 'Alias', 'Another name for an entry that exists. It links to that entry from now on'] : null,
            ['ignore', 'Ignore', 'Never offer this word again. You can bring it back from the Encyclopedia tab'], ['skip', 'Skip', 'Not now: ask again next time']].filter(Boolean);
          const choice = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': `What to do with ${f.term}` },
            choices.map(([v, l, t]) => el('label', { 'data-tip': t }, el('input', { type: 'radio', name: `noun-${i}`, value: v, checked: v === (scan ? 'skip' : 'add') }), el('span', {}, l))));
          const asEntry = el('div', { class: 'row' }, name, tag,
            secret ? lockBox(secret, 'only GMs will see this entry. On when the name was found only in GM-only text') : null);
          const asAlias = aliasOf ? el('div', { class: 'row', hidden: true }, el('span', { class: 'small' }, 'Another name for'), aliasOf) : null;
          const row = el('div', { class: 'noun-row', 'data-term': f.term }, choice,
            el('div', { class: 'noun-what' }, asEntry, asAlias,
              f.where.length ? el('small', { class: 'muted' }, `Found in ${f.where.join(', ')}${f.count > 1 ? ` · ${f.count} times` : ''}`) : null));
          const pick = () => choice.querySelector('input:checked')?.value || 'skip';
          const sync = () => {
            const v = pick();
            row.classList.toggle('off', v !== 'add' && v !== 'alias');
            asEntry.hidden = v === 'alias';
            if (asAlias) asAlias.hidden = v !== 'alias';
          };
          choice.addEventListener('change', sync); sync();
          return { f, row, name, tag, secret, aliasOf, pick, set: v => { const r = choice.querySelector(`input[value=${v}]`); if (r) { r.checked = true; sync(); } } };
        });
        const all = v => rows.forEach(r => r.set(v));
        const d = el('dialog', { class: 'kit-dialog noun-dialog', 'aria-label': 'New names for the Encyclopedia' },
          el('form', { method: 'dialog' },
            el('h3', {}, scan ? '📖 Names missing from the Encyclopedia' : '📖 New names for the Encyclopedia'),
            el('p', { class: 'small muted' }, scan
              ? `The Feature Highlighter found ${found.length} name${found.length === 1 ? '' : 's'} in ${where} that ${found.length === 1 ? 'isn\'t' : 'aren\'t'} in the Encyclopedia. Pick Add for the ones to keep; Ignore stops a word being offered again.`
              : 'The Feature Highlighter found these in what you saved. Add puts one in the Encyclopedia, Ignore stops it being offered again, Skip asks next time.'),
            el('div', { class: 'row small' }, el('span', { class: 'muted' }, 'All:'), btn('Add', () => all('add'), 'link small'), btn('Ignore', () => all('ignore'), 'link small'), btn('Skip', () => all('skip'), 'link small')),
            el('div', { class: 'noun-list' }, rows.map(r => r.row)),
            el('div', { class: 'kit-dialog-actions' },
              el('button', { value: 'save', class: 'primary', type: 'submit' }, 'Save choices'),
              el('button', { value: 'cancel', type: 'submit', 'data-tip': 'Close without adding or ignoring anything' }, 'Not now'))));
        d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
        d.addEventListener('close', async () => {
          d.remove();
          if (S.camp?.id !== cid) return resolve(false);
          if (d.returnValue !== 'save') { if (!scan) for (const r of rows) encSkipped.add(r.f.term); return resolve(false); }
          const adds = [], ignores = [];
          for (const r of rows) {
            const v = r.pick(), n = r.name.value.trim().replace(/\s+/g, ' ');
            if (v === 'ignore') ignores.push(r.f.term);
            if (v === 'skip' && !scan) encSkipped.add(r.f.term);
            if (v === 'alias') adds.push({ name: r.f.term, alias_of: Number(r.aliasOf.value) });
            if (v !== 'add' || !n) continue;
            const cat = encCatNamed(r.tag.value);
            adds.push({ name: n, is_secret: !!r.secret?.checked, category: cat, tags: r.tag.value && !cat ? [{ name: r.tag.value }] : [] });
            if (Nouns.keyOf(n) !== Nouns.keyOf(r.f.term)) ignores.push(r.f.term); // renamed: the word as found isn't offered again
          }
          try {
            let added = [], aliased = [];
            if (adds.length) ({ added, aliased } = await post('entries_add', { entries: adds }, cid));
            if (ignores.length) { await post('terms_ignore', { terms: ignores }, cid); S.encIgnored = [...S.encIgnored, ...ignores]; }
            if (added.length || aliased.length) {
              const list = S.encyclopedia.map(e => ({ ...e, aliases: [...(e.aliases || []), ...aliased.filter(a => a.id === e.id).map(a => a.alias)] }));
              S.encyclopedia = [...list, ...added.map(a => ({ id: a.id, name: a.name, aliases: [], is_secret: !!adds.find(x => x.name === a.name)?.is_secret, blank: true, preview: '' }))]
                .sort((a, b) => a.name.localeCompare(b.name));
            }
            if (added.length || aliased.length || ignores.length) {
              toast([added.length ? `Added ${added.length} to the Encyclopedia` : '', aliased.length ? `${aliased.length} other name${aliased.length === 1 ? '' : 's'} added` : '',
                ignores.length ? `${ignores.length} ignored` : ''].filter(Boolean).join(' · '));
              route();
            }
            resolve(true);
          } catch (err) { toast(err.message, true); resolve(false); }
        });
        document.body.append(d);
        d.showModal();
      });
    }

    /** Where each kind of text the detector reads lives, for "Mentioned in" and the full scan. */
    function sourceLabel(s) {
      const date = s.abs_day !== undefined ? E.fmtDate(cal(), s.abs_day, { noWeekday: true }) : '';
      const day = `#/c/${S.camp.id}/day/${s.abs_day}`;
      const shift = s.shift !== undefined ? shiftNames()[s.shift] || '' : '';
      return ({
        locations: [`${date}: Locations visited`, day], day_notes: [`${date}: Public notes`, day], day_gm_notes: [`${date}: Secret notes`, day],
        activity: [`${date}, ${shift}: activity`, day], shift_gm_notes: [`${date}, ${shift}: GM notes`, day], shift_note: [`${date}, ${shift}: a note`, day],
        event: [`${date}: event "${s.title}"`, day], event_note: [`${date}: a note on "${s.title}"`, day], reminder: [`${date}: reminder "${s.title}"`, day],
        entry: [`Encyclopedia: ${s.title}`, `#/c/${S.camp.id}/encyclopedia/${s.id}`], entry_gm_notes: [`Encyclopedia: ${s.title} (GM notes)`, `#/c/${S.camp.id}/encyclopedia/${s.id}`],
        downtime: [`${date}: ${s.title}`, `#/c/${S.camp.id}/downtime`], downtime_gm_notes: [`${date}: ${s.title} (GM notes)`, `#/c/${S.camp.id}/downtime`],
        holding: [`Party Holdings: ${s.title}`, `#/c/${S.camp.id}/holdings`], storage: [`Party Holdings: ${s.title} storage`, `#/c/${S.camp.id}/holdings`],
        gear: ['Party Holdings: Gear and Loot', `#/c/${S.camp.id}/holdings`], funds: ['Party Holdings: Party Funds', `#/c/${S.camp.id}/holdings`],
        tome: [`Library: ${s.title}`, `#/c/${S.camp.id}/library/${s.id}`],
        session: [`Sessions: ${s.title}`, `#/c/${S.camp.id}/sessions/${s.id}`], session_note: [`Sessions: ${s.title} (notes)`, `#/c/${S.camp.id}/sessions/${s.id}`],
      })[s.kind] || [s.kind, day];
    }
    /** The campaign's text for the detector: event, reminder and downtime titles, and short boxes like a holding's name, read as titles. */
    const scanSources = sources => sources.map(s => ({ ...s, title: !!s.short || ['event', 'reminder', 'downtime'].includes(s.kind), label: sourceLabel(s)[0] }));
    /** The full scan, or with only (a test of each source) and where (its name for the dialog) a scan of part of it. */
    async function fullScan(only = null, where = 'the campaign') {
      const { sources } = await api('encyclopedia_sources', { query: { cid: S.camp.id } });
      const found = Nouns.find(scanSources(only ? sources.filter(only) : sources), { ...detectorOpts(), ignored: S.encIgnored });
      if (!found.length) { toast(`No names missing: everything the Feature Highlighter finds in ${where} is in the Encyclopedia or ignored`); return; }
      await nounDialog(found.slice(0, 300), { scan: true, where });
    }
    /** A 🔍 Scan button for one entry or tome: the full scan, over only the text kept with it. */
    function scanOneBtn(what, only, where) {
      const b = btn('🔍 Scan', null, 'small', `Run the Feature Highlighter over just this ${what} and offer the names in it that are missing from the Encyclopedia`);
      b.addEventListener('click', busy(b, () => fullScan(only, where)));
      return b;
    }

    // an entry with a character sheet isn't blank: the sheet is what's written about it
    const entryBlank = e => !(e.notes || '').trim() && !(isGM() && (e.gm_notes || '').trim()) && !S.encChars?.[e.id];
    /** The Encyclopedia tab: the entries down the left (Blank Entries first), the one picked on the right. sel: an entry
     * id, 'new' for a new entry, or nothing. A blank entry, or a new one, opens straight in its editor. */
    async function viewEncyclopedia(sel) {
      const r = await api('encyclopedia', { query: { cid: S.camp.id } });
      const entries = r.entries;
      S.encTags = r.tags || []; S.encIgnored = r.ignored || [];
      const rel = { list: r.relations || [], types: r.relation_types || [], entries };
      const conns = connIndex(rel);
      const files = { list: r.files || [], uploads: r.uploads || { ready: false } };
      S.encUploads = files.uploads;
      for (const e of entries) e.files = files.list.filter(f => f.parent_id === e.id);
      S.encyclopedia = entries.map(e => ({ id: e.id, name: e.name, category: e.category || null, aliases: e.aliases || [], is_secret: e.is_secret, blank: entryBlank(e), preview: Nouns.plain(e.notes, 'html').replace(/\s+/g, ' ').trim().slice(0, 140),
        pic: e.files.find(f => f.kind === 'image' || (f.kind === 'embed' && !f.embed?.gone))?.url || null }));
      S.encChars = r.characters || {};
      const chars = S.encChars, hasChars = Object.keys(chars).length > 0;
      // Each filter keeps what is unticked, so everything shows at first and a tag made later starts ticked.
      const st = vs().enc || (vs().enc = { q: '', tagsOff: new Set(), relsOff: new Set(), catsOff: new Set(), folded: new Set() });
      if (st.near && !entries.some(e => e.id === st.near)) st.near = null;
      const current = sel === 'new' ? { tags: [] } : entries.find(e => e.id === Number(sel)) || null;
      const href = id => `#/c/${S.camp.id}/encyclopedia${id ? `/${id}` : ''}`;

      // --- the list
      const hay = new Map(entries.map(e => [e, [...Nouns.namesOf(e), encCat(e.category)?.[1] || '', ...(e.tags || []).map(t => t.name), Nouns.plain(e.notes, 'html'), isGM() ? Nouns.plain(e.gm_notes, 'html') : '',
        ...conns.get(e.id).flatMap(c => [c.label, c.other.name]), ...files.list.filter(f => f.parent_id === e.id).flatMap(f => [f.name, f.caption || ''])].join('\n').toLowerCase()]));
      // The connection labels in use, as seen from either end: "has resident" and "resident of".
      const relUsed = new Map();
      for (const list of conns.values()) for (const c of list) relUsed.set(c.label.toLowerCase(), { name: c.label, color: c.type.color });
      const used = tagsOf(entries).sort((a, b) => a.name.localeCompare(b.name));
      const nearRow = el('div', { class: 'row small' });
      const search = el('input', { type: 'search', value: st.q, placeholder: 'Search names, notes and tags', 'aria-label': 'Search the Encyclopedia' });
      const lists = el('div', { class: 'enc-lists' });
      const byId = new Map(entries.map(e => [e.id, e]));
      const ctx = { rel, conns, entries, st, files, draw: null,
        web: opts => WebView.open({ conns, byId, href, campaignName: S.camp.name, ...opts }) };
      // Each entry is a small card: its name, its other names under it, and its tags along the bottom.
      const item = e => el('a', { class: 'enc-item enc-card' + (current?.id === e.id ? ' on' : ''), href: href(e.id), 'aria-current': current?.id === e.id ? 'page' : null },
        el('span', { class: 'enc-name' }, e.is_secret ? el('span', { 'data-tip': 'GM only' }, '🔒 ') : null, e.name,
          chars[e.id]?.sheet_visible ? el('span', { class: 'enc-sheet', role: 'link', tabindex: 0, 'aria-label': `Open ${e.name}'s sheet`, 'data-tip': 'Open the character sheet',
            onclick: ev => { ev.preventDefault(); ev.stopPropagation(); location.hash = `#/c/${S.camp.id}/characters/${chars[e.id].id}`; },
            onkeydown: ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); location.hash = `#/c/${S.camp.id}/characters/${chars[e.id].id}`; } } }, ' 📜') : null),
        e.aliases?.length ? el('small', { class: 'enc-alias' }, `also ${e.aliases.join(', ')}`) : null,
        e.tags?.length ? el('span', { class: 'etags' }, e.tags.map(tagChip)) : null);
      // Each entry's keys for each filter; '' is "none" (no Category, no tags, no connections).
      const keys = new Map(entries.map(e => [e, {
        cat: [e.category || ''],
        tag: e.tags?.length ? e.tags.map(t => t.name.toLowerCase()) : [''],
        rel: conns.get(e.id).length ? [...new Set(conns.get(e.id).map(c => c.label.toLowerCase()))] : [''],
      }]));
      const offOf = { cat: st.catsOff, tag: st.tagsOff, rel: st.relsOff };
      /** Whether e passes every filter but skip's (so each dropdown counts what ticking an option would add). */
      const passes = (e, skip) => {
        const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.every(w => hay.get(e).includes(w))) return false;
        if (st.near && e.id !== st.near && !conns.get(e.id).some(c => c.other.id === st.near)) return false;
        if (st.kind && st.kind !== 'all' && chars[e.id]?.kind !== st.kind) return false;
        return Object.entries(offOf).every(([f, off]) => f === skip || keys.get(e)[f].some(k => !off.has(k)));
      };
      const countBy = f => {
        const n = new Map();
        for (const e of entries) if (passes(e, f)) for (const k of keys.get(e)[f]) n.set(k, (n.get(k) || 0) + 1);
        return n;
      };
      const catPick = multiPick('Category', 'categories', st.catsOff, () => draw());
      const tagPick = multiPick('Tags', 'tags', st.tagsOff, () => draw());
      const relPick = multiPick('Connections', 'connections', st.relsOff, () => draw());
      catPick.node.classList.add('enc-catpick'); tagPick.node.classList.add('enc-tagpick'); relPick.node.classList.add('enc-relpick');
      const clearAll = btn('Show all', () => { for (const off of Object.values(offOf)) off.clear(); st.q = search.value = ''; st.near = null; st.kind = 'all'; draw(); }, 'link small', 'Clear the search and every filter');
      // PCs and NPCs: the entries with a character sheet of each kind
      const kindSeg = hasChars ? el('div', { class: 'seg enc-kinds', role: 'group', 'aria-label': 'Characters' }) : null;
      const drawKinds = () => kindSeg?.replaceChildren(...[['all', 'All', 'Every entry'], ['pc', 'PCs', 'Only entries with a PC\'s sheet'], ['npc', 'NPCs', 'Only entries with an NPC\'s sheet']].map(([k, l, t]) =>
        btn(l, () => { st.kind = k; draw(); }, (st.kind || 'all') === k ? 'small on' : 'small', t)));
      const filters = el('div', { class: 'enc-filters' }, kindSeg, catPick.node, used.length ? tagPick.node : null, relUsed.size ? relPick.node : null, clearAll);
      const draw = () => {
        const shown = entries.filter(e => passes(e));
        const blank = shown.filter(entryBlank);
        const section = (key, title, list, tipText) => {
          const folded = st.folded.has(key);
          const head = el('button', { type: 'button', class: 'enc-fold', 'aria-expanded': String(!folded), onclick: () => { folded ? st.folded.delete(key) : st.folded.add(key); draw(); } },
            title);
          return el('section', { class: key === 'blank' ? 'enc-blank' : null, 'data-cat': key }, el('h3', {}, head, tipText ? tip(tipText) : null), folded ? [] : list.map(item));
        };
        const of = entries.length !== shown.length ? ` of ${entries.length}` : '';
        // Grouped by Category, in the order they are listed, then the entries with none.
        const groups = [...ENC_CATEGORIES, ['', 'No category', '']].map(([k, name, icon]) => [k, `${icon ? `${icon} ` : ''}${name}`, shown.filter(e => (e.category || '') === k)]).filter(g => g[2].length);
        const onlyNone = groups.length === 1 && groups[0][0] === '';
        lists.replaceChildren(...clean([
          blank.length ? section('blank', `Blank Entries (${blank.length})`, blank,
            'Entries with nothing written about them yet, such as names just added by the Feature Highlighter. Open one to describe it') : null,
          shown.length ? el('p', { class: 'small muted enc-count' }, `${shown.length}${of} entries`) : null,
          shown.length && groups.length && !onlyNone ? groups.map(([k, title, list]) => section(k, `${title} (${list.length})`, list))
            : shown.length ? section('all', `All entries (${shown.length}${of})`, shown)
            : el('p', { class: 'muted small' }, entries.length ? 'Nothing matches. Clear the search or the filters to see more.'
              : 'No entries yet. Add one, or scan the campaign for names that are missing.')]));
        const cats = countBy('cat'), tags = countBy('tag'), rels = countBy('rel');
        catPick.update([...ENC_CATEGORIES, ['', 'No category']].map(([k, name]) => ({ key: k, name, count: cats.get(k) || 0 })));
        tagPick.update([...used.map(t => ({ key: t.name.toLowerCase(), name: t.name, color: t.color })), { key: '', name: 'No tags' }].map(o => ({ ...o, count: tags.get(o.key) || 0 })));
        relPick.update([...[...relUsed].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([k, t]) => ({ key: k, name: t.name, color: t.color })), { key: '', name: 'No connections' }]
          .map(o => ({ ...o, count: rels.get(o.key) || 0 })));
        clearAll.hidden = shown.length === entries.length;
        drawKinds();
        kindSeg?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
        const near = st.near && entries.find(e => e.id === st.near);
        nearRow.hidden = !near;
        nearRow.replaceChildren(...(near ? [el('span', { class: 'muted' }, 'Connected to'), el('strong', {}, near.name),
          btn('× Clear', () => { st.near = null; draw(); }, 'link small', 'Show every entry again')] : []));
      };
      ctx.draw = draw;
      search.addEventListener('input', () => { st.q = search.value; draw(); });
      draw();
      const scanBtn = btn('🔍 Scan campaign', null, '', 'Run the Feature Highlighter over everything written in the campaign (notes, events, reminders, Locations visited, downtime, Party Holdings and the Library) and offer the names that are missing');
      scanBtn.addEventListener('click', busy(scanBtn, () => fullScan()));
      const ignored = S.encIgnored.length ? el('details', { class: 'enc-ignored' },
        el('summary', { class: 'small' }, `Ignored words (${S.encIgnored.length})`),
        el('p', { class: 'small muted' }, isGM() ? 'Words the GMs told the Feature Highlighter not to offer. Restore one to have it offered again.'
          : 'Words the players told the Feature Highlighter not to offer. Restore one to have it offered again.'),
        el('div', { class: 'enc-ignored-list' }, S.encIgnored.map(t => el('span', { class: 'enc-ignored-word' }, t, ' ',
          btn('Restore', async () => {
            try { await post('term_restore', { term: t }, S.camp.id); S.encIgnored = S.encIgnored.filter(x => x !== t); route(); } catch (err) { toast(err.message, true); }
          }, 'link small', `Have the Feature Highlighter offer "${t}" again`))))) : null;
      // --- the entry picked, or the newest ones to start from
      const reader = el('section', {});
      if (!current) readerEmpty(reader, { lead: entries.length ? 'Pick an entry to read it.' : 'Nothing here yet.',
        title: 'Newest', start: entries.filter(e => !entryBlank(e)).sort((a, b) => b.id - a.id).slice(0, 5)
          .map(e => el('a', { class: 'enc-card lp-start-item', href: href(e.id) }, el('span', { class: 'enc-name' }, e.name),
            encCat(e.category) ? el('small', { class: 'enc-alias' }, `${encCat(e.category)[2]} ${encCat(e.category)[1]}`) : null)),
        help: 'When you save a note, an event, a reminder, a day\'s Locations visited, a downtime card, a holding or a tome, the Feature Highlighter offers any new names it finds: capitalized words, words in bold, italics or underline, and words set apart *like this* or in "quote marks".' });
      else if (!current.id || entryBlank(current)) reader.append(entryEditor(current, ctx));
      else reader.append(...entryView(current, ctx));
      // The list and the entry swap widths with Wide view, or the list folds away with Hide list, remembered in this browser.
      mount(...campaignHeader('encyclopedia'), listPage({ title: 'Encyclopedia', picked: !!current,
        tipText: 'The people, places, items, groups and the like that turn up in play. Every name here is linked wherever it is written in the campaign. Everyone can add entries and write their Public notes; GM notes are for GMs only',
        add: el('a', { class: 'button primary small', href: href('new'), 'data-tip': 'Start an entry by hand' }, '+ New entry'),
        more: [scanBtn, [...conns.values()].some(l => l.length) ? btn('🕸 Campaign web', () => ctx.web({ center: null }), '', 'Draw every connection in the Encyclopedia as a web you can pan, zoom and filter by kind') : null, btn('⬇ Export…', () => exportLore(entries, conns, entries.filter(e => passes(e))), '', 'Download the Encyclopedia for a virtual tabletop or a wiki: Markdown pages with their pictures, or a Foundry VTT journal. It holds only what you can see here')],
        hide: { key: 'chronicle:enchide' },
        wide: { key: 'chronicle:encwide', tips: ['Widen the list to see more of the Encyclopedia at once, and narrow the entry', 'Give the entry its room back and narrow the list'] },
        top: [search, filters, nearRow], list: el('div', {}, lists, ignored, isGM() ? relationKinds(rel) : null), reader }));
    }

    /** The campaign's text that names entry e (encyclopedia_sources with names: only the sources containing one), asked
     * once for an entry's page, which shows it twice ("Mentioned in", "Where it was found"). */
    let namingCache = null;
    function sourcesNaming(e) {
      const names = Nouns.namesOf(e), key = `${S.camp.id}|${S.camp.changed}|${JSON.stringify(names)}`;
      if (namingCache?.key !== key || Date.now() - namingCache.at > 15000)
        namingCache = { key, at: Date.now(), p: api('encyclopedia_sources', { query: { cid: S.camp.id, names: JSON.stringify(names) } }) };
      namingCache.p.catch(() => { namingCache = null; });
      return namingCache.p;
    }
    /** Delete for entry e, for a GM or whoever added it: on its page and in its editor, so a blank entry, which opens
     * straight in its editor, can go without being written in first. */
    function deleteEntryBtn(e) {
      if (!e.id || !(isGM() || e.created_by === S.user.id)) return null;
      return btn('Delete', async () => {
        if (!await confirmDialog(`Delete "${e.name}" from the Encyclopedia?`, { ok: 'Delete', danger: true })) return;
        try { await post('entry_delete', { id: e.id }, S.camp.id); location.hash = `#/c/${S.camp.id}/encyclopedia`; } catch (err) { toast(err.message, true); }
      }, 'small danger', 'Delete this entry. Its name stays in the text it was found in');
    }
    /** The character card: the whole card opens the sheet; nothing of it for members the sheet is hidden from. */
    function characterCard(e) {
      const ch = S.encChars?.[e.id] || null;
      if (!ch?.sheet_visible) return null;
      const pic = (e.files || []).find(f => f.kind === 'image' || (f.kind === 'embed' && !f.embed?.gone))?.url || null;
      return el('a', { class: 'card enc-character', href: `#/c/${S.camp.id}/characters/${ch.id}`, 'data-tip': 'Open the character sheet' },
        pic ? el('img', { src: pic, alt: '', class: 'character-pic' }) : null,
        el('div', {},
          el('div', { class: 'row' }, el('span', { class: `chip kind-${ch.kind}` }, ch.kind === 'npc' ? 'NPC' : 'PC'),
            ch.kind === 'pc' && ch.owner ? el('span', {}, `Played by ${ch.owner.name}`) : null, el('span', { class: 'muted small' }, ch.game)),
          (ch.summary || []).filter(f => f.value !== null && f.value !== '' && typeof f.value !== 'object').map(f => el('div', { class: 'small' }, `${f.label}: ${f.value}`))));
    }
    /** An entry's tools, on its page and in its editor alike: Copy as handout and the scan for its name. */
    function entryTools(e, ctx) {
      return [btn('📋 Copy as handout', () => copyHandout(e, ctx), 'small', 'Copy this entry, formatted, to paste into a Roll20 handout, an Owlbear Rodeo note or a Foundry journal. GM notes and GM-only paragraphs are left out. In the editor it copies the entry as last saved'),
        scanOneBtn('entry', s => s.kind.startsWith('entry') && s.id === e.id, `"${e.name}"`),
        isGM() && e.is_secret ? btn('🔓 Reveal entry', async () => {
          const v = await KIT.dialog({ title: 'Reveal this entry to the players?', message: `${e.name} stops being GM only: players see it, its public notes and its pictures that aren't GM only from now on. GM notes and GM-only paragraphs stay hidden.`,
            buttons: [{ value: 'log', label: 'Reveal and log it today', cls: 'primary', focus: true }, { value: 'quiet', label: 'Just reveal' }, { value: 'cancel', label: 'Cancel' }] });
          if (v !== 'log' && v !== 'quiet') return;
          try {
            await post('item_reveal', { kind: 'entry', id: e.id, log: v === 'log' }, S.camp.id);
            toast(v === 'log' ? 'Revealed, and logged on today\'s events' : 'Revealed to the players');
            route();
          } catch (err) { toast(err.message, true); }
        }, 'small', 'Make this GM-only entry public: players see it from now on, and you can note it as an event on the current day') : null,
        isGM() ? btn('🕘 History', () => HistoryView.open({ kind: 'entry', ref: e.id, title: e.name, cid: S.camp.id, api, post, onRestore: route }), 'small', 'Earlier versions of this entry, what each save changed, and Restore. GMs only') : null];
    }
    /** The editor, with everything the entry's page offers: its tools, its character card and its connections. */
    function entryEditor(e, ctx) {
      return entryForm(e, e.id ? { tools: entryTools(e, ctx), extra: [characterCard(e), connectionsCard(e, ctx)] } : {});
    }
    function entryView(e, ctx) {
      const box = el('div', { class: 'enc-mentioned' }, el('h4', {}, 'Mentioned in'), el('p', { class: 'muted small' }, 'Looking…'));
      sourcesNaming(e).then(({ sources }) => {
        const linker = Nouns.linker([e], () => null), seen = new Set(), list = [];
        for (const s of sources) {
          if (s.kind.startsWith('entry') && s.id === e.id) continue;
          if (!linker.mentions(Nouns.plain(s.text, s.format)).length) continue;
          const [label, to] = sourceLabel(s);
          if (seen.has(label)) continue;
          seen.add(label); list.push(el('li', {}, el('a', { href: to }, label)));
        }
        box.replaceChildren(el('h4', {}, 'Mentioned in', tip('Every place in the campaign where this name is written, that you can see')),
          list.length ? el('ul', { class: 'enc-where' }, list.slice(0, 100)) : el('p', { class: 'muted small' }, 'Nowhere yet.'));
      }).catch(() => box.lastChild.replaceWith(el('p', { class: 'muted small' }, 'Could not look that up just now.')));
      // An entry's own name isn't linked in its notes.
      const others = Nouns.linker(S.encyclopedia.filter(x => x.id !== e.id), (x, text) => el('a', { class: 'enc-link', href: `#/c/${S.camp.id}/encyclopedia/${x.id}`, 'data-tip': `${x.name}: open it in the Encyclopedia`, 'data-tip-img': x.pic || null }, text));
      const note = html => others.tree(RichText.view(html, 'html'));
      const publicNote = html => revealButtons(note(html), 'entry', e.id);
      const ch = S.encChars?.[e.id] || null;
      const sheetHref = ch ? `#/c/${S.camp.id}/characters/${ch.id}` : null;
      return clean([
        el('div', { class: 'row spread' },
          el('h2', {}, e.token_url && typeof TokensTab !== 'undefined' ? TokensTab.face(el, e.token_url, e.name) : null, e.is_secret ? secretTag() : null, e.name),
          el('div', { class: 'row' },
            ch?.sheet_visible ? el('a', { class: 'button small primary', href: sheetHref, 'data-tip': `Open ${e.name}'s character sheet` }, 'Open sheet') : null,
            !ch && isGM() && typeof Sheets !== 'undefined' && (!e.category || e.category === 'person')
              ? btn('Add character sheet', () => Sheets.addToEntry(e).catch(err => toast(err.message, true)), 'small', 'Give this person a character sheet, for an NPC with stats') : null,
            isGM() && typeof Sheets !== 'undefined' && (ch || !e.category || e.category === 'person')
              ? btn('Link a member…', () => Sheets.linkMember(e).catch(err => toast(err.message, true)), 'small', 'Say which member of the campaign plays this person: it becomes their character (a sheet is made if it has none)') : null,
            btn('Edit', ev => ev.currentTarget.closest('.enc-detail').replaceChildren(entryEditor(e, ctx)), ch?.sheet_visible ? 'small' : 'small primary', 'Change this entry'),
            ...entryTools(e, ctx),
            deleteEntryBtn(e))),
        mapLinks('entry_id', e.id),
        characterCard(e),
        encCat(e.category) || e.tags?.length ? el('div', { class: 'etags' }, encCat(e.category) ? el('span', { class: 'chip enc-cat', 'data-tip': 'Category' }, `${encCat(e.category)[2]} ${encCat(e.category)[1]}`) : null,
          (e.tags || []).map(tagChip)) : null,
        e.aliases?.length ? el('div', { class: 'small' }, el('span', { class: 'muted' }, 'Also called '), e.aliases.join(', ')) : null,
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip('Everyone in the campaign can read these')),
          (e.notes || '').trim() ? publicNote(e.notes) : el('p', { class: 'muted' }, 'Nothing written yet.')),
        isGM() ? el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 GM notes', tip('Only GMs ever see these. The server never sends them to players')),
          (e.gm_notes || '').trim() ? note(e.gm_notes) : el('p', { class: 'muted' }, 'Nothing written yet.')) : null,
        connectionsCard(e, ctx),
        e.author ? el('small', { class: 'muted' }, 'Added by ', byline(e)) : null,
        attachmentsCard('encyclopedia', e.id, e.files || [], { uploads: S.encUploads, secret: e.is_secret, name: e.name }),
        box]);
    }

    // ------------------------------------------------------------ the Encyclopedia for virtual tabletops
    /** Entries as static/lore-export.js takes them: each with its connections as seen from it. */
    const loreEntries = (list, conns) => list.map(e => ({ ...e, files: e.files || [],
      links: (conns.get(e.id) || []).map(c => ({ label: c.label, to: c.other.id, note: c.r.note, is_secret: !!c.r.is_secret })) }));
    function saveFile(blob, name) {
      const a = el('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      // iPad Safari reads the file only once its "Download?" prompt is answered, so keep it for a minute, not a second
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    /** One entry, formatted, on the clipboard: HTML for a handout, and Markdown for anything that only takes text. */
    async function copyHandout(e, ctx) {
      // a GM-only entry is copied whole for the GM; any other leaves out what players can't see
      const all = LoreExport.pick(loreEntries(ctx.entries, ctx.conns), { gmOnly: !!e.is_secret });
      const one = all.find(x => x.id === e.id);
      const names = new Map(all.map(x => [x.id, x.name]));
      const html = LoreExport.handout(one, names);
      const text = `# ${one.name}\n\n${RichText.toMarkdown(one.notes || '')}`;
      try {
        if (window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        else await navigator.clipboard.writeText(text);
        toast('Copied. Paste it into a handout or a note');
      } catch { toast('This browser won\'t let the page copy', true); }
    }
    /** The Export dialog: which entries, in which format, and for a GM whether GM-only things go too. */
    function exportLore(all, conns, shown) {
      const gm = isGM();
      const fmt = el('select', { 'aria-label': 'Format' },
        el('option', { value: 'md' }, 'Markdown pages and pictures (.zip): Obsidian, wikis, Owlbear notes, anything'),
        el('option', { value: 'foundry' }, 'Foundry VTT journal and pictures (.zip)'));
      const which = el('select', { 'aria-label': 'Which entries' },
        el('option', { value: 'all' }, `Every entry (${all.length})`),
        shown.length !== all.length ? el('option', { value: 'shown' }, `The ${shown.length} the search and filters show`) : null);
      const gmOnly = gm ? el('input', { type: 'checkbox' }) : null;
      const how = el('p', { class: 'small muted' });
      const status = el('p', { class: 'small muted', 'aria-live': 'polite' });
      const drawHow = () => how.replaceChildren(fmt.value === 'foundry'
        ? 'In Foundry: make a journal entry, right-click it and choose Import Data, then pick the .json file from the zip. Upload the zip\'s chronicle folder to Foundry\'s User Data (in the File Browser, or by copying it into the Data folder) so the pictures show. GM-only entries and notes are hidden from players there too.'
        : 'One page per entry, linked to each other, with an Encyclopedia page listing them all. Open the folder as an Obsidian vault, or paste a page into any wiki or VTT note.');
      fmt.addEventListener('change', drawHow);
      drawHow();
      const go = el('button', { type: 'button', class: 'primary' }, 'Download');
      const cancel = el('button', { value: 'cancel' }, 'Cancel');
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'Export the Encyclopedia' },
        el('form', { method: 'dialog' },
          el('h3', {}, '⬇ Export the Encyclopedia'),
          el('label', { class: 'row small' }, 'Format ', fmt),
          el('label', { class: 'row small' }, 'Entries ', which),
          gm ? el('label', { class: 'row small' }, gmOnly, ' Include GM-only entries, notes, paragraphs, connections and pictures') : el('p', { class: 'small muted' }, 'It holds what you can see here.'),
          how, status,
          el('div', { class: 'kit-dialog-actions' }, go, cancel)));
      d.addEventListener('close', () => d.remove());
      d.addEventListener('cancel', ev => { if (go.disabled) ev.preventDefault(); });
      go.addEventListener('click', busy(go, async () => {
        const withGm = !!gmOnly?.checked;
        const list = LoreExport.pick(loreEntries(which.value === 'shown' ? shown : all, conns), { gmOnly: withGm });
        if (!list.length) throw new Error('There are no entries to export.');
        const pictures = LoreExport.plan(list);
        const out = [], folder = fmt.value === 'foundry' ? `${LoreExport.foundryFolder(S.camp.name)}/` : '';
        let done = 0;
        for (const p of pictures) {
          status.textContent = `Fetching pictures and files: ${++done} of ${pictures.length}`;
          const res = await fetch(p.file.url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`Couldn't fetch ${p.file.name} (${res.status})`);
          out.push({ path: folder + p.path, data: new Uint8Array(await res.arrayBuffer()) });
        }
        const base = S.camp.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Campaign';
        const date = new Date().toISOString().slice(0, 10);
        if (fmt.value === 'foundry') out.unshift({ path: `${base} Encyclopedia (Foundry journal).json`, data: JSON.stringify(LoreExport.foundry(list, pictures, { campaign: S.camp.name, gmOnly: withGm }), null, 2) + '\n' });
        else out.unshift(...LoreExport.markdown(list, pictures, { campaign: S.camp.name, gm, gmOnly: withGm, toMarkdown: RichText.toMarkdown, date }).files.map(f => ({ path: f.path, data: f.text })));
        saveFile(new Blob([LoreExport.zip(out)], { type: 'application/zip' }), `${base} Encyclopedia${fmt.value === 'foundry' ? ' for Foundry' : ''}.zip`);
        d.close();
      }));
      document.body.append(d);
      d.showModal();
    }

    return { encLinker, linked, linkedNote, revealButtons, mentionRow, encMentions, offerNouns, sourceLabel, scanOneBtn, entryBlank, deleteEntryBtn, viewEncyclopedia, sourcesNaming, saveFile };
  }
  root.EncyclopediaTab = { make };
})(window);
