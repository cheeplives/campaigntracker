/* vtt-calendar.js — a campaign's calendar for Seasons & Stars, the calendar module most Foundry VTT worlds use (Simple
 * Calendar, the one before it, stopped at Foundry 12). Seasons & Stars reads a calendar JSON file chosen in its Select
 * Calendar dialog; the format is its CALENDAR-FORMAT.md (github.com/rayners/fvtt-seasons-and-stars, MIT licence).
 *
 * Plain script, no build step, and no page needed, so it runs under Node in the tests. It only maps one format to
 * another: months, festival days, weekdays, the leap rule, eras' starting year, moons, seasons, the hours in a day and
 * the holidays it can express. What Seasons & Stars can't express (a Red Moon, an erratic moon, leap days in more than
 * one month, holidays tied to a moon's phase) is listed in lost, so the GM is told before downloading.
 *
 * Seasons & Stars counts months from 1 among the ordinary months only; festival months are its "intercalary" days,
 * placed after the month before them (or before the first month). Weekdays count from 0. */
'use strict';

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const has = v => v !== null && v !== undefined && String(v).trim() !== '';
  const hex = c => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : undefined;
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'calendar';
  const ICONS = ['new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous', 'full', 'waning-gibbous', 'last-quarter', 'waning-crescent'];

  /** camp: { name, calendar, current_shift }. Returns { calendar (the file's object), today: { year, month, day } in its
   * terms (null on a festival day), lost: [what didn't fit, in words] }. */
  function seasonsAndStars(camp, holidays = []) {
    const c = E.prep(JSON.parse(JSON.stringify(camp.calendar)));
    const lost = [];
    const months = c.months.map((m, i) => ({ m, i })), regular = months.filter(x => !x.m.intercalary);
    // index in Chronicle's months → 1-based month among the ordinary ones
    const ssMonth = new Map(regular.map((x, k) => [x.i, k + 1]));
    const name = c.name || camp.name || 'Campaign calendar';
    if (!regular.length) throw new Error('This calendar has only festival months, which Seasons & Stars can\'t show.');

    // ordinary months with no days (or leap-year only ones) can't be months in Seasons & Stars
    for (const x of regular) if (!(Number(x.m.days) > 0)) lost.push(`${x.m.name} has no days outside leap years, which Seasons & Stars can't show as a month.`);

    // the leap rule: Chronicle's every / skip / unskip
    const L = c.leap || {}, every = Number(L.every) || 0, extra = months.filter(x => Number(x.m.leapDays) > 0);
    let leapYear = { rule: 'none' };
    if (every > 0 && extra.length) {
      const ord = extra.filter(x => !x.m.intercalary);
      const rule = every === 4 && Number(L.skip) === 100 && Number(L.unskip) === 400 ? { rule: 'gregorian' } : { rule: 'custom', interval: every, offset: 0 };
      if (rule.rule === 'custom' && Number(L.skip)) lost.push(`The leap rule skips some years (every ${L.skip}); Seasons & Stars will have a leap year every ${every} years.`);
      if (ord.length) {
        leapYear = { ...rule, month: ord[0].m.name, extraDays: ord.reduce((n, x) => n + Number(x.m.leapDays), 0) };
        if (ord.length > 1) lost.push(`Leap days fall in ${ord.map(x => x.m.name).join(' and ')}; Seasons & Stars adds them all to ${ord[0].m.name}.`);
      } else leapYear = { ...rule };
    }

    // festival months: intercalary days after the ordinary month before them
    const intercalary = [];
    let before = null;
    for (const x of months) {
      if (!x.m.intercalary) { before = x.m.name; continue; }
      const days = Number(x.m.days) || 0, leap = Number(x.m.leapDays) || 0;
      const place = before ? { after: before } : { before: regular[0].m.name };
      if (days > 0) {
        intercalary.push({ name: x.m.name, days, ...place, leapYearOnly: false, countsForWeekdays: !!x.m.keepWeekday });
        if (leap > 0) lost.push(`${x.m.name} gains ${leap} day${leap > 1 ? 's' : ''} in leap years, which Seasons & Stars can't do for a festival.`);
      } else if (leap > 0 && leapYear.rule !== 'none') intercalary.push({ name: x.m.name, days: leap, ...place, leapYearOnly: true, countsForWeekdays: !!x.m.keepWeekday });
    }

    // weekdays: Seasons & Stars needs at least one
    const W = c.weekdays.length;
    const weekdays = W ? c.weekdays.map(w => ({ name: w })) : [{ name: 'Day' }];
    if (!W) lost.push('This calendar has no weekdays; Seasons & Stars gets one, called Day.');

    // a Chronicle day as a Seasons & Stars date; null on a festival day
    const ssDate = d => { const p = E.fromAbs(c, d); return ssMonth.has(p.month) ? { year: p.year, month: ssMonth.get(p.month), day: p.day } : null; };

    // moons: a new moon on an ordinary day, and the eight phases
    const moons = [];
    for (const m of c.moons || []) {
      if (E.isRedMoon(m)) { lost.push(`${m.name} follows the weekday and the region, which Seasons & Stars can't do.`); continue; }
      if (m.erratic) lost.push(`${m.name} wanders in Chronicle; in Seasons & Stars it keeps a steady ${m.cycle}-day cycle.`);
      const cycle = Number(m.cycle) || 28;
      let first = null;
      for (let k = 0; k < 50 && !first; k++) first = ssDate(Math.floor(Number(m.ref || 0)) + Math.round(k * cycle));
      if (!first) { lost.push(`${m.name}'s new moons all fall on festival days, so it was left out.`); continue; }
      const one = cycle >= 8, long = one ? (cycle - 4) / 4 : cycle / 8;
      moons.push({ name: m.name, cycleLength: cycle, firstNewMoon: first, color: hex(m.color),
        phases: E.MOON_PHASES.map(([label], i) => ({ name: label, length: one && i % 2 === 0 ? 1 : long, singleDay: one && i % 2 === 0, icon: ICONS[i] })) });
    }

    // seasons: each runs to the day before the next one starts
    const y0 = c.epochYear, starts = (c.seasons || []).length ? E.seasonStarts(c, y0) : [];
    const ordinary = (d, step) => { for (let k = 0; k < 400; k++, d += step) { const x = ssDate(d); if (x) return x; } return null; };
    const seasons = starts.map((s, i) => {
      const from = E.yearStart(c, y0) + s.doy, next = starts[(i + 1) % starts.length];
      const to = E.yearStart(c, y0) + next.doy - 1 + (i + 1 === starts.length ? E.yearLength(c, y0) : 0);
      const a = ordinary(from, 1), b = ordinary(to, -1);
      const out = { name: s.s.name, startMonth: a.month, startDay: a.day, endMonth: b.month, endDay: b.day };
      for (const k of ['sunrise', 'sunset']) if (E.parseClock(s.s[k]) !== null) out[k] = s.s[k];
      return out;
    });

    // holidays Seasons & Stars can express: a fixed date or the nth weekday of an ordinary month, every year or every n years
    const events = [], festival = new Set(), other = new Set();
    const ids = new Set();
    for (const h of holidays) {
      const r = h.rule || {}, m = Number(r.month), every = Math.max(1, Math.trunc(Number(r.every_years)) || 1);
      // a holiday on a festival month is that festival, which Seasons & Stars shows by name already
      if ((r.type === 'fixed' || r.type === 'nth_weekday') && c.months[m]?.intercalary) { festival.add(h.name); continue; }
      if ((r.type !== 'fixed' && r.type !== 'nth_weekday') || !ssMonth.has(m) || has(r.times) && Number(r.times) > 0) { other.add(h.name); continue; }
      const anchor = has(r.from_year) ? Number(r.from_year) : y0;
      let recurrence;
      if (r.type === 'fixed') recurrence = every > 1 ? { type: 'interval', intervalYears: every, anchorYear: anchor, month: ssMonth.get(m), day: Number(r.day) || 1 }
        : { type: 'fixed', month: ssMonth.get(m), day: Number(r.day) || 1 };
      else if (every === 1 && W && (Number(r.n) >= 1 || Number(r.n) === -1)) recurrence = { type: 'ordinal', month: ssMonth.get(m), occurrence: Number(r.n), weekday: Number(r.weekday) };
      else { other.add(h.name); continue; }
      let id = slug(h.name), n = 2;
      while (ids.has(id)) id = `${slug(h.name)}-${n++}`;
      ids.add(id);
      events.push({ id, name: h.name, ...(has(h.description) ? { description: String(h.description) } : {}), recurrence,
        ...(has(r.from_year) ? { startYear: Number(r.from_year) } : {}), ...(has(r.until_year) ? { endYear: Number(r.until_year) } : {}),
        duration: `${Math.max(1, Number(r.span) || 1)}d`, visibility: h.is_secret ? 'gm-only' : 'player-visible', ...(hex(h.color) ? { color: h.color } : {}) });
    }
    const list = set => [...set].join(', ');
    if (festival.size) lost.push(`Holidays on festival days (${list(festival)}) aren't events there; the festival days themselves are in the calendar by name.`);
    if (other.size) lost.push(`Holidays left out, as Seasons & Stars can't repeat them the way Chronicle does: ${list(other)}.`);
    if ((c.eras || []).length) lost.push('Eras are left out: Seasons & Stars numbers the years straight on.');

    const day = Math.floor(Number(camp.current_shift || 0) / E.slotsPerDay(c));
    const calendar = {
      id: `chronicle-${slug(name)}`,
      translations: { en: { label: name, description: `Exported from Campaign Chronicle (${camp.name}).` } },
      year: { epoch: y0, currentYear: E.fromAbs(c, day).year, prefix: '', suffix: '', startDay: E.mod(c.weekdayOffset, weekdays.length) },
      leapYear,
      months: regular.map(x => ({ name: x.m.name, days: Math.max(1, Number(x.m.days) || 0) })),
      weekdays, intercalary,
      time: { hoursInDay: Math.round(Number(c.hoursPerDay) || 24), minutesInHour: 60, secondsInMinute: 60 },
      moons, seasons, events,
    };
    return { calendar, today: ssDate(day), lost };
  }

  const fileName = camp => `${slug(camp.calendar?.name || camp.name)}-seasons-and-stars.json`;

  const api = { seasonsAndStars, fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VttCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
