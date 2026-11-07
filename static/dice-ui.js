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
    if (got) return { big: String(got.big), words: got.words || '', tier: got.tier || null, note: got.note || null, faces: got.faces || null, sys: got.sys };
    const one = res.results.length === 1 ? res.results[0] : null;
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
    if (d.extra) cls.push('extra');
    if (face) cls.push('face');
    const tips = [];
    if (face) tips.push(`rolled ${d.v}`);
    if (d.rerolled.length) tips.push(`rerolled ${d.rerolled.join(', ')}`);
    if (d.exploded) tips.push('exploded');
    if (d.rolls.length > 1 && !d.note) tips.push(`rolls ${d.rolls.join(' + ')}`);
    if (d.note) tips.push(d.note);
    if (d.dropped) tips.push('dropped');
    const final = face || show(t, d.v);
    const n = el('span', { class: cls.join(' '), title: tips.join('; ') || undefined }, final);
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
  /** The dice of a rolled roll, term by term; a repeat says which go each row was. faces (symbol dice) replace the numbers.
   * look ({ body, ink, tex }, static/dice-3d.js) colours them as the roller's own dice. */
  function diceRows(el, res, { animate = false, faces = null, look = null } = {}) {
    const chip = look && root.Dice3D ? root.Dice3D.chip(look) : null;
    return res.results.map((one, k) => {
      const row = el('div', { class: chip ? 'dice-terms looked' : 'dice-terms' });
      if (chip) for (const [p, v] of Object.entries(chip)) row.style.setProperty(p, v);
      if (res.repeat) row.append(el('span', { class: 'dice-go-n small muted' }, `#${k + 1} = ${one.total}`));
      one.terms.forEach((t, i) => {
        row.append(el('span', { class: 'dice-term', title: t.src }, t.dice.map((d, j) => die(el, d, t, animate, k === 0 && faces?.[i]?.[j]))));
      });
      return row;
    });
  }

  root.DiceUI = { TIER_NAME, labelOf, fields, oddsBar, outcome, diceRows };
})(window);
