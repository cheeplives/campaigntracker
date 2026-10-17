/*
 * Campaign Tracker engine: calendar math, moons, seasons, holidays, weather and visibility.
 * Pure functions with no DOM access, so the same file can be tested in Node.
 *
 * Time model: every in-game day has an integer "absolute day" (day 0 = first day of the
 * calendar's epoch year). A day has 4 shifts: 0 Overnight, 1 Dawn, 2 Noon, 3 Dusk.
 * The campaign "now" is stored as an absolute shift = absDay * 4 + shift.
 */
(function (root) {
  'use strict';

  const SHIFT_KEYS = ['overnight', 'dawn', 'noon', 'dusk'];
  const DEFAULT_SHIFT_NAMES = ['Overnight', 'Dawn', 'Noon', 'Dusk'];
  const VIS_LABELS = ['Pitch black', 'Very dark', 'Dim', 'Fair', 'Good', 'Bright'];
  const MOON_PHASES = [
    ['New', '🌑'], ['Waxing crescent', '🌒'], ['First quarter', '🌓'], ['Waxing gibbous', '🌔'],
    ['Full', '🌕'], ['Waning gibbous', '🌖'], ['Last quarter', '🌗'], ['Waning crescent', '🌘'],
  ];

  // Baseline things a party can spend a shift doing, drawn from the travel rules of the
  // Year Zero Engine SRD (one task per character per shift) and The Perilous Wilds
  // (travel roles, camp and provisions). The GM picks them into a shift's activity text,
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
  function shiftNames(cal) {
    const n = cal.shiftNames || [];
    return DEFAULT_SHIFT_NAMES.map((d, i) => n[i] || d);
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
    const d = Math.floor(absShift / 4), s = mod(absShift, 4);
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

  // Temperatures in °C: [typical low, typical high] for the day's high.
  const CLIMATES = {
    temperate: { label: 'Temperate', persistence: 0.45, seasons: {
      spring: { t: [4, 16], w: { clear: 3, partly: 3, overcast: 2, drizzle: 2, rain: 1, storm: 0.5, fog: 1 } },
      summer: { t: [14, 28], w: { clear: 5, partly: 3, overcast: 1, drizzle: 1, rain: 0.5, storm: 1, fog: 0.3, haze: 0.4 } },
      autumn: { t: [5, 17], w: { clear: 2, partly: 3, overcast: 3, drizzle: 2, rain: 1.5, storm: 0.3, fog: 2 } },
      winter: { t: [-6, 5], w: { clear: 2, partly: 2, overcast: 3, drizzle: 1, rain: 1, fog: 1.5, snow: 2, heavysnow: 1, blizzard: 0.3 } },
      any:    { t: [4, 18], w: { clear: 3, partly: 3, overcast: 2, drizzle: 2, rain: 1, storm: 0.5, fog: 1 } } } },
    arctic: { label: 'Arctic / tundra', persistence: 0.55, seasons: {
      spring: { t: [-15, -2], w: { clear: 3, partly: 2, overcast: 3, snow: 3, heavysnow: 1, blizzard: 1, fog: 1 } },
      summer: { t: [0, 12], w: { clear: 3, partly: 3, overcast: 3, drizzle: 2, rain: 1, fog: 2 } },
      autumn: { t: [-10, 2], w: { clear: 2, partly: 2, overcast: 3, snow: 3, heavysnow: 1.5, blizzard: 0.7, fog: 1 } },
      winter: { t: [-35, -15], w: { clear: 3, partly: 2, overcast: 2, snow: 2, heavysnow: 1, blizzard: 2 } },
      any:    { t: [-20, -2], w: { clear: 3, partly: 2, overcast: 3, snow: 3, heavysnow: 1, blizzard: 1 } } } },
    desert: { label: 'Desert', persistence: 0.6, seasons: {
      spring: { t: [15, 32], w: { clear: 6, partly: 2, haze: 2, sandstorm: 0.8, overcast: 0.3, drizzle: 0.1 } },
      summer: { t: [25, 45], w: { clear: 7, haze: 3, sandstorm: 1, partly: 1 } },
      autumn: { t: [15, 33], w: { clear: 6, partly: 2, haze: 1.5, sandstorm: 0.8 } },
      winter: { t: [5, 22], w: { clear: 6, partly: 2, overcast: 1, drizzle: 0.3, sandstorm: 0.5 } },
      any:    { t: [15, 35], w: { clear: 6, partly: 2, haze: 2, sandstorm: 0.8 } } } },
    tropical: { label: 'Tropical / jungle', persistence: 0.4, seasons: {
      spring: { t: [24, 32], w: { clear: 3, partly: 3, rain: 2, storm: 1.5, drizzle: 1 } },
      summer: { t: [25, 33], w: { partly: 2, rain: 3, storm: 3, overcast: 2, clear: 1 } },
      autumn: { t: [24, 32], w: { partly: 3, rain: 2, storm: 2, clear: 2 } },
      winter: { t: [22, 30], w: { clear: 4, partly: 3, drizzle: 1, rain: 0.5, fog: 0.5 } },
      any:    { t: [24, 32], w: { clear: 3, partly: 3, rain: 2, storm: 1.5, drizzle: 1 } } } },
    mountain: { label: 'Mountains / highlands', persistence: 0.4, seasons: {
      spring: { t: [-5, 10], w: { clear: 3, partly: 2, overcast: 2, snow: 2, drizzle: 1, fog: 2, storm: 0.5 } },
      summer: { t: [5, 20], w: { clear: 4, partly: 3, storm: 1.5, rain: 1, fog: 1.5, hail: 0.3 } },
      autumn: { t: [-5, 10], w: { clear: 3, partly: 2, overcast: 2, fog: 2, snow: 2, drizzle: 1 } },
      winter: { t: [-25, -5], w: { clear: 2, partly: 2, overcast: 2, snow: 3, heavysnow: 2, blizzard: 1.5, fog: 1 } },
      any:    { t: [-5, 12], w: { clear: 3, partly: 2, overcast: 2, snow: 1, drizzle: 1, fog: 2 } } } },
    maritime: { label: 'Coastal / maritime', persistence: 0.45, seasons: {
      spring: { t: [6, 14], w: { partly: 3, overcast: 3, drizzle: 3, rain: 1.5, fog: 2.5, clear: 2, storm: 0.5 } },
      summer: { t: [12, 22], w: { clear: 3, partly: 3, fog: 2, drizzle: 1, overcast: 2, storm: 0.5 } },
      autumn: { t: [7, 15], w: { overcast: 3, rain: 2.5, storm: 1.5, drizzle: 2, fog: 2, partly: 2 } },
      winter: { t: [0, 9], w: { overcast: 3, rain: 3, storm: 2, drizzle: 2, snow: 0.5, fog: 1.5 } },
      any:    { t: [8, 16], w: { partly: 3, overcast: 3, drizzle: 2, rain: 1.5, fog: 2, clear: 2, storm: 0.7 } } } },
    swamp: { label: 'Swamp / marsh', persistence: 0.5, seasons: {
      spring: { t: [8, 20], w: { fog: 4, overcast: 3, drizzle: 3, rain: 1, partly: 2, clear: 1 } },
      summer: { t: [18, 32], w: { fog: 2, haze: 2, partly: 3, storm: 1.5, rain: 1, clear: 2 } },
      autumn: { t: [8, 20], w: { fog: 5, overcast: 3, drizzle: 3, rain: 1, partly: 1 } },
      winter: { t: [-2, 8], w: { fog: 4, overcast: 3, drizzle: 2, snow: 1, rain: 1 } },
      any:    { t: [10, 22], w: { fog: 4, overcast: 3, drizzle: 3, rain: 1, partly: 2 } } } },
    underground: { label: 'Underground', persistence: 0.7, seasons: {
      any: { t: [8, 14], w: { still: 6, damp: 3, drafty: 2, dust: 0.4 } } } },
    ship: { label: 'Starship interior', persistence: 0.7, seasons: {
      any: { t: [19, 23], w: { nominal: 20, flicker: 2, nebula: 1, ionstorm: 0.8, redalert: 0.4, radiation: 0.4, blackout: 0.15 } } } },
    vacuum: { label: 'Open space / airless body', persistence: 0.6, seasons: {
      any: { t: [-150, 120], w: { nominal: 12, flare: 1, debris: 1, ionstorm: 0.5, radiation: 0.8 } } } },
  };

  // ---------------------------------------------------------------- Köppen climates
  // Baselines per Köppen–Geiger code, one entry per season (winter, spring, summer, autumn):
  // [low, high] = range of typical daytime highs in °C; wet 0–5 (0 arid … 5 torrential);
  // storm / fog / dust 0–3 (how often thunderstorms or blizzards, fog, and dust storms turn up).
  // Figures are rounded from representative stations (WorldClim / openclimatemap.org monthly normals).
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
    Af:  { label: 'Tropical rainforest', where: 'Singapore, Amazon basin, Congo basin', s: [sb(28, 32, 4, 2.5, 1), sb(28, 33, 4, 2.5, 1), sb(28, 32, 4.5, 3, 1), sb(28, 32, 4, 2.5, 1)] },
    Am:  { label: 'Tropical monsoon', where: 'Miami, Kerala, Myanmar coast', s: [sb(27, 31, 1.5, 0.5), sb(29, 34, 2, 1.5), sb(27, 31, 4.5, 3), sb(28, 32, 3, 2)] },
    Aw:  { label: 'Tropical savanna (dry winter)', where: 'Darwin, Lagos, Bangkok, Rio de Janeiro', s: [sb(28, 33, 0.5, 0, 0.5, 0.5), sb(31, 36, 1.5, 1.5, 0, 0.5), sb(29, 33, 4, 3), sb(29, 33, 2.5, 2)] },
    As:  { label: 'Tropical savanna (dry summer)', where: 'Chennai, Mombasa, Hawaii leeward coasts', s: [sb(27, 31, 3.5, 1.5), sb(30, 34, 1.5, 1), sb(30, 35, 0.5, 0.5, 0, 0.5), sb(28, 32, 2.5, 1.5)] },
    BWh: { label: 'Hot desert', where: 'Cairo, Dubai, Phoenix, the Sahara', s: [sb(18, 25, 0.3, 0, 0.5, 1), sb(26, 35, 0.15, 0.2, 0, 1.5), sb(35, 44, 0.1, 0.3, 0, 2), sb(27, 36, 0.15, 0.2, 0, 1)] },
    BWk: { label: 'Cold desert', where: 'Gobi, Ladakh, Great Basin, Patagonia', s: [sb(-5, 6, 0.3, 0, 0.5, 0.5), sb(10, 22, 0.4, 0.3, 0, 1.5), sb(24, 34, 0.3, 0.5, 0, 1), sb(8, 20, 0.3, 0.2, 0, 1)] },
    BSh: { label: 'Hot semi-arid steppe', where: 'Sahel, Alice Springs, Karachi, Monterrey', s: [sb(20, 27, 0.4, 0, 0.3, 1), sb(28, 36, 0.5, 0.5, 0, 1.5), sb(32, 39, 1.3, 1.5, 0, 1), sb(27, 34, 0.7, 0.7, 0, 0.5)] },
    BSk: { label: 'Cold semi-arid steppe', where: 'Denver, Madrid outskirts, Kazakh steppe, Ulaanbaatar plains', s: [sb(0, 9, 0.7, 0, 0.5, 0.3), sb(12, 22, 1, 1, 0, 0.7), sb(25, 33, 0.8, 1.5, 0, 0.5), sb(12, 22, 0.7, 0.3, 0.3, 0.3)] },
    Csa: { label: 'Hot-summer Mediterranean', where: 'Athens, Seville, Rome, Los Angeles inland', s: [sb(12, 17, 2.5, 0.5, 1), sb(19, 26, 1.2, 0.5, 0.3), sb(30, 36, 0.15, 0.3), sb(21, 28, 1.5, 0.7, 0.3)] },
    Csb: { label: 'Warm-summer Mediterranean', where: 'San Francisco, Porto, Cape Town', s: [sb(12, 16, 3, 0.3, 1.5), sb(16, 21, 1.5, 0.2, 1.5), sb(20, 26, 0.3, 0, 2.5), sb(17, 23, 1.5, 0.2, 2)] },
    Csc: { label: 'Cold-summer Mediterranean', where: 'Highlands of the Cascades and Andes', s: [sb(2, 7, 3, 0.5, 1.5), sb(6, 12, 2, 0.3, 1.5), sb(12, 17, 0.4, 0.2, 1), sb(7, 12, 2, 0.3, 1.5)] },
    Cwa: { label: 'Monsoon-influenced humid subtropical', where: 'Hong Kong, Delhi, Guangzhou', s: [sb(16, 22, 0.4, 0, 1, 0.3), sb(24, 32, 1.5, 1.5, 0.5), sb(30, 34, 4.5, 3), sb(24, 30, 2, 1.5)] },
    Cwb: { label: 'Subtropical highland', where: 'Mexico City, Johannesburg, Bogotá-style highlands', s: [sb(18, 22, 0.3, 0, 0.5, 0.3), sb(22, 27, 1.5, 1.5), sb(21, 25, 3.5, 2.5, 0.5), sb(20, 24, 1.5, 1, 0.5)] },
    Cwc: { label: 'Cold subtropical highland', where: 'High Andean and Himalayan valleys', s: [sb(8, 13, 0.3, 0, 1), sb(12, 17, 1.5, 1), sb(12, 16, 3, 2, 1.5), sb(10, 15, 1.5, 0.5, 1)] },
    Cfa: { label: 'Humid subtropical', where: 'Atlanta, Shanghai, Buenos Aires, Sydney', s: [sb(7, 14, 2.5, 0.3, 1), sb(17, 25, 2.5, 1.5, 0.5), sb(29, 33, 3, 2.5, 0.3), sb(17, 26, 2.3, 1, 1)] },
    Cfb: { label: 'Temperate oceanic', where: 'London, Paris, Melbourne, Seattle', s: [sb(5, 10, 3, 0.2, 2), sb(11, 18, 2.5, 0.5, 1), sb(19, 25, 2, 1, 0.5), sb(11, 18, 3, 0.5, 2)] },
    Cfc: { label: 'Subpolar oceanic', where: 'Faroe Islands, Reykjavík coast, Tierra del Fuego', s: [sb(1, 5, 3.5, 0.8, 1.5), sb(4, 9, 3, 0.3, 1.5), sb(10, 14, 3, 0.2, 2), sb(5, 10, 3.5, 0.8, 1.5)] },
    Dsa: { label: 'Hot-summer continental (dry summer)', where: 'Hakkari, eastern Anatolia, Utah valleys', s: [sb(-3, 4, 2.5, 0.5, 1), sb(10, 19, 2, 1), sb(27, 34, 0.3, 0.5, 0, 0.5), sb(12, 21, 1, 0.3, 0.5)] },
    Dsb: { label: 'Warm-summer continental (dry summer)', where: 'Iranian plateau towns, eastern Cascades', s: [sb(-6, 1, 2.5, 0.5, 1), sb(6, 14, 2, 0.7), sb(21, 27, 0.4, 0.5), sb(7, 15, 1.2, 0.3, 0.5)] },
    Dsc: { label: 'Subarctic (dry summer)', where: 'High Sierra and Anatolian uplands', s: [sb(-15, -5, 2.5, 0.8, 0.5), sb(-2, 8, 2, 0.5), sb(14, 19, 0.5, 0.5), sb(0, 8, 1.5, 0.3, 0.5)] },
    Dsd: { label: 'Extremely cold subarctic (dry summer)', where: 'Rare: high eastern Siberia', s: [sb(-40, -28, 1, 1, 0.5), sb(-12, 0, 0.8, 0.3), sb(14, 20, 0.5, 0.3), sb(-10, 0, 0.8, 0.5)] },
    Dwa: { label: 'Monsoon-influenced hot-summer continental', where: 'Beijing, Seoul', s: [sb(-2, 4, 0.3, 0, 0.5, 1), sb(14, 22, 1, 0.5, 0, 1.5), sb(28, 32, 4, 2.5, 0.5), sb(13, 22, 1, 0.3, 1)] },
    Dwb: { label: 'Monsoon-influenced warm-summer continental', where: 'Vladivostok, northern Korea', s: [sb(-12, -5, 0.3, 0, 0.3), sb(6, 14, 1.2, 0.3, 1.5), sb(20, 25, 3.5, 2, 1.5), sb(6, 14, 1.2, 0.3, 0.5)] },
    Dwc: { label: 'Monsoon-influenced subarctic', where: 'Mongolia, Chita, Tibetan uplands', s: [sb(-25, -14, 0.2, 0.3, 0.3, 0.3), sb(0, 12, 0.6, 0.3, 0, 1), sb(20, 25, 2.5, 1.5), sb(-2, 10, 0.6, 0.3)] },
    Dwd: { label: 'Monsoon-influenced extremely cold subarctic', where: 'Oymyakon region', s: [sb(-48, -35, 0.2, 0.3, 1), sb(-15, 0, 0.4, 0.2), sb(16, 22, 2, 1), sb(-14, -2, 0.5, 0.3)] },
    Dfa: { label: 'Hot-summer humid continental', where: 'Chicago, Kyiv-area plains, Toronto outskirts', s: [sb(-4, 3, 2, 1, 1), sb(10, 19, 2.5, 1.5, 0.5), sb(26, 31, 2.5, 2.5), sb(11, 20, 2, 0.5, 1)] },
    Dfb: { label: 'Warm-summer humid continental', where: 'Moscow, Toronto, Warsaw, Minneapolis', s: [sb(-9, -1, 2, 1, 1), sb(6, 15, 2, 0.7, 0.5), sb(20, 25, 2.5, 1.5, 0.3), sb(5, 13, 2.2, 0.3, 1.5)] },
    Dfc: { label: 'Subarctic (boreal taiga)', where: 'Fairbanks, Arkhangelsk, northern Scandinavia', s: [sb(-25, -12, 1.5, 1.2, 0.5), sb(-5, 8, 1.2, 0.5, 0.5), sb(16, 22, 2, 1), sb(-3, 6, 1.8, 0.5, 1)] },
    Dfd: { label: 'Extremely cold subarctic', where: 'Yakutsk, Verkhoyansk', s: [sb(-45, -32, 0.7, 0.5, 1.5), sb(-15, 2, 0.6, 0.2), sb(18, 25, 1.5, 0.8), sb(-12, 0, 0.8, 0.3, 0.5)] },
    ET:  { label: 'Tundra', where: 'Alaska North Slope, Norilsk, Svalbard coast', s: [sb(-30, -18, 1, 1.5), sb(-15, -3, 1, 1, 0.5), sb(2, 10, 1.5, 0.3, 2.5), sb(-8, 0, 1.5, 1, 1.5)] },
    EF:  { label: 'Ice cap', where: 'Antarctica, interior Greenland', s: [sb(-60, -35, 0.4, 2.5), sb(-40, -20, 0.4, 2), sb(-20, -5, 0.5, 1, 0.5), sb(-40, -20, 0.4, 2)] },
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
  const SHIFT_PEAK = { storm: [2, 3], hail: [2], haze: [2], sandstorm: [2, 3], fog: [1] };
  // Temperature at each shift as a share of the day's high-to-low swing below the high (Noon holds the high).
  const SHIFT_COOL = [0.9, 0.5, 0, 0.35];

  /** Typical difference between the daytime high and the overnight low, in °C, before cloud cover. */
  function diurnalRange(clim, sea) {
    if (clim === CLIMATES.underground || clim === CLIMATES.ship || clim === CLIMATES.vacuum) return 0;
    const k = clim.koppen || '';
    if (k) {
      const g = k[0];
      if (g === 'B') return k[1] === 'W' ? 16 : 13;
      if (g === 'E') return 5;
      if (g === 'A') return 8;
      if (k[1] === 's' && sea === 'summer') return 13; // dry Mediterranean summers swing hard
      return g === 'D' ? 11 : 9;
    }
    const R = { temperate: 9, arctic: 6, desert: 16, tropical: 8, mountain: 12, maritime: 6, swamp: 7 };
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
    return types.map((type, i) => {
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
   * Visibility 0–5 for one shift. Returns {score, label, parts[]} where parts explain the math.
   * lighting: 'natural' (sun + moons), 'artificial' (fixed light levels per shift), 'none' (total darkness).
   */
  function visibility(cal, region, weather, d, shift, override) {
    const rs = (region && region.settings) || {};
    const lighting = rs.lighting || cal.lighting || 'natural';
    const names = shiftNames(cal);
    const parts = [];
    let score;

    if (lighting === 'none') {
      score = 0; parts.push('No natural light (0)');
    } else if (lighting === 'artificial') {
      const lv = rs.light_levels || cal.lightLevels || [2, 4, 5, 4];
      score = Number(lv[shift] ?? 4);
      parts.push(`${names[shift]} lighting (${score})`);
    } else {
      score = [0, 3, 5, 3][shift];
      parts.push(`${names[shift]} base (${score})`);
    }

    const def = weather ? (WEATHER[weather.type] || {}) : null;
    if (lighting === 'natural' && shift === 0) {
      const ms = moons(cal, d);
      let light = ms.reduce((s, m, i) => s + m.illum * Number((cal.moons[i].brightness ?? 1)), 0);
      if (def) light *= def.moon ?? 1;
      const bonus = Math.min(2, Math.round(light * 2));
      if (bonus) { score += bonus; parts.push(`moonlight +${bonus}`); }
    }
    if (def) {
      const m = shift === 0 ? def.night : def.day;
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


  // ---------------------------------------------------------------- travel planner
  const C = 299792458, G0 = 9.80665, AU = 1.495978707e11, LY = 9.4607304725808e15;
  const DIST_UNITS = { km: 1e3, mi: 1609.344, AU, LY, ls: C, lm: C * 60 };
  // Central bodies (GM in m³/s²) and bodies orbiting them (orbit radius in AU or km).
  const SYSTEMS = {
    sun: { label: 'Sol', gm: 1.32712440018e20, unit: 'AU', bodies: {
      Mercury: 0.387, Venus: 0.723, Earth: 1.0, Mars: 1.524, Ceres: 2.77, Jupiter: 5.203,
      Saturn: 9.537, Uranus: 19.19, Neptune: 30.07, Pluto: 39.48 } },
    jupiter: { label: 'Jupiter system', gm: 1.26686534e17, unit: 'km', bodies: {
      Io: 421700, Europa: 671034, Ganymede: 1070412, Callisto: 1882709 } },
    saturn: { label: 'Saturn system', gm: 3.7931187e16, unit: 'km', bodies: {
      Enceladus: 238020, Tethys: 294619, Dione: 377396, Rhea: 527108, Titan: 1221870, Iapetus: 3560820 } },
    earth: { label: 'Earth–Moon', gm: 3.986004418e14, unit: 'km', bodies: {
      'Low orbit (400 km)': 6771, 'Geostationary': 42164, Moon: 384400 } },
  };

  /**
   * Compute a travel duration. Returns {hours, worldHours?, lines[]}.
   * modes: 'ground' | 'hohmann' | 'brachistochrone' | 'relativistic' | 'ftl'
   */
  function travel(mode, q) {
    const n = k => Number(q[k]);
    const lines = [];
    const fmtH = h => fmtDuration(h);
    if (mode === 'ground') {
      const dist = n('distance'), speed = n('speed'), perDay = n('hours_per_day') || 8;
      if (!(dist > 0 && speed > 0)) throw new Error('Enter a distance and a speed');
      const moving = dist / speed * (n('terrain') || 1);
      const days = moving / perDay;
      lines.push(`${moving.toFixed(1)} hours moving at ${speed}/h${n('terrain') && n('terrain') !== 1 ? ` (terrain ×${n('terrain')})` : ''}`);
      lines.push(`${perDay} travel hours a day → ${days.toFixed(1)} days`);
      return { hours: days * 24, lines };
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
  /** hours -> number of shifts, using the calendar's day length (default 24 h) */
  function hoursToShifts(cal, h) {
    const perShift = (Number(cal.hoursPerDay) || 24) / 4;
    return Math.max(0, Math.round(h / perShift));
  }

  // ---------------------------------------------------------------- presets
  // Astronomical seasons (equinox/solstice dates). Month indexes are 0-based.
  const GREGORIAN_SEASONS = {
    north: [
      { name: 'Spring', type: 'spring', month: 2, day: 20 }, { name: 'Summer', type: 'summer', month: 5, day: 21 },
      { name: 'Autumn', type: 'autumn', month: 8, day: 22 }, { name: 'Winter', type: 'winter', month: 11, day: 21 }],
    south: [
      { name: 'Autumn', type: 'autumn', month: 2, day: 20 }, { name: 'Winter', type: 'winter', month: 5, day: 21 },
      { name: 'Spring', type: 'spring', month: 8, day: 22 }, { name: 'Summer', type: 'summer', month: 11, day: 21 }],
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
        // reference = a known new moon (6 Jan 2000, 18:14 UTC) expressed as an absolute day
        moons: [{ name: 'Moon', cycle: 29.530588, ref: 730124.76, brightness: 1, color: '#e8e4d8' }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 2026, month: 9, day: 16 },
      regions: [{ name: 'Temperate lowlands', current: true, settings: { climate: 'temperate', hemisphere, lighting: 'natural', terrain_mod: 0 } }],
      holidays: [
        { name: "New Year's Day", color: '#4a90d9', rule: { type: 'fixed', month: 0, day: 1, span: 1 } },
        { name: 'Thanksgiving (US)', color: '#c0632b', rule: { type: 'nth_weekday', month: 10, weekday: 4, n: 4, span: 1 } },
        { name: 'Christmas Eve & Day', color: '#2e8b57', rule: { type: 'fixed', month: 11, day: 24, span: 2 } },
      ],
      settings: { time_unit: 'day', temp_unit: north ? 'F' : 'C' },
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
      regions: [
        { name: 'Reikland', current: true, settings: { climate: 'temperate', hemisphere: 'north', lighting: 'natural', terrain_mod: 0 } },
        { name: 'Drakwald Forest', settings: { climate: 'temperate', hemisphere: 'north', lighting: 'natural', terrain_mod: -1 } },
        { name: 'Middle Mountains', settings: { climate: 'mountain', hemisphere: 'north', lighting: 'natural', terrain_mod: 0 } }],
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
      settings: { time_unit: 'day', temp_unit: 'C' },
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
      // Climates follow the Köppen climate map of Middle-earth on r/imaginarymaps (c5mzt9). Umbar and Far Harad
      // lie south of that map, so theirs are inferred.
      regions: [
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
      ].map(([name, code, terrain], i) => ({
        name, ...(i ? {} : { current: true }),
        settings: { climate: `koppen:${code}`, hemisphere: 'north', lighting: 'natural', terrain_mod: terrain },
      })),
      holidays: [
        { name: 'Yule', color: '#2e8b57', rule: { type: 'fixed', month: 17, day: 1, span: 2 }, description: 'The two Yuledays: the old year ends on 1 Yule and the new one begins on 2 Yule.' },
        // Lithe is two entries so 2 Lithe is covered whether or not an Overlithe falls before it
        { name: 'Lithe', color: '#d9a441', rule: { type: 'fixed', month: 7, day: 1, span: 2 }, description: 'Midsummer holiday: 1 Lithe, Mid-year\'s Day, Overlithe in leap years, and 2 Lithe. The Free Fair is held on the White Downs.' },
        { name: 'Lithe', color: '#d9a441', rule: { type: 'fixed', month: 10, day: 1, span: 1 }, description: 'Midsummer holiday: 1 Lithe, Mid-year\'s Day, Overlithe in leap years, and 2 Lithe. The Free Fair is held on the White Downs.' },
        { name: 'Overlithe', color: '#d9a441', rule: { type: 'fixed', month: 9, day: 1, span: 1 }, description: 'The leap day, a special holiday added after Mid-year\'s Day.' },
        { name: 'Birthday of Bilbo and Frodo', color: '#c0632b', rule: { type: 'fixed', month: 13, day: 22, span: 1 } },
      ],
      settings: { time_unit: 'day', temp_unit: 'C' },
    },

    shipclock: {
      label: 'Starship clock (Standard Ship Time)',
      calendar: {
        name: 'Standard Ship Time', epochYear: 1, yearSuffix: '', dateFormat: '{W} · {M}, Day {d} · Mission Year {Y}', weekdayOffset: 0, lighting: 'artificial',
        lightLevels: [2, 4, 5, 4],
        weekdays: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
        months: Array.from({ length: 10 }, (_, i) => ({ name: `Cycle ${i + 1}`, days: 36 })),
        leap: null, seasons: [], moons: [],
        shiftNames: ['Night Watch', 'Morning Watch', 'Day Watch', 'Evening Watch'],
      },
      start: { year: 1, month: 0, day: 1 },
      regions: [
        { name: 'Ship interior', current: true, settings: { climate: 'ship', lighting: 'artificial', light_levels: [2, 4, 5, 4], terrain_mod: 0 } },
        { name: 'EVA / hull exterior', settings: { climate: 'vacuum', lighting: 'artificial', light_levels: [1, 1, 1, 1], terrain_mod: 0 } }],
      holidays: [
        { name: 'Launch Day', color: '#4a90d9', rule: { type: 'fixed', month: 0, day: 1, span: 1 } },
        { name: 'Shore leave rotation', color: '#2e8b57', rule: { type: 'every_n', start: 30, interval: 60, span: 3 } }],
      settings: { time_unit: 'week', temp_unit: 'C' },
    },

    custom: {
      label: 'Custom (start from a blank 12×30 calendar)',
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
    prep, shiftNames, isLeap, yearStart, yearLength, monthLength, fromAbs, toAbs, weekday, weekLength,
    yearLabel, fmtDate, fmtShift, addMonths, SEASON_TYPES, season, seasonStarts, monthSeasons, moons, moonPhase, holidaysOn, holidayActive,
    genWeather, shiftWeather, weatherLabel, TEMP_UNITS, fmtTemp, toTempUnit, fromTempUnit, visibility, climateFor, mod,
    KOPPEN, KOPPEN_GROUPS, KOPPEN_LETTERS, KOPPEN_SEASONS, WET_LABELS, koppenBase, koppenClimate, koppenCode, buildClimate, baselineWeights, describeBaseline,
    travel, fmtDuration, hoursToShifts, SYSTEMS, DIST_UNITS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
