/* settings-tab.js — The Settings tab: the campaign's calendar, seasons, units and weather tuning.
 *
 * Moved out of app.js as it was: app.js calls make() once with its shared helpers and state (tabCtx), and gets back
 * what the rest of the app uses. Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { E, Fan, S, UNIT_OPTIONS, alertDialog, btn, busy, cal, campHidesTemps, campUnits, campaignHeader, clean, confirmDialog, el, fanCtx, field, formData, isGM, leapSummary, loadCampaign, mount, post, promptDialog, route, saveFile, select, settings, tipped, toast, today } = ctx;

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
    const { calToText, textToCal } = CalendarText;

    // ------------------------------------------------------------ settings: weather tuning
    /** The step the ground rates are shown in on Weather tuning: the engine keeps them a quarter of the day (Dawn, Midday,
     * Dusk, Overnight), so a campaign in two shifts sees them a shift (two quarters) and one in hours sees them an hour.
     * k is what a quarter's figure is multiplied by to show it. */
    function groundStep(c) {
      const mode = E.timeMode(c), hpd = Number(c.hoursPerDay) || 24;
      if (mode === 'hours') return { k: 4 / hpd, a: 'an hour', one: 'an hour', many: 'hours', walk: 'hour by hour' };
      if (mode === 'shifts2') return { k: 2, a: 'a shift', one: 'a shift (Day or Night)', many: 'shifts', walk: 'shift by shift (Day and Night)' };
      return { k: 1, a: 'a shift', one: 'a shift', many: 'shifts', walk: 'shift by shift' };
    }

    /** Settings → Weather tuning: the app's own weather choices (see the About page), changed for this campaign only.
     * The campaign stores just the values that differ from the built-in ones (settings.tuning). */
    function tuningCard() {
      const D = E.tuningDefaults();
      let T = E.mergeTuning(settings().tuning);
      const wxName = k => `${E.WEATHER[k]?.icon || ''} ${E.WEATHER[k]?.label || k}`.trim();
      const regionClimates = S.regions.map(r => r.settings?.climate || 'temperate');
      const pick = (path, obj) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
      const fmt = v => (v === undefined ? '' : String(+(+v).toPrecision(4)));   // 4 figures: a rate shown an hour can be small
      const countChanges = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.values(o).reduce((n, v) => n + countChanges(v), 0) : o === undefined ? 0 : 1);
      const counters = {};
      const recount = () => {
        const ch = E.tuningChanges(T);
        for (const [k, out] of Object.entries(counters)) { const n = countChanges(ch[k]); out.textContent = n ? ` · ${n} changed` : ''; }
      };
      /** A number box for the value at path in T. scale shows it ×scale (100 for a chance shown in %). An empty box
       * goes back to the built-in value, or leaves the value out where there is none (blank = 0, or worked out). */
      function numBox(path, { label, step = 'any', min, max, scale = 1, blank = '' } = {}) {
        const def = pick(path, D);
        const input = el('input', { type: 'number', inputmode: 'decimal', step, min, max, class: 'tune-num', 'aria-label': label, placeholder: blank,
          value: fmt(pick(path, T) === undefined ? undefined : pick(path, T) * scale) });
        const mark = () => {
          const v = pick(path, T), changed = JSON.stringify(v) !== JSON.stringify(def);
          input.classList.toggle('tuned', changed);
          input.dataset.tip = changed ? `Built-in: ${def === undefined ? (blank || 'none') : fmt(def * scale)}` : '';
        };
        input.addEventListener('input', () => {
          const parent = pick(path.slice(0, -1), T), key = path[path.length - 1];
          const n = input.value === '' ? NaN : Number(input.value) / scale;
          if (Number.isFinite(n)) parent[key] = n;
          else if (def !== undefined) parent[key] = def;
          else delete parent[key];
          mark(); recount();
        });
        input.addEventListener('change', () => { input.value = fmt(pick(path, T) === undefined ? undefined : pick(path, T) * scale); });
        mark();
        return input;
      }
      const table = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl tune-tbl' },
        el('tr', {}, head.map(h => el('th', {}, h))), rows.map(r => el('tr', {}, r.map((c, i) => el(i ? 'td' : 'th', { scope: i ? null : 'row' }, c))))));
      /** One fold-out section: its body is drawn by draw(), again after "Reset this section". */
      function section(key, title, intro, draw) {
        const body = el('div', { class: 'tune-body' });
        const count = el('span', { class: 'muted small' });
        counters[key] = count;
        const redraw = () => { body.replaceChildren(...clean([draw()].flat())); recount(); };
        const reset = btn('Reset this section', () => { T[key] = JSON.parse(JSON.stringify(D[key])); redraw(); }, 'small',
          'Put this section back to the built-in values. Save to keep it');
        redraw();
        return el('details', { class: 'tune-sec' }, el('summary', {}, title, count),
          el('p', { class: 'muted small' }, intro), body, el('div', { class: 'row' }, reset));
      }
      const SEASON_LABEL = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter', any: 'Any other time' };

      // storms, fog and dust in each Köppen class
      const kSel = select([], '', { 'aria-label': 'Köppen class' });
      const firstK = regionClimates.find(c => String(c).startsWith('koppen:'));
      let kCode = firstK ? firstK.slice(7) : 'Cfb';
      const kOptions = () => {
        const ch = E.tuningChanges(T).koppen || {};
        kSel.replaceChildren(...Object.entries(E.KOPPEN_GROUPS).map(([g, name]) => el('optgroup', { label: name },
          Object.entries(E.KOPPEN).filter(([code]) => code[0] === g).map(([code, k]) =>
            el('option', { value: code, selected: code === kCode }, `${code} · ${k.label}${ch[code] ? ' (changed)' : ''}`)))));
      };
      const kTable = el('div');
      const drawK = () => {
        const f = (s, x, label) => numBox(['koppen', kCode, s, x], { label: `${kCode} ${s} ${label}`, step: 0.1, min: 0, max: 3 });
        kTable.replaceChildren(table(['Season', 'Storms', 'Fog', 'Dust storms'],
          E.KOPPEN_SEASONS.map(s => [SEASON_LABEL[s], f(s, 'storm', 'storms'), f(s, 'fog', 'fog'), f(s, 'dust', 'dust storms')])));
      };
      kSel.addEventListener('change', () => { kCode = kSel.value; drawK(); });
      const koppenSec = section('koppen', 'Storms, fog and dust in each Köppen class',
        'How often each turns up in a season, 0 (never) to 3 (often). Storms are thunderstorms, or blizzards when it is freezing. Highs and wetness come from weather stations and stay as they are. Used by regions with a Köppen class; a region\'s own custom climate keeps its own figures.',
        () => { kOptions(); drawK(); return [field('Class', kSel), kTable]; });
      kTable.addEventListener('input', kOptions);

      // the simple climates' weather mix
      const cSel = select(Object.entries(E.CLIMATES).map(([k, c]) => [k, c.label]), '', { 'aria-label': 'Climate' });
      let cKey = regionClimates.find(c => E.CLIMATES[c]) || 'temperate';
      cSel.value = cKey;
      const cTable = el('div');
      const drawC = () => {
        const seasons = Object.keys(D.climates[cKey]);
        const used = new Set(seasons.flatMap(s => Object.keys(D.climates[cKey][s])));
        const outdoor = E.OUTDOOR_WEATHER.some(k => used.has(k));
        const types = [...new Set([...(outdoor ? E.OUTDOOR_WEATHER : []), ...used])];
        const total = s => Object.values(T.climates[cKey][s]).reduce((a, b) => a + (b > 0 ? b : 0), 0);
        const share = (s, k) => { const t = total(s), w = T.climates[cKey][s][k] || 0; return t && w ? `${Math.round(w / t * 100)}%` : ''; };
        const rows = types.map(k => [wxName(k), ...seasons.map(s => {
          const box = numBox(['climates', cKey, s, k], { label: `${SEASON_LABEL[s]} ${E.WEATHER[k].label}`, step: 0.1, min: 0, max: 100, blank: '0' });
          const pct = el('small', { class: 'muted tune-pct', 'data-season': s, 'data-type': k }, share(s, k));
          return el('span', { class: 'tune-cell' }, box, pct);
        })]);
        const tbl = table(['Weather', ...seasons.map(s => SEASON_LABEL[s])], rows);
        tbl.addEventListener('input', () => tbl.querySelectorAll('.tune-pct').forEach(p => (p.textContent = share(p.dataset.season, p.dataset.type))));
        cTable.replaceChildren(tbl);
      };
      cSel.addEventListener('change', () => { cKey = cSel.value; drawC(); });
      const climateSec = section('climates', 'Weather mix of the simple climates',
        'How likely each weather is in each season, against the others: a 6 comes up twice as often as a 3, and 0 or empty never. The share of days it works out to is shown beside each.',
        () => { drawC(); return [field('Climate', cSel), cTable]; });

      // visibility
      const visSec = section('visibility', 'How weather changes visibility',
        'Added to a shift\'s visibility (0–5) by day and at night: −2 takes Clear down to Dim. Moonlight is the share of the moons\' light that gets through at night, 0 to 1.',
        () => table(['Weather', 'By day', 'At night', 'Moonlight'], Object.keys(E.WEATHER).map(k => [wxName(k),
          numBox(['visibility', k, 'day'], { label: `${E.WEATHER[k].label} by day`, step: 1, min: -5, max: 5 }),
          numBox(['visibility', k, 'night'], { label: `${E.WEATHER[k].label} at night`, step: 1, min: -5, max: 5 }),
          numBox(['visibility', k, 'moon'], { label: `${E.WEATHER[k].label} moonlight`, step: 0.05, min: 0, max: 1 })])));

      // shifts
      const labelOf = k => E.WEATHER[k]?.label || k;
      const byName = {};
      for (const [k, w] of Object.entries(E.WEATHER)) { byName[k] = k; byName[w.label.toLowerCase()] = k; }
      const variantBox = k => {
        const input = el('input', { class: 'tune-list', 'aria-label': `${labelOf(k)} eases off to`, value: (T.shifts.variants[k] || []).map(labelOf).join(', ') });
        const mark = () => {
          const changed = JSON.stringify(T.shifts.variants[k] || []) !== JSON.stringify(D.shifts.variants[k] || []);
          input.classList.toggle('tuned', changed);
          input.dataset.tip = changed ? `Built-in: ${(D.shifts.variants[k] || []).map(labelOf).join(', ') || 'none'}` : '';
        };
        input.addEventListener('input', () => {
          const names = input.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
          const bad = names.filter(n => !byName[n]);
          input.setCustomValidity(bad.length ? `Not a kind of weather: ${bad.join(', ')}` : '');
          if (bad.length) return;
          const list = [...new Set(names.map(n => byName[n]))].filter(x => x !== k);
          if (list.length || D.shifts.variants[k]) T.shifts.variants[k] = list; else delete T.shifts.variants[k];
          mark(); recount();
        });
        mark();
        return input;
      };
      const pct = (key, label, tipText) => field(label, numBox(['shifts', key], { label, step: 1, min: 0, max: 100, scale: 100 }), null, tipText);
      const shiftSec = section('shifts', 'How the shifts ease off from the forecast',
        'The day\'s weather is the worst it gets. Walking out from the shift it peaks in, each shift may ease off a step to a milder neighbour, and stays eased once it has.',
        () => [el('div', { class: 'grid2' },
          pct('ease', 'Chance a shift eases off (%)', 'For each shift away from the peak, the chance it steps down to a milder weather from the list below'),
          pct('fogLift', 'Chance fog lifts by Midday and after (%)', 'Fog is thickest at dawn, so it eases off faster later in the day'),
          pct('calmNight', 'Chance the wind drops overnight (%)', 'The chance the overnight shift has one level less wind than the day\'s strongest'),
          pct('calmDay', 'Chance the wind drops in other shifts (%)', 'The same for Dawn, Midday and Dusk, when they are not the peak')),
        el('p', { class: 'muted small' }, 'What each weather eases off to, mildest last. Type the names separated by commas, e.g. "Light rain, Overcast".'),
        table(['Weather', 'Eases off to'], Object.keys(E.WEATHER).map(k => [wxName(k), variantBox(k)]))]);

      // ground. The engine works it out a quarter of the day at a time; the rates are shown in the campaign's own step
      // (a shift, or an hour), scaled from the quarter they are kept in.
      const groundTypes = [...E.OUTDOOR_WEATHER, 'damp'];
      const step = groundStep(cal());
      const gf = (path, label, opts, tipText, hint) => field(label, numBox(['ground', ...path], { label, ...opts }), hint, tipText);
      const perStep = { scale: step.k, ...(step.k === 1 ? {} : { step: 'any' }) };
      const groundSec = section('ground', 'Ground conditions',
        `Snow and rain build up over the days before, ${step.walk}. Snow melts in the warmth and the ground dries in sun, warmth and wind.`,
        () => [el('div', { class: 'grid3' },
          gf(['melt'], `Snow melt (cm ${step.a} per °C)`, { step: 0.05, min: 0, max: 5, ...perStep }, `How much snow melts in ${step.one} for each degree above freezing`),
          gf(['drying'], `Drying rate (mm ${step.a} per °C)`, { step: 0.005, min: 0, max: 1, ...perStep },
            `How much water warmth dries out of damp ground in ${step.one}, for each degree above freezing, on an ordinary sunny day. Sun drying below makes it faster or slower in each weather, and wind speeds it up. Twice the number dries it twice as fast`),
          gf(['fieldCapacity'], 'Water the soil holds (mm)', { step: 1, min: 5, max: 55 }, `Rain beyond this drains away over the following ${step.many} instead of soaking in`)),
        table(['Weather', `Snow (cm ${step.a})`, `Rain (mm ${step.a})`, 'Sun drying (× drying rate)'], groundTypes.map(k => [wxName(k),
          numBox(['ground', 'snowfall', k], { label: `${labelOf(k)} snow`, step: 0.1, min: 0, max: 50, blank: '0', ...perStep }),
          numBox(['ground', 'rainfall', k], { label: `${labelOf(k)} rain`, step: 0.1, min: 0, max: 100, blank: '0', ...perStep }),
          numBox(['ground', 'sunshine', k], { label: `${labelOf(k)} sun drying`, step: 0.1, min: 0, max: 5, blank: 'auto' })])),
        el('p', { class: 'muted small' }, 'Sun drying multiplies the drying rate in that weather: 1 is an ordinary day, 1.5 dries half as fast again, 0.3 hardly dries at all. ',
          'Left empty, it is 0.2 for weather that rains or snows and 0.8 otherwise. The ground also dries most at midday and least overnight.'),
        el('h4', {}, 'Where the ground turns'),
        el('p', { class: 'muted small' }, 'The water in the topsoil (mm, up to 60) each label starts at, and the snow depth (cm) for each snow label. Each must be higher than the one before. Below Firm the ground is Dry.'),
        table(['', ...Object.values(E.GROUND_WET_STEPS)], [['Water (mm)', ...Object.keys(E.GROUND_WET_STEPS).map(k => numBox(['ground', 'wet', k], { label: `${E.GROUND_WET_STEPS[k]} from (mm)`, step: 1, min: 0, max: 59 }))]]),
        table(['', ...Object.values(E.GROUND_SNOW_STEPS)], [['Snow (cm)', ...Object.keys(E.GROUND_SNOW_STEPS).map(k => numBox(['ground', 'snow', k], { label: `${E.GROUND_SNOW_STEPS[k]} from (cm)`, step: 0.5, min: 0.1, max: 1000 }))]]),
        el('p', { class: 'muted small' }, 'Frozen ground with at least Soft\'s water in it shows as icy ruts.')]);

      const save = async (tuning, msg) => {
        const s = { ...settings() };
        if (tuning && Object.keys(tuning).length) s.tuning = tuning; else delete s.tuning;
        await post('campaign_update', { settings: s }, S.camp.id);
        await loadCampaign(S.camp.id, true); toast(msg); route();
      };
      const form = el('form', { class: 'card tune-card', novalidate: true }, el('h2', {}, 'Weather tuning'),
        el('p', { class: 'muted' }, 'The app\'s own choices behind the weather, for this campaign only: they aren\'t measurements (see About). Changed values are highlighted; hover or tap one to see the built-in value. ',
          'Days that already have weather keep it. New days and re-rolls, and every day\'s shifts, visibility and ground, follow these straight away.'),
        koppenSec, climateSec, visSec, shiftSec, groundSec,
        el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Save weather tuning'),
          settings().tuning ? btn('Reset all to built-in', busy(null, async () => {
            if (!await confirmDialog('Put all the weather tuning back to the built-in values for this campaign?')) return;
            await save(null, 'Weather tuning reset');
          }), 'small', 'Forget every change made here, so the campaign uses the app\'s built-in values again') : null));
      form.addEventListener('submit', busy(null, async e => {
        e.preventDefault();
        const badList = form.querySelector('.tune-list:invalid');
        if (badList) { badList.closest('details').open = true; badList.reportValidity(); return; }
        const problem = E.tuningProblem(T);
        if (problem) throw new Error(problem);
        await save(E.tuningChanges(T), 'Weather tuning saved');
      }));
      recount();
      return form;
    }

    /** Settings' own tabs, each an address of its own (#/c/1/settings/calendar) so a save, a reload or a link keeps it. */
    const SETTINGS_TABS = [['campaign', 'Campaign'], ['calendar', 'Calendar'], ['dice', 'Dice'], ['weather', 'Weather tuning'], ['tools', 'Tools']];
    function viewSettings(sub) {
      if (!isGM()) { mount(...campaignHeader('settings'), el('div', { class: 'card' }, el('p', {}, 'Only the GM can change campaign settings.'))); return; }
      const at = SETTINGS_TABS.some(([k]) => k === sub) ? sub : 'campaign';
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
      /** The calendar for Seasons & Stars in Foundry: say what didn't fit and what date to set, then download it. */
      async function exportSeasonsStars() {
        const r = VttCalendar.seasonsAndStars(S.camp, S.holidays);
        const c = r.calendar, today = r.today;
        const ok = el('button', { value: 'ok', class: 'primary' }, 'Download');
        const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'Calendar for Foundry' },
          el('form', { method: 'dialog' },
            el('h3', {}, '⬇ Calendar for Foundry VTT'),
            el('p', { class: 'small' }, 'For the Seasons & Stars module (Foundry 13). In Foundry, upload the file (the File Browser, or the Data folder), then in Seasons & Stars choose Select Calendar, pick the file, and Select.'),
            today ? el('p', { class: 'small' }, 'Then set Foundry\'s date to ', el('strong', {}, `${today.day} ${c.months[today.month - 1].name} ${today.year}`), ', where this campaign is now.')
              : el('p', { class: 'small' }, 'This campaign is on a festival day now; set Foundry\'s date to the day after it.'),
            r.lost.length ? [el('p', { class: 'small muted' }, 'Seasons & Stars can\'t hold everything:'), el('ul', { class: 'small muted' }, r.lost.map(t => el('li', {}, t)))] : null,
            el('div', { class: 'kit-dialog-actions' }, ok, el('button', { value: 'cancel' }, 'Cancel'))));
        d.addEventListener('close', () => {
          if (d.returnValue === 'ok') saveFile(new Blob([JSON.stringify(c, null, 2) + '\n'], { type: 'application/json' }), VttCalendar.fileName(S.camp));
          d.remove();
        });
        document.body.append(d);
        d.showModal();
      }
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
        const sessionsSel = select([['sessions', 'Sessions'], ['entries', 'Encyclopedia entries']], 'sessions', { name: 'sessions', 'aria-label': 'What dated events become' });
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
          btn('⬇ For Foundry…', exportSeasonsStars, 'small',
            'Download this calendar for Seasons & Stars, the calendar module most Foundry VTT worlds use, so Foundry shows the same months, weekdays, moons, seasons and holidays'),
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
      // Dice: who sees whose rolls, and how many the roll log keeps (api/dice.php reads them; static/dice-tab.js rolls).
      const dice = () => {
        const d = st.dice || {};
        const form = el('form', { class: 'card dice-settings' }, el('h2', {}, 'Dice'),
          el('p', { class: 'muted small' }, 'Anyone in the campaign rolls with the 🎲 button at the bottom right of every page. Rolls go in a log the whole table shares.'),
          el('div', { class: 'grid2' },
            field('Who sees a player\'s roll', select([['all', 'Everyone'], ['gm', 'The player and the GMs'], ['blind', 'Only the GMs (the player sees they rolled, not the result)']],
              d.player_vis || 'all', { name: 'player_vis' }), 'Where a player\'s roller starts. They can change it for each roll unless you lock it'),
            field('Roll log keeps', select([100, 200, 500, 1000, 2000, 5000].map(n => [n, `The last ${n} rolls`]), d.keep || 500, { name: 'keep' }),
              'Older rolls are deleted as new ones come in')),
          field('Players can\'t change who sees their rolls', el('input', { type: 'checkbox', name: 'lock_vis', checked: !!d.lock_vis })),
          field('GM rolls start hidden from players', el('input', { type: 'checkbox', name: 'gm_hidden', checked: !!d.gm_hidden }), 'A GM can still show any roll to everyone'),
          el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Save dice settings'),
            btn('Clear the roll log…', async () => {
              if (!await confirmDialog('Delete every roll in this campaign\'s roll log, for everyone? This can\'t be undone.', { ok: 'Clear the log', danger: true })) return;
              try { await post('dice_clear', {}, S.camp.id); toast('The roll log is empty'); } catch (err) { toast(err.message, true); }
            }, 'small danger', 'Delete every roll in the log, for everyone')));
        form.addEventListener('submit', async e => {
          e.preventDefault();
          const v = formData(form);
          const s = { ...settings(), dice: { player_vis: v.player_vis, keep: Number(v.keep), lock_vis: !!v.lock_vis, gm_hidden: !!v.gm_hidden } };
          try { await post('campaign_update', { settings: s }, S.camp.id); await loadCampaign(S.camp.id, true); toast('Saved'); route(); }
          catch (err) { toast(err.message, true); }
        });
        return form;
      };
      const tabs = el('nav', { class: 'settings-tabs', 'aria-label': 'Settings' }, SETTINGS_TABS.map(([k, label]) =>
        el('a', { href: `#/c/${S.camp.id}/settings${k === 'campaign' ? '' : '/' + k}`, class: k === at ? 'on' : '', ...(k === at ? { 'aria-current': 'page' } : {}) }, label)));
      const card = { campaign: () => general, calendar: () => calForm, dice, weather: tuningCard, tools: () => danger }[at]();
      card.prepend(tabs);
      mount(...campaignHeader('settings'), card);
    }

    return { SEASON_LABELS, seasonChip, seasonEditor, viewSettings };
  }
  root.SettingsTab = { make };
})(window);
