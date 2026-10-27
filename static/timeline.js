/* timeline.js — the arithmetic behind the Events tab's Timeline: where each event sits, which lane and row it takes, and
 * the ticks and labels of the axis in the campaign's own calendar.
 *
 * Plain script, no build step, and no page needed: app.js hands it the calendar and the events and gets back numbers
 * and text, so the same file runs under Node in the tests. Time is counted in days from the calendar's day 0 (abs_day),
 * as fractions where an event has shifts or hours: a day of four shifts puts Dusk at day + 0.5. A zoom is how many
 * pixels a day takes (px per day). */
'use strict';

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  /** The zoom buttons, from widest to closest, each as about how many days the view spans. */
  const ZOOMS = [
    ['era', 'Era', cal => 100 * avgYear(cal)],
    ['year', 'Year', cal => 1.5 * avgYear(cal)],
    ['month', 'Month', cal => 3 * avgMonth(cal)],
    ['week', 'Week', cal => 3 * E.weekLength(cal)],
    ['day', 'Day', () => 4],
  ];
  const avgYear = cal => E.yearLength(cal, cal.epochYear);
  // intercalary days and festival weeks are left out, so a month is the length of an ordinary one
  const avgMonth = cal => {
    const ms = (cal.months || []).filter(m => !m.intercalary && Number(m.days) > 1);
    return ms.length ? ms.reduce((n, m) => n + Number(m.days), 0) / ms.length : avgYear(cal) / Math.max(1, (cal.months || []).length);
  };
  /** The px per day that shows a zoom's span across width pixels. */
  const zoomPx = (cal, key, width) => width / ZOOMS.find(z => z[0] === key)[2](cal);
  /** The zoom button nearest a px per day. */
  function zoomOf(cal, ppd, width) {
    let best = null, gap = Infinity;
    for (const [key] of ZOOMS) {
      const g = Math.abs(Math.log(zoomPx(cal, key, width) / ppd));
      if (g < gap) { gap = g; best = key; }
    }
    return best;
  }

  /** Where an event runs, in days: { start, end, days }. An event without a shift fills its days; one with shifts runs
   * from the start of its first shift to the end of its last (a missing Shift End is its Shift Start). slots is the
   * calendar's shifts or hours a day. days is how many calendar days it touches. */
  function span(e, slots) {
    const a = Number(e.abs_day), b = e.end_day === null || e.end_day === undefined ? a : Number(e.end_day);
    if (e.shift === null || e.shift === undefined) return { start: a, end: b + 1, days: b - a + 1 };
    const s = Number(e.shift), t = e.shift_end === null || e.shift_end === undefined ? s : Number(e.shift_end);
    return { start: a + s / slots, end: b + (t + 1) / slots, days: b - a + 1 };
  }

  /** The lanes the events go in: [{ key, name, color, events }]. by is 'tags' (one lane per tag, in the order of tags,
   * with an Untagged lane last; an event with two tags is in both), 'entries' (one lane per Encyclopedia entry an
   * event names, from mentions(e), by name, with a lane for the rest) or 'one' (every event in one lane). */
  function lanes(events, by, { tags = [], mentions = () => [] } = {}) {
    if (by === 'one') return events.length ? [{ key: 'all', name: 'All events', color: null, events }] : [];
    const out = new Map(), rest = [];
    const add = (key, name, color, e) => {
      if (!out.has(key)) out.set(key, { key, name, color, events: [] });
      out.get(key).events.push(e);
    };
    if (by === 'entries') {
      for (const e of events) {
        const named = mentions(e);
        if (!named.length) rest.push(e);
        for (const n of named) add(`entry:${n.id}`, n.name, null, e);
      }
      const list = [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
      return rest.length ? [...list, { key: 'none', name: 'No entry named', color: null, events: rest }] : list;
    }
    for (const t of tags) out.set(`tag:${t.name.toLowerCase()}`, { key: `tag:${t.name.toLowerCase()}`, name: t.name, color: t.color, events: [] });
    for (const e of events) {
      if (!(e.tags || []).length) rest.push(e);
      for (const t of e.tags || []) add(`tag:${t.name.toLowerCase()}`, t.name, t.color, e);
    }
    const list = [...out.values()].filter(l => l.events.length);
    return rest.length ? [...list, { key: 'none', name: 'Untagged', color: null, events: rest }] : list;
  }

  /** Rows inside a lane, so nothing drawn overlaps: items are { x0, x1 } in pixels (a mark and its label), taken in
   * order and each put on the first row free from x0, with gap pixels to spare. Returns each item's row, and how many
   * rows there are. maxRows caps them: anything past it shares the last row. */
  function pack(items, gap = 6, maxRows = Infinity) {
    const ends = [], rows = items.map(it => {
      let r = ends.findIndex(x => x + gap <= it.x0);
      if (r < 0) r = ends.length < maxRows ? ends.length : ends.length - 1;
      ends[r] = Math.max(ends[r] ?? -Infinity, it.x1);
      return r;
    });
    return { rows, count: ends.length };
  }

  // ---------------------------------------------------------------- the axis
  /** Ticks of one kind in [from, to): [{ day, label }]. kind is 'day', 'week', 'month', 'year' or a number of years. */
  function ticks(cal, kind, from, to, limit = 4000) {
    E.prep(cal);
    const out = [], lo = Math.floor(from), hi = Math.ceil(to);
    const y0 = E.fromAbs(cal, lo).year, y1 = E.fromAbs(cal, hi).year;
    if (kind === 'day' || kind === 'week') {
      const W = E.weekLength(cal), weeks = (cal.weekdays || []).length > 0;
      if (hi - lo > limit * (kind === 'week' ? W : 1)) return null;
      for (let d = lo; d <= hi; d++) {
        const p = E.fromAbs(cal, d);
        // a calendar with weekdays starts its weeks on the first of them; one without counts weeks from each month's 1st
        if (kind === 'week' && (weeks ? E.weekday(cal, d) !== 0 : (p.day - 1) % W !== 0)) continue;
        out.push({ day: d, label: String(p.day) });
      }
    } else if (kind === 'month') {
      if ((y1 - y0 + 1) * cal.months.length > limit) return null;
      for (let y = y0; y <= y1; y++) cal.months.forEach((m, i) => {
        const d = E.toAbs(cal, y, i, 1);
        if (d >= lo && d <= hi) out.push({ day: d, label: m.name, year: y, month: i });
      });
    } else {
      const k = kind === 'year' ? 1 : kind;
      if ((y1 - y0 + 1) / k > limit) return null;
      for (let y = Math.ceil(y0 / k) * k; y <= y1; y += k) {
        const d = E.yearStart(cal, y);
        if (d >= lo && d <= hi) out.push({ day: d, label: E.yearLabel(cal, y), year: y });
      }
    }
    return out;
  }
  // the axis's kinds, finest first, each with roughly how many days apart its ticks are and how wide its label is
  const KINDS = cal => [['day', 1, 22], ['week', E.weekLength(cal), 26], ['month', avgMonth(cal), 48], ['year', avgYear(cal), 70],
    ...[2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].map(k => [k, k * avgYear(cal), 70])];
  /** The axis for the days [from, to) at ppd px per day: { minor, major } ticks, minor being the finest kind whose
   * labels fit and major the next kind up that differs from it in meaning (months over days and weeks, years over
   * months, and for years, every tenth or so). A major tick's label is in full: "Firstmonth 1492 DR". */
  function axis(cal, from, to, ppd) {
    const kinds = KINDS(cal);
    let i = kinds.findIndex(([, days, w]) => days * ppd >= w + 8);
    if (i < 0) i = kinds.length - 1;
    const minorKind = kinds[i][0];
    const minor = ticks(cal, minorKind, from, to) || [];
    let majorKind = minorKind === 'day' || minorKind === 'week' ? 'month' : minorKind === 'month' ? 'year' : null;
    if (!majorKind) {
      // years: the next coarser count of years that's at least five times as far apart
      const n = kinds[i][1] / avgYear(cal);
      majorKind = (kinds.slice(i + 1).find(([k]) => typeof k === 'number' && k >= n * 5) || [null])[0];
    }
    let major = majorKind ? ticks(cal, majorKind, from, to) || [] : [];
    if (majorKind === 'month') major = major.map(t => ({ ...t, label: `${t.label} ${E.yearLabel(cal, t.year)}` }));
    // the first label on screen says where the view starts, even before the first major tick
    const p = E.fromAbs(cal, Math.floor(from));
    const lead = majorKind === 'month' ? `${cal.months[p.month].name} ${E.yearLabel(cal, p.year)}` : E.yearLabel(cal, p.year);
    return { minorKind, majorKind, minor, major, lead };
  }

  /** The season stretches in [from, to): [{ from, to, name, type }], cut at the view's edges. Empty for a calendar
   * without seasons, or a view so wide (over limit years) that they'd be slivers. */
  function seasonBands(cal, from, to, limit = 60) {
    if (!(cal.seasons || []).length) return [];
    E.prep(cal);
    const y0 = E.fromAbs(cal, Math.floor(from)).year, y1 = E.fromAbs(cal, Math.ceil(to)).year;
    if (y1 - y0 > limit) return [];
    const starts = [];
    for (let y = y0 - 1; y <= y1 + 1; y++) for (const x of E.seasonStarts(cal, y)) starts.push({ day: E.yearStart(cal, y) + x.doy, name: x.s.name, type: x.s.type || 'none' });
    const out = [];
    starts.forEach((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].day : Infinity;
      if (end > from && s.day < to) out.push({ from: Math.max(s.day, from), to: Math.min(end, to), name: s.name, type: s.type });
    });
    return out;
  }

  /** The holidays in [from, to): [{ from, to, name, color }], one per run of days. Skipped (null) over limit days. */
  function holidayBands(cal, holidays, from, to, limit = 1200) {
    const lo = Math.floor(from), hi = Math.ceil(to);
    if (!(holidays || []).length) return [];
    if (hi - lo > limit) return null;
    const open = new Map(), out = [];
    for (let d = lo; d <= hi; d++) {
      const on = new Set(E.holidaysOn(cal, holidays, d));
      for (const [h, run] of open) if (!on.has(h)) { out.push(run); open.delete(h); }
      for (const h of on) if (open.has(h)) open.get(h).to = d + 1; else open.set(h, { from: d, to: d + 1, name: h.name, color: h.color, description: h.description || '' });
    }
    out.push(...open.values());
    return out.sort((a, b) => a.from - b.from);
  }

  const Timeline = { ZOOMS, zoomPx, zoomOf, span, lanes, pack, ticks, axis, seasonBands, holidayBands };
  if (typeof module !== 'undefined' && module.exports) module.exports = Timeline;
  else root.Timeline = Timeline;
})(typeof window !== 'undefined' ? window : globalThis);
