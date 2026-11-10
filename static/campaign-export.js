/* campaign-export.js — the whole campaign as one zip: Markdown pages to read (the Encyclopedia as the Encyclopedia tab
 * exports it, events, calendar notes, sessions, the Library, the party's things, reminders, clocks, downtime, maps and
 * characters), campaign.json with every row for a program or a later import, and the pictures and files.
 *
 * Plain script, no build step, and no page needed: it only formats what ?a=campaign_export answered (api/export.php,
 * GMs only, so everything is in it and GM-only things are marked 🔒). The caller fetches the files' bytes and zips
 * the lot with LoreExport.zip. The same file runs under Node in the tests; the engine, LoreExport and toMarkdown
 * (rich text to Markdown, which needs a page) are passed in. */
'use strict';

(function (root) {
  const has = v => v !== null && v !== undefined && String(v).trim() !== '';
  const text = v => String(v ?? '').replace(/\r\n?/g, '\n').trim();
  const on = v => v === true || Number(v) === 1;
  const lock = v => (on(v) ? ' 🔒' : '');
  const mdText = s => String(s ?? '').replace(/([\\[\]*_`|])/g, '\\$1');
  const mdHref = path => path.split('/').map(p => (p === '..' ? p : encodeURIComponent(p))).join('/');
  const json = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
  const RICH = /^\s*<(p|ul|ol|h[1-6]|aside|blockquote|table|div|hr|pre)\b/i;

  function fileNamer() {
    const used = new Set();
    return (name, ext = '') => {
      const base = String(name || '').replace(/[\\/:*?"<>|#^[\]\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'Untitled';
      let n = `${base}${ext}`, i = 2;
      while (used.has(n.toLowerCase())) n = `${base} ${i++}${ext}`;
      used.add(n.toLowerCase());
      return n;
    };
  }
  const extOf = f => (/\.[a-z0-9]{1,5}$/i.exec(f.original_name || '') || [''])[0].toLowerCase()
    || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' }[f.mime] || '');

  /** data: what ?a=campaign_export answered. opts: { Engine, LoreExport, toMarkdown, date, calendar } (calendar: the
   * campaign's as the page holds it, when it has one). Returns { files: [{ path, data }] } (text files, campaign.json
   * among them) and { fetch: [{ path, id, name }] }: the stored files to add under those paths, by attachment id. */
  function build(data, opts) {
    const E = opts.Engine, T = data.tables || {}, camp = data.campaign || {};
    const cal = opts.calendar || camp.calendar;
    const rows = t => T[t] || [];
    const who = id => (id === null || id === undefined ? '' : (data.people || {})[String(id)] || '');
    const rich = (v, format) => (!has(v) ? '' : format === 'html' || (format !== 'text' && RICH.test(v)) ? opts.toMarkdown(String(v)) : text(v));
    const day = d => E.fmtDate(cal, Number(d));
    const slot = s => E.fmtShift(cal, Number(s));
    const shiftName = s => (s === null || s === undefined || s === '' ? '' : E.shiftNames(cal)[Number(s)] || '');
    const foot = `*Exported from Campaign Chronicle · ${camp.name} · GM view, with GM-only notes · ${opts.date}*`;
    const out = [], fetch = [];
    const page = (path, lines) => out.push({ path, data: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n\n' + foot + '\n' });
    const byId = t => new Map(rows(t).map(r => [Number(r.id), r]));

    // ---- the stored files, each once under files/, and who they belong to
    const fname = fileNamer(), fileOf = new Map(), filesOf = new Map();
    for (const f of rows('attachments')) {
      const k = `${f.parent_type}:${Number(f.parent_id)}`;
      if (!filesOf.has(k)) filesOf.set(k, []);
      filesOf.get(k).push(f);
      if (f.kind === 'embed') continue;
      const path = `files/${fname(`${f.id} ${String(f.original_name || f.caption || 'file').replace(/\.[^.]+$/, '')}`, extOf(f))}`;
      fileOf.set(Number(f.id), path);
      fetch.push({ path, id: Number(f.id), name: f.original_name || path });
    }
    const filesFor = (type, id) => filesOf.get(`${type}:${Number(id)}`) || [];
    const credit = f => opts.LoreExport.creditLine(f.credit_title || f.credit_author ? { title: f.credit_title, author: f.credit_author, license: f.credit_license, source: f.credit_source } : null);
    /** A parent's pictures and files as Markdown, from a page one folder down (up: '../') or at the top (''). */
    const fileLines = (type, id, up) => filesFor(type, id).flatMap(f => {
      if (f.kind === 'embed') return has(f.embed_url) ? [`[${mdText(f.caption || 'Picture')}](${f.embed_url})`, ''] : [];
      const href = mdHref(up + fileOf.get(Number(f.id))), label = mdText(f.caption || f.original_name || 'file') + lock(f.is_secret);
      return [f.kind === 'image' ? `![${label}](${href})` : `[${label}](${href})`, ...(credit(f) ? ['', `*${credit(f)}*`] : []), ''];
    });

    // ---- Encyclopedia, as the Encyclopedia tab's own Markdown export writes it, so Import from Markdown reads it back
    const tagName = new Map(rows('encyclopedia_tag_names').map(t => [Number(t.id), t.name]));
    const entryTags = new Map();
    for (const t of rows('encyclopedia_tags')) {
      if (!entryTags.has(Number(t.entry_id))) entryTags.set(Number(t.entry_id), []);
      if (tagName.has(Number(t.tag_id))) entryTags.get(Number(t.entry_id)).push({ name: tagName.get(Number(t.tag_id)) });
    }
    const relType = byId('encyclopedia_relation_types'), links = new Map();
    const link = (from, l) => { if (!links.has(from)) links.set(from, []); links.get(from).push(l); };
    for (const r of rows('encyclopedia_relations')) {
      const t = relType.get(Number(r.type_id));
      if (!t) continue;
      link(Number(r.from_id), { label: t.label, to: Number(r.to_id), note: r.note, is_secret: on(r.is_secret) });
      link(Number(r.to_id), { label: has(t.inverse_label) ? t.inverse_label : t.label, to: Number(r.from_id), note: r.note, is_secret: on(r.is_secret) });
    }
    // an entry's facts, labelled as its campaign's settings label them, else by their keys
    const labels = new Map();
    for (const [cat, list] of Object.entries(camp.entry_fields || {})) for (const f of list || []) labels.set(`${cat}:${f.key}`, f.label);
    const factsOf = e => Object.entries(json(e.facts_json) || {}).filter(([, v]) => has(v))
      .map(([k, v]) => ({ label: labels.get(`${e.category}:${k}`) || k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), value: String(v) }));
    const entries = rows('encyclopedia_entries').map(e => ({
      id: Number(e.id), name: e.name, category: e.category || '', fields: factsOf(e), aliases: json(e.aliases_json) || [], tags: entryTags.get(Number(e.id)) || [],
      notes: e.notes || '', gm_notes: e.gm_notes || '', is_secret: on(e.is_secret), links: links.get(Number(e.id)) || [],
      files: filesFor('encyclopedia', e.id).map(f => ({ id: Number(f.id), name: f.original_name || '', mime: f.mime, kind: f.kind, caption: f.caption, is_secret: on(f.is_secret),
        credit: f.credit_title || f.credit_author ? { title: f.credit_title, author: f.credit_author, license: f.credit_license, source: f.credit_source } : null,
        embed: has(f.embed_url) ? { url: f.embed_url } : null })),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const entryName = new Map(entries.map(e => [e.id, e.name]));
    if (entries.length) {
      const pictures = entries.flatMap(e => e.files.filter(f => f.kind !== 'embed').map(f => ({ entry: e, file: f, path: `../${fileOf.get(f.id)}` })));
      for (const f of opts.LoreExport.markdown(entries, pictures, { campaign: camp.name, gm: true, gmOnly: true, toMarkdown: opts.toMarkdown, date: opts.date }).files)
        out.push({ path: `Encyclopedia/${f.path}`, data: f.text });
    }

    // ---- Events, oldest first
    const tags = new Map(rows('tags').map(t => [Number(t.id), t.name]));
    const eventTags = new Map(), eventNotes = new Map();
    for (const t of rows('event_tags')) { if (!eventTags.has(Number(t.event_id))) eventTags.set(Number(t.event_id), []); if (tags.has(Number(t.tag_id))) eventTags.get(Number(t.event_id)).push(tags.get(Number(t.tag_id))); }
    for (const n of rows('event_notes')) { if (!eventNotes.has(Number(n.event_id))) eventNotes.set(Number(n.event_id), []); eventNotes.get(Number(n.event_id)).push(n); }
    const events = [...rows('events')].sort((a, b) => Number(a.abs_day) - Number(b.abs_day) || Number(a.shift ?? -1) - Number(b.shift ?? -1) || Number(a.id) - Number(b.id));
    const eventTitle = new Map(events.map(e => [Number(e.id), e.title]));
    if (events.length) {
      const L = [`# ${camp.name}: Events`, ''];
      let last = null;
      for (const e of events) {
        if (Number(e.abs_day) !== last) { L.push(`## ${day(e.abs_day)}`, ''); last = Number(e.abs_day); }
        L.push(`### ${e.title}${lock(e.is_secret)}`, '');
        const about = [shiftName(e.shift) + (has(e.shift_end) && Number(e.shift_end) !== Number(e.shift) ? ` to ${shiftName(e.shift_end)}` : ''),
          has(e.end_day) && Number(e.end_day) !== Number(e.abs_day) ? `until ${day(e.end_day)}` : '',
          (eventTags.get(Number(e.id)) || []).length ? `Tags: ${eventTags.get(Number(e.id)).join(', ')}` : ''].filter(has);
        if (about.length) L.push(`*${about.join(' · ')}*`, '');
        if (has(e.body)) L.push(rich(e.body), '');
        for (const n of eventNotes.get(Number(e.id)) || []) L.push(`- **${mdText(who(n.user_id) || 'A player')}:** ${text(n.body)}`);
        L.push('');
      }
      page('Events.md', L);
    }

    // ---- Calendar notes: each day with something written on it
    const days = new Map();
    const dayOf = d => { d = Number(d); if (!days.has(d)) days.set(d, { shifts: new Map() }); return days.get(d); };
    const shiftOf = (d, s) => { const x = dayOf(d).shifts; s = Number(s); if (!x.has(s)) x.set(s, { notes: [] }); return x.get(s); };
    for (const r of rows('days')) if (has(r.notes) || has(r.gm_notes) || has(r.locations)) Object.assign(dayOf(r.abs_day), { row: r });
    for (const r of rows('shifts')) if (has(r.activity) || has(r.gm_notes)) Object.assign(shiftOf(r.abs_day, r.shift), { row: r });
    for (const r of rows('shift_notes')) if (has(r.body)) shiftOf(r.abs_day, r.shift).notes.push(r);
    if (days.size) {
      const L = [`# ${camp.name}: Calendar notes`, ''];
      for (const d of [...days.keys()].sort((a, b) => a - b)) {
        const x = days.get(d);
        L.push(`## ${day(d)}`, '');
        if (x.row && has(x.row.locations)) L.push(`**Where:** ${text(x.row.locations)}`, '');
        if (x.row && has(x.row.notes)) L.push('### Public notes', '', rich(x.row.notes, x.row.notes_format || 'text'), '');
        if (x.row && has(x.row.gm_notes)) L.push('### Secret notes 🔒', '', rich(x.row.gm_notes, x.row.gm_notes_format || 'text'), '');
        for (const s of [...x.shifts.keys()].sort((a, b) => a - b)) {
          const sh = x.shifts.get(s);
          L.push(`### ${shiftName(s) || `Shift ${s + 1}`}`, '');
          if (sh.row && has(sh.row.activity)) L.push(`**Activity:** ${text(sh.row.activity)}`, '');
          if (sh.row && has(sh.row.gm_notes)) L.push(`**GM notes 🔒:** ${text(sh.row.gm_notes)}`, '');
          for (const n of sh.notes) L.push(`- **${mdText(who(n.user_id) || 'A player')}:** ${text(n.body)}`);
          L.push('');
        }
      }
      page('Calendar notes.md', L);
    }

    // ---- Sessions, a page each
    const sessions = [...rows('play_sessions')].sort((a, b) => Number(a.number) - Number(b.number) || Number(a.id) - Number(b.id));
    const sname = fileNamer(), sessionNotes = new Map();
    for (const n of rows('session_notes')) { if (!sessionNotes.has(Number(n.session_id))) sessionNotes.set(Number(n.session_id), []); sessionNotes.get(Number(n.session_id)).push(n); }
    for (const s of sessions) {
      const title = `Session ${s.number}${has(s.title) ? `: ${s.title}` : ''}`;
      const L = [`# ${title}`, ''];
      const about = [has(s.played_on) ? `Played on ${s.played_on}` : '', has(s.first_day) ? `In game: ${day(s.first_day)}${has(s.last_day) && Number(s.last_day) !== Number(s.first_day) ? ` to ${day(s.last_day)}` : ''}` : '',
        on(s.is_published) ? 'Published' : 'Draft 🔒'].filter(has);
      L.push(`*${about.join(' · ')}*`, '', ...fileLines('session', s.id, '../'));
      if (has(s.summary)) L.push('## Summary', '', rich(s.summary, s.summary_format), '');
      if (has(s.rewards)) L.push('## Session Rewards', '', rich(s.rewards), '');
      if (has(s.loot)) L.push('## Loot Found', '', rich(s.loot), '');
      const notes = (sessionNotes.get(Number(s.id)) || []).sort((a, b) => Number(a.position) - Number(b.position));
      if (notes.length) L.push('## Notes 🔒', '', ...notes.map(n => `${'  '.repeat(Math.max(0, Number(n.depth) || 0))}- ${text(n.text)}`), '');
      else if (has(s.notes_text)) L.push('## Notes 🔒', '', text(s.notes_text), '');
      page(`Sessions/${sname(`${String(s.number).padStart(3, '0')} ${s.title || 'Session'}`, '.md')}`, L);
    }

    // ---- Library, a page each
    const tname = fileNamer();
    for (const t of rows('library_tomes')) {
      const L = [`# ${t.title}`, ''];
      if (has(t.description)) L.push(`*${text(t.description)}*`, '');
      L.push(...fileLines('library', t.id, '../'));
      if (has(t.body)) L.push(rich(t.body, t.kind === 'text' ? 'text' : undefined), '');
      page(`Library/${tname(t.title, '.md')}`, L);
    }

    // ---- Party: groups, holdings, funds and gear
    const table = (head, list) => (list.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...list.map(r => `| ${r.map(c => mdText(text(c)).replace(/\n/g, ' ')).join(' | ')} |`), ''] : []);
    const storage = new Map();
    for (const s of rows('holding_storage')) { if (!storage.has(Number(s.holding_id))) storage.set(Number(s.holding_id), []); storage.get(Number(s.holding_id)).push(s); }
    // the holdings, funds and gear of the party (who null) or of one character (its id: its sheet's Holdings page, 051)
    const ofWho = (t, who) => rows(t).filter(r => (has(r.character_id) ? Number(r.character_id) : null) === who);
    const holdingLines = (who, h2) => {
      const L = [], hs = ofWho('holdings', who), funds = ofWho('party_funds', who), gear = ofWho('party_gear', who);
      if (hs.length) L.push(`${h2} Holdings`, '');
      for (const h of hs) {
        L.push(`${h2}# ${h.name}`, '');
        const about = [h.type_name || h.kind, has(h.location) ? `at ${h.location}` : '', Number(h.amount) > 1 ? `× ${Number(h.amount)}` : ''].filter(has);
        if (about.length) L.push(`*${about.join(' · ')}*`, '');
        if (has(h.description)) L.push(text(h.description), '');
        L.push(...table(['Stored', 'Weight'], (storage.get(Number(h.id)) || []).map(s => [s.item, has(s.weight) ? String(Number(s.weight)) : ''])));
      }
      if (funds.length) L.push(`${h2} Funds`, '', ...table(['Currency', 'Amount', 'Where'], funds.map(f => [f.currency, String(Number(f.amount)), f.location])));
      if (gear.length) L.push(`${h2} Gear`, '', ...table(['Item', 'Amount', 'Held by', 'Where'], gear.map(g => [g.item, String(Number(g.amount)), g.claimed_by, g.location])));
      return L;
    };
    const partyHoldings = holdingLines(null, '##');
    if (partyHoldings.length || rows('party_groups').length) {
      const L = [`# ${camp.name}: Party`, ''];
      if (rows('party_groups').length) L.push('## Groups', '', ...rows('party_groups').map(g => `- ${mdText(g.name)}${on(g.is_main) ? ' (main group)' : ''}`), '');
      L.push(...partyHoldings);
      page('Party.md', L);
    }

    // ---- Characters: who they are and what each owns; their sheets are in campaign.json
    if (rows('sheet_characters').length) {
      const charName = c => entryName.get(Number(c.entry_id)) || `Character ${c.id}`;
      const L = [`# ${camp.name}: Characters`, '', ...table(['Character', 'Kind', 'Player'], rows('sheet_characters').map(c =>
        [charName(c), c.kind === 'npc' ? 'NPC' : 'PC', who(c.owner_id)])),
        'Each character\'s sheet (its filled-in fields) is in campaign.json, under `tables.sheet_characters`.', ''];
      for (const c of rows('sheet_characters')) {
        const own = holdingLines(Number(c.id), '###');
        if (own.length) L.push(`## ${mdText(charName(c))}'s holdings`, '', ...own);
      }
      page('Characters.md', L);
    }

    // ---- Reminders, clocks and downtime
    if (rows('reminders').length) {
      const L = [`# ${camp.name}: Reminders`, ''];
      for (const r of [...rows('reminders')].sort((a, b) => Number(a.due_shift) - Number(b.due_shift)))
        L.push(`- **${mdText(r.title)}**${r.audience === 'gm' ? ' 🔒' : ''}, due ${slot(r.due_shift)}${has(r.body) ? `: ${text(r.body).replace(/\n+/g, ' ')}` : ''}`);
      page('Reminders.md', L);
    }
    if (rows('clocks').length) {
      const L = [`# ${camp.name}: Clocks`, ''];
      for (const c of rows('clocks')) {
        const about = [`${Number(c.filled)} of ${Number(c.segments)}`, on(c.by_gm) ? '' : 'a player\'s', c.visibility === 'secret' ? 'Secret 🔒' : c.visibility === 'vague' ? 'Vague' : 'Shown',
          on(c.archived) ? 'put away' : '', entryName.has(Number(c.entry_id)) ? `about ${entryName.get(Number(c.entry_id))}` : ''].filter(has);
        L.push(`- **${mdText(c.name)}** (${about.join(', ')})${has(c.description) ? `: ${text(c.description).replace(/\n+/g, ' ')}` : ''}`);
      }
      page('Clocks.md', L);
    }
    if (rows('downtimes').length) {
      const L = [`# ${camp.name}: Downtime`, ''];
      for (const d of [...rows('downtimes')].sort((a, b) => Number(a.start_shift) - Number(b.start_shift))) {
        L.push(`## ${d.title || d.kind}`, '', `*${slot(d.start_shift)}${has(d.end_shift) && Number(d.end_shift) !== Number(d.start_shift) ? ` to ${slot(d.end_shift)}` : ''}*`, '');
        for (const a of json(d.activities_json) || []) if (a && has(a.text ?? a.activity ?? a.name)) L.push(`- ${a.who || a.character ? `**${mdText(a.who || a.character)}:** ` : ''}${text(a.text ?? a.activity ?? a.name)}`);
        L.push('');
        if (has(d.notes)) L.push(rich(d.notes), '');
        if (has(d.gm_notes)) L.push('**GM notes 🔒:**', '', rich(d.gm_notes), '');
      }
      page('Downtime.md', L);
    }

    // ---- Maps: each with its picture, pins and routes
    if (rows('maps').length) {
      const L = [`# ${camp.name}: Maps`, ''], maps = byId('maps');
      for (const m of rows('maps')) {
        L.push(`## ${m.name}${lock(m.is_secret)}`, '');
        if (fileOf.has(Number(m.image_id))) L.push(`![${mdText(m.name)}](${mdHref(fileOf.get(Number(m.image_id)))})`, '');
        if (has(m.scale_per_px)) L.push(`*${Number(m.width)} × ${Number(m.height)} px · 1 px = ${Number(Number(m.scale_per_px).toPrecision(4))} ${m.scale_unit || ''}*`, '');
        const pins = rows('map_pins').filter(p => Number(p.map_id) === Number(m.id));
        if (pins.length) L.push('**Pins**', '', ...pins.map(p => {
          const name = has(p.label) ? p.label : p.kind === 'entry' ? entryName.get(Number(p.entry_id)) : p.kind === 'event' ? eventTitle.get(Number(p.event_id)) : '';
          const opens = maps.get(Number(p.child_map_id));
          return `- ${mdText(name || 'Pin')}${lock(p.is_secret)}${opens ? ` (opens ${mdText(opens.name)})` : ''}${has(p.note) ? `: ${text(p.note).replace(/\n+/g, ' ')}` : ''}`;
        }), '');
        const routes = rows('map_routes').filter(r => Number(r.map_id) === Number(m.id));
        if (routes.length) L.push('**Routes**', '', ...routes.map(r => `- ${mdText(r.name || 'Route')}${lock(r.is_secret)}`), '');
      }
      page('Maps.md', L);
    }

    // ---- the front page, and every row
    const counts = [['Encyclopedia entries', entries.length, 'Encyclopedia/Encyclopedia.md'], ['Events', events.length, 'Events.md'], ['Days and shifts with notes', days.size, 'Calendar notes.md'],
      ['Sessions', sessions.length, 'Sessions'], ['Library tomes', rows('library_tomes').length, 'Library'], ['Holdings', ofWho('holdings', null).length, 'Party.md'],
      ['Characters', rows('sheet_characters').length, 'Characters.md'], ['Reminders', rows('reminders').length, 'Reminders.md'], ['Clocks', rows('clocks').length, 'Clocks.md'],
      ['Rests and downtime', rows('downtimes').length, 'Downtime.md'], ['Maps', rows('maps').length, 'Maps.md'], ['Pictures and files', fetch.length, 'files']];
    const R = [`# ${camp.name}`, ''];
    if (has(camp.description)) R.push(text(camp.description), '');
    R.push(`Everything in this campaign, exported from Campaign Chronicle on ${opts.date}. It is the GM's copy: GM-only entries, notes and paragraphs are in it, marked 🔒.`, '',
      `The campaign had reached ${slot(camp.current_shift)}.`, '', '## What is here', '',
      ...counts.filter(c => c[1]).map(([label, n, path]) => `- ${label}: ${n}, ${/\.md$/.test(path) ? `in [${path.replace(/\.md$/, '')}](${mdHref(path)})` : `in the \`${path}\` folder`}`), '',
      '## The files', '',
      '- The `.md` pages are for reading, in any text editor, Obsidian (open this folder as a vault) or a wiki.',
      '- `campaign.json` holds every row as the app stores it: the calendar and settings, regions, holidays, days and their weather, events, the Encyclopedia and its connections, sessions, the Library, holdings, character sheets, maps, pins and routes, clocks and dice rolls. Rich text is HTML there. People are named in `people`, by the numbers the rows use.',
      '- `files` holds each picture and file once, named by its number in `campaign.json` (`tables.attachments`).', '',
      'Not in it: the members and their accounts, edit history, API keys and invitation links.');
    out.unshift({ path: 'README.md', data: R.join('\n') + '\n\n' + foot + '\n' });
    out.push({ path: 'campaign.json', data: JSON.stringify(data, null, 1) + '\n' });
    return { files: out, fetch };
  }

  const api = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CampaignExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
