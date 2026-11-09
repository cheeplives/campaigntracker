/* sessions-tab.js — The Sessions tab: the list of play sessions and a session's page (its notes, summary and pictures). The
 * shorthand and the draft summary are static/sessions.js.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  const E = root.Engine;
  function make(ctx) {
    const { S, api, trail, pinButton, attachmentsCard, btn, busy, cal, campaignHeader, clean, confirmDialog, el, encMentions, field, isGM, linkedNote, revealButtons, listPage, mount, notesEntry, offerNouns, post, readerEmpty, route, sessionName, sessionStart, sessionShiftNotes, sessionActionsBox, newSessionDialog, sessionDatesDialog, pickShiftDialog, sessionPlaces, nowShift, tip, toast } = ctx;

    // ------------------------------------------------------------ sessions tab
    /** The Sessions tab: every game night, newest first, and the one picked: for GMs its notes beside the summary written
     * from them, with Build draft; for players the published summary. */
    async function viewSessions(sel) {
      const cid = S.camp.id;
      const [{ sessions }, one] = await Promise.all([api('sessions', { query: { cid } }),
        sel ? api('session', { query: { cid, id: sel } }).catch(() => null) : null]);
      if (one) S.sessUploads = one.uploads;
      const href = id => `#/c/${cid}/sessions${id ? `/${id}` : ''}`;
      const item = (x, cls = 'sess-item') => el('a', { class: `${cls === 'lp-start-item' ? '' : 'enc-item '}enc-card ${cls}` + (one?.session.id === x.id ? ' on' : ''), href: href(x.id), 'aria-current': one?.session.id === x.id ? 'page' : null },
        el('span', { class: 'enc-name' }, sessionName(x), x.last_day === null && isGM() ? el('span', { class: 'chip sess-open', 'data-tip': 'Not ended yet: its last day is still open' }, 'open') : null),
        el('small', { class: 'lib-desc' }, [x.played_on ? `Played ${x.played_on}` : null, Sessions.daysCovered(cal(), x),
          isGM() && !x.is_published ? 'not published' : null].filter(Boolean).join(' · ')));
      const add = isGM() ? btn('+ New session', async () => {
        const made = await newSessionDialog();
        if (made) location.hash = href(made.id);
      }, 'primary small', 'Start a session at the campaign\'s clock or another shift, or write one up afterwards, then take your notes in it') : null;
      // the list, and a search over the sessions' names and dates once there are a few
      const list = el('div', { class: 'lib-list' });
      const search = sessions.length > 4 ? el('input', { type: 'search', value: sessQuery, placeholder: 'Search names and dates', 'aria-label': 'Search the sessions' }) : null;
      const draw = () => {
        const words = (search ? sessQuery : '').toLowerCase().split(/\s+/).filter(Boolean);
        const shown = sessions.filter(x => words.every(w => `${sessionName(x)}\n${x.played_on || ''}\n${Sessions.daysCovered(cal(), x)}`.toLowerCase().includes(w)));
        list.replaceChildren(...(shown.length ? shown.map(x => item(x))
          : [el('p', { class: 'muted small' }, sessions.length ? 'Nothing matches. Clear the search to see every session.'
            : isGM() ? 'No sessions yet. Press + New session, then take your notes in it.' : 'No session summaries published yet.')]));
      };
      search?.addEventListener('input', () => { sessQuery = search.value; draw(); });
      draw();
      // the session picked, or the open one and the latest to start from
      const reader = el('section', { class: 'sess-detail' });
      if (sel && !one) reader.append(el('p', { class: 'muted' }, 'That session isn\'t here any more.'));
      else if (!one) readerEmpty(reader, { lead: sessions.length ? 'Pick a session to read it.' : 'Nothing here yet.',
        title: 'Latest', start: [...sessions.filter(x => x.last_day === null && isGM()), ...sessions.filter(x => !(x.last_day === null && isGM()))].slice(0, 4).map(x => item(x, 'lp-start-item')) });
      else reader.append(...clean(sessionPage(one.session, one.notes || [], sessions)));
      // Hide list: the list folds to a rail and the session picked gets the room, remembered in this browser.
      mount(...campaignHeader('sessions'), listPage({ cls: 'sess-page', title: 'Sessions', picked: !!sel, add, top: [search], list, reader,
        tipText: isGM() ? 'Each game night: your running notes, and the summary you write from them afterwards. Players read a summary once you publish it'
          : 'A summary of each game night, as the GM writes it up',
        hide: { key: 'chronicle:sesshide', was: 'chronicle:sesswide' } }));
    }
    let sessQuery = '';

    function sessionPage(s, notes, sessions) {
      const cid = S.camp.id, gm = isGM();
      const withNotes = gm ? el('input', { type: 'checkbox' }) : null;
      const exportBtn = btn('⬇ Export', () => {
        const md = Sessions.markdown({ cal: cal(), session: { ...s, ...(gm ? { summary: editor.value().text, ...(rewards ? { rewards: rewards.value().text, loot: loot.value().text } : {}) } : {}) },
          notes: gm ? Sessions.parseLines(entry.text()) : [], gm,
          withNotes: !!withNotes?.checked, toMarkdown: RichText.toMarkdown });
        const a = el('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: Sessions.fileName(s) });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }, 'small', 'Download this session as a Markdown file to paste into Scabard or another wiki. It holds only what you can see here');
      // maps, handouts and sketches from the night: GMs add them, players see them once the session is published
      const pictures = gm || s.files?.length ? attachmentsCard('session', s.id, s.files || (s.files = []), { uploads: S.sessUploads, gmAdds: true,
        empty: 'No pictures or files yet. Add a map, a handout or a sketch of the scene.' }) : null;
      // the places it names, on a picture of their map, under it all (filled in once the map has loaded)
      const places = el('div', { class: 'sess-places-slot' });
      const asText = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent;
      const placesFrom = notesText => sessionPlaces([asText(s.summary), asText(s.rewards), asText(s.loot), notesText || ''].join('\n'))
        .then(n => places.replaceChildren(...(n ? [n] : []))).catch(() => {});
      const where = trail(['Sessions', `#/c/${S.camp.id}/sessions`], [sessionName(s)]);
      const head = [el('h2', {}, sessionName(s)),
        el('p', { class: 'small muted' }, [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · '))];
      if (!gm) {
        placesFrom('');
        return [where, head[0], el('div', { class: 'row sess-bar' }, head[1], el('span', { class: 'sess-bar-gap' }), exportBtn),
          el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
          ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
            el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))), places, pictures];
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
      // 🗓 In-game dates…: where it starts and ends in the campaign's calendar, or still open
      const datesBtn = btn('🗓 In-game dates…', busy(null, async () => { if (await sessionDatesDialog(s)) route(); }), 'small',
        'Set the day and shift the session starts and ends on in the campaign\'s calendar, or leave it open');
      const undated = el('input', { type: 'checkbox', checked: !!s.undated });
      const details = el('div', { class: 'sess-fields', hidden: !!s.title },
        el('div', { class: 'sess-fields-row' }, field('Title', title), field('Played on', played, null, 'The real-world date of the game night')),
        el('label', { class: 'inline small', 'data-tip': 'For a session written up without its in-game days (an imported one): it covers only the shifts you add it to one at a time, At the Table' },
          undated, ' No in-game dates'), el('div', { class: 'row' }, datesBtn));
      const detailsBtn = btn('✎ Details', () => {
        details.hidden = !details.hidden; detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
        showSave();
      },
        'small', 'Change the title, the date you played, and the in-game days and shifts it covers');
      detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
      const more = el('details', { class: 'sess-more' }, el('summary', { class: 'button small', 'aria-label': 'More', title: 'End or reopen, export with notes, delete' }, '⋯'),
        el('div', { class: 'sess-more-list' }, openClose,
          el('label', { class: 'inline small', 'data-tip': 'Add your notes to the file, as a list under the summary' }, withNotes, ' Include notes in Export'),
          btn('🕘 History', () => HistoryView.open({ kind: 'session', ref: s.id, title: sessionName(s), cid, api, post, onRestore: route }), 'small', 'Earlier versions of this session\'s summary, rewards, loot and notes, what each save changed, and Restore'), del));
      document.addEventListener('click', ev => { if (more.open && !more.contains(ev.target)) more.open = false; });
      const bar = el('div', { class: 'row sess-bar' }, head[1],
        el('label', { class: 'inline sess-pub', 'data-tip': 'Players can read the summary (never your notes or its GM-only paragraphs) once it is published' }, pub, ' Published'),
        el('span', { class: 'sess-bar-gap' }), detailsBtn, exportBtn, pinButton({ kind: 'session', id: s.id, name: sessionName(s) }), more);

      // --- the notes: one text box, saved as it is typed (notesEntry in app.js); Build draft under it writes the summary
      const notesHead = el('h3', {}, 'Notes', tip('Your notes from the game, a line each. They save as you type. Build draft writes the summary from them. The ? button under the box lists what each mark does'));

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
      const draft = btn('Build draft', busy(null, async () => {
        // what was written on the session's shifts first, then the notes box, each under its day
        const fromShifts = await sessionShiftNotes(s).catch(() => []);
        const html = Sessions.draftHtml(cal(), [...fromShifts, ...Sessions.notesFromText(cal(), entry.text(), sessionStart(s), nowShift()).notes]);
        if (!html) return toast(entry.text().trim() ? 'Nothing to draft: every note is a ! aside or a time jump' : 'Type some notes first, or write on the shifts At the Table', true);
        if (editing.hidden) setEditing(true);
        let append = false;
        if (editor.value().text) {
          const v = await KIT.dialog({ message: 'The summary already has writing in it. Replace it with the draft, or add the draft below it?', buttons: [
            { value: 'add', label: 'Add below', cls: 'primary', focus: true }, { value: 'replace', label: 'Replace', cls: 'danger' }, { value: '', label: 'Cancel' }] });
          if (!v) return;
          append = v === 'add';
        }
        editor.setHtml(html, append);
        cols.dataset.show = 'summary';   // one column (a phone): show the summary it filled
      }), 'primary small', 'Fill the summary from the shifts this session ran over and your notes: each shift\'s activity with the players\' notes on it, the GM notes on a shift as GM-only paragraphs, then a paragraph per note with its indented lines, a heading per day, ! lines left out, $ lines as GM-only paragraphs and ? lines listed GM only at the end. Then rewrite it as you like, and Save');
      const entry = notesEntry(s, notes, [draft]);
      // The GM reads the session as players do, with the Encyclopedia's names linked (and the GM-only paragraphs marked),
      // and Edit opens the editors. A session with nothing written yet opens in them.
      const reading = el('div', { class: 'sess-read' });
      const drawReading = () => reading.replaceChildren(
        el('div', { class: 'lib-body' }, (s.summary || '').trim() ? revealButtons(linkedNote(s.summary, 'html'), 'session', s.id, { field: 'summary' }) : el('p', { class: 'muted' }, 'Nothing written yet.')),
        ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
          el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, revealButtons(linkedNote(s[k], 'html'), 'session', s.id, { field: k })))));
      const editing = el('div', { class: 'sess-editing' });
      const edit = btn('✎ Edit', () => setEditing(true), 'small', 'Open the summary, rewards and loot in editors to change them');
      const cancel = btn('Cancel', () => {
        editor.setHtml(s.summary || ''); rewards?.setHtml(s.rewards || ''); loot?.setHtml(s.loot || '');
        setEditing(false);
      }, 'small', 'Close the editors without saving what was changed in them');
      function setEditing(on) {
        editing.hidden = !on; reading.hidden = on;
        edit.hidden = on; cancel.hidden = !on;
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
          // names added from the detector's dialog are linked in the summary as read
          offerNouns([{ text: s.summary, format: 'html', label: `${sessionName(s)}'s summary` },
            ...(hasExtras ? [{ text: s.rewards, format: 'html', label: `${sessionName(s)}'s rewards` }, { text: s.loot, format: 'html', label: `${sessionName(s)}'s loot` }] : [])])
            .then(() => drawReading());
        }
        const t = title.value.trim().replace(/\s+/g, ' '), on = played.value || null;
        if (t !== (s.title || '') || on !== (s.played_on || null) || undated.checked !== !!s.undated) {
          const r = await post('session_save', { id: s.id, title: t, played_on: on, undated: undated.checked }, cid);
          Object.assign(s, { title: r.session.title, played_on: r.session.played_on, undated: r.session.undated });
          // the heading, the date line and the session's name in the list, redrawn in place so nothing typed is lost
          head[0].textContent = sessionName(s);
          where.lastElementChild.textContent = sessionName(s);
          head[1].textContent = [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · ');
          const inList = document.querySelector('.sess-item.on .enc-name');
          if (inList?.firstChild?.nodeType === Node.TEXT_NODE) inList.firstChild.textContent = sessionName(s);
          if (s.title) { details.hidden = true; detailsBtn.setAttribute('aria-expanded', 'false'); }
        }
        setEditing(false);
        toast('Saved');
      }));

      // the actions picked At the Table on the session's shifts, under the notes once they've loaded
      const actsSlot = el('div', { class: 'sess-acts-slot' });
      sessionActionsBox(s).then(b => { if (b) actsSlot.append(b); }).catch(() => {});
      // the summary is the wide column, the notes beside it; a phone shows one at a time, the summary first once there is one
      const cols = el('div', { class: 'sess-cols', 'data-show': (s.summary || '').trim() ? 'summary' : 'notes' });
      const tabBtn = (key, label) => btn(label, () => { cols.dataset.show = key; }, 'small', `Show the ${label.toLowerCase()}`);
      cols.append(el('div', { class: 'sess-tabs row' }, tabBtn('summary', 'Summary'), tabBtn('notes', 'Notes')),
        el('div', { class: 'sess-notes' }, notesHead, entry.node, actsSlot),
        el('div', { class: 'sess-summary' },
          el('div', { class: 'row sess-sumhead' }, el('h3', {}, 'Summary', tip('What you write up from the notes. GM-only paragraphs (🔒) never reach players')),
            el('div', { class: 'row' }, edit, cancel, save)),
          reading,
          editing));
      editing.append(editor.node,
          hasExtras ? el('div', { class: 'sess-extras' },
            el('div', {}, el('h3', {}, 'Session Rewards', tip('What the party earned this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), rewards.node),
            el('div', {}, el('h3', {}, 'Loot Found', tip('The coin, items and treasure found this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), loot.node))
            : el('p', { class: 'muted small' }, 'Open install.php on the server and press Install or upgrade to add Session Rewards and Loot Found.'));
      setEditing(![s.summary, s.rewards, s.loot].some(t => (t || '').trim()));
      // the notes box grows with what's typed in it, up to most of the window, then scrolls
      const nbox = entry.box;
      const grow = () => { nbox.style.height = 'auto'; nbox.style.height = `${Math.min(nbox.scrollHeight + 2, Math.max(240, innerHeight * 0.75))}px`; };
      for (const e of ['input', 'keyup', 'focus']) nbox.addEventListener(e, grow);
      if (nbox.value) requestAnimationFrame(grow);
      // the shifts it takes in outside its run (added from a shift's + Session…), each linking to its day; ✕ takes one out
      // + Add a shift… puts in one more, picked by day and shift
      const n = E.slotsPerDay(cal()), xs = s.extra_shifts || [];
      const addShift = btn(`+ Add a ${E.slotWord(cal())}…`, busy(null, async () => {
        const a = await pickShiftDialog(`Add a ${E.slotWord(cal())} to ${sessionName(s)}`, 'Add');
        if (a === null) return;
        await post('session_shift_add', { id: s.id, abs_shift: a }, cid);
        toast(`${E.fmtShift(cal(), a)} is in ${sessionName(s)}`);
        route();
      }), 'link small', `Put one more ${E.slotWord(cal())} in this session, outside its run: a flashback, or a split party's other half`);
      const extras = el('p', { class: 'small sess-extras-list' }, el('span', { class: 'muted' }, xs.length ? 'Also takes in: ' : `Takes in no other ${E.slotWord(cal())}s. `),
        ...xs.flatMap((a, k) => [k ? ', ' : '', el('a', { href: `#/c/${cid}/day/${Math.floor(a / n)}` }, E.fmtShift(cal(), a)), ' ',
          Object.assign(btn('✕', busy(null, async () => { await post('session_shift_remove', { id: s.id, abs_shift: a }, cid); route(); }), 'link small',
            `Take ${E.fmtShift(cal(), a)} out of this session`), { ariaLabel: `Take ${E.fmtShift(cal(), a)} out` })]), ' ', addShift);
      placesFrom(entry.text());
      return [where, head[0], bar, extras, details, cols, places, pictures];
    }

    return { viewSessions };
  }
  root.SessionsTab = { make };
})(window);
