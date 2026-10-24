/* sessions.js — the shorthand of the Session notes box, and the draft summary built from a session's notes.
 *
 * Plain script, no build step, and no page needed: app.js hands it the calendar and the notes and gets back numbers
 * and text, so the same file runs under Node in the tests. A note is { id, position, depth, text, abs_shift,
 * is_covered }; its first character can mark it:
 *   !  a GM aside (dice, rules): never in the draft;
 *   ?  a loose end: in the draft only as a GM-only "Loose ends" paragraph at the end;
 *   >  a time jump: the notes after it take the day and shift it reaches (see parseJump). */
'use strict';

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  /** '!', '?', '>' or '' for a note's text. */
  const mark = text => {
    const c = String(text || '').trimStart().charAt(0);
    return '!?>'.includes(c) && c ? c : '';
  };

  /** The slot named by a word: a shift name from its start ("du" is Dusk), or in hours mode an hour, "14" or "14:00". */
  function slotOf(cal, word) {
    if (!word) return null;
    const n = E.slotsPerDay(cal);
    if (E.timeMode(cal) === 'hours') {
      const m = /^(\d{1,3})(?::00)?$/.exec(word);
      return m && Number(m[1]) < n ? Number(m[1]) : null;
    }
    const i = E.shiftNames(cal).findIndex(s => s.toLowerCase().startsWith(word));
    return i < 0 ? null : i;
  }
  /** The day reached from day: "+3", "+3d", "+2w", "+1m", or a date ("12 Firstmonth"). */
  function dayOf(cal, text, day) {
    const m = /^\+(\d+)\s*([dwm])?$/.exec(text);
    if (m) {
      const k = Number(m[1]);
      return m[2] === 'w' ? day + k * E.weekLength(cal) : m[2] === 'm' ? E.addMonths(cal, day, k) : day + k;
    }
    return E.parseDate(cal, text, day);
  }
  /** The absolute shift a ">" line reaches from stamp (the shift the notes before it took), or null when it can't be
   * read. ">" alone goes back to clock. A day without a shift keeps the stamp's shift; a shift alone keeps its day. */
  function parseJump(cal, text, stamp, clock) {
    const t = String(text || '').trim();
    if (t[0] !== '>') return null;
    const rest = t.slice(1).trim().toLowerCase();
    if (!rest) return clock;
    const n = E.slotsPerDay(cal), day = Math.floor(stamp / n), slot = E.mod(stamp, n);
    const s = slotOf(cal, rest);
    if (s !== null) return day * n + s;
    const d = dayOf(cal, rest, day);
    if (d !== null) return d * n + slot;
    const words = rest.split(/\s+/);
    if (words.length < 2) return null;
    const s2 = slotOf(cal, words[words.length - 1]), d2 = s2 === null ? null : dayOf(cal, words.slice(0, -1).join(' '), day);
    return d2 === null ? null : d2 * n + s2;
  }
  /** The stamp a new note takes: the last jump's shift among the notes (in order), else the campaign clock. */
  function stampAt(notes, clock) {
    for (let i = notes.length - 1; i >= 0; i--) if (mark(notes[i].text) === '>') return Number(notes[i].abs_shift);
    return clock;
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** A note as a sentence: trimmed, its first letter capitalized, a full stop added when it has no closing mark. */
  function sentence(text) {
    const t = String(text).trim();
    if (!t) return '';
    const s = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?…:;"')\]]$/.test(s) ? s : `${s}.`;
  }
  /** A starting summary from a session's notes (in order), as rich text: each unindented note a paragraph with its
   * indented notes as further sentences, grouped under a heading per in-game day when there are several; ! and >
   * lines left out; ? lines in one GM-only "Loose ends" paragraph at the end. '' when nothing is left. */
  function draftHtml(cal, notes) {
    const n = E.slotsPerDay(cal), paras = [], loose = [];
    // where indented lines go: the paragraph above, the loose end above (in brackets), or nowhere under a ! line
    let cur = null;
    for (const x of notes) {
      const k = mark(x.text), top = Number(x.depth) === 0 || !cur;
      if (k === '>') continue;
      if (k === '!' || k === '?') {
        if (!top) continue;                                   // an indented ! or ? line: just that line is left out
        const t = String(x.text).trim().slice(1).trim();
        cur = k === '?' && t ? (loose.push({ text: t, more: [] }), { loose: loose[loose.length - 1] }) : { sink: true };
        continue;
      }
      const t = String(x.text).trim();
      if (!t) continue;
      if (top) { paras.push(cur = { day: Math.floor(Number(x.abs_shift) / n), parts: [] }); cur.parts.push(sentence(t)); }
      else if (cur.loose) cur.loose.more.push(t);
      else if (!cur.sink) cur.parts.push(sentence(t));
    }
    // one heading per day, in day order; the notes keep their order within a day
    const days = [...new Set(paras.map(p => p.day))].sort((a, b) => a - b);
    let html = '';
    for (const d of days) {
      if (days.length > 1) html += `<h3>${esc(E.fmtDate(cal, d))}</h3>`;
      for (const p of paras) if (p.day === d) html += `<p>${esc(p.parts.join(' '))}</p>`;
    }
    if (loose.length) html += `<aside>${esc(`Loose ends: ${loose.map(l => l.more.length ? `${l.text} (${l.more.join('; ')})` : l.text).join('; ')}`)}</aside>`;
    return html;
  }

  /** "Session 12: A Locked Box", or "Session 12" when it has no title. */
  const name = s => `Session ${s.number}${s.title ? `: ${s.title}` : ''}`;
  /** The in-game days a session covered, as text. */
  function daysCovered(cal, s) {
    const f = d => E.fmtDate(cal, d, { noWeekday: true });
    if (s.last_day === null || s.last_day === undefined) return `${f(s.first_day)} onwards`;
    return s.last_day === s.first_day ? f(s.first_day) : `${f(s.first_day)} to ${f(s.last_day)}`;
  }
  /** A session as a Markdown file, laid out like the day export: a # title, an italic byline, the summary and, when
   * withNotes, the notes as a nested list. toMarkdown turns the summary's rich text into Markdown (RichText.toMarkdown
   * in the browser). Only what the reader was sent goes in. */
  function markdown({ cal, session, notes = [], gm = false, withNotes = false, toMarkdown }) {
    const L = [`# ${name(session)}`, '',
      `*${session.played_on ? `Played ${session.played_on} · ` : ''}${daysCovered(cal, session)}*`, ''];
    const body = session.summary ? toMarkdown(session.summary) : '';
    L.push(body || '*No summary written yet.*', '');
    if (withNotes && notes.length) {
      L.push('## Notes', '');
      for (const n of notes) L.push(`${'   '.repeat(Number(n.depth) || 0)}- ${String(n.text).replace(/\s+/g, ' ')}`);
      L.push('');
    }
    L.push(`*Exported from Campaign Chronicle · ${gm ? 'GM' : 'player'} view · ${new Date().toISOString().slice(0, 10)}*`);
    return L.join('\n') + '\n';
  }
  /** "Session 12 - A Locked Box.md", without characters a file name can't hold. */
  const fileName = s => `${`Session ${s.number}${s.title ? ` - ${s.title}` : ''}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()}.md`;

  const Sessions = { mark, parseJump, stampAt, draftHtml, sentence, name, daysCovered, markdown, fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sessions;
  else root.Sessions = Sessions;
})(typeof window !== 'undefined' ? window : globalThis);
