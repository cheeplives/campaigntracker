/* sessions-tab.js — The Sessions tab: the list of play sessions and a session's page (its notes, summary and pictures). The
 * shorthand and the draft summary are static/sessions.js.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  const E = root.Engine;
  function make(ctx) {
    const { S, api, trail, pinButton, attachmentsCard, btn, busy, cal, campaignHeader, clean, confirmDialog, el, encMentions, field, isGM, linkedNote, questRow, revealButtons, listPage, mount, notesEntry, offerNouns, post, readerEmpty, route, sessionName, sessionStart, sessionShiftNotes, sessionActionsBox, newSessionDialog, sessionDatesDialog, pickShiftDialog, sessionPlaces, nowShift, tip, toast } = ctx;

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
      }, 'primary new-btn', 'Start a session at the campaign\'s clock or another shift, or write one up afterwards, then take your notes in it') : null;
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
      // the rolls made during it: on its shifts, as far as this member may see them (api/dice.php dice_in_shifts)
      const DiceUI = root.DiceUI, DiceSystems = root.DiceSystems; // loaded after this file
      const shown = (s.rolls || []).filter(r => !DiceUI.rerollOf(r));
      const rollsCard = shown.length ? el('details', { class: 'card sess-rolls' },
        el('summary', {}, el('h3', {}, `🎲 Rolls this session (${shown.length})`)),
        DiceUI.rollList(el, s.rolls, { table: DiceSystems.campaignSystem(S.camp?.settings?.dice ? { system: S.camp.settings.dice.system } : null)?.table })) : null;
      const head = [el('h2', {}, sessionName(s)),
        el('p', { class: 'small muted' }, [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · '))];
      // the quests it touches: named in it, or reached through an entry connected to one
      const quests = () => questRow([s.summary, 'html'], [s.rewards, 'html'], [s.loot, 'html'], s.notes_text || '', ...(notes || []).map(n => n.text || ''));
      if (!gm) {
        placesFrom('');
        return [where, head[0], el('div', { class: 'row sess-bar' }, head[1], el('span', { class: 'sess-bar-gap' }), exportBtn), quests(),
          el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
          ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
            el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))), rollsCard, places, pictures];
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
      // the shared ⋯ (KIT.menu): closes when an item is picked, on a click elsewhere and on Escape
      const more = KIT.menu({ label: '⋯', ariaLabel: `More for ${sessionName(s)}`, tip: 'End or reopen, export, pin, history, delete', cls: 'more-menu', items: [
        openClose,
        el('hr'),
        el('label', { class: 'inline small', 'data-tip': 'Add your notes to the file, as a list under the summary' }, withNotes, ' Include notes in Export'),
        exportBtn,
        pinButton({ kind: 'session', id: s.id, name: sessionName(s) }),
        btn('🕘 History', () => HistoryView.open({ kind: 'session', ref: s.id, title: sessionName(s), cid, api, post, onRestore: route }), 'small', 'Earlier versions of this session\'s summary, rewards, loot and notes, what each save changed, and Restore'),
        el('hr'),
        del] });
      const bar = el('div', { class: 'row sess-bar' }, head[1],
        el('label', { class: 'inline sess-pub', 'data-tip': 'Players can read the summary (never your notes or its GM-only paragraphs) once it is published' }, pub, ' Published'),
        el('span', { class: 'sess-bar-gap' }), detailsBtn, more);

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
      const fromTranscript = typeof Transcript === 'undefined' ? null : btn('Draft from transcript…', () => transcriptDialog({ s, sessions,
        notes: () => entry.text(),
        accept({ notesText, summaryHtml, rewardsHtml, lootHtml, title: named, replace }) {
          if (notesText) {
            const box = entry.box;
            box.value = box.value.trimEnd() ? `${box.value.trimEnd()}\n${notesText}` : notesText;
            box.dispatchEvent(new Event('input', { bubbles: true }));   // saves as typing does, and reads its > lines
          }
          if (summaryHtml || rewardsHtml || lootHtml) {
            if (editing.hidden) setEditing(true);
            if (summaryHtml) editor.setHtml(summaryHtml, !replace);
            if (rewardsHtml) rewards?.setHtml(rewardsHtml, true);
            if (lootHtml) loot?.setHtml(lootHtml, true);
            cols.dataset.show = 'summary';
          }
          if (named && !title.value.trim()) { title.value = named; details.hidden = false; detailsBtn.setAttribute('aria-expanded', 'true'); showSave(); }
        },
        hasSummary: () => !!editor.value().text }), 'small',
        'Read a transcript of the game night (from Zoom, Teams, Otter, a Discord bot or Whisper) into a draft of its notes, summary, rewards and loot, with your own Anthropic API key. You check the draft before any of it is added here');
      const entry = notesEntry(s, notes, [draft, fromTranscript].filter(Boolean));
      // The GM reads the session as players do, with the Encyclopedia's names linked (and the GM-only paragraphs marked),
      // and Edit opens the editors. A session with nothing written yet opens in them.
      const reading = el('div', { class: 'sess-read' });
      const drawReading = () => reading.replaceChildren(...[quests()].filter(Boolean),
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
      }), 'small', `Put one more ${E.slotWord(cal())} in this session, outside its run: a flashback, or a split party's other half`);
      const extras = el('p', { class: 'small sess-extras-list' }, el('span', { class: 'muted' }, xs.length ? 'Also takes in: ' : `Takes in no other ${E.slotWord(cal())}s. `),
        ...xs.flatMap((a, k) => [k ? ', ' : '', el('a', { href: `#/c/${cid}/day/${Math.floor(a / n)}` }, E.fmtShift(cal(), a)), ' ',
          Object.assign(btn('✕', busy(null, async () => { await post('session_shift_remove', { id: s.id, abs_shift: a }, cid); route(); }), 'link small',
            `Take ${E.fmtShift(cal(), a)} out of this session`), { ariaLabel: `Take ${E.fmtShift(cal(), a)} out` })]), ' ', addShift);
      placesFrom(entry.text());
      return [where, head[0], bar, extras, details, cols, rollsCard, places, pictures];
    }

    // ------------------------------------------------------------ draft from transcript
    const TX_STORE = () => `chronicle:transcript:${S.camp.id}`;
    const txKept = () => { try { return JSON.parse(localStorage.getItem(TX_STORE()) || '{}') || {}; } catch { return {}; } };
    const txKeep = v => { try { localStorage.setItem(TX_STORE(), JSON.stringify(v)); } catch { /* private mode: asked again next time */ } };
    /** Draft from transcript: the GM picks a transcript file, says who each speaker is, and Claude (with the GM's own
     * Anthropic key, from this browser) drafts the session from it. The GM ticks what to keep, and accept() puts it in
     * the page's notes box and editors: nothing is saved by the dialog itself, and the transcript is kept nowhere. */
    function transcriptDialog({ s, sessions, notes, accept, hasSummary }) {
      const T = root.Transcript;
      const d = el('dialog', { class: 'kit-dialog tx-dialog', 'aria-label': 'Draft from transcript' });
      let abort = null, closed = false;
      d.addEventListener('close', () => { closed = true; abort?.abort(); d.remove(); });
      const show = (...nodes) => d.replaceChildren(...nodes.filter(Boolean));   // a part that doesn't apply is null
      const heading = t => el('h3', {}, t);
      const actions = (...b) => el('div', { class: 'kit-dialog-actions' }, ...b);
      const cancel = () => btn('Cancel', () => d.close());
      const key = MapScan.apiKey.get();
      const kept = txKept();
      const members = (S.members || []).map(m => ({ id: Number(m.id), display_name: m.display_name || '', character_name: m.character_name || '', role: m.role }));
      const memberLabel = m => (m.role === 'gm' ? `${m.display_name}, the GM` : m.character_name && m.character_name !== m.display_name ? `${m.display_name}, playing ${m.character_name}` : m.display_name);
      const memberName = m => (m.role === 'gm' ? `${m.display_name} (GM)` : m.character_name && m.character_name !== m.display_name ? `${m.display_name} (plays ${m.character_name})` : m.display_name);
      let turns = [], fileName = '';

      // --- step 1: the file
      function pick(problem) {
        const file = el('input', { type: 'file', accept: '.txt,.vtt,.srt,.md,text/plain,text/vtt', hidden: true, 'aria-label': 'Transcript file' });
        const paste = el('textarea', { rows: 5, placeholder: 'Or paste the transcript here', 'aria-label': 'Transcript text', spellcheck: false });
        const said = el('p', { class: 'small bad', role: 'alert' }, problem || '');
        const read = (text, name) => {
          if (text.length > T.MAX_CHARS) { said.textContent = 'That is too long to read in one go (over about 300,000 words). Split it in two.'; return; }
          const got = T.parse(text);
          if (!got.length) { said.textContent = 'No speech was found in that. It reads plain text, WebVTT (.vtt) and SubRip (.srt) transcripts.'; return; }
          turns = got; fileName = name;
          who();
        };
        file.addEventListener('change', async () => {
          const f = file.files[0];
          if (!f) return;
          if (/\.(docx?|pdf|json|mp3|m4a|wav|mp4|ogg|flac|webm)$/i.test(f.name)) { said.textContent = `${f.name} isn't a kind it can read yet. Export the transcript as plain text (.txt), WebVTT (.vtt) or SubRip (.srt). It reads transcripts, not recordings.`; return; }
          try { read(await f.text(), f.name); } catch { said.textContent = 'That file couldn\'t be read.'; }
        });
        show(heading('Draft from transcript'),
          el('p', {}, 'Pick the transcript of this game night. Claude reads it and drafts the session\'s notes, summary, rewards and loot, and you choose what to keep. Nothing is added to the session until you say so.'),
          key ? null : el('p', { class: 'tx-note' }, 'This uses your own Anthropic API key, which isn\'t saved in this browser yet. ', el('a', { href: '#/account', onclick: () => d.close() }, 'Add your key on your account page'), ', then come back.'),
          el('div', { class: 'row' }, btn('Choose a file…', () => file.click(), 'primary', 'A .txt, .vtt or .srt transcript, as Zoom, Teams, Otter, Google Meet (downloaded as plain text), Discord transcription bots and Whisper make them'), file,
            el('span', { class: 'small muted' }, 'Plain text, WebVTT or SubRip')),
          paste,
          el('div', { class: 'row' }, btn('Use the pasted text', () => { if (paste.value.trim()) read(paste.value, ''); else said.textContent = 'Paste the transcript in the box first.'; }, 'small')),
          said,
          el('p', { class: 'small muted' }, 'Your browser reads the file and sends the transcript straight to Anthropic with your key. It is never uploaded to this site, and isn\'t kept after the draft.'),
          actions(cancel()));
      }

      // --- step 2: who each speaker is
      function who() {
        const found = T.speakers(turns);
        const rows = found.map(sp => {
          const anon = T.anonymous(sp.label);
          const was = anon ? null : kept.speakers?.[sp.label];
          const guessed = T.guess(sp.label, members);
          const val = was !== undefined && was !== null && (was === 'asis' || was === 'out' || members.some(m => String(m.id) === String(was))) ? was : guessed !== null ? guessed : 'asis';
          const sel = el('select', { 'aria-label': `Who is ${sp.label || 'the unnamed speaker'}` },
            members.map(m => el('option', { value: m.id, selected: String(m.id) === String(val) }, memberLabel(m))),
            el('option', { value: 'asis', selected: val === 'asis' }, anon ? 'Not sure: let Claude work it out' : 'Someone else (a guest)'),
            el('option', { value: 'out', selected: val === 'out' }, 'Leave out everything they said'));
          return { sp, anon, sel, row: el('div', { class: 'tx-speaker' },
            el('div', { class: 'tx-speaker-who' }, el('strong', {}, sp.label || 'No name given'), el('small', { class: 'muted' }, `${sp.words.toLocaleString()} words`)),
            sel,
            sp.samples.length ? el('p', { class: 'small muted tx-sample' }, `“${sp.samples[0]}”`) : null) };
        });
        const model = el('select', { 'aria-label': 'Model' }, T.MODELS.map(m => el('option', { value: m.id, selected: m.id === (kept.model || T.MODELS[0].id) }, m.label)));
        const agreed = el('input', { type: 'checkbox' });
        const price = el('p', { class: 'small muted', role: 'status' });
        const nameOf = r => {
          const v = r.sel.value;
          if (v === 'out') return null;
          const m = members.find(x => String(x.id) === v);
          return m ? memberName(m) : r.anon ? `${r.sp.label || 'Unlabelled speaker'} (unidentified)` : `${r.sp.label} (guest)`;
        };
        const text = () => T.tidy(turns, label => nameOf(rows.find(r => r.sp.label === label)));
        const say = () => {
          const n = T.tokens(text()), c = T.cost(model.value, n);
          price.textContent = n ? `About ${Math.max(1, Math.round(n / 1000)).toLocaleString()}k tokens to read. On ${T.MODELS.find(m => m.id === model.value).label} this draft will cost your Anthropic account about ${c < 0.015 ? 'a cent or two' : `$${c.toFixed(2)}`}, and takes a minute or three.` : 'Everyone is left out, so there is nothing to read.';
          go.disabled = !n || !agreed.checked || !key;
        };
        const go = btn('Draft the session', () => {
          txKeep({ model: model.value, speakers: { ...(kept.speakers || {}), ...Object.fromEntries(rows.filter(r => !r.anon).map(r => [r.sp.label, r.sel.value])) } });
          const cast = [...new Set(rows.map(nameOf).filter(Boolean))].map(n => {
            const r = rows.find(x => nameOf(x) === n), m = members.find(x => String(x.id) === r.sel.value);
            return m ? (m.role === 'gm' ? `${n}: the game master, who narrates and speaks for the other characters`
              : m.character_name && m.character_name !== m.display_name ? `${n}: a player, whose character is ${m.character_name}` : `${n}: a player`)
              : r.anon ? `${n}: unidentified; work out who from what they say` : `${n}: someone not in the campaign's member list`;
          });
          run(text(), cast, model.value, '');
        }, 'primary');
        [model, agreed, ...rows.map(r => r.sel)].forEach(x => x.addEventListener('change', say));
        const words = turns.reduce((t, x) => t + x.text.split(/\s+/).length, 0);
        show(heading('Who is speaking?'),
          el('p', { class: 'small muted' }, `${fileName ? `${fileName}: ` : ''}${words.toLocaleString()} words from ${found.length === 1 ? '1 speaker' : `${found.length} speakers`}. Say who each one is, so Claude knows which character they play. Names from the file are remembered in this browser for next time.`),
          found.length === 1 && T.anonymous(found[0].label) ? el('p', { class: 'tx-note small' }, 'This transcript doesn\'t say who is speaking, so Claude will work it out from what is said. Check the draft a little more closely.') : null,
          el('div', { class: 'tx-list' }, rows.map(r => r.row)),
          field('Model', model, 'Sonnet is a good writer at a low price. Opus writes a little better for about twice as much, and Haiku costs about a cent.'),
          el('label', { class: 'inline tx-agree' }, agreed, ' Everyone at the table knows this recording is being sent to Anthropic to draft the session.'),
          price,
          key ? null : el('p', { class: 'tx-note small' }, el('a', { href: '#/account', onclick: () => d.close() }, 'Add your Anthropic API key on your account page'), ' to draft.'),
          actions(go, btn('Back', () => pick()), cancel()));
        say();
      }

      // --- step 3: the draft being written
      let last = null;   // { transcript, cast, model }: what a redraft sends again
      async function run(transcript, cast, model, again) {
        last = { transcript, cast, model };
        const said = el('p', { class: 'small', role: 'status' }, 'Sending the transcript to Anthropic…');
        const bar = el('progress', { 'aria-label': 'Drafting' });
        show(heading('Drafting the session'),
          el('p', { class: 'small muted' }, 'Claude is reading the transcript with your own Anthropic API key. A full night takes a minute or three: keep this window open.'),
          bar, said, actions(cancel()));
        abort = new AbortController();
        try {
          // the session before this one, for continuity, and the campaign's names, so misheard ones are spelt right
          const prev = (sessions || []).filter(x => x.number < s.number).sort((a, b) => b.number - a.number)[0];
          const before = prev ? await api('session', { query: { cid: S.camp.id, id: prev.id } }).then(r => new DOMParser().parseFromString(String(r.session.summary || ''), 'text/html').body.textContent.trim().slice(0, 6000), () => '') : '';
          const names = (S.encyclopedia || []).flatMap(e => [e.name, ...(e.aliases || [])]).filter(Boolean).slice(0, 1500);
          const c = cal(), slots = E.timeMode(c) === 'hours' ? [] : E.shiftNames(c);
          const ctxt = { campaign: S.camp.name, about: String(S.camp.description || '').slice(0, 2000), cast, names, slots, before, notes: String(notes() || '').slice(0, 20000) };
          const { draft, usage } = await T.draft(key, model, ctxt, transcript, { again, signal: abort.signal, onProgress: t => { said.textContent = t; } });
          if (!closed) review(draft, usage);
        } catch (err) {
          if (closed) return;
          bar.remove(); said.classList.add('bad'); said.textContent = err.message;
          d.querySelector('.kit-dialog-actions').replaceChildren(btn('Try again', () => run(transcript, cast, model, again), 'primary'), btn('Back', () => who()), cancel());
        }
      }

      // --- step 4: the GM ticks what to keep
      function review(draft, usage) {
        const at = t => (t ? el('small', { class: 'muted tx-at', 'data-tip': 'Where this is in the transcript (hours:minutes)' }, t) : el('small', { class: 'tx-at' }));
        const tick = (label, on = true) => el('input', { type: 'checkbox', checked: on, 'aria-label': label });
        const jumpOk = t => Sessions.parseJump(cal(), t, sessionStart(s), nowShift()) !== null;
        const part = (title, items, row, open = true, note = '') => {
          if (!items.length) return null;
          const rows = items.map(row);
          const count = el('small', { class: 'muted' });
          const say = () => { const n = rows.filter(r => r.box.checked).length; count.textContent = ` ${n} of ${rows.length} ticked`; };
          rows.forEach(r => r.box.addEventListener('change', say));
          say();
          const all = on => btn(on ? 'All' : 'None', () => { rows.forEach(r => { r.box.checked = on; }); say(); }, 'link small', `Tick ${on ? 'every one' : 'none'} of these`);
          const node = el('details', { class: 'tx-part', open }, el('summary', {}, el('strong', {}, title), count),
            note ? el('p', { class: 'small muted' }, note) : null,
            el('div', { class: 'row tx-all' }, all(true), all(false)),
            el('div', { class: 'tx-rows' }, rows.map(r => r.row)));
          return { node, picked: () => rows.filter(r => r.box.checked).map(r => r.item) };
        };
        const noteKind = t => ({ '!': 'aside', '?': 'loose end', '$': 'GM only', '>': 'time jump' })[t[0]] || '';
        const notesPart = part('Notes', draft.notes, n => {
          const bad = n.text[0] === '>' && !jumpOk(n.text);
          const box = tick(n.text, !bad);
          const kind = bad ? 'a jump this calendar can\'t read: left out' : noteKind(n.text);
          return { item: n, box, row: el('label', { class: `tx-row${n.indent ? ' tx-indent' : ''}` }, box, at(n.at), el('span', {}, n.text, kind ? el('small', { class: 'chip tx-kind' }, kind) : null)) };
        }, true, 'Added to the end of your notes box, in its own shorthand.');
        const sumPart = part('Summary', draft.summary, p => {
          const box = tick(p.text.slice(0, 60));
          return { item: p, box, row: el('label', { class: 'tx-row tx-para' }, box, el('span', {}, p.text, p.gm_only ? el('small', { class: 'chip tx-kind' }, 'GM only') : null)) };
        }, true, 'Goes into the summary editor for you to rewrite. Players read it only once you publish the session.');
        const simple = (title, items) => part(title, items, x => { const box = tick(x); return { item: x, box, row: el('label', { class: 'tx-row tx-para' }, box, el('span', {}, x)) }; });
        const rewPart = simple('Session rewards', draft.rewards), lootPart = simple('Loot found', draft.loot);
        const outPart = part('Left out', draft.left_out, x => {
          const box = tick(x.gist, false);
          return { item: x, box, row: el('label', { class: 'tx-row' }, box, at(x.at), el('span', {}, x.gist, el('small', { class: 'chip tx-kind' }, x.kind))) };
        }, false, 'What Claude took to be table talk, rules talk or unclear. Tick one to add it to your notes as an aside.');
        const guesses = draft.speakers.length ? el('p', { class: 'small muted' }, 'Claude\'s guesses at the unnamed speakers: ', draft.speakers.map(x => `${x.label} is ${x.guess}`).join('; '), '.') : null;
        const empty = !draft.notes.length && !draft.summary.length;
        const again = el('input', { maxlength: 500, placeholder: 'For another go: shorter, more about the duel, Kestrel is a she…', 'aria-label': 'What to change in another draft' });
        const m = T.MODELS.find(x => x.id === last.model);
        const spent = usage.input ? `This draft read ${usage.input.toLocaleString()} tokens and wrote ${usage.output.toLocaleString()}, about $${Math.max(0.01, ((usage.input - usage.cached) * m.in + usage.cached * m.in * 0.1 + usage.output * m.out) / 1e6).toFixed(2)} on your Anthropic account.` : '';
        const add = btn('Add to the session', async () => {
          const paras = sumPart?.picked() || [];
          let replace = false;
          if (paras.length && hasSummary()) {
            const v = await KIT.dialog({ message: 'The summary already has writing in it. Replace it with the draft, or add the draft below it?', buttons: [
              { value: 'add', label: 'Add below', cls: 'primary', focus: true }, { value: 'replace', label: 'Replace', cls: 'danger' }, { value: '', label: 'Cancel' }] });
            if (!v) return;
            replace = v === 'replace';
          }
          accept({ title: draft.title, replace,
            notesText: T.notesText(notesPart?.picked() || [], { ok: jumpOk, extra: outPart?.picked() || [], from: fileName }),
            summaryHtml: T.summaryHtml(paras), rewardsHtml: T.listHtml(rewPart?.picked() || []), lootHtml: T.listHtml(lootPart?.picked() || []) });
          d.close();
          toast('Added. Read it over and change what you like, then Save the summary');
        }, 'primary', 'Put what is ticked into this session\'s notes box and its summary, rewards and loot editors. The notes save as typing does; the rest waits for your Save');
        show(heading(empty ? 'Nothing to draft' : draft.title ? `Draft: ${draft.title}` : 'The draft'),
          el('p', { class: 'small muted' }, empty ? 'Claude found nothing of the game in this transcript.' : 'Untick anything you don\'t want. The time beside a line is where to find it in the transcript.'),
          guesses,
          el('div', { class: 'tx-review' }, [notesPart, sumPart, rewPart, lootPart, outPart].filter(Boolean).map(x => x.node)),
          el('div', { class: 'row tx-again' }, again, btn('Draft again', () => run(last.transcript, last.cast, last.model, again.value.trim() || 'Have another go at it.'), 'small', 'Have Claude write the draft again, with what you typed in mind. It reads the transcript again at about a tenth of the price if you ask within a few minutes')),
          spent ? el('p', { class: 'small muted' }, spent) : null,
          actions(empty ? null : add, cancel()));
      }

      document.body.append(d); d.showModal();
      pick();
    }

    return { viewSessions };
  }
  root.SessionsTab = { make };
})(window);
