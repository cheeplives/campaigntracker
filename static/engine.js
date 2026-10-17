/*
 * Campaign Tracker engine: calendar math, moons, seasons, holidays, weather and visibility.
 * Pure functions with no DOM access, so the same file can be tested in Node.
 *
 * Time model: every in-game day has an integer "absolute day" (day 0 = first day of the
 * calendar's epoch year). How a day is split depends on the calendar's timeMode:
 *   shifts4 (the default): 4 shifts, 0 Dawn, 1 Midday, 2 Dusk, 3 Overnight, so a day runs from dawn to the night after it;
 *   shifts2: 2 shifts, 0 Day (dawn to dusk) and 1 Night (dusk to the next dawn);
 *   hours: one slot per hour from midnight, like a normal calendar (hoursPerDay of them).
 * The campaign "now" is stored as an absolute slot = absDay * slotsPerDay(cal) + slot. Weather, light and
 * visibility are still worked out for the four quarters of the day (Dawn, Midday, Dusk, Overnight), and
 * every slot takes its quarter's (slotQuarter).
 */
(function (root) {
  'use strict';

  const SHIFT_KEYS = ['dawn', 'midday', 'dusk', 'overnight'];
  const DEFAULT_SHIFT_NAMES = ['Dawn', 'Midday', 'Dusk', 'Overnight'];
  const VIS_LABELS = ['Pitch black', 'Very dark', 'Dim', 'Fair', 'Good', 'Bright'];
  const MOON_PHASES = [
    ['New', '🌑'], ['Waxing crescent', '🌒'], ['First quarter', '🌓'], ['Waxing gibbous', '🌔'],
    ['Full', '🌕'], ['Waning gibbous', '🌖'], ['Last quarter', '🌗'], ['Waning crescent', '🌘'],
  ];

  // Baseline things a party can spend a shift doing on a journey (one task per character
  // per shift: travel roles, camp and provisions). The GM picks them into a shift's activity text,
  // which stays free text, so who does what and anything else can be written alongside.
  const SHIFT_ACTION_GROUPS = { travel: 'On the move', land: 'Living off the land', camp: 'In camp', other: 'Other' };
  const SHIFT_ACTIONS = [
    { name: 'March', group: 'travel', icon: '🥾', desc: 'Travel on foot towards the destination. Two shifts of marching a day is comfortable; a third or fourth is a forced march.' },
    { name: 'Forced march', group: 'travel', icon: '😓', desc: 'Keep moving past the usual two shifts a day. Everyone tests their stamina, and anyone who fails has to stop and rest.' },
    { name: 'Ride / drive', group: 'travel', icon: '🐎', desc: 'Travel on a mount or in a vehicle. Passengers can keep watch, rest or sleep, but the rider or driver can do nothing else.' },
    { name: 'Sail / row', group: 'travel', icon: '⛵', desc: 'Travel by boat along a river, across a lake or at sea. Passengers can rest or sleep if they take no other task.' },
    { name: 'Navigate', group: 'travel', icon: '🧭', desc: 'Pick the route through unfamiliar or dangerous country. Done well, the party makes good time; done badly, it is slowed, strays off course or walks into trouble.' },
    { name: 'Scout ahead', group: 'travel', icon: '🔭', desc: 'Range ahead of the group to spot shortcuts, shelter, sites worth finding and signs of danger before the rest arrive.' },
    { name: 'Keep watch', group: 'travel', icon: '👁', desc: 'One lookout watches for threats, and can do so while marching. Without one, the party gets no warning of what is coming.' },
    { name: 'Forage', group: 'land', icon: '🌿', desc: 'Search the area for edible plants or drinkable water. Searching the same place again yields less each time.' },
    { name: 'Hunt / trap', group: 'land', icon: '🏹', desc: 'Track game and bring it down, or set snares. The meat still has to be cooked before it is safe to eat.' },
    { name: 'Fish', group: 'land', icon: '🎣', desc: 'Needs a river, lake or coast and some fishing gear. It can be done from a moving boat.' },
    { name: 'Gather', group: 'land', icon: '🪵', desc: 'Collect firewood, fuel or other raw materials from the surroundings.' },
    { name: 'Explore', group: 'land', icon: '🗺', desc: 'Stop the journey to search a site, ruin or landmark. It can take one shift or many, and it leaves no time for rest.' },
    { name: 'Make camp', group: 'camp', icon: '⛺', desc: 'Find a sheltered spot, light a fire and settle in, usually in the evening. A poor site invites a mishap during the night.' },
    { name: 'Cook', group: 'camp', icon: '🍲', desc: 'Turn caught or foraged food into safe meals over a fire or in a kitchen. Can happen in the same shift as making camp.' },
    { name: 'Manage provisions', group: 'camp', icon: '🎒', desc: 'Share out food and water and keep track of what is left. Careful handling stretches the supplies.' },
    { name: 'Stand guard', group: 'camp', icon: '🛡', desc: 'Stay awake to watch over the camp. The guard needs to sleep in some other shift.' },
    { name: 'Rest', group: 'camp', icon: '🔥', desc: 'Take it easy and recover from injury and strain. Being interrupted by a fight or similar drama spoils it.' },
    { name: 'Sleep', group: 'camp', icon: '💤', desc: 'Everyone needs at least one shift of sleep a day, usually overnight. Interrupted sleep does not count.' },
    { name: 'Repair', group: 'other', icon: '🔧', desc: 'Fix broken gear, a damaged vehicle or a wrecked camp. Serious damage takes a full shift of work.' },
    { name: 'Tend wounds', group: 'other', icon: '🩹', desc: 'Treat the injured, stop bleeding and nurse the sick.' },
    { name: 'Socialise / trade', group: 'other', icon: '🗣', desc: 'Spend time with locals or fellow travellers: bargain, buy supplies, gather rumours or carouse.' },
  ];
  /** Add an action's name to a shift's activity text, after anything already written there. */
  function addShiftAction(text, name) {
    const t = String(text || '').replace(/[\s;,]+$/, '');
    return t ? `${t}; ${name}` : name;
  }

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------------------------------------------------------------- calendar
  function prep(cal) {
    if (cal._prepped) return cal;
    const months = cal.months || [];
    cal.weekdays = cal.weekdays || [];
    cal.epochYear = Number(cal.epochYear || 0);
    cal.weekdayOffset = Number(cal.weekdayOffset || 0);
    cal._base = months.reduce((s, m) => s + Number(m.days || 0), 0);
    cal._extra = months.reduce((s, m) => s + Number(m.leapDays || 0), 0);
    cal._baseW = months.reduce((s, m) => s + (inWeek(m) ? Number(m.days || 0) : 0), 0);
    cal._extraW = months.reduce((s, m) => s + (inWeek(m) ? Number(m.leapDays || 0) : 0), 0);
    if (cal._base <= 0) throw new Error('Calendar needs at least one month with days');
    Object.defineProperty(cal, '_prepped', { value: true, enumerable: false });
    return cal;
  }
  /** Festival (intercalary) days sit outside the weekday cycle unless marked keepWeekday (like the Shire's Yule days). */
  function inWeek(m) { return !m.intercalary || !!m.keepWeekday; }
  /** The names of the day's four quarters, which weather and light are worked out for: the shift names in four-shift mode. */
  function quarterNames(cal) {
    let n = timeMode(cal) === 'shifts4' ? cal.shiftNames || [] : [];
    // campaigns made before the rename saved the old defaults (moved to dawn-first order by the server); they get the new ones
    if (n.join() === 'Dawn,Noon,Dusk,Overnight') n = [];
    return DEFAULT_SHIFT_NAMES.map((d, i) => n[i] || d);
  }
  /** The name of every slot of a day: the four shift names, Day and Night, or the hours (00:00, 01:00…). */
  function shiftNames(cal) {
    const m = timeMode(cal);
    if (m === 'shifts2') return ['Day', 'Night'];
    if (m === 'hours') return Array.from({ length: slotsPerDay(cal) }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    return quarterNames(cal);
  }

  // ---------------------------------------------------------------- time modes
  const TIME_MODES = { shifts4: 'Four shifts (Dawn, Midday, Dusk, Overnight)', shifts2: 'Two shifts (Day and Night)', hours: 'Hours, like a normal calendar' };
  function timeMode(cal) { return TIME_MODES[cal && cal.timeMode] ? cal.timeMode : 'shifts4'; }
  /** How many slots (shifts or hours) a day has. Hours mode has one per hour of the calendar's day, up to 240. */
  function slotsPerDay(cal) {
    const m = timeMode(cal);
    if (m === 'shifts2') return 2;
    if (m === 'hours') return clamp(Math.round(Number(cal.hoursPerDay) || 24), 1, 240);
    return 4;
  }
  /** How many of the calendar's hours one slot lasts. */
  function slotHours(cal) { return (Number(cal.hoursPerDay) || 24) / slotsPerDay(cal); }
  /** "shift" or "hour": what a slot is called in this calendar. */
  function slotWord(cal) { return timeMode(cal) === 'hours' ? 'hour' : 'shift'; }
  /** The quarter of the day (0 Dawn, 1 Midday, 2 Dusk, 3 Overnight) whose weather and light a slot takes.
   * Day takes Midday's and Night Overnight's; an hour takes the quarter it falls in, hours before dawn the overnight one. */
  function slotQuarter(cal, slot) {
    const m = timeMode(cal);
    if (m === 'shifts2') return slot ? 3 : 1;
    if (m === 'hours') return (Math.floor(4 * slot / slotsPerDay(cal)) + 3) % 4;
    return slot;
  }
  /** A day's weather by quarter (from shiftWeather, or the server's partial copy) as weather by slot. */
  function slotsFromQuarters(cal, quarters) {
    return Array.from({ length: slotsPerDay(cal) }, (_, i) => (quarters && quarters[slotQuarter(cal, i)]) || null);
  }

  function hasLeap(cal) { return !!(cal.leap && cal.leap.every > 0 && cal._extra > 0); }
  function isLeap(cal, y) {
    if (!hasLeap(cal)) return false;
    const L = cal.leap;
    if (mod(y, L.every) !== 0) return false;
    if (L.skip && mod(y, L.skip) === 0) return !!(L.unskip && mod(y, L.unskip) === 0);
    return true;
  }
  // number of leap years in [1..n] style count, valid for any integer n (proleptic)
  function leapCount(cal, n) {
    const L = cal.leap;
    let c = Math.floor(n / L.every);
    if (L.skip) c -= Math.floor(n / L.skip);
    if (L.skip && L.unskip) c += Math.floor(n / L.unskip);
    return c;
  }
  function leapsBefore(cal, y) { // leap years in [epochYear, y)
    if (!hasLeap(cal)) return 0;
    return leapCount(cal, y - 1) - leapCount(cal, cal.epochYear - 1);
  }
  function yearStart(cal, y) {
    prep(cal);
    return (y - cal.epochYear) * cal._base + leapsBefore(cal, y) * cal._extra;
  }
  function yearLength(cal, y) { prep(cal); return cal._base + (isLeap(cal, y) ? cal._extra : 0); }
  function monthLength(cal, y, m) {
    const mo = cal.months[m];
    return Number(mo.days) + (isLeap(cal, y) ? Number(mo.leapDays || 0) : 0);
  }

  /** absolute day -> {year, month (index), day (1-based), doy, intercalary} */
  function fromAbs(cal, d) {
    prep(cal);
    const avg = cal._base + (hasLeap(cal) ? cal._extra / cal.leap.every : 0);
    let y = cal.epochYear + Math.floor(d / avg);
    while (yearStart(cal, y) > d) y--;
    while (yearStart(cal, y + 1) <= d) y++;
    let doy = d - yearStart(cal, y);
    const out = { year: y, doy };
    for (let m = 0; m < cal.months.length; m++) {
      const len = monthLength(cal, y, m);
      if (doy < len) {
        out.month = m; out.day = doy + 1; out.intercalary = !!cal.months[m].intercalary;
        return out;
      }
      doy -= len;
    }
    out.month = cal.months.length - 1; out.day = 1; out.intercalary = false;
    return out;
  }
  function toAbs(cal, y, m, day) {
    prep(cal);
    let d = yearStart(cal, y);
    for (let i = 0; i < m; i++) d += monthLength(cal, y, i);
    return d + (day - 1);
  }
  /** weekday index or null (intercalary days and calendars without weeks have none) */
  function weekday(cal, d) {
    prep(cal);
    if (!cal.weekdays.length) return null;
    const p = fromAbs(cal, d);
    if (!inWeek(cal.months[p.month])) return null;
    let count = (p.year - cal.epochYear) * cal._baseW + leapsBefore(cal, p.year) * cal._extraW;
    for (let m = 0; m < p.month; m++) if (inWeek(cal.months[m])) count += monthLength(cal, p.year, m);
    count += p.day - 1;
    return mod(cal.weekdayOffset + count, cal.weekdays.length);
  }
  function weekLength(cal) { return cal.weekdays && cal.weekdays.length ? cal.weekdays.length : 7; }

  function yearLabel(cal, y) {
    return cal.yearSuffix ? `${y} ${cal.yearSuffix}` : String(y);
  }
  function fmtDate(cal, d, opts = {}) {
    const p = fromAbs(cal, d);
    const mo = cal.months[p.month];
    const wd = weekday(cal, d);
    const W = (wd !== null && !opts.noWeekday) ? cal.weekdays[wd] : '';
    if (p.intercalary && monthLength(cal, p.year, p.month) === 1) return `${W ? `${W}, ` : ''}${mo.name}, ${yearLabel(cal, p.year)}`;
    const fmt = cal.dateFormat || '{W}, {d} {M} {Y}';
    let out = fmt.replace('{d}', p.day).replace('{M}', mo.name).replace('{Y}', yearLabel(cal, p.year)).replace('{W}', W);
    return out.replace(/^[\s,·—-]+/, '').trim();
  }
  function fmtShift(cal, absShift) {
    const n = slotsPerDay(cal), d = Math.floor(absShift / n), s = mod(absShift, n);
    return `${shiftNames(cal)[s]} · ${fmtDate(cal, d)}`;
  }

  /** Move n months forward/back keeping the day number (clamped). Intercalary months are skipped. */
  function addMonths(cal, d, n) {
    const p = fromAbs(cal, d);
    let y = p.year, m = p.month;
    const step = n >= 0 ? 1 : -1;
    let left = Math.abs(n);
    while (left > 0) {
      m += step;
      if (m >= cal.months.length) { m = 0; y++; }
      if (m < 0) { m = cal.months.length - 1; y--; }
      if (!cal.months[m].intercalary || cal.months.every(x => x.intercalary)) left--;
    }
    return toAbs(cal, y, m, Math.min(p.day, monthLength(cal, y, m)));
  }

  // ---------------------------------------------------------------- seasons
  const SEASON_TYPES = ['spring', 'summer', 'autumn', 'winter', 'none'];
  const SEASON_FLIP = { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' };

  /** Season start days of a year, sorted by day-of-year. */
  function seasonStarts(cal, year) {
    return (cal.seasons || []).map(s => {
      const m = clamp(Number(s.month) || 0, 0, cal.months.length - 1);
      const day = clamp(Number(s.day) || 1, 1, monthLength(cal, year, m));
      return { s, month: m, day, doy: toAbs(cal, year, m, day) - yearStart(cal, year) };
    }).sort((a, b) => a.doy - b.doy);
  }

  /**
   * Season on absolute day d. Season dates are written for the calendar's own hemisphere
   * (cal.hemisphere, default north); a region in the other hemisphere gets the opposite season.
   */
  function season(cal, d, hemisphere) {
    if (!(cal.seasons || []).length) return { name: '', type: 'none' };
    const p = fromAbs(cal, d);
    const starts = seasonStarts(cal, p.year);
    let cur = starts[starts.length - 1].s; // wraps from previous year
    for (const x of starts) if (x.doy <= p.doy) cur = x.s;
    let name = cur.name, type = cur.type || 'none';
    if (hemisphere && hemisphere !== (cal.hemisphere || 'north') && SEASON_FLIP[type]) {
      type = SEASON_FLIP[type];
      const twin = cal.seasons.find(s => s.type === type);
      if (twin) name = twin.name;
    }
    return { name, type };
  }

  /**
   * Which seasons each month of a year falls in: [{ month, seasons: [{ name, type, from, to }] }],
   * where from/to are day numbers within the month.
   */
  function monthSeasons(cal, year = cal.epochYear) {
    return cal.months.map((mo, m) => {
      const len = monthLength(cal, year, m), out = [];
      for (let day = 1; day <= len; day++) {
        const s = season(cal, toAbs(cal, year, m, day));
        const last = out[out.length - 1];
        if (last && last.name === s.name && last.type === s.type) last.to = day;
        else out.push({ name: s.name, type: s.type, from: day, to: day });
      }
      return { month: m, seasons: out };
    });
  }

  // ---------------------------------------------------------------- moons
  function moonPhase(moon, d) {
    const cycle = Number(moon.cycle) || 28;
    const t = d + 0.5 - Number(moon.ref || 0);
    let ph = t / cycle;
    if (moon.erratic) ph += 0.18 * Math.sin(d / 7.3) + 0.11 * Math.sin(d / 3.1 + 1.7);
    ph = mod(ph, 1);
    const illum = (1 - Math.cos(2 * Math.PI * ph)) / 2;
    const idx = mod(Math.round(ph * 8), 8);
    return { name: moon.name, phase: ph, illum, label: MOON_PHASES[idx][0], icon: MOON_PHASES[idx][1], color: moon.color };
  }
  function moons(cal, d) { return (cal.moons || []).map(m => moonPhase(m, d)); }

  // ---------------------------------------------------------------- holidays
  function nthWeekdayStart(cal, y, m, wd, n) {
    const len = monthLength(cal, y, m), hits = [];
    for (let day = 1; day <= len; day++) {
      const a = toAbs(cal, y, m, day);
      if (weekday(cal, a) === Number(wd)) hits.push(a);
    }
    if (!hits.length) return null;
    return Number(n) < 0 ? hits[hits.length - 1] : (hits[Number(n) - 1] ?? null);
  }
  function holidayStartsForYear(cal, rule, y) {
    const m = Number(rule.month);
    if (!(m >= 0 && m < cal.months.length)) return null;
    if (rule.type === 'fixed') {
      const day = Number(rule.day) || 1;
      if (day > monthLength(cal, y, m)) return null;
      return toAbs(cal, y, m, day);
    }
    if (rule.type === 'nth_weekday') return nthWeekdayStart(cal, y, m, rule.weekday, rule.n);
    return null;
  }
  function holidayActive(cal, h, d) {
    const r = h.rule || {};
    const span = Math.max(1, Number(r.span) || 1);
    if (r.type === 'once') { const s = Number(r.abs_day); return d >= s && d < s + span; }
    if (r.type === 'every_n') {
      const s = Number(r.start), iv = Math.max(1, Number(r.interval) || 1);
      return d >= s && mod(d - s, iv) < span;
    }
    const y = fromAbs(cal, d).year;
    for (const yy of [y, y - 1]) {
      const s = holidayStartsForYear(cal, r, yy);
      if (s !== null && d >= s && d < s + span) return true;
    }
    return false;
  }
  function holidaysOn(cal, holidays, d) { return (holidays || []).filter(h => holidayActive(cal, h, d)); }

  // ---------------------------------------------------------------- weather
  // day / night: visibility modifier during daylight shifts and the overnight shift.
  // moon: fraction of moonlight that gets through. precip: can turn to snow/rain with temperature.
  const WEATHER = {
    clear:     { label: 'Clear', icon: '☀️', day: 0, night: 0, moon: 1 },
    partly:    { label: 'Partly cloudy', icon: '⛅', day: 0, night: 0, moon: 0.7 },
    overcast:  { label: 'Overcast', icon: '☁️', day: -1, night: 0, moon: 0.15 },
    drizzle:   { label: 'Light rain', icon: '🌦️', day: -1, night: 0, moon: 0.2, precip: 'rain', snowAs: 'snow' },
    rain:      { label: 'Heavy rain', icon: '🌧️', day: -2, night: -1, moon: 0.05, precip: 'rain', snowAs: 'heavysnow' },
    storm:     { label: 'Thunderstorm', icon: '⛈️', day: -2, night: -1, moon: 0, precip: 'rain', snowAs: 'blizzard', wind: 2 },
    fog:       { label: 'Fog', icon: '🌫️', day: -3, night: -1, moon: 0.1 },
    snow:      { label: 'Light snow', icon: '🌨️', day: -1, night: 0, moon: 0.3, precip: 'snow', rainAs: 'drizzle' },
    heavysnow: { label: 'Heavy snow', icon: '❄️', day: -2, night: -1, moon: 0.05, precip: 'snow', rainAs: 'rain' },
    blizzard:  { label: 'Blizzard', icon: '🌬️', day: -4, night: -1, moon: 0, precip: 'snow', rainAs: 'storm', wind: 3 },
    hail:      { label: 'Hail', icon: '🧊', day: -2, night: -1, moon: 0, wind: 1 },
    haze:      { label: 'Heat haze', icon: '🥵', day: -1, night: 0, moon: 0.8 },
    sandstorm: { label: 'Sandstorm', icon: '🌪️', day: -4, night: -1, moon: 0, wind: 3 },
    // underground
    still:     { label: 'Still air', icon: '🕯️', day: 0, night: 0, moon: 0 },
    damp:      { label: 'Damp, dripping', icon: '💧', day: 0, night: 0, moon: 0 },
    drafty:    { label: 'Drafts', icon: '🍃', day: 0, night: 0, moon: 0 },
    dust:      { label: 'Dust or smoke', icon: '🌁', day: -2, night: -1, moon: 0 },
    // shipboard / space
    nominal:   { label: 'Systems nominal', icon: '🛰️', day: 0, night: 0, moon: 1 },
    flicker:   { label: 'Power fluctuations', icon: '⚡', day: -2, night: -1, moon: 1 },
    redalert:  { label: 'Emergency lighting', icon: '🚨', day: -3, night: -1, moon: 1 },
    blackout:  { label: 'Blackout', icon: '⬛', day: -5, night: -5, moon: 1 },
    nebula:    { label: 'Nebula transit', icon: '🌌', day: -1, night: -1, moon: 0.3 },
    ionstorm:  { label: 'Ion storm', icon: '🌀', day: -1, night: -1, moon: 0.5 },
    radiation: { label: 'Radiation alert', icon: '☢️', day: 0, night: 0, moon: 1 },
    flare:     { label: 'Solar flare', icon: '🔆', day: 1, night: 1, moon: 1 },
    debris:    { label: 'Debris field', icon: '☄️', day: -1, night: -1, moon: 0.6 },
  };
  const WIND = ['Calm', 'Breezy', 'Windy', 'Gale'];

  // Temperatures in °C: [typical low, typical high] for the day's high. The simple climates take their
  // temperatures from one station each (1991–2020 normals in tools/climate-normals.json, worked out the same way
  // as the Köppen baselines below): temperate = Warsaw, arctic = Utqiaġvik, desert = Cairo, tropical = Darwin,
  // mountains = Davos, coastal = Bergen, swamp = Pinsk in the Pripyat Marshes. Underground follows cave air, which
  // holds near the surface's yearly mean (a constant 12 °C in Mammoth Cave, per the US National Park Service);
  // the starship sits at room temperature (20–22 °C); open space spans the Moon's equator, 95–390 K (NASA Moon
  // Fact Sheet). The weather weights (w) are the app's own game tuning, not measurements.
  const CLIMATES = {
    temperate: { label: 'Temperate', persistence: 0.45, seasons: {
      spring: { t: [7, 20], w: { clear: 3, partly: 3, overcast: 2, drizzle: 2, rain: 1, storm: 0.5, fog: 1 } },
      summer: { t: [22, 26], w: { clear: 5, partly: 3, overcast: 1, drizzle: 1, rain: 0.5, storm: 1, fog: 0.3, haze: 0.4 } },
      autumn: { t: [7, 19], w: { clear: 2, partly: 3, overcast: 3, drizzle: 2, rain: 1.5, storm: 0.3, fog: 2 } },
      winter: { t: [0, 4], w: { clear: 2, partly: 2, overcast: 3, drizzle: 1, rain: 1, fog: 1.5, snow: 2, heavysnow: 1, blizzard: 0.3 } },
      any:    { t: [9, 17], w: { clear: 3, partly: 3, overcast: 2, drizzle: 2, rain: 1, storm: 0.5, fog: 1 } } } },
    arctic: { label: 'Arctic / tundra', persistence: 0.55, seasons: {
      spring: { t: [-20, -3], w: { clear: 3, partly: 2, overcast: 3, snow: 3, heavysnow: 1, blizzard: 1, fog: 1 } },
      summer: { t: [5, 9], w: { clear: 3, partly: 3, overcast: 3, drizzle: 2, rain: 1, fog: 2 } },
      autumn: { t: [-11, 3], w: { clear: 2, partly: 2, overcast: 3, snow: 3, heavysnow: 1.5, blizzard: 0.7, fog: 1 } },
      winter: { t: [-21, -17], w: { clear: 3, partly: 2, overcast: 2, snow: 2, heavysnow: 1, blizzard: 2 } },
      any:    { t: [-12, -2], w: { clear: 3, partly: 2, overcast: 3, snow: 3, heavysnow: 1, blizzard: 1 } } } },
    desert: { label: 'Desert', persistence: 0.6, seasons: {
      spring: { t: [24, 32], w: { clear: 6, partly: 2, haze: 2, sandstorm: 0.8, overcast: 0.3, drizzle: 0.1 } },
      summer: { t: [33, 37], w: { clear: 7, haze: 3, sandstorm: 1, partly: 1 } },
      autumn: { t: [25, 33], w: { clear: 6, partly: 2, haze: 1.5, sandstorm: 0.8 } },
      winter: { t: [18, 22], w: { clear: 6, partly: 2, overcast: 1, drizzle: 0.3, sandstorm: 0.5 } },
      any:    { t: [25, 31], w: { clear: 6, partly: 2, haze: 2, sandstorm: 0.8 } } } },
    tropical: { label: 'Tropical / jungle', persistence: 0.4, seasons: {
      spring: { t: [31, 35], w: { clear: 3, partly: 3, rain: 2, storm: 1.5, drizzle: 1 } },
      summer: { t: [30, 34], w: { partly: 2, rain: 3, storm: 3, overcast: 2, clear: 1 } },
      autumn: { t: [31, 35], w: { partly: 3, rain: 2, storm: 2, clear: 2 } },
      winter: { t: [30, 34], w: { clear: 4, partly: 3, drizzle: 1, rain: 0.5, fog: 0.5 } },
      any:    { t: [31, 35], w: { clear: 3, partly: 3, rain: 2, storm: 1.5, drizzle: 1 } } } },
    mountain: { label: 'Mountains / highlands', persistence: 0.4, seasons: {
      spring: { t: [5, 13], w: { clear: 3, partly: 2, overcast: 2, snow: 2, drizzle: 1, fog: 2, storm: 0.5 } },
      summer: { t: [16, 20], w: { clear: 4, partly: 3, storm: 1.5, rain: 1, fog: 1.5, hail: 0.3 } },
      autumn: { t: [5, 14], w: { clear: 3, partly: 2, overcast: 2, fog: 2, snow: 2, drizzle: 1 } },
      winter: { t: [-1, 3], w: { clear: 2, partly: 2, overcast: 2, snow: 3, heavysnow: 2, blizzard: 1.5, fog: 1 } },
      any:    { t: [6, 13], w: { clear: 3, partly: 2, overcast: 2, snow: 1, drizzle: 1, fog: 2 } } } },
    maritime: { label: 'Coastal / maritime', persistence: 0.45, seasons: {
      spring: { t: [7, 15], w: { partly: 3, overcast: 3, drizzle: 3, rain: 1.5, fog: 2.5, clear: 2, storm: 0.5 } },
      summer: { t: [17, 21], w: { clear: 3, partly: 3, fog: 2, drizzle: 1, overcast: 2, storm: 0.5 } },
      autumn: { t: [8, 16], w: { overcast: 3, rain: 2.5, storm: 1.5, drizzle: 2, fog: 2, partly: 2 } },
      winter: { t: [3, 7], w: { overcast: 3, rain: 3, storm: 2, drizzle: 2, snow: 0.5, fog: 1.5 } },
      any:    { t: [9, 15], w: { partly: 3, overcast: 3, drizzle: 2, rain: 1.5, fog: 2, clear: 2, storm: 0.7 } } } },
    swamp: { label: 'Swamp / marsh', persistence: 0.5, seasons: {
      spring: { t: [6, 20], w: { fog: 4, overcast: 3, drizzle: 3, rain: 1, partly: 2, clear: 1 } },
      summer: { t: [22, 26], w: { fog: 2, haze: 2, partly: 3, storm: 1.5, rain: 1, clear: 2 } },
      autumn: { t: [5, 19], w: { fog: 5, overcast: 3, drizzle: 3, rain: 1, partly: 1 } },
      winter: { t: [-2, 2], w: { fog: 4, overcast: 3, drizzle: 2, snow: 1, rain: 1 } },
      any:    { t: [8, 17], w: { fog: 4, overcast: 3, drizzle: 3, rain: 1, partly: 2 } } } },
    underground: { label: 'Underground', persistence: 0.7, seasons: {
      any: { t: [10, 14], w: { still: 6, damp: 3, drafty: 2, dust: 0.4 } } } },
    ship: { label: 'Starship interior', persistence: 0.7, seasons: {
      any: { t: [20, 22], w: { nominal: 20, flicker: 2, nebula: 1, ionstorm: 0.8, redalert: 0.4, radiation: 0.4, blackout: 0.15 } } } },
    vacuum: { label: 'Open space / airless body', persistence: 0.6, seasons: {
      any: { t: [-178, 117], w: { nominal: 12, flare: 1, debris: 1, ionstorm: 0.5, radiation: 0.8 } } } },
  };

  // ---------------------------------------------------------------- Köppen climates
  // Baselines per Köppen–Geiger code, one entry per season (winter, spring, summer, autumn):
  // [low, high] = range of typical daytime highs in °C; wet 0–5 (0 arid … 5 torrential);
  // storm / fog / dust 0–3 (how often thunderstorms or blizzards, fog, and dust storms turn up).
  // Highs and wetness come from one representative station per class (`station`: place, Wikipedia article, normals period, weather service, and a note where it only borders the class),
  // from the 1991–2020 monthly normals in tools/climate-normals.json; `node tools/climate-baselines.js` shows the
  // rules and checks each station's class. Storm, fog and dust are the app's own game tuning, not measurements.
  // Tropical wet and dry seasons follow the sun: the wet season is "summer", the dry season "winter".
  const KOPPEN_GROUPS = {
    A: 'Tropical', B: 'Arid', C: 'Temperate', D: 'Continental', E: 'Polar',
  };
  // Allowed second and third letters per group, with what each letter means.
  const KOPPEN_LETTERS = {
    A: [{ f: 'rainforest (wet all year)', m: 'monsoon (short dry season)', w: 'savanna (dry winter)', s: 'savanna (dry summer)' }, null],
    B: [{ W: 'desert', S: 'steppe (semi-arid)' }, { h: 'hot', k: 'cold' }],
    C: [{ f: 'no dry season', s: 'dry summer', w: 'dry winter' }, { a: 'hot summer', b: 'warm summer', c: 'cool summer' }],
    D: [{ f: 'no dry season', s: 'dry summer', w: 'dry winter' }, { a: 'hot summer', b: 'warm summer', c: 'subarctic', d: 'extremely cold winter' }],
    E: [{ T: 'tundra', F: 'ice cap' }, null],
  };
  const sb = (lo, hi, wet, storm = 0, fog = 0, dust = 0) => ({ t: [lo, hi], wet, storm, fog, dust });
  const KOPPEN = {
    Af:  { label: 'Tropical rainforest', where: 'Singapore, Amazon basin, Congo basin', station: ['Singapore', 'Climate_of_Singapore', '1991–2020', 'Meteorological Service Singapore (NEA)'], s: [sb(29, 33, 4.5, 2.5, 1), sb(30, 34, 4, 2.5, 1), sb(30, 34, 3.8, 3, 1), sb(30, 34, 4.2, 2.5, 1)] },
    Am:  { label: 'Tropical monsoon', where: 'Miami, Kerala, Myanmar coast', station: ['Miami International Airport, Florida, US', 'Miami', '1991–2020', 'NOAA'], s: [sb(23, 27, 2.4, 0.5), sb(27, 31, 3.3, 1.5), sb(30, 34, 4.6, 3), sb(27, 32, 4.2, 2)] },
    Aw:  { label: 'Tropical savanna (dry winter)', where: 'Darwin, Lagos, Bangkok, Rio de Janeiro', station: ['Darwin Airport, Northern Territory, Australia', 'Darwin,_Northern_Territory', '1991–2020', 'Bureau of Meteorology'], s: [sb(30, 34, 0.1, 0, 0.5, 0.5), sb(31, 35, 2.8, 1.5, 0, 0.5), sb(30, 34, 5, 3), sb(31, 35, 3.8, 2)] },
    As:  { label: 'Tropical savanna (dry summer)', where: 'Chennai, Mombasa, Hawaii leeward coasts', station: ['Chennai (Nungambakkam), India', 'Chennai', '1991–2020', 'India Meteorological Department', 'Wikipedia: As, closely bordering Aw (by the rules here it comes out Aw)'], s: [sb(28, 32, 2.7, 1.5), sb(33, 37, 1.4, 1), sb(34, 38, 3.4, 0.5, 0, 0.5), sb(30, 34, 4.8, 1.5)] },
    BWh: { label: 'Hot desert', where: 'Cairo, Dubai, Phoenix, the Sahara', station: ['Cairo International Airport, Egypt', 'Cairo', '1991–2020', 'Egyptian Meteorological Authority / NOAA'], s: [sb(18, 22, 0.3, 0, 0.5, 1), sb(24, 32, 0.2, 0.2, 0, 1.5), sb(33, 37, 0, 0.3, 0, 2), sb(25, 33, 0.1, 0.2, 0, 1)] },
    BWk: { label: 'Cold desert', where: 'Leh (Ladakh), Gobi, Great Basin, Patagonia', station: ['Leh, Ladakh, India', 'Leh', '1951–2020', 'India Meteorological Department'], s: [sb(1, 5, 0.6, 0, 0.5, 0.5), sb(10, 20, 0.7, 0.3, 0, 1.5), sb(24, 29, 0.8, 0.5, 0, 1), sb(11, 23, 0.5, 0.2, 0, 1)] },
    BSh: { label: 'Hot semi-arid steppe', where: 'Niamey, the Sahel, Monterrey', station: ['Niamey Airport, Niger', 'Niamey', '1991–2020', 'NOAA NCEI / WMO'], s: [sb(32, 36, 0, 0, 0.3, 1), sb(39, 43, 0.8, 0.5, 0, 1.5), sb(33, 38, 3.7, 1.5, 0, 1), sb(34, 38, 1.8, 0.7, 0, 0.5)] },
    BSk: { label: 'Cold semi-arid steppe', where: 'Denver, Kazakh steppe, Ulaanbaatar plains', station: ['Denver International Airport, Colorado, US', 'Denver', '1991–2020', 'NOAA'], s: [sb(5, 9, 0.7, 0, 0.5, 0.3), sb(13, 22, 2, 1, 0, 0.7), sb(28, 32, 2.2, 1.5, 0, 0.5), sb(12, 26, 1.5, 0.3, 0.3, 0.3)] },
    Csa: { label: 'Hot-summer Mediterranean', where: 'Rome, Seville, Athens, Los Angeles inland', station: ['Rome Ciampino Airport, Italy', 'Rome', '1991–2020', 'NOAA'], s: [sb(11, 15, 2.8, 0.5, 1), sb(16, 22, 2.5, 0.5, 0.3), sb(28, 32, 1.5, 0.3), sb(17, 27, 3, 0.7, 0.3)] },
    Csb: { label: 'Warm-summer Mediterranean', where: 'Porto, San Francisco, Cape Town', station: ['Porto Airport, Portugal', 'Porto', '1991–2020', 'IPMA'], s: [sb(13, 17, 3.7, 0.3, 1.5), sb(17, 21, 3.1, 0.2, 1.5), sb(22, 26, 1.5, 0, 2.5), sb(17, 24, 3.6, 0.2, 2)] },
    Csc: { label: 'Cold-summer Mediterranean', where: 'Akureyri (by the −3 °C rule), highlands of the Cascades and Andes', station: ['Akureyri, Iceland', 'Akureyri', '1991–2020', 'Icelandic Met Office / NOAA', 'Csc when the C/D line is drawn at −3 °C (Dsc at 0 °C); no station with published open normals is Csc at 0 °C'], s: [sb(1, 5, 2.5, 0.5, 1.5), sb(4, 10, 1.7, 0.3, 1.5), sb(12, 16, 1.7, 0.2, 1), sb(4, 12, 2.6, 0.3, 1.5)] },
    Cwa: { label: 'Monsoon-influenced humid subtropical', where: 'Hong Kong, Delhi, Guangzhou', station: ['Hong Kong Observatory', 'Climate_of_Hong_Kong', '1991–2020', 'Hong Kong Observatory'], s: [sb(18, 22, 1.8, 0, 1, 0.3), sb(22, 29, 4.1, 1.5, 0.5), sb(29, 33, 5, 3), sb(25, 31, 4, 1.5)] },
    Cwb: { label: 'Subtropical highland', where: 'Mexico City, Johannesburg, Bogotá-style highlands', station: ['Mexico City (Tacubaya), Mexico', 'Mexico_City', '1991–2020', 'Servicio Meteorológico Nacional'], s: [sb(21, 25, 0.6, 0, 0.5, 0.3), sb(25, 29, 1.7, 1.5), sb(23, 27, 4, 2.5, 0.5), sb(21, 25, 2.9, 1, 0.5)] },
    Cwc: { label: 'Cold subtropical highland', where: 'El Alto, high Andean and Himalayan valleys', station: ['El Alto International Airport, Bolivia', 'El_Alto', 'not stated', 'SENAMHI Bolivia / Deutscher Wetterdienst', 'Wikipedia classes El Alto as Cwc; its warmest month sits just under the 10 °C line, so it borders on ET'], s: [sb(12, 16, 0.7, 0, 1), sb(14, 18, 2, 1), sb(13, 17, 3.4, 2, 1.5), sb(12, 16, 2, 0.5, 1)] },
    Cfa: { label: 'Humid subtropical', where: 'Atlanta, Shanghai, Buenos Aires, Sydney', station: ['Atlanta (Hartsfield–Jackson Airport), Georgia, US', 'Atlanta', '1991–2020', 'NOAA'], s: [sb(11, 15, 3.5, 0.3, 1), sb(19, 27, 3.3, 1.5, 0.5), sb(29, 33, 3.4, 2.5, 0.3), sb(18, 29, 3.1, 1, 1)] },
    Cfb: { label: 'Temperate oceanic', where: 'London, Paris, Melbourne, Seattle', station: ['London Heathrow, UK', 'London', '1991–2020', 'Met Office'], s: [sb(7, 11, 2.4, 0.2, 2), sb(12, 18, 2.1, 0.5, 1), sb(21, 25, 2.2, 1, 0.5), sb(12, 20, 2.5, 0.5, 2)] },
    Cfc: { label: 'Subpolar oceanic', where: 'Tórshavn (Faroe Islands), Reykjavík coast, Tierra del Fuego', station: ['Tórshavn, Faroe Islands', 'Tórshavn', '1991–2020', 'Danish Meteorological Institute'], s: [sb(4, 8, 3.9, 0.8, 1.5), sb(6, 10, 3.2, 0.3, 1.5), sb(10, 14, 2.8, 0.2, 2), sb(8, 12, 3.8, 0.8, 1.5)] },
    Dsa: { label: 'Hot-summer continental (dry summer)', where: 'Hakkâri, eastern Anatolia, Utah valleys', station: ['Hakkâri, Turkey', 'Hakkâri_(city)', '1991–2020', 'Turkish State Meteorological Service'], s: [sb(-1, 3, 3.2, 0.5, 1), sb(7, 20, 3.3, 1), sb(26, 32, 0.7, 0.5, 0, 0.5), sb(10, 27, 2.2, 0.3, 0.5)] },
    Dsb: { label: 'Warm-summer continental (dry summer)', where: 'Sivas, central Anatolia, Iranian plateau towns', station: ['Sivas, Turkey', 'Sivas', '1991–2020', 'Turkish State Meteorological Service'], s: [sb(1, 5, 2.1, 0.5, 1), sb(10, 21, 2.4, 0.7), sb(25, 30, 1.1, 0.5), sb(11, 26, 1.8, 0.3, 0.5)] },
    Dsc: { label: 'Subarctic (dry summer)', where: 'Akureyri, High Sierra and Anatolian uplands', station: ['Akureyri, Iceland', 'Akureyri', '1991–2020', 'Icelandic Met Office / NOAA'], s: [sb(1, 5, 2.5, 0.8, 0.5), sb(4, 10, 1.7, 0.5), sb(12, 16, 1.7, 0.5), sb(4, 12, 2.6, 0.3, 0.5)] },
    Dsd: { label: 'Extremely cold subarctic (dry summer)', where: 'Rare: Verkhoyansk and high eastern Siberia', station: ['Verkhoyansk, Russia', 'Verkhoyansk', '1991–2020', 'Roshydromet via NOAA', 'Wikipedia: usually called Dfd, but technically qualifies as Dsd'], s: [sb(-42, -37, 0.4, 1, 0.5), sb(-19, 10, 0.6, 0.3), sb(19, 23, 1.7, 0.3), sb(-30, 9, 1, 0.5)] },
    Dwa: { label: 'Monsoon-influenced hot-summer continental', where: 'Seoul, Beijing', station: ['Seoul, South Korea', 'Seoul', '1991–2020', 'Korea Meteorological Administration'], s: [sb(2, 6, 1.4, 0, 0.5, 1), sb(11, 24, 2.7, 0.5, 0, 1.5), sb(27, 31, 5, 2.5, 0.5), sb(12, 26, 2.9, 0.3, 1)] },
    Dwb: { label: 'Monsoon-influenced warm-summer continental', where: 'Vladivostok, northern Korea', station: ['Vladivostok, Russia', 'Vladivostok', '1991–2020', 'Roshydromet via NOAA'], s: [sb(-8, -4, 1, 0, 0.3), sb(3, 15, 2.4, 0.3, 1.5), sb(18, 23, 3.8, 2, 1.5), sb(3, 20, 2.7, 0.3, 0.5)] },
    Dwc: { label: 'Monsoon-influenced subarctic', where: 'Mohe, northern Mongolia, Tibetan uplands', station: ['Mohe, Heilongjiang, China', 'Mohe_City', '1991–2020', 'China Meteorological Administration'], s: [sb(-19, -11, 0.5, 0.3, 0.3, 0.3), sb(-2, 18, 1.4, 0.3, 0, 1), sb(23, 27, 3.1, 1.5), sb(-9, 17, 1.7, 0.3)] },
    Dwd: { label: 'Monsoon-influenced extremely cold subarctic', where: 'Rare: the Oymyakon region', station: ['Oymyakon, Russia', 'Oymyakon', '1991–2020', 'Roshydromet / WMO via NOAA', 'no station with published open normals is clearly Dwd; Oymyakon borders on it (driest winter month 5 mm against a 4.6 mm cut-off)'], s: [sb(-42, -36, 0.5, 0.3, 1), sb(-20, 10, 0.6, 0.2), sb(19, 23, 2, 1), sb(-30, 9, 1.1, 0.3)] },
    Dfa: { label: 'Hot-summer humid continental', where: 'Chicago, Kyiv-area plains, Toronto outskirts', station: ['Chicago O\'Hare Airport, Illinois, US', 'Chicago', '1991–2020', 'NOAA'], s: [sb(-1, 3, 2.3, 1, 1), sb(8, 21, 3.1, 1.5, 0.5), sb(26, 30, 3.3, 2.5), sb(9, 24, 2.8, 0.5, 1)] },
    Dfb: { label: 'Warm-summer humid continental', where: 'Warsaw, Moscow, Toronto, Minneapolis', station: ['Warsaw (Chopin Airport), Poland', 'Warsaw', '1991–2020', 'Institute of Meteorology and Water Management (IMGW)'], s: [sb(0, 4, 1.7, 1, 1), sb(7, 20, 2, 0.7, 0.5), sb(22, 26, 2.7, 1.5, 0.3), sb(7, 19, 2, 0.3, 1.5)] },
    Dfc: { label: 'Subarctic (boreal taiga)', where: 'Yellowknife, Arkhangelsk, northern Scandinavia', station: ['Yellowknife Airport, Canada', 'Yellowknife', '1991–2020', 'Environment and Climate Change Canada'], s: [sb(-22, -18, 0.9, 1.2, 0.5), sb(-11, 10, 1, 0.5, 0.5), sb(18, 22, 1.9, 1), sb(-9, 11, 1.7, 0.5, 1)] },
    Dfd: { label: 'Extremely cold subarctic', where: 'Oymyakon, Verkhoyansk', station: ['Oymyakon, Russia', 'Oymyakon', '1991–2020', 'Roshydromet / WMO via NOAA'], s: [sb(-42, -36, 0.5, 0.5, 1.5), sb(-20, 10, 0.6, 0.2), sb(19, 23, 2, 0.8), sb(-30, 9, 1.1, 0.3, 0.5)] },
    ET:  { label: 'Tundra', where: 'Utqiaġvik (Alaska North Slope), Norilsk, Svalbard coast', station: ['Utqiaġvik (Wiley Post–Will Rogers Airport), Alaska, US', 'Utqiagvik,_Alaska', '1991–2020', 'NOAA'], s: [sb(-21, -17, 0.4, 1.5), sb(-20, -3, 0.4, 1, 0.5), sb(5, 9, 1.3, 0.3, 2.5), sb(-11, 3, 1, 1, 1.5)] },
    EF:  { label: 'Ice cap', where: 'Antarctica (South Pole), interior Greenland', station: ['Amundsen–Scott South Pole Station, Antarctica', 'Amundsen–Scott_South_Pole_Station', '1991–2020 (temperature), 1957–1988 (precipitation)', 'NOAA / Deutscher Wetterdienst'], s: [sb(-56, -52, 0, 2.5), sb(-54, -35, 0, 2), sb(-37, -26, 0, 1, 0.5), sb(-53, -49, 0, 2)] },
  };
  const KOPPEN_SEASONS = ['winter', 'spring', 'summer', 'autumn'];
  const WET_LABELS = ['Arid', 'Very dry', 'Light', 'Moderate', 'Wet', 'Very wet'];

  /** Weather weights for one season's baseline (see KOPPEN). Snow appears on its own when highs are near or below freezing. */
  function baselineWeights(p) {
    const [lo, hi] = p.t, mid = (lo + hi) / 2, wet = clamp(Number(p.wet) || 0, 0, 5);
    const storm = Number(p.storm) || 0, fog = Number(p.fog) || 0, dust = Number(p.dust) || 0;
    const cold = mid <= 1, frosty = lo <= 2;
    const w = {
      clear: Math.max(0.4, 5 - wet), partly: wet ? 3 : 2, overcast: 0.3 + 0.7 * wet,
      drizzle: wet >= 0.5 ? 0.5 * wet : 0.05, rain: wet >= 1 ? 0.4 * wet * (wet > 3 ? 1.4 : 1) : 0.05 * wet,
      storm: cold ? 0 : storm * 0.8, fog: fog * 1.1,
      haze: mid >= 27 && wet < 2.5 ? 2.5 - wet : 0, sandstorm: dust * 0.6,
      hail: storm >= 1.5 && mid >= 8 && mid <= 30 ? 0.25 : 0,
    };
    if (frosty) {
      const share = clamp((3 - lo) / Math.max(1, hi - lo + 3), 0.2, 1); // how much of the season is cold enough
      w.snow = (0.6 * wet + 0.4) * share * 2;
      w.heavysnow = 0.35 * wet * share * 2;
      w.blizzard = (storm * 0.6 + 0.1 * wet) * share;
      if (cold) { w.drizzle *= 0.3; w.rain *= 0.3; }
    }
    for (const k in w) w[k] = Math.round(w[k] * 100) / 100;
    return w;
  }

  /** Baselines (keyed winter/spring/summer/autumn) into the engine's climate shape. */
  function buildClimate(base, meta = {}) {
    const seasons = {};
    for (const k of KOPPEN_SEASONS) {
      const p = base[k];
      seasons[k] = { t: [Math.min(p.t[0], p.t[1]), Math.max(p.t[0], p.t[1])], w: baselineWeights(p) };
    }
    const avg = f => KOPPEN_SEASONS.reduce((s, k) => s + f(base[k]), 0) / 4;
    seasons.any = { t: [Math.round(avg(p => p.t[0])), Math.round(avg(p => p.t[1]))],
      w: baselineWeights({ t: [avg(p => p.t[0]), avg(p => p.t[1])], wet: avg(p => p.wet), storm: avg(p => p.storm), fog: avg(p => p.fog), dust: avg(p => p.dust) }) };
    const g = (meta.koppen || '')[0];
    return { label: meta.label || 'Custom climate', koppen: meta.koppen || '', base,
      persistence: g === 'B' ? 0.6 : g === 'E' ? 0.55 : 0.45, seasons };
  }

  /** Editable season baselines for a Köppen code, keyed winter/spring/summer/autumn (a fresh copy). */
  function koppenBase(code) {
    const k = KOPPEN[code]; if (!k) return null;
    const out = {};
    KOPPEN_SEASONS.forEach((s, i) => (out[s] = JSON.parse(JSON.stringify(k.s[i]))));
    return out;
  }
  const _kCache = {}, _customCache = new WeakMap();
  function koppenClimate(code) {
    if (!KOPPEN[code]) return null;
    return _kCache[code] || (_kCache[code] = buildClimate(koppenBase(code), { koppen: code, label: `${code} · ${KOPPEN[code].label}` }));
  }
  /** Köppen code from letters, or '' when the combination isn't a Köppen class. */
  function koppenCode(group, second, third) {
    const L = KOPPEN_LETTERS[group]; if (!L || !L[0][second]) return '';
    if (L[1] && !L[1][third]) return '';
    const code = group + second + (L[1] ? third : '');
    return KOPPEN[code] ? code : '';
  }
  /** Readable one-liner for a season baseline, e.g. "Highs 11–18°C · Wet · storms". */
  function describeBaseline(p, unit) {
    const parts = [`Highs ${fmtTemp(p.t[0], unit)} to ${fmtTemp(p.t[1], unit)}`, WET_LABELS[Math.round(clamp(p.wet, 0, 5))]];
    if (p.storm >= 1) parts.push((p.t[0] + p.t[1]) / 2 <= 1 ? 'blizzards' : 'thunderstorms');
    if (p.fog >= 1) parts.push('fog');
    if (p.dust >= 1) parts.push('dust storms');
    return parts.join(' · ');
  }

  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rngFor(seedStr) {
    let a = hashStr(seedStr);
    return function () { // mulberry32
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pickWeighted(weights, r) {
    const entries = Object.entries(weights).filter(([k, w]) => w > 0 && WEATHER[k]);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let x = r * total;
    for (const [k, w] of entries) { if ((x -= w) < 0) return k; }
    return entries.length ? entries[entries.length - 1][0] : 'clear';
  }
  function climateFor(region) {
    const s = (region && region.settings) || {};
    const cc = s.custom_climate;
    if (s.climate === 'koppen_custom' && cc && cc.base) {
      // rebuilt from the baselines so weather tuning in this file reaches saved custom climates
      if (!_customCache.has(cc)) _customCache.set(cc, buildClimate(cc.base, cc));
      return _customCache.get(cc);
    }
    if (s.climate === 'custom' && cc && cc.seasons) return cc;
    if (String(s.climate).startsWith('koppen:')) return koppenClimate(s.climate.slice(7)) || CLIMATES.temperate;
    return CLIMATES[s.climate] || CLIMATES.temperate;
  }

  /**
   * Generate weather for absolute day d.
   * prev: previous day's weather object (or null) for persistence.
   * nonce: change it to "re-roll" the same day.
   */
  function genWeather(cal, seed, region, d, prev, nonce) {
    const clim = climateFor(region);
    const hemi = region && region.settings && region.settings.hemisphere;
    const sea = season(cal, d, hemi);
    const sdef = clim.seasons[sea.type] || clim.seasons.any || Object.values(clim.seasons)[0];
    const rng = rngFor(`${seed}|${region ? region.id : 0}|${d}|${nonce || 0}`);

    // temperature: random target in the seasonal range, smoothed toward yesterday
    const [lo, hi] = sdef.t;
    let target = lo + (hi - lo) * (rng() * 0.6 + rng() * 0.4);
    let temp = (prev && typeof prev.temp === 'number') ? prev.temp * 0.45 + target * 0.55 : target;
    temp = Math.round(temp);

    let type;
    const persist = clim.persistence ?? 0.45;
    // Repeating yesterday gets less likely the longer a spell lasts; severe weather breaks up faster.
    const SEVERE = ['rain', 'storm', 'heavysnow', 'blizzard', 'sandstorm', 'hail', 'redalert', 'blackout', 'ionstorm', 'flare'];
    let streak = 0;
    if (prev && prev.type && sdef.w[prev.type] > 0) {
      const p = persist * Math.pow(0.6, prev.streak || 0) * (SEVERE.includes(prev.type) ? 0.5 : 1);
      if (rng() < p) { type = prev.type; streak = (prev.streak || 0) + 1; }
    }
    if (!type) type = pickWeighted(sdef.w, rng());

    const def = WEATHER[type];
    if (def.precip === 'rain' && temp <= 0 && def.snowAs) type = def.snowAs;
    if (def.precip === 'snow' && temp >= 3 && def.rainAs) type = def.rainAs;

    const wr = rng();
    let wind = wr < 0.3 ? 0 : wr < 0.75 ? 1 : wr < 0.95 ? 2 : 3;
    if (WEATHER[type].wind) wind = Math.max(wind, WEATHER[type].wind);
    if (clim === CLIMATES.underground || clim === CLIMATES.ship || clim === CLIMATES.vacuum) wind = 0;

    if (prev && prev.type === type && !streak) streak = (prev.streak || 0) + 1;
    return { type, temp, wind, season: sea.name, streak };
  }

  // ---------------------------------------------------------------- weather by shift
  // The day's weather is the forecast: its type is the worst the day gets, its temp the daytime high and its
  // wind the strongest. Each shift either matches it or eases off to one of these milder neighbours.
  const SHIFT_VARIANTS = {
    clear: ['partly'], partly: ['clear', 'overcast'], overcast: ['partly'], drizzle: ['overcast', 'partly'],
    rain: ['drizzle', 'overcast'], storm: ['rain', 'overcast'], fog: ['overcast', 'partly', 'clear'],
    snow: ['overcast', 'partly'], heavysnow: ['snow', 'overcast'], blizzard: ['heavysnow', 'snow'],
    hail: ['rain', 'overcast'], haze: ['clear'], sandstorm: ['haze', 'clear'],
    still: ['damp'], damp: ['still'], drafty: ['still'], dust: ['drafty', 'still'],
    flicker: ['nominal'], redalert: ['flicker'], blackout: ['redalert', 'flicker'], ionstorm: ['flicker', 'nominal'],
    radiation: ['nominal'], flare: ['nominal'], debris: ['nominal'],
  };
  // Which shift the forecast peaks in: storms, hail, haze and dust build in the afternoon heat; fog is thickest at dawn.
  // Indexes here run Overnight, Dawn, Midday, Dusk (the order before Dawn became the first shift), so the
  // same day still rolls the same weather; shiftWeather() hands the result back in Dawn-first order.
  const SHIFT_PEAK = { storm: [2, 3], hail: [2], haze: [2], sandstorm: [2, 3], fog: [1] };
  // Temperature at each shift as a share of the day's high-to-low swing below the high (Midday holds the high).
  const SHIFT_COOL = [0.9, 0.5, 0, 0.35];

  /** Typical difference between the daytime high and the overnight low, in °C, before cloud cover. */
  function diurnalRange(clim, sea) {
    // Mean daily maximum minus mean daily minimum across the stations in tools/climate-normals.json
    // (`node tools/climate-baselines.js` prints them), rounded to the nearest half degree.
    if (clim === CLIMATES.underground || clim === CLIMATES.ship || clim === CLIMATES.vacuum) return 0;
    const k = clim.koppen || '';
    if (k) {
      const g = k[0];
      if (g === 'B') return k[1] === 'W' ? 12.5 : 14.5;
      if (g === 'E') return 6.5;
      if (g === 'A') return 8;
      if (k[1] === 's' && sea === 'summer') return 11.5; // dry-summer stations swing more in summer
      return g === 'D' ? 10.5 : 8.5;
    }
    const R = { temperate: 8.5, arctic: 6, desert: 10.5, tropical: 9, mountain: 10, maritime: 6, swamp: 8 };
    for (const key in R) if (clim === CLIMATES[key]) return R[key];
    return 9;
  }
  // Cloud and rain keep the night warm and the day cool, so they shrink the swing.
  const CLOUD_DAMP = { clear: 1, haze: 1, partly: 0.85, sandstorm: 0.7, rain: 0.45, storm: 0.45, heavysnow: 0.45, blizzard: 0.45, hail: 0.45 };

  /**
   * Weather for each of the 4 shifts of absolute day d, worked out from that day's weather w.
   * Deterministic for the same day and forecast, so nothing extra is stored. Returns [] when w is empty.
   */
  function shiftWeather(cal, seed, region, d, w) {
    if (!w || !w.type) return [];
    const clim = climateFor(region);
    const sea = season(cal, d, region && region.settings && region.settings.hemisphere);
    const rng = rngFor(`${seed}|shifts|${d}|${w.type}|${w.temp}|${w.wind}`);
    const variants = SHIFT_VARIANTS[w.type] || [];
    const peaks = SHIFT_PEAK[w.type] || [0, 1, 2, 3];
    const peak = peaks[Math.floor(rng() * peaks.length)];
    const fogLifts = w.type === 'fog';

    // Walk out from the peak shift: each step may ease off to a milder neighbour, and stays eased once it has.
    const types = [];
    types[peak] = w.type;
    for (const dir of [-1, 1]) {
      let cur = w.type;
      for (let i = peak + dir; i >= 0 && i < 4; i += dir) {
        const ease = fogLifts && i >= 2 ? 0.85 : 0.4;
        if (variants.length && rng() < ease) {
          const pool = cur === w.type ? variants : variants.slice(variants.indexOf(cur));
          cur = pool[Math.min(pool.length - 1, Math.floor(rng() * rng() * pool.length))] || cur;
        }
        types[i] = cur;
      }
    }

    const hasTemp = typeof w.temp === 'number';
    const range = diurnalRange(clim, sea.type) * (CLOUD_DAMP[w.type] ?? 0.55) * (w.wind >= 2 ? 0.8 : 1);
    const calm = range === 0;
    const out = types.map((type, i) => {
      let temp = null;
      if (hasTemp) temp = Math.min(w.temp, Math.round(w.temp - range * SHIFT_COOL[i] + (calm || i === 2 ? 0 : rng() * 2 - 1)));
      const def = WEATHER[type] || {};
      // a colder shift can turn the day's rain to snow (a thunderstorm only as far as heavy snow)
      if (temp !== null && def.precip === 'rain' && temp <= 0 && def.snowAs) type = type === 'storm' ? 'heavysnow' : def.snowAs;
      if (temp !== null && def.precip === 'snow' && temp >= 3 && def.rainAs) type = def.rainAs;
      let wind = w.wind || 0;
      if (i !== peak && wind > 0 && rng() < (i === 0 ? 0.6 : 0.35)) wind -= 1; // nights are calmer
      if ((WEATHER[type] || {}).wind) wind = Math.max(wind, WEATHER[type].wind);
      return { type, temp, wind: Math.min(wind, Math.max(w.wind || 0, (WEATHER[type] || {}).wind || 0)) };
    });
    return [out[1], out[2], out[3], out[0]];
  }

  // Temperatures are stored in °C; these convert for display and input.
  const TEMP_UNITS = {
    C: { label: 'Celsius', sym: '°C', from: c => c, to: v => v },
    F: { label: 'Fahrenheit', sym: '°F', from: c => c * 9 / 5 + 32, to: v => (v - 32) * 5 / 9 },
    K: { label: 'Kelvin', sym: ' K', from: c => c + 273.15, to: v => v - 273.15 },
    R: { label: 'Rankine', sym: '°R', from: c => (c + 273.15) * 9 / 5, to: v => v * 5 / 9 - 273.15 },
    Re: { label: 'Réaumur', sym: '°Ré', from: c => c * 4 / 5, to: v => v * 5 / 4 },
  };
  const tempDef = unit => TEMP_UNITS[unit] || TEMP_UNITS.C;
  /** °C -> the unit's value, rounded to `dp` decimals. */
  function toTempUnit(c, unit, dp = 0) { const f = 10 ** dp; return Math.round(tempDef(unit).from(c) * f) / f; }
  /** A value in the unit -> °C. */
  function fromTempUnit(v, unit) { return tempDef(unit).to(v); }
  function fmtTemp(c, unit) {
    if (unit === 'none' || typeof c !== 'number') return '';
    return `${toTempUnit(c, unit)}${tempDef(unit).sym}`;
  }
  function weatherLabel(w, unit) {
    if (!w) return '';
    const def = WEATHER[w.type] || { label: w.type, icon: '' };
    const parts = [def.label];
    const t = fmtTemp(w.temp, unit);
    if (t) parts.push(t);
    if (w.wind) parts.push(WIND[w.wind] || '');
    return parts.filter(Boolean).join(', ');
  }

  // ---------------------------------------------------------------- visibility
  /**
   * Visibility 0–5 for one slot (shift or hour). Returns {score, label, parts[]} where parts explain the math.
   * lighting: 'natural' (sun + moons), 'artificial' (fixed light levels per quarter of the day), 'none' (total darkness).
   */
  function visibility(cal, region, weather, d, slot, override) {
    const rs = (region && region.settings) || {};
    const lighting = rs.lighting || cal.lighting || 'natural';
    const name = shiftNames(cal)[slot], shift = slotQuarter(cal, slot);
    const parts = [];
    let score;

    if (lighting === 'none') {
      score = 0; parts.push('No natural light (0)');
    } else if (lighting === 'artificial') {
      const lv = rs.light_levels || cal.lightLevels || [4, 5, 4, 2];
      score = Number(lv[shift] ?? 4);
      parts.push(`${name} lighting (${score})`);
    } else {
      // Dusk runs from sunset into the evening, so it sits nearer night than dawn
      score = [3, 5, 1, 0][shift];
      parts.push(`${name} base (${score})`);
    }

    const def = weather ? (WEATHER[weather.type] || {}) : null;
    if (lighting === 'natural' && shift >= 2) {
      const ms = moons(cal, d);
      let light = ms.reduce((s, m, i) => s + m.illum * Number((cal.moons[i].brightness ?? 1)), 0);
      if (def) light *= def.moon ?? 1;
      const bonus = Math.min(shift === 3 ? 2 : 1, Math.round(light * 2));
      if (bonus) { score += bonus; parts.push(`moonlight +${bonus}`); }
    }
    if (def) {
      const m = shift === 3 ? def.night : def.day;
      if (m) { score += m; parts.push(`${def.label.toLowerCase()} ${m > 0 ? '+' : ''}${m}`); }
    }
    const tm = Number(rs.terrain_mod || 0);
    if (tm && lighting !== 'none') { score += tm; parts.push(`terrain ${tm > 0 ? '+' : ''}${tm}`); }

    score = clamp(Math.round(score), 0, 5);
    if (override !== null && override !== undefined && override !== '') {
      score = clamp(Number(override), 0, 5);
      parts.push(`GM override → ${score}`);
    }
    return { score, label: VIS_LABELS[score], parts };
  }


  // ---------------------------------------------------------------- sources
  // Where the app's reference figures come from, shown on the About page. Data entries below name their source
  // by key. Wikipedia text is CC BY-SA 4.0; NASA, JPL and US government pages are public domain; GOV.UK
  // statistics are under the Open Government Licence v3.0.
  const wp = (page, title) => ({ title: title || page.replace(/_/g, ' ').replace(/ \(.*\)$/, ''), by: 'Wikipedia', licence: 'CC BY-SA 4.0',
    url: `https://en.wikipedia.org/wiki/${page}` });
  const nasa = (title, url, by = 'NASA') => ({ title, by, licence: 'Public domain (US government work)', url });
  const SOURCES = {
    walk: wp('Preferred_walking_speed'), jog: wp('Jogging'), horse: wp('Horse_gait'), stage: wp('Stagecoach'),
    camel: wp('Dromedary'), oxen: wp('Oregon_Trail'), bike: wp('Bicycle_performance'),
    dft: { title: 'Vehicle speed compliance statistics for Great Britain: 2024 (average free-flow speeds)', by: 'Department for Transport',
      licence: 'Open Government Licence v3.0', url: 'https://www.gov.uk/government/statistics/vehicle-speed-compliance-statistics-for-great-britain-2024/vehicle-speed-compliance-statistics-for-great-britain-2024' },
    acela: wp('Acela'), shinkansen: wp('Shinkansen'), maglev: wp('Shanghai_maglev_train'), lrv: wp('Lunar_Roving_Vehicle'),
    percy: nasa('Map a Mars rover driving route (Perseverance top speed)', 'https://www.jpl.nasa.gov/edu/learn/project/map-a-mars-rover-driving-route/', 'NASA JPL'),
    galley: wp('Galley'), longship: wp('Longship'), clipper: wp('Clipper'), titanic: wp('Titanic'), container: wp('Container_ship'),
    carrier: wp('Nimitz-class_aircraft_carrier'), hydrofoil: wp('Hydrofoil'),
    eagle: wp('Golden_eagle'), pigeon: wp('Homing_pigeon'), zeppelin: wp('LZ_129_Hindenburg'), heli: wp('Bell_206'),
    cessna: wp('Cessna_172'), b787: wp('Boeing_787_Dreamliner'), concorde: wp('Concorde'),
    jplPlanets: nasa('Approximate positions of the planets (Table 1, semi-major axes)', 'https://ssd.jpl.nasa.gov/planets/approx_pos.html', 'NASA JPL Solar System Dynamics'),
    jplSats: nasa('Planetary satellite mean elements', 'https://ssd.jpl.nasa.gov/sats/elem/sep.html', 'NASA JPL Solar System Dynamics'),
    jplConst: nasa('Astrodynamic parameters (GM, au, speed of light)', 'https://ssd.jpl.nasa.gov/astro_par.html', 'NASA JPL Solar System Dynamics'),
    pluto: nasa('Pluto fact sheet', 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/plutofact.html', 'NASA NSSDCA'),
    moonFacts: nasa('Moon fact sheet', 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html', 'NASA NSSDCA'),
    ceres: wp('Ceres_(dwarf_planet)'), geo: wp('Geostationary_orbit'),
    l2: nasa("Webb's orbit at Sun–Earth Lagrange point 2", 'https://science.nasa.gov/asset/webb/webbs-orbit-at-sun-earth-lagrange-point-2-l2/'),
    helio: wp('Heliopause_(astronomy)', 'Heliopause'), oort: nasa('Oort Cloud facts', 'https://science.nasa.gov/solar-system/oort-cloud/facts'),
    nearStars: wp('List_of_nearest_stars'), g0: wp('Standard_gravity'), ly: wp('Light-year'),
    altair: wp('Altair'), vega: wp('Vega'), pollux: wp('Pollux_(star)'), arcturus: wp('Arcturus'), trappist: wp('TRAPPIST-1'),
    aldebaran: wp('Aldebaran'), polaris: wp('Polaris'), betelgeuse: wp('Betelgeuse'), sgra: wp('Sagittarius_A*'),
    // climate
    beck: { title: 'Present and future Köppen-Geiger climate classification maps at 1-km resolution (Beck et al., Scientific Data 5, 180214, 2018)',
      by: 'Scientific Data', licence: 'CC BY 4.0', url: 'https://doi.org/10.1038/sdata.2018.214' },
    cave: nasa('Mammoth Cave weather (cave air a constant 12 °C)', 'https://home.nps.gov/maca/planyourvisit/weather.htm', 'US National Park Service'),
    room: wp('Room_temperature'),
    // calendars
    gregorian: wp('Gregorian_calendar'),
    usno: nasa('Earth’s seasons and apsides (equinox and solstice dates)', 'https://aa.usno.navy.mil/data/Earth_Seasons', 'US Naval Observatory'),
    phases: { title: 'Six Millennium Catalog of Phases of the Moon (mean synodic month 29.530588 days; moon phase predictions by Fred Espenak, NASA/GSFC)',
      by: 'NASA Goddard', licence: 'Free to reproduce with acknowledgment', url: 'https://eclipse.gsfc.nasa.gov/phase/phasecat.html' },
    usHolidays: nasa('5 U.S.C. § 6103, federal holidays (New Year’s Day, Thanksgiving, Christmas Day)', 'https://www.govinfo.gov/link/uscode/5/6103', 'US Code'),
    xmasEve: wp('Christmas_Eve'),
    imperial: { title: 'Imperial Calendar', by: 'Warhammer Fantasy Lexicanum (fan wiki)', licence: 'Not openly licensed; setting © Games Workshop',
      url: 'https://whfb.lexicanum.com/wiki/Imperial_Calendar' },
    imperialMoons: { title: 'Mannslieb & Morrslieb', by: 'Warhammer Fantasy Lexicanum (fan wiki)', licence: 'Not openly licensed; setting © Games Workshop',
      url: 'https://whfb.lexicanum.com/wiki/Moon' },
    shire: { title: 'Shire Calendar', by: 'Tolkien Gateway (fan wiki)', licence: 'CC BY-SA 4.0 (wiki text); the setting © the Tolkien Estate',
      url: 'https://tolkiengateway.net/wiki/Shire_Calendar' },
    letter294: { title: 'Tolkien, Letters no. 294: Hobbiton at about the latitude of Oxford, Minas Tirith of Florence, Pelargir of ancient Troy (quoted in a Tolkien FAQ)',
      by: 'Aarhus University (Tolkien FAQ)', licence: 'Quotation; © the Tolkien Estate', url: 'https://cs.au.dk/~clemens/au15572/tolkien/actuallyeurope.html' },
    imaginarymaps: { title: 'Köppen climate map of Middle-earth (r/imaginarymaps, post c5mzt9)', by: 'Reddit user post', licence: 'Not openly licensed',
      url: 'https://www.reddit.com/r/imaginarymaps/comments/c5mzt9/' },
    // rules
    yze: { title: 'Year Zero Engine Standard Reference Document (journeys: four shifts a day, travel tasks, terrain)', by: 'Free League Publishing',
      licence: 'Year Zero Engine Free Tabletop License (royalty-free, commercial use allowed)', url: 'https://freeleaguepublishing.com/community-content/free-tabletop-licenses/' },
  };

  // ---------------------------------------------------------------- travel planner
  // Physical constants: c and the au from JPL (jplConst), standard gravity (g0) and the IAU light-year (ly).
  const C = 299792458, G0 = 9.80665, AU = 1.495978707e11, LY = 9.4607304725808e15;
  const DIST_UNITS = { km: 1e3, mi: 1609.344, AU, LY, ls: C, lm: C * 60 };
  // Central bodies (GM in m³/s², from jplConst; Jupiter and Saturn are their whole systems) and the bodies orbiting
  // them (mean orbit radius in AU or km, from jplPlanets, jplSats, pluto and ceres; low orbit adds 400 km to Earth's
  // 6,371 km mean radius, and geostationary is from geo).
  const SYSTEMS = {
    sun: { label: 'Sol', gm: 1.32712440041e20, unit: 'AU', bodies: {
      Mercury: 0.387, Venus: 0.723, Earth: 1.0, Mars: 1.524, Ceres: 2.77, Jupiter: 5.203,
      Saturn: 9.537, Uranus: 19.19, Neptune: 30.07, Pluto: 39.48 } },
    jupiter: { label: 'Jupiter system', gm: 1.267127641e17, unit: 'km', bodies: {
      Io: 421800, Europa: 671100, Ganymede: 1070400, Callisto: 1882700 } },
    saturn: { label: 'Saturn system', gm: 3.79405848418e16, unit: 'km', bodies: {
      Enceladus: 238400, Tethys: 295000, Dione: 377700, Rhea: 527200, Titan: 1221900, Iapetus: 3561700 } },
    earth: { label: 'Earth–Moon', gm: 3.98600435507e14, unit: 'km', bodies: {
      'Low orbit (400 km)': 6771, 'Geostationary': 42164, Moon: 384400 } },
  };

  // Genres limit which travel modes and sample figures the Travel tab offers. A campaign with no genre saved
  // (made before genres existed) counts as Sci-Fi, which shows every mode, so nothing disappears on it.
  const GENRES = { fantasy: 'Fantasy', modern: 'Modern', scifi: 'Sci-Fi' };
  // Overland, sea and air all use the speed × shifts maths ('ground'); the rest are the space modes.
  const SPEED_MODES = ['overland', 'sea', 'air'];
  const GENRE_MODES = {
    fantasy: ['overland', 'sea', 'air'],
    modern: ['overland', 'sea', 'air', 'hohmann'],
    scifi: ['overland', 'sea', 'air', 'hohmann', 'brachistochrone', 'relativistic', 'ftl'],
  };
  const genreOf = settings => (settings && GENRES[settings.genre] ? settings.genre : 'scifi');
  // Real-world speeds in km/h, by speed mode: [label, km/h, genres, source key]. Each figure is the one its source
  // states (converted from mph or knots where it gives those); the label says when it is a top or cruising speed.
  const F = ['fantasy', 'modern', 'scifi'], M = ['modern', 'scifi'], SF = ['scifi'];
  const SPEEDS = {
    overland: [
      { group: 'On foot', items: [
        ['Walking (typical adult, 1.4 m/s)', 5, F, 'walk'], ['Slow walker or tired group (1.1 m/s)', 4, F, 'walk'],
        ['Jogging (6.4–9.7 km/h)', 8, F, 'jog']] },
      { group: 'Animals and carts', items: [
        ['Ox-drawn wagon (up to 2 mph)', 3.2, F, 'oxen'], ['Camel caravan, walking', 4, F, 'camel'], ['Horseback, at a walk', 7, F, 'horse'],
        ['Horseback, at a trot', 13, F, 'horse'], ['Stagecoach, before the late 1700s', 8, F, 'stage'],
        ['Fast stagecoach of the 1830s (horses changed at each stage)', 16, F, 'stage']] },
      { group: 'Road and rail', items: [
        ['Bicycle (Copenhagen average)', 15.5, M, 'bike'], ['Car on a 30 mph town road, free-flowing', 48, M, 'dft'],
        ['Car on a rural road, free-flowing', 82, M, 'dft'], ['Car on a motorway / highway, free-flowing', 109, M, 'dft'],
        ['Intercity train (Acela, average with stops)', 113, M, 'acela'], ['Maglev (Shanghai, average)', 224, M, 'maglev'],
        ['High-speed train (Shinkansen, Tokyo–Osaka)', 239, M, 'shinkansen']] },
      { group: 'Off-world vehicles', items: [
        ['Apollo Lunar Roving Vehicle (design top speed)', 10, SF, 'lrv'], ['Mars rover (Perseverance, top speed)', 0.152, SF, 'percy']] },
    ],
    sea: [
      { group: 'Under oar and sail', items: [
        ['Medieval oared galley, cruising', 5, F, 'galley'], ['Viking longship (5–10 kn)', 14, F, 'longship'],
        ['Ancient trireme, cruising (Olympias trials)', 14, F, 'galley'], ['Medieval galley under sail, fair wind', 15, F, 'galley'],
        ['Clipper ship, 1866 tea race average (6.6 kn)', 12.2, M, 'clipper']] },
      { group: 'Engines', items: [
        ['Ocean liner, 1912 (Titanic service speed, 21 kn)', 39, M, 'titanic'], ['Container ship, slow steaming (21 kn)', 39, M, 'container'],
        ['Aircraft carrier (Nimitz class, 30+ kn)', 56, M, 'carrier'], ['Hydrofoil ferry (Hong Kong–Macau, 45 kn)', 83, M, 'hydrofoil']] },
    ],
    air: [
      { group: 'Wings', items: [
        ['Golden eagle, unhurried soaring', 48, F, 'eagle'], ['Homing pigeon, long-distance average', 97, F, 'pigeon']] },
      { group: 'Powered flight', items: [
        ['Airship (Hindenburg, cruise)', 122, M, 'zeppelin'], ['Helicopter (Bell 206 JetRanger, cruise)', 220, M, 'heli'],
        ['Light aircraft (Cessna 172, cruise)', 226, M, 'cessna'], ['Airliner at cruise (Boeing 787, Mach 0.85)', 903, M, 'b787'],
        ['Concorde (Mach 2.02 cruise)', 2154, M, 'concorde']] },
    ],
  };
  /** The sample speed groups for a speed mode and genre, without the empty ones. */
  function speedSamples(mode, genre) {
    return (SPEEDS[mode] || []).map(g => ({ group: g.group, items: g.items.filter(i => i[2].includes(genre)).map(([label, kmh]) => ({ label, kmh })) }))
      .filter(g => g.items.length);
  }
  // Solar-system distances for thrust burns: [label, distance, unit, source key]. Planet pairs come from the mean
  // orbit radii in SYSTEMS, so a real closest approach can differ a little (Mars ranges 0.37–0.68 AU at opposition).
  function spaceDistances() {
    const b = SYSTEMS.sun.bodies;
    const r = x => +x.toFixed(2);
    const pair = (a, z) => [[`${a} to ${z}, closest (${r(Math.abs(b[z] - b[a]))} AU)`, r(Math.abs(b[z] - b[a])), 'AU', 'jplPlanets'],
      [`${a} to ${z}, farthest (${r(b[z] + b[a])} AU)`, r(b[z] + b[a]), 'AU', 'jplPlanets']];
    return [
      { group: 'Near Earth', items: [['Earth to geostationary orbit (35,786 km)', 35786, 'km', 'geo'], ['Earth to the Moon (384,400 km)', 384400, 'km', 'jplSats'],
        ['Earth to the Sun–Earth L2 point (1.5 million km)', 1.5e6, 'km', 'l2'], ['Sun to Earth (1 AU, 8.3 light-minutes)', 1, 'AU', 'jplConst']] },
      { group: 'From Earth', items: ['Mercury', 'Venus', 'Mars', 'Ceres', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'].flatMap(z => pair('Earth', z)) },
      { group: 'Between other bodies', items: [...pair('Mars', 'Ceres'), ...pair('Mars', 'Jupiter'), ...pair('Jupiter', 'Saturn'), ...pair('Saturn', 'Uranus')] },
      { group: 'The outer system', items: [['Sun to the heliopause (Voyager 1 crossed it at 121 AU)', 121, 'AU', 'helio'],
        ['Sun to the inner Oort cloud (about 2,000 AU)', 2000, 'AU', 'oort'], ['Sol to Proxima Centauri (4.25 LY)', 4.25, 'LY', 'nearStars']] },
    ];
  }
  // Star systems near Sol (and a few landmarks), by J2000 right ascension (hours), declination (degrees) and
  // distance from Sol (light-years), so the distance between any two can be worked out; the last field is the source.
  const STARS = [
    ['Sol', 0, 0, 0], ['Proxima Centauri', 14.4953, -62.6794, 4.25, 'nearStars'], ['Alpha Centauri A/B', 14.6601, -60.8339, 4.34, 'nearStars'],
    ["Barnard's Star", 17.9635, 4.6933, 5.96, 'nearStars'], ['Wolf 359', 10.9414, 7.0147, 7.86, 'nearStars'], ['Lalande 21185', 11.0556, 35.97, 8.30, 'nearStars'],
    ['Sirius', 6.7525, -16.7161, 8.71, 'nearStars'], ['Epsilon Eridani', 3.5488, -9.4583, 10.47, 'nearStars'], ['Procyon', 7.655, 5.225, 11.46, 'nearStars'],
    ['61 Cygni', 21.115, 38.7494, 11.40, 'nearStars'], ['Epsilon Indi', 22.056, -56.7861, 11.87, 'nearStars'], ['Tau Ceti', 1.7345, -15.9375, 11.91, 'nearStars'],
    ['Altair', 19.8464, 8.8683, 16.73, 'altair'], ['Vega', 18.6157, 38.7837, 25.04, 'vega'], ['Pollux', 7.7553, 28.0262, 33.78, 'pollux'],
    ['Arcturus', 14.261, 19.1822, 36.7, 'arcturus'], ['TRAPPIST-1', 23.1082, -5.0414, 40.66, 'trappist'], ['Aldebaran', 4.5987, 16.5093, 67, 'aldebaran'],
    ['Polaris', 2.5303, 89.2641, 446.5, 'polaris'], ['Betelgeuse', 5.9195, 7.4071, 548, 'betelgeuse'],
    ['Galactic centre (Sagittarius A*)', 17.7611, -29.0078, 26996, 'sgra'],
  ];
  /** Straight-line distance in light-years between two STARS entries (by index), to the nearest 0.01 LY. */
  function starDistance(i, j) {
    const xyz = ([, ra, dec, d]) => {
      const a = ra * Math.PI / 12, b = dec * Math.PI / 180;
      return [d * Math.cos(b) * Math.cos(a), d * Math.cos(b) * Math.sin(a), d * Math.sin(b)];
    };
    const p = xyz(STARS[i]), q = xyz(STARS[j]);
    return Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100) / 100;
  }

  /**
   * Compute a travel duration. Returns {hours, worldHours?, lines[]}.
   * modes: 'ground' (or 'overland' | 'sea' | 'air') | 'hohmann' | 'brachistochrone' | 'relativistic' | 'ftl'
   */
  function travel(mode, q) {
    if (SPEED_MODES.includes(mode)) mode = 'ground';
    const n = k => Number(q[k]);
    const lines = [];
    const fmtH = h => fmtDuration(h);
    if (mode === 'ground') {
      // A day has slots_per_day slots (4 shifts by default, 2, or its hours) of shift_hours each; the party
      // travels `shifts` of them and rests the others.
      const spd = n('slots_per_day') > 0 ? Math.round(n('slots_per_day')) : 4, word = q.slot === 'hour' ? 'hour' : 'shift';
      const dist = n('distance'), speed = n('speed'), perDay = Math.min(spd, Math.max(1, Math.round(n('shifts')) || Math.min(2, spd)));
      const shiftH = n('shift_hours') > 0 ? n('shift_hours') : 24 / spd;
      if (!(dist > 0 && speed > 0)) throw new Error('Enter a distance and a speed');
      const moving = dist / speed * (n('terrain') || 1);
      const travelShifts = moving / shiftH;
      // Whole days of travel, then the last day's remaining slots: arrival comes at the end of the last moving slot.
      const fullDays = Math.max(0, Math.ceil(travelShifts / perDay) - 1);
      const elapsed = fullDays * spd + (travelShifts - fullDays * perDay);
      const terr = n('terrain') && n('terrain') !== 1 ? ` (terrain ×${n('terrain')})` : '';
      lines.push(word === 'hour' && shiftH === 1 ? `${moving.toFixed(1)} hours moving at ${speed}/h${terr}`
        : `${moving.toFixed(1)} hours moving at ${speed}/h${terr} = ${travelShifts.toFixed(1)} ${word}s of ${+shiftH.toFixed(2)} h`);
      lines.push(`${perDay} ${word}${perDay === 1 ? '' : 's'} on the move a day → ${(elapsed / spd).toFixed(1)} days`);
      return { hours: elapsed * shiftH, lines };
    }
    if (mode === 'hohmann') {
      const sys = SYSTEMS[q.system] || SYSTEMS.sun;
      const toM = r => r * (sys.unit === 'AU' ? AU : 1e3);
      const r1 = toM(n('r1')), r2 = toM(n('r2'));
      if (!(r1 > 0 && r2 > 0) || r1 === r2) throw new Error('Pick two different orbits');
      const a = (r1 + r2) / 2;
      const t = Math.PI * Math.sqrt(a ** 3 / sys.gm);
      const v1 = Math.sqrt(sys.gm / r1), v2 = Math.sqrt(sys.gm / r2);
      const dv1 = Math.abs(Math.sqrt(sys.gm / r1) * (Math.sqrt(2 * r2 / (r1 + r2)) - 1));
      const dv2 = Math.abs(Math.sqrt(sys.gm / r2) * (1 - Math.sqrt(2 * r1 / (r1 + r2))));
      const T1 = 2 * Math.PI * Math.sqrt(r1 ** 3 / sys.gm), T2 = 2 * Math.PI * Math.sqrt(r2 ** 3 / sys.gm);
      const syn = 1 / Math.abs(1 / T1 - 1 / T2);
      lines.push(`Minimum-energy transfer around ${sys.label}: ${fmtH(t / 3600)}`);
      lines.push(`Δv ≈ ${(dv1 / 1000).toFixed(2)} + ${(dv2 / 1000).toFixed(2)} = ${((dv1 + dv2) / 1000).toFixed(2)} km/s (orbit to orbit, ignoring escaping each body's gravity)`);
      lines.push(`Launch windows repeat every ${fmtH(syn / 3600)} (synodic period)`);
      void v1; void v2;
      return { hours: t / 3600, lines };
    }
    if (mode === 'brachistochrone' || mode === 'relativistic') {
      const d = n('distance') * (DIST_UNITS[q.unit] || 1e3);
      const a = n('g') * G0;
      if (!(d > 0 && a > 0)) throw new Error('Enter a distance and an acceleration');
      const vmax = n('max_speed_c') > 0 ? n('max_speed_c') * C : Infinity;
      if (mode === 'brachistochrone') {
        // accelerate to midpoint (or cruise cap), coast, flip and decelerate
        let tAcc = Math.sqrt(d / a), coast = 0, peak = a * tAcc;
        if (peak > vmax) { tAcc = vmax / a; peak = vmax; coast = (d - a * tAcc * tAcc) / vmax; }
        const t = 2 * tAcc + coast;
        lines.push(`Burn at ${n('g')} g, flip at ${coast ? 'cruise' : 'midpoint'}: ${fmtH(t / 3600)}`);
        lines.push(`Peak speed ${(peak / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/s (${(peak / C * 100).toFixed(2)}% of light)`);
        if (coast) lines.push(`Includes ${fmtH(coast / 3600)} coasting`);
        if (peak / C > 0.1) lines.push('Above ~10% of light speed — consider the relativistic mode.');
        return { hours: t / 3600, lines };
      }
      // relativistic: constant proper acceleration, flip at midpoint (optional cruise cap as max rapidity)
      const half = d / 2;
      let tauHalf = (C / a) * Math.acosh(1 + a * half / (C * C));
      let tHalf = (C / a) * Math.sinh(a * tauHalf / C);
      let coastT = 0, coastTau = 0;
      if (vmax < C) {
        const phiMax = Math.atanh(vmax / C);
        if (a * tauHalf / C > phiMax) {
          tauHalf = phiMax * C / a;
          const dAcc = (C * C / a) * (Math.cosh(phiMax) - 1);
          tHalf = (C / a) * Math.sinh(phiMax);
          coastT = (d - 2 * dAcc) / vmax;
          coastTau = coastT / Math.cosh(phiMax);
        }
      }
      const world = 2 * tHalf + coastT, ship = 2 * tauHalf + coastTau;
      const peakBeta = Math.tanh(a * tauHalf / C);
      lines.push(`Ship (crew) time: ${fmtH(ship / 3600)}`);
      lines.push(`Outside-world time: ${fmtH(world / 3600)}`);
      lines.push(`Peak speed ${(peakBeta * 100).toFixed(3)}% of light`);
      return { hours: ship / 3600, worldHours: world / 3600, lines };
    }
    if (mode === 'ftl') {
      if (q.ftl_kind === 'fixed') {
        const h = n('fixed_hours');
        if (!(h > 0)) throw new Error('Enter the jump duration');
        lines.push(`Fixed-duration jump: ${fmtH(h)}`);
        return { hours: h, lines };
      }
      const dist = n('distance'), rate = n('rate');
      if (!(dist > 0 && rate > 0)) throw new Error('Enter a distance and an FTL speed');
      const days = dist / rate;
      lines.push(`${dist} LY at ${rate} LY/day: ${fmtH(days * 24)}`);
      return { hours: days * 24, lines };
    }
    throw new Error('Unknown travel mode');
  }
  function fmtDuration(h) {
    if (!isFinite(h)) return '∞';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    const d = h / 24;
    if (d < 365 * 2) return `${d.toFixed(1)} days`;
    return `${(d / 365.25).toFixed(2)} years (${Math.round(d).toLocaleString()} days)`;
  }
  /** hours -> number of slots (shifts or hours), using the calendar's day length (default 24 h) */
  function hoursToShifts(cal, h) {
    return Math.max(0, Math.round(h / slotHours(cal)));
  }

  // ---------------------------------------------------------------- presets
  // Astronomical seasons: the usual equinox and solstice dates (usno). Month indexes are 0-based.
  const GREGORIAN_SEASONS = {
    north: [
      { name: 'Spring', type: 'spring', month: 2, day: 20 }, { name: 'Summer', type: 'summer', month: 5, day: 21 },
      { name: 'Autumn', type: 'autumn', month: 8, day: 22 }, { name: 'Winter', type: 'winter', month: 11, day: 21 }],
    south: [
      { name: 'Autumn', type: 'autumn', month: 2, day: 20 }, { name: 'Winter', type: 'winter', month: 5, day: 21 },
      { name: 'Spring', type: 'spring', month: 8, day: 22 }, { name: 'Summer', type: 'summer', month: 11, day: 21 }],
  };
  /** Preset regions from [name, Köppen code, terrain visibility modifier] rows; the first is where the party starts. */
  const koppenRegions = (hemisphere, rows) => rows.map(([name, code, terrain = 0], i) => ({
    name, ...(i ? {} : { current: true }),
    settings: { climate: `koppen:${code}`, hemisphere, lighting: 'natural', terrain_mod: terrain },
  }));
  // Real-world regions for the Gregorian presets, each listed under the hemisphere it lies in. Regions that
  // straddle the equator (the Amazon and Congo basins, the East African highlands) sit with the south, where most of them lie.
  const EARTH_REGIONS = {
    north: [
      ['Central Europe (Germany, the Low Countries)', 'Cfb'], ['British Isles & northern France', 'Cfb'],
      ['Mediterranean Europe (Spain, Italy, Greece)', 'Csa'], ['Eastern Europe (Poland, Ukraine, western Russia)', 'Dfb'],
      ['Southern Scandinavia (Oslo, Stockholm)', 'Dfb'], ['Northern Scandinavia & the Siberian taiga', 'Dfc'],
      ['Eastern Siberia (Yakutsk)', 'Dfd'], ['Arctic tundra (Svalbard, northern Canada, Alaska North Slope)', 'ET', 1],
      ['Eastern US: Northeast & Midwest (Boston, Chicago)', 'Dfa'], ['Eastern US: Mid-Atlantic & Southeast (Washington, Atlanta)', 'Cfa'],
      ['Southern Florida', 'Am'], ['Great Plains & Rocky Mountain foothills (Denver)', 'BSk'],
      ['US Southwest deserts (Phoenix, Mojave)', 'BWh', 1], ['US West Coast (coastal California, Pacific Northwest)', 'Csb'],
      ['Southern Canada (Toronto, Montreal, the Prairies)', 'Dfb'], ['Canadian boreal forest & interior Alaska', 'Dfc'],
      ['Mexican highlands (Mexico City)', 'Cwb'], ['Caribbean & Central America', 'Aw'],
      ['Sahara', 'BWh', 1], ['Sahel (Mali, Niger, Chad)', 'BSh'], ['West Africa (Lagos, Accra)', 'Aw'],
      ['Ethiopian Highlands', 'Cwb'], ['Arabian Peninsula', 'BWh', 1], ['Iranian plateau & Anatolian interior', 'BSk'],
      ['Central Asian steppe (Kazakhstan)', 'BSk'], ['Northern India (Delhi, the Ganges plain)', 'Cwa'],
      ['Southern India', 'Aw'], ['Tibetan Plateau', 'Dwc'], ['Mongolia', 'Dwc'],
      ['Northern China & Korea (Beijing, Seoul)', 'Dwa'], ['Eastern China (Shanghai, the Yangtze valley)', 'Cfa'],
      ['Southern China (Guangzhou, Hong Kong)', 'Cwa'], ['Japan (Honshu, Kyushu)', 'Cfa'],
      ['Mainland Southeast Asia (Thailand, Vietnam, Myanmar)', 'Aw'], ['Malay Peninsula & Singapore', 'Af', -2]],
    south: [
      ['Southeast Australia (Melbourne, Tasmania)', 'Cfb'], ['Eastern Australia (Sydney, Brisbane)', 'Cfa'],
      ['Southwest Australia (Perth)', 'Csa'], ['Northern Australia (Darwin, the Top End)', 'Aw'],
      ['Australian Outback', 'BWh', 1], ['New Zealand', 'Cfb'], ['Java & Bali', 'Am'], ['New Guinea', 'Af', -2],
      ['Amazon Basin', 'Af', -2], ['Brazilian Cerrado & Rio de Janeiro', 'Aw'],
      ['Southern Brazil, Uruguay & the Pampas (Buenos Aires)', 'Cfa'], ['Andean Altiplano (La Paz, Lake Titicaca)', 'Cwc'],
      ['Central Chile (Santiago)', 'Csb'], ['Patagonia', 'BWk'], ['Tierra del Fuego', 'Cfc'],
      ['Congo Basin', 'Af', -2], ['East African Highlands (Nairobi, Lake Victoria)', 'Cwb'],
      ['Southern African savanna (Zambia, Zimbabwe, Mozambique)', 'Aw'], ['Highveld (Johannesburg)', 'Cwb'],
      ['Kalahari', 'BSh', 1], ['Western Cape (Cape Town)', 'Csb'], ['Antarctica', 'EF', 1]],
  };
  function gregorianPreset(hemisphere) {
    const north = hemisphere === 'north';
    return {
      label: `Gregorian (real-world, ${north ? 'Northern' : 'Southern'} Hemisphere)`,
      calendar: {
        name: 'Gregorian', epochYear: 1, yearSuffix: '', weekdayOffset: 1, lighting: 'natural', hemisphere,
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        months: [
          { name: 'January', days: 31 }, { name: 'February', days: 28, leapDays: 1 }, { name: 'March', days: 31 },
          { name: 'April', days: 30 }, { name: 'May', days: 31 }, { name: 'June', days: 30 },
          { name: 'July', days: 31 }, { name: 'August', days: 31 }, { name: 'September', days: 30 },
          { name: 'October', days: 31 }, { name: 'November', days: 30 }, { name: 'December', days: 31 }],
        leap: { every: 4, skip: 100, unskip: 400 },
        seasons: GREGORIAN_SEASONS[hemisphere],
        // mean synodic month, and reference = a known new moon (6 Jan 2000, 18:14 UTC) as an absolute day (phases)
        moons: [{ name: 'Moon', cycle: 29.530588, ref: 730124.76, brightness: 1, color: '#e8e4d8' }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 2026, month: 9, day: 16 },
      regions: koppenRegions(hemisphere, EARTH_REGIONS[hemisphere]),
      holidays: [
        { name: "New Year's Day", color: '#4a90d9', rule: { type: 'fixed', month: 0, day: 1, span: 1 } },
        { name: 'Thanksgiving (US)', color: '#c0632b', rule: { type: 'nth_weekday', month: 10, weekday: 4, n: 4, span: 1 } },
        { name: 'Christmas Eve & Day', color: '#2e8b57', rule: { type: 'fixed', month: 11, day: 24, span: 2 } },
      ],
      settings: { genre: 'modern', time_unit: 'day', temp_unit: north ? 'F' : 'C' },
    };
  }

  const PRESETS = {
    gregorian: gregorianPreset('north'),
    gregorian_south: gregorianPreset('south'),

    imperial: {
      label: 'Imperial Calendar (Warhammer Fantasy)',
      calendar: {
        name: 'Imperial Calendar', epochYear: 0, yearSuffix: 'IC', weekdayOffset: 0, lighting: 'natural',
        weekdays: ['Wellentag', 'Aubentag', 'Marktag', 'Backertag', 'Bezahltag', 'Konistag', 'Angestag', 'Festag'],
        months: [
          { name: 'Hexenstag', days: 1, intercalary: true },
          { name: 'Nachexen', days: 32 }, { name: 'Jahrdrung', days: 33 },
          { name: 'Mitterfruhl', days: 1, intercalary: true },
          { name: 'Pflugzeit', days: 33 }, { name: 'Sigmarzeit', days: 33 }, { name: 'Sommerzeit', days: 33 },
          { name: 'Sonnstill', days: 1, intercalary: true },
          { name: 'Vorgeheim', days: 33 },
          { name: 'Geheimnistag', days: 1, intercalary: true },
          { name: 'Nachgeheim', days: 32 }, { name: 'Erntezeit', days: 33 },
          { name: 'Mittherbst', days: 1, intercalary: true },
          { name: 'Brauzeit', days: 33 }, { name: 'Kaldezeit', days: 33 }, { name: 'Ulriczeit', days: 33 },
          { name: 'Mondstille', days: 1, intercalary: true },
          { name: 'Vorhexen', days: 33 }],
        leap: null,
        hemisphere: 'north',
        // first days of the seasons per the Imperial Calendar: Nachexen 17, Sigmarzeit 18, Nachgeheim 17, Kaldezeit 18
        seasons: [
          { name: 'Spring', type: 'spring', month: 1, day: 17 }, { name: 'Summer', type: 'summer', month: 5, day: 18 },
          { name: 'Autumn', type: 'autumn', month: 10, day: 17 }, { name: 'Winter', type: 'winter', month: 14, day: 18 }],
        moons: [
          { name: 'Mannslieb', cycle: 25, ref: 0, brightness: 1, color: '#e8e4d8' },
          { name: 'Morrslieb', cycle: 31, ref: 7, brightness: 0.5, color: '#9fd27a', erratic: true }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 2522, month: 4, day: 1 },
      // No open data exists for a fictional world. Each region takes the Köppen climate (beck) of its real-world
      // analogue, a judgement call: the Empire is Germany shading into
      // Poland and Romania eastward, Bretonnia France, Estalia Spain, Tilea Italy, Kislev Russia and Ukraine.
      // Regions marked * are judgement calls where the analogue isn't settled or the region spans a climate border.
      regions: koppenRegions('north', [
        ['Reikland', 'Cfb'], ['Middenland', 'Cfb'], ['Drakwald Forest', 'Cfb', -1], ['Nordland', 'Cfb'],
        ['Wasteland & Marienburg', 'Cfb'], ['Wissenland', 'Cfb'],
        ['Hochland', 'Dfb'], // *
        ['Talabecland', 'Dfb'], // *
        ['Great Forest', 'Dfb', -1], // *
        ['Middle Mountains', 'Dfc'], // * uplands colder than the lowlands around them
        ['Ostland', 'Dfb'],
        ['Averland', 'Dfb'], // * Bavaria and Austria sit on the Cfb/Dfb line
        ['Stirland', 'Dfb'], ['The Moot', 'Dfb'], ['Sylvania', 'Dfb'], ['Ostermark', 'Dfb'],
        ['Kislev', 'Dfb'], ['Troll Country', 'Dfc'], ['Northern Wastes', 'ET', 1],
        ["Bretonnia: Couronne & the north (L'Anguille, Lyonesse, Artois)", 'Cfb'],
        ['Bretonnia: Bordeleaux & Aquitaine', 'Cfb'],
        ['Bretonnia: Brionne, Quenelles & Carcassonne', 'Csa'], // * Provence and Languedoc
        ['Grey Mountains', 'Dfc'], // * the Alps below the snowline
        ['Black Mountains', 'Dfc'], // *
        ["World's Edge Mountains (high passes)", 'ET'], // *
        ['Estalia', 'Csa'], ['Tilea', 'Csa'],
        ['Border Princes', 'Cfa'], // * the Balkans
        ['Badlands', 'BSk'], // *
      ]),
      // the Important Dates list on the Imperial Calendar sheet; month indexes count the intercalary days
      holidays: [
        { name: 'Hexenstag (Witching Day)', color: '#7b4fa0', rule: { type: 'fixed', month: 0, day: 1, span: 1 }, description: 'Morr. Start of the New Year.' },
        { name: 'Year Blessing', color: '#4a90d9', rule: { type: 'fixed', month: 1, day: 1, span: 1 }, description: 'Verena.' },
        { name: 'Mitterfruhl (Spring Equinox)', color: '#2e8b57', rule: { type: 'fixed', month: 3, day: 1, span: 1 }, description: 'Manaan, Taal, Ulric.' },
        { name: 'First Quaff', color: '#8b5a2b', rule: { type: 'fixed', month: 4, day: 33, span: 1 }, description: 'Dwarf Gods.' },
        { name: 'Sigmarsfest', color: '#b8860b', rule: { type: 'fixed', month: 5, day: 18, span: 1 }, description: 'Sigmar.' },
        { name: 'Sonnstill (Summer Solstice)', color: '#2e8b57', rule: { type: 'fixed', month: 7, day: 1, span: 1 }, description: 'Taal, Rhya, Elf Gods.' },
        { name: 'Saga', color: '#8b5a2b', rule: { type: 'fixed', month: 8, day: 33, span: 1 }, description: 'Dwarf Gods.' },
        { name: 'Geheimnisnacht (Mystery Night)', color: '#7b4fa0', rule: { type: 'fixed', month: 8, day: 33, span: 1 }, description: 'The night before Geheimnistag.' },
        { name: 'Geheimnistag (Day of Mystery)', color: '#7b4fa0', rule: { type: 'fixed', month: 9, day: 1, span: 1 }, description: 'Morr.' },
        { name: 'Pie Week', color: '#c0632b', rule: { type: 'fixed', month: 11, day: 1, span: 8 }, description: 'Halfling Gods.' },
        { name: 'Mittherbst (Autumn Equinox)', color: '#2e8b57', rule: { type: 'fixed', month: 12, day: 1, span: 1 }, description: 'Rhya, Taal, Ulric.' },
        { name: 'Second Breech', color: '#8b5a2b', rule: { type: 'fixed', month: 13, day: 33, span: 1 }, description: 'Dwarf Gods.' },
        { name: 'Mondstille (Winter Solstice)', color: '#2e8b57', rule: { type: 'fixed', month: 16, day: 1, span: 1 }, description: 'Ulric, Taal, Rhya.' },
        { name: 'Keg End', color: '#8b5a2b', rule: { type: 'fixed', month: 17, day: 33, span: 1 }, description: 'Dwarf Gods.' },
        { name: 'Hexensnacht (Witching Night)', color: '#7b4fa0', rule: { type: 'fixed', month: 17, day: 33, span: 1 }, description: 'The night before Hexenstag; both moons are said to be full.' },
      ],
      settings: { genre: 'fantasy', time_unit: 'day', temp_unit: 'C' },
    },

    middleearth: {
      label: 'Middle-earth (Shire Reckoning, Third Age)',
      calendar: {
        // Shire Reckoning (LotR Appendix D). S.R. year + 1600 = Third Age year (1418 S.R. = T.A. 3018).
        // 2 Yule is always Sterday: Mid-year's Day and Overlithe sit outside the week, so every date keeps its weekday.
        name: 'Shire Reckoning', epochYear: 1, yearSuffix: 'S.R.', weekdayOffset: 0, lighting: 'natural', hemisphere: 'north',
        weekdays: ['Sterday', 'Sunday', 'Monday', 'Trewsday', 'Hevensday', 'Mersday', 'Highday'],
        months: [
          { name: '2 Yule', days: 1, intercalary: true, keepWeekday: true },
          { name: 'Afteryule', days: 30 }, { name: 'Solmath', days: 30 }, { name: 'Rethe', days: 30 },
          { name: 'Astron', days: 30 }, { name: 'Thrimidge', days: 30 }, { name: 'Forelithe', days: 30 },
          { name: '1 Lithe', days: 1, intercalary: true, keepWeekday: true },
          { name: "Mid-year's Day", days: 1, intercalary: true },
          { name: 'Overlithe', days: 0, leapDays: 1, intercalary: true },
          { name: '2 Lithe', days: 1, intercalary: true, keepWeekday: true },
          { name: 'Afterlithe', days: 30 }, { name: 'Wedmath', days: 30 }, { name: 'Halimath', days: 30 },
          { name: 'Winterfilth', days: 30 }, { name: 'Blotmath', days: 30 }, { name: 'Foreyule', days: 30 },
          { name: '1 Yule', days: 1, intercalary: true, keepWeekday: true }],
        // Overlithe every fourth year, except the last year of a century
        leap: { every: 4, skip: 100, unskip: 0 },
        // Shire dates run about ten days ahead of ours: Rethe 29 ≈ 20 March, Mid-year's Day ≈ 21 June, Winterfilth 2 ≈ 22 September, 1 Yule ≈ 20 December
        seasons: [
          { name: 'Spring', type: 'spring', month: 3, day: 29 }, { name: 'Summer', type: 'summer', month: 8, day: 1 },
          { name: 'Autumn', type: 'autumn', month: 14, day: 2 }, { name: 'Winter', type: 'winter', month: 17, day: 1 }],
        // a real-world synodic month; the phases are not matched to the dates in the books
        moons: [{ name: 'Moon', cycle: 29.530588, ref: 0, brightness: 1, color: '#e8e4d8' }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 1418, month: 13, day: 23 }, // Frodo leaves Bag End
      // No open data exists for a fictional world. Climates were first taken from a fan Köppen map of Middle-earth
      // (imaginarymaps, not openly licensed) and fit Tolkien's own latitude anchors (letter294): the Shire at
      // Oxford's latitude (Cfb), Minas Tirith at Florence's. Umbar and Far Harad lie south of that map, so theirs are inferred.
      regions: koppenRegions('north', [
        ['The Shire', 'Cfb', 0], ['Bree-land', 'Cfb', 0], ['Old Forest', 'Cfb', -1], ['Lindon & the Grey Havens', 'Cfb', 0],
        ['Eriador wilds (Lone-lands, Weathertop)', 'Cfb', 0], ['Dunland', 'Cfb', 0],
        ['Rhudaur & the Trollshaws', 'Dfb', 0], ['Rivendell', 'Dfb', -1],
        ['Misty Mountains (high passes)', 'ET', 0], ['Angmar & the Ettenmoors', 'Dfc', 0], ['Forodwaith', 'ET', 1],
        ['Lothlórien', 'Dfb', -1], ['Fangorn Forest', 'Dfb', -1], ['Rohan', 'Dfb', 0], ['Mirkwood', 'Dfb', -2],
        ['Dale & Erebor', 'Dfc', 0], ['Iron Hills', 'Dfc', 0], ['Rhûn', 'BSk', 0],
        ['Anórien', 'Dfa', 0], ['Minas Tirith & Lossarnach', 'Csa', 0], ['Ithilien', 'Csa', -1],
        ['Lebennin & Belfalas (Dol Amroth)', 'Csa', 0], ['South Gondor (Harondor)', 'BSh', 0],
        ['Mordor: Gorgoroth', 'BWk', 0], ['Mordor: Nurn', 'BWk', 0], ['Umbar', 'BWh', 0],
        ['Near Harad', 'BWh', 1], ['Far Harad', 'Aw', 0],
      ]),
      holidays: [
        { name: 'Yule', color: '#2e8b57', rule: { type: 'fixed', month: 17, day: 1, span: 2 }, description: 'The two Yuledays: the old year ends on 1 Yule and the new one begins on 2 Yule.' },
        // Lithe is two entries so 2 Lithe is covered whether or not an Overlithe falls before it
        { name: 'Lithe', color: '#d9a441', rule: { type: 'fixed', month: 7, day: 1, span: 2 }, description: 'Midsummer holiday: 1 Lithe, Mid-year\'s Day, Overlithe in leap years, and 2 Lithe. The Free Fair is held on the White Downs.' },
        { name: 'Lithe', color: '#d9a441', rule: { type: 'fixed', month: 10, day: 1, span: 1 }, description: 'Midsummer holiday: 1 Lithe, Mid-year\'s Day, Overlithe in leap years, and 2 Lithe. The Free Fair is held on the White Downs.' },
        { name: 'Overlithe', color: '#d9a441', rule: { type: 'fixed', month: 9, day: 1, span: 1 }, description: 'The leap day, a special holiday added after Mid-year\'s Day.' },
        { name: 'Birthday of Bilbo and Frodo', color: '#c0632b', rule: { type: 'fixed', month: 13, day: 22, span: 1 } },
      ],
      settings: { genre: 'fantasy', time_unit: 'day', temp_unit: 'C' },
    },

    shipclock: {
      label: 'Starship clock (Standard Ship Time)',
      calendar: {
        name: 'Standard Ship Time', epochYear: 1, yearSuffix: '', dateFormat: '{W} · {M}, Day {d} · Mission Year {Y}', weekdayOffset: 0, lighting: 'artificial',
        lightLevels: [4, 5, 4, 2],
        weekdays: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
        months: Array.from({ length: 10 }, (_, i) => ({ name: `Cycle ${i + 1}`, days: 36 })),
        leap: null, seasons: [], moons: [],
        shiftNames: ['Morning Watch', 'Day Watch', 'Evening Watch', 'Night Watch'],
      },
      start: { year: 1, month: 0, day: 1 },
      regions: [
        { name: 'Ship interior', current: true, settings: { climate: 'ship', lighting: 'artificial', light_levels: [4, 5, 4, 2], terrain_mod: 0 } },
        { name: 'EVA / hull exterior', settings: { climate: 'vacuum', lighting: 'artificial', light_levels: [1, 1, 1, 1], terrain_mod: 0 } }],
      holidays: [
        { name: 'Launch Day', color: '#4a90d9', rule: { type: 'fixed', month: 0, day: 1, span: 1 } },
        { name: 'Shore leave rotation', color: '#2e8b57', rule: { type: 'every_n', start: 30, interval: 60, span: 3 } }],
      settings: { genre: 'scifi', time_unit: 'week', temp_unit: 'C' },
    },

    custom: {
      label: 'Custom (choose your own months and their lengths)',
      calendar: {
        name: 'Custom calendar', epochYear: 1, yearSuffix: '', weekdayOffset: 0, lighting: 'natural',
        weekdays: ['Firstday', 'Seconday', 'Thirdday', 'Fourthday', 'Fifthday', 'Sixthday', 'Restday'],
        months: Array.from({ length: 12 }, (_, i) => ({ name: `Month ${i + 1}`, days: 30 })),
        leap: null,
        seasons: [
          { name: 'Spring', type: 'spring', month: 2, day: 1 }, { name: 'Summer', type: 'summer', month: 5, day: 1 },
          { name: 'Autumn', type: 'autumn', month: 8, day: 1 }, { name: 'Winter', type: 'winter', month: 11, day: 1 }],
        moons: [{ name: 'Moon', cycle: 28, ref: 0, brightness: 1, color: '#e8e4d8' }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 1, month: 0, day: 1 },
      regions: [{ name: 'Home region', current: true, settings: { climate: 'temperate', hemisphere: 'north', lighting: 'natural', terrain_mod: 0 } }],
      holidays: [],
      settings: { time_unit: 'day', temp_unit: 'C' },
    },
  };

  const Engine = {
    SHIFT_KEYS, SHIFT_ACTIONS, SHIFT_ACTION_GROUPS, addShiftAction, VIS_LABELS, WEATHER, WIND, CLIMATES, PRESETS,
    prep, shiftNames, quarterNames, TIME_MODES, timeMode, slotsPerDay, slotHours, slotWord, slotQuarter, slotsFromQuarters, isLeap, yearStart, yearLength, monthLength, fromAbs, toAbs, weekday, weekLength,
    yearLabel, fmtDate, fmtShift, addMonths, SEASON_TYPES, season, seasonStarts, monthSeasons, moons, moonPhase, holidaysOn, holidayActive,
    genWeather, shiftWeather, weatherLabel, TEMP_UNITS, fmtTemp, toTempUnit, fromTempUnit, visibility, climateFor, mod,
    KOPPEN, KOPPEN_GROUPS, KOPPEN_LETTERS, KOPPEN_SEASONS, WET_LABELS, koppenBase, koppenClimate, koppenCode, buildClimate, baselineWeights, describeBaseline,
    travel, fmtDuration, hoursToShifts, SOURCES, SPEEDS, SYSTEMS, DIST_UNITS, GENRES, SPEED_MODES, GENRE_MODES, genreOf, speedSamples, spaceDistances, STARS, starDistance,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
