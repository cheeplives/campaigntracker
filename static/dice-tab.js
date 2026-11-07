/* dice-tab.js — The die roller: the 🎲 button on every campaign page and the panel it opens.
 *
 * The panel sits along the right of a wide screen (a desktop, an iPad held sideways) and pushes the page over, and is a
 * sheet over the bottom of a narrower one (an iPad held upright, a phone). Its roll log is the table's: everyone's rolls,
 * newest first, as far as each person may see them (api/dice.php). At the bottom: one tap rolls a single d4 to d100 or
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
    const Dice = root.Dice;

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
    const store = {
      get: k => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
    };
    const openKey = () => `chronicle-dice-open-${cid}`;
    const seenKey = () => `chronicle-dice-seen-${cid}`;
    const visKey = () => `chronicle-dice-vis-${cid}`;
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ------------------------------------------------------------ the button and the panel
    const dot = el('span', { class: 'dice-dot', hidden: true, 'aria-hidden': 'true' });
    const fab = el('button', { type: 'button', class: 'dice-fab', hidden: true, 'aria-label': 'Dice roller', 'aria-expanded': 'false', 'data-tip': 'Roll dice. Everyone at the table sees the log' },
      el('span', { 'aria-hidden': 'true' }, '🎲'), dot);
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
    const panel = el('section', { class: 'dice-panel', hidden: true, role: 'region', 'aria-label': 'Dice roller' },
      el('div', { class: 'dice-head' }, el('h2', {}, '🎲 Dice'), sub,
        el('button', { type: 'button', class: 'dice-x', 'aria-label': 'Close the dice roller', 'data-tip': 'Close. The log keeps everyone\'s rolls', onclick: () => setOpen(false) }, '✕')),
      log,
      el('div', { class: 'dice-foot' }, help, quick,
        el('div', { class: 'dice-row' }, input, helpBtn, rollBtn),
        err,
        el('label', { class: 'dice-who small muted' }, el('span', {}, '👁 Who sees it'), visSel, visFixed)));
    document.body.append(fab, panel);

    fab.addEventListener('click', () => setOpen(true));
    helpBtn.addEventListener('click', () => showHelp(help.hidden));
    rollBtn.addEventListener('click', () => roll(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); roll(input.value); } });
    input.addEventListener('input', () => { if (err.textContent) check(); });
    visSel.addEventListener('change', () => store.set(visKey(), visSel.value));
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!help.hidden) showHelp(false); else setOpen(false);
      e.stopPropagation();
    });

    function showHelp(on) {
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
        if (matchMedia('(hover: hover)').matches) input.focus({ preventScroll: true });
      } else {
        stopPoll();
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
          take(r.rolls, !!lastId);
        } catch { /* offline for a moment: the next poll tries again */ } finally { loading = null; }
      })();
      return loading;
    }
    /** Add rolls from the server to the log; animate them when they are news. */
    function take(list, news) {
      const known = new Set(rolls.map(r => r.id));
      for (const r of list) {
        if (known.has(r.id)) continue;
        rolls.push(r);
        if (news) fresh.add(r.id);
        lastId = Math.max(lastId, r.id);
      }
      rolls.sort((a, b) => a.id - b.id);
      if (rolls.length > 200) rolls = rolls.slice(-200);
      draw();
      if (isOpen()) markSeen();
    }
    function draw() {
      if (!rolls.length) {
        log.replaceChildren(el('li', { class: 'dice-empty muted' }, 'No rolls yet. Tap a die below, or type a roll and press Roll.'));
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
    /** One roll in the log: who and what for, the result, what was rolled, and its dice. */
    function entry(r, latest) {
      const head = el('div', { class: 'dice-e-top' });
      const out = el('div', { class: 'dice-e-out' });
      const body = el('div', { class: 'dice-e-dice' });
      const mark = VIS_MARK[r.visibility];
      let label = '', resultText = '?', words = '';
      if (r.seed === null) {
        words = 'Rolled for the GM';
        try { label = Dice.parse(r.expr).label; } catch { /* unreadable: no label either */ }
      } else {
        try {
          const res = Dice.roll(r.expr, r.seed);
          label = res.label;
          resultText = Dice.summary(res);
          res.results.forEach((one, k) => body.append(resultDice(one, res.repeat ? k + 1 : 0, fresh.has(r.id) && !reduced())));
          const m = res.results.length === 1 && res.results[0].mode === 'successes';
          if (m) { const n = res.results[0].total; resultText = String(n); words = `success${Math.abs(n) === 1 ? '' : 'es'}`; }
        } catch (e) {
          resultText = '—';
          words = 'Can\'t read this roll';
        }
      }
      head.append(el('span', { class: 'dice-e-who' }, r.author || 'Someone', label ? el('span', { class: 'muted' }, ` · ${label}`) : null,
        mark ? el('span', { class: 'dice-e-vis', title: mark[1], 'aria-label': mark[1] }, ` ${mark[0]}`) : null));
      out.append(el('b', {}, resultText));
      if (words) out.append(el('small', {}, words));
      const exprText = r.expr.split('#')[0].trim();
      return el('li', { class: 'dice-e' + (latest ? ' latest' : '') + (r.visibility !== 'all' ? ' hidden-roll' : '') + (fresh.has(r.id) ? ' fresh' : '') },
        el('div', { class: 'dice-e-main' }, head, el('div', { class: 'dice-e-meta small muted' }, el('span', { class: 'mono' }, exprText), ` · ${when(r.at)}`), body), out);
    }
    /** The dice of one result, term by term; a repeat says which go it was. */
    function resultDice(one, go, animate) {
      const row = el('div', { class: 'dice-terms' });
      if (go) row.append(el('span', { class: 'dice-go-n small muted' }, `#${go} = ${one.total}`));
      for (const t of one.terms) {
        const g = el('span', { class: 'dice-term', title: t.src }, t.dice.map(d => die(d, t, animate)));
        row.append(g);
      }
      return row;
    }
    const show = (t, v) => (t.sides === 'F' ? (v > 0 ? '+' : v < 0 ? '−' : '0') : String(v));
    function die(d, t, animate) {
      const cls = ['die', t.sides === 'F' ? 'dF' : `d${t.sides}`];
      if (d.dropped) cls.push('dropped');
      if (d.success) cls.push('hit');
      if (d.fail) cls.push('miss');
      if (d.exploded) cls.push('boom');
      if (d.extra) cls.push('extra');
      const tips = [];
      if (d.rerolled.length) tips.push(`rerolled ${d.rerolled.join(', ')}`);
      if (d.exploded) tips.push('exploded');
      if (d.rolls.length > 1 && !d.note) tips.push(`rolls ${d.rolls.join(' + ')}`);
      if (d.note) tips.push(d.note);
      if (d.dropped) tips.push('dropped');
      const n = el('span', { class: cls.join(' '), title: tips.join('; ') || undefined }, show(t, d.v));
      if (animate) tumble(n, t, d);
      return n;
    }
    /** A 2D die tumbling for a moment before it lands on its value (which was known before it started). */
    function tumble(n, t, d) {
      const faces = t.sides === 'F' ? [-1, 0, 1] : t.sides === 66 ? [11, 23, 36, 45, 52, 64] : null;
      const any = () => (faces ? faces[Math.floor(Math.random() * faces.length)] : 1 + Math.floor(Math.random() * t.sides));
      n.classList.add('rolling');
      let k = 0;
      const tick = setInterval(() => {
        if (++k >= 7) { clearInterval(tick); n.textContent = show(t, d.v); n.classList.remove('rolling'); return; }
        n.textContent = show(t, any());   // only the look of the tumble: the result is already set
      }, 70);
    }

    // ------------------------------------------------------------ rolling
    async function roll(text) {
      const expr = String(text || '').trim();
      if (!expr) { err.textContent = 'Type a roll, like 2d6+3'; input.focus(); return; }
      const msg = Dice.check(expr);
      if (msg) { err.textContent = msg; input.classList.add('bad'); input.focus(); return; }
      err.textContent = '';
      input.classList.remove('bad');
      rollBtn.disabled = true;
      quick.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        const r = await post('dice_roll', { expr, engine: Dice.VERSION, visibility: visSel.value }, cid);
        if (text === input.value) input.select?.();
        fresh.add(r.roll.id);
        await load();          // anything rolled since the last poll, then this one, in order
        take([r.roll], true);
      } catch (e) { toast(e.message, true); } finally {
        rollBtn.disabled = false;
        quick.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
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
        log.replaceChildren();
        panel.hidden = true;
        document.body.classList.remove('dice-open');
        dot.hidden = true;
        if (cid) {
          seenId = Number(store.get(seenKey())) || 0;
          drawVis();
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
