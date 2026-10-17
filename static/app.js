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
  const S = { user: null, pending: null, csrf: '', camp: null, role: null, regions: [], holidays: [], members: [] };
  /** Build number, shown in the footer so a bug report names the build. Bump on each release. */
  const APP_VERSION = '4';
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
    return data;
  }
  const post = (action, body, cid) => api(action, { query: cid ? { cid } : {}, body });

  // ------------------------------------------------------------ campaign helpers
  const isGM = () => S.role === 'gm';
  const cal = () => S.camp.calendar;
  const nowShift = () => S.camp.current_shift;
  const today = () => Math.floor(nowShift() / 4);
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
    S.camp = r.campaign; S.role = r.role; S.regions = r.regions; S.holidays = r.holidays; S.members = r.members;
    E.prep(S.camp.calendar);
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
      if (row && row.weather) { prev = row.weather; continue; }
      const reg = (row && regionById(row.region_id)) || region;
      const w = E.genWeather(cal(), S.camp.seed, reg, d, prev, 0);
      out.push({ abs_day: d, region_id: reg ? reg.id : null, weather: w });
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
    const d0 = Math.floor(from / 4), d1 = Math.floor(to / 4);
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
    const c = cal(), cur = nowShift(), day = Math.floor(cur / 4), sh = E.mod(cur, 4);
    switch (unit) {
      case 'shift': return amount;
      case 'day': return amount * 4;
      case 'week': return amount * E.weekLength(c) * 4;
      case 'month': return (E.addMonths(c, day, amount) - day) * 4;
      case 'year': { const p = E.fromAbs(c, day); const y = p.year + amount;
        const t = E.toAbs(c, y, p.month, Math.min(p.day, E.monthLength(c, y, p.month))); return (t - day) * 4; }
    }
    return 0;
  }

  // ------------------------------------------------------------ shared widgets
  function visPill(v) {
    return el('span', { class: `vis v${v.score}`, 'data-tip': `Visibility ${v.score} of 5 (${v.label}): how well the party can see this shift.\n${v.parts.join(' · ')}` }, `👁 ${v.score} ${v.label}`);
  }
  /** A drop-down of the baseline shift actions. Picking one hands its name to onPick and
   * resets, so the activity text stays free-form and several actions can be added. */
  function actionPicker(onPick) {
    const groups = Object.entries(E.SHIFT_ACTION_GROUPS).map(([g, label]) => el('optgroup', { label },
      E.SHIFT_ACTIONS.filter(a => a.group === g).map(a => el('option', { value: a.name, title: a.desc }, `${a.icon} ${a.name}`))));
    const sel = el('select', { class: 'actpick', 'aria-label': 'Add an action',
      'data-tip': 'Common things to spend a shift doing, from the Year Zero Engine and Perilous Wilds travel rules. Picking one adds it to the activity; you can still type anything' },
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

  const SHIFT_TIP = 'Every day is split into four shifts of about six hours (by default Overnight, Dawn, Midday and Dusk). Time passes, activities are logged and visibility is worked out shift by shift.';
  const CLIMATE_TIP = 'Decides the odds of each kind of weather and the usual temperatures in every season. Köppen classes match real-world climates; the setting climates cover ship interiors, open space, caves and the like.';
  const roleBadge = role => el('span', { class: `role ${role}`, 'data-tip': role === 'gm' ? 'You run this campaign' : 'You play in this campaign' }, role === 'gm' ? 'GM' : 'Player');
  const secretTag = () => el('span', { class: 'secret-tag', 'data-tip': 'Only GMs can see this' }, '🔒 SECRET');
  const holidayChip = x => el('span', { class: 'chip', style: { background: x.color }, 'data-tip': x.description || `Holiday: ${x.name}` }, x.name);
  function moonBadges(d) {
    return E.moons(cal(), d).map(m => el('span', { class: 'moon', 'data-tip': `${m.name}: ${m.label} (${Math.round(m.illum * 100)}% lit). Moonlight brightens the overnight shift under sun & moons lighting.` },
      el('span', { style: m.color && cal().moons.length > 1 ? { filter: `drop-shadow(0 0 2px ${m.color})` } : {} }, m.icon)));
  }
  const FORECAST_TIP = 'The day\'s forecast: the worst weather it brings, its daytime high and its strongest wind. Each shift varies within it, cooler at night and often easing off away from the worst of it.';
  function weatherText(w, what = FORECAST_TIP) {
    if (!w) return el('span', { class: 'muted' }, 'No weather recorded');
    const def = E.WEATHER[w.type] || {};
    const mods = [def.day ? `daytime visibility ${def.day > 0 ? '+' : ''}${def.day}` : null, def.night ? `overnight ${def.night > 0 ? '+' : ''}${def.night}` : null].filter(Boolean);
    return el('span', { class: 'wx', 'data-tip': `${what}\n${def.label}${mods.length ? `: ${mods.join(', ')}` : ': no effect on visibility'}` }, `${def.icon || ''} ${E.weatherLabel(w, tempUnit())}`);
  }
  /** The weather in each of day d's four shifts, worked out from the day's forecast w. */
  const shiftWx = (d, region, w) => E.shiftWeather(cal(), S.camp.seed, region, d, w);
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
      el('p', { class: 'muted pad' }, 'New people appear here after their first sign-in. Approve them, then a GM adds them to a campaign by email from its Members tab. Admins are set in the server config (admin_identities).'));
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
    const shiftSel = select(E.shiftNames(E.PRESETS[preset].calendar).map((n, i) => [i, n]), 2, { name: 'shift' });
    const f = el('form', { class: 'card narrow' }, el('h1', {}, 'New campaign'),
      field('Name', el('input', { name: 'name', required: true, maxlength: 150 })),
      field('Description', el('textarea', { name: 'description', rows: 2 })),
      field('Calendar preset', presetSel, 'Every preset can be fully customized afterwards (Settings tab).',
        'Sets the months, weekdays, moons, seasons, starting regions and holidays. Pick the closest one and edit it later.'),
      monthsWrap, startWrap, field('Starting shift', shiftSel, null, SHIFT_TIP), climateWrap, seasonWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Create'), btn('Cancel', () => (location.hash = '#/'))));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const p = E.PRESETS[preset], v = formData(f);
      try {
        const r = await post('campaign_create', {
          name: v.name, description: v.description, calendar: { ...presetCal(), seasons: seasons.getSeasons() }, settings: { ...p.settings },
          current_shift: picker.getAbs() * 4 + Number(v.shift),
          regions: p.regions.map(r => r === homeRegion() ? { ...r, settings: { ...r.settings, climate: v.climate } } : r), holidays: p.holidays,
        });
        location.hash = `#/c/${r.id}`;
      } catch (err) { toast(err.message, true); }
    });
    mount(f);
  }

  // ------------------------------------------------------------ campaign shell
  const TABS = [['calendar', 'Calendar'], ['travel', 'Travel'], ['regions', 'Regions'], ['holidays', 'Holidays'], ['members', 'Members'], ['settings', 'Settings']];
  const TAB_TIPS = {
    calendar: 'Month and week views of days, weather, visibility, moons and events',
    travel: 'Work out how long a journey takes, then pass that much time',
    regions: 'Places with their own climate, light source and terrain',
    holidays: 'Festivals and recurring days shown on the calendar',
    members: 'Who plays in this campaign, and who can GM it',
    settings: 'Campaign options and the calendar itself (GM only)',
  };
  function campaignHeader(active) {
    const c = cal(), d = today(), sh = E.mod(nowShift(), 4);
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
            el('a', { href: `#/c/${S.camp.id}/day/${d}`, class: 'now-date', 'data-tip': 'The current shift and date in the campaign. Click to open today' }, `${shiftNames()[sh]} · ${E.fmtDate(c, d)}`),
            el('span', { class: 'now-meta' }, region ? el('span', { 'data-tip': `Where the party is today: ${regionSummary(region)}` }, `📍 ${region.name}`) : null, ' ',
              weatherText(sw, `Weather this ${shiftNames()[sh]}. Day's forecast: ${E.weatherLabel(w, tempUnit())}`), ' ', visPill(v), ' ', moonBadges(d),
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
    const unit = select([['shift', 'shift(s)'], ['day', 'day(s)'], ['week', 'week(s)'], ['month', 'month(s)'], ['year', 'year(s)']], def, { 'aria-label': 'Unit',
      'data-tip': 'A day has four shifts. Months and years follow this campaign\'s calendar' });
    const act = el('input', { placeholder: 'Activity for the passed shifts (optional)', class: 'grow', list: 'pass-actions',
      'data-tip': 'Written into every shift that passes, e.g. "Marching to Altdorf". Pick a common action from the suggestions or type your own. Shifts that already have an activity keep it' });
    const go = btn('Pass time ▶', null, 'primary', 'Move "now" forward and roll weather for every new day');
    go.addEventListener('click', busy(go, async () => {
      const n = unitShifts(unit.value, Number(amt.value) || 0);
      if (Math.abs(n) > 4 * 3650 && !await confirmDialog(`That jumps ${Math.round(Math.abs(n) / 4)} days. Continue?`)) return;
      await passShifts(n, act.value.trim());
      vs().anchor = today();
      toast(`Now: ${E.fmtShift(cal(), nowShift())}`);
      route();
    }));
    const back = btn('◀ 1 shift', null, 'small', 'Step back one shift. Recorded weather, notes and activities stay');
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
        btn('Week', () => { st.mode = 'week'; route(); }, st.mode === 'week' ? 'small on' : 'small', 'One row per day showing every shift, its visibility and activity')),
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
    Number(e.is_secret) ? '🔒 ' : '• ', e.title);
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
    const c = cal(), names = shiftNames();
    const rows = [];
    for (let d = from; d <= to; d++) {
      const row = data.days.get(d), w = row?.weather, sh = dayShifts(data, d);
      const reg = regionById(row?.region_id) || currentRegion(), sws = shiftWx(d, reg, w);
      const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
      rows.push(el('a', { class: 'weekrow' + (d === today() ? ' today' : ''), href: `#/c/${S.camp.id}/day/${d}` },
        el('div', { class: 'wr-date' }, el('strong', {}, E.fmtDate(c, d)), el('div', { class: 'small' }, weatherText(w), ' ', moonBadges(d)),
          hol.map(holidayChip), evs.map(evLine)),
        el('div', { class: 'wr-shifts' }, [0, 1, 2, 3].map(i => {
          const s = sh[i] || {};
          const sw = sws[i] || null, v = E.visibility(c, reg, sw, d, i, s.visibility_override);
          const isNow = d * 4 + i === nowShift();
          return el('div', { class: 'shiftbox' + (isNow ? ' now' : ''), 'data-tip': isNow ? 'This is the current shift' : null },
            el('div', { class: 'sb-head' }, el('span', {}, names[i], sw ? el('span', { class: 'sb-wx', 'data-tip': E.weatherLabel(sw, tempUnit()) }, ` ${E.WEATHER[sw.type]?.icon || ''}`) : null), visPill(v)),
            el('div', { class: 'sb-act' }, s.activity || el('span', { class: 'muted' }, '—')));
        }))));
    }
    return el('div', { class: 'weeklist' }, rows);
  }

  // ------------------------------------------------------------ day drill-down
  async function viewDay(d) {
    const c = cal(), names = shiftNames();
    const r = await api('day', { query: { cid: S.camp.id, d } });
    const row = r.day || {};
    const region = regionById(row.region_id) || currentRegion();
    const w = row.weather || null;
    const shifts = {}; r.shifts.forEach(s => (shifts[s.shift] = s));
    const p = E.fromAbs(c, d);
    const sea = E.season(c, d, region?.settings?.hemisphere);
    const hol = E.holidaysOn(c, S.holidays, d);

    const nav = el('div', { class: 'calbar' },
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d - 1}` }, '◀ Previous day'),
      el('h2', {}, E.fmtDate(c, d)),
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d + 1}` }, 'Next day ▶'),
      btn('Back to calendar', () => { vs().anchor = d; location.hash = `#/c/${S.camp.id}/calendar`; }, 'small', 'Return to the calendar, showing this day'));

    // --- overview card
    const overview = el('div', { class: 'card' },
      el('div', { class: 'kv' },
        el('div', {}, el('span', { class: 'lbl' }, 'Season', tip('From the calendar\'s season dates, flipped for regions in the other hemisphere. The season picks which weather odds apply.')), sea.name || '—'),
        el('div', {}, el('span', { class: 'lbl' }, 'Region'), region ? el('span', { 'data-tip': regionSummary(region) }, region.name) : '—'),
        el('div', {}, el('span', { class: 'lbl' }, 'Forecast', tip(FORECAST_TIP)), weatherText(w)),
        el('div', {}, el('span', { class: 'lbl' }, 'Moons'), E.moons(c, d).map(m => el('div', {}, `${m.icon} ${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)`))),
        hol.length ? el('div', {}, el('span', { class: 'lbl' }, 'Holidays'), hol.map(x => el('div', {}, holidayChip(x), x.description ? ` ${x.description}` : ''))) : null,
        d === today() ? el('div', {}, el('span', { class: 'lbl' }, 'Now'), names[E.mod(nowShift(), 4)]) : null),
      !isGM() && row.notes ? el('div', { class: 'notes' }, el('span', { class: 'lbl' }, 'Notes'), el('p', { class: 'pre' }, row.notes)) : null);

    if (isGM()) overview.append(dayEditor(d, row, region, w));

    // --- shifts
    const sws = shiftWx(d, region, w);
    const shiftCards = el('div', { class: 'shifts' }, [0, 1, 2, 3].map(i => shiftCard(d, i, shifts[i] || {}, region, sws[i] || null)));

    // --- events
    const evCard = el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h3', {}, 'Events'),
      (isGM() || settings().players_can_add_events) ? btn('+ Add event', () => evCard.append(eventForm(d)), 'primary small', 'Log something that happened (or will happen) on this day') : null),
      r.events.length ? r.events.map(e => eventView(e, d)) : el('p', { class: 'muted' }, 'No events on this day.'));

    mount(...campaignHeader('calendar'), nav, overview, el('h3', { class: 'pad' }, 'Shifts', tip(SHIFT_TIP)), shiftCards, evCard);
  }

  function dayEditor(d, row, region, w) {
    const regSel = select([['', '— (current region)'], ...S.regions.map(r => [r.id, r.name])], row.region_id ?? '', { name: 'region_id' });
    const wSel = select([['', '— none —'], ...Object.entries(E.WEATHER).map(([k, v]) => [k, `${v.icon} ${v.label}`])], w?.type || '', { name: 'wtype' });
    const tUnit = tempUnit();
    const tVal = w && typeof w.temp === 'number' ? E.toTempUnit(w.temp, tUnit, 1) : '';
    const temp = el('input', { type: 'number', name: 'temp', value: tVal, step: 'any', class: 'w-num' });
    const wind = select(E.WIND.map((n, i) => [i, n]), w?.wind || 0, { name: 'wind' });
    const notes = el('textarea', { name: 'notes', rows: 3, value: row.notes || '' });
    const gmn = el('textarea', { name: 'gm_notes', rows: 3, value: row.gm_notes || '' });
    const f = el('form', { class: 'dayedit' },
      el('div', { class: 'grid2' },
        field('Region for this day', regSel, null, 'Where the party spent this day. Its climate rolls the weather and its light source and terrain set visibility. "Current region" follows wherever the party is now.'),
        field('Weather', el('span', { class: 'row' }, wSel, tipped(temp, 'Daytime high'), tUnit === 'none' ? '' : tempSym(tUnit), tipped(wind, 'Wind strength')), null,
          'Set the day\'s weather by hand. Rain, fog, snow and the like lower visibility; see the shift cards below for the exact effect.'),
        field('Day notes (players can see)', notes),
        field('GM notes 🔒', gmn, null, 'Only GMs ever see these')),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, 'Save day'),
        tipped(btn('🎲 Re-roll weather', async () => {
          const reg = regionById(regSel.value) || region;
          const prev = (await fetchRange(d - 1, d - 1)).days.get(d - 1)?.weather || null;
          const nw = E.genWeather(cal(), S.camp.seed, reg, d, prev, Date.now());
          await post('day_update', { abs_day: d, region_id: regSel.value || null, weather: nw, notes: notes.value, gm_notes: gmn.value }, S.camp.id);
          route();
        }, 'small'), 'Roll new weather for this day from the region\'s climate and the day before, and save it'),
        d !== today() ? btn('Make this day "now"', async () => { await passShifts(d * 4 + E.mod(nowShift(), 4) - nowShift()); route(); }, 'small',
          'Move the campaign clock to this day, keeping the same shift') : null));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      let weather = null;
      if (wSel.value) {
        let t = temp.value === '' ? null : Number(temp.value);
        if (t !== null) t = Math.round(E.fromTempUnit(t, tUnit));
        weather = { ...(w || {}), type: wSel.value, temp: t, wind: Number(wind.value) };
      }
      try {
        await post('day_update', { abs_day: d, region_id: regSel.value || null, weather, notes: notes.value, gm_notes: gmn.value }, S.camp.id);
        toast('Day saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  function shiftCard(d, i, s, region, sw) {
    const c = cal(), names = shiftNames();
    const v = E.visibility(c, region, sw, d, i, s.visibility_override);
    const isNow = d * 4 + i === nowShift();
    const card = el('div', { class: 'card shiftcard' + (isNow ? ' now' : '') },
      el('div', { class: 'row spread' }, el('h4', {}, names[i], isNow ? el('span', { class: 'nowtag', 'data-tip': 'The campaign clock is on this shift' }, 'NOW') : null), visPill(v)),
      sw ? el('div', { class: 'small' }, weatherText(sw, `Weather this ${names[i]}, worked out from the day's forecast`)) : null,
      el('small', { class: 'muted', 'data-tip': 'How the visibility score was worked out: base light for the shift, then moonlight, weather and terrain' }, v.parts.join(' · ')));
    if (!isGM()) {
      card.append(el('p', { class: 'pre' }, s.activity || el('span', { class: 'muted' }, 'No activity recorded.')));
      return card;
    }
    const act = el('textarea', { rows: 2, value: s.activity || '', placeholder: 'What the party does this shift', 'data-tip': 'Players can see this' });
    const hint = el('small', { class: 'muted' });
    const pick = actionPicker(a => {
      act.value = E.addShiftAction(act.value, a.name);
      hint.textContent = `${a.icon} ${a.name}: ${a.desc}`;
      act.focus();
    });
    const gmn = el('textarea', { rows: 2, value: s.gm_notes || '', placeholder: 'GM-only notes 🔒', 'data-tip': 'Only GMs ever see these' });
    const ov = select([['', 'Auto'], ...E.VIS_LABELS.map((l, k) => [k, `${k} ${l}`])], s.visibility_override ?? '');
    const save = btn('Save', null, 'small primary', 'Save this shift\'s activity, notes and visibility');
    save.addEventListener('click', busy(save, async () => {
      await post('shift_save', { abs_day: d, shift: i, activity: act.value, gm_notes: gmn.value, visibility_override: ov.value }, S.camp.id);
      toast(`${names[i]} saved`); route();
    }));
    card.append(pick, act, hint, gmn, el('div', { class: 'row' }, el('label', { class: 'inline' }, 'Visibility ', ov,
      tip('Auto works it out from the light source, moonlight, weather and terrain. Pick a number to force it for this shift, e.g. a magical darkness or a burning city.')), save,
      !isNow ? btn('Set as now', async () => { await passShifts(d * 4 + i - nowShift()); route(); }, 'small', 'Move the campaign clock to this shift') : null));
    return card;
  }

  function eventView(e, d) {
    const names = shiftNames(), c = cal();
    const mine = Number(e.created_by) === S.user.id;
    const span = e.end_day !== null && e.end_day !== undefined ? ` (${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })})` : '';
    const box = el('div', { class: 'event' + (Number(e.is_secret) ? ' secret' : '') });
    const notesList = el('div', { class: 'enotes' }, (e.notes || []).map(n => el('div', { class: 'enote' },
      el('div', { class: 'pre' }, n.body),
      el('small', { class: 'muted' }, `— ${n.author || 'unknown'}, ${n.created_at}`,
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
        el('small', { class: 'muted' }, e.shift !== null && e.shift !== undefined ? names[e.shift] : 'All day', span)),
      e.body ? el('p', { class: 'pre' }, e.body) : null,
      el('small', { class: 'muted' }, `Added by ${e.author || 'unknown'}`),
      (isGM() || mine) ? el('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(eventForm(d, e)), 'small', 'Change this event'),
        btn('Delete', async () => {
          if (!await confirmDialog(`Delete "${e.title}"?`)) return;
          try { await post('event_delete', { id: e.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Delete this event and its notes')) : null,
      notesList, el('div', { class: 'row' }, noteIn, addNote)].filter(Boolean));
    return box;
  }

  function eventForm(d, e = {}) {
    const names = shiftNames();
    const start = Number(e.abs_day ?? d);
    const lasts = e.end_day !== null && e.end_day !== undefined ? Number(e.end_day) - start + 1 : 1;
    const startPick = datePicker(start);
    const f = el('form', { class: 'event editing' },
      el('div', { class: 'grid2' },
        field('Title', el('input', { name: 'title', value: e.title || '', required: true, maxlength: 200 })),
        field('Shift', select([['', 'All day'], ...names.map((n, i) => [i, n])], e.shift ?? '', { name: 'shift' }), null, 'When in the day it happens. "All day" for things that span the whole day'),
        field('Starts', startPick),
        field('Lasts (days)', el('input', { type: 'number', name: 'lasts', min: 1, value: lasts }), null, 'More than 1 shows the event on every day it covers, like a siege or a voyage'),
        isGM() ? field('Secret (GM only)', el('input', { type: 'checkbox', name: 'is_secret', checked: !!Number(e.is_secret) }), null, 'Players won\'t see this event or its notes') : null),
      field('Details', el('textarea', { name: 'body', rows: 4, value: e.body || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, e.id ? 'Save event' : 'Add event'), btn('Cancel', () => route(), 'small')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = formData(f), a = startPick.getAbs(), n = Math.max(1, Number(v.lasts) || 1);
      try {
        await post('event_save', { id: e.id, abs_day: a, end_day: n > 1 ? a + n - 1 : null, shift: v.shift, title: v.title, body: v.body, is_secret: v.is_secret }, S.camp.id);
        toast('Event saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ travel tab
  function viewTravel() {
    const out = el('div', { class: 'travel-out' });
    const modeSel = select([
      ['ground', 'Overland / sea / air (speed × hours per day)'],
      ['hohmann', 'Orbital transfer (Hohmann, minimum fuel)'],
      ['brachistochrone', 'Constant-thrust burn (flip-and-burn / torch drive)'],
      ['relativistic', 'Interstellar at relativistic speed'],
      ['ftl', 'FTL / jump drive'],
    ], 'ground', { class: 'travel-mode' });
    const fieldsWrap = el('div', { class: 'grid2' });
    const unitSel = () => select([['km', 'km'], ['mi', 'miles'], ['AU', 'AU'], ['LY', 'light-years'], ['ls', 'light-seconds'], ['lm', 'light-minutes']], 'AU', { name: 'unit' });
    const drawFields = () => {
      const m = modeSel.value;
      const F = [];
      if (m === 'ground') {
        F.push(field('Distance', el('input', { name: 'distance', type: 'number', step: 'any', value: 60 }), 'Any unit — miles, km, leagues…'),
          field('Speed per hour (same unit)', el('input', { name: 'speed', type: 'number', step: 'any', value: 3 }), 'Walking ≈ 3 mph / 5 km/h; horse ≈ 5–6 mph; sailing ship ≈ 4–8 knots'),
          field('Travel hours per day', el('input', { name: 'hours_per_day', type: 'number', step: 'any', value: 8 }), '24 for ships that sail around the clock'),
          field('Terrain multiplier', select([[1, 'Road / open water ×1'], [1.5, 'Rough ×1.5'], [2, 'Forest / hills ×2'], [3, 'Mountains / swamp ×3']], 1, { name: 'terrain' }), null,
            'Multiplies the travel time for slow going. ×2 means the trip takes twice as long'));
      } else if (m === 'hohmann') {
        const sys = el('select', { name: 'system' }, Object.entries(E.SYSTEMS).map(([k, s]) => el('option', { value: k }, s.label)));
        const r1 = el('input', { name: 'r1', type: 'number', step: 'any', value: 1 }), r2 = el('input', { name: 'r2', type: 'number', step: 'any', value: 1.524 });
        const b1 = el('select', {}), b2 = el('select', {});
        const fill = () => {
          const s = E.SYSTEMS[sys.value];
          const opts = [['', 'custom…'], ...Object.entries(s.bodies).map(([n, r]) => [r, n])];
          const names = opts.map(o => o[1]);
          const pick = [names.indexOf('Earth'), names.indexOf('Mars')];
          [b1, b2].forEach((b, k) => { b.replaceChildren(...opts.map(([v, l]) => el('option', { value: v }, l))); b.selectedIndex = pick[k] > 0 ? pick[k] : Math.min(opts.length - 1, k + 1); });
          r1.value = b1.value; r2.value = b2.value;
          lbl1.firstChild.textContent = `From orbit radius (${s.unit})`; lbl2.firstChild.textContent = `To orbit radius (${s.unit})`;
        };
        b1.addEventListener('change', () => { if (b1.value) r1.value = b1.value; });
        b2.addEventListener('change', () => { if (b2.value) r2.value = b2.value; });
        const lbl1 = field('From', el('span', { class: 'row' }, b1, r1)), lbl2 = field('To', el('span', { class: 'row' }, b2, r2));
        sys.addEventListener('change', fill);
        F.push(field('Central body', sys, null, 'The star or planet both orbits go around. Pick a body from the lists or type an orbit radius'), lbl1, lbl2);
        setTimeout(fill);
      } else if (m === 'brachistochrone' || m === 'relativistic') {
        F.push(field('Distance', el('span', { class: 'row' }, el('input', { name: 'distance', type: 'number', step: 'any', value: m === 'relativistic' ? 4.24 : 1.5 }), (() => { const u = unitSel(); if (m === 'relativistic') u.value = 'LY'; return u; })()),
          'Earth–Mars ranges 0.5–2.5 AU; Alpha Centauri is 4.24 LY'),
          field('Acceleration (g)', el('input', { name: 'g', type: 'number', step: 'any', value: m === 'relativistic' ? 1 : 0.3 }), '1 g = 9.81 m/s². The Expanse-style "juice" burns run 3–7 g; comfortable cruising is 0.3–1 g'),
          field('Speed cap (fraction of light, optional)', el('input', { name: 'max_speed_c', type: 'number', step: 'any', min: 0, max: 0.999, placeholder: 'none' }), 'Ship accelerates to the cap, coasts, then decelerates',
            '0.1 means a tenth of the speed of light. Leave empty to burn all the way to the midpoint'));
      } else {
        const kind = select([['rate', 'Speed in light-years per day'], ['fixed', 'Fixed duration per jump']], 'rate', { name: 'ftl_kind' });
        F.push(field('FTL type', kind, null, 'Speed: the trip scales with distance. Fixed: every jump takes the same time, however far'),
          field('Distance (LY)', el('input', { name: 'distance', type: 'number', step: 'any', value: 10 })),
          field('FTL speed (LY per day)', el('input', { name: 'rate', type: 'number', step: 'any', value: 1 })),
          field('Fixed jump duration (hours)', el('input', { name: 'fixed_hours', type: 'number', step: 'any', value: 168 }), 'e.g. 168 h = one week in jump space'));
      }
      fieldsWrap.replaceChildren(...F);
      out.replaceChildren();
    };
    modeSel.addEventListener('change', drawFields);
    drawFields();

    const regOpts = [['', '— no change —'], ...S.regions.map(r => [r.id, r.name])];
    const fromName = el('input', { placeholder: 'Origin (e.g. Earth)' }), toName = el('input', { placeholder: 'Destination (e.g. Mars)' });
    const travelReg = select(regOpts, ''), arriveReg = select(regOpts, '');
    const f = el('form', { class: 'card' }, el('h2', {}, 'Travel planner'),
      field('Mode', modeSel, null, 'Overland: distance ÷ speed, in travel hours per day. Orbital transfer: the slow, fuel-saving path between two orbits. Constant thrust: accelerate to the midpoint, flip, decelerate. Relativistic: the same, with ship time slowing near light speed. FTL: your setting\'s jump drive.'),
      fieldsWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary', 'data-tip': 'Work out the travel time. Nothing changes until you depart' }, 'Calculate')), out);

    let result = null;
    f.addEventListener('submit', e => {
      e.preventDefault();
      try {
        const q = formData(f);
        result = E.travel(modeSel.value, q);
        out.replaceChildren(el('div', { class: 'result' },
          el('h3', {}, `Travel time: ${E.fmtDuration(result.hours)}`, result.worldHours ? ' (ship time)' : ''),
          el('ul', {}, result.lines.map(l => el('li', {}, l))),
          result.worldHours ? el('p', { class: 'muted' }, 'The tracker follows the party, so it advances by ship time unless you pick world time below.') : null),
          isGM() ? departForm() : el('p', { class: 'muted' }, 'Only the GM can advance time.'));
      } catch (err) { out.replaceChildren(el('p', { class: 'bad' }, err.message)); }
    });

    const departForm = () => {
      const useWorld = el('input', { type: 'checkbox' });
      const shiftsFor = () => E.hoursToShifts(cal(), useWorld.checked && result.worldHours ? result.worldHours : result.hours);
      const info = el('small', { class: 'muted' });
      const upd = () => {
        const n = shiftsFor();
        info.textContent = `${n} shifts (${(n / 4).toFixed(1)} days). Arrive: ${E.fmtShift(cal(), nowShift() + n)}`;
      };
      useWorld.addEventListener('change', upd); upd();
      const go = btn('Depart — pass this much time', null, 'primary', 'Pass the travel time, label each passed shift with the trip, and log it as an event');
      go.addEventListener('click', busy(go, async () => {
        const n = shiftsFor();
        if (n <= 0) throw new Error('Trip is shorter than one shift');
        const label = `In transit${fromName.value || toName.value ? `: ${fromName.value || '?'} → ${toName.value || '?'}` : ''}`;
        const startDay = today();
        await passShifts(n, label, travelReg.value || null, arriveReg.value || null);
        vs().anchor = today();
        await post('event_save', { abs_day: startDay, end_day: today() > startDay ? today() : null, shift: null,
          title: `${label}`, body: result.lines.join('\n'), is_secret: false }, S.camp.id);
        toast(`Arrived: ${E.fmtShift(cal(), nowShift())}`);
        location.hash = `#/c/${S.camp.id}/calendar`;
      }));
      return el('div', { class: 'depart' }, el('h3', {}, 'Make the trip'),
        el('div', { class: 'grid2' }, field('From', fromName), field('To', toName),
          field('Region while travelling', travelReg, 'e.g. "Ship interior" so transit days get shipboard conditions'),
          field('Region on arrival', arriveReg, null, 'The party is moved here when the trip ends'),
          result.worldHours ? field('Advance by outside-world time instead', useWorld, null, 'Near light speed, less time passes on board than back home. Tick this to move the clock by the longer, outside time') : null),
        info, el('div', { class: 'row' }, go),
        el('small', { class: 'muted' }, 'Labels every passed shift with the trip (without overwriting existing activity) and logs a multi-day travel event.'));
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
    const lv = s.light_levels || [2, 4, 5, 4];
    return 'Artificial light by shift:\n' + shiftNames().map((n, i) => `${n}: ${lv[i]} ${E.VIS_LABELS[lv[i]] || ''}`).join('\n');
  }
  function regionSummary(r) {
    const s = r.settings || {};
    const clim = climateName(s);
    const light = { natural: 'Sun & moons', artificial: `Artificial lighting (${(s.light_levels || [2, 4, 5, 4]).join('/')})`, none: 'No light' }[s.lighting || 'natural'];
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
    + '0 Pitch black: no light at all\n1 Very dark: emergency strips, a single torch\n2 Dim: night-cycle lighting, a lamplit room\n'
    + '3 Fair: like dawn or dusk outdoors\n4 Good: normal working lights\n5 Bright: daylight-strength lighting or floodlights\n'
    + 'The default 2 / 4 / 5 / 4 is a ship or station that dims its lights at night. Weather (such as Emergency lighting) and the terrain modifier still adjust the result, and a GM override on a shift replaces it.';
  const LIGHT_EXAMPLES = ['no light at all', 'emergency strips, a single torch', 'night-cycle lighting, a lamplit room', 'like dawn or dusk outdoors', 'normal working lights', 'daylight-strength lighting'];
  /** One 0–5 box per shift for artificial lighting, each with its shift name and a live label. */
  function lightLevels(lv) {
    const natural = [0, 3, 5, 3];
    return el('span', { class: 'lightlv' }, shiftNames().map((n, i) => {
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
    const lv = s.light_levels || [2, 4, 5, 4];
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
        field('Light source', lightSel, null, 'Where the light comes from, which sets the starting visibility of each shift.\nSun & moons: 0 overnight (plus up to +2 for moonlight), 3 at dawn and dusk, 5 at midday.\nArtificial: the levels you set below, the same every day.\nNone: always 0, pitch black, unless the party brings light.'),
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

  // ------------------------------------------------------------ members tab
  function viewMembers() {
    const card = el('div', { class: 'card' }, el('h2', {}, 'Members'),
      S.members.map(m => el('div', { class: 'listrow' },
        el('div', {}, el('strong', {}, m.display_name || m.email), m.email ? el('span', { class: 'muted' }, ` (${m.email})`) : null,
          el('span', { class: `role ${m.role}`, 'data-tip': m.role === 'gm' ? 'Can pass time, edit everything and see secrets' : 'Sees the calendar, adds notes, and adds events if allowed' }, m.role === 'gm' ? 'GM' : 'Player')),
        isGM() ? el('div', { class: 'actions' }, btn('Remove', async () => {
          if (!await confirmDialog(`Remove ${m.display_name} from this campaign?`)) return;
          try { await post('member_remove', { user_id: m.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Take them out of this campaign. Their account stays')) : null)));
    if (isGM()) {
      const f = el('form', { class: 'row' }, el('input', { name: 'email', type: 'email', placeholder: 'Their sign-in email', required: true, class: 'grow' }),
        select([['player', 'Player'], ['gm', 'Co-GM']], 'player', { name: 'role', 'data-tip': 'A co-GM has the same powers as you, including secrets' }), el('button', { class: 'primary small' }, 'Add member'));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        try { await post('member_add', formData(f), S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
      });
      card.append(el('h3', {}, 'Add a member'), f, el('small', { class: 'muted' }, 'Use the email they sign in with. They need to have signed in once and been approved by the site admin.'));
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
      shiftNames: E.shiftNames(c).join(', '),
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
      const s = { ...st, current_region: v.current_region ? Number(v.current_region) : null, time_unit: v.time_unit, temp_unit: v.temp_unit,
        players_see_future_weather: v.players_see_future_weather, players_can_add_events: v.players_can_add_events };
      try { await post('campaign_update', { name: v.name, description: v.description, settings: s }, S.camp.id); await loadCampaign(S.camp.id, true); toast('Saved'); route(); }
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
        field('Hours per day', el('input', { type: 'number', name: 'hoursPerDay', value: c.hoursPerDay || 24 }), 'Used to turn travel hours into shifts'),
        field('Default light source', select([['natural', 'Sun & moons'], ['artificial', 'Artificial'], ['none', 'None']], c.lighting || 'natural', { name: 'cal_lighting' }), 'Regions can override',
          'Used for any region that doesn\'t set its own. See the Light source help on a region'),
        field('Shift names (4, comma-separated)', el('input', { name: 'shiftNames', value: t.shiftNames }), null,
          'Rename the four shifts, in order: the overnight one, then morning, midday and evening. Their lighting stays tied to that order')),
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
        await post('campaign_update', { calendar: E.PRESETS[presetSel.value].calendar }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      }, 'small'), 'Swap in the preset\'s months, weekdays, moons and seasons. Days, events and regions stay')),
      el('div', { class: 'row' }, btn('Delete this campaign', async () => {
        const typed = await promptDialog(`Type DELETE to permanently delete "${S.camp.name}" and everything in it.`, { title: 'Delete campaign', ok: 'Delete', danger: true });
        if (typed !== 'DELETE') return;
        await post('campaign_delete', { confirm: 'DELETE' }, S.camp.id); S.camp = null; location.hash = '#/';
      }, 'small danger', 'Permanently delete the campaign and everything in it. Asks you to type DELETE first')));
    mount(...campaignHeader('settings'), general, calForm, danger);
  }

  // ------------------------------------------------------------ router
  async function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    if (!S.user) return; // boot() shows the sign-in or waiting screen
    renderNav();
    try {
      if (parts[0] === '') return await viewCampaigns();
      if (parts[0] === 'account') return viewAccount();
      if (parts[0] === 'admin') return await viewAdmin();
      if (parts[0] === 'c') {
        const cid = Number(parts[1]);
        await loadCampaign(cid);
        const tab = parts[2] || 'calendar';
        if (tab === 'day') return await viewDay(Number(parts[3]));
        return await ({ calendar: viewCalendar, travel: viewTravel, regions: viewRegions, holidays: viewHolidays, members: viewMembers, settings: viewSettings }[tab] || viewCalendar)();
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
    if (res.status === 401) { S.user = null; S.pending = null; renderNav(); return viewLogin(data.providers || []); }
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

  window.addEventListener('hashchange', route);
  $('#version').textContent = `Campaign Chronicle build ${APP_VERSION}`;
  boot();
})();
