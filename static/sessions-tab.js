/* sessions-tab.js — The Sessions tab: the list of play sessions and a session's page (its notes, summary and pictures). The
 * shorthand and the draft summary are static/sessions.js.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { S, api, attachmentsCard, btn, busy, cal, campaignHeader, clean, confirmDialog, el, encMentions, field, isGM, linkedNote, mount, notesEntry, offerNouns, post, route, sessionName, snoteList, tip, toast } = ctx;

    // ------------------------------------------------------------ sessions tab
    /** The Sessions tab: every game night, newest first, and the one picked: for GMs its notes beside the summary written
     * from them, with Build draft; for players the published summary. */
    async function viewSessions(sel) {
      const cid = S.camp.id;
      const [{ sessions }, one] = await Promise.all([api('sessions', { query: { cid } }),
        sel ? api('session', { query: { cid, id: sel } }).catch(() => null) : null]);
      if (one) S.sessUploads = one.uploads;
      const href = id => `#/c/${cid}/sessions${id ? `/${id}` : ''}`;
      // The page can take the whole width: the sessions run across the top and the session picked gets the room, remembered in this browser.
      let wide = sessWide();
      const page = el('div', { class: 'enc-page sess-page' + (sel ? ' has-sel' : '') + (wide ? ' wide' : '') });
      const wideBtn = btn('', () => { wide = !wide; rememberSessWide(wide); setWide(); }, 'small enc-widebtn');
      const setWide = () => {
        page.classList.toggle('wide', wide);
        wideBtn.textContent = wide ? '⇤ Narrow view' : '⇥ Wide view';
        wideBtn.setAttribute('aria-pressed', String(wide));
        wideBtn.dataset.tip = wide ? 'Back to the list beside the session' : 'Give the session the whole width, with the list of sessions along the top';
      };
      setWide();
      const item = x => el('a', { class: 'enc-item sess-item' + (one?.session.id === x.id ? ' on' : ''), href: href(x.id), 'aria-current': one?.session.id === x.id ? 'page' : null },
        el('span', { class: 'enc-name' }, sessionName(x), x.last_day === null && isGM() ? el('span', { class: 'chip sess-open', 'data-tip': 'Not ended yet: its last day is still open' }, 'open') : null),
        el('small', { class: 'lib-desc' }, [x.played_on ? `Played ${x.played_on}` : null, Sessions.daysCovered(cal(), x),
          isGM() ? `${x.covered} of ${x.notes} notes covered` : null, isGM() && !x.is_published ? 'not published' : null].filter(Boolean).join(' · ')));
      const add = isGM() ? btn('+ New session', busy(null, async () => {
        const r = await post('session_save', {}, cid);
        S.openSession = r.session;
        location.hash = href(r.session.id);
      }), 'primary small', 'Start a session on the campaign\'s current day, then take your notes in it') : null;
      const left = el('section', { class: 'card enc-index' },
        el('div', { class: 'row spread' }, el('h2', {}, 'Sessions', tip(isGM()
          ? 'Each game night: your running notes, and the summary you write from them afterwards. Players read a summary once you publish it'
          : 'A summary of each game night, as the GM writes it up')), el('div', { class: 'row' }, add, wideBtn)),
        el('div', { class: 'lib-list' }, sessions.length ? sessions.map(item)
          : el('p', { class: 'muted small' }, isGM() ? 'No sessions yet. Press + New session, then take your notes in it.' : 'No session summaries published yet.')));
      const right = el('section', { class: 'card enc-detail sess-detail' });
      if (sel && !one) right.append(el('p', { class: 'muted' }, 'That session isn\'t here any more.'));
      else if (!one) right.append(el('p', { class: 'muted' }, sessions.length ? 'Pick a session to read it.' : 'Nothing here yet.'));
      else right.append(...clean(sessionPage(one.session, one.notes || [], sessions)));
      page.append(left, right);
      mount(...campaignHeader('sessions'), page);
    }
    const SESS_WIDE_KEY = 'chronicle:sesswide';
    function sessWide() {
      try { return localStorage.getItem(SESS_WIDE_KEY) === '1'; } catch { return false; }
    }
    function rememberSessWide(on) {
      try { on ? localStorage.setItem(SESS_WIDE_KEY, '1') : localStorage.removeItem(SESS_WIDE_KEY); } catch { /* private mode: just this page */ }
    }

    function sessionPage(s, notes, sessions) {
      const cid = S.camp.id, gm = isGM();
      const withNotes = gm ? el('input', { type: 'checkbox' }) : null;
      const exportBtn = btn('⬇ Export', () => {
        const md = Sessions.markdown({ cal: cal(), session: { ...s, ...(gm ? { summary: editor.value().text, ...(rewards ? { rewards: rewards.value().text, loot: loot.value().text } : {}) } : {}) }, notes, gm,
          withNotes: !!withNotes?.checked, toMarkdown: RichText.toMarkdown });
        const a = el('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: Sessions.fileName(s) });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }, 'small', 'Download this session as a Markdown file to paste into Scabard or another wiki. It holds only what you can see here');
      // maps, handouts and sketches from the night: GMs add them, players see them once the session is published
      const pictures = gm || s.files?.length ? attachmentsCard('session', s.id, s.files || (s.files = []), { uploads: S.sessUploads, gmAdds: true,
        empty: 'No pictures or files yet. Add a map, a handout or a sketch of the scene.' }) : null;
      const head = [el('h2', {}, sessionName(s)),
        el('p', { class: 'small muted' }, [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · '))];
      if (!gm) {
        return [head[0], el('div', { class: 'row sess-bar' }, head[1], el('span', { class: 'sess-bar-gap' }), exportBtn),
          el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
          ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
            el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))), pictures];
      }

      // --- details: title, date played, publishing, open or ended
      const title = el('input', { value: s.title, maxlength: 200, placeholder: `Session ${s.number}` });
      const played = el('input', { type: 'date', value: s.played_on || '' });
      const pub = el('input', { type: 'checkbox', checked: s.is_published,
        onchange: async ev => {
          try {
            await post('session_save', { id: s.id, is_published: ev.target.checked }, cid);
            s.is_published = ev.target.checked;
            toast(s.is_published ? 'Published for players' : 'Hidden from players again');
          } catch (err) { ev.target.checked = !ev.target.checked; toast(err.message, true); }
        } });
      const openClose = s.last_day === null
        ? btn('End session', busy(null, async () => { await post('session_end', { id: s.id }, cid); S.openSession = null; route(); }), 'small', 'Close this session at the campaign\'s current day, so its dates show the days it covered')
        : btn('Reopen', busy(null, async () => { const r = await post('session_save', { id: s.id, reopen: true }, cid); S.openSession = r.session; route(); }), 'small',
          'Open this session again, so its last day is no longer fixed. Any other open session ends');
      const del = btn('Delete session', async () => {
        if (!await confirmDialog(`Delete ${sessionName(s)} with its notes and summary?`, { ok: 'Delete', danger: true })) return;
        try {
          await post('session_delete', { id: s.id }, cid);
          if (S.openSession?.id === s.id) S.openSession = null;
          location.hash = `#/c/${cid}/sessions`;
        } catch (err) { toast(err.message, true); }
      }, 'small danger', 'Delete this session, its notes and its summary');
      // Title and Played on are set once, so they fold behind ✎ Details (open while the session has no title), and the one
      // Save under the summary saves them with everything else; the rest of
      // what's done to a session, rather than written in it, waits in the ⋯ menu. The summary is left the room under the title.
      const details = el('div', { class: 'sess-fields', hidden: !!s.title },
        el('div', { class: 'sess-fields-row' }, field('Title', title), field('Played on', played, null, 'The real-world date of the game night')));
      const detailsBtn = btn('✎ Details', () => {
        details.hidden = !details.hidden; detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
        showSave();
      },
        'small', 'Change the title and the date you played');
      detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
      const more = el('details', { class: 'sess-more' }, el('summary', { class: 'button small', 'aria-label': 'More', title: 'End or reopen, export with notes, delete' }, '⋯'),
        el('div', { class: 'sess-more-list' }, openClose,
          el('label', { class: 'inline small', 'data-tip': 'Add your notes to the file, as a list under the summary' }, withNotes, ' Include notes in Export'), del));
      document.addEventListener('click', ev => { if (more.open && !more.contains(ev.target)) more.open = false; });
      const bar = el('div', { class: 'row sess-bar' }, head[1],
        el('label', { class: 'inline sess-pub', 'data-tip': 'Players can read the summary (never your notes or its GM-only paragraphs) once it is published' }, pub, ' Published'),
        el('span', { class: 'sess-bar-gap' }), detailsBtn, exportBtn, more);

      // --- the notes, each ticked once the summary covers it
      const notesHead = el('h3', {});
      const notesList = el('div', { class: 'snotes' });
      const others = sessions.filter(x => x.id !== s.id);
      const opts = { onChange: () => reloadNotes(), notes: () => notes, tick: true, move: others, onTick: () => countNotes() };
      const countable = () => notes.filter(n => Sessions.mark(n.text) !== '>');
      const countNotes = () => notesHead.replaceChildren('Notes ', el('span', { class: 'muted small' }, `${countable().filter(n => n.is_covered).length} of ${countable().length} covered`),
        tip('Your notes from the game. Tick one once the summary covers it, so you can see what\'s left. Build draft ticks the ones it uses'));
      const drawNotes = () => {
        countNotes();
        notesList.replaceChildren(...(notes.length ? snoteList(notes, opts) : [el('p', { class: 'muted small' }, 'No notes in this session.')]));
      };
      async function reloadNotes() {
        try { notes = (await api('session', { query: { cid, id: s.id } })).notes || []; } catch (err) { toast(err.message, true); }
        drawNotes();
      }
      drawNotes();

      // --- the summary
      const editor = RichText.editor({ text: s.summary || '', format: 'html', label: 'Summary', placeholder: 'What happened this session, for the players to read',
        secret: true, mentions: encMentions() });
      editor.node.classList.add('rt-tall');
      // Session Rewards and Loot Found, under the summary (their columns come with install.php's upgrade)
      const hasExtras = 'rewards' in s;
      const rewards = hasExtras ? RichText.editor({ text: s.rewards || '', format: 'html', label: 'Session Rewards', secret: true, mentions: encMentions(),
        placeholder: 'What the party earned: experience, favours, standing, story rewards' }) : null;
      rewards?.node.classList.add('rt-small');   // a few lines each, side by side
      const loot = hasExtras ? RichText.editor({ text: s.loot || '', format: 'html', label: 'Loot Found', secret: true, mentions: encMentions(),
        placeholder: 'The coin, items and treasure the party found' }) : null;
      loot?.node.classList.add('rt-medium');
      const draft = btn('Build draft', async () => {
        const html = Sessions.draftHtml(cal(), notes);
        if (!html) return toast('Nothing to draft: every note is a ! aside or a time jump', true);
        let append = false;
        if (editor.value().text) {
          const v = await KIT.dialog({ message: 'The summary already has writing in it. Replace it with the draft, or add the draft below it?', buttons: [
            { value: 'add', label: 'Add below', cls: 'primary', focus: true }, { value: 'replace', label: 'Replace', cls: 'danger' }, { value: '', label: 'Cancel' }] });
          if (!v) return;
          append = v === 'add';
        }
        editor.setHtml(html, append);
        for (const n of notes) {
          const k = Sessions.mark(n.text);
          if (k === '!' || k === '>' || n.is_covered) continue;
          try { await post('snote_save', { id: n.id, is_covered: true }, cid); n.is_covered = true; } catch (err) { toast(err.message, true); break; }
        }
        drawNotes();
      }, 'small', 'Fill the summary from your notes: a paragraph per note with its indented lines, a heading per day, ! lines left out and ? lines listed GM only at the end. Then rewrite it as you like');
      // The GM reads the session as players do, with the Encyclopedia's names linked (and the GM-only paragraphs marked),
      // and Edit opens the editors. A session with nothing written yet opens in them.
      const reading = el('div', { class: 'sess-read' });
      const drawReading = () => reading.replaceChildren(
        el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
        ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
          el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))));
      const editing = el('div', { class: 'sess-editing' });
      const edit = btn('✎ Edit', () => setEditing(true), 'small', 'Open the summary, rewards and loot in editors to change them');
      const cancel = btn('Cancel', () => {
        editor.setHtml(s.summary || ''); rewards?.setHtml(s.rewards || ''); loot?.setHtml(s.loot || '');
        setEditing(false);
      }, 'small', 'Close the editors without saving what was changed in them');
      function setEditing(on) {
        editing.hidden = !on; reading.hidden = on;
        edit.hidden = on; draft.hidden = cancel.hidden = !on;
        showSave();
        if (!on) drawReading();
      }
      // the one Save is there while the editors or the title and date played are open
      const showSave = () => { save.hidden = editing.hidden && details.hidden; };
      // what the editors held when the page opened or last saved, so Save sends the writing only when it has changed
      const writing = () => ({ summary: editor.value().text, ...(hasExtras ? { rewards: rewards.value().text, loot: loot.value().text } : {}) });
      let savedWriting = null;
      RichText.load().then(() => { savedWriting ??= writing(); }).catch(() => {});   // once the editors have it, as they tidy it
      const save = btn('Save', null, 'primary small', 'Save everything changed on this page: the title and date played, the summary, rewards and loot. Players read them once the session is published');
      save.addEventListener('click', busy(save, async () => {
        // the writing first: when it was saved elsewhere meanwhile nothing is saved, rather than half of it
        const written = writing();
        if (!savedWriting || JSON.stringify(written) !== JSON.stringify(savedWriting)) {
          const r = await post('session_summary_save', { id: s.id, version: s.version, ...written }, cid);
          s.version = r.session.version; s.summary = r.session.summary; s.rewards = r.session.rewards; s.loot = r.session.loot;
          savedWriting = written;
          // names added from the detector's dialog are linked in the summary as read, and in the notes
          offerNouns([{ text: s.summary, format: 'html', label: `${sessionName(s)}'s summary` },
            ...(hasExtras ? [{ text: s.rewards, format: 'html', label: `${sessionName(s)}'s rewards` }, { text: s.loot, format: 'html', label: `${sessionName(s)}'s loot` }] : [])])
            .then(() => { drawReading(); drawNotes(); });
        }
        const t = title.value.trim().replace(/\s+/g, ' '), on = played.value || null;
        if (t !== (s.title || '') || on !== (s.played_on || null)) {
          const r = await post('session_save', { id: s.id, title: t, played_on: on }, cid);
          Object.assign(s, { title: r.session.title, played_on: r.session.played_on });
          // the heading, the date line and the session's name in the list, redrawn in place so nothing typed is lost
          head[0].textContent = sessionName(s);
          head[1].textContent = [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · ');
          const inList = document.querySelector('.sess-item.on .enc-name');
          if (inList?.firstChild?.nodeType === Node.TEXT_NODE) inList.firstChild.textContent = sessionName(s);
          if (s.title) { details.hidden = true; detailsBtn.setAttribute('aria-expanded', 'false'); }
        }
        setEditing(false);
        toast('Saved');
      }));

      // the summary is the wide column, the notes beside it; a phone shows one at a time, the summary first once there is one
      const cols = el('div', { class: 'sess-cols', 'data-show': (s.summary || '').trim() ? 'summary' : 'notes' });
      const tabBtn = (key, label) => btn(label, () => { cols.dataset.show = key; }, 'small', `Show the ${label.toLowerCase()}`);
      cols.append(el('div', { class: 'sess-tabs row' }, tabBtn('summary', 'Summary'), tabBtn('notes', 'Notes')),
        el('div', { class: 'sess-notes' }, notesHead, notesEntry(s, () => notes, () => reloadNotes()), notesList),
        el('div', { class: 'sess-summary' },
          el('div', { class: 'row sess-sumhead' }, el('h3', {}, 'Summary', tip('What you write up from the notes. GM-only paragraphs (🔒) never reach players')),
            el('div', { class: 'row' }, edit, draft, cancel, save)),
          reading,
          editing));
      editing.append(editor.node,
          hasExtras ? el('div', { class: 'sess-extras' },
            el('div', {}, el('h3', {}, 'Session Rewards', tip('What the party earned this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), rewards.node),
            el('div', {}, el('h3', {}, 'Loot Found', tip('The coin, items and treasure found this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), loot.node))
            : el('p', { class: 'muted small' }, 'Open install.php on the server and press Install or upgrade to add Session Rewards and Loot Found.'));
      setEditing(![s.summary, s.rewards, s.loot].some(t => (t || '').trim()));
      // the notes box starts small and grows with what's typed in it, up to half the window
      const nbox = cols.querySelector('.snote-box');
      const grow = () => { nbox.style.height = 'auto'; nbox.style.height = `${Math.min(nbox.scrollHeight + 2, innerHeight / 2)}px`; };
      for (const e of ['input', 'keyup', 'focus']) nbox?.addEventListener(e, grow);
      if (nbox?.value) requestAnimationFrame(grow);
      return [head[0], bar, details, cols, pictures];
    }

    return { viewSessions };
  }
  root.SessionsTab = { make };
})(window);
