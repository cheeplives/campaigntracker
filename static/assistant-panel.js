/* assistant-panel.js — the Assistant's panel (GMs): a conversation down the right of the page, where a GM asks for an
 * entry to be filled out, for connections or for ideas, and accepts, edits or discards what comes back.
 *
 * The thinking is in assistant.js; this file draws it. app.js calls make() once with its shared helpers and state
 * (tabCtx's), and the entry and session pages put assistantButton() among their buttons. The panel shows only when a
 * GM has switched the assistant on in Settings. A conversation lives in this page only: closing the panel keeps it,
 * New request or leaving the campaign forgets it, and nothing of it is stored.
 *
 * What a GM accepts is saved by the pages' own actions (entry_save, relations_save), so History, the stale-copy check
 * and the rules about secrets apply to it as they do to anything typed by hand. Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { S, api, post, el, btn, toast, route, isGM, settings } = ctx;
    const A = root.Assistant;
    const WIDE = 1300;   // from here the page makes room for the panel instead of sitting under it

    const fresh = () => ({ cid: null, messages: [], campaign: null, names: new Map(), busy: false, stop: null, use: A.noUse(), sentFocus: null, notes: [], started: false });
    let st = fresh(), panel = null, body = null, box = null, sendBtn = null, useLine = null, readLine = null;

    const on = () => !!(S.camp && isGM() && settings().assistant && settings().assistant.enabled && A);
    const model = () => A.modelOf(settings().assistant && settings().assistant.model).id;
    const key = () => (typeof MapScan !== 'undefined' ? MapScan.apiKey.get() : '');

    /** The entry or session the page behind the panel shows, from its address: { kind, id, name } or null. */
    function focus() {
      const m = /^#\/c\/(\d+)\/(encyclopedia|sessions)\/(\d+)/.exec(location.hash);
      if (!m || !S.camp || Number(m[1]) !== S.camp.id) return null;
      const id = Number(m[3]);
      if (m[2] === 'encyclopedia') { const e = S.encyclopedia.find(x => x.id === id); return e ? { kind: 'entry', id, name: e.name } : null; }
      return { kind: 'session', id, name: 'this session' };
    }
    const PRESETS = {
      entry: [['Fill out this entry', 'Fill out this entry. Ask me first if something important is missing.'], ['Suggest connections', 'Suggest connections between this entry and others that the campaign supports but doesn\'t have yet.'],
        ['Suggest plot hooks', 'Suggest three plot hooks that involve this entry and tie into threads the sessions left open.']],
      session: [['Suggest connections', 'Suggest connections between entries that this session shows but the campaign doesn\'t have yet.'], ['Find missing entries', 'Which people, places and things does this session name that have no entry yet? Propose entries for the ones worth keeping.'],
        ['Loose threads', 'What threads did this session leave loose, and what could come of each next time?']],
      none: [['Ideas for next session', 'Suggest three plot points or encounters for the next session, tied to threads the last sessions left open.'], ['Find thin entries', 'Which entries matter to recent sessions but say very little? List the five most worth filling in.']],
    };

    // ------------------------------------------------------------ drawing
    /** Claude's words as paragraphs and lists. It is asked for plain text; stray Markdown marks are dropped. */
    function prose(text) {
      const out = [];
      for (const block of String(text).replace(/\*\*|__|^#+\s*/gm, '').split(/\n\s*\n/)) {
        let list = null;
        for (const line of block.split('\n').map(l => l.trim()).filter(Boolean)) {
          const item = /^[-•*]\s+(.*)$/.exec(line);
          if (item) { if (!list) { list = el('ul', {}); out.push(list); } list.append(el('li', {}, item[1])); }
          else { list = null; out.push(el('p', {}, line)); }
        }
      }
      return out;
    }
    const add = node => { body.append(node); body.scrollTop = body.scrollHeight; return node; };
    let steps = null;
    const step = (icon, text) => { if (!steps) steps = add(el('div', { class: 'asst-steps' })); steps.append(el('span', {}, KIT.icon(icon), text)); body.scrollTop = body.scrollHeight; };
    const say = text => { steps = null; add(el('div', { class: 'asst-msg' }, prose(text))); };
    const note = (text, bad) => { steps = null; add(el('p', { class: 'asst-note' + (bad ? ' bad' : '') }, text)); };

    function drawUse() {
      if (!st.use.calls) { useLine.textContent = 'Nothing is saved until you accept it'; return; }
      useLine.textContent = `This conversation: ${A.costText(A.cost(model(), st.use))} on your Anthropic key. Nothing is saved until you accept it`;
    }
    function drawRead() {
      const f = focus();
      readLine.replaceChildren(...(f ? ['About ', el('b', {}, f.kind === 'entry' ? f.name : 'the session on this page'), ' and whatever else it needs to read'] : ['About the whole campaign']));
    }
    function drawStart() {
      steps = null;
      const f = focus();
      if (!key()) {
        body.replaceChildren(el('div', { class: 'asst-msg' },
          el('p', {}, 'The assistant uses your own Anthropic API key, so what it does is billed to your Anthropic account: usually a few cents a request.'),
          el('p', {}, el('a', { href: '#/account' }, 'Add your key on your account page'), ', then come back here.')));
        return;
      }
      body.replaceChildren(el('div', { class: 'asst-msg' },
        el('p', {}, f ? `Ask for help with ${f.kind === 'entry' ? f.name : 'this session'}, or pick a start:` : 'Ask for help with the campaign, or pick a start:'),
        el('div', { class: 'row asst-presets' }, PRESETS[f ? f.kind : 'none'].map(([label, text]) => btn(label, () => send(text), 'small')))));
    }
    function setBusy(busy) {
      st.busy = busy;
      sendBtn.textContent = busy ? 'Stop' : 'Send';
      box.disabled = busy || !key();
      panel.classList.toggle('busy', busy);
    }

    // ------------------------------------------------------------ proposals
    const here = id => new RegExp(`^#/c/${S.camp.id}/encyclopedia/${id}(?:$|[/?])`).test(location.hash);
    /** Redraw the page behind the panel when it shows something just changed, unless the GM is typing in it. */
    const refresh = (...ids) => { if (ids.some(here) && !document.querySelector('.enc-detail form')) route(); };
    const openLink = (id, label) => el('a', { href: `#/c/${S.camp.id}/encyclopedia/${id}` }, label);

    /** Save an accepted proposal. Resolves the line the card shows in place of its buttons. */
    async function accept(p) {
      const cid = S.camp.id;
      if (p.kind === 'notes') {
        const now = await api('assistant_read', { query: { cid, kind: 'entry', id: p.entry_id } });
        await post('entry_save', { id: p.entry_id, name: now.name, [p.field]: A.notesHtml(now[p.field], p), version: now.version }, cid);
        const e = S.encyclopedia.find(x => x.id === p.entry_id);
        if (e) e.blank = false;
        refresh(p.entry_id);
        return ['Saved to ', openLink(p.entry_id, now.name)];
      }
      if (p.kind === 'entry') {
        const made = await post('entry_save', { name: p.name, category: p.category, notes: A.textHtml(p.notes), gm_notes: A.textHtml(p.gm_notes), is_secret: p.gm_only }, cid);
        S.encyclopedia = [...S.encyclopedia.filter(x => x.id !== made.id), { id: made.id, name: p.name, category: p.category, facts: {}, aliases: [], is_secret: p.gm_only, blank: !p.notes && !p.gm_notes, pic: null, token_url: null,
          preview: p.notes.replace(/\s+/g, ' ').slice(0, 140) }].sort((a, b) => a.name.localeCompare(b.name));
        st.names.set(made.id, p.name);
        st.notes.push(`The GM accepted the new entry "${p.name}": its id is ${made.id}.`);
        return ['Created ', openLink(made.id, p.name)];
      }
      await post('relations_save', { entry_id: p.from_id, type: { label: p.label, inverse_label: p.inverse_label }, add: [p.to_id], is_secret: p.gm_only }, cid);
      refresh(p.from_id, p.to_id);
      return ['Connected ', openLink(p.from_id, p.from), ' and ', openLink(p.to_id, p.to)];
    }

    /** A proposal's card: what it would change, why, and Accept, Edit first and Discard. */
    function propose(p) {
      steps = null;
      const secret = p.kind === 'notes' ? p.field === 'gm_notes' : p.gm_only;
      const title = p.kind === 'notes' ? `${p.field === 'gm_notes' ? 'GM notes' : 'Public notes'} for ${p.entry}${p.mode === 'replace' ? ' (replaces what is there)' : ''}`
        : p.kind === 'entry' ? `New entry: ${p.name}${p.category ? `, ${p.category}` : ''}` : 'New connection';
      const text = t => el('div', { class: 'asst-text' }, prose(t));
      // the parts of it that are text: [key in p, label, node]
      const parts = p.kind === 'notes' ? [['text', null, text(p.text)]]
        : p.kind === 'entry' ? [['notes', 'Public notes', p.notes ? text(p.notes) : null], ['gm_notes', 'GM notes', p.gm_notes ? text(p.gm_notes) : null]].filter(x => x[2]) : [];
      const view = p.kind === 'connection'
        ? [el('p', {}, el('b', {}, p.from), ' ', el('span', { class: 'chip asst-rel' }, p.label), ' ', el('b', {}, p.to))]
        : parts.flatMap(([, label, node]) => [label && parts.length > 1 ? el('span', { class: 'asst-sub' }, label === 'GM notes' ? '🔒 GM notes' : label) : null, node]);
      const foot = el('div', { class: 'row card-foot' });
      const card = el('div', { class: 'asst-prop' + (secret ? ' secret' : ''), 'data-kind': p.kind },
        el('span', { class: 'lbl' }, secret ? '🔒 ' : '', title), ...view,
        p.why || (secret && p.kind !== 'notes') ? el('span', { class: 'why' }, [secret && p.kind !== 'notes' ? 'GM only.' : '', p.why].filter(Boolean).join(' ')) : null, foot);
      const done = line => { card.classList.add('done'); foot.replaceChildren(el('span', { class: 'asst-done' }, ...line)); };
      const acceptBtn = btn(p.kind === 'entry' ? 'Create entry' : p.kind === 'connection' ? 'Add connection' : 'Accept', async () => {
        acceptBtn.disabled = true;
        // text the GM edited in the card first
        for (const ta of card.querySelectorAll('textarea[data-part]')) p[ta.dataset.part] = ta.value.trim();
        try { done(await accept(p)); toast(p.kind === 'entry' ? 'Entry created' : p.kind === 'connection' ? 'Connection added' : 'Saved'); }
        catch (err) { acceptBtn.disabled = false; toast(err.message, true); }
      }, 'small', 'Save this to the campaign');
      const editBtn = parts.length ? btn('Edit first', () => {
        for (const [k, label, node] of parts) node.replaceWith(el('textarea', { 'data-part': k, rows: Math.min(12, Math.max(3, Math.ceil(p[k].length / 60))), value: p[k], 'aria-label': label || title }));
        editBtn.remove();
        card.querySelector('textarea').focus();
      }, 'small', 'Change the text here before it is saved') : null;
      foot.append(acceptBtn, editBtn || '', btn('Discard', () => { card.remove(); }, 'small link', 'Drop this suggestion'));
      add(card);
    }

    // ------------------------------------------------------------ a request
    const io = {
      search: q => api('assistant_search', { query: { cid: st.cid, q } }),
      readEntry: id => api('assistant_read', { query: { cid: st.cid, kind: 'entry', id } }),
      readSession: id => api('assistant_read', { query: { cid: st.cid, kind: 'session', id } }),
      propose, step, say,
    };
    async function send(text) {
      text = String(text || '').trim();
      if (!text || st.busy) return;
      if (!key()) { drawStart(); return; }
      if (!st.started) { body.replaceChildren(); st.started = true; }
      steps = null;
      add(el('div', { class: 'asst-me' }, text));
      box.value = '';
      setBusy(true);
      const stopper = new AbortController();
      st.stop = () => stopper.abort();
      const running = st, base = st.messages.length;
      try {
        if (!st.campaign) {
          const c = await api('assistant_context', { query: { cid: st.cid } });
          st.campaign = A.campaignText(c);
          st.names = new Map(c.entries.map(e => [e.id, e.name]));
        }
        // what the page shows goes with the first message about it
        const f = focus(), fkey = f ? `${f.kind}:${f.id}` : '';
        const L = [];
        if (f && fkey !== st.sentFocus) {
          const r = await api('assistant_read', { query: { cid: st.cid, kind: f.kind, id: f.id } });
          L.push(`The GM has this ${f.kind} open on the page:`, '', r.text, '');
          step(f.kind === 'entry' ? 'book' : 'scroll', `Read ${f.kind === 'entry' ? r.name : 'the session on this page'}`);
        } else if (!f && st.sentFocus) L.push('The GM has left that page, and is asking about the campaign as a whole.', '');
        if (st.notes.length) L.push(...st.notes, '');
        L.push(L.length ? `The GM says: ${text}` : text);
        st.messages.push({ role: 'user', content: L.join('\n') });
        const sentNotes = st.notes.length;
        const { text: reply, use } = await A.run({ apiKey: key(), model: model(), campaign: st.campaign, messages: st.messages, io, names: st.names, signal: stopper.signal });
        if (running !== st) return;
        st.sentFocus = fkey;
        st.notes.splice(0, sentNotes);
        for (const k of Object.keys(use)) st.use[k] += use[k];
        if (reply) say(reply);
      } catch (err) {
        if (running !== st) return;
        st.messages.length = base;   // the request never happened, so it can simply be sent again
        if (err && err.use) for (const k of Object.keys(err.use)) st.use[k] += err.use[k];
        note(err && err.name === 'AbortError' ? 'Stopped. Nothing was saved.' : (err && err.message) || 'Something went wrong.', !(err && err.name === 'AbortError'));
      } finally {
        if (running === st) { st.stop = null; setBusy(false); drawUse(); box.focus(); }
      }
    }

    // ------------------------------------------------------------ the panel
    function build() {
      body = el('div', { class: 'asst-body', 'aria-live': 'polite' });
      readLine = el('div', { class: 'asst-read' });
      useLine = el('div', { class: 'asst-use' });
      box = el('textarea', { rows: 2, placeholder: 'Ask for a draft, a change or an idea…', 'aria-label': 'Message to the assistant',
        onkeydown: ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(box.value); } } });
      sendBtn = btn('Send', () => (st.busy ? st.stop && st.stop() : send(box.value)), '');
      panel = el('aside', { class: 'asst-panel', 'aria-label': 'Assistant', onkeydown: ev => { if (ev.key === 'Escape' && !st.busy) close(); } },
        el('div', { class: 'asst-head' }, el('h2', {}, 'Assistant'),
          btn('New request', () => { reset(); drawStart(); drawUse(); box.focus(); }, 'small', 'Forget this conversation and start another'),
          el('button', { type: 'button', class: 'small', 'aria-label': 'Close the assistant', onclick: close }, '✕')),
        readLine, body,
        el('div', { class: 'asst-foot' }, el('div', { class: 'row' }, box, sendBtn), useLine));
    }
    /** Forget the conversation (and stop a request that is running). */
    function reset() {
      if (st.stop) st.stop();
      const cid = S.camp ? S.camp.id : null;
      st = fresh();
      st.cid = cid;
      if (panel) { panel.classList.remove('busy'); sendBtn.textContent = 'Send'; }
    }
    const isOpen = () => !!(panel && panel.isConnected);
    /** Show the pages' Assistant buttons as pressed while the panel is open. */
    const mark = open => { for (const b of document.querySelectorAll('.asst-open-btn')) { b.setAttribute('aria-expanded', String(open)); b.classList.toggle('on', open); } };
    function close() {
      if (!isOpen()) return;
      panel.remove();
      document.body.classList.remove('asst-open');
      mark(false);
    }
    /** Open the panel, starting over when the campaign behind it has changed. ask: a request to send straight away. */
    function open(ask) {
      if (!on()) return;
      if (!panel) build();
      if (st.cid !== S.camp.id) reset();
      if (!isOpen()) {
        document.body.append(panel);
        document.body.classList.add('asst-open');
      }
      mark(true);
      if (!st.started) drawStart();
      box.disabled = st.busy || !key();
      drawRead(); drawUse();
      if (ask && key()) send(ask); else if (!box.disabled) box.focus();
    }
    // the page behind changes: follow it, and go when it leaves the campaign or the assistant is switched off
    window.addEventListener('hashchange', () => {
      if (!isOpen()) return;
      if (!new RegExp(`^#/c/${st.cid}(?:/|$)`).test(location.hash)) { reset(); close(); return; }
      setTimeout(() => { if (!isOpen()) return; if (!on()) { reset(); close(); return; } drawRead(); if (!st.started) drawStart(); }, 0);
    });

    /** The button a page shows to open the panel, or null when the assistant is off here. ask: what it asks at once. */
    function assistantButton(label, ask, tipText) {
      if (!on()) return null;
      return el('button', { type: 'button', class: 'small asst-open-btn' + (isOpen() ? ' on' : ''), 'aria-expanded': String(isOpen()), 'data-tip': tipText || 'Ask the assistant for a draft, connections or ideas. Nothing is saved until you accept it',
        onclick: () => (isOpen() && !ask ? close() : open(ask)) }, label || '✨ Assistant');
    }
    return { assistantButton, openAssistant: open, closeAssistant: close, assistantOn: on, WIDE };
  }
  root.AssistantPanel = { make };
})(window);
