/* Campaign Chronicle — browser app (plain JS, no build step).
 * All user-supplied text is inserted with textContent (via el()), never innerHTML. Rich text notes are rebuilt
 * element by element from an allow-list by RichText.view() (static/richtext.js).
 * Permissions are enforced by api/index.php; the UI only hides controls a role can't use.
 * Sign-in is Google/GitHub with an admin approval queue, the same as Sinless (api/auth/). */
(function () {
  'use strict';
  const E = window.Engine;

  const { el, $, toast, tip, tipped, hideTip, confirmDialog, promptDialog, alertDialog } = KIT;
  const app = () => $('#app');
  const clean = kids => kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false);
  // The campaign tabs stay pinned just under the sticky top bar, whose height changes as it wraps or shows the change notice.
  // Not a ResizeObserver: Safari raises "ResizeObserver loop completed with undelivered notifications" as a page error
  // whenever the bar's size also moves in the layout pass straight after the callback (a web font landing, say), which no
  // callback can prevent. Instead the height is measured on the next frame after anything that can change it.
  let topbarH = -1, fitQueued = false;
  const fitTopbar = () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const h = $('.topbar').offsetHeight;
      if (h !== topbarH) { topbarH = h; document.documentElement.style.setProperty('--topbar-h', `${h}px`); }
    });
  };
  new MutationObserver(fitTopbar).observe($('.topbar'), { childList: true, subtree: true, characterData: true, attributes: true });
  new MutationObserver(fitTopbar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
  window.addEventListener('resize', fitTopbar);
  // The installed app's title bar takes the top bar's colour, so it follows the theme and light/dark mode.
  const fitThemeColor = () => $('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  new MutationObserver(fitThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
  fitThemeColor();
  document.fonts?.addEventListener?.('loadingdone', fitTopbar);
  document.fonts?.ready.then(fitTopbar);
  fitTopbar();
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
  const S = { user: null, pending: null, csrf: '', camp: null, role: null, regions: [], holidays: [], members: [], tags: [], holdingTags: [], reminders: [],
    encReady: false, encyclopedia: [], encIgnored: [], encTags: [], libReady: false, libUploads: null, mapsReady: false };
  /** Build number, shown in the footer so a bug report names the build. Bump on each release. */
  const APP_VERSION = '24';
  async function api(action, { query = {}, body = null } = {}) {
    const qs = new URLSearchParams({ a: action, ...query }).toString();
    const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (query.cid && viewingAs(query.cid)) opt.headers['X-View-As'] = 'player';
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-CSRF-Token'] = S.csrf; opt.body = JSON.stringify(body); }
    const res = await fetch('api/index.php?' + qs, opt);
    let data;
    try { data = await res.json(); } catch { throw Object.assign(new Error(`Server error (${res.status})`), { status: res.status }); }
    // Signed out, or access changed while the page was open: go back through the gate.
    if (res.status === 401 || data.error === 'not_approved') { S.user = null; boot(); }
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `Error ${res.status}`), { status: res.status });
    if (body) ownWrite();
    return data;
  }
  const post = (action, body, cid) => api(action, { query: cid ? { cid } : {}, body });
  // View as player: a GM's choice, for this tab only, to have the server answer this campaign's pages as it would a player's
  const viewKey = cid => `chronicle-view-as-${cid}`;
  const viewingAs = cid => { try { return sessionStorage.getItem(viewKey(cid)) === 'player'; } catch { return false; } };
  function setViewingAs(on) {
    try { if (on) sessionStorage.setItem(viewKey(S.camp.id), 'player'); else sessionStorage.removeItem(viewKey(S.camp.id)); } catch { /* private window: stays as it was */ }
    loadCampaign(S.camp.id, true).then(route, err => toast(err.message, true));
  }

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
      if (seq === writeSeq && S.camp?.id === cid && r.changed !== S.camp.changed) { showChangeBanner(r.changed); checkReminders(); }
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

  // ------------------------------------------------------------ reminders
  // A reminder sits on a day and shift (or hour) of the calendar and pops up once the campaign clock reaches it,
  // for everyone it is meant for, until each of them dismisses it. Every page load in a campaign checks, and so
  // does the change poll, so a player sees it when the GM passes time without having to refresh.
  const REMINDER_AUDIENCES = [['me', 'Just me'], ['gm', 'The GMs'], ['all', 'Everyone']];
  const AUDIENCE_TEXT = { me: 'Only you', gm: 'GMs only', all: 'Everyone' };
  const snoozed = new Set(); // "id@clock": Remind me later was pressed; it pops up again once the clock moves
  let reminderOpen = false;
  async function loadReminders() {
    const cid = S.camp.id;
    const r = await api('reminders', { query: { cid } });
    if (S.camp?.id === cid) S.reminders = r.reminders;
    return r;
  }
  async function checkReminders() {
    if (!S.camp?.id) return;
    try { popDueReminders(await loadReminders()); } catch { /* offline for a moment: try again next time */ }
  }
  /** Show the reminders the clock has reached that this person hasn't dismissed (or put off at this time). */
  function popDueReminders({ reminders, current_shift: clock }) {
    if (reminderOpen) return;
    const due = reminders.filter(x => x.due && !x.dismissed && !snoozed.has(`${x.id}@${clock}`));
    if (due.length) reminderDialog(due, clock);
  }
  function reminderDialog(list, clock) {
    hideTip();
    reminderOpen = true;
    const cid = S.camp.id;
    const d = el('dialog', { class: 'kit-dialog reminder-dialog', 'aria-label': 'Reminders' },
      el('form', { method: 'dialog' },
        el('h3', {}, list.length === 1 ? '🔔 Reminder' : `🔔 ${list.length} reminders`),
        el('div', { class: 'reminder-list' }, list.map(x => el('div', { class: 'reminder' },
          el('strong', {}, x.title),
          el('div', { class: 'small muted' }, E.fmtShift(cal(), x.due_shift)),
          x.body ? el('p', { class: 'pre' }, x.body) : null,
          el('small', { class: 'muted' }, `${AUDIENCE_TEXT[x.audience] || ''} · from `, byline(x))))),
        el('div', { class: 'kit-dialog-actions' },
          el('button', { value: 'dismiss', class: 'primary', type: 'submit', autofocus: true }, 'Dismiss'),
          el('button', { value: 'later', type: 'submit' }, 'Remind me later'))));
    d.addEventListener('cancel', () => { d.returnValue = 'later'; });
    d.addEventListener('close', async () => {
      d.remove();
      reminderOpen = false;
      if (d.returnValue !== 'dismiss') { list.forEach(x => snoozed.add(`${x.id}@${clock}`)); return; }
      try {
        await post('reminder_dismiss', { ids: list.map(x => x.id) }, cid);
        list.forEach(x => (x.dismissed = true));
      } catch (e) { toast(e.message, true); }
    });
    document.body.append(d);
    d.showModal();
  }

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
  /** Campaign default (set by the GM) for anyone who hasn't picked their own units: 'metric' or 'imperial'. A campaign
   * saved before this choice had a temperature unit instead, and °F or °R stood for Imperial. */
  const campUnits = () => {
    const st = S.camp ? settings() : {};
    if (st.units) return st.units;
    return E.isImperial(st.temp_unit) ? 'imperial' : 'metric';
  };
  /** Whether the GM has hidden temperatures in this campaign (once the old 'Hide temperatures' unit). */
  const campHidesTemps = () => !!S.camp && (settings().hide_temps ?? settings().temp_unit === 'none');
  /** The user's own units, 'metric' or 'imperial', or '' to show each campaign's as its GM set them. An older
   * temperature-only choice still counts until they save a new one. */
  const myUnits = () => {
    const p = S.user?.prefs || {};
    if (p.units) return p.units;
    return !p.temp_unit || p.temp_unit === 'none' ? '' : E.isImperial(p.temp_unit) ? 'imperial' : 'metric';
  };
  /** Metric or Imperial for every temperature, length, depth and speed: the user's own choice, else the campaign's. */
  const unitSystem = () => myUnits() || campUnits();
  /** The temperature unit to show: °C for Metric, °F for Imperial, or 'none' when the campaign hides temperatures. */
  const tempUnit = () => (campHidesTemps() ? 'none' : unitSystem() === 'imperial' ? 'F' : 'C');
  const tempSym = unit => E.TEMP_UNITS[unit]?.sym.trim() || '°C';
  const shiftNames = () => E.shiftNames(cal());

  async function loadCampaign(cid, force) {
    if (!force && S.camp && S.camp.id === cid) return;
    const r = await api('campaign', { query: { cid } });
    S.camp = r.campaign; S.role = r.role; S.regions = r.regions; S.holidays = r.holidays; S.members = r.members; S.tags = r.tags || []; S.reminders = [];
    S.encReady = !!r.encyclopedia_ready; S.encyclopedia = r.encyclopedia || []; S.encIgnored = r.encyclopedia_ignored || []; S.encTags = r.encyclopedia_tags || []; S.encCatsReady = !!r.encyclopedia_categories_ready;
    S.libReady = !!r.library_ready; S.mapsReady = !!r.maps_ready;
    S.sessionsReady = !!r.sessions_ready; S.openSession = r.open_session || null;
    S.viewAs = !!r.viewing_as_player;
    E.prep(S.camp.calendar);
    hideChangeBanner();
    if (isGM()) await ensureWeather(today(), today()).catch(() => {});
  }

  /** Fetch stored day rows in [from, to] (chunked). Returns Map(abs_day -> row) plus shifts & events. */
  async function fetchRange(from, to) {
    const days = new Map(), shifts = [], events = [], notes = new Map();
    for (let a = from; a <= to; a += 1500) {
      const b = Math.min(to, a + 1499);
      const r = await api('days', { query: { cid: S.camp.id, from: a, to: b } });
      r.days.forEach(d => days.set(d.abs_day, d));
      shifts.push(...r.shifts);
      (r.notes || []).forEach(n => notes.set(n.abs_day, n));
      for (const e of r.events) if (!events.some(x => x.id === e.id)) events.push(e);
    }
    return { days, shifts, events, notes };
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
    if (activity && n > 0) await post('shifts_fill', { from_shift: from + 1, to_shift: to, activity, transit: E.isOnTheMove(activity) }, S.camp.id);
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
  /** A single-line activity box with its own drop-down of the baseline shift actions, filtered as you type.
   * Not a <datalist>: Android Chrome shows those as a sideways strip above the keyboard, not a list.
   * Picking an action puts its name in the box, which stays free text. */
  function actionCombo(input) {
    const list = el('ul', { class: 'combo-list', role: 'listbox', id: `combo-${++actionCombo.n}`, hidden: true });
    const toggle = el('button', { type: 'button', class: 'combo-btn', tabindex: -1, 'aria-label': 'Show actions' }, '▾');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.autocomplete = 'off';
    let wrap = null, opts = [], at = -1;
    // pointerdown, not click: iPad Safari sends no click for a tap on plain page background
    const outside = e => { if (!wrap.contains(e.target)) close(); };
    const close = () => {
      list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', outside);
    };
    const mark = i => {
      opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === i)));
      at = i;
      if (opts[i]) { input.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    };
    const pick = a => { input.value = a.name; close(); };
    /** Fill the list with the actions matching q (all of them when q is empty), under their group headings. */
    function open(q = '') {
      const needle = q.trim().toLowerCase();
      const hits = E.SHIFT_ACTIONS.filter(a => !needle || a.name.toLowerCase().includes(needle));
      if (!hits.length) return close();
      opts = [];
      list.replaceChildren(...Object.entries(E.SHIFT_ACTION_GROUPS).flatMap(([g, label]) => {
        const mine = hits.filter(a => a.group === g);
        return mine.length ? [el('li', { class: 'combo-group', role: 'presentation' }, label), ...mine.map(a => {
          const o = el('li', { class: 'combo-opt', role: 'option', id: `${list.id}-${opts.length}`, 'aria-selected': 'false' },
            el('span', { class: 'combo-name' }, `${a.icon} ${a.name}`), el('small', {}, a.desc));
          // keep focus (and the on-screen keyboard state) in the box while choosing
          o.addEventListener('mousedown', e => e.preventDefault());
          o.addEventListener('click', () => pick(a));
          o._action = a;
          opts.push(o);
          return o;
        })] : [];
      }));
      at = -1;
      hideTip(); // its tooltip would sit on top of the list
      if (list.hidden) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', outside); }
      list.scrollTop = 0;
    }
    toggle.addEventListener('mousedown', e => e.preventDefault());
    toggle.addEventListener('click', () => { if (list.hidden) open(); else close(); });
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('click', () => { if (list.hidden && !input.value.trim()) open(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(); if (e.key === 'ArrowUp') mark(opts.length - 1); else mark(0); return; }
        mark(e.key === 'ArrowDown' ? Math.min(at + 1, opts.length - 1) : Math.max(at - 1, 0));
      } else if (e.key === 'Enter' && !list.hidden && opts[at]) {
        e.preventDefault(); pick(opts[at]._action);
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault(); close();
      } else if (e.key === 'Tab') close();
    });
    return (wrap = el('span', { class: 'combo grow' }, input, toggle, list));
  }
  actionCombo.n = 0;

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
  /** The Categories an Encyclopedia entry can be in (one each, or none): key, name, icon. */
  const ENC_CATEGORIES = [['location', 'Location', '📍'], ['person', 'Person', '👤'], ['item', 'Item', '🗝️'], ['group', 'Group', '👥'], ['vehicle', 'Vehicle', '⛵']];
  const encCat = k => ENC_CATEGORIES.find(c => c[0] === k) || null;
  /** The Category named n (any case), for the detector's guesses: "Location" → 'location'. */
  const encCatNamed = n => ENC_CATEGORIES.find(c => c[1].toLowerCase() === String(n || '').toLowerCase())?.[0] || null;
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
  function moonBadges(d, region = currentRegion()) {
    return E.moons(cal(), d, region).map(m => el('span', { class: 'moon', 'data-tip': `${m.name}: ${m.label} (${Math.round(m.illum * 100)}% lit)${m.redMoon && region ? `, as seen from ${region.name}` : ''}. Moonlight brightens the dusk and overnight shifts under sun & moons lighting.` },
      moonGlyph(m)));
  }
  /** A moon's phase as an icon: the emoji, or for the Red Moon a drawing of it, red where lit and black where not. */
  function moonGlyph(m) {
    if (!m.redMoon) return el('span', { style: m.color && cal().moons.length > 1 ? { filter: `drop-shadow(0 0 2px ${m.color})` } : {} }, m.icon);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'moon-svg'); svg.setAttribute('aria-hidden', 'true');
    const disc = document.createElementNS(ns, 'circle');
    disc.setAttribute('cx', 12); disc.setAttribute('cy', 12); disc.setAttribute('r', 10); disc.setAttribute('fill', '#111');
    disc.setAttribute('stroke', m.color || '#c8513a'); disc.setAttribute('stroke-width', 0.75);
    svg.append(disc);
    if (m.illum > 0.001) {
      // the lit side: a half disc, then back along the terminator, an ellipse as wide as cos(phase) of the radius
      const ph = m.phase, waxing = ph <= 0.5, rx = Math.abs(Math.cos(2 * Math.PI * ph)) * 10, gibbous = ph > 0.25 && ph < 0.75;
      const lit = document.createElementNS(ns, 'path');
      lit.setAttribute('d', `M12 2 A10 10 0 0 ${waxing ? 1 : 0} 12 22 A${rx.toFixed(3)} 10 0 0 ${waxing === gibbous ? 1 : 0} 12 2 Z`);
      lit.setAttribute('fill', m.color || '#c8513a');
      svg.append(lit);
    }
    return el('span', { class: 'moon-glyph' }, svg);
  }
  const FORECAST_TIP = 'The day\'s forecast: the worst weather it brings, its daytime high and its strongest wind. Each shift varies within it, cooler at night and often easing off away from the worst of it.';
  const SO_FAR_TIP = 'The weather this shift. The rest of today\'s weather shows up as each shift comes round.';
  /** Tooltip lines giving how much falls and the wind's actual speed, e.g. 'Heavy rain: 4–15 mm an hour' and
   * 'Windy: 25–38 mph (Beaufort 6–7)'. Empty for dry, calm weather. */
  function wxTip(w) {
    if (!w) return '';
    const rate = E.precipRate(w.type, unitSystem());
    return (rate ? `\n${E.WEATHER[w.type].label}: ${rate}` : '')
      + (w.wind ? `\n${E.WIND[w.wind]}: ${E.windSpeed(w.wind, unitSystem())} (Beaufort ${E.WIND_SPEEDS[w.wind].beaufort})` : '');
  }
  function weatherText(w, what = FORECAST_TIP) {
    if (!w) return el('span', { class: 'muted' }, 'No weather recorded');
    if (w.partial && what === FORECAST_TIP) what = SO_FAR_TIP;
    const def = E.WEATHER[w.type] || {};
    const mods = [def.day ? `daytime visibility ${def.day > 0 ? '+' : ''}${def.day}` : null, def.night ? `overnight ${def.night > 0 ? '+' : ''}${def.night}` : null].filter(Boolean);
    return el('span', { class: 'wx', 'data-tip': `${what}\n${def.label}${mods.length ? `: ${mods.join(', ')}` : ': no effect on visibility'}${wxTip(w)}` }, `${def.icon || ''} ${E.weatherLabel(w, tempUnit())}`);
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
  /** The ground in each shift (or hour) of day d in region, worked out from the weather of the days before; w is day d's
   * weather as this page has it. [] where nothing can be known: caves and ships, or a day a player may not see yet. */
  async function groundFor(d, region, w) {
    const hide = !isGM() && !settings().players_see_future_weather;
    if (hide && d > today()) return [];
    const { days } = await fetchRange(d - E.GROUND_DAYS, d - 1);
    const history = new Map();
    // stored days count only where the party was in this region; the rest are rolled from its climate
    for (const [ad, row] of days) if (row.weather && (regionById(row.region_id) || currentRegion())?.id === region?.id) history.set(ad, row.weather);
    history.set(d, w || null);
    const quarters = E.groundConditions(cal(), S.camp.seed, region, d, history);
    return quarters.length ? E.slotsFromQuarters(cal(), quarters) : [];
  }
  /** The ground underfoot in a word or two, with what it means for travel and how it got that way in its tooltip. */
  function groundText(g, d) {
    const l = E.groundLabel(g, unitSystem());
    if (!l) return null;
    const ago = n => n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
    const lines = [`Ground underfoot: ${l.label}. ${l.going}`,
      g.lastSnow !== null ? `Last snowfall: ${ago(d - g.lastSnow)}.` : null,
      `Rain or snowmelt on ${g.wetDays} of the last 7 days.`,
      g.frozen ? 'The ground is frozen.' : null,
      `Worked out from the last ${E.GROUND_DAYS} days of weather here: rain and snow, how warm it was, sun and wind. Days with no weather recorded are rolled from the region's climate. A rough guide, not a rule.`];
    return el('span', { class: 'ground', 'data-tip': lines.filter(Boolean).join('\n') }, `${l.icon} ${l.label}`);
  }
  /** year / month / day picker for this campaign's calendar; getAbs() returns the absolute day */
  function datePicker(abs) {
    const c = cal(), p = E.fromAbs(c, abs ?? today());
    // with eras the year is typed as its number in an era (27 RA), and the era is picked next to it
    const at = E.eraOf(c, p.year), eras = E.eraList(c);
    const y = el('input', { type: 'number', value: eras.length ? at.year : p.year, class: 'w-year', 'aria-label': 'Year' });
    const era = eras.length ? select([...eras.map(e => [e.index, e.abbr || e.name]), ['', 'Calendar year']], at.era ? at.era.index : '',
      { 'aria-label': 'Era', 'data-tip': 'The era the year is counted in. Calendar year: the plain year number, ignoring eras' }) : null;
    const m = select(c.months.map((mo, i) => [i, mo.name]), p.month, { 'aria-label': 'Month' });
    const d = el('input', { type: 'number', min: 1, value: p.day, class: 'w-day', 'aria-label': 'Day' });
    const wrap = el('span', { class: 'datepick' }, ...clean([d, m, y, era]));
    wrap.getAbs = () => {
      const yy = era && era.value !== '' ? E.eraYear(c.eras[Number(era.value)], Number(y.value)) : Number(y.value), mm = Number(m.value);
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
    let wrap = null;
    // pointerdown, not click: iPad Safari sends no click for a tap on plain page background
    const outside = e => { if (!wrap.contains(e.target)) close(); };
    const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside); };
    list.append(...SCHEMES.map(s => el('li', { role: 'none' },
      el('button', { type: 'button', role: 'menuitemradio', class: 'scheme-opt', 'aria-checked': String(s.id === cur.id),
        onclick: () => { close(); applyScheme(s.id, true); renderNav(); } },
        el('span', { class: 'scheme-dot', style: { background: s.dot } }),
        el('span', {}, s.name, el('small', {}, s.blurb))))));
    button.addEventListener('click', e => {
      e.stopPropagation();
      if (!list.hidden) return close();
      list.hidden = false; button.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside);
    });
    list.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });
    return (wrap = el('span', { class: 'scheme-pick' }, button, list));
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

  const UNIT_OPTIONS = [['', 'None (each campaign\'s own)'], ['imperial', 'Imperial (°F, miles, inches, mph)'], ['metric', 'Metric (°C, km, cm, km/h)']];
  async function viewAccount() {
    const { campaigns } = await api('campaigns');
    const prefs = el('form', { class: 'card narrow' }, el('h2', {}, 'Preferences'),
      el('p', { class: 'muted' }, `Signed in as ${S.user.email}. Your name comes from your Google or GitHub account.`),
      field('Units', select(UNIT_OPTIONS, myUnits(), { name: 'units' }),
        'Every temperature, distance, depth and speed the app works out. Only changes what you see. With None you see each campaign in the units its GM picked.'),
      el('button', { class: 'primary' }, 'Save'));
    prefs.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(prefs).units;
      try { S.user.prefs = (await post('prefs_save', { units: v || null })).prefs; toast('Preferences saved'); } catch (err) { toast(err.message, true); }
    });
    // The campaigns they belong to (not every campaign an admin can open), each with their character there. A box saves when you leave it.
    const mine = campaigns.filter(c => c.member);
    const list = el('div', { class: 'card narrow' }, el('h2', {}, 'Your campaigns'),
      mine.length ? el('ul', { class: 'camplist account-camps' }, mine.map(c => {
        const name = el('input', { value: c.character_name || '', maxlength: 150, placeholder: 'Your own name', 'aria-label': `Your character in ${c.name}` });
        name.addEventListener('change', async () => {
          try {
            await post('member_character', { character_name: name.value }, c.id);
            c.character_name = name.value.trim();
            const m = S.camp?.id === c.id && S.members.find(x => Number(x.id) === S.user.id);
            if (m) m.character_name = c.character_name;
            toast('Saved');
          } catch (err) { toast(err.message, true); }
        });
        return el('li', {}, el('a', { href: `#/c/${c.id}` }, el('strong', {}, c.name), roleBadge(c.role)),
          field('Character', name, null, 'Events and notes you add in this campaign are signed with this name instead of your own'));
      })) : el('p', { class: 'muted' }, 'You aren\'t in any campaigns yet.'));
    mount(prefs, list);
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
          !self ? act(legacy ? 'Delete' : 'Remove', async () => {
            if (!await confirmDialog(legacy ? `Delete ${u.display_name || u.email}? Their campaign memberships and notes' authorship go with it.`
              : `Remove ${u.display_name || u.email} from Campaign Chronicle? They leave every campaign here, and asking again puts them back in the queue. Their Sinless account isn't touched.`,
              { ok: legacy ? 'Delete' : 'Remove', danger: true })) return false;
            await post('user_delete', { id: u.id });
          }, 'danger', legacy ? 'Delete this account. Their campaign memberships go with it' : 'Take them off Campaign Chronicle and out of its campaigns. Their Sinless account stays') : null)));
    };
    const pending = users.filter(u => u.status === 'pending').length;
    mount(el('div', { class: 'card' }, el('h2', {}, 'Users'),
      pending ? el('p', {}, `${pending} ${pending === 1 ? 'person is' : 'people are'} waiting for approval.`) : null,
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl users' }, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Status'), el('th', {})), users.map(row)))),
      el('p', { class: 'muted pad' }, 'Everyone who has signed in to Campaign Chronicle is listed here, after their first sign-in. Approving someone here lets them into Chronicle only: Sinless keeps its own approvals, even for the same Google or GitHub account. Approve them, then a GM adds them from the Members tab of a campaign. Admins are set in the server config (admin_identities).'));
  }

  // ------------------------------------------------------------ campaign list / create
  async function viewCampaigns() {
    const { campaigns } = await api('campaigns');
    S.camp = null;
    const list = el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h1', {}, 'Your campaigns'), btn('+ New campaign', () => (location.hash = '#/new'), 'primary')),
      campaigns.length ? el('ul', { class: 'camplist' }, campaigns.map(c =>
        el('li', { class: 'camp-row' },
          el('div', { class: 'camp-main' }, el('a', { href: `#/c/${c.id}` }, el('strong', {}, c.name), roleBadge(c.role)),
            c.description ? el('p', { class: 'muted' }, c.description) : null),
          // Only a GM can copy (a copy holds the secrets) or delete one.
          c.role === 'gm' ? el('div', { class: 'camp-actions' },
            btn('Copy', () => copyCampaign(c), 'small', 'Make a new campaign of your own from this one: everything in it, or just its calendar and setup'),
            btn('Delete', () => deleteCampaign(c), 'small danger', 'Permanently delete the campaign and everything in it. Asks you to type DELETE first')) : null)))
        : el('p', { class: 'muted' }, 'No campaigns yet. Create one to get started.'));
    mount(list);
  }
  async function deleteCampaign(c) {
    const typed = await promptDialog(`Type DELETE to permanently delete "${c.name}" and everything in it.`, { title: 'Delete campaign', ok: 'Delete', danger: true });
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'DELETE') { toast('Not deleted: type DELETE to confirm', true); return; }
    try { await post('campaign_delete', { confirm: 'DELETE' }, c.id); toast(`Deleted ${c.name}`); viewCampaigns(); } catch (err) { toast(err.message, true); }
  }
  /** Copy a campaign into a new one the copier GMs: a name, and everything in it or only its setup. */
  function copyCampaign(c) {
    const name = el('input', { name: 'name', value: `${c.name} (copy)`.slice(0, 150), maxlength: 150, required: true });
    const what = select([['all', 'Everything in it'], ['setup', 'Only its setup']], 'all', { name: 'what' });
    const status = el('p', { class: 'muted small' });
    const ok = el('button', { class: 'primary', type: 'submit' }, 'Copy');
    const cancel = el('button', { type: 'button', onclick: () => d.close() }, 'Cancel');
    const form = el('form', {}, el('h3', {}, `Copy ${c.name}`),
      field('Name of the copy', name),
      field('What to copy', what, 'Everything: days, events, notes, the Encyclopedia, Library, sessions, holdings, reminders and files. '
        + 'Only its setup: the calendar and date, settings, regions, holidays and the tag and relationship lists, to start a new campaign in the same world.'),
      el('p', { class: 'muted small' }, 'You are the copy\'s GM. Nobody else is added: invite players from its Members tab.'),
      status, el('div', { class: 'kit-dialog-actions' }, ok, cancel));
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': `Copy ${c.name}` }, form);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      ok.disabled = cancel.disabled = true;
      status.textContent = 'Copying…';
      try {
        await post('campaign_copy', { name: name.value, setup: what.value === 'setup' }, c.id);
        d.close();
        toast(`Copied to ${name.value.trim()}`);
        viewCampaigns();
      } catch (err) {
        status.textContent = '';
        ok.disabled = cancel.disabled = false;
        toast(err.message, true);
      }
    });
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    name.select();
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

  /** "leap years: 2028, 2032, 2036, 2040…, but not 2100": the next few leap years from a year on, for checking a leap rule at a glance. */
  function leapSummary(c, from) {
    const t = E.prep(JSON.parse(JSON.stringify(c)));
    const out = [];
    for (let y = from; out.length < 4 && y < from + 100000; y++) if (E.isLeap(t, y)) out.push(y);
    if (!out.length) return 'no leap years';
    // the next year the "except" rule takes away (like 2100), which the first few rarely show
    const L = t.leap, skipped = L.skip ? Math.ceil((from + 1) / L.skip) * L.skip : 0;
    const next = skipped && !E.isLeap(t, skipped) && E.mod(skipped, L.every) === 0 ? `, but not ${skipped}` : '';
    return `leap years: ${out.join(', ')}…${next}`;
  }

  function viewCreate() {
    let preset = 'gregorian';
    // the built-in presets, plus 'file' once a calendar is imported from a file
    const presets = { ...E.PRESETS };
    const presetSel = select(E.presetOptions(), preset, { name: 'preset' });
    const importBtn = btn('Import calendar from file…', async () => {
      try {
        const r = await CalendarFile.pick();
        if (!r) return;
        const base = E.PRESETS.custom;
        const hemisphere = r.calendar.hemisphere === 'south' ? 'south' : 'north';
        presets.file = { label: `From file: ${r.calendar.name || 'calendar'}`, calendar: r.calendar, holidays: r.holidays, settings: base.settings,
          regions: base.regions.map(x => ({ ...x, settings: { ...x.settings, hemisphere } })),
          start: r.today || { year: Number(r.calendar.epochYear) || 0, month: 0, day: 1 } };
        presetSel.querySelector('option[value=file]')?.remove();
        presetSel.append(el('option', { value: 'file' }, presets.file.label));
        presetSel.value = 'file';
        presetSel.dispatchEvent(new Event('change'));
        toast(`Imported ${r.calendar.name || 'the calendar'}${r.holidays.length ? ` and ${r.holidays.length} holiday${r.holidays.length === 1 ? '' : 's'}` : ''}`);
      } catch (err) { toast(err.message, true); }
    }, 'small', 'Start from a calendar exported from another campaign (Settings → Tools → Export calendar), with its holidays and the date it had reached');
    const startWrap = el('div');
    // the Custom preset's months, set on this form: how many there are and each one's length
    let customMonths = E.PRESETS.custom.calendar.months.map(m => ({ ...m }));
    // and its week: how many days, and each one's name
    let customWeekdays = [...E.PRESETS.custom.calendar.weekdays];
    // and its leap rule: every N years, except every N, unless every N (null for no leap years)
    let customLeap = null;
    /** The preset's calendar, with the custom months, week, leap rule (and seasons spread over the months) when Custom is picked. */
    const presetCal = () => {
      const c = presets[preset].calendar;
      return preset === 'custom' ? { ...c, months: customMonths.map(m => ({ ...m })), weekdays: [...customWeekdays], leap: customLeap && { ...customLeap }, seasons: spreadSeasons(c.seasons, c.months, customMonths) } : c;
    };
    const tmpCal = () => { const c = JSON.parse(JSON.stringify(presetCal())); E.prep(c); return c; };
    let picker;
    const drawStart = () => {
      const p = presets[preset], c = tmpCal();
      const saved = S.camp; S.camp = { calendar: c, current_shift: 0 }; // datePicker reads cal()
      picker = datePicker(E.toAbs(c, p.start.year, p.start.month, p.start.day));
      S.camp = saved;
      startWrap.replaceChildren(field('Starting date', picker, 'You can change "now" at any time later.'));
    };
    const seasonWrap = el('div');
    let seasons;
    const drawSeasons = () => {
      seasons = seasonEditor(tmpCal());
      const hemi = presets[preset].calendar.hemisphere;
      seasonWrap.replaceChildren(el('h3', {}, 'Seasons'),
        ...(hemi ? [el('p', { class: 'muted' }, `Dates are for the ${hemi === 'south' ? 'southern' : 'northern'} hemisphere.`)] : []), seasons);
    };
    const homeRegion = () => presets[preset].regions.find(r => r.current) || presets[preset].regions[0];
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
        el('input', { value: m.name, 'data-k': 'name', 'aria-label': `Month ${i + 1} name`, class: 'grow', style: { flexBasis: '110px', minWidth: 0 }, placeholder: `Month ${i + 1}` }),
        el('input', { type: 'number', min: 1, max: 1000, value: m.days, class: 'w-day', 'data-k': 'days', 'aria-label': `Month ${i + 1} days` }),
        el('small', { class: 'muted' }, '+'),
        el('input', { type: 'number', min: 0, max: 1000, value: m.leapDays || 0, class: 'w-day', 'data-k': 'leap', 'aria-label': `Month ${i + 1} leap days`, 'data-tip': 'Extra days this month gets in a leap year, added at its end (like 29 February)' }),
        el('small', { class: 'muted' }, 'leap')));
      const num = (r, k, lo) => Math.max(lo, Math.min(1000, Math.round(Number(r.querySelector(`[data-k=${k}]`).value) || lo)));
      const read = () => [...rows.children].map((r, i) => {
        const m = { name: r.querySelector('[data-k=name]').value.trim() || `Month ${i + 1}`, days: num(r, 'days', 1) };
        if (num(r, 'leap', 0)) m.leapDays = num(r, 'leap', 0);
        return m;
      });
      const leapIn = (name, value, label) => el('input', { type: 'number', min: 0, max: 10000, value, class: 'w-day', name, 'aria-label': label });
      const every = leapIn('leap_every', customLeap ? customLeap.every : 0, 'Leap year every N years'), skip = leapIn('leap_skip', customLeap ? customLeap.skip : 0, 'Except every N years'), unskip = leapIn('leap_unskip', customLeap ? customLeap.unskip : 0, 'Unless every N years');
      const small = t => el('small', { class: 'muted' }, t);
      // three boxes in one sentence, so a div rather than field()'s label, which would only name the first
      const leapRule = el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Leap years', tip('A leap year adds each month\'s leap days. Years divisible by the "except" number are not leap years after all, unless they are also divisible by the "unless" number. Leave those two at 0 for a plain every-N-years rule')),
        el('div', { class: 'row' }, small('every'), every, small('years, except every'), skip, small('unless every'), unskip),
        small('0 for no leap years. Gregorian: every 4, except every 100, unless every 400'));
      const total = el('small', { class: 'muted' });
      const sync = () => {
        customMonths = read();
        const n = v => Math.max(0, Math.round(Number(v.value) || 0));
        customLeap = n(every) > 0 ? { every: n(every), skip: n(skip), unskip: n(unskip) } : null;
        const base = customMonths.reduce((t, m) => t + m.days, 0), extra = customMonths.reduce((t, m) => t + (m.leapDays || 0), 0);
        total.textContent = `${customMonths.length} month${customMonths.length === 1 ? '' : 's'}, ${base} days a year`
          + (customLeap && extra ? `, ${base + extra} in a leap year (${leapSummary({ months: customMonths, leap: customLeap, epochYear: 1 }, 1)}).` : '.')
          + (extra && !customLeap ? ' Set how often leap years come below for the leap days to count.' : '')
          + (customLeap && !extra ? ' Give a month some leap days for leap years to add any.' : '');
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
      leapRule.addEventListener('change', sync);
      sync();
      monthsWrap.replaceChildren(el('h3', {}, 'Months'),
        field('Number of months', count, null, 'How many months make up a year. Each one can have its own number of days below.'),
        el('small', { class: 'muted' }, 'Name · days in the month + extra days in a leap year'), rows, leapRule, total, drawWeek());
    };
    /** The Custom preset's week: any number of days, each with its own name, or none for a calendar without weeks. */
    const drawWeek = () => {
      const wrap = el('div'), rows = el('div', { class: 'weekrows grid3' });
      const count = el('input', { type: 'number', min: 0, max: 100, value: customWeekdays.length, class: 'w-day', name: 'week_length' });
      const addRow = (name, i) => rows.append(el('input', { value: name, 'data-k': 'weekday', 'aria-label': `Weekday ${i + 1} name`, placeholder: `Day ${i + 1}` }));
      const sync = () => { customWeekdays = [...rows.children].map((r, i) => r.value.trim() || `Day ${i + 1}`); drawStart(); };
      customWeekdays.forEach(addRow);
      count.addEventListener('change', () => {
        const n = Math.max(0, Math.min(100, Math.round(Number(count.value) || 0)));
        count.value = n;
        while (rows.children.length > n) rows.lastChild.remove();
        while (rows.children.length < n) addRow(`Day ${rows.children.length + 1}`, rows.children.length);
        sync();
      });
      rows.addEventListener('change', sync);
      wrap.append(el('h3', {}, 'Week'),
        field('Days in a week', count, '0 for a calendar without weeks.', 'How many days make up a week, each with its own name below. The month grid has one column per day of the week, and "Nth weekday" holidays count in it.'),
        rows);
      return wrap;
    };
    presetSel.addEventListener('change', () => { preset = presetSel.value; drawMonths(); drawStart(); drawSeasons(); drawClimate(); });
    drawMonths(); drawStart(); drawSeasons(); drawClimate();
    // How the days are split: four shifts, two (Day and Night) or hours. The starting shift list follows it.
    const modeSel = select(Object.entries(E.TIME_MODES), 'shifts4', { name: 'time_mode' });
    const shiftSel = select([], 0, { name: 'shift' });
    const startShift = field('Starting shift', shiftSel, null, shiftTip({}));
    const drawShifts = () => {
      const c = { ...presets[preset].calendar, timeMode: modeSel.value }, names = E.shiftNames(c);
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
        'Sets the months, weekdays, moons, seasons, starting regions and holidays. Pick the closest one and edit it later, or import a calendar exported from another campaign.'),
      el('div', { class: 'row' }, importBtn),
      monthsWrap, startWrap,
      field('Time tracking', modeSel, 'You can change this later on the Settings tab.',
        'How each day is split. Four shifts: Dawn, Midday, Dusk and Overnight, about six hours each. Two shifts: Day and Night. Hours: every hour of the day from midnight, like a normal calendar. Weather, light and visibility follow the time of day in every mode, and the travel planner counts in the same steps.'),
      startShift, climateWrap, seasonWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Create'), btn('Cancel', () => (location.hash = '#/'))));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const p = presets[preset], v = formData(f);
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
  // The tabs in the Legend's four groups, each under its heading (a thin divider when the tabs run across the top)
  const TAB_GROUPS = [
    ['Play', 'The campaign\'s days: where the clock is, and what happened when', [['today', 'Current Day'], ['calendar', 'Calendar'], ['events', 'Events'], ['sessions', 'Sessions']]],
    ['Party', 'What the party does and owns: journeys, rests and holdings', [['travel', 'Travel'], ['downtime', 'Downtime'], ['holdings', 'Party Holdings']]],
    ['World', 'What the party has learned, and tools for making more', [['encyclopedia', 'Encyclopedia'], ['library', 'Library'], ['generators', 'Generators']]],
    ['Setup', 'The campaign\'s places, holidays, people and options', [['regions', 'Regions'], ['holidays', 'Holidays'], ['members', 'Members'], ['settings', 'Settings']]],
  ];
  const TAB_TIPS = {
    today: 'The campaign\'s current day up close: every shift, its weather and visibility, and the day\'s events',
    calendar: 'Month and week views of days, weather, visibility, moons and events',
    events: 'Every event in one list: search it and filter it by tag',
    sessions: 'Each game night\'s quick notes and the summary written from them',
    travel: 'Work out how long a journey takes, then pass that much time',
    downtime: 'Rests and downtime: what the party does, and who does it',
    holdings: 'The party\'s gear and loot, and its vehicles, animals, buildings and assets',
    encyclopedia: 'The people, places, items and groups met in play, linked wherever their names are written',
    library: 'The campaign\'s books, journals and notes, written out in full. Anyone can add or change one',
    generators: 'Random names, taverns, companies and towns, to use on the spot or add to the Encyclopedia',
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
            : 'You are a player here: GM notes, secret events and (unless allowed) future weather are hidden' }, isGM() ? 'GM view' : 'Player view'),
            isGM() ? btn('👁 View as player', () => setViewingAs(true), 'small view-as',
              'See this campaign exactly as your players do: no secrets, GM notes or GM-only paragraphs. Nothing can be changed until you leave') : null),
          S.viewAs ? el('div', { class: 'view-as-banner', role: 'status' }, el('span', {}, '👁 Viewing as a player: this is what your players see. Changes are off.'),
            btn('Leave player view', () => setViewingAs(false), 'small primary')) : null,
          el('div', { class: 'now-time' },
            el('a', { href: `#/c/${S.camp.id}/today`, class: 'now-date', 'data-tip': `The current ${word()} and date in the campaign. Click to open today` }, `${shiftNames()[sh]} · ${E.fmtDate(c, d)}`),
            el('span', { class: 'now-meta' }, region ? el('span', { 'data-tip': `Where the party is today: ${regionSummary(region)}` }, `📍 ${region.name}`) : null, ' ',
              weatherText(sw, w?.partial ? `Weather this ${shiftNames()[sh]}` : `Weather this ${shiftNames()[sh]}. Day's forecast: ${E.weatherLabel(w, tempUnit())}`), ' ', visPill(v), ' ', moonBadges(d, region),
              hol.map(holidayChip)))),
        isGM() ? passTime() : null]));
    };
    // Pass time is a row on Current Day and the calendar, where time moves; elsewhere a button opens the same row, so the
    // bar stays one line and the page below gets the room
    const passTime = () => {
      const w = passTimeWidget();
      if (active === 'today' || active === 'calendar') return w;
      w.hidden = true;
      const open = btn('⏩ Pass time', () => { w.hidden = !w.hidden; open.setAttribute('aria-expanded', String(!w.hidden)); if (!w.hidden) w.querySelector('input')?.focus(); },
        'small primary now-passbtn', 'Open the Pass time row to move the campaign clock');
      open.setAttribute('aria-expanded', 'false');
      return [open, w];
    };
    draw();
    const folds = legendFolds();
    const tabs = el('nav', { class: 'tabs' + (legendHidden() ? ' tucked' : '') }, legendTuck(), searchBox(active), TAB_GROUPS.map(([g, gTip, ts]) => {
      const folded = !!folds[g];
      const toggle = el('button', { type: 'button', 'aria-expanded': String(!folded), 'data-tip': `${gTip}. Click to fold or unfold. It stays as you leave it in this browser` },
        el('span', { class: 'tab-group-caret', 'aria-hidden': 'true' }), g);
      const links = ts.filter(([k]) => k !== 'settings' || isGM()).map(([k, l]) =>
        el('a', { href: `#/c/${S.camp.id}/${k}`, class: (k === active ? 'on' : '') + (folded ? ' folded' : ''), 'data-group': g, 'data-tip': TAB_TIPS[k] }, l));
      const heading = el('span', { class: 'tab-group' + (folded ? ' folded' : ''), 'data-group': g }, toggle);
      toggle.addEventListener('click', () => {
        const f = !heading.classList.contains('folded');
        heading.classList.toggle('folded', f);
        toggle.setAttribute('aria-expanded', String(!f));
        links.forEach(a => a.classList.toggle('folded', f));
        rememberLegendFold(g, f);
      });
      return [heading, links];
    }).flat());
    return [head, tabs];
  }
  // Which of the Legend's groups are folded, remembered in this browser for each account. Setup starts folded.
  const LEGEND_KEY = 'chronicle:legend';
  function legendFolds() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`${LEGEND_KEY}:${S.user?.id}`)); } catch { /* private mode: defaults */ }
    return { Setup: true, ...saved };
  }
  function rememberLegendFold(g, folded) {
    const all = { ...legendFolds(), [g]: folded };
    try { localStorage.setItem(`${LEGEND_KEY}:${S.user?.id}`, JSON.stringify(all)); } catch { /* private mode: just this page */ }
  }
  // The whole Legend tucks away to a thin strip on the left, also remembered in this browser for each account
  function legendHidden() {
    try { return localStorage.getItem(`${LEGEND_KEY}:tucked:${S.user?.id}`) === '1'; } catch { return false; }
  }
  /** The « / » button at the top of the Legend that tucks it away to the left and brings it back. Across the top it is hidden. */
  function legendTuck() {
    const btn = el('button', { type: 'button', class: 'legend-tuck' });
    const show = tucked => {
      btn.textContent = tucked ? '»' : '«';
      btn.setAttribute('aria-expanded', String(!tucked));
      btn.setAttribute('aria-label', tucked ? 'Show the tabs' : 'Hide the tabs');
      btn.dataset.tip = tucked ? 'Show the tabs down the left' : 'Tuck the tabs away to the left, to give the page more room. It stays as you leave it in this browser';
    };
    show(legendHidden());
    btn.addEventListener('click', () => {
      const tucked = btn.closest('nav').classList.toggle('tucked');
      show(tucked);
      try { tucked ? localStorage.setItem(`${LEGEND_KEY}:tucked:${S.user?.id}`, '1') : localStorage.removeItem(`${LEGEND_KEY}:tucked:${S.user?.id}`); } catch { /* private mode: just this page */ }
    });
    return btn;
  }

  /** The search box with the tabs: Enter opens the Search page. On a phone, where the tabs scroll sideways, it is a 🔍 tab instead. */
  function searchBox(active) {
    const input = el('input', { type: 'search', name: 'q', placeholder: 'Search', 'aria-label': 'Search the campaign', enterkeyhint: 'search',
      'data-tip': 'Search the whole campaign: the Encyclopedia, days and events, the Library, Party Holdings and downtime. Press / to jump here' });
    const form = el('form', { class: 'tab-search', role: 'search' }, input);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const q = input.value.trim();
      if (q) location.hash = searchHref(q);
    });
    return [form, el('a', { href: `#/c/${S.camp.id}/search`, class: 'tab-search-link' + (active === 'search' ? ' on' : ''), 'aria-label': 'Search', 'data-tip': 'Search the whole campaign' }, '🔍')];
  }
  const searchHref = q => `#/c/${S.camp.id}/search` + (q ? `?q=${encodeURIComponent(q)}` : '');
  // "/" anywhere but in a text box jumps to the search box, as on many sites
  document.addEventListener('keydown', ev => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const box = $('.tab-search input');
    if (!box || !box.offsetParent) return;
    ev.preventDefault();
    box.focus();
  });

  function passTimeWidget() {
    const def = { day: 'shift', week: 'day', month: 'week' }[settings().time_unit || 'day'] || 'shift';
    const amt = el('input', { type: 'number', value: 1, min: -9999, class: 'w-num', 'aria-label': 'Amount', 'data-tip': 'How much time to pass. A negative number winds the clock back' });
    const unit = select([['shift', `${word()}(s)`], ['day', 'day(s)'], ['week', 'week(s)'], ['month', 'month(s)'], ['year', 'year(s)']], def, { 'aria-label': 'Unit',
      'data-tip': `A day has ${hourMode() ? `${spd()} hours` : spd() === 2 ? 'two shifts, Day and Night' : 'four shifts'}. Months and years follow this campaign's calendar` });
    const act = el('input', { placeholder: `Activity for the passed ${word()}s (optional)`, 'aria-label': 'Activity',
      'data-tip': `Written into every ${word()} that passes, e.g. "Marching to Altdorf". Pick a common action from the ▾ list or type your own. ${Word()}s that already have an activity keep it` });
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
    return el('div', { class: 'passtime' }, el('span', { class: 'lbl' }, 'Pass time', tip('Advance the campaign clock. Players see the new "now" straight away.')), amt, unit, actionCombo(act), go, back);
  }

  // ------------------------------------------------------------ calendar tab
  /** "Reign of Aldric: year 27 of the era, calendar year 1526" for a year an era covers, else undefined. */
  function eraTip(c, y) {
    const { era, year } = E.eraOf(c, y);
    return era ? `${era.name}: year ${year} of the era, calendar year ${y}` : undefined;
  }
  const viewState = {};
  function vs() { return viewState[S.camp.id] || (viewState[S.camp.id] = { mode: settings().time_unit === 'day' ? 'week' : 'month', anchor: today() }); }

  async function viewCalendar() {
    const c = cal(), st = vs();
    const body = el('div', { class: 'card' });
    const anchor = st.anchor;
    let from, to, title, titleTip, seasonLine = null;
    if (st.mode === 'month') {
      const p = E.fromAbs(c, anchor);
      from = E.toAbs(c, p.year, p.month, 1);
      to = from + E.monthLength(c, p.year, p.month) - 1;
      title = `${c.months[p.month].name} ${E.yearLabel(c, p.year)}`;
      titleTip = eraTip(c, p.year);
      const segs = (c.seasons || []).length ? E.monthSeasons(c, p.year)[p.month].seasons : [];
      if (segs.length) seasonLine = el('div', { class: 'seasonline' }, segs.map((x, i) =>
        el('span', { class: 'seasonseg' }, seasonChip(x), i ? ` begins on day ${x.from}` : '')));
    } else if (st.mode === 'year') {
      const y = E.fromAbs(c, anchor).year;
      from = E.toAbs(c, y, 0, 1);
      to = from + E.yearLength(c, y) - 1;
      title = E.yearLabel(c, y);
      titleTip = eraTip(c, y);
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
      } else if (st.mode === 'year') st.anchor = E.toAbs(c, E.fromAbs(c, anchor).year + dir, 0, 1);
      else st.anchor = anchor + dir * E.weekLength(c);
      route();
    };
    const jump = datePicker(anchor);
    const toolbar = el('div', { class: 'calbar' },
      btn('◀', () => step(-1), 'small', `Previous ${st.mode}`), el('h2', { 'data-tip': titleTip }, title), btn('▶', () => step(1), 'small', `Next ${st.mode}`),
      btn('Today', () => { st.anchor = today(); route(); }, 'small', 'Jump back to the current day'),
      el('span', { class: 'seg' },
        btn('Month', () => { st.mode = 'month'; route(); }, st.mode === 'month' ? 'small on' : 'small', 'A month grid with weather, moon phases and events'),
        btn('Week', () => { st.mode = 'week'; route(); }, st.mode === 'week' ? 'small on' : 'small', hourMode() ? 'One row per day showing the hours with an activity, their visibility and activity' : 'One row per day showing every shift, its visibility and activity'),
        btn('Year', () => { st.mode = 'year'; route(); }, st.mode === 'year' ? 'small on' : 'small', 'Every month of the year on one page. Click a month\'s name to open it, or a day to open the day')),
      el('span', { class: 'jump' }, jump, btn('Go', () => { st.anchor = jump.getAbs(); route(); }, 'small', 'Show the date picked on the left')));

    mount(...campaignHeader('calendar'), toolbar, seasonLine, body);
    body.append(el('p', { class: 'muted' }, 'Loading…'));
    const data = await fetchRange(from, to);
    const missing = []; for (let d = from; d <= to; d++) if (!data.days.get(d)?.weather) missing.push(d);
    const content = st.mode === 'month' ? monthGrid(from, to, data) : st.mode === 'year' ? yearGrid(from, data) : weekList(from, to, data);
    body.replaceChildren(content);
    if (isGM() && missing.length && st.mode !== 'year') { // a whole year is too much to forecast with one click
      const g = btn(`Generate weather for ${missing.length} day(s) here`, null, 'small', 'Roll weather now for the days shown that have none yet, using each day\'s region');
      g.addEventListener('click', busy(g, async () => { await ensureWeather(from, to); route(); }));
      body.append(el('div', { class: 'row' }, g, el('small', { class: 'muted' }, 'Days are generated automatically as time passes; this forecasts ahead. Players only see future weather if you allow it in Settings.')));
    }
  }

  function dayEvents(data, d) { return data.events.filter(e => Number(e.abs_day) <= d && Number(e.end_day ?? e.abs_day) >= d); }
  function dayShifts(data, d) { const o = {}; data.shifts.filter(s => Number(s.abs_day) === d).forEach(s => (o[s.shift] = s)); return o; }

  /** Moons reaching new / first quarter / full / last quarter on day d (the day the phase is closest). */
  function keyMoonPhases(d) {
    const reg = currentRegion();
    const before = E.moons(cal(), d - 1, reg), now = E.moons(cal(), d, reg), after = E.moons(cal(), d + 1, reg);
    const dist = (ph, t) => Math.min(Math.abs(ph - t), 1 - Math.abs(ph - t));
    const out = [];
    now.forEach((m, i) => {
      for (const [t, label, icon] of [[0, 'New', '🌑'], [0.25, 'First quarter', '🌓'], [0.5, 'Full', '🌕'], [0.75, 'Last quarter', '🌗']]) {
        const x = dist(m.phase, t);
        // the Red Moon goes by its own phase names (Black, Empty Half, Full, Full Half) and is drawn red and black
        if (x < 0.06 && x <= dist(before[i].phase, t) && x < dist(after[i].phase, t)) out.push(m.redMoon ? { ...m, glyph: moonGlyph(m) } : { name: m.name, label, icon });
      }
    });
    return out;
  }

  /** Note previews for the calendar views: day notes, GM notes (GMs only) and shift notes, as the server allowed them. */
  const noteWho = n => n.kind === 'gm' ? 'GM notes 🔒' : n.kind === 'day' ? 'Day notes' : `${shiftNames()[n.shift] ?? 'Shift'}${n.author ? ` · ${n.author}` : ''}`;
  function notesTip(np) {
    const more = np.count - np.items.length;
    return np.items.map(n => `${noteWho(n)}: ${n.text}`).join('\n\n') + (more > 0 ? `\n\n+${more} more. Open the day to read them` : '');
  }
  const notePreview = (n, cls = 'dc-note') => el('div', { class: cls + (n.kind === 'gm' ? ' secret' : '') },
    el('span', { class: 'np-icon' }, n.kind === 'gm' ? '🔒 ' : '📝 '), el('span', { class: 'np-text' }, n.text));

  const dayReminders = d => S.reminders.filter(x => Math.floor(x.due_shift / spd()) === d);
  const reminderTip = rs => rs.map(x => `🔔 ${shiftNames()[E.mod(x.due_shift, spd())]}: ${x.title}`).join('\n');
  const evLine = e => el('div', { class: 'evline' + (Number(e.is_secret) ? ' secret' : ''), 'data-tip': Number(e.is_secret) ? 'Secret event: only GMs can see it' : null },
    Number(e.is_secret) ? '🔒 ' : el('span', { class: 'evdot', style: e.tags?.length ? { color: e.tags[0].color } : null }, '● '), e.title);
  function dayCell(d, data, compact) {
    const c = cal(), p = E.fromAbs(c, d), row = data.days.get(d);
    const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d), rems = dayReminders(d), np = data.notes.get(d);
    const w = row?.weather, def = w ? E.WEATHER[w.type] : null;
    const cls = ['daycell'];
    if (d === today()) cls.push('today');
    if (d < today()) cls.push('past');
    if (p.intercalary) cls.push('festival');
    if (evs.length || hol.length) cls.push('has-ev');
    return el('a', { class: cls.join(' '), href: `#/c/${S.camp.id}/day/${d}` },
      el('div', { class: 'dc-top' }, el('span', { class: 'dnum' }, p.intercalary && E.monthLength(c, p.year, p.month) === 1 ? c.months[p.month].name : p.day),
        el('span', { class: 'dc-icons' }, def ? el('span', { 'data-tip': E.weatherLabel(w, tempUnit()) + wxTip(w) }, def.icon) : null,
          compact ? null : keyMoonPhases(d).map(m => el('span', { 'data-tip': `${m.name}: ${m.label} moon` }, m.glyph || m.icon)),
          rems.length ? el('span', { class: 'dc-bell', 'data-tip': reminderTip(rems) }, '🔔') : null)),
      hol.map(x => el('div', { class: 'chip', style: { background: x.color }, 'data-tip': x.description || `Holiday: ${x.name}` }, x.name)),
      evs.slice(0, 3).map(evLine),
      evs.length > 3 ? el('div', { class: 'muted small', 'data-tip': evs.slice(3).map(e => e.title).join('\n') }, `+${evs.length - 3} more`) : null,
      np ? el('div', { class: 'dc-notes', 'data-tip': notesTip(np) }, notePreview(np.items[0]),
        np.count > 1 ? el('div', { class: 'muted small dc-notes-more' }, `+${np.count - 1} more note${np.count > 2 ? 's' : ''}`) : null) : null);
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

  /** A small day for the year view: its number, marked when something is on, with the details in its tooltip. */
  function yearCell(d, data) {
    const c = cal(), p = E.fromAbs(c, d), row = data.days.get(d);
    const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d), rems = dayReminders(d), np = data.notes.get(d);
    const w = row?.weather;
    const cls = ['ycell'];
    if (d === today()) cls.push('today');
    if (d < today()) cls.push('past');
    if (p.intercalary) cls.push('festival');
    if (evs.length || hol.length) cls.push('has-ev');
    const tipLines = [E.fmtDate(c, d), w ? E.weatherLabel(w, tempUnit()) : null, ...keyMoonPhases(d).map(m => `${m.icon} ${m.name}: ${m.label} moon`),
      ...hol.map(x => `Holiday: ${x.name}`), ...evs.map(e => `${Number(e.is_secret) ? '🔒' : '●'} ${e.title}`),
      ...rems.map(x => `🔔 ${x.title}`), np ? `📝 ${np.count} note${np.count > 1 ? 's' : ''}` : null].filter(Boolean);
    return el('a', { class: cls.join(' '), href: `#/c/${S.camp.id}/day/${d}`, 'data-tip': tipLines.join('\n'),
      style: hol.length ? { boxShadow: `inset 0 -3px 0 ${hol[0].color}` } : null },
      p.intercalary && E.monthLength(c, p.year, p.month) === 1 ? '★' : p.day);
  }

  /** Every month of the year starting on day `from`, each as a small grid. A month's name opens it in the month view. */
  function yearGrid(from, data) {
    const c = cal(), wl = E.weekLength(c), st = vs(), y = E.fromAbs(c, from).year;
    const months = [];
    c.months.forEach((mo, m) => {
      const len = E.monthLength(c, y, m);
      if (len <= 0) return; // leap-only months in common years
      const start = E.toAbs(c, y, m, 1);
      const cells = [];
      const weeks = !mo.intercalary && c.weekdays.length;
      if (weeks) for (let i = 0, lead = E.weekday(c, start) || 0; i < lead; i++) cells.push(el('span', { class: 'ycell empty' }));
      for (let d = start; d < start + len; d++) cells.push(yearCell(d, data));
      const cols = weeks ? wl : Math.min(wl, len);
      const open = el('button', { type: 'button', class: 'ym-name', 'data-tip': `Open ${mo.name} in the month view`,
        onclick: () => { st.mode = 'month'; st.anchor = start; route(); } }, len === 1 && mo.intercalary ? `★ ${mo.name}` : mo.name);
      months.push(el('div', { class: 'ymonth' + (mo.intercalary ? ' festival' : '') + (today() >= start && today() < start + len ? ' current' : '') },
        open,
        weeks ? el('div', { class: 'ygrid ygrid-head', style: { gridTemplateColumns: `repeat(${wl}, minmax(0,1fr))` } }, c.weekdays.map(n => el('span', { 'data-tip': n }, n.slice(0, 2)))) : null,
        el('div', { class: 'ygrid', style: { gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` } }, cells)));
    });
    return el('div', { class: 'yeargrid' }, months);
  }

  function weekList(from, to, data) {
    const c = cal(), names = shiftNames(), slots = names.map((_, i) => i);
    const rows = [];
    for (let d = from; d <= to; d++) {
      const row = data.days.get(d), w = row?.weather, sh = dayShifts(data, d);
      const reg = regionById(row?.region_id) || currentRegion(), sws = shiftWx(d, reg, w);
      const evs = dayEvents(data, d), hol = E.holidaysOn(c, S.holidays, d);
      const np = data.notes.get(d), dayNotes = np?.items.filter(n => n.kind !== 'shift') || [];
      const shiftNotesOf = i => np?.items.filter(n => n.kind === 'shift' && n.shift === i) || [];
      const hidden = np ? np.count - np.items.length : 0;
      rows.push(el('a', { class: 'weekrow' + (d === today() ? ' today' : ''), href: `#/c/${S.camp.id}/day/${d}` },
        el('div', { class: 'wr-date' }, el('strong', {}, E.fmtDate(c, d)), el('div', { class: 'small' }, weatherText(w), ' ', moonBadges(d, reg)),
          hol.map(holidayChip), tagsOf(evs).map(tagChip), evs.map(evLine),
          dayReminders(d).map(x => el('div', { class: 'evline reminder', 'data-tip': reminderTip([x]) }, '🔔 ', x.title)),
          dayNotes.map(n => el('div', { 'data-tip': `${noteWho(n)}: ${n.text}` }, notePreview(n, 'wr-note'))),
          hidden > 0 ? el('div', { class: 'muted small', 'data-tip': 'Open the day to read them' }, `+${hidden} more note${hidden > 1 ? 's' : ''}`) : null),
        el('div', { class: 'wr-shifts', style: spd() === 2 ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } : {} }, slots.filter(i => !hourMode() || sh[i]?.activity || shiftNotesOf(i).length || d * spd() + i === nowShift()).map(i => {
          const s = sh[i] || {};
          const sw = sws[i] || null, v = E.visibility(c, reg, sw, d, i, s.visibility_override);
          const isNow = d * spd() + i === nowShift();
          return el('div', { class: 'shiftbox' + (isNow ? ' now' : ''), 'data-tip': isNow ? `This is the current ${word()}` : null },
            el('div', { class: 'sb-head' }, el('span', {}, names[i], sw ? el('span', { class: 'sb-wx', 'data-tip': E.weatherLabel(sw, tempUnit()) + wxTip(sw) }, ` ${E.WEATHER[sw.type]?.icon || ''}`) : null), visPill(v)),
            el('div', { class: 'sb-act' }, s.activity || el('span', { class: 'muted' }, '—')),
            shiftNotesOf(i).map(n => el('div', { 'data-tip': `${noteWho(n)}: ${n.text}` }, notePreview(n, 'wr-note'))));
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
    let grounds = [];
    try { grounds = await groundFor(d, region, w); } catch { /* the day still shows without it */ }
    const groundNow = d === today() ? grounds[E.mod(nowShift(), spd())] : grounds.filter(Boolean).pop();
    const p = E.fromAbs(c, d);
    const sea = E.season(c, d, region?.settings?.hemisphere);
    const sun = E.sunTimes(c, d, region?.settings?.hemisphere);
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

    // --- weather and the day's conditions
    const overview = el('div', { class: 'dayconditions' },
      el('div', { class: 'kv' },
        el('div', {}, el('span', { class: 'lbl' }, 'Season', tip('From the calendar\'s season dates, flipped for regions in the other hemisphere. The season picks which weather odds apply.')), sea.name || '—'),
        el('div', {}, el('span', { class: 'lbl' }, 'Region'), region ? el('span', { 'data-tip': regionSummary(region) }, region.name) : '—'),
        el('div', {}, el('span', { class: 'lbl' }, w?.partial ? 'Weather now' : 'Forecast', tip(w?.partial ? SO_FAR_TIP : FORECAST_TIP)), weatherText(w)),
        groundNow ? el('div', {}, el('span', { class: 'lbl' }, d === today() ? 'Ground now' : 'Ground at day\'s end',
          tip('Snow lying on the ground, or how wet or frozen it is, from the weather of the days before. Each shift card shows it as the day goes on')), groundText(groundNow, d)) : null,
        sun ? el('div', { class: 'sun' }, el('span', { class: 'lbl' }, 'Sun', tip('Sunrise and sunset, blended between the times set on the seasons in Settings, and taken from half a year away for regions in the other hemisphere. Natural light at dawn and dusk follows them')),
          `☀ Sunrise ${E.fmtClock(sun.sunrise)} · Sunset ${E.fmtClock(sun.sunset)}`, el('div', { class: 'small muted' }, `${fmtDaylight(sun.daylight)} of daylight`)) : null,
        el('div', {}, el('span', { class: 'lbl' }, 'Moons'), E.moons(c, d, region).map(m => el('div', {}, m.redMoon ? moonGlyph(m) : m.icon, ` ${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)`))),
        hol.length ? el('div', {}, el('span', { class: 'lbl' }, 'Holidays'), hol.map(x => el('div', {}, holidayChip(x), x.description ? ` ${x.description}` : ''))) : null,
        // The Current Day tab's banner already shows the shift the clock is on.
        d === today() && !current ? el('div', {}, el('span', { class: 'lbl' }, 'Now'), names[E.mod(nowShift(), spd())]) : null));

    if (isGM()) overview.append(dayEditor(d, row, region, w));

    // --- shifts
    const sws = shiftWx(d, region, w);
    const shiftCards = el('div', { class: 'shifts' + (hourMode() ? ' hours' : '') }, names.map((_, i) =>
      shiftCard(d, i, shifts[i] || {}, region, sws[i] || null, !!w?.partial && !sws[i], (r.shift_notes || []).filter(n => Number(n.shift) === i), grounds[i] || null)));

    // --- events
    const evBox = dayBox('events', 'Events', {
      actions: (isGM() || settings().players_can_add_events) ? btn('+ Add event', () => openBox(evBox).append(eventForm(d)), 'primary small', 'Log something that happened (or will happen) on this day') : null,
    }, r.events.length ? r.events.map(e => eventView(e, d)) : el('p', { class: 'muted' }, 'No events on this day.'));

    // --- reminders
    const rems = dayReminders(d);
    const remBox = dayBox('reminders', 'Reminders', {
      tip: `A reminder pops up once the campaign clock reaches its ${word()}, for whoever it is for, until they dismiss it`,
      actions: btn('+ Add reminder', () => openBox(remBox).append(reminderForm(d)), 'primary small', `Have something pop up when the campaign reaches a ${word()} of this day`),
    }, rems.length ? rems.map(x => reminderView(x, d)) : el('p', { class: 'muted' }, 'No reminders on this day.'));

    mount(...campaignHeader(current ? 'today' : 'calendar'), nav,
      dayBox('weather', 'Weather', { summary: [region ? `📍 ${region.name}` : null, ' ', weatherText(w)] }, current ? dayHero(d, region, w, sws, shifts, groundNow) : null, overview),
      dayBox('shifts', `${Word()}s`, { tip: shiftTip() }, shiftCards),
      notesBox(d, row),
      evBox, remBox);
  }

  // The day page is a column of boxes (Weather, Shifts or Hours, Notes, Events, Reminders), each of which folds to its
  // heading (Weather to a line of what it holds). Which ones are folded is remembered in this browser, for each account.
  const BOXES_KEY = 'chronicle:dayboxes';
  function foldedBoxes() {
    try { return JSON.parse(localStorage.getItem(`${BOXES_KEY}:${S.user?.id}`)) || {}; } catch { return {}; }
  }
  function rememberFold(key, folded) {
    const all = foldedBoxes();
    if (folded) all[key] = true; else delete all[key];
    try { localStorage.setItem(`${BOXES_KEY}:${S.user?.id}`, JSON.stringify(all)); } catch { /* private mode: just this page */ }
  }
  /** A day box: its heading folds and unfolds it. opts: { tip, actions }, where actions sit at the right of the heading. */
  function dayBox(key, title, opts, ...body) {
    const folded = !!foldedBoxes()[key];
    const inner = el('div', { class: 'daybox-body', id: `daybox-${key}`, hidden: folded }, body);
    const toggle = el('button', { type: 'button', class: 'daybox-toggle', 'aria-expanded': String(!folded), 'aria-controls': inner.id,
      'data-tip': 'Fold or unfold this box. It stays as you leave it in this browser' }, el('span', { class: 'daybox-caret', 'aria-hidden': 'true' }), title);
    const box = el('section', { class: 'card daybox' + (folded ? ' folded' : ''), 'data-box': key },
      el('div', { class: 'daybox-head' }, el('h3', {}, toggle, opts.tip ? tip(opts.tip) : null),
        opts.summary ? el('span', { class: 'daybox-sum small' }, opts.summary) : null, opts.actions ? el('div', { class: 'row' }, opts.actions) : null),
      inner);
    toggle.addEventListener('click', () => setFold(box, !box.classList.contains('folded')));
    return box;
  }
  function setFold(box, folded) {
    box.classList.toggle('folded', folded);
    box.querySelector('.daybox-body').hidden = folded;
    box.querySelector('.daybox-toggle').setAttribute('aria-expanded', String(!folded));
    rememberFold(box.dataset.box, folded);
  }
  /** Unfold a box (to add something to it) and return its body. */
  function openBox(box) {
    if (box.classList.contains('folded')) setFold(box, false);
    return box.querySelector('.daybox-body');
  }

  /** The Notes box: the places the party went, Public notes everyone in the campaign reads and Secret notes only GMs
   * see. The GM writes both notes in word-processor editors; players read the Public ones. */
  function notesBox(d, row) {
    const PUBLIC_TIP = 'Everyone in the campaign can read these. Only GMs can change them';
    const SECRET_TIP = 'Only GMs ever see these. The server never sends them to players';
    const LOC_TIP = 'The towns, sites and buildings the party went to this day. Players can see this';
    if (!isGM()) {
      return dayBox('notes', 'Notes', {},
        row.locations ? el('div', { class: 'notes-locs' }, el('span', { class: 'lbl' }, 'Locations visited', tip(LOC_TIP)), el('div', { class: 'pre' }, linked(row.locations))) : null,
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip(PUBLIC_TIP)),
          (row.notes || '').trim() ? linkedNote(row.notes, row.notes_format) : el('p', { class: 'muted' }, 'No notes for this day yet.')));
    }
    const locs = el('textarea', { name: 'locations', rows: 1, value: row.locations || '', placeholder: 'e.g. Altdorf, the Grey Lady inn, Reikwald crossroads' });
    const pub = RichText.editor({ text: row.notes, format: row.notes_format, label: 'Public notes', placeholder: 'What happened today, for everyone to read', secret: true, mentions: encMentions() });
    const sec = RichText.editor({ text: row.gm_notes, format: row.gm_notes_format, label: 'Secret notes', placeholder: 'Secrets, plans and reminders for GMs only', mentions: encMentions() });
    const save = btn('Save notes', null, 'primary small', 'Save the locations and both notes');
    save.addEventListener('click', busy(save, async () => {
      const p = pub.value(), g = sec.value();
      await post('day_update', { abs_day: d, notes: p.text, notes_format: p.format, gm_notes: g.text, gm_notes_format: g.format, locations: locs.value }, S.camp.id);
      toast('Notes saved'); route();
      offerNouns([{ kind: 'locations', text: locs.value, label: 'Locations visited' }, { text: p.text, format: p.format, label: 'Public notes' },
        { text: g.text, format: g.format, secret: true, label: 'Secret notes' }]);
    }));
    return dayBox('notes', 'Notes', {},
      field('Locations visited', locs, null, LOC_TIP),
      el('div', { class: 'notes-grid' },
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip(PUBLIC_TIP)), pub.node),
        el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 Secret notes', tip(SECRET_TIP)), sec.node)),
      mentionRow(row.locations, [row.notes, row.notes_format], [row.gm_notes, row.gm_notes_format]),
      el('div', { class: 'row' }, save, S.sessionsReady ? btn('Import to a session…', () => importToSession(d, pub.value(), sec.value()), 'small',
        'Copy these notes, as they are written now, into a session\'s notes to write its summary from') : null));
  }

  /** A day's notes as session note lines: { pub: [{ text, depth }], sec: [...] }. Paragraphs, headings and list items become
   * lines (nested lists indent); GM-only paragraphs in the Public notes go with the Secret ones. Text that isn't rich text
   * is read by its indent, as typed in the notes box. */
  function dayNoteLines(text, format) {
    const pub = [], sec = [];
    if (!(text || '').trim()) return { pub, sec };
    if (format !== 'html') {
      for (const l of Sessions.parseLines(text)) pub.push({ text: l.text, depth: l.depth });
      return { pub, sec };
    }
    const isList = n => n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName);
    const line = (into, t, depth) => { t = t.replace(/\s+/g, ' ').trim(); if (t) into.push({ text: t.slice(0, 1000), depth: Math.min(3, depth) }); };
    const walk = (node, depth, into) => {
      for (const c of node.children) {
        if (isList(c)) walk(c, depth, into);
        else if (c.tagName === 'LI') {
          line(into, [...c.childNodes].filter(n => !isList(n)).map(n => n.textContent).join(''), depth);
          for (const sub of c.children) if (isList(sub)) walk(sub, depth + 1, into);
        } else if (c.tagName === 'ASIDE') { if (c.children.length) walk(c, 0, sec); else line(sec, c.textContent, 0); }
        else if (c.tagName !== 'HR') line(into, c.textContent, depth);
      }
    };
    walk(new DOMParser().parseFromString(`<body>${text}</body>`, 'text/html').body, 0, pub);
    return { pub, sec };
  }

  /** Current Day's Notes box → "Import to a session…": choose a session (or a new one) and which of the day's notes to add to it. */
  async function importToSession(d, pubVal, secVal) {
    const cid = S.camp.id;
    let sessions;
    try { ({ sessions } = await api('sessions', { query: { cid } })); } catch (e) { return toast(e.message, true); }
    const p = dayNoteLines(pubVal.text, pubVal.format), g = dayNoteLines(secVal.text, secVal.format);
    const secretLines = [...p.sec, ...g.pub, ...g.sec];
    const pubBox = el('input', { type: 'checkbox', checked: p.pub.length > 0, disabled: !p.pub.length });
    const secBox = el('input', { type: 'checkbox', checked: secretLines.length > 0, disabled: !secretLines.length });
    const where = select([['new', 'A new session'], ...sessions.map(x => [x.id, sessionName(x)])], sessions[0]?.id ?? 'new', { 'aria-label': 'Session to add the notes to' });
    const err = el('p', { class: 'bad small', hidden: true });
    const go = el('button', { class: 'primary', type: 'submit' }, 'Import');
    const dlg = el('dialog', { class: 'kit-dialog', 'aria-label': 'Import notes to a session' },
      el('form', { novalidate: true },
        el('h3', {}, 'Import notes to a session'),
        el('p', { class: 'kit-dialog-msg' }, `The notes of ${E.fmtDate(cal(), d)} become lines in the session\'s notes, stamped with this day. The day\'s notes stay as they are.`),
        field('Add them to', where),
        el('label', { class: 'inline' }, pubBox, ` Public notes (${p.pub.length} line${p.pub.length === 1 ? '' : 's'})`),
        el('label', { class: 'inline', 'data-tip': 'GM-only notes go in under a 🔒 line, which the draft summary keeps as a GM-only paragraph' }, secBox,
          ` Secret notes (${secretLines.length} line${secretLines.length === 1 ? '' : 's'})`),
        err,
        el('div', { class: 'kit-dialog-actions' }, go, el('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'))));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('form').addEventListener('submit', busy(go, async e => {
      e.preventDefault();
      const notes = [], at = d * spd();
      if (pubBox.checked) for (const l of p.pub) notes.push({ ...l, abs_shift: at });
      if (secBox.checked) {
        notes.push({ text: `🔒 Secret notes · ${E.fmtDate(cal(), d, { noWeekday: true })}`, depth: 0, abs_shift: at });
        for (const l of secretLines) notes.push({ text: l.text, depth: Math.min(3, l.depth + 1), abs_shift: at });
      }
      if (!(pubBox.checked ? p.pub.length : 0) && !(secBox.checked ? secretLines.length : 0)) { err.textContent = 'Pick notes that have something written in them'; err.hidden = false; return; }
      try {
        let sid = where.value === 'new' ? null : Number(where.value);
        if (!sid) sid = (await post('session_save', {}, cid)).session.id;
        await post('snote_bulk', { session_id: sid, notes }, cid);
        dlg.close();
        const to = sessions.find(x => x.id === sid);
        toast(`Added ${notes.length} note${notes.length === 1 ? '' : 's'} to ${to ? sessionName(to) : 'a new session'}`);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    }));
    document.body.append(dlg);
    dlg.showModal();
    go.focus();
  }

  // ------------------------------------------------------------ session notes
  // The GM's quick notes during play, typed into the notes box on a session's page (the Sessions tab): free text, one
  // note per line, indented lines under the line above. The shorthand (static/sessions.js): ! a GM aside, ? a loose
  // end, > a time jump. What is typed is kept in this browser until it is added to the session, so nothing typed is lost.
  const SNOTE_TIP = 'Enter starts a new line · Tab / Shift+Tab indents · Ctrl+Enter adds them to the session · @ names an Encyclopedia entry · ! keeps a line out of the summary · ? marks a loose end · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock';
  const SNOTE_HELP = [['Enter', 'a new line: each line becomes one note'], ['Tab, Shift+Tab', 'indent a line under the line above, or bring it back out (Esc, then Tab, leaves the box)'], ['Ctrl+Enter', 'adds what you have typed to the session\'s notes'], ['@', 'names an Encyclopedia entry'],
    ['!', 'at the start: a GM aside (dice, rules), kept out of the summary'], ['?', 'at the start: a loose end, listed apart at the end of the summary'],
    ['>+1, >+9, >+2w', 'jump on a day, nine days, two weeks'], ['>dusk', 'jump to that part of the day'], ['>+1 dawn', 'the next day at dawn'],
    ['>12 Firstmonth', 'jump to a date'], ['>', 'alone: back to the campaign\'s clock']];
  const SNOTE_MARKS = { '!': ['🎲', 'GM aside: kept out of the summary\'s draft'], '?': ['❓', 'Loose end: not in the summary, listed under Loose ends'] };
  const sessionName = s => `Session ${s.number}${s.title ? `: ${s.title}` : ''}`;
  /** Where a note sits in time, short: the shift alone on the campaign's current day, else the date too. */
  function snoteStamp(abs) {
    const n = spd(), d = Math.floor(abs / n), sh = shiftNames()[E.mod(abs, n)];
    return d === today() ? sh : `${sh} · ${E.fmtDate(cal(), d, { noWeekday: true })}`;
  }
  /** One note as a row. opts: { onChange(), notes() → the session's notes, tick, move: [sessions] }. A > line is a divider. */
  function snoteRow(n, opts) {
    const k = Sessions.mark(n.text);
    const del = btn('✕', async () => {
      if (!await confirmDialog('Delete this note?', { ok: 'Delete', danger: true })) return;
      try { await post('snote_delete', { id: n.id }, S.camp.id); opts.onChange(); } catch (err) { toast(err.message, true); }
    }, 'link small snote-del', 'Delete this note');
    del.setAttribute('aria-label', 'Delete note');
    const nudge = (dir, label, glyph) => {
      const b = btn(glyph, async () => {
        const list = opts.notes(), i = list.findIndex(x => x.id === n.id), to = i + dir;
        if (to < 0 || to >= list.length) return;
        // named by the note it goes after, so a list another tab has changed since still puts it in the right place
        const after = dir < 0 ? list[i - 2]?.id ?? 0 : list[i + 1].id;
        try { await post('snote_move', { id: n.id, after_id: after }, S.camp.id); opts.onChange(); } catch (err) { toast(err.message, true); }
      }, 'link small snote-nudge', label);
      b.setAttribute('aria-label', label);
      return b;
    };
    // a note's time shows in the heading over its group (see snoteList); this moves the one note to another day or shift
    const when = k === '>' ? null : btn('🕓', async () => {
      const v = await promptDialog('Move this note in time. Write it as a jump from where it is: +1, -1, dusk, +1 dawn or 12 Firstmonth', { ok: 'Move' });
      if (v === null || !v.trim()) return;
      const back = /^\s*-(\d+)\s*$/.exec(v);
      const to = back ? n.abs_shift - Number(back[1]) * spd() : Sessions.parseJump(cal(), `>${v}`, n.abs_shift, nowShift());
      if (to === null) return toast('Couldn\'t read that; try +1, dusk or 12 Firstmonth', true);
      try { await post('snote_save', { id: n.id, abs_shift: to }, S.camp.id); opts.onChange(); } catch (err) { toast(err.message, true); }
    }, 'link small snote-when-btn', `${snoteStamp(n.abs_shift)}. Click to move this note to another day or shift`);
    when?.setAttribute('aria-label', 'Move in time');
    const tools = el('span', { class: 'snote-tools' }, when, nudge(-1, 'Move up', '▲'), nudge(1, 'Move down', '▼'),
      opts.move?.length ? select([['', 'Move to…'], ...opts.move.map(s => [s.id, sessionName(s)])], '', {
        'aria-label': 'Move to another session', 'data-tip': 'Move this note to another session, at its end',
        onchange: async ev => {
          try { await post('snote_move', { id: n.id, session_id: Number(ev.target.value) }, S.camp.id); toast('Note moved'); opts.onChange(); } catch (err) { toast(err.message, true); }
        } }) : null, del);
    if (k === '>') {
      const clock = btn('Set the clock here', busy(null, async () => {
        await passShifts(n.abs_shift - nowShift());
        toast(`The clock is now ${snoteStamp(n.abs_shift)}`); route();
      }), 'small', 'Move the campaign\'s clock (weather, reminders and everyone\'s pages) to this day and shift');
      return el('div', { class: 'snote-jump', 'data-tip': 'Time jump: the notes after this take this day and shift. Set the clock here also moves the campaign\'s clock' },
        el('span', { class: 'snote-jump-at' }, `${shiftNames()[E.mod(n.abs_shift, spd())]} · ${E.fmtDate(cal(), Math.floor(n.abs_shift / spd()))}`),
        el('code', { class: 'small muted' }, n.text), clock, tools);
    }
    const textEl = el('span', { class: 'snote-text' }, linked(n.text));
    const row = el('div', { class: `snote snote-d${n.depth}` + (n.is_covered ? ' covered' : '') },
      opts.tick ? el('input', { type: 'checkbox', checked: n.is_covered, 'aria-label': 'Covered by the summary', 'data-tip': 'Ticked once the summary covers this note',
        onchange: async ev => {
          try { await post('snote_save', { id: n.id, is_covered: ev.target.checked }, S.camp.id); n.is_covered = ev.target.checked; opts.onTick?.(); } catch (err) { toast(err.message, true); }
        } }) : null,
      SNOTE_MARKS[k] ? el('span', { class: 'snote-mark', 'data-tip': SNOTE_MARKS[k][1], 'aria-label': SNOTE_MARKS[k][1] }, SNOTE_MARKS[k][0]) : null,
      textEl,
      tools);
    // a click on the text (not a link in it) changes it: Enter saves, Escape leaves it, Tab and Shift+Tab indent
    textEl.addEventListener('click', ev => {
      if (ev.target.closest('a')) return;
      let depth = n.depth;
      const edit = el('input', { class: 'snote-edit', value: n.text, maxlength: 1000, 'aria-label': 'Change this note', 'data-tip': 'Enter saves the change · Escape leaves it · Tab / Shift+Tab indents' });
      edit.addEventListener('keydown', async e => {
        if (e.key === 'Escape') return opts.onChange();
        if (e.key === 'Tab') { e.preventDefault(); depth = Math.max(0, Math.min(3, depth + (e.shiftKey ? -1 : 1))); row.className = `snote snote-d${depth}`; return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        try { await post('snote_save', { id: n.id, text: edit.value, depth }, S.camp.id); opts.onChange(); } catch (err) { toast(err.message, true); }
      });
      textEl.replaceWith(edit);
      edit.focus();
    });
    return row;
  }

  /** A session's notes as rows, grouped by when they happened: once the notes cover more than one shift, a heading names the
   * day and shift over each run of notes that share it (a > line is its own heading). One shift needs no heading. */
  function snoteList(notes, opts) {
    const heads = new Set(notes.map(n => n.abs_shift)).size > 1;
    let at = null;
    return notes.flatMap(n => {
      const row = snoteRow(n, opts), was = at;
      at = n.abs_shift;
      if (!heads || Sessions.mark(n.text) === '>' || n.abs_shift === was) return [row];
      return [el('div', { class: 'snote-when' }, snoteStamp(n.abs_shift)), row];
    });
  }

  /** The notes box on a session's page: free text, a line per note, kept in this browser until Add to notes sends it.
   * getNotes() gives the session's notes as last loaded; onAdded() runs once they are saved. */
  function notesEntry(s, getNotes, onAdded) {
    const cid = S.camp.id, draftKey = `chronicle:snotes-draft:${S.user?.id}:${s.id}`;
    const help = el('div', { class: 'snote-help small', hidden: true }, el('dl', {}, SNOTE_HELP.map(([k, v]) => [el('dt', {}, el('code', {}, k)), el('dd', {}, v)])));
    const err = el('p', { class: 'snote-err small', role: 'alert' });
    const box = el('textarea', { class: 'snote-box', rows: 7, maxlength: 60000, spellcheck: true, 'aria-label': 'New notes', 'data-tip': SNOTE_TIP,
      placeholder: 'Type your notes here, a line each. Enter starts a new line and Tab indents. Add them to the session when you are ready.' });
    try { box.value = localStorage.getItem(draftKey) || ''; } catch { /* private mode */ }
    const count = el('span', { class: 'small muted' });
    let attempt = null;  // the key the notes being added go under, so a resend whose first send arrived adds nothing twice
    const changed = () => {
      attempt = null;
      try { box.value ? localStorage.setItem(draftKey, box.value) : localStorage.removeItem(draftKey); } catch { /* private mode: kept on the page only */ }
      const n = Sessions.parseLines(box.value).length;
      count.textContent = n ? `${n} line${n === 1 ? '' : 's'} not added yet` : '';
    };
    /** Indent (dir 1) or outdent (dir -1) every line the selection touches, by two spaces. */
    function indent(dir) {
      const v = box.value, from = v.lastIndexOf('\n', box.selectionStart - 1) + 1;
      let to = v.indexOf('\n', box.selectionEnd); if (to < 0) to = v.length;
      const lines = v.slice(from, to).split('\n');
      let first = 0, total = 0;
      const out = lines.map((l, i) => {
        const cut = dir > 0 ? 0 : Math.min(2, /^ */.exec(l)[0].length);
        const r = dir > 0 ? '  ' + l : l.slice(cut), d = dir > 0 ? 2 : -cut;
        if (i === 0) first = d;
        total += d;
        return r;
      });
      const a = box.selectionStart, b = box.selectionEnd;
      box.value = v.slice(0, from) + out.join('\n') + v.slice(to);
      box.setSelectionRange(Math.max(from, a + first), Math.max(from, b + total));
      changed();
    }
    const wrap = el('div', { class: 'snote-entry' }, box);
    const mentions = encMentions() ? RichText.inputMentions(box, wrap, encMentions()) : null;
    box.addEventListener('input', () => { err.textContent = ''; changed(); });
    box.addEventListener('keydown', ev => {
      if (mentions?.keydown(ev)) return;
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !box.dataset.freeTab) { ev.preventDefault(); indent(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') box.dataset.freeTab = '1';   // the next Tab leaves the box, as a keyboard user needs
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); addBtn.click(); }
      if (ev.key !== 'Escape') delete box.dataset.freeTab;
    });
    const phone = (glyph, label, dir) => {
      const b = btn(glyph, () => { indent(dir); box.focus(); }, 'small snote-phone', label);
      b.setAttribute('aria-label', label);
      return b;
    };
    const helpBtn = btn('?', () => { help.hidden = !help.hidden; }, 'small', 'Show the shorthand this box understands');
    helpBtn.setAttribute('aria-label', 'Shorthand');
    let adding = false;  // one add at a time: a second press while one is on its way would send the same lines under a new key
    async function add() {
      err.textContent = '';
      const lines = Sessions.parseLines(box.value);
      if (!lines.length) { err.textContent = 'Type a note first'; return; }
      const long = lines.find(l => l.text.length > 1000);
      if (long) { err.textContent = `Line ${long.line} is longer than 1000 characters`; return; }
      // another tab may have jumped in time since this page loaded: start from the session as saved
      let have = getNotes();
      try { have = (await api('session', { query: { cid, id: s.id } })).notes || have; } catch { /* offline: the add below will say */ }
      let stamp = Sessions.stampAt(have, nowShift());
      const notes = [];
      for (const l of lines) {
        let at = stamp;
        if (Sessions.mark(l.text) === '>') {
          at = Sessions.parseJump(cal(), l.text, stamp, nowShift());
          if (at === null) { err.textContent = `Line ${l.line}: couldn't read that jump; try >+1, >dusk or >12 Firstmonth`; return; }
          stamp = at;
        }
        notes.push({ text: l.text, depth: l.depth, abs_shift: at });
      }
      err.textContent = '';
      attempt = attempt || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
      try { await post('snote_bulk', { session_id: s.id, notes, key: attempt }, cid); } catch (e) { err.textContent = `Not added: ${e.message}. What you typed is still here`; return; }
      box.value = ''; changed();
      toast(`Added ${notes.length} note${notes.length === 1 ? '' : 's'}`);
      onAdded();
    }
    const addBtn = btn('Add to notes', busy(null, async () => {
      if (adding) return;
      adding = true;
      try { await add(); } finally { adding = false; }
    }), 'primary small', 'Add each line you typed to this session\'s notes, below. Nothing is added until you press this');
    changed();
    return el('div', { class: 'snote-entry-all' },
      wrap, el('div', { class: 'row snote-entry-bar' }, addBtn, phone('⇤', 'Outdent', -1), phone('⇥', 'Indent', 1), helpBtn, count), err, help);
  }

  /** Hours of daylight as "11h 40m". */
  const fmtDaylight = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

  /** The Current Day tab's banner and the day's shifts (or hours) at a glance. On today it shows the shift the campaign
   * clock is on, large; on any other day, the day's forecast (what the player may see of it). */
  function dayHero(d, region, w, sws, shifts, ground) {
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
          ground ? el('div', { class: 'small' }, groundText(ground, d)) : null,
          shifts[sh]?.activity ? el('p', { class: 'pre dh-act' }, linked(shifts[sh].activity)) : null));
    } else {
      const def = w ? E.WEATHER[w.type] || {} : null;
      main = el('div', { class: 'dh-now' },
        el('div', { class: 'dh-icon', 'aria-hidden': 'true' }, def?.icon || '·'),
        el('div', {},
          el('div', { class: 'lbl' }, d < today() ? 'Past day' : 'Coming day'),
          el('div', { class: 'dh-shift' }, w ? def.label || w.type : isGM() ? 'No weather recorded' : 'Weather not known yet'),
          w ? el('div', {}, weatherText(w)) : null,
          ground ? el('div', { class: 'small' }, groundText(ground, d)) : null));
    }
    return el('div', { class: 'dayhero' }, main,
      el('div', { class: 'dh-strip' + (hourMode() ? ' hours' : ''), style: spd() === 2 ? { gridTemplateColumns: 'repeat(2, minmax(64px, 1fr))', maxWidth: '240px' } : {} }, names.map((_, i) => {
        const x = sws[i] || null, cls = ['dh-step'];
        if (i === sh) cls.push('now'); else if (i < sh) cls.push('past');
        const wxt = x ? `${names[i]}: ${E.weatherLabel(x, tempUnit())}${wxTip(x)}` : `${names[i]}: weather not known yet`;
        const kids = [el('span', { class: 'dh-step-icon' }, x ? E.WEATHER[x.type]?.icon || '' : '?'), el('span', { class: 'small' }, names[i])];
        if (i === sh) return el('div', { class: cls.join(' '), 'data-tip': `${wxt}. The campaign clock is on this ${word()}` }, el('span', { class: 'nowtag' }, 'NOW'), ...kids);
        if (!isGM()) return el('div', { class: cls.join(' '), 'data-tip': wxt }, ...kids);
        cls.push('nowpick');
        return moveNowButton(d, i, el('button', { type: 'button', class: cls.join(' '), 'aria-label': `Move Now to ${names[i]}`,
          'data-tip': `${wxt}. Click to move the NOW flag, and the campaign clock, here` }, el('span', { class: 'nowtag' }, 'NOW'), ...kids));
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
    const wind = select(E.WIND.map((n, i) => [i, `${n} (${E.windSpeed(i, unitSystem())})`]), w?.wind || 0, { name: 'wind' });
    const f = el('form', { class: 'dayedit' },
      el('div', { class: 'grid2' },
        field('Region for this day', regPick.node, null, 'Where the party spent this day. Its climate rolls the weather and its light source and terrain set visibility. "Current region" follows wherever the party is now.'),
        field('Weather', el('span', { class: 'row' }, wSel, tipped(temp, 'Daytime high'), tUnit === 'none' ? '' : tempSym(tUnit), tipped(wind, 'Wind strength')), null,
          `Set the day's weather by hand. Rain, fog, snow and the like lower visibility; see the ${word()} cards below for the exact effect.`)),
      el('div', { class: 'row' }, el('button', { class: 'primary small', 'data-tip': 'Save the region and weather. Notes save from the Notes box' }, 'Save day'),
        tipped(btn('🎲 Re-roll weather', async () => {
          let rid;
          try { rid = await regPick.resolve(); } catch (err) { return toast(err.message, true); }
          const reg = regionById(rid) || region;
          const prev = (await fetchRange(d - 1, d - 1)).days.get(d - 1)?.weather || null;
          const nw = E.genWeather(cal(), S.camp.seed, reg, d, prev, Date.now());
          await post('day_update', { abs_day: d, region_id: rid || null, weather: withShiftWx(d, reg, nw) }, S.camp.id);
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
        await post('day_update', { abs_day: d, region_id: rid || null, weather }, S.camp.id);
        toast('Day saved'); route();
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  /** A shift card's title, with the NOW flag on the current one. A GM moves the flag, and the campaign clock,
   * by clicking (or tapping) another shift's title, where a faint flag shows it can go. */
  function shiftTitle(d, i, isNow) {
    const name = shiftNames()[i];
    const flag = el('span', { class: 'nowtag' }, 'NOW');
    if (isNow) return el('h4', {}, name, tipped(flag, `The campaign clock is on this ${word()}`));
    if (!isGM()) return el('h4', {}, name);
    return el('h4', {}, moveNowButton(d, i, el('button', { type: 'button', class: 'nowpick', 'aria-label': `Move Now to ${name}`,
      'data-tip': `Move the NOW flag, and the campaign clock, to this ${word()}` }, name, flag)));
  }
  /** Make button b move the campaign clock to shift i of day d (from a shift title or the Weather box's strip). */
  function moveNowButton(d, i, b) {
    b.addEventListener('click', e => e.preventDefault()); // inside a folded card's summary: don't open it as well
    b.addEventListener('click', busy(b, async () => {
      await passShifts(d * spd() + i - nowShift());
      toast(`Now: ${shiftNames()[i]}`); route();
    }));
    return b;
  }

  /** hiddenWx: a player looking at a shift of today that hasn't come yet, whose weather the server held back. */
  function shiftCard(d, i, s, region, sw, hiddenWx, notes, ground) {
    const c = cal(), names = shiftNames();
    const v = E.visibility(c, region, sw, d, i, s.visibility_override);
    const isNow = d * spd() + i === nowShift();
    const card = el('div', { class: 'card shiftcard' + (isNow ? ' now' : '') },
      el('div', { class: 'row spread' }, shiftTitle(d, i, isNow), visPill(v)),
      sw ? el('div', { class: 'small' }, weatherText(sw, `Weather this ${names[i]}, worked out from the day's forecast`))
        : hiddenWx ? el('div', { class: 'small muted', 'data-tip': `Players see each ${word()}'s weather once the campaign clock reaches it` }, 'Weather not known yet') : null,
      ground ? el('div', { class: 'small' }, groundText(ground, d)) : null,
      el('small', { class: 'muted', 'data-tip': `How the visibility score was worked out: base light for the ${word()}, then moonlight, weather and terrain` }, v.parts.join(' · ')));
    // In hours mode a day has many cards, so an hour with nothing recorded starts folded to its heading.
    const fold = c => {
      if (!hourMode() || isNow || s.activity || s.gm_notes || (s.visibility_override ?? '') !== '' || notes.length) return c;
      const det = el('details', { class: c.className + ' folded' }), sum = el('summary');
      sum.append(c.firstChild); det.append(sum, ...c.childNodes);
      return det;
    };
    if (!isGM()) {
      card.append(el('p', { class: 'pre' }, s.activity ? linked(s.activity) : el('span', { class: 'muted' }, 'No activity recorded.')), shiftNotes(d, i, notes));
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
      await post('shift_save', { abs_day: d, shift: i, activity: act.value, gm_notes: gmn.value, visibility_override: ov.value, transit: E.isOnTheMove(act.value) }, S.camp.id);
      toast(`${names[i]} saved`); route();
      offerNouns([{ text: act.value, label: `${names[i]} activity` }, { text: gmn.value, secret: true, label: `${names[i]} GM notes` }]);
    }));
    card.append(pick, act, hint, gmn, mentionRow(s.activity, s.gm_notes) || '', el('div', { class: 'row' }, el('label', { class: 'inline' }, 'Visibility ', ov,
      tip(`Auto works it out from the light source, moonlight, weather and terrain. Pick a number to force it for this ${word()}, e.g. a magical darkness or a burning city.`)), save),
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
      el('div', { class: 'pre' }, linked(n.body)),
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
      offerNouns([{ text: input.value, label: `a ${shiftNames()[i]} note` }]);
    }));
    return el('div', { class: 'shiftnotes' }, el('span', { class: 'lbl' }, 'Notes'), el('div', { class: 'enotes' }, list), input, el('div', { class: 'row' }, add));
  }

  function eventView(e, d) {
    const c = cal();
    const mine = Number(e.created_by) === S.user.id;
    const span = e.end_day !== null && e.end_day !== undefined ? ` (${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })})` : '';
    const box = el('div', { class: 'event' + (Number(e.is_secret) ? ' secret' : '') });
    const notesList = el('div', { class: 'enotes' }, (e.notes || []).map(n => el('div', { class: 'enote' },
      el('div', { class: 'pre' }, linked(n.body)),
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
      offerNouns([{ text: noteIn.value, secret: !!Number(e.is_secret), label: `a note on "${e.title}"` }]);
    }));
    box.append(...[
      el('div', { class: 'row spread' },
        el('h4', {}, Number(e.is_secret) ? secretTag() : null, linked(e.title)),
        el('small', { class: 'muted' }, shiftRange(e), span)),
      e.tags?.length ? el('div', { class: 'etags' }, e.tags.map(tagChip)) : null,
      e.body ? el('p', { class: 'pre' }, linked(e.body)) : null,
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

  const canEditReminder = x => x.created_by === S.user.id || (isGM() && x.audience !== 'me');
  function reminderView(x, d) {
    const state = !x.due ? ['Waiting', `Pops up when the clock reaches ${E.fmtShift(cal(), x.due_shift)}`]
      : x.dismissed ? ['Dismissed', 'You have read this one'] : ['Due', 'The clock has reached it and you haven\'t dismissed it yet'];
    const box = el('div', { class: 'event reminder' + (x.due ? ' due' : '') },
      el('div', { class: 'row spread' },
        el('h4', {}, '🔔 ', linked(x.title)),
        el('small', { class: 'muted' }, shiftNames()[E.mod(x.due_shift, spd())], ' · ', el('span', { 'data-tip': state[1] }, state[0]))),
      x.body ? el('p', { class: 'pre' }, linked(x.body)) : null,
      el('small', { class: 'muted' }, `${AUDIENCE_TEXT[x.audience] || ''} · added by `, byline(x)),
      canEditReminder(x) ? el('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(reminderForm(d, x)), 'small', 'Change this reminder'),
        btn('Delete', async () => {
          if (!await confirmDialog(`Delete the reminder "${x.title}"?`)) return;
          try { await post('reminder_delete', { id: x.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Delete this reminder')) : null);
    return box;
  }

  function reminderForm(d, x = {}) {
    const n = spd(), names = shiftNames();
    // a new reminder on today starts at the next shift, since the clock has already reached this one
    const at = x.id ? x.due_shift : d === today() ? Math.min(nowShift() + 1, d * n + n - 1) : d * n;
    const day = datePicker(Math.floor(at / n));
    const slot = select(names.map((nm, i) => [i, nm]), E.mod(at, n), { name: 'slot', 'aria-label': Word() });
    const audience = isGM() ? select(REMINDER_AUDIENCES, x.audience || 'me', { name: 'audience' }) : null;
    const f = el('form', { class: 'event editing reminder' },
      el('div', { class: 'grid2' },
        field('Title', el('input', { name: 'title', value: x.title || '', required: true, maxlength: 200, placeholder: 'e.g. The ransom is due' })),
        field('When', el('span', { class: 'row' }, day, slot), null, `It pops up once the campaign clock reaches this ${word()}`),
        isGM() ? field('Who sees it', audience, null, 'Just me: only you. The GMs: every GM of this campaign. Everyone: the players too')
          : el('p', { class: 'muted small' }, 'Only you see your reminders.')),
      field('Details', el('textarea', { name: 'body', rows: 3, value: x.body || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, x.id ? 'Save reminder' : 'Add reminder'), btn('Cancel', () => route(), 'small')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = formData(f), due = day.getAbs() * n + Number(slot.value);
      if (due <= nowShift() && due !== x.due_shift) { toast(`Pick a ${word()} after now: the clock has already passed that one`, true); return; }
      try {
        await post('reminder_save', { id: x.id, title: v.title, body: v.body, due_shift: due, audience: audience ? audience.value : 'me' }, S.camp.id);
        toast('Reminder saved'); route();
        offerNouns([{ text: `${v.title}\n${v.body}`, title: true, secret: isGM() && audience.value !== 'all', label: `reminder "${v.title}"` }]);
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  /** Toggle tags on and off, or make a new one with its own colour.
   * get() returns the picked tags as [{ name, color }]. Holdings pass their own list (tags), apart from the events'. */
  function tagPicker(picked, noun = 'event', tags = S.tags) {
    const key = t => t.name.toLowerCase();
    const nouns = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
    const known = new Map(tags.map(t => [key(t), t]));
    for (const t of picked) if (!known.has(key(t))) known.set(key(t), t);
    const on = new Set(picked.map(key));
    const list = el('div', { class: 'tagpick' });
    const draw = () => list.replaceChildren(...[...known.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
      const k = key(t), sel = on.has(k);
      const b = el('button', { type: 'button', class: 'tagopt' + (sel ? ' on' : ''), 'aria-pressed': String(sel),
        'data-tip': sel ? `Tagged ${t.name}. Click to take it off` : `Click to tag this ${noun} ${t.name}`,
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
    const node = el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags', tip(noun === 'event' ? 'Group events by kind. Each tag has a colour, shown on the days that carry it in week view. Make your own with New tag'
      : `Group ${nouns} by kind. These tags are the ${nouns}' own, apart from the events' tags. Make your own with New tag`)),
      list, el('div', { class: 'row' }, name, color, btn('+ Add tag', add, 'small', `Create this tag and put it on the ${noun}`)));
    return { node, get: () => [...on].map(k => ({ name: known.get(k).name, color: known.get(k).color })) };
  }

  /** A dropdown of checkboxes for filtering a list, with Select all and Deselect all. Everything starts ticked; off is the
   * Set of keys unticked, kept by the caller so it lasts between visits and a new option starts ticked. noun names the
   * options in the button ("tags"). update(options) redraws it: [{ key, name, color?, count }], keeping it open. */
  function multiPick(label, noun, off, onChange) {
    const sum = el('summary', { class: 'button small' });
    const box = el('div', { class: 'mpick-list', role: 'group', 'aria-label': label });
    const find = el('input', { type: 'search', placeholder: `Find ${noun}`, 'aria-label': `Find ${noun}`, class: 'mpick-find' });
    let opts = [], shape = '';
    const change = () => { sync(); onChange(); };
    const all = btn('Select all', () => { off.clear(); change(); }, 'link small', `Show every ${noun.replace(/s$/, '')}`);
    const none = btn('Deselect all', () => { for (const o of opts) off.add(o.key); change(); }, 'link small', `Untick every ${noun.replace(/s$/, '')}, then tick the ones to show`);
    const node = el('details', { class: 'mpick' }, sum,
      el('div', { class: 'mpick-panel' }, el('div', { class: 'row small' }, all, none), find, box));
    const sync = () => {
      const on = opts.filter(o => !off.has(o.key)).length;
      sum.textContent = `${label}: ${on === opts.length ? 'All' : on ? `${on} of ${opts.length}` : 'None'} ▾`;
      node.classList.toggle('filtered', on !== opts.length);
      for (const cb of box.querySelectorAll('input')) cb.checked = !off.has(cb.value);
      all.disabled = on === opts.length; none.disabled = !on;
    };
    const filter = () => {
      const q = find.value.trim().toLowerCase();
      for (const row of box.children) row.hidden = !!q && !row.dataset.name.includes(q);
    };
    find.addEventListener('input', filter);
    find.hidden = true;
    const update = list => {
      opts = list;
      const next = JSON.stringify(list.map(o => [o.key, o.name, o.color, o.count]));
      if (next !== shape) { // only when the options change, so a box being ticked keeps its focus
        shape = next;
        box.replaceChildren(...list.map(o => {
          const cb = el('input', { type: 'checkbox', value: o.key, onchange: () => { cb.checked ? off.delete(o.key) : off.add(o.key); change(); } });
          const row = el('label', { class: 'mpick-opt' + (o.count ? '' : ' empty'), 'data-name': o.name.toLowerCase() }, cb,
            o.color ? el('span', { class: 'mpick-dot', style: { background: o.color }, 'aria-hidden': 'true' }) : null,
            el('span', { class: 'grow' }, o.name), el('small', { class: 'muted' }, String(o.count ?? '')));
          return row;
        }));
        find.hidden = list.length < 10;
        filter();
      }
      sync();
    };
    return { node, update };
  }
  // A click anywhere else, or Escape, closes an open multiPick.
  document.addEventListener('pointerdown', ev => {
    for (const d of document.querySelectorAll('details.mpick[open]')) if (!d.contains(ev.target)) d.open = false;
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    for (const d of document.querySelectorAll('details.mpick[open]')) {
      ev.stopPropagation(); d.open = false;
      if (!document.activeElement || document.activeElement === document.body || d.contains(document.activeElement)) d.querySelector('summary').focus();
    }
  }, true);

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
        offerNouns([{ text: `${v.title}\n${v.body}`, title: true, secret: isGM() && !!v.is_secret, label: `event "${v.title}"` }]);
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  /** text with each search word wrapped in <mark>, still built from text nodes */
  function markWords(text, words) {
    if (!words.length) return text;
    const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? el('mark', {}, part) : part));
  }

  // ------------------------------------------------------------ events tab
  /** Every event the member can see in one list, newest or oldest first, or on a timeline, narrowed by a search and by tags. */
  async function viewEvents() {
    const [{ events }, { sessions }] = await Promise.all([api('events', { query: { cid: S.camp.id } }),
      S.sessionsReady ? api('sessions', { query: { cid: S.camp.id } }).catch(() => ({ sessions: [] })) : { sessions: [] }]);
    const st = vs().events || (vs().events = { q: '', tags: new Set(), when: 'all', order: 'asc' });
    const c = cal(), d0 = today();
    const end = e => Number(e.end_day ?? e.abs_day);
    // what the search looks through: title, details, notes, tags and who added it
    const hay = new Map(events.map(e => [e, [e.title, e.body, ...(e.notes || []), ...(e.tags || []).map(t => t.name), e.author].filter(Boolean).join('\n').toLowerCase()]));
    const used = tagsOf(events).sort((a, b) => a.name.localeCompare(b.name));
    for (const k of [...st.tags]) if (!used.some(t => t.name.toLowerCase() === k)) st.tags.delete(k);

    const search = el('input', { type: 'search', value: st.q, placeholder: 'Search titles, details, notes and tags', 'aria-label': 'Search events' });
    const when = select([['all', 'All events'], ['upcoming', 'Today and later'], ['past', 'Before today']], st.when, { 'aria-label': 'When',
      'data-tip': 'Every event, only those still to come (or running today), or only those already over' });
    const order = select([['asc', 'Oldest first'], ['desc', 'Newest first']], st.order, { 'aria-label': 'Order' });
    const tagRow = el('div', { class: 'tagpick' });
    const count = el('p', { class: 'small muted', 'aria-live': 'polite' });
    const list = el('div', { class: 'evlist' });
    let asTimeline = evTimelineOn();
    const timeline = eventTimeline(st, sessions);

    const marked = markWords;
    const clip = t => (t.length > 220 ? `${t.slice(0, 219).trimEnd()}…` : t);
    const row = (e, words) => {
      const a = Number(e.abs_day), b = end(e);
      const date = E.fmtDate(c, a, { noWeekday: true }) + (b !== a ? ` → ${E.fmtDate(c, b, { noWeekday: true })}` : '');
      const state = b < d0 ? 'past' : a > d0 ? 'future' : 'now';
      const notes = (e.notes || []).length;
      return el('div', { class: `listrow evrow ${state}` + (Number(e.is_secret) ? ' secret' : '') },
        el('div', { class: 'evwhen' },
          el('a', { href: `#/c/${S.camp.id}/day/${a}`, 'data-tip': 'Open this day' }, date),
          el('div', { class: 'small muted' }, shiftRange(e), state === 'now' ? el('span', { class: 'evnow' }, ' · Today') : null)),
        el('div', { class: 'evbody' },
          el('h4', {}, Number(e.is_secret) ? secretTag() : null, el('a', { href: `#/c/${S.camp.id}/day/${a}` }, marked(e.title, words))),
          e.tags?.length ? el('div', { class: 'etags' }, e.tags.map(tagChip)) : null,
          e.body ? el('p', { class: 'small pre' }, words.length ? marked(clip(e.body), words) : linked(clip(e.body))) : null,
          el('small', { class: 'muted' }, 'Added by ', byline(e), notes ? ` · ${notes} note${notes === 1 ? '' : 's'}` : '')));
    };
    const draw = () => {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = events.filter(e => (st.when === 'all' || (st.when === 'upcoming' ? end(e) >= d0 : end(e) < d0))
        && (!st.tags.size || (e.tags || []).some(t => st.tags.has(t.name.toLowerCase())))
        && words.every(w => hay.get(e).includes(w)));
      count.textContent = shown.length === events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : `${shown.length} of ${events.length} events`;
      const none = el('p', { class: 'muted' }, events.length ? 'No events match. Clear the search or the tags to see more.' : 'No events yet. Add one from any day on the Calendar.');
      timeline.node.hidden = !asTimeline || !shown.length;
      order.hidden = asTimeline;
      if (asTimeline) {
        list.replaceChildren(...(shown.length ? [] : [none]));
        timeline.draw(shown);
      } else {
        if (st.order === 'desc') shown = shown.slice().reverse();
        list.replaceChildren(...(shown.length ? shown.map(e => row(e, words)) : [none]));
      }
      tagRow.replaceChildren(...used.map(t => {
        const k = t.name.toLowerCase(), on = st.tags.has(k);
        const b = el('button', { type: 'button', class: 'tagopt' + (on ? ' on' : ''), 'aria-pressed': String(on),
          'data-tip': on ? `Showing ${t.name} events. Click to stop filtering by it` : `Show only events tagged ${t.name}`,
          onclick: () => { on ? st.tags.delete(k) : st.tags.add(k); draw(); } }, el('span', { class: 'tick', 'aria-hidden': 'true' }, on ? '✓ ' : ''), t.name);
        b.style.setProperty('--tag', t.color);
        return b;
      }), ...(st.tags.size ? [btn('Clear tags', () => { st.tags.clear(); draw(); }, 'link small', 'Show events with any tag, or none')] : []));
    };
    search.addEventListener('input', () => { st.q = search.value; draw(); });
    when.addEventListener('change', () => { st.when = when.value; draw(); });
    order.addEventListener('change', () => { st.order = order.value; draw(); });
    const asList = btn('List', () => setView(false), 'small', 'Every event as a list, oldest or newest first');
    const asTl = btn('Timeline', () => setView(true), 'small', 'The events along the calendar, in lanes by tag: zoom from an era down to a day and drag to move along');
    const setView = on => {
      asTimeline = on;
      rememberEvTimeline(on);
      asList.classList.toggle('on', !on); asList.setAttribute('aria-pressed', String(!on));
      asTl.classList.toggle('on', on); asTl.setAttribute('aria-pressed', String(on));
      draw();
    };
    mount(...campaignHeader('events'), el('div', { class: 'card' },
      el('div', { class: 'row evhead' }, el('h2', {}, 'Events'), el('span', { class: 'seg', role: 'group', 'aria-label': 'Show events as' }, asList, asTl)),
      el('div', { class: 'row evfilters' }, search, when, order),
      used.length ? el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags', tip('Pick one or more tags to see only the events that carry any of them')), tagRow) : null,
      count, list, timeline.node));
    setView(asTimeline); // drawn once it's on the page, so the timeline knows how wide it is
  }
  const EV_VIEW_KEY = 'chronicle:evtimeline';
  function evTimelineOn() {
    try { return localStorage.getItem(EV_VIEW_KEY) === '1'; } catch { return false; }
  }
  function rememberEvTimeline(on) {
    try { on ? localStorage.setItem(EV_VIEW_KEY, '1') : localStorage.removeItem(EV_VIEW_KEY); } catch { /* private mode: just this page */ }
  }

  // ------------------------------------------------------------ events timeline
  /** The Events tab's Timeline: the events the filters leave, drawn along the campaign's own calendar with time running
   * left to right, in lanes by tag (or by the Encyclopedia entries they name, or all in one). The mouse wheel, a pinch,
   * the zoom buttons or + and − zoom from an era down to a day; dragging or the arrow keys move along. A one-day event
   * is a dot, a longer one a bar, and close up an event with shifts covers just those. Hover or tap an event to read it,
   * click it or tap it again to open its day. Bands over the lanes can show the sessions, seasons and holidays, and a
   * red line marks now. Secret events have a dashed purple edge; players never receive them. The view (zoom, place,
   * lanes, bands) is kept in st.tl while you move around the campaign. Returns { node, draw(events) }. */
  function eventTimeline(st, sessions) {
    const c = cal(), slots = spd(), cid = S.camp.id;
    const now = nowShift() / slots;
    const narrow = matchMedia('(max-width: 600px)').matches;
    const tl = st.tl || (st.tl = { lanes: narrow ? 'one' : 'tags', bands: { sessions: true, seasons: true, holidays: false }, ppd: null, center: null });
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs, ...kids) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
      for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      return n;
    };
    const canHover = matchMedia('(hover: hover)').matches;
    const fmt = d => E.fmtDate(c, d, { noWeekday: true });
    const svg = s('svg', { class: 'tl', tabindex: 0, role: 'group', 'aria-label': 'Timeline of events. Left and right arrows move along it, plus and minus zoom, Home goes to now' });
    const box = el('div', { class: 'tl-box' }, svg);
    let shown = [], W = 0, from = 0, to = 0;

    const minPpd = () => W / (3000 * E.yearLength(c, c.epochYear)), maxPpd = () => W / 1.5;
    const clampPpd = v => Math.min(maxPpd(), Math.max(minPpd(), v));
    /** Zoom to ppd keeping the day under x (pixels from the left) where it is. */
    const zoomAt = (ppd, x = W / 2) => {
      tl.zoom = null;
      const d = tl.center + (x - W / 2) / tl.ppd;
      tl.ppd = clampPpd(ppd);
      tl.center = d - (x - W / 2) / tl.ppd;
      render();
    };
    /** Show every event that's shown, and now, with a little room either side. */
    const fit = () => {
      const spans = shown.map(e => Timeline.span(e, slots));
      if (!spans.length || narrow) { tl.ppd = clampPpd(Timeline.zoomPx(c, 'month', W)); tl.center = now; return; }
      const lo = Math.min(now, ...spans.map(x => x.start)), hi = Math.max(now, ...spans.map(x => x.end));
      tl.ppd = clampPpd(Math.min((W * 0.9) / Math.max(hi - lo, 1), Timeline.zoomPx(c, 'week', W)));
      tl.center = (lo + hi) / 2;
    };

    // ---- the controls over it
    const zoomBtns = Timeline.ZOOMS.map(([key, label]) => {
      const b = btn(label, () => { zoomAt(Timeline.zoomPx(c, key, W)); tl.zoom = key; markZoom(); }, 'small', `Zoom to about ${{ era: 'a hundred years', year: 'a year and a half', month: 'three months', week: 'three weeks', day: 'four days' }[key]} across`);
      b.dataset.zoom = key;
      return b;
    });
    const laneOpts = [['tags', 'Lanes by tag'], ...(S.encReady && S.encyclopedia.length ? [['entries', 'Lanes by Encyclopedia entry']] : []), ['one', 'One lane']];
    if (!laneOpts.some(o => o[0] === tl.lanes)) tl.lanes = 'tags';
    const laneSel = select(laneOpts, tl.lanes, { 'aria-label': 'Lanes', 'data-tip': 'One lane per tag (an event with two tags is in both), one per Encyclopedia entry the events name, or every event in one lane' });
    laneSel.addEventListener('change', () => { tl.lanes = laneSel.value; render(); });
    const bandBox = (key, label, tipText) => {
      const cb = el('input', { type: 'checkbox', checked: !!tl.bands[key] });
      cb.addEventListener('change', () => { tl.bands[key] = cb.checked; render(); });
      return el('label', { class: 'tl-band-opt small', 'data-tip': tipText }, cb, ` ${label}`);
    };
    const bands = [
      S.sessionsReady && sessions.length ? bandBox('sessions', 'Sessions', 'A band showing the days each session covered') : null,
      (c.seasons || []).length ? bandBox('seasons', 'Seasons', 'A band showing the calendar\'s seasons') : null,
      S.holidays.length ? bandBox('holidays', 'Holidays', 'A band showing the holidays (when zoomed in to a few years or less)') : null,
    ].filter(Boolean);
    const bar = el('div', { class: 'row tl-tools' },
      el('span', { class: 'seg', role: 'group', 'aria-label': 'Zoom' }, zoomBtns),
      btn('−', () => zoomAt(tl.ppd / 1.6), 'small', 'Zoom out (or the mouse wheel, or pinch)'),
      btn('+', () => zoomAt(tl.ppd * 1.6), 'small', 'Zoom in (or the mouse wheel, or pinch)'),
      btn('Now', () => { tl.center = now; render(); }, 'small', 'Move to the current day'),
      btn('Fit', () => { tl.zoom = null; fit(); render(); }, 'small', 'Show every event listed at once'),
      laneSel, bands.length ? el('span', { class: 'tl-bands' }, bands) : null,
      btn('⬇ PNG', () => exportPng().catch(err => toast(err.message || 'Could not make the picture', true)), 'small', 'Download the timeline as it looks now, as a picture for the session recap'));
    const node = el('div', { class: 'tl-panel' }, bar, box,
      el('p', { class: 'small muted tl-help' }, canHover ? 'Scroll to zoom, drag to move along. Hover an event to read it, click it to open its day.'
        : 'Pinch to zoom, drag to move along. Tap an event to read it, tap it again to open its day.'));

    /** Light the zoom button pressed last, or else the one nearest the zoom (a short calendar can have two the same). */
    function markZoom() {
      const zk = tl.zoom || Timeline.zoomOf(c, tl.ppd, W);
      for (const b of zoomBtns) { const on = b.dataset.zoom === zk; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    }

    // ---- drawing
    const SEASON_FILL = { spring: '#6fb37a', summer: '#e0b341', autumn: '#c8743a', winter: '#6f9fd0', none: '#8a8a8a' };
    const text = (x, y, str, cls, extra) => s('text', { x, y, class: cls, ...extra }, str);
    const approxW = str => str.length * 6.6 + 4;
    const cut = (str, n) => (str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str);
    function render() {
      if (!box.isConnected) return;
      W = Math.max(280, Math.round(box.clientWidth || 0));
      if (!tl.ppd) fit();
      tl.ppd = clampPpd(tl.ppd);
      from = tl.center - W / 2 / tl.ppd; to = tl.center + W / 2 / tl.ppd;
      const X = d => (d - from) * tl.ppd;
      markZoom();

      const grid = s('g', { class: 'tl-grid' }), top = s('g'), body = s('g');
      let y = 0;
      // the axis: years or months along the top, the finer ticks under them
      const ax = Timeline.axis(c, from, to, tl.ppd);
      let lastEnd = -Infinity;
      const majorX = ax.major.map(t => X(t.day));
      if (!majorX.some(x => x < approxW(ax.lead) + 8)) { top.append(text(4, 14, ax.lead, 'tl-major')); lastEnd = approxW(ax.lead) + 4; }
      for (const t of ax.major) {
        const x = X(t.day);
        if (x >= lastEnd + 6) { top.append(text(x + 3, 14, t.label, 'tl-major')); lastEnd = x + 3 + approxW(t.label); }
      }
      lastEnd = -Infinity;
      const minorLabels = s('g');
      for (const t of ax.minor) {
        const x = X(t.day);
        if (x >= lastEnd + 4) { minorLabels.append(text(x + 3, 32, t.label, 'tl-minor')); lastEnd = x + 3 + approxW(t.label); }
      }
      top.append(minorLabels);
      y = 40;
      const bandRow = (label, items) => {
        const g = s('g', { class: 'tl-bandrow' });
        g.append(...items(y));
        g.append(text(4, y + 13, label, 'tl-lane-name'));
        top.append(g);
        y += 20;
      };
      if (tl.bands.sessions && S.sessionsReady && sessions.length) {
        bandRow('Sessions', y0 => sessions.filter(x => x.first_day !== null).map(x => {
          const a = Number(x.first_day), b = (x.last_day === null ? today() : Number(x.last_day)) + 1;
          if (X(b) < 0 || X(a) > W) return null;
          const label = `Session ${x.number}${x.title ? `: ${x.title}` : ''}`;
          const w = Math.max(3, X(b) - X(a));
          // the label clears the band's name when the bar reaches past it, else starts on the bar
          const lx = X(a) < 70 && X(b) > 150 ? 70 : X(a);
          return s('g', { class: 'tl-session', 'data-session': x.id, 'data-tip': `${label}\n${fmt(a)}${b - 1 !== a ? ` → ${fmt(b - 1)}` : ''}${x.is_published ? '' : '\nNot published: only GMs see it'}` },
            s('rect', { x: X(a), y: y0 + 2, width: w, height: 16, rx: 3 }),
            w > 40 ? text(lx + 4, y0 + 14, cut(label, Math.max(3, Math.floor((Math.min(X(b), W) - lx - 8) / 6.6))), 'tl-band-label') : null);
        }));
      }
      if (tl.bands.seasons && (c.seasons || []).length) {
        const list = Timeline.seasonBands(c, from, to);
        if (list.length) bandRow('Seasons', y0 => list.map(b => s('g', { 'data-tip': `${b.name}: ${fmt(Math.ceil(b.from))} → ${fmt(Math.ceil(b.to) - 1)}` },
          s('rect', { x: X(b.from), y: y0 + 2, width: Math.max(1, X(b.to) - X(b.from)), height: 16, class: 'tl-season', style: `fill:${SEASON_FILL[b.type] || SEASON_FILL.none}` }),
          X(b.to) - Math.max(X(b.from), 70) > approxW(b.name) ? text(Math.max(X(b.from), 70) + 4, y0 + 14, b.name, 'tl-band-label') : null)));
      }
      if (tl.bands.holidays && S.holidays.length) {
        const list = Timeline.holidayBands(c, S.holidays, from, to);
        bandRow('Holidays', y0 => (list === null ? [text(74, y0 + 14, 'Zoom in to see the holidays', 'tl-band-label muted')]
          : list.map(h => s('g', { 'data-tip': `${h.name}: ${fmt(h.from)}${h.to - 1 !== h.from ? ` → ${fmt(h.to - 1)}` : ''}${h.description ? `\n${h.description}` : ''}` },
            s('rect', { x: X(h.from), y: y0 + 2, width: Math.max(3, X(h.to) - X(h.from)), height: 16, rx: 2, class: 'tl-holiday', style: `fill:${h.color || 'var(--accent)'}` }),
            X(h.to) - X(h.from) > approxW(h.name) + 6 ? text(X(h.from) + 4, y0 + 14, h.name, 'tl-band-label') : null))));
      }

      // the lanes
      const tagsUsed = tagsOf(shown).sort((a, b) => a.name.localeCompare(b.name));
      const laneList = Timeline.lanes(shown, tl.lanes, { tags: tagsUsed, mentions: e => encLinker().mentions([e.title, e.body, ...(e.notes || [])].filter(Boolean).join('\n')) });
      const ROW = 22;
      for (const lane of laneList) {
        const top0 = y;
        const items = lane.events.map(e => {
          const sp = Timeline.span(e, slots), x0 = X(sp.start), x1 = X(sp.end);
          const dot = sp.days === 1 && x1 - x0 < 14;
          const title = (Number(e.is_secret) ? '🔒 ' : '') + e.title;
          const mx0 = dot ? (x0 + x1) / 2 - 5 : x0, mx1 = dot ? (x0 + x1) / 2 + 5 : Math.max(x1, x0 + 4);
          // a label goes inside a bar it fits in, otherwise just after the mark
          const inside = !dot && Math.min(mx1, W) - Math.max(mx0, 0) > approxW(title) + 8;
          return { e, sp, dot, title, x0: mx0, x1: inside ? mx1 : mx1 + 4 + approxW(cut(title, 32)), mx0, mx1, inside };
        }).filter(it => it.x1 >= 0 && it.x0 <= W).sort((a, b) => a.x0 - b.x0);
        const { rows, count } = Timeline.pack(items, 6, 10);
        const g = s('g', { class: 'tl-lane' });
        g.append(s('line', { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: 'tl-lane-line' }));
        y += 18;
        items.forEach((it, i) => {
          const cy = y + rows[i] * ROW + ROW / 2;
          const color = lane.color || it.e.tags?.[0]?.color || 'var(--accent)';
          const a = Number(it.e.abs_day), b = Number(it.e.end_day ?? it.e.abs_day);
          const when = fmt(a) + (b !== a ? ` → ${fmt(b)}` : '') + (it.e.shift !== null && it.e.shift !== undefined ? ` · ${shiftRange(it.e)}` : '');
          const tags = (it.e.tags || []).map(t => t.name).join(', ');
          const tipText = [`${it.title}`, when, tags ? `Tags: ${tags}` : null, it.e.body ? cut(it.e.body, 200) : null, canHover ? 'Click to open the day' : 'Tap again to open the day'].filter(Boolean).join('\n');
          const mark = it.dot
            ? s('circle', { cx: (it.mx0 + it.mx1) / 2, cy, r: 5, class: 'tl-dot', style: `fill:${color}` })
            : s('rect', { x: it.mx0, y: cy - 7, width: it.mx1 - it.mx0, height: 14, rx: 3, class: 'tl-bar', style: `fill:${color};stroke:${color}` });
          const lx = it.inside ? Math.max(it.mx0, 0) + 5 : it.mx1 + 4;
          g.append(s('g', { class: 'tl-ev' + (Number(it.e.is_secret) ? ' secret' : '') + (it.sp.end <= now ? ' past' : ''), 'data-day': a, 'data-id': it.e.id, 'data-tip': tipText, 'aria-label': `${it.title}, ${when}` },
            // an invisible box over the mark and its label, so a tap between the letters still lands on the event
            s('rect', { x: it.x0, y: cy - ROW / 2 + 1, width: Math.max(1, it.x1 - it.x0), height: ROW - 2, class: 'tl-hit' }),
            mark, text(lx, cy + 4, it.inside ? it.title : cut(it.title, 32), 'tl-label')));
        });
        y += Math.max(1, count) * ROW + 6;
        g.append(text(4, top0 + 13, `${lane.name} (${lane.events.length})`, 'tl-lane-name'));
        if (lane.color) g.lastChild.prepend(s('tspan', { style: `fill:${lane.color}` }, '● '));
        body.append(g);
      }
      const H = y + 4;
      // grid lines behind everything, the minor ones faint
      for (const t of ax.minor) grid.append(s('line', { x1: X(t.day), x2: X(t.day), y1: 20, y2: H, class: 'tl-tick' }));
      for (const t of ax.major) grid.append(s('line', { x1: X(t.day), x2: X(t.day), y1: 2, y2: H, class: 'tl-tick major' }));
      const nowX = X(now);
      const nowLine = nowX >= 0 && nowX <= W ? s('g', { class: 'tl-now', 'data-tip': `Now: ${E.fmtShift(c, nowShift())}` },
        s('line', { x1: nowX, x2: nowX, y1: 20, y2: H }), s('rect', { x: nowX - 1.5, y: 20, width: 3, height: H - 20, class: 'tl-now-hit' })) : null;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.replaceChildren(grid, top, body, nowLine);
    }

    // ---- moving about: wheel, drag, pinch and keys
    const pointers = new Map();
    let drag = null, pinch = null, downOn = null, moved = false, lastTap = null;
    const localX = clientX => clientX - svg.getBoundingClientRect().left;
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      hideTip();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? W : 1;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { tl.center += ((e.shiftKey ? e.deltaY : e.deltaX) * k) / tl.ppd; later(); return; }
      const x = localX(e.clientX), d = tl.center + (x - W / 2) / tl.ppd;
      tl.zoom = null;
      tl.ppd = clampPpd(tl.ppd * Math.exp(-e.deltaY * k * 0.0015));
      tl.center = d - (x - W / 2) / tl.ppd;
      later();
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, e.clientX);
      downOn = e.target instanceof Element ? e.target.closest('.tl-ev, .tl-session') : null;
      if (pointers.size === 1) { drag = { x: e.clientX, center: tl.center }; moved = false; }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { gap: Math.max(10, Math.abs(a - b)), ppd: tl.ppd, mid: localX((a + b) / 2) };
        pinch.day = tl.center + (pinch.mid - W / 2) / tl.ppd;
        moved = true;
      }
    });
    svg.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e.clientX);
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        tl.zoom = null;
        tl.ppd = clampPpd(pinch.ppd * Math.max(10, Math.abs(a - b)) / pinch.gap);
        tl.center = pinch.day - (localX((a + b) / 2) - W / 2) / tl.ppd;
        later();
      } else if (drag) {
        const dx = e.clientX - drag.x;
        if (!moved && Math.abs(dx) > 5) { moved = true; hideTip(); try { svg.setPointerCapture(e.pointerId); } catch { /* already gone */ } svg.classList.add('dragging'); }
        if (moved) { tl.center = drag.center - dx / tl.ppd; later(); }
      }
    });
    const up = e => {
      if (!pointers.delete(e.pointerId)) return;
      svg.classList.remove('dragging');
      if (pointers.size < 2) pinch = null;
      if (pointers.size) { const [x] = pointers.values(); drag = { x, center: tl.center }; return; }
      drag = null;
      if (e.type !== 'pointerup' || moved || !downOn) return;
      const hit = downOn;
      downOn = null;
      const key = hit.dataset.day ?? `s${hit.dataset.session}`;
      // a mouse opens it at once; a touch shows its card first (KIT's tooltip) and opens it on a second tap
      if (e.pointerType !== 'mouse' && lastTap !== key) { lastTap = key; return; }
      lastTap = null;
      location.hash = hit.dataset.session ? `#/c/${cid}/sessions/${hit.dataset.session}` : `#/c/${cid}/day/${hit.dataset.day}`;
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('keydown', e => {
      const step = W / 6 / tl.ppd;
      if (e.key === 'ArrowLeft') tl.center -= step;
      else if (e.key === 'ArrowRight') tl.center += step;
      else if (e.key === '+' || e.key === '=') zoomAt(tl.ppd * 1.6);
      else if (e.key === '-' || e.key === '_') zoomAt(tl.ppd / 1.6);
      else if (e.key === 'Home') tl.center = now;
      else return;
      e.preventDefault();
      render();
    });
    // redrawn to the new width when the window changes size, until the tab is left
    const onResize = () => { if (!box.isConnected) window.removeEventListener('resize', onResize); else later(); };
    window.addEventListener('resize', onResize);

    // ---- a picture of it: the drawing with its colours written in, on the card's background, at twice the size
    async function exportPng() {
      const clone = svg.cloneNode(true);
      const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
      const PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'paint-order', 'display'];
      src.forEach((n, i) => {
        const cs = getComputedStyle(n);
        dst[i].setAttribute('style', PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
        dst[i].removeAttribute('class'); dst[i].removeAttribute('data-tip');
      });
      clone.setAttribute('xmlns', NS);
      const w = Number(svg.getAttribute('width')), h = Number(svg.getAttribute('height'));
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('Could not draw the picture')); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`; });
      const canvas = document.createElement('canvas');
      canvas.width = w * 2; canvas.height = h * 2;
      const g = canvas.getContext('2d');
      g.scale(2, 2);
      g.fillStyle = getComputedStyle(box).backgroundColor;
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
      if (!blob) throw new Error('Could not make the picture');
      const a = el('a', { href: URL.createObjectURL(blob), download: `${S.camp.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Campaign'} timeline.png` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    return { node, draw(events) { shown = events; render(); } };
  }

  // ------------------------------------------------------------ encyclopedia
  // The Encyclopedia tab keeps the people, places, items and the like that turn up in play. Each save of a note,
  // event, reminder or Locations visited list runs the Proper Noun Detector (static/encyclopedia.js) over what was
  // saved and offers the new names it finds; whoever saved says Add, Ignore (never offer it again) or Skip (ask next
  // time). Names of entries are linked wherever they are written, as the text is shown: the stored text never changes.
  let encLinkMemo = null;
  /** The linker for the entries this member can see, rebuilt when the list changes. */
  function encLinker() {
    if (encLinkMemo?.list !== S.encyclopedia) {
      encLinkMemo = { list: S.encyclopedia, linker: Nouns.linker(S.encyclopedia, (e, text) => el('a', { class: 'enc-link' + (e.is_secret ? ' secret' : ''),
        href: `#/c/${S.camp.id}/encyclopedia/${e.id}`, 'data-tip': `📖 ${e.name}${e.is_secret ? ' (GM only)' : ''}${e.preview ? `: ${e.preview}` : '. Nothing written about it yet'}`,
        'data-tip-img': e.pic || null }, text)) };
    }
    return encLinkMemo.linker;
  }
  /** Text with every Encyclopedia name in it linked to its entry. */
  const linked = t => encLinker().text(t);
  /** A stored note as RichText.view() shows it, with the Encyclopedia's names linked. */
  function linkedNote(text, format, cls) {
    const node = RichText.view(text, format, cls);
    if (format === 'html') encLinker().tree(node); else node.replaceChildren(...linked(text));
    return node;
  }
  /** GMs: a 🔓 Reveal button on each run of GM-only paragraphs in a shown entry or tome (kind 'entry' or 'tome'),
   * which makes them public and can note it as an event on the current day. */
  function revealButtons(node, kind, id) {
    if (!isGM()) return node;
    const all = [...node.querySelectorAll('aside')];
    all.forEach((a, i) => {
      if (a.previousElementSibling?.nodeName === 'ASIDE') return;  // the button goes on the first of a run
      const run = [];
      for (let x = a, j = i; x && x.nodeName === 'ASIDE' && all[j] === x; x = x.nextElementSibling, j++) run.push({ index: j, text: x.textContent.trim() });
      a.prepend(btn('🔓 Reveal', async () => {
        const v = await KIT.dialog({ title: 'Reveal to the players?', message: run.length > 1 ? `These ${run.length} paragraphs become public now.` : 'This paragraph becomes public now.',
          buttons: [{ value: 'log', label: 'Reveal and log it today', cls: 'primary', focus: true }, { value: 'quiet', label: 'Just reveal' }, { value: 'cancel', label: 'Cancel' }] });
        if (v !== 'log' && v !== 'quiet') return;
        try {
          await post('secret_reveal', { kind, id, which: run, log: v === 'log' }, S.camp.id);
          toast(v === 'log' ? 'Revealed, and logged on today\'s events' : 'Revealed to the players');
          route();
        } catch (err) { toast(err.message, true); }
      }, 'small rt-reveal', 'Make this GM-only text public: players see it from now on'));
    });
    return node;
  }
  /** For text still open in an editor, where links can't go: a line of links to the entries it mentions. */
  function mentionRow(...texts) {
    const seen = new Set(), list = [];
    for (const [t, format] of texts.map(x => (Array.isArray(x) ? x : [x, 'plain']))) {
      for (const e of encLinker().mentions(Nouns.plain(t, format))) if (!seen.has(e.id)) { seen.add(e.id); list.push(e); }
    }
    if (!list.length) return null;
    return el('div', { class: 'enc-mentions small' }, el('span', { class: 'muted', 'data-tip': 'Encyclopedia entries named in this text. Open one to read or add to it' }, '📖 '),
      list.map(e => el('a', { class: 'enc-link' + (e.is_secret ? ' secret' : ''), href: `#/c/${S.camp.id}/encyclopedia/${e.id}` }, e.name)));
  }
  /** Words the campaign already has names for, which the detector never offers: the calendar's months, weekdays, shifts,
   * moons, seasons and eras, the members' names and character names, the names of the event and Encyclopedia tags, and the
   * Long Rest, Short Rest and Downtime labels a rest writes into the shifts. */
  function knownWords() {
    const c = cal();
    const people = S.members.flatMap(m => [m.character_name, m.display_name]).filter(Boolean);
    return [...(c.months || []).map(m => m.name), ...(c.weekdays || []), ...shiftNames(), ...(c.moons || []).map(m => m.name),
      ...(c.seasons || []).map(s => s.name), ...(c.eras || []).flatMap(e => [e?.name, e?.abbr]),
      ...people, ...people.flatMap(n => n.split(/\s+/)), ...S.tags.map(t => t.name), ...S.encTags.map(t => t.name),
      ...Object.values(DOWNTIME_KINDS).map(k => k.label), ...E.SHIFT_ACTIONS.map(a => a.name)].filter(Boolean);
  }
  /** Names the campaign knows the kind of: its regions are Locations and its holidays Events. */
  function knownKinds() {
    const h = {};
    for (const r of S.regions) h[r.name] = 'Location';
    for (const x of S.holidays) h[x.name] = 'Event';
    return h;
  }
  /** The @ list in rich text editors: the Encyclopedia names this member can see, and a new entry made on the spot. */
  function encMentions() {
    if (!S.encReady) return null;
    return {
      list: () => S.encyclopedia,
      create: async name => {
        try {
          const { id } = await post('entry_save', { name }, S.camp.id);
          S.encyclopedia = [...S.encyclopedia, { id, name, aliases: [], is_secret: false, blank: true, preview: '' }].sort((a, b) => a.name.localeCompare(b.name));
          toast(`${name} added to the Encyclopedia`);
          return true;
        } catch (err) { toast(err.message, true); return false; }
      },
    };
  }
  const detectorOpts = () => ({ known: S.encyclopedia.flatMap(Nouns.namesOf), ignored: [...S.encIgnored, ...encSkipped], stop: knownWords(), hints: knownKinds() });
  // Names skipped in the dialog (or left with Not now) aren't offered again until the page is reloaded; Scan campaign still lists them.
  const encSkipped = new Set();
  /** Run the detector over what was just saved and offer what it finds. sources: see Nouns.find(). */
  async function offerNouns(sources) {
    if (!S.encReady) return;
    // a rich text note's GM-only paragraphs are read as secret, so names found only there start as GM only
    sources = sources.flatMap(s => {
      if (s.format !== 'html') return [s];
      const { open, secret } = RichText.split(s.text);
      return [{ ...s, text: open }, { ...s, text: secret, secret: true }];
    });
    const found = Nouns.find(sources.filter(s => s.text && String(s.text).trim()), detectorOpts());
    if (found.length) await nounDialog(found.slice(0, 40));
  }
  /** Ask about each name found: Add it to the Encyclopedia (with a tag, and as GM only for a GM), Ignore it from now on,
   * or Skip it this time. scan: the full check of the campaign (or of one entry or tome, named by where), where every
   * name starts on Skip. */
  function nounDialog(found, { scan = false, where = 'the campaign' } = {}) {
    return new Promise(resolve => {
      hideTip();
      const cid = S.camp.id;
      // a Category, or else a tag: the detector's guess is either ("Person", "Religion")
      const tagOpts = S.encCatsReady ? [['', 'No category'], ...ENC_CATEGORIES.map(([, n, i]) => [n, `${i} ${n}`]),
        ...S.encTags.filter(t => !encCatNamed(t.name)).map(t => [t.name, `Tag: ${t.name}`])] : [['', 'No tag'], ...S.encTags.map(t => [t.name, t.name])];
      const rows = found.map((f, i) => {
        const name = el('input', { value: f.term, maxlength: 150, 'aria-label': `Name for ${f.term}`, class: 'grow' });
        const tag = select(tagOpts, f.tag || '', { 'aria-label': S.encCatsReady ? `Category or tag for ${f.term}` : `Tag for ${f.term}` });
        const secret = isGM() ? el('input', { type: 'checkbox', checked: f.secret, 'aria-label': `${f.term} is GM only` }) : null;
        // "Hoffmann" beside an entry for Gunther Hoffmann: it may be another name for that entry rather than a new one.
        const like = Nouns.related(f.term, S.encyclopedia);
        const aliasOf = like.length ? select(like.map(e => [e.id, e.name]), like[0].id, { 'aria-label': `Which entry ${f.term} is another name for` }) : null;
        const choices = [['add', 'Add', 'Add it to the Encyclopedia'], like.length ? ['alias', 'Alias', 'Another name for an entry that exists. It links to that entry from now on'] : null,
          ['ignore', 'Ignore', 'Never offer this word again. You can bring it back from the Encyclopedia tab'], ['skip', 'Skip', 'Not now: ask again next time']].filter(Boolean);
        const choice = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': `What to do with ${f.term}` },
          choices.map(([v, l, t]) => el('label', { 'data-tip': t }, el('input', { type: 'radio', name: `noun-${i}`, value: v, checked: v === (scan ? 'skip' : 'add') }), el('span', {}, l))));
        const asEntry = el('div', { class: 'row' }, name, tag,
          secret ? el('label', { class: 'inline small', 'data-tip': 'Only GMs will see this entry. Ticked when the name was found only in GM-only text' }, secret, ' 🔒 GM only') : null);
        const asAlias = aliasOf ? el('div', { class: 'row', hidden: true }, el('span', { class: 'small' }, 'Another name for'), aliasOf) : null;
        const row = el('div', { class: 'noun-row', 'data-term': f.term }, choice,
          el('div', { class: 'noun-what' }, asEntry, asAlias,
            f.where.length ? el('small', { class: 'muted' }, `Found in ${f.where.join(', ')}${f.count > 1 ? ` · ${f.count} times` : ''}`) : null));
        const pick = () => choice.querySelector('input:checked')?.value || 'skip';
        const sync = () => {
          const v = pick();
          row.classList.toggle('off', v !== 'add' && v !== 'alias');
          asEntry.hidden = v === 'alias';
          if (asAlias) asAlias.hidden = v !== 'alias';
        };
        choice.addEventListener('change', sync); sync();
        return { f, row, name, tag, secret, aliasOf, pick, set: v => { const r = choice.querySelector(`input[value=${v}]`); if (r) { r.checked = true; sync(); } } };
      });
      const all = v => rows.forEach(r => r.set(v));
      const d = el('dialog', { class: 'kit-dialog noun-dialog', 'aria-label': 'New names for the Encyclopedia' },
        el('form', { method: 'dialog' },
          el('h3', {}, scan ? '📖 Names missing from the Encyclopedia' : '📖 New names for the Encyclopedia'),
          el('p', { class: 'small muted' }, scan
            ? `The Proper Noun Detector found ${found.length} name${found.length === 1 ? '' : 's'} in ${where} that ${found.length === 1 ? 'isn\'t' : 'aren\'t'} in the Encyclopedia. Pick Add for the ones to keep; Ignore stops a word being offered again.`
            : 'The Proper Noun Detector found these in what you saved. Add puts one in the Encyclopedia, Ignore stops it being offered again, Skip asks next time.'),
          el('div', { class: 'row small' }, el('span', { class: 'muted' }, 'All:'), btn('Add', () => all('add'), 'link small'), btn('Ignore', () => all('ignore'), 'link small'), btn('Skip', () => all('skip'), 'link small')),
          el('div', { class: 'noun-list' }, rows.map(r => r.row)),
          el('div', { class: 'kit-dialog-actions' },
            el('button', { value: 'save', class: 'primary', type: 'submit' }, 'Save choices'),
            el('button', { value: 'cancel', type: 'submit', 'data-tip': 'Close without adding or ignoring anything' }, 'Not now'))));
      d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
      d.addEventListener('close', async () => {
        d.remove();
        if (S.camp?.id !== cid) return resolve(false);
        if (d.returnValue !== 'save') { if (!scan) for (const r of rows) encSkipped.add(r.f.term); return resolve(false); }
        const adds = [], ignores = [];
        for (const r of rows) {
          const v = r.pick(), n = r.name.value.trim().replace(/\s+/g, ' ');
          if (v === 'ignore') ignores.push(r.f.term);
          if (v === 'skip' && !scan) encSkipped.add(r.f.term);
          if (v === 'alias') adds.push({ name: r.f.term, alias_of: Number(r.aliasOf.value) });
          if (v !== 'add' || !n) continue;
          const cat = S.encCatsReady ? encCatNamed(r.tag.value) : null;
          adds.push({ name: n, is_secret: !!r.secret?.checked, category: cat, tags: r.tag.value && !cat ? [{ name: r.tag.value }] : [] });
          if (Nouns.keyOf(n) !== Nouns.keyOf(r.f.term)) ignores.push(r.f.term); // renamed: the word as found isn't offered again
        }
        try {
          let added = [], aliased = [];
          if (adds.length) ({ added, aliased } = await post('entries_add', { entries: adds }, cid));
          if (ignores.length) { await post('terms_ignore', { terms: ignores }, cid); S.encIgnored = [...S.encIgnored, ...ignores]; }
          if (added.length || aliased.length) {
            const list = S.encyclopedia.map(e => ({ ...e, aliases: [...(e.aliases || []), ...aliased.filter(a => a.id === e.id).map(a => a.alias)] }));
            S.encyclopedia = [...list, ...added.map(a => ({ id: a.id, name: a.name, aliases: [], is_secret: !!adds.find(x => x.name === a.name)?.is_secret, blank: true, preview: '' }))]
              .sort((a, b) => a.name.localeCompare(b.name));
          }
          if (added.length || aliased.length || ignores.length) {
            toast([added.length ? `Added ${added.length} to the Encyclopedia` : '', aliased.length ? `${aliased.length} other name${aliased.length === 1 ? '' : 's'} added` : '',
              ignores.length ? `${ignores.length} ignored` : ''].filter(Boolean).join(' · '));
            route();
          }
          resolve(true);
        } catch (err) { toast(err.message, true); resolve(false); }
      });
      document.body.append(d);
      d.showModal();
    });
  }

  /** Where each kind of text the detector reads lives, for "Mentioned in" and the full scan. */
  function sourceLabel(s) {
    const date = s.abs_day !== undefined ? E.fmtDate(cal(), s.abs_day, { noWeekday: true }) : '';
    const day = `#/c/${S.camp.id}/day/${s.abs_day}`;
    const shift = s.shift !== undefined ? shiftNames()[s.shift] || '' : '';
    return ({
      locations: [`${date}: Locations visited`, day], day_notes: [`${date}: Public notes`, day], day_gm_notes: [`${date}: Secret notes`, day],
      activity: [`${date}, ${shift}: activity`, day], shift_gm_notes: [`${date}, ${shift}: GM notes`, day], shift_note: [`${date}, ${shift}: a note`, day],
      event: [`${date}: event "${s.title}"`, day], event_note: [`${date}: a note on "${s.title}"`, day], reminder: [`${date}: reminder "${s.title}"`, day],
      entry: [`Encyclopedia: ${s.title}`, `#/c/${S.camp.id}/encyclopedia/${s.id}`], entry_gm_notes: [`Encyclopedia: ${s.title} (GM notes)`, `#/c/${S.camp.id}/encyclopedia/${s.id}`],
      downtime: [`${date}: ${s.title}`, `#/c/${S.camp.id}/downtime`], downtime_gm_notes: [`${date}: ${s.title} (GM notes)`, `#/c/${S.camp.id}/downtime`],
      holding: [`Party Holdings: ${s.title}`, `#/c/${S.camp.id}/holdings`], storage: [`Party Holdings: ${s.title} storage`, `#/c/${S.camp.id}/holdings`],
      gear: ['Party Holdings: Gear and Loot', `#/c/${S.camp.id}/holdings`], funds: ['Party Holdings: Party Funds', `#/c/${S.camp.id}/holdings`],
      tome: [`Library: ${s.title}`, `#/c/${S.camp.id}/library/${s.id}`],
      session: [`Sessions: ${s.title}`, `#/c/${S.camp.id}/sessions/${s.id}`], session_note: [`Sessions: ${s.title} (notes)`, `#/c/${S.camp.id}/sessions/${s.id}`],
    })[s.kind] || [s.kind, day];
  }
  /** The campaign's text for the detector: event, reminder and downtime titles, and short boxes like a holding's name, read as titles. */
  const scanSources = sources => sources.map(s => ({ ...s, title: !!s.short || ['event', 'reminder', 'downtime'].includes(s.kind), label: sourceLabel(s)[0] }));
  /** The full scan, or with only (a test of each source) and where (its name for the dialog) a scan of part of it. */
  async function fullScan(only = null, where = 'the campaign') {
    const { sources } = await api('encyclopedia_sources', { query: { cid: S.camp.id } });
    const found = Nouns.find(scanSources(only ? sources.filter(only) : sources), { ...detectorOpts(), ignored: S.encIgnored });
    if (!found.length) { toast(`No names missing: everything the detector finds in ${where} is in the Encyclopedia or ignored`); return; }
    await nounDialog(found.slice(0, 300), { scan: true, where });
  }
  /** A 🔍 Scan button for one entry or tome: the full scan, over only the text kept with it. */
  function scanOneBtn(what, only, where) {
    const b = btn('🔍 Scan', null, 'small', `Run the Proper Noun Detector over just this ${what} and offer the names in it that are missing from the Encyclopedia`);
    b.addEventListener('click', busy(b, () => fullScan(only, where)));
    return b;
  }

  const entryBlank = e => !(e.notes || '').trim() && !(isGM() && (e.gm_notes || '').trim());
  /** The Encyclopedia tab: the entries down the left (Blank Entries first), the one picked on the right. sel: an entry
   * id, 'new' for a new entry, or nothing. A blank entry, or a new one, opens straight in its editor. */
  async function viewEncyclopedia(sel) {
    if (!S.encReady) {
      return mount(...campaignHeader('encyclopedia'), el('div', { class: 'card' }, el('h2', {}, 'Encyclopedia'),
        el('p', {}, isGM() ? 'The Encyclopedia needs a database upgrade first: open install.php on the server and press Install or upgrade.'
          : 'The Encyclopedia isn\'t set up on this server yet. Ask whoever runs it to open install.php.')));
    }
    const r = await api('encyclopedia', { query: { cid: S.camp.id } });
    const entries = r.entries;
    S.encTags = r.tags || []; S.encIgnored = r.ignored || [];
    const rel = { ready: !!r.relations_ready, list: r.relations || [], types: r.relation_types || [], entries };
    const conns = connIndex(rel);
    const files = { list: r.files || [], uploads: r.uploads || { ready: false } };
    S.encUploads = files.uploads;
    for (const e of entries) e.files = files.list.filter(f => f.parent_id === e.id);
    S.encyclopedia = entries.map(e => ({ id: e.id, name: e.name, aliases: e.aliases || [], is_secret: e.is_secret, blank: entryBlank(e), preview: Nouns.plain(e.notes, 'html').replace(/\s+/g, ' ').trim().slice(0, 140),
      pic: e.files.find(f => f.kind === 'image' || (f.kind === 'embed' && !f.embed?.gone))?.url || null }));
    S.encCatsReady = !!r.categories_ready;
    // Each filter keeps what is unticked, so everything shows at first and a tag made later starts ticked.
    const st = vs().enc || (vs().enc = { q: '', tagsOff: new Set(), relsOff: new Set(), catsOff: new Set(), folded: new Set() });
    if (st.near && !entries.some(e => e.id === st.near)) st.near = null;
    const current = sel === 'new' ? { tags: [] } : entries.find(e => e.id === Number(sel)) || null;
    const href = id => `#/c/${S.camp.id}/encyclopedia${id ? `/${id}` : ''}`;

    // --- the list
    const hay = new Map(entries.map(e => [e, [...Nouns.namesOf(e), encCat(e.category)?.[1] || '', ...(e.tags || []).map(t => t.name), Nouns.plain(e.notes, 'html'), isGM() ? Nouns.plain(e.gm_notes, 'html') : '',
      ...conns.get(e.id).flatMap(c => [c.label, c.other.name]), ...files.list.filter(f => f.parent_id === e.id).flatMap(f => [f.name, f.caption || ''])].join('\n').toLowerCase()]));
    // The connection labels in use, as seen from either end: "has resident" and "resident of".
    const relUsed = new Map();
    for (const list of conns.values()) for (const c of list) relUsed.set(c.label.toLowerCase(), { name: c.label, color: c.type.color });
    const used = tagsOf(entries).sort((a, b) => a.name.localeCompare(b.name));
    const nearRow = el('div', { class: 'row small' });
    const search = el('input', { type: 'search', value: st.q, placeholder: 'Search names, notes and tags', 'aria-label': 'Search the Encyclopedia' });
    const lists = el('div', { class: 'enc-lists' });
    const ctx = { rel, conns, entries, st, files, draw: null };
    // Each entry is a small card: its name, its other names under it, and its tags along the bottom.
    const item = e => el('a', { class: 'enc-item enc-card' + (current?.id === e.id ? ' on' : ''), href: href(e.id), 'aria-current': current?.id === e.id ? 'page' : null },
      el('span', { class: 'enc-name' }, e.is_secret ? el('span', { 'data-tip': 'GM only' }, '🔒 ') : null, e.name),
      e.aliases?.length ? el('small', { class: 'enc-alias' }, `also ${e.aliases.join(', ')}`) : null,
      e.tags?.length ? el('span', { class: 'etags' }, e.tags.map(tagChip)) : null);
    // Each entry's keys for each filter; '' is "none" (no Category, no tags, no connections).
    const keys = new Map(entries.map(e => [e, {
      cat: [e.category || ''],
      tag: e.tags?.length ? e.tags.map(t => t.name.toLowerCase()) : [''],
      rel: conns.get(e.id).length ? [...new Set(conns.get(e.id).map(c => c.label.toLowerCase()))] : [''],
    }]));
    const offOf = { cat: st.catsOff, tag: st.tagsOff, rel: st.relsOff };
    /** Whether e passes every filter but skip's (so each dropdown counts what ticking an option would add). */
    const passes = (e, skip) => {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.every(w => hay.get(e).includes(w))) return false;
      if (st.near && e.id !== st.near && !conns.get(e.id).some(c => c.other.id === st.near)) return false;
      return Object.entries(offOf).every(([f, off]) => f === skip || (f === 'cat' && !S.encCatsReady) || keys.get(e)[f].some(k => !off.has(k)));
    };
    const countBy = f => {
      const n = new Map();
      for (const e of entries) if (passes(e, f)) for (const k of keys.get(e)[f]) n.set(k, (n.get(k) || 0) + 1);
      return n;
    };
    const catPick = multiPick('Category', 'categories', st.catsOff, () => draw());
    const tagPick = multiPick('Tags', 'tags', st.tagsOff, () => draw());
    const relPick = multiPick('Connections', 'connections', st.relsOff, () => draw());
    catPick.node.classList.add('enc-catpick'); tagPick.node.classList.add('enc-tagpick'); relPick.node.classList.add('enc-relpick');
    const clearAll = btn('Show all', () => { for (const off of Object.values(offOf)) off.clear(); st.q = search.value = ''; st.near = null; draw(); }, 'link small', 'Clear the search and every filter');
    const filters = el('div', { class: 'enc-filters' }, S.encCatsReady ? catPick.node : null, used.length ? tagPick.node : null, relUsed.size ? relPick.node : null, clearAll);
    const draw = () => {
      const shown = entries.filter(e => passes(e));
      const blank = shown.filter(entryBlank);
      const section = (key, title, list, tipText) => {
        const folded = st.folded.has(key);
        const head = el('button', { type: 'button', class: 'enc-fold', 'aria-expanded': String(!folded), onclick: () => { folded ? st.folded.delete(key) : st.folded.add(key); draw(); } },
          title);
        return el('section', { class: key === 'blank' ? 'enc-blank' : null, 'data-cat': key }, el('h3', {}, head, tipText ? tip(tipText) : null), folded ? [] : list.map(item));
      };
      const of = entries.length !== shown.length ? ` of ${entries.length}` : '';
      // Grouped by Category, in the order they are listed, then the entries with none.
      const groups = S.encCatsReady ? [...ENC_CATEGORIES, ['', 'No category', '']].map(([k, name, icon]) => [k, `${icon ? `${icon} ` : ''}${name}`, shown.filter(e => (e.category || '') === k)]).filter(g => g[2].length) : [];
      const onlyNone = groups.length === 1 && groups[0][0] === '';
      lists.replaceChildren(...clean([
        blank.length ? section('blank', `Blank Entries (${blank.length})`, blank,
          'Entries with nothing written about them yet, such as names just added by the Proper Noun Detector. Open one to describe it') : null,
        shown.length ? el('p', { class: 'small muted enc-count' }, `${shown.length}${of} entries`) : null,
        shown.length && groups.length && !onlyNone ? groups.map(([k, title, list]) => section(k, `${title} (${list.length})`, list))
          : shown.length ? section('all', `All entries (${shown.length}${of})`, shown)
          : el('p', { class: 'muted small' }, entries.length ? 'Nothing matches. Clear the search or the filters to see more.'
            : 'No entries yet. Add one, or scan the campaign for names that are missing.')]));
      const cats = countBy('cat'), tags = countBy('tag'), rels = countBy('rel');
      catPick.update([...ENC_CATEGORIES, ['', 'No category']].map(([k, name]) => ({ key: k, name, count: cats.get(k) || 0 })));
      tagPick.update([...used.map(t => ({ key: t.name.toLowerCase(), name: t.name, color: t.color })), { key: '', name: 'No tags' }].map(o => ({ ...o, count: tags.get(o.key) || 0 })));
      relPick.update([...[...relUsed].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([k, t]) => ({ key: k, name: t.name, color: t.color })), { key: '', name: 'No connections' }]
        .map(o => ({ ...o, count: rels.get(o.key) || 0 })));
      clearAll.hidden = shown.length === entries.length;
      const near = st.near && entries.find(e => e.id === st.near);
      nearRow.hidden = !near;
      nearRow.replaceChildren(...(near ? [el('span', { class: 'muted' }, 'Connected to'), el('strong', {}, near.name),
        btn('× Clear', () => { st.near = null; draw(); }, 'link small', 'Show every entry again')] : []));
    };
    ctx.draw = draw;
    search.addEventListener('input', () => { st.q = search.value; draw(); });
    draw();
    const scanBtn = btn('🔍 Scan campaign', null, 'small', 'Run the Proper Noun Detector over everything written in the campaign (notes, events, reminders, Locations visited, downtime, Party Holdings and the Library) and offer the names that are missing');
    scanBtn.addEventListener('click', busy(scanBtn, () => fullScan()));
    const ignored = S.encIgnored.length ? el('details', { class: 'enc-ignored' },
      el('summary', { class: 'small' }, `Ignored words (${S.encIgnored.length})`),
      el('p', { class: 'small muted' }, isGM() ? 'Words the GMs told the detector not to offer. Restore one to have it offered again.'
        : 'Words the players told the detector not to offer. Restore one to have it offered again.'),
      el('div', { class: 'enc-ignored-list' }, S.encIgnored.map(t => el('span', { class: 'enc-ignored-word' }, t, ' ',
        btn('Restore', async () => {
          try { await post('term_restore', { term: t }, S.camp.id); S.encIgnored = S.encIgnored.filter(x => x !== t); route(); } catch (err) { toast(err.message, true); }
        }, 'link small', `Have the detector offer "${t}" again`))))) : null;
    // The list and the entry swap widths at the press of a button, remembered in this browser.
    let wide = encWide();
    const page = el('div', { class: 'enc-page' + (current ? ' has-sel' : '') + (wide ? ' wide' : '') });
    const wideBtn = btn('', () => { wide = !wide; rememberEncWide(wide); setWide(); }, 'small enc-widebtn');
    const setWide = () => {
      page.classList.toggle('wide', wide);
      wideBtn.textContent = wide ? '⇤ Narrow list' : '⇥ Wide list';
      wideBtn.setAttribute('aria-pressed', String(wide));
      wideBtn.dataset.tip = wide ? 'Give the entry its room back and narrow the list' : 'Widen the list to see more of the Encyclopedia at once, and narrow the entry';
    };
    setWide();
    const left = el('section', { class: 'card enc-index' },
      el('div', { class: 'row spread' }, el('h2', {}, 'Encyclopedia', tip('The people, places, items, groups and the like that turn up in play. Every name here is linked wherever it is written in the campaign. Everyone can add entries and write their Public notes; GM notes are for GMs only')),
        el('div', { class: 'row' }, el('a', { class: 'button primary small', href: href('new'), 'data-tip': 'Start an entry by hand' }, '+ New entry'), scanBtn, wideBtn)),
      search, filters, nearRow, lists, ignored, isGM() && rel.ready ? relationKinds(rel) : null);

    // --- the entry picked
    const right = el('section', { class: 'card enc-detail' });
    if (!current) right.append(el('p', { class: 'muted' }, entries.length ? 'Pick an entry to read it.' : 'Nothing here yet.'),
      el('p', { class: 'small muted' }, 'When you save a note, an event, a reminder, a day\'s Locations visited, a downtime card, a holding or a tome, the Proper Noun Detector offers any new names it finds: capitalized words, words in bold, italics or underline, and words set apart *like this* or in "quote marks".'));
    else if (!current.id || entryBlank(current)) right.append(entryForm(current));
    else right.append(...entryView(current, ctx));
    page.append(left, right);
    mount(...campaignHeader('encyclopedia'), page);
  }

  const ENC_WIDE_KEY = 'chronicle:encwide';
  function encWide() {
    try { return localStorage.getItem(ENC_WIDE_KEY) === '1'; } catch { return false; }
  }
  function rememberEncWide(on) {
    try { on ? localStorage.setItem(ENC_WIDE_KEY, '1') : localStorage.removeItem(ENC_WIDE_KEY); } catch { /* private mode: just this page */ }
  }

  function entryView(e, ctx) {
    const canDelete = isGM() || e.created_by === S.user.id;
    const box = el('div', { class: 'enc-mentioned' }, el('h4', {}, 'Mentioned in'), el('p', { class: 'muted small' }, 'Looking…'));
    api('encyclopedia_sources', { query: { cid: S.camp.id } }).then(({ sources }) => {
      const linker = Nouns.linker([e], () => null), seen = new Set(), list = [];
      for (const s of sources) {
        if (s.kind.startsWith('entry') && s.id === e.id) continue;
        if (!linker.mentions(Nouns.plain(s.text, s.format)).length) continue;
        const [label, to] = sourceLabel(s);
        if (seen.has(label)) continue;
        seen.add(label); list.push(el('li', {}, el('a', { href: to }, label)));
      }
      box.replaceChildren(el('h4', {}, 'Mentioned in', tip('Every place in the campaign where this name is written, that you can see')),
        list.length ? el('ul', { class: 'enc-where' }, list.slice(0, 100)) : el('p', { class: 'muted small' }, 'Nowhere yet.'));
    }).catch(() => box.lastChild.replaceWith(el('p', { class: 'muted small' }, 'Could not look that up just now.')));
    // An entry's own name isn't linked in its notes.
    const others = Nouns.linker(S.encyclopedia.filter(x => x.id !== e.id), (x, text) => el('a', { class: 'enc-link', href: `#/c/${S.camp.id}/encyclopedia/${x.id}`, 'data-tip': `${x.name}: open it in the Encyclopedia`, 'data-tip-img': x.pic || null }, text));
    const note = html => others.tree(RichText.view(html, 'html'));
    const publicNote = html => revealButtons(note(html), 'entry', e.id);
    return clean([
      el('div', { class: 'row spread' },
        el('h2', {}, e.is_secret ? secretTag() : null, e.name),
        el('div', { class: 'row' },
          btn('Edit', ev => ev.currentTarget.closest('.enc-detail').replaceChildren(entryForm(e)), 'small primary', 'Change this entry'),
          scanOneBtn('entry', s => s.kind.startsWith('entry') && s.id === e.id, `"${e.name}"`),
          canDelete ? btn('Delete', async () => {
            if (!await confirmDialog(`Delete "${e.name}" from the Encyclopedia?`, { ok: 'Delete', danger: true })) return;
            try { await post('entry_delete', { id: e.id }, S.camp.id); location.hash = `#/c/${S.camp.id}/encyclopedia`; } catch (err) { toast(err.message, true); }
          }, 'small danger', 'Delete this entry. Its name stays in the text it was found in') : null)),
      encCat(e.category) || e.tags?.length ? el('div', { class: 'etags' }, encCat(e.category) ? el('span', { class: 'chip enc-cat', 'data-tip': 'Category' }, `${encCat(e.category)[2]} ${encCat(e.category)[1]}`) : null,
        (e.tags || []).map(tagChip)) : null,
      e.aliases?.length ? el('div', { class: 'small' }, el('span', { class: 'muted' }, 'Also called '), e.aliases.join(', ')) : null,
      el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip('Everyone in the campaign can read these')),
        (e.notes || '').trim() ? publicNote(e.notes) : el('p', { class: 'muted' }, 'Nothing written yet.')),
      isGM() ? el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 GM notes', tip('Only GMs ever see these. The server never sends them to players')),
        (e.gm_notes || '').trim() ? note(e.gm_notes) : el('p', { class: 'muted' }, 'Nothing written yet.')) : null,
      connectionsCard(e, ctx),
      e.author ? el('small', { class: 'muted' }, 'Added by ', byline(e)) : null,
      attachmentsCard('encyclopedia', e.id, e.files || [], { uploads: S.encUploads, secret: e.is_secret, name: e.name }),
      box]);
  }

  // ------------------------------------------------------------ pictures and files
  // A portrait on a character, a map on a location: pictures show on the page, other files are downloaded. The server
  // checks every upload's contents, keeps it outside the web root and sends it only to members who may see its parent,
  // so a file on a GM-only entry, or one marked GM only, never reaches players.
  const fileSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  /** Send one file to the server (multipart, so not through api()). */
  async function uploadFile(parentType, parentId, file, { caption = '', secret = false } = {}) {
    const fd = new FormData();
    fd.append('parent_type', parentType); fd.append('parent_id', String(parentId)); fd.append('file', file, file.name);
    if (caption) fd.append('caption', caption);
    if (secret) fd.append('is_secret', '1');
    const res = await fetch('api/index.php?' + new URLSearchParams({ a: 'file_upload', cid: S.camp.id }), { method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': S.csrf }, body: fd });
    let data;
    try { data = await res.json(); } catch { throw new Error(res.status === 413 ? 'That file is too big for the server' : `Server error (${res.status})`); }
    if (res.status === 401 || data.error === 'not_approved') { S.user = null; boot(); }
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `Error ${res.status}`), { status: res.status });
    ownWrite();
    return data.file;
  }

  /** A found picture's credit: "Title by Author, Licence, via Source", each part linked when it can be; an embed's
   * reads "Title by Author on DeviantArt". */
  const creditText = f => { const c = f.credit;
    return `${c.title || 'Untitled'}${c.author ? ` by ${c.author}` : ''}${f.embed ? ` on ${c.source || 'DeviantArt'}` : `, ${c.license}${c.source ? `, via ${c.source}` : ''}`}. Open the picture for the links`; };
  function creditLine(f) {
    const c = f.credit, link = (href, text) => href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text;
    const by = c.author ? [' by ', link(c.author_url, c.author)] : [];
    return el('p', { class: 'small muted file-credit' }, c.title || 'Untitled', by,
      f.embed ? [' on ', link(f.embed.url || c.source_url, c.source || 'DeviantArt')] : [', ', link(c.license_url, c.license), c.source ? [', via ', link(c.source_url, c.source)] : null]);
  }

  // Find Image: an entry's name looked up in open picture libraries, only when asked. The server does the searching (so
  // the keys stay there) and decides what may be copied: only CC0, public domain, CC BY and CC BY-SA pictures get Use
  // this picture, and each keeps its credit. A DeviantArt work under any other licence can be embedded instead, which
  // keeps only its link, or followed to its page and its artist's to ask before copying it.
  const FIND_SOURCES = [
    ['openverse', 'Open web', 'Openly licensed pictures from Flickr, Wikimedia Commons, museums and more, through Openverse'],
    ['museums', 'Museums', 'Public-domain paintings, armour, maps and the like from The Met, the Art Institute of Chicago and the Smithsonian'],
    ['deviantart', 'DeviantArt', 'Searched by tag, so the words are joined into one: "ruined keep" looks for ruinedkeep'],
  ];
  function findImage(parentType, parentId, name, opts) {
    const cid = S.camp.id;
    let source = 'openverse', seq = 0;
    const q = el('input', { type: 'search', value: name || '', maxlength: 200, placeholder: 'e.g. ruined keep', 'aria-label': 'Search for pictures', enterkeyhint: 'search' });
    q.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
    const gmOnly = opts.gmOnly;                       // the Pictures and files box's own GM only box
    const out = el('div', { class: 'find-results', 'aria-live': 'polite' });
    const say = t => out.replaceChildren(el('p', { class: 'muted small' }, t));
    const tab = (k, label, t) => el('button', { type: 'button', role: 'tab', class: 'small' + (k === source ? ' on' : ''), 'aria-selected': String(k === source), 'data-source': k, 'data-tip': t,
      onclick: () => { source = k; for (const b of tabs.children) { const on = b.dataset.source === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); } run(); } }, label);
    const tabs = el('div', { class: 'seg find-tabs', role: 'tablist', 'aria-label': 'Where to search' }, FIND_SOURCES.map(([k, label, t]) => tab(k, label, t)));
    // the campaign's fan wiki, when there is one, as a tab of its own
    let fan = null;
    Fan?.findTab(fanCtx()).then(t => { if (t) tabs.append(tab(t.key, t.label, (fan = t).tip)); });
    const link = (href, text, cls) => href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text) : text;
    async function run() {
      const words = q.value.trim(), mine = ++seq;
      if (!words) return say('Type something to search for.');
      say('Looking…');
      try {
        const r = source === 'fanwiki' && fan ? { results: await fan.search(words) } : await api('image_search', { query: { cid, source, q: words } });
        if (mine !== seq) return;
        if (!r.results.length) return say(`Nothing found for "${words}".`);
        out.replaceChildren(el('div', { class: 'find-grid' }, r.results.map(result)));
      } catch (err) { if (mine === seq) say(err.message); }
    }
    function result(it) {
      const pick = async (mode, ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await post('image_import', { parent_type: parentType, parent_id: parentId, source: it.source, id: it.id, mode, is_secret: !!gmOnly?.checked }, cid);
          toast('Picture added');
          opts.onAdded();
        } catch (err) { b.disabled = false; toast(err.message, true); }
      };
      const da = it.source === 'deviantart';
      return el('figure', { class: 'find-result' },
        el('a', { class: 'find-thumb', href: it.landing_url, target: '_blank', rel: 'noopener noreferrer', 'data-tip': `Open "${it.title}" where it was found` },
          el('img', { src: it.thumb, alt: it.title, loading: 'lazy', referrerpolicy: 'no-referrer' })),
        el('figcaption', { class: 'small' },
          el('strong', {}, it.title),
          it.author ? el('span', {}, 'by ', link(it.author_url, it.author)) : null,
          el('span', {}, link(it.license_url, it.license), ' · ', link(it.landing_url, it.via || 'Source'))),
        it.open ? btn('Use this picture', ev => pick('copy', ev), 'small primary', 'Copy this picture to the entry, with its credit')
          : it.fair_use ? el('div', { class: 'find-closed' },
            el('p', { class: 'small muted' }, 'Not openly licensed: it can be kept on this entry for your campaign\'s own use, credited to the wiki.'),
            btn('Keep as personal fair use', ev => pick('copy', ev), 'small', 'Copy this picture to the entry, credited to the wiki and marked "Personal fair use". If its owner asks, remove it'))
          : el('div', { class: 'find-closed' },
            el('p', { class: 'small muted' }, da ? 'Not openly licensed: embed it from DeviantArt, or ask the artist before copying it.' : 'Not openly licensed, so it can\'t be copied here.'),
            da ? el('div', { class: 'row' }, link(it.landing_url, 'View on DeviantArt', 'button small'), link(it.author_url, 'Artist\'s page', 'button small'),
              btn('Embed from DeviantArt', ev => pick('embed', ev), 'small', 'Show this work on the entry from DeviantArt, credited, without copying it. If the artist removes it, it goes from here too')) : null));
    }
    const panel = el('div', { class: 'find-image' },
      el('div', { class: 'row find-bar' }, q, btn('Search', run, 'small primary'), tabs),
      out);
    run();
    return panel;
  }

  /** The Pictures and files box on a page. files: what the server sent for this parent; opts.uploads: { ready, max_bytes,
   * accept, problem }; opts.secret: the parent is GM only, so every file on it is too; opts.manageAny: every member may
   * change or remove its files (otherwise whoever added one, and GMs); opts.gmAdds: only GMs may add files (a session's);
   * opts.empty: what the box says while it has none; opts.name: an Encyclopedia entry's name, which Find Image starts from. After a change the box fetches its files again and
   * redraws only itself, so notes being typed beside it are kept; files is updated in place. */
  function attachmentsCard(parentType, parentId, files, opts = {}) {
    const up = opts.gmAdds && !isGM() ? { ready: false } : opts.uploads || { ready: false };
    const cid = S.camp.id;
    const refresh = async () => {
      try {
        const r = await api('files', { query: { cid, parent_type: parentType, parent_id: parentId } });
        files.splice(0, files.length, ...r.files);
        if (S.camp?.id === cid && box.isConnected) box.replaceWith(attachmentsCard(parentType, parentId, files, { ...opts, uploads: r.uploads }));
      } catch (err) { toast(err.message, true); }
    };
    opts = { ...opts, refresh };
    const mine = f => isGM() || opts.manageAny || f.created_by === S.user.id;
    const hidden = f => f.is_secret || opts.secret;
    const isPic = f => f.kind === 'image' || f.kind === 'embed';
    const pics = files.filter(isPic), docs = files.filter(f => !isPic(f));
    const status = el('p', { class: 'small muted file-status', role: 'status' });
    const gmOnly = isGM() && !opts.secret ? el('input', { type: 'checkbox', 'aria-label': 'Upload as GM only' }) : null;
    const send = async list => {
      list = [...list];
      if (!list.length) return;
      let done = 0;
      for (const file of list) {
        if (file.size > up.max_bytes) { toast(`${file.name} is too big: files can be ${fileSize(up.max_bytes)} at most`, true); continue; }
        status.textContent = `Uploading ${file.name}…`;
        try { await uploadFile(parentType, parentId, file, { secret: !!gmOnly?.checked }); done++; } catch (err) { toast(`${file.name}: ${err.message}`, true); }
      }
      status.textContent = '';
      if (done) { toast(done === 1 ? 'File added' : `${done} files added`); refresh(); }
    };
    const input = el('input', { type: 'file', multiple: true, accept: up.accept || 'image/*', class: 'file-input', 'aria-label': 'Add pictures or files' });
    input.addEventListener('change', () => { send(input.files); input.value = ''; });
    const findSlot = el('div', { class: 'find-slot' });
    const findBtn = up.ready && parentType === 'encyclopedia' && opts.name ? btn('🖼️ Find Image', () => {
      findSlot.firstChild ? findSlot.replaceChildren() : findSlot.replaceChildren(findImage(parentType, parentId, opts.name, { gmOnly, onAdded: refresh }));
    }, 'small', 'Search open picture libraries, museums and DeviantArt for a picture of this, credited') : null;
    const addBtn = up.ready ? el('label', { class: 'button small primary file-add', 'data-tip': `Add a picture (JPEG, PNG, GIF, WebP) or a file (PDF, text) up to ${fileSize(up.max_bytes)}. You can also drop files here` }, input, '📎 Add') : null;
    const gallery = pics.length ? el('div', { class: 'file-gallery' }, pics.map((f, i) =>
      el('figure', { class: 'file-pic' + (hidden(f) ? ' secret' : ''), 'data-id': f.id },
        el('button', { type: 'button', class: 'file-thumb', 'aria-label': `Open ${f.caption || f.name}`, onclick: () => fileViewer(pics, i, { ...opts, mine, hidden }) },
          f.embed?.gone ? el('span', { class: 'muted small file-gone' }, 'No longer on DeviantArt')
            : el('img', { src: f.url, alt: f.caption || f.name, loading: 'lazy', width: f.width, height: f.height, referrerpolicy: f.embed ? 'no-referrer' : null })),
        // Only the picture shows; its name, caption, GM only, embed and credit are in the "?" on its corner.
        el('span', { class: 'file-pic-info' }, tip([f.caption || f.name, hidden(f) ? '🔒 GM only: players never see this' : null,
          f.embed ? 'Embedded: shown from DeviantArt each time, not copied here, so it needs a connection' : null,
          f.credit ? creditText(f) : null].filter(Boolean).join('\n')))))) : null;
    const docList = docs.length ? el('ul', { class: 'file-list' }, docs.map(f => el('li', { 'data-id': f.id },
      hidden(f) ? el('span', { 'data-tip': 'GM only: players never see this' }, '🔒 ') : null,
      el('a', { href: `${f.url}&dl=1`, download: f.name, 'data-tip': `Download ${f.name}` }, '📄 ', f.name),
      el('small', { class: 'muted' }, ` ${fileSize(f.size)}`), f.caption ? el('span', { class: 'small' }, ` · ${f.caption}`) : null,
      mine(f) ? btn('✎', () => fileEdit(f, opts), 'link small', 'Change the caption') : null,
      mine(f) ? btn('×', () => fileDelete(f, opts), 'link small', `Remove ${f.name}`) : null))) : null;
    const box = el('section', { class: 'enc-files' },
      el('div', { class: 'row spread' }, el('h4', {}, 'Pictures and files', tip(opts.secret ? 'GM only, like the entry. Pictures show here; other files download'
          : 'Everyone in the campaign can see these, except any marked 🔒 GM only. Pictures show here; other files download')),
        el('div', { class: 'row' }, gmOnly ? el('label', { class: 'inline small', 'data-tip': 'Only GMs will see what you add' }, gmOnly, ' 🔒 GM only') : null, findBtn, addBtn)),
      findSlot, gallery, docList,
      !files.length ? el('p', { class: 'muted small' }, up.ready ? opts.empty || 'No pictures or files yet. Add a portrait, a map or a handout.' : isGM() && up.problem ? up.problem : 'No pictures or files yet.') : null,
      status);
    if (up.ready) {
      box.addEventListener('dragover', ev => { if ([...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); box.classList.add('drop'); } });
      box.addEventListener('dragleave', ev => { if (!box.contains(ev.relatedTarget)) box.classList.remove('drop'); });
      box.addEventListener('drop', ev => { ev.preventDefault(); box.classList.remove('drop'); send(ev.dataTransfer.files); });
    }
    return box;
  }
  async function fileDelete(f, opts) {
    if (!await confirmDialog(`Remove ${f.name}? It can't be brought back.`, { ok: 'Remove', danger: true })) return false;
    try { await post('file_delete', { id: f.id }, S.camp.id); toast('File removed'); opts.refresh(); return true; } catch (err) { toast(err.message, true); return false; }
  }
  /** Change a file's caption and (GMs) whether it is GM only. */
  function fileEdit(f, opts, after) {
    hideTip();
    const caption = el('input', { value: f.caption || '', maxlength: 200, placeholder: 'e.g. Gunther, sketched by Ilse', 'aria-label': 'Caption' });
    const secret = isGM() ? el('input', { type: 'checkbox', checked: f.is_secret || opts.secret, disabled: !!opts.secret }) : null;
    const form = el('form', {}, el('h3', {}, `✎ ${f.name}`), field('Caption', caption),
      secret ? el('label', { class: 'inline small', 'data-tip': opts.secret ? 'Everything on a GM-only entry is GM only' : 'Only GMs will see this file' }, secret, ' 🔒 GM only') : null,
      el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Save'),
        el('button', { type: 'button', onclick: () => d.close() }, 'Cancel')));
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': `Change ${f.name}` }, form);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const body = { id: f.id, caption: caption.value.trim() };
      if (secret && !opts.secret) body.is_secret = secret.checked;
      try { await post('file_update', body, S.camp.id); d.close(); after?.(); toast('Saved'); opts.refresh(); } catch (err) { toast(err.message, true); }
    });
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    caption.focus();
  }
  /** A picture at full size, with the others on the page a step away (arrow keys too). It opens fitted to the window;
   * a click, + or a pinch on a trackpad zooms in where it points, so a big map can be read, and dragging (or a finger)
   * moves around it. */
  function fileViewer(pics, start, opts) {
    hideTip();
    let i = start;
    const img = el('img', { class: 'file-full', draggable: 'false' });
    const stage = el('div', { class: 'file-stage' }, img);
    const cap = el('p', { class: 'file-cap' });
    const zoomBar = el('div', { class: 'row file-zoom' });
    const tools = el('div', { class: 'row file-tools' });
    // zoom: 0 while fitted, else the picture's scale against its own pixels; fit: its scale when fitted
    let zoom = 0, fit = 1;
    const fitScale = () => fit;
    /** Zoom to scale z (0: fit), keeping the point at (cx, cy) on the screen, the stage's middle by default, still. */
    function zoomTo(z, cx, cy) {
      if (!img.naturalWidth) return;
      const before = img.getBoundingClientRect(), box = stage.getBoundingClientRect();
      cx ??= box.left + box.width / 2; cy ??= box.top + box.height / 2;
      const rx = (cx - before.left) / before.width, ry = (cy - before.top) / before.height;
      const max = Math.max(1, 16000 / Math.max(img.naturalWidth, img.naturalHeight));
      zoom = z > fit * 1.01 ? Math.min(z, max) : 0;
      stage.classList.toggle('zoomed', !!zoom);
      img.style.width = zoom ? `${Math.round(img.naturalWidth * zoom)}px` : '';
      if (zoom) {
        const after = img.getBoundingClientRect();
        stage.scrollLeft += after.left + rx * after.width - cx;
        stage.scrollTop += after.top + ry * after.height - cy;
      }
      drawZoom();
    }
    const step = k => zoomTo((zoom || fitScale()) * k);
    function drawZoom() {
      if (!img.naturalWidth) return zoomBar.replaceChildren();
      zoomBar.replaceChildren(...clean([
        btn('−', () => step(1 / 1.5), 'small', 'Zoom out (−)'),
        el('span', { class: 'small muted file-zoom-pct', 'aria-live': 'polite' }, `${Math.round((zoom || fitScale()) * 100)}%`),
        btn('+', () => step(1.5), 'small', 'Zoom in (+). You can also click the picture, or pinch'),
        zoom ? btn('Fit', () => zoomTo(0), 'small', 'Fit the whole picture in the window (0)') : null,
        zoom || fitScale() < 1 ? btn('1:1', () => zoomTo(1), 'small', 'Show the picture at its own size, a pixel for a pixel') : null]));
    }
    img.addEventListener('load', () => {
      zoom = 0; stage.classList.remove('zoomed'); img.style.width = '';
      fit = Math.min(1, img.getBoundingClientRect().width / img.naturalWidth || 1);
      drawZoom();
    });
    // a click zooms in to twice the fitted size (at least the picture's own) or back out; a drag with the mouse pans
    let drag = null;
    stage.addEventListener('pointerdown', ev => {
      if (ev.pointerType !== 'mouse' || ev.button !== 0 || !zoom) return;
      drag = { x: ev.clientX, y: ev.clientY, l: stage.scrollLeft, t: stage.scrollTop, moved: false };
      stage.setPointerCapture(ev.pointerId);
    });
    stage.addEventListener('pointermove', ev => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      stage.scrollLeft = drag.l - dx; stage.scrollTop = drag.t - dy;
    });
    stage.addEventListener('pointerup', () => { if (drag) setTimeout(() => { drag = null; }); });
    // on the stage, as a drag's pointer capture sends the click there
    stage.addEventListener('click', ev => {
      if (drag?.moved || !zoom && ev.target !== img) return;
      zoomTo(zoom ? 0 : Math.max(1, fitScale() * 2), ev.clientX, ev.clientY);
    });
    // a trackpad's pinch (and Ctrl with the wheel) zooms where it points, instead of the whole page
    stage.addEventListener('wheel', ev => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      zoomTo((zoom || fitScale()) * Math.exp(-ev.deltaY / 100), ev.clientX, ev.clientY);
    }, { passive: false });
    const show = () => {
      const f = pics[i];
      img.src = f.url; img.alt = f.caption || f.name; img.referrerPolicy = f.embed ? 'no-referrer' : '';
      cap.replaceChildren(...clean([opts.hidden(f) ? '🔒 ' : '', f.caption || f.name, f.embed ? null : el('small', { class: 'muted' }, ` · ${f.width && f.height ? `${f.width}×${f.height} · ` : ''}${fileSize(f.size)}`),
        f.credit ? creditLine(f) : null]));
      tools.replaceChildren(...clean([
        pics.length > 1 ? btn('‹', () => { i = (i + pics.length - 1) % pics.length; show(); }, 'small', 'Previous picture') : null,
        pics.length > 1 ? el('span', { class: 'small muted' }, `${i + 1} / ${pics.length}`) : null,
        pics.length > 1 ? btn('›', () => { i = (i + 1) % pics.length; show(); }, 'small', 'Next picture') : null,
        f.embed ? el('a', { class: 'button small', href: f.embed.url, target: '_blank', rel: 'noopener noreferrer' }, 'View on DeviantArt')
          : el('a', { class: 'button small', href: `${f.url}&dl=1`, download: f.name }, 'Download'),
        opts.mine(f) ? btn('✎ Caption', () => fileEdit(f, opts, () => d.close()), 'small') : null,
        opts.mine(f) ? btn('Remove', async () => { if (await fileDelete(f, opts)) d.close(); }, 'small danger') : null,
        btn('Close', () => d.close(), 'small primary')]));
    };
    const d = el('dialog', { class: 'kit-dialog file-viewer', 'aria-label': 'Picture' }, stage, zoomBar, cap, tools);
    d.addEventListener('keydown', ev => {
      if (ev.target.closest('input, textarea')) return;
      if (ev.key === '+' || ev.key === '=') step(1.5);
      if (ev.key === '-') step(1 / 1.5);
      if (ev.key === '0') zoomTo(0);
      if (pics.length < 2) return;
      if (ev.key === 'ArrowLeft') { i = (i + pics.length - 1) % pics.length; show(); }
      if (ev.key === 'ArrowRight') { i = (i + 1) % pics.length; show(); }
    });
    d.addEventListener('click', ev => { if (ev.target === d) d.close(); });
    d.addEventListener('close', () => d.remove());
    show();
    document.body.append(d);
    d.showModal();
  }

  // Connections between entries: London "Has resident" Gunther, Gunther "Resident of" London. Each relationship type
  // has a label for each end (one, for a type that reads the same both ways); the server never sends players a
  // connection that is GM only or touches a GM-only entry.
  /** Type t as seen from one end: side 'from' reads its label, 'to' its inverse. */
  const relLabel = (t, side) => t.symmetric || side === 'from' ? t.label : t.inverse_label;
  /** Each entry's connections, by id: [{ r, type, side, label, other }], other being the entry at the far end. */
  function connIndex(rel) {
    const types = new Map(rel.types.filter(t => t.id).map(t => [t.id, t]));
    const byId = new Map(rel.entries.map(e => [e.id, e]));
    const out = new Map(rel.entries.map(e => [e.id, []]));
    for (const r of rel.list) {
      const type = types.get(r.type_id), a = byId.get(r.from_id), b = byId.get(r.to_id);
      if (!type || !a || !b) continue;
      out.get(a.id).push({ r, type, side: 'from', label: relLabel(type, 'from'), other: b });
      out.get(b.id).push({ r, type, side: type.symmetric ? 'from' : 'to', label: relLabel(type, 'to'), other: a });
    }
    for (const list of out.values()) list.sort((x, y) => x.label.localeCompare(y.label) || x.other.name.localeCompare(y.other.name));
    return out;
  }
  /** Every way a connection can be read from the entry it is made on: both ends of each type, once for a symmetric one. */
  function relChoices(types) {
    return types.flatMap(t => t.symmetric ? [{ t, side: 'from' }] : [{ t, side: 'from' }, { t, side: 'to' }])
      .map(c => ({ ...c, key: `${c.t.id ?? `${c.t.label}|${c.t.inverse_label}`}:${c.side}`, label: relLabel(c.t, c.side), far: relLabel(c.t, c.side === 'from' ? 'to' : 'from') }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  /** Whether this member may remove or change connection r: whoever made it, and GMs. */
  const relMine = r => isGM() || r.created_by === S.user.id;

  /** The Connections card on entry e's page, grouped by label as seen from e, with the suggestions from the notes. */
  function connectionsCard(e, ctx) {
    const { rel, conns, entries, st } = ctx;
    if (!rel.ready) return null;
    const list = conns.get(e.id) || [];
    const groups = new Map();
    for (const c of list) {
      const k = `${c.type.id}:${c.side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const choiceKey = c => `${c.type.id}:${c.side}`;
    const rows = [...groups.values()].map(g => {
      const label = el('span', { class: 'chip enc-rel', 'data-tip': g[0].type.symmetric ? `${g[0].label}: reads the same from both ends`
        : `${g[0].label}. From the other end it reads "${relLabel(g[0].type, g[0].side === 'from' ? 'to' : 'from')}"` }, g[0].label);
      label.style.background = g[0].type.color;
      return el('div', { class: 'enc-conn-row' }, label,
        el('span', { class: 'enc-conn-names' }, g.map(c => {
          const secret = c.r.is_secret || c.other.is_secret || e.is_secret;
          return el('span', { class: 'enc-conn' + (secret ? ' secret' : ''), 'data-id': c.other.id },
            secret ? el('span', { 'data-tip': 'GM only: players never see this connection' }, '🔒 ') : null,
            el('a', { class: 'enc-link' + (c.other.is_secret ? ' secret' : ''), href: `#/c/${S.camp.id}/encyclopedia/${c.other.id}`,
              'data-tip': `${c.other.name}${c.other.is_secret ? ' (GM only)' : ''}: open it in the Encyclopedia` }, c.other.name),
            c.r.note ? el('small', { class: 'muted' }, ` (${c.r.note})`) : null,
            relMine(c.r) ? btn('×', async () => {
              if (!await confirmDialog(`Remove "${c.label} ${c.other.name}" from ${e.name}? It goes from both pages.`, { ok: 'Remove', danger: true })) return;
              try { await post('relation_delete', { id: c.r.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
            }, 'link small enc-conn-x', `Remove this connection from both pages`) : null);
        })),
        btn('✎', () => connectDialog(e, rel, { choice: choiceKey(g[0]) }), 'link small', `Add or remove ${g[0].label} connections`));
    });
    // Suggestions: entries named in these notes, or whose notes name this one, not yet connected to it.
    const linked = new Set(list.map(c => c.other.id));
    const ideas = Nouns.suggestions(e, entries, { gm: isGM() }).filter(x => !linked.has(x.other.id));
    const suggest = ideas.length ? el('details', { class: 'enc-suggest' },
      el('summary', { class: 'small' }, `Suggested connections (${ideas.length})`),
      el('p', { class: 'small muted' }, 'Entries named in these notes, or whose notes name this one. A line like "Residents: Gunther, Ilse" suggests the name too. Connect makes it a connection on both pages.'),
      el('ul', { class: 'enc-suggest-list' }, ideas.slice(0, 50).map(x => {
        const mine = x.writer.id === e.id;
        return el('li', { 'data-id': x.other.id },
          x.secret && isGM() ? el('span', { 'data-tip': 'Found in GM notes or touches a GM-only entry, so it would be GM only' }, '🔒 ') : null,
          el('a', { class: 'enc-link', href: `#/c/${S.camp.id}/encyclopedia/${x.other.id}` }, x.other.name),
          el('small', { class: 'muted' }, x.label ? ` · "${x.label}" in ${mine ? 'these notes' : `${x.other.name}'s notes`}` : mine ? ' · named in these notes' : ` · ${x.other.name}'s notes name ${e.name}`),
          ' ', btn('Connect…', () => connectDialog(mine ? e : x.other, rel, { label: x.label, tick: [mine ? x.other.id : e.id], secret: x.secret }), 'small',
            x.label ? `Connect them as "${x.label}"` : 'Pick how they are connected'));
      }))) : null;
    return el('section', { class: 'enc-conns' },
      el('div', { class: 'row spread' }, el('h4', {}, 'Connections', tip(`How ${e.name} is connected to other entries. Each connection shows on both pages, read from each end ("Has resident" here, "Resident of" there)`)),
        el('div', { class: 'row' },
          list.length ? btn('Show in list', () => { st.near = e.id; ctx.draw(); }, 'small', `List ${e.name} and the entries connected to it`) : null,
          btn('🔗 Link', () => connectDialog(e, rel), 'small primary', `Connect ${e.name} to one or more entries`))),
      rows.length ? el('div', { class: 'enc-conn-list' }, rows) : el('p', { class: 'muted small' }, 'No connections yet.'),
      suggest);
  }

  /** Josh's Link dialog: connect entry e to the entries ticked, with one relationship. preset: { choice } (a relChoices
   * key), { label } (a label to pick, or to start a new relationship with), tick (entry ids to tick), secret. */
  function connectDialog(e, rel, preset = {}) {
    hideTip();
    const cid = S.camp.id;
    const choices = relChoices(rel.types);
    const lower = s => String(s || '').toLowerCase();
    const start = preset.choice ? choices.find(c => c.key === preset.choice)
      : preset.label ? choices.find(c => lower(c.label) === lower(preset.label)) : choices.find(c => c.label === 'Related to') || choices[0];
    const pick = select([...choices.map(c => [c.key, c.t.symmetric ? `${c.label} (both ways)` : `${c.label} ↔ ${c.far}`]), ['new', '+ New connection…']],
      start ? start.key : 'new', { 'aria-label': `How ${e.name} is connected`, class: 'grow' });
    const mineIn = el('input', { maxlength: 40, value: !start && preset.label ? preset.label : '', placeholder: 'e.g. Has resident', 'aria-label': `New connection, as ${e.name} reads it` });
    const theirsIn = el('input', { maxlength: 40, placeholder: 'e.g. Resident of. Leave empty if it reads the same both ways', 'aria-label': 'New connection, as the other entries read it' });
    const fresh = el('div', { class: 'grid2 conn-new' }, field(`From ${e.name}'s side`, mineIn), field('From theirs', theirsIn, null, 'What the entries you tick show on their pages. Leave it empty if it reads the same both ways, like "Ally of"'));
    const choice = () => choices.find(c => c.key === pick.value) || null;
    const conns = connIndex(rel).get(e.id) || [];
    const linkedFor = c => new Set(c && c.t.id ? conns.filter(x => x.type.id === c.t.id && x.side === c.side).map(x => x.other.id) : []);
    let was = linkedFor(choice());
    const others = rel.entries.filter(x => x.id !== e.id).sort((a, b) => a.name.localeCompare(b.name));
    const search = el('input', { type: 'search', placeholder: 'Search entries', 'aria-label': 'Search entries to connect', class: 'grow' });
    const usedTags = tagsOf(others).sort((a, b) => a.name.localeCompare(b.name));
    const tagSel = select([['', 'All tags'], ...usedTags.map(t => [t.name.toLowerCase(), t.name])], '', { 'aria-label': 'Show entries with this tag' });
    const rows = others.map(x => {
      const box = el('input', { type: 'checkbox', checked: was.has(x.id) || (preset.tick || []).includes(x.id), 'aria-label': x.name });
      const already = el('small', { class: 'muted' });
      const row = el('label', { class: 'conn-row', 'data-id': x.id }, box,
        el('span', { class: 'grow' }, x.is_secret ? el('span', { 'data-tip': 'GM only' }, '🔒 ') : null, x.name),
        x.tags?.length ? el('span', { class: 'etags' }, x.tags.map(tagChip)) : null, already);
      return { x, box, row, already, hay: [...Nouns.namesOf(x), ...(x.tags || []).map(t => t.name)].join('\n').toLowerCase() };
    });
    const count = el('p', { class: 'small muted conn-count' });
    const note = el('input', { maxlength: 200, placeholder: 'e.g. since the flood', 'aria-label': 'Note on the new connections' });
    const secret = isGM() ? el('input', { type: 'checkbox', checked: !!preset.secret || !!e.is_secret, disabled: !!e.is_secret }) : null;
    const sync = () => {
      const c = choice();
      fresh.hidden = !!c;
      const far = c ? c.far : (theirsIn.value.trim() || mineIn.value.trim() || '…');
      const n = rows.filter(r => r.box.checked).length;
      for (const r of rows) r.already.textContent = was.has(r.x.id) ? (r.box.checked ? 'connected ✓' : 'will be removed') : '';
      const gone = rows.filter(r => !r.box.checked && was.has(r.x.id)).length;
      count.textContent = `${n} picked${gone ? `, ${gone} to remove` : ''}. Each will show "${far} ${e.name}" on its page.`;
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      for (const r of rows) r.row.hidden = !(words.every(w => r.hay.includes(w)) && (!tagSel.value || (r.x.tags || []).some(t => t.name.toLowerCase() === tagSel.value)));
    };
    pick.addEventListener('change', () => { was = linkedFor(choice()); for (const r of rows) r.box.checked = was.has(r.x.id); sync(); });
    for (const el_ of [search, mineIn, theirsIn]) el_.addEventListener('input', sync);
    tagSel.addEventListener('change', sync);
    for (const r of rows) r.box.addEventListener('change', sync);
    const form = el('form', {},
      el('h3', {}, `🔗 Connect ${e.name} to…`),
      el('div', { class: 'row' }, el('strong', {}, e.name), pick, el('span', { class: 'muted' }, 'the entries ticked')),
      fresh,
      el('div', { class: 'row' }, search, usedTags.length ? tagSel : null),
      el('div', { class: 'conn-list' }, others.length ? rows.map(r => r.row) : el('p', { class: 'muted small' }, 'There are no other entries yet.')),
      count,
      field('Note (optional)', note, null, 'A few words shown beside each new connection, on both pages'),
      secret ? el('label', { class: 'inline small', 'data-tip': e.is_secret ? `${e.name} is GM only, so its connections are too` : 'Only GMs will see these connections. Connections to a GM-only entry always are' }, secret, ' 🔒 GM only') : null,
      el('div', { class: 'kit-dialog-actions' },
        el('button', { class: 'primary', type: 'submit' }, 'Save connections'),
        el('button', { type: 'button', value: 'cancel', onclick: () => d.close() }, 'Cancel')));
    const d = el('dialog', { class: 'kit-dialog conn-dialog', 'aria-label': `Connect ${e.name}` }, form);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const c = choice();
      if (!c && !mineIn.value.trim()) { toast('Name the new connection', true); mineIn.focus(); return; }
      const add = rows.filter(r => r.box.checked && !was.has(r.x.id)).map(r => r.x.id);
      const remove = rows.filter(r => !r.box.checked && was.has(r.x.id)).map(r => r.x.id);
      if (!add.length && !remove.length) { d.close(); return; }
      const type = c ? (c.t.id ? { id: c.t.id } : { label: c.t.label, inverse_label: c.t.inverse_label, symmetric: c.t.symmetric })
        : { label: mineIn.value.trim(), inverse_label: theirsIn.value.trim() };
      const body = { entry_id: e.id, type, side: c ? c.side : 'from', add, remove, note: note.value.trim() };
      if (secret) body.is_secret = secret.checked;
      try {
        await post('relations_save', body, cid);
        d.close();
        toast([add.length ? `${add.length} connected` : '', remove.length ? `${remove.length} removed` : ''].filter(Boolean).join(' · '));
        if (S.camp?.id === cid) route();
      } catch (err) { toast(err.message, true); }
    });
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    sync();
    d.showModal();
    (start ? search : mineIn).focus();
  }

  /** GMs: the campaign's kinds of connection, to rename, recolour, merge or delete. */
  function relationKinds(rel) {
    const stored = rel.types.filter(t => t.id);
    if (!stored.length) return null;
    const used = new Map();
    for (const r of rel.list) used.set(r.type_id, (used.get(r.type_id) || 0) + 1);
    return el('details', { class: 'enc-kinds' },
      el('summary', { class: 'small' }, `Kinds of connection (${stored.length})`),
      el('p', { class: 'small muted' }, 'Rename a kind of connection here and every page using it changes. Merge moves its connections into another kind.'),
      stored.map(t => {
        const label = el('input', { value: t.label, maxlength: 40, 'aria-label': 'Label from the first end' });
        const inverse = el('input', { value: t.inverse_label, maxlength: 40, placeholder: 'Same both ways', 'aria-label': 'Label from the other end' });
        const color = el('input', { type: 'color', value: t.color, 'aria-label': 'Colour' });
        const into = select([['', 'Merge into…'], ...stored.filter(x => x.id !== t.id).map(x => [x.id, x.symmetric ? x.label : `${x.label} ↔ ${x.inverse_label}`])], '', { 'aria-label': `Merge ${t.label} into another kind` });
        const save = async body => { try { await post('relation_type_save', { id: t.id, ...body }, S.camp.id); route(); } catch (err) { toast(err.message, true); } };
        into.addEventListener('change', async () => {
          if (!into.value) return;
          if (await confirmDialog(`Move every "${t.label}" connection into "${into.selectedOptions[0].textContent}"?`, { ok: 'Merge' })) save({ merge_into: Number(into.value) });
          else into.value = '';
        });
        return el('div', { class: 'enc-kind row', 'data-id': t.id, 'data-label': t.label }, color, label, el('span', { class: 'muted' }, '↔'), inverse,
          el('small', { class: 'muted' }, `${used.get(t.id) || 0} used`),
          btn('Save', () => save({ label: label.value, inverse_label: inverse.value, symmetric: !inverse.value.trim(), color: color.value }), 'small'),
          into,
          btn('Delete', async () => {
            if (!await confirmDialog(`Delete "${t.label}" and its ${used.get(t.id) || 0} connection(s)?`, { ok: 'Delete', danger: true })) return;
            try { await post('relation_type_delete', { id: t.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
          }, 'small danger'));
      }));
  }

  /** The sentences across the campaign that name entry e, each with a button that puts it into the notes, so an entry the
   * detector added starts from what was written rather than from nothing. Quotes from GM-only text go to the GM notes. */
  function foundIn(e, pub, gm) {
    // folded once the entry has notes of its own (open for a blank one, whose quotes are what it's written from), with a count
    const head = el('summary', {}, 'Where it was found');
    const box = el('details', { class: 'enc-found', open: entryBlank(e) }, head, el('p', { class: 'muted small' }, 'Looking…'));
    api('encyclopedia_sources', { query: { cid: S.camp.id } }).then(({ sources }) => {
      const names = Nouns.namesOf(e), rows = [];
      for (const s of sources) {
        if (s.kind.startsWith('entry') && s.id === e.id) continue;
        const [label, to] = sourceLabel(s);
        for (const q of Nouns.excerpts(Nouns.plain(s.text, s.format), names).slice(0, 3)) {
          if (rows.length >= 30) break;
          const into = s.secret && gm ? gm : pub;
          rows.push(el('div', { class: 'enc-quote' }, el('blockquote', {}, `“${q}”`, ' ', el('a', { href: to, class: 'small muted' }, label)),
            btn(s.secret && gm ? 'Add to GM notes' : 'Add to notes', ev => { into.insertText(q); ev.currentTarget.disabled = true; }, 'small',
              s.secret && gm ? 'Put this sentence at the end of the GM notes' : 'Put this sentence at the end of the Public notes')));
        }
      }
      head.append(' ', el('span', { class: 'muted small' }, `(${rows.length})`));
      box.lastChild.replaceWith(rows.length ? el('div', { class: 'enc-quotes' }, rows) : el('p', { class: 'muted small' }, 'Nowhere yet.'));
    }).catch(() => box.lastChild.replaceWith(el('p', { class: 'muted small' }, 'Could not look that up just now.')));
    return box;
  }

  /** Generate Summary: looks the entry's name up on Wikipedia, only when pressed, and lists the matching articles with
   * their descriptions so a namesake (the Swiss Altdorf for the Empire's) can be passed over. The picked article's
   * summary goes at the end of the Public notes with a link to the article and its licence, CC BY-SA 4.0, which asks for
   * both. The browser asks Wikipedia itself, so index.html's connect-src lets the page reach en.wikipedia.org. */
  const WIKI = 'https://en.wikipedia.org';
  /** Fan wikis (static/fanwikis.js and api/fanwikis.php): a module of its own, used only while it is here. */
  const Fan = typeof FanWikis === 'undefined' ? null : FanWikis;
  const fanCtx = extra => ({ el, btn, api, extLink, cid: S.camp?.id, key: S.camp ? settings().fan_wiki : null, gm: isGM(),
    hint: S.camp ? `${S.camp.name} ${cal().name || ''}` : '', ...extra });
  const wikiPage = title => `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2C/g, ',')}`;
  async function wikiJson(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Wikipedia said ${res.status}`);
    return res.json();
  }
  const WIKI_API = params => `${WIKI}/w/api.php?${new URLSearchParams({ ...params, format: 'json', formatversion: 2, origin: '*' })}`;
  /** The meanings a disambiguation page lists, in its order: each bulleted line's first link to an article, with the
   * line as written. See also and everything after it, navigation boxes and links to missing pages are left out. */
  function wikiMeanings(html) {
    const body = new DOMParser().parseFromString(String(html || ''), 'text/html').body, out = [];
    for (const n of body.querySelectorAll('h2, li')) {
      if (n.tagName === 'H2') { if (/^see also$/i.test(n.textContent.trim())) break; continue; }
      if (n.closest('.navbox, .toc, .metadata, .hatnote, .mw-references-wrap')) continue;
      const a = [...n.querySelectorAll('a[href^="/wiki/"]')].find(x => x.closest('li') === n && !x.classList.contains('new'));
      const title = a?.getAttribute('title');
      if (!title || /^(Wiktionary|Special|File|Category|Help|Wikipedia|Template|Portal|Talk):/.test(title) || out.some(m => m.title === title)) continue;
      const line = n.cloneNode(true);
      line.querySelectorAll('ul, ol, sup').forEach(x => x.remove());
      out.push({ title, line: line.textContent.replace(/\s+/g, ' ').trim() });
    }
    return out.slice(0, 40);
  }
  function wikiSummary(name, pub) {
    const out = el('div', { class: 'enc-wiki-out', 'aria-live': 'polite' });
    const say = (...t) => out.replaceChildren(el('p', { class: 'muted small' }, ...t));
    const gone = () => say('Could not reach Wikipedia just now. Try again later.');
    /** A list of articles to pick from: [{ title, line, several }]. */
    const pickList = (intro, items) => out.replaceChildren(el('p', { class: 'muted small' }, intro),
      el('div', { class: 'enc-wiki-hits' }, items.map(h => el('button', { type: 'button', class: 'enc-wiki-hit', onclick: () => (h.several ? meanings(h.title) : show(h.title)),
        'data-tip': h.several ? `"${h.title}" has several meanings: list them` : `Show the summary of "${h.title}"` },
        el('strong', {}, h.title, h.several ? el('span', { class: 'enc-wiki-several' }, 'Several meanings') : null), h.line ? el('span', { class: 'muted small' }, h.line) : null))),
      el('div', { class: 'row' }, btn('None of these', () => out.replaceChildren(), 'link small')));
    async function search() {
      const q = name.value.trim();
      if (!q) return say('Give the entry a name first.');
      say('Looking…');
      try {
        const data = await wikiJson(WIKI_API({ action: 'query', generator: 'search', gsrsearch: q, gsrlimit: 5, prop: 'description|pageprops', ppprop: 'disambiguation', redirects: 1 }));
        const hits = (data.query?.pages || []).sort((a, b) => a.index - b.index);
        if (!hits.length) return say(`Wikipedia has no article matching "${q}".`);
        pickList('Which of these is it? Pick one to see its summary.', hits.map(h => ({ title: h.title, line: h.description, several: !!h.pageprops && 'disambiguation' in h.pageprops })));
      } catch { gone(); }
    }
    async function meanings(title) {
      say('Looking…');
      const vague = () => out.replaceChildren(el('p', { class: 'muted small' }, `"${title}" has several meanings on Wikipedia. Search with a more specific name, such as "${title} (place)", by changing the Name above.`),
        btn('Back', search, 'link small'));
      try {
        const data = await wikiJson(WIKI_API({ action: 'parse', page: title, prop: 'text', redirects: 1 }));
        const list = wikiMeanings(data.parse?.text);
        if (!list.length) return vague();
        pickList(`"${title}" has several meanings. Which one is it?`, list);
        out.querySelector('.row').append(btn('Back', search, 'link small'));
      } catch { vague(); }
    }
    async function show(title) {
      say('Looking…');
      try {
        const s = await wikiJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
        const text = String(s.extract || '').trim();
        if (s.type === 'disambiguation') return meanings(s.title || title);
        if (!text) return out.replaceChildren(el('p', { class: 'muted small' }, `Wikipedia has no summary for "${title}". Pick another.`), btn('Back', search, 'link small'));
        const url = wikiPage(s.title || title);
        out.replaceChildren(el('div', { class: 'enc-quote' },
          el('blockquote', {}, text, ' ', el('a', { href: url, target: '_blank', rel: 'noopener', class: 'small muted' }, `${s.title || title}, Wikipedia`)),
          el('div', { class: 'row' },
            btn('Add to notes', ev => { pub.insertText(text); pub.insertText('Source: ', { text: s.title || title, link: url }, ', Wikipedia, CC BY-SA 4.0'); ev.currentTarget.disabled = true; }, 'small',
              'Put this summary at the end of the Public notes, with a link to the article. Rewrite it as you like'),
            btn('Back', search, 'link small'))));
      } catch { gone(); }
    }
    return el('div', { class: 'enc-wiki' },
      btn('📚 Generate Summary', search, 'small', 'Look this name up on Wikipedia and add a short summary of the article to the Public notes, as a start for a real-world place, person or thing'),
      out);
  }

  function entryForm(e) {
    const name = el('input', { name: 'name', value: e.name || '', required: true, maxlength: 150, placeholder: 'e.g. The Grey Lady inn' });
    const aliases = el('input', { name: 'aliases', value: (e.aliases || []).join(', '), maxlength: 2000, placeholder: 'e.g. Hoffmann, the innkeeper' });
    const tags = tagPicker(e.tags || [], 'entry', S.encTags);
    const category = S.encCatsReady ? select([['', 'None'], ...ENC_CATEGORIES.map(([k, n, i]) => [k, `${i} ${n}`])], e.category || '', { name: 'category' }) : null;
    const secret = isGM() ? el('input', { type: 'checkbox', name: 'is_secret', checked: !!e.is_secret }) : null;
    const pub = RichText.editor({ text: e.notes || '', format: 'html', label: 'Public notes', placeholder: 'What the party knows: who or what it is, where, what happened there', secret: isGM(), mentions: encMentions() });
    const gm = isGM() ? RichText.editor({ text: e.gm_notes || '', format: 'html', label: 'GM notes', placeholder: 'Secrets, plans and the truth of it, for GMs only', mentions: encMentions() }) : null;
    const f = el('form', { class: 'enc-form' },
      el('h2', {}, e.id ? `Edit ${e.name}` : 'New entry'),
      el('div', { class: 'grid2' },
        field('Name', name),
        category ? field('Category', category, null, 'What kind of thing it is. The Encyclopedia lists entries by Category; use tags to tell entries of one Category apart') : null,
        field('Other names', aliases, null, 'Other ways the same thing is written, separated by commas. Each one links to this entry and is never offered by the detector'),
        secret ? field('GM only', secret, null, 'Players won\'t see this entry at all, or have its name linked') : null),
      // the notes straight under the name, where the writing is; tags, the quotes found elsewhere and Generate Summary after
      el('div', { class: 'notes-grid' },
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip('Everyone in the campaign can read these, and change them')), pub.node),
        gm ? el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 GM notes', tip('Only GMs ever see these. The server never sends them to players')), gm.node) : null),
      tags.node,
      e.id ? foundIn(e, pub, gm) : null,
      e.id ? wikiSummary(name, pub) : null,
      e.id && Fan ? Fan.summary(fanCtx({ name, pub })) : null,
      e.id ? attachmentsCard('encyclopedia', e.id, e.files || (e.files = []), { uploads: S.encUploads, secret: e.is_secret, name: e.name }) : null,
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, e.id ? 'Save entry' : 'Add entry'),
        e.id && !entryBlank(e) ? btn('Cancel', () => route(), 'small') : el('a', { class: 'button small', href: `#/c/${S.camp.id}/encyclopedia` }, 'Cancel')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const p = pub.value(), g = gm?.value();
      const body = { id: e.id, name: name.value, aliases: aliases.value.split(',').map(x => x.trim()).filter(Boolean), notes: p.text, tags: tags.get() };
      if (category) body.category = category.value;
      if (gm) Object.assign(body, { gm_notes: g.text, is_secret: secret.checked });
      try {
        const { id } = await post('entry_save', body, S.camp.id);
        for (const t of body.tags) if (!S.encTags.some(x => x.name.toLowerCase() === t.name.toLowerCase())) S.encTags.push(t);
        const was = S.encyclopedia.filter(x => x.id !== id);
        S.encyclopedia = [...was, { id, name: name.value.trim(), aliases: body.aliases, is_secret: !!secret?.checked, blank: !p.text && !g?.text, pic: S.encyclopedia.find(x => x.id === id)?.pic || null,
          preview: Nouns.plain(p.text, 'html').replace(/\s+/g, ' ').trim().slice(0, 140) }].sort((a, b) => a.name.localeCompare(b.name));
        toast('Entry saved');
        const to = `#/c/${S.camp.id}/encyclopedia/${id}`;
        if (location.hash === to) route(); else location.hash = to;
        offerNouns([{ text: p.text, format: 'html', secret: !!secret?.checked, label: 'Public notes' }, gm ? { text: g.text, format: 'html', secret: true, label: 'GM notes' } : null].filter(Boolean));
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ library tab
  // The campaign's books, journals and notes ("tomes"): a title, a short description and a long body in the same
  // word-processor editor as the day notes. Every member, GM or player, can add a tome and change any of them.
  const TOME_KINDS = [['book', 'Book', '📕'], ['journal', 'Journal', '📓'], ['note', 'Note', '📜']];
  const tomeKind = k => TOME_KINDS.find(x => x[0] === k) || TOME_KINDS[0];

  /** The Library tab: the tomes down the left, the one picked on the right. sel: a tome id, 'new', or nothing. */
  async function viewLibrary(sel) {
    if (!S.libReady) {
      return mount(...campaignHeader('library'), el('div', { class: 'card' }, el('h2', {}, 'Library'),
        el('p', {}, isGM() ? 'The Library needs a database upgrade first: open install.php on the server and press Install or upgrade.'
          : 'The Library isn\'t set up on this server yet. Ask whoever runs it to open install.php.')));
    }
    const [{ tomes }, one] = await Promise.all([api('library', { query: { cid: S.camp.id } }),
      sel && sel !== 'new' ? api('tome', { query: { cid: S.camp.id, id: sel } }).catch(() => null) : null]);
    const current = sel === 'new' ? { kind: 'book', title: '', description: '', body: '' } : one?.tome || null;
    if (one) S.libUploads = one.uploads;
    const st = vs().lib || (vs().lib = { q: '', kinds: new Set() });
    const href = id => `#/c/${S.camp.id}/library${id ? `/${id}` : ''}`;

    // --- the list
    const search = el('input', { type: 'search', value: st.q, placeholder: 'Search titles and descriptions', 'aria-label': 'Search the Library' });
    const kindRow = el('div', { class: 'tagpick' });
    const list = el('div', { class: 'lib-list' });
    const item = t => el('a', { class: 'enc-item lib-item' + (current?.id === t.id ? ' on' : ''), href: href(t.id), 'aria-current': current?.id === t.id ? 'page' : null },
      el('span', { class: 'enc-name' }, el('span', { 'aria-hidden': 'true' }, `${tomeKind(t.kind)[2]} `), t.title),
      t.description ? el('small', { class: 'lib-desc' }, t.description) : null);
    const draw = () => {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = tomes.filter(t => (!st.kinds.size || st.kinds.has(t.kind)) && words.every(w => `${t.title}\n${t.description}`.toLowerCase().includes(w)));
      list.replaceChildren(el('h3', {}, `Tomes (${shown.length}${shown.length !== tomes.length ? ` of ${tomes.length}` : ''})`),
        ...(shown.length ? shown.map(item) : [el('p', { class: 'muted small' }, tomes.length ? 'Nothing matches. Clear the search or the kinds to see more.'
          : 'The shelves are empty. Add a book, a journal or a note.')]));
      kindRow.replaceChildren(...TOME_KINDS.map(([k, label, icon]) => {
        const on = st.kinds.has(k), n = tomes.filter(t => t.kind === k).length;
        return el('button', { type: 'button', class: 'tagopt' + (on ? ' on' : ''), 'aria-pressed': String(on),
          'data-tip': on ? `Showing ${label.toLowerCase()}s. Click to stop filtering by it` : `Show only ${label.toLowerCase()}s`,
          onclick: () => { on ? st.kinds.delete(k) : st.kinds.add(k); draw(); } }, el('span', { class: 'tick', 'aria-hidden': 'true' }, on ? '✓ ' : ''), `${icon} ${label}s (${n})`);
      }));
    };
    search.addEventListener('input', () => { st.q = search.value; draw(); });
    draw();
    const left = el('section', { class: 'card enc-index' },
      el('div', { class: 'row spread' }, el('h2', {}, 'Library', tip('The campaign\'s books, journals and notes. Everyone in the campaign, GM or player, can add a tome and change any of them')),
        el('a', { class: 'button primary small', href: href('new'), 'data-tip': 'Add a book, a journal or a note' }, '+ New tome')),
      search, kindRow, list);

    // --- the tome picked
    const right = el('section', { class: 'card enc-detail lib-detail' });
    if (sel && sel !== 'new' && !current) right.append(el('p', { class: 'muted' }, 'That tome isn\'t in the Library any more.'));
    else if (!current) right.append(el('p', { class: 'muted' }, tomes.length ? 'Pick a tome to read it.' : 'Nothing on the shelves yet.'),
      el('p', { class: 'small muted' }, 'A tome is a book the party found, a character\'s journal, or a note passed across the table. Give it a title and a line about it, then write it out in full.'));
    else if (!current.id) right.append(tomeForm(current));
    else right.append(...tomeView(current));
    mount(...campaignHeader('library'), el('div', { class: 'enc-page' + (current || sel ? ' has-sel' : '') }, left, right));
  }

  function tomeView(t) {
    const [, label, icon] = tomeKind(t.kind);
    const canDelete = isGM() || t.created_by === S.user.id;
    const changed = t.editor && (t.editor !== t.author || t.updated_at !== t.created_at);
    return clean([
      el('div', { class: 'row spread' },
        el('h2', {}, t.title),
        el('div', { class: 'row' },
          btn('Edit', ev => ev.currentTarget.closest('.lib-detail').replaceChildren(tomeForm(t)), 'small primary', 'Change this tome. Anyone in the campaign can'),
          scanOneBtn('tome', s => s.kind === 'tome' && s.id === t.id, `"${t.title}"`),
          canDelete ? btn('Delete', async () => {
            if (!await confirmDialog(`Delete "${t.title}" from the Library?`, { ok: 'Delete', danger: true })) return;
            try { await post('tome_delete', { id: t.id }, S.camp.id); location.hash = `#/c/${S.camp.id}/library`; } catch (err) { toast(err.message, true); }
          }, 'small danger', 'Delete this tome and everything written in it') : null)),
      el('div', { class: 'lib-kind small' }, el('span', { 'aria-hidden': 'true' }, `${icon} `), label, t.words ? el('span', { class: 'muted' }, ` · ${t.words.toLocaleString()} word${t.words === 1 ? '' : 's'}`) : null),
      t.description ? el('p', { class: 'lib-blurb' }, t.description) : null,
      el('div', { class: 'lib-body' }, (t.body || '').trim() ? revealButtons(linkedNote(t.body, 'html'), 'tome', t.id) : el('p', { class: 'muted' }, 'Nothing written in it yet. Press Edit to start.')),
      tomeFiles(t),
      el('small', { class: 'muted' }, t.author ? ['Added by ', byline(t)] : 'Added', ` on ${t.created_at.slice(0, 10)}`,
        changed ? `; last changed by ${t.editor} on ${t.updated_at.slice(0, 10)}` : '')]);
  }

  /** A tome's pictures and files: anyone in the campaign adds them or takes them off, as with the tome itself. */
  const tomeFiles = t => attachmentsCard('library', t.id, t.files || (t.files = []), { uploads: S.libUploads, manageAny: true });

  function tomeForm(t) {
    const kind = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Kind of tome' }, TOME_KINDS.map(([k, label, icon]) =>
      el('label', {}, el('input', { type: 'radio', name: 'kind', value: k, checked: t.kind === k }), el('span', {}, `${icon} ${label}`))));
    const title = el('input', { name: 'title', value: t.title || '', required: true, maxlength: 200, placeholder: 'e.g. The Codex of Vitreous Night' });
    const desc = el('textarea', { name: 'description', rows: 2, maxlength: 1000, placeholder: 'A line or two: what it is, who wrote it, where it was found' }, t.description || '');
    const body = RichText.editor({ text: t.body || '', format: 'html', label: 'Contents', placeholder: 'Write out the tome: its chapters, entries, or the note itself', secret: isGM(), mentions: encMentions() });
    body.node.classList.add('rt-tall');
    const f = el('form', { class: 'enc-form lib-form' },
      el('h2', {}, t.id ? `Edit ${t.title}` : 'New tome'),
      el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Kind'), kind),
      field('Title', title),
      field('Description', desc, null, 'A short summary, shown under the title and in the Library list'),
      el('div', { class: 'notepanel public' }, el('h4', {}, 'Contents', tip('Everyone in the campaign can read and change this')), body.node),
      t.id ? tomeFiles(t) : el('p', { class: 'small muted' }, 'You can add pictures and files once the tome is saved.'),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, t.id ? 'Save tome' : 'Add tome'),
        t.id ? btn('Cancel', () => route(), 'small') : el('a', { class: 'button small', href: `#/c/${S.camp.id}/library` }, 'Cancel')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const b = body.value();
      const save = f.querySelector('button.primary');
      save.disabled = true;
      try {
        const { tome } = await post('tome_save', { id: t.id, version: t.version, kind: f.elements.kind.value, title: title.value, description: desc.value, body: b.text }, S.camp.id);
        toast(t.id ? 'Tome saved' : 'Added to the Library');
        const to = `#/c/${S.camp.id}/library/${tome.id}`;
        if (location.hash === to) route(); else location.hash = to;
        offerNouns([{ text: `${title.value}\n${desc.value}`, title: true, label: `tome "${tome.title}"` }, { text: b.text, format: 'html', label: `tome "${tome.title}"` }]);
      } catch (err) { toast(err.message, true); save.disabled = false; }
    });
    return f;
  }

  // ------------------------------------------------------------ sessions tab
  /** The Sessions tab: every game night, newest first, and the one picked: for GMs its notes beside the summary written
   * from them, with Build draft; for players the published summary. */
  async function viewSessions(sel) {
    const cid = S.camp.id;
    if (!S.sessionsReady) {
      return mount(...campaignHeader('sessions'), el('div', { class: 'card' }, el('h2', {}, 'Sessions'),
        el('p', {}, isGM() ? 'Sessions need a database upgrade first: open install.php on the server and press Install or upgrade.'
          : 'Sessions aren\'t set up on this server yet. Ask whoever runs it to open install.php.')));
    }
    const [{ sessions }, one] = await Promise.all([api('sessions', { query: { cid } }),
      sel ? api('session', { query: { cid, id: sel } }).catch(() => null) : null]);
    if (one) S.sessUploads = one.uploads;
    const href = id => `#/c/${cid}/sessions${id ? `/${id}` : ''}`;
    // The page can take the whole width: the sessions run across the top and the session picked gets the room, remembered in this browser.
    let wide = sessWide();
    const page = el('div', { class: 'enc-page sess-page' + (sel ? ' has-sel' : '') + (wide ? ' wide' : '') });
    const wideBtn = btn('', () => { wide = !wide; rememberSessWide(wide); setWide(); }, 'small enc-widebtn');
    const setWide = () => {
      page.classList.toggle('wide', wide);
      wideBtn.textContent = wide ? '⇤ Narrow view' : '⇥ Wide view';
      wideBtn.setAttribute('aria-pressed', String(wide));
      wideBtn.dataset.tip = wide ? 'Back to the list beside the session' : 'Give the session the whole width, with the list of sessions along the top';
    };
    setWide();
    const item = x => el('a', { class: 'enc-item sess-item' + (one?.session.id === x.id ? ' on' : ''), href: href(x.id), 'aria-current': one?.session.id === x.id ? 'page' : null },
      el('span', { class: 'enc-name' }, sessionName(x), x.last_day === null && isGM() ? el('span', { class: 'chip sess-open', 'data-tip': 'Not ended yet: its last day is still open' }, 'open') : null),
      el('small', { class: 'lib-desc' }, [x.played_on ? `Played ${x.played_on}` : null, Sessions.daysCovered(cal(), x),
        isGM() ? `${x.covered} of ${x.notes} notes covered` : null, isGM() && !x.is_published ? 'not published' : null].filter(Boolean).join(' · ')));
    const add = isGM() ? btn('+ Session', busy(null, async () => {
      const r = await post('session_save', {}, cid);
      S.openSession = r.session;
      location.hash = href(r.session.id);
    }), 'primary small', 'Start a session on the campaign\'s current day, then take your notes in it') : null;
    const left = el('section', { class: 'card enc-index' },
      el('div', { class: 'row spread' }, el('h2', {}, 'Sessions', tip(isGM()
        ? 'Each game night: your running notes, and the summary you write from them afterwards. Players read a summary once you publish it'
        : 'A summary of each game night, as the GM writes it up')), el('div', { class: 'row' }, add, wideBtn)),
      el('div', { class: 'lib-list' }, sessions.length ? sessions.map(item)
        : el('p', { class: 'muted small' }, isGM() ? 'No sessions yet. Press + Session, then take your notes in it.' : 'No session summaries published yet.')));
    const right = el('section', { class: 'card enc-detail sess-detail' });
    if (sel && !one) right.append(el('p', { class: 'muted' }, 'That session isn\'t here any more.'));
    else if (!one) right.append(el('p', { class: 'muted' }, sessions.length ? 'Pick a session to read it.' : 'Nothing here yet.'));
    else right.append(...clean(sessionPage(one.session, one.notes || [], sessions)));
    page.append(left, right);
    mount(...campaignHeader('sessions'), page);
  }
  const SESS_WIDE_KEY = 'chronicle:sesswide';
  function sessWide() {
    try { return localStorage.getItem(SESS_WIDE_KEY) === '1'; } catch { return false; }
  }
  function rememberSessWide(on) {
    try { on ? localStorage.setItem(SESS_WIDE_KEY, '1') : localStorage.removeItem(SESS_WIDE_KEY); } catch { /* private mode: just this page */ }
  }

  function sessionPage(s, notes, sessions) {
    const cid = S.camp.id, gm = isGM();
    const withNotes = gm ? el('input', { type: 'checkbox' }) : null;
    const exportBtn = btn('⬇ Export', () => {
      const md = Sessions.markdown({ cal: cal(), session: { ...s, ...(gm ? { summary: editor.value().text, ...(rewards ? { rewards: rewards.value().text, loot: loot.value().text } : {}) } : {}) }, notes, gm,
        withNotes: !!withNotes?.checked, toMarkdown: RichText.toMarkdown });
      const a = el('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: Sessions.fileName(s) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }, 'small', 'Download this session as a Markdown file to paste into Scabard or another wiki. It holds only what you can see here');
    // maps, handouts and sketches from the night: GMs add them, players see them once the session is published
    const pictures = gm || s.files?.length ? attachmentsCard('session', s.id, s.files || (s.files = []), { uploads: S.sessUploads, gmAdds: true,
      empty: 'No pictures or files yet. Add a map, a handout or a sketch of the scene.' }) : null;
    const head = [el('h2', {}, sessionName(s)),
      el('p', { class: 'small muted' }, [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · '))];
    if (!gm) {
      return [head[0], el('div', { class: 'row sess-bar' }, head[1], el('span', { class: 'sess-bar-gap' }), exportBtn),
        el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
        ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
          el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))), pictures];
    }

    // --- details: title, date played, publishing, open or ended
    const title = el('input', { value: s.title, maxlength: 200, placeholder: `Session ${s.number}` });
    const played = el('input', { type: 'date', value: s.played_on || '' });
    const pub = el('input', { type: 'checkbox', checked: s.is_published,
      onchange: async ev => {
        try {
          await post('session_save', { id: s.id, is_published: ev.target.checked }, cid);
          s.is_published = ev.target.checked;
          toast(s.is_published ? 'Published for players' : 'Hidden from players again');
        } catch (err) { ev.target.checked = !ev.target.checked; toast(err.message, true); }
      } });
    const openClose = s.last_day === null
      ? btn('End session', busy(null, async () => { await post('session_end', { id: s.id }, cid); S.openSession = null; route(); }), 'small', 'Close this session at the campaign\'s current day, so its dates show the days it covered')
      : btn('Reopen', busy(null, async () => { const r = await post('session_save', { id: s.id, reopen: true }, cid); S.openSession = r.session; route(); }), 'small',
        'Open this session again, so its last day is no longer fixed. Any other open session ends');
    const del = btn('Delete session', async () => {
      if (!await confirmDialog(`Delete ${sessionName(s)} with its notes and summary?`, { ok: 'Delete', danger: true })) return;
      try {
        await post('session_delete', { id: s.id }, cid);
        if (S.openSession?.id === s.id) S.openSession = null;
        location.hash = `#/c/${cid}/sessions`;
      } catch (err) { toast(err.message, true); }
    }, 'small danger', 'Delete this session, its notes and its summary');
    // Title and Played on are set once, so they fold behind ✎ Details (open while the session has no title), and the one
    // Save under the summary saves them with everything else; the rest of
    // what's done to a session, rather than written in it, waits in the ⋯ menu. The summary is left the room under the title.
    const details = el('div', { class: 'sess-fields', hidden: !!s.title },
      el('div', { class: 'sess-fields-row' }, field('Title', title), field('Played on', played, null, 'The real-world date of the game night')));
    const detailsBtn = btn('✎ Details', () => {
      details.hidden = !details.hidden; detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
      showSave();
    },
      'small', 'Change the title and the date you played');
    detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
    const more = el('details', { class: 'sess-more' }, el('summary', { class: 'button small', 'aria-label': 'More', title: 'End or reopen, export with notes, delete' }, '⋯'),
      el('div', { class: 'sess-more-list' }, openClose,
        el('label', { class: 'inline small', 'data-tip': 'Add your notes to the file, as a list under the summary' }, withNotes, ' Include notes in Export'), del));
    document.addEventListener('click', ev => { if (more.open && !more.contains(ev.target)) more.open = false; });
    const bar = el('div', { class: 'row sess-bar' }, head[1],
      el('label', { class: 'inline sess-pub', 'data-tip': 'Players can read the summary (never your notes or its GM-only paragraphs) once it is published' }, pub, ' Published'),
      el('span', { class: 'sess-bar-gap' }), detailsBtn, exportBtn, more);

    // --- the notes, each ticked once the summary covers it
    const notesHead = el('h3', {});
    const notesList = el('div', { class: 'snotes' });
    const others = sessions.filter(x => x.id !== s.id);
    const opts = { onChange: () => reloadNotes(), notes: () => notes, tick: true, move: others, onTick: () => countNotes() };
    const countable = () => notes.filter(n => Sessions.mark(n.text) !== '>');
    const countNotes = () => notesHead.replaceChildren('Notes ', el('span', { class: 'muted small' }, `${countable().filter(n => n.is_covered).length} of ${countable().length} covered`),
      tip('Your notes from the game. Tick one once the summary covers it, so you can see what\'s left. Build draft ticks the ones it uses'));
    const drawNotes = () => {
      countNotes();
      notesList.replaceChildren(...(notes.length ? snoteList(notes, opts) : [el('p', { class: 'muted small' }, 'No notes in this session.')]));
    };
    async function reloadNotes() {
      try { notes = (await api('session', { query: { cid, id: s.id } })).notes || []; } catch (err) { toast(err.message, true); }
      drawNotes();
    }
    drawNotes();

    // --- the summary
    const editor = RichText.editor({ text: s.summary || '', format: 'html', label: 'Summary', placeholder: 'What happened this session, for the players to read',
      secret: true, mentions: encMentions() });
    editor.node.classList.add('rt-tall');
    // Session Rewards and Loot Found, under the summary (their columns come with install.php's upgrade)
    const hasExtras = 'rewards' in s;
    const rewards = hasExtras ? RichText.editor({ text: s.rewards || '', format: 'html', label: 'Session Rewards', secret: true, mentions: encMentions(),
      placeholder: 'What the party earned: experience, favours, standing, story rewards' }) : null;
    rewards?.node.classList.add('rt-small');   // a few lines each, side by side
    const loot = hasExtras ? RichText.editor({ text: s.loot || '', format: 'html', label: 'Loot Found', secret: true, mentions: encMentions(),
      placeholder: 'The coin, items and treasure the party found' }) : null;
    loot?.node.classList.add('rt-medium');
    const draft = btn('Build draft', async () => {
      const html = Sessions.draftHtml(cal(), notes);
      if (!html) return toast('Nothing to draft: every note is a ! aside or a time jump', true);
      let append = false;
      if (editor.value().text) {
        const v = await KIT.dialog({ message: 'The summary already has writing in it. Replace it with the draft, or add the draft below it?', buttons: [
          { value: 'add', label: 'Add below', cls: 'primary', focus: true }, { value: 'replace', label: 'Replace', cls: 'danger' }, { value: '', label: 'Cancel' }] });
        if (!v) return;
        append = v === 'add';
      }
      editor.setHtml(html, append);
      for (const n of notes) {
        const k = Sessions.mark(n.text);
        if (k === '!' || k === '>' || n.is_covered) continue;
        try { await post('snote_save', { id: n.id, is_covered: true }, cid); n.is_covered = true; } catch (err) { toast(err.message, true); break; }
      }
      drawNotes();
    }, 'small', 'Fill the summary from your notes: a paragraph per note with its indented lines, a heading per day, ! lines left out and ? lines listed GM only at the end. Then rewrite it as you like');
    // The GM reads the session as players do, with the Encyclopedia's names linked (and the GM-only paragraphs marked),
    // and Edit opens the editors. A session with nothing written yet opens in them.
    const reading = el('div', { class: 'sess-read' });
    const drawReading = () => reading.replaceChildren(
      el('div', { class: 'lib-body' }, (s.summary || '').trim() ? linkedNote(s.summary, 'html') : el('p', { class: 'muted' }, 'Nothing written yet.')),
      ...[['rewards', 'Session Rewards'], ['loot', 'Loot Found']].filter(([k]) => (s[k] || '').trim()).map(([k, title]) =>
        el('div', { class: 'sess-extra', 'data-box': k }, el('h3', {}, title), el('div', { class: 'lib-body' }, linkedNote(s[k], 'html')))));
    const editing = el('div', { class: 'sess-editing' });
    const edit = btn('✎ Edit', () => setEditing(true), 'small', 'Open the summary, rewards and loot in editors to change them');
    const cancel = btn('Cancel', () => {
      editor.setHtml(s.summary || ''); rewards?.setHtml(s.rewards || ''); loot?.setHtml(s.loot || '');
      setEditing(false);
    }, 'small', 'Close the editors without saving what was changed in them');
    function setEditing(on) {
      editing.hidden = !on; reading.hidden = on;
      edit.hidden = on; draft.hidden = cancel.hidden = !on;
      showSave();
      if (!on) drawReading();
    }
    // the one Save is there while the editors or the title and date played are open
    const showSave = () => { save.hidden = editing.hidden && details.hidden; };
    // what the editors held when the page opened or last saved, so Save sends the writing only when it has changed
    const writing = () => ({ summary: editor.value().text, ...(hasExtras ? { rewards: rewards.value().text, loot: loot.value().text } : {}) });
    let savedWriting = null;
    RichText.load().then(() => { savedWriting ??= writing(); }).catch(() => {});   // once the editors have it, as they tidy it
    const save = btn('Save', null, 'primary small', 'Save everything changed on this page: the title and date played, the summary, rewards and loot. Players read them once the session is published');
    save.addEventListener('click', busy(save, async () => {
      // the writing first: when it was saved elsewhere meanwhile nothing is saved, rather than half of it
      const written = writing();
      if (!savedWriting || JSON.stringify(written) !== JSON.stringify(savedWriting)) {
        const r = await post('session_summary_save', { id: s.id, version: s.version, ...written }, cid);
        s.version = r.session.version; s.summary = r.session.summary; s.rewards = r.session.rewards; s.loot = r.session.loot;
        savedWriting = written;
        // names added from the detector's dialog are linked in the summary as read, and in the notes
        offerNouns([{ text: s.summary, format: 'html', label: `${sessionName(s)}'s summary` },
          ...(hasExtras ? [{ text: s.rewards, format: 'html', label: `${sessionName(s)}'s rewards` }, { text: s.loot, format: 'html', label: `${sessionName(s)}'s loot` }] : [])])
          .then(() => { drawReading(); drawNotes(); });
      }
      const t = title.value.trim().replace(/\s+/g, ' '), on = played.value || null;
      if (t !== (s.title || '') || on !== (s.played_on || null)) {
        const r = await post('session_save', { id: s.id, title: t, played_on: on }, cid);
        Object.assign(s, { title: r.session.title, played_on: r.session.played_on });
        // the heading, the date line and the session's name in the list, redrawn in place so nothing typed is lost
        head[0].textContent = sessionName(s);
        head[1].textContent = [s.played_on ? `Played ${s.played_on}` : null, Sessions.daysCovered(cal(), s)].filter(Boolean).join(' · ');
        const inList = document.querySelector('.sess-item.on .enc-name');
        if (inList?.firstChild?.nodeType === Node.TEXT_NODE) inList.firstChild.textContent = sessionName(s);
        if (s.title) { details.hidden = true; detailsBtn.setAttribute('aria-expanded', 'false'); }
      }
      setEditing(false);
      toast('Saved');
    }));

    // the summary is the wide column, the notes beside it; a phone shows one at a time, the summary first once there is one
    const cols = el('div', { class: 'sess-cols', 'data-show': (s.summary || '').trim() ? 'summary' : 'notes' });
    const tabBtn = (key, label) => btn(label, () => { cols.dataset.show = key; }, 'small', `Show the ${label.toLowerCase()}`);
    cols.append(el('div', { class: 'sess-tabs row' }, tabBtn('summary', 'Summary'), tabBtn('notes', 'Notes')),
      el('div', { class: 'sess-notes' }, notesHead, notesEntry(s, () => notes, () => reloadNotes()), notesList),
      el('div', { class: 'sess-summary' },
        el('div', { class: 'row sess-sumhead' }, el('h3', {}, 'Summary', tip('What you write up from the notes. GM-only paragraphs (🔒) never reach players')),
          el('div', { class: 'row' }, edit, draft, cancel, save)),
        reading,
        editing));
    editing.append(editor.node,
        hasExtras ? el('div', { class: 'sess-extras' },
          el('div', {}, el('h3', {}, 'Session Rewards', tip('What the party earned this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), rewards.node),
          el('div', {}, el('h3', {}, 'Loot Found', tip('The coin, items and treasure found this session. Players read it once the session is published; GM-only paragraphs (🔒) never reach them')), loot.node))
          : el('p', { class: 'muted small' }, 'Open install.php on the server and press Install or upgrade to add Session Rewards and Loot Found.'));
    setEditing(![s.summary, s.rewards, s.loot].some(t => (t || '').trim()));
    // the notes box starts small and grows with what's typed in it, up to half the window
    const nbox = cols.querySelector('.snote-box');
    const grow = () => { nbox.style.height = 'auto'; nbox.style.height = `${Math.min(nbox.scrollHeight + 2, innerHeight / 2)}px`; };
    for (const e of ['input', 'keyup', 'focus']) nbox?.addEventListener(e, grow);
    if (nbox?.value) requestAnimationFrame(grow);
    return [head[0], bar, details, cols, pictures];
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
      ['hyperspace', 'Hyperspace (Star Wars hyperdrive)'],
    ].filter(([k]) => E.GENRE_MODES[genre].includes(k));
    const modeSel = select(modes, 'overland', { class: 'travel-mode' });
    const fieldsWrap = el('div', { class: 'grid2' });
    // One Metric / Imperial choice for every distance and speed box below; the maths itself always runs in km.
    const startUnits = unitSystem();
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
        const perDay = select([...Array.from({ length: n }, (_, i) => [i + 1, `${i + 1} ${w}${i ? 's' : ''}`]), ['auto', `Determine ${w}s`]],
          m === 'sea' ? n : hourMode() ? Math.min(8, n) : n === 2 ? 1 : 2, { name: 'shifts' });
        const hh = `${+h.toFixed(2)} h each. `;
        const perDayHint = hourMode() ? (m === 'sea' ? `Ships with a crew on watch sail all ${n}` : m === 'overland' ? 'About 8 is a normal day' : `${n} keeps going around the clock`)
          : n === 2 ? hh + (m === 'sea' ? 'Ships with a crew on watch sail both' : m === 'overland' ? '1 is a normal day' : '2 keeps going around the clock')
          : hh + (m === 'sea' ? 'Ships with a crew on watch sail all 4' : m === 'overland' ? '2 is a normal day, 3 a forced march' : '4 keeps going around the clock');
        F.push(field('Sample speed', samples, 'Real-world figures, each from a source listed on the About page. Fills in the speed'),
          field(`Distance (${imp() ? 'miles' : 'km'})`, dist),
          field(`Speed (${speedUnit})`, speed),
          field(`${Word()}s traveled per day`, perDay, perDayHint,
            (hourMode() ? `How many of the calendar's ${n} hours a day the party is on the move. They rest for the others`
              : `A shift is ${n === 2 ? 'half' : 'a quarter'} of the calendar's ${dayH}-hour day. The party rests for the other${n === 2 ? '' : ' shifts'}`)
              + `. Determine ${w}s instead works out how many ${w}s of travel the trip needs, a part ${w} counting as a whole one, and passes just those`),
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
      } else if (m === 'hyperspace') {
        const base = el('input', { name: 'base_hours', type: 'number', step: 'any', min: 0, value: 96 });
        const trips = samplePicker(E.HYPER_TRIPS.map(g => ({ group: g.group, items: g.items.map(([label, h]) => ({ label, h })) })),
          i => { base.value = i.h; }, i => `${i.label}: ${E.fmtDuration(i.h)}`);
        trips.selectedIndex = 6;
        base.addEventListener('input', () => { trips.value = ''; });
        F.push(field('Sample trip', trips, 'Fills in the trip time. The app\'s own guide, as the films leave trip times loose'),
          field('Trip time at Class 1 (hours)', base, 'How long a Class 1 hyperdrive takes on a main hyperlane'),
          field('Hyperdrive class', select(E.HYPERDRIVE_CLASSES, 1, { name: 'hyperdrive_class' }), null,
            'The class multiplies the trip time: Class 2 takes twice as long as Class 1, Class 0.5 half as long'),
          field('Route', select(E.HYPER_ROUTES, 1, { name: 'route' }), null,
            'Main hyperlanes are mapped and fast. Off them, the navicomputer plots shorter, more careful jumps'));
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
      field('Mode', modeSel, `Modes for a ${E.GENRES[genre]} campaign. Change the genre on the Settings tab.`, `Overland, sea and air: distance ÷ speed, travelling some of the day's ${hourMode() ? 'hours' : spd() === 2 ? 'two shifts' : 'four shifts'}. Orbital transfer: the slow, fuel-saving path between two orbits. Constant thrust: accelerate to the midpoint, flip, decelerate. Relativistic: the same, with ship time slowing near light speed. FTL: your setting's jump drive. Hyperspace: a Star Wars trip time, scaled by the hyperdrive's class and the route.`),
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
          el('h3', {}, result.shifts ? `${result.shifts} ${result.word}${result.shifts === 1 ? '' : 's'} of travel` : `Travel time: ${E.fmtDuration(result.hours)}`, result.worldHours ? ' (ship time)' : ''),
          el('ul', {}, result.lines.map(l => el('li', {}, l))),
          result.worldHours ? el('p', { class: 'muted' }, 'The tracker follows the party, so it advances by ship time unless you pick world time below.') : null),
          isGM() ? departForm() : el('p', { class: 'muted' }, 'Only the GM can advance time.'));
      } catch (err) { out.replaceChildren(el('p', { class: 'bad' }, err.message)); }
    });

    /** Add names to a day's Locations visited, after what is there and skipping any it already lists. */
    const addLocations = async (d, names) => {
      names = names.map(x => x.trim()).filter(Boolean);
      if (!names.length) return;
      const cur = ((await api('day', { query: { cid: S.camp.id, d } })).day?.locations || '').trim();
      const have = new Set(cur.split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean));
      const add = names.filter(x => !have.has(x.toLowerCase()) && have.add(x.toLowerCase()));
      if (add.length) await post('day_update', { abs_day: d, locations: [cur, ...add].filter(Boolean).join(', ') }, S.camp.id);
    };
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
        // From joins the departure day's Locations visited and To the arrival day's (one day's list for a same-day trip).
        await addLocations(startDay, [fromName.value]);
        await addLocations(today(), [toName.value]);
        vs().anchor = today();
        await post('event_save', { abs_day: startDay, end_day: today() > startDay ? today() : null, shift: null,
          title: `${label}`, body: result.lines.join('\n'), is_secret: false, tags: [{ name: 'Transit' }] }, S.camp.id);
        toast(`Arrived: ${E.fmtShift(cal(), nowShift())}`);
        location.hash = `#/c/${S.camp.id}/calendar`;
      }));
      return el('div', { class: 'depart' }, el('h3', {}, 'Make the trip'),
        el('div', { class: 'grid2' }, field('From', fromName), field('To', toName),
          field('Region while travelling', travelReg.node, 'e.g. "Ship interior" so transit days get shipboard conditions'),
          field('Region on arrival', arriveReg.node, null, 'The party is moved here when the trip ends'),
          result.worldHours ? field('Advance by outside-world time instead', useWorld, null, 'Near light speed, less time passes on board than back home. Tick this to move the clock by the longer, outside time') : null),
        info, el('div', { class: 'row' }, go),
        el('small', { class: 'muted' }, `Labels every passed ${word()} with the trip (without overwriting existing activity), logs a multi-day travel event, and adds From to the first day's Locations visited and To to the last day's.`));
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
        field('Artificial light per shift (0–5)', lightLv, 'Used when Light source is Artificial', LIGHT_TIP),
        (cal().moons || []).some(E.isRedMoon) ? field('Red Moon seen as from', select(E.RED_MOON_BANDS.map(([k, l]) => [k, l]), s.moon_shift ?? 0, { name: 'moon_shift' }), null,
          'The Red Moon shows a different phase to each land at the same moment, the phases sweeping round it. Pick the land this region is in, or nearest to') : null),
      customWrap, builder, baselineWrap,
      field('Description', el('textarea', { name: 'description', rows: 2, value: r.description || '' })),
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, 'Save region'), btn('Cancel', () => f.remove(), 'small')));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(f);
      const settingsOut = { climate: v.climate, hemisphere: v.hemisphere, lighting: v.lighting, terrain_mod: Number(v.terrain_mod),
        light_levels: [0, 1, 2, 3].map(i => Math.max(0, Math.min(5, Number(v[`lv${i}`]) || 0))),
        ...(v.moon_shift !== undefined ? { moon_shift: v.moon_shift === 'full' ? 'full' : Number(v.moon_shift) || 0 } : {}) };
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
  /** "Last", "2nd to last"… for a negative n, "1st", "2nd"… otherwise. */
  const nthLabel = n => (n === -1 ? 'last' : n < -1 ? `${E.ordinal(-n)} to last` : E.ordinal(n));
  const hasYear = v => v !== undefined && v !== null && v !== '';
  function describeRule(r) {
    const c = cal(); r = r || {};
    const span = Number(r.span) > 1 ? ` for ${r.span} days` : '';
    const mname = c.months[r.month]?.name || '?';
    const every = Math.max(1, Number(r.every_years) || 1);
    const often = every > 1 ? `Every ${every} years` : 'Every year';
    // limits: "5 times from 1420", "from 1420 to 1430", "until 1430"
    const from = hasYear(r.from_year) ? E.yearLabel(c, Number(r.from_year)) : '', until = hasYear(r.until_year) ? E.yearLabel(c, Number(r.until_year)) : '';
    const limit = [Number(r.times) > 0 ? `${r.times} time${Number(r.times) === 1 ? '' : 's'}` : '',
      from && until ? `from ${from} to ${until}` : from ? `from ${from}` : until ? `until ${until}` : ''].filter(Boolean).join(' ');
    const tail = `${span}${limit ? `, ${limit}` : ''}`;
    if (r.type === 'fixed') return `${often}: ${r.day} ${mname}${tail}`;
    if (r.type === 'nth_weekday') return `${often}: ${nthLabel(Number(r.n))} ${c.weekdays[r.weekday] || '?'} of ${mname}${tail}`;
    if (r.type === 'once') return `Once: ${E.fmtDate(c, Number(r.abs_day))}${span}`;
    if (r.type === 'every_n') return `Every ${r.interval} days from ${E.fmtDate(c, Number(r.start), { noWeekday: true })}${tail}`;
    if (r.type === 'moon_phase') {
      const moon = (c.moons || [])[Number(r.moon) || 0]?.name || '?', ph = (E.MOON_PHASES[Number(r.phase)] || ['?'])[0];
      const inMonth = hasYear(r.month) && Number(r.month) >= 0 ? ` in ${mname}` : '';
      return `Every ${ph.toLowerCase()} ${ph === 'New' || ph === 'Full' ? 'moon' : ''} of ${moon}${inMonth}${tail}`.replace(/\s+/g, ' ');
    }
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
    const fromAbsYear = () => E.fromAbs(c, today()).year;
    // Nth weekday needs weeks; offered on a calendar without any only to keep a rule it already has
    const hasWeeks = c.weekdays.length > 0 || r.type === 'nth_weekday';
    // likewise moon phases need a moon
    const hasMoons = (c.moons || []).length > 0 || r.type === 'moon_phase';
    const type = select([['fixed', 'Same date every year'], ...(hasWeeks ? [['nth_weekday', 'Nth weekday of a month']] : []), ['once', 'One time only'], ['every_n', 'Every N days'],
      ...(hasMoons ? [['moon_phase', 'Moon phase']] : [])], r.type, { name: 'type' });
    const monthSel = select(c.months.map((m, i) => [i, m.name]), r.month ?? 0, { name: 'month' });
    const moonSel = select((c.moons || []).map((m, i) => [i, m.name]), r.moon ?? 0, { name: 'moon' });
    const phaseSel = select(E.MOON_PHASES.map(([label, icon], i) => [i, `${icon} ${label}`]), r.phase ?? 4, { name: 'phase' });
    const moonMonthSel = select([[-1, 'Any month'], ...c.months.map((m, i) => [i, m.name])], r.type === 'moon_phase' && hasYear(r.month) ? r.month : -1, { name: 'moon_month' });
    const dayIn = el('input', { type: 'number', min: 1, name: 'day', value: r.day || 1 });
    const wdSel = select(c.weekdays.map((w, i) => [i, w]), r.weekday ?? 0, { name: 'weekday' });
    // as many as a weekday can fall in the longest month: 5 for a 7-day week, 4 for an 8-day one, more for short weeks
    const maxN = Math.max(1, E.maxWeekdaysInMonth(c), Number(r.n) || 0);
    const nSel = select([...Array.from({ length: maxN }, (_, i) => [i + 1, E.ordinal(i + 1)]), ...Array.from({ length: maxN - 1 }, (_, i) => [-1 - i, nthLabel(-1 - i)[0].toUpperCase() + nthLabel(-1 - i).slice(1)])], r.n ?? 1, { name: 'n' });
    const everyIn = el('input', { type: 'number', min: 1, name: 'every_years', value: r.every_years || 1 });
    const limitSel = select([['', 'Forever'], ['years', 'Between two years'], ['times', 'A set number of times']],
      Number(r.times) > 0 ? 'times' : hasYear(r.from_year) || hasYear(r.until_year) ? 'years' : '', { name: 'limit' });
    const fromIn = el('input', { type: 'number', name: 'from_year', value: r.from_year ?? '', placeholder: String(fromAbsYear()) });
    const untilIn = el('input', { type: 'number', name: 'until_year', value: r.until_year ?? '' });
    const eraHint = E.eraList(c).length ? 'The calendar year, not the year in an era' : null;
    const timesIn = el('input', { type: 'number', min: 1, name: 'times', value: r.times || 3 });
    const oncePick = datePicker(r.abs_day ?? today()), startPick = datePicker(r.start ?? today());
    const interval = el('input', { type: 'number', min: 1, name: 'interval', value: r.interval || 30 });
    const parts = {
      month: field('Month', monthSel), day: field('Day', dayIn), weekday: field('Weekday', wdSel, `${E.weekLength(c)} days a week`), n: field('Which one', nSel),
      once: field('Date', oncePick), start: field('First occurrence', startPick), interval: field('Repeat every (days)', interval, null, 'Counted in days, ignoring months and years. Good for market days or a comet'),
      moon: field('Moon', moonSel), phase: field('Phase', phaseSel, null, 'Falls on the one day each cycle when the moon is nearest this phase'), moon_month: field('Only in', moonMonthSel, null, 'Every time the phase comes round, or only when it falls in one month'),
      every_years: field('Every (years)', everyIn, null, '1 for every year, 4 for every fourth year (counted from the first year, or the calendar\'s first year if that is blank)'),
      limit: field('Runs', limitSel, null, 'Forever, only between two years, or a set number of times from the first year'),
      from_year: field('First year', fromIn, eraHint), until_year: field('Last year', untilIn, eraHint), times: field('Times', timesIn),
    };
    const show = { fixed: ['month', 'day', 'every_years', 'limit'], nth_weekday: ['n', 'weekday', 'month', 'every_years', 'limit'], once: ['once'], every_n: ['start', 'interval', 'limit'], moon_phase: ['moon', 'phase', 'moon_month', 'limit'] };
    // moon phases can't count times, and every N days counts from its first occurrence, not a year
    const limits = { moon_phase: ['', 'years'] };
    const sync = () => {
      const t = type.value, on = [...show[t]];
      [...limitSel.options].forEach(o => (o.hidden = !!limits[t] && !limits[t].includes(o.value)));
      if (limitSel.selectedOptions[0]?.hidden) limitSel.value = '';
      if (on.includes('limit')) {
        if (limitSel.value === 'years') on.push('from_year', 'until_year');
        if (limitSel.value === 'times') on.push('times', ...(t === 'every_n' ? [] : ['from_year']));
        if (on.includes('every_years') && Number(everyIn.value) > 1 && !on.includes('from_year')) on.push('from_year');
      }
      Object.entries(parts).forEach(([k, part]) => (part.style.display = on.includes(k) ? '' : 'none'));
    };
    [type, limitSel].forEach(x => x.addEventListener('change', sync));
    everyIn.addEventListener('input', sync);
    const f = el('form', { class: 'card' }, el('h3', {}, x.id ? `Edit ${x.name}` : 'New holiday'),
      el('div', { class: 'grid2' },
        field('Name', el('input', { name: 'name', value: x.name || '', required: true })),
        field('Repeats', type, null, 'Same date: e.g. 1 January every year. Nth weekday: e.g. the last Thursday of November. One time only: a single date. Every N days: a fixed cycle from a first date. Moon phase: e.g. every full moon'),
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
      if (v.type === 'moon_phase') Object.assign(rule, { moon: Number(v.moon), phase: Number(v.phase), ...(Number(v.moon_month) >= 0 ? { month: Number(v.moon_month) } : {}) });
      if (v.type === 'fixed' || v.type === 'nth_weekday') {
        const every = Math.max(1, Math.trunc(Number(v.every_years)) || 1);
        if (every > 1) rule.every_years = every;
      }
      if (v.type !== 'once') {
        const yr = s => (s === '' || !Number.isFinite(Number(s)) ? null : Math.trunc(Number(s)));
        const from = yr(v.from_year), until = yr(v.until_year);
        if (v.limit === 'years') Object.assign(rule, from !== null ? { from_year: from } : {}, until !== null ? { until_year: until } : {});
        if (v.limit === 'times') Object.assign(rule, { times: Math.max(1, Math.trunc(Number(v.times)) || 1) }, v.type !== 'every_n' ? { from_year: from ?? fromAbsYear() } : {});
        // every N years counts from the first year
        if (rule.every_years && rule.from_year === undefined && from !== null) rule.from_year = from;
        if (v.limit === 'years' && from !== null && until !== null && until < from) return toast('The last year is before the first year', true);
      }
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
      offerNouns([{ text: body.title, title: true, label: `${DOWNTIME_KINDS[k].label} title` }]);
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
      save.addEventListener('click', busy(save, async () => {
        await post('downtime_save', { id: x.id, notes: notes.value }, S.camp.id); toast('Notes saved');
        offerNouns([{ text: notes.value, label: `${k.label} notes` }]);
      }));
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
      offerNouns([{ text: `${title.value}\n${custom.filter(n => picked.has(n)).join('\n')}`, title: true, label: `${k.label} title and activities` },
        { text: notes.value, label: `${k.label} notes` }, { text: gmn.value, secret: true, label: `${k.label} GM notes` }]);
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

  // ------------------------------------------------------------ party holdings tab
  // Gear and Loot on the left, one card per holding on the right. GM and players alike add, change and remove both.
  /** Holding types and their own fields, beyond name, location, description, amount and tags. Matches HOLDING_KINDS in api/index.php. */
  const HOLDING_KINDS = {
    vehicle: { label: 'Vehicle', icon: '🚙', fields: ['top_speed', 'fuel_cap', 'fuel_type', 'fuel_consume', 'reliability', 'armor', 'crew', 'cargo', 'value'] },
    animal: { label: 'Animal', icon: '🐎', fields: ['top_speed', 'training', 'armor', 'crew', 'cargo', 'value'] },
    building: { label: 'Building', icon: '🏰', fields: ['construction', 'armor', 'size', 'class', 'status', 'upkeep', 'access', 'seclusion', 'environment', 'value'] },
    asset: { label: 'Asset', icon: '💎', fields: ['category', 'value'] },
    custom: { label: 'Custom', icon: '📦', fields: ['value'] },
  };
  const HOLDING_FIELDS = {
    top_speed: 'Top Speed', fuel_cap: 'Fuel Capacity', fuel_type: 'Fuel Type', fuel_consume: 'Fuel Consumption', reliability: 'Reliability',
    armor: 'Armor', crew: 'Crew', cargo: 'Cargo', value: 'Value', training: 'Training', construction: 'Construction Type', size: 'Size', class: 'Class', status: 'Status', upkeep: 'Upkeep', access: 'Access', seclusion: 'Seclusion', environment: 'Environment', category: 'Category',
  };
  /** Fields picked from a list, or typed in with Custom. */
  const HOLDING_CHOICES = {
    construction: ['Wood', 'Stone', 'Concrete', 'Metal', 'Mixed'],
    category: ['Item', 'Connection', 'Contact', 'Favor'],
  };
  const HOLDING_MAX = 1e9;
  const holdingType = h => (h.kind === 'custom' ? h.type_name : HOLDING_KINDS[h.kind]?.label) || h.kind;

  /** A − amount + ticker. onTick(delta) and onSet(n) save it; if one throws, the box goes back to what it was. */
  function amountTicker(value, { label = 'Amount', onTick, onSet } = {}) {
    let n = Number(value) || 0;
    const box = el('input', { type: 'number', min: 0, max: HOLDING_MAX, step: 1, value: n, class: 'tick-n', 'aria-label': label });
    const show = () => { box.value = n; minus.disabled = n <= 0; };
    const tick = async delta => {
      const was = n;
      n = Math.max(0, Math.min(HOLDING_MAX, n + delta));
      if (n === was) return;
      show();
      try { if (onTick) await onTick(n - was); } catch (err) { n = was; show(); toast(err.message, true); }
    };
    const minus = el('button', { type: 'button', class: 'small', 'aria-label': `${label}: one fewer`, 'data-tip': 'One fewer', onclick: () => tick(-1) }, '−');
    const plus = el('button', { type: 'button', class: 'small', 'aria-label': `${label}: one more`, 'data-tip': 'One more', onclick: () => tick(1) }, '+');
    box.addEventListener('change', async () => {
      const was = n, v = Math.round(Number(box.value));
      if (!Number.isFinite(v) || v < 0 || v > HOLDING_MAX) { show(); return; }
      n = v; show();
      try { if (onSet) await onSet(n); } catch (err) { n = was; show(); toast(err.message, true); }
    });
    show();
    return { node: el('div', { class: 'ticker' }, minus, box, plus), get: () => n };
  }

  async function viewHoldings() {
    const { funds, gear, holdings, tags } = await api('holdings', { query: { cid: S.camp.id } });
    S.holdingTags = tags || [];
    const right = el('div', { class: 'holdings-col' },
      el('div', { class: 'card' }, el('div', { class: 'row spread' },
        el('h2', {}, 'Holdings', tip('Vehicles, animals, buildings, assets and anything else the party owns, one card each, with tags of their own. The GM and every player can add and change them.')),
        btn('+ Add holding', () => holdingDialog(), 'primary', 'Add a vehicle, animal, building, asset or a type of your own')),
        holdings.length ? null : el('p', { class: 'muted' }, 'No holdings yet. Press Add holding to add one.')),
      holdings.map(holdingCard));
    mount(...campaignHeader('holdings'), el('div', { class: 'holdings-page' }, el('div', { class: 'holdings-col holdings-left' }, fundsCard(funds || []), gearCard(gear)), right));
  }

  /** Party Funds: a ledger of the party's money, one line per currency, where it is kept and how much
   * ("Gold pieces", "Bank of Altdorf", 120). Boxes save when you leave them. */
  function fundsCard(funds) {
    const rows = el('div', { class: 'ledger-rows' });
    const amountBox = (v, label) => el('input', { type: 'number', step: 'any', value: v ?? '', placeholder: 'Amount', 'aria-label': label });
    const line = f => {
      const cur = el('input', { maxlength: 60, value: f.currency, 'aria-label': 'Currency' });
      const loc = el('input', { maxlength: 200, value: f.location || '', placeholder: 'Location', 'aria-label': `Where the ${f.currency} is kept` });
      const amt = amountBox(f.amount, `Amount of ${f.currency}`);
      const save = async () => {
        if (!cur.value.trim()) { cur.value = f.currency; return; }
        try { await post('funds_save', { id: f.id, currency: cur.value, location: loc.value, amount: amt.value }, S.camp.id); f.currency = cur.value.trim(); toast('Saved'); } catch (err) { toast(err.message, true); }
      };
      for (const i of [cur, loc, amt]) i.addEventListener('change', save);
      const row = el('div', { class: 'ledger-row' }, cur, loc, amt,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${f.currency}`, 'data-tip': 'Remove this line', onclick: async () => {
          if (!await confirmDialog(`Remove "${cur.value}" from Party Funds?`, { ok: 'Remove', danger: true })) return;
          try { await post('funds_delete', { id: f.id }, S.camp.id); row.remove(); } catch (err) { toast(err.message, true); }
        } }, '✕'));
      return row;
    };
    rows.append(...funds.map(line));
    const nCur = el('input', { maxlength: 60, placeholder: 'Currency, e.g. Gold pieces', 'aria-label': 'New currency' });
    const nLoc = el('input', { maxlength: 200, placeholder: 'Location', 'aria-label': 'Where the new currency is kept' });
    const nAmt = amountBox('', 'Amount of the new currency');
    const add = btn('+ Add', null, 'small primary', 'Add this to Party Funds');
    // As in Storage: clear the boxes before saving so nothing typed meanwhile is lost, and put them back if it fails.
    add.addEventListener('click', busy(null, async () => {
      if (!nCur.value.trim()) { nCur.focus(); toast('Name the currency first', true); return; }
      const typed = [nCur.value, nLoc.value, nAmt.value];
      const f = { currency: typed[0].trim(), location: typed[1].trim(), amount: typed[2] === '' ? 0 : Number(typed[2]) };
      nCur.value = nLoc.value = nAmt.value = '';
      nCur.focus();
      try { f.id = (await post('funds_save', { currency: f.currency, location: f.location, amount: typed[2] }, S.camp.id)).id; }
      catch (err) { if (!nCur.value && !nLoc.value && !nAmt.value) [nCur.value, nLoc.value, nAmt.value] = typed; throw err; }
      rows.append(line(f));
    }));
    for (const i of [nCur, nLoc, nAmt]) i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add.click(); } });
    return el('section', { class: 'card funds' },
      el('h2', {}, 'Party Funds', tip('The party\'s money, one line per currency, with where it is kept: gold in a strongbox, credits in a bank. Type in a box and it saves when you leave it. The GM and every player can edit it.')),
      el('div', { class: 'ledger-row ledger-head', 'aria-hidden': 'true' }, el('span', { class: 'lbl' }, 'Currency'), el('span', { class: 'lbl' }, 'Location'), el('span', { class: 'lbl' }, 'Amount'), el('span')),
      rows,
      el('div', { class: 'ledger-row ledger-new' }, nCur, nLoc, nAmt, add));
  }

  /** The Gear and Loot list: item, who claimed it and where it is, all free text, and how many. Each box saves when you leave it. */
  function gearCard(gear) {
    const rows = el('div', { class: 'gear-rows' });
    const gearRow = g => {
      const text = (name, label, ph) => el('input', { name, value: g[name] || '', maxlength: 200, 'aria-label': label, placeholder: ph });
      const item = text('item', 'Item', 'Item'), claimed = text('claimed_by', 'Claimed by', 'Claimed by'), loc = text('location', 'Location', 'Location');
      const save = async () => {
        try { await post('gear_save', { id: g.id, item: item.value, claimed_by: claimed.value, location: loc.value }, S.camp.id); toast('Saved'); } catch (err) { toast(err.message, true); }
      };
      [item, claimed, loc].forEach(i => i.addEventListener('change', save));
      const amount = amountTicker(g.amount, { label: `How many ${g.item || 'of this item'}`,
        onTick: delta => post('gear_tick', { id: g.id, delta }, S.camp.id),
        onSet: n => post('gear_save', { id: g.id, item: item.value, claimed_by: claimed.value, location: loc.value, amount: n }, S.camp.id) });
      const row = el('div', { class: 'gear-row' }, item, claimed, loc, amount.node,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${g.item || 'this item'}`, 'data-tip': 'Remove this item', onclick: async () => {
          if (!await confirmDialog(`Remove "${item.value || 'this item'}" from Gear and Loot?`, { ok: 'Remove', danger: true })) return;
          try { await post('gear_delete', { id: g.id }, S.camp.id); row.remove(); } catch (err) { toast(err.message, true); }
        } }, '✕'));
      return row;
    };
    rows.append(...gear.map(gearRow));
    // The last row adds an item; Enter in any of its boxes adds it too.
    const nItem = el('input', { maxlength: 200, placeholder: 'New item', 'aria-label': 'New item' });
    const nClaimed = el('input', { maxlength: 200, placeholder: 'Claimed by', 'aria-label': 'New item claimed by' });
    const nLoc = el('input', { maxlength: 200, placeholder: 'Location', 'aria-label': 'New item location' });
    const nAmount = amountTicker(1, { label: 'How many of the new item' });
    const add = btn('+ Add', null, 'small primary', 'Add this item to the list');
    add.addEventListener('click', busy(null, async () => {
      if (!nItem.value.trim()) { nItem.focus(); toast('Name the item first', true); return; }
      // As in Storage: clear the boxes first, and put them back if the save fails.
      const typed = [nItem.value, nClaimed.value, nLoc.value];
      const g = { item: typed[0].trim(), claimed_by: typed[1].trim(), location: typed[2].trim(), amount: nAmount.get() };
      nItem.value = nClaimed.value = nLoc.value = '';
      nItem.focus();
      try { g.id = (await post('gear_save', g, S.camp.id)).id; }
      catch (err) { if (!nItem.value && !nClaimed.value && !nLoc.value) [nItem.value, nClaimed.value, nLoc.value] = typed; throw err; }
      rows.append(gearRow(g));
    }));
    for (const i of [nItem, nClaimed, nLoc]) i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add.click(); } });
    return el('section', { class: 'card gear' },
      el('h2', {}, 'Gear and Loot', tip('What the party carries and has found. Type in any box and it saves when you leave it; − and + change how many. The GM and every player can edit the list.')),
      el('div', { class: 'gear-row gear-head', 'aria-hidden': 'true' }, ['Item', 'Claimed by', 'Location', 'Amount', ''].map(h => el('span', { class: 'lbl' }, h))),
      rows,
      gear.length ? null : el('p', { class: 'muted gear-empty' }, 'Nothing yet. Add the first item below.'),
      el('div', { class: 'gear-row gear-new' }, nItem, nClaimed, nLoc, nAmount.node, add));
  }

  /** One holding's card: its type, amount, location, description, fields and tags, with Edit and Delete. */
  function holdingCard(h) {
    const k = HOLDING_KINDS[h.kind] || HOLDING_KINDS.custom;
    const amount = amountTicker(h.amount, { label: `How many ${h.name}`, onTick: delta => post('holding_tick', { id: h.id, delta }, S.camp.id) });
    const stats = k.fields.filter(f => h.stats?.[f]).map(f => el('div', {}, el('span', { class: 'lbl' }, HOLDING_FIELDS[f]), el('span', {}, h.stats[f])));
    return el('section', { class: 'card holding', 'data-kind': h.kind },
      el('div', { class: 'row spread' },
        el('h3', {}, `${k.icon} ${h.name}`),
        el('div', { class: 'inline' }, el('span', { class: 'lbl' }, 'Amount'), amount.node)),
      el('small', { class: 'muted' }, holdingType(h), h.location ? ` · 📍 ${h.location}` : ''),
      h.tags?.length ? el('div', { class: 'etags' }, h.tags.map(tagChip)) : null,
      h.description ? el('p', { class: 'pre' }, h.description) : null,
      stats.length ? el('div', { class: 'hold-stats' }, stats) : null,
      storageBox(h),
      el('div', { class: 'row' },
        btn('Edit', () => holdingDialog(h), 'small', 'Change this holding'),
        btn('Delete', async () => {
          if (!await confirmDialog(`Delete "${h.name}"?`, { ok: 'Delete', danger: true })) return;
          try { await post('holding_delete', { id: h.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Delete this holding')));
  }

  /** The first number in a text such as "1,200 lb" or "2.5 tons", or null. */
  const leadNumber = s => { const m = String(s ?? '').replace(/,/g, '').match(/\d+(\.\d+)?|\.\d+/); return m ? Number(m[0]) : null; };
  const fmtWeight = n => (Math.round(n * 100) / 100).toLocaleString();
  /** A holding's Storage box: a ledger of what is kept in it and how much each weighs, with the total,
   * flagged when it is more than the holding's Cargo. Boxes save when you leave them. */
  function storageBox(h) {
    const cap = leadNumber(h.stats?.cargo);
    const lines = el('div', { class: 'ledger-rows' });
    const total = el('div', { class: 'ledger-total' });
    const weights = () => [...lines.querySelectorAll('input.ledger-w')].map(i => Number(i.value) || 0);
    const sum = () => {
      const t = weights().reduce((a, b) => a + b, 0), over = cap !== null && t > cap;
      total.classList.toggle('over', over);
      total.replaceChildren(el('span', {}, 'Total weight'), el('strong', {}, fmtWeight(t), cap !== null ? ` / ${h.stats.cargo}` : ''),
        ...(over ? [el('span', { class: 'bad', role: 'alert' }, `⚠ Over cargo by ${fmtWeight(t - cap)}`)] : []));
    };
    const wInput = v => el('input', { type: 'number', min: 0, step: 'any', class: 'ledger-w', value: v ?? '', placeholder: 'Weight' });
    const line = s => {
      const item = el('input', { maxlength: 200, value: s.item, 'aria-label': 'Stored item' });
      const weight = wInput(s.weight);
      weight.setAttribute('aria-label', `Weight of ${s.item}`);
      const save = async () => {
        if (!item.value.trim()) { item.value = s.item; return; }
        try { await post('storage_save', { id: s.id, item: item.value, weight: weight.value }, S.camp.id); s.item = item.value.trim(); toast('Saved'); } catch (err) { toast(err.message, true); }
      };
      item.addEventListener('change', save);
      weight.addEventListener('change', save);
      weight.addEventListener('input', sum);
      const row = el('div', { class: 'ledger-row' }, item, weight,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${s.item} from storage`, 'data-tip': 'Remove from storage', onclick: async () => {
          if (!await confirmDialog(`Remove "${item.value}" from ${h.name}'s storage?`, { ok: 'Remove', danger: true })) return;
          try { await post('storage_delete', { id: s.id }, S.camp.id); row.remove(); sum(); } catch (err) { toast(err.message, true); }
        } }, '✕'));
      return row;
    };
    lines.append(...(h.storage || []).map(line));
    const nItem = el('input', { maxlength: 200, placeholder: 'New item', 'aria-label': `New item in ${h.name}'s storage` });
    const nWeight = wInput('');
    nWeight.setAttribute('aria-label', `Weight of the new item in ${h.name}'s storage`);
    const add = btn('+ Add', null, 'small', 'Put this item in storage');
    // Not disabled while saving, so a quick second item (Enter, Enter) is added too.
    add.addEventListener('click', busy(null, async () => {
      if (!nItem.value.trim()) { nItem.focus(); toast('Name the item first', true); return; }
      // Clear the boxes before saving, so anything typed while it saves isn't wiped; put it back if the save fails.
      const typed = [nItem.value, nWeight.value];
      const s = { item: typed[0].trim(), weight: typed[1] === '' ? null : Number(typed[1]) };
      nItem.value = nWeight.value = '';
      nItem.focus();
      try { s.id = (await post('storage_save', { holding_id: h.id, item: s.item, weight: typed[1] }, S.camp.id)).id; }
      catch (err) { if (!nItem.value && !nWeight.value) [nItem.value, nWeight.value] = typed; throw err; }
      lines.append(line(s));
      sum();
    }));
    for (const i of [nItem, nWeight]) i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); add.click(); } });
    sum();
    return el('div', { class: 'storage' },
      el('span', { class: 'lbl' }, 'Storage', tip(cap !== null
        ? `What is kept in ${h.name}, and what each item weighs. The total is checked against its Cargo (${h.stats.cargo}), so give weights in the same unit`
        : `What is kept in ${h.name}, and what each item weighs. Give the holding a Cargo value to be warned when it is overloaded`)),
      el('div', { class: 'ledger-row ledger-head', 'aria-hidden': 'true' }, el('span', { class: 'lbl' }, 'Item'), el('span', { class: 'lbl' }, 'Weight'), el('span')),
      lines,
      el('div', { class: 'ledger-row ledger-new' }, nItem, nWeight, add),
      total);
  }

  /** Add a holding, or edit one (h): the common fields, then the fields of the type picked. */
  function holdingDialog(h = {}) {
    hideTip();
    const CUSTOM = '__custom';
    const kindSel = select([...Object.entries(HOLDING_KINDS).map(([v, x]) => [v, v === 'custom' ? 'Custom…' : x.label])], h.kind || 'vehicle', { name: 'kind', 'aria-label': 'Type' });
    const typeName = el('input', { maxlength: 60, value: h.type_name || '', placeholder: 'e.g. Ship, Company, Spell', 'aria-label': 'Custom type' });
    const typeField = field('Custom type', typeName, 'What kind of holding this is');
    const name = el('input', { maxlength: 200, value: h.name || '', required: true });
    const loc = el('input', { maxlength: 200, value: h.location || '' });
    const desc = el('textarea', { rows: 5, value: h.description || '' });
    const amount = amountTicker(h.amount ?? 1);
    const tags = tagPicker(h.tags || [], 'holding', S.holdingTags || []);
    // One box per field across every type, so switching type and back keeps what was typed.
    const boxes = {};
    for (const f of Object.keys(HOLDING_FIELDS)) {
      const v = h.stats?.[f] || '';
      const input = el('input', { maxlength: 200, value: v });
      const choices = HOLDING_CHOICES[f];
      if (!choices) { boxes[f] = { node: field(HOLDING_FIELDS[f], input), get: () => input.value }; continue; }
      const custom = !!v && !choices.includes(v);
      const sel = select([['', '—'], ...choices.map(c => [c, c]), [CUSTOM, 'Custom…']], custom ? CUSTOM : v, { 'aria-label': HOLDING_FIELDS[f] });
      input.value = custom ? v : '';
      input.placeholder = `Your own ${HOLDING_FIELDS[f].toLowerCase()}`;
      input.setAttribute('aria-label', `Custom ${HOLDING_FIELDS[f].toLowerCase()}`);
      const sync = () => { input.hidden = sel.value !== CUSTOM; };
      sel.addEventListener('change', () => { sync(); if (!input.hidden) input.focus(); });
      sync();
      boxes[f] = { node: field(HOLDING_FIELDS[f], el('div', { class: 'stack' }, sel, input)), get: () => (sel.value === CUSTOM ? input.value : sel.value) };
    }
    const statsBox = el('div', { class: 'grid3 hold-fields' });
    const syncKind = () => {
      typeField.hidden = kindSel.value !== 'custom';
      statsBox.replaceChildren(...HOLDING_KINDS[kindSel.value].fields.map(f => boxes[f].node));
    };
    kindSel.addEventListener('change', syncKind);
    syncKind();
    const err = el('p', { class: 'bad small', hidden: true });
    const save = el('button', { class: 'primary', type: 'submit' }, h.id ? 'Save' : 'Add holding');
    const title = h.id ? `Edit ${h.name}` : 'Add holding';
    const d = el('dialog', { class: 'kit-dialog hold-dialog', 'aria-label': title },
      el('form', { novalidate: true },
        el('h3', {}, title),
        el('div', { class: 'grid2' }, field('Holding Name', name), field('Type', kindSel)),
        typeField,
        field('Location', loc),
        field('Description', desc),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Amount'), amount.node),
        statsBox,
        tags.node,
        err,
        el('div', { class: 'kit-dialog-actions' }, save, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
    d.addEventListener('close', () => d.remove());
    d.querySelector('form').addEventListener('submit', busy(save, async e => {
      e.preventDefault();
      err.hidden = true;
      const kind = kindSel.value;
      const fail = (msg, box) => { err.textContent = msg; err.hidden = false; box?.focus(); };
      if (!name.value.trim()) return fail('Give the holding a name.', name);
      if (kind === 'custom' && !typeName.value.trim()) return fail('Name the custom type.', typeName);
      const stats = Object.fromEntries(HOLDING_KINDS[kind].fields.map(f => [f, boxes[f].get().trim()]).filter(([, v]) => v));
      const picked = tags.get();
      try {
        await post('holding_save', { id: h.id, name: name.value, kind, type_name: kind === 'custom' ? typeName.value : '',
          location: loc.value, description: desc.value, amount: amount.get(), stats, tags: picked }, S.camp.id);
      } catch (x) { return fail(x.message); }
      d.close();
      toast(h.id ? 'Holding saved' : 'Holding added');
      route();
      offerNouns([{ text: `${name.value}\n${loc.value}`, title: true, short: true, label: `holding "${name.value.trim()}"` }, { text: desc.value, label: `holding "${name.value.trim()}"` }]);
    }));
    document.body.append(d);
    d.showModal();
    name.focus();
  }

  // ------------------------------------------------------------ generators tab
  // Random names, taverns, companies and towns from static/generators.js. Nothing is stored until someone presses 📖 on
  // a result, which adds it to the Encyclopedia. The genre and each card's choices are remembered in this browser for
  // each campaign.
  const GEN_KEY = 'cc-generators';
  function genPrefs() {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(GEN_KEY)) || {}; } catch { /* private mode: defaults */ }
    const name = cal().name || '';
    return { genre: /ship time/i.test(name) ? 'scifi' : /gregorian/i.test(name) ? 'modern' : 'fantasy', secret: true, ...all[S.camp.id] };
  }
  function setGenPrefs(p) {
    try {
      const all = JSON.parse(localStorage.getItem(GEN_KEY)) || {};
      all[S.camp.id] = { ...all[S.camp.id], ...p };
      localStorage.setItem(GEN_KEY, JSON.stringify(all));
    } catch { /* private mode: just this page */ }
  }
  /** Rich text for an Encyclopedia note, built from nodes so every word goes in as text. */
  const genHtml = (...kids) => el('div', {}, kids).innerHTML;
  async function genCopy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('This browser won\'t let the page copy. Select the text instead', true); }
  }

  /** The 📖 button on a result: adds it to the Encyclopedia with tag and notes (rich text), then becomes a link to it. */
  function genAddButton(name, tag, notes) {
    const b = el('button', { type: 'button', class: 'small gen-add', 'aria-label': `Add ${name} to the Encyclopedia`,
      'data-tip': `Add ${name} to the Encyclopedia, ${S.encCatsReady && encCatNamed(tag) ? 'as a' : 'tagged'} ${tag}${isGM() && genPrefs().secret ? ', as GM only' : ''}` }, '📖 Add');
    b.addEventListener('click', busy(b, async () => {
      if (!S.encReady) throw new Error('The Encyclopedia isn\'t set up on this server yet: install.php needs to be run');
      const secret = isGM() && !!genPrefs().secret;
      // Person and Location are Categories; Rumor is a tag
      const cat = S.encCatsReady ? encCatNamed(tag) : null;
      const { id } = await post('entry_save', { name, notes: notes(), ...(cat ? { category: cat } : { tags: [{ name: tag }] }), ...(isGM() ? { is_secret: secret } : {}) }, S.camp.id);
      S.encyclopedia = [...S.encyclopedia.filter(x => x.id !== id), { id, name, aliases: [], is_secret: secret, blank: false,
        preview: Nouns.plain(notes(), 'html').replace(/\s+/g, ' ').trim().slice(0, 140) }].sort((a, x) => a.name.localeCompare(x.name));
      toast(`Added ${name} to the Encyclopedia`);
      b.replaceWith(el('a', { class: 'button small gen-add', href: `#/c/${S.camp.id}/encyclopedia/${id}`, 'data-tip': 'Open its Encyclopedia entry' }, '📖 Open'));
    }));
    return b;
  }
  /** One result line: the name, a note under it, Copy and 📖 Add. */
  function genRow(r, tag) {
    return el('li', { class: 'gen-item' },
      el('div', { class: 'gen-what' }, el('span', { class: 'gen-name' }, r.name), r.note ? el('span', { class: 'small muted' }, r.note) : null),
      el('button', { type: 'button', class: 'small', 'aria-label': `Copy ${r.name}`, 'data-tip': 'Copy the name', onclick: () => genCopy(r.name) }, '📋'),
      genAddButton(r.name, tag, () => genHtml(r.note ? el('p', {}, r.note) : null)));
  }
  /** A generator card: a title, its own choices, the Generate button and the results under them. roll() gives the nodes. */
  function genCard(title, tipText, controls, roll, cls) {
    const out = el('div', { class: 'gen-out' });
    const draw = () => { hideTip(); out.replaceChildren(...clean([roll()])); };
    const go = btn('🎲 Generate', draw, 'primary', 'Roll a new set');
    for (const c of controls) (c.matches('input') ? c : c.querySelector('select, input'))?.addEventListener('change', draw);
    draw();
    return el('section', { class: `card gen-card ${cls || ''}` }, el('h2', {}, title, tip(tipText)), el('div', { class: 'gen-controls' }, controls, go), out);
  }

  /** The campaign's Encyclopedia names sorted by Category (or else by tag), for rumors: {person, place, group, item}. Fetched once per change to the
   * Encyclopedia; until it arrives this gives {} and then calls ready() so the rumors can be drawn again. */
  let genCastMemo = null;
  function genCast(ready) {
    if (!S.encReady) return {};
    if (genCastMemo?.list === S.encyclopedia && genCastMemo.cid === S.camp.id) return genCastMemo.cast || {};
    const memo = genCastMemo = { list: S.encyclopedia, cid: S.camp.id, cast: null };
    const kinds = { person: /^(person|people|npc|character|pc)s?$/, place: /^(location|place|city|town|region|planet|station|building)s?$/,
      group: /^(group|faction|organi[sz]ation|company|guild|gang|corporation|house)s?$/, item: /^(item|object|artifact|artefact)s?$/ };
    api('encyclopedia', { query: { cid: S.camp.id } }).then(r => {
      const cast = { person: [], place: [], group: [], item: [] };
      for (const e of r.entries || []) {
        const tags = [e.category === 'location' ? 'place' : e.category, ...(e.tags || []).map(t => t.name.toLowerCase())].filter(Boolean);
        const k = Object.keys(kinds).find(k => tags.some(t => kinds[k].test(t)));
        if (k) cast[k].push(e.name);
      }
      memo.cast = cast;
      if (Object.values(cast).some(x => x.length)) ready();
    }).catch(() => { memo.cast = {}; });
    return {};
  }

  function viewGenerators() {
    const pref = genPrefs();
    const genre = select(Gen.GENRES, pref.genre, { 'aria-label': 'Genre' });
    genre.addEventListener('change', () => { setGenPrefs({ genre: genre.value }); viewGenerators(); });
    const g = genre.value;
    const keep = (k, sel) => { sel.addEventListener('change', () => setGenPrefs({ [k]: sel.value })); return sel; };

    const peoples = Gen.PEOPLES[g];
    const people = keep('people_' + g, select([['', 'Any'], ...peoples], pref['people_' + g] || peoples[0][0], { 'aria-label': 'Race or people' }));
    const gender = keep('gender', select(Gen.GENDERS, pref.gender || '', { 'aria-label': 'Gender' }));
    const traits = el('input', { type: 'checkbox', checked: !!pref.traits, onchange: e => setGenPrefs({ traits: e.target.checked }) });
    // Kind: a real name, or what someone goes by (a street name or handle, 'alias' for any of them) with the real name behind it.
    const nameKind = keep('nameKind', select([['', 'Real name'], ...Gen.ALIAS_KINDS, ['alias', 'Any street name or handle']], pref.nameKind || '', { 'aria-label': 'Kind of name' }));
    const kindName = Object.fromEntries(Gen.ALIAS_KINDS);
    const names = genCard('Names', 'Character names for this genre. Each people or culture has its own sounds; pick Any to mix them. Gender-neutral gives names used for anyone. Kind gives a street name, a cyberpunk handle or the tag a netrunner signs in cyberspace instead, with the real name behind it; any genre can use them. 📖 Add puts a name in the Encyclopedia as a Person, with its real name, look and quirk as notes',
      [field('Kind', nameKind), field('Race or people', people), field('Gender', gender),
        el('label', { class: 'inline small gen-traits', 'data-tip': 'Give each name how they look and a habit or manner, for an NPC on the spot' }, traits, 'Add a look and a quirk')],
      () => el('ul', { class: 'gen-list' }, Gen.many(10, () => nameKind.value
        ? Gen.alias(nameKind.value === 'alias' ? '' : nameKind.value, g, people.value, gender.value) : Gen.name(g, people.value, gender.value)).map(r => {
        const t = traits.checked ? Gen.traits(g, r.people) : null;
        const note = [r.kind && nameKind.value === 'alias' ? `${kindName[r.kind]}.` : '', r.note ? `${r.note}.` : '', t ? `${t.look}. ${t.quirk}.` : ''].filter(Boolean).join(' ');
        return genRow({ name: r.name, note }, 'Person');
      })));

    const taverns = genCard(g === 'western' ? 'Saloons & inns' : g === 'scifi' || g === 'cyberpunk' ? 'Bars & clubs' : 'Taverns, inns & pubs',
      'Places to eat, drink and sleep, each with what it\'s known for and who runs it. 📖 Add puts one in the Encyclopedia as a Location', [],
      () => el('ul', { class: 'gen-list' }, Gen.many(6, () => Gen.tavern(g)).map(r => genRow(r, 'Location'))));

    const sector = keep('sector', select(Gen.SECTORS, pref.sector || '', { 'aria-label': 'Line of business' }));
    const companies = genCard(g === 'fantasy' ? 'Guilds & companies' : g === 'western' ? 'Companies' : 'Companies & corporations',
      'Businesses, guilds and corporations for this genre. 📖 Add puts one in the Encyclopedia as a Group', [field('Line of business', sector)],
      () => el('ul', { class: 'gen-list' }, Gen.many(6, () => Gen.company(g, sector.value)).map(r => genRow(r, 'Group'))));

    const useEnc = el('input', { type: 'checkbox', checked: pref.useEnc !== false, onchange: e => setGenPrefs({ useEnc: e.target.checked }) });
    const rumors = genCard('Rumors', 'Talk the party overhears, and who they heard it from. With the box ticked, rumors are about the people, places, groups and items in your Encyclopedia (by their Categories and tags), with made-up names for the rest. 📖 Add puts one in the Encyclopedia, tagged Rumor',
      [S.encReady ? el('label', { class: 'inline small gen-traits', 'data-tip': 'Use names from your Encyclopedia tagged Person, Location, Group or Item' }, useEnc, 'Use Encyclopedia names') : null].filter(Boolean),
      () => el('ul', { class: 'gen-list' }, Gen.rumors(g, 6, useEnc.checked ? genCast(() => useEnc.dispatchEvent(new Event('change'))) : {}).map(r => el('li', { class: 'gen-item' },
        el('div', { class: 'gen-what' }, el('span', { class: 'gen-rumor' }, r.name), el('span', { class: 'small muted' }, r.note)),
        el('button', { type: 'button', class: 'small', 'aria-label': 'Copy the rumor', 'data-tip': 'Copy the rumor', onclick: () => genCopy(r.name) }, '📋'),
        genAddButton(r.title, 'Rumor', () => genHtml(el('p', {}, r.name), el('p', {}, el('em', {}, r.note))))))));

    const size = keep('size', select(Gen.SIZE_KEYS.map(([k, l]) => [k, k ? `${l}: ${Gen.sizeLabel(g, k)}` : l]), pref.size || '', { 'aria-label': 'Size' }));
    const towns = genCard('Towns', 'A whole settlement: who runs it, what pays for it, a few places and people, and trouble for the party to walk into. 📖 Add puts the town, or any place or person in it, in the Encyclopedia',
      [field('Size', size)], () => genTown(Gen.town(g, size.value)), 'gen-town');

    const secret = isGM() ? el('label', { class: 'inline small', 'data-tip': 'What you add with 📖 stays hidden from players until you untick GM only on its entry' },
      el('input', { type: 'checkbox', checked: pref.secret !== false, onchange: e => setGenPrefs({ secret: e.target.checked }) }), 'Add to the Encyclopedia as GM only') : null;
    mount(...campaignHeader('generators'), el('div', { class: 'gen-page' },
      el('div', { class: 'card gen-head' }, el('div', { class: 'row spread' },
        el('h2', {}, 'Generators', tip('Random names, handles, places, businesses, rumors and towns for when the players go somewhere you didn\'t plan. Everything here is made in your browser and nothing is saved unless you press 📖 Add')),
        el('div', { class: 'row' }, field('Genre', genre), secret))),
      names, taverns, companies, rumors, towns));
  }

  /** A generated town as a stat block, with 📖 Add for the town and for each place and person in it. */
  function genTown(t) {
    const pop = `${t.kind}, population about ${t.population.toLocaleString()}`;
    const facts = t.facts;
    const notes = () => genHtml(el('p', {}, el('strong', {}, pop)), el('ul', {}, facts.map(([k, v]) => el('li', {}, el('strong', {}, `${k}: `), v))),
      el('h3', {}, 'Places'), el('ul', {}, t.places.map(p => el('li', {}, `${p.name} (${p.note})`))),
      el('h3', {}, 'People'), el('ul', {}, t.people.map(p => el('li', {}, `${p.name}: ${p.note}`))),
      el('h3', {}, 'Trouble'), el('ul', {}, t.hooks.map(h => el('li', {}, h))));
    const text = [t.name, pop, ...facts.map(([k, v]) => `${k}: ${v}`), '', 'Places:', ...t.places.map(p => `- ${p.name} (${p.note})`),
      '', 'People:', ...t.people.map(p => `- ${p.name}: ${p.note}`), '', 'Trouble:', ...t.hooks.map(h => `- ${h}`)].join('\n');
    const sub = (title, list, tag, where) => el('div', { class: 'gen-sub' }, el('h3', {}, title), el('ul', { class: 'gen-list' }, list.map(r => el('li', { class: 'gen-item' },
      el('div', { class: 'gen-what' }, el('span', { class: 'gen-name' }, r.name), el('span', { class: 'small muted' }, r.note)),
      genAddButton(r.name, tag, () => genHtml(el('p', {}, `${r.note}, in ${where}.`)))))));
    return el('div', { class: 'gen-townblock' },
      el('div', { class: 'gen-town-title' }, el('div', {}, el('h3', {}, t.name), el('span', { class: 'muted' }, pop)),
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'small', 'data-tip': 'Copy the whole town as text', onclick: () => genCopy(text) }, '📋 Copy'),
          genAddButton(t.name, 'Location', notes))),
      el('dl', { class: 'gen-facts' }, facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el('div', { class: 'gen-cols' }, sub('Places', t.places, 'Location', t.name), sub('People', t.people, 'Person', t.name),
        el('div', { class: 'gen-sub' }, el('h3', {}, 'Trouble'), el('ul', { class: 'gen-hooks' }, t.hooks.map(h => el('li', {}, h))))));
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
        list.replaceChildren(...clean([m.length ? m.slice(0, 8).map(u => el('div', { class: 'listrow', role: 'listitem' },
          el('div', {}, el('strong', {}, u.display_name || u.email || 'Unnamed account'), u.display_name && u.email ? el('span', { class: 'muted' }, ` ${u.email}`) : null),
          el('div', { class: 'actions' }, btn('Add', () => add({ user_id: u.id }), 'small primary', `Add ${u.display_name || u.email || 'them'} to this campaign`))))
          : [el('p', { class: 'muted' }, candidates.length ? 'Nobody registered matches. Type their full sign-in email and press Add by email.' : 'Nobody to list here. Add someone by their sign-in email.')],
          m.length > 8 ? el('small', { class: 'muted' }, `${m.length - 8} more. Type to narrow the list.`) : null]));
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
      card.append(el('h3', {}, 'Add a member'), f, list, el('small', { class: 'muted' }, S.user?.is_admin ? 'Everyone who has signed in and been approved by the site admin is listed. Someone new needs to sign in once and be approved first.'
        : 'People you play with in your other campaigns are listed by name. To add anyone else, type their full sign-in email. Someone new needs to sign in once and be approved first.'));
      api('member_candidates', { query: { cid: S.camp.id } }).then(r => { candidates = r.users; renderList(); }).catch(err => toast(err.message, true));
    }
    mount(...campaignHeader('members'), card);
  }

  // ------------------------------------------------------------ season editor
  /** A season's sunrise and sunset boxes as saved: both trimmed, or neither when both are blank. */
  const sunPair = (r, t) => (r.trim() || t.trim() ? { sunrise: r.trim(), sunset: t.trim() } : {});
  const SEASON_LABELS = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter', none: 'None (no climate change)' };
  const seasonChip = s => el('span', { class: `season s-${s.type || 'none'}` }, s.name || '—');
  /** Editable list of seasons (name, climate type, start month & day, and sunrise and sunset on that day) with a live
   * month-by-month preview. */
  function seasonEditor(c) {
    const rows = el('div', { class: 'seasonrows' });
    const preview = el('div', { class: 'seasonmap' });
    const monthOpts = c.months.map((m, i) => [i, `${i + 1}. ${m.name}`]);
    const read = () => [...rows.children].map(r => ({
      name: r.querySelector('[data-k=name]').value.trim(),
      type: r.querySelector('[data-k=type]').value,
      month: Number(r.querySelector('[data-k=month]').value),
      day: Math.max(1, Number(r.querySelector('[data-k=day]').value) || 1),
      ...sunPair(r.querySelector('[data-k=sunrise]').value, r.querySelector('[data-k=sunset]').value),
    }));
    const redraw = () => {
      const test = { ...c, seasons: read().filter(s => s.name) };
      let map;
      try { E.prep(test); map = E.monthSeasons(test); } catch { return; }
      const sunOn = month => { const t = E.sunTimes(test, E.toAbs(test, test.epochYear, month, 1)); return t && `☀ ${E.fmtClock(t.sunrise)}–${E.fmtClock(t.sunset)}`; };
      preview.replaceChildren(el('table', { class: 'tbl' }, el('tbody', {}, map.map(({ month, seasons }) =>
        el('tr', {}, el('td', {}, c.months[month].name), el('td', {}, test.seasons.length
          ? seasons.map(x => el('span', { class: 'seasonseg' }, seasonChip(x), seasons.length > 1 ? ` ${x.from}–${x.to}` : ''))
          : el('span', { class: 'muted' }, 'No seasons')),
          el('td', { class: 'muted small', 'data-tip': `Sunrise and sunset on day 1 of ${c.months[month].name}` }, sunOn(month) || ''))))));
    };
    const addRow = (s = { name: '', type: 'none', month: 0, day: 1 }) => {
      const month = select(monthOpts, s.month, { 'data-k': 'month', 'aria-label': 'Start month' });
      const day = el('input', { type: 'number', min: 1, value: s.day || 1, class: 'w-day', 'data-k': 'day', 'aria-label': 'Start day' });
      const syncMax = () => { const mo = c.months[month.value]; day.max = Number(mo.days) + Number(mo.leapDays || 0); };
      month.addEventListener('change', syncMax); syncMax();
      const clock = (k, label, tipText) => el('input', { value: s[k] || '', placeholder: k === 'sunrise' ? '06:00' : '18:00', class: 'w-clock', inputmode: 'numeric',
        'data-k': k, 'aria-label': label, 'data-tip': tipText });
      const row = el('div', { class: 'row seasonrow' },
        el('input', { value: s.name || '', placeholder: 'Season name', 'data-k': 'name', 'aria-label': 'Season name', class: 'grow' }),
        select(Object.entries(SEASON_LABELS), s.type || 'none', { 'data-k': 'type', 'aria-label': 'Climate', 'data-tip': 'Which season\'s weather odds regions use while this season lasts' }),
        month, day,
        el('span', { class: 'sunpair' }, '☀', clock('sunrise', 'Sunrise', 'Sunrise on this season\'s first day, like 06:30. Leave both blank to skip'), '–',
          clock('sunset', 'Sunset', 'Sunset on this season\'s first day, like 18:15. Days in between blend towards the next season\'s times')),
        btn('✕', () => { row.remove(); redraw(); }, 'small link', 'Remove this season'));
      rows.append(row);
    };
    (c.seasons || []).forEach(s => addRow(s));
    const wrap = el('div', { class: 'seasoned' }, el('small', { class: 'muted' }, 'Name · climate · first month and day · sunrise–sunset that day'), rows,
      el('div', { class: 'row' }, btn('+ Add season', () => { addRow(); redraw(); rows.lastChild.querySelector('input').focus(); }, 'small', 'Add another season, such as a monsoon or a festival winter'),
        el('small', { class: 'muted' }, 'Each season runs from its start day until the next one begins, wrapping into the next year. The climate decides which weather table regions use. Sunrise and sunset are optional: set them and every day shows its times, blended from one season to the next, and natural light at dawn and dusk follows them.')),
      el('details', { open: true }, el('summary', {}, 'Seasons by month'), preview));
    wrap.addEventListener('input', redraw);
    wrap.addEventListener('change', redraw);
    redraw();
    wrap.getSeasons = () => {
      const list = read();
      if (list.some(s => !s.name)) throw new Error('Every season needs a name');
      const H = Number(c.hoursPerDay) || 24;
      for (const s of list) {
        if (s.sunrise === undefined) continue;
        const r = E.parseClock(s.sunrise), t = E.parseClock(s.sunset);
        if (r === null || t === null) throw new Error(`${s.name}: give both sunrise and sunset as times like 06:30, or leave both blank`);
        if (r > t || t > H) throw new Error(`${s.name}: sunrise has to come before sunset, within a ${H}-hour day`);
      }
      return list;
    };
    return wrap;
  }

  // ------------------------------------------------------------ settings tab
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
        field('Default units', select(UNIT_OPTIONS.slice(1), campUnits(), { name: 'units' }), 'Anyone can pick Metric or Imperial for themselves on their account page',
          'Used for anyone who hasn\'t chosen their own units. Covers every temperature, distance, depth and speed the app works out'),
        field('Show temperatures', el('input', { type: 'checkbox', name: 'show_temps', checked: !campHidesTemps() }), null,
          'Off: weather shows no temperatures for anyone, whatever units they use'),
        field('Players see future weather', el('input', { type: 'checkbox', name: 'players_see_future_weather', checked: !!st.players_see_future_weather }), null,
          'Off: players only see weather up to today. On: they also see days you have generated ahead, like a forecast'),
        field('Players can add events', el('input', { type: 'checkbox', name: 'players_can_add_events', checked: !!st.players_can_add_events }), 'They can always add notes to events they can see'),
        Fan ? field('Fan wiki', Fan.settingsSelect(fanCtx()), 'Where Encyclopedia entries look names up for a summary or a picture',
          'The setting\'s fan wiki, for everyone in the campaign: an entry\'s Summary from the wiki and the wiki\'s tab in Find Image use it. None for a game of your own. The list starts on a guess from the campaign\'s name and calendar, used only once you save') : null),
      field('Description', el('textarea', { name: 'description', rows: 2, value: S.camp.description || '' })),
      el('button', { class: 'primary' }, 'Save campaign settings'));
    general.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(general);
      const s = { ...st, current_region: v.current_region ? Number(v.current_region) : null, genre: v.genre, time_unit: v.time_unit, units: v.units, hide_temps: !v.show_temps,
        players_see_future_weather: v.players_see_future_weather, players_can_add_events: v.players_can_add_events, fan_wiki: v.fan_wiki || st.fan_wiki };
      if (!s.fan_wiki) delete s.fan_wiki;
      delete s.temp_unit;
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
    // what the leap fields add up to, from this year on, so the rule can be checked before saving
    const leapNote = el('small', { class: 'muted leap-note' });
    const drawLeap = () => {
      const v = formData(calForm);
      const months = v.months.split('\n').map(l => l.split(',').map(x => x.trim())).filter(([name]) => name)
        .map(([name, days, leap]) => ({ name, days: Math.max(0, Number(days) || 0), leapDays: Math.max(0, Number(leap) || 0) }));
      const every = Math.max(0, Number(v.leap_every) || 0);
      const base = months.reduce((t, m) => t + m.days, 0), extra = months.reduce((t, m) => t + m.leapDays, 0);
      const inLeap = months.filter(m => m.leapDays).map(m => `${m.name} +${m.leapDays}`).join(', ');
      if (base <= 0) return (leapNote.textContent = '');
      if (!every && !extra) return (leapNote.textContent = 'No leap years. To add one, give a month leap days in the list above (like "February, 28, 1") and set how often leap years come.');
      if (!every) return (leapNote.textContent = `Months have leap days (${inLeap}), but no leap years are set, so they never happen.`);
      if (!extra) return (leapNote.textContent = 'Leap years are set, but no month has leap days, so they add nothing. Add a third number to a month line, like "February, 28, 1".');
      const rule = { every, skip: Math.max(0, Number(v.leap_skip) || 0), unskip: Math.max(0, Number(v.leap_unskip) || 0) };
      leapNote.textContent = `A leap year has ${base + extra} days instead of ${base} (${inLeap}). From this year, ${leapSummary({ months, leap: rule, epochYear: c.epochYear }, E.fromAbs(c, today()).year)}`;
    };
    const calForm = el('form', { class: 'card' }, el('h2', {}, 'Calendar'),
      el('p', { class: 'muted' }, 'Changing the calendar re-labels every stored day: records stay attached to the same absolute day number, not to a month name.'),
      el('div', { class: 'grid2' },
        field('Calendar name', el('input', { name: 'cal_name', value: c.name || '' })),
        field('Year label suffix', el('input', { name: 'yearSuffix', value: c.yearSuffix || '' }), (c.eras || []).length ? 'e.g. IC, AD, MY. Only for years no era covers' : 'e.g. IC, AD, MY'),
        field('First year (epoch)', el('input', { type: 'number', name: 'epochYear', value: c.epochYear }), null, 'The year number of the calendar\'s very first day'),
        field('Weekday of epoch day 1 (0 = first weekday)', el('input', { type: 'number', name: 'weekdayOffset', value: c.weekdayOffset || 0 }), null,
          'Shifts the whole weekday cycle. Change it to line up a known date with the right weekday'),
        field('Date format', el('input', { name: 'dateFormat', value: c.dateFormat || '{W}, {d} {M} {Y}' }), '{W} weekday, {d} day, {M} month, {Y} year, {E} era name, {w} week name (Glorantha)'),
        field('Hours per day', el('input', { type: 'number', name: 'hoursPerDay', value: c.hoursPerDay || 24 }), { shifts4: 'Each of the day\'s four shifts is a quarter of this, for travel too', shifts2: 'Day and Night are half of this each, for travel too', hours: 'The hours in a day, each one its own step on the clock and in the travel planner' }[E.timeMode(c)]),
        field('Default light source', select([['natural', 'Sun & moons'], ['artificial', 'Artificial'], ['none', 'None']], c.lighting || 'natural', { name: 'cal_lighting' }), 'Regions can override',
          'Used for any region that doesn\'t set its own. See the Light source help on a region'),
        field('Shift names (4, comma-separated)', el('input', { name: 'shiftNames', value: t.shiftNames }), E.timeMode(c) === 'shifts4' ? null : 'Used when Time tracking is four shifts',
          'Rename the four shifts, in order: morning, midday, evening, then the overnight one. Their lighting stays tied to that order')),
      field('Weekdays (comma-separated; leave empty for no weeks)', ta('weekdays', t.weekdays, 2),
        c.weekdays.length ? `${c.weekdays.length} days a week. The week is as long as this list.` : 'No weeks.',
        'One name per day of the week, in order. A week can have any number of days: 8 in the Imperial Calendar, 6 in Standard Ship Time, 10 for a decade'),
      field('Months — one per line: Name, days, leap days[, festival]', ta('months', t.months, 8), 'Add "festival" for intercalary days that sit outside the weekday cycle (like Mitterfruhl), or "festival weekday" for named days that keep their weekday (like 2 Yule). Days can be 0 for a leap-only day (like Overlithe: 0, 1, festival)'),
      el('div', { class: 'grid3' },
        field('Leap year every N years (0 = none)', el('input', { type: 'number', name: 'leap_every', value: L.every || 0 }), null, 'Leap years add each month\'s leap days. Gregorian: 4'),
        field('…except every N years', el('input', { type: 'number', name: 'leap_skip', value: L.skip || 0 }), null, 'Years divisible by this are not leap years after all. Gregorian: 100'),
        field('…unless every N years', el('input', { type: 'number', name: 'leap_unskip', value: L.unskip || 0 }), null, 'Years divisible by this are leap years again. Gregorian: 400')),
      leapNote,
      field('Eras — one per line: Name, abbreviation, first year[, restart | before]', ta('eras', t.eras, 3),
        'e.g. Dale Reckoning, DR, 1. Add "restart" to count the era\'s years from 1, or "before" for the years before it, counted back (1 BCE)',
        'An era runs from its first year until the next one starts, and its abbreviation replaces the year suffix (1492 DR). Only one era can be "before". Leave the box empty for no eras.\nYears are typed and stored as calendar years; eras only change how they are labelled. Date pickers take the year in an era, with the era picked next to it. Use {E} in the date format to show the era\'s full name'),
      el('h3', {}, 'Seasons'),
      field('Season dates are for the', select([['north', 'Northern hemisphere'], ['south', 'Southern hemisphere']], c.hemisphere || 'north', { name: 'cal_hemisphere' }),
        'Regions in the other hemisphere get the opposite season'),
      seasons,
      el('small', { class: 'muted' }, 'Start months use the saved month list; save month changes first, then adjust seasons.'),
      field('Moons — one per line: Name, cycle days, reference day, brightness 0–1, color[, erratic][, red moon]', ta('moons', t.moons, 3), 'Reference day = an absolute day number when the moon is new. Today is absolute day ' + today() + '. "red moon" makes it Glorantha\'s Red Moon: its phase follows the weekday (Black on the third, Full on the sixth) and the land each region sees it from.'),
      el('details', {}, el('summary', {}, 'Advanced: raw calendar JSON'), ta('raw', JSON.stringify(c, null, 1), 12),
        el('small', { class: 'muted' }, 'If you edit this box, it is saved instead of the fields above.')),
      el('button', { class: 'primary' }, 'Save calendar'));
    const rawInitial = calForm.elements.raw.value;
    calForm.addEventListener('input', e => { if (/^(months|leap_)/.test(e.target.name || '')) drawLeap(); });
    drawLeap();
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

    const presetSel = select(E.presetOptions(), 'gregorian');
    async function importCalendar() {
      try {
        const r = await CalendarFile.pick();
        if (!r) return;
        const name = r.calendar.name || 'the calendar';
        if (!await confirmDialog(`Replace this campaign's calendar with ${name} from the file? Stored days keep their absolute day numbers.`)) return;
        // holidays the campaign doesn't have yet, by name
        const have = new Set(S.holidays.map(h => h.name.toLowerCase()));
        const fresh = r.holidays.filter(h => !have.has(h.name.toLowerCase()));
        const addHolidays = fresh.length && await confirmDialog(`Also add the file's ${fresh.length} holiday${fresh.length === 1 ? '' : 's'} this campaign doesn't have (${fresh.map(h => h.name).join(', ')})?`);
        await post('campaign_update', { calendar: { ...r.calendar, timeMode: E.timeMode(c) } }, S.camp.id);
        if (addHolidays) for (const h of fresh) await post('holiday_save', h, S.camp.id);
        await loadCampaign(S.camp.id, true); toast(`Imported ${name}${addHolidays ? ` and ${fresh.length} holiday${fresh.length === 1 ? '' : 's'}` : ''}`); route();
      } catch (err) { toast(err.message, true); }
    }
    /** Import from Scabard: pick the export, say what is in it and how session logs will come in, then send it in
     * batches (pages, then connections, then one request per picture), saying where it has got to; the counts at the end. */
    async function importScabard() {
      let data;
      try {
        const text = await Scabard.pick();
        if (text === null) return;
        data = Scabard.parse(text);
      } catch (err) { toast(err.message, true); return; }
      const cid = S.camp.id;
      const sessionsSel = select([['sessions', 'Sessions'], ['entries', 'Encyclopedia entries']], S.sessionsReady ? 'sessions' : 'entries', { name: 'sessions', 'aria-label': 'What dated events become' });
      const pics = el('input', { type: 'checkbox', name: 'pictures', checked: true });
      const what = el('ul', { class: 'scabard-plan' });
      const status = el('p', { class: 'small muted scabard-status', 'aria-live': 'polite' });
      const draw = () => {
        const plan = Scabard.plan(data, { sessions: sessionsSel.value === 'sessions' });
        const n = (c, one, many) => `${c} ${c === 1 ? one : many || `${one}s`}`;
        what.replaceChildren(...clean([
          el('li', {}, el('strong', {}, n(plan.entries, 'Encyclopedia entry', 'Encyclopedia entries')), plan.entries ? `: ${Object.entries(plan.kinds).map(([k, c]) => `${c} ${k}`).join(', ')}` : ''),
          plan.sessions ? el('li', {}, el('strong', {}, n(plan.sessions, 'session log')), sessionsSel.value === 'sessions' ? ', each a Session played on its date' : '') : null,
          el('li', {}, el('strong', {}, n(plan.connections, 'connection')), ' between them'),
          plan.pictures ? el('li', {}, el('strong', {}, n(plan.pictures, 'picture')), ' on Scabard') : null,
          Object.keys(plan.skipped).length ? el('li', { class: 'muted' }, 'Left out: ', Object.entries(plan.skipped).map(([k, c]) => `${c} ${k}`).join(', '), ' (Scabard\'s own structure)') : null]));
      };
      sessionsSel.addEventListener('change', draw);
      draw();
      const go = el('button', { type: 'button', class: 'primary' }, 'Import');
      const cancel = el('button', { value: 'cancel', type: 'submit' }, 'Cancel');
      const d = el('dialog', { class: 'kit-dialog scabard-dialog', 'aria-label': 'Import from Scabard' },
        el('form', { method: 'dialog' },
          el('h3', {}, '⬆ Import from Scabard'),
          el('p', { class: 'small muted' }, 'The export holds:'), what,
          el('div', { class: 'row small' }, el('label', {}, 'Dated events (2025-10-05: Final Preparations) become ', sessionsSel)),
          S.encUploads?.ready !== false ? el('label', { class: 'row small' }, pics, ' Copy each page\'s picture from Scabard') : null,
          el('p', { class: 'small muted' }, 'Everything comes in by name: an entry that already has a name in the file is kept as it is (one with nothing written in it yet is filled in), and tags and connections are added only where missing, so the import can be run again after Scabard changes. Nothing is deleted.'),
          status,
          el('div', { class: 'kit-dialog-actions' }, go, cancel)));
      d.addEventListener('cancel', e => { if (go.disabled) e.preventDefault(); else d.returnValue = 'cancel'; });
      d.addEventListener('close', () => d.remove());
      let total;
      const add = r => {
        for (const k of ['added', 'filled', 'kept']) total.entries[k] += r.entries[k];
        for (const k of ['added', 'kept']) total.sessions[k] += r.sessions[k];
        for (const k of ['tags', 'connections', 'lines']) total[k] += r[k];
        for (const k of ['pages', 'connections', 'unresolved']) total.skipped[k] += r.skipped[k];
        total.pictures.push(...r.pictures); total.elsewhere.push(...r.elsewhere);
      };
      go.addEventListener('click', busy(go, async () => {
        cancel.disabled = sessionsSel.disabled = pics.disabled = true;
        total = { entries: { added: 0, filled: 0, kept: 0 }, sessions: { added: 0, kept: 0 }, tags: 0, connections: 0, lines: 0, skipped: { pages: 0, connections: 0, unresolved: 0 }, pictures: [], elsewhere: [] };
        try {
          const options = { sessions: sessionsSel.value };
          const pages = Scabard.order(data.pages, options.sessions === 'sessions');
          let done = 0;
          for (const batch of Scabard.batches(pages, Scabard.PAGES_MAX)) {
            status.textContent = `Importing pages ${done + 1}–${done + batch.length} of ${pages.length}…`;
            add(await post('scabard_import', { pages: batch, options }, cid));
            done += batch.length;
          }
          done = 0;
          for (const batch of Scabard.batches(data.conns, Scabard.CONNS_MAX)) {
            status.textContent = `Connecting ${done + 1}–${done + batch.length} of ${data.conns.length}…`;
            add(await post('scabard_import', { conns: batch, options }, cid));
            done += batch.length;
          }
          const copied = [], had = [], missed = [...total.elsewhere.map(n => `${n} (not on Scabard)`)];
          if (pics.checked) for (const [i, p] of total.pictures.entries()) {
            status.textContent = `Copying picture ${i + 1} of ${total.pictures.length}: ${p.name}…`;
            try {
              const r = await post('scabard_picture', p, cid);
              if (r.copied) copied.push(p.name); else if (r.skipped === 'has_picture') had.push(p.name); else missed.push(p.name);
            } catch (err) {
              missed.push(`${p.name} (${err.message})`);
              if (err.status === 409) { missed.push(...total.pictures.slice(i + 1).map(x => x.name)); break; } // uploads aren't set up here: no use trying the rest
            }
          }
          d.returnValue = 'done'; d.close();
          const e = total.entries, s = total.sessions, lines = [];
          lines.push(`Entries: ${e.added} added, ${e.filled} filled in, ${e.kept} kept as they were.`);
          if (s.added || s.kept) lines.push(`Sessions: ${s.added} added, ${s.kept} kept.`);
          lines.push(`${total.connections} connection${total.connections === 1 ? '' : 's'}, ${total.tags} tag${total.tags === 1 ? '' : 's'} and ${total.lines} line${total.lines === 1 ? '' : 's'} of notes added.`);
          if (pics.checked) lines.push(`Pictures: ${copied.length} copied${had.length ? `, ${had.length} already there` : ''}${missed.length ? `, ${missed.length} not fetched (${missed.slice(0, 8).join(', ')}${missed.length > 8 ? '…' : ''})` : ''}.`);
          if (total.skipped.unresolved) lines.push(`${total.skipped.unresolved} connection${total.skipped.unresolved === 1 ? '' : 's'} named a page that isn't in the file.`);
          await alertDialog(lines.join('\n'), { title: 'Imported from Scabard' });
          await loadCampaign(cid, true);
          route();
        } catch (err) {
          status.textContent = `Stopped: ${err.message}. Import again carries on from here (nothing is added twice).`;
          cancel.disabled = false;
          throw err;
        }
      }));
      document.body.append(d);
      d.showModal();
    }
    const danger = el('div', { class: 'card' }, el('h2', {}, 'Tools'),
      el('div', { class: 'row' }, presetSel, tipped(btn('Replace calendar with preset', async () => {
        if (!await confirmDialog('Replace this campaign\'s calendar with the preset? Stored days keep their absolute day numbers.')) return;
        await post('campaign_update', { calendar: { ...E.PRESETS[presetSel.value].calendar, timeMode: E.timeMode(c) } }, S.camp.id);
        await loadCampaign(S.camp.id, true); route();
      }, 'small'), 'Swap in the preset\'s months, weekdays, moons and seasons. Days, events and regions stay')),
      el('div', { class: 'row' },
        btn('⬇ Export calendar', () => CalendarFile.download(S.camp, S.holidays), 'small',
          'Download this calendar and its holidays as a JSON file, to keep as a backup or to start another campaign on it (New campaign → Import calendar from file). Days, events and notes are not in it'),
        btn('Import calendar…', importCalendar, 'small',
          'Replace this campaign\'s calendar with one from a JSON file exported here. Days, events and regions stay, and you can add the file\'s holidays too')),
      el('div', { class: 'row' }, btn('⬆ Import from Scabard…', importScabard, 'small',
        'Bring a campaign over from Scabard: its Export campaign .json file becomes Encyclopedia entries with their tags, other names, notes, GM secrets, connections and pictures, and its dated session logs become Sessions. Safe to run again: nothing is added twice or deleted')),
      el('div', { class: 'row' }, btn('Delete this campaign', async () => {
        const typed = await promptDialog(`Type DELETE to permanently delete "${S.camp.name}" and everything in it.`, { title: 'Delete campaign', ok: 'Delete', danger: true });
        if (typed === null) return;
        if (typed.trim().toUpperCase() !== 'DELETE') { toast('Not deleted: type DELETE to confirm', true); return; }
        try { await post('campaign_delete', { confirm: 'DELETE' }, S.camp.id); S.camp = null; location.hash = '#/'; } catch (err) { toast(err.message, true); }
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
    const fanAbout = Fan ? Fan.about(fanCtx()) : null;
    const p = (...t) => el('p', {}, ...t);
    const list = items => el('ul', {}, items.filter(Boolean).map(i => el('li', {}, ...[i].flat())));
    mount(
      el('div', { class: 'card about' },
        el('h1', {}, 'About Campaign Chronicle'),
        p('Campaign Chronicle is a tracker for tabletop campaigns: an in-game calendar, weather, moons, visibility, events and a travel planner. ',
          'This page lists where every built-in figure comes from: the sample speeds and distances in the travel planner, the climate baselines behind the weather, and the calendar presets.'),
        p('Open sources come first: Wikipedia articles (CC BY-SA 4.0, which in turn cite national weather services, NOAA, NASA and the like), ',
          'NASA, JPL and other US government pages (public domain), UK government statistics (Open Government Licence) and openly licensed papers. ',
          'Where a figure has no open source, such as the fictional settings, the source is still credited with its owner and terms, and this page says so under "No open source" at the bottom.'),
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
          ['Hyperspace: a hyperdrive\'s class multiplies the trip time, Class 1 being the stock drive and Class 0.5 twice as fast, from ', cite('falcon'),
            '. The other classes, the route multipliers and the sample trip times are the app\'s own guide (see "No open source" below).'],
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
        p('The wind speeds shown for Calm, Breezy, Windy and Gale are Beaufort forces 0–3, 4–5, 6–7 and 8 and up: ', cite('beaufort'), '. ',
          'The rates the weather tooltips give for rain, snow and hail are the usual intensity bands, rounded: ', cite('rain'), ', ', cite('snowfall'), ' and ', cite('hail'), '.'),
        p('Game tuning, not measurements: how often thunderstorms, fog and dust storms turn up (0–3) in each class, the weather mix of the simple climates, ',
          'how each kind of weather changes visibility, how the four shifts ease off from the day\'s forecast, and the ground conditions model (how much snow and rain each kind of weather leaves, ',
          'how fast it melts and dries, and where the ground turns soft, muddy or frozen). These are the app\'s own choices.')),
      section('Calendars and holidays',
        list([
          ['Gregorian calendar months and leap years: ', cite('gregorian'), '. Season start dates (equinoxes and solstices): ', cite('usno'), '.'],
          ['Preset sunrise and sunset times: local solar time on each season\'s start date at about 45° latitude, from ', cite('sunrise'), '.'],
          ['The Moon\'s mean synodic month (29.530588 days) and reference new moon of 6 January 2000, 18:14 UT: ', cite('phases'), '.'],
          ['New Year\'s Day, Thanksgiving (fourth Thursday in November) and Christmas Day: ', cite('usHolidays'), '. Christmas Eve: ', cite('xmasEve'), '.'],
          ['Middle-earth (Shire Reckoning): months, Yule and Lithe days, the Overlithe leap rule and the fixed weekdays from Appendix D of The Lord of the Rings, as summarised by ', cite('shire'), '.'],
          ['Imperial Calendar (Warhammer Fantasy): months, festival days, weekdays and the two moons: ', cite('imperial'), ' and ', cite('imperialMoons'), '.'],
          ['Glorantha (Orlanthi calendar): seasons, weeks and weekdays from ', cite('balazar'), ' and ', cite('orlanthi'), '; the cults\' holy days from ', cite('runequestCults'), '.'],
          ['Forgotten Realms (Calendar of Harptos): months, tendays, the festival days, Shieldmeet and the equinox and solstice dates from ', cite('harptos'), '; Selûne\'s cycle and a known full moon from ', cite('selune'), '.'],
          ['Eberron (Galifar Calendar): months, weekdays, seasons and the twelve moons\' names from ', cite('galifar'), '; the holidays from ', cite('galifarHolidays'), '.'],
          ['Exandria (Critical Role): months, weekdays, seasons and holidays from ', cite('exandria'), '; the moons from ', cite('catha'), ' and ', cite('ruidus'), '.'],
          ['Golarion (Absalom Reckoning): months, weekdays and Leap Day from ', cite('absalom'), '; the holidays from ', cite('golarionHolidays'), '.'],
          ['Star Wars (Galactic Standard Calendar): the ten months, the five-day week and the three festival weeks from ', cite('gsc'), ', ', cite('gscWeek'), ' and ', cite('gscYear'),
            '; the worlds given as regions from ', cite('wookPlanets'), '.'],
          ['Greyhawk (Common Year): the months, the four festival weeks, the weekdays and Luna and Celene from ', cite('greyhawkCal'), '; the festivals\' placement and the moons\' full nights from ', cite('greyhawkMonth'), '.'],
          ['Iron Kingdoms (Morrowan calendar): the thirteen months, the four named weeks, the equinoxes, solstices and holidays from ', cite('ikCalendar'), '; the Longest Night every third year from ', cite('ikLongestNight'), '.'],
          ['Dark Sun (Calendar of Kings): the 375-day year, months, festival weeks, six-day week and Free Years from ', cite('athasCalendar'), '; the moons\' cycles from ', cite('athasMoons'), '.'],
          ['Rokugan (Isawa Calendar): the twelve months, the seasons, the year count and the Setsuban Festival from ', cite('rokuganTime'), '.'],
          ['Traveller (Imperial Calendar): the 365-day year, Holiday, the 52 seven-day weeks and the weekday names from ', cite('travellerCal'), '.'],
          ['The Witcher (elven calendar): the eight savaeds, their lengths and opening holidays from ', cite('elvenCalendar'), '.'],
          'The Starship clock and the Custom calendar are made up for this app.',
        ])),
      section('Game rules',
        p('The four shifts of a day, the shift tasks under "Add an action" and the terrain multipliers follow ', cite('yze'), '. ',
          'The visibility score (0–5), its base values per shift and its modifiers are this app\'s own design.')),
      section('Software and fonts',
        list([
          ['The notes editor: ', cite('quill'), '.'],
          ['Typefaces, self-hosted: ', cite('inter'), ' and ', cite('barlow'), '.'],
          'The Proper Noun Detector\'s list of common English words, and every other word list in the app, was written for it.',
          ['Generate Summary on an Encyclopedia entry: the matching articles and their summaries come from ', extLink({ url: 'https://en.wikipedia.org/', title: 'Wikipedia' }),
            ' (CC BY-SA 4.0), through its public API, and only when the button is pressed. Each summary added to an entry\'s notes links to its article and names the licence.'],
          ['Find Image on an Encyclopedia entry searches, only when asked: ', extLink({ url: 'https://openverse.org/', title: 'Openverse' }),
            ' (openly licensed pictures from Flickr, Wikimedia Commons, museums and more), the public-domain collections of ',
            extLink({ url: 'https://www.metmuseum.org/hubs/open-access', title: 'The Met (Open Access)' }), ' and the ',
            extLink({ url: 'https://www.artic.edu/open-access/public-api', title: 'Art Institute of Chicago (public API)' }), ' and the ',
            extLink({ url: 'https://www.si.edu/openaccess', title: 'Smithsonian (Open Access)' }), ', and ',
            extLink({ url: 'https://www.deviantart.com/', title: 'DeviantArt' }), '. Only pictures under CC0, a public domain mark, CC BY or CC BY-SA are copied, ',
            'each with its title, artist, licence and source shown under it. Other DeviantArt works can only be embedded: the app keeps the link, and the picture is shown from DeviantArt, credited to its artist.'],
          fanAbout ? [fanAbout.used] : null,
          'The Generators tab\'s names, syllables, rumors and templates were written for it too. Its real-world given and family names are common names picked by hand; no name list or database was copied.',
        ])),
      section('No open source',
        p('These figures cannot come from open data, so they are the app\'s judgement or come from sources that are not openly licensed:'),
        list([
          ['Imperial Calendar preset (Warhammer Fantasy, © Games Workshop): the calendar, its holidays and moons follow the official setting via a fan wiki, ',
            'and the region climates are judgement calls from each region\'s real-world analogue (the Empire as Germany, Bretonnia as France, Kislev as Russia), using the Köppen classes above.'],
          ['Middle-earth preset (© the Tolkien Estate): the calendar follows the books. Region climates were first taken from ', cite('imaginarymaps'),
            ' and fit Tolkien\'s own latitude anchors: ', cite('letter294'), '.'],
          ['Glorantha preset (© Chaosium): the calendar and holy days follow the official setting via fan sources. Glorantha is flat and its seasons are the same everywhere; region climates are judgement calls from ', cite('gloranthaGeo'),
            ' (cold toward the Glacier in the north, hot toward Pamaltela in the south) and ', cite('gloranthaWeather'), ', using the Köppen classes above. The Red Moon\'s weekly phases (Black on Clayday, Full on Wildday from Dragon Pass) and the phase each land sees at once come from ', cite('redMoonForum'),
            '; which band each preset region falls in is a judgement call, and a region the thread doesn\'t place sees it as Dragon Pass does.'],
          'Forgotten Realms preset (© Wizards of the Coast): the calendar and Selûne follow the official setting via a fan wiki. Region climates are judgement calls from each region\'s real-world analogue (the Sword Coast as Atlantic Europe, Amn and Tethyr as Spain, Calimshan as North Africa), using the Köppen classes above.',
          'Eberron preset (© Wizards of the Coast): the calendar follows the official setting via a fan wiki, and the holidays via a fan world page. The setting gives the twelve moons no cycles, so the app makes Zarantyr full every 28 days and each farther moon a week slower. Region climates are judgement calls (the Five Nations as temperate Europe, Q\'barra and Xen\'drik as jungle); the Mournland\'s weather is magical, so it keeps Cyre\'s old climate.',
          'Exandria preset (© Critical Role): the calendar follows the official setting via a fan wiki. Which weekday the year starts on is not given, and Catha\'s 33-day and Ruidus\'s 164-day cycles are the app\'s choice within what the wiki says. Region climates are judgement calls (Tal\'Dorei and the Dwendalian Empire as temperate Europe, Marquet as North Africa).',
          'Golarion preset (© Paizo): the calendar follows the official setting via a fan wiki; weekdays line up with the real year 2700 years earlier, and Somal is given the Moon\'s mean synodic month. Holidays that fall on an equinox or solstice take the seasons\' usual days. Region climates are judgement calls (the Inner Sea as the Mediterranean, Osirion as Egypt, the Mwangi Expanse as the Congo).',
          ['Star Wars preset (© Lucasfilm): the calendar follows Wookieepedia, which notes that sources disagree (some give a 368-day year with three extra holidays, others twelve months). ',
            'The app keeps the ten-month version, 365 days, without the three holidays, whose dates no source gives. Wookieepedia numbers the months rather than naming them, so the app calls them Month 1 to Month 10. ',
            'There are no seasons or moons, since each world has its own. Region climates are judgement calls from how each world is shown (Tatooine and Jakku as hot desert, Hoth as ice cap, Endor and Kashyyyk as forest), using the Köppen classes above. ',
            'In the travel planner, hyperdrive classes other than 0.5 and 1, the route multipliers and the sample trip times are the app\'s own guide, as the films leave trip times loose.'],
          ['Greyhawk preset (© Wizards of the Coast): the calendar follows a fan wiki, with the festivals and the moons\' full nights from the Greyhawk Online wiki, which states no licence. Sources disagree on the year (360 days in 1980 and in 2024, 364 in between); the app keeps 364. The year is counted in CY and starts in 576 CY, the app\'s choice. Region climates are judgement calls from each region\'s real-world analogue, using the Köppen classes above.'],
          ['Iron Kingdoms preset (© Privateer Press): the calendar follows a fan wiki. The weekdays are numbered because no source names them, Calder and Laris are full on Katesh 28 and Khadoven 28 but no cycle is given, so there are no moons, and the Longest Night every third year comes from a fan\'s calendar sheet. The year starts in 604 AR, the app\'s choice. Region climates are judgement calls.'],
          ['Dark Sun preset (© Wizards of the Coast): the calendar follows ', cite('athasCalendar'), ' and the moons ', cite('athasMoons'), ', neither openly licensed. The years are counted in Free Years, not the 77-year King\'s Age names, and the first day\'s moon phases are the app\'s choice. The three seasons are mapped to summer, autumn and spring. Region climates are judgement calls (desert and steppe).'],
          ['Rokugan preset (© Fantasy Flight Games / Asmodee): the calendar follows a fan wiki. It names no weekdays and no moon, so there are none, and the year starts in 1123 IC, the app\'s choice. Region climates are judgement calls (Japan and China for the Empire).'],
          ['Traveller preset (© Mongoose Publishing): the calendar follows the Traveller Wiki (CC BY-NC, non-commercial). The wiki names no months, so the 52 weeks are used as months. The year starts in 1105 IC, the usual Third Imperium year. Regions are kinds of world.'],
          ['The Witcher preset (© CD Projekt / Andrzej Sapkowski): the wiki gives only the elves\' calendar, so that is the preset. It has no weekdays or era, and the moon\'s phase and the year 1272 are the app\'s choice. Region climates are judgement calls.'],
          'Four rare Köppen classes have no weather station with published open normals squarely in them: Csc and Dwd borrow the nearest bordering station, and the Cwc and Dsd stations sit on their class line. Each is noted in the climate table.',
          ['DeviantArt, through its API and oEmbed, for Find Image: artists there keep their copyright unless they chose a Creative Commons licence, so the app copies only works under an open one and embeds the rest, linked to the work and its artist. ',
            'If an artist or DeviantArt asks, a work will be removed.'],
          fanAbout ? [fanAbout.nonOpen] : null,
          'Storm, fog and dust frequencies, the weather mixes of the simple climates, the ground conditions model and the visibility rules (see above).',
          ['Fan sites and pages used above that are not openly licensed, each credited where it is used: the Warhammer Fantasy Lexicanum (CC BY-NC, non-commercial use only), ',
            cite('balazar'), ', ', cite('runequestCults'), ', ', cite('gloranthaWeather'), ', ', cite('redMoonForum'), ', ', cite('galifarHolidays'), ' and ', cite('imaginarymaps'), '. ',
            'Each was used only for facts (dates, names, cycles and climate zones), not copied text. If an owner asks, the figures taken from their page will be replaced or removed.'],
        ])));
  }

  // ------------------------------------------------------------ search page
  // Which heading each kind of text from encyclopedia_sources goes under. Encyclopedia entries and events come from their
  // own lists instead, which also carry their aliases and tags.
  const SEARCH_GROUPS = [['entry', 'Encyclopedia'], ['day', 'Days and events'], ['session', 'Sessions'], ['tome', 'Library'], ['holding', 'Party Holdings'], ['downtime', 'Downtime']];
  const searchGroupOf = kind => (kind.startsWith('downtime') ? 'downtime' : kind.startsWith('session') ? 'session' : ['holding', 'storage', 'gear', 'funds'].includes(kind) ? 'holding'
    : kind === 'tome' ? 'tome' : 'day');

  /** The Search page: everything in the campaign this member may read, matched on every word typed. The server sends a
   * player nothing secret, so a player's search can't find it either. */
  async function viewSearch(q0) {
    const cid = S.camp.id, gm = isGM();
    const [{ sources }, enc, { events }] = await Promise.all([api('encyclopedia_sources', { query: { cid } }),
      S.encReady ? api('encyclopedia', { query: { cid } }) : { entries: [] }, api('events', { query: { cid } })]);
    // Each result: a title, a link, where it sits in time (for sorting the days), and its text in segments, each GM only or not.
    const items = new Map();
    const item = (key, group, title, href, at = Infinity) => items.get(key) || (items.set(key, { group, title, href, at, segs: [], extra: [], secret: false }), items.get(key));
    for (const e of enc.entries || []) {
      const it = item(`entry:${e.id}`, 'entry', e.name, `#/c/${cid}/encyclopedia/${e.id}`);
      it.secret = !!e.is_secret;
      it.extra.push(...(e.aliases || []), ...(e.tags || []).map(t => t.name));
      if (e.aliases?.length) it.segs.push({ text: `Also called ${e.aliases.join(', ')}` });
      it.segs.push({ text: Nouns.plain(e.notes, 'html') });
      if (gm) it.segs.push({ text: Nouns.plain(e.gm_notes, 'html'), secret: true });
    }
    for (const e of events) {
      const a = Number(e.abs_day);
      const it = item(`event:${e.id}`, 'day', `${E.fmtDate(cal(), a, { noWeekday: true })}: ${e.title}`, `#/c/${cid}/day/${a}`, a);
      it.secret = !!Number(e.is_secret);
      it.extra.push(...(e.tags || []).map(t => t.name), e.author || '');
      it.segs.push({ text: e.body || '' }, ...(e.notes || []).map(n => ({ text: n })));
    }
    for (const s of sources) {
      if (['entry', 'entry_gm_notes', 'event', 'event_note'].includes(s.kind)) continue;
      const [label, href] = sourceLabel(s), group = searchGroupOf(s.kind);
      // under its own heading a tome or holding needs no "Library: " in front, and its name isn't repeated as its text
      const it = item(label, group, label.replace(/^(Library|Party Holdings|Sessions): /, ''), href, s.abs_day ?? Infinity);
      let text = Nouns.plain(s.text, s.format);
      if (s.short && s.title && text.startsWith(s.title)) text = text.slice(s.title.length);
      it.segs.push({ text, secret: !!s.secret });
    }
    const all = [...items.values()].map(it => ({ ...it, segs: it.segs.filter(g => g.text.trim()),
      hay: [it.title, ...it.extra, ...it.segs.map(g => g.text)].join('\n').toLowerCase() }));

    const input = el('input', { type: 'search', value: q0, placeholder: 'Names, places, words from any note', 'aria-label': 'Search everything', autocomplete: 'off' });
    const count = el('p', { class: 'small muted', 'aria-live': 'polite' });
    const out = el('div', { class: 'search-results' });
    const clip = (text, words) => {  // a stretch of text around the first word found in it
      const flat = text.replace(/\s+/g, ' ').trim(), low = flat.toLowerCase();
      const at = Math.min(...words.map(w => low.indexOf(w)).filter(i => i >= 0));
      if (!Number.isFinite(at) || flat.length <= 220) return flat.length > 220 ? `${flat.slice(0, 219).trimEnd()}…` : flat;
      const from = Math.max(0, at - 70), to = Math.min(flat.length, from + 220);
      return (from ? '…' : '') + flat.slice(from, to).trim() + (to < flat.length ? '…' : '');
    };
    const row = (it, words) => {
      const seg = it.segs.find(g => words.some(w => g.text.toLowerCase().includes(w))) || it.segs[0];
      const secret = it.secret || seg?.secret;
      return el('div', { class: 'listrow search-row' + (secret ? ' secret' : '') },
        el('h4', {}, secret ? secretTag() : null, el('a', { href: it.href }, markWords(it.title, words))),
        it.extra.filter(Boolean).length && it.group === 'entry' ? el('div', { class: 'small muted' }, it.extra.filter(Boolean).join(' · ')) : null,
        seg ? el('p', { class: 'small' }, markWords(clip(seg.text, words), words)) : null);
    };
    const draw = () => {
      const q = input.value.trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
      history.replaceState(null, '', location.pathname + location.search + searchHref(q));
      if (!words.length) { count.textContent = ''; out.replaceChildren(el('p', { class: 'muted' }, 'Type a name or a few words. Every word has to appear, in any order.')); return; }
      const hits = all.filter(it => words.every(w => it.hay.includes(w)));
      count.textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : '';
      if (!hits.length) { out.replaceChildren(el('p', { class: 'muted' }, 'Nothing in the campaign matches every word.')); return; }
      // names and titles that match come first; days and events then run in date order
      const inTitle = it => (words.some(w => it.title.toLowerCase().includes(w) || it.extra.some(x => x.toLowerCase().includes(w))) ? 0 : 1);
      out.replaceChildren(...clean(SEARCH_GROUPS.map(([g, heading]) => {
        const list = hits.filter(it => it.group === g).sort((a, b) => inTitle(a) - inTitle(b) || a.at - b.at || a.title.localeCompare(b.title));
        if (!list.length) return null;
        return el('section', { class: 'card search-group' }, el('h3', {}, heading, el('span', { class: 'muted small' }, ` ${list.length}`)),
          list.slice(0, 50).map(it => row(it, words)),
          list.length > 50 ? el('p', { class: 'small muted' }, `and ${list.length - 50} more: add a word to narrow them down`) : null);
      })));
    };
    input.addEventListener('input', draw);
    mount(...campaignHeader('search'), el('div', { class: 'card' }, el('h2', {}, 'Search',
      tip(gm ? 'Everything in the campaign, GM notes and secrets included (marked 🔒)' : 'Everything in the campaign you can see')), input, count), out);
    draw();
    input.focus();
  }

  // ------------------------------------------------------------ router
  // Pages draw one at a time, in order, so a page still loading when the address changes again (Back while a day loads)
  // can't draw over the newer one, or over what has been typed in it. One that a newer address replaced before it began is skipped.
  let routeSeq = 0, routeRun = Promise.resolve();
  function route() {
    const seq = ++routeSeq;
    return (routeRun = routeRun.then(() => (seq === routeSeq ? routeTo() : null)).catch(err => console.error(err)));
  }
  async function routeTo() {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = (path || '').split('/');
    if (parts[0] === 'about') { renderNav(); return viewAbout(); } // readable signed out too
    if (!S.user) return; // boot() shows the sign-in or waiting screen
    renderNav();
    try {
      if (parts[0] === '') return await viewCampaigns();
      if (parts[0] === 'account') return await viewAccount(); // awaited, so a failed load lands in the catch below
      if (parts[0] === 'admin') return await viewAdmin();
      if (parts[0] === 'new') return viewCreate(); // its own address, so Cancel (back to #/) is a real change of page
      if (parts[0] === 'c') {
        const cid = Number(parts[1]);
        await loadCampaign(cid);
        const rem = await loadReminders().catch(() => null); // fresh on every page, so a pass of time pops what it reached
        const tab = parts[2] || 'today';
        const viewToday = () => viewDay(today(), true);
        if (tab === 'day') await viewDay(Number(parts[3]));
        else if (tab === 'encyclopedia') await viewEncyclopedia(parts[3]);
        else if (tab === 'library') await viewLibrary(parts[3]);
        else if (tab === 'sessions') await viewSessions(parts[3]);
        else if (tab === 'search') await viewSearch(new URLSearchParams(query || '').get('q') || '');
        else if (tab === 'today' && parts[3]) await viewDay(Number(parts[3]), true);
        else await ({ today: viewToday, calendar: viewCalendar, events: viewEvents, travel: viewTravel, downtime: viewDowntime, holdings: viewHoldings, generators: viewGenerators, regions: viewRegions, holidays: viewHolidays, members: viewMembers, settings: viewSettings }[tab] || viewToday)();
        if (rem) popDueReminders(rem);
        return;
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
  // Makes the app installable in Chrome and Edge (with manifest.webmanifest). Needs HTTPS, or localhost.
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  boot();
})();
