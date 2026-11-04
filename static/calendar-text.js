/* calendar-text.js — a calendar as the Settings tab's text boxes show it, and back: weekdays on one line, a month, moon
 * or era per line with its fields after commas. textToCal throws an Error with a message for the person when a box
 * can't be read.
 *
 * Plain script, no build step, and no page needed: it needs only the engine, so the same file runs under Node in the
 * tests (tests/browser/calendar-text.spec.js). */
(function (root) {
  'use strict';
  const E = root.Engine || (typeof require !== 'undefined' ? require('./engine.js') : null);

  function calToText(c) {
    return {
      weekdays: (c.weekdays || []).join(', '),
      months: c.months.map(m => [m.name, m.days, m.leapDays || 0, m.intercalary ? (m.keepWeekday ? 'festival weekday' : 'festival') : ''].filter((x, i) => i < 3 || x).join(', ')).join('\n'),
      moons: (c.moons || []).map(m => [m.name, m.cycle, m.ref || 0, m.brightness ?? 1, m.color || '#e8e4d8', m.erratic ? 'erratic' : '', m.kind === 'red_moon' ? 'red moon' : ''].filter((x, i) => i < 5 || x).join(', ')).join('\n'),
      shiftNames: E.quarterNames({ ...c, timeMode: 'shifts4' }).join(', '),
      eras: (c.eras || []).map(e => [e.name, e.abbr || '', e.start || 0, e.restart ? 'restart' : e.before ? 'before' : ''].filter((x, i) => i < 3 || x).join(', ')).join('\n'),
    };
  }
  function textToCal(v, base, seasons) {
    const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(',').map(x => x.trim()));
    const c = { ...base };
    c.name = v.cal_name; c.epochYear = Number(v.epochYear) || 0; c.yearSuffix = v.yearSuffix;
    c.weekdayOffset = Number(v.weekdayOffset) || 0; c.dateFormat = v.dateFormat || undefined;
    c.hoursPerDay = Number(v.hoursPerDay) || 24; c.lighting = v.cal_lighting;
    c.weekdays = v.weekdays.split(',').map(x => x.trim()).filter(Boolean);
    c.months = lines(v.months).map(([name, days, leap, fest]) => {
      // a month may have no days outside leap years (like Overlithe)
      const m = { name, days: Math.max(Number(leap) > 0 ? 0 : 1, Number(days) || 0) };
      if (Number(leap)) m.leapDays = Number(leap);
      if (fest && /fest|inter/i.test(fest)) m.intercalary = true;
      if (m.intercalary && /week/i.test(fest)) m.keepWeekday = true;
      // week names have no field of their own here, so a month keeps the ones it had under the same name
      const was = (base.months || []).find(o => o.name === name);
      if (was && was.weeks) m.weeks = was.weeks;
      return m;
    });
    if (!c.months.length) throw new Error('Add at least one month');
    const every = Number(v.leap_every);
    c.leap = every > 0 ? { every, skip: Number(v.leap_skip) || 0, unskip: Number(v.leap_unskip) || 0 } : null;
    c.hemisphere = v.cal_hemisphere; c.seasons = seasons;
    // after the color, "erratic" wobbles the cycle and "red moon" makes it Glorantha's Red Moon (phases by weekday and region)
    c.moons = lines(v.moons).map(([name, cycle, ref, bright, color, ...flags]) => ({ name, cycle: Number(cycle) || 28, ref: Number(ref) || 0, brightness: bright === undefined ? 1 : Number(bright), color: color || '#e8e4d8',
      erratic: flags.some(f => /err/i.test(f)), ...(flags.some(f => /red\s*moon/i.test(f)) ? { kind: 'red_moon' } : {}) }));
    c.shiftNames = v.shiftNames.split(',').map(x => x.trim()).slice(0, 4);
    c.eras = lines(v.eras).map(([name, abbr, start, kind]) => {
      if (!Number.isFinite(Number(start)) || start === undefined || start === '') throw new Error(`Era "${name}" needs a first year`);
      const e = { name, abbr: abbr || '', start: Number(start) };
      if (/restart/i.test(kind || '')) e.restart = true;
      if (/before/i.test(kind || '')) e.before = true;
      return e;
    });
    if (c.eras.filter(e => e.before).length > 1) throw new Error('Only one era can count the years before');
    if (!c.eras.length) delete c.eras;
    return c;
  }

  const CalendarText = { calToText, textToCal };
  if (typeof module !== 'undefined' && module.exports) module.exports = CalendarText;
  else root.CalendarText = CalendarText;
})(typeof window !== 'undefined' ? window : globalThis);
