/* Campaign Chronicle — browser app (plain JS, no build step).
 * All user-supplied text is inserted with textContent (via el()), never innerHTML.
 * Permissions are enforced by api/index.php; the UI only hides controls a role can't use.
 * Sign-in is Google/GitHub with an admin approval queue, the same as Sinless (api/auth/). */
(function () {
  'use strict';
  const E = window.Engine;

  const { el, $, toast, tip, tipped, hideTip, confirmDialog, promptDialog } = KIT;
  const app = () => $('#app');
  const clean = kids => kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false);
  function mount(...kids) { hideTip(); const a = app(); a.replaceChildren(...clean(kids)); window.scrollTo(0, 0); }
  function field(label, input, hint, tipText) {
    return el('label', { class: 'field' }, el('span', { class: 'lbl' }, label, tipText ? tip(tipText) : null), input, hint ? el('small', { class: 'muted' }, hint) : null);
  }
  function select(options, value, attrs) {
    return el('select', attrs || {}, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
  }
  const btn = (label, onclick, cls, tipText) => el('button', { type: 'button', class: cls || '', onclick, 'data-tip': tipText }, label);
  function formData(form) {
    const o = {};
    for (const f of form.elements) {
      if (!f.name) continue;
      o[f.name] = f.type === 'checkbox' ? f.checked : f.value;
    }
    return o;
  }
  function busy(button, fn) {
    return async (...a) => {
      if (button) button.disabled = true;
      try { await fn(...a); } catch (e) { toast(e.message, true); } finally { if (button) button.disabled = false; }
    };
  }

  // ------------------------------------------------------------ API
  const S = { user: null, pending: null, csrf: '', camp: null, role: null, regions: [], holidays: [], members: [], tags: [] };
  /** Build number, shown in the footer so a bug report names the build. Bump on each release. */
  const APP_VERSION = '8';
  async function api(action, { query = {}, body = null } = {}) {
    const qs = new URLSearchParams({ a: action, ...query }).toString();
    const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-CSRF-Token'] = S.csrf; opt.body = JSON.stringify(body); }
    const res = await fetch('api/index.php?' + qs, opt);
    let data;
    try { data = await res.json(); } catch { throw new Error(`Server error (${res.status})`); }
    // Signed out, or access changed while the page was open: go back through the gate.
    if (res.status === 401 || data.error === 'not_approved') { S.user = null; boot(); }
    if (!res.ok) throw new Error(data.message || data.error || `Error ${res.status}`);
    if (body) ownWrite();
    return data;
  }
  const post = (action, body, cid) => api(action, { query: cid ? { cid } : {}, body });

  // ------------------------------------------------------------ change notices
  // An open campaign page asks the server every so often whether a GM has changed the campaign
  // (api 'changed', which a GM's save bumps). If so it offers a Refresh in a banner; it never
  // reloads by itself, so nothing being typed is lost.
  const CHANGE_POLL_MS = 30000;
  let writeSeq = 0, checking = false;
  /** After this page saves something, take the new stamp as seen so our own change isn't announced. */
  function ownWrite() {
    if (!S.camp?.id) return;
    const seq = ++writeSeq, cid = S.camp.id;
    api('changed', { query: { cid } }).then(r => { if (seq === writeSeq && S.camp?.id === cid) S.camp.changed = r.changed; }).catch(() => {});
  }
  async function checkForChanges() {
    const cid = S.camp?.id;
    if (!cid || !S.user || checking || document.hidden || !location.hash.startsWith(`#/c/${cid}`) || $('#change-banner')) return;
    checking = true;
    const seq = writeSeq;
    try {
      const r = await api('changed', { query: { cid } });
      // a save from this page since the check started: its own stamp, not someone else's change
      if (seq === writeSeq && S.camp?.id === cid && r.changed !== S.camp.changed) showChangeBanner(r.changed);
    } catch { /* offline for a moment: try again next time */ } finally { checking = false; }
  }
  function showChangeBanner(stamp) {
    if ($('#change-banner')) return;
    const refresh = async () => {
      hideChangeBanner();
      try { await loadCampaign(S.camp.id, true); await route(); } catch (e) { toast(e.message, true); }
    };
    $('.topbar').append(el('div', { id: 'change-banner', role: 'status', 'aria-live': 'polite' },
      el('span', {}, isGM() ? 'This campaign was changed by another GM or in another tab.' : 'The GM updated the calendar.'),
      btn('Refresh', refresh, 'primary small', 'Load the changes. Save anything you are typing first.'),
      btn('✕', () => { if (S.camp) S.camp.changed = stamp; hideChangeBanner(); }, 'link', 'Dismiss until the next change')));
  }
  function hideChangeBanner() { $('#change-banner')?.remove(); }
  setInterval(checkForChanges, CHANGE_POLL_MS);
  document.addEventListener('visibilitychange', checkForChanges);

  // ------------------------------------------------------------ campaign helpers
  const isGM = () => S.role === 'gm';
  const cal = () => S.camp.calendar;
  const nowShift = () => S.camp.current_shift;
  /** Slots in a day: 4 or 2 shifts, or the day's hours (Settings → Time tracking). */
  const spd = () => E.slotsPerDay(cal());
  const today = () => Math.floor(nowShift() / spd());
  const hourMode = () => E.timeMode(cal()) === 'hours';
  /** "shift" or "hour", for labels; Word() is capitalized. */
  const word = () => E.slotWord(cal());
  const Word = () => (hourMode() ? 'Hour' : 'Shift');
  const settings = () => S.camp.settings || (S.camp.settings = {});
  const regionById = id => S.regions.find(r => r.id === Number(id)) || null;
  const currentRegion = () => regionById(settings().current_region) || S.regions[0] || null;
  /** Campaign default (set by the GM) for anyone who hasn't picked their own units. */
  const campTempUnit = () => (S.camp && settings().temp_unit) || 'C';
  const tempUnit = () => S.user?.prefs?.temp_unit || campTempUnit();
  const tempSym = unit => E.TEMP_UNITS[unit]?.sym.trim() || '°C';
  const TEMP_OPTIONS = [...Object.entries(E.TEMP_UNITS).map(([k, u]) => [k, `${u.label} (${u.sym.trim()})`]), ['none', 'Hide temperatures']];
  const shiftNames = () => E.shiftNames(cal());

  async function loadCampaign(cid, force) {
    if (!force && S.camp && S.camp.id === cid) return;
    const r = await api('campaign', { query: { cid } });
    S.camp = r.campaign; S.role = r.role; S.regions = r.regions; S.holidays = r.holidays; S.members = r.members; S.tags = r.tags || [];
    E.prep(S.camp.calendar);
    hideChangeBanner();
    if (isGM()) await ensureWeather(today(), today()).catch(() => {});
  }

  /** Fetch stored day rows in [from, to] (chunked). Returns Map(abs_day -> row) plus shifts & events. */
  async function fetchRange(from, to) {
    const days = new Map(), shifts = [], events = [];
    for (let a = from; a <= to; a += 1500) {
      const b = Math.min(to, a + 1499);
      const r = await api('days', { query: { cid: S.camp.id, from: a, to: b } });
      r.days.forEach(d => days.set(d.abs_day, d));
      shifts.push(...r.shifts);
      for (const e of r.events) if (!events.some(x => x.id === e.id)) events.push(e);
    }
    return { days, shifts, events };
  }

  /** GM only: generate and store weather for days in [from, to] that don't have any yet. */
  async function ensureWeather(from, to, regionId) {
    if (!isGM()) return 0;
    if (to - from > 4000) from = to - 60; // very long jumps: only the last two months get weather
    const { days } = await fetchRange(from - 1, to);
    const region = regionById(regionId) || currentRegion();
    let prev = days.get(from - 1)?.weather || null;
    const out = [];
    for (let d = from; d <= to; d++) {
      const row = days.get(d);
      if (row && row.weather) {
        // stored before shift weather was saved, or the engine has changed it since: refresh the copy players get
        const fresh = withShiftWx(d, regionById(row.region_id) || currentRegion(), row.weather);
        if (JSON.stringify(fresh.shifts) !== JSON.stringify(row.weather.shifts) || fresh.shift_order !== row.weather.shift_order) out.push({ abs_day: d, region_id: row.region_id, weather: fresh });
        prev = row.weather; continue;
      }
      const reg = (row && regionById(row.region_id)) || region;
      const w = E.genWeather(cal(), S.camp.seed, reg, d, prev, 0);
      out.push({ abs_day: d, region_id: reg ? reg.id : null, weather: withShiftWx(d, reg, w) });
      prev = w;
    }
    for (let i = 0; i < out.length; i += 1000) await post('days_save', { days: out.slice(i, i + 1000) }, S.camp.id);
    return out.length;
  }

  /** GM: move "now" forward by n shifts, optionally labelling the passed shifts. */
  async function passShifts(n, activity, travelRegionId, arrivalRegionId) {
    const from = nowShift(), to = from + n;
    if (n === 0) return;
    if (activity && n > 0) await post('shifts_fill', { from_shift: from + 1, to_shift: to, activity }, S.camp.id);
    const d0 = Math.floor(from / spd()), d1 = Math.floor(to / spd());
    if (n > 0) {
      // transit days use the travel region (or wherever the party was), arrival day uses the new region
      if (d1 > d0 + 1) await ensureWeather(d0 + 1, d1 - 1, travelRegionId || settings().current_region);
      if (arrivalRegionId) await setCurrentRegion(arrivalRegionId);
      await ensureWeather(d0, d1);
    }
    await post('set_time', { current_shift: to }, S.camp.id);
    S.camp.current_shift = to;
  }
  async function setCurrentRegion(id) {
    const s = { ...settings(), current_region: Number(id) || null };
    await post('campaign_update', { settings: s }, S.camp.id);
    S.camp.settings = s;
  }
  function unitShifts(unit, amount) {
    const c = cal(), n = spd(), day = Math.floor(nowShift() / n);
    switch (unit) {
      case 'shift': return amount;
      case 'day': return amount * n;
      case 'week': return amount * E.weekLength(c) * n;
      case 'month': return (E.addMonths(c, day, amount) - day) * n;
      case 'year': { const p = E.fromAbs(c, day); const y = p.year + amount;
        const t = E.toAbs(c, y, p.month, Math.min(p.day, E.monthLength(c, y, p.month))); return (t - day) * n; }
    }
    return 0;
  }

  // ------------------------------------------------------------ shared widgets
  function visPill(v) {
    return el('span', { class: `vis v${v.score}`, 'data-tip': `Visibility ${v.score} of 5 (${v.label}): how well the party can see this ${word()}.\n${v.parts.join(' · ')}` }, `👁 ${v.score} ${v.label}`);
  }
  /** A drop-down of the baseline shift actions. Picking one hands its name to onPick and
   * resets, so the activity text stays free-form and several actions can be added. */
  function actionPicker(onPick) {
    const groups = Object.entries(E.SHIFT_ACTION_GROUPS).map(([g, label]) => el('optgroup', { label },
      E.SHIFT_ACTIONS.filter(a => a.group === g).map(a => el('option', { value: a.name, title: a.desc }, `${a.icon} ${a.name}`))));
    const sel = el('select', { class: 'actpick', 'aria-label': 'Add an action',
      'data-tip': 'Common things to spend a shift doing on a journey. Picking one adds it to the activity; you can still type anything' },
      el('option', { value: '' }, '+ Add an action…'), groups);
    sel.addEventListener('change', () => {
      const a = E.SHIFT_ACTIONS.find(x => x.name === sel.value);
      sel.value = '';
      if (a) onPick(a);
    });
    return sel;
  }
  /** Suggestions for a single-line activity input (the browser shows them as you type). */
  function actionList(id) {
    return el('datalist', { id }, E.SHIFT_ACTIONS.map(a => el('option', { value: a.name, label: a.desc })));
  }

  const SHIFT_TIPS = {
    shifts4: 'Every day is split into four shifts of about six hours (by default Dawn, Midday, Dusk and Overnight, in that order). Time passes, activities are logged and visibility is worked out shift by shift.',
    shifts2: 'Every day is split into two shifts, Day (dawn to dusk) and Night (dusk to the next dawn). Time passes, activities are logged and visibility is worked out shift by shift.',
    hours: 'Time is kept in hours from midnight, like a normal calendar. Time passes, activities are logged and visibility is worked out hour by hour, from the light and weather of that part of the day.',
  };
  /** How this campaign (or calendar c) splits its days, for tooltips. Set under Settings → Time tracking. */
  const shiftTip = (c = cal()) => SHIFT_TIPS[E.timeMode(c)] + ' The GM picks four shifts, two shifts or hours in Settings.';
  const CLIMATE_TIP = 'Decides the odds of each kind of weather and the usual temperatures in every season. Köppen classes match real-world climates; the setting climates cover ship interiors, open space, caves and the like.';
  const roleBadge = role => el('span', { class: `role ${role}`, 'data-tip': role === 'gm' ? 'You run this campaign' : 'You play in this campaign' }, role === 'gm' ? 'GM' : 'Player');
  const secretTag = () => el('span', { class: 'secret-tag', 'data-tip': 'Only GMs can see this' }, '🔒 SECRET');
  const holidayChip = x => el('span', { class: 'chip', style: { background: x.color }, 'data-tip': x.description || `Holiday: ${x.name}` }, x.name);
  const tagChip = t => el('span', { class: 'chip tag', style: { background: t.color }, 'data-tip': `Tag: ${t.name}` }, t.name);
  /** The different tags on a list of events, in order of first appearance. */
  function tagsOf(evs) {
    const seen = new Map();
    for (const e of evs) for (const t of e.tags || []) if (!seen.has(t.name.toLowerCase())) seen.set(t.name.toLowerCase(), t);
    return [...seen.values()];
  }
  /** "All day", "Dawn", or "Dawn → Dusk" for an event's shifts. */
  function shiftRange(e) {
    const names = shiftNames();
    if (e.shift === null || e.shift === undefined) return 'All day';
    const a = Number(e.shift), b = e.shift_end === null || e.shift_end === undefined ? a : Number(e.shift_end);
    return a === b && (e.end_day === null || e.end_day === undefined) ? names[a] : `${names[a]} → ${names[b]}`;
  }
  function moonBadges(d) {
    return E.moons(cal(), d).map(m => el('span', { class: 'moon', 'data-tip': `${m.name}: ${m.label} (${Math.round(m.illum * 100)}% lit). Moonlight brightens the dusk and overnight shifts under sun & moons lighting.` },
      el('span', { style: m.color && cal().moons.length > 1 ? { filter: `drop-shadow(0 0 2px ${m.color})` } : {} }, m.icon)));
  }
  const FORECAST_TIP = 'The day\'s forecast: the worst weather it brings, its daytime high and its strongest wind. Each shift varies within it, cooler at night and often easing off away from the worst of it.';
  const SO_FAR_TIP = 'The weather this shift. The rest of today\'s weather shows up as each shift comes round.';
  function weatherText(w, what = FORECAST_TIP) {
    if (!w) return el('span', { class: 'muted' }, 'No weather recorded');
    if (w.partial && what === FORECAST_TIP) what = SO_FAR_TIP;
    const def = E.WEATHER[w.type] || {};
    const mods = [def.day ? `daytime visibility ${def.day > 0 ? '+' : ''}${def.day}` : null, def.night ? `overnight ${def.night > 0 ? '+' : ''}${def.night}` : null].filter(Boolean);
    return el('span', { class: 'wx', 'data-tip': `${what}\n${def.label}${mods.length ? `: ${mods.join(', ')}` : ': no effect on visibility'}` }, `${def.icon || ''} ${E.weatherLabel(w, tempUnit())}`);
  }
  /** The weather in each of day d's shifts (or hours), worked out from the day's forecast w for its four quarters. On today, a player
   * without future weather gets only the shifts so far from the server (w.partial), never the forecast. */
  const shiftWx = (d, region, w) => E.slotsFromQuarters(cal(), w?.partial ? w.shifts : E.shiftWeather(cal(), S.camp.seed, region, d, w));
  /** Day weather as the GM saves it: the forecast plus its four shifts, so the server can hand players
   * today's shifts one at a time without sending the forecast. shift_order records the calendar's shift
   * order they were saved in; the server ignores a copy saved in another order. */
  function withShiftWx(d, region, w) {
    const { shifts, shift_order, ...forecast } = w;
    return { ...forecast, shifts: E.shiftWeather(cal(), S.camp.seed, region, d, forecast), shift_order: cal().shiftOrder || 'overnight' };
  }
  /** year / month / day picker for this campaign's calendar; getAbs() returns the absolute day */
  function datePicker(abs) {
    const c = cal(), p = E.fromAbs(c, abs ?? today());
    const y = el('input', { type: 'number', value: p.year, class: 'w-year', 'aria-label': 'Year' });
    const m = select(c.months.map((mo, i) => [i, mo.name]), p.month, { 'aria-label': 'Month' });
    const d = el('input', { type: 'number', min: 1, value: p.day, class: 'w-day', 'aria-label': 'Day' });
    const wrap = el('span', { class: 'datepick' }, d, m, y);
    wrap.getAbs = () => {
      const yy = Number(y.value), mm = Number(m.value);
      const len = E.monthLength(c, yy, mm);
      return E.toAbs(c, yy, mm, Math.max(1, Math.min(Number(d.value) || 1, len)));
    };
    return wrap;
  }

  // ------------------------------------------------------------ top nav
  function renderNav() {
    const n = $('#topnav');
    n.replaceChildren(...clean([
      S.user ? el('a', { href: '#/', 'data-tip': 'All the campaigns you play in or run' }, 'Campaigns') : null,
      S.user?.is_admin ? el('a', { href: '#/admin', 'data-tip': 'Approve sign-ups and manage accounts (site admins only)' }, 'Users') : null,
      S.user ? el('a', { href: '#/account', 'data-tip': `Signed in as ${S.user.email}. Your display preferences` }, S.user.name || S.user.email) : null,
      schemePicker(),
      themeToggle(),
      S.user || S.pending ? btn('Sign out', signOut, 'link') : null,
    ]));
  }

  // ------------------------------------------------------------ theme (same control and storage scheme as Sinless)
  const THEME_KEY = 'chronicle:theme';
  function themeToggle() {
    const isLight = () => document.documentElement.dataset.theme === 'light';
    const b = btn(isLight() ? '☀' : '🌙', () => {
      const t = isLight() ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: just this page */ }
      b.textContent = t === 'light' ? '☀' : '🌙';
    }, 'theme-toggle', 'Toggle light / dark mode');
    b.setAttribute('aria-label', 'Toggle light / dark mode');
    return b;
  }

  // Colour themes, independent of light/dark (each has both). id must match a
  // data-scheme block in style.css and SCHEMES in api/index.php; dot is the swatch.
  const SCHEME_KEY = 'chronicle:scheme';
  const SCHEMES = [
    { id: 'parchment', name: 'Parchment & Brass', dot: '#d9a441', blurb: 'The classic: aged paper and lamplight' },
    { id: 'nightsky', name: 'Night Sky', dot: '#b9c6f2', blurb: 'Indigo and moonlight, for night watches' },
    { id: 'console', name: 'Ship\'s Console', dot: '#3ee0a0', blurb: 'Phosphor green on a bridge display' },
    { id: 'arctic', name: 'Arctic', dot: '#7cc8f0', blurb: 'Glacier blue and snow' },
    { id: 'wildwood', name: 'Wildwood', dot: '#9cc45a', blurb: 'Moss and bark, for the overland road' },
  ];
  const schemeOf = id => SCHEMES.find(s => s.id === id) || SCHEMES[0];
  const currentScheme = () => schemeOf(document.documentElement.dataset.scheme).id;
  /** Apply a theme on this device. save = also store it on the signed-in account. */
  function applyScheme(id, save) {
    id = schemeOf(id).id;
    document.documentElement.dataset.scheme = id;
    try { localStorage.setItem(SCHEME_KEY, id); } catch { /* private mode: just this page */ }
    if (save && S.user && S.user.prefs?.scheme !== id) {
      post('prefs_save', { scheme: id }).then(r => { S.user.prefs = r.prefs; }).catch(err => toast(err.message, true));
    }
  }
  /** Top-bar theme picker: a pill showing the current theme, opening a menu of all of them (like Sinless's). */
  function schemePicker() {
    const cur = schemeOf(currentScheme());
    const list = el('ul', { class: 'scheme-list', role: 'menu', hidden: true });
    const button = el('button', { type: 'button', class: 'scheme-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Theme: ${cur.name}` },
      el('span', { class: 'scheme-dot', style: { background: cur.dot } }), el('span', { class: 'scheme-name' }, cur.name));
    const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); };
    list.append(...SCHEMES.map(s => el('li', { role: 'none' },
      el('button', { type: 'button', role: 'menuitemradio', class: 'scheme-opt', 'aria-checked': String(s.id === cur.id),
        onclick: () => { close(); applyScheme(s.id, true); renderNav(); } },
        el('span', { class: 'scheme-dot', style: { background: s.dot } }),
        el('span', {}, s.name, el('small', {}, s.blurb))))));
    button.addEventListener('click', e => {
      e.stopPropagation();
      if (!list.hidden) return close();
      list.hidden = false; button.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', close);
    });
    list.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });
    return el('span', { class: 'scheme-pick' }, button, list);
  }

  // ------------------------------------------------------------ sign-in gate / account / admin
  const PROVIDER_LABEL = { google: 'Google', github: 'GitHub' };
  async function signOut() {
    await fetch('api/auth/logout.php', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': S.csrf } }).catch(() => {});
    S.user = null; S.camp = null; S.pending = null;
    location.hash = '#/';
    boot();
  }
  /** Sign-in card: one button per configured provider. Returns here after OAuth. */
  function viewLogin(providers) {
    const ret = encodeURIComponent(location.pathname + location.search + location.hash);
    mount(el('div', { class: 'card narrow auth-card' },
      el('h1', {}, 'Campaign Chronicle'),
      el('p', { class: 'muted' }, 'Sign in to see your campaigns. It\'s the same Google or GitHub sign-in as Sinless.'),
      providers.length
        ? el('div', { class: 'auth-buttons' }, providers.map(p => el('a', { class: `button primary btn-oauth ${p}`, href: `api/auth/login.php?provider=${p}&return=${ret}` }, `Sign in with ${PROVIDER_LABEL[p] || p}`)))
        : el('p', { class: 'bad' }, 'No sign-in providers are set up on the server yet.'),
      new URLSearchParams(location.search).has('auth_error') ? el('p', { class: 'bad' }, 'Sign-in didn\'t complete. Please try again.') : null));
  }
  let pendingTimer = null;
  /** Signed in but not (or no longer) approved. Polls, and lets them in once an admin approves. */
  function viewPending(u) {
    const revoked = u.status === 'revoked';
    mount(el('div', { class: 'card narrow auth-card' },
      el('h1', {}, revoked ? 'Access removed' : 'Awaiting approval'),
      el('p', {}, revoked
        ? 'An administrator has removed your access. Your notes are kept if it is restored.'
        : 'Your account has been created and is waiting for the site admin to approve it. You\'ll get in automatically once approved, with no need to reload.'),
      el('p', { class: 'muted' }, `Signed in as ${u.email}`),
      btn('Sign out', signOut)));
    clearTimeout(pendingTimer);
    if (!revoked) pendingTimer = setTimeout(boot, 20000);
  }

  function viewAccount() {
    const prefs = el('form', { class: 'card narrow' }, el('h2', {}, 'Preferences'),
      el('p', { class: 'muted' }, `Signed in as ${S.user.email}. Your name comes from your Google or GitHub account.`),
      field('Temperature units', select([['', 'Campaign default'], ...TEMP_OPTIONS], S.user.prefs?.temp_unit || '', { name: 'temp_unit' }),
        'Only changes what you see. Each campaign\'s GM sets the default for players who leave this alone.'),
      el('button', { class: 'primary' }, 'Save'));
    prefs.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(prefs).temp_unit;
      try { S.user.prefs = (await post('prefs_save', { temp_unit: v || null })).prefs; toast('Preferences saved'); } catch (err) { toast(err.message, true); }
    });
    mount(prefs);
  }

  const STATUS_LABEL = { pending: 'Waiting for approval', approved: 'Approved', revoked: 'Access removed' };
  async function viewAdmin() {
    const { users } = await api('users');
    const act = (label, fn, cls, tipText) => btn(label, async () => {
      try { if (await fn() !== false) viewAdmin(); } catch (err) { toast(err.message, true); }
    }, `small ${cls || ''}`, tipText);
    const row = u => {
      const legacy = u.provider === 'legacy';
      const self = Number(u.id) === S.user.id;
      return el('tr', {},
        el('td', {}, el('strong', {}, u.display_name || '(no name)'), Number(u.is_admin) ? el('span', { class: 'role gm' }, 'Admin') : null),
        el('td', {}, legacy ? (u.email || el('span', { class: 'muted' }, 'not linked yet')) : u.email,
          el('div', { class: 'small muted' }, legacy ? 'Account from before Google/GitHub sign-in' : `${PROVIDER_LABEL[u.provider] || u.provider}`)),
        el('td', {}, el('span', { class: `status ${u.status}` }, STATUS_LABEL[u.status] || u.status)),
        el('td', { class: 'act' }, el('div', { class: 'actions' },
          legacy ? act(u.email ? 'Change email' : 'Link email', async () => {
            const email = await promptDialog(`Their Google or GitHub email. When ${u.display_name} first signs in with it, they take over this account and keep their campaigns.`, { title: 'Link account', value: u.email || '', placeholder: 'name@example.com', ok: 'Save' });
            if (email === null) return false;
            await post('user_email', { id: u.id, email });
          }, '', 'Connect this older account to the player\'s Google or GitHub email') : null,
          !self && u.status !== 'approved' ? act('Approve', () => post('user_status', { id: u.id, status: 'approved' }), 'primary', 'Let them in. A GM can then add them to a campaign by email') : null,
          !self && u.status === 'approved' && !Number(u.is_admin) ? act('Revoke', () => post('user_status', { id: u.id, status: 'revoked' }), 'danger', 'Block their access. Their campaigns and notes stay') : null,
          !self ? act('Delete', async () => {
            if (!await confirmDialog(`Delete ${u.display_name || u.email}? Their campaign memberships and notes' authorship go with it.`, { ok: 'Delete', danger: true })) return false;
            await post('user_delete', { id: u.id });
          }, 'danger', 'Delete this account. Their campaign memberships go with it') : null)));
    };
    const pending = users.filter(u => u.status === 'pending').length;
    mount(el('div', { class: 'card' }, el('h2', {}, 'Users'),
      pending ? el('p', {}, `${pending} ${pending === 1 ? 'person is' : 'people are'} waiting for approval.`) : null,
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl users' }, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Status'), el('th', {})), users.map(row)))),
      el('p', { class: 'muted pad' }, 'New people appear here after their first sign-in. Approve them, then a GM picks them from the Members tab of a campaign. Admins are set in the server config (admin_identities).'));
  }

  // ------------------------------------------------------------ campaign list / create
  async function viewCampaigns() {
    const { campaigns } = await api('campaigns');
    S.camp = null;
    const list = el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h1', {}, 'Your campaigns'), btn('+ New campaign', viewCreate, 'primary')),
      campaigns.length ? el('ul', { class: 'camplist' }, campaigns.map(c =>
        el('li', {}, el('a', { href: `#/c/${c.id}` }, el('strong', {}, c.name), roleBadge(c.role)),
          c.description ? el('p', { class: 'muted' }, c.description) : null)))
        : el('p', { class: 'muted' }, 'No campaigns yet. Create one to get started.'));
    mount(list);
  }

  /** Seasons moved from one month list to another, each starting at the same share of the year. */
  function spreadSeasons(seasons, from, to) {
    const len = ms => ms.reduce((t, m) => t + Number(m.days), 0);
    return seasons.map(s => {
      let d = from.slice(0, s.month).reduce((t, m) => t + Number(m.days), 0) + s.day - 1, month = 0;
      d = Math.floor(d * len(to) / len(from));
      while (d >= to[month].days) d -= to[month++].days;
      return { ...s, month, day: d + 1 };
    });
  }

  function viewCreate() {
    let preset = 'gregorian';
    const presetSel = select(Object.entries(E.PRESETS).map(([k, p]) => [k, p.label]), preset, { name: 'preset' });
    const startWrap = el('div');
    // the Custom preset's months, set on this form: how many there are and each one's length
    let customMonths = E.PRESETS.custom.calendar.months.map(m => ({ ...m }));
    /** The preset's calendar, with the custom months (and seasons spread over them) when Custom is picked. */
    const presetCal = () => {
      const c = E.PRESETS[preset].calendar;
      return preset === 'custom' ? { ...c, months: customMonths.map(m => ({ ...m })), seasons: spreadSeasons(c.seasons, c.months, customMonths) } : c;
    };
    const tmpCal = () => { const c = JSON.parse(JSON.stringify(presetCal())); E.prep(c); return c; };
    let picker;
    const drawStart = () => {
      const p = E.PRESETS[preset], c = tmpCal();
      const saved = S.camp; S.camp = { calendar: c, current_shift: 0 }; // datePicker reads cal()
      picker = datePicker(E.toAbs(c, p.start.year, p.start.month, p.start.day));
      S.camp = saved;
      startWrap.replaceChildren(field('Starting date', picker, 'You can change "now" at any time later.'));
    };
    const seasonWrap = el('div');
    let seasons;
    const drawSeasons = () => {
      seasons = seasonEditor(tmpCal());
      const hemi = E.PRESETS[preset].calendar.hemisphere;
      seasonWrap.replaceChildren(el('h3', {}, 'Seasons'),
        hemi ? el('p', { class: 'muted' }, `Dates are for the ${hemi === 'south' ? 'southern' : 'northern'} hemisphere.`) : null, seasons);
    };
    const homeRegion = () => E.PRESETS[preset].regions.find(r => r.current) || E.PRESETS[preset].regions[0];
    const climateWrap = el('div');
    let climateSel;
    const drawClimate = () => {
      climateSel = climateSelect(homeRegion().settings.climate || 'temperate', { name: 'climate' });
      const hint = el('small', { class: 'muted' });
      const sync = () => {
        const k = E.KOPPEN[climateSel.value.replace('koppen:', '')];
        hint.textContent = k ? `Typical of ${k.where}. ` : '';
        hint.textContent += `Sets the baseline weather by season for "${homeRegion().name}"; each region can have its own climate (Regions tab).`;
      };
      climateSel.addEventListener('change', sync); sync();
      climateSel.querySelector('option[value=koppen_custom]').remove(); climateSel.querySelector('option[value=custom]').remove(); // built later, per region
      climateWrap.replaceChildren(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Home region climate', tip(CLIMATE_TIP)), climateSel, hint));
    };
    const monthsWrap = el('div');
    const drawMonths = () => {
      if (preset !== 'custom') return monthsWrap.replaceChildren();
      const rows = el('div', { class: 'monthrows' });
      const count = el('input', { type: 'number', min: 1, max: 100, value: customMonths.length, class: 'w-day', name: 'month_count' });
      const addRow = (m, i) => rows.append(el('div', { class: 'row monthrow' },
        el('input', { value: m.name, 'data-k': 'name', 'aria-label': `Month ${i + 1} name`, class: 'grow', placeholder: `Month ${i + 1}` }),
        el('input', { type: 'number', min: 1, max: 1000, value: m.days, class: 'w-day', 'data-k': 'days', 'aria-label': `Month ${i + 1} days` }),
        el('small', { class: 'muted' }, 'days')));
      const read = () => [...rows.children].map((r, i) => ({
        name: r.querySelector('[data-k=name]').value.trim() || `Month ${i + 1}`,
        days: Math.max(1, Math.min(1000, Math.round(Number(r.querySelector('[data-k=days]').value) || 1))),
      }));
      const total = el('small', { class: 'muted' });
      const sync = () => {
        customMonths = read();
        total.textContent = `${customMonths.length} month${customMonths.length === 1 ? '' : 's'}, ${customMonths.reduce((t, m) => t + m.days, 0)} days a year.`;
        drawStart(); drawSeasons();
      };
      customMonths.forEach(addRow);
      count.addEventListener('change', () => {
        const n = Math.max(1, Math.min(100, Math.round(Number(count.value) || 1)));
        count.value = n;
        const len = rows.lastChild ? rows.lastChild.querySelector('[data-k=days]').value : 30;
        while (rows.children.length > n) rows.lastChild.remove();
        while (rows.children.length < n) addRow({ name: `Month ${rows.children.length + 1}`, days: len }, rows.children.length);
        sync();
      });
      rows.addEventListener('change', sync);
      sync();
      monthsWrap.replaceChildren(el('h3', {}, 'Months'),
        field('Number of months', count, null, 'How many months make up a year. Each one can have its own number of days below.'),
        el('small', { class: 'muted' }, 'Name · days in the month'), rows, total);
    };
    presetSel.addEventListener('change', () => { preset = presetSel.value; drawMonths(); drawStart(); drawSeasons(); drawClimate(); });
    drawMonths(); drawStart(); drawSeasons(); drawClimate();
    // How the days are split: four shifts, two (Day and Night) or hours. The starting shift list follows it.
    const modeSel = select(Object.entries(E.TIME_MODES), 'shifts4', { name: 'time_mode' });
    const shiftSel = select([], 0, { name: 'shift' });
    const startShift = field('Starting shift', shiftSel, null, shiftTip({}));
    const drawShifts = () => {
      const c = { ...E.PRESETS[preset].calendar, timeMode: modeSel.value }, names = E.shiftNames(c);
      const pick = { shifts4: 1, shifts2: 0, hours: Math.min(names.length - 1, Math.round(names.length / 3)) }[modeSel.value];
      shiftSel.replaceChildren(...names.map((n, i) => el('option', { value: i }, n)));
      shiftSel.value = String(pick);
      startShift.querySelector('.lbl').firstChild.textContent = modeSel.value === 'hours' ? 'Starting hour' : 'Starting shift';
      startShift.querySelector('.tip')?.setAttribute('data-tip', shiftTip(c));
    };
    modeSel.addEventListener('change', drawShifts);
    presetSel.addEventListener('change', drawShifts);
    drawShifts();
    const f = el('form', { class: 'card narrow' }, el('h1', {}, 'New campaign'),
      field('Name', el('input', { name: 'name', required: true, maxlength: 150 })),
      field('Description', el('textarea', { name: 'description', rows: 2 })),
      field('Calendar preset', presetSel, 'Every preset can be fully customized afterwards (Settings tab).',
        'Sets the months, weekdays, moons, seasons, starting regions and holidays. Pick the closest one and edit it later.'),
      monthsWrap, startWrap,
      field('Time tracking', modeSel, 'You can change this later on the Settings tab.',
        'How each day is split. Four shifts: Dawn, Midday, Dusk and Overnight, about six hours each. Two shifts: Day and Night. Hours: every hour of the day from midnight, like a normal calendar. Weather, light and visibility follow the time of day in every mode, and the travel planner counts in the same steps.'),
      startShift, climateWrap, seasonWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Create'), btn('Cancel', () => (location.hash = '#/'))));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const p = E.PRESETS[preset], v = formData(f);
      try {
        const r = await post('campaign_create', {
          name: v.name, description: v.description, calendar: { ...presetCal(), seasons: seasons.getSeasons(), timeMode: v.time_mode }, settings: { ...p.settings },
          current_shift: picker.getAbs() * E.slotsPerDay({ ...presetCal(), timeMode: v.time_mode }) + Number(v.shift),
          regions: p.regions.map(r => r === homeRegion() ? { ...r, settings: { ...r.settings, climate: v.climate } } : r), holidays: p.holidays,
        });
        location.hash = `#/c/${r.id}`;
      } catch (err) { toast(err.message, true); }
    });
    mount(f);
  }

  // ------------------------------------------------------------ campaign shell
  const TABS = [['today', 'Current Day'], ['calendar', 'Calendar'], ['travel', 'Travel'], ['downtime', 'Downtime'], ['regions', 'Regions'], ['holidays', 'Holidays'], ['members', 'Members'], ['settings', 'Settings']];
  const TAB_TIPS = {
    today: 'The campaign\'s current day up close: every shift, its weather and visibility, and the day\'s events',
    calendar: 'Month and week views of days, weather, visibility, moons and events',
    travel: 'Work out how long a journey takes, then pass that much time',
    downtime: 'Rests and downtime: what the party does, and who does it',
    regions: 'Places with their own climate, light source and terrain',
    holidays: 'Festivals and recurring days shown on the calendar',
    members: 'Who plays in this campaign, and who can GM it',
    settings: 'Campaign options and the calendar itself (GM only)',
  };
  function campaignHeader(active) {
    const c = cal(), d = today(), sh = E.mod(nowShift(), spd());
    const head = el('section', { class: 'nowbar' });
    const draw = async () => {
      let dayRow = null;
      try { dayRow = (await fetchRange(d, d)).days.get(d) || null; } catch { /* ignore */ }
      const region = regionById(dayRow?.region_id) || currentRegion();
      const w = dayRow?.weather || null, sw = shiftWx(d, region, w)[sh] || null;
      const v = E.visibility(c, region, sw, d, sh, null);
      const hol = E.holidaysOn(c, S.holidays, d);
      head.replaceChildren(...clean([
        el('div', { class: 'now-main' },
          el('div', { class: 'now-title' }, el('h1', {}, S.camp.name), el('span', { class: `role ${S.role}`, 'data-tip': isGM()
            ? 'You are a GM here: you can pass time, edit days and see secret events, notes and future weather'
            : 'You are a player here: GM notes, secret events and (unless allowed) future weather are hidden' }, isGM() ? 'GM view' : 'Player view')),
          el('div', { class: 'now-time' },
            el('a', { href: `#/c/${S.camp.id}/today`, class: 'now-date', 'data-tip': `The current ${word()} and date in the campaign. Click to open today` }, `${shiftNames()[sh]} · ${E.fmtDate(c, d)}`),
            el('span', { class: 'now-meta' }, region ? el('span', { 'data-tip': `Where the party is today: ${regionSummary(region)}` }, `📍 ${region.name}`) : null, ' ',
              weatherText(sw, w?.partial ? `Weather this ${shiftNames()[sh]}` : `Weather this ${shiftNames()[sh]}. Day's forecast: ${E.weatherLabel(w, tempUnit())}`), ' ', visPill(v), ' ', moonBadges(d),
              hol.map(holidayChip)))),
        isGM() ? passTimeWidget() : null]));
    };
    draw();
    const tabs = el('nav', { class: 'tabs' }, TABS.filter(([k]) => k !== 'settings' || isGM()).map(([k, l]) => el('a', { href: `#/c/${S.camp.id}/${k}`, class: k === active ? 'on' : '', 'data-tip': TAB_TIPS[k] }, l)));
    return [head, tabs];
  }

  function passTimeWidget() {
    const def = { day: 'shift', week: 'day', month: 'week' }[settings().time_unit || 'day'] || 'shift';
    const amt = el('input', { type: 'number', value: 1, min: -9999, class: 'w-num', 'aria-label': 'Amount', 'data-tip': 'How much time to pass. A negative number winds the clock back' });
    const unit = select([['shift', `${word()}(s)`], ['day', 'day(s)'], ['week', 'week(s)'], ['month', 'month(s)'], ['year', 'year(s)']], def, { 'aria-label': 'Unit',
      'data-tip': `A day has ${hourMode() ? `${spd()} hours` : spd() === 2 ? 'two shifts, Day and Night' : 'four shifts'}. Months and years follow this campaign's calendar` });
    const act = el('input', { placeholder: `Activity for the passed ${word()}s (optional)`, class: 'grow', list: 'pass-actions',
      'data-tip': `Written into every ${word()} that passes, e.g. "Marching to Altdorf". Pick a common action from the suggestions or type your own. ${Word()}s that already have an activity keep it` });
    const go = btn('Pass time ▶', null, 'primary', 'Move "now" forward and roll weather for every new day');
    go.addEventListener('click', busy(go, async () => {
      const n = unitShifts(unit.value, Number(amt.value) || 0);
      if (Math.abs(n) > spd() * 3650 && !await confirmDialog(`That jumps ${Math.round(Math.abs(n) / spd())} days. Continue?`)) return;
      await passShifts(n, act.value.trim());
      vs().anchor = today();
      toast(`Now: ${E.fmtShift(cal(), nowShift())}`);
      route();
    }));
    const back = btn(`◀ 1 ${word()}`, null, 'small', `Step back one ${word()}. Recorded weather, notes and activities stay`);
    back.addEventListener('click', busy(back, async () => { await passShifts(-1); route(); }));
    return el('div', { class: 'passtime' }, el('span', { class: 'lbl' }, 'Pass time', tip('Advance the campaign clock. Players see the new "now" straight away.')), amt, unit, act, actionList('pass-actions'), go, back);
  }

  // ------------------------------------------------------------ calendar tab
  const viewState = {};
  function vs() { return viewState[S.camp.id] || (viewState[S.camp.id] = { mode: settings().time_unit === 'day' ? 'week' : 'month', anchor: today() }); }

  async function viewCalendar() {
    const c = cal(), st = vs();
    const body = el('div', { class: 'card' });
    const anchor = st.anchor;
    let from, to, title, seasonLine = null;
    if (st.mode === 'month') {
      const p = E.fromAbs(c, anchor);
      from = E.toAbs(c, p.year, p.month, 1);
      to = from + E.monthLength(c, p.year, p.month) - 1;
      title = `${c.months[p.month].name} ${E.yearLabel(c, p.year)}`;
      const segs = (c.seasons || []).length ? E.monthSeasons(c, p.year)[p.month].seasons : [];
      if (segs.length) seasonLine = el('div', { class: 'seasonline' }, segs.map((x, i) =>
        el('span', { class: 'seasonseg' }, seasonChip(x), i ? ` begins on day ${x.from}` : '')));
    } else {
      // walk back to the first weekday, then forward through a full week (festival days have no weekday)
      const wl = E.weekLength(c);
      let start = anchor, guard = 0;
      if (c.weekdays.length) while (E.weekday(c, start) !== 0 && guard++ < 400) start--;
      let end = start, n = 0;
      while (n < wl && end - start < 400) { if (!c.weekdays.length || E.weekday(c, end) !== null) n++; end++; }
      from = start; to = end - 1;
      title = `${E.fmtDate(c, from, { noWeekday: true })} – ${E.fmtDate(c, to, { noWeekday: true })}`;
    }
    const step = dir => {
      if (st.mode === 'month') {
        const p = E.fromAbs(c, anchor);
        let y = p.year, m = p.month + dir;
        for (let guard = 0; guard < c.months.length; guard++) { // skip leap-only months in common years (like Overlithe)
          if (m < 0) { m = c.months.length - 1; y--; } else if (m >= c.months.length) { m = 0; y++; }
          if (E.monthLength(c, y, m) > 0) break;
          m += dir;
        }
        st.anchor = E.toAbs(c, y, m, 1);
      } else st.anchor = anchor + dir * E.weekLength(c);
      route();
    };
    const jump = datePicker(anchor);
    const toolbar = el('div', { class: 'calbar' },
      btn('◀', () => step(-1), 'small', `Previous ${st.mode}`), el('h2', {}, title), btn('▶', () => step(1), 'small', `Next ${st.mode}`),
      btn('Today', () => { st.anchor = today(); route(); }, 'small', 'Jump back to the current day'),
      el('span', { class: 'seg' },
        btn('Month', () => { st.mode = 'month'; route(); }, st.mode === 'month' ? 'small on' : 'small', 'A month grid with weather, moon phases and events'),
        btn('Week', () => { st.mode = 'week'; route(); }, st.mode === 'week' ? 'small on' : 'small', hourMode() ? 'One row per day showing the hours with an activity, their visibility and activity' : 'One row per day showing every shift, its visibility and activity')),
      el('span', { class: 'jump' }, jump, btn('Go', () => { st.anchor = jump.getAbs(); route(); }, 'small', 'Show the date picked on the left')));

    mount(...campaignHeader('calendar'), toolbar, seasonLine, body);
    body.append(el('p', { class: 'muted' }, 'Loading…'));
    const data = await fetchRange(from, to);
    const missing = []; for (let d = from; d <= to; d++) if (!data.days.get(d)?.weather) missing.push(d);
    const content = st.mode === 'month' ? monthGrid(from, to, data) : weekList(from, to, data);
    body.replaceChildren(content);
    if (isGM() && missing.length) {
      const g = btn(`Generate weather for ${missing.length} day(s) here`, null, 'small', 'Roll weather now for the days shown that have none yet, using each day\'s region');
      g.addEventListener('click', busy(g, async () => { await ensureWeather(from, to); route(); }));
      body.append(el('div', { class: 'row' }, g, el('small', { class: 'muted' }, 'Days are generated automatically as time passes; this forecasts ahead. Players only see future weather if you allow it in Settings.')));
    }
  }

  function dayEvents(data, d) { return data.events.filter(e => Number(e.abs_day) <= d && Number(e.end_day ?? e.abs_day) >= d); }
  function dayShifts(data, d) { const o = {}; data.shifts.filter(s => Number(s.abs_day) === d).forEach(s => (o[s.shift] = s)); return o; }

  /** Moons reaching new / first quarter / full / last quarter on day d (the day the phase is closest). */
  function keyMoonPhases(d) {
    const before = E.moons(cal(), d - 1), now = E.moons(cal(), d), after = E.moons(cal(), d + 1);
    const dist = (ph, t) => Math.min(Math.abs(ph - t), 1 - Math.abs(ph - t));
    const out = [];
    now.forEach((m, i) => {
      for (const [t, label, icon] of [[0, 'New', '🌑'], [0.25, 'First quarter', '🌓'], [0.5, 'Full', '🌕'], [0.75, 'Last quarter', '🌗']]) {
        const x = dist(m.phase, t);
        if (x < 0.06 && x <= dist(before[i].phase, t) && x < dist(after[i].phase, t)) out.push({ name: m.name, label, icon });
      }
    });
    return out;
  }

  const evLine = e => el('div', { class: 'evline' + (Number(e.is_secret) ? ' secret' : ''), 'data-tip': Number(e.is_secret) ? 'Secret event: only GMs can see it' : null },
    Number(e.is_secret) ? '🔒 ' : el('span', { class: 'evdot', style: e.tags?.length ? { color: e.tags[0].color } : null }, '● '), e.title);
  function dayCell(d, data, compact) {
    const c = cal(), p = E.fromAbs(c, d), row = data.days.get(d);
    const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
    const w = row?.weather, def = w ? E.WEATHER[w.type] : null;
    const cls = ['daycell'];
    if (d === today()) cls.push('today');
    if (d < today()) cls.push('past');
    if (p.intercalary) cls.push('festival');
    if (evs.length || hol.length) cls.push('has-ev');
    return el('a', { class: cls.join(' '), href: `#/c/${S.camp.id}/day/${d}` },
      el('div', { class: 'dc-top' }, el('span', { class: 'dnum' }, p.intercalary && E.monthLength(c, p.year, p.month) === 1 ? c.months[p.month].name : p.day),
        el('span', { class: 'dc-icons' }, def ? el('span', { 'data-tip': E.weatherLabel(w, tempUnit()) }, def.icon) : null,
          compact ? null : keyMoonPhases(d).map(m => el('span', { 'data-tip': `${m.name}: ${m.label} moon` }, m.icon)))),
      hol.map(x => el('div', { class: 'chip', style: { background: x.color }, 'data-tip': x.description || `Holiday: ${x.name}` }, x.name)),
      evs.slice(0, 3).map(evLine),
      evs.length > 3 ? el('div', { class: 'muted small', 'data-tip': evs.slice(3).map(e => e.title).join('\n') }, `+${evs.length - 3} more`) : null,
      row?.has_notes ? el('div', { class: 'muted small', 'data-tip': 'This day has notes. Open it to read them' }, '📝') : null);
  }

  function monthGrid(from, to, data) {
    const c = cal(), wl = E.weekLength(c);
    const p = E.fromAbs(c, from);
    if (c.months[p.month].intercalary || !c.weekdays.length) {
      return el('div', { class: 'grid-free', style: { gridTemplateColumns: `repeat(${Math.min(wl, to - from + 1)}, minmax(0,1fr))` } },
        Array.from({ length: to - from + 1 }, (_, i) => dayCell(from + i, data)));
    }
    const lead = E.weekday(c, from) || 0;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(el('div', { class: 'daycell empty' }));
    for (let d = from; d <= to; d++) cells.push(dayCell(d, data));
    return el('div', {},
      el('div', { class: 'grid-head', style: { gridTemplateColumns: `repeat(${wl}, minmax(0,1fr))` } }, c.weekdays.map(n => el('div', { 'data-tip': n }, n.slice(0, 3)))),
      el('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${wl}, minmax(0,1fr))` } }, cells));
  }

  function weekList(from, to, data) {
    const c = cal(), names = shiftNames(), slots = names.map((_, i) => i);
    const rows = [];
    for (let d = from; d <= to; d++) {
      const row = data.days.get(d), w = row?.weather, sh = dayShifts(data, d);
      const reg = regionById(row?.region_id) || currentRegion(), sws = shiftWx(d, reg, w);
      const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
      rows.push(el('a', { class: 'weekrow' + (d === today() ? ' today' : ''), href: `#/c/${S.camp.id}/day/${d}` },
        el('div', { class: 'wr-date' }, el('strong', {}, E.fmtDate(c, d)), el('div', { class: 'small' }, weatherText(w), ' ', moonBadges(d)),
          hol.map(holidayChip), tagsOf(evs).map(tagChip), evs.map(evLine)),
        el('div', { class: 'wr-shifts', style: spd() === 2 ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } : {} }, slots.filter(i => !hourMode() || sh[i]?.activity || d * spd() + i === nowShift()).map(i => {
          const s = sh[i] || {};
          const sw = sws[i] || null, v = E.visibility(c, reg, sw, d, i, s.visibility_override);
          const isNow = d * spd() + i === nowShift();
          return el('div', { class: 'shiftbox' + (isNow ? ' now' : ''), 'data-tip': isNow ? `This is the current ${word()}` : null },
            el('div', { class: 'sb-head' }, el('span', {}, names[i], sw ? el('span', { class: 'sb-wx', 'data-tip': E.weatherLabel(sw, tempUnit()) }, ` ${E.WEATHER[sw.type]?.icon || ''}`) : null), visPill(v)),
            el('div', { class: 'sb-act' }, s.activity || el('span', { class: 'muted' }, '—')));
        }))));
    }
    return el('div', { class: 'weeklist' }, rows);
  }

  // ------------------------------------------------------------ day drill-down
  /** current: the Current Day tab, which opens on today with the current shift up front and can step to other days. */
  async function viewDay(d, current = false) {
    const c = cal(), names = shiftNames();
    const r = await api('day', { query: { cid: S.camp.id, d } });
    const row = r.day || {};
    const region = regionById(row.region_id) || currentRegion();
    const w = row.weather || null;
    const shifts = {}; r.shifts.forEach(s => (shifts[s.shift] = s));
    const p = E.fromAbs(c, d);
    const sea = E.season(c, d, region?.settings?.hemisphere);
    const hol = E.holidaysOn(c, S.holidays, d);

    const toCalendar = btn(current ? 'Show in calendar' : 'Back to calendar', () => { vs().anchor = d; location.hash = `#/c/${S.camp.id}/calendar`; }, 'small',
      current ? 'Open the calendar on this day' : 'Return to the calendar, showing this day');
    const exportBtn = btn('⬇ Export', () => DayExport.download({ camp: S.camp, role: S.role, regions: S.regions, holidays: S.holidays, tempUnit: tempUnit(), d, data: r }), 'small',
      'Download this day as a Markdown file (events, weather, notes and shifts) to paste into Scabard or another wiki. It holds only what you can see here');
    const tabDay = n => `#/c/${S.camp.id}/${current ? `today/${n}` : `day/${n}`}`;
    const nav = current ? el('div', { class: 'calbar' },
      el('a', { class: 'button small', href: tabDay(d - 1) }, '◀ Previous day'),
      el('h2', {}, E.fmtDate(c, d)),
      el('a', { class: 'button small', href: tabDay(d + 1) }, 'Next day ▶'),
      d !== today() ? el('a', { class: 'button small', href: `#/c/${S.camp.id}/today`, 'data-tip': 'Back to the campaign\'s current day' }, 'Return to today') : null,
      toCalendar, exportBtn) : el('div', { class: 'calbar' },
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d - 1}` }, '◀ Previous day'),
      el('h2', {}, E.fmtDate(c, d)),
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d + 1}` }, 'Next day ▶'),
      toCalendar,
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${today()}`, 'data-tip': 'Open the campaign\'s current day' }, 'Go to today'),
      exportBtn);

    // --- overview card
    const overview = el('div', { class: 'card' },
      el('div', { class: 'kv' },
        el('div', {}, el('span', { class: 'lbl' }, 'Season', tip('From the calendar\'s season dates, flipped for regions in the other hemisphere. The season picks which weather odds apply.')), sea.name || '—'),
        el('div', {}, el('span', { class: 'lbl' }, 'Region'), region ? el('span', { 'data-tip': regionSummary(region) }, region.name) : '—',
          !isGM() && row.locations ? el('span', { class: 'lbl', style: { marginTop: '8px' } }, 'Locations visited') : null,
          !isGM() && row.locations ? el('span', { class: 'pre' }, row.locations) : null),
        el('div', {}, el('span', { class: 'lbl' }, w?.partial ? 'Weather now' : 'Forecast', tip(w?.partial ? SO_FAR_TIP : FORECAST_TIP)), weatherText(w)),
        el('div', {}, el('span', { class: 'lbl' }, 'Moons'), E.moons(c, d).map(m => el('div', {}, `${m.icon} ${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)`))),
        hol.length ? el('div', {}, el('span', { class: 'lbl' }, 'Holidays'), hol.map(x => el('div', {}, holidayChip(x), x.description ? ` ${x.description}` : ''))) : null,
        d === today() ? el('div', {}, el('span', { class: 'lbl' }, 'Now'), names[E.mod(nowShift(), spd())]) : null),
      !isGM() && row.notes ? el('div', { class: 'notes' }, el('span', { class: 'lbl' }, 'Notes'), el('p', { class: 'pre' }, row.notes)) : null);

    if (isGM()) overview.append(dayEditor(d, row, region, w));

    // --- shifts
    const sws = shiftWx(d, region, w);
    const shiftCards = el('div', { class: 'shifts' + (hourMode() ? ' hours' : '') }, names.map((_, i) =>
      shiftCard(d, i, shifts[i] || {}, region, sws[i] || null, !!w?.partial && !sws[i], (r.shift_notes || []).filter(n => Number(n.shift) === i))));

    // --- events
    const evCard = el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h3', {}, 'Events'),
      (isGM() || settings().players_can_add_events) ? btn('+ Add event', () => evCard.append(eventForm(d)), 'primary small', 'Log something that happened (or will happen) on this day') : null),
      r.events.length ? r.events.map(e => eventView(e, d)) : el('p', { class: 'muted' }, 'No events on this day.'));

    mount(...campaignHeader(current ? 'today' : 'calendar'), nav, current ? dayHero(d, region, w, sws, shifts) : null, overview,
      el('h3', { class: 'pad' }, `${Word()}s`, tip(shiftTip())), shiftCards, evCard);
  }

  /** The Current Day tab's banner and the day's shifts (or hours) at a glance. On today it shows the shift the campaign
   * clock is on, large; on any other day, the day's forecast (what the player may see of it). */
  function dayHero(d, region, w, sws, shifts) {
    const c = cal(), names = shiftNames(), isToday = d === today();
    const sh = isToday ? E.mod(nowShift(), spd()) : d < today() ? spd() : -1; // which shifts have passed
    let main;
    if (isToday) {
      const sw = sws[sh] || null, def = sw ? E.WEATHER[sw.type] || {} : null;
      const v = E.visibility(c, region, sw, d, sh, shifts[sh]?.visibility_override);
      main = el('div', { class: 'dh-now' },
        el('div', { class: 'dh-icon', 'aria-hidden': 'true' }, def?.icon || '·'),
        el('div', {},
          el('div', { class: 'lbl' }, 'Now'),
          el('div', { class: 'dh-shift' }, names[sh]),
          el('div', {}, weatherText(sw, `Weather this ${names[sh]}`), ' ', visPill(v)),
          shifts[sh]?.activity ? el('p', { class: 'pre dh-act' }, shifts[sh].activity) : null));
    } else {
      const def = w ? E.WEATHER[w.type] || {} : null;
      main = el('div', { class: 'dh-now' },
        el('div', { class: 'dh-icon', 'aria-hidden': 'true' }, def?.icon || '·'),
        el('div', {},
          el('div', { class: 'lbl' }, d < today() ? 'Past day' : 'Coming day'),
          el('div', { class: 'dh-shift' }, w ? def.label || w.type : isGM() ? 'No weather recorded' : 'Weather not known yet'),
          w ? el('div', {}, weatherText(w)) : null));
    }
    return el('section', { class: 'card dayhero' }, main,
      el('div', { class: 'dh-strip' + (hourMode() ? ' hours' : ''), style: spd() === 2 ? { gridTemplateColumns: 'repeat(2, minmax(64px, 1fr))', maxWidth: '240px' } : {} }, names.map((_, i) => {
        const x = sws[i] || null, cls = ['dh-step'];
        if (i === sh) cls.push('now'); else if (i < sh) cls.push('past');
        return el('div', { class: cls.join(' '), 'data-tip': x ? `${names[i]}: ${E.weatherLabel(x, tempUnit())}` : `${names[i]}: weather not known yet` },
          el('span', { class: 'dh-step-icon' }, x ? E.WEATHER[x.type]?.icon || '' : '?'), el('span', { class: 'small' }, names[i]));
      })));
  }

  /** A region select with a "Custom…" choice that shows a name box. resolve() returns the picked region id ('' for the
   * lead option); a custom name is first saved as a new region, starting from the party's current region's conditions. */
  function regionPicker(lead, value, attrs) {
    const sel = select([...lead, ...S.regions.map(r => [r.id, r.name]), ['custom', 'Custom…']], value, attrs);
    const name = el('input', { maxlength: 150, placeholder: 'New region name', 'aria-label': 'Custom region name', style: { display: 'none' } });
    sel.addEventListener('change', () => { name.style.display = sel.value === 'custom' ? '' : 'none'; if (sel.value === 'custom') name.focus(); });
    const node = el('span', { class: 'row' }, sel, name);
    const resolve = async () => {
      if (sel.value !== 'custom') return sel.value;
      const n = name.value.trim();
      if (!n) throw new Error('Name the custom region');
      const same = S.regions.find(r => r.name.toLowerCase() === n.toLowerCase());
      if (same) return String(same.id);
      const base = currentRegion();
      const { id } = await post('region_save', { name: n, description: '', settings: { ...(base?.settings || { climate: 'temperate' }) } }, S.camp.id);
      S.regions.push({ id, name: n, description: '', settings: { ...(base?.settings || { climate: 'temperate' }) } });
      S.regions.sort((a, b) => a.name.localeCompare(b.name));
      sel.insertBefore(el('option', { value: id }, n), sel.lastChild);
      sel.value = String(id); name.style.display = 'none';
      toast(`Added region "${n}". Set its climate on the Regions tab`);
      return String(id);
    };
    return { node, sel, resolve };
  }

  function dayEditor(d, row, region, w) {
    const regPick = regionPicker([['', '— (current region)']], row.region_id ?? '', { name: 'region_id' });
    const wSel = select([['', '— none —'], ...Object.entries(E.WEATHER).map(([k, v]) => [k, `${v.icon} ${v.label}`])], w?.type || '', { name: 'wtype' });
    const tUnit = tempUnit();
    const tVal = w && typeof w.temp === 'number' ? E.toTempUnit(w.temp, tUnit, 1) : '';
    const temp = el('input', { type: 'number', name: 'temp', value: tVal, step: 'any', class: 'w-num' });
    const wind = select(E.WIND.map((n, i) => [i, n]), w?.wind || 0, { name: 'wind' });
    const notes = el('textarea', { name: 'notes', rows: 3, value: row.notes || '' });
    const gmn = el('textarea', { name: 'gm_notes', rows: 3, value: row.gm_notes || '' });
    const locs = el('textarea', { name: 'locations', rows: 2, value: row.locations || '', placeholder: 'e.g. Altdorf, the Grey Lady inn, Reikwald crossroads' });
    const f = el('form', { class: 'dayedit' },
      el('div', { class: 'grid2' },
        el('div', { class: 'stack' },
          field('Region for this day', regPick.node, null, 'Where the party spent this day. Its climate rolls the weather and its light source and terrain set visibility. "Current region" follows wherever the party is now.'),
          field('Locations visited', locs, null, 'The towns, sites and buildings the party went to this day. Players can see this')),
        field('Weather', el('span', { class: 'row' }, wSel, tipped(temp, 'Daytime high'), tUnit === 'none' ? '' : tempSym(tUnit), tipped(wind, 'Wind strength')), null,
          `Set the day's weather by hand. Rain, fog, snow and the like lower visibility; see the ${word()} cards below for the exact effect.`),
        field('Day notes (players can see)', notes),
        field('GM notes 🔒', gmn, null, 'Only GMs ever see these')),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, 'Save day'),
        tipped(btn('🎲 Re-roll weather', async () => {
          let rid;
          try { rid = await regPick.resolve(); } catch (err) { return toast(err.message, true); }
          const reg = regionById(rid) || region;
          const prev = (await fetchRange(d - 1, d - 1)).days.get(d - 1)?.weather || null;
          const nw = E.genWeather(cal(), S.camp.seed, reg, d, prev, Date.now());
          await post('day_update', { abs_day: d, region_id: rid || null, weather: withShiftWx(d, reg, nw), notes: notes.value, gm_notes: gmn.value, locations: locs.value }, S.camp.id);
          route();
        }, 'small'), 'Roll new weather for this day from the region\'s climate and the day before, and save it'),
        d !== today() ? btn('Make this day "now"', async () => { await passShifts(d * spd() + E.mod(nowShift(), spd()) - nowShift()); route(); }, 'small',
          `Move the campaign clock to this day, keeping the same ${word()}`) : null));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      let rid;
      try { rid = await regPick.resolve(); } catch (err) { return toast(err.message, true); }
      let weather = null;
      if (wSel.value) {
        let t = temp.value === '' ? null : Number(temp.value);
        if (t !== null) t = Math.round(E.fromTempUnit(t, tUnit));
        weather = withShiftWx(d, regionById(rid) || currentRegion(), { ...(w || {}), type: wSel.value, temp: t, wind: Number(wind.value) });
      }
      try {
        await post('day_update', { abs_day: d, region_id: rid || null, weather, notes: notes.value, gm_notes: gmn.value, locations: locs.value }, S.camp.id);
        toast('Day saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  /** hiddenWx: a player looking at a shift of today that hasn't come yet, whose weather the server held back. */
  function shiftCard(d, i, s, region, sw, hiddenWx, notes) {
    const c = cal(), names = shiftNames();
    const v = E.visibility(c, region, sw, d, i, s.visibility_override);
    const isNow = d * spd() + i === nowShift();
    const card = el('div', { class: 'card shiftcard' + (isNow ? ' now' : '') },
      el('div', { class: 'row spread' }, el('h4', {}, names[i], isNow ? el('span', { class: 'nowtag', 'data-tip': `The campaign clock is on this ${word()}` }, 'NOW') : null), visPill(v)),
      sw ? el('div', { class: 'small' }, weatherText(sw, `Weather this ${names[i]}, worked out from the day's forecast`))
        : hiddenWx ? el('div', { class: 'small muted', 'data-tip': `Players see each ${word()}'s weather once the campaign clock reaches it` }, 'Weather not known yet') : null,
      el('small', { class: 'muted', 'data-tip': `How the visibility score was worked out: base light for the ${word()}, then moonlight, weather and terrain` }, v.parts.join(' · ')));
    // In hours mode a day has many cards, so an hour with nothing recorded starts folded to its heading.
    const fold = c => {
      if (!hourMode() || isNow || s.activity || s.gm_notes || (s.visibility_override ?? '') !== '' || notes.length) return c;
      const det = el('details', { class: c.className + ' folded' }), sum = el('summary');
      sum.append(c.firstChild); det.append(sum, ...c.childNodes);
      return det;
    };
    if (!isGM()) {
      card.append(el('p', { class: 'pre' }, s.activity || el('span', { class: 'muted' }, 'No activity recorded.')), shiftNotes(d, i, notes));
      return fold(card);
    }
    const act = el('textarea', { rows: 2, value: s.activity || '', placeholder: `What the party does this ${word()}`, 'data-tip': 'Players can see this' });
    const hint = el('small', { class: 'muted' });
    const pick = actionPicker(a => {
      act.value = E.addShiftAction(act.value, a.name);
      hint.textContent = `${a.icon} ${a.name}: ${a.desc}`;
      act.focus();
    });
    const gmn = el('textarea', { rows: 2, value: s.gm_notes || '', placeholder: 'GM-only notes 🔒', 'data-tip': 'Only GMs ever see these' });
    const ov = select([['', 'Auto'], ...E.VIS_LABELS.map((l, k) => [k, `${k} ${l}`])], s.visibility_override ?? '');
    const save = btn('Save', null, 'small primary', `Save this ${word()}'s activity, notes and visibility`);
    save.addEventListener('click', busy(save, async () => {
      await post('shift_save', { abs_day: d, shift: i, activity: act.value, gm_notes: gmn.value, visibility_override: ov.value }, S.camp.id);
      toast(`${names[i]} saved`); route();
    }));
    card.append(pick, act, hint, gmn, el('div', { class: 'row' }, el('label', { class: 'inline' }, 'Visibility ', ov,
      tip(`Auto works it out from the light source, moonlight, weather and terrain. Pick a number to force it for this ${word()}, e.g. a magical darkness or a burning city.`)), save,
      !isNow ? btn('Set as now', async () => { await passShifts(d * spd() + i - nowShift()); route(); }, 'small', `Move the campaign clock to this ${word()}`) : null),
      shiftNotes(d, i, notes));
    return fold(card);
  }

  /** Who wrote something: their character name, with the player's own name on hover when it differs. */
  function byline(x) {
    const who = x.author || 'unknown';
    return x.player && x.player !== who ? el('span', { 'data-tip': `Played by ${x.player}` }, who) : who;
  }

  /** Free notes at the foot of a shift card, separate from events. Anyone in the campaign can add one. */
  function shiftNotes(d, i, notes) {
    const list = notes.map(n => el('div', { class: 'enote' },
      el('div', { class: 'pre' }, n.body),
      el('small', { class: 'muted' }, '— ', byline(n), `, ${n.created_at}`,
        (isGM() || Number(n.user_id) === S.user.id) ? tipped(btn('delete', async () => {
          if (!await confirmDialog('Delete this note?')) return;
          try { await post('shift_note_delete', { id: n.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'link small'), 'Delete this note') : null)));
    const input = el('textarea', { rows: 4, placeholder: 'Notes', 'aria-label': `Notes for ${shiftNames()[i]}`, 'data-tip': 'Everyone in the campaign can read these' });
    const add = btn('Add note', null, 'small', `Add your note to this ${word()}, signed with your character name`);
    add.addEventListener('click', busy(add, async () => {
      if (!input.value.trim()) return;
      await post('shift_note_add', { abs_day: d, shift: i, body: input.value }, S.camp.id); route();
    }));
    return el('div', { class: 'shiftnotes' }, el('span', { class: 'lbl' }, 'Notes'), el('div', { class: 'enotes' }, list), input, el('div', { class: 'row' }, add));
  }

  function eventView(e, d) {
    const c = cal();
    const mine = Number(e.created_by) === S.user.id;
    const span = e.end_day !== null && e.end_day !== undefined ? ` (${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })})` : '';
    const box = el('div', { class: 'event' + (Number(e.is_secret) ? ' secret' : '') });
    const notesList = el('div', { class: 'enotes' }, (e.notes || []).map(n => el('div', { class: 'enote' },
      el('div', { class: 'pre' }, n.body),
      el('small', { class: 'muted' }, '— ', byline(n), `, ${n.created_at}`,
        (isGM() || Number(n.user_id) === S.user.id) ? tipped(btn('delete', async () => {
          if (!await confirmDialog('Delete this note?')) return;
          try { await post('note_delete', { id: n.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'link small'), 'Delete this note') : null))));
    const noteIn = el('textarea', { rows: 2, placeholder: 'Add a note…' });
    const addNote = btn('Add note', null, 'small', 'Add a comment to this event. Everyone who can see the event can read it');
    addNote.addEventListener('click', busy(addNote, async () => {
      if (!noteIn.value.trim()) return;
      await post('note_add', { event_id: e.id, body: noteIn.value }, S.camp.id); route();
    }));
    box.append(...[
      el('div', { class: 'row spread' },
        el('h4', {}, Number(e.is_secret) ? secretTag() : null, e.title),
        el('small', { class: 'muted' }, shiftRange(e), span)),
      e.tags?.length ? el('div', { class: 'etags' }, e.tags.map(tagChip)) : null,
      e.body ? el('p', { class: 'pre' }, e.body) : null,
      el('small', { class: 'muted' }, 'Added by ', byline(e)),
      (isGM() || mine) ? el('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(eventForm(d, e)), 'small', 'Change this event'),
        btn('Delete', async () => {
          if (!await confirmDialog(`Delete "${e.title}"?`)) return;
          try { await post('event_delete', { id: e.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Delete this event and its notes')) : null,
      notesList, el('div', { class: 'row' }, noteIn, addNote)].filter(Boolean));
    return box;
  }

  /** Toggle tags on and off, or make a new one with its own colour.
   * get() returns the picked tags as [{ name, color }]. */
  function tagPicker(picked) {
    const key = t => t.name.toLowerCase();
    const known = new Map(S.tags.map(t => [key(t), t]));
    for (const t of picked) if (!known.has(key(t))) known.set(key(t), t);
    const on = new Set(picked.map(key));
    const list = el('div', { class: 'tagpick' });
    const draw = () => list.replaceChildren(...[...known.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
      const k = key(t), sel = on.has(k);
      const b = el('button', { type: 'button', class: 'tagopt' + (sel ? ' on' : ''), 'aria-pressed': String(sel),
        'data-tip': sel ? `Tagged ${t.name}. Click to take it off` : `Click to tag this event ${t.name}`,
        onclick: () => { sel ? on.delete(k) : on.add(k); draw(); } }, el('span', { class: 'tick', 'aria-hidden': 'true' }, sel ? '✓ ' : ''), t.name);
      b.style.setProperty('--tag', t.color); // el()'s style object can't set custom properties
      return b;
    }));
    const PALETTE = ['#2563eb', '#0891b2', '#16a34a', '#9333ea', '#e11d48', '#ea580c', '#4d7c0f', '#0f766e'];
    const name = el('input', { maxlength: 40, placeholder: 'New tag', 'aria-label': 'New tag name' });
    const color = el('input', { type: 'color', value: PALETTE[known.size % PALETTE.length], 'aria-label': 'New tag colour', 'data-tip': 'Colour for the new tag' });
    const add = () => {
      const n = name.value.trim();
      if (!n) return;
      const k = n.toLowerCase();
      if (!known.has(k)) known.set(k, { name: n, color: color.value });
      on.add(k); name.value = ''; color.value = PALETTE[known.size % PALETTE.length]; draw();
    };
    name.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
    draw();
    const node = el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags', tip('Group events by kind. Each tag has a colour, shown on the days that carry it in week view. Make your own with New tag')),
      list, el('div', { class: 'row' }, name, color, btn('+ Add tag', add, 'small', 'Create this tag and put it on the event')));
    return { node, get: () => [...on].map(k => ({ name: known.get(k).name, color: known.get(k).color })) };
  }

  function eventForm(d, e = {}) {
    const names = shiftNames();
    const start = Number(e.abs_day ?? d); // a new event starts on the day it is added from
    const lasts = e.end_day !== null && e.end_day !== undefined ? Number(e.end_day) - start + 1 : 1;
    const shiftOpts = names.map((n, i) => [i, n]);
    const allDay = el('input', { type: 'checkbox', name: 'all_day', checked: e.shift === null || e.shift === undefined });
    const shiftStart = select(shiftOpts, e.shift ?? 0, { name: 'shift' });
    const shiftEnd = select(shiftOpts, e.shift_end ?? e.shift ?? 0, { name: 'shift_end', required: true });
    // Shift End follows Shift Start until it is set apart, so one pick means one shift.
    let lastStart = shiftStart.value;
    shiftStart.addEventListener('change', () => { if (shiftEnd.value === lastStart) shiftEnd.value = shiftStart.value; lastStart = shiftStart.value; });
    const startField = field(`${Word()} Start`, shiftStart, null, `The ${word()} the event begins in`);
    const endField = field(`${Word()} End`, shiftEnd, null, `The ${word()} it ends in, on its last day. The same as ${Word()} Start for a one-${word()} event`);
    const syncAllDay = () => { startField.hidden = endField.hidden = allDay.checked; };
    allDay.addEventListener('change', syncAllDay); syncAllDay();
    const tags = tagPicker(e.tags || []);
    const f = el('form', { class: 'event editing' },
      el('div', { class: 'grid2' },
        field('Title', el('input', { name: 'title', value: e.title || '', required: true, maxlength: 200 })),
        field('All day', allDay, null, `For things that fill the whole day. Untick to pick the ${word()}s it starts and ends in`),
        startField, endField,
        field('Lasts (days)', el('input', { type: 'number', name: 'lasts', min: 1, value: lasts }), null, 'More than 1 shows the event on every day it covers, like a siege or a voyage'),
        isGM() ? field('Secret (GM only)', el('input', { type: 'checkbox', name: 'is_secret', checked: !!Number(e.is_secret) }), null, 'Players won\'t see this event or its notes') : null),
      tags.node,
      field('Details', el('textarea', { name: 'body', rows: 4, value: e.body || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, e.id ? 'Save event' : 'Add event'), btn('Cancel', () => route(), 'small')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = formData(f), n = Math.max(1, Number(v.lasts) || 1);
      const timed = !allDay.checked;
      if (timed && n === 1 && Number(shiftEnd.value) < Number(shiftStart.value)) { toast(`${Word()} End is before ${Word()} Start`, true); return; }
      const picked = tags.get();
      try {
        await post('event_save', { id: e.id, abs_day: start, end_day: n > 1 ? start + n - 1 : null,
          shift: timed ? shiftStart.value : null, shift_end: timed ? shiftEnd.value : null,
          title: v.title, body: v.body, is_secret: v.is_secret, tags: picked }, S.camp.id);
        for (const t of picked) if (!S.tags.some(x => x.name.toLowerCase() === t.name.toLowerCase())) S.tags.push(t);
        toast('Event saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ travel tab
  function viewTravel() {
    const out = el('div', { class: 'travel-out' });
    const genre = E.genreOf(settings());
    const modes = [
      ['overland', 'Overland (on foot, mounted, by road or rail)'],
      ['sea', 'Sea and river (oar, sail, engine)'],
      ['air', 'Air (wing, airship, aircraft)'],
      ['hohmann', 'Orbital transfer (Hohmann, minimum fuel)'],
      ['brachistochrone', 'Constant-thrust burn (flip-and-burn / torch drive)'],
      ['relativistic', 'Interstellar at relativistic speed'],
      ['ftl', 'FTL / jump drive'],
    ].filter(([k]) => E.GENRE_MODES[genre].includes(k));
    const modeSel = select(modes, 'overland', { class: 'travel-mode' });
    const fieldsWrap = el('div', { class: 'grid2' });
    // One Metric / Imperial choice for every distance and speed box below; the maths itself always runs in km.
    const startUnits = campTempUnit() === 'F' ? 'imperial' : 'metric';
    const units = el('div', { class: 'travel-units', role: 'radiogroup', 'aria-label': 'Units', 'data-tip': 'Metric or Imperial for every distance and speed in the planner' },
      [['metric', 'Metric'], ['imperial', 'Imperial']].map(([v, l]) =>
        el('label', {}, el('input', { type: 'radio', name: 'travel_units', value: v, checked: v === startUnits }), l)));
    const KM_MI = 1.609344, imp = () => units.querySelector('input:checked').value === 'imperial';
    const unitSel = () => select([imp() ? ['mi', 'miles'] : ['km', 'km'], ['AU', 'AU'], ['LY', 'light-years'], ['ls', 'light-seconds'], ['lm', 'light-minutes']], 'AU', { name: 'unit' });
    const shiftH = () => E.slotHours(cal());
    const num = x => +x.toPrecision(3);
    /** A "pick a sample" select over groups of {label, …} items; onPick gets the chosen item. */
    const samplePicker = (groups, onPick, labelOf = i => i.label) => {
      const items = [];
      const s = el('select', { 'aria-label': 'Sample' }, el('option', { value: '' }, 'Pick a sample…'),
        groups.map(g => el('optgroup', { label: g.group }, g.items.map(i => el('option', { value: items.push(i) - 1 }, labelOf(i))))));
      s.addEventListener('change', () => { if (s.value !== '') onPick(items[s.value]); });
      return s;
    };
    /** From / To star pickers that fill a light-year distance input. */
    const starPickers = dist => {
      const opts = E.STARS.map(([name, , , ly], i) => [i, i ? `${name} (${ly.toLocaleString()} LY from Sol)` : name]);
      const from = select(opts, 0, { 'aria-label': 'From star' }), to = select(opts, 1, { 'aria-label': 'To star' });
      const fill = () => { if (from.value !== to.value) dist.value = num(E.starDistance(Number(from.value), Number(to.value))); };
      from.addEventListener('change', fill); to.addEventListener('change', fill);
      return [field('From star system', from, null, 'Pick two star systems to fill in the distance between them, or type your own distance'),
        field('To star system', to)];
    };
    const drawFields = () => {
      const m = modeSel.value;
      const F = [];
      if (E.SPEED_MODES.includes(m)) {
        const groups = E.speedSamples(m, genre), first = groups[0].items[0];
        const dist = el('input', { name: 'distance', type: 'number', step: 'any', value: imp() ? { overland: 40, sea: 200, air: 300 }[m] : { overland: 60, sea: 300, air: 500 }[m] });
        const toUnit = kmh => num(imp() ? kmh / KM_MI : kmh), speedUnit = imp() ? 'mph' : 'km/h';
        const speed = el('input', { name: 'speed', type: 'number', step: 'any', value: toUnit(first.kmh) });
        const samples = samplePicker(groups, i => { speed.value = toUnit(i.kmh); }, i => `${i.label}: ${toUnit(i.kmh)} ${speedUnit}`);
        samples.name = 'sample';
        samples.selectedIndex = 1;
        speed.addEventListener('input', () => { samples.value = ''; });
        const h = shiftH(), n = spd(), dayH = +(h * n).toFixed(2), w = word();
        // How much of the day the party travels, in this campaign's shifts or hours (Settings → Time tracking).
        // The options are just the counts; what they mean goes in the hint under the box.
        const perDay = select(Array.from({ length: n }, (_, i) => [i + 1, `${i + 1} ${w}${i ? 's' : ''}`]),
          m === 'sea' ? n : hourMode() ? Math.min(8, n) : n === 2 ? 1 : 2, { name: 'shifts' });
        const hh = `${+h.toFixed(2)} h each. `;
        const perDayHint = hourMode() ? (m === 'sea' ? `Ships with a crew on watch sail all ${n}` : m === 'overland' ? 'About 8 is a normal day' : `${n} keeps going around the clock`)
          : n === 2 ? hh + (m === 'sea' ? 'Ships with a crew on watch sail both' : m === 'overland' ? '1 is a normal day' : '2 keeps going around the clock')
          : hh + (m === 'sea' ? 'Ships with a crew on watch sail all 4' : m === 'overland' ? '2 is a normal day, 3 a forced march' : '4 keeps going around the clock');
        F.push(field('Sample speed', samples, 'Real-world figures, each from a source listed on the About page. Fills in the speed'),
          field(`Distance (${imp() ? 'miles' : 'km'})`, dist),
          field(`Speed (${speedUnit})`, speed),
          field(`${Word()}s traveled per day`, perDay, perDayHint,
            hourMode() ? `How many of the calendar's ${n} hours a day the party is on the move. They rest for the others`
              : `A shift is ${n === 2 ? 'half' : 'a quarter'} of the calendar's ${dayH}-hour day. The party rests for the other${n === 2 ? '' : ' shifts'}`),
          el('input', { type: 'hidden', name: 'shift_hours', value: h }),
          el('input', { type: 'hidden', name: 'slots_per_day', value: n }),
          el('input', { type: 'hidden', name: 'slot', value: word() }),
          m === 'overland' ? field('Terrain multiplier', select([[1, 'Road / open ground ×1'], [2, 'Woods, hills or ruins ×2'], [3, 'Mountains ×3'], [4, 'Swamp ×4']], 1, { name: 'terrain' }), null,
            'Multiplies the travel time for slow going. ×2 means the trip takes twice as long. These follow the terrain speeds in the Year Zero Engine reference document (woods at half speed, mountains a third, swamp a quarter)') : null);
      } else if (m === 'hohmann') {
        const sys = el('select', { name: 'system' }, Object.entries(E.SYSTEMS).map(([k, s]) => el('option', { value: k }, s.label)));
        const r1 = el('input', { name: 'r1', type: 'number', step: 'any', value: 1 }), r2 = el('input', { name: 'r2', type: 'number', step: 'any', value: 1.524 });
        const b1 = el('select', { name: 'body1', 'aria-label': 'From body' }), b2 = el('select', { name: 'body2', 'aria-label': 'To body' });
        const fill = () => {
          const s = E.SYSTEMS[sys.value];
          // Moon systems give orbit radii in km; show them in miles for Imperial (converted back on Calculate).
          const mi = s.unit === 'km' && imp(), u = mi ? 'mi' : s.unit, r0 = r => (mi ? Math.round(r / KM_MI) : r);
          const opts = [['', 'custom…'], ...Object.entries(s.bodies).map(([n, r]) => [r0(r), `${n} (${r0(r).toLocaleString()} ${u})`])];
          const names = Object.keys(s.bodies);
          const pick = [names.indexOf('Earth') + 1, names.indexOf('Mars') + 1];
          [b1, b2].forEach((b, k) => { b.replaceChildren(...opts.map(([v, l]) => el('option', { value: v }, l))); b.selectedIndex = pick[k] > 0 ? pick[k] : Math.min(opts.length - 1, k + 1); });
          r1.value = b1.value; r2.value = b2.value;
          lbl1.firstChild.textContent = `From orbit radius (${u})`; lbl2.firstChild.textContent = `To orbit radius (${u})`;
        };
        b1.addEventListener('change', () => { if (b1.value) r1.value = b1.value; });
        b2.addEventListener('change', () => { if (b2.value) r2.value = b2.value; });
        const lbl1 = field('From', el('span', { class: 'row' }, b1, r1)), lbl2 = field('To', el('span', { class: 'row' }, b2, r2));
        sys.addEventListener('change', fill);
        F.push(field('Central body', sys, null, 'The star or planet both orbits go around. Pick a body from the lists or type an orbit radius'), lbl1, lbl2);
        fill();
      } else if (m === 'brachistochrone' || m === 'relativistic') {
        const dist = el('input', { name: 'distance', type: 'number', step: 'any', value: m === 'relativistic' ? 4.25 : 1.5 });
        const u = unitSel(); if (m === 'relativistic') u.value = 'LY';
        if (m === 'brachistochrone') {
          F.push(field('Sample distance', samplePicker(E.spaceDistances().map(g => ({ group: g.group, items: g.items.map(([label, d, unit]) => ({ label, d, unit })) })),
            i => { const mi = i.unit === 'km' && imp(); dist.value = mi ? num(i.d / KM_MI) : i.d; u.value = mi ? 'mi' : i.unit; }), 'Planet distances use average orbits'));
        } else F.push(...starPickers(dist));
        F.push(field('Distance', el('span', { class: 'row' }, dist, u)),
          field('Acceleration (g)', el('input', { name: 'g', type: 'number', step: 'any', value: m === 'relativistic' ? 1 : 0.3 }), '1 g = 9.81 m/s². The Expanse-style "juice" burns run 3–7 g; comfortable cruising is 0.3–1 g'),
          field('Speed cap (fraction of light, optional)', el('input', { name: 'max_speed_c', type: 'number', step: 'any', min: 0, max: 0.999, placeholder: 'none' }), 'Ship accelerates to the cap, coasts, then decelerates',
            '0.1 means a tenth of the speed of light. Leave empty to burn all the way to the midpoint'));
      } else {
        const kind = select([['rate', 'Speed in light-years per day'], ['fixed', 'Fixed duration per jump']], 'rate', { name: 'ftl_kind' });
        const dist = el('input', { name: 'distance', type: 'number', step: 'any', value: 4.25 });
        F.push(field('FTL type', kind, null, 'Speed: the trip scales with distance. Fixed: every jump takes the same time, however far'),
          ...starPickers(dist),
          field('Distance (LY)', dist),
          field('FTL speed (LY per day)', el('input', { name: 'rate', type: 'number', step: 'any', value: 1 })),
          field('Fixed jump duration (hours)', el('input', { name: 'fixed_hours', type: 'number', step: 'any', value: 168 }), 'e.g. 168 h = one week in jump space'));
      }
      fieldsWrap.classList.toggle('travel-speed', E.SPEED_MODES.includes(m));
      fieldsWrap.replaceChildren(...F.filter(Boolean));
      out.replaceChildren();
    };
    modeSel.addEventListener('change', drawFields);
    drawFields();
    // Switching units redraws the boxes in the new units and carries the numbers already typed across.
    units.addEventListener('change', () => {
      const k = imp() ? 1 / KM_MI : KM_MI, m = modeSel.value;
      const before = Object.fromEntries([...fieldsWrap.querySelectorAll('[name]')].map(x => [x.name, x.value]));
      const conv = n => (before[n] === '' ? '' : num(Number(before[n]) * k));
      drawFields();
      const set = (n, v) => { const x = fieldsWrap.querySelector(`[name=${n}]`); if (x && v !== undefined) x.value = v; };
      for (const n of Object.keys(before)) if (n !== 'shift_hours') set(n, before[n]);
      if (E.SPEED_MODES.includes(m)) { set('distance', conv('distance')); set('speed', conv('speed')); }
      else if (before.unit === 'km' || before.unit === 'mi') { set('unit', imp() ? 'mi' : 'km'); set('distance', conv('distance')); }
      else if (m === 'hohmann' && E.SYSTEMS[before.system]?.unit === 'km') fieldsWrap.querySelector('[name=system]').dispatchEvent(new Event('change'));
    });

    const fromName = el('input', { placeholder: 'Origin (e.g. Earth)' }), toName = el('input', { placeholder: 'Destination (e.g. Mars)' });
    const f = el('form', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, 'Travel planner'), units),
      field('Mode', modeSel, `Modes for a ${E.GENRES[genre]} campaign. Change the genre on the Settings tab.`, `Overland, sea and air: distance ÷ speed, travelling some of the day's ${hourMode() ? 'hours' : spd() === 2 ? 'two shifts' : 'four shifts'}. Orbital transfer: the slow, fuel-saving path between two orbits. Constant thrust: accelerate to the midpoint, flip, decelerate. Relativistic: the same, with ship time slowing near light speed. FTL: your setting's jump drive.`),
      fieldsWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary', 'data-tip': 'Work out the travel time. Nothing changes until you depart' }, 'Calculate')), out);

    let result = null;
    f.addEventListener('submit', e => {
      e.preventDefault();
      try {
        const q = formData(f);
        if (modeSel.value === 'hohmann' && E.SYSTEMS[q.system]?.unit === 'km' && imp()) { q.r1 = Number(q.r1) * KM_MI; q.r2 = Number(q.r2) * KM_MI; }
        result = E.travel(modeSel.value, q);
        out.replaceChildren(el('div', { class: 'result' },
          el('h3', {}, `Travel time: ${E.fmtDuration(result.hours)}`, result.worldHours ? ' (ship time)' : ''),
          el('ul', {}, result.lines.map(l => el('li', {}, l))),
          result.worldHours ? el('p', { class: 'muted' }, 'The tracker follows the party, so it advances by ship time unless you pick world time below.') : null),
          isGM() ? departForm() : el('p', { class: 'muted' }, 'Only the GM can advance time.'));
      } catch (err) { out.replaceChildren(el('p', { class: 'bad' }, err.message)); }
    });

    const departForm = () => {
      const travelReg = regionPicker([['', '— no change —']], ''), arriveReg = regionPicker([['', '— no change —']], '');
      const useWorld = el('input', { type: 'checkbox' });
      const shiftsFor = () => E.hoursToShifts(cal(), useWorld.checked && result.worldHours ? result.worldHours : result.hours);
      const info = el('small', { class: 'muted' });
      const upd = () => {
        const n = shiftsFor();
        info.textContent = `${n} ${word()}s (${(n / spd()).toFixed(1)} days). Arrive: ${E.fmtShift(cal(), nowShift() + n)}`;
      };
      useWorld.addEventListener('change', upd); upd();
      const go = btn('Depart — pass this much time', null, 'primary', `Pass the travel time, label each passed ${word()} with the trip, and log it as an event`);
      go.addEventListener('click', busy(go, async () => {
        const n = shiftsFor();
        if (n <= 0) throw new Error(`Trip is shorter than one ${word()}`);
        const label = `In transit${fromName.value || toName.value ? `: ${fromName.value || '?'} → ${toName.value || '?'}` : ''}`;
        const startDay = today();
        const travelId = await travelReg.resolve(), arriveId = await arriveReg.resolve();
        await passShifts(n, label, travelId || null, arriveId || null);
        vs().anchor = today();
        await post('event_save', { abs_day: startDay, end_day: today() > startDay ? today() : null, shift: null,
          title: `${label}`, body: result.lines.join('\n'), is_secret: false }, S.camp.id);
        toast(`Arrived: ${E.fmtShift(cal(), nowShift())}`);
        location.hash = `#/c/${S.camp.id}/calendar`;
      }));
      return el('div', { class: 'depart' }, el('h3', {}, 'Make the trip'),
        el('div', { class: 'grid2' }, field('From', fromName), field('To', toName),
          field('Region while travelling', travelReg.node, 'e.g. "Ship interior" so transit days get shipboard conditions'),
          field('Region on arrival', arriveReg.node, null, 'The party is moved here when the trip ends'),
          result.worldHours ? field('Advance by outside-world time instead', useWorld, null, 'Near light speed, less time passes on board than back home. Tick this to move the clock by the longer, outside time') : null),
        info, el('div', { class: 'row' }, go),
        el('small', { class: 'muted' }, `Labels every passed ${word()} with the trip (without overwriting existing activity) and logs a multi-day travel event.`));
    };
    mount(...campaignHeader('travel'), f);
  }

  // ------------------------------------------------------------ regions tab
  function viewRegions() {
    const cur = settings().current_region;
    const list = el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, 'Regions'),
      isGM() ? btn('+ New region', () => list.after(regionForm()), 'primary small', 'Add a place with its own climate, light source and terrain') : null),
      S.regions.map(r => el('div', { class: 'listrow' },
        el('div', {}, el('strong', {}, r.name), r.id === Number(cur) ? el('span', { class: 'nowtag', 'data-tip': 'New days are rolled with this region\'s weather' }, 'PARTY IS HERE') : null,
          el('div', { class: 'muted small', 'data-tip': lightSummary(r) }, regionSummary(r)), r.description ? el('div', { class: 'small pre' }, r.description) : null),
        isGM() ? el('div', { class: 'actions' },
          r.id !== Number(cur) ? btn('Party is here', async () => { await setCurrentRegion(r.id); await ensureWeather(today(), today()); toast(`Party moved to ${r.name}`); await loadCampaign(S.camp.id, true); route(); }, 'small',
            'Move the party here. Days from now on use this region\'s climate, light and terrain') : null,
          btn('Edit', () => list.after(regionForm(r)), 'small', 'Change this region\'s climate, light and terrain'),
          btn('Delete', async () => {
            if (!await confirmDialog(`Delete region ${r.name}? Days recorded there keep their weather.`)) return;
            await post('region_delete', { id: r.id }, S.camp.id); await loadCampaign(S.camp.id, true); route();
          }, 'small danger', 'Delete this region. Days already recorded there keep their weather')) : null)));
    mount(...campaignHeader('regions'), list,
      el('p', { class: 'muted pad' }, 'A region sets the climate (weather odds by season), the light source (sun and moons, artificial lighting, or none), and a terrain modifier to visibility — e.g. −1 under forest canopy.'));
  }
  function climateName(s) {
    if (s.climate === 'custom') return 'Custom climate';
    if (s.climate === 'koppen_custom') return `${s.custom_climate?.label || 'Custom climate'}${s.custom_climate?.koppen ? ` (from ${s.custom_climate.koppen})` : ''}`;
    return E.climateFor({ settings: s }).label;
  }
  function lightSummary(r) {
    const s = r.settings || {};
    if ((s.lighting || 'natural') !== 'artificial') return null;
    const lv = s.light_levels || [4, 5, 4, 2];
    return 'Artificial light by time of day:\n' + E.quarterNames(cal()).map((n, i) => `${n}: ${lv[i]} ${E.VIS_LABELS[lv[i]] || ''}`).join('\n');
  }
  function regionSummary(r) {
    const s = r.settings || {};
    const clim = climateName(s);
    const light = { natural: 'Sun & moons', artificial: `Artificial lighting (${(s.light_levels || [4, 5, 4, 2]).join('/')})`, none: 'No light' }[s.lighting || 'natural'];
    return [clim, (s.hemisphere || 'north') !== (cal().hemisphere || 'north') ? `${s.hemisphere === 'south' ? 'Southern' : 'Northern'} hemisphere` : null, light, s.terrain_mod ? `Terrain ${s.terrain_mod > 0 ? '+' : ''}${s.terrain_mod}` : null].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------ climate picker
  const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter'];
  /** Climate select: Köppen classes by group, the simple setting climates, and the two custom modes. */
  function climateSelect(value, attrs) {
    const opt = (v, l) => el('option', { value: v, selected: v === value }, l);
    const groups = Object.entries(E.KOPPEN_GROUPS).map(([g, gl]) => el('optgroup', { label: `Köppen ${g} · ${gl}` },
      Object.entries(E.KOPPEN).filter(([code]) => code[0] === g).map(([code, k]) => opt(`koppen:${code}`, `${code} · ${k.label}`))));
    return el('select', attrs || {}, groups,
      el('optgroup', { label: 'Simple & setting climates' }, Object.entries(E.CLIMATES).map(([k, c]) => opt(k, c.label))),
      el('optgroup', { label: 'Custom' }, opt('koppen_custom', 'Custom Köppen build-out'), opt('custom', 'Custom (raw JSON)')));
  }
  /** Season-by-season baseline: typical highs, how wet, and the likeliest weather. */
  function climateBaseline(clim) {
    const unit = tempUnit() === 'none' ? 'C' : tempUnit();
    const rows = [...SEASON_ORDER, 'any'].filter(k => clim.seasons[k]).map(k => {
      const sd = clim.seasons[k], tot = Object.values(sd.w).reduce((a, b) => a + b, 0) || 1;
      const odds = Object.entries(sd.w).filter(([t, w]) => w > 0 && E.WEATHER[t]).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([t, w]) => `${E.WEATHER[t].icon} ${E.WEATHER[t].label} ${Math.round(w / tot * 100)}%`).join(', ');
      const desc = clim.base?.[k] ? E.describeBaseline(clim.base[k], unit) : `Highs ${E.fmtTemp(sd.t[0], unit)} to ${E.fmtTemp(sd.t[1], unit)}`;
      return el('tr', {}, el('td', {}, el('span', { class: `season s-${k === 'any' ? 'none' : k}` }, k === 'any' ? 'No season' : SEASON_LABELS[k])), el('td', {}, desc), el('td', { class: 'muted' }, odds));
    });
    return el('table', { class: 'tbl baseline' }, el('tbody', {}, rows));
  }
  /** Builder for a custom climate: start from Köppen letters, then tune each season's baseline. */
  function koppenBuilder(cc, onChange) {
    let base = cc?.base ? JSON.parse(JSON.stringify(cc.base)) : E.koppenBase('Cfb');
    let from = cc?.koppen || 'Cfb';
    const unit = tempUnit() === 'none' ? 'C' : tempUnit(), sym = tempSym(unit);
    const name = el('input', { value: cc?.label || `Custom ${from}`, 'aria-label': 'Climate name', maxlength: 80 });
    const letter = (opts, v, lbl) => select(Object.entries(opts).map(([k, l]) => [k, `${k} · ${l}`]), v, { 'aria-label': lbl });
    const lettersWrap = el('span', { class: 'row' });
    const codeOut = el('strong', {});
    const group = select(Object.entries(E.KOPPEN_GROUPS).map(([g, l]) => [g, `${g} · ${l}`]), from[0], { 'aria-label': 'Köppen group' });
    let second, third;
    const code = () => E.koppenCode(group.value, second.value, third ? third.value : '');
    const drawLetters = (pre = '') => {
      const [L2, L3] = E.KOPPEN_LETTERS[group.value];
      second = letter(L2, pre[1] in L2 ? pre[1] : Object.keys(L2)[0], 'Precipitation pattern');
      third = L3 ? letter(L3, pre[2] in L3 ? pre[2] : Object.keys(L3)[0], 'Temperature') : null;
      lettersWrap.replaceChildren(group, second, third);
      syncCode();
    };
    const syncCode = () => {
      const c = code();
      codeOut.textContent = c ? `${c} · ${E.KOPPEN[c].label}` : 'Not a Köppen class';
      codeOut.dataset.tip = c ? `Typical of ${E.KOPPEN[c].where}` : '';
      load.disabled = !c;
    };
    const load = tipped(btn('Load baseline', () => {
      const c = code(); if (!c) return;
      if (name.value.trim() === `Custom ${from}` || !name.value.trim()) name.value = `Custom ${c}`;
      from = c; base = E.koppenBase(c); drawTable(); onChange();
    }, 'small'), 'Fill the table below with this Köppen class\'s typical seasons. Replaces what is there');
    const num = (v, k, i, attrs) => el('input', { type: 'number', value: E.toTempUnit(v, unit, 1), step: unit === 'C' ? 1 : 'any', 'data-k': k, 'data-i': i, class: 'w-num', ...attrs });
    const scale = (v, k, max, lbl) => el('input', { type: 'number', min: 0, max, step: 'any', value: Number(v) || 0, 'data-k': k, class: 'w-num', 'aria-label': lbl });
    const table = el('table', { class: 'tbl builder' });
    const drawTable = () => table.replaceChildren(
      el('thead', {}, el('tr', {}, [['Season'], [`Highs from ${sym}`, 'The coolest typical daytime high in this season'], [`to ${sym}`, 'The warmest typical daytime high in this season'],
        ['Precipitation 0–5', '0 arid, 1 very dry, 2 light, 3 moderate, 4 wet, 5 very wet. Below freezing it falls as snow'],
        ['Storms 0–3', 'How often thunderstorms (or blizzards, when freezing) roll in: 0 never, 3 often'],
        ['Fog 0–3', 'How often fog or mist settles: 0 never, 3 often'], ['Dust 0–3', 'How often dust or sandstorms blow: 0 never, 3 often']]
        .map(([x, t]) => el('th', {}, x, t ? tip(t) : null)))),
      el('tbody', {}, SEASON_ORDER.map(k => {
        const p = base[k];
        return el('tr', { 'data-s': k }, el('td', {}, el('span', { class: `season s-${k}` }, SEASON_LABELS[k])),
          el('td', {}, num(p.t[0], 't', 0, { 'aria-label': `${k} lowest high` })), el('td', {}, num(p.t[1], 't', 1, { 'aria-label': `${k} highest high` })),
          el('td', {}, scale(p.wet, 'wet', 5, `${k} precipitation`)),
          ...['storm', 'fog', 'dust'].map(x => el('td', {}, scale(p[x], x, 3, `${k} ${x}`))));
      })));
    const read = () => {
      for (const tr of table.querySelectorAll('tbody tr')) {
        const p = base[tr.dataset.s];
        for (const inp of tr.querySelectorAll('[data-k]')) {
          const v = Number(inp.value) || 0;
          if (inp.dataset.k === 't') { if (inp.value !== '') p.t[Number(inp.dataset.i)] = Math.round(E.fromTempUnit(v, unit)); }
          else p[inp.dataset.k] = Math.max(0, Math.min(inp.dataset.k === 'wet' ? 5 : 3, v));
        }
      }
    };
    group.addEventListener('change', () => drawLetters());
    lettersWrap.addEventListener('change', e => { if (e.target !== group) syncCode(); });
    drawLetters(from); drawTable();
    table.addEventListener('change', () => { read(); onChange(); });
    name.addEventListener('input', onChange);
    const wrap = el('div', { class: 'builderwrap' },
      field('Climate name', name),
      el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Start from a Köppen class'), el('span', { class: 'row' }, lettersWrap, codeOut, load),
        el('small', { class: 'muted' }, 'Pick the group, precipitation pattern and temperature letters, then load that class\'s baseline and tune any season below. Highs are daytime highs; precipitation runs from 0 (arid) to 5 (torrential), storms, fog and dust from 0 (never) to 3 (frequent). Storms in freezing weather become blizzards.')),
      table);
    wrap.getClimate = () => { read(); return { label: name.value.trim() || 'Custom climate', koppen: from, base: JSON.parse(JSON.stringify(base)) }; };
    return wrap;
  }

  const LIGHT_TIP = 'Only used when the light source is Artificial. Each box is the base visibility of one shift, every day, before weather and terrain:\n'
    + '0 Pitch black: no light at all\n1 Very dark: emergency strips, a single torch, dusk outdoors\n2 Dim: night-cycle lighting, a lamplit room\n'
    + '3 Fair: like dawn outdoors\n4 Good: normal working lights\n5 Bright: daylight-strength lighting or floodlights\n'
    + 'The default 4 / 5 / 4 / 2 is a ship or station that dims its lights at night. Weather (such as Emergency lighting) and the terrain modifier still adjust the result, and a GM override on a shift replaces it.';
  const LIGHT_EXAMPLES = ['no light at all', 'emergency strips, a single torch, dusk outdoors', 'night-cycle lighting, a lamplit room', 'like dawn outdoors', 'normal working lights', 'daylight-strength lighting'];
  /** One 0–5 box per shift for artificial lighting, each with its shift name and a live label. */
  function lightLevels(lv) {
    const natural = [3, 5, 1, 0];
    return el('span', { class: 'lightlv' }, E.quarterNames(cal()).map((n, i) => {
      const out = el('small', { class: 'muted' });
      const input = el('input', { type: 'number', min: 0, max: 5, name: `lv${i}`, value: lv[i], class: 'w-num', 'aria-label': `${n} light level`,
        'data-tip': `${n}: how well lit this shift is, 0 (pitch black) to 5 (bright). Sun & moons would give ${natural[i]} here.` });
      const sync = () => {
        const v = Math.max(0, Math.min(5, Math.round(Number(input.value) || 0)));
        out.textContent = `${v} · ${E.VIS_LABELS[v]}`;
        out.dataset.tip = `${E.VIS_LABELS[v]}: ${LIGHT_EXAMPLES[v]}`;
      };
      input.addEventListener('input', sync); sync();
      return el('span', {}, el('span', { class: 'small' }, n), input, out);
    }));
  }

  function regionForm(r = { settings: {} }) {
    const s = r.settings || {};
    const climate = climateSelect(s.climate || 'temperate', { name: 'climate' });
    const custom = el('textarea', { name: 'custom_climate', rows: 8, class: 'mono',
      value: JSON.stringify(s.climate === 'custom' && s.custom_climate ? s.custom_climate : E.CLIMATES.temperate, null, 1) });
    const customWrap = field('Custom climate', custom, 'Seasons: spring/summer/autumn/winter/any. t = [low, high] °C; w = weather weights. Weather keys: ' + Object.keys(E.WEATHER).join(', '));
    const baseline = el('div', {});
    const builder = koppenBuilder(s.climate === 'koppen_custom' ? s.custom_climate : null, () => drawBaseline());
    const baselineWrap = el('details', { open: true, class: 'field' }, el('summary', {}, 'Baseline weather by season'), baseline,
      el('small', { class: 'muted' }, 'Each day\'s weather is rolled against these odds for the season it falls in, then drifts from the day before.'));
    const drawBaseline = () => {
      const v = climate.value;
      if (v === 'custom') return baseline.replaceChildren();
      const clim = v === 'koppen_custom' ? E.buildClimate(builder.getClimate().base, builder.getClimate()) : E.climateFor({ settings: { climate: v } });
      const k = v.startsWith('koppen:') ? E.KOPPEN[v.slice(7)] : null;
      baseline.replaceChildren(...clean([k ? el('p', { class: 'muted' }, `${k.label}. Typical of ${k.where}.`) : null, climateBaseline(clim)]));
    };
    const syncCustom = () => {
      customWrap.style.display = climate.value === 'custom' ? '' : 'none';
      builder.style.display = climate.value === 'koppen_custom' ? '' : 'none';
      baselineWrap.style.display = climate.value === 'custom' ? 'none' : '';
      drawBaseline();
    };
    climate.addEventListener('change', syncCustom); syncCustom();
    const lv = s.light_levels || [4, 5, 4, 2];
    const lightSel = select([['natural', 'Sun & moons'], ['artificial', 'Artificial (ship, station, city lights)'], ['none', 'None (caves, deep space)']], s.lighting || 'natural', { name: 'lighting' });
    const lightLv = lightLevels(lv);
    const syncLight = () => lightLv.classList.toggle('off', lightSel.value !== 'artificial');
    lightSel.addEventListener('change', syncLight); syncLight();
    const f = el('form', { class: 'card' }, el('h3', {}, r.id ? `Edit ${r.name}` : 'New region'),
      el('div', { class: 'grid2' },
        field('Name', el('input', { name: 'name', value: r.name || '', required: true })),
        field('Climate', climate, null, CLIMATE_TIP),
        field('Hemisphere', select([['north', 'Northern'], ['south', 'Southern']], s.hemisphere || cal().hemisphere || 'north', { name: 'hemisphere' }),
          `Seasons flip when this differs from the calendar's (${cal().hemisphere === 'south' ? 'southern' : 'northern'}) hemisphere`),
        field('Light source', lightSel, null, 'Where the light comes from, which sets the starting visibility of each shift.\nSun & moons: 3 at dawn, 5 at midday, 1 at dusk (plus up to +1 for moonlight), 0 overnight (plus up to +2 for moonlight).\nArtificial: the levels you set below, the same every day.\nNone: always 0, pitch black, unless the party brings light.'),
        field('Terrain visibility modifier', select([[-2, '−2 (dense jungle, deep canyon)'], [-1, '−1 (forest, narrow streets)'], [0, '0 (open)'], [1, '+1 (snowfield, desert glare, open sea)']], s.terrain_mod || 0, { name: 'terrain_mod' }), null,
          'Added to every shift\'s visibility here, after light and weather. It has no effect when the light source is None'),
        field('Artificial light per shift (0–5)', lightLv, 'Used when Light source is Artificial', LIGHT_TIP)),
      customWrap, builder, baselineWrap,
      field('Description', el('textarea', { name: 'description', rows: 2, value: r.description || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, 'Save region'), btn('Cancel', () => f.remove(), 'small')));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(f);
      const settingsOut = { climate: v.climate, hemisphere: v.hemisphere, lighting: v.lighting, terrain_mod: Number(v.terrain_mod),
        light_levels: [0, 1, 2, 3].map(i => Math.max(0, Math.min(5, Number(v[`lv${i}`]) || 0))) };
      if (v.climate === 'custom') {
        try { settingsOut.custom_climate = JSON.parse(v.custom_climate); } catch { return toast('Custom climate is not valid JSON', true); }
      }
      if (v.climate === 'koppen_custom') settingsOut.custom_climate = builder.getClimate();
      try {
        await post('region_save', { id: r.id, name: v.name, description: v.description, settings: settingsOut }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ holidays tab
  function describeRule(r) {
    const c = cal(); r = r || {};
    const span = Number(r.span) > 1 ? ` for ${r.span} days` : '';
    const mname = c.months[r.month]?.name || '?';
    if (r.type === 'fixed') return `Every year: ${r.day} ${mname}${span}`;
    if (r.type === 'nth_weekday') return `Every year: ${Number(r.n) < 0 ? 'last' : ['', '1st', '2nd', '3rd', '4th', '5th'][r.n]} ${c.weekdays[r.weekday] || '?'} of ${mname}${span}`;
    if (r.type === 'once') return `Once: ${E.fmtDate(c, Number(r.abs_day))}${span}`;
    if (r.type === 'every_n') return `Every ${r.interval} days from ${E.fmtDate(c, Number(r.start), { noWeekday: true })}${span}`;
    return '?';
  }
  function viewHolidays() {
    const list = el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, 'Holidays & recurring days'),
      isGM() ? btn('+ New holiday', () => list.after(holidayForm()), 'primary small', 'Add a festival, feast day or any other recurring date') : null),
      S.holidays.length ? S.holidays.map(x => el('div', { class: 'listrow' },
        el('div', {}, holidayChip(x), x.is_secret ? secretTag() : null,
          el('div', { class: 'small muted' }, describeRule(x.rule)), x.description ? el('div', { class: 'small pre' }, x.description) : null),
        isGM() ? el('div', { class: 'actions' }, btn('Edit', () => list.after(holidayForm(x)), 'small', 'Change this holiday'),
          btn('Delete', async () => { if (!await confirmDialog(`Delete ${x.name}?`)) return; await post('holiday_delete', { id: x.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); }, 'small danger', 'Remove this holiday from the calendar')) : null))
        : el('p', { class: 'muted' }, 'No holidays yet.'));
    mount(...campaignHeader('holidays'), list);
  }
  function holidayForm(x = { rule: { type: 'fixed', month: 0, day: 1, span: 1 }, color: '#b8860b' }) {
    const c = cal(), r = x.rule || {};
    const type = select([['fixed', 'Same date every year'], ['nth_weekday', 'Nth weekday of a month'], ['once', 'One time only'], ['every_n', 'Every N days']], r.type, { name: 'type' });
    const monthSel = select(c.months.map((m, i) => [i, m.name]), r.month ?? 0, { name: 'month' });
    const dayIn = el('input', { type: 'number', min: 1, name: 'day', value: r.day || 1 });
    const wdSel = select(c.weekdays.map((w, i) => [i, w]), r.weekday ?? 0, { name: 'weekday' });
    const nSel = select([[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, '5th'], [-1, 'Last']], r.n ?? 1, { name: 'n' });
    const oncePick = datePicker(r.abs_day ?? today()), startPick = datePicker(r.start ?? today());
    const interval = el('input', { type: 'number', min: 1, name: 'interval', value: r.interval || 30 });
    const parts = {
      month: field('Month', monthSel), day: field('Day', dayIn), weekday: field('Weekday', wdSel), n: field('Which one', nSel),
      once: field('Date', oncePick), start: field('First occurrence', startPick), interval: field('Repeat every (days)', interval, null, 'Counted in days, ignoring months and years. Good for market days or a comet'),
    };
    const show = { fixed: ['month', 'day'], nth_weekday: ['n', 'weekday', 'month'], once: ['once'], every_n: ['start', 'interval'] };
    const sync = () => Object.entries(parts).forEach(([k, part]) => (part.style.display = show[type.value].includes(k) ? '' : 'none'));
    type.addEventListener('change', sync);
    const f = el('form', { class: 'card' }, el('h3', {}, x.id ? `Edit ${x.name}` : 'New holiday'),
      el('div', { class: 'grid2' },
        field('Name', el('input', { name: 'name', value: x.name || '', required: true })),
        field('Repeats', type, null, 'Same date: e.g. 1 January every year. Nth weekday: e.g. the last Thursday of November. One time only: a single date. Every N days: a fixed cycle from a first date'),
        ...Object.values(parts),
        field('Lasts (days)', el('input', { type: 'number', min: 1, name: 'span', value: r.span || 1 }), null, 'For festivals that run over several days'),
        field('Color', el('input', { type: 'color', name: 'color', value: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#b8860b' }), null, 'The holiday\'s label color on the calendar'),
        field('Secret (GM only)', el('input', { type: 'checkbox', name: 'is_secret', checked: !!x.is_secret }), null, 'Players won\'t see this holiday on the calendar')),
      field('Description', el('textarea', { name: 'description', rows: 2, value: x.description || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, 'Save holiday'), btn('Cancel', () => f.remove(), 'small')));
    sync();
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(f);
      const rule = { type: v.type, span: Math.max(1, Number(v.span) || 1) };
      if (v.type === 'fixed') Object.assign(rule, { month: Number(v.month), day: Number(v.day) });
      if (v.type === 'nth_weekday') Object.assign(rule, { month: Number(v.month), weekday: Number(v.weekday), n: Number(v.n) });
      if (v.type === 'once') rule.abs_day = oncePick.getAbs();
      if (v.type === 'every_n') Object.assign(rule, { start: startPick.getAbs(), interval: Math.max(1, Number(v.interval) || 1) });
      try {
        await post('holiday_save', { id: x.id, name: v.name, rule, color: v.color, is_secret: v.is_secret, description: v.description }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ downtime tab
  /** Shifts in a day: four, or whatever the campaign's time tracking gives where campaigns have a mode. */
  const dtSpd = () => (E.slotsPerDay ? E.slotsPerDay(cal()) : 4);
  const dtHours = () => !!E.timeMode && E.timeMode(cal()) === 'hours';
  const dtWord = n => `${dtHours() ? 'hour' : 'shift'}${n === 1 ? '' : 's'}`;
  /** The fewest shifts a long rest uses up: half the day (2 of 4 shifts, 1 of 2), or 8 hours. Matches long_rest_min() in api/index.php. */
  const longRestMin = () => (dtHours() ? Math.min(8, dtSpd()) : Math.max(1, Math.floor(dtSpd() / 2)));
  const DOWNTIME_KINDS = {
    long_rest: { label: 'Long Rest', icon: '🛏' },
    short_rest: { label: 'Short Rest', icon: '☕' },
    downtime: { label: 'Downtime', icon: '🏠' },
  };
  const REST_ACTIVITIES = [
    ['Tend to Wounds', 'Bind injuries, change dressings and get some health back'],
    ['Manage Stress', 'Talk it out, pray, meditate or otherwise shake off stress and fear'],
    ['Repair Gear', 'Mend armour, sharpen blades, patch clothes and fix equipment'],
    ['Prepare', 'Plan the next move, ready spells, sort supplies or study the map'],
    ['Relax', 'Eat, drink and take it easy'],
  ];
  const DOWNTIME_ACTIVITIES = [
    ['Work on Project', 'Make progress on a long-term project: a building, a book, a scheme'],
    ['Crafting', 'Make or improve items, potions or gear'],
    ['Career Pursuits', 'Work a trade or a job for pay, standing or contacts'],
    ['Research', 'Dig through libraries, archives and rumours for answers'],
    ['Recuperate', 'Rest up to recover from lasting injuries, illness or trauma'],
    ['Train', 'Learn a skill, a language, a tool or a technique'],
    ['Networking', 'Make contacts, call in favours and hear the news'],
    ['Acquire an Asset', 'Find and get hold of a mount, property, vehicle, hireling or rare item'],
    ['Indulge or Carouse', 'Party, gamble and indulge vices to blow off steam, for better or worse'],
  ];
  /** The activities offered for a kind of downtime: a long rest has the rest ones plus Work on Project. */
  const dtOffered = kind => kind === 'downtime' ? DOWNTIME_ACTIVITIES
    : kind === 'long_rest' ? [...REST_ACTIVITIES, ['Work on Project', 'Put a few hours into a long-term project']] : REST_ACTIVITIES;
  const dtPlayers = () => S.members.filter(m => m.role === 'player');
  const memberName = m => m.character_name || m.display_name || m.email;

  async function viewDowntime() {
    const { downtimes } = await api('downtimes', { query: { cid: S.camp.id } });
    const head = el('div', { class: 'card' }, el('div', { class: 'row spread' },
      el('h2', {}, 'Downtime', tip('Rests and stretches of downtime, one card each. Making one writes Long Rest, Short Rest or Downtime into the activity of the shifts it covers, and can move the clock to its end. Pick what the party does on each card and who does it.')),
      isGM() ? btn('+ New downtime', () => downtimeDialog(), 'primary', 'Start a long rest, a short rest or some days of downtime') : null),
      downtimes.length ? null : el('p', { class: 'muted' }, isGM() ? 'No rests or downtime yet. Press New downtime to add one.' : 'No rests or downtime yet.'));
    mount(...campaignHeader('downtime'), head, el('div', { class: 'downtimes' }, downtimes.map(downtimeCard)));
  }

  /** The dialog a new downtime card starts from: what kind, how long, and whether to move the clock. */
  function downtimeDialog() {
    hideTip();
    const spd = dtSpd(), min = longRestMin();
    const kinds = Object.entries(DOWNTIME_KINDS).map(([k, x]) => el('label', { class: 'inline dt-kind' },
      el('input', { type: 'radio', name: 'kind', value: k, checked: k === 'long_rest' }), `${x.icon} ${x.label}`));
    const slots = el('input', { type: 'number', name: 'slots', class: 'w-num', step: 1 });
    const slotsLbl = el('span', { class: 'lbl' });
    const slotsHint = el('small', { class: 'muted' });
    const restField = el('label', { class: 'field' }, slotsLbl, slots, slotsHint);
    const startDay = datePicker(today()), endDay = datePicker(today() + 6);
    const dayFields = el('div', {}, field('Start date', startDay), field('End date', endDay, 'Every shift from the start of the first day to the end of the last'));
    const title = el('input', { name: 'title', maxlength: 200, placeholder: 'e.g. Back at the Grey Lady inn' });
    const moveClock = el('input', { type: 'checkbox', name: 'move', checked: true });
    const moveLbl = el('span');
    const err = el('p', { class: 'bad small', hidden: true });
    const kind = () => kinds.map(k => k.querySelector('input')).find(i => i.checked).value;
    const sync = () => {
      const k = kind(), rest = k !== 'downtime';
      restField.hidden = !rest; dayFields.hidden = rest;
      if (rest) {
        const lo = k === 'long_rest' ? min : 0;
        slots.min = lo; slots.max = 10 * spd;
        slots.value = k === 'long_rest' ? min : dtHours() ? 1 : 0;
        slotsLbl.textContent = `${dtHours() ? 'Hours' : 'Shifts'} used up`;
        slotsHint.textContent = k === 'long_rest'
          ? (dtHours() ? `At least ${min} hours.` : `At least ${min} of the day's ${spd} shifts.`)
          : (dtHours() ? 'About an hour.' : 'About an hour, so it usually costs no shift. 0 marks the current shift only.');
      }
      moveLbl.textContent = rest ? ' Move the clock to the end of the rest' : ' Move the clock to the end of the downtime';
    };
    kinds.forEach(k => k.addEventListener('change', sync));
    const create = el('button', { class: 'primary', type: 'submit' }, 'Create');
    const d = el('dialog', { class: 'kit-dialog dt-dialog', 'aria-label': 'New downtime' },
      el('form', { novalidate: true },
        el('h3', {}, 'New downtime'),
        el('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Kind' }, el('span', { class: 'lbl' }, 'Kind'), el('div', { class: 'row' }, kinds)),
        restField, dayFields,
        field('Title (optional)', title),
        el('label', { class: 'inline' }, moveClock, moveLbl),
        err,
        el('div', { class: 'kit-dialog-actions' }, create, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
    sync();
    d.addEventListener('close', () => d.remove());
    d.querySelector('form').addEventListener('submit', busy(create, async e => {
      e.preventDefault();
      err.hidden = true;
      const k = kind(), body = { kind: k, title: title.value };
      if (k === 'downtime') {
        body.start_day = startDay.getAbs(); body.end_day = endDay.getAbs();
        if (body.end_day < body.start_day) { err.textContent = 'The end date is before the start date.'; err.hidden = false; return; }
      } else {
        body.slots = Math.round(Number(slots.value));
        if (!(body.slots >= Number(slots.min) && body.slots <= Number(slots.max))) {
          err.textContent = `Enter ${slots.min} to ${slots.max} ${dtWord(2)}.`; err.hidden = false; return;
        }
      }
      try {
        const r = await post('downtime_save', body, S.camp.id);
        if (moveClock.checked && r.end_shift > nowShift()) await passShifts(r.end_shift - nowShift());
      } catch (x) { err.textContent = x.message; err.hidden = false; return; }
      d.close();
      toast(`${DOWNTIME_KINDS[k].label} added`);
      route();
    }));
    document.body.append(d);
    d.showModal();
  }

  /** When a downtime runs: its dates, or its shifts for a rest. */
  function downtimeWhen(x) {
    const c = cal(), n = dtSpd();
    if (x.kind === 'downtime') {
      const a = Math.floor(x.start_shift / n), b = Math.floor(x.end_shift / n), days = b - a + 1;
      return `${E.fmtDate(c, a)}${b > a ? ` → ${E.fmtDate(c, b)}` : ''} · ${days} day${days === 1 ? '' : 's'}`;
    }
    if (!x.slots) return `During ${E.fmtShift(c, x.start_shift)} · no ${dtWord(1)} lost`;
    return `${E.fmtShift(c, x.start_shift)}${x.slots > 1 ? ` → ${E.fmtShift(c, x.end_shift)}` : ''} · ${x.slots} ${dtWord(x.slots)}`;
  }

  /** One downtime card. The GM picks its activities and who takes part; the public notes are open to everyone. */
  function downtimeCard(x) {
    const k = DOWNTIME_KINDS[x.kind] || { label: x.kind, icon: '' };
    const going = nowShift() >= x.start_shift && nowShift() <= x.end_shift;
    const players = dtPlayers();
    const byId = new Map(S.members.map(m => [Number(m.id), m]));
    const card = el('section', { class: 'card downtime', 'data-kind': x.kind },
      el('div', { class: 'row spread' },
        el('h3', {}, `${k.icon} ${k.label}`, x.title ? el('span', { class: 'dt-title' }, ` · ${x.title}`) : null,
          going ? el('span', { class: 'nowtag', 'data-tip': 'The campaign clock is inside this one' }, 'NOW') : null),
        el('small', { class: 'muted' }, downtimeWhen(x))));
    const notes = el('textarea', { rows: 3, value: x.notes || '', 'aria-label': 'Notes', placeholder: 'Notes for everyone',
      'data-tip': 'Everyone in the campaign can read and change these' });

    if (!isGM()) {
      card.append(el('span', { class: 'lbl' }, 'Activities'),
        x.activities.length ? el('ul', { class: 'dt-acts' }, x.activities.map(a => {
          const who = a.members.map(id => byId.get(Number(id))).filter(Boolean).map(memberName);
          return el('li', {}, el('strong', {}, a.name), who.length ? el('span', { class: 'muted' }, ` · ${who.join(', ')}`) : null);
        })) : el('p', { class: 'muted' }, 'No activities picked yet.'));
      const save = btn('Save notes', null, 'small primary', 'Save the notes on this card');
      save.addEventListener('click', busy(save, async () => { await post('downtime_save', { id: x.id, notes: notes.value }, S.camp.id); toast('Notes saved'); }));
      card.append(field('Notes', notes), el('div', { class: 'row' }, save));
      return card;
    }

    // picked: name -> Set of member ids; the offered activities first, then custom ones in the order they were added
    const picked = new Map(x.activities.map(a => [a.name, new Set(a.members.map(Number))]));
    const offered = dtOffered(x.kind);
    const custom = x.activities.map(a => a.name).filter(nm => !offered.some(([o]) => o === nm));
    const list = el('div', { class: 'dt-acts' });
    const row = (name, desc) => {
      const on = picked.has(name);
      const box = el('input', { type: 'checkbox', checked: on, 'aria-label': name, onchange: () => { box.checked ? picked.set(name, new Set()) : picked.delete(name); draw(); } });
      const who = on && players.length ? el('div', { class: 'dt-who', role: 'group', 'aria-label': `Who does ${name}` }, players.map(m => {
        const id = Number(m.id), sel = picked.get(name).has(id);
        return el('button', { type: 'button', class: 'dt-member' + (sel ? ' on' : ''), 'aria-pressed': String(sel),
          'data-tip': sel ? `${memberName(m)} is doing this. Click to take them off` : `Click to put ${memberName(m)} on this`,
          onclick: () => { const s = picked.get(name); s.has(id) ? s.delete(id) : s.add(id); draw(); } }, memberName(m));
      })) : null;
      return el('div', { class: 'dt-act' + (on ? ' on' : '') }, el('label', { class: 'inline', 'data-tip': desc || 'A custom activity' }, box, name), who);
    };
    const draw = () => list.replaceChildren(...offered.map(([n, desc]) => row(n, desc)), ...custom.map(n => row(n, null)));
    draw();
    const customIn = el('input', { maxlength: 100, placeholder: 'Custom activity', 'aria-label': 'Custom activity', class: 'grow' });
    const addCustom = () => {
      const n = customIn.value.trim();
      if (!n) return;
      const same = [...offered.map(([o]) => o), ...custom].find(o => o.toLowerCase() === n.toLowerCase());
      if (!same) custom.push(n);
      if (!picked.has(same || n)) picked.set(same || n, new Set());
      customIn.value = ''; draw();
    };
    customIn.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addCustom(); } });
    const title = el('input', { maxlength: 200, value: x.title || '', 'aria-label': 'Title', placeholder: 'Title (optional)' });
    const gmn = el('textarea', { rows: 3, value: x.gm_notes || '', 'aria-label': 'GM notes', placeholder: 'GM-only notes 🔒', 'data-tip': 'Only GMs ever see these' });
    const save = btn('Save', null, 'small primary', 'Save this card\'s title, activities and notes');
    save.addEventListener('click', busy(save, async () => {
      const acts = [...offered.map(([n]) => n), ...custom].filter(n => picked.has(n)).map(n => ({ name: n, members: [...picked.get(n)] }));
      await post('downtime_save', { id: x.id, title: title.value, activities: acts, notes: notes.value, gm_notes: gmn.value }, S.camp.id);
      toast(`${k.label} saved`); route();
    }));
    const del = btn('Delete', async () => {
      if (!await confirmDialog(`Delete this ${k.label.toLowerCase()}? Its label comes off the shifts it covered; the clock stays where it is.`, { ok: 'Delete', danger: true })) return;
      try { await post('downtime_delete', { id: x.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
    }, 'small danger', 'Delete this card');
    card.append(
      field('Title', title),
      el('span', { class: 'lbl' }, 'Activities', tip(players.length ? 'Tick what the party does, then pick which players do each one' : 'Tick what the party does. Add players on the Members tab to put them on activities')),
      list,
      el('div', { class: 'row' }, customIn, btn('+ Add', addCustom, 'small', 'Add your own activity to this card')),
      el('div', { class: 'grid2' }, field('Notes (players can see and edit)', notes), field('GM notes 🔒', gmn, null, 'Only GMs ever see these')),
      el('div', { class: 'row' }, save, del));
    return card;
  }

  // ------------------------------------------------------------ members tab
  function viewMembers() {
    const card = el('div', { class: 'card' }, el('h2', {}, 'Members'),
      S.members.map(m => {
        const self = Number(m.id) === S.user.id;
        return el('div', { class: 'listrow member' },
          el('div', { class: 'who' }, el('strong', {}, m.display_name || m.email), m.email ? el('span', { class: 'muted' }, ` (${m.email})`) : null,
            el('span', { class: `role ${m.role}`, 'data-tip': m.role === 'gm' ? 'Can pass time, edit everything and see secrets' : 'Sees the calendar, adds notes, and adds events if allowed' }, m.role === 'gm' ? 'GM' : 'Player')),
          // The character sits centred between the player and the buttons, larger than the rest of the row.
          el('div', { class: 'member-char' }, el('span', { class: 'lbl' }, 'Character'),
            m.character_name ? el('span', { class: 'charname' }, m.character_name) : el('span', { class: 'muted' }, 'none yet')),
          el('div', { class: 'actions' },
            (self || isGM()) ? btn(m.character_name ? 'Rename character' : 'Set character', async () => {
              const name = await promptDialog(self ? 'Your character\'s name in this campaign:' : `${m.display_name}'s character name:`,
                { value: m.character_name || '', placeholder: 'Leave empty to use their own name', ok: 'Save' });
              if (name === null) return;
              try { await post('member_character', { user_id: m.id, character_name: name }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
            }, 'small', 'Events and notes they add are signed with this name instead of their own') : null,
            isGM() ? btn('Remove', async () => {
              if (!await confirmDialog(`Remove ${m.display_name} from this campaign?`)) return;
              try { await post('member_remove', { user_id: m.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
            }, 'small danger', 'Take them out of this campaign. Their account stays') : null));
      }));
    if (isGM()) {
      // Pick from the site's approved accounts, or type a full email for someone not in the list.
      let candidates = [];
      const q = el('input', { name: 'q', type: 'search', placeholder: 'Search people, or type their sign-in email', autocomplete: 'off', 'aria-label': 'Find a person to add', class: 'grow' });
      const role = select([['player', 'Player'], ['gm', 'Co-GM']], 'player', { name: 'role', 'aria-label': 'Role', 'data-tip': 'A co-GM has the same powers as you, including secrets' });
      const list = el('div', { class: 'picker', role: 'list', 'aria-label': 'Registered people' });
      const add = async body => {
        try { await post('member_add', { ...body, role: role.value }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
      };
      const matches = () => {
        const t = q.value.trim().toLowerCase();
        return t ? candidates.filter(u => (u.display_name || '').toLowerCase().includes(t) || (u.email || '').toLowerCase().includes(t)) : candidates;
      };
      const renderList = () => {
        const m = matches();
        list.replaceChildren(...(m.length ? m.slice(0, 8).map(u => el('div', { class: 'listrow', role: 'listitem' },
          el('div', {}, el('strong', {}, u.display_name || u.email), u.display_name && u.email ? el('span', { class: 'muted' }, ` ${u.email}`) : null),
          el('div', { class: 'actions' }, btn('Add', () => add({ user_id: u.id }), 'small primary', `Add ${u.display_name || u.email} to this campaign`))))
          : [el('p', { class: 'muted' }, candidates.length ? 'Nobody registered matches. Type their full sign-in email and press Add by email.' : 'Everyone registered is already in this campaign. Add someone new by their sign-in email.')]),
          m.length > 8 ? el('small', { class: 'muted' }, `${m.length - 8} more. Type to narrow the list.`) : null);
      };
      q.addEventListener('input', renderList);
      const f = el('form', { class: 'row' }, q, role, el('button', { class: 'small' }, 'Add by email'));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const v = q.value.trim();
        const m = matches();
        if (v.includes('@')) return add({ email: v });
        if (v && m.length === 1) return add({ user_id: m[0].id });
        toast('Pick someone from the list, or type their full sign-in email.', true);
      });
      card.append(el('h3', {}, 'Add a member'), f, list, el('small', { class: 'muted' }, 'Everyone who has signed in and been approved by the site admin is listed. Someone new needs to sign in once and be approved first.'));
      api('member_candidates', { query: { cid: S.camp.id } }).then(r => { candidates = r.users; renderList(); }).catch(err => toast(err.message, true));
    }
    mount(...campaignHeader('members'), card);
  }

  // ------------------------------------------------------------ season editor
  const SEASON_LABELS = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter', none: 'None (no climate change)' };
  const seasonChip = s => el('span', { class: `season s-${s.type || 'none'}` }, s.name || '—');
  /** Editable list of seasons (name, climate type, start month & day) with a live month-by-month preview. */
  function seasonEditor(c) {
    const rows = el('div', { class: 'seasonrows' });
    const preview = el('div', { class: 'seasonmap' });
    const monthOpts = c.months.map((m, i) => [i, `${i + 1}. ${m.name}`]);
    const read = () => [...rows.children].map(r => ({
      name: r.querySelector('[data-k=name]').value.trim(),
      type: r.querySelector('[data-k=type]').value,
      month: Number(r.querySelector('[data-k=month]').value),
      day: Math.max(1, Number(r.querySelector('[data-k=day]').value) || 1),
    }));
    const redraw = () => {
      const test = { ...c, seasons: read().filter(s => s.name) };
      let map;
      try { E.prep(test); map = E.monthSeasons(test); } catch { return; }
      preview.replaceChildren(el('table', { class: 'tbl' }, el('tbody', {}, map.map(({ month, seasons }) =>
        el('tr', {}, el('td', {}, c.months[month].name), el('td', {}, test.seasons.length
          ? seasons.map(x => el('span', { class: 'seasonseg' }, seasonChip(x), seasons.length > 1 ? ` ${x.from}–${x.to}` : ''))
          : el('span', { class: 'muted' }, 'No seasons')))))));
    };
    const addRow = (s = { name: '', type: 'none', month: 0, day: 1 }) => {
      const month = select(monthOpts, s.month, { 'data-k': 'month', 'aria-label': 'Start month' });
      const day = el('input', { type: 'number', min: 1, value: s.day || 1, class: 'w-day', 'data-k': 'day', 'aria-label': 'Start day' });
      const syncMax = () => { const mo = c.months[month.value]; day.max = Number(mo.days) + Number(mo.leapDays || 0); };
      month.addEventListener('change', syncMax); syncMax();
      const row = el('div', { class: 'row seasonrow' },
        el('input', { value: s.name || '', placeholder: 'Season name', 'data-k': 'name', 'aria-label': 'Season name', class: 'grow' }),
        select(Object.entries(SEASON_LABELS), s.type || 'none', { 'data-k': 'type', 'aria-label': 'Climate', 'data-tip': 'Which season\'s weather odds regions use while this season lasts' }),
        month, day,
        btn('✕', () => { row.remove(); redraw(); }, 'small link', 'Remove this season'));
      rows.append(row);
    };
    (c.seasons || []).forEach(s => addRow(s));
    const wrap = el('div', { class: 'seasoned' }, el('small', { class: 'muted' }, 'Name · climate · first month and day'), rows,
      el('div', { class: 'row' }, btn('+ Add season', () => { addRow(); redraw(); rows.lastChild.querySelector('input').focus(); }, 'small', 'Add another season, such as a monsoon or a festival winter'),
        el('small', { class: 'muted' }, 'Each season runs from its start day until the next one begins, wrapping into the next year. The climate decides which weather table regions use.')),
      el('details', { open: true }, el('summary', {}, 'Seasons by month'), preview));
    wrap.addEventListener('input', redraw);
    wrap.addEventListener('change', redraw);
    redraw();
    wrap.getSeasons = () => {
      const list = read();
      if (list.some(s => !s.name)) throw new Error('Every season needs a name');
      return list;
    };
    return wrap;
  }

  // ------------------------------------------------------------ settings tab
  function calToText(c) {
    return {
      weekdays: (c.weekdays || []).join(', '),
      months: c.months.map(m => [m.name, m.days, m.leapDays || 0, m.intercalary ? (m.keepWeekday ? 'festival weekday' : 'festival') : ''].filter((x, i) => i < 3 || x).join(', ')).join('\n'),
      moons: (c.moons || []).map(m => [m.name, m.cycle, m.ref || 0, m.brightness ?? 1, m.color || '#e8e4d8', m.erratic ? 'erratic' : ''].filter((x, i) => i < 5 || x).join(', ')).join('\n'),
      shiftNames: E.quarterNames({ ...c, timeMode: 'shifts4' }).join(', '),
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
      return m;
    });
    if (!c.months.length) throw new Error('Add at least one month');
    const every = Number(v.leap_every);
    c.leap = every > 0 ? { every, skip: Number(v.leap_skip) || 0, unskip: Number(v.leap_unskip) || 0 } : null;
    c.hemisphere = v.cal_hemisphere; c.seasons = seasons;
    c.moons = lines(v.moons).map(([name, cycle, ref, bright, color, erratic]) => ({ name, cycle: Number(cycle) || 28, ref: Number(ref) || 0, brightness: bright === undefined ? 1 : Number(bright), color: color || '#e8e4d8', erratic: /err/i.test(erratic || '') }));
    c.shiftNames = v.shiftNames.split(',').map(x => x.trim()).slice(0, 4);
    return c;
  }

  function viewSettings() {
    if (!isGM()) { mount(...campaignHeader('settings'), el('div', { class: 'card' }, el('p', {}, 'Only the GM can change campaign settings.'))); return; }
    const st = settings(), c = cal(), t = calToText(c);
    const ta = (name, value, rows) => el('textarea', { name, rows: rows || 4, value, class: 'mono' });
    const general = el('form', { class: 'card' }, el('h2', {}, 'Campaign'),
      el('div', { class: 'grid2' },
        field('Name', el('input', { name: 'name', value: S.camp.name, required: true })),
        field('Party\'s current region', select([['', '—'], ...S.regions.map(r => [r.id, r.name])], st.current_region ?? '', { name: 'current_region' }), null,
          'New days roll their weather here. Same as "Party is here" on the Regions tab'),
        field('Genre', select(Object.entries(E.GENRES), E.genreOf(st), { name: 'genre' }), 'Sets which travel modes and sample speeds the Travel tab offers',
          'Fantasy: overland, sea and air by foot, horse, sail and wing. Modern: adds engines, aircraft and orbital transfers. Sci-Fi: adds thrust burns, relativistic and FTL travel'),
        field('Time tracking', select(Object.entries(E.TIME_MODES), E.timeMode(c), { name: 'time_mode' }), 'Also used by the travel planner',
          'How each day is split. Four shifts: Dawn, Midday, Dusk and Overnight, about six hours each. Two shifts: Day and Night. Hours: every hour of the day from midnight, like a normal calendar.\nChanging it moves the clock, shift activities, notes and timed events to the matching time of day. Going to fewer, longer steps joins the activities that land together.'),
        field('Time scale', select([['day', 'Day by day (detailed shifts)'], ['week', 'Week by week'], ['month', 'Month by month']], st.time_unit || 'day', { name: 'time_unit' }), 'Sets the default calendar view and pass-time step'),
        field('Default temperature units', select(TEMP_OPTIONS, st.temp_unit || 'C', { name: 'temp_unit' }), 'Anyone can pick their own units on their account page',
          'Used for anyone who hasn\'t chosen their own units'),
        field('Players see future weather', el('input', { type: 'checkbox', name: 'players_see_future_weather', checked: !!st.players_see_future_weather }), null,
          'Off: players only see weather up to today. On: they also see days you have generated ahead, like a forecast'),
        field('Players can add events', el('input', { type: 'checkbox', name: 'players_can_add_events', checked: !!st.players_can_add_events }), 'They can always add notes to events they can see')),
      field('Description', el('textarea', { name: 'description', rows: 2, value: S.camp.description || '' })),
      el('button', { class: 'primary' }, 'Save campaign settings'));
    general.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(general);
      const s = { ...st, current_region: v.current_region ? Number(v.current_region) : null, genre: v.genre, time_unit: v.time_unit, temp_unit: v.temp_unit,
        players_see_future_weather: v.players_see_future_weather, players_can_add_events: v.players_can_add_events };
      const body = { name: v.name, description: v.description, settings: s };
      if (v.time_mode !== E.timeMode(c)) {
        if (!await confirmDialog(`Switch to ${E.TIME_MODES[v.time_mode].toLowerCase()}? The clock, shift activities, notes and timed events move to the matching time of day.`)) return;
        body.calendar = { ...c, timeMode: v.time_mode };
      }
      try { await post('campaign_update', body, S.camp.id); await loadCampaign(S.camp.id, true); toast('Saved'); route(); }
      catch (err) { toast(err.message, true); }
    });

    const L = c.leap || {};
    const seasons = seasonEditor(c);
    const calForm = el('form', { class: 'card' }, el('h2', {}, 'Calendar'),
      el('p', { class: 'muted' }, 'Changing the calendar re-labels every stored day: records stay attached to the same absolute day number, not to a month name.'),
      el('div', { class: 'grid2' },
        field('Calendar name', el('input', { name: 'cal_name', value: c.name || '' })),
        field('Year label suffix', el('input', { name: 'yearSuffix', value: c.yearSuffix || '' }), 'e.g. IC, AD, MY'),
        field('First year (epoch)', el('input', { type: 'number', name: 'epochYear', value: c.epochYear }), null, 'The year number of the calendar\'s very first day'),
        field('Weekday of epoch day 1 (0 = first weekday)', el('input', { type: 'number', name: 'weekdayOffset', value: c.weekdayOffset || 0 }), null,
          'Shifts the whole weekday cycle. Change it to line up a known date with the right weekday'),
        field('Date format', el('input', { name: 'dateFormat', value: c.dateFormat || '{W}, {d} {M} {Y}' }), '{W} weekday, {d} day, {M} month, {Y} year'),
        field('Hours per day', el('input', { type: 'number', name: 'hoursPerDay', value: c.hoursPerDay || 24 }), { shifts4: 'Each of the day\'s four shifts is a quarter of this, for travel too', shifts2: 'Day and Night are half of this each, for travel too', hours: 'The hours in a day, each one its own step on the clock and in the travel planner' }[E.timeMode(c)]),
        field('Default light source', select([['natural', 'Sun & moons'], ['artificial', 'Artificial'], ['none', 'None']], c.lighting || 'natural', { name: 'cal_lighting' }), 'Regions can override',
          'Used for any region that doesn\'t set its own. See the Light source help on a region'),
        field('Shift names (4, comma-separated)', el('input', { name: 'shiftNames', value: t.shiftNames }), E.timeMode(c) === 'shifts4' ? null : 'Used when Time tracking is four shifts',
          'Rename the four shifts, in order: morning, midday, evening, then the overnight one. Their lighting stays tied to that order')),
      field('Weekdays (comma-separated; leave empty for no weeks)', ta('weekdays', t.weekdays, 2)),
      field('Months — one per line: Name, days, leap days[, festival]', ta('months', t.months, 8), 'Add "festival" for intercalary days that sit outside the weekday cycle (like Mitterfruhl), or "festival weekday" for named days that keep their weekday (like 2 Yule). Days can be 0 for a leap-only day (like Overlithe: 0, 1, festival)'),
      el('div', { class: 'grid3' },
        field('Leap year every N years (0 = none)', el('input', { type: 'number', name: 'leap_every', value: L.every || 0 }), null, 'Leap years add each month\'s leap days. Gregorian: 4'),
        field('…except every N years', el('input', { type: 'number', name: 'leap_skip', value: L.skip || 0 }), null, 'Years divisible by this are not leap years after all. Gregorian: 100'),
        field('…unless every N years', el('input', { type: 'number', name: 'leap_unskip', value: L.unskip || 0 }), null, 'Years divisible by this are leap years again. Gregorian: 400')),
      el('h3', {}, 'Seasons'),
      field('Season dates are for the', select([['north', 'Northern hemisphere'], ['south', 'Southern hemisphere']], c.hemisphere || 'north', { name: 'cal_hemisphere' }),
        'Regions in the other hemisphere get the opposite season'),
      seasons,
      el('small', { class: 'muted' }, 'Start months use the saved month list; save month changes first, then adjust seasons.'),
      field('Moons — one per line: Name, cycle days, reference day, brightness 0–1, color[, erratic]', ta('moons', t.moons, 3), 'Reference day = an absolute day number when the moon is new. Today is absolute day ' + today() + '.'),
      el('details', {}, el('summary', {}, 'Advanced: raw calendar JSON'), ta('raw', JSON.stringify(c, null, 1), 12),
        el('small', { class: 'muted' }, 'If you edit this box, it is saved instead of the fields above.')),
      el('button', { class: 'primary' }, 'Save calendar'));
    const rawInitial = calForm.elements.raw.value;
    calForm.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(calForm);
      try {
        let newCal;
        if (v.raw !== rawInitial) newCal = JSON.parse(v.raw);
        else newCal = textToCal(v, c, seasons.getSeasons());
        const test = JSON.parse(JSON.stringify(newCal)); E.prep(test); E.fmtDate(test, today());
        await post('campaign_update', { calendar: newCal }, S.camp.id);
        await loadCampaign(S.camp.id, true); toast('Calendar saved'); route();
      } catch (err) { toast(err.message, true); }
    });

    const presetSel = select(Object.entries(E.PRESETS).map(([k, p]) => [k, p.label]), 'gregorian');
    const danger = el('div', { class: 'card' }, el('h2', {}, 'Tools'),
      el('div', { class: 'row' }, presetSel, tipped(btn('Replace calendar with preset', async () => {
        if (!await confirmDialog('Replace this campaign\'s calendar with the preset? Stored days keep their absolute day numbers.')) return;
        await post('campaign_update', { calendar: { ...E.PRESETS[presetSel.value].calendar, timeMode: E.timeMode(c) } }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      }, 'small'), 'Swap in the preset\'s months, weekdays, moons and seasons. Days, events and regions stay')),
      el('div', { class: 'row' }, btn('Delete this campaign', async () => {
        const typed = await promptDialog(`Type DELETE to permanently delete "${S.camp.name}" and everything in it.`, { title: 'Delete campaign', ok: 'Delete', danger: true });
        if (typed !== 'DELETE') return;
        await post('campaign_delete', { confirm: 'DELETE' }, S.camp.id); S.camp = null; location.hash = '#/';
      }, 'small danger', 'Permanently delete the campaign and everything in it. Asks you to type DELETE first')));
    mount(...campaignHeader('settings'), general, calForm, danger);
  }

  // ------------------------------------------------------------ about: where the built-in figures come from
  const extLink = (src, text) => el('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, text || src.title);
  /** "Title — publisher (licence)" for one SOURCES entry. */
  const cite = key => {
    const src = E.SOURCES[key];
    return src ? el('span', {}, extLink(src), el('span', { class: 'muted' }, ` · ${src.by} (${src.licence})`)) : null;
  };
  const aboutTable = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl about-tbl' },
    el('tr', {}, head.map(h => el('th', {}, h))), rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))));
  function viewAbout() {
    const MODE = { overland: 'Overland', sea: 'Sea and river', air: 'Air' };
    const speedRows = Object.entries(E.SPEEDS).flatMap(([m, groups]) => groups.flatMap(g => g.items.map(([label, kmh, , src]) => [MODE[m], label, `${kmh}`, cite(src)])));
    // planet-to-planet pairs all come from the orbit radii, so they share one line
    const distRows = E.spaceDistances().flatMap(g => g.items.filter(it => it[3] !== 'jplPlanets').map(([label, , , src]) => [label, cite(src)]));
    distRows.splice(4, 0, ['Closest and farthest distances between planets (sums and differences of their mean orbit radii)', cite('jplPlanets')]);
    const starRows = E.STARS.slice(1).map(([name, , , ly, src]) => [name, `${ly.toLocaleString()}`, cite(src)]);
    const wiki = page => ({ url: `https://en.wikipedia.org/wiki/${page}`, title: page.replace(/_/g, ' ') });
    const koppenRows = Object.entries(E.KOPPEN).map(([code, k]) => {
      const [place, page, period, agency, note] = k.station;
      return [code, k.label, el('span', {}, extLink(wiki(page), place), note ? el('small', { class: 'muted', style: { display: 'block' } }, note) : null), period, agency];
    });
    const section = (title, ...kids) => el('section', { class: 'card about' }, el('h2', {}, title), ...kids);
    const p = (...t) => el('p', {}, ...t);
    const list = items => el('ul', {}, items.map(i => el('li', {}, ...[i].flat())));
    mount(
      el('div', { class: 'card about' },
        el('h1', {}, 'About Campaign Chronicle'),
        p('Campaign Chronicle is a tracker for tabletop campaigns: an in-game calendar, weather, moons, visibility, events and a travel planner. ',
          'This page lists where every built-in figure comes from: the sample speeds and distances in the travel planner, the climate baselines behind the weather, and the calendar presets.'),
        p('The sources are open: Wikipedia articles (CC BY-SA 4.0, which in turn cite national weather services, NOAA, NASA and the like), ',
          'NASA, JPL and other US government pages (public domain), UK government statistics (Open Government Licence) and openly licensed papers. ',
          'Where a figure has no open source, such as the fictional settings, this page says so under "No open source" at the bottom.'),
        S.user ? null : el('p', {}, el('a', { href: '#/' }, 'Sign in'))),
      section('Travel planner: sample speeds',
        p('Each sample is the figure its source states, converted to km/h where it gives mph or knots. The label says when it is a top, cruising or free-flow speed rather than an average.'),
        aboutTable(['Mode', 'Sample', 'km/h', 'Source'], speedRows),
        p('Terrain multipliers follow the off-road speeds in the Year Zero Engine reference document: ', cite('yze'), '.')),
      section('Travel planner: space',
        list([
          ['Constants: the speed of light, the astronomical unit and every GM (gravitational parameter): ', cite('jplConst'), '. Standard gravity: ', cite('g0'), '. Light-year: ', cite('ly'), '.'],
          ['Planet orbits for the Hohmann transfers and distances: ', cite('jplPlanets'), '; Pluto: ', cite('pluto'), '; Ceres: ', cite('ceres'), '.'],
          ['Moon orbits (Jupiter, Saturn and Earth systems): ', cite('jplSats'), '. Geostationary orbit: ', cite('geo'), '.'],
        ]),
        aboutTable(['Sample distance', 'Source'], distRows),
        p('Star distances and positions (J2000 right ascension and declination), from which the planner works out the distance between any two:'),
        aboutTable(['Star', 'Light-years from Sol', 'Source'], starRows)),
      section('Weather and climate',
        p('Each Köppen–Geiger class takes its daytime highs and wetness from one representative weather station: its 1991–2020 monthly normals ',
          '(mean daily maximum, mean daily minimum and precipitation) as published in the station\'s Wikipedia climate table, which reproduces the national weather service named. ',
          'A season\'s highs run from the lowest to the highest of its three months\' mean daily maxima, widened to at least 4 °C; wetness (0–5) is 1.25 × log₂(1 + P/20), with P the season\'s mean monthly precipitation in mm. ',
          'The day-to-night temperature swing for each climate group is the stations\' mean daily maximum minus mean daily minimum. ',
          'The class letters and their rules are those of ', cite('beck'), '.'),
        aboutTable(['Class', 'Climate', 'Station', 'Normals', 'Weather service'], koppenRows),
        p('The simple setting climates take their temperatures from one station each: temperate from Warsaw, arctic from Utqiaġvik, desert from Cairo, tropical from Darwin, ',
          'coastal from ', extLink(wiki('Bergen'), 'Bergen'), ', mountains from ', extLink(wiki('Davos'), 'Davos'), ' and swamp from ', extLink(wiki('Pinsk'), 'Pinsk'), ' in the Pripyat Marshes. ',
          'Underground air holds near the surface\'s yearly mean: ', cite('cave'), '. The starship is kept at room temperature (20–22 °C): ', cite('room'), '. ',
          'Open space spans the Moon\'s equatorial range of 95–390 K: ', cite('moonFacts'), '.'),
        p('Game tuning, not measurements: how often thunderstorms, fog and dust storms turn up (0–3) in each class, the weather mix of the simple climates, ',
          'how each kind of weather changes visibility, and how the four shifts ease off from the day\'s forecast. These are the app\'s own choices.')),
      section('Calendars and holidays',
        list([
          ['Gregorian calendar months and leap years: ', cite('gregorian'), '. Season start dates (equinoxes and solstices): ', cite('usno'), '.'],
          ['The Moon\'s mean synodic month (29.530588 days) and reference new moon of 6 January 2000, 18:14 UT: ', cite('phases'), '.'],
          ['New Year\'s Day, Thanksgiving (fourth Thursday in November) and Christmas Day: ', cite('usHolidays'), '. Christmas Eve: ', cite('xmasEve'), '.'],
          ['Middle-earth (Shire Reckoning): months, Yule and Lithe days, the Overlithe leap rule and the fixed weekdays from Appendix D of The Lord of the Rings, as summarised by ', cite('shire'), '.'],
          ['Imperial Calendar (Warhammer Fantasy): months, festival days, weekdays and the two moons: ', cite('imperial'), ' and ', cite('imperialMoons'), '.'],
          'The Starship clock and the Custom calendar are made up for this app.',
        ])),
      section('Game rules',
        p('The four shifts of a day, the shift tasks under "Add an action" and the terrain multipliers follow ', cite('yze'), '. ',
          'The visibility score (0–5), its base values per shift and its modifiers are this app\'s own design.')),
      section('No open source',
        p('These figures cannot come from open data, so they are the app\'s judgement or come from sources that are not openly licensed:'),
        list([
          ['Imperial Calendar preset (Warhammer Fantasy, © Games Workshop): the calendar, its holidays and moons follow the official setting via a fan wiki, ',
            'and the region climates are judgement calls from each region\'s real-world analogue (the Empire as Germany, Bretonnia as France, Kislev as Russia), using the Köppen classes above.'],
          ['Middle-earth preset (© the Tolkien Estate): the calendar follows the books. Region climates were first taken from ', cite('imaginarymaps'),
            ' and fit Tolkien\'s own latitude anchors: ', cite('letter294'), '.'],
          'Four rare Köppen classes have no weather station with published open normals squarely in them: Csc and Dwd borrow the nearest bordering station, and the Cwc and Dsd stations sit on their class line. Each is noted in the climate table.',
          'Storm, fog and dust frequencies, the weather mixes of the simple climates, and the visibility rules (see above).',
        ])));
  }

  // ------------------------------------------------------------ router
  async function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    if (parts[0] === 'about') { renderNav(); return viewAbout(); } // readable signed out too
    if (!S.user) return; // boot() shows the sign-in or waiting screen
    renderNav();
    try {
      if (parts[0] === '') return await viewCampaigns();
      if (parts[0] === 'account') return viewAccount();
      if (parts[0] === 'admin') return await viewAdmin();
      if (parts[0] === 'c') {
        const cid = Number(parts[1]);
        await loadCampaign(cid);
        const tab = parts[2] || 'today';
        if (tab === 'day') return await viewDay(Number(parts[3]));
        if (tab === 'today' && parts[3]) return await viewDay(Number(parts[3]), true);
        const viewToday = () => viewDay(today(), true);
        return await ({ today: viewToday, calendar: viewCalendar, travel: viewTravel, downtime: viewDowntime, regions: viewRegions, holidays: viewHolidays, members: viewMembers, settings: viewSettings }[tab] || viewToday)();
      }
      await viewCampaigns();
    } catch (err) {
      if (!S.user) return;
      mount(el('div', { class: 'card narrow' }, el('h2', {}, 'Something went wrong'), el('p', {}, err.message), el('a', { href: '#/' }, 'Back to campaigns')));
    }
  }

  /** Ask the server who we are (the same probe as Sinless), then show the gate or the app. */
  async function boot() {
    clearTimeout(pendingTimer);
    let res, data;
    try {
      res = await fetch('api/auth/me.php', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      data = await res.json();
    } catch (e) {
      S.user = null; renderNav();
      mount(el('div', { class: 'card narrow' }, el('h2', {}, 'Cannot reach the server'), el('p', {}, 'Check that the config is in place and install.php has been run.')));
      return;
    }
    if (res.status === 401) { S.user = null; S.pending = null; renderNav(); return location.hash.startsWith('#/about') ? viewAbout() : viewLogin(data.providers || []); }
    if (!res.ok) { S.user = null; renderNav(); return mount(el('div', { class: 'card narrow' }, el('h2', {}, 'Server error'), el('p', {}, data.message || data.error || `Error ${res.status}`))); }
    S.csrf = data.csrf;
    if (data.status !== 'approved') { S.user = null; S.pending = data; renderNav(); return viewPending(data); }
    S.pending = null;
    const first = !S.user;
    S.user = { ...data, id: Number(data.id) };
    // A theme saved on the account wins over this device's, so it follows them between devices.
    if (S.user.prefs?.scheme && S.user.prefs.scheme !== currentScheme()) applyScheme(S.user.prefs.scheme);
    if (first && new URLSearchParams(location.search).has('auth_error')) history.replaceState(null, '', location.pathname + location.hash);
    route();
  }

  // Signed out, leaving the About page goes back through the gate.
  window.addEventListener('hashchange', () => (S.user ? route() : boot()));
  $('#version').textContent = `Campaign Chronicle build ${APP_VERSION}`;
  $('#version').before(el('a', { href: '#/about', class: 'small', 'data-tip': 'Where the travel speeds, climates and calendars come from' }, 'About & sources'), ' · ');
  boot();
})();
