/* history-view.js — the History dialog (GMs): an entry's, tome's, session's or day's earlier versions down the left, and
 * on the right what the one picked changed, word by word (the arithmetic is in diff.js), with Restore.
 *
 * Plain script, no build step. app.js hands it how to call the server; the server only answers GMs, as an old version can
 * hold GM notes and secret paragraphs. Nothing here writes except Restore, and a restore is itself a new version. */
'use strict';

const HistoryView = (() => {
  const yes = v => (Number(v) ? 'Yes' : 'No');
  const aliases = v => { try { return (JSON.parse(v || '[]') || []).join(', '); } catch (e) { return String(v || ''); } };
  const html = v => Diff.htmlText(v);
  const text = v => String(v ?? '');
  const facts = v => { try { return Object.entries(JSON.parse(v || '{}') || {}).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${x}`).join('\n'); } catch (e) { return String(v || ''); } };
  // What each kind keeps: [key, label, how to read it as text]. A day's notes are plain or rich, by their own format.
  const FIELDS = {
    entry: [['name', 'Name', text, true], ['aliases', 'Other names', aliases, true], ['category', 'Category', text, true], ['facts', 'Facts', facts, true], ['is_secret', 'GM only', yes, true],
      ['notes', 'Public notes', html], ['gm_notes', 'GM notes', html]],
    tome: [['title', 'Title', text, true], ['kind', 'Kind', text, true], ['description', 'Description', text, true], ['body', 'Contents', html]],
    session: [['title', 'Title', text, true], ['summary', 'Summary', html], ['rewards', 'Session Rewards', html], ['loot', 'Loot Found', html], ['notes_text', 'Notes', text]],
    day: [['notes', 'Public notes', (v, d) => (d.notes_format === 'html' ? html(v) : text(v))], ['gm_notes', 'Secret notes', (v, d) => (d.gm_notes_format === 'html' ? html(v) : text(v))]],
  };
  const KIND_NAME = { entry: 'entry', tome: 'tome', session: 'session', day: 'day' };

  /** Open the dialog. kind: 'entry', 'tome', 'session' or 'day'; ref: its id (the absolute day for a day); cid: the
   * campaign; api(action, { query }) and post(action, body, cid) are app.js's; onRestore() runs after a restore. */
  function open({ kind, ref, title, cid, api, post, onRestore }) {
    const { el } = KIT;
    const st = { versions: [], pick: null, mode: 'prev', cache: new Map() };
    const dlg = el('dialog', { class: 'kit-dialog history-dialog', 'aria-label': `History of ${title}` });
    const list = el('ul', { class: 'hist-list' });
    const pane = el('div', { class: 'hist-pane', 'aria-live': 'polite' });
    const bar = el('div', { class: 'row hist-bar' });
    const close = () => dlg.close();

    const when = v => v.saved_at.slice(0, 16);
    function drawList() {
      list.replaceChildren(...st.versions.map((v, i) => el('li', {}, el('button', { type: 'button', class: 'hist-ver' + (v.id === st.pick ? ' on' : ''), 'data-version': v.id, 'aria-current': v.id === st.pick ? 'true' : null,
        onclick: () => show(v.id) },
        el('strong', {}, v.baseline ? 'Before history began' : when(v)), el('small', { class: 'muted' }, v.baseline ? 'what it held when history started' : `${v.by || 'Someone'}${i === 0 ? ' · latest' : ''}`)))));
    }

    /** The paragraphs of one field's change, with long unchanged runs folded away. */
    function body(d) {
      const out = [];
      let run = [];
      const flush = () => {
        if (run.length > 4) { out.push(el('p', { class: 'hist-line same' }, run[0].text), el('p', { class: 'hist-fold muted small' }, `… ${run.length - 2} paragraphs unchanged …`), el('p', { class: 'hist-line same' }, run[run.length - 1].text)); }
        else for (const r of run) out.push(el('p', { class: 'hist-line same' }, r.text));
        run = [];
      };
      for (const x of d) {
        if (x.type === 'same') { run.push(x); continue; }
        flush();
        if (x.type === 'add') out.push(el('p', { class: 'hist-line add' }, el('ins', {}, x.text)));
        else if (x.type === 'del') out.push(el('p', { class: 'hist-line del' }, el('del', {}, x.text)));
        else out.push(el('p', { class: 'hist-line change' }, x.parts.map(p => (p.t === '=' ? p.s : p.t === '+' ? el('ins', {}, p.s) : el('del', {}, p.s)))));
      }
      flush();
      return out;
    }

    /** The change from `from` to `to` (both field maps, or `from` null for nothing before), as a list of field blocks. */
    function changes(from, to) {
      const blocks = [];
      for (const [key, label, read, line] of FIELDS[kind]) {
        const a = from ? read(from[key], from) : '', b = read(to[key], to);
        if (a === b) continue;
        if (line) blocks.push(el('div', { class: 'hist-field' }, el('h5', {}, label), el('p', { class: 'hist-line change' }, a ? [el('del', {}, a), ' → '] : null, el('ins', {}, b || '(empty)'))));
        else blocks.push(el('div', { class: 'hist-field' }, el('h5', {}, label), ...body(Diff.lines(a, b))));
      }
      return blocks;
    }

    async function load(id) {
      if (!st.cache.has(id)) st.cache.set(id, await api('history_get', { query: { cid, id } }));
      return st.cache.get(id);
    }

    async function show(id) {
      st.pick = id; drawList();
      pane.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      let r;
      try { r = await load(id); } catch (err) { pane.replaceChildren(el('p', { class: 'muted' }, err.message)); return; }
      if (st.pick !== id) return;                       // another version was picked while this one loaded
      const v = r.version;
      const same = r.current && JSON.stringify(r.current) === JSON.stringify(v.data);
      const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Compare' },
        [['prev', 'What this save changed'], ['now', 'Compared with now']].map(([k, label]) => el('button', { type: 'button', class: st.mode === k ? 'on' : '', 'aria-pressed': st.mode === k ? 'true' : 'false',
          onclick: () => { st.mode = k; show(id); } }, label)));
      const restore = same ? el('span', { class: 'muted small' }, 'This is how it is now.') : el('button', { type: 'button', class: 'small primary', 'data-act': 'restore',
        onclick: () => restoreIt(v) }, 'Restore this version');
      bar.replaceChildren(seg, restore);
      let blocks, head;
      if (st.mode === 'prev') {
        blocks = changes(r.previous, v.data);
        head = v.baseline ? 'This is what it held before history began.' : r.previous ? `What ${v.by || 'someone'} changed on ${when(v)}:` : `What ${v.by || 'someone'} wrote on ${when(v)}:`;
      } else {
        blocks = r.current ? changes(r.current, v.data) : [];
        head = same ? 'Nothing differs from how it is now.' : `Restoring this version would change it like this (red is now, green is then):`;
      }
      pane.replaceChildren(el('p', { class: 'hist-head' }, head), ...(blocks.length ? blocks : [el('p', { class: 'muted' }, 'No change in the text.')]));
    }

    async function restoreIt(v) {
      if (!await KIT.confirmDialog(`Put the ${KIND_NAME[kind]} back as it was on ${when(v)}? What it says now stays in its history, so you can come back to it.`, { ok: 'Restore' })) return;
      try { await post('history_restore', { id: v.id }, cid); KIT.toast('Restored'); close(); if (onRestore) onRestore(); } catch (err) { KIT.toast(err.message, true); }
    }

    dlg.append(
      el('div', { class: 'web-head' }, el('h3', {}, `History: ${title}`), el('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: close }, '✕')),
      el('p', { class: 'small muted' }, 'Each save is kept (saves by one person within ten minutes count as one), the newest 50. Only GMs see this, as old versions can hold GM notes.'),
      el('div', { class: 'hist-body' }, el('div', { class: 'hist-side' }, list), el('div', { class: 'hist-main' }, bar, pane)));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', ev => { if (ev.target === dlg) close(); });
    document.body.append(dlg);
    dlg.showModal();
    pane.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    api('history_list', { query: { cid, kind, ref } }).then(r => {
      st.versions = r.versions;
      if (!st.versions.length) { list.replaceChildren(el('li', { class: 'muted small' }, 'No versions yet.')); pane.replaceChildren(el('p', { class: 'muted' }, 'Nothing has been saved since history began. The next save starts it.')); return; }
      drawList(); show(st.versions[0].id);
    }).catch(err => pane.replaceChildren(el('p', { class: 'muted' }, err.message)));
    return dlg;
  }

  return { open };
})();
