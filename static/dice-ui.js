/* dice-ui.js — Pieces of the die roller that both the roller (static/dice-tab.js) and Settings → Dice
 * (static/settings-tab.js) draw: a dice system's number fields, the odds bar, a roll's outcome and its dice.
 *
 * Each takes Kit's el() so it builds nodes the same way the rest of the app does. Plain script, no build step. */
(function (root) {
  'use strict';
  const Dice = root.Dice, DS = root.DiceSystems;

  /** What the odds bar and the log call each tier (DiceSystems.TIERS), best first. */
  const TIER_NAME = { crit: 'Critical', good: 'Success', partial: 'Partial', bad: 'Failure', botch: 'Botch' };

  /** The label a number shows: the game's own name for it if the preset has one ("DC" for Target). */
  const labelOf = (d, labels) => (labels && labels[d.key]) || d.label;

  /** One field per parameter of sys (only those in keys, if given). onChange gets the key and its new value. */
  function fields(el, sys, p, { labels, keys, onChange, idPrefix = 'dsp' } = {}) {
    const defs = sys.params.filter(d => !keys || keys.includes(d.key));
    return defs.map(d => {
      const id = `${idPrefix}-${sys.id}-${d.key}`;
      const set = v => onChange && onChange(d.key, v);
      const name = labelOf(d, labels);
      if (d.type === 'bool') {
        return el('label', { class: 'dsp-f dsp-bool', 'data-key': d.key, title: d.help || undefined },
          el('input', { type: 'checkbox', id, checked: !!p[d.key], onchange: e => set(e.target.checked) }), el('span', {}, name));
      }
      let input;
      if (d.type === 'num') {
        const box = el('input', { type: 'number', id, value: String(p[d.key]), min: String(d.min), max: String(d.max), step: '1', inputmode: 'numeric',
          onchange: e => { const v = Math.max(d.min, Math.min(d.max, Math.round(Number(e.target.value) || 0))); e.target.value = String(v); set(v); } });
        const nudge = by => () => {
          const v = Math.max(d.min, Math.min(d.max, (Math.round(Number(box.value)) || 0) + by));
          box.value = String(v);
          set(v);
        };
        input = el('span', { class: 'dsp-step' },
          el('button', { type: 'button', class: 'dsp-b', 'aria-label': `${name} down one`, tabindex: '-1', onclick: nudge(-1) }, '−'),
          box,
          el('button', { type: 'button', class: 'dsp-b', 'aria-label': `${name} up one`, tabindex: '-1', onclick: nudge(1) }, '+'));
      } else if (d.type === 'sel') {
        input = el('select', { id, onchange: e => set(d.opts.find(([o]) => String(o) === e.target.value)?.[0] ?? d.def) },
          d.opts.map(([v, l]) => el('option', { value: String(v), selected: String(v) === String(p[d.key]) }, l)));
      } else {
        input = el('input', { type: 'text', id, value: String(p[d.key]), maxlength: '40', onchange: e => set(e.target.value) });
      }
      return el('div', { class: `dsp-f dsp-${d.type}`, 'data-key': d.key },
        el('label', { for: id, title: d.help || undefined }, name), input);
    });
  }

  /** The odds bar: one coloured band per tier, as wide as its chance. set(null) hides it (a system with no target). */
  function oddsBar(el) {
    const bar = el('div', { class: 'dice-odds-bar', role: 'img' });
    const key = el('div', { class: 'dice-odds-key small' });
    const node = el('div', { class: 'dice-odds', hidden: true }, bar, key);
    return {
      node,
      set(odds) {
        node.hidden = !odds;
        if (!odds) return;
        const parts = DS.TIERS.filter(t => odds[t] >= 0.0005).map(t => [t, odds[t]]);
        const pct = x => (x >= 0.995 ? '>99%' : x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);
        bar.replaceChildren(...parts.map(([t, x]) => el('span', { class: `t-${t}`, style: { flexGrow: String(x) } })));
        bar.setAttribute('aria-label', 'Chances: ' + parts.map(([t, x]) => `${TIER_NAME[t]} ${pct(x)}`).join(', '));
        key.replaceChildren(...parts.map(([t, x]) => el('span', { class: 'dice-odds-k' }, el('i', { class: `t-${t}`, 'aria-hidden': 'true' }), `${TIER_NAME[t]} ${pct(x)}`)));
      },
    };
  }

  /** How a rolled roll reads: { big, words, tier, note, faces } — the system's reading if it has one, else the total
   * (or the count of successes). */
  function outcome(res, ctx) {
    let got = null;
    try { got = DS.read(res, ctx); } catch { got = null; }
    const boom = exploded(res);
    if (got) return { big: String(got.big), words: got.words || '', tier: got.tier || null, note: [got.note, boom].filter(Boolean).join('; ') || null, faces: got.faces || null, sys: got.sys };
    const o = plainOutcome(res);
    return { ...o, note: boom };
  }
  /** What the explosions added, in a few words ("exploded: 3 more dice", "matches rolled again: 2 more dice"), or null. */
  function exploded(res) {
    let more = 0, matched = false;
    for (const one of res.results) for (const t of one.terms) for (const d of t.dice) {
      if (d.extra) more++;
      else if (d.exploded && !d.note && d.rolls.length > 1) more += d.rolls.length - 1;     // compounded into one die
      if (d.matched) matched = true;
    }
    if (!more) return null;
    return `${matched ? 'matches rolled again' : 'exploded'}: ${more} more ${more === 1 ? 'die' : 'dice'}`;
  }
  function plainOutcome(res) {
    const one = res.results.length === 1 ? res.results[0] : null;
    if (one && one.mode === 'sets') {
      const [best, ...rest] = one.sets;
      if (!best) return { big: '—', words: 'No set', tier: 'bad' };
      return { big: `${best.w}×${best.h}`, words: rest.length ? `also ${rest.map(x => `${x.w}×${x.h}`).join(', ')}` : 'one set', tier: best.w >= 4 ? 'crit' : 'good' };
    }
    if (one && one.mode === 'successes') return { big: String(one.total), words: `success${Math.abs(one.total) === 1 ? '' : 'es'}`, tier: null };
    return { big: Dice.summary(res), words: '', tier: null };
  }

  const show = (t, v) => (t.sides === 'F' ? (v > 0 ? '+' : v < 0 ? '−' : '0') : String(v));
  /** One die, styled for what happened to it. animate: tumble for a moment before landing on its value. */
  function die(el, d, t, animate, face) {
    const cls = ['die', t.sides === 'F' ? 'dF' : `d${t.sides}`];
    if (d.dropped) cls.push('dropped');
    if (d.success) cls.push('hit');
    if (d.fail) cls.push('miss');
    if (d.exploded) cls.push('boom');
    if (d.crit) cls.push('crit');
    if (d.fumble) cls.push('fumble');
    if (d.extra) cls.push('extra');
    if (face) cls.push('face');
    const tips = [];
    if (face) tips.push(`rolled ${d.v}`);
    if (d.rerolled.length) tips.push(`rerolled ${d.rerolled.join(', ')}`);
    if (d.byHand) { cls.push('byhand'); tips.push(`rerolled by hand, was ${d.byHand.map(v => show(t, v)).join(', then ')}`); }
    if (d.matched) tips.push('matched: rolled again');
    else if (d.exploded) tips.push('exploded');
    if (d.extra) tips.push('added by an explosion');
    if (d.crit) tips.push('critical');
    if (d.fumble) tips.push('critical failure');
    if (d.rolls.length > 1 && !d.note) tips.push(`rolls ${d.rolls.join(' + ')}`);
    if (d.note) tips.push(d.note);
    if (d.dropped) tips.push('dropped');
    const final = face || show(t, d.v);
    const n = el('span', { class: cls.join(' '), title: tips.join('; ') || undefined, 'data-i': d.i !== undefined ? String(d.i) : undefined }, final);
    if (animate) tumble(n, t, final);
    return n;
  }
  function tumble(n, t, final) {
    const faces = t.sides === 'F' ? [-1, 0, 1] : t.sides === 66 ? [11, 23, 36, 45, 52, 64] : null;
    const any = () => (faces ? faces[Math.floor(Math.random() * faces.length)] : 1 + Math.floor(Math.random() * t.sides));
    n.classList.add('rolling');
    let k = 0;
    const tick = setInterval(() => {
      if (++k >= 7) { clearInterval(tick); n.textContent = final; n.classList.remove('rolling'); return; }
      n.textContent = show(t, any());   // only the look of the tumble: the result is already set
    }, 70);
  }
  /** The different sources a roll's dice were tagged with, in the order they first come. */
  const tags = res => [...new Set(res.results.flatMap(o => o.terms.map(t => t.tag).filter(Boolean)))];
  /** The dice of a rolled roll, term by term; a repeat says which go each row was. faces (symbol dice) replace the numbers.
   * animate: true tumbles every die, or a Set of die numbers (d.i) tumbles only those (dice just rerolled).
   * look ({ body, ink, tex }, static/dice-3d.js) colours them as the roller's own dice. */
  function diceRows(el, res, { animate = false, faces = null, look = null } = {}) {
    const chip = look && root.Dice3D ? root.Dice3D.chip(look) : null;
    return res.results.map((one, k) => {
      const row = el('div', { class: chip ? 'dice-terms looked' : 'dice-terms' });
      if (chip) for (const [p, v] of Object.entries(chip)) row.style.setProperty(p, v);
      if (chip?.['--die-glow']) row.classList.add('anim', `anim-${root.Dice3D.ANIMATED[look.tex]}`);
      if (res.repeat) row.append(el('span', { class: 'dice-go-n small muted' }, `#${k + 1} = ${one.total}`));
      one.terms.forEach((t, i) => {
        // a tagged term ("2d6[Athletics]") says where its dice came from, each source in its own colour
        const tagged = t.tag ? ` tagged tag-${tags(res).indexOf(t.tag) % 6}` : '';
        row.append(el('span', { class: 'dice-term' + tagged, title: t.tag ? `${t.tag}: ${t.src}` : t.src },
          t.tag ? el('span', { class: 'dice-tag' }, t.tag) : null,
          t.dice.map((d, j) => die(el, d, t, animate instanceof Set ? animate.has(d.i) : animate, k === 0 && faces?.[i]?.[j]))));
      });
      return row;
    });
  }

  /** A reroll's log entry ("~<roll id>:<die numbers>", api/dice.php): which roll and dice, or null for a roll. */
  const rerollOf = r => { const m = /^~(\d+):([\d,]+)$/.exec(r.expr); return m ? { id: Number(m[1]), dice: m[2].split(',').map(Number) } : null; };
  /** The rerolls of roll r among rolls, oldest first, as Dice.roll takes them. */
  const rerollsFor = (rolls, r) => rolls.filter(x => x.seed && rerollOf(x)?.id === r.id).map(x => ({ seed: x.seed, dice: rerollOf(x).dice, id: x.id }));

  /** A list of rolls to read back (a session's page): who rolled what, the result and the dice, oldest first, each
   * reroll folded into its roll. ctx.table: the campaign's result table, for a table system's rolls. */
  function rollList(el, rolls, ctx = {}) {
    const fmt = at => { const t = new Date(String(at).replace(' ', 'T')); return isFinite(t) ? t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
    return el('ol', { class: 'dice-hist' }, rolls.filter(r => !rerollOf(r)).map(r => {
      let label = '', big = '?', words = '', tier = null, dice = null;
      if (r.seed === null) {
        words = 'Rolled for the GM';
        try { label = Dice.parse(r.expr).label; } catch { /* unreadable */ }
      } else {
        try {
          const rr = rerollsFor(rolls, r), res = Dice.roll(r.expr, r.seed, rr), o = outcome(res, ctx);
          label = res.label; big = o.big; words = o.words + (rr.length ? `${o.words ? ' · ' : ''}rerolled` : ''); tier = o.tier;
          dice = diceRows(el, res, { faces: o.faces, look: r.look });
        } catch { big = '—'; words = 'Can\'t read this roll'; }
      }
      return el('li', { class: 'dice-hist-e' + (tier ? ` t-${tier}` : '') },
        el('div', {}, el('b', {}, r.author || 'Someone'), label ? el('span', { class: 'muted' }, ` · ${label}`) : null,
          el('div', { class: 'small muted' }, el('span', { class: 'mono' }, r.expr.split('#')[0].split('@')[0].trim()), ` · ${fmt(r.at)}`), dice),
        el('div', { class: 'dice-hist-out' }, el('b', {}, big), words ? el('small', { class: tier ? `tier t-${tier}` : null }, words) : null));
    }));
  }

  /** The roller's button picture: a d20 with a d4 and a d6 in front of it, in the theme's colours (px square). */
  function pileIcon(el, px = 36) {
    const span = el('span', { class: 'dice-pile', 'aria-hidden': 'true' });
    span.innerHTML = `<svg viewBox="0 0 48 48" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">
      <g class="pd20"><path d="M19 4 31.6 11.3v14.6L19 33.2 6.4 25.9V11.3Z"/><path d="M19 11 27.6 25 10.4 25Z M19 4v7 M6.4 11.3 19 11 M31.6 11.3 19 11 M6.4 11.3l4 13.7 M31.6 11.3l-4 13.7 M6.4 25.9l4-.9 M31.6 25.9l-4-.9 M19 33.2l-8.6-8.2 M19 33.2l8.6-8.2" fill="none"/></g>
      <g class="pd4"><path d="M14 25.5 3.5 43 14.5 46.5 24.5 41Z"/><path d="M14 25.5 14.5 46.5" fill="none"/></g>
      <g class="pd6"><path d="M34 22 44.5 27.2 34 32.4 23.5 27.2Z"/><path d="M23.5 27.2 34 32.4V45L23.5 39.6Z"/><path d="M34 32.4 44.5 27.2V39.6L34 45Z"/>
        <g fill="currentColor" stroke="none"><circle cx="34" cy="27.2" r="1.6"/><circle cx="26.3" cy="32" r="1.3"/><circle cx="31.2" cy="40.2" r="1.3"/><circle cx="36.7" cy="40.2" r="1.3"/><circle cx="39.25" cy="36.1" r="1.3"/><circle cx="41.8" cy="32" r="1.3"/></g></g>
    </svg>`;
    return span;
  }

  root.DiceUI = { TIER_NAME, pileIcon, labelOf, fields, oddsBar, outcome, diceRows, rerollOf, rerollsFor, rollList };
})(window);
