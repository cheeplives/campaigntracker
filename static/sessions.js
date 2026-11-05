/* sessions.js — the shorthand of a session's notes box, and the draft summary built from a session's notes.
 *
 * Plain script, no build step, and no page needed: app.js hands it the calendar and the notes and gets back numbers
 * and text, so the same file runs under Node in the tests. A session's notes are one text box (notesFromText reads it
 * as notes: a line each, indented lines under the line above). A note is { depth, text, abs_shift }; its first
 * character can mark it:
 *   !  a GM aside (dice, rules): never in the draft;
 *   ?  a loose end: in the draft only as a GM-only "Loose ends" paragraph at the end;
 *   >  a time jump: the notes after it take the day and shift it reaches (see parseJump);
 *   $  a secret: in the draft as a GM-only paragraph, with the lines indented under it. 🔒 at the start of an
 *      unindented line does the same (notes imported from a day's Secret notes before $ were written this way).
 * Sessions from before the text box kept a row per note; foldNotes writes those rows out as the box's text. */
'use strict';

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  /** '!', '?', '>', '$' or '' for a note's text. */
  const mark = text => {
    const c = String(text || '').trimStart().charAt(0);
    return '!?>$'.includes(c) && c ? c : '';
  };
  /** Whether a note starts a GM-only block: $, or 🔒 on an unindented line. */
  const secretLine = (text, depth) => mark(text) === '$' || (Number(depth) === 0 && String(text || '').trim().startsWith('🔒'));
  const secretText = text => { const t = String(text || '').trim(); return (t.startsWith('🔒') ? t.slice('🔒'.length) : t.slice(1)).trim(); };

  /** The text typed in the notes box as notes: one per non-blank line, trimmed, its depth from how far it is indented
   * (tabs count four spaces; a line indented further than the one above is a level deeper, at most 3; one indented less
   * goes back to the level it matches). line is its place in the text, from 1. */
  function parseLines(text) {
    const out = [], stack = [0];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      if (!raw.trim()) return;
      const w = /^[ \t]*/.exec(raw)[0].replace(/\t/g, '    ').length;
      if (w > stack[stack.length - 1]) stack.push(w);
      else while (stack.length > 1 && w < stack[stack.length - 1]) stack.pop();
      out.push({ text: raw.trim(), depth: Math.min(3, stack.length - 1), line: i + 1 });
    });
    return out;
  }

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

  /** The notes box's text as notes, each stamped with the shift it happened in: start (the session's first day) until a
   * > line moves it; ">" alone goes to clock. Returns { notes: [{ text, depth, abs_shift, line }], end (the stamp after
   * the last line), bad: [line numbers of > lines that couldn't be read, which leave the stamp where it was] }. */
  function notesFromText(cal, text, start, clock) {
    let stamp = start;
    const notes = [], bad = [];
    for (const l of parseLines(text)) {
      if (mark(l.text) === '>') {
        const at = parseJump(cal, l.text, stamp, clock);
        if (at === null) bad.push(l.line); else stamp = at;
      }
      notes.push({ text: l.text, depth: l.depth, abs_shift: stamp, line: l.line });
    }
    return { notes, end: stamp, bad };
  }
  /** A > line that takes the day of stamp `from` to day `to` (keeping the shift), checked by reading it back: ">+3"
   * going forward, else the date itself. null when no line would read back right (a calendar parseDate can't name). */
  function jumpLine(cal, from, to) {
    const n = E.slotsPerDay(cal), day = Math.floor(from / n);
    if (to === day) return null;
    const tries = [];
    if (to > day) tries.push(`>+${to - day}`);
    const p = E.fromAbs(cal, to), mo = cal.months[p.month];
    if (mo) tries.push(`>${p.day} ${mo.name} ${p.year}`, `>${p.day} ${mo.name}`);
    for (const t of tries) {
      const at = parseJump(cal, t, from, from);
      if (at !== null && Math.floor(at / n) === to) return t;
    }
    return null;
  }
  /** The text for the notes box from a session's note rows (in order), from before notes were one text box: a line each,
   * indented two spaces a level. Where a note's day isn't the one the lines above it reach from start (notes imported
   * from a day, moved in time, or a ">" back to a clock that has moved since), a > line is written above it, so the
   * draft still puts it under its day. */
  function foldNotes(cal, rows, start) {
    const n = E.slotsPerDay(cal), out = [];
    let stamp = start;
    for (const r of rows) {
      const pad = '  '.repeat(Math.max(0, Math.min(3, Number(r.depth) || 0))), at = Number(r.abs_shift), text = String(r.text || '').trim();
      if (!text) continue;
      if (mark(text) === '>') {
        const read = parseJump(cal, text, stamp, stamp);
        if (read !== null && Math.floor(read / n) === Math.floor(at / n)) { out.push(pad + text); stamp = read; continue; }
        const j = jumpLine(cal, stamp, Math.floor(at / n));
        out.push(pad + (j || text));
        stamp = j ? parseJump(cal, j, stamp, stamp) : at;
        continue;
      }
      if (Math.floor(at / n) !== Math.floor(stamp / n)) {
        const j = jumpLine(cal, stamp, Math.floor(at / n));
        if (j) { out.push(pad + j); stamp = parseJump(cal, j, stamp, stamp); }
      }
      out.push(pad + text);
    }
    return out.join('\n');
  }

  /** What was written on the shifts a session ran over, as notes for the draft, shift by shift from `from` to `to`
   * (absolute shifts): a shift's activity as a line (any further lines of it indented under it), each player's note on
   * it indented under that with its author in brackets (a line of its own when the shift has no activity), and the GM's
   * notes on it as a $ line, so they stay GM-only. Activities and players' notes are marked plain: draftHtml reads no
   * shorthand in them. days: what the day action sends for each day, { d, shifts:
   * [{ shift, activity, gm_notes }], shift_notes: [{ shift, body, author }] }. */
  function shiftNotes(cal, days, from, to) {
    const n = E.slotsPerDay(cal), out = [];
    const lines = t => String(t || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const byDay = new Map(days.map(x => [Number(x.d), x]));
    for (let a = from; a <= to; a++) {
      const x = byDay.get(Math.floor(a / n));
      if (!x) continue;
      const i = E.mod(a, n), s = (x.shifts || []).find(y => Number(y.shift) === i) || {};
      const act = lines(s.activity);
      // plain: written on a shift, not in the shorthand, so a ! or ? it starts with is just a character
      act.forEach((t, k) => out.push({ text: t, depth: k ? 1 : 0, abs_shift: a, plain: true }));
      for (const m of (x.shift_notes || []).filter(y => Number(y.shift) === i)) {
        const t = lines(m.body).join(' ');
        if (t) out.push({ text: m.author ? `${sentence(t)} (${m.author})` : t, depth: act.length ? 1 : 0, abs_shift: a, plain: true });
      }
      lines(s.gm_notes).forEach((t, k) => out.push({ text: k ? t : `$ ${t}`, depth: k ? 1 : 0, abs_shift: a }));
    }
    return out;
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
   * lines left out; $ (and 🔒) lines GM-only paragraphs, with the lines indented under them; ? lines in one GM-only
   * "Loose ends" paragraph at the end. '' when nothing is left. */
  function draftHtml(cal, notes) {
    const n = E.slotsPerDay(cal), paras = [], loose = [], secret = [];
    // where indented lines go: the paragraph above, the loose end above (in brackets), or nowhere under a ! line
    let cur = null;
    for (const x of notes) {
      const k = x.plain ? '' : mark(x.text), top = Number(x.depth) === 0 || !cur;
      if (k === '>') continue;
      if (!x.plain && secretLine(x.text, top ? 0 : x.depth)) {
        const t = secretText(x.text);
        if (!top) { if (t && !cur.sink) secret.push({ text: t, more: [] }); continue; }   // an indented $ line: that line alone, GM only
        secret.push({ text: t, more: [] });
        cur = { secret: secret[secret.length - 1] };
        continue;
      }
      if (k === '!' || k === '?') {
        if (!top) continue;                                   // an indented ! or ? line: just that line is left out
        const t = String(x.text).trim().slice(1).trim();
        cur = k === '?' && t ? (loose.push({ text: t, more: [] }), { loose: loose[loose.length - 1] }) : { sink: true };
        continue;
      }
      const t = String(x.text).trim();
      if (!t) continue;
      if (top) { paras.push(cur = { day: Math.floor(Number(x.abs_shift) / n), parts: [] }); cur.parts.push(sentence(t)); }
      else if (cur.secret) cur.secret.more.push(t);
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
    for (const g of secret) {
      const t = g.text && g.more.length ? `${g.text}: ${g.more.join('; ')}` : g.text || g.more.join('; ');
      if (t) html += `<aside>${esc(t)}</aside>`;
    }
    if (loose.length) html += `<aside>${esc(`Loose ends: ${loose.map(l => l.more.length ? `${l.text} (${l.more.join('; ')})` : l.text).join('; ')}`)}</aside>`;
    return html;
  }

  /** "Session 12: A Locked Box", or "Session 12" when it has no title. */
  const name = s => `Session ${s.number}${s.title ? `: ${s.title}` : ''}`;
  /** The in-game days a session covered, as text, with the shifts it started and ended on when it knows them (sessions
   * from before those were kept cover whole days). */
  function daysCovered(cal, s) {
    const f = d => E.fmtDate(cal, d, { noWeekday: true });
    const open = s.last_day === null || s.last_day === undefined;
    if (s.first_shift !== null && s.first_shift !== undefined) {
      const n = E.slotsPerDay(cal), names = E.shiftNames(cal);
      const at = a => ({ d: Math.floor(a / n), name: names[E.mod(a, n)] });
      const a = at(Number(s.first_shift));
      if (open) return `${a.name}, ${f(a.d)} onwards`;
      if (s.last_shift !== null && s.last_shift !== undefined) {
        const b = at(Number(s.last_shift));
        if (a.d === b.d) return a.name === b.name ? `${a.name}, ${f(a.d)}` : `${f(a.d)}, ${a.name} to ${b.name}`;
        return `${a.name}, ${f(a.d)} to ${b.name}, ${f(b.d)}`;
      }
    }
    if (open) return `${f(s.first_day)} onwards`;
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
    for (const [key, title] of [['rewards', 'Session Rewards'], ['loot', 'Loot Found']]) {
      const md = session[key] ? toMarkdown(session[key]) : '';
      if (md) L.push(`## ${title}`, '', md, '');
    }
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

  const Sessions = { mark, parseLines, parseJump, stampAt, notesFromText, jumpLine, foldNotes, shiftNotes, draftHtml, sentence, name, daysCovered, markdown, fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sessions;
  else root.Sessions = Sessions;
})(typeof window !== 'undefined' ? window : globalThis);
