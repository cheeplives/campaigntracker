/* calendar-file.js — a campaign's calendar as a JSON file, and back.
 *
 * The file holds the calendar (months, weekdays, leap rule, eras, moons, seasons,
 * shift names), the campaign's holidays and the date it had reached, so it can
 * be kept as a backup, shared, or used to start a new campaign on the same
 * calendar. Days, events, notes and regions are not in it.
 *
 * Plain script, no build step. Import also takes a bare calendar object, like
 * the "raw calendar JSON" box on the Settings tab. */
'use strict';

const CalendarFile = (() => {
  const E = window.Engine;
  const FORMAT = 'campaign-chronicle-calendar';
  const VERSION = 1;
  // set by the server or the time mode, not part of the calendar itself
  const DROP = ['shiftOrder', 'timeMode'];

  const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => JSON.parse(JSON.stringify(v));
  const strip = c => { const out = copy(c); DROP.forEach(k => delete out[k]); return out; };

  /** The file's object for campaign camp (with calendar and current_shift) and its holidays. */
  function build(camp, holidays) {
    const c = camp.calendar, d = Math.floor(Number(camp.current_shift || 0) / E.slotsPerDay(c));
    const t = E.fromAbs(E.prep(copy(c)), d);
    return {
      format: FORMAT, version: VERSION, exported: new Date().toISOString().slice(0, 10),
      calendar: strip(c),
      today: { year: t.year, month: t.month, day: t.day },
      holidays: (holidays || []).map(h => ({ name: h.name, rule: h.rule, description: h.description || '', color: h.color, is_secret: !!h.is_secret })),
    };
  }

  /** A file name like "greyhawk-calendar.json". */
  function fileName(camp) {
    const slug = `${camp.calendar.name || camp.name || 'campaign'}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    return `${slug || 'campaign'}-calendar.json`;
  }

  function download(camp, holidays) {
    const blob = new Blob([JSON.stringify(build(camp, holidays), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(camp);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** { calendar, holidays, today } from a file's text. Throws an Error that says what is wrong. */
  function parse(text) {
    let o;
    try { o = JSON.parse(text); } catch { throw new Error('That file is not JSON.'); }
    if (!plain(o)) throw new Error('That file does not hold a calendar.');
    if (o.format !== undefined && o.format !== FORMAT) throw new Error('That file is not a Campaign Chronicle calendar.');
    if (o.format === FORMAT && Number(o.version) > VERSION) throw new Error('That calendar was exported by a newer version. Update this site to import it.');
    const c = o.format === FORMAT ? o.calendar : o;
    if (!plain(c) || !Array.isArray(c.months) || !c.months.length) throw new Error('That file has no months, so it is not a calendar.');
    c.months.forEach((m, i) => {
      if (!plain(m) || typeof m.name !== 'string' || !m.name.trim()) throw new Error(`Month ${i + 1} has no name.`);
      if (!Number.isFinite(Number(m.days)) || Number(m.days) < 0) throw new Error(`${m.name} has no number of days.`);
    });
    if (c.weekdays !== undefined && (!Array.isArray(c.weekdays) || c.weekdays.some(w => typeof w !== 'string'))) throw new Error('The weekdays must be a list of names.');
    if (c.moons !== undefined && !Array.isArray(c.moons)) throw new Error('The moons must be a list.');
    if (c.seasons !== undefined && !Array.isArray(c.seasons)) throw new Error('The seasons must be a list.');
    const calendar = strip(c);
    // the same check Settings makes before saving: it must work out a date
    const test = E.prep(copy(calendar));
    E.fmtDate(test, 0);
    const holidays = (Array.isArray(o.holidays) ? o.holidays : []).filter(h => plain(h) && typeof h.name === 'string' && h.name.trim() && plain(h.rule))
      .map(h => ({ name: h.name.trim().slice(0, 150), rule: h.rule, description: typeof h.description === 'string' ? h.description : '', color: typeof h.color === 'string' ? h.color : '#b8860b', is_secret: !!h.is_secret }));
    let today = null;
    if (plain(o.today)) {
      const y = Math.round(Number(o.today.year)), m = Math.round(Number(o.today.month)), d = Math.round(Number(o.today.day));
      if ([y, m, d].every(Number.isFinite) && m >= 0 && m < calendar.months.length && d >= 1) today = { year: y, month: m, day: d };
    }
    return { calendar, holidays, today };
  }

  /** Asks for a .json file and resolves with parse()'s result, or null when none is picked. */
  function pick() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
      input.addEventListener('change', async () => {
        input.remove();
        const f = input.files[0];
        if (!f) return resolve(null);
        try { resolve(parse(await f.text())); } catch (e) { reject(e); }
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      document.body.append(input);
      input.click();
    });
  }

  return { FORMAT, VERSION, build, fileName, download, parse, pick };
})();
