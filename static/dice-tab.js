/* dice-tab.js — The die roller: the 🎲 button on every campaign page and the panel it opens.
 *
 * The panel sits along the right of a wide screen (a desktop, an iPad held sideways) and pushes the page over, and is a
 * sheet over the bottom of a narrower one (an iPad held upright, a phone). Its roll log is the table's: everyone's rolls,
 * newest first, as far as each person may see them (api/dice.php). At the top, over the log, so they stay put as the
 * log grows: one tap rolls a single d4 to d100 or
 * a Fudge die, and the free-roll box takes anything the ? card lists.
 *
 * A roll is asked of the server, which picks its seed; static/dice.js works the dice out from it, the same on every
 * device. While the panel is open it asks for new rolls every few seconds; while it is closed, the campaign's change
 * check (every 30 seconds) says whether anyone rolled, and the button shows a dot.
 *
 * app.js calls make() once with its shared helpers and state (tabCtx). Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { S, api, el, isGM, post, toast } = ctx;
    const Dice = root.Dice, DS = root.DiceSystems, DiceUI = root.DiceUI, D3 = root.Dice3D;
    const ask = ctx.promptDialog;

    const QUICK = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', 'dF'];
    const POLL_MS = 4000;
    /** The ? card: what can go in the free-roll box. [write, means, example] */
    const HELP = [
      ['2d6+3', 'Roll 2 six-sided dice, add 3', '2d6+3'],
      ['d% · d100', 'Percentile die', 'd%'],
      ['dF', 'Fudge/Fate die (−1, 0, +1)', '4dF+2'],
      ['d66', 'Two d6 read as tens and units (11 to 66)', 'd66'],
      ['+ − × ÷ ( )', 'Maths with numbers or dice (÷ rounds down)', '1d8+1d6+2'],
      ['khN · klN', 'Keep highest / lowest N', '4d6kh3'],
      ['dhN · dlN', 'Drop highest / lowest N', '4d6dl1'],
      ['adv · dis', 'Advantage / disadvantage: 2d20, keep the higher / lower', 'adv+5'],
      ['!', 'Explode: a top roll rolls again and adds', '3d6!'],
      ['!>=N', 'Explode on N or more', '10d10!>=8'],
      ['!!', 'Compound: explosions add into one die', 'd6!!'],
      ['rN · r<N', 'Reroll Ns (and again if it comes up again)', '2d6r1'],
      ['roN', 'Reroll once', 'd20ro1'],
      ['>=N', 'Count successes instead of a total', '7d10>=6'],
      ['fN · f<=N', 'Each failure cancels a success', '7d10>=6f1'],
      ['d100bN · d100pN', 'Bonus / penalty dice: N extra tens dice, keep the best / worst', 'd100b1'],
      ['d100flip', 'Flip-flop: read both ways round, keep the lower', 'd100flip'],
      ['d100swap', 'Read the digits the other way round (73 is 37)', 'd100swap'],
      ['Nx(…)', 'Repeat the roll N times', '6x(4d6kh3)'],
      ['# text', 'Label the roll', 'd8+3 # longsword'],
    ];
    const VIS_PLAYER = [['all', 'Everyone', 'Everyone at the table sees this roll'],
      ['gm', 'Me + GM', 'Only you and the GMs see this roll'],
      ['blind', 'GM only', 'Only the GMs see what you rolled; you see that you rolled']];
    const VIS_GM = [['all', 'Everyone', 'Everyone at the table sees this roll'], ['gm', 'GMs only', 'Only the GMs see this roll']];

    let cid = null, rolls = [], lastId = 0, seenId = 0, settings = null, pollTimer = null, loading = null, fresh = new Set();
    // The campaign's dice system (Settings → Dice), the numbers on the roller now, and which kind of roll is showing.
    let sysNow = null, sysSig = '', sysP = null, mode = 'free', oddsTimer = null, busy = false;
    // The roll whose 3D dice are in the air: its result in the log waits for them to land.
    let landingId = 0;
    const store = {
      get: k => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
    };
    const openKey = () => `chronicle-dice-open-${cid}`;
    const seenKey = () => `chronicle-dice-seen-${cid}`;
    const visKey = () => `chronicle-dice-vis-${cid}`;
    const modeKey = () => `chronicle-dice-mode-${cid}`;
    const sysKey = () => `chronicle-dice-sys-${cid}`;
    const MORE_KEY = 'chronicle-dice-more';
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ------------------------------------------------------------ the button and the panel
    const dot = el('span', { class: 'dice-dot', hidden: true, 'aria-hidden': 'true' });
    const fab = el('button', { type: 'button', class: 'dice-fab', hidden: true, 'aria-label': 'Dice roller', 'aria-expanded': 'false', 'data-tip': 'Roll dice. Everyone at the table sees the log' },
      pileIcon(), dot);
    /** The button's picture: a d20 with a d4 and a d6 in front of it, drawn in the theme's colours. */
    function pileIcon() {
      const span = el('span', { class: 'dice-pile', 'aria-hidden': 'true' });
      span.innerHTML = `<svg viewBox="0 0 48 48" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">
        <g class="pd20"><path d="M19 4 31.6 11.3v14.6L19 33.2 6.4 25.9V11.3Z"/><path d="M19 11 27.6 25 10.4 25Z M19 4v7 M6.4 11.3 19 11 M31.6 11.3 19 11 M6.4 11.3l4 13.7 M31.6 11.3l-4 13.7 M6.4 25.9l4-.9 M31.6 25.9l-4-.9 M19 33.2l-8.6-8.2 M19 33.2l8.6-8.2" fill="none"/></g>
        <g class="pd4"><path d="M14 25.5 3.5 43 14.5 46.5 24.5 41Z"/><path d="M14 25.5 14.5 46.5" fill="none"/></g>
        <g class="pd6"><path d="M34 22 44.5 27.2 34 32.4 23.5 27.2Z"/><path d="M23.5 27.2 34 32.4V45L23.5 39.6Z"/><path d="M34 32.4 44.5 27.2V39.6L34 45Z"/>
          <g fill="currentColor" stroke="none"><circle cx="34" cy="27.2" r="1.6"/><circle cx="26.3" cy="32" r="1.3"/><circle cx="31.2" cy="40.2" r="1.3"/><circle cx="36.7" cy="40.2" r="1.3"/><circle cx="39.25" cy="36.1" r="1.3"/><circle cx="41.8" cy="32" r="1.3"/></g></g>
      </svg>`;
      return span;
    }
    const log = el('ol', { class: 'dice-log', 'aria-live': 'polite', 'aria-label': 'Rolls, newest first' });
    const input = el('input', { type: 'text', class: 'dice-input', placeholder: 'Free roll: 1d10, 2d6+3, 4d6kh3…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': 'Free roll', maxlength: String(Dice.LIMITS.length) });
    const err = el('div', { class: 'dice-err small', role: 'alert' });
    const helpBtn = el('button', { type: 'button', class: 'dice-q', 'aria-label': 'How to write a free roll', 'aria-expanded': 'false', 'data-tip': 'Everything you can type in the free-roll box' }, '?');
    const rollBtn = el('button', { type: 'button', class: 'primary dice-go' }, 'Roll');
    const visSel = el('select', { class: 'dice-vis', 'aria-label': 'Who sees the roll' });
    const visFixed = el('span', { class: 'dice-vis-fixed small muted', hidden: true });
    const help = el('div', { class: 'dice-help', hidden: true, role: 'dialog', 'aria-label': 'Writing a free roll' },
      el('div', { class: 'dice-help-h' }, el('h3', {}, 'Writing a free roll'),
        el('button', { type: 'button', class: 'link', 'aria-label': 'Close', onclick: () => showHelp(false) }, '✕')),
      el('table', {}, el('tbody', {}, HELP.map(([w, means, ex]) => el('tr', {},
        el('td', { class: 'mono w' }, w),
        el('td', {}, means, ' ', el('button', { type: 'button', class: 'link mono dice-ex', 'data-tip': 'Put this in the box', onclick: () => { input.value = ex; check(); showHelp(false); input.focus(); } }, ex)))))),
      el('p', { class: 'small muted' }, 'Tap an example to put it in the box. Spaces and capitals don\'t matter.'));
    const quick = el('div', { class: 'dice-quick', role: 'group', 'aria-label': 'Roll one die' },
      QUICK.map(q => el('button', { type: 'button', class: 'dice-chip', 'data-tip': `Roll one ${q}`, onclick: () => roll(q === 'dF' ? '1dF' : `1${q}`) }, q)));
    const sub = el('span', { class: 'dice-sub small muted' }, 'Free dice');

    // The game roll: the campaign's dice system, its numbers, the odds, and a Roll button.
    const tabGame = el('button', { type: 'button', role: 'tab', class: 'dice-tab', id: 'dice-tab-game', 'aria-controls': 'dice-sys' }, 'Game roll');
    const tabFree = el('button', { type: 'button', role: 'tab', class: 'dice-tab', id: 'dice-tab-free', 'aria-controls': 'dice-free' }, 'Free roll');
    const modes = el('div', { class: 'dice-modes', role: 'tablist', 'aria-label': 'Kind of roll', hidden: true }, tabGame, tabFree);
    const forInput = el('input', { type: 'text', class: 'dice-for', placeholder: 'Roll for… (optional)', maxlength: '60', autocomplete: 'off', 'aria-label': 'What the roll is for' });
    const mainBox = el('div', { class: 'dsp-grid' });
    const moreBox = el('div', { class: 'dsp-grid' });
    const more = el('details', { class: 'dice-more' }, el('summary', { class: 'small' }, 'More options'), moreBox);
    const odds = DiceUI.oddsBar(el);
    const sysNotation = el('span', { class: 'dice-sys-n mono' });
    const sysRollBtn = el('button', { type: 'button', class: 'primary dice-go dice-sys-go' }, el('span', {}, 'Roll'), sysNotation);
    const sysBox = el('div', { class: 'dice-sys', id: 'dice-sys', role: 'tabpanel', 'aria-labelledby': 'dice-tab-game', hidden: true },
      mainBox, more, odds.node,
      el('div', { class: 'dice-row' }, forInput, sysRollBtn));
    const freeBox = el('div', { class: 'dice-free', id: 'dice-free', role: 'tabpanel', 'aria-labelledby': 'dice-tab-free' }, quick,
      el('div', { class: 'dice-row' }, input, helpBtn, rollBtn));

    // Saved rolls: this person's, in this campaign (their account prefs, so they follow them to another device).
    const savedSel = el('select', { class: 'dice-saved', 'aria-label': 'Saved rolls' });
    const saveBtn = el('button', { type: 'button', class: 'small dice-save', 'data-tip': 'Save the roll as it is now, with a name, to roll again later' }, '☆ Save');
    const forgetBtn = el('button', { type: 'button', class: 'small dice-forget', hidden: true, 'aria-label': 'Forget this saved roll', 'data-tip': 'Forget this saved roll' }, '🗑');
    const who = el('label', { class: 'dice-who small muted', 'data-tip': 'Who sees the rolls you make' }, el('span', { 'aria-hidden': 'true' }, '👁'), visSel, visFixed);
    const savedRow = el('div', { class: 'dice-saved-row' }, savedSel, saveBtn, forgetBtn, who);

    // Pinned beside the page (it moves over) or floating over it (nothing moves): 📌 switches, remembered on this device.
    // Until someone picks, a mouse and keyboard pin it and a touch screen floats it.
    const PIN_KEY = 'chronicle-dice-pin';
    const pinBtn = el('button', { type: 'button', class: 'dice-pin', 'aria-label': 'Pin the roller beside the page' }, '📌');
    const pinned = () => { const v = store.get(PIN_KEY); return v ? v === 'pin' : matchMedia('(hover: hover) and (pointer: fine)').matches; };
    function drawPin() {
      const on = pinned();
      document.body.classList.toggle('dice-float', !on);
      pinBtn.setAttribute('aria-pressed', String(on));
      pinBtn.dataset.tip = on ? 'Pinned beside the page. Tap to float it over the page instead' : 'Floating over the page. Tap to pin it beside the page instead';
    }
    pinBtn.addEventListener('click', () => { store.set(PIN_KEY, pinned() ? 'float' : 'pin'); drawPin(); });
    drawPin();
    const lookBtn = el('button', { type: 'button', class: 'dice-look-b', 'aria-label': 'Your dice: colours and 3D', 'aria-expanded': 'false', 'data-tip': 'Your dice: their colours, their pattern and 3D' }, '🎨');
    const lookCard = el('div', { class: 'dice-help dice-look', hidden: true, role: 'dialog', 'aria-label': 'Your dice' });
    lookBtn.addEventListener('click', () => showLook(lookCard.hidden));
    const panel = el('section', { class: 'dice-panel', hidden: true, role: 'region', 'aria-label': 'Dice roller' },
      el('div', { class: 'dice-head' }, el('h2', {}, '🎲 Dice'), sub,
        lookBtn, pinBtn,
        el('button', { type: 'button', class: 'dice-x', 'aria-label': 'Close the dice roller', 'data-tip': 'Close. The log keeps everyone\'s rolls', onclick: () => setOpen(false) }, '✕')),
      el('div', { class: 'dice-foot' }, modes, sysBox, freeBox, err, savedRow),
      el('div', { class: 'dice-body' }, log, help, lookCard));
    document.body.append(fab, panel);

    fab.addEventListener('click', () => setOpen(true));
    helpBtn.addEventListener('click', () => showHelp(help.hidden));
    rollBtn.addEventListener('click', () => roll(input.value));
    sysRollBtn.addEventListener('click', rollGame);
    forInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); rollGame(); } });
    tabGame.addEventListener('click', () => setMode('game', true));
    tabFree.addEventListener('click', () => setMode('free', true));
    modes.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      setMode(mode === 'game' ? 'free' : 'game', true);
      (mode === 'game' ? tabGame : tabFree).focus();
    });
    more.addEventListener('toggle', () => store.set(MORE_KEY, more.open ? '1' : null));
    savedSel.addEventListener('change', () => useSaved(Number(savedSel.value)));
    saveBtn.addEventListener('click', saveRoll);
    forgetBtn.addEventListener('click', forgetRoll);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roll(input.value); } });
    input.addEventListener('input', () => { if (err.textContent) check(); });
    visSel.addEventListener('change', () => store.set(visKey(), visSel.value));
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!help.hidden) showHelp(false); else if (!lookCard.hidden) showLook(false); else setOpen(false);
      e.stopPropagation();
    });

    function showHelp(on) {
      if (on) showLook(false);
      help.hidden = !on;
      helpBtn.setAttribute('aria-expanded', String(on));
      helpBtn.classList.toggle('on', on);
    }
    /** Says what is wrong with the free roll, if anything; true when it reads. */
    function check() {
      const msg = input.value.trim() ? Dice.check(input.value) : null;
      err.textContent = msg || '';
      input.classList.toggle('bad', !!msg);
      return !msg;
    }
    function isOpen() { return !panel.hidden; }
    function setOpen(on) {
      if (!cid) return;
      panel.hidden = !on;
      fab.hidden = on;
      fab.setAttribute('aria-expanded', String(on));
      document.body.classList.toggle('dice-open', on);
      store.set(openKey(), on ? '1' : null);
      if (on) {
        showHelp(false);
        load().then(() => { markSeen(); });
        startPoll();
        if (matchMedia('(hover: hover)').matches) (mode === 'game' ? sysRollBtn : input).focus({ preventScroll: true });
      } else {
        stopPoll();
        showLook(false);
        D3?.stop();
        fab.focus({ preventScroll: true });
      }
    }

    // ------------------------------------------------------------ the log
    function drawVis() {
      const opts = isGM() ? VIS_GM : VIS_PLAYER;
      const locked = !isGM() && settings?.lock_vis;
      const def = isGM() ? (settings?.gm_hidden ? 'gm' : 'all') : (settings?.player_vis || 'all');
      const want = locked ? def : (store.get(visKey()) || def);
      visSel.replaceChildren(...opts.map(([v, l, t]) => el('option', { value: v, title: t, selected: v === want }, l)));
      if (!opts.some(([v]) => v === want)) visSel.value = def;
      visSel.hidden = !!locked;
      visFixed.hidden = !locked;
      visFixed.textContent = locked ? `${(opts.find(([v]) => v === def) || opts[0])[1]} (set by the GM)` : '';
    }
    async function load() {
      if (loading) return loading;
      const at = cid;
      loading = (async () => {
        try {
          const r = await api('dice_rolls', { query: lastId ? { cid: at, after: lastId } : { cid: at } });
          if (at !== cid) return;
          settings = r.settings;
          drawVis();
          drawSys();
          take(r.rolls, !!lastId);
        } catch { /* offline for a moment: the next poll tries again */ } finally { loading = null; }
      })();
      return loading;
    }
    /** Add rolls from the server to the log; animate them when they are news. */
    function take(list, news) {
      const known = new Set(rolls.map(r => r.id));
      let toss = null;
      for (const r of list) {
        if (known.has(r.id)) continue;
        if (r.mine && S.user) r.look = myLook();     // what this page has just picked, even before the account has it
        rolls.push(r);
        if (news) fresh.add(r.id);
        if (fresh.has(r.id) && (!toss || r.id > toss.id)) toss = r;
        lastId = Math.max(lastId, r.id);
      }
      rolls.sort((a, b) => a.id - b.id);
      if (rolls.length > 200) rolls = rolls.slice(-200);
      if (toss && isOpen() && toss.id === rolls[rolls.length - 1].id) throw3d(toss);
      draw();
      if (isOpen()) markSeen();
    }
    /** Throw a roll's dice in 3D over the page, in its roller's colours; its result in the log shows once they land. */
    function throw3d(r) {
      if (!D3 || r.seed === null) return;
      let res;
      try { res = Dice.roll(r.expr, r.seed); } catch { return; }
      if (!D3.can(res)) return;
      landingId = r.id;
      const done = () => {
        if (landingId !== r.id) return;
        landingId = 0;
        const li = log.querySelector(`[data-id="${r.id}"]`);
        li?.classList.remove('landing');
      };
      D3.toss(res, r.look).then(done, done);
      setTimeout(done, 4000);      // never leave a result hidden
    }
    function draw() {
      if (!rolls.length) {
        log.replaceChildren(el('li', { class: 'dice-empty muted' }, 'No rolls yet. Tap a die above, or type a roll and press Roll.'));
        return;
      }
      log.replaceChildren(...rolls.slice().reverse().map((r, k) => entry(r, k === 0)));
      fresh.clear();
    }
    const when = at => {
      const t = new Date(String(at).replace(' ', 'T'));
      const s = (Date.now() - t.getTime()) / 1000;
      if (!isFinite(s)) return '';
      if (s < 45) return 'just now';
      if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
      return t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };
    const VIS_MARK = { gm: ['🔒', 'Only the roller and the GMs see this roll'], blind: ['🙈', 'Only the GMs see what was rolled'] };
    /** One roll in the log: who and what for, the result (as the campaign's dice system reads it, if it has one), what
     * was rolled, and its dice. */
    function entry(r, latest) {
      const head = el('div', { class: 'dice-e-top' });
      const out = el('div', { class: 'dice-e-out' });
      const body = el('div', { class: 'dice-e-dice' });
      const meta = el('div', { class: 'dice-e-meta small muted' });
      const mark = VIS_MARK[r.visibility];
      let label = '', big = '?', words = '', tier = null, note = null, sysName = '';
      if (r.seed === null) {
        words = 'Rolled for the GM';
        try { label = Dice.parse(r.expr).label; } catch { /* unreadable: no label either */ }
      } else {
        try {
          const res = Dice.roll(r.expr, r.seed);
          const o = DiceUI.outcome(res, { table: sysNow?.table });
          label = res.label;
          ({ big, words, tier, note } = o);
          if (o.sys && o.sys.id !== sysNow?.sys.id) sysName = o.sys.name;
          body.append(...DiceUI.diceRows(el, res, { animate: fresh.has(r.id) && !reduced() && landingId !== r.id, faces: o.faces, look: r.look }));
        } catch (e) {
          big = '—';
          words = 'Can\'t read this roll';
        }
      }
      head.append(el('span', { class: 'dice-e-who' }, r.author || 'Someone', label ? el('span', { class: 'muted' }, ` · ${label}`) : null,
        mark ? el('span', { class: 'dice-e-vis', title: mark[1], 'aria-label': mark[1] }, ` ${mark[0]}`) : null));
      out.append(el('b', {}, big));
      if (words) out.append(el('small', { class: tier ? `tier t-${tier}` : null }, words));
      const exprText = r.expr.split('#')[0].split('@')[0].trim();
      meta.append(...[el('span', { class: 'mono' }, exprText), sysName && ` · ${sysName}`, note && ` · ${note}`, ` · ${when(r.at)}`].filter(Boolean));
      return el('li', { 'data-id': String(r.id), class: 'dice-e' + (latest ? ' latest' : '') + (r.visibility !== 'all' ? ' hidden-roll' : '') + (fresh.has(r.id) ? ' fresh' : '') + (tier ? ` t-${tier}` : '') + (landingId === r.id ? ' landing' : '') },
        el('div', { class: 'dice-e-main' }, head, meta, body), out);
    }

    // ------------------------------------------------------------ rolling
    async function roll(text) {
      if (busy) return;
      const expr = String(text || '').trim();
      if (!expr) { err.textContent = 'Type a roll, like 2d6+3'; input.focus(); return; }
      const msg = Dice.check(expr);
      if (msg) { err.textContent = msg; input.classList.add('bad'); input.focus(); return; }
      err.textContent = '';
      input.classList.remove('bad');
      busy = true;
      rollBtn.disabled = sysRollBtn.disabled = true;
      quick.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        const r = await post('dice_roll', { expr, engine: Dice.VERSION, visibility: visSel.value }, cid);
        if (text === input.value) input.select?.();
        fresh.add(r.roll.id);
        await load();          // anything rolled since the last poll, then this one, in order
        take([r.roll], true);
      } catch (e) { toast(e.message, true); } finally {
        busy = false;
        rollBtn.disabled = sysRollBtn.disabled = false;
        quick.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    }

    // ------------------------------------------------------------ the game roll
    /** Show the game roll or the free roll. A campaign with no dice system has only the free roll. */
    function setMode(m, remember) {
      mode = sysNow && m === 'game' ? 'game' : 'free';
      modes.hidden = !sysNow;
      sysBox.hidden = mode !== 'game';
      freeBox.hidden = mode !== 'free';
      tabGame.setAttribute('aria-selected', String(mode === 'game'));
      tabFree.setAttribute('aria-selected', String(mode === 'free'));
      tabGame.tabIndex = mode === 'game' ? 0 : -1;
      tabFree.tabIndex = mode === 'free' ? 0 : -1;
      if (mode !== 'free') showHelp(false);
      err.textContent = '';
      if (remember) store.set(modeKey(), mode);
      drawSaved();
    }
    /** The campaign's dice system, as the server last said (settings.system): redrawn only when the GM changed it. */
    function drawSys() {
      const sig = JSON.stringify(settings?.system || null);
      if (sig === sysSig) return;
      sysSig = sig;
      sysNow = DS.campaignSystem(settings);
      const preset = sysNow?.game ? DS.PRESETS.find(g => g.id === sysNow.game) : null;
      sub.textContent = sysNow ? (preset ? preset.name : sysNow.sys.name) : 'Free dice';
      sub.title = sub.textContent;
      if (sysNow) {
        let mine = null;
        try { mine = JSON.parse(store.get(sysKey()) || 'null'); } catch { /* start from the campaign's */ }
        sysP = DS.params(sysNow.sys, sysNow.p, mine && mine.id === sysNow.sys.id ? mine.p : null);
        drawFields();
      }
      setMode(store.get(modeKey()) || 'game');
      draw();
    }
    function drawFields() {
      const { sys, labels } = sysNow;
      const main = sys.params.filter(d => d.main).map(d => d.key);
      const rest = sys.params.filter(d => !d.main).map(d => d.key);
      const onChange = (k, v) => { sysP = DS.params(sys, { ...sysP, [k]: v }); store.set(sysKey(), JSON.stringify({ id: sys.id, p: sysP })); refreshSys(); };
      mainBox.replaceChildren(...DiceUI.fields(el, sys, sysP, { labels, keys: main, onChange, idPrefix: 'dice' }));
      moreBox.replaceChildren(...DiceUI.fields(el, sys, sysP, { labels, keys: rest, onChange, idPrefix: 'dice' }));
      more.hidden = !rest.length;
      more.open = !!store.get(MORE_KEY);
      refreshSys();
    }
    /** The dice the numbers make, and (a moment after the last change) the odds of each outcome. */
    function refreshSys() {
      if (!sysNow) return;
      const text = sysNow.sys.build(sysP);
      sysNotation.textContent = text;
      sysRollBtn.setAttribute('aria-label', `Roll ${text}`);
      clearTimeout(oddsTimer);
      oddsTimer = setTimeout(() => {
        try { odds.set(DS.odds(sysNow.sys, sysP, { table: sysNow.table }, 2000)); } catch { odds.set(null); }
      }, 120);
      if (savedSel.value) { const s = savedList()[Number(savedSel.value) - 1]; if (s && s.e !== gameText()) { savedSel.value = ''; forgetBtn.hidden = true; } }
    }
    /** The game roll as it is stored: its dice, @ the system and its numbers, # what it is for (cut to fit). */
    function gameText() {
      let label = forInput.value.trim();
      let t = DS.rollText(sysNow.sys, sysP, label);
      while (t.length > Dice.LIMITS.length && label) { label = label.slice(0, -1).trim(); t = DS.rollText(sysNow.sys, sysP, label); }
      return t;
    }
    function rollGame() { if (sysNow) roll(gameText()); }

    // ------------------------------------------------------------ saved rolls
    const savedList = () => (cid && S.user?.prefs?.dice_saved?.[cid]) || [];
    function drawSaved() {
      const list = savedList();
      savedSel.replaceChildren(el('option', { value: '' }, list.length ? `Saved rolls (${list.length})` : 'No saved rolls yet'),
        ...list.map((r, k) => el('option', { value: String(k + 1) }, r.n)));
      savedSel.disabled = !list.length;
      forgetBtn.hidden = true;
    }
    /** Put a saved roll on the roller: its numbers on the game roll if it is one of this campaign's system, else in the
     * free-roll box (which rolls anything, a roll from another system included). */
    function useSaved(k) {
      const r = savedList()[k - 1];
      forgetBtn.hidden = !r;
      if (!r) return;
      let parsed = null;
      try { parsed = Dice.parse(r.e); } catch { /* still goes in the box, which says what is wrong */ }
      const d = parsed?.system ? DS.decode(parsed.system) : null;
      if (d && sysNow && d.sys.id === sysNow.sys.id) {
        setMode('game', true);
        sysP = d.p;
        store.set(sysKey(), JSON.stringify({ id: sysNow.sys.id, p: sysP }));
        forInput.value = parsed.label || '';
        drawFields();
      } else {
        setMode('free', true);
        input.value = r.e;
        check();
      }
      savedSel.value = String(k);
      forgetBtn.hidden = false;
    }
    async function putSaved(list) {
      const r = await post('prefs_save', { dice_saved: { cid, list } });
      if (S.user) S.user.prefs = r.prefs;
      drawSaved();
    }
    async function saveRoll() {
      const e = mode === 'game' && sysNow ? gameText() : input.value.trim();
      if (!e) { err.textContent = 'Type a roll first, then save it'; return; }
      const msg = Dice.check(e);
      if (msg) { err.textContent = msg; return; }
      let guess = '';
      try { guess = Dice.parse(e).label; } catch { /* no label */ }
      const name = await ask('A name for this roll, to find it in the list:', { title: 'Save this roll', value: guess || e.split('#')[0].split('@')[0].trim(), ok: 'Save' });
      if (name === null || !name.trim()) return;
      const list = savedList().filter(r => r.n !== name.trim());
      if (list.length >= 100) { toast('That is a lot of saved rolls: forget one first', true); return; }
      try {
        await putSaved([...list, { n: name.trim().slice(0, 60), e }]);
        const k = savedList().findIndex(r => r.n === name.trim().slice(0, 60));
        savedSel.value = String(k + 1);
        forgetBtn.hidden = k < 0;
        toast(`Saved "${name.trim()}"`);
      } catch (x) { toast(x.message, true); }
    }
    async function forgetRoll() {
      const k = Number(savedSel.value);
      const r = savedList()[k - 1];
      if (!r) return;
      try { await putSaved(savedList().filter((_, i) => i !== k - 1)); toast(`Forgot "${r.n}"`); } catch (x) { toast(x.message, true); }
    }

    // ------------------------------------------------------------ your dice
    // How this person's dice look: a colour, a colour for the numbers and a pattern (their account's, so every table
    // sees their rolls in it), and whether this device throws 3D dice.
    const myLook = () => S.user?.prefs?.dice_look || null;
    let lookTimer = null;
    function showLook(on) {
      if (on) { showHelp(false); drawLook(); }
      lookCard.hidden = !on;
      lookBtn.setAttribute('aria-expanded', String(on));
      lookBtn.classList.toggle('on', on);
    }
    function drawLook() {
      const cur = myLook(), shown = cur || D3.themeLook();
      const set = look => { setLook(look); drawLook(); };
      const swatch = (look, name, current, reset) => el('button', { type: 'button', class: 'dice-sw' + (current ? ' on' : ''), 'aria-label': name, 'aria-pressed': String(!!current), 'data-tip': name,
        style: { background: look.body, color: look.ink }, onclick: () => set(reset ? null : { ...look, tex: cur?.tex || '' }) }, '6');
      const theme = D3.themeLook();
      const body = el('input', { type: 'color', value: shown.body, 'aria-label': 'Colour of the dice',
        onchange: e => set({ body: e.target.value, ink: D3.inkFor(e.target.value), tex: shown.tex || '' }) });
      const ink = el('input', { type: 'color', value: shown.ink, 'aria-label': 'Colour of the numbers',
        onchange: e => set({ ...shown, ink: e.target.value }) });
      const tex = el('select', { 'aria-label': 'Pattern', onchange: e => set({ ...shown, tex: e.target.value }) },
        D3.TEXTURES.map(([v, l]) => el('option', { value: v, selected: v === (shown.tex || '') }, l)));
      const still = el('canvas', { class: 'dice-look-3d', width: '192', height: '192', 'aria-hidden': 'true' });
      const flat = el('div', { class: 'dice-look-flat', 'aria-hidden': 'true' });
      const res = { results: [{ terms: [{ src: 'd20', sides: 20, dice: [{ v: 20, rolls: [20], rerolled: [] }] }, { src: 'd6', sides: 6, dice: [{ v: 3, rolls: [3], rerolled: [] }, { v: 6, rolls: [6], rerolled: [] }] }], total: 29 }] };
      flat.append(...DiceUI.diceRows(el, res, { look: shown }));
      const slow = matchMedia('(prefers-reduced-motion: reduce)').matches, no3d = !D3.available();
      const on3d = el('input', { type: 'checkbox', checked: D3.enabled() && !slow && !no3d, disabled: slow || no3d,
        onchange: e => { D3.setEnabled(e.target.checked); drawLook(); } });
      lookCard.replaceChildren(
        el('div', { class: 'dice-help-h' }, el('h3', {}, 'Your dice'),
          el('button', { type: 'button', class: 'link', 'aria-label': 'Close', onclick: () => showLook(false) }, '✕')),
        el('p', { class: 'small muted' }, 'Everyone at the table sees your rolls in these colours, in every campaign you play in.'),
        el('div', { class: 'dice-look-grid' },
          el('div', { class: 'dice-look-pre' }, still, flat),
          el('div', {},
            el('div', { class: 'dice-sws', role: 'group', 'aria-label': 'Dice colours' },
              swatch(theme, 'The theme\'s colours', !cur, true), ...D3.SWATCHES.map(([b, i, n]) => swatch({ body: b, ink: i }, n, cur && cur.body === b && cur.ink === i))),
            el('div', { class: 'dice-look-row' },
              el('label', {}, body, ' Dice'), el('label', {}, ink, ' Numbers')),
            el('label', { class: 'dice-look-row' }, 'Pattern ', tex))),
        el('label', { class: 'dice-look-row small' }, on3d, ' Throw 3D dice on this device',
          no3d ? el('span', { class: 'muted' }, ' (this browser can\'t draw 3D)') : slow ? el('span', { class: 'muted' }, ' (off: this device asks for less motion)') : null));
      if (D3.enabled() && !slow && !no3d) D3.still(still, shown).then(ok => { still.hidden = !ok; }); else still.hidden = true;
    }
    /** Keep a new look: at once on this page, and on the account a moment later (so a run of changes is one save). */
    function setLook(look) {
      if (S.user) S.user.prefs = { ...(S.user.prefs || {}), dice_look: look };
      if (!look && S.user?.prefs) delete S.user.prefs.dice_look;
      for (const r of rolls) if (r.mine) r.look = look;
      draw();
      clearTimeout(lookTimer);
      lookTimer = setTimeout(async () => {
        try { const r = await post('prefs_save', { dice_look: look }); if (S.user) S.user.prefs = r.prefs; } catch (x) { toast(x.message, true); }
      }, 500);
    }

    // ------------------------------------------------------------ keeping up
    function startPoll() {
      stopPoll();
      pollTimer = setInterval(() => { if (!document.hidden && isOpen()) load(); }, POLL_MS);
    }
    function stopPoll() { clearInterval(pollTimer); pollTimer = null; }
    function markSeen() {
      seenId = Math.max(seenId, lastId);
      store.set(seenKey(), String(seenId));
      dot.hidden = true;
    }
    /** The campaign's change check found the newest roll this person may see: a dot on the button if it is news. */
    function notice(last) {
      if (!cid || !last) return;
      if (isOpen()) { if (last > lastId) load(); return; }
      dot.hidden = !(last > seenId);
    }

    /** After every page draws: the button on a campaign's pages, the panel as it was left in this campaign. */
    function sync() {
      const inCamp = !!S.camp && location.hash.startsWith(`#/c/${S.camp.id}`);
      const next = inCamp ? S.camp.id : null;
      if (next !== cid) {
        stopPoll();
        cid = next;
        rolls = []; lastId = 0; settings = null; fresh.clear();
        sysNow = null; sysSig = ''; sysP = null; forInput.value = '';
        log.replaceChildren();
        panel.hidden = true;
        document.body.classList.remove('dice-open');
        dot.hidden = true;
        if (cid) {
          seenId = Number(store.get(seenKey())) || 0;
          drawVis();
          setMode('free');
          if (store.get(openKey())) setOpen(true);
        }
      }
      showHelp(false);
      fab.hidden = !cid || isOpen();
      if (!cid) panel.hidden = true;
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && isOpen()) load(); });

    return { diceSync: sync, diceNotice: notice };
  }
  root.DiceTab = { make };
})(window);
