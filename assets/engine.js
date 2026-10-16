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
    cal._baseW = months.reduce((s, m) => s + (m.intercalary ? 0 : Number(m.days || 0)), 0);
    cal._extraW = months.reduce((s, m) => s + (m.intercalary ? 0 : Number(m.leapDays || 0)), 0);
    if (cal._base <= 0) throw new Error('Calendar needs at least one month with days');
    Object.defineProperty(cal, '_prepped', { value: true, enumerable: false });
    return cal;
  }
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
    if (p.intercalary) return null;
    let count = (p.year - cal.epochYear) * cal._baseW + leapsBefore(cal, p.year) * cal._extraW;
    for (let m = 0; m < p.month; m++) if (!cal.months[m].intercalary) count += monthLength(cal, p.year, m);
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
    if (p.intercalary && monthLength(cal, p.year, p.month) === 1) return `${mo.name}, ${yearLabel(cal, p.year)}`;
    const wd = weekday(cal, d);
    const W = (wd !== null && !opts.noWeekday) ? cal.weekdays[wd] : '';
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
  function season(cal, d, hemisphere) {
    const list = cal.seasons || [];
    if (!list.length) return { name: '', type: 'none' };
    const p = fromAbs(cal, d);
    const starts = list.map(s => ({ s, doy: toAbs(cal, p.year, clamp(s.month, 0, cal.months.length - 1), s.day || 1) - yearStart(cal, p.year) }))
      .sort((a, b) => a.doy - b.doy);
    let cur = starts[starts.length - 1].s; // wraps from previous year
    for (const x of starts) if (x.doy <= p.doy) cur = x.s;
    let type = cur.type || 'none';
    if (hemisphere === 'south') type = { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' }[type] || type;
    return { name: cur.name, type };
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
    if (s.climate === 'custom' && s.custom_climate && s.custom_climate.seasons) return s.custom_climate;
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

  function fmtTemp(c, unit) {
    if (unit === 'none' || typeof c !== 'number') return '';
    return unit === 'F' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${c}°C`;
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
  const PRESETS = {
    gregorian: {
      label: 'Gregorian (real-world)',
      calendar: {
        name: 'Gregorian', epochYear: 1, yearSuffix: '', weekdayOffset: 1, lighting: 'natural',
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        months: [
          { name: 'January', days: 31 }, { name: 'February', days: 28, leapDays: 1 }, { name: 'March', days: 31 },
          { name: 'April', days: 30 }, { name: 'May', days: 31 }, { name: 'June', days: 30 },
          { name: 'July', days: 31 }, { name: 'August', days: 31 }, { name: 'September', days: 30 },
          { name: 'October', days: 31 }, { name: 'November', days: 30 }, { name: 'December', days: 31 }],
        leap: { every: 4, skip: 100, unskip: 400 },
        seasons: [
          { name: 'Spring', type: 'spring', month: 2, day: 20 }, { name: 'Summer', type: 'summer', month: 5, day: 21 },
          { name: 'Autumn', type: 'autumn', month: 8, day: 22 }, { name: 'Winter', type: 'winter', month: 11, day: 21 }],
        // reference = a known new moon (6 Jan 2000, 18:14 UTC) expressed as an absolute day
        moons: [{ name: 'Moon', cycle: 29.530588, ref: 730124.76, brightness: 1, color: '#e8e4d8' }],
        shiftNames: DEFAULT_SHIFT_NAMES,
      },
      start: { year: 2026, month: 9, day: 16 },
      regions: [{ name: 'Temperate lowlands', current: true, settings: { climate: 'temperate', hemisphere: 'north', lighting: 'natural', terrain_mod: 0 } }],
      holidays: [
        { name: "New Year's Day", color: '#4a90d9', rule: { type: 'fixed', month: 0, day: 1, span: 1 } },
        { name: 'Thanksgiving (US)', color: '#c0632b', rule: { type: 'nth_weekday', month: 10, weekday: 4, n: 4, span: 1 } },
        { name: 'Christmas Eve & Day', color: '#2e8b57', rule: { type: 'fixed', month: 11, day: 24, span: 2 } },
      ],
      settings: { time_unit: 'day', temp_unit: 'F' },
    },

    imperial: {
      label: 'Imperial Calendar (Warhammer Fantasy)',
      calendar: {
        name: 'Imperial Calendar', epochYear: 0, yearSuffix: 'IC', weekdayOffset: 0, lighting: 'natural',
        weekdays: ['Wellentag', 'Aubentag', 'Marktag', 'Backertag', 'Bezahltag', 'Konistag', 'Angestag', 'Festag'],
        months: [
          { name: 'Hexenstag', days: 1, intercalary: true },
          { name: 'Nachhexen', days: 32 }, { name: 'Jahrdrung', days: 33 },
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
        seasons: [
          { name: 'Spring', type: 'spring', month: 3, day: 1 }, { name: 'Summer', type: 'summer', month: 7, day: 1 },
          { name: 'Autumn', type: 'autumn', month: 12, day: 1 }, { name: 'Winter', type: 'winter', month: 16, day: 1 }],
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
      holidays: [
        { name: 'Hexensnacht (Witching Night)', color: '#7b4fa0', rule: { type: 'fixed', month: 17, day: 33, span: 1 }, description: 'The night before Hexenstag; both moons are said to be full.' },
        { name: 'Geheimnisnacht (Mystery Night)', color: '#7b4fa0', rule: { type: 'fixed', month: 8, day: 33, span: 1 }, description: 'The night before Geheimnistag.' },
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
    SHIFT_KEYS, VIS_LABELS, WEATHER, WIND, CLIMATES, PRESETS,
    prep, shiftNames, isLeap, yearStart, yearLength, monthLength, fromAbs, toAbs, weekday, weekLength,
    yearLabel, fmtDate, fmtShift, addMonths, season, moons, moonPhase, holidaysOn, holidayActive,
    genWeather, weatherLabel, fmtTemp, visibility, climateFor, mod,
    travel, fmtDuration, hoursToShifts, SYSTEMS, DIST_UNITS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
