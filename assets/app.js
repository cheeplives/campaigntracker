/* Campaign Chronicle — browser app (plain JS, no build step).
 * All user-supplied text is inserted with textContent (via h()), never innerHTML.
 * Permissions are enforced by api.php; the UI only hides controls a role can't use. */
(function () {
  'use strict';
  const E = window.Engine;

  // ------------------------------------------------------------ DOM helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (s, el = document) => el.querySelector(s);
  const app = () => $('#app');
  const clean = kids => kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false);
  function mount(...kids) { const a = app(); a.replaceChildren(...clean(kids)); window.scrollTo(0, 0); }
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), 3200);
  }
  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  }
  function select(options, value, attrs) {
    return h('select', attrs || {}, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  }
  const btn = (label, onclick, cls) => h('button', { type: 'button', class: cls || '', onclick }, label);
  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
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
  const S = { user: null, csrf: '', camp: null, role: null, regions: [], holidays: [], members: [] };
  async function api(action, { query = {}, body = null } = {}) {
    const qs = new URLSearchParams({ a: action, ...query }).toString();
    const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-CSRF-Token'] = S.csrf; opt.body = JSON.stringify(body); }
    const res = await fetch('api.php?' + qs, opt);
    let data;
    try { data = await res.json(); } catch { throw new Error(`Server error (${res.status})`); }
    if (res.status === 401 && action !== 'login') { S.user = null; location.hash = '#/login'; }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
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
  const tempUnit = () => settings().temp_unit || 'C';
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
    return h('span', { class: `vis v${v.score}`, title: v.parts.join(' · ') }, `👁 ${v.score} ${v.label}`);
  }
  function moonBadges(d) {
    return E.moons(cal(), d).map(m => h('span', { class: 'moon', title: `${m.name}: ${m.label} (${Math.round(m.illum * 100)}% lit)` },
      h('span', { style: m.color && cal().moons.length > 1 ? { filter: `drop-shadow(0 0 2px ${m.color})` } : {} }, m.icon)));
  }
  function weatherText(w) {
    if (!w) return h('span', { class: 'muted' }, 'No weather recorded');
    const def = E.WEATHER[w.type] || {};
    return h('span', { class: 'wx' }, `${def.icon || ''} ${E.weatherLabel(w, tempUnit())}`);
  }
  /** year / month / day picker for this campaign's calendar; getAbs() returns the absolute day */
  function datePicker(abs) {
    const c = cal(), p = E.fromAbs(c, abs ?? today());
    const y = h('input', { type: 'number', value: p.year, class: 'w-year', 'aria-label': 'Year' });
    const m = select(c.months.map((mo, i) => [i, mo.name]), p.month, { 'aria-label': 'Month' });
    const d = h('input', { type: 'number', min: 1, value: p.day, class: 'w-day', 'aria-label': 'Day' });
    const wrap = h('span', { class: 'datepick' }, d, m, y);
    wrap.getAbs = () => {
      const yy = Number(y.value), mm = Number(m.value);
      const len = E.monthLength(c, yy, mm);
      return E.toAbs(c, yy, mm, Math.min(Math.max(1, Number(d.value) || 1), len));
    };
    return wrap;
  }

  // ------------------------------------------------------------ top nav
  function renderNav() {
    const n = $('#topnav');
    if (!S.user) { n.replaceChildren(); return; }
    n.replaceChildren(...clean([
      h('a', { href: '#/' }, 'Campaigns'),
      S.user.is_admin ? h('a', { href: '#/admin' }, 'Users') : null,
      h('a', { href: '#/account' }, S.user.display_name),
      btn('Log out', async () => {
        await post('logout', {}).catch(() => {});
        S.user = null; S.camp = null;
        try { S.csrf = (await api('me')).csrf; } catch { /* fresh token comes with the next page load */ }
        location.hash = '#/login'; route();
      }, 'link'),
    ]));
  }

  // ------------------------------------------------------------ login / account / admin
  function viewLogin() {
    const f = h('form', { class: 'card narrow' },
      h('h1', {}, 'Sign in'),
      field('Username', h('input', { name: 'username', autocomplete: 'username', required: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { class: 'primary' }, 'Sign in'));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await post('login', formData(f));
        S.user = r.user; S.csrf = r.csrf; location.hash = '#/'; renderNav(); route();
      } catch (err) { toast(err.message, true); }
    });
    mount(f);
  }

  function viewAccount() {
    const f = h('form', { class: 'card narrow' }, h('h2', {}, 'Change password'),
      field('Current password', h('input', { name: 'current', type: 'password', required: true })),
      field('New password', h('input', { name: 'new', type: 'password', minlength: 8, required: true })),
      h('button', { class: 'primary' }, 'Save'));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      try { await post('password', formData(f)); toast('Password changed'); f.reset(); } catch (err) { toast(err.message, true); }
    });
    mount(f);
  }

  async function viewAdmin() {
    const { users } = await api('users');
    const editForm = (u = {}) => {
      const f = h('form', { class: 'card' }, h('h3', {}, u.id ? `Edit ${u.username}` : 'New user'),
        h('div', { class: 'grid2' },
          field('Username', h('input', { name: 'username', value: u.username || '', required: true })),
          field('Display name', h('input', { name: 'display_name', value: u.display_name || '' })),
          field(u.id ? 'New password (blank = keep)' : 'Password', h('input', { name: 'password', type: 'password', minlength: 8, required: !u.id })),
          field('Site admin', h('input', { type: 'checkbox', name: 'is_admin', checked: !!Number(u.is_admin) }), 'Admins can manage users and act as GM in every campaign')),
        h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Save'), btn('Cancel', () => viewAdmin())));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        try { await post('user_save', { ...formData(f), id: u.id }); toast('Saved'); viewAdmin(); } catch (err) { toast(err.message, true); }
      });
      return f;
    };
    const list = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Users'), btn('+ New user', () => mount(editForm()), 'primary')),
      h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Username'), h('th', {}, 'Name'), h('th', {}, 'Admin'), h('th', {})),
        users.map(u => h('tr', {}, h('td', {}, u.username), h('td', {}, u.display_name), h('td', {}, Number(u.is_admin) ? 'Yes' : ''),
          h('td', { class: 'actions' }, btn('Edit', () => mount(editForm(u)), 'small'),
            u.id !== S.user.id ? btn('Delete', async () => {
              if (!confirm(`Delete user ${u.username}?`)) return;
              try { await post('user_delete', { id: u.id }); viewAdmin(); } catch (err) { toast(err.message, true); }
            }, 'small danger') : null)))));
    mount(list, h('p', { class: 'muted pad' }, 'Create accounts for your players here, then add them to a campaign from its Members tab.'));
  }

  // ------------------------------------------------------------ campaign list / create
  async function viewCampaigns() {
    const { campaigns } = await api('campaigns');
    S.camp = null;
    const list = h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h1', {}, 'Your campaigns'), btn('+ New campaign', viewCreate, 'primary')),
      campaigns.length ? h('ul', { class: 'camplist' }, campaigns.map(c =>
        h('li', {}, h('a', { href: `#/c/${c.id}` }, h('strong', {}, c.name), h('span', { class: `role ${c.role}` }, c.role === 'gm' ? 'GM' : 'Player')),
          c.description ? h('p', { class: 'muted' }, c.description) : null)))
        : h('p', { class: 'muted' }, 'No campaigns yet. Create one to get started.'));
    mount(list);
  }

  function viewCreate() {
    let preset = 'gregorian';
    const presetSel = select(Object.entries(E.PRESETS).map(([k, p]) => [k, p.label]), preset, { name: 'preset' });
    const startWrap = h('div');
    const tmpCal = () => { const c = JSON.parse(JSON.stringify(E.PRESETS[preset].calendar)); E.prep(c); return c; };
    let picker;
    const drawStart = () => {
      const p = E.PRESETS[preset], c = tmpCal();
      const saved = S.camp; S.camp = { calendar: c, current_shift: 0 }; // datePicker reads cal()
      picker = datePicker(E.toAbs(c, p.start.year, p.start.month, p.start.day));
      S.camp = saved;
      startWrap.replaceChildren(field('Starting date', picker, 'You can change "now" at any time later.'));
    };
    const seasonWrap = h('div');
    let seasons;
    const drawSeasons = () => {
      seasons = seasonEditor(tmpCal());
      const hemi = E.PRESETS[preset].calendar.hemisphere;
      seasonWrap.replaceChildren(h('h3', {}, 'Seasons'),
        hemi ? h('p', { class: 'muted' }, `Dates are for the ${hemi === 'south' ? 'southern' : 'northern'} hemisphere.`) : null, seasons);
    };
    const homeRegion = () => E.PRESETS[preset].regions.find(r => r.current) || E.PRESETS[preset].regions[0];
    const climateWrap = h('div');
    let climateSel;
    const drawClimate = () => {
      climateSel = climateSelect(homeRegion().settings.climate || 'temperate', { name: 'climate' });
      const hint = h('small', { class: 'muted' });
      const sync = () => {
        const k = E.KOPPEN[climateSel.value.replace('koppen:', '')];
        hint.textContent = k ? `Typical of ${k.where}. ` : '';
        hint.textContent += `Sets the baseline weather by season for "${homeRegion().name}"; each region can have its own climate (Regions tab).`;
      };
      climateSel.addEventListener('change', sync); sync();
      climateSel.querySelector('option[value=koppen_custom]').remove(); climateSel.querySelector('option[value=custom]').remove(); // built later, per region
      climateWrap.replaceChildren(h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Home region climate'), climateSel, hint));
    };
    presetSel.addEventListener('change', () => { preset = presetSel.value; drawStart(); drawSeasons(); drawClimate(); });
    drawStart(); drawSeasons(); drawClimate();
    const shiftSel = select(E.shiftNames(E.PRESETS[preset].calendar).map((n, i) => [i, n]), 2, { name: 'shift' });
    const f = h('form', { class: 'card narrow' }, h('h1', {}, 'New campaign'),
      field('Name', h('input', { name: 'name', required: true, maxlength: 150 })),
      field('Description', h('textarea', { name: 'description', rows: 2 })),
      field('Calendar preset', presetSel, 'Every preset can be fully customized afterwards (Settings tab).'),
      startWrap, field('Starting shift', shiftSel), climateWrap, seasonWrap,
      h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Create'), btn('Cancel', () => (location.hash = '#/'))));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const p = E.PRESETS[preset], v = formData(f);
      try {
        const r = await post('campaign_create', {
          name: v.name, description: v.description, calendar: { ...p.calendar, seasons: seasons.getSeasons() }, settings: { ...p.settings },
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
  function campaignHeader(active) {
    const c = cal(), d = today(), sh = E.mod(nowShift(), 4);
    const head = h('section', { class: 'nowbar' });
    const draw = async () => {
      let dayRow = null;
      try { dayRow = (await fetchRange(d, d)).days.get(d) || null; } catch { /* ignore */ }
      const region = regionById(dayRow?.region_id) || currentRegion();
      const w = dayRow?.weather || null;
      const v = E.visibility(c, region, w, d, sh, null);
      const hol = E.holidaysOn(c, S.holidays, d);
      head.replaceChildren(...clean([
        h('div', { class: 'now-main' },
          h('div', { class: 'now-title' }, h('h1', {}, S.camp.name), h('span', { class: `role ${S.role}` }, isGM() ? 'GM view' : 'Player view')),
          h('div', { class: 'now-time' },
            h('a', { href: `#/c/${S.camp.id}/day/${d}`, class: 'now-date' }, `${shiftNames()[sh]} · ${E.fmtDate(c, d)}`),
            h('span', { class: 'now-meta' }, region ? `📍 ${region.name}` : null, ' ', weatherText(w), ' ', visPill(v), ' ', moonBadges(d),
              hol.map(x => h('span', { class: 'chip', style: { background: x.color } }, x.name))))),
        isGM() ? passTimeWidget() : null]));
    };
    draw();
    const tabs = h('nav', { class: 'tabs' }, TABS.filter(([k]) => k !== 'settings' || isGM()).map(([k, l]) => h('a', { href: `#/c/${S.camp.id}/${k}`, class: k === active ? 'on' : '' }, l)));
    return [head, tabs];
  }

  function passTimeWidget() {
    const def = { day: 'shift', week: 'day', month: 'week' }[settings().time_unit || 'day'] || 'shift';
    const amt = h('input', { type: 'number', value: 1, min: -9999, class: 'w-num', 'aria-label': 'Amount' });
    const unit = select([['shift', 'shift(s)'], ['day', 'day(s)'], ['week', 'week(s)'], ['month', 'month(s)'], ['year', 'year(s)']], def, { 'aria-label': 'Unit' });
    const act = h('input', { placeholder: 'Activity for the passed shifts (optional)', class: 'grow' });
    const go = btn('Pass time ▶', null, 'primary');
    go.addEventListener('click', busy(go, async () => {
      const n = unitShifts(unit.value, Number(amt.value) || 0);
      if (Math.abs(n) > 4 * 3650 && !confirm(`That jumps ${Math.round(Math.abs(n) / 4)} days. Continue?`)) return;
      await passShifts(n, act.value.trim());
      vs().anchor = today();
      toast(`Now: ${E.fmtShift(cal(), nowShift())}`);
      route();
    }));
    const back = btn('◀ 1 shift', null, 'small');
    back.addEventListener('click', busy(back, async () => { await passShifts(-1); route(); }));
    return h('div', { class: 'passtime' }, h('span', { class: 'lbl' }, 'Pass time'), amt, unit, act, go, back);
  }

  // ------------------------------------------------------------ calendar tab
  const viewState = {};
  function vs() { return viewState[S.camp.id] || (viewState[S.camp.id] = { mode: settings().time_unit === 'day' ? 'week' : 'month', anchor: today() }); }

  async function viewCalendar() {
    const c = cal(), st = vs();
    const body = h('div', { class: 'card' });
    const anchor = st.anchor;
    let from, to, title, seasonLine = null;
    if (st.mode === 'month') {
      const p = E.fromAbs(c, anchor);
      from = E.toAbs(c, p.year, p.month, 1);
      to = from + E.monthLength(c, p.year, p.month) - 1;
      title = `${c.months[p.month].name} ${E.yearLabel(c, p.year)}`;
      const segs = (c.seasons || []).length ? E.monthSeasons(c, p.year)[p.month].seasons : [];
      if (segs.length) seasonLine = h('div', { class: 'seasonline' }, segs.map((x, i) =>
        h('span', { class: 'seasonseg' }, seasonChip(x), i ? ` begins on day ${x.from}` : '')));
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
        if (m < 0) { m = c.months.length - 1; y--; } else if (m >= c.months.length) { m = 0; y++; }
        st.anchor = E.toAbs(c, y, m, 1);
      } else st.anchor = anchor + dir * E.weekLength(c);
      route();
    };
    const jump = datePicker(anchor);
    const toolbar = h('div', { class: 'calbar' },
      btn('◀', () => step(-1), 'small'), h('h2', {}, title), btn('▶', () => step(1), 'small'),
      btn('Today', () => { st.anchor = today(); route(); }, 'small'),
      h('span', { class: 'seg' },
        btn('Month', () => { st.mode = 'month'; route(); }, st.mode === 'month' ? 'small on' : 'small'),
        btn('Week', () => { st.mode = 'week'; route(); }, st.mode === 'week' ? 'small on' : 'small')),
      h('span', { class: 'jump' }, jump, btn('Go', () => { st.anchor = jump.getAbs(); route(); }, 'small')));

    mount(...campaignHeader('calendar'), toolbar, seasonLine, body);
    body.append(h('p', { class: 'muted' }, 'Loading…'));
    const data = await fetchRange(from, to);
    const missing = []; for (let d = from; d <= to; d++) if (!data.days.get(d)?.weather) missing.push(d);
    const content = st.mode === 'month' ? monthGrid(from, to, data) : weekList(from, to, data);
    body.replaceChildren(content);
    if (isGM() && missing.length) {
      const g = btn(`Generate weather for ${missing.length} day(s) here`, null, 'small');
      g.addEventListener('click', busy(g, async () => { await ensureWeather(from, to); route(); }));
      body.append(h('div', { class: 'row' }, g, h('small', { class: 'muted' }, 'Days are generated automatically as time passes; this forecasts ahead. Players only see future weather if you allow it in Settings.')));
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

  function dayCell(d, data, compact) {
    const c = cal(), p = E.fromAbs(c, d), row = data.days.get(d);
    const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
    const w = row?.weather, def = w ? E.WEATHER[w.type] : null;
    const cls = ['daycell'];
    if (d === today()) cls.push('today');
    if (d < today()) cls.push('past');
    if (p.intercalary) cls.push('festival');
    if (evs.length || hol.length) cls.push('has-ev');
    return h('a', { class: cls.join(' '), href: `#/c/${S.camp.id}/day/${d}` },
      h('div', { class: 'dc-top' }, h('span', { class: 'dnum' }, p.intercalary && E.monthLength(c, p.year, p.month) === 1 ? c.months[p.month].name : p.day),
        h('span', { class: 'dc-icons' }, def ? h('span', { title: E.weatherLabel(w, tempUnit()) }, def.icon) : null,
          compact ? null : keyMoonPhases(d).map(m => h('span', { title: `${m.name}: ${m.label}` }, m.icon)))),
      hol.map(x => h('div', { class: 'chip', style: { background: x.color } }, x.name)),
      evs.slice(0, 3).map(e => h('div', { class: 'evline' + (Number(e.is_secret) ? ' secret' : '') }, Number(e.is_secret) ? '🔒 ' : '• ', e.title)),
      evs.length > 3 ? h('div', { class: 'muted small' }, `+${evs.length - 3} more`) : null,
      row?.has_notes ? h('div', { class: 'muted small' }, '📝') : null);
  }

  function monthGrid(from, to, data) {
    const c = cal(), wl = E.weekLength(c);
    const p = E.fromAbs(c, from);
    if (c.months[p.month].intercalary || !c.weekdays.length) {
      return h('div', { class: 'grid-free', style: { gridTemplateColumns: `repeat(${Math.min(wl, to - from + 1)}, minmax(0,1fr))` } },
        Array.from({ length: to - from + 1 }, (_, i) => dayCell(from + i, data)));
    }
    const lead = E.weekday(c, from) || 0;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'daycell empty' }));
    for (let d = from; d <= to; d++) cells.push(dayCell(d, data));
    return h('div', {},
      h('div', { class: 'grid-head', style: { gridTemplateColumns: `repeat(${wl}, minmax(0,1fr))` } }, c.weekdays.map(n => h('div', { title: n }, n.slice(0, 3)))),
      h('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${wl}, minmax(0,1fr))` } }, cells));
  }

  function weekList(from, to, data) {
    const c = cal(), names = shiftNames();
    const rows = [];
    for (let d = from; d <= to; d++) {
      const row = data.days.get(d), w = row?.weather, sh = dayShifts(data, d);
      const reg = regionById(row?.region_id) || currentRegion();
      const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
      rows.push(h('a', { class: 'weekrow' + (d === today() ? ' today' : ''), href: `#/c/${S.camp.id}/day/${d}` },
        h('div', { class: 'wr-date' }, h('strong', {}, E.fmtDate(c, d)), h('div', { class: 'small' }, weatherText(w), ' ', moonBadges(d)),
          hol.map(x => h('span', { class: 'chip', style: { background: x.color } }, x.name)),
          evs.map(e => h('div', { class: 'evline' + (Number(e.is_secret) ? ' secret' : '') }, Number(e.is_secret) ? '🔒 ' : '• ', e.title))),
        h('div', { class: 'wr-shifts' }, [0, 1, 2, 3].map(i => {
          const s = sh[i] || {};
          const v = E.visibility(c, reg, w, d, i, s.visibility_override);
          const isNow = d * 4 + i === nowShift();
          return h('div', { class: 'shiftbox' + (isNow ? ' now' : '') },
            h('div', { class: 'sb-head' }, h('span', {}, names[i]), visPill(v)),
            h('div', { class: 'sb-act' }, s.activity || h('span', { class: 'muted' }, '—')));
        }))));
    }
    return h('div', { class: 'weeklist' }, rows);
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

    const nav = h('div', { class: 'calbar' },
      h('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d - 1}` }, '◀ Previous day'),
      h('h2', {}, E.fmtDate(c, d)),
      h('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d + 1}` }, 'Next day ▶'),
      btn('Back to calendar', () => { vs().anchor = d; location.hash = `#/c/${S.camp.id}/calendar`; }, 'small'));

    // --- overview card
    const overview = h('div', { class: 'card' },
      h('div', { class: 'kv' },
        h('div', {}, h('span', { class: 'lbl' }, 'Season'), sea.name || '—'),
        h('div', {}, h('span', { class: 'lbl' }, 'Region'), region ? region.name : '—'),
        h('div', {}, h('span', { class: 'lbl' }, 'Weather'), weatherText(w)),
        h('div', {}, h('span', { class: 'lbl' }, 'Moons'), E.moons(c, d).map(m => h('div', {}, `${m.icon} ${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)`))),
        hol.length ? h('div', {}, h('span', { class: 'lbl' }, 'Holidays'), hol.map(x => h('div', {}, h('span', { class: 'chip', style: { background: x.color } }, x.name), x.description ? ` ${x.description}` : ''))) : null,
        d === today() ? h('div', {}, h('span', { class: 'lbl' }, 'Now'), names[E.mod(nowShift(), 4)]) : null),
      !isGM() && row.notes ? h('div', { class: 'notes' }, h('span', { class: 'lbl' }, 'Notes'), h('p', { class: 'pre' }, row.notes)) : null);

    if (isGM()) overview.append(dayEditor(d, row, region, w));

    // --- shifts
    const shiftCards = h('div', { class: 'shifts' }, [0, 1, 2, 3].map(i => shiftCard(d, i, shifts[i] || {}, region, w)));

    // --- events
    const evCard = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', {}, 'Events'),
      (isGM() || settings().players_can_add_events) ? btn('+ Add event', () => evCard.append(eventForm(d)), 'primary small') : null),
      r.events.length ? r.events.map(e => eventView(e, d)) : h('p', { class: 'muted' }, 'No events on this day.'));

    mount(...campaignHeader('calendar'), nav, overview, h('h3', { class: 'pad' }, 'Shifts'), shiftCards, evCard);
  }

  function dayEditor(d, row, region, w) {
    const regSel = select([['', '— (current region)'], ...S.regions.map(r => [r.id, r.name])], row.region_id ?? '', { name: 'region_id' });
    const wSel = select([['', '— none —'], ...Object.entries(E.WEATHER).map(([k, v]) => [k, `${v.icon} ${v.label}`])], w?.type || '', { name: 'wtype' });
    const tUnit = tempUnit();
    const tVal = w && typeof w.temp === 'number' ? (tUnit === 'F' ? Math.round(w.temp * 9 / 5 + 32) : w.temp) : '';
    const temp = h('input', { type: 'number', name: 'temp', value: tVal, class: 'w-num' });
    const wind = select(E.WIND.map((n, i) => [i, n]), w?.wind || 0, { name: 'wind' });
    const notes = h('textarea', { name: 'notes', rows: 3, value: row.notes || '' });
    const gmn = h('textarea', { name: 'gm_notes', rows: 3, value: row.gm_notes || '' });
    const f = h('form', { class: 'dayedit' },
      h('div', { class: 'grid2' },
        field('Region for this day', regSel),
        field('Weather', h('span', { class: 'row' }, wSel, temp, tUnit === 'none' ? '' : `°${tUnit}`, wind)),
        field('Day notes (players can see)', notes),
        field('GM notes 🔒', gmn)),
      h('div', { class: 'row' }, h('button', { class: 'primary small' }, 'Save day'),
        btn('🎲 Re-roll weather', async () => {
          const reg = regionById(regSel.value) || region;
          const prev = (await fetchRange(d - 1, d - 1)).days.get(d - 1)?.weather || null;
          const nw = E.genWeather(cal(), S.camp.seed, reg, d, prev, Date.now());
          await post('day_update', { abs_day: d, region_id: regSel.value || null, weather: nw, notes: notes.value, gm_notes: gmn.value }, S.camp.id);
          route();
        }, 'small'),
        d !== today() ? btn('Make this day "now"', async () => { await passShifts(d * 4 + E.mod(nowShift(), 4) - nowShift()); route(); }, 'small') : null));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      let weather = null;
      if (wSel.value) {
        let t = temp.value === '' ? null : Number(temp.value);
        if (t !== null && tUnit === 'F') t = Math.round((t - 32) * 5 / 9);
        weather = { ...(w || {}), type: wSel.value, temp: t, wind: Number(wind.value) };
      }
      try {
        await post('day_update', { abs_day: d, region_id: regSel.value || null, weather, notes: notes.value, gm_notes: gmn.value }, S.camp.id);
        toast('Day saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  function shiftCard(d, i, s, region, w) {
    const c = cal(), names = shiftNames();
    const v = E.visibility(c, region, w, d, i, s.visibility_override);
    const isNow = d * 4 + i === nowShift();
    const card = h('div', { class: 'card shiftcard' + (isNow ? ' now' : '') },
      h('div', { class: 'row spread' }, h('h4', {}, names[i], isNow ? h('span', { class: 'nowtag' }, 'NOW') : null), visPill(v)),
      h('small', { class: 'muted' }, v.parts.join(' · ')));
    if (!isGM()) {
      card.append(h('p', { class: 'pre' }, s.activity || h('span', { class: 'muted' }, 'No activity recorded.')));
      return card;
    }
    const act = h('textarea', { rows: 2, value: s.activity || '', placeholder: 'What the party does this shift' });
    const gmn = h('textarea', { rows: 2, value: s.gm_notes || '', placeholder: 'GM-only notes 🔒' });
    const ov = select([['', 'Auto'], ...E.VIS_LABELS.map((l, k) => [k, `${k} ${l}`])], s.visibility_override ?? '');
    const save = btn('Save', null, 'small primary');
    save.addEventListener('click', busy(save, async () => {
      await post('shift_save', { abs_day: d, shift: i, activity: act.value, gm_notes: gmn.value, visibility_override: ov.value }, S.camp.id);
      toast(`${names[i]} saved`); route();
    }));
    card.append(act, gmn, h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Visibility ', ov), save,
      !isNow ? btn('Set as now', async () => { await passShifts(d * 4 + i - nowShift()); route(); }, 'small') : null));
    return card;
  }

  function eventView(e, d) {
    const names = shiftNames(), c = cal();
    const mine = Number(e.created_by) === S.user.id;
    const span = e.end_day !== null && e.end_day !== undefined ? ` (${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })})` : '';
    const box = h('div', { class: 'event' + (Number(e.is_secret) ? ' secret' : '') });
    const notesList = h('div', { class: 'enotes' }, (e.notes || []).map(n => h('div', { class: 'enote' },
      h('div', { class: 'pre' }, n.body),
      h('small', { class: 'muted' }, `— ${n.author || 'unknown'}, ${n.created_at}`,
        (isGM() || Number(n.user_id) === S.user.id) ? btn('delete', async () => {
          if (!confirm('Delete this note?')) return;
          try { await post('note_delete', { id: n.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'link small') : null))));
    const noteIn = h('textarea', { rows: 2, placeholder: 'Add a note…' });
    const addNote = btn('Add note', null, 'small');
    addNote.addEventListener('click', busy(addNote, async () => {
      if (!noteIn.value.trim()) return;
      await post('note_add', { event_id: e.id, body: noteIn.value }, S.camp.id); route();
    }));
    box.append(...[
      h('div', { class: 'row spread' },
        h('h4', {}, Number(e.is_secret) ? h('span', { class: 'secret-tag' }, '🔒 SECRET') : null, e.title),
        h('small', { class: 'muted' }, e.shift !== null && e.shift !== undefined ? names[e.shift] : 'All day', span)),
      e.body ? h('p', { class: 'pre' }, e.body) : null,
      h('small', { class: 'muted' }, `Added by ${e.author || 'unknown'}`),
      (isGM() || mine) ? h('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(eventForm(d, e)), 'small'),
        btn('Delete', async () => {
          if (!confirm(`Delete "${e.title}"?`)) return;
          try { await post('event_delete', { id: e.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger')) : null,
      notesList, h('div', { class: 'row' }, noteIn, addNote)].filter(Boolean));
    return box;
  }

  function eventForm(d, e = {}) {
    const names = shiftNames();
    const start = Number(e.abs_day ?? d);
    const lasts = e.end_day !== null && e.end_day !== undefined ? Number(e.end_day) - start + 1 : 1;
    const startPick = datePicker(start);
    const f = h('form', { class: 'event editing' },
      h('div', { class: 'grid2' },
        field('Title', h('input', { name: 'title', value: e.title || '', required: true, maxlength: 200 })),
        field('Shift', select([['', 'All day'], ...names.map((n, i) => [i, n])], e.shift ?? '', { name: 'shift' })),
        field('Starts', startPick),
        field('Lasts (days)', h('input', { type: 'number', name: 'lasts', min: 1, value: lasts })),
        isGM() ? field('Secret (GM only)', h('input', { type: 'checkbox', name: 'is_secret', checked: !!Number(e.is_secret) })) : null),
      field('Details', h('textarea', { name: 'body', rows: 4, value: e.body || '' })),
      h('div', { class: 'row' }, h('button', { class: 'primary small' }, e.id ? 'Save event' : 'Add event'), btn('Cancel', () => route(), 'small')));
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
    const out = h('div', { class: 'travel-out' });
    const modeSel = select([
      ['ground', 'Overland / sea / air (speed × hours per day)'],
      ['hohmann', 'Orbital transfer (Hohmann, minimum fuel)'],
      ['brachistochrone', 'Constant-thrust burn (flip-and-burn / torch drive)'],
      ['relativistic', 'Interstellar at relativistic speed'],
      ['ftl', 'FTL / jump drive'],
    ], 'ground', { class: 'travel-mode' });
    const fieldsWrap = h('div', { class: 'grid2' });
    const unitSel = () => select([['km', 'km'], ['mi', 'miles'], ['AU', 'AU'], ['LY', 'light-years'], ['ls', 'light-seconds'], ['lm', 'light-minutes']], 'AU', { name: 'unit' });
    const drawFields = () => {
      const m = modeSel.value;
      const F = [];
      if (m === 'ground') {
        F.push(field('Distance', h('input', { name: 'distance', type: 'number', step: 'any', value: 60 }), 'Any unit — miles, km, leagues…'),
          field('Speed per hour (same unit)', h('input', { name: 'speed', type: 'number', step: 'any', value: 3 }), 'Walking ≈ 3 mph / 5 km/h; horse ≈ 5–6 mph; sailing ship ≈ 4–8 knots'),
          field('Travel hours per day', h('input', { name: 'hours_per_day', type: 'number', step: 'any', value: 8 }), '24 for ships that sail around the clock'),
          field('Terrain multiplier', select([[1, 'Road / open water ×1'], [1.5, 'Rough ×1.5'], [2, 'Forest / hills ×2'], [3, 'Mountains / swamp ×3']], 1, { name: 'terrain' })));
      } else if (m === 'hohmann') {
        const sys = h('select', { name: 'system' }, Object.entries(E.SYSTEMS).map(([k, s]) => h('option', { value: k }, s.label)));
        const r1 = h('input', { name: 'r1', type: 'number', step: 'any', value: 1 }), r2 = h('input', { name: 'r2', type: 'number', step: 'any', value: 1.524 });
        const b1 = h('select', {}), b2 = h('select', {});
        const fill = () => {
          const s = E.SYSTEMS[sys.value];
          const opts = [['', 'custom…'], ...Object.entries(s.bodies).map(([n, r]) => [r, n])];
          const names = opts.map(o => o[1]);
          const pick = [names.indexOf('Earth'), names.indexOf('Mars')];
          [b1, b2].forEach((b, k) => { b.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l))); b.selectedIndex = pick[k] > 0 ? pick[k] : Math.min(opts.length - 1, k + 1); });
          r1.value = b1.value; r2.value = b2.value;
          lbl1.firstChild.textContent = `From orbit radius (${s.unit})`; lbl2.firstChild.textContent = `To orbit radius (${s.unit})`;
        };
        b1.addEventListener('change', () => { if (b1.value) r1.value = b1.value; });
        b2.addEventListener('change', () => { if (b2.value) r2.value = b2.value; });
        const lbl1 = field('From', h('span', { class: 'row' }, b1, r1)), lbl2 = field('To', h('span', { class: 'row' }, b2, r2));
        sys.addEventListener('change', fill);
        F.push(field('Central body', sys), lbl1, lbl2);
        setTimeout(fill);
      } else if (m === 'brachistochrone' || m === 'relativistic') {
        F.push(field('Distance', h('span', { class: 'row' }, h('input', { name: 'distance', type: 'number', step: 'any', value: m === 'relativistic' ? 4.24 : 1.5 }), (() => { const u = unitSel(); if (m === 'relativistic') u.value = 'LY'; return u; })()),
          'Earth–Mars ranges 0.5–2.5 AU; Alpha Centauri is 4.24 LY'),
          field('Acceleration (g)', h('input', { name: 'g', type: 'number', step: 'any', value: m === 'relativistic' ? 1 : 0.3 }), '1 g = 9.81 m/s². The Expanse-style "juice" burns run 3–7 g; comfortable cruising is 0.3–1 g'),
          field('Speed cap (fraction of light, optional)', h('input', { name: 'max_speed_c', type: 'number', step: 'any', min: 0, max: 0.999, placeholder: 'none' }), 'Ship accelerates to the cap, coasts, then decelerates'));
      } else {
        const kind = select([['rate', 'Speed in light-years per day'], ['fixed', 'Fixed duration per jump']], 'rate', { name: 'ftl_kind' });
        F.push(field('FTL type', kind),
          field('Distance (LY)', h('input', { name: 'distance', type: 'number', step: 'any', value: 10 })),
          field('FTL speed (LY per day)', h('input', { name: 'rate', type: 'number', step: 'any', value: 1 })),
          field('Fixed jump duration (hours)', h('input', { name: 'fixed_hours', type: 'number', step: 'any', value: 168 }), 'e.g. 168 h = one week in jump space'));
      }
      fieldsWrap.replaceChildren(...F);
      out.replaceChildren();
    };
    modeSel.addEventListener('change', drawFields);
    drawFields();

    const regOpts = [['', '— no change —'], ...S.regions.map(r => [r.id, r.name])];
    const fromName = h('input', { placeholder: 'Origin (e.g. Earth)' }), toName = h('input', { placeholder: 'Destination (e.g. Mars)' });
    const travelReg = select(regOpts, ''), arriveReg = select(regOpts, '');
    const f = h('form', { class: 'card' }, h('h2', {}, 'Travel planner'),
      field('Mode', modeSel), fieldsWrap,
      h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Calculate')), out);

    let result = null;
    f.addEventListener('submit', e => {
      e.preventDefault();
      try {
        const q = formData(f);
        result = E.travel(modeSel.value, q);
        out.replaceChildren(h('div', { class: 'result' },
          h('h3', {}, `Travel time: ${E.fmtDuration(result.hours)}`, result.worldHours ? ' (ship time)' : ''),
          h('ul', {}, result.lines.map(l => h('li', {}, l))),
          result.worldHours ? h('p', { class: 'muted' }, 'The tracker follows the party, so it advances by ship time unless you pick world time below.') : null),
          isGM() ? departForm() : h('p', { class: 'muted' }, 'Only the GM can advance time.'));
      } catch (err) { out.replaceChildren(h('p', { class: 'bad' }, err.message)); }
    });

    const departForm = () => {
      const useWorld = h('input', { type: 'checkbox' });
      const shiftsFor = () => E.hoursToShifts(cal(), useWorld.checked && result.worldHours ? result.worldHours : result.hours);
      const info = h('small', { class: 'muted' });
      const upd = () => {
        const n = shiftsFor();
        info.textContent = `${n} shifts (${(n / 4).toFixed(1)} days). Arrive: ${E.fmtShift(cal(), nowShift() + n)}`;
      };
      useWorld.addEventListener('change', upd); upd();
      const go = btn('Depart — pass this much time', null, 'primary');
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
      return h('div', { class: 'depart' }, h('h3', {}, 'Make the trip'),
        h('div', { class: 'grid2' }, field('From', fromName), field('To', toName),
          field('Region while travelling', travelReg, 'e.g. "Ship interior" so transit days get shipboard conditions'),
          field('Region on arrival', arriveReg),
          result.worldHours ? field('Advance by outside-world time instead', useWorld) : null),
        info, h('div', { class: 'row' }, go),
        h('small', { class: 'muted' }, 'Labels every passed shift with the trip (without overwriting existing activity) and logs a multi-day travel event.'));
    };
    mount(...campaignHeader('travel'), f);
  }

  // ------------------------------------------------------------ regions tab
  function viewRegions() {
    const cur = settings().current_region;
    const list = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Regions'),
      isGM() ? btn('+ New region', () => list.after(regionForm()), 'primary small') : null),
      S.regions.map(r => h('div', { class: 'listrow' },
        h('div', {}, h('strong', {}, r.name), r.id === Number(cur) ? h('span', { class: 'nowtag' }, 'PARTY IS HERE') : null,
          h('div', { class: 'muted small' }, regionSummary(r)), r.description ? h('div', { class: 'small pre' }, r.description) : null),
        isGM() ? h('div', { class: 'actions' },
          r.id !== Number(cur) ? btn('Party is here', async () => { await setCurrentRegion(r.id); await ensureWeather(today(), today()); toast(`Party moved to ${r.name}`); await loadCampaign(S.camp.id, true); route(); }, 'small') : null,
          btn('Edit', () => list.after(regionForm(r)), 'small'),
          btn('Delete', async () => {
            if (!confirm(`Delete region ${r.name}? Days recorded there keep their weather.`)) return;
            await post('region_delete', { id: r.id }, S.camp.id); await loadCampaign(S.camp.id, true); route();
          }, 'small danger')) : null)));
    mount(...campaignHeader('regions'), list,
      h('p', { class: 'muted pad' }, 'A region sets the climate (weather odds by season), the light source (sun and moons, artificial lighting, or none), and a terrain modifier to visibility — e.g. −1 under forest canopy.'));
  }
  function climateName(s) {
    if (s.climate === 'custom') return 'Custom climate';
    if (s.climate === 'koppen_custom') return `${s.custom_climate?.label || 'Custom climate'}${s.custom_climate?.koppen ? ` (from ${s.custom_climate.koppen})` : ''}`;
    return E.climateFor({ settings: s }).label;
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
    const opt = (v, l) => h('option', { value: v, selected: v === value }, l);
    const groups = Object.entries(E.KOPPEN_GROUPS).map(([g, gl]) => h('optgroup', { label: `Köppen ${g} · ${gl}` },
      Object.entries(E.KOPPEN).filter(([code]) => code[0] === g).map(([code, k]) => opt(`koppen:${code}`, `${code} · ${k.label}`))));
    return h('select', attrs || {}, groups,
      h('optgroup', { label: 'Simple & setting climates' }, Object.entries(E.CLIMATES).map(([k, c]) => opt(k, c.label))),
      h('optgroup', { label: 'Custom' }, opt('koppen_custom', 'Custom Köppen build-out'), opt('custom', 'Custom (raw JSON)')));
  }
  /** Season-by-season baseline: typical highs, how wet, and the likeliest weather. */
  function climateBaseline(clim) {
    const unit = tempUnit() === 'none' ? 'C' : tempUnit();
    const rows = [...SEASON_ORDER, 'any'].filter(k => clim.seasons[k]).map(k => {
      const sd = clim.seasons[k], tot = Object.values(sd.w).reduce((a, b) => a + b, 0) || 1;
      const odds = Object.entries(sd.w).filter(([t, w]) => w > 0 && E.WEATHER[t]).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([t, w]) => `${E.WEATHER[t].icon} ${E.WEATHER[t].label} ${Math.round(w / tot * 100)}%`).join(', ');
      const desc = clim.base?.[k] ? E.describeBaseline(clim.base[k], unit) : `Highs ${E.fmtTemp(sd.t[0], unit)} to ${E.fmtTemp(sd.t[1], unit)}`;
      return h('tr', {}, h('td', {}, h('span', { class: `season s-${k === 'any' ? 'none' : k}` }, k === 'any' ? 'No season' : SEASON_LABELS[k])), h('td', {}, desc), h('td', { class: 'muted' }, odds));
    });
    return h('table', { class: 'tbl baseline' }, h('tbody', {}, rows));
  }
  /** Builder for a custom climate: start from Köppen letters, then tune each season's baseline. */
  function koppenBuilder(cc, onChange) {
    let base = cc?.base ? JSON.parse(JSON.stringify(cc.base)) : E.koppenBase('Cfb');
    let from = cc?.koppen || 'Cfb';
    const name = h('input', { value: cc?.label || `Custom ${from}`, 'aria-label': 'Climate name', maxlength: 80 });
    const letter = (opts, v, lbl) => select(Object.entries(opts).map(([k, l]) => [k, `${k} · ${l}`]), v, { 'aria-label': lbl });
    const lettersWrap = h('span', { class: 'row' });
    const codeOut = h('strong', {});
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
      codeOut.title = c ? `e.g. ${E.KOPPEN[c].where}` : '';
      load.disabled = !c;
    };
    const load = btn('Load baseline', () => {
      const c = code(); if (!c) return;
      if (name.value.trim() === `Custom ${from}` || !name.value.trim()) name.value = `Custom ${c}`;
      from = c; base = E.koppenBase(c); drawTable(); onChange();
    }, 'small');
    const num = (v, k, i, attrs) => h('input', { type: 'number', value: v, step: k === 't' ? 1 : 0.5, 'data-k': k, 'data-i': i, class: 'w-num', ...attrs });
    const scale = (v, k, max, lbl) => h('input', { type: 'number', min: 0, max, step: 'any', value: Number(v) || 0, 'data-k': k, class: 'w-num', 'aria-label': lbl });
    const table = h('table', { class: 'tbl builder' });
    const drawTable = () => table.replaceChildren(
      h('thead', {}, h('tr', {}, ['Season', 'Highs from °C', 'to °C', 'Precipitation 0–5', 'Storms 0–3', 'Fog 0–3', 'Dust 0–3'].map(x => h('th', {}, x)))),
      h('tbody', {}, SEASON_ORDER.map(k => {
        const p = base[k];
        return h('tr', { 'data-s': k }, h('td', {}, h('span', { class: `season s-${k}` }, SEASON_LABELS[k])),
          h('td', {}, num(p.t[0], 't', 0, { 'aria-label': `${k} lowest high` })), h('td', {}, num(p.t[1], 't', 1, { 'aria-label': `${k} highest high` })),
          h('td', {}, scale(p.wet, 'wet', 5, `${k} precipitation`)),
          ...['storm', 'fog', 'dust'].map(x => h('td', {}, scale(p[x], x, 3, `${k} ${x}`))));
      })));
    const read = () => {
      for (const tr of table.querySelectorAll('tbody tr')) {
        const p = base[tr.dataset.s];
        for (const el of tr.querySelectorAll('[data-k]')) {
          const v = Number(el.value) || 0;
          if (el.dataset.k === 't') p.t[Number(el.dataset.i)] = Math.round(v);
          else p[el.dataset.k] = Math.max(0, Math.min(el.dataset.k === 'wet' ? 5 : 3, v));
        }
      }
    };
    group.addEventListener('change', () => drawLetters());
    lettersWrap.addEventListener('change', e => { if (e.target !== group) syncCode(); });
    drawLetters(from); drawTable();
    table.addEventListener('change', () => { read(); onChange(); });
    name.addEventListener('input', onChange);
    const wrap = h('div', { class: 'builderwrap' },
      field('Climate name', name),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Start from a Köppen class'), h('span', { class: 'row' }, lettersWrap, codeOut, load),
        h('small', { class: 'muted' }, 'Pick the group, precipitation pattern and temperature letters, then load that class\'s baseline and tune any season below. Highs are daytime highs; precipitation runs from 0 (arid) to 5 (torrential), storms, fog and dust from 0 (never) to 3 (frequent). Storms in freezing weather become blizzards.')),
      table);
    wrap.getClimate = () => { read(); return { label: name.value.trim() || 'Custom climate', koppen: from, base: JSON.parse(JSON.stringify(base)) }; };
    return wrap;
  }

  function regionForm(r = { settings: {} }) {
    const s = r.settings || {};
    const climate = climateSelect(s.climate || 'temperate', { name: 'climate' });
    const custom = h('textarea', { name: 'custom_climate', rows: 8, class: 'mono',
      value: JSON.stringify(s.climate === 'custom' && s.custom_climate ? s.custom_climate : E.CLIMATES.temperate, null, 1) });
    const customWrap = field('Custom climate', custom, 'Seasons: spring/summer/autumn/winter/any. t = [low, high] °C; w = weather weights. Weather keys: ' + Object.keys(E.WEATHER).join(', '));
    const baseline = h('div', {});
    const builder = koppenBuilder(s.climate === 'koppen_custom' ? s.custom_climate : null, () => drawBaseline());
    const baselineWrap = h('details', { open: true, class: 'field' }, h('summary', {}, 'Baseline weather by season'), baseline,
      h('small', { class: 'muted' }, 'Each day\'s weather is rolled against these odds for the season it falls in, then drifts from the day before.'));
    const drawBaseline = () => {
      const v = climate.value;
      if (v === 'custom') return baseline.replaceChildren();
      const clim = v === 'koppen_custom' ? E.buildClimate(builder.getClimate().base, builder.getClimate()) : E.climateFor({ settings: { climate: v } });
      const k = v.startsWith('koppen:') ? E.KOPPEN[v.slice(7)] : null;
      baseline.replaceChildren(...clean([k ? h('p', { class: 'muted' }, `${k.label}. Typical of ${k.where}.`) : null, climateBaseline(clim)]));
    };
    const syncCustom = () => {
      customWrap.style.display = climate.value === 'custom' ? '' : 'none';
      builder.style.display = climate.value === 'koppen_custom' ? '' : 'none';
      baselineWrap.style.display = climate.value === 'custom' ? 'none' : '';
      drawBaseline();
    };
    climate.addEventListener('change', syncCustom); syncCustom();
    const lv = s.light_levels || [2, 4, 5, 4];
    const f = h('form', { class: 'card' }, h('h3', {}, r.id ? `Edit ${r.name}` : 'New region'),
      h('div', { class: 'grid2' },
        field('Name', h('input', { name: 'name', value: r.name || '', required: true })),
        field('Climate', climate),
        field('Hemisphere', select([['north', 'Northern'], ['south', 'Southern']], s.hemisphere || cal().hemisphere || 'north', { name: 'hemisphere' }),
          `Seasons flip when this differs from the calendar's (${cal().hemisphere === 'south' ? 'southern' : 'northern'}) hemisphere`),
        field('Light source', select([['natural', 'Sun & moons'], ['artificial', 'Artificial (ship, station, city lights)'], ['none', 'None (caves, deep space)']], s.lighting || 'natural', { name: 'lighting' })),
        field('Terrain visibility modifier', select([[-2, '−2 (dense jungle, deep canyon)'], [-1, '−1 (forest, narrow streets)'], [0, '0 (open)'], [1, '+1 (snowfield, desert glare, open sea)']], s.terrain_mod || 0, { name: 'terrain_mod' })),
        field('Artificial light per shift (0–5)', h('span', { class: 'row' }, shiftNames().map((n, i) =>
          h('input', { type: 'number', min: 0, max: 5, name: `lv${i}`, value: lv[i], class: 'w-num', title: n }))), 'Overnight / Dawn / Noon / Dusk — used when Light source is Artificial')),
      customWrap, builder, baselineWrap,
      field('Description', h('textarea', { name: 'description', rows: 2, value: r.description || '' })),
      h('div', { class: 'row' }, h('button', { class: 'primary small' }, 'Save region'), btn('Cancel', () => f.remove(), 'small')));
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
    const list = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Holidays & recurring days'),
      isGM() ? btn('+ New holiday', () => list.after(holidayForm()), 'primary small') : null),
      S.holidays.length ? S.holidays.map(x => h('div', { class: 'listrow' },
        h('div', {}, h('span', { class: 'chip', style: { background: x.color } }, x.name), x.is_secret ? h('span', { class: 'secret-tag' }, '🔒 SECRET') : null,
          h('div', { class: 'small muted' }, describeRule(x.rule)), x.description ? h('div', { class: 'small pre' }, x.description) : null),
        isGM() ? h('div', { class: 'actions' }, btn('Edit', () => list.after(holidayForm(x)), 'small'),
          btn('Delete', async () => { if (!confirm(`Delete ${x.name}?`)) return; await post('holiday_delete', { id: x.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); }, 'small danger')) : null))
        : h('p', { class: 'muted' }, 'No holidays yet.'));
    mount(...campaignHeader('holidays'), list);
  }
  function holidayForm(x = { rule: { type: 'fixed', month: 0, day: 1, span: 1 }, color: '#b8860b' }) {
    const c = cal(), r = x.rule || {};
    const type = select([['fixed', 'Same date every year'], ['nth_weekday', 'Nth weekday of a month'], ['once', 'One time only'], ['every_n', 'Every N days']], r.type, { name: 'type' });
    const monthSel = select(c.months.map((m, i) => [i, m.name]), r.month ?? 0, { name: 'month' });
    const dayIn = h('input', { type: 'number', min: 1, name: 'day', value: r.day || 1 });
    const wdSel = select(c.weekdays.map((w, i) => [i, w]), r.weekday ?? 0, { name: 'weekday' });
    const nSel = select([[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, '5th'], [-1, 'Last']], r.n ?? 1, { name: 'n' });
    const oncePick = datePicker(r.abs_day ?? today()), startPick = datePicker(r.start ?? today());
    const interval = h('input', { type: 'number', min: 1, name: 'interval', value: r.interval || 30 });
    const parts = {
      month: field('Month', monthSel), day: field('Day', dayIn), weekday: field('Weekday', wdSel), n: field('Which one', nSel),
      once: field('Date', oncePick), start: field('First occurrence', startPick), interval: field('Repeat every (days)', interval),
    };
    const show = { fixed: ['month', 'day'], nth_weekday: ['n', 'weekday', 'month'], once: ['once'], every_n: ['start', 'interval'] };
    const sync = () => Object.entries(parts).forEach(([k, el]) => (el.style.display = show[type.value].includes(k) ? '' : 'none'));
    type.addEventListener('change', sync);
    const f = h('form', { class: 'card' }, h('h3', {}, x.id ? `Edit ${x.name}` : 'New holiday'),
      h('div', { class: 'grid2' },
        field('Name', h('input', { name: 'name', value: x.name || '', required: true })),
        field('Repeats', type), ...Object.values(parts),
        field('Lasts (days)', h('input', { type: 'number', min: 1, name: 'span', value: r.span || 1 })),
        field('Color', h('input', { type: 'color', name: 'color', value: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#b8860b' })),
        field('Secret (GM only)', h('input', { type: 'checkbox', name: 'is_secret', checked: !!x.is_secret }))),
      field('Description', h('textarea', { name: 'description', rows: 2, value: x.description || '' })),
      h('div', { class: 'row' }, h('button', { class: 'primary small' }, 'Save holiday'), btn('Cancel', () => f.remove(), 'small')));
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
    const card = h('div', { class: 'card' }, h('h2', {}, 'Members'),
      S.members.map(m => h('div', { class: 'listrow' },
        h('div', {}, h('strong', {}, m.display_name), m.username ? h('span', { class: 'muted' }, ` (${m.username})`) : null, h('span', { class: `role ${m.role}` }, m.role === 'gm' ? 'GM' : 'Player')),
        isGM() ? h('div', { class: 'actions' }, btn('Remove', async () => {
          if (!confirm(`Remove ${m.display_name} from this campaign?`)) return;
          try { await post('member_remove', { user_id: m.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger')) : null)));
    if (isGM()) {
      const f = h('form', { class: 'row' }, h('input', { name: 'username', placeholder: 'Username', required: true }),
        select([['player', 'Player'], ['gm', 'Co-GM']], 'player', { name: 'role' }), h('button', { class: 'primary small' }, 'Add member'));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        try { await post('member_add', formData(f), S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
      });
      card.append(h('h3', {}, 'Add a member'), f, h('small', { class: 'muted' }, 'The account must exist first — site admins create accounts under Users.'));
    }
    mount(...campaignHeader('members'), card);
  }

  // ------------------------------------------------------------ season editor
  const SEASON_LABELS = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter', none: 'None (no climate change)' };
  const seasonChip = s => h('span', { class: `season s-${s.type || 'none'}` }, s.name || '—');
  /** Editable list of seasons (name, climate type, start month & day) with a live month-by-month preview. */
  function seasonEditor(c) {
    const rows = h('div', { class: 'seasonrows' });
    const preview = h('div', { class: 'seasonmap' });
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
      preview.replaceChildren(h('table', { class: 'tbl' }, h('tbody', {}, map.map(({ month, seasons }) =>
        h('tr', {}, h('td', {}, c.months[month].name), h('td', {}, test.seasons.length
          ? seasons.map(x => h('span', { class: 'seasonseg' }, seasonChip(x), seasons.length > 1 ? ` ${x.from}–${x.to}` : ''))
          : h('span', { class: 'muted' }, 'No seasons')))))));
    };
    const addRow = (s = { name: '', type: 'none', month: 0, day: 1 }) => {
      const month = select(monthOpts, s.month, { 'data-k': 'month', 'aria-label': 'Start month' });
      const day = h('input', { type: 'number', min: 1, value: s.day || 1, class: 'w-day', 'data-k': 'day', 'aria-label': 'Start day' });
      const syncMax = () => { const mo = c.months[month.value]; day.max = Number(mo.days) + Number(mo.leapDays || 0); };
      month.addEventListener('change', syncMax); syncMax();
      const row = h('div', { class: 'row seasonrow' },
        h('input', { value: s.name || '', placeholder: 'Season name', 'data-k': 'name', 'aria-label': 'Season name', class: 'grow' }),
        select(Object.entries(SEASON_LABELS), s.type || 'none', { 'data-k': 'type', 'aria-label': 'Climate' }),
        month, day,
        btn('✕', () => { row.remove(); redraw(); }, 'small link'));
      rows.append(row);
    };
    (c.seasons || []).forEach(s => addRow(s));
    const wrap = h('div', { class: 'seasoned' }, h('small', { class: 'muted' }, 'Name · climate · first month and day'), rows,
      h('div', { class: 'row' }, btn('+ Add season', () => { addRow(); redraw(); rows.lastChild.querySelector('input').focus(); }, 'small'),
        h('small', { class: 'muted' }, 'Each season runs from its start day until the next one begins, wrapping into the next year. The climate decides which weather table regions use.')),
      h('details', { open: true }, h('summary', {}, 'Seasons by month'), preview));
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
      months: c.months.map(m => [m.name, m.days, m.leapDays || 0, m.intercalary ? 'festival' : ''].filter((x, i) => i < 3 || x).join(', ')).join('\n'),
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
      const m = { name, days: Math.max(1, Number(days) || 1) };
      if (Number(leap)) m.leapDays = Number(leap);
      if (fest && /fest|inter/i.test(fest)) m.intercalary = true;
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
    if (!isGM()) { mount(...campaignHeader('settings'), h('div', { class: 'card' }, h('p', {}, 'Only the GM can change campaign settings.'))); return; }
    const st = settings(), c = cal(), t = calToText(c);
    const ta = (name, value, rows) => h('textarea', { name, rows: rows || 4, value, class: 'mono' });
    const general = h('form', { class: 'card' }, h('h2', {}, 'Campaign'),
      h('div', { class: 'grid2' },
        field('Name', h('input', { name: 'name', value: S.camp.name, required: true })),
        field('Party\'s current region', select([['', '—'], ...S.regions.map(r => [r.id, r.name])], st.current_region ?? '', { name: 'current_region' })),
        field('Time scale', select([['day', 'Day by day (detailed shifts)'], ['week', 'Week by week'], ['month', 'Month by month']], st.time_unit || 'day', { name: 'time_unit' }), 'Sets the default calendar view and pass-time step'),
        field('Temperature', select([['C', '°C'], ['F', '°F'], ['none', 'Hide temperatures']], st.temp_unit || 'C', { name: 'temp_unit' })),
        field('Players see future weather', h('input', { type: 'checkbox', name: 'players_see_future_weather', checked: !!st.players_see_future_weather })),
        field('Players can add events', h('input', { type: 'checkbox', name: 'players_can_add_events', checked: !!st.players_can_add_events }), 'They can always add notes to events they can see')),
      field('Description', h('textarea', { name: 'description', rows: 2, value: S.camp.description || '' })),
      h('button', { class: 'primary' }, 'Save campaign settings'));
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
    const calForm = h('form', { class: 'card' }, h('h2', {}, 'Calendar'),
      h('p', { class: 'muted' }, 'Changing the calendar re-labels every stored day: records stay attached to the same absolute day number, not to a month name.'),
      h('div', { class: 'grid2' },
        field('Calendar name', h('input', { name: 'cal_name', value: c.name || '' })),
        field('Year label suffix', h('input', { name: 'yearSuffix', value: c.yearSuffix || '' }), 'e.g. IC, AD, MY'),
        field('First year (epoch)', h('input', { type: 'number', name: 'epochYear', value: c.epochYear })),
        field('Weekday of epoch day 1 (0 = first weekday)', h('input', { type: 'number', name: 'weekdayOffset', value: c.weekdayOffset || 0 })),
        field('Date format', h('input', { name: 'dateFormat', value: c.dateFormat || '{W}, {d} {M} {Y}' }), '{W} weekday, {d} day, {M} month, {Y} year'),
        field('Hours per day', h('input', { type: 'number', name: 'hoursPerDay', value: c.hoursPerDay || 24 }), 'Used to turn travel hours into shifts'),
        field('Default light source', select([['natural', 'Sun & moons'], ['artificial', 'Artificial'], ['none', 'None']], c.lighting || 'natural', { name: 'cal_lighting' }), 'Regions can override'),
        field('Shift names (4, comma-separated)', h('input', { name: 'shiftNames', value: t.shiftNames }))),
      field('Weekdays (comma-separated; leave empty for no weeks)', ta('weekdays', t.weekdays, 2)),
      field('Months — one per line: Name, days, leap days[, festival]', ta('months', t.months, 8), 'Add "festival" for intercalary days that sit outside the weekday cycle (like Mitterfruhl)'),
      h('div', { class: 'grid3' },
        field('Leap year every N years (0 = none)', h('input', { type: 'number', name: 'leap_every', value: L.every || 0 })),
        field('…except every N years', h('input', { type: 'number', name: 'leap_skip', value: L.skip || 0 })),
        field('…unless every N years', h('input', { type: 'number', name: 'leap_unskip', value: L.unskip || 0 }))),
      h('h3', {}, 'Seasons'),
      field('Season dates are for the', select([['north', 'Northern hemisphere'], ['south', 'Southern hemisphere']], c.hemisphere || 'north', { name: 'cal_hemisphere' }),
        'Regions in the other hemisphere get the opposite season'),
      seasons,
      h('small', { class: 'muted' }, 'Start months use the saved month list; save month changes first, then adjust seasons.'),
      field('Moons — one per line: Name, cycle days, reference day, brightness 0–1, color[, erratic]', ta('moons', t.moons, 3), 'Reference day = an absolute day number when the moon is new. Today is absolute day ' + today() + '.'),
      h('details', {}, h('summary', {}, 'Advanced: raw calendar JSON'), ta('raw', JSON.stringify(c, null, 1), 12),
        h('small', { class: 'muted' }, 'If you edit this box, it is saved instead of the fields above.')),
      h('button', { class: 'primary' }, 'Save calendar'));
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
    const danger = h('div', { class: 'card' }, h('h2', {}, 'Tools'),
      h('div', { class: 'row' }, presetSel, btn('Replace calendar with preset', async () => {
        if (!confirm('Replace this campaign\'s calendar with the preset? Stored days keep their absolute day numbers.')) return;
        await post('campaign_update', { calendar: E.PRESETS[presetSel.value].calendar }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      }, 'small')),
      h('div', { class: 'row' }, btn('Delete this campaign', async () => {
        const typed = prompt(`Type DELETE to permanently delete "${S.camp.name}" and everything in it.`);
        if (typed !== 'DELETE') return;
        await post('campaign_delete', { confirm: 'DELETE' }, S.camp.id); S.camp = null; location.hash = '#/';
      }, 'small danger')));
    mount(...campaignHeader('settings'), general, calForm, danger);
  }

  // ------------------------------------------------------------ router
  async function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    renderNav();
    try {
      if (!S.user) { if (parts[0] !== 'login') location.hash = '#/login'; return viewLogin(); }
      if (parts[0] === 'login' || parts[0] === '') return await viewCampaigns();
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
      mount(h('div', { class: 'card narrow' }, h('h2', {}, 'Something went wrong'), h('p', {}, err.message), h('a', { href: '#/' }, 'Back to campaigns')));
    }
  }

  window.addEventListener('hashchange', route);
  (async () => {
    try { const r = await api('me'); S.user = r.user; S.csrf = r.csrf; }
    catch (e) { mount(h('div', { class: 'card narrow' }, h('h2', {}, 'Cannot reach the server'), h('p', {}, e.message, ' — did you run install.php?'))); return; }
    route();
  })();
})();
