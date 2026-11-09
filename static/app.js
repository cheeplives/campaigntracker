/* Campaign Chronicle — browser app (plain JS, no build step).
 * All user-supplied text is inserted with textContent (via el()), never innerHTML. Rich text notes are rebuilt
 * element by element from an allow-list by RichText.view() (static/richtext.js).
 * Permissions are enforced by api/index.php; the UI only hides controls a role can't use.
 * Sign-in is Google/GitHub with an admin approval queue, the same as Sinless (api/auth/). */
(function () {
  'use strict';
  const E = window.Engine;
  /** panel.html: At the Table on its own, signed in with a panel link (see "the panel" below). */
  const PANEL = document.documentElement.hasAttribute('data-panel');

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
  /** A GM only switch: the checkbox given (its aria-label is "GM only" unless it has one), shown as the 🔒 button the
   * rich text editor marks GM-only paragraphs with. lockField puts it where a form's other fields are. */
  function lockBox(input, tipText) {
    if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', 'GM only');
    return el('label', { class: 'lock-toggle', 'data-tip': tipText ? `GM only: ${tipText}` : 'GM only' }, input, el('span', { 'aria-hidden': 'true' }, '🔒'));
  }
  const lockField = (input, tipText) => el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'GM only'), lockBox(input, tipText));
  const btn = (label, onclick, cls, tipText) => el('button', { type: 'button', class: cls || '', onclick, 'data-tip': tipText }, label);
  /** The ⋯ beside a row's everyday buttons: the rarer and riskier actions (Copy, Delete) wait behind it, as on a map's ⚙ */
  /** A row of choice buttons (Month / Week / Year): the one with class "on" is also aria-pressed, as on the map's toolbar */
  const pressedSeg = seg => { seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on')))); return seg; };
  const moreMenu = (name, ...items) => KIT.menu({ label: '⋯', ariaLabel: `More for ${name}`, tip: 'More: copy, delete and the like', items, cls: 'more-menu' });
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
  const APP_VERSION = '31';
  async function api(action, { query = {}, body = null } = {}) {
    const qs = new URLSearchParams({ a: action, ...query }).toString();
    const opt = { method: body ? 'POST' : 'GET', credentials: PANEL ? 'omit' : 'same-origin', headers: { Accept: 'application/json' } };
    if (PANEL) {
      // In another site's frame, a change needs this panel's own "Allow changes here" first (panelFooter), so a page
      // that frames it can't trick a click into passing time or adding a note. The weather a GM's panel stores is no change.
      if (body && action !== 'days_save' && panelFramed() && !panelWritesAllowed())
        throw Object.assign(new Error(`Changes are off while ${panelEmbedder()} shows this panel. Turn on Allow changes here, at the bottom, to make them.`), { status: 403 });
      opt.headers['X-Chronicle-Panel'] = panelCodeNow;
    } else if (query.cid && viewingAs(query.cid)) opt.headers['X-View-As'] = 'player';
    if (body) { opt.headers['Content-Type'] = 'application/json'; if (!PANEL) opt.headers['X-CSRF-Token'] = S.csrf; opt.body = JSON.stringify(body); }
    if (body && leaving) opt.keepalive = true;   // a delete still waiting on its Undo, sent as the page goes
    const noteFail = (status, msg) => { if (typeof ReportLog !== 'undefined') ReportLog.request(action, status, msg); };
    const tracked = !!body && !PANEL && action !== 'days_save' && action !== 'changed';   // the campaign bar's "✓ Saved"
    if (tracked) SaveState.begin();
    let res;
    try { res = await fetch('api/index.php?' + qs, opt); } catch (err) { if (!leaving) noteFail(0, err.message); if (tracked) SaveState.end(err.message); throw err; }
    if (tracked) SaveState.end(res.ok ? null : `Not saved (${res.status})`);
    if (res.ok && (action === 'session_save' || action === 'session_delete' || action === 'session_start')) forgetPinSessions();   // the Legend's pinned names
    let data;
    try { data = await res.json(); } catch { noteFail(res.status, 'not JSON'); throw Object.assign(new Error(`Server error (${res.status})`), { status: res.status }); }
    // The panel's link was revoked (or its maker lost access): ask for a new one.
    if (PANEL && (res.status === 401 || data.error === 'not_approved')) {
      if (data.error !== 'panel_not_allowed') { forgetPanelCode(); panelAsk(data.message || 'That panel link no longer works.'); }
      throw Object.assign(new Error(data.message || 'Not allowed'), { status: res.status });
    }
    // Signed out, or access changed while the page was open: go back through the gate.
    if (res.status === 401 || data.error === 'not_approved') { S.user = null; boot(); }
    if (!res.ok) { noteFail(res.status, data.error || data.message); throw Object.assign(new Error(data.message || data.error || `Error ${res.status}`), { status: res.status }); }
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

  // A reload or a close cuts off any request still on its way, and Safari rejects it as "TypeError: Load failed". The
  // page is going, so nothing is lost and no one is there to tell: a request that fails that way while leaving isn't a fault.
  let leaving = false;
  addEventListener('beforeunload', () => { leaving = true; });
  addEventListener('pagehide', () => { leaving = true; });
  addEventListener('pageshow', () => { leaving = false; });   // back from the back-forward cache

  // One line in the campaign bar says whether everything you changed has reached the server: ✓ Saved, Saving…, Not saved
  // (with what went wrong in its tooltip) or Offline. It follows every change the page sends.
  const SaveState = (() => {
    const node = el('span', { class: 'save-state', role: 'status' });
    let busy = 0, failed = null, sent = false;   // nothing is claimed as saved until something has been changed
    const show = () => {
      const off = navigator.onLine === false;
      node.className = 'save-state' + (off || failed ? ' bad' : busy ? ' busy' : '');
      node.textContent = off ? 'Offline' : busy ? 'Saving…' : failed ? 'Not saved' : sent ? '✓ Saved' : '';
      node.dataset.tip = off ? 'This device is offline. Changes made now will not reach the campaign until it is back online'
        : failed ? `The last change did not save: ${failed}. Try it again` : busy ? 'Sending your change' : 'Everything you changed on this page is saved';
    };
    addEventListener('online', show); addEventListener('offline', show);
    addEventListener('hashchange', () => { if (!busy && !failed) { sent = false; show(); } });   // a new page has changed nothing yet
    show();
    return { node, begin() { busy++; sent = true; show(); }, end(err) { busy = Math.max(0, busy - 1); failed = err || (busy ? failed : null); show(); } };
  })();

  // Undo instead of "Are you sure?": a delete takes the thing off the page at once and says so with an Undo button, and the
  // server is only told 8 seconds later (or sooner: when another delete starts, you go to another page or the tab closes).
  // A redraw of the same page (after a save somewhere on it) keeps the Undo and its time, and hides the row again.
  // Each row that can go this way carries data-undo="<action>:<id>", so a redrawn copy of it is found and hidden too.
  const Undo = (() => {
    let pending = null, bar = null;
    // closed: back to the foot of the screen (it may have been lifted over At the Table's bar), so it slides out of sight
    const close = () => { if (bar) { bar.classList.remove('show'); bar.style.bottom = ''; } };
    const rows = p => [...document.querySelectorAll(`[data-undo="${CSS.escape(p.key)}"]`)];
    async function flush() {
      const p = pending; if (!p) return;
      pending = null; clearTimeout(p.timer); close();
      try { await p.commit(); } catch (err) { p.restore(); toast(err.message, true); }
    }
    function start(p) {
      if (pending) flush();
      const had = document.activeElement;
      p.hash = location.hash;
      p.hide();
      pending = p;
      if (!bar) document.body.append(bar = el('div', { id: 'undo-toast', role: 'status' }));
      const undo = el('button', { type: 'button', class: 'undo-btn', 'aria-label': `Undo: ${p.label}` }, 'Undo');
      undo.addEventListener('click', () => {
        if (pending !== p) return;
        pending = null; clearTimeout(p.timer); close(); p.restore();
        // focus goes back to the row's own Delete (a redraw may have made a new one)
        const again = had?.isConnected && !had.closest('[hidden]') ? had
          : rows(p).find(r => r.isConnected)?.querySelector('button.danger');
        again?.focus();
      });
      bar.replaceChildren(el('span', {}, p.label), undo, el('span', { class: 'undo-bar' }));
      // above At the Table's floating bar, however many rows it wraps to (two on an iPad held upright)
      const tb = document.querySelector('.tv-bar'), tr = tb?.getBoundingClientRect();
      bar.style.bottom = tr && tr.height ? `${Math.max(20, innerHeight - tr.top + 12)}px` : '';
      bar.classList.remove('show'); void bar.offsetWidth; bar.classList.add('show');
      // a toast that comes meanwhile sits above the Undo bar
      document.documentElement.style.setProperty('--undo-clear', `${(parseFloat(getComputedStyle(bar).bottom) || 20) + bar.offsetHeight + 8}px`);
      // the Delete pressed is now hidden, so focus would fall to the page: put it on Undo instead
      if (had && (had === document.body || had.closest('[hidden], .undo-gone'))) undo.focus({ preventScroll: true });
      p.timer = setTimeout(flush, 8000);
    }
    /** True while a delete waits for its Undo on the page now showing: a redraw then keeps it. */
    const samePage = () => !!pending && pending.hash === location.hash;
    /** After a redraw of the same page: hide the redrawn copy of the row that is waiting to go. */
    function reapply() { if (samePage()) pending.hide(); }
    addEventListener('pagehide', () => { flush(); });
    return { start, flush, samePage, reapply, rows };
  })();
  /** A small ⧉ Copy button that puts `text` on the clipboard (what it is, for the toast and its tooltip). */
  const copyButton = (text, what) => btn('⧉ Copy', async () => {
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); toast(`${what} copied`); }
    catch { toast('This browser would not copy it. Select it and press Ctrl+C (⌘C)', true); }
  }, 'small copy-btn', `Copy the ${what.toLowerCase()}`);
  /** A one-line trail above a page's title: [label, href] steps, the last one where you are. */
  const trail = (...steps) => el('nav', { class: 'trail', 'aria-label': 'You are here' }, steps.filter(Boolean).map(([label, href], i, a) => [
    href && i < a.length - 1 ? el('a', { href }, label) : el('span', { 'aria-current': i === a.length - 1 ? 'page' : null }, label),
    i < a.length - 1 ? el('span', { class: 'trail-sep', 'aria-hidden': 'true' }, '›') : null]).flat());
  const shortText = (t, n = 40) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
  /** Take `box` off the page and delete it on the server after the Undo has had its time. `changed` runs after the row
   *  goes or comes back (a ledger's total); it is handed the ledger the row is in, which a redraw may have made anew. */
  const undoDelete = (box, label, action, body, done, changed) => {
    const key = `${action}:${body.id}`;
    box.dataset.undo = key;
    const set = gone => {
      for (const r of new Set([box, ...Undo.rows(p)])) {
        r.hidden = gone; r.classList.toggle('undo-gone', gone);
        // a storage ledger's total: a redrawn ledger counts again through its own weight boxes
        if (r !== box) r.closest('.ledger-rows')?.querySelector('.ledger-row:not([hidden]) input.ledger-w')?.dispatchEvent(new Event('input'));
      }
      changed?.();
    };
    const p = { key, label,
      hide: () => set(true), restore: () => set(false),
      commit: async () => { await post(action, body, S.camp.id); if (done) done(); } };
    Undo.start(p);
  };
  addEventListener('unhandledrejection', e => { if (leaving && e.reason instanceof TypeError) e.preventDefault(); });

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
      diceNotice(r.last_roll);
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
  setInterval(() => (PANEL ? panelPoll() : checkForChanges()), CHANGE_POLL_MS);
  document.addEventListener('visibilitychange', () => (PANEL ? panelPoll() : checkForChanges()));

  // ↑ back to the top of any page, once it has scrolled a screen's worth
  if (!PANEL) {
    const toTop = el('button', { type: 'button', class: 'to-top', 'aria-label': 'Back to the top', 'data-tip': 'Back to the top of the page' }, '↑');
    toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    const showTop = () => toTop.classList.toggle('show', window.scrollY > Math.min(600, window.innerHeight * 0.8));
    window.addEventListener('scroll', showTop, { passive: true });
    document.body.append(toTop);
  }

  // a shift's visibility choice (and other small pop-ups that are <details>) shuts when a click lands elsewhere
  document.addEventListener('click', e => document.querySelectorAll('details.tv-rem[open], details.sess-more-chips[open]')
    .forEach(x => { if (!x.contains(e.target)) x.open = false; }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('details.tv-rem[open], details.sess-more-chips[open]').forEach(x => { x.open = false; }); });

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
    if (reminderOpen || PANEL) return;
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
    S.camp = r.campaign; S.role = r.role; S.regions = r.regions; S.holidays = r.holidays; S.members = r.members; S.invites = r.invites || []; S.tags = r.tags || []; S.reminders = [];
    S.encyclopedia = r.encyclopedia || []; S.encIgnored = r.encyclopedia_ignored || []; S.encTags = r.encyclopedia_tags || [];
    S.mapIndex = r.maps_index || [];
    S.openSession = r.open_session || null;
    S.viewAs = !!r.viewing_as_player;
    E.prep(S.camp.calendar);
    E.setTuning(S.camp.settings?.tuning);
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
        const fresh = withShiftWx(d, regionById(row.region_id) || currentRegion(), row.weather, d === to);
        if (JSON.stringify(fresh.shifts) !== JSON.stringify(row.weather.shifts) || fresh.shift_order !== row.weather.shift_order
          || JSON.stringify(fresh.outlook) !== JSON.stringify(row.weather.outlook)) out.push({ abs_day: d, region_id: row.region_id, weather: fresh });
        prev = row.weather; continue;
      }
      const reg = (row && regionById(row.region_id)) || region;
      const w = E.genWeather(cal(), S.camp.seed, reg, d, prev, 0);
      out.push({ abs_day: d, region_id: reg ? reg.id : null, weather: withShiftWx(d, reg, w, d === to) });
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
  function withShiftWx(d, region, w, withOutlook = false) {
    const { shifts, shift_order, outlook, ...forecast } = w;
    const out = { ...forecast, shifts: E.shiftWeather(cal(), S.camp.seed, region, d, forecast), shift_order: cal().shiftOrder || 'overnight' };
    // the day the clock is on keeps the general outlook for it and the next two days, for players the server sends no
    // seed (the Weather forecast button); it is refreshed whenever the clock reaches a day or the GM opens the campaign
    const keep = withOutlook || d === today() ? E.outlook(cal(), S.camp.seed, region, d, forecast) : null;
    if (keep && keep.length) out.outlook = keep;
    return out;
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
      g.set ? 'The GM set the ground by hand on this day; it carries on from there.' : null,
      `Worked out from the last ${E.GROUND_DAYS} days of weather here: rain and snow, how warm it was, sun and wind. Days with no weather recorded are rolled from the region's climate. A rough guide, not a rule.`];
    return el('span', { class: 'ground', 'data-tip': lines.filter(Boolean).join('\n') }, `${l.icon} ${l.label}`);
  }
  /** The wind this shift in a word, with its speed beside it, e.g. '💨 Windy 25–38 mph'. Null without weather. */
  function windText(w) {
    if (!w || !w.type) return null;
    const lv = w.wind || 0, speed = E.windSpeed(lv, unitSystem());
    return el('span', { class: 'wind', 'data-tip': `Wind this ${word()}: ${E.WIND[lv]}, ${speed} (Beaufort ${E.WIND_SPEEDS[lv].beaufort})` },
      `💨 ${E.WIND[lv]}`, el('span', { class: 'small muted' }, ` ${speed}`));
  }
  /** A temperature rounded to the nearest 5 in the campaign's unit, the way a forecast gives it ('around 15°C'). */
  const roughTemp = c => { const u = tempUnit(); return u === 'none' || typeof c !== 'number' ? '' : `${Math.round(E.toTempUnit(c, u) / 5) * 5}${E.TEMP_UNITS[u]?.sym || '°C'}`; };
  /** The general outlook for day d (forecast w) and the two days after: worked out here where the page has the seed, else
   * the copy the GM's browser saved with today's weather. [] when there is none. */
  function outlookFor(d, region, w) {
    if (!w || !w.type) return [];
    if (S.camp.seed !== undefined && S.camp.seed !== null && !w.partial) return E.outlook(cal(), S.camp.seed, region, d, w);
    return Array.isArray(w.outlook) ? w.outlook.filter(x => x && Number(x.d) >= d) : [];
  }
  /** The Weather forecast button and its pop-up: each day's outlook in words, its rough high and low, and the wind. */
  function forecastButton(d, region, w) {
    const days = outlookFor(d, region, w);
    if (!days.length) return null;
    const open = E.openAir(region);
    const dayName = x => (x.d === d ? 'Today' : x.d === d + 1 ? 'Tomorrow' : E.fmtDate(cal(), x.d).split(',')[0]);
    return el('details', { class: 'tv-rem tv-forecast' },
      el('summary', { class: 'chip', 'data-tip': 'The general weather outlook for today and the next two days. A forecast, not a promise: the weather can turn, and it changes if the party moves on' }, '🌦 Weather forecast'),
      el('div', { class: 'tv-fc-pop surface-float' },
        el('ul', { class: 'forecast-list' }, days.map(x => {
          const def = E.WEATHER[x.type] || {};
          const temps = [x.hi !== null && roughTemp(x.hi) ? `high around ${roughTemp(x.hi)}` : null, x.lo !== null && roughTemp(x.lo) ? `low around ${roughTemp(x.lo)}` : null].filter(Boolean).join(', ');
          return el('li', {}, el('b', {}, dayName(x)), el('span', {}, `${def.icon || ''} ${E.outlookWords(x.type)}`),
            el('span', { class: 'small muted' }, clean([temps ? temps[0].toUpperCase() + temps.slice(1) : null, open ? `${E.WIND[x.wind || 0].toLowerCase()} (${E.windSpeed(x.wind || 0, unitSystem())})` : null]).join(' · ')));
        })),
        el('p', { class: 'small muted' }, 'A general outlook. The weather can turn, and it changes if the party moves on.')));
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
    // Every control in the top bar is the same pill; the page you are on has its pill lit
    const at = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || '';
    const navPill = (href, here, tip, text) => el('a', { href, class: 'nav-pill', 'data-tip': tip, 'aria-current': here ? 'page' : null }, text);
    n.replaceChildren(...clean([
      S.user ? navPill('#/', ['', 'c', 'new'].includes(at), 'All the campaigns you play in or run', 'Campaigns') : null,
      S.user && typeof Sheets !== 'undefined' ? navPill('#/templates', at === 'templates', 'Character sheet templates for every game: use one, fork one, or make your own', 'Sheet templates') : null,
      schemePicker(),
      themeToggle(),
      S.user && reports ? reports.button() : null,
      // Your name opens a menu of what is yours: the account page, the admin's Site Admin, and signing out
      S.user ? KIT.menu({ label: [el('span', { class: 'nav-pill-name' }, S.user.name || S.user.email), el('span', { class: 'nav-caret', 'aria-hidden': 'true' }, '▾')],
        ariaLabel: `Account menu for ${S.user.name || S.user.email}`, cls: `account-menu${['account', 'admin'].includes(at) ? ' is-here' : ''}`,
        tip: `Signed in as ${S.user.email}`, items: [
          el('a', { href: '#/account', class: 'button small', 'data-tip': 'Your name and pronouns, your units and the map scanner key' }, 'Account'),
          S.user.is_admin ? el('a', { href: '#/admin', class: 'button small', 'data-tip': 'Approve sign-ups, manage accounts, and see game requests and problem reports (site admins only)' }, 'Site Admin') : null,
          el('hr'),
          btn('Sign out', signOut, 'small')] })
        : S.pending ? btn('Sign out', signOut, 'nav-pill') : null,
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
    }, 'theme-toggle nav-pill', 'Toggle light / dark mode');
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
    const button = el('button', { type: 'button', class: 'scheme-btn nav-pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Theme: ${cur.name}` },
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
    // The name and pronouns the app calls them by, in place of the name from Google or GitHub (user_profiles, migration 036)
    const nameIn = el('input', { name: 'name', value: S.user.custom_name || '', maxlength: 150, placeholder: S.user.provider_name || 'Your name', autocomplete: 'nickname', 'aria-label': 'Name' });
    const pronIn = el('input', { name: 'pronouns', value: S.user.pronouns || '', maxlength: 40, placeholder: 'e.g. she/her', list: 'pronoun-ideas', 'aria-label': 'Pronouns' });
    const ideas = el('datalist', { id: 'pronoun-ideas' }, ['she/her', 'he/him', 'they/them', 'she/they', 'he/they', 'xe/xem', 'ze/hir', 'any pronouns'].map(v => el('option', { value: v })));
    const profile = el('form', { class: 'card narrow' }, el('h2', {}, 'Your name'),
      el('p', { class: 'muted' }, `Signed in as ${S.user.email}.${S.user.provider_name ? ` Google or GitHub calls you ${S.user.provider_name}.` : ''} Set a name here and Chronicle calls you that instead, everywhere in the app.`),
      field('Name', nameIn, 'Leave it blank to use the name from Google or GitHub. A character name you set in a campaign still signs your notes there.'),
      field('Pronouns', pronIn, 'Shown beside your name on Members and Site Admin. Optional.'), ideas,
      el('button', { class: 'primary' }, 'Save name'));
    profile.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await post('profile_save', { name: nameIn.value, pronouns: pronIn.value });
        Object.assign(S.user, { name: r.name, custom_name: r.custom_name, pronouns: r.pronouns });
        nameIn.value = r.custom_name || ''; pronIn.value = r.pronouns || '';
        const me = S.members?.find(x => Number(x.id) === S.user.id);
        if (me) Object.assign(me, { display_name: r.name, pronouns: r.pronouns });
        renderNav();
        toast('Name saved');
      } catch (err) { toast(err.message, true); }
    });
    const prefs = el('form', { class: 'card narrow' }, el('h2', {}, 'Preferences'),
      field('Units', select(UNIT_OPTIONS, myUnits(), { name: 'units' }),
        'Every temperature, distance, depth and speed the app works out. Only changes what you see. With None you see each campaign in the units its GM picked.'),
      el('button', { class: 'primary' }, 'Save'));
    prefs.addEventListener('submit', async e => {
      e.preventDefault();
      const v = formData(prefs).units;
      try { S.user.prefs = (await post('prefs_save', { units: v || null })).prefs; toast('Preferences saved'); } catch (err) { toast(err.message, true); }
    });
    // The GM's own Anthropic API key, for Scan for names on a map. Kept in this browser only: never sent to this site's
    // server, only from the browser straight to Anthropic when they scan.
    let scanner = null;
    if (typeof MapScan !== 'undefined') {
      const has = () => !!MapScan.apiKey.get();
      const keyIn = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: has() ? 'Saved. Paste a new key to replace it' : 'sk-ant-…', 'aria-label': 'Anthropic API key' });
      const state = el('p', { class: 'small', role: 'status' });
      const forget = btn('Remove key', () => {
        MapScan.apiKey.set(null); keyIn.placeholder = 'sk-ant-…'; show(); toast('Key removed from this browser');
      });
      const show = () => { state.textContent = has() ? 'A key is saved in this browser.' : 'No key saved in this browser.'; forget.style.display = has() ? '' : 'none'; };
      scanner = el('form', { class: 'card narrow' }, el('h2', {}, 'Map scanner'),
        el('p', { class: 'muted' }, 'Scan for names on a map can have Claude read the place names, using your own Anthropic API key, so the scans are billed to your Anthropic account (a few cents each). Create a key at ',
          el('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), '.'),
        el('p', { class: 'muted small' }, 'The key is saved in this browser only, never on this site\'s server, so add it on each device you scan from. When you scan, your browser sends the map\'s picture and the key straight to Anthropic.'),
        field('Anthropic API key', keyIn), state,
        el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Save key'), forget));
      scanner.addEventListener('submit', e => {
        e.preventDefault();
        const v = keyIn.value.trim();
        if (!v) return toast('Paste your API key first', true);
        if (!/^sk-ant-[\w-]{20,}$/.test(v)) return toast('That doesn\'t look like an Anthropic API key (they start with sk-ant-)', true);
        if (!MapScan.apiKey.set(v)) return toast('This browser won\'t store it (private browsing, or site data blocked)', true);
        keyIn.value = ''; keyIn.placeholder = 'Saved. Paste a new key to replace it'; show(); toast('Key saved in this browser');
      });
      show();
    }
    mount(profile, prefs, scanner);
  }

  const STATUS_LABEL = { pending: 'Waiting for approval', approved: 'Approved', revoked: 'Access removed' };
  /** Site Admin's tabs along the top of the page: [key, label, tip]. A new tab is a row here and a view below. */
  const ADMIN_TABS = [['users', 'Users', 'Approve sign-ups and manage accounts'],
    ['sheets', 'Sheets', 'Starter templates, and the games people have asked for'],
    ['reports', 'Reports', 'Problems people reported with the ! button in the top bar']];
  function adminTabs(at) {
    return el('nav', { class: 'subtabs admin-tabs', 'aria-label': 'Site Admin' }, ADMIN_TABS.map(([k, label, t]) =>
      el('a', { href: `#/admin/${k}`, class: k === at ? 'on' : '', 'data-tip': t, ...(k === at ? { 'aria-current': 'page' } : {}) }, label)));
  }
  /** #/admin[/<tab>]: Site Admin, for site admins only (the server refuses everyone else). */
  async function viewAdmin(tab) {
    if (!ADMIN_TABS.some(([k]) => k === tab)) tab = 'users';
    if (tab === 'reports' && reports) return reports.viewReports(adminHead, mount);
    return tab === 'sheets' ? viewAdminSheets() : viewAdminUsers();
  }
  const adminHead = at => el('div', { class: 'card admin-head' }, el('h1', {}, 'Site Admin'), adminTabs(at));
  async function viewAdminUsers() {
    const { users } = await api('users');
    const act = (label, fn, cls, tipText) => btn(label, async () => {
      try { if (await fn() !== false) viewAdminUsers(); } catch (err) { toast(err.message, true); }
    }, `small ${cls || ''}`, tipText);
    const row = u => {
      const legacy = u.provider === 'legacy';
      const self = Number(u.id) === S.user.id;
      return el('tr', {},
        el('td', {}, el('strong', {}, u.display_name || '(no name)'), u.pronouns ? el('span', { class: 'pronouns muted' }, ` (${u.pronouns})`) : null,
          Number(u.is_admin) ? el('span', { class: 'role gm' }, 'Admin') : null,
          u.provider_name && u.provider_name !== u.display_name ? el('div', { class: 'small muted' }, `${PROVIDER_LABEL[u.provider] || 'Account'} name: ${u.provider_name}`) : null),
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
    mount(adminHead('users'), el('div', { class: 'card' }, el('h2', {}, 'Users'),
      pending ? el('p', {}, `${pending} ${pending === 1 ? 'person is' : 'people are'} waiting for approval.`) : null,
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl users' }, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Status'), el('th', {})), users.map(row)))),
      el('p', { class: 'muted pad' }, 'Everyone who has signed in to Campaign Chronicle is listed here, after their first sign-in. Approving someone here lets them into Chronicle only: Sinless keeps its own approvals, even for the same Google or GitHub account. Approve them, then a GM adds them from the Members tab of a campaign. Admins are set in the server config (admin_identities).'));
  }
  /** Site Admin's Sheets tab: load the starter templates, and the games people asked for with Request a game. */
  async function viewAdminSheets() {
    const { requests, off } = await api('game_requests');
    const starters = el('div', { class: 'card' }, el('h2', {}, 'Starter templates'),
      el('p', { class: 'muted' }, 'The starter library is kept with the app, one file per game in db/starter-templates. Loading adds the new ones and updates the ones that changed; templates forked from them keep their own copy.'),
      (() => {
        const b = btn('Load starter templates', null, 'primary', 'Add and update the starter templates from the files shipped with the app');
        b.addEventListener('click', busy(b, async () => {
          const r = await post('starter_templates_load', {});
          toast(`${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged`);
        }));
        return b;
      })());
    const sw = el('input', { type: 'checkbox', checked: !off, 'aria-label': 'Let people request games' });
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      try {
        await post('site_setting_save', { name: 'game_requests_off', value: !sw.checked });
        toast(sw.checked ? 'Request a game is on' : 'Request a game is off: the button is gone from Sheet templates');
      } catch (err) { sw.checked = !sw.checked; toast(err.message, true); }
      sw.disabled = false;
    });
    const total = requests.reduce((t, r) => t + r.count, 0);
    const when = d => new Date(String(d).replace(' ', 'T')).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const row = r => el('tr', {},
      el('td', {}, el('strong', {}, r.game)),
      el('td', { class: 'num' }, String(r.count)),
      el('td', { class: 'small' }, r.who.join(', ')),
      el('td', { class: 'small muted' }, r.count > 1 && when(r.first) !== when(r.last) ? `${when(r.first)} to ${when(r.last)}` : when(r.last)),
      el('td', { class: 'act' }, btn('Clear', async () => {
        if (!await confirmDialog(`Clear the ${r.count === 1 ? 'request' : `${r.count} requests`} for ${r.game}? Do this once its template is in, or to drop it. People can ask for it again.`, { ok: 'Clear' })) return;
        try { await post('game_requests_clear', { key: r.key }); toast(`Cleared ${r.game}`); viewAdminSheets(); } catch (err) { toast(err.message, true); }
      }, 'small', 'Take this game off the list, once its template is in or to drop it')));
    const asked = el('div', { class: 'card' }, el('h2', {}, 'Game requests'),
      el('label', { class: 'switch-row' }, sw, el('span', {}, 'Let people request games'),
        tip('With this off, the Request a game button is gone from Sheet templates and no new requests come in. The list below stays.')),
      requests.length
        ? [el('p', { class: 'muted' }, `${total} ${total === 1 ? 'request' : 'requests'} for ${requests.length} ${requests.length === 1 ? 'game' : 'games'}, most asked for first. Each person counts once per game.`),
          el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl game-requests' },
            el('tr', {}, el('th', {}, 'Game'), el('th', { class: 'num' }, 'Asked'), el('th', {}, 'Who'), el('th', {}, 'When'), el('th', {})),
            requests.map(row)))]
        : el('p', { class: 'muted' }, off ? 'No requests yet, and requests are off.' : 'No requests yet. People ask with Request a game on the Sheet templates page.'));
    mount(adminHead('sheets'), typeof Sheets !== 'undefined' ? starters : null, asked);
  }

  // ------------------------------------------------------------ campaign list / create
  /** The campaigns this person starred (kept in their preferences), and a list sorted starred first, then by name. */
  const starredIds = () => new Set((S.user?.prefs?.starred || []).map(Number));
  const byStarThenName = list => {
    const st = starredIds();
    return [...list].sort((a, b) => (st.has(Number(b.id)) - st.has(Number(a.id))) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  };
  /** The star by a campaign's name: pressing it stars or unstars the campaign for this person, then `after` redraws. */
  function starButton(c, after) {
    const on = starredIds().has(Number(c.id));
    const b = el('button', { type: 'button', class: 'camp-star' + (on ? ' on' : ''), 'aria-pressed': String(on),
      'aria-label': on ? `Unstar ${c.name}` : `Star ${c.name}`, 'data-tip': on ? 'Unstar: sort it by name again' : 'Star: keep it at the top of your list' }, on ? '★' : '☆');
    b.addEventListener('click', async () => {
      const st = starredIds();
      if (on) st.delete(Number(c.id)); else st.add(Number(c.id));
      b.disabled = true;
      try { S.user.prefs = (await post('prefs_save', { starred: [...st] })).prefs; after(); }
      catch (err) { toast(err.message, true); b.disabled = false; }
    });
    return b;
  }
  async function viewCampaigns() {
    const { campaigns } = await api('campaigns');
    S.camp = null;
    const draw = () => mount(el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h1', {}, 'Your campaigns'), btn('+ New campaign', () => (location.hash = '#/new'), 'primary')),
      campaigns.length ? el('ul', { class: 'camplist' }, byStarThenName(campaigns).map(c =>
        el('li', { class: 'camp-row' + (starredIds().has(Number(c.id)) ? ' starred' : '') },
          starButton(c, draw),
          el('div', { class: 'camp-main' }, el('a', { href: `#/c/${c.id}` }, el('strong', {}, c.name), roleBadge(c.role)),
            c.description ? el('p', { class: 'muted' }, c.description) : null),
          // Only a GM can copy (a copy holds the secrets) or delete one.
          c.role === 'gm' ? el('div', { class: 'camp-actions' }, moreMenu(c.name,
            btn('Copy…', () => copyCampaign(c), 'small', 'Make a new campaign of your own from this one: everything in it, or just its calendar and setup'),
            el('hr'),
            btn('Delete…', () => deleteCampaign(c), 'small danger', 'Permanently delete the campaign and everything in it. Asks you to type DELETE first'))) : null)))
        : el('p', { class: 'muted' }, 'No campaigns yet. Create one to get started.')));
    draw();
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
    const f = el('form', { class: 'card narrow form-wide' }, el('h1', {}, 'New campaign'),
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
    ['Play', 'The campaign\'s days: where the clock is, and what happened when', [['table', 'At the Table'], ['calendar', 'Calendar'], ['events', 'Events'], ['sessions', 'Sessions'], ['clocks', 'Clocks']]],
    ['Party', 'What the party does and owns: journeys, rests and holdings, and where it is right now', [['characters', 'Characters'], ['travel', 'Travel'], ['downtime', 'Downtime'], ['holdings', 'Party Holdings']]],
    ['World', 'What the party has learned, and tools for making more', [['encyclopedia', 'Encyclopedia'], ['library', 'Library'], ['generators', 'Generators'], ['maps', 'Maps']]],
    ['Setup', 'The campaign\'s places, holidays, people and options', [['regions', 'Regions'], ['holidays', 'Holidays'], ['members', 'Members'], ['tokens', 'Tokens'], ['settings', 'Settings']]],
  ];
  const TAB_TIPS = {
    calendar: 'Month and week views of days, weather, visibility, moons and events',
    events: 'Every event in one list, searched and filtered by tag, and every reminder beside it',
    sessions: 'Each game night\'s quick notes and the summary written from them',
    clocks: 'Circles of segments that fill as something comes closer: the GM\'s plots and dangers, and the players\' own plans',
    table: 'Play from here: the shift the clock is on in a big box (what the party does, notes, its events) with End shift, and today\'s weather, shifts and events folded underneath',
    characters: 'Everyone\'s characters and their sheets',
    travel: 'Work out how long a journey takes, then pass that much time',
    downtime: 'Rests and downtime: what the party does, and who does it',
    holdings: 'The party\'s gear and loot, and its vehicles, animals, buildings and assets',
    encyclopedia: 'The people, places, items and groups met in play, linked wherever their names are written',
    library: 'The campaign\'s books, journals and notes, written out in full. Anyone can add or change one',
    generators: 'Random names, taverns, companies and towns, to use on the spot or add to the Encyclopedia',
    regions: 'Places with their own climate, light source and terrain',
    holidays: 'Festivals and recurring days shown on the calendar',
    members: 'Who plays in this campaign, and who can GM it',
    maps: 'Pictures of the world you can zoom, scale and measure on',
    tokens: 'Round pictures for the party\'s groups, characters and entries (GM only)',
    settings: 'Campaign options and the calendar itself (GM only)',
  };
  // "On this page": the long pages (At the Table, a day) get links to their boxes in the campaign bar. At the Table, where the
  // bar has room, they are plain links with the one you are in tinted; elsewhere, and on a narrow screen, one Jump to ▾ menu.
  // A link opens its box if it is folded, then scrolls to it.
  let jumpScroll = null;
  function fillJumpLinks() {
    if (jumpScroll) { removeEventListener('scroll', jumpScroll); jumpScroll = null; }
    const nav = $('.nowbar .jump-links'), main = app();
    if (!nav || !main) return;
    const targets = [];
    const now = main.querySelector('.tv-now');
    if (now) targets.push([now, 'Now']);
    main.querySelectorAll('section.daybox[data-box], section.tv-links').forEach(sec => {
      const raw = (sec.querySelector('.daybox-toggle')?.textContent || (sec.classList.contains('tv-links') ? 'VTT' : '')).trim();
      if (!raw) return;
      const name = raw.replace(/^today's\s+/i, '').replace(/\s+and conditions$/i, '').replace(/\s+today$/i, '');
      const n = sec.querySelectorAll('.daybox-body > .event').length;
      targets.push([sec, name.charAt(0).toUpperCase() + name.slice(1) + (n ? ` (${n})` : '')]);
    });
    if (targets.length < 3) { nav.hidden = true; nav.replaceChildren(); return; }
    const go = sec => {
      const t = sec.querySelector('.daybox-toggle');
      if (sec.classList.contains('folded') && t) t.click();
      sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    };
    // the app routes by the address's hash, so a link can't be #box: it names this page (a new tab opens the page, not a
    // blank one), and the click opens and scrolls to the box. aria-controls says which box it moves to.
    targets.forEach(([sec, name], i) => { if (!sec.id) sec.id = `box-${(sec.dataset.box || name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`; });
    const links = targets.map(([sec, name]) => el('a', { href: location.hash || '#', 'aria-controls': sec.id, onclick: ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return; ev.preventDefault(); go(sec); } }, name));
    const menu = KIT.menu({ label: 'Jump to ▾', ariaLabel: 'Jump to a part of this page', items: targets.map(([sec, name]) => btn(name, () => go(sec))), cls: 'jump-menu', align: 'left' });
    nav.replaceChildren(el('span', { class: 'jump-inline' }, links), menu);
    nav.hidden = false;
    // the link for the box you are in is tinted, as you scroll
    const mark = () => {
      const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0) + 90;
      let on = 0;
      targets.forEach(([sec], i) => { if (sec.isConnected && sec.getBoundingClientRect().top <= line) on = i; });
      links.forEach((a, i) => { a.classList.toggle('on', i === on); if (i === on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
    };
    let queued = false;
    jumpScroll = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; mark(); }); } };
    addEventListener('scroll', jumpScroll, { passive: true });
    mark();
  }
  function campaignHeader(active) {
    const c = cal(), d = today(), sh = E.mod(nowShift(), spd());
    // At the Table's block repeats the date, weather and light, so there the bar keeps to the campaign, View as player and ⏩
    const head = el('section', { class: 'nowbar' + (active === 'table' ? ' on-table' : '') });
    const jumpNav = el('nav', { class: 'jump-links' + (active === 'table' ? ' inline' : ''), 'aria-label': 'On this page', hidden: true });
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
              'See this campaign exactly as your players do: no secrets, GM notes or GM-only paragraphs. Nothing can be changed until you leave') : null,
            jumpNav),
          S.viewAs ? el('div', { class: 'view-as-banner', role: 'status' }, el('span', {}, '👁 Viewing as a player: this is what your players see. Changes are off.'),
            btn('Leave player view', () => setViewingAs(false), 'small primary')) : null,
          el('div', { class: 'now-time' },
            el('a', { href: `#/c/${S.camp.id}/table`, class: 'now-date', 'data-tip': `The current ${word()} and date in the campaign. Click to open At the Table` }, `${shiftNames()[sh]} · ${E.fmtDate(c, d)}`),
            el('span', { class: 'now-meta' }, region ? el('span', { 'data-tip': `Where the party is today: ${regionSummary(region)}` }, `📍 ${region.name}`) : null, ' ',
              weatherText(sw, w?.partial ? `Weather this ${shiftNames()[sh]}` : `Weather this ${shiftNames()[sh]}. Day's forecast: ${E.weatherLabel(w, tempUnit())}`), ' ', visPill(v), ' ', moonBadges(d, region),
              hol.map(holidayChip)))),
        SaveState.node,
        isGM() ? passTime() : null]));
      fillJumpLinks();
    };
    // Pass time is the same on every page: a ⏩ button at the end of the bar that opens its row. The button is just the
    // arrows until the mouse is over it (or it has focus, or its row is open), so the bar stays one line and the page
    // below gets the room. Once opened, the row stays open as you move between pages, until you close it.
    const passTime = () => {
      const w = passTimeWidget();
      w.hidden = !passTimeOpen;
      const open = el('button', { type: 'button', class: 'small primary now-passbtn', 'aria-expanded': String(passTimeOpen),
        'data-tip': 'Open the Pass time row to move the campaign clock' },
        el('span', { class: 'pt-icon' }, '⏩'), el('span', { class: 'pt-label' }, ' Pass time'));
      open.addEventListener('click', () => {
        passTimeOpen = w.hidden;
        w.hidden = !passTimeOpen;
        open.setAttribute('aria-expanded', String(passTimeOpen));
        if (passTimeOpen) w.querySelector('input')?.focus();
      });
      return [open, w];
    };
    draw();
    const folds = legendFolds();
    const tabs = el('nav', { class: 'tabs' + (legendHidden() ? ' tucked' : '') }, legendTuck(), searchBox(active), legendQuick(), TAB_GROUPS.map(([g, gTip, ts]) => {
      const folded = !!folds[g];
      const toggle = el('button', { type: 'button', 'aria-expanded': String(!folded), 'data-tip': `${gTip}. Click to fold or unfold. It stays as you leave it in this browser` },
        el('span', { class: 'tab-group-caret', 'aria-hidden': 'true' }), g);
      const links = ts.filter(([k]) => ((k !== 'settings' && k !== 'tokens') || isGM()) && (k !== 'characters' || typeof Sheets !== 'undefined')).map(([k, l]) =>
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
    if (legendIsDrawer()) return true;   // an iPad in portrait: the Legend is a drawer, closed until wanted
    try { return localStorage.getItem(`${LEGEND_KEY}:tucked:${S.user?.id}`) === '1'; } catch { return false; }
  }
  /** Between a phone and a desktop (an iPad in portrait) the Legend is a drawer: a thin rail with » that slides the tabs out
   * over the page, and slides them back once a tab is picked, on a tap outside or on Escape. Nothing is remembered there. */
  const legendIsDrawer = () => matchMedia('(min-width: 561px) and (max-width: 1000px)').matches;
  /** The « / » button at the top of the Legend that tucks it away to the left and brings it back. On a phone, where the tabs are a row, it is hidden. */
  function legendTuck() {
    const btn = el('button', { type: 'button', class: 'legend-tuck' });
    const show = tucked => {
      btn.textContent = tucked ? '»' : '«';
      btn.setAttribute('aria-expanded', String(!tucked));
      btn.setAttribute('aria-label', tucked ? 'Show the tabs' : 'Hide the tabs');
      btn.dataset.tip = tucked ? 'Show the tabs down the left' : 'Tuck the tabs away to the left, to give the page more room. It stays as you leave it in this browser';
    };
    show(legendHidden());
    const setTucked = tucked => { btn.closest('nav').classList.toggle('tucked', tucked); show(tucked); };
    btn.addEventListener('click', () => {
      const tucked = !btn.closest('nav').classList.contains('tucked');
      setTucked(tucked);
      if (legendIsDrawer()) {
        if (!tucked) btn.closest('nav').querySelector('a.on, a')?.focus();
        return;
      }
      try { tucked ? localStorage.setItem(`${LEGEND_KEY}:tucked:${S.user?.id}`, '1') : localStorage.removeItem(`${LEGEND_KEY}:tucked:${S.user?.id}`); } catch { /* private mode: just this page */ }
    });
    // The drawer closes on a tap outside it, on Escape, and when a tab is picked; these go with the page
    const off = new AbortController();
    window.addEventListener('hashchange', () => off.abort(), { once: true });
    const closeDrawer = () => { if (legendIsDrawer() && !btn.closest('nav')?.classList.contains('tucked')) setTucked(true); };
    document.addEventListener('click', ev => { if (!btn.closest('nav')?.contains(ev.target) || ev.target.closest('nav a')) closeDrawer(); }, { signal: off.signal });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeDrawer(); }, { signal: off.signal });
    return btn;
  }

  /** The search box with the tabs: Enter opens the Search page. On a phone, where the tabs scroll sideways, it is a 🔍 tab instead. */
  function searchBox(active) {
    const input = el('input', { type: 'search', name: 'q', placeholder: 'Search', 'aria-label': 'Search the campaign', enterkeyhint: 'search',
      'data-tip': 'Search the whole campaign: the Encyclopedia, days and events, the Library, Party Holdings and downtime. Press / to jump here' });
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const form = el('form', { class: 'tab-search', role: 'search' }, input,
      el('button', { type: 'button', class: 'tab-search-kbd', onclick: () => openJumpBox(), 'aria-label': 'Jump to a name, a tab or an action',
        'data-tip': `Jump to a name, a tab or an action, or roll dice (${mac ? '⌘K' : 'Ctrl K'}). Press ? for every key` }, mac ? '⌘K' : 'Ctrl K'));
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
    if (!box) return;
    // in the iPad's drawer the box is tucked away with the tabs: bring them out first
    if (!box.offsetParent && legendIsDrawer() && $('nav.tabs.tucked .legend-tuck')) $('nav.tabs .legend-tuck').click();
    if (!box.offsetParent) return;
    ev.preventDefault();
    box.focus();
  });

  // Ctrl K (⌘K on a Mac or an iPad keyboard): one box to jump anywhere in the campaign or do something, from any page.
  // Typing matches Encyclopedia names and the tabs, and offers a roll, a search of everything and a few actions; with
  // nothing typed it lists the pages opened lately. ↑ ↓ move, Enter goes, Escape closes. `?` lists every key.
  let jumpBox = null;
  function openJumpBox(seed = '') {
    if (!S.camp || jumpBox) return;
    const from = document.activeElement;
    hideTip(); closePeek();
    const input = el('input', { type: 'text', class: 'jb-input', placeholder: 'Jump to a name or a tab, or type a roll like 2d6+3', 'aria-label': 'Jump to or do',
      autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'jb-list', value: seed });
    const list = el('div', { class: 'jb-list', id: 'jb-list', role: 'listbox' });
    const box = el('div', { class: 'jb-box surface-float', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Jump to' },
      el('div', { class: 'jb-in' }, el('span', { 'aria-hidden': 'true' }, '🔍'), input, el('kbd', {}, 'Esc')), list,
      el('div', { class: 'jb-foot' }, el('span', {}, el('kbd', {}, '↑'), ' ', el('kbd', {}, '↓'), ' move'), el('span', {}, el('kbd', {}, 'Enter'), ' go'),
        el('span', {}, el('kbd', {}, '?'), ' every key')));
    const scrim = el('div', { class: 'jb-scrim', onclick: () => close() });
    let items = [], sel = 0;
    const close = (back = true) => { scrim.remove(); box.remove(); jumpBox = null; if (back && from?.isConnected) from.focus({ preventScroll: true }); };
    const go = it => { close(false); it.run(); };
    const cid = S.camp.id;
    const tabs = TAB_GROUPS.flatMap(([g, , ts]) => ts.map(([k, l]) => [k, l, g])).filter(([k]) => ((k !== 'settings' && k !== 'tokens') || isGM()) && (k !== 'characters' || typeof Sheets !== 'undefined'));
    const draw = () => {
      const q = input.value.trim(), ql = q.toLowerCase();
      const groups = [];
      if (!q) {
        const recent = recentList().filter(x => x.hash.startsWith(`#/c/${cid}/`) && x.hash !== location.hash);
        if (recent.length) groups.push(['Recent', recent.map(x => ({ icon: x.icon, name: x.label, hint: '', run: () => { location.hash = x.hash; } }))]);
      } else {
        const words = ql.split(/\s+/);
        const hit = t => words.every(w => t.toLowerCase().includes(w));
        const ents = (S.encyclopedia || []).filter(e => hit([e.name, ...(e.aliases || [])].join(' '))).sort((a, b) =>
          (b.name.toLowerCase().startsWith(ql) ? 1 : 0) - (a.name.toLowerCase().startsWith(ql) ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 6);
        if (ents.length) groups.push(['Encyclopedia', ents.map(e => ({ icon: encCat(e.category)?.[2] || '📖', name: e.name, hint: encCat(e.category)?.[1] || '',
          run: () => { location.hash = `#/c/${cid}/encyclopedia/${e.id}`; } }))]);
        const tabHits = tabs.filter(([, l]) => hit(l)).slice(0, 4);
        if (tabHits.length) groups.push(['Go to', tabHits.map(([k, l, g]) => ({ icon: '🧭', name: l, hint: g, run: () => { location.hash = `#/c/${cid}/${k}`; } }))]);
      }
      const acts = [];
      if (q && typeof Dice !== 'undefined' && /\d*d\d/i.test(q) && !Dice.check(q)) acts.push({ icon: '🎲', name: `Roll ${q}`, hint: 'In the dice panel, for the table', run: () => rollFromBox(q) });
      if (q) acts.push({ icon: '🔍', name: `Search everything for "${q}"`, hint: 'Entries, days, events, the Library…', run: () => { location.hash = searchHref(q); } });
      const want = (name, it) => (!q || name.toLowerCase().includes(ql)) && acts.push(it);
      want('new entry', { icon: '➕', name: 'New entry', hint: 'Encyclopedia', run: () => { location.hash = `#/c/${cid}/encyclopedia/new`; } });
      if (isGM()) want('pass time', { icon: '⏩', name: 'Pass time', hint: 'Open the Pass time row', run: () => { const b = $('.now-passbtn'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); $('.passtime input')?.focus(); } });
      want('roll dice', { icon: '🎲', name: 'Roll dice', hint: 'Open the dice panel', run: () => $('.dice-fab')?.click() });
      if (acts.length) groups.push(['Actions', acts]);
      items = groups.flatMap(([, its]) => its);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      let n = 0;
      list.replaceChildren(...(items.length ? groups.map(([title, its]) => el('div', { class: 'jb-sec' }, el('div', { class: 'jb-h' }, title), its.map(it => {
        const i = n++;
        return el('div', { class: 'jb-it' + (i === sel ? ' sel' : ''), role: 'option', id: `jb-${i}`, 'aria-selected': String(i === sel),
          onpointerdown: ev => ev.preventDefault(), onclick: () => go(it) },
          el('span', { class: 'jb-icon', 'aria-hidden': 'true' }, it.icon), el('span', { class: 'jb-name' }, it.name), el('small', {}, it.hint));
      }))) : [el('p', { class: 'muted jb-none' }, 'Nothing matches. Press Enter to search everything.')]));
      if (items.length) input.setAttribute('aria-activedescendant', `jb-${sel}`); else input.removeAttribute('aria-activedescendant');
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (items.length) { sel = (sel + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; draw(); } }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (items[sel]) go(items[sel]); else if (input.value.trim()) { close(false); location.hash = searchHref(input.value.trim()); } }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
      else if (ev.key === 'Tab') ev.preventDefault();   // the box is modal: its one field keeps the focus (↑ ↓ move through the list)
    });
    document.body.append(scrim, box);
    jumpBox = box;
    draw();
    input.focus();
  }
  function rollFromBox(expr) {
    const fab = $('.dice-fab');
    if (fab && fab.getAttribute('aria-expanded') !== 'true') fab.click();
    setTimeout(() => { const i = $('.dice-input'), b = $('.dice-go'); if (i && b) { i.value = expr; b.click(); } }, 60);
  }
  /** The `?` sheet: every key the app answers, the ones for this page first. */
  function keysSheet() {
    const onMap = /\/maps\/\d+/.test(location.hash);
    const row = (k, what) => el('tr', {}, el('td', {}, k.split(' ').map(x => el('kbd', {}, x))), el('td', {}, what));
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    KIT.dialog({ title: 'Keys', message: el('div', { class: 'keys-sheet' },
      onMap ? [el('h4', {}, 'On a map'), el('table', {}, row('P', 'Add a pin'), row('L', 'Add a label'), row('M', 'Measure'), row('T', 'Move the party'), row('Esc', 'Leave the tool, or close what is open'))] : null,
      el('h4', {}, 'Anywhere in a campaign'), el('table', {},
        row(mac ? '⌘ K' : 'Ctrl K', 'Jump to a name, a tab or an action, or roll'), row('/', 'Search the whole campaign'),
        row('?', 'This list'), row('Esc', 'Close a menu, a card, a drawer or a dialog')),
      el('p', { class: 'small muted' }, 'Keys work when the cursor is not in a text box.')),
      buttons: [{ value: 'ok', label: 'Close', cls: 'primary', focus: true }] });
  }
  document.addEventListener('keydown', ev => {
    if (!S.camp || !location.hash.startsWith('#/c/') || document.querySelector('dialog[open]')) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'k') {
      if (ev.target.closest?.('[contenteditable="true"], .ql-editor')) return;   // the editor's own Ctrl K makes a link
      ev.preventDefault();
      jumpBox ? jumpBox.querySelector('input')?.focus() : openJumpBox();
      return;
    }
    if (ev.key === '?' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.target.closest?.('input, textarea, select, [contenteditable]') && !jumpBox) { ev.preventDefault(); keysSheet(); }
  });

  let passTimeOpen = false;   // the Pass time row, open or closed, for this visit
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

  /** After End shift with no session open: ask once whether to start one on the shift the clock moved to, so Build draft
   * can gather the shifts played. Not now isn't asked again in this browser until it is closed. */
  async function offerSession() {
    const key = `chronicle:nosessask:${S.camp.id}`;
    if (S.openSession || !isGM() || S.viewAs) return;
    try { if (sessionStorage.getItem(key)) return; } catch { /* asked every time without storage */ }
    const v = await KIT.dialog({ message: `No session is open. Start one now, from ${E.fmtShift(cal(), nowShift())}? Its notes and Build draft will gather the shifts you play.`,
      buttons: [{ value: 'start', label: 'Start a session', cls: 'primary', focus: true }, { value: '', label: 'Not now' }] });
    if (v !== 'start') { try { sessionStorage.setItem(key, '1'); } catch { /* fine */ } return; }
    const r = await post('session_save', {}, S.camp.id);
    S.openSession = r.session;
    toast(`${sessionName(r.session)} started`);
  }

  /** At the Table's Pass time dialog: skip ahead by an amount or to a date (with an activity for the time passed, and
   * when it lands shown as you type), or start a rest or downtime, or plan a trip on the Travel tab. Resolves once the
   * clock has moved (true), or not (false). */
  function passTimeDialog() {
    hideTip();
    return new Promise(resolve => {
      const c = cal(), n = spd(), now = nowShift();
      let moved = false;
      const how = [['amount', 'By an amount'], ['date', 'To a date']].map(([v, l]) => el('label', { class: 'inline' },
        el('input', { type: 'radio', name: 'pt-how', value: v, checked: v === 'amount' }), ` ${l}`));
      const def = { day: 'shift', week: 'day', month: 'week' }[settings().time_unit || 'day'] || 'shift';
      const amt = el('input', { type: 'number', value: 1, min: 1, class: 'w-num', 'aria-label': 'Amount' });
      const unit = select([['shift', `${word()}(s)`], ['day', 'day(s)'], ['week', 'week(s)'], ['month', 'month(s)'], ['year', 'year(s)']], def, { 'aria-label': 'Unit' });
      const day = datePicker(today() + 1);
      const slot = select(shiftNames().map((x, i) => [i, x]), 0, { 'aria-label': `${Word()} of that day` });
      const act = el('input', { placeholder: `e.g. Waiting for the caravan`, 'aria-label': 'Activity for the time passed' });
      const byAmount = el('div', { class: 'row' }, amt, unit), byDate = el('div', { class: 'row', hidden: true }, day, slot);
      const lands = el('p', { class: 'small muted', role: 'status' });
      const err = el('p', { class: 'bad small', hidden: true });
      const mode = () => how.map(h => h.querySelector('input')).find(i => i.checked).value;
      const target = () => mode() === 'amount' ? now + unitShifts(unit.value, Math.round(Number(amt.value) || 0))
        : (day.getAbs() ?? today()) * n + Number(slot.value);
      const sync = () => {
        byAmount.hidden = mode() !== 'amount'; byDate.hidden = mode() !== 'date';
        const t = target();
        lands.textContent = t > now ? `Lands on ${E.fmtShift(c, t)}, ${t - now} ${word()}${t - now === 1 ? '' : 's'} on.` : 'That isn\'t after now.';
      };
      for (const x of [...how, amt, unit, slot]) x.addEventListener('change', sync);
      amt.addEventListener('input', sync);
      day.addEventListener('change', sync); day.addEventListener('input', sync);
      const go = el('button', { class: 'primary', type: 'submit' }, 'Pass time ▶');
      const d = el('dialog', { class: 'kit-dialog pt-dialog', 'aria-label': 'Pass time' },
        el('form', { novalidate: true },
          el('h3', {}, 'Pass time'),
          el('p', { class: 'small muted' }, `Now: ${E.fmtShift(c, now)}`),
          el('fieldset', { class: 'pt-skip' }, el('legend', {}, 'Skip ahead'),
            el('div', { class: 'row', role: 'radiogroup', 'aria-label': 'How far' }, how),
            byAmount, byDate,
            field('What the party does meanwhile (optional)', actionCombo(act), `Written into every ${word()} that passes. ${Word()}s that already have an activity keep it`),
            lands, err,
            el('div', { class: 'row' }, go)),
          el('fieldset', { class: 'pt-other' }, el('legend', {}, 'Or'),
            el('div', { class: 'row' },
              btn('🛏 Rest or downtime…', () => { d.close(); downtimeDialog(); }, 'small', 'Start a long rest, a short rest or some days of downtime: it labels the shifts it covers and can move the clock to its end'),
              el('a', { class: 'button small', href: `#/c/${S.camp.id}/travel`, onclick: () => d.close(),
                'data-tip': 'Plan a trip on the Travel tab: Depart passes the travel time, labels each shift with the trip and moves the party on the map' }, '🧭 Travel…'))),
          el('div', { class: 'kit-dialog-actions' }, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
      sync();
      d.addEventListener('close', () => { d.remove(); resolve(moved); });
      d.querySelector('form').addEventListener('submit', busy(go, async e => {
        e.preventDefault();
        err.hidden = true;
        const t = target();
        if (!(t > now)) { err.textContent = `Pick a time after now (${E.fmtShift(c, now)}).`; err.hidden = false; return; }
        if (t - now > n * 3650 && !await confirmDialog(`That jumps ${Math.round((t - now) / n)} days. Continue?`)) return;
        try { await passShifts(t - now, act.value.trim()); }
        catch (x) { err.textContent = x.message; err.hidden = false; return; }
        moved = true;
        vs().anchor = today();
        d.close();
        toast(`Now: ${E.fmtShift(cal(), nowShift())}`);
      }));
      document.body.append(d);
      d.showModal();
      amt.focus();
    });
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
      pressedSeg(el('span', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' },
        btn('Month', () => { st.mode = 'month'; route(); }, st.mode === 'month' ? 'small on' : 'small', 'A month grid with weather, moon phases and events'),
        btn('Week', () => { st.mode = 'week'; route(); }, st.mode === 'week' ? 'small on' : 'small', hourMode() ? 'One row per day showing the hours with an activity, their visibility and activity' : 'One row per day showing every shift, its visibility and activity'),
        btn('Year', () => { st.mode = 'year'; route(); }, st.mode === 'year' ? 'small on' : 'small', 'Every month of the year on one page. Click a month\'s name to open it, or a day to open the day'))),
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
  /** A day as the day page and At the Table read it: the server's day (its row, shifts, shift notes and events), with its
   * region, weather, the weather in each shift and the ground. */
  async function loadDay(d, withGround = true) {
    const r = await api('day', { query: { cid: S.camp.id, d } });
    const row = r.day || {};
    const region = regionById(row.region_id) || currentRegion();
    const w = row.weather || null;
    const shifts = {}; r.shifts.forEach(s => (shifts[s.shift] = s));
    let grounds = [];
    if (withGround) try { grounds = await groundFor(d, region, w); } catch { /* the day still shows without it */ }
    return { d, r, row, region, w, shifts, grounds, sws: shiftWx(d, region, w) };
  }

  /** The day page (a day of the calendar): Previous and Next day, then its boxes. Today is At the Table. */
  async function viewDay(d) {
    const c = cal(), x = await loadDay(d);
    const toCalendar = btn('Back to calendar', () => { vs().anchor = d; location.hash = `#/c/${S.camp.id}/calendar`; }, 'small',
      'Return to the calendar, showing this day');
    const exportBtn = btn('⬇ Export', () => DayExport.download({ camp: S.camp, role: S.role, regions: S.regions, holidays: S.holidays, tempUnit: tempUnit(), d, data: x.r }), 'small',
      'Download this day as a Markdown file (events, weather, notes and shifts) to paste into Scabard or another wiki. It holds only what you can see here');
    const nav = el('div', { class: 'calbar' },
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d - 1}` }, '◀ Previous day'),
      el('h2', {}, E.fmtDate(c, d)),
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/day/${d + 1}` }, 'Next day ▶'),
      toCalendar,
      el('a', { class: 'button small', href: `#/c/${S.camp.id}/table`, 'data-tip': 'Open At the Table, on the campaign\'s current day' }, 'Go to today'),
      exportBtn);
    // the trail: Calendar › Firstmonth 1492 › this day. The month step opens the calendar on this day's month.
    const mp = E.fromAbs(c, d);
    const toMonth = ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return; vs().anchor = d; vs().mode = 'month'; };
    const where = trail(['Calendar', `#/c/${S.camp.id}/calendar`], [`${c.months[mp.month].name} ${E.yearLabel(c, mp.year)}`, `#/c/${S.camp.id}/calendar`], [E.fmtDate(c, d, { noWeekday: true })]);
    where.querySelectorAll('a')[1]?.addEventListener('click', toMonth);
    mount(...campaignHeader('calendar'), where, nav, ...dayBoxes(x));
  }

  /** A day's boxes: Weather, Shifts (or Hours), Notes, Events and Reminders. table: under At the Table, where they start
   * folded (remembered apart from the day page's) and the Notes box stays on the day's calendar page. */
  function dayBoxes({ d, r, row, region, w, shifts, grounds, sws }, table = false) {
    const c = cal(), names = shiftNames();
    const key = k => (table ? `table-${k}` : k);
    const groundNow = d === today() ? grounds[E.mod(nowShift(), spd())] : grounds.filter(Boolean).pop();
    const sea = E.season(c, d, region?.settings?.hemisphere);
    const sun = E.sunTimes(c, d, region?.settings?.hemisphere);
    const hol = E.holidaysOn(c, S.holidays, d);

    // --- weather and the day's conditions
    const overview = el('div', { class: 'dayconditions' },
      el('div', { class: 'kv' },
        el('div', {}, el('span', { class: 'lbl' }, 'Season', tip('From the calendar\'s season dates, flipped for regions in the other hemisphere. The season picks which weather odds apply.')), sea.name || '—'),
        el('div', {}, el('span', { class: 'lbl' }, 'Region'), region ? el('span', { 'data-tip': regionSummary(region) }, region.name) : '—'),
        (row.locations || '').trim() ? el('div', { class: 'notes-locs' }, el('span', { class: 'lbl' }, 'Locations visited', tip(LOC_TIP)), el('div', { class: 'pre' }, linked(row.locations))) : null,
        el('div', {}, el('span', { class: 'lbl' }, w?.partial ? 'Weather now' : 'Forecast', tip(w?.partial ? SO_FAR_TIP : FORECAST_TIP)), weatherText(w)),
        groundNow ? el('div', {}, el('span', { class: 'lbl' }, d === today() ? 'Ground now' : 'Ground at day\'s end',
          tip('Snow lying on the ground, or how wet or frozen it is, from the weather of the days before. Each shift card shows it as the day goes on')), groundText(groundNow, d)) : null,
        sun ? el('div', { class: 'sun' }, el('span', { class: 'lbl' }, 'Sun', tip('Sunrise and sunset, blended between the times set on the seasons in Settings, and taken from half a year away for regions in the other hemisphere. Natural light at dawn and dusk follows them')),
          `☀ Sunrise ${E.fmtClock(sun.sunrise)} · Sunset ${E.fmtClock(sun.sunset)}`, el('div', { class: 'small muted' }, `${fmtDaylight(sun.daylight)} of daylight`)) : null,
        el('div', {}, el('span', { class: 'lbl' }, 'Moons'), E.moons(c, d, region).map(m => el('div', {}, m.redMoon ? moonGlyph(m) : m.icon, ` ${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)`))),
        hol.length ? el('div', {}, el('span', { class: 'lbl' }, 'Holidays'), hol.map(x => el('div', {}, holidayChip(x), x.description ? ` ${x.description}` : ''))) : null,
        // At the Table already shows the shift the clock is on.
        d === today() && !table ? el('div', {}, el('span', { class: 'lbl' }, 'Now'), names[E.mod(nowShift(), spd())]) : null));

    if (isGM()) overview.append(dayEditor(d, row, region, w, r, undefined, grounds));

    // --- shifts
    const shiftCards = el('div', { class: 'shifts' + (hourMode() ? ' hours' : '') }, names.map((_, i) =>
      shiftCard(d, i, shifts[i] || {}, region, sws[i] || null, !!w?.partial && !sws[i], (r.shift_notes || []).filter(n => Number(n.shift) === i), grounds[i] || null, { sessions: r.sessions, actions: r.shift_actions || [], party: r.party_characters || [] })));

    // --- events
    const evBox = dayBox(key('events'), 'Events', {
      folded: table,
      actions: (isGM() || settings().players_can_add_events) ? btn('+ New event', () => openBox(evBox).append(eventForm(d)), 'small', 'Log something that happened (or will happen) on this day') : null,
    }, r.events.length ? r.events.map(e => eventView(e, d)) : el('p', { class: 'muted' }, 'No events on this day.'));

    // --- reminders
    const rems = dayReminders(d);
    const remBox = dayBox(key('reminders'), 'Reminders', {
      folded: table,
      tip: `A reminder pops up once the campaign clock reaches its ${word()}, for whoever it is for, until they dismiss it`,
      actions: btn('+ New reminder', () => openBox(remBox).append(reminderForm(d)), 'small', `Have something pop up when the campaign reaches a ${word()} of this day`),
    }, rems.length ? rems.map(x => reminderView(x, d)) : el('p', { class: 'muted' }, 'No reminders on this day.'));

    return clean([
      // At the Table's block over the big box holds all of this, with ✎ Day for the editor
      table ? null : dayBox(key('weather'), 'Weather', { summary: [region ? `📍 ${region.name}` : null, ' ', weatherText(w)] }, overview),
      dayBox(key('shifts'), table ? `Every ${word()} today` : `${Word()}s`, { folded: table, tip: shiftTip() }, shiftCards),
      // The day's Public and Secret notes are on its calendar page.
      table ? null : notesBox(d, row),
      evBox, remBox]);
  }

  // The day page is a column of boxes (Weather, Shifts or Hours, Notes, Events, Reminders), each of which folds to its
  // heading (Weather to a line of what it holds). Which ones are folded is remembered in this browser, for each account.
  const BOXES_KEY = 'chronicle:dayboxes';
  function foldedBoxes() {
    try { return JSON.parse(localStorage.getItem(`${BOXES_KEY}:${S.user?.id}`)) || {}; } catch { return {}; }
  }
  function rememberFold(key, folded) {
    const all = foldedBoxes();
    all[key] = folded;   // kept either way: At the Table's boxes start folded
    try { localStorage.setItem(`${BOXES_KEY}:${S.user?.id}`, JSON.stringify(all)); } catch { /* private mode: just this page */ }
  }
  /** A day box: its heading folds and unfolds it. opts: { tip, actions, summary, folded }: actions sit at the right of the
   * heading; folded is how it starts until it has been folded or unfolded in this browser. */
  function dayBox(key, title, opts, ...body) {
    const all = foldedBoxes(), folded = key in all ? !!all[key] : !!opts.folded;
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

  const LOC_TIP = 'The towns, sites and buildings the party went to this day. Players can see this';
  /** The Notes box, on a day's calendar page: Public notes everyone in the campaign reads and Secret notes only GMs
   * see. The GM writes both notes in word-processor editors; players read the Public ones. */
  function notesBox(d, row) {
    const PUBLIC_TIP = 'Everyone in the campaign can read these. Only GMs can change them';
    const SECRET_TIP = 'Only GMs ever see these. The server never sends them to players';
    if (!isGM()) {
      return dayBox('notes', 'Notes', {},
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip(PUBLIC_TIP)),
          (row.notes || '').trim() ? linkedNote(row.notes, row.notes_format) : el('p', { class: 'muted' }, 'No notes for this day yet.')));
    }
    const pub = RichText.editor({ text: row.notes, format: row.notes_format, label: 'Public notes', placeholder: 'What happened today, for everyone to read', secret: true, mentions: encMentions() });
    const sec = RichText.editor({ text: row.gm_notes, format: row.gm_notes_format, label: 'Secret notes', placeholder: 'Secrets, plans and reminders for GMs only', mentions: encMentions() });
    const save = btn('Save notes', null, 'primary small', 'Save both notes');
    save.addEventListener('click', busy(save, async () => {
      const p = pub.value(), g = sec.value();
      // version: the copy opened here, so a co-GM's save since isn't overwritten (refused, with a message to reload)
      await post('day_update', { abs_day: d, version: row.version || 0, notes: p.text, notes_format: p.format, gm_notes: g.text, gm_notes_format: g.format }, S.camp.id);
      toast('Notes saved'); route();
      offerNouns([{ text: p.text, format: p.format, label: 'Public notes' },
        { text: g.text, format: g.format, secret: true, label: 'Secret notes' }]);
    }));
    return dayBox('notes', 'Notes', {},
      el('div', { class: 'notes-grid' },
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip(PUBLIC_TIP)), pub.node),
        el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 Secret notes', tip(SECRET_TIP)), sec.node)),
      mentionRow([row.notes, row.notes_format], [row.gm_notes, row.gm_notes_format]),
      el('div', { class: 'row' }, save, (row.gm_notes || '').trim() ? btn('🔓 Reveal secret notes', async () => {
          const v = await KIT.dialog({ title: 'Reveal the secret notes to the players?', message: 'The secret notes, as last saved, join the end of the public notes and the secret notes are cleared. Anything typed here and not saved yet is left out.',
            buttons: [{ value: 'log', label: 'Reveal and log it today', cls: 'primary', focus: true }, { value: 'quiet', label: 'Just reveal' }, { value: 'cancel', label: 'Cancel' }] });
          if (v !== 'log' && v !== 'quiet') return;
          try { await post('item_reveal', { kind: 'day', id: d, log: v === 'log' }, S.camp.id); toast(v === 'log' ? 'Revealed, and logged on this day\'s events' : 'Revealed to the players'); route(); } catch (err) { toast(err.message, true); }
        }, 'small', 'Move the secret notes onto the end of the public notes, so players read them, and optionally note it on this day\'s events') : null,
        btn('🕘 History', () => HistoryView.open({ kind: 'day', ref: d, title: `day ${d}'s notes`, cid: S.camp.id, api, post, onRestore: route }), 'small', 'Earlier versions of this day\'s notes, what each save changed, and Restore'),
        btn('Import to a session…', () => importToSession(d, pub.value(), sec.value()), 'small',
        'Copy these notes, as they are written now, into a session\'s notes to write its summary from')));
  }

  /** A day's notes as lines for a session's notes: { pub: [{ text, depth }], sec: [...] }. Paragraphs, headings and list items become
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
        el('p', { class: 'kit-dialog-msg' }, `The notes of ${E.fmtDate(cal(), d)} go at the end of the session\'s notes, under a jump to this day. The day\'s notes stay as they are.`),
        field('Add them to', where),
        el('label', { class: 'inline' }, pubBox, ` Public notes (${p.pub.length} line${p.pub.length === 1 ? '' : 's'})`),
        el('label', { class: 'inline', 'data-tip': 'GM-only notes go in under a $ line, which the draft summary keeps as a GM-only paragraph' }, secBox,
          ` Secret notes (${secretLines.length} line${secretLines.length === 1 ? '' : 's'})`),
        err,
        el('div', { class: 'kit-dialog-actions' }, go, el('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'))));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('form').addEventListener('submit', busy(go, async e => {
      e.preventDefault();
      const add = [], line = l => `${'  '.repeat(Math.max(0, Math.min(3, l.depth)))}${l.text}`;
      if (pubBox.checked) for (const l of p.pub) add.push(line(l));
      if (secBox.checked && secretLines.length) {
        add.push(`$ Secret notes · ${E.fmtDate(cal(), d, { noWeekday: true })}`);
        for (const l of secretLines) add.push(line({ text: l.text, depth: l.depth + 1 }));
      }
      if (!add.length) { err.textContent = 'Pick notes that have something written in them'; err.hidden = false; return; }
      try {
        let sid = where.value === 'new' ? null : Number(where.value);
        if (!sid) sid = (await post('session_save', {}, cid)).session.id;
        // at the end of the session's notes as saved, under a > line to this day when the notes there are on another
        const r = await api('session', { query: { cid, id: sid } });
        const was = sessionNotesText(r.session, r.notes);
        const end = Sessions.notesFromText(cal(), was, sessionStart(r.session), nowShift()).end;
        const jump = Sessions.jumpLine(cal(), end, d);
        const text = [was.replace(/\s+$/, ''), jump, ...add].filter(Boolean).join('\n');
        await post('session_notes_save', { id: sid, notes_text: text, base: r.session.notes_text ?? null }, cid);
        dlg.close();
        const to = sessions.find(x => x.id === sid);
        toast(`Added ${add.length} line${add.length === 1 ? '' : 's'} to ${to ? sessionName(to) : 'a new session'}'s notes`);
      } catch (ex) { err.textContent = ex.status === 409 ? 'That session\'s notes were being changed just then. Try again' : ex.message; err.hidden = false; }
    }));
    document.body.append(dlg);
    dlg.showModal();
    go.focus();
  }

  // ------------------------------------------------------------ session notes
  // The GM's notes during play, in one text box on a session's page (the Sessions tab): free text, a line per note,
  // indented lines under the line above. The shorthand (static/sessions.js): ! a GM aside, ? a loose end, > a time jump,
  // $ a secret. The box saves as it is typed; until the server has it, it is kept in this browser too.
  const SNOTE_TIP = 'Saves as you type · Enter starts a new line · Tab / Shift+Tab indents · @ names an Encyclopedia entry · ! keeps a line out of the summary · $ puts it in the summary as a secret · ? marks a loose end · > jumps in time: >+1, >dusk, >+1 dawn, >12 Firstmonth, > alone for the clock';
  const SNOTE_HELP = [['Enter', 'a new line: each line is one note'], ['Tab, Shift+Tab', 'indent a line under the line above, or bring it back out (Esc, then Tab, leaves the box)'], ['@', 'names an Encyclopedia entry'],
    ['!', 'at the start: a GM aside (dice, rules), kept out of the summary'], ['$', 'at the start: a secret, which Build draft puts in the summary as a GM-only paragraph (with the lines indented under it)'],
    ['?', 'at the start: a loose end, listed apart (GM only) at the end of the summary'],
    ['>+1, >+9, >+2w', 'jump on a day, nine days, two weeks'], ['>dusk', 'jump to that part of the day'], ['>+1 dawn', 'the next day at dawn'],
    ['>12 Firstmonth', 'jump to a date'], ['>', 'alone: back to the campaign\'s clock']];
  const sessionName = s => `Session ${s.number}${s.title ? `: ${s.title}` : ''}`;
  /** The stamp a session's notes start from: the shift it started on, or its first day's first shift for a session
   * from before sessions kept their shifts. */
  const sessionStart = s => s.first_shift !== null && s.first_shift !== undefined ? Number(s.first_shift) : Number(s.first_day) * spd();
  /** The last shift a session covers: the one it ended on, the end of its last day for a session from before shifts
   * were kept, or the clock while it is open. */
  const sessionEnd = s => s.last_shift !== null && s.last_shift !== undefined ? Number(s.last_shift)
    : s.last_day !== null && s.last_day !== undefined ? (Number(s.last_day) + 1) * spd() - 1 : nowShift();
  /** What was written on the shifts a session ran over (activities, players' notes, GM notes), as notes for Build draft:
   * at most a month of days from its start, so a session left open for ages doesn't load a year of days. */
  /** The days a session ran over (its run, then the shifts it takes in outside it), as the day action sends them, with
   * its runs of shifts in order: { days, runs: [[from, to]] }. */
  async function sessionDays(s) {
    const n = spd(), from = sessionStart(s), to = s.undated ? from - 1 : Math.min(sessionEnd(s), from + 31 * n - 1);
    // an undated session (one imported without its in-game dates) has no run, only the shifts given it one at a time;
    // the shifts it takes in outside its run (a flashback, a split party's other half) too, each in its place in time
    const extra = (s.extra_shifts || []).map(Number).filter(a => a < from || a > to).slice(0, 4 * n);
    const ds = new Set(extra.map(a => Math.floor(a / n)));
    for (let d = Math.floor(from / n); d <= Math.floor(to / n); d++) ds.add(d);
    const days = await Promise.all([...ds].map(d => api('day', { query: { cid: S.camp.id, d } })
      .then(r => ({ d, shifts: r.shifts || [], shift_notes: r.shift_notes || [], shift_actions: r.shift_actions || [] }))));
    const runs = [...(to < from ? [] : [[from, to]]), ...extra.map(a => [a, a])].sort((a, b) => a[0] - b[0]);
    return { days, runs };
  }
  async function sessionShiftNotes(s) {
    const { days, runs } = await sessionDays(s);
    return runs.flatMap(([a, b]) => Sessions.shiftNotes(cal(), days, a, b));
  }
  /** A session page's Actions box: the party's and each player's action on every shift it ran over, picked At the
   * Table; null when none were picked. */
  async function sessionActionsBox(s) {
    const { days, runs } = await sessionDays(s);
    const n = spd(), byDay = new Map(days.map(x => [x.d, x])), rows = [];
    for (const [a, b] of runs) for (let k = a; k <= b; k++) {
      const acts = (byDay.get(Math.floor(k / n))?.shift_actions || []).filter(y => Number(y.shift) === E.mod(k, n));
      if (acts.length) rows.push([k, acts]);
    }
    if (!rows.length) return null;
    const find = name => E.SHIFT_ACTIONS.find(x => x.name === name);
    return el('section', { class: 'sess-actions', 'data-box': 'actions' },
      el('h3', {}, 'Actions', tip(`What the party and each player's character did on each ${word()} of this session, picked At the Table. Build draft writes them into the summary`)),
      el('ul', { class: 'sess-act-list' }, rows.map(([k, acts]) => el('li', {},
        el('span', { class: 'small muted' }, E.fmtShift(cal(), k)), el('br'),
        acts.map((y, m) => el('span', { 'data-tip': find(y.action)?.desc || null }, m ? ' · ' : '', el('b', {}, y.who), `: ${[find(y.action)?.icon, y.action].filter(Boolean).join(' ')}`))))));
  }
  /** + New session's question, Starting when?: the clock's shift to start now, or an earlier one; Played already writes
   * one up afterwards, ended where it says, and leaves an open session open. Resolves to the new session, or null. */
  function newSessionDialog() {
    hideTip();
    return new Promise(resolve => {
      const now = nowShift(), n = spd();
      let made = null;
      const shiftSel = label => select(shiftNames().map((x, i) => [i, x]), E.mod(now, n), { 'aria-label': label });
      const day = datePicker(today()), slot = shiftSel(`${Word()} it starts`);
      const done = el('input', { type: 'checkbox' });
      const endDay = datePicker(today()), endSlot = shiftSel(`${Word()} it ended`);
      const endField = field('It ended', el('div', { class: 'row' }, endDay, endSlot), 'The session is made ended here, and a session that is open now stays open');
      const err = el('p', { class: 'bad small', hidden: true });
      const first = () => (day.getAbs() ?? today()) * n + Number(slot.value);
      const last = () => (endDay.getAbs() ?? today()) * n + Number(endSlot.value);
      const go = el('button', { class: 'primary', type: 'submit' }, 'Start session');
      const d = el('dialog', { class: 'kit-dialog pt-dialog', 'aria-label': 'New session' },
        el('form', { novalidate: true },
          el('h3', {}, 'New session'),
          field('Starting when?', el('div', { class: 'row' }, day, slot), `The campaign's clock (${E.fmtShift(cal(), now)}) unless you pick another ${word()}. Build draft gathers the ${word()}s from here`),
          el('label', { class: 'inline' }, done, ' Played already: write it up afterwards'),
          endField, err,
          el('div', { class: 'kit-dialog-actions' }, go, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
      const sync = () => { endField.hidden = !done.checked; go.textContent = done.checked ? 'Make session' : 'Start session'; };
      done.addEventListener('change', sync); sync();
      d.addEventListener('close', () => { d.remove(); resolve(made); });
      d.querySelector('form').addEventListener('submit', busy(go, async e => {
        e.preventDefault();
        err.hidden = true;
        if (done.checked && last() < first()) { err.textContent = 'It can\'t end before it starts.'; err.hidden = false; return; }
        try {
          const r = await post('session_save', { first_shift: first(), ...(done.checked ? { last_shift: last() } : {}) }, S.camp.id);
          if (!done.checked) S.openSession = r.session;
          made = r.session;
        } catch (x) { err.textContent = x.message; err.hidden = false; return; }
        d.close();
      }));
      document.body.append(d);
      d.showModal();
    });
  }
  /** A shift's sessions, as chips linking to them, and for a GM "+ Session…" to put the shift in one: an existing session
   * takes it in (a shift outside its run is added on its own: a flashback, or a split party's other half), or A new
   * session made for it. */
  function shiftSessions(abs, sessions, after) {
    const mine = (sessions || []).filter(x => (x.slots || []).includes(E.mod(abs, spd())));
    const gm = isGM() && !PANEL && !S.viewAs;
    // a GM's chip has a ✕ that takes the shift out of that session
    const chip = x => {
      const a = el('a', { class: 'chip sess-chip', href: `#/c/${S.camp.id}/sessions/${x.id}`, 'data-tip': `This ${word()} is part of ${sessionName(x)}` }, `Session ${x.number}`);
      if (!gm) return a;
      const off = btn('✕', () => removeShiftFromSession(abs, x, after), 'link small sess-chip-off', `Take this ${word()} out of ${sessionName(x)}`);
      off.setAttribute('aria-label', `Take ${E.fmtShift(cal(), abs)} out of Session ${x.number}`);
      return el('span', { class: 'sess-chip-wrap' }, a, off);
    };
    // the latest two show; the rest fold behind "+N more", so a shift in many sessions doesn't take the box over
    const latest = [...mine].sort((a, b) => b.number - a.number), shown = latest.slice(0, 2), rest = latest.slice(2);
    const chips = [...shown.reverse().map(chip), rest.length ? el('details', { class: 'sess-more-chips' },
      el('summary', { class: 'chip', 'data-tip': `The other sessions this ${word()} is part of` }, `+${rest.length} more`),
      el('div', { class: 'sess-more-pop' }, rest.reverse().map(chip))) : null].filter(Boolean);
    const add = gm ? btn(mine.length ? '+' : '+ Session…', () => addShiftToSession(abs, mine, after), 'link small',
      `Put this ${word()} in a session: one already played (as a flashback or a split party's other half) or a new one`) : null;
    if (add && mine.length) add.setAttribute('aria-label', 'Add to another session');
    return chips.length || add ? el('div', { class: 'row sess-chips' }, chips, add) : null;
  }
  /** Take shift abs out of session x: one it takes in outside its run goes, and the first or last shift of its run moves
   * its start or end by one (the server says when the shift is in the middle of the run). */
  async function removeShiftFromSession(abs, x, after) {
    if (!await confirmDialog(`Take ${E.fmtShift(cal(), abs)} out of ${sessionName(x)}?`)) return;
    try {
      await post('session_shift_remove', { id: x.id, abs_shift: abs }, S.camp.id);
      toast(`${E.fmtShift(cal(), abs)} is no longer in ${sessionName(x)}`);
      (after || route)();
    } catch (err) { toast(err.message, true); }
  }
  /** A day and a shift (or hour) picked in two boxes; abs() is the absolute shift. */
  function shiftPicker(abs0, label) {
    const n = spd(), day = datePicker(Math.floor(abs0 / n)), slot = select(shiftNames().map((x, i) => [i, x]), E.mod(abs0, n), { 'aria-label': `${label}: ${word()}` });
    day.querySelectorAll('[aria-label]').forEach(x => x.setAttribute('aria-label', `${label}: ${x.getAttribute('aria-label').toLowerCase()}`));
    return { node: el('div', { class: 'row' }, day, slot), abs: () => (day.getAbs() ?? Math.floor(abs0 / n)) * n + Number(slot.value) };
  }
  /** The session page's In-game dates…: where the session starts and ends in the campaign's calendar, or that it is still
   * open. Resolves to the saved session, or null. */
  function sessionDatesDialog(s) {
    hideTip();
    return new Promise(resolve => {
      const n = spd(), now = nowShift();
      const from = s.first_shift ?? s.first_day * n;
      const to = s.last_shift ?? (s.last_day === null || s.last_day === undefined ? now : (s.last_day + 1) * n - 1);
      const start = shiftPicker(s.undated ? now : from, 'Starts'), end = shiftPicker(s.undated ? now : Math.max(from, to), 'Ends');
      const open = el('input', { type: 'checkbox', checked: s.last_day === null || s.last_day === undefined });
      const endField = field('Ends', end.node);
      const err = el('p', { class: 'bad small', hidden: true });
      const go = el('button', { class: 'primary', type: 'submit' }, 'Save');
      let saved = null;
      const d = el('dialog', { class: 'kit-dialog pt-dialog', 'aria-label': 'In-game dates' },
        el('form', { novalidate: true },
          el('h3', {}, `${sessionName(s)}: in-game dates`),
          el('p', { class: 'small muted' }, `The ${word()}s of the campaign's calendar it ran over. Build draft gathers them, and each ${word()} card shows the session. ${word()}s it takes in outside these are listed under the session's title.`),
          field('Starts', start.node),
          el('label', { class: 'inline' }, open, ' Still open (it runs to the clock; any other open session ends)'),
          endField, err,
          el('div', { class: 'kit-dialog-actions' }, go, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
      const sync = () => { endField.hidden = open.checked; };
      open.addEventListener('change', sync); sync();
      d.addEventListener('close', () => { d.remove(); resolve(saved); });
      d.querySelector('form').addEventListener('submit', busy(go, async e => {
        e.preventDefault();
        err.hidden = true;
        if (!open.checked && end.abs() < start.abs()) { err.textContent = 'It can\'t end before it starts.'; err.hidden = false; return; }
        try {
          const r = await post('session_save', { id: s.id, first_shift: start.abs(), last_shift: open.checked ? null : end.abs() }, S.camp.id);
          if (open.checked) S.openSession = r.session; else if (S.openSession?.id === s.id) S.openSession = null;
          saved = r.session;
        } catch (x) { err.textContent = x.message; err.hidden = false; return; }
        d.close();
      }));
      document.body.append(d);
      d.showModal();
    });
  }
  /** Pick one day and shift (or hour) in a dialog; resolves to the absolute shift, or null. */
  async function pickShiftDialog(title, okLabel) {
    const pick = shiftPicker(nowShift(), title);
    const v = await KIT.dialog({ title, message: pick.node, buttons: [{ value: 'ok', label: okLabel, cls: 'primary', focus: true }, { value: '', label: 'Cancel' }] });
    return v === 'ok' ? pick.abs() : null;
  }
  async function addShiftToSession(abs, already, after) {
    let sessions;
    try { ({ sessions } = await api('sessions', { query: { cid: S.camp.id } })); } catch (err) { return toast(err.message, true); }
    const have = new Set(already.map(x => x.id));
    const pick = select([['new', 'A new session'], ...sessions.filter(x => !have.has(x.id)).map(x => [x.id, `${sessionName(x)} (${Sessions.daysCovered(cal(), x)})`])],
      sessions.find(x => !have.has(x.id))?.id ?? 'new', { 'aria-label': 'Session' });
    const v = await KIT.dialog({ title: `Add ${E.fmtShift(cal(), abs)} to a session`, message: el('span', {}, pick), buttons: [
      { value: 'add', label: 'Add', cls: 'primary', focus: true }, { value: '', label: 'Cancel' }] });
    if (v !== 'add') return;
    try {
      if (pick.value === 'new') {
        // the clock's own shift with nothing open starts a session there; any other shift gets one made for it alone
        const open = abs === nowShift() && !S.openSession;
        const r = await post('session_save', { first_shift: abs, ...(open ? {} : { last_shift: abs }) }, S.camp.id);
        if (open) S.openSession = r.session;
        toast(`${sessionName(r.session)} made for ${E.fmtShift(cal(), abs)}`);
      } else {
        const r = await post('session_shift_add', { id: Number(pick.value), abs_shift: abs }, S.camp.id);
        toast(`${E.fmtShift(cal(), abs)} is in ${sessionName(r.session)}`);
      }
      (after || route)();
    } catch (err) { toast(err.message, true); }
  }
  /** A session's notes as text: what was saved, or (never saved as text yet) its old note rows written out. */
  const sessionNotesText = (s, rows) => s.notes_text ?? Sessions.foldNotes(cal(), rows || [], sessionStart(s));

  /** The notes box on a session's page: one text box, saved as it is typed. rows: the session's note rows from before
   * the text box, folded in when it has never been saved as text. actions: buttons for the start of its bar (Build
   * draft). Returns { node, text() }. */
  function notesEntry(s, rows, actions = []) {
    const cid = S.camp.id, uid = S.user?.id;
    const backupKey = `chronicle:snotes:${uid}:${s.id}`, oldDraftKey = `chronicle:snotes-draft:${uid}:${s.id}`;
    const store = {
      get(k) { try { return localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode: kept on the page only */ } }
    };
    const help = el('div', { class: 'snote-help small', hidden: true }, el('dl', {}, SNOTE_HELP.map(([k, v]) => [el('dt', {}, el('code', {}, k)), el('dd', {}, v)])));
    const err = el('p', { class: 'snote-err small', role: 'alert' });
    const hint = el('p', { class: 'snote-hint small muted' });
    const status = el('span', { class: 'small muted snote-status', 'aria-live': 'polite' });
    const box = el('textarea', { class: 'snote-box', rows: 12, maxlength: 500000, spellcheck: true, 'aria-label': 'Session notes', 'data-tip': SNOTE_TIP,
      placeholder: 'Type your notes here as the game goes, a line each. Enter starts a new line and Tab indents. They save as you type; Build draft writes the summary from them.' });

    // base: the text the server has, as far as this page knows (null: never saved as text). What the box starts with:
    // the saved text, or the old rows written out, then whatever this browser kept that the server never got.
    let base = s.notes_text ?? null;
    let text = sessionNotesText(s, rows);
    let saveNow = base === null && !!text;                   // folded from the old rows: save it as text at once
    const oldDraft = (store.get(oldDraftKey) || '').trim(); // lines typed before the text box and never added
    if (oldDraft) { text = text ? `${text}\n${oldDraft}` : oldDraft; saveNow = true; }
    let kept = null;
    try { kept = JSON.parse(store.get(backupKey) || 'null'); } catch { /* not ours */ }
    let conflict = null;                                    // this browser's copy, when the server's changed under it
    if (kept && typeof kept.text === 'string' && kept.text !== text) {
      if (kept.base === base) { text = kept.text; saveNow = true; }   // typed here, the save never got through
      else if (kept.text !== base) conflict = kept.text;              // typed here, and the notes changed elsewhere since
    }
    box.value = text;

    const keep = () => store.set(backupKey, box.value === base ? null : JSON.stringify({ text: box.value, base }));
    const lines = () => {
      const { notes, bad } = Sessions.notesFromText(cal(), box.value, sessionStart(s), nowShift());
      const n = notes.length;
      hint.textContent = bad.length ? `Line${bad.length === 1 ? '' : 's'} ${bad.join(', ')}: couldn't read that jump; try >+1, >dusk or >12 Firstmonth` : '';
      return n;
    };
    let timer = null, saving = null, stale = conflict !== null;   // stale: nothing saves until the GM picks a copy
    const show = (t, bad = false) => { status.textContent = t; status.classList.toggle('bad', bad); };
    /** Send the box's text, unless the server already has it; one send at a time, the latest text after it. */
    async function save() {
      clearTimeout(timer); timer = null;
      if (stale) return;
      if (saving) { await saving; if (box.value === base) return; }
      const sent = box.value;
      if (sent === base) { show(base === null ? '' : 'Saved'); return; }
      show('Saving…');
      saving = (async () => {
        try {
          await post('session_notes_save', { id: s.id, notes_text: sent, base }, cid);
          base = sent; s.notes_text = sent;
          store.set(oldDraftKey, null);
          keep();
          show(box.value === base ? 'Saved' : 'Saving…');
          err.replaceChildren();
        } catch (e) {
          if (e.status === 409) { stale = true; showStale(); }
          else show(`Not saved: ${e.message}. What you typed is kept in this browser and saves when it can`, true);
        } finally { saving = null; }
      })();
      await saving;
      if (!stale && box.value !== base && !timer) timer = setTimeout(save, 1500);
    }
    /** The server's notes changed under this page: say so, and let the GM pick which copy to keep. */
    function showStale(mine = box.value) {
      show('Not saved', true);
      err.replaceChildren('These notes were changed in another tab or on another device. ',
        btn('Load the saved notes', busy(null, async () => {
          const r = await api('session', { query: { cid, id: s.id } });
          base = r.session.notes_text ?? null; s.notes_text = base;
          box.value = sessionNotesText(r.session, r.notes); stale = false;
          store.set(backupKey, null); err.replaceChildren(); changed(false);
        }), 'small', 'Put the saved notes in the box, in place of what is in it now'), ' ',
        btn('Keep mine', busy(null, async () => {
          const r = await api('session', { query: { cid, id: s.id } });
          base = r.session.notes_text ?? null; stale = false; box.value = mine;
          err.replaceChildren(); changed(false); await save();
        }), 'small', 'Save what is in this box over the other copy'));
    }
    function changed(soon = true) {
      err.textContent && !stale && err.replaceChildren();
      keep(); lines();
      if (stale) return;
      if (box.value === base) { clearTimeout(timer); timer = null; show(base === null ? '' : 'Saved'); return; }
      show('Not saved yet');
      clearTimeout(timer);
      timer = setTimeout(save, soon ? 2000 : 0);
    }
    /** Indent (dir 1) or outdent (dir -1) every line the selection touches, by two spaces. */
    function indent(dir) {
      const v = box.value, from = v.lastIndexOf('\n', box.selectionStart - 1) + 1;
      let to = v.indexOf('\n', box.selectionEnd); if (to < 0) to = v.length;
      const ls = v.slice(from, to).split('\n');
      let first = 0, total = 0;
      const out = ls.map((l, i) => {
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
    box.addEventListener('input', () => changed());
    box.addEventListener('blur', () => { if (timer) save(); });
    // leaving the page (another tab of the app, closing or hiding it): send what is waiting
    const flush = () => { if (timer) save(); }, off = new AbortController();
    addEventListener('pagehide', flush, { signal: off.signal });
    addEventListener('hashchange', () => { flush(); off.abort(); }, { signal: off.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); }, { signal: off.signal });
    box.addEventListener('keydown', ev => {
      if (mentions?.keydown(ev)) return;
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !box.dataset.freeTab) { ev.preventDefault(); indent(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') box.dataset.freeTab = '1';   // the next Tab leaves the box, as a keyboard user needs
      if (ev.key !== 'Escape') delete box.dataset.freeTab;
    });
    const phone = (glyph, label, dir) => {
      const b = btn(glyph, () => { indent(dir); box.focus(); }, 'small snote-phone', label);
      b.setAttribute('aria-label', label);
      return b;
    };
    const helpBtn = btn('?', () => { help.hidden = !help.hidden; }, 'small', 'Show the shorthand this box understands');
    helpBtn.setAttribute('aria-label', 'Shorthand');
    lines();
    show(base === null ? '' : 'Saved');
    if (conflict !== null) showStale(conflict);
    else if (saveNow) changed(false);
    return {
      node: el('div', { class: 'snote-entry-all' },
        wrap, el('div', { class: 'row snote-entry-bar' }, ...actions, phone('⇤', 'Outdent', -1), phone('⇥', 'Indent', 1), helpBtn, status), hint, err, help),
      text: () => box.value,
      box
    };
  }

  /** Hours of daylight as "11h 40m". */
  const fmtDaylight = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };

  /** Day d's shifts (or hours) in a row, each with its weather: NOW on the one the clock is on, and for GMs a click on another
   * moves the clock there. */
  function dayStrip(d, sws) {
    const names = shiftNames(), isToday = d === today();
    const sh = isToday ? E.mod(nowShift(), spd()) : d < today() ? spd() : -1; // which shifts have passed
    return el('div', { class: 'dh-strip' + (hourMode() ? ' hours' : ''), style: spd() === 2 ? { gridTemplateColumns: 'repeat(2, minmax(64px, 1fr))', maxWidth: '240px' } : {} }, names.map((_, i) => {
      const x = sws[i] || null, cls = ['dh-step'];
      if (i === sh) cls.push('now'); else if (i < sh) cls.push('past');
      const wxt = x ? `${names[i]}: ${E.weatherLabel(x, tempUnit())}${wxTip(x)}` : `${names[i]}: weather not known yet`;
      const kids = [el('span', { class: 'dh-step-icon' }, x ? E.WEATHER[x.type]?.icon || '' : '?'), el('span', { class: 'small' }, names[i])];
      if (i === sh) return el('div', { class: cls.join(' '), 'data-tip': `${wxt}. The campaign clock is on this ${word()}` }, el('span', { class: 'nowtag' }, 'NOW'), ...kids);
      if (!isGM()) return el('div', { class: cls.join(' '), 'data-tip': wxt }, ...kids);
      cls.push('nowpick');
      return moveNowButton(d, i, el('button', { type: 'button', class: cls.join(' '), 'aria-label': `Move Now to ${names[i]}`,
        'data-tip': `${wxt}. Click to move the NOW flag, and the campaign clock, here` }, el('span', { class: 'nowtag' }, 'NOW'), ...kids));
    }));
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

  /** The Encyclopedia's Locations named in some text (by name or other name, as whole words, any case), in the order
   * the Encyclopedia lists them. */
  function placesNamed(text) {
    const t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return S.encyclopedia.filter(e => e.category === 'location' && [e.name, ...(e.aliases || [])].some(n => {
      const k = String(n || '').trim().toLowerCase();
      return k.length > 1 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}($|[^\\p{L}\\p{N}])`, 'u').test(t);
    }));
  }
  /** A still picture of part of a map: the window win ({ x, y, w, h } in the map's pixels) of its picture, with the pins
   * given as dots (named on hover, and in a line under it when label is set) and, at flag, the party's 🚩. Null when the map
   * has no picture. A click opens href. */
  function miniMap(m, win, { pins = [], flag = null, href = null, label = false, tipText = '' } = {}) {
    const W = Number(m.width), H = Number(m.height);
    if (!m.image_url || !W || !H) return null;
    const pct = v => `${(v * 100).toFixed(3)}%`;
    const at = (x, y) => ({ left: pct((x - win.x) / win.w), top: pct((y - win.y) / win.h) });
    const inside = p => p.x >= win.x && p.x <= win.x + win.w && p.y >= win.y && p.y <= win.y + win.h;
    const img = el('img', { src: m.image_url, alt: '', loading: 'lazy', draggable: 'false' });
    Object.assign(img.style, { width: pct(W / win.w), height: pct(H / win.h), left: pct(-win.x / win.w), top: pct(-win.y / win.h) });
    const dot = (p, cls, text) => {
      const d = el('span', { class: cls, 'data-tip': text || null, 'aria-hidden': 'true' }, cls === 'mm-flag' ? '🚩' : label && text ? el('span', { class: 'mm-label' }, text) : '');
      Object.assign(d.style, at(p.x, p.y));
      return d;
    };
    const shown = pins.filter(inside);
    const box = el(href ? 'a' : 'div', { class: 'mini-map', href, 'data-tip': tipText || null, 'aria-label': tipText || `Part of ${m.name}` },
      img, ...shown.map(p => dot(p, 'mm-pin' + (label ? ' named' : ''), MapGeo.pinName(p))), flag ? dot(flag, 'mm-flag', null) : null);
    box.style.aspectRatio = `${win.w} / ${win.h}`;
    return box;
  }
  /** The point a fraction f (0 to 1) of the way along a path of points, by distance. */
  function pointAlong(pts, f) {
    const seg = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    let left = f * seg.reduce((a, b) => a + b, 0);
    for (let i = 0; i < seg.length; i++) {
      if (left <= seg[i] || i === seg.length - 1) {
        const t = seg[i] ? Math.min(1, left / seg[i]) : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
      }
      left -= seg[i];
    }
    return { x: pts[0].x, y: pts[0].y };
  }
  /** The window of a map around point c, side span (in its pixels), kept on the picture. */
  function mapWindowAt(m, c, span) {
    const W = Number(m.width), H = Number(m.height), w = Math.min(span, W), h = Math.min(span, H);
    return { x: Math.max(0, Math.min(W - w, c.x - w / 2)), y: Math.max(0, Math.min(H - h, c.y - h / 2)), w, h };
  }
  /** The window of a map that holds these points, with a margin, never thinner than half as tall as wide (or the reverse). */
  function mapWindowAround(m, pts) {
    const W = Number(m.width), H = Number(m.height), xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const least = Math.max(W, H) * 0.12;
    let w = Math.max(least, (Math.max(...xs) - Math.min(...xs)) * 1.6), h = Math.max(least, (Math.max(...ys) - Math.min(...ys)) * 1.4);
    if (w > 2 * h) h = w / 2; else if (h > 2 * w) w = h / 2;
    w = Math.min(w, W); h = Math.min(h, H);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    return { x: Math.max(0, Math.min(W - w, cx - w / 2)), y: Math.max(0, Math.min(H - h, cy - h / 2)), w, h };
  }
  /** A session's places: the Encyclopedia's Locations named in its text that have a pin, on a picture of the map most of
   * them are on, each named under it and linking to its pin. Null when none is pinned. */
  async function sessionPlaces(text) {
    const named = placesNamed(text);
    if (!named.length) return null;
    const ids = new Set(named.map(e => e.id));
    const pinned = (S.mapIndex || []).filter(p => ids.has(p.entry_id));
    if (!pinned.length) return null;
    const count = new Map();
    for (const p of pinned) count.set(p.map_id, (count.get(p.map_id) || 0) + 1);
    const mapId = [...count].sort((a, b) => b[1] - a[1])[0][0];
    let m;
    try { m = await api('map', { query: { cid: S.camp.id, id: mapId } }); } catch { return null; }
    const pins = (m.pins || []).filter(p => ids.has(p.entry_id));
    if (!pins.length) return null;
    const pic = miniMap(m.map, mapWindowAround(m.map, pins), { pins, label: true, href: `#/c/${S.camp.id}/maps/${mapId}`, tipText: `Open ${m.map.name}` });
    const others = [...count.keys()].filter(id => id !== mapId).length;
    return el('section', { class: 'sess-places', 'data-box': 'places' },
      el('h3', {}, 'Places', tip('The Encyclopedia\'s Locations named in this session that are pinned on a map')),
      pic,
      el('div', { class: 'row sess-place-list' }, pins.map(p => el('a', { class: 'map-link small', href: `#/c/${S.camp.id}/maps/${mapId}?pin=${p.id}`,
        'data-tip': `Open ${m.map.name} at ${MapGeo.pinName(p)}` }, `📍 ${MapGeo.pinName(p)}`))),
      others ? el('p', { class: 'small muted' }, `And on ${others} other map${others === 1 ? '' : 's'}: their entries link to them.`) : null);
  }
  /** Add a line to what the party does on the clock's shift, keeping what is written there (the map's Log it). */
  async function logOnShift(text) {
    const a = nowShift(), n = spd(), d = Math.floor(a / n), i = E.mod(a, n);
    const r = await api('day', { query: { cid: S.camp.id, d } });
    const s = (r.shifts || []).find(x => Number(x.shift) === i) || {};
    const activity = [String(s.activity || '').trim(), text].filter(Boolean).join('\n');
    await post('shift_save', { abs_day: d, shift: i, activity, gm_notes: s.gm_notes || '', visibility_override: s.visibility_override ?? '' }, S.camp.id);
  }

  /** Places for a day's Locations visited: the Encyclopedia's Locations named in what was written on its shifts (activity,
   * players' notes and GM notes) that the box doesn't list yet. dayData: what the day action sent. */
  function locationSuggestions(dayData, have, near = []) {
    const text = [...(dayData?.shifts || []).flatMap(s => [s.activity, s.gm_notes]), ...(dayData?.shift_notes || []).map(n => n.body)].filter(Boolean).join('\n');
    const listed = new Set(String(have || '').split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean));
    const seen = new Set();
    return [...placesNamed(text), ...near].filter(e => !seen.has(e.id) && seen.add(e.id))
      .filter(e => ![e.name, ...(e.aliases || [])].some(n => listed.has(String(n).toLowerCase())));
  }
  /** The Encyclopedia entries pinned nearest where the main group's trail had it on day d's shifts (on its map). */
  async function trailPlaces(d) {
    const { groups } = await api('groups', { query: { cid: S.camp.id } });
    const g = groups.find(x => x.is_main) || groups[0];
    if (!g?.map_id) return [];
    const m = await api('map', { query: { cid: S.camp.id, id: g.map_id } });
    const n = spd(), reach = Math.max(Number(m.map.width) || 0, Number(m.map.height) || 0) * 0.03 + 10;
    const pts = (m.trail || []).filter(t => t.group_id === g.id && Math.floor(t.abs_shift / n) === d);
    const ids = new Set(pts.map(t => MapGeo.nearestPin(m.pins || [], t, reach)).filter(p => p?.entry_id).map(p => p.entry_id));
    return S.encyclopedia.filter(e => ids.has(e.id));
  }

  /** The quarters of a day a GM can set conditions for, as [quarter, label]: the shifts, Day and Night, or in hours mode
   * each quarter with the hours it covers. */
  function quarterOptions() {
    const c = cal(), names = shiftNames(), qn = E.quarterNames(c), by = new Map();
    names.forEach((nm, i) => { const q = E.slotQuarter(c, i); if (!by.has(q)) by.set(q, []); by.get(q).push(nm); });
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([q, nms]) => [q, hourMode() ? `${qn[q]} (${nms[0]}–${nms[nms.length - 1]})` : nms.join(', ')]);
  }
  /** The ✎ Day editor's "Conditions" part: the weather, temperature, wind and ground of one shift (a quarter of the day
   * in hours mode), each Auto (worked out from the forecast and the days before) or set by hand. ovs is the working copy
   * of the day's overrides, by quarter, that Save day stores with the weather. */
  function conditionsEditor(d, region, w, ovs, q0, grounds) {
    const tUnit = tempUnit(), qs = quarterOptions(), open = E.openAir(region);
    let q = qs.some(([x]) => x === q0) ? q0 : qs[0][0];
    const qSel = select(qs, q, { 'aria-label': `${Word()} to set` });
    const body = el('span', { class: 'row conds' });
    const autoShifts = () => E.shiftWeather(cal(), S.camp.seed, region, d, { ...w, overrides: null });
    // the ground worked out for each quarter, from what the page already has (by slot); a quarter whose ground was set by
    // hand has it there, so its Auto choice names nothing
    const autoGround = [];
    (grounds || []).forEach((g, i) => { autoGround[E.slotQuarter(cal(), i)] ??= g; });
    const draw = () => {
      const auto = autoShifts()[q] || {}, o = ovs[q] || {}, def = E.WEATHER[auto.type] || {};
      const set = (k, v) => {
        const x = { ...(ovs[q] || {}) };
        if (v === '' || v === null || v === undefined || Number.isNaN(v)) delete x[k]; else x[k] = v;
        ovs[q] = Object.keys(x).length ? x : null;
      };
      const type = select([['', `Auto: ${def.icon || ''} ${def.label || '—'}`], ...Object.entries(E.WEATHER).map(([k, v]) => [k, `${v.icon} ${v.label}`])], o.type || '', { 'aria-label': 'Weather' });
      type.addEventListener('change', () => set('type', type.value));
      const autoT = typeof auto.temp === 'number' ? E.toTempUnit(auto.temp, tUnit, 0) : '';
      const temp = el('input', { type: 'number', step: 'any', class: 'w-num', 'aria-label': 'Temperature', placeholder: autoT === '' ? 'Auto' : `Auto ${autoT}`,
        value: typeof o.temp === 'number' ? E.toTempUnit(o.temp, tUnit, 1) : '' });
      temp.addEventListener('input', () => set('temp', temp.value === '' ? '' : Math.round(E.fromTempUnit(Number(temp.value), tUnit))));
      const wind = select([['', `Auto: ${E.WIND[auto.wind || 0]}`], ...E.WIND.map((n, i) => [i, `${n} (${E.windSpeed(i, unitSystem())})`])], o.wind ?? '', { 'aria-label': 'Wind' });
      wind.addEventListener('change', () => set('wind', wind.value === '' ? '' : Number(wind.value)));
      const ag = (ovs[q] || {}).ground || (w.overrides && (w.overrides[q] || {}).ground) ? null : E.groundLabel(autoGround[q], unitSystem());
      const ground = select([['', ag ? `Auto: ${ag.label}` : 'Auto'], ...Object.entries(E.GROUND_PRESETS).map(([k, v]) => [k, v.label])], o.ground || '', { 'aria-label': 'Ground' });
      ground.addEventListener('change', () => set('ground', ground.value));
      const reset = btn('Auto', () => { ovs[q] = null; draw(); }, 'small', `Put this ${word()} back to the conditions worked out from the forecast`);
      body.replaceChildren(...clean([tipped(type, 'Weather'), tipped(temp, 'Temperature'), tUnit === 'none' ? null : tempSym(tUnit),
        open ? tipped(wind, 'Wind') : null, open ? tipped(ground, 'Ground underfoot. The days after carry on from it') : null, reset]));
    };
    qSel.addEventListener('change', () => { q = Number(qSel.value); draw(); });
    draw();
    return field('Conditions', el('span', { class: 'row' }, qSel, body), null,
      `Set any of a ${word()}'s conditions by hand: its weather, temperature${open ? ', wind and the ground underfoot' : ''}. Auto keeps what is worked out from the day's forecast${open ? ' and, for the ground, the days before' : ''}. Light is set on the ${word()}'s own card.`);
  }

  function dayEditor(d, row, region, w, dayData, slot, grounds) {
    const ovs = [0, 1, 2, 3].map(i => (Array.isArray(w?.overrides) && w.overrides[i]) || null);
    const q0 = E.slotQuarter(cal(), slot ?? (d === today() ? E.mod(nowShift(), spd()) : 0));
    const conds = w?.type && !w.partial ? conditionsEditor(d, region, w, ovs, q0, grounds) : null;
    const regPick = regionPicker([['', '— (current region)']], row.region_id ?? '', { name: 'region_id' });
    const wSel = select([['', '— none —'], ...Object.entries(E.WEATHER).map(([k, v]) => [k, `${v.icon} ${v.label}`])], w?.type || '', { name: 'wtype' });
    const tUnit = tempUnit();
    const tVal = w && typeof w.temp === 'number' ? E.toTempUnit(w.temp, tUnit, 1) : '';
    const temp = el('input', { type: 'number', name: 'temp', value: tVal, step: 'any', class: 'w-num' });
    const wind = select(E.WIND.map((n, i) => [i, `${n} (${E.windSpeed(i, unitSystem())})`]), w?.wind || 0, { name: 'wind' });
    const locs = el('textarea', { name: 'locations', rows: 1, value: row.locations || '', placeholder: 'e.g. Altdorf, the Grey Lady inn, Reikwald crossroads' });
    // places the day's shifts name that the box doesn't list yet: a tap adds one to the box, saved with Save day
    const sugg = el('div', { class: 'row loc-suggest' });
    let near = [];   // the places the party's trail passed this day, once the map has loaded
    const drawSugg = () => {
      const list = locationSuggestions(dayData, locs.value, near);
      sugg.hidden = !list.length;
      sugg.replaceChildren(el('span', { class: 'small muted', 'data-tip': 'The Encyclopedia\'s places named on this day\'s shifts, and the pins the party\'s trail passed' }, 'Places this day:'), ...list.map(e => btn(`+ ${e.name}`, () => {
        locs.value = [locs.value.trim(), e.name].filter(Boolean).join(', ');
        drawSugg();
      }, 'small', `Add ${e.name} to Locations visited. Save day keeps it`)));
    };
    locs.addEventListener('input', drawSugg);
    drawSugg();
    trailPlaces(d).then(list => { near = list; drawSugg(); }).catch(() => {});
    const f = el('form', { class: 'dayedit' },
      el('div', { class: 'grid2' },
        el('div', {},
          field('Region for this day', regPick.node, null, 'Where the party spent this day. Its climate rolls the weather and its light source and terrain set visibility. "Current region" follows wherever the party is now.'),
          field('Locations visited', locs, null, LOC_TIP), sugg),
        el('div', {},
          field('Day\'s forecast', el('span', { class: 'row' }, wSel, tipped(temp, 'Daytime high'), tUnit === 'none' ? '' : tempSym(tUnit), tipped(wind, 'Strongest wind')), null,
            `Set the day's weather by hand: the worst it brings, its daytime high and its strongest wind. Each ${word()} is worked out from it. Rain, fog, snow and the like lower visibility; see the ${word()} cards for the exact effect.`),
          conds)),
      el('div', { class: 'row' }, el('button', { class: 'primary small', 'data-tip': 'Save the region, locations visited and weather' }, 'Save day'),
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
        const overrides = ovs.some(Boolean) ? ovs : undefined;
        weather = withShiftWx(d, regionById(rid) || currentRegion(), { ...(w || {}), type: wSel.value, temp: t, wind: Number(wind.value), overrides });
        if (!overrides) delete weather.overrides;
      }
      // Locations go only when changed: saving them counts as a save of the day's notes (a co-GM's open copy goes stale).
      const locChanged = locs.value !== (row.locations || '');
      try {
        await post('day_update', { abs_day: d, region_id: rid || null, weather, ...(locChanged ? { locations: locs.value } : {}) }, S.camp.id);
        toast('Day saved'); route();
        if (locChanged) offerNouns([{ kind: 'locations', text: locs.value, label: 'Locations visited' }]);
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

  /** A shift's actions: one for the party as a whole, one for each player's character and one for each character with
   * no player that travels with the party, picked from the baseline shift actions (their descriptions on hover). A GM
   * picks any of them, a player their own; each saves as it is picked, and a session's page and its Build draft list
   * them. acts: the day's shift_actions. party: the day's party_characters. readOnly: just the ones picked. */
  function shiftActionsBox(d, i, acts, opt = {}) {
    const mine = (acts || []).filter(a => Number(a.shift) === i);
    const keyOf = a => `${Number(a.user_id) || 0}:${Number(a.character_id) || 0}`;
    const byKey = new Map(mine.map(a => [keyOf(a), a]));
    const find = name => E.SHIFT_ACTIONS.find(a => a.name === name);
    const label = name => { const a = find(name); return a ? `${a.icon} ${a.name}` : name; };
    const players = dtPlayers(), party = opt.party || [];
    const row = (uid, chid, who, gone = false) => ({ uid, chid, key: `${uid}:${chid}`, who, gone });
    const rows = [row(0, 0, 'The party'), ...players.map(m => row(Number(m.id), 0, memberName(m))),
      ...party.map(c => row(0, Number(c.id), c.kind === 'npc' ? `${c.name} (NPC)` : c.name)),
      // a player who has since left, or a character no longer in the party, keeps what they did
      ...mine.filter(a => !listed(a)).map(a => row(Number(a.user_id) || 0, Number(a.character_id) || 0, a.who, true))];
    function listed(a) {
      const u = Number(a.user_id) || 0, c = Number(a.character_id) || 0;
      return c ? party.some(x => Number(x.id) === c) : !u || players.some(m => Number(m.id) === u);
    }
    const head = el('span', { class: 'lbl' }, 'Actions', tip(`One action for the party as a whole, one for each player's character and one for each character with no player who travels with the party this ${word()}. Hover an action to read what it means. They go in the notes of the session this ${word()} is in`));
    if (opt.readOnly) {
      const set = rows.filter(r => byKey.has(r.key));
      if (!set.length) return null;
      return el('div', { class: 'shift-actions read' }, head, el('div', { class: 'sa-list small' }, set.map((r, k) => {
        const a = byKey.get(r.key).action;
        return el('span', { 'data-tip': find(a)?.desc || null }, k ? ' · ' : '', el('b', {}, r.who), ': ', label(a));
      })));
    }
    const status = el('small', { class: 'sa-status', role: 'status' });
    const can = r => !S.viewAs && !r.gone && (isGM() || (r.uid && r.uid === S.user.id));
    const grid = el('div', { class: 'sa-grid' }, rows.map(r => {
      const cur = byKey.get(r.key)?.action || '';
      const whole = !r.uid && !r.chid;
      const name = el('span', { class: 'sa-who' + (whole ? ' party' : '') }, r.who);
      if (!can(r)) return [name, el('span', { class: 'sa-val' + (cur ? '' : ' muted'), 'data-tip': find(cur)?.desc || null }, cur ? label(cur) : '—')];
      const sel = el('select', { class: 'sa-pick', 'aria-label': `${r.who}'s action this ${shiftNames()[i]}` },
        el('option', { value: '' }, '—'),
        Object.entries(E.SHIFT_ACTION_GROUPS).map(([g, gl]) => el('optgroup', { label: gl },
          E.SHIFT_ACTIONS.filter(a => a.group === g).map(a => el('option', { value: a.name, title: a.desc }, `${a.icon} ${a.name}`)))),
        cur && !find(cur) ? el('option', { value: cur }, cur) : null);
      sel.value = cur;
      const tipNow = () => { const a = find(sel.value); sel.dataset.tip = a ? `${a.icon} ${a.name}: ${a.desc}` : `Pick what ${whole ? 'the party as a whole' : r.who} does this ${word()}`; };
      tipNow();
      let saved = cur;
      sel.addEventListener('change', async () => {
        tipNow();
        status.textContent = 'Saving…'; status.className = 'sa-status';
        try {
          await post('shift_action_set', { abs_day: d, shift: i, user_id: r.uid, character_id: r.chid, action: sel.value, transit: whole && E.isOnTheMove(sel.value) }, S.camp.id);
          saved = sel.value;
          status.textContent = 'Saved ✓'; status.className = 'sa-status ok';
        } catch (err) { sel.value = saved; tipNow(); status.textContent = 'Not saved'; status.className = 'sa-status bad'; toast(err.message, true); }
      });
      return [name, sel];
    }).flat());
    return el('div', { class: 'shift-actions' }, el('div', { class: 'row spread' }, head, status), grid,
      players.length || party.length ? null : el('p', { class: 'small muted' }, 'Players who join the campaign get a line each, and so does a character with no player when Travels with the party is ticked on its sheet.'));
  }

  /** hiddenWx: a player looking at a shift of today that hasn't come yet, whose weather the server held back. opt: { big: the
   * shift At the Table is on (never folded, its editor open), readOnly: as a player sees it (the panel), after: what to
   * redraw once a note is added or deleted (else the page) }. */
  function shiftCard(d, i, s, region, sw, hiddenWx, notes, ground, opt = {}) {
    const c = cal(), names = shiftNames();
    const v = E.visibility(c, region, sw, d, i, s.visibility_override);
    const isNow = d * spd() + i === nowShift();
    const card = el('div', { class: 'card shiftcard' + (isNow ? ' now' : '') },
      el('div', { class: 'row spread' }, shiftTitle(d, i, isNow), visPill(v)),
      PANEL ? null : shiftSessions(d * spd() + i, opt.sessions, opt.after),
      // At the Table's big box leaves the weather, ground and light to the block over it
      ...(opt.big ? [] : [sw ? el('div', { class: 'small' }, weatherText(sw, `Weather this ${names[i]}, worked out from the day's forecast`))
        : hiddenWx ? el('div', { class: 'small muted', 'data-tip': `Players see each ${word()}'s weather once the campaign clock reaches it` }, 'Weather not known yet') : null,
      ground ? el('div', { class: 'small' }, groundText(ground, d)) : null,
      el('small', { class: 'muted', 'data-tip': `How the visibility score was worked out: base light for the ${word()}, then moonlight, weather and terrain` }, v.parts.join(' · '))]));
    // In hours mode a day has many cards, so an hour with nothing recorded starts folded to its heading.
    const fold = c => {
      if (opt.big || !hourMode() || isNow || s.activity || s.gm_notes || (s.visibility_override ?? '') !== '' || notes.length) return c;
      const det = el('details', { class: c.className + ' folded' }), sum = el('summary');
      sum.append(c.firstChild); det.append(sum, ...c.childNodes);
      return det;
    };
    // the actions: the big box's (a player picks their own there), else a line of what was picked
    const actsBox = opt.actions && (opt.big || !isGM() || opt.readOnly) ? shiftActionsBox(d, i, opt.actions, { readOnly: opt.readOnly || !opt.big, party: opt.party }) : null;
    if (!isGM() || opt.readOnly) {
      card.append(el('p', { class: 'pre' }, s.activity ? linked(s.activity) : el('span', { class: 'muted' }, 'No activity recorded.')), actsBox || '', shiftNotes(d, i, notes, opt.after));
      return fold(card);
    }
    // The GM's editor folds to a summary of what's recorded (the shift that's now starts open), and each box saves as you
    // leave it, with Saved ✓ beside the summary: no Save button.
    const act = el('textarea', { rows: opt.big ? 6 : 2, value: s.activity || '', placeholder: `What the party does this ${word()}`, 'aria-label': `What the party does this ${names[i]}`, 'data-tip': 'Players can see this' });
    const gmn = el('textarea', { rows: opt.big ? 3 : 2, value: s.gm_notes || '', placeholder: 'GM-only notes 🔒', 'aria-label': `GM-only notes for ${names[i]}`, 'data-tip': 'Only GMs ever see these' });
    // the visibility pill is itself the choice: Auto (what the light, moon, weather and terrain give) first, then each score
    const auto = E.visibility(c, region, sw, d, i, null);
    const ov = select([['', `👁 ${auto.score} ${auto.label} · auto`], ...E.VIS_LABELS.map((l, k) => [k, `👁 ${k} ${l}`])], s.visibility_override ?? '');
    ov.setAttribute('aria-label', `Visibility for ${names[i]}`);
    const drawVis = () => {
      const nv = ov.value === '' ? auto : E.visibility(c, region, sw, d, i, Number(ov.value));
      ov.className = `vis vis-select v${nv.score}`;
      ov.dataset.tip = `Visibility ${nv.score} of 5 (${nv.label}): how well the party can see this ${word()}.\n${nv.parts.join(' · ')}\nPick a score to force it for this ${word()} (a magical darkness, a burning city), or Auto to work it out again`;
    };
    drawVis();
    ov.addEventListener('change', drawVis);
    const status = el('small', { class: 'shift-status', role: 'status' });
    const preview = el('span', { class: 'shift-preview' });
    const drawPreview = () => preview.replaceChildren(...clean([
      act.value.trim() ? el('span', { class: 'pre' }, linked(act.value)) : el('span', { class: 'muted' }, 'Nothing recorded yet.'),
      gmn.value.trim() ? el('span', { class: 'shift-gmn' }, '🔒 ', linked(gmn.value)) : null]));
    drawPreview();
    let saved = { a: act.value, g: gmn.value, o: String(ov.value) }, queue = Promise.resolve();
    // the Feature Highlighter asks once the GM is done with the shift (focus leaves its editor), not after every box
    const nouns = {};
    const offer = () => queue.then(() => {
      const list = [nouns.a ? { text: saved.a, label: `${names[i]} activity` } : null, nouns.g ? { text: saved.g, secret: true, label: `${names[i]} GM notes` } : null].filter(Boolean);
      nouns.a = nouns.g = false;
      if (list.length) offerNouns(list);
    });
    const save = () => queue = queue.then(async () => {
      const now = { a: act.value, g: gmn.value, o: String(ov.value) };
      if (now.a === saved.a && now.g === saved.g && now.o === saved.o) return;
      status.textContent = 'Saving…'; status.className = 'shift-status';
      try {
        await post('shift_save', { abs_day: d, shift: i, activity: now.a, gm_notes: now.g, visibility_override: now.o, transit: E.isOnTheMove(now.a) }, S.camp.id);
        const was = saved; saved = now;
        status.textContent = 'Saved ✓'; status.className = 'shift-status ok';
        drawPreview();
        if (now.a !== was.a) nouns.a = true;
        if (now.g !== was.g) nouns.g = true;
      } catch (err) { status.textContent = 'Not saved'; status.className = 'shift-status bad'; toast(err.message, true); }
    });
    for (const x of [act, gmn, ov]) x.addEventListener('change', save);
    // the visibility changes from its pill in the card's heading: a click opens the choice under it
    card.querySelector('.vis').replaceWith(ov);
    ov.addEventListener('click', e => e.stopPropagation());   // in a folded card's summary: don't fold it as well
    // the big box: the writing is the main thing, with the actions beside it; a day page's card keeps them in its editor
    const editor = el('details', { class: 'shift-edit', open: isNow || opt.big || null },
      el('summary', { 'data-tip': `Open to write what the party does, pick everyone's actions and write GM-only notes. Each box saves as you leave it` },
        preview, el('span', { class: 'shift-edit-label' }, el('span', { class: 'when-closed' }, '✎ Edit'), el('span', { class: 'when-open' }, 'Done'))),
      opt.big ? el('span', { class: 'lbl' }, 'What the party does') : null, act,
      opt.big ? el('span', { class: 'lbl' }, '🔒 GM notes') : null, gmn, mentionRow(s.activity, s.gm_notes) || '',
      !opt.big && opt.actions ? shiftActionsBox(d, i, opt.actions, { party: opt.party }) : null);
    editor.addEventListener('focusout', e => { if (!editor.contains(e.relatedTarget)) { save(); offer(); } });
    editor.addEventListener('toggle', () => { if (!editor.open) { save(); offer(); } });
    card.append(editor, status, actsBox || '', shiftNotes(d, i, notes, opt.after));
    return fold(card);
  }

  /** Who wrote something: their character name, with the player's own name on hover when it differs. */
  function byline(x) {
    const who = x.author || 'unknown';
    return x.player && x.player !== who ? el('span', { 'data-tip': `Played by ${x.player}` }, who) : who;
  }

  /** Free notes at the foot of a shift card, separate from events. Anyone in the campaign can add one. */
  function shiftNotes(d, i, notes, after = route) {
    const list = notes.map(n => el('div', { class: 'enote', 'data-undo': `shift_note_delete:${n.id}` },
      el('div', { class: 'pre' }, linked(n.body)),
      el('small', { class: 'muted' }, '— ', byline(n), `, ${n.created_at}`,
        (isGM() || Number(n.user_id) === S.user.id) ? tipped(btn('Delete', ev =>
          undoDelete(ev.currentTarget.closest('.enote'), `Deleted the note "${shortText(n.body)}"`, 'shift_note_delete', { id: n.id }), 'small danger note-del'), 'Delete this note') : null)));
    // the box stays closed behind + Note until it's wanted
    const input = el('textarea', { rows: 3, placeholder: 'Your note', hidden: true, 'aria-label': `Notes for ${shiftNames()[i]}`, 'data-tip': 'Everyone in the campaign can read these' });
    const add = btn('+ Note', null, 'small', `Add your note to this ${word()}, signed with your character name`);
    add.addEventListener('click', busy(add, async () => {
      if (input.hidden) { input.hidden = false; add.textContent = 'Add note'; input.focus(); return; }
      if (!input.value.trim()) return;
      await post('shift_note_add', { abs_day: d, shift: i, body: input.value }, S.camp.id); after();
      if (!PANEL) offerNouns([{ text: input.value, label: `a ${shiftNames()[i]} note` }]);   // the panel can't add entries
    }));
    return el('div', { class: 'shiftnotes' }, list.length ? el('span', { class: 'lbl' }, 'Notes') : null, el('div', { class: 'enotes' }, list), input, el('div', { class: 'row' }, add));
  }

  // Recent and Pinned in the Legend: each campaign's own choice, off unless a GM turns them on in Settings. Recent is the
  // last five things you opened, kept in this browser. Pinned is the GMs' short list for tonight (an entry, a tome, a session,
  // a map), kept in the campaign's settings, so everyone in the campaign sees it; entries a member can't see are left out.
  const quickOn = k => !!settings()[`legend_${k}`];
  const RECENT_MAX = 5;
  const recentKey = () => `chronicle:recent:${S.user?.id}:${S.camp?.id}`;
  const recentList = () => { try { return JSON.parse(localStorage.getItem(recentKey()) || '[]'); } catch { return []; } };
  const QUICK_KIND = { encyclopedia: ['entry', '📖'], library: ['tome', '📜'], sessions: ['session', '📝'], maps: ['map', '🗺'], day: ['day', '📅'] };
  function noteRecent(hash) {
    if (!S.camp) return;   // kept even with Recent off in the Legend: Ctrl K lists it
    const m = hash.match(/^#\/c\/(\d+)\/(encyclopedia|library|sessions|maps|day)\/(\d+)$/);
    if (!m || Number(m[1]) !== S.camp.id) return;
    const head = hash === location.hash ? app().querySelector('.enc-detail h2') || app().querySelector('.map-page h2, .map-head h2, h2') : null;
    const text = node => { const c = node?.cloneNode(true); c?.querySelectorAll('.tip, .secret-tag, img').forEach(x => x.remove()); return (c?.textContent || '').trim(); };
    const label = m[2] === 'day' ? E.fmtDate(cal(), Number(m[3]), { noWeekday: true })
      : m[2] === 'encyclopedia' ? S.encyclopedia.find(e => e.id === Number(m[3]))?.name || text(head) : text(head);
    if (!label) return;
    const list = [{ hash, label, icon: QUICK_KIND[m[2]][1] }, ...recentList().filter(x => x.hash !== hash)].slice(0, RECENT_MAX);
    try { localStorage.setItem(recentKey(), JSON.stringify(list)); } catch { /* private mode: no Recent */ }
  }
  const pinsOf = () => (Array.isArray(settings().legend_pins) ? settings().legend_pins : []);
  const pinHref = p => `#/c/${S.camp.id}/${{ entry: 'encyclopedia', tome: 'library', session: 'sessions', map: 'maps' }[p.kind]}/${p.id}`;
  // A session's title is never kept in the pin: the campaign's settings reach players, and an unpublished session's title
  // must not. Its name comes from the sessions list this member may read (a player: the published ones), loaded once.
  let pinSessions = null, pinSessionsCid = null, pinSessionsLoading = null;
  function loadPinSessions() {
    const cid = S.camp.id;
    if (pinSessionsCid === cid && (pinSessions || pinSessionsLoading)) return pinSessionsLoading;
    pinSessionsCid = cid; pinSessions = null;
    return (pinSessionsLoading = api('sessions', { query: { cid } }).then(r => {
      if (S.camp?.id !== cid) return;
      pinSessions = new Map((r.sessions || []).map(x => [x.id, sessionName(x)]));
      document.querySelectorAll('.legend-quick-wrap').forEach(w => w.replaceChildren(...legendQuickItems()));
    }).catch(() => {}).finally(() => { pinSessionsLoading = null; }));
  }
  /** Drop what the Legend knows of sessions, after one is saved, published or deleted. */
  const forgetPinSessions = () => { pinSessions = null; pinSessionsCid = null; };
  /** A pin's name as this member may see it, or null to leave it out (an entry that is GM only or gone, an unpublished session). */
  const pinLabel = p => (p.kind === 'entry' ? S.encyclopedia.find(e => e.id === p.id)?.name || null
    : p.kind === 'session' ? (pinSessionsCid === S.camp.id ? pinSessions?.get(p.id) : null) || null
    : p.name || null);
  /** 📌 Pin / Unpin for a GM, when Pinned is on: puts the thing in (or takes it out of) the Legend's Pinned list. */
  function pinButton(p) {
    if (!isGM() || !quickOn('pinned')) return null;
    const on = pinsOf().some(x => x.kind === p.kind && x.id === p.id);
    const b = btn(on ? '📌 Unpin' : '📌 Pin', async () => {
      const pins = on ? pinsOf().filter(x => !(x.kind === p.kind && x.id === p.id)) : [...pinsOf(), { kind: p.kind, id: p.id, ...(p.kind === 'entry' || p.kind === 'session' ? {} : { name: p.name }) }].slice(-8);
      // (this sends the campaign's settings as this browser has them, so a second GM's Settings save at the same moment
      // can be overwritten; Settings and pins are both rare, so a merge on the server isn't worth it yet)
      try { await post('campaign_update', { settings: { ...settings(), legend_pins: pins } }, S.camp.id); settings().legend_pins = pins; forgetPinSessions(); closePeek(); route(); }
      catch (err) { toast(err.message, true); }
    }, 'small pin-btn', on ? 'Take this out of the Pinned list in the Legend' : 'Put this in the Pinned list at the top of the Legend, for everyone in the campaign');
    return b;
  }
  /** The Legend's Pinned and Recent groups (nothing when both are off or empty). */
  function legendQuick() {
    if (quickOn('pinned') && pinsOf().some(p => p.kind === 'session')) loadPinSessions();
    return el('div', { class: 'legend-quick-wrap' }, legendQuickItems());
  }
  function legendQuickItems() {
    const quick = (cls, title, items) => items.length ? [el('span', { class: `legend-quick-h ${cls}` }, title),
      items.map(([href, icon, label]) => el('a', { href, class: 'legend-quick', 'data-tip': label }, el('span', { class: 'lq-icon', 'aria-hidden': 'true' }, icon), el('span', { class: 'lq-name' }, label)))] : [];
    const pins = quickOn('pinned') ? pinsOf().map(p => [pinHref(p), QUICK_KIND[{ entry: 'encyclopedia', tome: 'library', session: 'sessions', map: 'maps' }[p.kind]][1], pinLabel(p)]).filter(x => x[2]) : [];
    const here = location.hash;
    const recent = quickOn('recent') ? recentList().filter(x => x.hash !== here && x.hash.startsWith(`#/c/${S.camp.id}/`)).slice(0, RECENT_MAX).map(x => [x.hash, x.icon, x.label]) : [];
    return [...quick('pinned', '📌 Pinned', pins), ...quick('recent', 'Recent', recent)].flat();
  }

  // Peek: a click (or tap) on an Encyclopedia name written in a note opens a small card about it on the spot, with Open,
  // Show on map and Pin, instead of leaving the page you are running. Ctrl/⌘-click, a middle click or the card's Open still go there.
  let peekCard = null;
  const closePeek = () => { if (!peekCard) return; peekCard._from?.removeAttribute('aria-expanded'); peekCard.remove(); peekCard = null; document.removeEventListener('pointerdown', peekOutside, true); document.removeEventListener('keydown', peekKeys, true); };
  const peekOutside = ev => { if (peekCard && !peekCard.contains(ev.target) && !ev.target.closest?.('a.enc-link')) closePeek(); };
  const peekKeys = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); const a = peekCard?._from; closePeek(); a?.focus(); } };
  function openPeek(a, e) {
    closePeek(); hideTip();
    const cat = encCat(e.category);
    const href = `#/c/${S.camp.id}/encyclopedia/${e.id}`;
    const pins = (S.mapIndex || []).filter(p => p.entry_id === e.id);
    const card = el('div', { class: 'peek surface-float', role: 'dialog', 'aria-label': e.name },
      el('div', { class: 'peek-head' },
        e.pic ? el('img', { class: 'peek-pic', src: e.pic, alt: '' }) : el('div', { class: 'peek-pic peek-icon', 'aria-hidden': 'true' }, cat ? cat[2] : '📖'),
        el('div', {}, el('a', { class: 'peek-name', href, onclick: closePeek }, e.name),
          el('div', { class: 'etags' }, cat ? el('span', { class: 'chip enc-cat' }, `${cat[2]} ${cat[1]}`) : null, e.is_secret ? secretTag() : null))),
      el('p', { class: e.preview ? 'peek-text' : 'peek-text muted' }, e.preview || 'Nothing written about it yet.'),
      el('div', { class: 'row peek-acts' },
        el('a', { class: 'button small primary', href, onclick: closePeek }, 'Open'),
        pins.length ? el('a', { class: 'button small', href: `#/c/${S.camp.id}/maps/${pins[0].map_id}?pin=${pins[0].pin_id}`, onclick: closePeek,
          'data-tip': `Open ${pins[0].map_name} at its pin` }, '🗺 Show on map') : null,
        S.viewAs ? null : btn('+ Note', () => peekNote(card, e), 'small peek-note-btn', `Add a note to the end of ${e.name}'s notes`),
        !e.is_secret && quickOn('pinned') ? pinButton({ kind: 'entry', id: e.id }) : null));
    card._from = a;
    a.setAttribute('aria-expanded', 'true');
    document.body.append(card);
    const r = a.getBoundingClientRect(), w = card.offsetWidth;
    const left = Math.max(8, Math.min(r.left + scrollX - 16, scrollX + document.documentElement.clientWidth - w - 8));
    const below = r.bottom + card.offsetHeight + 12 < innerHeight || r.top < card.offsetHeight + 12;
    card.style.left = `${left}px`;
    card.style.top = `${(below ? r.bottom + 8 : r.top - card.offsetHeight - 8) + scrollY}px`;
    card.classList.toggle('above', !below);
    card.style.setProperty('--peek-arrow', `${Math.max(14, Math.min(w - 26, r.left + scrollX - left + Math.min(r.width / 2, 40)))}px`);
    peekCard = card;
    document.addEventListener('pointerdown', peekOutside, true);
    document.addEventListener('keydown', peekKeys, true);
    card.querySelector('.peek-acts a')?.focus({ preventScroll: true });
  }
  /** The peek's + Note: a note at the end of the entry's notes, as At the Table's Encyclopedia add does, without leaving. */
  function peekNote(card, e) {
    if (card.querySelector('.peek-note')) return card.querySelector('.peek-note textarea').focus();
    const text = el('textarea', { rows: 3, 'aria-label': `Note on ${e.name}`, placeholder: 'What you found out' });
    const gmOnly = el('input', { type: 'checkbox' });
    const save = btn('Save note', null, 'small primary');
    const form = el('div', { class: 'peek-note' }, text, el('div', { class: 'row spread' },
      isGM() ? el('label', { class: 'small inline', 'data-tip': 'Goes in the entry\'s GM notes instead, which players never see' }, gmOnly, ' GM only') : el('span'),
      el('div', { class: 'row' }, btn('Cancel', () => form.remove(), 'small'), save)));
    save.addEventListener('click', busy(save, async () => {
      const body = text.value.trim();
      if (!body) return toast('Write the note first', true);
      await post('entry_note_add', { id: e.id, body, gm_only: isGM() && gmOnly.checked }, S.camp.id);
      tableEntries = null;
      toast(`Note added to ${e.name}`);
      closePeek();
    }));
    // the card's own Open stays the one filled button until the note is being written
    card.querySelector('.peek-acts .primary')?.classList.remove('primary');
    card.querySelector('.peek-acts').before(form);
    text.focus();
  }
  // Names in prose (notes, events, summaries) peek. Lists of entries to go to (Connections, Suggested connections, the
  // 📖 names-in-this-text row) are navigation already, so their links go straight there.
  const PEEK_SKIP = '.enc-conn, .enc-conn-list, .enc-suggest-list, .enc-mentions';
  document.addEventListener('click', ev => {
    const a = ev.target.closest?.('a.enc-link');
    if (!a || PANEL || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || a.closest(`[contenteditable="true"], .peek, ${PEEK_SKIP}`)) return;
    const m = (a.getAttribute('href') || '').match(/^#\/c\/(\d+)\/encyclopedia\/(\d+)$/);
    const e = m && Number(m[1]) === S.camp?.id ? (S.encyclopedia || []).find(x => x.id === Number(m[2])) : null;
    if (!e) return;
    ev.preventDefault();
    if (peekCard?._from === a) closePeek(); else openPeek(a, e);
  });
  addEventListener('hashchange', closePeek);

  /** "📍 On the map: <map>" links, one per pin this member can see that points at entry or event `id` (key: 'entry_id' or 'event_id'). */
  const mapLinks = (key, id) => {
    const links = (S.mapIndex || []).filter(p => p[key] === id).map(p =>
      el('a', { class: 'map-link', href: `#/c/${S.camp.id}/maps/${p.map_id}?pin=${p.pin_id}`, 'data-tip': 'Open the map at this pin' }, `📍 On the map: ${p.map_name}`));
    return links.length ? el('div', { class: 'map-links small' }, links) : null;
  };

  function eventView(e, d) {
    const c = cal();
    const mine = Number(e.created_by) === S.user.id;
    const span = e.end_day !== null && e.end_day !== undefined ? ` (${E.fmtDate(c, Number(e.abs_day), { noWeekday: true })} → ${E.fmtDate(c, Number(e.end_day), { noWeekday: true })})` : '';
    const box = el('div', { class: 'event' + (Number(e.is_secret) ? ' secret' : ''), 'data-undo': `event_delete:${e.id}` });
    const notesList = el('div', { class: 'enotes' }, (e.notes || []).map(n => el('div', { class: 'enote', 'data-undo': `note_delete:${n.id}` },
      el('div', { class: 'pre' }, linked(n.body)),
      el('small', { class: 'muted' }, '— ', byline(n), `, ${n.created_at}`,
        (isGM() || Number(n.user_id) === S.user.id) ? tipped(btn('Delete', ev =>
          undoDelete(ev.currentTarget.closest('.enote'), `Deleted the note "${shortText(n.body)}"`, 'note_delete', { id: n.id }), 'small danger note-del'), 'Delete this note') : null))));
    // The note box stays folded behind its button until it's wanted, so a day of events isn't a stack of empty boxes
    const noteIn = el('textarea', { rows: 2, placeholder: 'Add a note…', hidden: true, 'aria-label': `Note on ${e.title}` });
    const addNote = btn('Add note', null, 'small', 'Add a comment to this event. Everyone who can see the event can read it');
    addNote.addEventListener('click', busy(addNote, async () => {
      if (noteIn.hidden) { noteIn.hidden = false; addNote.textContent = 'Save note'; noteIn.focus(); return; }
      if (!noteIn.value.trim()) return;
      await post('note_add', { event_id: e.id, body: noteIn.value }, S.camp.id); route();
      offerNouns([{ text: noteIn.value, secret: !!Number(e.is_secret), label: `a note on "${e.title}"` }]);
    }));
    box.append(...[
      el('div', { class: 'row spread' },
        el('h4', {}, Number(e.is_secret) ? secretTag() : null, linked(e.title)),
        el('small', { class: 'muted' }, shiftRange(e), span)),
      mapLinks('event_id', Number(e.id)),
      e.tags?.length ? el('div', { class: 'etags' }, e.tags.map(tagChip)) : null,
      e.body ? el('p', { class: 'pre' }, linked(e.body)) : null,
      el('small', { class: 'muted' }, 'Added by ', byline(e)),
      (isGM() || mine) ? el('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(eventForm(d, e)), 'small', 'Change this event'),
        isGM() && Number(e.is_secret) ? btn('🔓 Reveal', async () => {
          if (!await confirmDialog(`Make "${e.title}" public? Players see this event and its notes from now on.`, { ok: 'Reveal' })) return;
          try { await post('item_reveal', { kind: 'event', id: e.id }, S.camp.id); toast('Revealed to the players'); route(); } catch (err) { toast(err.message, true); }
        }, 'small', 'Make this GM-only event public: players see it from now on') : null,
        btn('Delete', () => undoDelete(box, `Deleted "${shortText(e.title)}"`, 'event_delete', { id: e.id }), 'small danger', 'Delete this event and its notes')) : null,
      notesList, el('div', { class: 'row' }, noteIn, addNote)].filter(Boolean));
    return box;
  }

  const canEditReminder = x => x.created_by === S.user.id || (isGM() && x.audience !== 'me');
  function reminderView(x, d) {
    const state = !x.due ? ['Waiting', `Pops up when the clock reaches ${E.fmtShift(cal(), x.due_shift)}`]
      : x.dismissed ? ['Dismissed', 'You have read this one'] : ['Due', 'The clock has reached it and you haven\'t dismissed it yet'];
    const box = el('div', { class: 'event reminder' + (x.due ? ' due' : ''), 'data-undo': `reminder_delete:${x.id}` },
      el('div', { class: 'row spread' },
        el('h4', {}, '🔔 ', linked(x.title)),
        el('small', { class: 'muted' }, shiftNames()[E.mod(x.due_shift, spd())], ' · ', el('span', { 'data-tip': state[1] }, state[0]))),
      x.body ? el('p', { class: 'pre' }, linked(x.body)) : null,
      el('small', { class: 'muted' }, `${AUDIENCE_TEXT[x.audience] || ''} · added by `, byline(x)),
      canEditReminder(x) ? el('div', { class: 'row' },
        btn('Edit', () => box.replaceWith(reminderForm(d, x)), 'small', 'Change this reminder'),
        btn('Delete', () => undoDelete(box, `Deleted the reminder "${shortText(x.title)}"`, 'reminder_delete', { id: x.id }), 'small danger', 'Delete this reminder')) : null);
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
    const all = btn('Select all', () => { off.clear(); change(); }, 'small', `Show every ${noun.replace(/s$/, '')}`);
    const none = btn('Deselect all', () => { for (const o of opts) off.add(o.key); change(); }, 'small', `Untick every ${noun.replace(/s$/, '')}, then tick the ones to show`);
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

  /** opt.pinAt: { map_id, map_name, x, y }, where the party stands: a GM can pin the new event there. */
  function eventForm(d, e = {}, opt = {}) {
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
    const pinIt = !e.id && opt.pinAt && isGM() ? el('input', { type: 'checkbox', name: 'pin_it' }) : null;
    const f = el('form', { class: 'event editing' },
      el('div', { class: 'grid2' },
        field('Title', el('input', { name: 'title', value: e.title || '', required: true, maxlength: 200 })),
        field('All day', allDay, null, `For things that fill the whole day. Untick to pick the ${word()}s it starts and ends in`),
        startField, endField,
        field('Lasts (days)', el('input', { type: 'number', name: 'lasts', min: 1, value: lasts }), null, 'More than 1 shows the event on every day it covers, like a siege or a voyage'),
        isGM() ? lockField(el('input', { type: 'checkbox', name: 'is_secret', checked: !!Number(e.is_secret) }), 'players won\'t see this event or its notes') : null),
      tags.node,
      field('Details', el('textarea', { name: 'body', rows: 4, value: e.body || '' })),
      pinIt ? el('label', { class: 'inline small', 'data-tip': `Put a pin for this event on ${opt.pinAt.map_name}, at the party's marker` }, pinIt, ` 📍 Pin it where the party is, on ${opt.pinAt.map_name}`) : null,
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, e.id ? 'Save event' : 'Add event'), btn('Cancel', () => route(), 'small')));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = formData(f), n = Math.max(1, Number(v.lasts) || 1);
      const timed = !allDay.checked;
      if (timed && n === 1 && Number(shiftEnd.value) < Number(shiftStart.value)) { toast(`${Word()} End is before ${Word()} Start`, true); return; }
      const picked = tags.get();
      try {
        const saved = await post('event_save', { id: e.id, abs_day: start, end_day: n > 1 ? start + n - 1 : null,
          shift: timed ? shiftStart.value : null, shift_end: timed ? shiftEnd.value : null,
          title: v.title, body: v.body, is_secret: v.is_secret, tags: picked }, S.camp.id);
        if (pinIt?.checked) {
          try {
            await post('pin_save', { map_id: opt.pinAt.map_id, x: opt.pinAt.x, y: opt.pinAt.y, kind: 'event', event_id: saved.id }, S.camp.id);
            await loadCampaign(S.camp.id, true);   // its 📍 link back
          } catch (err) { toast(`Event saved, but not pinned: ${err.message}`, true); }
        }
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
      api('sessions', { query: { cid: S.camp.id } }).catch(() => ({ sessions: [] }))]);
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
          mapLinks('event_id', Number(e.id)),
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
      }), ...(st.tags.size ? [btn('Clear tags', () => { st.tags.clear(); draw(); }, 'small', 'Show events with any tag, or none')] : []));
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
      el('div', { class: 'row evhead' }, eventsSubtabs('events'), el('span', { class: 'seg', role: 'group', 'aria-label': 'Show events as' }, asList, asTl)),
      el('div', { class: 'row evfilters' }, search, when, order),
      used.length ? el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags', tip('Pick one or more tags to see only the events that carry any of them')), tagRow) : null,
      count, list, timeline.node));
    setView(asTimeline); // drawn once it's on the page, so the timeline knows how wide it is
  }
  /** The Events tab's two halves along the top of its card: the events, and every reminder. */
  function eventsSubtabs(at) {
    return el('nav', { class: 'subtabs', 'aria-label': 'Events and reminders' }, [['events', 'Events', ''], ['reminders', 'Reminders', '/reminders']].map(([k, label, path]) =>
      el('a', { href: `#/c/${S.camp.id}/events${path}`, class: k === at ? 'on' : '', ...(k === at ? { 'aria-current': 'page' } : {}) }, label)));
  }

  // ------------------------------------------------------------ reminders list (the Events tab's Reminders half)
  /** Every reminder this member can see in one list, by when it is due, narrowed by a search, by whether it is still
   * waiting, due or dismissed, and (for a GM) by who it is for. Each can be edited or deleted where it is, and
   * + New reminder adds one on any day. */
  async function viewReminders() {
    const { reminders } = await loadReminders();
    const st = vs().reminders || (vs().reminders = { q: '', state: 'all', who: 'any', order: 'asc' });
    const c = cal(), n = spd(), d0 = today();
    const stateOf = x => (!x.due ? 'waiting' : x.dismissed ? 'dismissed' : 'due');
    const hay = new Map(reminders.map(x => [x, [x.title, x.body, x.author, x.player].filter(Boolean).join('\n').toLowerCase()]));

    const search = el('input', { type: 'search', value: st.q, placeholder: 'Search titles and details', 'aria-label': 'Search reminders' });
    const state = select([['all', 'All reminders'], ['waiting', 'Still to come'], ['due', 'Due, not dismissed'], ['dismissed', 'Dismissed']], st.state,
      { 'aria-label': 'Which reminders', 'data-tip': 'Every reminder, only those the clock hasn\'t reached yet, those it has that you haven\'t dismissed, or those you have' });
    const who = isGM() ? select([['any', 'For anyone'], ...REMINDER_AUDIENCES], st.who, { 'aria-label': 'Who sees it', 'data-tip': 'Only reminders kept for yourself, for the GMs, or for everyone' }) : null;
    const order = select([['asc', 'Soonest first'], ['desc', 'Latest first']], st.order, { 'aria-label': 'Order' });
    const count = el('p', { class: 'small muted', 'aria-live': 'polite' });
    const list = el('div', { class: 'evlist remlist' });
    const adder = el('div', {});

    const row = (x, words) => {
      const d = Math.floor(x.due_shift / n), s = stateOf(x);
      const when = d < d0 ? 'past' : d > d0 ? 'future' : 'now';
      const label = { waiting: 'Waiting', due: 'Due', dismissed: 'Dismissed' }[s];
      const tipText = { waiting: `Pops up when the clock reaches ${E.fmtShift(c, x.due_shift)}`, due: 'The clock has reached it and you haven\'t dismissed it yet', dismissed: 'You have read this one' }[s];
      const r = el('div', { class: `listrow evrow remrow ${when} ${s}`, 'data-undo': `reminder_delete:${x.id}` },
        el('div', { class: 'evwhen' },
          el('a', { href: `#/c/${S.camp.id}/day/${d}`, 'data-tip': 'Open this day' }, E.fmtDate(c, d, { noWeekday: true })),
          el('div', { class: 'small muted' }, shiftNames()[E.mod(x.due_shift, n)], ' · ', el('span', { class: `remstate ${s}`, 'data-tip': tipText }, label))),
        el('div', { class: 'evbody' },
          el('h4', {}, '🔔 ', words.length ? markWords(x.title, words) : linked(x.title)),
          x.body ? el('p', { class: 'small pre' }, words.length ? markWords(x.body, words) : linked(x.body)) : null,
          el('small', { class: 'muted' }, `${AUDIENCE_TEXT[x.audience] || ''} · added by `, byline(x)),
          canEditReminder(x) ? el('div', { class: 'row' },
            btn('Edit', () => r.replaceWith(reminderForm(d, x)), 'small', 'Change this reminder'),
            btn('Delete', () => undoDelete(r, `Deleted the reminder "${shortText(x.title)}"`, 'reminder_delete', { id: x.id }), 'small danger', 'Delete this reminder')) : null));
      return r;
    };
    const draw = () => {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = reminders.filter(x => (st.state === 'all' || stateOf(x) === st.state)
        && (!who || st.who === 'any' || x.audience === st.who)
        && words.every(w => hay.get(x).includes(w)));
      const noun = k => `${k} reminder${k === 1 ? '' : 's'}`;
      count.textContent = shown.length === reminders.length ? noun(reminders.length) : `${shown.length} of ${noun(reminders.length)}`;
      if (st.order === 'desc') shown = shown.slice().reverse();
      list.replaceChildren(...(shown.length ? shown.map(x => row(x, words))
        : [el('p', { class: 'muted' }, reminders.length ? 'No reminders match. Clear the search or pick All reminders to see more.' : 'No reminders yet. Add one here or from any day on the Calendar.')]));
    };
    search.addEventListener('input', () => { st.q = search.value; draw(); });
    state.addEventListener('change', () => { st.state = state.value; draw(); });
    who?.addEventListener('change', () => { st.who = who.value; draw(); });
    order.addEventListener('change', () => { st.order = order.value; draw(); });
    const add = btn('+ New reminder', () => { adder.replaceChildren(reminderForm(d0)); adder.querySelector('input')?.focus(); }, 'primary small',
      `Have something pop up when the campaign reaches a ${word()}: set it on any day`);
    mount(...campaignHeader('events'), el('div', { class: 'card' },
      el('div', { class: 'row evhead' }, eventsSubtabs('reminders'), add),
      el('p', { class: 'small muted' }, `A reminder pops up once the campaign clock reaches its ${word()}, for whoever it is for, until they dismiss it.`),
      adder,
      el('div', { class: 'row evfilters' }, search, state, who, order),
      count, list));
    draw();
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
    const laneOpts = [['tags', 'Lanes by tag'], ...(S.encyclopedia.length ? [['entries', 'Lanes by Encyclopedia entry']] : []), ['one', 'One lane']];
    if (!laneOpts.some(o => o[0] === tl.lanes)) tl.lanes = 'tags';
    const laneSel = select(laneOpts, tl.lanes, { 'aria-label': 'Lanes', 'data-tip': 'One lane per tag (an event with two tags is in both), one per Encyclopedia entry the events name, or every event in one lane' });
    laneSel.addEventListener('change', () => { tl.lanes = laneSel.value; render(); });
    const bandBox = (key, label, tipText) => {
      const cb = el('input', { type: 'checkbox', checked: !!tl.bands[key] });
      cb.addEventListener('change', () => { tl.bands[key] = cb.checked; render(); });
      return el('label', { class: 'tl-band-opt small', 'data-tip': tipText }, cb, ` ${label}`);
    };
    const bands = [
      sessions.length ? bandBox('sessions', 'Sessions', 'A band showing the days each session covered') : null,
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
      if (tl.bands.sessions && sessions.length) {
        bandRow('Sessions', y0 => sessions.filter(x => x.first_day !== null && !x.undated).map(x => {
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

  // ------------------------------------------------------------ encyclopedia: static/encyclopedia-tab.js
  let encLinker, linked, linkedNote, revealButtons, mentionRow, encMentions, offerNouns, sourceLabel, scanOneBtn, entryBlank, deleteEntryBtn, viewEncyclopedia, sourcesNaming, saveFile;

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
          const r = await post('image_import', { parent_type: parentType, parent_id: parentId, source: it.source, id: it.id, mode, is_secret: !!gmOnly?.checked }, cid);
          toast('Picture added');
          opts.onAdded(r.file);
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
            el('p', { class: 'small muted' }, da ? (opts.copyOnly ? 'Not openly licensed: ask the artist before copying it.' : 'Not openly licensed: embed it from DeviantArt, or ask the artist before copying it.') : 'Not openly licensed, so it can\'t be copied here.'),
            da ? el('div', { class: 'row' }, link(it.landing_url, 'View on DeviantArt', 'button small'), link(it.author_url, 'Artist\'s page', 'button small'),
              opts.copyOnly ? null : btn('Embed from DeviantArt', ev => pick('embed', ev), 'small', 'Show this work on the entry from DeviantArt, credited, without copying it. If the artist removes it, it goes from here too')) : null));
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
    const addBtn = up.ready ? el('label', { class: 'button small file-add', 'data-tip': `Add a picture (JPEG, PNG, GIF, WebP) or a file (PDF, text) up to ${fileSize(up.max_bytes)}. You can also drop files here` }, input, '📎 Add') : null;
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
        el('div', { class: 'row' }, gmOnly ? lockBox(gmOnly, 'only GMs will see what you add') : null, findBtn, addBtn)),
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
      secret ? lockBox(secret, opts.secret ? 'everything on a GM-only entry is GM only' : 'only GMs will see this file') : null,
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
          list.length ? btn('🕸 Web', () => ctx.web({ center: e.id }), 'small', `Draw ${e.name}'s connections as a web, one or two steps out`) : null,
          Web.hasFamily({ conns }, e.id) ? btn('🌳 Family', () => ctx.web({ center: e.id, mode: 'family' }), 'small', `Draw ${e.name}'s family: parents, partners, children and siblings`) : null,
          list.length ? btn('Show in list', () => { st.near = e.id; ctx.draw(); }, 'small', `List ${e.name} and the entries connected to it`) : null,
          btn('🔗 Link', () => connectDialog(e, rel), 'small', `Connect ${e.name} to one or more entries`))),
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
      secret ? lockBox(secret, e.is_secret ? `${e.name} is GM only, so its connections are too` : 'only GMs will see these connections. Connections to a GM-only entry always are') : null,
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
    sourcesNaming(e).then(({ sources }) => {
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
  /** What the Maps tab's modules (static/tokens.js, and the Maps tab itself) get of the page: they need nothing else of it. */
  const mapsCtx = extra => ({ el, btn, api, post, mount, campaignHeader, toast, confirmDialog, field, select, isGM, unitSystem, findImage, S,
    encCat, genre: () => E.genreOf(settings()), offerNouns, today, fmtDay: d => E.fmtDate(cal(), d, { noWeekday: true }), fmtShift: a => E.fmtShift(cal(), a), uploadFile, reloadCampaign: () => loadCampaign(S.camp.id, true),
    nowShift, slotWord: word, logOnShift, ...extra });
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
      el('div', { class: 'row' }, btn('None of these', () => out.replaceChildren(), 'small')));
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

  /** opt (from the Encyclopedia tab): tools, more buttons for the header; extra, cards under the notes (connections). */
  function entryForm(e, opt = {}) {
    const name = el('input', { name: 'name', value: e.name || '', required: true, maxlength: 150, placeholder: 'e.g. The Grey Lady inn' });
    const aliases = el('input', { name: 'aliases', value: (e.aliases || []).join(', '), maxlength: 2000, placeholder: 'e.g. Hoffmann, the innkeeper' });
    const tags = tagPicker(e.tags || [], 'entry', S.encTags);
    const category = select([['', 'None'], ...ENC_CATEGORIES.map(([k, n, i]) => [k, `${i} ${n}`])], e.category || '', { name: 'category' });
    const secret = isGM() ? el('input', { type: 'checkbox', name: 'is_secret', checked: !!e.is_secret }) : null;
    const pub = RichText.editor({ text: e.notes || '', format: 'html', label: 'Public notes', placeholder: 'What the party knows: who or what it is, where, what happened there', secret: isGM(), mentions: encMentions() });
    const gm = isGM() ? RichText.editor({ text: e.gm_notes || '', format: 'html', label: 'GM notes', placeholder: 'Secrets, plans and the truth of it, for GMs only', mentions: encMentions() }) : null;
    // a Person entry's character sheet, from the editor too (a blank entry opens straight here): Open sheet, or a GM's
    // Add character sheet, shown while the Category picked is Person (or none)
    const ch = e.id ? S.encChars?.[e.id] || null : null;
    const sheetBtn = !e.id || typeof Sheets === 'undefined' ? null
      : ch ? (ch.sheet_visible ? el('a', { class: 'button small', href: `#/c/${S.camp.id}/characters/${ch.id}`, 'data-tip': `Open ${e.name}'s character sheet` }, 'Open sheet') : null)
      : isGM() ? btn('Add character sheet', () => Sheets.addToEntry(e).catch(err => toast(err.message, true)), 'small', 'Give this person a character sheet, for a PC or an NPC with stats') : null;
    const memberBtn = e.id && typeof Sheets !== 'undefined' && isGM()
      ? btn('Link a member…', () => Sheets.linkMember(e).catch(err => toast(err.message, true)), 'small', 'Say which member of the campaign plays this person: it becomes their character (a sheet is made if it has none)') : null;
    if (memberBtn && !ch) {
      const fit = () => { memberBtn.style.display = ['', 'person'].includes(category.value) ? '' : 'none'; };
      category.addEventListener('change', fit);
      fit();
    }
    if (sheetBtn && !ch) {
      const fit = () => { sheetBtn.style.display = ['', 'person'].includes(category.value) ? '' : 'none'; };
      category.addEventListener('change', fit);
      fit();
    }
    const f = el('form', { class: 'enc-form' },
      el('div', { class: 'row spread' }, el('h2', {}, e.id ? `Edit ${e.name}` : 'New entry'), el('div', { class: 'row' }, sheetBtn, memberBtn, opt.tools || [])),
      e.id ? mapLinks('entry_id', e.id) : null,   // a blank entry opens here, so its pins are linked here too
      el('div', { class: 'grid2' },
        field('Name', name),
        category ? field('Category', category, null, 'What kind of thing it is. The Encyclopedia lists entries by Category; use tags to tell entries of one Category apart') : null,
        field('Other names', aliases, null, 'Other ways the same thing is written, separated by commas. Each one links to this entry and is never offered by the Feature Highlighter'),
        secret ? lockField(secret, 'players won\'t see this entry at all, or have its name linked') : null),
      // the notes straight under the name, where the writing is; tags, the quotes found elsewhere and Generate Summary after
      el('div', { class: 'notes-grid' },
        el('div', { class: 'notepanel public' }, el('h4', {}, 'Public notes', tip('Everyone in the campaign can read these, and change them')), pub.node),
        gm ? el('div', { class: 'notepanel secret' }, el('h4', {}, '🔒 GM notes', tip('Only GMs ever see these. The server never sends them to players')), gm.node) : null),
      tags.node,
      ...(opt.extra || []).filter(Boolean),
      e.id ? foundIn(e, pub, gm) : null,
      e.id ? wikiSummary(name, pub) : null,
      e.id && Fan ? Fan.summary(fanCtx({ name, pub })) : null,
      e.id ? attachmentsCard('encyclopedia', e.id, e.files || (e.files = []), { uploads: S.encUploads, secret: e.is_secret, name: e.name }) : null,
      el('div', { class: 'row' }, el('button', { class: 'primary small' }, e.id ? 'Save entry' : 'Add entry'),
        e.id && !entryBlank(e) ? btn('Cancel', () => route(), 'small') : el('a', { class: 'button small', href: `#/c/${S.camp.id}/encyclopedia` }, 'Cancel'),
        deleteEntryBtn(e)));
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const p = pub.value(), g = gm?.value();
      const body = { id: e.id, version: e.id ? e.version : undefined, name: name.value, aliases: aliases.value.split(',').map(x => x.trim()).filter(Boolean), notes: p.text, tags: tags.get() };
      if (category) body.category = category.value;
      if (gm) Object.assign(body, { gm_notes: g.text, is_secret: secret.checked });
      try {
        const { id, version } = await post('entry_save', body, S.camp.id);
        e.version = version;
        for (const t of body.tags) if (!S.encTags.some(x => x.name.toLowerCase() === t.name.toLowerCase())) S.encTags.push(t);
        const was = S.encyclopedia.filter(x => x.id !== id);
        S.encyclopedia = [...was, { id, name: name.value.trim(), aliases: body.aliases, is_secret: !!secret?.checked, blank: !p.text && !g?.text, pic: S.encyclopedia.find(x => x.id === id)?.pic || null, token_url: S.encyclopedia.find(x => x.id === id)?.token_url || null,
          preview: Nouns.plain(p.text, 'html').replace(/\s+/g, ' ').trim().slice(0, 140) }].sort((a, b) => a.name.localeCompare(b.name));
        toast('Entry saved');
        const to = `#/c/${S.camp.id}/encyclopedia/${id}`;
        if (location.hash === to) route(); else location.hash = to;
        offerNouns([{ text: p.text, format: 'html', secret: !!secret?.checked, label: 'Public notes' }, gm ? { text: g.text, format: 'html', secret: true, label: 'GM notes' } : null].filter(Boolean));
      } catch (err) { toast(err.message, true); }
    });
    return f;
  }

  // ------------------------------------------------------------ list and reader
  // Encyclopedia, Library and Sessions share one layout: a list card with its title, + New, a ⋯ menu for the rarer
  // actions and Wide view, « to tuck the list away, then search and filters above the list; the reader card beside it with the item picked.
  /** wide: { key, tips: [off, on] } lets the page swap widths, remembered in this browser under key.
   * hide: { key, was } puts a « at the list's top right that tucks it away to a thin rail (» and its name, the whole rail a
   * button to bring it back) so the item picked takes the screen, remembered under key
   * (was: an older key whose '1' counts as hidden until the button is pressed). Two columns only: one column has nothing to fold. */
  function listPage({ cls = '', title, tipText, add = null, more = [], wide = null, hide = null, top = [], list, reader, picked }) {
    const page = el('div', { class: `enc-page ${cls}`.trim() + (picked ? ' has-sel' : '') });
    const toggle = (o, onCls, label, tips) => {
      let on = false;
      try { on = localStorage.getItem(o.key) === '1' || (!!o.was && localStorage.getItem(o.key) === null && localStorage.getItem(o.was) === '1'); } catch { /* private mode */ }
      const b = btn('', () => {
        on = !on;
        try { localStorage.setItem(o.key, on ? '1' : '0'); } catch { /* private mode: just this page */ }
        set();
        if (onCls === 'list-hidden') (on ? rail : b).focus();
      }, onCls === 'wide' ? 'small enc-widebtn' : 'lp-hidebtn');
      const set = () => {
        page.classList.toggle(onCls, on);
        b.textContent = label(on);
        b.setAttribute('aria-pressed', String(on));
        b.dataset.tip = tips[on ? 1 : 0];
      };
      const rail = onCls === 'list-hidden' ? el('button', { type: 'button', class: 'lp-rail', 'aria-label': `Show the ${title} list`, 'data-tip': `Show the ${title} list again`,
        onclick: () => b.click() }, el('span', { class: 'lp-rail-icon', 'aria-hidden': 'true' }, '»'), el('span', { class: 'lp-rail-name' }, title)) : null;
      set();
      return { b, rail };
    };
    const wideBtn = wide ? toggle(wide, 'wide', on => on ? '⇤ Narrow view' : '⇥ Wide view', wide.tips).b : null;
    const hid = hide ? toggle(hide, 'list-hidden', () => '«', [`Tuck the list away to the left, so the ${picked ? 'item picked' : 'page'} takes the room. It stays as you leave it in this browser`, '']) : null;
    hid?.b.setAttribute('aria-label', 'Hide the list');
    const items = more.filter(Boolean);
    const menu = items.length ? KIT.menu({ ariaLabel: `More for ${title}`, tip: 'More: scan, export and the like', items, cls: 'more-menu' }) : null;
    const left = el('section', { class: 'card enc-index' },
      el('div', { class: 'lp-head' + (hid ? ' has-hide' : '') }, el('h2', {}, title, tipText ? tip(tipText) : null), el('div', { class: 'lp-actions' }, add, menu, wideBtn), hid?.b),
      ...clean(top), list, hid?.rail);
    list.classList.add('lp-list');
    reader.classList.add('card', 'enc-detail');
    page.append(left, reader);
    return page;
  }
  /** The reader with nothing picked: a line, then a few items to start from (the open session, the newest entries, the
   * tomes last changed) as links, then the help. On one column (a phone, an iPad upright) it's left out, as the list is enough. */
  function readerEmpty(reader, { lead, title = '', start = [], help = '' }) {
    reader.classList.add('lp-empty');
    reader.append(...clean([el('p', { class: 'muted lp-lead' }, lead),
      start.length ? el('div', { class: 'lp-start' }, el('h3', {}, title), start) : null,
      help ? el('p', { class: 'small muted' }, help) : null]));
    return reader;
  }

  // ------------------------------------------------------------ library tab
  // The campaign's books, journals and notes ("tomes"): a title, a short description and a long body in the same
  // word-processor editor as the day notes. Every member, GM or player, can add a tome and change any of them.
  const TOME_KINDS = [['book', 'Book', '📕'], ['journal', 'Journal', '📓'], ['note', 'Note', '📜']];
  const tomeKind = k => TOME_KINDS.find(x => x[0] === k) || TOME_KINDS[0];

  /** The Library tab: the tomes down the left, the one picked on the right. sel: a tome id, 'new', or nothing. */
  async function viewLibrary(sel) {
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
    const item = (t, cls = 'lib-item') => el('a', { class: `${cls === 'lp-start-item' ? '' : 'enc-item '}enc-card ${cls}` + (current?.id === t.id ? ' on' : ''), href: href(t.id), 'aria-current': current?.id === t.id ? 'page' : null },
      el('span', { class: 'enc-name' }, el('span', { 'aria-hidden': 'true' }, `${tomeKind(t.kind)[2]} `), t.title),
      t.description ? el('small', { class: 'lib-desc' }, t.description) : null);
    const draw = () => {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = tomes.filter(t => (!st.kinds.size || st.kinds.has(t.kind)) && words.every(w => `${t.title}\n${t.description}`.toLowerCase().includes(w)));
      list.replaceChildren(el('h3', {}, `Tomes (${shown.length}${shown.length !== tomes.length ? ` of ${tomes.length}` : ''})`),
        ...(shown.length ? shown.map(t => item(t)) : [el('p', { class: 'muted small' }, tomes.length ? 'Nothing matches. Clear the search or the kinds to see more.'
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

    // --- the tome picked, or the ones last changed to start from
    const reader = el('section', { class: 'lib-detail' });
    if (sel && sel !== 'new' && !current) reader.append(el('p', { class: 'muted' }, 'That tome isn\'t in the Library any more.'));
    else if (!current) readerEmpty(reader, { lead: tomes.length ? 'Pick a tome to read it.' : 'Nothing on the shelves yet.',
      title: 'Last changed', start: [...tomes].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id).slice(0, 5).map(t => item(t, 'lp-start-item')),
      help: 'A tome is a book the party found, a character\'s journal, or a note passed across the table. Give it a title and a line about it, then write it out in full.' });
    else if (!current.id) reader.append(tomeForm(current));
    else reader.append(...tomeView(current));
    mount(...campaignHeader('library'), listPage({ cls: 'lib-page', title: 'Library', picked: !!(current || sel),
      tipText: 'The campaign\'s books, journals and notes. Everyone in the campaign, GM or player, can add a tome and change any of them',
      add: el('a', { class: 'button primary small', href: href('new'), 'data-tip': 'Add a book, a journal or a note' }, '+ New tome'),
      hide: { key: 'chronicle:libhide' },
      wide: { key: 'chronicle:libwide', tips: ['Widen the list to see more of the Library at once, and narrow the tome', 'Give the tome its room back and narrow the list'] },
      top: [search, el('div', { class: 'enc-filters' }, kindRow)], list, reader }));
  }

  function tomeView(t) {
    const [, label, icon] = tomeKind(t.kind);
    const canDelete = isGM() || t.created_by === S.user.id;
    const changed = t.editor && (t.editor !== t.author || t.updated_at !== t.created_at);
    return clean([
      trail(['Library', `#/c/${S.camp.id}/library`], [label], [t.title]),
      el('div', { class: 'row spread' },
        el('h2', {}, t.title),
        el('div', { class: 'row' },
          btn('Edit', ev => ev.currentTarget.closest('.lib-detail').replaceChildren(tomeForm(t)), 'small primary', 'Change this tome. Anyone in the campaign can'),
          pinButton({ kind: 'tome', id: t.id, name: t.title }),
          scanOneBtn('tome', s => s.kind === 'tome' && s.id === t.id, `"${t.title}"`),
          isGM() ? btn('🕘 History', () => HistoryView.open({ kind: 'tome', ref: t.id, title: t.title, cid: S.camp.id, api, post, onRestore: route }), 'small', 'Earlier versions of this tome, what each save changed, and Restore. GMs only') : null,
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

  // ------------------------------------------------------------ sessions tab: static/sessions-tab.js
  let viewSessions;

  // ------------------------------------------------------------ travel tab
  async function viewTravel() {
    const out = el('div', { class: 'travel-out' });
    // The party's groups (main first), the maps' names and, for Depart, the pins of the map a group is on.
    let groups = [], mapNames = new Map(), result = null;
    const pinCache = new Map();
    const loadParty = async () => {
      try {
        groups = (await api('groups', { query: { cid: S.camp.id } })).groups;
        mapNames = new Map((await api('maps', { query: { cid: S.camp.id } })).maps.map(m => [m.id, m.name]));
      } catch { /* the card is only a convenience; the planner still works */ }
    };
    await loadParty();
    // Plan this trip: a saved route (route=) or a measured path (path=x,y;x,y…) on a map, sent from the Maps tab
    let trip = null;   // { map, pins, points, name }
    const tq = new URLSearchParams(location.hash.split('?')[1] || '');
    if (tq.get('map')) {
      try {
        const d = await api('map', { query: { cid: S.camp.id, id: tq.get('map') } });
        const r = tq.get('route') ? (d.routes || []).find(x => x.id === Number(tq.get('route'))) : null;
        const points = r ? r.points.map(([x, y]) => ({ x, y }))
          : (tq.get('path') || '').split(';').map(p => p.split(',').map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite)).map(([x, y]) => ({ x, y }));
        if (points.length > 1 && MapGeo.toMetres(1, d.map) !== null) trip = { map: d.map, pins: d.pins || [], points, name: r ? r.name : null, terrain: r && Array.isArray(r.terrain) && r.terrain.length === points.length - 1 ? [...r.terrain] : null };
      } catch { /* a map that can't be read plans nothing */ }
    }
    const partyCard = el('div', { class: 'card party-card' });
    const memberName = uid => { const m = S.members.find(x => Number(x.id) === uid); return m ? m.character_name || m.display_name : 'Someone'; };
    const charName = c => (c.kind === 'npc' ? `${c.name} (NPC)` : c.name);
    /** Who is in group g: its players, then the characters with no player who travel with it. */
    const partyNames = g => [...g.members.map(memberName), ...(g.characters || []).map(charName)];
    const reloadParty = async () => { await loadParty(); drawParty(); result = null; out.replaceChildren(); };   // Depart is offered again with the new groups
    /** A small modal form: run() does the work, and the card is redrawn after. */
    const partyDialog = (title, kids, ok, run) => {
      const d = el('dialog', { class: 'kit-dialog party-dialog', 'aria-label': title });
      const go = el('button', { class: 'primary', type: 'submit' }, ok);
      const form = el('form', {}, el('h3', {}, title), kids, el('div', { class: 'kit-dialog-actions' }, go, btn('Cancel', () => d.close())));
      form.addEventListener('submit', async ev => {
        ev.preventDefault(); go.disabled = true;
        try { await run(); d.close(); await reloadParty(); } catch (err) { toast(err.message, true); go.disabled = false; }
      });
      d.addEventListener('close', () => d.remove());
      d.append(form); document.body.append(d); d.showModal();
    };
    const splitParty = () => {
      const name = el('input', { maxlength: 100, required: true, autocomplete: 'off', placeholder: 'e.g. Scouts' });
      const from = groups.length > 1 ? select(groups.map(g => [g.id, g.name]), groups[0].id) : null;
      const region = select([['', '— none —'], ...S.regions.map(r => [r.id, r.name])], groups[0].region_id ?? '');
      const pick = el('div', { class: 'party-pick' });
      const fromGroup = () => groups.find(g => g.id === Number(from ? from.value : groups[0].id));
      const drawPick = () => {
        region.value = fromGroup().region_id ?? '';
        pick.replaceChildren(...fromGroup().members.map(u => el('label', {}, el('input', { type: 'checkbox', value: u }), memberName(u))),
          ...(fromGroup().characters || []).map(c => el('label', {}, el('input', { type: 'checkbox', value: c.id, 'data-character': '1' }), charName(c))));
        if (!pick.children.length) pick.append(el('small', { class: 'muted' }, 'No one is in that group'));
      };
      from?.addEventListener('change', drawPick); drawPick();
      partyDialog('Split the party', [from ? field('From', from) : null, field('Group name', name), field('Who goes', pick), field('Region', region, 'Where they are now')], 'Split', async () => {
        const ticked = [...pick.querySelectorAll('input:checked')];
        const members = ticked.filter(i => !i.hasAttribute('data-character')).map(i => Number(i.value));
        const characters = ticked.filter(i => i.hasAttribute('data-character')).map(i => Number(i.value));
        await post('group_split', { from_id: fromGroup().id, name: name.value, members, characters, region_id: region.value ? Number(region.value) : null }, S.camp.id);
      });
    };
    const mergeParty = g => {
      const into = select(groups.filter(x => x.id !== g.id).map(x => [x.id, x.name]), '');
      partyDialog(`Merge ${g.name}`, [field('Merge into', into, `${g.name}'s members join that group, and ${g.name} is gone`)], 'Merge',
        () => post('group_merge', { id: g.id, into_id: Number(into.value) }, S.camp.id));
    };
    const tokenParty = async g => {
      let tokens;
      try { tokens = (await api('tokens', { query: { cid: S.camp.id } })).tokens; } catch (err) { return toast(err.message, true); }
      const sel = select([['', 'None (a flag)'], ...tokens.map(t => [t.id, t.name])], g.token_id ?? '');
      partyDialog(`Token for ${g.name}`, [field('Token', sel, tokens.length ? 'Its picture is the group\'s marker on the maps' : 'Add tokens on the Tokens tab first')], 'Save',
        () => post('group_save', { id: g.id, token_id: sel.value ? Number(sel.value) : null }, S.camp.id));
    };
    const drawParty = () => {
      partyCard.hidden = !groups.length;
      partyCard.replaceChildren(el('div', { class: 'row spread' }, el('h2', {}, 'Where the party is'),
        isGM() ? btn('Split the party…', splitParty, 'small', 'Send some of the party off as a group of their own') : null),
        ...groups.map(g => el('div', { class: 'party-row' },
          el('div', { class: 'party-info' },
            el('div', {}, el('strong', { class: 'party-name' }, g.name), g.is_main ? el('span', { class: 'party-main', 'data-tip': 'Its region is the campaign\'s current region' }, 'MAIN') : null),
            el('small', { class: 'party-members muted' }, partyNames(g).join(', ') || 'No one yet'),
            el('small', {}, 'Region: ', el('span', { class: 'party-region' }, regionById(g.region_id)?.name || '—'),
              ' · Map: ', el('span', { class: 'party-map' }, mapNames.get(g.map_id) || '—'))),
          isGM() ? el('div', { class: 'actions' },
            btn('Rename', async () => {
              const name = await promptDialog('Rename this group:', { value: g.name, ok: 'Save' });
              if (!name || !name.trim()) return;
              try { await post('group_save', { id: g.id, name }, S.camp.id); await reloadParty(); } catch (err) { toast(err.message, true); }
            }, 'small'),
            g.is_main ? null : btn('Make main group', async () => {
              try { await post('group_save', { id: g.id, is_main: true }, S.camp.id); await loadCampaign(S.camp.id, true); await reloadParty(); } catch (err) { toast(err.message, true); }
            }, 'small', 'Its region becomes the campaign\'s current region, and the weather follows it'),
            groups.length > 1 ? btn('Merge into…', () => mergeParty(g), 'small', 'Its members join another group, and this one is gone') : null,
            btn('Token', () => tokenParty(g), 'small', 'Choose the picture that marks this group on the maps')) : null)));
    };
    drawParty();
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
    const tripNote = el('p', { class: 'small travel-trip' });
    /** Fill the planner from the trip: its length (a space map's in AU or light-years, by Constant thrust when the genre
     * has it), and From and To from the pins at its ends. */
    const fillTrip = () => {
      if (!trip) return;
      const m = MapGeo.toMetres(MapGeo.pathPx(trip.points), trip.map), space = MapGeo.isSpace(trip.map);
      const want = space ? 'brachistochrone' : E.SPEED_MODES.includes(modeSel.value) ? modeSel.value : 'overland';
      if (modes.some(([k]) => k === want) && modeSel.value !== want) { modeSel.value = want; drawFields(); }
      const dist = fieldsWrap.querySelector('[name=distance]'), unit = fieldsWrap.querySelector('[name=unit]');
      if (dist && unit && space) { const ly = m >= MapGeo.UNIT_M.ly; unit.value = ly ? 'LY' : 'AU'; dist.value = num(m / (ly ? MapGeo.UNIT_M.ly : MapGeo.UNIT_M.au)); }
      else if (dist && unit) { unit.value = imp() ? 'mi' : 'km'; dist.value = num(m / (imp() ? 1609.344 : 1000)); }
      else if (dist) dist.value = num(m / (imp() ? 1609.344 : 1000));
      const reach = Math.max(trip.map.width || 0, trip.map.height || 0) * 0.03 + 10;   // a pin this close to an end is where it starts or stops
      const at = pt => { const p = MapGeo.nearestPin(trip.pins, pt, reach); return p ? MapGeo.pinName(p) : ''; };
      fromName.value = at(trip.points[0]); toName.value = at(trip.points[trip.points.length - 1]);
      // a route with slow legs: the terrain is their average by length, so the time is each leg's own added up
      const tsel = fieldsWrap.querySelector('[name=terrain]');
      if (tsel && trip.terrain) {
        let sum = 0, weighted = 0;
        trip.terrain.forEach((t, i) => { const len = MapGeo.pathPx([trip.points[i], trip.points[i + 1]]); sum += len; weighted += len * t; });
        const avg = sum > 0 ? Math.round(weighted / sum * 100) / 100 : 1;
        if (![...tsel.options].some(o => Number(o.value) === avg)) tsel.append(el('option', { value: String(avg) }, `Mixed ×${avg} (from the route's legs)`));
        tsel.value = String(avg);
      }
      tripNote.replaceChildren(`Planning the trip along ${trip.name || 'a measured path'} on ${trip.map.name}. `,
        btn('Reverse', () => { trip.points.reverse(); if (trip.terrain) trip.terrain.reverse(); fillTrip(); out.replaceChildren(); }, 'small', 'Travel the other way: From and To swap, and Depart moves the marker to the other end'));
    };
    const f = el('form', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, 'Travel planner'), units),
      field('Mode', modeSel, `Modes for a ${E.GENRES[genre]} campaign. Change the genre on the Settings tab.`, `Overland, sea and air: distance ÷ speed, travelling some of the day's ${hourMode() ? 'hours' : spd() === 2 ? 'two shifts' : 'four shifts'}. Orbital transfer: the slow, fuel-saving path between two orbits. Constant thrust: accelerate to the midpoint, flip, decelerate. Relativistic: the same, with ship time slowing near light speed. FTL: your setting's jump drive. Hyperspace: a Star Wars trip time, scaled by the hyperdrive's class and the route.`),
      fieldsWrap,
      el('div', { class: 'row' }, el('button', { class: 'primary', 'data-tip': 'Work out the travel time. Nothing changes until you depart' }, 'Calculate')), out);

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
      // with more than one group, who is travelling; the main group is first
      const who = groups.length > 1 ? select(groups.map(g => [g.id, g.name]), groups[0].id, { 'aria-label': 'Who is travelling' }) : null;
      const travelling = () => who ? groups.find(g => g.id === Number(who.value)) : groups.find(g => g.is_main) || null;
      const toList = el('datalist', { id: 'travel-to-list' });
      toName.setAttribute('list', 'travel-to-list');
      const pinsOf = async mapId => {
        if (!pinCache.has(mapId)) pinCache.set(mapId, (await api('map', { query: { cid: S.camp.id, id: mapId } })).pins || []);
        return pinCache.get(mapId);
      };
      // the To box suggests the pins of the travelling group's map: their labels and their entries' names
      const suggest = async () => {
        const g = travelling();
        const pins = g && g.map_id ? await pinsOf(g.map_id).catch(() => []) : [];
        const names = [...new Set(pins.flatMap(p => [p.label, p.entry && p.entry.name]).filter(Boolean))];
        toList.replaceChildren(...names.map(n => el('option', { value: n })));
      };
      const travelField = field('Region while travelling', travelReg.node, 'e.g. "Ship interior" so transit days get shipboard conditions');
      const sideTrip = () => { const g = travelling(); return !!g && !g.is_main; };
      who?.addEventListener('change', () => { suggest(); travelField.style.display = sideTrip() ? 'none' : ''; });
      suggest();
      const upd = () => {
        const n = shiftsFor();
        info.textContent = `${n} ${word()}s (${(n / spd()).toFixed(1)} days). Arrive: ${E.fmtShift(cal(), nowShift() + n)}`;
      };
      useWorld.addEventListener('change', upd); upd();
      const go = btn('Depart — pass this much time', null, 'primary', `Pass the travel time, label each passed ${word()} with the trip, and log it as an event`);
      go.addEventListener('click', busy(go, async () => {
        const n = shiftsFor();
        if (n <= 0) throw new Error(`Trip is shorter than one ${word()}`);
        const g = travelling(), side = sideTrip();
        const label = `In transit${side ? ` (${g.name})` : ''}${fromName.value || toName.value ? `: ${fromName.value || '?'} → ${toName.value || '?'}` : ''}`;
        const startDay = today(), startShift = nowShift();
        const travelId = side ? '' : await travelReg.resolve(), arriveId = await arriveReg.resolve();
        // a side group's trip only moves the clock: the shifts are the main party's, and so is the weather's region
        await passShifts(n, side ? null : label, travelId || null, side ? null : arriveId || null);
        if (side && arriveId) {
          try { await post('group_save', { id: g.id, region_id: Number(arriveId) }, S.camp.id); }
          catch (err) { toast(`${g.name}'s region did not change: ${err.message}`, true); }
        }
        if (g && trip) {   // a planned trip ends where its route does
          const end = trip.points[trip.points.length - 1];
          // its trail gets a stop for each shift on the way (each day's start, on a long trip), along the route
          const step = n > 48 ? spd() : 1, stops = [];
          for (let k = step; k < n && stops.length < 400; k += step) stops.push({ ...pointAlong(trip.points, k / n), abs_shift: startShift + k });
          try { await post('group_move', { id: g.id, map_id: trip.map.id, x: end.x, y: end.y, stops }, S.camp.id); }
          catch (err) { toast(`The marker did not move: ${err.message}`, true); }
        } else if (g && g.map_id && toName.value.trim()) {
          try {
            const pin = MapGeo.pinFor(await pinsOf(g.map_id), toName.value);
            if (pin) await post('group_move', { id: g.id, map_id: g.map_id, x: pin.x, y: pin.y }, S.camp.id);
          } catch (err) { toast(`The marker did not move: ${err.message}`, true); }
        }
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
        el('div', { class: 'grid2' }, who ? field('Who is travelling', who, 'The clock moves for everyone') : null, field('From', fromName), field('To', toName),
          travelField,
          field('Region on arrival', arriveReg.node, null, 'The party is moved here when the trip ends'),
          result.worldHours ? field('Advance by outside-world time instead', useWorld, null, 'Near light speed, less time passes on board than back home. Tick this to move the clock by the longer, outside time') : null),
        toList, info, el('div', { class: 'row' }, go),
        el('small', { class: 'muted' }, `Labels every passed ${word()} with the trip (without overwriting existing activity), logs a multi-day travel event, and adds From to the first day's Locations visited and To to the last day's.`));
    };
    if (trip) { f.firstChild.after(tripNote); fillTrip(); }
    mount(...campaignHeader('travel'), partyCard, f);
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
          moreMenu(r.name, btn('Delete…', async () => {
            if (!await confirmDialog(`Delete region ${r.name}? Days recorded there keep their weather.`)) return;
            await post('region_delete', { id: r.id }, S.camp.id); await loadCampaign(S.camp.id, true); route();
          }, 'small danger', 'Delete this region. Days already recorded there keep their weather'))) : null)));
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
          moreMenu(x.name, btn('Delete…', async () => { if (!await confirmDialog(`Delete ${x.name}?`)) return; await post('holiday_delete', { id: x.id }, S.camp.id); await loadCampaign(S.camp.id, true); route(); }, 'small danger', 'Remove this holiday from the calendar'))) : null))
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
        lockField(el('input', { type: 'checkbox', name: 'is_secret', checked: !!x.is_secret }), 'players won\'t see this holiday on the calendar')),
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
      isGM() ? btn('+ New downtime', () => downtimeDialog(), 'primary small', 'Start a long rest, a short rest or some days of downtime') : null),
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
      el('div', { class: 'row' }, customIn, btn('+ Add', addCustom, 'small primary', 'Add your own activity to this card')),
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
        btn('+ New holding', () => holdingDialog(), 'primary small', 'Add a vehicle, animal, building, asset or a type of your own')),
        holdings.length ? null : el('p', { class: 'muted' }, 'No holdings yet. Press + New holding to add one.')),
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
      const row = el('div', { class: 'ledger-row', 'data-undo': `funds_delete:${f.id}` }, cur, loc, amt,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${f.currency}`, 'data-tip': 'Remove this line', onclick: () =>
          undoDelete(row, `Removed "${shortText(cur.value)}" from Party Funds`, 'funds_delete', { id: f.id }, () => row.remove()) }, '✕'));
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
      const row = el('div', { class: 'gear-row', 'data-undo': `gear_delete:${g.id}` }, item, claimed, loc, amount.node,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${g.item || 'this item'}`, 'data-tip': 'Remove this item', onclick: () =>
          undoDelete(row, `Removed "${shortText(item.value || 'the item')}" from Gear and Loot`, 'gear_delete', { id: g.id }, () => row.remove()) }, '✕'));
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
        moreMenu(h.name, btn('Delete…', async () => {
          if (!await confirmDialog(`Delete "${h.name}"?`, { ok: 'Delete', danger: true })) return;
          try { await post('holding_delete', { id: h.id }, S.camp.id); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'Delete this holding'))));
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
    const weights = () => [...lines.querySelectorAll('.ledger-row:not([hidden]) input.ledger-w')].map(i => Number(i.value) || 0);
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
      const row = el('div', { class: 'ledger-row', 'data-undo': `storage_delete:${s.id}` }, item, weight,
        el('button', { type: 'button', class: 'link danger', 'aria-label': `Remove ${s.item} from storage`, 'data-tip': 'Remove from storage', onclick: () => {
          undoDelete(row, `Removed "${shortText(item.value)}" from ${h.name}'s storage`, 'storage_delete', { id: s.id }, () => row.remove(), sum);
        } }, '✕'));
      return row;
    };
    lines.append(...(h.storage || []).map(line));
    const nItem = el('input', { maxlength: 200, placeholder: 'New item', 'aria-label': `New item in ${h.name}'s storage` });
    const nWeight = wInput('');
    nWeight.setAttribute('aria-label', `Weight of the new item in ${h.name}'s storage`);
    const add = btn('+ Add', null, 'small primary', 'Put this item in storage');
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

  // ------------------------------------------------------------ generators tab: static/generators-tab.js
  let viewGenerators;
  let viewClocks, tableClocks, panelClocks;
  let reports = null;   // ChronicleReport.make() below: the ! button and Site Admin's Reports tab

  // ------------------------------------------------------------ members tab
  async function viewMembers() {
    // The Characters tab's sheets, to match each member's character up with one
    let sheets = [];
    try { sheets = (await api('characters', { query: { cid: S.camp.id } })).characters; } catch { /* the list still works without them */ }
    const sheetOf = m => sheets.find(c => c.id === Number(m.active_character_id));
    /** The sheets member m could be linked to: their own and, for a GM, any no other player plays; one named as their
     * character first. */
    const linkable = m => {
      const players = new Set(S.members.filter(x => x.role === 'player').map(x => Number(x.id)));
      const name = (m.character_name || '').trim().toLowerCase();
      return sheets.filter(c => !c.secret && (c.owner?.id === Number(m.id) || (isGM() && !(c.owner && players.has(c.owner.id)))))
        .sort((a, b) => (b.name.toLowerCase() === name) - (a.name.toLowerCase() === name) || a.name.localeCompare(b.name));
    };
    /** The Person entries (or entries with no Category) with no sheet yet, which a GM can link a member to: a sheet is
     * made for the one picked. The one named as their character comes first. */
    const sheetEntries = new Set(sheets.map(c => c.entry_id));
    const linkableEntries = m => {
      if (!isGM()) return [];
      const name = (m.character_name || '').trim().toLowerCase();
      return S.encyclopedia.filter(e => !sheetEntries.has(e.id) && (!e.category || e.category === 'person') && (e.category === 'person' || e.name.toLowerCase() === name))
        .sort((a, b) => (b.name.toLowerCase() === name) - (a.name.toLowerCase() === name) || a.name.localeCompare(b.name));
    };
    const linkSheet = async m => {
      const options = linkable(m), entries = linkableEntries(m);
      const name = (m.character_name || '').trim().toLowerCase();
      // a sheet named as their character first, then an entry named so, then the rest of the sheets, then the entries
      const named = entries.length && entries[0].name.toLowerCase() === name && !(options[0]?.name.toLowerCase() === name);
      const sheetOpts = options.map(c => [`c${c.id}`, `${c.name} (${c.kind === 'npc' ? 'NPC' : 'PC'} sheet${c.owner ? `, ${c.owner.name}` : ', no player'})`]);
      const entryOpts = entries.map(e => [`e${e.id}`, `${e.name} (Encyclopedia entry, no sheet yet)`]);
      const all = named ? [entryOpts[0], ...sheetOpts, ...entryOpts.slice(1)] : [...sheetOpts, ...entryOpts];
      const pick = select(all, all[0]?.[0] ?? '', { 'aria-label': 'Character' });
      let tpl = null;
      const tplLoad = Sheets.templatePick().then(t => (tpl = t)).catch(() => null);   // one picker, however often the choice changes
      const tplRow = el('div');
      const fit = async () => {
        if (!pick.value.startsWith('e')) { tplRow.replaceChildren(); return; }
        await tplLoad;
        if (tpl && pick.value.startsWith('e') && !tplRow.firstChild) tplRow.replaceChildren(field('Template for its sheet', tpl));
      };
      pick.addEventListener('change', fit);
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'Link a character' });
      const form = el('form', { method: 'dialog' }, el('h3', {}, `${m.display_name}'s character`),
        el('p', { class: 'small muted' }, `The character becomes ${m.display_name}'s, and its name is the one the app shows for them. For an Encyclopedia entry with no sheet, pick a template to give it one now, or None to add one later.`),
        field('Character', pick), tplRow,
        el('div', { class: 'kit-dialog-actions' }, el('button', { value: 'ok', class: 'primary' }, 'Link'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel')));
      d.addEventListener('close', async () => {
        d.remove();
        if (d.returnValue !== 'ok' || !pick.value) return;
        const id = Number(pick.value.slice(1));
        try {
          if (pick.value.startsWith('c')) await post('member_link_character', { user_id: m.id, character_id: id }, S.camp.id);
          else await Sheets.linkToMember({ entryId: id, name: S.encyclopedia.find(e => e.id === id)?.name || '', templateId: tpl?.value ? Number(tpl.value) : null, uid: Number(m.id) });
          await loadCampaign(S.camp.id, true); route();
        } catch (err) { toast(err.message, true); }
      });
      d.append(form); document.body.append(d); d.showModal();
      await fit();
    };
    const card = el('div', { class: 'card' }, el('h2', {}, 'Members'),
      S.members.map(m => {
        const self = Number(m.id) === S.user.id;
        const sheet = sheetOf(m);
        const canLink = (self || isGM()) && !sheet && typeof Sheets !== 'undefined';
        return el('div', { class: 'listrow member' },
          el('div', { class: 'who' }, m.token_url && typeof TokensTab !== 'undefined' ? TokensTab.face(el, m.token_url, m.character_name || m.display_name) : null, el('strong', {}, m.display_name || m.email), m.pronouns ? el('span', { class: 'pronouns muted' }, ` (${m.pronouns})`) : null, m.email ? el('span', { class: 'muted' }, ` (${m.email})`) : null,
            el('span', { class: `role ${m.role}`, 'data-tip': m.role === 'gm' ? 'Can pass time, edit everything and see secrets' : 'Sees the calendar, adds notes, and adds events if allowed' }, m.role === 'gm' ? 'GM' : 'Player')),
          // The character sits centred between the player and the buttons, larger than the rest of the row.
          el('div', { class: 'member-char' }, el('span', { class: 'lbl' }, 'Character'),
            sheet ? el('a', { class: 'charname', href: `#/c/${S.camp.id}/characters/${sheet.id}`, 'data-tip': 'Open their character sheet' }, sheet.name)
              : m.character_name ? el('span', { class: 'charname' }, m.character_name) : el('span', { class: 'muted' }, 'none yet'),
            canLink && m.character_name ? el('span', { class: 'small muted' }, 'No sheet yet') : null),
          el('div', { class: 'actions' },
            (self || isGM()) ? btn(m.character_name ? 'Rename character' : 'Set character', async () => {
              const name = await promptDialog(self ? 'Your character\'s name in this campaign:' : `${m.display_name}'s character name:`,
                { value: m.character_name || '', placeholder: 'Leave empty to use their own name', ok: 'Save' });
              if (name === null) return;
              try { await post('member_character', { user_id: m.id, character_name: name }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
            }, 'small', 'Events and notes they add are signed with this name instead of their own') : null,
            canLink && (linkable(m).length || linkableEntries(m).length) ? btn('Link a character…', () => linkSheet(m).catch(err => toast(err.message, true)), 'small', 'Match them up with a character: a sheet on the Characters tab, or a Person in the Encyclopedia') : null,
            canLink ? btn('Make a sheet', () => Sheets.newCharacter({ name: m.character_name || '', owner_id: m.id }).catch(err => toast(err.message, true)),
              'small', 'Give this character a sheet on the Characters tab, with this name') : null,
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
        try {
          const r = await post('member_add', { ...body, role: role.value }, S.camp.id);
          if (r.invited) toast(`Invitation recorded. ${body.email} joins the next time they sign in with an approved account`);
          await loadCampaign(S.camp.id, true); route();
        } catch (err) { toast(err.message, true); }
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
          // With nobody to pick from, the note under the form already says to add people by email: no empty-list message
          : candidates.length ? [el('p', { class: 'muted' }, 'Nobody registered matches. Type their full sign-in email and press Add by email.')] : [],
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
      // Invitations by email not taken up yet: they become members when that person, approved, next signs in.
      if (S.invites.length) card.append(el('h3', {}, 'Invited'), ...S.invites.map(i => el('div', { class: 'listrow member invite' },
        el('div', { class: 'who' }, el('strong', {}, i.email), el('span', { class: `role ${i.role}` }, i.role === 'gm' ? 'GM' : 'Player'),
          el('span', { class: 'muted small' }, ' joins when they next sign in')),
        el('div', { class: 'actions' }, btn('Cancel invitation', async () => {
          try { await post('member_remove', { email: i.email }, S.camp.id); await loadCampaign(S.camp.id, true); route(); } catch (err) { toast(err.message, true); }
        }, 'small danger', 'They won\'t join this campaign when they sign in')))));
      card.append(el('h3', {}, 'Add a member'), f, list, el('small', { class: 'muted' }, S.user?.is_admin ? 'Everyone who has signed in and been approved by the site admin is listed. Anyone else, type their sign-in email: they join when they next sign in, once approved.'
        : 'People you play with in your other campaigns are listed by name. To add anyone else, type their full sign-in email: they join the campaign the next time they sign in with an approved account.'));
      api('member_candidates', { query: { cid: S.camp.id } }).then(r => { candidates = r.users; renderList(); }).catch(err => toast(err.message, true));
    }
    mount(...campaignHeader('members'), card);
  }

  // ------------------------------------------------------------ season editor: static/settings-tab.js
  let SEASON_LABELS, seasonChip, seasonEditor, viewSettings;

  // ------------------------------------------------------------ about: where the built-in figures come from
  const extLink = (src, text) => el('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, text || src.title);
  /** "Title — publisher (licence)" for one SOURCES entry. */
  const cite = key => {
    const src = E.SOURCES[key];
    return src ? el('span', {}, extLink(src), el('span', { class: 'muted' }, ` · ${src.by} (${src.licence})`)) : null;
  };
  const aboutTable = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl about-tbl' },
    el('tr', {}, head.map(h => el('th', {}, h))), rows.map(r => el('tr', {}, r.map(c => el('td', {}, c))))));
  /** The starter templates' section: each game and the sheet it was built from, filled in once the list comes. */
  function starterAbout(section) {
    const body = el('div', {}, el('p', { class: 'muted small' }, 'Loading…'));
    fetch('api/index.php?a=starter_sources', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(r => r.json()).then(({ starters }) => {
      if (!starters?.length) return body.closest('section')?.remove();
      body.replaceChildren(
        el('p', {}, 'Each starter template in the sheet template library is this app\'s own list of field labels and sections, made from the character sheet named beside its game. No artwork, logos or rules text are copied. ',
          'Not affiliated with or endorsed by the publishers.'),
        aboutTable(['Game', 'Built from'], starters.map(st => [[st.game, st.edition ? ` (${st.edition})` : ''].join(''),
          el('span', {}, st.source.url ? extLink({ url: st.source.url, title: st.source.title || st.source.url }) : st.source.title,
            el('span', { class: 'muted' }, ` · ${st.source.owner}${st.source.licence ? ` (${st.source.licence})` : ''}`))])));
    }).catch(() => body.closest('section')?.remove());
    return section('Starter templates', body);
  }
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
          'how fast it melts and dries, and where the ground turns soft, muddy or frozen). These are the app\'s own choices, and a GM can change them for one campaign under Settings → Weather tuning.')),
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
          ['The map viewer on the Maps tab: ', cite('leaflet'), '.'],
          ['Scan for names on a map, Read here (in your browser; the picture is never sent anywhere): ', cite('tesseract'), ', reading with ', cite('tessdata'), '.'],
          ['Scan for names on a map, Read with Claude: only when a GM picks it, their browser sends the map\'s picture to ', extLink({ url: 'https://www.anthropic.com/', title: 'Anthropic' }),
            '\'s API with the GM\'s own API key, and Claude (', (typeof MapScan !== 'undefined' ? MapScan.MODEL : 'claude-opus-5-5'), ') reads the place names on it. Under ',
            extLink({ url: 'https://www.anthropic.com/legal/commercial-terms', title: 'Anthropic\'s commercial terms' }), ' the names it returns belong to the GM. The GM approves each one before it is pinned.'],
          ['Reading a PDF to draft a character sheet template (in your browser; the PDF is never uploaded): ', cite('pdfjs'), '.'],
          ['The 3D dice on the die roller: ', cite('three'), '. The dice shapes, the numbers on them and the dice patterns (marble, wood, stone and the rest) are drawn in your browser by this app; no picture files are used.'],
          ['The screenshot the Report (!) button offers, taken in your browser and sent only with the report, to the site admins: ', cite('htmlToImage'), '.'],
          'Send to GitHub on Site Admin\'s Reports tab opens an issue on the app\'s GitHub repository, only when a site admin presses it. The issue carries the report\'s text and page details, never who sent it or the screenshot.',
          ['Typefaces, self-hosted: ', cite('inter'), ' and ', cite('barlow'), '.'],
          'The Feature Highlighter\'s list of common English words, and every other word list in the app, was written for it.',
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
      starterAbout(section),
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
          ['Import on a character\'s sheet reads a character the player made elsewhere, only when asked: a ', extLink({ url: 'https://pathbuilder2e.com/', title: 'Pathbuilder 2e' }),
            ' export, or a public character on ', extLink({ url: 'https://www.dndbeyond.com/', title: 'D&D Beyond' }),
            ' through its character service. Neither is openly licensed; only that player\'s own character is read, and its values are copied onto the sheet.'],
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
      api('encyclopedia', { query: { cid } }), api('events', { query: { cid } })]);
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

  // ------------------------------------------------------------ At the Table
  // The campaign as it is played: the date and where the party is up top, then a big box for the shift the clock is on
  // (what the party does, everyone's notes, the GM notes, its events and reminders, End shift), with the shift before and
  // the one after beside it to look at. Today's boxes (its weather, every shift, events, reminders) fold away underneath.
  // The same view is the panel (panel.html, PANEL below), signed in with a panel link where Chronicle's own sign-in can't
  // reach; there it keeps to the header, the shift's activity and notes, and the lookup. The links are made at its foot.
  const ENTRY_NOTE_TIP = 'Added to the end of the entry\'s Public notes, which everyone in the campaign can read';
  let tableEntries = null;   // the Encyclopedia's entries with their notes, loaded the first time one is looked up
  let tablePeek = null;      // the shift (absolute) looked at from a side panel; null: the one the clock is on
  let tableDayEdit = false;  // At the Table's ✎ Day editor is open (kept as the page redraws)
  /** Whether event e is on shift i of day d: an all-day event on any shift of its days, else from its start shift on its
   * first day to its end shift on its last. */
  function eventCovers(e, d, i) {
    const a = Number(e.abs_day), b = Number(e.end_day ?? e.abs_day);
    if (d < a || d > b) return false;
    if (e.shift === null || e.shift === undefined) return true;
    const lo = d === a ? Number(e.shift) : 0, hi = d === b ? Number(e.shift_end ?? e.shift) : spd() - 1;
    return i >= lo && i <= hi;
  }
  async function viewTable() {
    const cid = S.camp.id, c = cal(), n = spd(), names = shiftNames(), now = nowShift(), d0 = today();
    // a look elsewhere ends once the clock gets there; a player can look back but not ahead
    if (PANEL || tablePeek === now || (tablePeek !== null && !isGM() && tablePeek > now)) tablePeek = null;
    const at = tablePeek ?? now, d = Math.floor(at / n);
    tableEntries = null;
    // the day looked at and those either side (for the side panels), and today (for the boxes underneath)
    const want = PANEL ? [d] : [...new Set([d - 1, d, d + 1, d0])];
    const [loaded, groups] = await Promise.all([
      Promise.all(want.map(x => loadDay(x, x === d || x === d0).catch(() => null))),
      api('groups', { query: { cid } }).then(r => r.groups).catch(() => [])]);
    if (S.camp?.id !== cid) return;
    const days = new Map(want.map((x, k) => [x, loaded[k]]));
    const slot = abs => {
      const x = days.get(Math.floor(abs / n)), i = E.mod(abs, n);
      return x ? { abs, d: x.d, i, x, s: x.shifts[i] || {}, sw: x.sws[i] || null, hidden: !!x.w?.partial && !x.sws[i],
        notes: (x.r.shift_notes || []).filter(m => Number(m.shift) === i), ground: x.grounds[i] || null } : null;
    };
    const cur = slot(at), region = cur?.x.region || currentRegion();
    const card = (title, ...kids) => el('div', { class: 'tv-card' }, el('b', {}, title), ...kids);
    const chronicleHref = h => (PANEL ? `index.html${h}` : h);
    const outLink = (href, label, tipText) => el('a', { href: chronicleHref(href), target: PANEL ? '_blank' : null, rel: PANEL ? 'noopener' : null, 'data-tip': tipText }, label);

    // where the party is: the main group (else the first), its region and the pin nearest its marker on its map
    const mainGroup = groups.find(x => x.is_main) || groups[0];
    let partyMap = null, partyData = null;
    // its parts: the region, the pin it's near, a link to its map, a small picture of the map around it, the other groups
    const party = await (async () => {
      // the region is the day's (the one its weather and light come from); the main group's own is added only when it differs
      const g = mainGroup, gReg = g && regionById(g.region_id), out = { region: (region || gReg)?.name || null, groupRegion: gReg && region && gReg.id !== region.id ? gReg.name : null, near: null, link: null, mini: null,
        groups: groups.length > 1 ? `${groups.length} groups: ${groups.map(x => x.name).join(', ')}` : null };
      if (g?.map_id) {
        try {
          const m = await api('map', { query: { cid, id: g.map_id } });
          const W = Number(m.map.width) || 0, H = Number(m.map.height) || 0, reach = Math.max(W, H) * 0.03 + 10;
          const pin = MapGeo.nearestPin(m.pins, { x: g.x, y: g.y }, reach);
          partyMap = m.map; partyData = m;
          out.near = pin ? `Near ${MapGeo.pinName(pin)}` : 'On the map';
          out.link = outLink(`#/c/${cid}/maps/${g.map_id}`, m.map.name, 'Open the map');
          // a small picture of the map around the party, wider than tall, with the pins near it
          const span = Math.max(W, H) * 0.3, w = Math.min(span, W), h = Math.min(span * 0.62, H);
          const win = { x: Math.max(0, Math.min(W - w, g.x - w / 2)), y: Math.max(0, Math.min(H - h, g.y - h / 2)), w, h };
          if (!PANEL) out.mini = miniMap(m.map, win, { pins: m.pins, flag: g, href: `#/c/${cid}/maps/${g.map_id}`, tipText: `Open ${m.map.name}` });
        } catch { /* a map this member can't open: the region is enough */ }
      }
      return out;
    })();

    const view = el('div', { class: 'table-view' + (PANEL ? ' in-panel' : ' tv-wide') });
    const nsh = E.mod(now, n);
    const head = el('div', { class: 'tv-head' },
      el('div', { class: 'tv-camp' }, S.camp.name),
      el('div', { class: 'tv-date' }, E.fmtDate(c, d0)),
      el('div', { class: 'tv-shift' }, hourMode() ? `${names[nsh]}` : `${names[nsh]} · ${n === 2 ? (nsh ? 'night' : 'day') : `${['1st', '2nd', '3rd', '4th'][nsh]} shift of 4`}`),
      E.holidaysOn(c, S.holidays, d0).map(holidayChip));
    const moons = E.moons(c, d, region);
    const moonCard = card('Moons', moons.length ? el('div', { class: 'tv-moons' }, moons.map(m => el('div', {}, moonGlyph(m), ` ${m.name}: ${m.label}`))) : el('div', { class: 'muted' }, 'None'));
    const partyCard = el('div', { class: 'tv-card tv-party' }, el('b', {}, 'Party'), ...(party.region || party.near ? clean([
      party.region ? el('div', { class: 'big' }, party.region) : null, party.near ? el('div', {}, '📍 ', party.near) : null,
      party.link ? el('div', { class: 'small' }, party.link) : null, party.groups ? el('div', { class: 'small muted' }, party.groups) : null]) : [el('div', { class: 'muted' }, 'Not set')]));

    // the big box: the shift as its card on the day page shows it, made large, its editor open
    const big = cur ? shiftCard(cur.d, cur.i, cur.s, cur.x.region, cur.sw, cur.hidden, cur.notes, cur.ground, { big: true, readOnly: PANEL, after: PANEL ? () => viewTable() : route, sessions: cur.x.r.sessions, actions: cur.x.r.shift_actions || [], party: cur.x.r.party_characters || [] })
      : el('div', { class: 'card shiftcard' }, el('p', { class: 'muted' }, `This ${word()} couldn't be loaded.`));
    big.classList.add('tv-now');
    // on a wide screen the big box is two columns: the writing, and beside it everyone's notes and the events
    const twoCols = () => {
      if (PANEL) return;
      const main = el('div', { class: 'tv-now-main' }), aside = el('div', { class: 'tv-now-aside' });
      for (const n of [...big.children]) {
        if (n.matches('.shift-edit, .shift-status, p.pre')) main.append(n);
        else if (n.matches('.shift-actions, .shiftnotes')) aside.append(n);
      }
      big.append(el('div', { class: 'tv-now-cols' }, main, aside));
    };

    if (PANEL) {
      // the panel: the header, the clock's shift as a player reads it, what's on today and the lookup
      const sw = cur?.sw || null, v = E.visibility(c, region, sw, d0, nsh, cur?.s.visibility_override);
      const from = d0 * n, to = from + n;
      const todays = [
        ...(cur?.x.r.events || []).map(e => el('li', {}, '📅 ', Number(e.is_secret) ? secretTag() : null, ' ', outLink(`#/c/${cid}/day/${d0}`, e.title, shiftRange(e)))),
        ...(S.reminders || []).filter(x => x.due_shift >= from && x.due_shift < to)
          .map(x => el('li', { class: x.due ? '' : 'muted' }, '⏰ ', x.title, el('span', { class: 'small muted' }, ` · ${E.fmtShift(c, x.due_shift).split(',')[0]}`))),
      ];
      view.append(head,
        el('div', { class: 'tv-grid' },
          card('Weather', el('div', { class: 'big' }, weatherText(sw, cur?.x.w?.partial ? `Weather this ${names[nsh]}` : `Weather this ${names[nsh]}. Day's forecast: ${E.weatherLabel(cur?.x.w, tempUnit())}`))),
          card('Light', el('div', { class: 'big' }, visPill(v))), moonCard, partyCard),
        big,
        el('section', { class: 'tv-sec' }, el('b', {}, 'Today'), todays.length ? el('ul', { class: 'tv-today' }, todays) : el('p', { class: 'muted small' }, 'Nothing on today')),
        (await panelClocks()) || '', tableLookup(view), tableNote(), panelFooter());
      return mount(view);
    }

    // looking at another shift: say so, with the way back
    if (at !== now) {
      big.prepend(el('div', { class: 'tv-peek row' }, el('span', {}, `Looking at ${E.fmtShift(c, at)}. The clock is on ${names[nsh]}.`),
        btn('Back to now', () => { tablePeek = null; viewTable(); }, 'small primary', `Back to the ${word()} the campaign clock is on`)));
    }
    // (its events are in the Events box under it, and + Event and + Reminder are on the floating bar)
    twoCols();

    // the block over the big box, one card: the date and shift, its weather, where the party is, the moons, a badge for
    // the reminders, a small map, and the day's shifts with their weather along the foot
    const ai = E.mod(at, n);
    const remList = [...new Map([...(S.reminders || []).filter(x => x.due && !x.dismissed), ...(S.reminders || []).filter(x => x.due_shift === at)]
      .sort((a, b) => a.due_shift - b.due_shift).map(x => [x.id, x])).values()];
    const remBadge = remList.length ? el('details', { class: 'tv-rem' },
      el('summary', { class: 'chip tv-rem-chip' + (remList.some(x => x.due && !x.dismissed) ? ' due' : ''), 'data-tip': `Reminders on this ${word()}, and any the clock has reached that you haven't dismissed. Click to read them` },
        `🔔 ${remList.length} reminder${remList.length === 1 ? '' : 's'}`),
      el('div', { class: 'tv-rem-pop surface-float' }, remList.map(x => reminderView(x, Math.floor(x.due_shift / n))))) : null;
    // the wind has its own place on the line under it, so it isn't said twice
    const wx = cur?.sw ? weatherText(E.openAir(region) ? { ...cur.sw, wind: 0 } : cur.sw, `Weather this ${names[ai]}, worked out from the day's forecast`)
      : el('span', { class: 'muted', 'data-tip': `Players see each ${word()}'s weather once the campaign clock reaches it` }, 'Weather not known yet');
    const ground = cur?.ground ? groundText(cur.ground, cur.d) : null;
    // the season, the sun and the moons on one quiet line
    const hemi = region?.settings?.hemisphere, sea = E.season(c, d, hemi), sun = E.sunTimes(c, d, hemi);
    const wind = cur?.sw && E.openAir(region) ? windText(cur.sw) : null;
    const skyLine = el('span', { class: 'tv-fact tv-sky' }, clean([
      ground ? el('span', { class: 'tv-cond' }, ground) : null,
      wind ? el('span', { class: 'tv-cond' }, wind) : null,
      sea.name ? el('span', { 'data-tip': 'The season, from the calendar\'s season dates (flipped for the other hemisphere)' }, sea.name) : null,
      sun ? el('span', { class: 'sun', 'data-tip': `${fmtDaylight(sun.daylight)} of daylight` }, `☀ ${E.fmtClock(sun.sunrise)}–${E.fmtClock(sun.sunset)}`) : null,
      ...moons.map(m => el('span', { 'data-tip': `${m.name}: ${m.label} (${Math.round(m.illum * 100)}%)` }, moonGlyph(m), ` ${m.name} ${m.label}`))]).flatMap((x, k) => k ? [' · ', x] : [x]));
    const locs = (cur?.x.row?.locations || '').trim();
    // the GM's day editor (region, weather, Locations visited), which the day page's Weather box holds, opens under the block
    // (it stays open as the page redraws after a save or a re-roll, until ✎ Day closes it)
    const dayEdit = cur && isGM() && !S.viewAs ? el('div', { class: 'tv-dayedit', hidden: true }) : null;
    const showDayEdit = on => {
      if (on && !dayEdit.firstChild) dayEdit.append(dayEditor(cur.d, cur.x.row, cur.x.region, cur.x.w, cur.x.r, cur.i, cur.x.grounds));
      dayEdit.hidden = !on; tableDayEdit = on;
      dayEditBtn.setAttribute('aria-expanded', String(on));
    };
    const dayEditBtn = dayEdit ? btn('✎ Day', () => showDayEdit(dayEdit.hidden), 'small', `Change the day's region, set or re-roll its weather, set any of this ${word()}'s conditions by hand, and write its Locations visited`) : null;
    if (dayEdit) showDayEdit(tableDayEdit);
    const summary = el('section', { class: 'tv-summary', 'aria-label': `This ${word()}` },
      el('div', { class: 'tv-sum-main' },
        el('div', { class: 'tv-sum-top' },
          el('div', { class: 'tv-head' },
            el('div', { class: 'tv-date' }, E.fmtDate(c, d)),
            el('div', { class: 'tv-shift' }, hourMode() ? names[ai] : `${names[ai]} · ${n === 2 ? (ai ? 'night' : 'day') : `${['1st', '2nd', '3rd', '4th'][ai]} shift of 4`}`,
              ...E.holidaysOn(c, S.holidays, d).map(holidayChip))),
          el('div', { class: 'tv-sum-acts' }, forecastButton(d0, days.get(d0)?.region || currentRegion(), days.get(d0)?.w), remBadge, dayEditBtn)),
        el('div', { class: 'tv-facts' },
          el('span', { class: 'tv-fact tv-wx' }, wx),
          el('span', { class: 'tv-fact tv-party' }, '📍 ', clean([party.region ? el('b', { 'data-tip': region ? regionSummary(region) : null }, party.region) : null,
            party.groupRegion ? el('span', { class: 'muted', 'data-tip': 'The main party group\'s own region, which differs from the day\'s' }, `group in ${party.groupRegion}`) : null,
            party.near, party.link, party.groups ? el('span', { class: 'muted' }, party.groups) : null]).flatMap((x, k) => k ? [' · ', x] : [x]),
            party.region || party.near ? null : el('span', { class: 'muted' }, 'Party not placed')),
          skyLine,
          locs ? el('span', { class: 'tv-fact notes-locs' }, el('span', { class: 'lbl', 'data-tip': LOC_TIP }, 'Visited'), el('span', {}, linked(locs))) : null),
        cur ? dayStrip(cur.d, cur.x.sws) : null),
      party.mini ? el('div', { class: 'tv-sum-map tv-party' }, party.mini) : null,
      dayEdit);

    // the floating bar: End and Pass time for the GM on the clock's shift, and the Encyclopedia for everyone, in a pop-up over it
    const tools = [];
    if (isGM() && !S.viewAs && at === now) {
      const end = btn(`End ${names[nsh]} ▶ on to ${names[E.mod(now + 1, n)]}`, null, 'primary', `Move the campaign clock on one ${word()}, rolling the weather for a new day. Everyone's view catches up`);
      end.addEventListener('click', busy(end, async () => {
        await passShifts(1);
        toast(`Now: ${E.fmtShift(cal(), nowShift())}`);
        await offerSession();
        route();
      }));
      const more = btn('Pass time…', async () => { if (await passTimeDialog()) route(); }, '',
        'Pass more time at once: skip ahead by an amount or to a date with an activity for the time passed, or start a rest, downtime or a trip');
      tools.push(end, more, el('span', { class: 'tv-bar-gap', 'aria-hidden': 'true' }));
    }
    const pop = el('div', { class: 'tv-bar-pop surface-float', hidden: true });
    const lookup = tableLookup(view, () => openPop('note')), note = tableNote();
    // + Event and + Reminder open their forms over the bar, set to the shift looked at (made when opened, so a closed
    // bar holds no form)
    const canEvent = cur && (isGM() || settings().players_can_add_events) && !S.viewAs, canRem = cur && !S.viewAs;
    const formPane = (title, make) => {
      const pane = el('section', { class: 'tv-sec' });
      pane.fill = () => { if (!pane.firstChild) pane.append(el('b', {}, title), make()); };
      return pane;
    };
    const evPane = canEvent ? formPane(`New event on ${E.fmtShift(c, at)}`, () => eventForm(cur.d, { shift: cur.i, shift_end: cur.i },
      { pinAt: partyMap && mainGroup?.x !== null && mainGroup?.x !== undefined ? { map_id: partyMap.id, map_name: partyMap.name, x: mainGroup.x, y: mainGroup.y } : null })) : null;
    const remPane = canRem ? formPane('New reminder', () => reminderForm(cur.d)) : null;
    const panes = { look: lookup, note, event: evPane, rem: remPane };
    pop.append(...clean(Object.values(panes)));
    const toggle = which => () => openPop(pop.dataset.on === which ? null : which);
    const lookBtn = btn('🔍 Search', toggle('look'), '', 'Look a name up in the Encyclopedia');
    const noteBtn = btn('📝 Encyclopedia add', toggle('note'), '', 'Add a note to the end of an Encyclopedia entry');
    const evBtn = evPane ? btn('+ Event', toggle('event'), '', `Log something that happens on this ${word()}`) : null;
    const remBtn = remPane ? btn('+ Reminder', toggle('rem'), '', `Have something pop up when the campaign clock reaches a ${word()}`) : null;
    const popBtns = { look: lookBtn, note: noteBtn, event: evBtn, rem: remBtn };
    function openPop(which) {
      pop.hidden = !which; pop.dataset.on = which || '';
      for (const [k, pane] of Object.entries(panes)) if (pane) {
        pane.hidden = which !== k;
        if (pane.fill) { if (which === k) pane.fill(); else pane.replaceChildren(); }   // a form closed is gone
      }
      for (const [k, b] of Object.entries(popBtns)) b?.setAttribute('aria-pressed', String(which === k));
      if (which) panes[which]?.querySelector('input:not([type=checkbox])')?.focus();
    }
    openPop(null);
    pop.addEventListener('keydown', e => { if (e.key === 'Escape') { openPop(null); } });
    // it folds away to one button, like the map's toolbar, remembered on this device
    const bar = el('div', { class: 'tv-bar surface-float', role: 'toolbar', 'aria-label': 'At the Table tools' }, ...tools, ...clean([evBtn, remBtn]), lookBtn, noteBtn);
    const barKey = `chronicle-table-bar-${cid}`;
    let barFolded = (() => { try { return localStorage.getItem(barKey) === 'folded'; } catch { return false; } })();
    const barFold = btn('', () => {
      barFolded = !barFolded;
      try { localStorage.setItem(barKey, barFolded ? 'folded' : 'open'); } catch { /* this visit only */ }
      syncBarFold();
    }, 'small tv-bar-fold');
    const syncBarFold = () => {
      bar.classList.toggle('folded', barFolded);
      barFold.textContent = barFolded ? '🧰' : '⟩';
      barFold.setAttribute('aria-label', barFolded ? 'Show the bar' : 'Hide the bar');
      barFold.setAttribute('aria-expanded', String(!barFolded));
      if (barFolded) openPop(null);
    };
    bar.append(barFold);
    syncBarFold();
    const dock = el('div', { class: 'tv-dock' }, pop, bar);

    // the shift before (in hours mode the last hour with something written, back into yesterday) and the one after
    const written = y => !!(y && (y.s.activity || y.s.gm_notes || y.notes.length));
    let prevAbs = at - 1;
    if (hourMode()) for (let k = at - 1; k >= (d - 1) * n; k--) if (written(slot(k))) { prevAbs = k; break; }
    // where the main group's trail had it on a shift: the pin nearest its point then
    const wasNear = abs => {
      if (!partyData || !mainGroup) return null;
      const t = (partyData.trail || []).filter(q => q.group_id === mainGroup.id && q.abs_shift <= abs).pop();
      const reach = Math.max(Number(partyData.map.width) || 0, Number(partyData.map.height) || 0) * 0.03 + 10;
      const pin = t && MapGeo.nearestPin(partyData.pins || [], t, reach);
      return pin ? MapGeo.pinName(pin) : null;
    };
    const side = (abs, before) => {
      const y = slot(abs), i = E.mod(abs, n), dd = Math.floor(abs / n);
      const near = before ? wasNear(abs) : null;
      const ahead = abs > now, canLook = isGM() || !ahead;
      const act = (y?.s.activity || '').trim().split('\n')[0];
      const evN = y ? y.x.r.events.filter(e => eventCovers(e, dd, i)).length : 0, remN = (S.reminders || []).filter(x => x.due_shift === abs).length;
      const kids = [
        el('b', {}, before ? `◀ ${names[i]}` : `${names[i]} ▶`),
        el('span', { class: 'small muted' }, dd === d ? (before ? `The ${word()} before` : `The ${word()} after`) : E.fmtDate(c, dd, { noWeekday: true })),
        y?.sw ? el('span', { class: 'small' }, `${E.WEATHER[y.sw.type]?.icon || ''} ${E.weatherLabel(y.sw, tempUnit())}`) : el('span', { class: 'small muted' }, 'Weather not known yet'),
        act ? el('span', { class: 'small tv-side-act' }, act.length > 90 ? `${act.slice(0, 88)}…` : act) : null,
        near ? el('span', { class: 'small tv-side-near' }, `📍 Was near ${near}`) : null,
        evN ? el('span', { class: 'small' }, `📅 ${evN} event${evN === 1 ? '' : 's'}`) : null,
        remN ? el('span', { class: 'small' }, `🔔 ${remN} reminder${remN === 1 ? '' : 's'}`) : null,
        canLook ? el('span', { class: 'small muted tv-side-hint' }, abs === now ? 'Back to now' : before ? 'Look back, or fix its notes' : 'Look ahead') : null];
      const cls = `tv-side ${before ? 'prev' : 'next'}`;
      if (!canLook) return el('div', { class: cls }, ...clean(kids));
      return el('button', { type: 'button', class: cls, 'aria-label': `Look at ${names[i]}, ${E.fmtDate(c, dd, { noWeekday: true })}`,
        onclick: () => { tablePeek = abs === now ? null : abs; viewTable(); } }, ...clean(kids));
    };

    const today0 = days.get(d0);
    view.append(summary,
      el('div', { class: 'tv-stage' }, el('div', { class: 'tv-nav' }, side(prevAbs, true), side(at + 1, false)), big),
      (await tableClocks(dayBox)) || '',
      ...(today0 ? dayBoxes(today0, true) : []),
      await tableLinksBox(), dock);
    mount(...campaignHeader('table'), view);
  }
  async function loadTableEntries() {
    if (!tableEntries) tableEntries = (await api('encyclopedia', { query: { cid: S.camp.id } })).entries;
    return tableEntries;
  }
  /** Look an entry up by name or alias and read it here, with Add a note and a link into the Encyclopedia. */
  function tableLookup(view, onNote) {
    const input = el('input', { type: 'search', placeholder: 'Look up a name in the Encyclopedia', 'aria-label': 'Look up a name in the Encyclopedia', autocomplete: 'off' });
    const out = el('div', { class: 'tv-lookup' });
    const show = async () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return out.replaceChildren();
      const named = e => [e.name, ...(e.aliases || [])].map(n => n.toLowerCase());
      const hits = S.encyclopedia.filter(e => named(e).some(n => n.includes(q)))
        .sort((a, b) => Number(!named(b).some(n => n.startsWith(q))) - Number(!named(a).some(n => n.startsWith(q))) || a.name.localeCompare(b.name));
      if (!hits.length) return out.replaceChildren(el('p', { class: 'muted small' }, 'No entry by that name'));
      const entries = await loadTableEntries();
      const full = entries.find(e => e.id === hits[0].id) || hits[0];
      const cat = encCat(full.category);
      out.replaceChildren(el('div', { class: 'tv-entry' + (full.is_secret ? ' secret' : '') },
        el('h3', {}, full.is_secret ? secretTag() : null, ' ', full.name, cat ? el('span', { class: 'chip tag' }, `${cat[2]} ${cat[1]}`) : null),
        full.notes ? RichText.view(full.notes, 'html', 'tv-notes') : el('p', { class: 'muted small' }, 'Nothing written about it yet'),
        el('div', { class: 'row' },
          btn('📝 Add a note', () => { onNote?.(); const n = view.querySelector('.tv-note'); n?.setEntry(full); n?.scrollIntoView({ block: 'nearest' }); n?.querySelector('textarea')?.focus(); }, 'small'),
          el('a', { class: 'button small', href: (PANEL ? 'index.html' : '') + `#/c/${S.camp.id}/encyclopedia/${full.id}`, target: PANEL ? '_blank' : null, rel: PANEL ? 'noopener' : null }, PANEL ? 'Open in Chronicle ↗' : 'Open the entry')),
        hits.length > 1 ? el('p', { class: 'small muted' }, `Also: ${hits.slice(1, 6).map(e => e.name).join(', ')}`) : null));
    };
    let t = 0;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => show().catch(e => toast(e.message, true)), 200); });
    return el('section', { class: 'tv-sec' }, el('b', {}, 'Encyclopedia'), input, out);
  }
  /** A note at the end of an Encyclopedia entry's notes. (A note on the shift goes in the big box's Notes.) */
  function tableNote() {
    const entryIn = el('input', { list: 'tv-entry-names', placeholder: 'Entry name', 'aria-label': 'Entry', autocomplete: 'off' });
    const names = el('datalist', { id: 'tv-entry-names' }, S.encyclopedia.map(e => el('option', { value: e.name })));
    const text = el('textarea', { rows: 3, 'aria-label': 'Note', placeholder: 'What you found out' });
    const gmOnly = el('input', { type: 'checkbox' });
    const gmLabel = el('label', { class: 'small', 'data-tip': 'Goes in the entry\'s GM notes instead, which players never see' }, gmOnly, ' GM only');
    const save = btn('Save note', null, 'primary small');
    const box = el('section', { class: 'tv-sec tv-note' }, el('b', {}, 'Add a note to an Encyclopedia entry'), el('div', { class: 'tv-entry-pick' }, entryIn, names), text,
      el('div', { class: 'row spread' }, isGM() ? gmLabel : el('span'), save), el('p', { class: 'small muted' }, ENTRY_NOTE_TIP));
    box.setEntry = e => { entryIn.value = e.name; };
    save.addEventListener('click', busy(save, async () => {
      const body = text.value.trim();
      if (!body) return toast('Write the note first', true);
      const n = entryIn.value.trim().toLowerCase();
      const e = S.encyclopedia.find(x => x.name.toLowerCase() === n || (x.aliases || []).some(a => a.toLowerCase() === n));
      if (!e) return toast('Pick an entry from the list', true);
      await post('entry_note_add', { id: e.id, body, gm_only: isGM() && gmOnly.checked }, S.camp.id);
      tableEntries = null;
      toast(`Note added to ${e.name}`);
      text.value = '';
    }));
    return box;
  }

  // ------------------------------------------------------------ panel links
  /** Where panel.html lives, beside index.html. */
  const panelBase = () => new URL('panel.html', location.href.split('#')[0]).href;
  /** The box at the foot of At the Table: the panel links this member made (a GM: everyone's), and New panel link. */
  async function tableLinksBox() {
    const cid = S.camp.id;
    const r = await api('panel_links', { query: { cid } }).catch(() => ({ ready: false, links: [] }));
    const box = el('section', { class: 'card tv-links' }, el('h3', {}, 'Use in a VTT or on stream',
      tip('Show this page beside your virtual tabletop (an Owlbear Rodeo extension, a Foundry window), on a stream or a shared screen: make a panel link, then paste it there once. Or give a program (a Foundry module, a bot) an API key. Each sees what you see, and can be revoked here at any time')));
    const kindText = k => (k.scope === 'api' ? `API key, ${k.write ? 'read and write' : 'read-only'}` : k.scope === 'public_panel' ? `Public${k.overlay ? ', overlay' : ''}` : 'Personal');
    const list = el('div', {}, r.links.length ? r.links.map(k => el('div', { class: 'listrow tv-link' },
      el('div', {}, el('strong', {}, k.label), el('span', { class: 'small muted' }, ` · ${kindText(k)}${isGM() && k.maker ? ` · made by ${k.maker}` : ''} · ${k.last_used_at ? `last used ${k.last_used_at}` : 'not used yet'}`)),
      btn('Revoke', async () => {
        if (!await confirmDialog(`Revoke "${k.label}"? Anywhere it is pasted stops working at once.`, { ok: 'Revoke', danger: true })) return;
        try { await post('panel_link_revoke', { id: k.id }, cid); toast('Link revoked'); box.replaceWith(await tableLinksBox()); } catch (e) { toast(e.message, true); }
      }, 'small'))) : el('p', { class: 'muted small' }, 'No panel links yet.'));
    box.append(list, el('div', { class: 'row' }, btn('New panel link…', () => newPanelLink(box), 'small'),
      btn('New API key…', () => newApiKey(box), 'small', 'A key for a program, such as a Foundry VTT module, a Discord bot or your own script, to read this campaign (and, if you allow it, pass time and add notes) as you'),
      el('span', { class: 'small muted' }, 'Owlbear Rodeo: add ', el('code', {}, new URL('api/index.php?a=owlbear_manifest', panelBase()).href),
        copyButton(new URL('api/index.php?a=owlbear_manifest', panelBase()).href, 'Owlbear Rodeo address'), ' under Extensions → Add custom extension.')));
    return box;
  }
  function newPanelLink(box) {
    const label = el('input', { maxlength: 80, placeholder: isGM() ? 'e.g. Owlbear, or Twitch overlay' : 'e.g. Owlbear on my laptop', 'aria-label': 'Label' });
    const scope = select([['panel', 'Personal: sees what I see'], ['public_panel', 'Public: what every player sees, read-only (streams, a shared TV)']], 'panel', { 'aria-label': 'Kind' });
    const overlay = el('input', { type: 'checkbox' });
    const overlayRow = el('label', { class: 'small', hidden: true }, overlay, ' Overlay style: see-through, large text, for an OBS browser source');
    scope.addEventListener('change', () => { overlayRow.hidden = scope.value !== 'public_panel'; });
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'New panel link' });
    const form = el('form', { method: 'dialog' }, el('h3', {}, 'New panel link'),
      field('Label', label, 'So you know where it is pasted'), isGM() ? field('Kind', scope) : null, overlayRow,
      el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', value: 'ok' }, 'Make link'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel')));
    d.append(form);
    form.addEventListener('submit', async ev => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault();
      try {
        const r = await post('panel_link_create', { scope: isGM() ? scope.value : 'panel', label: label.value.trim(), overlay: overlay.checked }, S.camp.id);
        const url = `${panelBase()}#k=${r.link.code}${r.link.overlay ? '&overlay=1' : ''}`;
        const shown = el('input', { readonly: true, value: url, 'aria-label': 'Panel link', onfocus: e => e.target.select() });
        form.replaceChildren(el('h3', {}, `"${r.link.label}" is ready`),
          el('p', {}, 'Copy the link and paste it into the panel the first time it opens (or into OBS as a Browser Source).'),
          shown, el('p', { class: 'small muted' }, 'You won\'t see this link again. Anyone who has it sees ' + (r.link.scope === 'public_panel' ? 'what every player sees.' : 'what you see, and can add notes as you.')),
          el('div', { class: 'kit-dialog-actions' },
            btn('Copy', async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { shown.select(); toast('Press Ctrl+C (⌘C) to copy', true); } }, 'primary'),
            el('button', { value: 'done' }, 'Done')));
        box.replaceWith(await tableLinksBox());
      } catch (e) { toast(e.message, true); }
    });
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }

  /** A key for a program: what it may do, then the key, shown once, with how to send it. */
  function newApiKey(box) {
    const label = el('input', { maxlength: 80, placeholder: 'e.g. Foundry module, or Discord bot', 'aria-label': 'Label' });
    const access = select([['read', 'Read only: the date, weather, Encyclopedia and the like'], ['write', isGM() ? 'Read and write: also pass time, add notes and events' : 'Read and write: also add notes and events']], 'read', { 'aria-label': 'Access' });
    const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'New API key' });
    const form = el('form', { method: 'dialog' }, el('h3', {}, 'New API key'),
      field('Label', label, 'So you know which program has it'), field('Access', access),
      el('p', { class: 'small muted' }, 'The key acts as you: it sees what you see in this campaign, and nothing in your other campaigns.'),
      el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', value: 'ok' }, 'Make key'), el('button', { value: 'cancel', formnovalidate: true }, 'Cancel')));
    d.append(form);
    form.addEventListener('submit', async ev => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault();
      try {
        const r = await post('panel_link_create', { scope: 'api', label: label.value.trim(), write: access.value === 'write' }, S.camp.id);
        const key = r.link.code, url = new URL('api/index.php', panelBase()).href;
        const shown = el('input', { readonly: true, value: key, 'aria-label': 'API key', onfocus: e => e.target.select() });
        form.replaceChildren(el('h3', {}, `"${r.link.label}" is ready`),
          el('p', {}, 'Copy the key into the program. You won\'t see it again.'), shown,
          el('p', { class: 'small muted' }, 'Programs send it in the X-Chronicle-Key header, for example:'),
          el('pre', { class: 'small api-example' }, `curl -H "X-Chronicle-Key: ${key}" \\\n  "${url}?a=campaign"`),
          el('p', { class: 'small muted' }, 'What it can do is in docs/API.md in Campaign Chronicle\'s code. Revoke it here whenever you like.'),
          el('div', { class: 'kit-dialog-actions' },
            btn('Copy', async () => { try { await navigator.clipboard.writeText(key); toast('Key copied'); } catch { shown.select(); toast('Press Ctrl+C (⌘C) to copy', true); } }, 'primary'),
            el('button', { value: 'done' }, 'Done')));
        box.replaceWith(await tableLinksBox());
      } catch (e) { toast(e.message, true); }
    });
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }

  // ------------------------------------------------------------ the panel (panel.html)
  // At the Table on its own, for another site's frame (Owlbear Rodeo, Foundry) or OBS. It signs in with a panel link's
  // code, sent in the X-Chronicle-Panel header (api/panel.php), as the browser won't send Chronicle's cookie there. The
  // code comes in the address (#k=…) or is pasted once, and is kept in this frame's own storage.
  const PANEL_KEY = 'chronicle-panel-code';
  let panelCodeNow = '';
  const codeIn = s => (String(s || '').match(/(?:^|[#&?]k=|^)([0-9a-f]{64})(?:$|[&\s])/) || [])[1] || '';
  function readPanelCode() {
    const h = new URLSearchParams(location.hash.slice(1));
    const fromHash = codeIn(h.get('k') || '');
    if (fromHash) {
      try { localStorage.setItem(PANEL_KEY, fromHash); } catch { /* storage blocked: keeps working until reloaded */ }
      h.delete('k');
      history.replaceState(null, '', location.pathname + location.search + (h.toString() ? `#${h}` : ''));
      return fromHash;
    }
    try { return localStorage.getItem(PANEL_KEY) || ''; } catch { return ''; }
  }
  // Framed by another site (Owlbear Rodeo, Foundry, a page you don't know): which one, and whether its frames may change
  // things, remembered per site in this frame's own storage.
  const PANEL_WRITES_KEY = 'chronicle-panel-writes';
  const panelFramed = () => { try { return window.top !== window.self; } catch { return true; } };
  /** The site showing this panel in its frame, as an origin, or '' when the browser won't say. */
  function panelEmbedderOrigin() {
    const anc = location.ancestorOrigins;
    if (anc && anc.length) return anc[anc.length - 1];
    try { return document.referrer ? new URL(document.referrer).origin : ''; } catch { return ''; }
  }
  const panelEmbedder = () => { const o = panelEmbedderOrigin(); try { return o ? new URL(o).host : 'another site'; } catch { return 'another site'; } };
  function panelWriteSites() { try { return JSON.parse(localStorage.getItem(PANEL_WRITES_KEY) || '[]'); } catch { return []; } }
  const panelWritesAllowed = () => !!panelEmbedderOrigin() && panelWriteSites().includes(panelEmbedderOrigin());
  function setPanelWrites(on) {
    const o = panelEmbedderOrigin();
    if (!o) return;
    const list = panelWriteSites().filter(x => x !== o);
    if (on) list.push(o);
    try { localStorage.setItem(PANEL_WRITES_KEY, JSON.stringify(list)); } catch { /* this page only */ }
  }
  function forgetPanelCode() {
    panelCodeNow = '';
    try { localStorage.removeItem(PANEL_KEY); } catch { /* nothing kept */ }
  }
  const panelOverlay = () => new URLSearchParams(location.hash.slice(1)).get('overlay') === '1' || new URLSearchParams(location.search).get('overlay') === '1' || !!S.panel?.link?.overlay;
  function panelAsk(why) {
    S.camp = null;
    const input = el('input', { placeholder: 'https://…/panel.html#k=…', 'aria-label': 'Panel link', autocomplete: 'off' });
    const f = el('form', { class: 'card panel-ask' }, el('h2', {}, 'Campaign Chronicle'),
      why ? el('p', { class: 'error' }, why) : null,
      el('p', {}, 'Paste your panel link. Make one in Chronicle: open the campaign, then At the Table → Use in a VTT or on stream → New panel link.'),
      input, el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Open')));
    f.addEventListener('submit', ev => {
      ev.preventDefault();
      const code = codeIn(input.value.trim());
      if (!code) return toast('That isn\'t a panel link', true);
      try { localStorage.setItem(PANEL_KEY, code); } catch { /* this page only */ }
      panelCodeNow = code;
      panelBoot();
    });
    mount(f);
    input.focus();
  }
  async function panelBoot() {
    panelCodeNow ||= readPanelCode();
    if (!panelCodeNow) return panelAsk();
    try {
      const who = await api('panel_whoami');
      S.panel = who;
      S.user = { id: who.link?.user_id || 0, display_name: who.name || '', prefs: {} };
      document.documentElement.classList.toggle('panel-overlay', panelOverlay());
      await loadCampaign(who.campaign_id, true);
      S.reminders = (await api('reminders', { query: { cid: who.campaign_id } }).catch(() => ({ reminders: [] }))).reminders;
      await viewTable();
      panelStamp = Date.now();
    } catch (e) {
      if (e.status === 401) return;   // api() has asked for a new link
      mount(el('div', { class: 'card' }, el('h2', {}, 'Can\'t reach Chronicle'), el('p', {}, e.message), btn('Try again', () => panelBoot(), 'primary')));
    }
  }
  let panelStamp = 0;
  function panelFooter() {
    const who = S.panel?.link?.scope === 'public_panel' ? 'Public panel' : `Signed in as ${S.user.display_name}${isGM() ? ' (GM)' : ''}`;
    const ago = el('span', { class: 'panel-ago' }, '↻ just now');
    // public panels change nothing anyway; a member's own link in a frame starts with changes off
    const writes = S.panel?.link?.scope !== 'public_panel' && panelFramed()
      ? (panelWritesAllowed()
        ? btn(`Changes allowed on ${panelEmbedder()} · turn off`, () => { setPanelWrites(false); viewTable(); }, 'small', 'Stop this panel making changes while this site shows it')
        : panelEmbedderOrigin()
          ? btn('Allow changes here', async () => {
            if (!await confirmDialog(`Let this panel pass time and add notes while ${panelEmbedder()} shows it? Only allow a site you use, such as your VTT.`, { ok: 'Allow changes' })) return;
            setPanelWrites(true); viewTable();
          }, 'small', `Changes are off while ${panelEmbedder()} shows this panel`)
          : el('span', {}, 'Read only here: this browser doesn\'t say which site shows the panel'))
      : null;
    return el('div', { class: 'panel-foot small muted' }, el('span', {}, `${who} · via panel link`), ago, writes,
      btn('Forget this link', async () => { if (await confirmDialog('Forget this panel link on this device? You\'ll need to paste it again.')) { forgetPanelCode(); panelAsk(); } }, 'small'));
  }
  /** The panel follows the campaign: when a GM changes it (passes time, say), it redraws, unless a note is being typed. */
  async function panelPoll() {
    if (!S.camp || document.hidden) return;
    try {
      // the change stamp is to the second, so a pass of time in the same second as the last change is caught by the clock
      const [r, rem] = await Promise.all([api('changed', { query: { cid: S.camp.id } }), api('reminders', { query: { cid: S.camp.id } })]);
      const typing = [...document.querySelectorAll('.table-view textarea, .table-view input')].some(i => i.value && i === document.activeElement) || !!document.querySelector('.table-view textarea')?.value;
      if ((r.changed !== S.camp.changed || rem.current_shift !== S.camp.current_shift) && !typing) {
        await loadCampaign(S.camp.id, true);
        S.reminders = rem.reminders;
        await viewTable();
        panelStamp = Date.now();
      }
      const ago = document.querySelector('.panel-ago');
      if (ago) { const m = Math.round((Date.now() - panelStamp) / 60000); ago.textContent = m < 1 ? '↻ just now' : `↻ ${m} min ago`; }
    } catch { /* offline for a moment */ }
  }

  // ------------------------------------------------------------ the tabs in their own files
  // Everything the moved tabs use from here, built once everything above exists. A tab's own exports that another tab
  // uses are getters, as they are filled in just below.
  const tabCtx = {
    DOWNTIME_KINDS, E, ENC_CATEGORIES, Fan, S, UNIT_OPTIONS, alertDialog, api, attachmentsCard, btn, busy, byline,
    cal, campHidesTemps, campUnits, campaignHeader, clean, confirmDialog, connIndex, connectionsCard, el, encCat,
    encCatNamed, get encMentions() { return encMentions; }, entryForm, fanCtx, field, formData, hideTip, isGM,
    leapSummary, get linkedNote() { return linkedNote; }, listPage, loadCampaign, lockBox, mapLinks, mount, multiPick,
    notesEntry, get offerNouns() { return offerNouns; }, post, promptDialog, readerEmpty, relationKinds, route,
    get saveFile() { return saveFile; }, secretTag, select, sessionName, sessionStart, sessionShiftNotes, sessionActionsBox, newSessionDialog, sessionDatesDialog, pickShiftDialog, sessionPlaces, settings, shiftNames, nowShift, tagChip,
    tagsOf, tip, tipped, toast, today, trail, copyButton, pinButton, vs
  };
  ({ encLinker, linked, linkedNote, revealButtons, mentionRow, encMentions, offerNouns, sourceLabel, scanOneBtn, entryBlank, deleteEntryBtn, viewEncyclopedia, sourcesNaming, saveFile } = EncyclopediaTab.make(tabCtx));
  tabCtx.revealButtons = revealButtons;
  ({ viewSessions } = SessionsTab.make(tabCtx));
  ({ viewGenerators } = GeneratorsTab.make(tabCtx));
  ({ viewClocks, tableClocks, panelClocks } = ClocksTab.make(tabCtx));
  // The die roller (static/dice-tab.js): not in panel.html, which has no 🎲 button.
  const { diceSync, diceNotice, diceFromSheet } = !PANEL && typeof DiceTab !== 'undefined' ? DiceTab.make(tabCtx) : { diceSync: () => {}, diceNotice: () => {}, diceFromSheet: null };
  // The Report (!) button and Site Admin's Reports tab (static/report.js; the At the Table panel doesn't load it)
  reports = typeof ChronicleReport !== 'undefined' ? ChronicleReport.make({ S, api, post, btn, el, toast, confirmDialog, promptDialog, hideTip, version: APP_VERSION }) : null;
  ({ SEASON_LABELS, seasonChip, seasonEditor, viewSettings } = SettingsTab.make(tabCtx));

  // ------------------------------------------------------------ router
  // Pages draw one at a time, in order, so a page still loading when the address changes again (Back while a day loads)
  // can't draw over the newer one, or over what has been typed in it. One that a newer address replaced before it began is skipped.
  let routeSeq = 0, routeRun = Promise.resolve();
  function route() {
    const seq = ++routeSeq;
    let drawn = null;   // the address this run drew, for Recent, even if the address has moved on since
    return (routeRun = routeRun.then(() => (seq === routeSeq ? (drawn = location.hash, routeTo()) : null)).catch(err => console.error(err))
      .then(() => { Undo.reapply(); diceSync(); fillJumpLinks(); keepPlace(); if (drawn) noteRecent(drawn); }));
  }
  // Back keeps your place: each page's scroll, and its list's scroll, are noted as you leave it, and put back when Back (or
  // Forward) returns to it. Opening an item from a list (the Encyclopedia, Library, Sessions) keeps the list where it was too.
  // A page reached by a new click starts at the top as before.
  const places = new Map();
  let placeHash = null, placeShot = null, placeNav = false;
  const tabOf = h => (h || '').split('?')[0].split('/').slice(0, 4).join('/');
  addEventListener('hashchange', () => {   // runs before the new page is drawn: the old one is still there to measure
    placeNav = true;
    if (placeHash) places.set(placeHash, placeShot = { y: scrollY, lists: [...document.querySelectorAll('.lp-list')].map(l => l.scrollTop) });
  });
  function keepPlace() {
    if (!placeNav) { placeHash = location.hash; return; }   // a page drawn again after a save stays as mount() leaves it
    placeNav = false;
    const h = location.hash, back = !!history.state?.chronicleSeen;
    if (!back) { try { history.replaceState({ ...(history.state || {}), chronicleSeen: true }, ''); } catch { /* fine */ } }
    const was = back ? places.get(h) : (placeHash && tabOf(placeHash) === tabOf(h) ? { y: null, lists: placeShot?.lists } : null);
    placeHash = h; placeShot = null;
    if (!was) return;
    if (was.y !== null && was.y !== undefined) scrollTo(0, was.y);
    document.querySelectorAll('.lp-list').forEach((l, i) => { if (was.lists?.[i]) l.scrollTop = was.lists[i]; });
  }
  async function routeTo() {
    if (!Undo.samePage()) await Undo.flush();   // going to another page: a delete waiting on its Undo goes through first
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = (path || '').split('/');
    if (parts[0] === 'about') { renderNav(); return viewAbout(); } // readable signed out too
    if (!S.user) return; // boot() shows the sign-in or waiting screen
    renderNav();
    try {
      if (parts[0] === '') return await viewCampaigns();
      if (parts[0] === 'account') return await viewAccount(); // awaited, so a failed load lands in the catch below
      if (parts[0] === 'admin') return await viewAdmin(parts[1]);
      if (parts[0] === 'templates' && typeof Sheets !== 'undefined') return await Sheets.route(parts.slice(1));
      if (parts[0] === 'new') return viewCreate(); // its own address, so Cancel (back to #/) is a real change of page
      if (parts[0] === 'c') {
        const cid = Number(parts[1]);
        await loadCampaign(cid);
        const rem = await loadReminders().catch(() => null); // fresh on every page, so a pass of time pops what it reached
        const tab = parts[2] || 'table';
        const viewToday = () => viewTable();   // Current Day is At the Table now
        if (tab === 'day') await viewDay(Number(parts[3]));
        else if (tab === 'encyclopedia') await viewEncyclopedia(parts[3]);
        else if (tab === 'library') await viewLibrary(parts[3]);
        else if (tab === 'sessions') await viewSessions(parts[3]);
        else if (tab === 'clocks') await viewClocks();
        else if (tab === 'maps' && typeof MapsTab !== 'undefined') await MapsTab.view(mapsCtx(), parts[3], query);
        else if (tab === 'tokens' && typeof TokensTab !== 'undefined') await TokensTab.view(mapsCtx());
        else if (tab === 'characters' && typeof Sheets !== 'undefined') await Sheets.campaignRoute(parts.slice(3));
        else if (tab === 'search') await viewSearch(new URLSearchParams(query || '').get('q') || '');
        else if (tab === 'today' && parts[3]) await viewDay(Number(parts[3]));   // an old Current Day link to another day
        else await ({ today: viewToday, table: viewTable, calendar: viewCalendar, events: () => (parts[3] === 'reminders' ? viewReminders() : viewEvents()), travel: viewTravel, downtime: viewDowntime, holdings: viewHoldings, generators: viewGenerators, regions: viewRegions, holidays: viewHolidays, members: viewMembers, settings: () => viewSettings(parts[3]) }[tab] || viewToday)();
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
    if (PANEL) return panelBoot();
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

  // Character sheets (static/sheets.js): the template library and editor, and the sheets themselves.
  if (typeof Sheets !== 'undefined') Sheets.mount({ S, api, post, mount, field, campaignHeader, isGM, route, rollFromSheet: diceFromSheet, reloadCampaign: () => loadCampaign(S.camp.id, true) });

  // Signed out, leaving the About page goes back through the gate.
  if (!PANEL) {
    window.addEventListener('hashchange', () => (S.user ? route() : boot()));
    $('#version').textContent = `Campaign Chronicle build ${APP_VERSION}`;
    $('#version').before(el('a', { href: '#/about', class: 'small', 'data-tip': 'Where the travel speeds, climates and calendars come from' }, 'About & sources'), ' · ');
    // Makes the app installable in Chrome and Edge (with manifest.webmanifest). Needs HTTPS, or localhost.
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
