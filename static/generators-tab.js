/* generators-tab.js — The Generators tab: names, places and the like from static/generators.js, saved to the Encyclopedia.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { S, api, btn, busy, cal, campaignHeader, clean, el, encCatNamed, field, hideTip, isGM, lockBox, mount, post, select, tip, toast } = ctx;

    // ------------------------------------------------------------ generators tab
    // Random names, taverns, companies and towns from static/generators.js. Nothing is stored until someone presses 📖 on
    // a result, which adds it to the Encyclopedia. The genre and each card's choices are remembered in this browser for
    // each campaign.
    const GEN_KEY = 'cc-generators';
    function genPrefs() {
      let all = {};
      try { all = JSON.parse(localStorage.getItem(GEN_KEY)) || {}; } catch { /* private mode: defaults */ }
      const name = cal().name || '';
      return { genre: /ship time/i.test(name) ? 'scifi' : /gregorian/i.test(name) ? 'modern' : 'fantasy', secret: true, ...all[S.camp.id] };
    }
    function setGenPrefs(p) {
      try {
        const all = JSON.parse(localStorage.getItem(GEN_KEY)) || {};
        all[S.camp.id] = { ...all[S.camp.id], ...p };
        localStorage.setItem(GEN_KEY, JSON.stringify(all));
      } catch { /* private mode: just this page */ }
    }
    /** Rich text for an Encyclopedia note, built from nodes so every word goes in as text. */
    const genHtml = (...kids) => el('div', {}, kids).innerHTML;
    async function genCopy(text) {
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('This browser won\'t let the page copy. Select the text instead', true); }
    }

    /** The 📖 button on a result: adds it to the Encyclopedia with tag and notes (rich text), then becomes a link to it. */
    function genAddButton(name, tag, notes) {
      const b = el('button', { type: 'button', class: 'small gen-add', 'aria-label': `Add ${name} to the Encyclopedia`,
        'data-tip': `Add ${name} to the Encyclopedia, ${encCatNamed(tag) ? 'as a' : 'tagged'} ${tag}${isGM() && genPrefs().secret ? ', as GM only' : ''}` }, '📖 Add');
      b.addEventListener('click', busy(b, async () => {
        const secret = isGM() && !!genPrefs().secret;
        // Person and Location are Categories; Rumor is a tag
        const cat = encCatNamed(tag);
        const { id } = await post('entry_save', { name, notes: notes(), ...(cat ? { category: cat } : { tags: [{ name: tag }] }), ...(isGM() ? { is_secret: secret } : {}) }, S.camp.id);
        S.encyclopedia = [...S.encyclopedia.filter(x => x.id !== id), { id, name, aliases: [], is_secret: secret, blank: false,
          preview: Nouns.plain(notes(), 'html').replace(/\s+/g, ' ').trim().slice(0, 140) }].sort((a, x) => a.name.localeCompare(x.name));
        toast(`Added ${name} to the Encyclopedia`);
        b.replaceWith(el('a', { class: 'button small gen-add', href: `#/c/${S.camp.id}/encyclopedia/${id}`, 'data-tip': 'Open its Encyclopedia entry' }, '📖 Open'));
      }));
      return b;
    }
    /** One result line: the name, a note under it, Copy and 📖 Add. */
    function genRow(r, tag) {
      return el('li', { class: 'gen-item' },
        el('div', { class: 'gen-what' }, el('span', { class: 'gen-name' }, r.name), r.note ? el('span', { class: 'small muted' }, r.note) : null),
        el('button', { type: 'button', class: 'small', 'aria-label': `Copy ${r.name}`, 'data-tip': 'Copy the name', onclick: () => genCopy(r.name) }, '📋'),
        genAddButton(r.name, tag, () => genHtml(r.note ? el('p', {}, r.note) : null)));
    }
    /** A generator card: a title, its own choices, the Generate button and the results under them. roll() gives the nodes. */
    function genCard(title, tipText, controls, roll, cls) {
      const out = el('div', { class: 'gen-out' });
      const draw = () => { hideTip(); out.replaceChildren(...clean([roll()])); };
      const go = btn('🎲 Generate', draw, 'primary', 'Roll a new set');
      for (const c of controls) (c.matches('input') ? c : c.querySelector('select, input'))?.addEventListener('change', draw);
      draw();
      return el('section', { class: `card gen-card ${cls || ''}` }, el('h2', {}, title, tip(tipText)), el('div', { class: 'gen-controls' }, controls, go), out);
    }

    /** The campaign's Encyclopedia names sorted by Category (or else by tag), for rumors: {person, place, group, item}. Fetched once per change to the
     * Encyclopedia; until it arrives this gives {} and then calls ready() so the rumors can be drawn again. */
    let genCastMemo = null;
    function genCast(ready) {
      if (genCastMemo?.list === S.encyclopedia && genCastMemo.cid === S.camp.id) return genCastMemo.cast || {};
      const memo = genCastMemo = { list: S.encyclopedia, cid: S.camp.id, cast: null };
      const kinds = { person: /^(person|people|npc|character|pc)s?$/, place: /^(location|place|city|town|region|planet|station|building)s?$/,
        group: /^(group|faction|organi[sz]ation|company|guild|gang|corporation|house)s?$/, item: /^(item|object|artifact|artefact)s?$/ };
      api('encyclopedia', { query: { cid: S.camp.id } }).then(r => {
        const cast = { person: [], place: [], group: [], item: [] };
        for (const e of r.entries || []) {
          const tags = [e.category === 'location' ? 'place' : e.category, ...(e.tags || []).map(t => t.name.toLowerCase())].filter(Boolean);
          const k = Object.keys(kinds).find(k => tags.some(t => kinds[k].test(t)));
          if (k) cast[k].push(e.name);
        }
        memo.cast = cast;
        if (Object.values(cast).some(x => x.length)) ready();
      }).catch(() => { memo.cast = {}; });
      return {};
    }

    function viewGenerators() {
      const pref = genPrefs();
      const genre = select(Gen.GENRES, pref.genre, { 'aria-label': 'Genre' });
      genre.addEventListener('change', () => { setGenPrefs({ genre: genre.value }); viewGenerators(); });
      const g = genre.value;
      const keep = (k, sel) => { sel.addEventListener('change', () => setGenPrefs({ [k]: sel.value })); return sel; };

      const peoples = Gen.PEOPLES[g];
      const people = keep('people_' + g, select([['', 'Any'], ...peoples], pref['people_' + g] || peoples[0][0], { 'aria-label': 'Race or people' }));
      const gender = keep('gender', select(Gen.GENDERS, pref.gender || '', { 'aria-label': 'Gender' }));
      const traits = el('input', { type: 'checkbox', checked: !!pref.traits, onchange: e => setGenPrefs({ traits: e.target.checked }) });
      // Kind: a real name, or what someone goes by (a street name or handle, 'alias' for any of them) with the real name behind it.
      const nameKind = keep('nameKind', select([['', 'Real name'], ...Gen.ALIAS_KINDS, ['alias', 'Any street name or handle']], pref.nameKind || '', { 'aria-label': 'Kind of name' }));
      const kindName = Object.fromEntries(Gen.ALIAS_KINDS);
      const names = genCard('Names', 'Character names for this genre. Each people or culture has its own sounds; pick Any to mix them. Gender-neutral gives names used for anyone. Kind gives a street name, a cyberpunk handle or the tag a netrunner signs in cyberspace instead, with the real name behind it; any genre can use them. 📖 Add puts a name in the Encyclopedia as a Person, with its real name, look and quirk as notes',
        [field('Kind', nameKind), field('Race or people', people), field('Gender', gender),
          el('label', { class: 'inline small gen-traits', 'data-tip': 'Give each name how they look and a habit or manner, for an NPC on the spot' }, traits, 'Add a look and a quirk')],
        () => el('ul', { class: 'gen-list' }, Gen.many(10, () => nameKind.value
          ? Gen.alias(nameKind.value === 'alias' ? '' : nameKind.value, g, people.value, gender.value) : Gen.name(g, people.value, gender.value)).map(r => {
          const t = traits.checked ? Gen.traits(g, r.people) : null;
          const note = [r.kind && nameKind.value === 'alias' ? `${kindName[r.kind]}.` : '', r.note ? `${r.note}.` : '', t ? `${t.look}. ${t.quirk}.` : ''].filter(Boolean).join(' ');
          return genRow({ name: r.name, note }, 'Person');
        })));

      const taverns = genCard(g === 'western' ? 'Saloons & inns' : g === 'scifi' || g === 'cyberpunk' ? 'Bars & clubs' : 'Taverns, inns & pubs',
        'Places to eat, drink and sleep, each with what it\'s known for and who runs it. 📖 Add puts one in the Encyclopedia as a Location', [],
        () => el('ul', { class: 'gen-list' }, Gen.many(6, () => Gen.tavern(g)).map(r => genRow(r, 'Location'))));

      const sector = keep('sector', select(Gen.SECTORS, pref.sector || '', { 'aria-label': 'Line of business' }));
      const companies = genCard(g === 'fantasy' ? 'Guilds & companies' : g === 'western' ? 'Companies' : 'Companies & corporations',
        'Businesses, guilds and corporations for this genre. 📖 Add puts one in the Encyclopedia as a Group', [field('Line of business', sector)],
        () => el('ul', { class: 'gen-list' }, Gen.many(6, () => Gen.company(g, sector.value)).map(r => genRow(r, 'Group'))));

      const useEnc = el('input', { type: 'checkbox', checked: pref.useEnc !== false, onchange: e => setGenPrefs({ useEnc: e.target.checked }) });
      const rumors = genCard('Rumors', 'Talk the party overhears, and who they heard it from. With the box ticked, rumors are about the people, places, groups and items in your Encyclopedia (by their Categories and tags), with made-up names for the rest. 📖 Add puts one in the Encyclopedia, tagged Rumor',
        [el('label', { class: 'inline small gen-traits', 'data-tip': 'Use names from your Encyclopedia tagged Person, Location, Group or Item' }, useEnc, 'Use Encyclopedia names')],
        () => el('ul', { class: 'gen-list' }, Gen.rumors(g, 6, useEnc.checked ? genCast(() => useEnc.dispatchEvent(new Event('change'))) : {}).map(r => el('li', { class: 'gen-item' },
          el('div', { class: 'gen-what' }, el('span', { class: 'gen-rumor' }, r.name), el('span', { class: 'small muted' }, r.note)),
          el('button', { type: 'button', class: 'small', 'aria-label': 'Copy the rumor', 'data-tip': 'Copy the rumor', onclick: () => genCopy(r.name) }, '📋'),
          genAddButton(r.title, 'Rumor', () => genHtml(el('p', {}, r.name), el('p', {}, el('em', {}, r.note))))))));

      const size = keep('size', select(Gen.SIZE_KEYS.map(([k, l]) => [k, k ? `${l}: ${Gen.sizeLabel(g, k)}` : l]), pref.size || '', { 'aria-label': 'Size' }));
      const towns = genCard('Towns', 'A whole settlement: who runs it, what pays for it, a few places and people, and trouble for the party to walk into. 📖 Add puts the town, or any place or person in it, in the Encyclopedia',
        [field('Size', size)], () => genTown(Gen.town(g, size.value)), 'gen-town');

      const secret = isGM() ? lockBox(el('input', { type: 'checkbox', checked: pref.secret !== false, 'aria-label': 'Add to the Encyclopedia as GM only', onchange: e => setGenPrefs({ secret: e.target.checked }) }),
        'what you add with 📖 stays hidden from players until you turn GM only off on its entry') : null;
      mount(...campaignHeader('generators'), el('div', { class: 'gen-page' },
        el('div', { class: 'card gen-head' }, el('div', { class: 'row spread' },
          el('h2', {}, 'Generators', tip('Random names, handles, places, businesses, rumors and towns for when the players go somewhere you didn\'t plan. Everything here is made in your browser and nothing is saved unless you press 📖 Add')),
          el('div', { class: 'row gen-head-tools' }, el('label', { class: 'gen-genre' }, el('span', { class: 'lbl' }, 'Genre'), genre), secret))),
        names, taverns, companies, rumors, towns));
    }

    /** A generated town as a stat block, with 📖 Add for the town and for each place and person in it. */
    function genTown(t) {
      const pop = `${t.kind}, population about ${t.population.toLocaleString()}`;
      const facts = t.facts;
      const notes = () => genHtml(el('p', {}, el('strong', {}, pop)), el('ul', {}, facts.map(([k, v]) => el('li', {}, el('strong', {}, `${k}: `), v))),
        el('h3', {}, 'Places'), el('ul', {}, t.places.map(p => el('li', {}, `${p.name} (${p.note})`))),
        el('h3', {}, 'People'), el('ul', {}, t.people.map(p => el('li', {}, `${p.name}: ${p.note}`))),
        el('h3', {}, 'Trouble'), el('ul', {}, t.hooks.map(h => el('li', {}, h))));
      const text = [t.name, pop, ...facts.map(([k, v]) => `${k}: ${v}`), '', 'Places:', ...t.places.map(p => `- ${p.name} (${p.note})`),
        '', 'People:', ...t.people.map(p => `- ${p.name}: ${p.note}`), '', 'Trouble:', ...t.hooks.map(h => `- ${h}`)].join('\n');
      const sub = (title, list, tag, where) => el('div', { class: 'gen-sub' }, el('h3', {}, title), el('ul', { class: 'gen-list' }, list.map(r => el('li', { class: 'gen-item' },
        el('div', { class: 'gen-what' }, el('span', { class: 'gen-name' }, r.name), el('span', { class: 'small muted' }, r.note)),
        genAddButton(r.name, tag, () => genHtml(el('p', {}, `${r.note}, in ${where}.`)))))));
      return el('div', { class: 'gen-townblock' },
        el('div', { class: 'gen-town-title' }, el('div', {}, el('h3', {}, t.name), el('span', { class: 'muted' }, pop)),
          el('div', { class: 'row' }, el('button', { type: 'button', class: 'small', 'data-tip': 'Copy the whole town as text', onclick: () => genCopy(text) }, '📋 Copy'),
            genAddButton(t.name, 'Location', notes))),
        el('dl', { class: 'gen-facts' }, facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
        el('div', { class: 'gen-cols' }, sub('Places', t.places, 'Location', t.name), sub('People', t.people, 'Person', t.name),
          el('div', { class: 'gen-sub' }, el('h3', {}, 'Trouble'), el('ul', { class: 'gen-hooks' }, t.hooks.map(h => el('li', {}, h))))));
    }

    return { viewGenerators };
  }
  root.GeneratorsTab = { make };
})(window);
