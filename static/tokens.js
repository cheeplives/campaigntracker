/* tokens.js — the Tokens tab: a library of token pictures (api/maps.php), each a round marker that a party group, a
 * character, an Encyclopedia entry or a creature wears. GMs only. app.js hands it a context (mapsCtx) so this file
 * needs nothing else of the page; it is a module of its own so the tab does not wait for the Maps tab.
 *
 * Plain script, no build step. TokensTab.face() draws the round marker, which the Members tab and an entry's page use. */
'use strict';

const TokensTab = (() => {
  const KINDS = [['party', 'Party'], ['character', 'Character'], ['creature', 'Creature'], ['object', 'Object']];
  const kindName = k => KINDS.find(([v]) => v === k)?.[1] || k;

  // Game icons: the game-icons.net set, copied into static/vendor/game-icons (tools/game-icons-build.js). A GM picks one,
  // and the browser draws it white on its kind's colour and uploads the picture as a new token, credited to its artist.
  const ICONS = 'static/vendor/game-icons/';
  const KIND_COLOURS = { party: '#b07a1c', character: '#3f5f8f', creature: '#9a3a2c', object: '#5f6b3a' };
  // A dozen ready-made tokens for each setting genre (Settings → genre): [kind, icon, name].
  const STARTERS = {
    fantasy: [['party', 'delapouite/knight-banner', 'Adventuring party'], ['character', 'lorc/visored-helm', 'Warrior'],
      ['character', 'delapouite/wizard-face', 'Wizard'], ['character', 'darkzaitzev/hooded-assassin', 'Rogue'], ['character', 'delapouite/sun-priest', 'Priest'],
      ['creature', 'delapouite/goblin-head', 'Goblin'], ['creature', 'delapouite/orc-head', 'Orc'], ['creature', 'skoll/skeleton', 'Skeleton'],
      ['creature', 'lorc/wolf-head', 'Wolf'], ['creature', 'lorc/dragon-head', 'Dragon'], ['object', 'lorc/locked-chest', 'Treasure chest'], ['object', 'lorc/campfire', 'Campfire']],
    modern: [['party', 'delapouite/jeep', 'Party vehicle'], ['character', 'delapouite/police-officer-head', 'Police officer'],
      ['character', 'skoll/balaclava', 'Masked thug'], ['character', 'skoll/gas-mask', 'Soldier'], ['character', 'delapouite/spy', 'Agent'],
      ['character', 'delapouite/person', 'Bystander'], ['creature', 'delapouite/sitting-dog', 'Guard dog'], ['creature', 'delapouite/shambling-zombie', 'Zombie'],
      ['object', 'delapouite/cctv-camera', 'Security camera'], ['object', 'delapouite/laptop', 'Laptop'], ['object', 'delapouite/first-aid-kit', 'First-aid kit'],
      ['object', 'delapouite/money-stack', 'Cash']],
    scifi: [['party', 'delapouite/spaceship', 'Party ship'], ['character', 'lorc/space-suit', 'Spacer'], ['character', 'delapouite/astronaut-helmet', 'Trooper'],
      ['character', 'delapouite/cyborg-face', 'Cyborg'], ['character', 'delapouite/robot-helmet', 'Robot'], ['creature', 'lorc/alien-stare', 'Alien'],
      ['creature', 'delapouite/alien-bug', 'Xeno bug'], ['creature', 'delapouite/delivery-drone', 'Drone'], ['creature', 'delapouite/battle-mech', 'Mech'],
      ['object', 'delapouite/laser-turret', 'Turret'], ['object', 'delapouite/cargo-crate', 'Cargo crate'], ['object', 'sbed/medical-pack', 'Medkit']],
  };
  let iconIndex = null;
  /** The set's index (every icon as "artist/name", and the artists), fetched the first time it is needed. */
  function loadIcons() {
    iconIndex ??= fetch(ICONS + 'index.json', { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error('The game icons couldn\'t be loaded'); return r.json(); })
      .catch(err => { iconIndex = null; throw err; });
    return iconIndex;
  }
  const iconName = id => id.split('/')[1].replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
  /** The icons whose names hold every word typed, those with a word starting as typed first. */
  function findIcons(index, q) {
    const words = q.toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (!words.length) return [];
    const hits = index.icons.filter(id => { const n = id.split('/')[1]; return words.every(w => n.includes(w)); });
    const starts = id => id.split('/')[1].split('-').some(p => p.startsWith(words[0]));
    return hits.sort((a, b) => starts(b) - starts(a));
  }
  /** Draw icon `id` white on a disc of `colour` and return it as a 256-pixel PNG. */
  async function drawIcon(id, colour) {
    const res = await fetch(`${ICONS}svg/${id}.svg`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`The icon ${iconName(id)} couldn't be loaded`);
    // an explicit size, so every browser draws it at the size asked (an SVG with only a viewBox has none of its own)
    const svg = (await res.text()).replace(/currentColor/g, '#fff').replace('<svg ', '<svg width="512" height="512" ');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = colour; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.1)'; g.beginPath(); g.arc(128, 100, 150, 0, Math.PI * 2); g.fill();
    g.drawImage(img, 38, 38, 180, 180);
    return new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('The icon couldn\'t be drawn')), 'image/png'));
  }

  /** The round marker: the picture, or the name's first letter while there is none. */
  function face(el, url, name) {
    return el('span', { class: 'token-face', 'data-tip': name || null }, url ? el('img', { src: url, alt: name || '', loading: 'lazy' }) : el('span', { 'aria-hidden': 'true' }, (name || '?').trim().charAt(0).toUpperCase()));
  }

  /** Send one picture to token_upload (multipart, so not through api()), with name, kind or icon in extra; the new token comes back. */
  async function upload(ctx, file, extra = {}) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const res = await fetch('api/index.php?' + new URLSearchParams({ a: 'token_upload', cid: ctx.S.camp.id }), { method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': ctx.S.csrf }, body: fd });
    let data;
    try { data = await res.json(); } catch { throw new Error(res.status === 413 ? 'That file is too big for the server' : `Server error (${res.status})`); }
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `Error ${res.status}`), { status: res.status });
    return data.token;
  }

  async function view(ctx) {
    const { el, btn, api, post, field, select, toast, S } = ctx;
    const cid = S.camp.id;
    if (!ctx.isGM()) return ctx.mount(...ctx.campaignHeader('tokens'), el('div', { class: 'card' }, el('p', {}, 'Only the GM can manage tokens.')));
    let tokens = [], groups = [];
    const load = async () => {
      const [t, g] = await Promise.all([api('tokens', { query: { cid } }), api('groups', { query: { cid } })]);
      tokens = t.tokens; groups = g.groups;
    };
    await load();

    const grid = el('div', { class: 'token-grid' });
    const status = el('p', { class: 'small muted', role: 'status' });
    const search = el('input', { type: 'search', placeholder: 'Find a token', 'aria-label': 'Find a token', autocomplete: 'off' });
    const kind = select([['', 'All kinds'], ...KINDS], '', { 'aria-label': 'Kind' });
    const nameOf = (list, id) => list.find(x => x.id === id)?.name;
    const memberName = m => m.character_name || m.display_name;

    function draw() {
      const q = search.value.trim().toLowerCase();
      const shown = tokens.filter(t => (!kind.value || t.kind === kind.value) && (!q || t.name.toLowerCase().includes(q)));
      grid.replaceChildren(...(shown.length ? shown.map(card) : tokens.length ? [el('p', { class: 'muted' }, 'No token matches.')]
        : [el('div', { class: 'token-empty' }, el('p', { class: 'muted' }, 'No tokens yet. Upload some pictures, find one, or start with a dozen ready-made ones.'),
          btn(`Add ${ctx.genres[ctx.genre()]} starter tokens…`, gameIcons, 'small primary', 'Twelve tokens for this campaign\'s genre, from game-icons.net'))]));
    }
    const refresh = async () => { await load(); draw(); };
    /** After a change to what a token is used for: the members and entries the page holds carry its picture too. */
    const changed = async () => { await ctx.reloadCampaign(); await refresh(); };
    function card(t) {
      const uses = [t.member_id ? `Plays ${memberName(S.members.find(m => Number(m.id) === t.member_id) || { display_name: 'a player' })}` : null,
        t.entry_id ? `Stands for ${nameOf(S.encyclopedia, t.entry_id) || 'an entry'}` : null,
        ...t.groups.map(g => `Marks ${nameOf(groups, g) || 'a group'}`)].filter(Boolean);
      return el('div', { class: 'token-card' + (t.is_secret ? ' secret' : ''), 'data-id': t.id },
        face(el, t.image_url, t.name),
        el('strong', { class: 'token-name' }, t.is_secret ? '🔒 ' : '', t.name),
        el('span', { class: 'small muted' }, kindName(t.kind), t.size_squares > 1 ? ` · ${t.size_squares}×${t.size_squares}` : ''),
        uses.length ? el('span', { class: 'small token-uses' }, uses.join(' · ')) : null,
        btn('Edit', () => edit(t), 'small', `Change ${t.name}: who or what wears it, its size, its picture`));
    }

    /** Send the chosen files one at a time, then show the new tokens. */
    async function send(files) {
      files = [...files];
      let done = 0;
      for (const f of files) {
        status.textContent = `Uploading ${f.name}…`;
        try { await upload(ctx, f); done++; } catch (err) { toast(`${f.name}: ${err.message}`, true); }
      }
      status.textContent = '';
      if (done) { toast(done === 1 ? 'Token added' : `${done} tokens added`); api('changed', { query: { cid } }).then(r => { S.camp.changed = r.changed; }).catch(() => {}); await refresh(); }
    }
    const input = el('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'file-input', 'aria-label': 'Upload token pictures' });
    input.addEventListener('change', () => { send(input.files); input.value = ''; });

    /** Find Image for a token: the token is made first (named for what is looked up), then the picture picked is its picture. */
    function findFor(t) {
      const d = el('dialog', { class: 'kit-dialog token-dialog', 'aria-label': 'Find a picture for a token' });
      let current = t, picked = false;
      const close = el('button', { type: 'button', onclick: () => d.close() }, 'Close');
      const show = tok => {
        current = tok;
        d.replaceChildren(el('h3', {}, `Find a picture for ${tok.name}`), ctx.findImage('token', tok.id, tok.name, { copyOnly: true, onAdded: async file => {
          try { await post('token_save', { id: tok.id, image_id: file.id }, cid); picked = true; d.close(); } catch (err) {
            await post('file_delete', { id: file.id }, cid).catch(() => {});   // not kept as a picture the token can't use
            toast(err.message, true);
          }
        } }), el('div', { class: 'kit-dialog-actions' }, close));
      };
      if (t) show(t);
      else {
        const name = el('input', { maxlength: 100, placeholder: 'e.g. goblin archer', 'aria-label': 'What to look for', class: 'kit-dialog-input' });
        const form = el('form', {}, el('h3', {}, 'Find a token picture'), field('What is it a token of?', name, 'It names the token, and starts the search'),
          el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Search'), el('button', { type: 'button', onclick: () => d.close() }, 'Cancel')));
        form.addEventListener('submit', async ev => {
          ev.preventDefault();
          if (!name.value.trim()) return toast('Type what to look for', true);
          try { show((await post('token_save', { name: name.value.trim() }, cid)).token); } catch (err) { toast(err.message, true); }
        });
        d.append(form);
      }
      // a token made for a search that found nothing is not kept
      d.addEventListener('close', async () => { d.remove(); if (!t && current && !picked) await post('token_delete', { id: current.id }, cid).catch(() => {}); changed().catch(() => {}); });
      document.body.append(d);
      d.showModal();
    }

    /** Game icons: search the game-icons.net set, or start from the genre's starter set, and add picks as tokens. The
     * dialog stays open to add more; the Tokens tab behind it fills in as they are added. */
    async function gameIcons() {
      const d = el('dialog', { class: 'kit-dialog token-dialog gi-dialog', 'aria-label': 'Game icons' });
      d.addEventListener('close', () => d.remove());
      document.body.append(d);
      d.showModal();
      let index;
      try { index = await loadIcons(); } catch (err) { d.close(); return toast(err.message, true); }
      const added = new Set();
      let picked = null;   // { id, kind?, name? }
      const q = el('input', { type: 'search', placeholder: 'Search icons: goblin, sword, ship…', 'aria-label': 'Search the game icons', autocomplete: 'off', class: 'grow' });
      const genreSel = select(Object.entries(ctx.genres), ctx.genre(), { 'aria-label': 'Genre' });
      const results = el('div', { class: 'gi-grid', role: 'list' });
      const note = el('p', { class: 'small muted', role: 'status' });
      const name = el('input', { maxlength: 100, 'aria-label': 'Token name', placeholder: 'Pick an icon' });
      const kindSel = select(KINDS, 'creature', { 'aria-label': 'Kind' });
      const preview = el('span', { class: 'gi-face gi-preview' });
      const credit = el('span', { class: 'small muted' });
      const addOne = el('button', { type: 'button', class: 'primary', disabled: true }, 'Add token');
      const addAll = btn('Add all 12', () => addSet(), 'small primary', 'Add every token of this starter set that isn\'t added yet');
      const starters = () => STARTERS[genreSel.value].map(([kind, id, nm]) => ({ id, kind, name: nm }));
      const artistOf = id => index.artists[id.split('/')[0]];
      const faceFor = (id, colour) => el('span', { class: 'gi-face', style: { background: colour } }, el('img', { src: `${ICONS}svg/${id}.svg`, alt: '', loading: 'lazy' }));
      function cell(it) {
        const a = artistOf(it.id);
        return el('button', { type: 'button', class: 'gi-cell', role: 'listitem', 'aria-pressed': String(picked?.id === it.id && picked?.name === it.name), 'data-icon': it.id,
          'data-tip': `${iconName(it.id)} by ${a?.name || 'unknown'}`, onclick: () => pick(it) },
          faceFor(it.id, KIND_COLOURS[it.kind || kindSel.value]), el('span', { class: 'gi-label' }, added.has(it.name ?? it.id) ? '✓ ' : '', it.name || iconName(it.id)));
      }
      function list() {
        const term = q.value.trim();
        const shown = term ? findIcons(index, term) : null;
        addAll.style.display = genreSel.parentElement.style.display = term ? 'none' : '';   // a starter set only while not searching
        const items = shown ? shown.slice(0, 120).map(id => ({ id })) : starters();
        results.replaceChildren(...(items.length ? items.map(cell) : [el('p', { class: 'muted' }, 'No icon has that in its name. Try a shorter word, like "orc" or "gun".')]));
        note.textContent = shown ? (shown.length > 120 ? `Showing 120 of ${shown.length}. Type more to narrow it down.` : `${shown.length} found.`)
          : `The ${ctx.genres[genreSel.value]} starter set. Search for any of the ${index.icons.length.toLocaleString()} icons.`;
      }
      function pick(it) {
        picked = it;
        name.value = it.name || iconName(it.id);
        if (it.kind) kindSel.value = it.kind;
        const a = artistOf(it.id);
        credit.textContent = `by ${a?.name || 'unknown'}, ${a?.licence === 'CC0' ? 'CC0' : 'CC BY 3.0'}`;
        addOne.disabled = false;
        paint(); list();
      }
      function paint() {
        preview.style.background = KIND_COLOURS[kindSel.value];
        preview.replaceChildren(picked ? el('img', { src: `${ICONS}svg/${picked.id}.svg`, alt: '' }) : el('span', { 'aria-hidden': 'true' }, '?'));
      }
      async function make(id, nm, kind) {
        const png = await drawIcon(id, KIND_COLOURS[kind]);
        await upload(ctx, new File([png], `${id.split('/')[1]}.png`, { type: 'image/png' }), { name: nm, kind, icon: id });
        added.add(nm); added.add(id);
      }
      async function addSet() {
        const todo = starters().filter(it => !added.has(it.name));
        let done = 0;
        addAll.disabled = true;
        for (const it of todo) {
          note.textContent = `Adding ${it.name} (${done + 1} of ${todo.length})…`;
          try { await make(it.id, it.name, it.kind); done++; } catch (err) { toast(`${it.name}: ${err.message}`, true); }
        }
        addAll.disabled = false;
        if (done) { toast(done === 1 ? 'Token added' : `${done} tokens added`); await refresh(); }
        list();
      }
      addOne.addEventListener('click', async () => {
        if (!picked) return;
        const nm = name.value.trim();
        if (!nm) return toast('Give the token a name', true);
        addOne.disabled = true;
        try { await make(picked.id, nm, kindSel.value); toast(`Added ${nm}`); await refresh(); list(); } catch (err) { toast(err.message, true); }
        addOne.disabled = false;
      });
      kindSel.addEventListener('change', () => { paint(); if (q.value.trim()) list(); });
      genreSel.addEventListener('change', list);
      let timer = 0;
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(list, 150); });
      q.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
      paint();
      d.append(el('h3', {}, 'Game icons'),
        el('p', { class: 'small muted' }, 'Icons from ', el('a', { href: 'https://game-icons.net/', target: '_blank', rel: 'noopener noreferrer' }, 'game-icons.net'),
          ', drawn white on the colour of their kind. Each token keeps its artist\'s credit.'),
        el('div', { class: 'row' }, q, el('label', { class: 'inline gi-genre' }, 'Starter set ', genreSel), addAll),
        note, results,
        el('div', { class: 'gi-pick row' }, preview, el('div', { class: 'gi-pick-fields' }, el('div', { class: 'row' }, name, kindSel), credit), addOne),
        el('div', { class: 'kit-dialog-actions' }, el('button', { type: 'button', onclick: () => d.close() }, 'Close')));
      list();
      q.focus();
    }

    function edit(t) {
      const name = el('input', { value: t.name, maxlength: 100, required: true, 'aria-label': 'Name' });
      const kindSel = select(KINDS, t.kind, { 'aria-label': 'Kind' });
      const size = select([1, 2, 3, 4].map(n => [n, n === 1 ? '1 square' : `${n} × ${n} squares`]), t.size_squares, { 'aria-label': 'Size' });
      const member = select([['', 'Nobody'], ...S.members.map(m => [m.id, memberName(m)])], t.member_id ?? '', { 'aria-label': 'Character' });
      const entry = select([['', 'No entry'], ...S.encyclopedia.map(e => [e.id, e.name])], t.entry_id ?? '', { 'aria-label': 'Entry' });
      const secret = el('input', { type: 'checkbox', checked: t.is_secret, 'aria-label': 'GM only' });
      const boxes = groups.map(g => ({ g, box: el('input', { type: 'checkbox', checked: t.groups.includes(g.id) }) }));
      const pic = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'file-input', 'aria-label': 'Change the picture' });
      const form = el('form', {}, el('h3', {}, `Token: ${t.name}`),
        el('div', { class: 'row token-edit-face' }, face(el, t.image_url, t.name),
          el('label', { class: 'button small file-add' }, pic, 'Change picture'),
          btn('Find Image…', () => { d.close(); findFor(t); }, 'small', 'Search open picture libraries for a picture of this')),
        t.credit ? ctx.creditLine({ credit: t.credit }) : null,
        field('Name', name), field('Kind', kindSel), field('Size', size, 'How many squares across it covers on a gridded map'),
        field('Character', member, 'The player whose character wears it. A character has one token'),
        field('Entry', entry, 'An Encyclopedia entry it stands for, shown on the entry\'s page and on the entry\'s pins on a map'),
        el('fieldset', { class: 'token-uses-box' }, el('legend', {}, 'Use for'),
          boxes.length ? boxes.map(({ g, box }) => el('label', { class: 'inline' }, box, ` ${g.name}`)) : el('span', { class: 'muted small' }, 'No party groups yet.')),
        el('label', { class: 'lock-toggle', 'data-tip': 'GM only: players are never shown a GM-only token\'s picture' }, secret, el('span', { 'aria-hidden': 'true' }, '🔒')),
        el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Save'),
          btn('Delete', async () => {
            d.close();
            if (!await ctx.confirmDialog(`Delete the token "${t.name}"? Whatever uses it goes back to having none.`, { ok: 'Delete', danger: true })) return;
            try { await post('token_delete', { id: t.id }, cid); toast('Token deleted'); await changed(); } catch (err) { toast(err.message, true); }
          }, 'danger'),
          el('button', { type: 'button', onclick: () => d.close() }, 'Cancel')));
      pic.addEventListener('change', async () => {
        const f = pic.files[0];
        if (!f) return;
        let file = null;
        try {
          file = await ctx.uploadFile('token', t.id, f);
          await post('token_save', { id: t.id, image_id: file.id }, cid);
          d.close(); toast('Picture changed'); await changed();
        } catch (err) {
          if (file) await post('file_delete', { id: file.id }, cid).catch(() => {});
          toast(err.message, true);
        }
      });
      const d = el('dialog', { class: 'kit-dialog token-dialog', 'aria-label': `Change ${t.name}` }, form);
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        try {
          await post('token_save', { id: t.id, name: name.value.trim(), kind: kindSel.value, size_squares: Number(size.value), member_id: member.value || null,
            entry_id: entry.value || null, is_secret: secret.checked, group_ids: boxes.filter(b => b.box.checked).map(b => b.g.id) }, cid);
          d.close(); toast('Saved'); await changed();
        } catch (err) { toast(err.message, true); }
      });
      d.addEventListener('close', () => d.remove());
      document.body.append(d);
      d.showModal();
      name.focus();
    }

    search.addEventListener('input', draw);
    kind.addEventListener('change', draw);
    draw();
    ctx.mount(...ctx.campaignHeader('tokens'), el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h2', {}, 'Tokens'),
        el('div', { class: 'row' }, el('label', { class: 'button small primary file-add', 'data-tip': 'Pick pictures (JPEG, PNG, GIF, WebP): each becomes a token named after its file' }, input, 'Upload tokens…'),
          btn('Find Image…', () => findFor(null), 'small', 'Search open picture libraries for a token picture'),
          btn('Game icons…', gameIcons, 'small', 'Pick from over 4,000 game-icons.net icons, or add a starter set for the genre'))),
      el('p', { class: 'muted small' }, 'Round pictures for the party\'s groups (their marker on a map), the players\' characters (the Members tab) and the Encyclopedia\'s entries (the entry\'s page and its pins on a map). Players see a token\'s picture only where it is used, and never a 🔒 GM-only one.'),
      el('div', { class: 'row' }, search, kind), status, grid));
  }

  return { view, face };
})();
