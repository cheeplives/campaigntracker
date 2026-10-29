/* tokens.js — the Tokens tab: a library of token pictures (api/maps.php), each a round marker that a party group, a
 * character, an Encyclopedia entry or a creature wears. GMs only. app.js hands it a context (mapsCtx) so this file
 * needs nothing else of the page; it is a module of its own so the tab does not wait for the Maps tab.
 *
 * Plain script, no build step. TokensTab.face() draws the round marker, which the Members tab and an entry's page use. */
'use strict';

const TokensTab = (() => {
  const KINDS = [['party', 'Party'], ['character', 'Character'], ['creature', 'Creature'], ['object', 'Object']];
  const kindName = k => KINDS.find(([v]) => v === k)?.[1] || k;

  /** The round marker: the picture, or the name's first letter while there is none. */
  function face(el, url, name) {
    return el('span', { class: 'token-face', 'data-tip': name || null }, url ? el('img', { src: url, alt: name || '', loading: 'lazy' }) : el('span', { 'aria-hidden': 'true' }, (name || '?').trim().charAt(0).toUpperCase()));
  }

  /** Send one picture to token_upload (multipart, so not through api()); the new token comes back. */
  async function upload(ctx, file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
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
      grid.replaceChildren(...(shown.length ? shown.map(card) : [el('p', { class: 'muted' }, tokens.length ? 'No token matches.' : 'No tokens yet. Upload some pictures, or find one.')]));
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

    function edit(t) {
      const name = el('input', { value: t.name, maxlength: 100, required: true, 'aria-label': 'Name' });
      const kindSel = select(KINDS, t.kind, { 'aria-label': 'Kind' });
      const size = select([1, 2, 3, 4].map(n => [n, n === 1 ? '1 square' : `${n} × ${n} squares`]), t.size_squares, { 'aria-label': 'Size' });
      const member = select([['', 'Nobody'], ...S.members.map(m => [m.id, memberName(m)])], t.member_id ?? '', { 'aria-label': 'Character' });
      const entry = select([['', 'No entry'], ...S.encyclopedia.map(e => [e.id, e.name])], t.entry_id ?? '', { 'aria-label': 'Entry' });
      const secret = el('input', { type: 'checkbox', checked: t.is_secret });
      const boxes = groups.map(g => ({ g, box: el('input', { type: 'checkbox', checked: t.groups.includes(g.id) }) }));
      const pic = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'file-input', 'aria-label': 'Change the picture' });
      const form = el('form', {}, el('h3', {}, `Token: ${t.name}`),
        el('div', { class: 'row token-edit-face' }, face(el, t.image_url, t.name),
          el('label', { class: 'button small file-add' }, pic, 'Change picture'),
          btn('Find Image…', () => { d.close(); findFor(t); }, 'small', 'Search open picture libraries for a picture of this')),
        field('Name', name), field('Kind', kindSel), field('Size', size, 'How many squares across it covers on a gridded map'),
        field('Character', member, 'The player whose character wears it. A character has one token'),
        field('Entry', entry, 'An Encyclopedia entry it stands for, shown on the entry\'s page'),
        el('fieldset', { class: 'token-uses-box' }, el('legend', {}, 'Use for'),
          boxes.length ? boxes.map(({ g, box }) => el('label', { class: 'inline' }, box, ` ${g.name}`)) : el('span', { class: 'muted small' }, 'No party groups yet.')),
        el('label', { class: 'inline small', 'data-tip': 'Players are never shown a GM-only token\'s picture' }, secret, ' 🔒 GM only'),
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
          btn('Find Image…', () => findFor(null), 'small', 'Search open picture libraries for a token picture'))),
      el('p', { class: 'muted small' }, 'Round pictures for the party\'s groups, the players\' characters and the Encyclopedia\'s entries. Players see a token\'s picture only where it is used, and never a 🔒 GM-only one.'),
      el('div', { class: 'row' }, search, kind), status, grid));
  }

  return { view, face };
})();
