/* dice-systems.js — The dice systems a campaign can roll with: how each one builds its dice and reads them.
 *
 * Each system turns its numbers (a pool and a difficulty, a modifier and a DC…) into dice in the free-roll notation
 * (static/dice.js), and reads the rolled dice into an outcome: a big number, a few words, and a tier (critical, success,
 * partial, failure, botch) that colours the log and the odds bar. A roll is stored as its dice, then @ and the system with
 * its numbers, then its label: "7d10>=6 @pool n=7 d=10 t=6 ones=1 # Dex + Firearms". The seed rolls the dice; the system
 * reads them, the same on every device.
 *
 * "Start from a game" (PRESETS) picks a system and its numbers for a published game. Game names are only named, to say
 * which rules a preset follows; no text or art of theirs is used. Plain script, no build step; also loads under Node
 * for tests/browser/dice-systems.spec.js. */
(function (root) {
  'use strict';
  const Dice = root.Dice || (typeof require !== 'undefined' ? require('./dice.js') : null);

  // ------------------------------------------------------------ parameters
  const num = (key, label, def, min, max, o = {}) => ({ key, label, type: 'num', def, min, max, ...o });
  const sel = (key, label, def, opts, o = {}) => ({ key, label, type: 'sel', def, opts, ...o });
  const bool = (key, label, def, o = {}) => ({ key, label, type: 'bool', def, ...o });
  const text = (key, label, def, o = {}) => ({ key, label, type: 'text', def, ...o });
  const DIE = sides => sides.map(s => [s, `d${s}`]);
  const sign = n => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '');
  const plural = (n, one, many = `${one}s`) => `${n} ${Math.abs(n) === 1 ? one : many}`;
  /** The kept dice of a term, as numbers. */
  const kept = t => t.dice.filter(d => !d.dropped).map(d => d.v);
  const all = t => t.dice.map(d => d.v);

  /** The tiers a reading falls in, best first, and what the odds bar calls them. */
  const TIERS = ['crit', 'good', 'partial', 'bad', 'botch'];

  const GROUPS = [
    ['add', 'Roll, add, beat a number'],
    ['bands', 'Fixed outcome bands'],
    ['under', 'Roll under a number'],
    ['pool', 'Dice pools'],
    ['step', 'Step dice'],
    ['gm', 'GM tools'],
  ];

  // ------------------------------------------------------------ the systems
  const SYSTEMS = [
    // 1
    { id: 'd20', group: 'add', name: 'Single die + modifier vs target', hint: 'd20, d10, d100',
      params: [
        num('mod', 'Modifier', 0, -30, 60, { main: true }),
        num('tn', 'Target', 15, 0, 200, { main: true, help: '0 for no target' }),
        sel('adv', 'Advantage', 'none', [['none', 'Normal'], ['adv', 'Advantage'], ['dis', 'Disadvantage']], { main: true }),
        sel('die', 'Die', 20, DIE([20, 10, 12, 100])),
        num('crit', 'Critical on a natural', 20, 0, 100, { help: '19 for 19–20; 0 for none' }),
        bool('fumble', 'A natural 1 fails', true),
        num('margin', 'Beat or miss by this much for a critical', 0, 0, 50, { help: '10 for Pathfinder 2e; 0 for none' }),
        num('boons', 'Boons (+) or banes (−)', 0, -6, 6, { help: 'Add (or take away) the highest of that many d6' }),
      ],
      build: p => {
        const base = p.adv === 'adv' ? `2d${p.die}kh1` : p.adv === 'dis' ? `2d${p.die}kl1` : `1d${p.die}`;
        const boons = p.boons > 0 ? `+${p.boons}d6kh1` : p.boons < 0 ? `-${-p.boons}d6kh1` : '';
        return `${base}${boons}${sign(p.mod)}`;
      },
      read: (r, p) => {
        const nat = kept(r.terms[0])[0], total = r.total;
        const hiCrit = p.crit > 0 && nat >= p.crit, natOne = nat === 1;
        if (!p.tn) return { big: total, words: hiCrit ? 'Natural critical' : natOne && p.fumble ? 'Natural 1' : '', tier: hiCrit ? 'crit' : natOne && p.fumble ? 'botch' : null };
        let k;   // 0 botch, 1 failure, 2 success, 3 critical
        if (p.margin > 0) {
          k = total >= p.tn + p.margin ? 3 : total >= p.tn ? 2 : total <= p.tn - p.margin ? 0 : 1;
          if (hiCrit) k = Math.min(3, k + 1);          // a natural 20 steps the result up, a natural 1 down
          if (natOne && p.fumble) k = Math.max(0, k - 1);
        } else {
          k = total >= p.tn ? 2 : 1;
          if (hiCrit) k = 3;
          else if (natOne && p.fumble) k = 0;
        }
        const words = ['Critical failure', 'Failure', 'Success', 'Critical success'][k];
        const by = total - p.tn;
        return { big: total, words, tier: ['botch', 'bad', 'good', 'crit'][k], note: by >= 0 ? `beat ${p.tn} by ${by}` : `missed ${p.tn} by ${-by}` };
      } },
    // 2
    { id: 'sum', group: 'add', name: 'Several dice added up vs target', hint: '2d6, 3d6, Nd6',
      params: [
        num('n', 'Dice', 2, 1, 30, { main: true }),
        num('mod', 'Modifier', 0, -30, 60, { main: true }),
        num('tn', 'Target', 8, 0, 300, { main: true, help: '0 for no target' }),
        sel('sides', 'Die', 6, DIE([6, 4, 8, 10, 12, 20])),
        bool('wild', 'One die is a wild die (explodes on its top face; a 1 is a mishap)', false),
        bool('explode', 'Every die explodes on its top face', false),
      ],
      build: p => {
        const x = p.explode ? '!' : '';
        if (!p.wild) return `${p.n}d${p.sides}${x}${sign(p.mod)}`;
        return `${p.n > 1 ? `${p.n - 1}d${p.sides}${x}+` : ''}1d${p.sides}!${sign(p.mod)}`;
      },
      read: (r, p) => {
        const wild = p.wild ? r.terms[r.terms.length - 1].dice[0] : null;
        const mishap = wild && wild.rolls[0] === 1;
        const note = mishap ? 'the wild die rolled a 1: a mishap' : null;
        if (!p.tn) return { big: r.total, words: '', tier: mishap ? 'partial' : null, note };
        const by = r.total - p.tn;
        return { big: r.total, words: by >= 0 ? 'Success' : 'Failure', tier: by >= 0 ? 'good' : 'bad',
          note: [by >= 0 ? `beat ${p.tn} by ${by}` : `missed ${p.tn} by ${-by}`, note].filter(Boolean).join('; ') };
      } },
    // 3
    { id: 'fudge', group: 'add', name: 'Zero-centred dice (Fudge, plus/minus)', hint: '4dF, d6 − d6',
      params: [
        num('skill', 'Skill', 2, -4, 12, { main: true }),
        num('opp', 'Opposition', 2, -4, 14, { main: true }),
        sel('dice', 'Dice', '4dF', [['4dF', '4 Fudge dice'], ['d6-d6', 'A plus d6 minus a minus d6']]),
      ],
      build: p => `${p.dice === '4dF' ? '4dF' : '1d6-1d6'}${sign(p.skill)}`,
      read: (r, p) => {
        const shifts = r.total - p.opp;
        const k = shifts < 0 ? 'bad' : shifts === 0 ? 'partial' : shifts >= 3 ? 'crit' : 'good';
        const words = { bad: 'Fail', partial: 'Tie', good: 'Succeed', crit: 'Succeed with style' }[k];
        return { big: sign(r.total) || '0', words, tier: k, note: `${LADDER[r.total] || ''}${LADDER[r.total] ? ', ' : ''}${plural(shifts, 'shift')}` };
      } },
    // 4
    { id: 'table', group: 'add', name: 'Roll into a result table', hint: 'd100, 2d6, d20',
      params: [
        num('mod', 'Modifier', 0, -100, 200, { main: true }),
        text('dice', 'Dice', '1d100', { help: 'Any free roll, like 2d6 or 1d20' }),
        bool('open', 'Open-ended: 96–100 rolls again and adds (d100 only)', false),
      ],
      build: p => `${p.open && /^1?d(100|%)$/i.test(p.dice) ? '1d100!>=96' : p.dice}${sign(p.mod)}`,
      read: (r, p, ctx) => {
        const row = tableRows(ctx?.table).find(x => r.total >= x.lo && r.total <= x.hi);
        return { big: r.total, words: row ? row.text : '', tier: row?.tier || null };
      } },
    // 5
    { id: 'pbta', group: 'bands', name: '2d6 + stat into fixed bands', hint: '6− · 7–9 · 10+',
      params: [
        num('stat', 'Stat', 0, -3, 5, { main: true }),
        sel('adv', 'Advantage', 'none', [['none', 'Normal'], ['adv', 'Advantage (3d6, best 2)'], ['dis', 'Disadvantage (3d6, worst 2)']], { main: true }),
        num('fwd', 'Forward / ongoing', 0, -5, 5),
        bool('crit12', '12+ is a critical', false),
      ],
      build: p => `${p.adv === 'adv' ? '3d6kh2' : p.adv === 'dis' ? '3d6kl2' : '2d6'}${sign(p.stat + p.fwd)}`,
      read: (r, p) => {
        const t = r.total;
        if (p.crit12 && t >= 12) return { big: t, words: 'Critical', tier: 'crit' };
        if (t >= 10) return { big: t, words: 'Strong hit', tier: 'good' };
        if (t >= 7) return { big: t, words: 'Weak hit', tier: 'partial' };
        return { big: t, words: 'Miss', tier: 'bad' };
      } },
    // 6
    { id: 'action', group: 'bands', name: 'Action die vs challenge dice', hint: 'd6 + stat vs 2d10',
      params: [
        num('stat', 'Stat', 2, 0, 5, { main: true }),
        num('adds', 'Adds', 0, -5, 10, { main: true }),
      ],
      build: () => '1d6+2d10',
      read: (r, p) => {
        const action = Math.min(10, r.terms[0].value + p.stat + p.adds);
        const [a, b] = all(r.terms[1]);
        const beats = (action > a) + (action > b);
        const match = a === b ? ', a match' : '';
        return { big: action, words: ['Miss', 'Weak hit', 'Strong hit'][beats] + match, tier: ['bad', 'partial', 'good'][beats], note: `vs ${a} and ${b}` };
      } },
    // 7
    { id: 'duality', group: 'bands', name: 'Two-colour dice', hint: 'Hope d12 + Fear d12',
      params: [
        num('mod', 'Modifier', 0, -10, 20, { main: true }),
        num('tn', 'Difficulty', 12, 0, 40, { main: true }),
        sel('sides', 'Dice', 12, DIE([12, 10, 6, 8, 20])),
        text('first', 'First die is', 'Hope'),
        text('second', 'Second die is', 'Fear'),
      ],
      build: p => `1d${p.sides}+1d${p.sides}${sign(p.mod)}`,
      read: (r, p) => {
        const a = r.terms[0].value, b = r.terms[1].value;
        if (a === b) return { big: r.total, words: 'Critical success', tier: 'crit', note: `doubles (${a})` };
        const ok = !p.tn || r.total >= p.tn;
        const side = a > b ? p.first : p.second;
        return { big: r.total, words: `${ok ? 'Success' : 'Failure'} with ${side}`, tier: ok ? 'good' : 'bad', note: `${p.first} ${a}, ${p.second} ${b}` };
      } },
    // 8
    { id: 'percent', group: 'under', name: 'Percentile roll-under', hint: 'd100 vs skill %',
      params: [
        num('skill', 'Skill %', 50, 1, 200, { main: true }),
        sel('bp', 'Bonus or penalty dice', 0, [[2, '2 bonus dice'], [1, '1 bonus die'], [0, 'None'], [-1, '1 penalty die'], [-2, '2 penalty dice']], { main: true }),
        sel('mode', 'Read as', 'tiers', [['tiers', 'Regular, hard and extreme successes'], ['sl', 'Success levels (tens of skill − tens of roll)'], ['plain', 'Success or failure']]),
        bool('doubles', 'Doubles are critical (11, 22 … under the skill; over it, a fumble)', false),
        bool('flip', 'Flip-flop: read both ways round, keep the lower', false),
      ],
      build: p => (p.flip ? '1d100flip' : p.bp > 0 ? `1d100b${p.bp}` : p.bp < 0 ? `1d100p${-p.bp}` : '1d100'),
      read: (r, p) => {
        const v = r.total, ok = v <= p.skill && v !== 100;
        const dbl = p.doubles && v < 100 && v % 11 === 0;
        if (p.mode === 'sl') {
          const sl = Math.floor(p.skill / 10) - Math.floor(v / 10);
          const tier = dbl ? (ok ? 'crit' : 'botch') : ok ? 'good' : 'bad';
          return { big: v, words: `${ok ? 'Success' : 'Failure'}, ${sl >= 0 ? '+' : ''}${sl} SL${dbl ? (ok ? ', critical' : ', fumble') : ''}`, tier };
        }
        if (p.mode === 'plain') return { big: v, words: dbl ? (ok ? 'Critical success' : 'Fumble') : ok ? 'Success' : 'Failure', tier: dbl ? (ok ? 'crit' : 'botch') : ok ? 'good' : 'bad' };
        const fumble = p.skill < 50 ? v >= 96 : v === 100;
        if (v === 1 || (dbl && ok)) return { big: v, words: 'Critical success', tier: 'crit' };
        if (fumble || (dbl && !ok)) return { big: v, words: 'Fumble', tier: 'botch' };
        if (v <= Math.floor(p.skill / 5)) return { big: v, words: 'Extreme success', tier: 'crit' };
        if (v <= Math.floor(p.skill / 2)) return { big: v, words: 'Hard success', tier: 'good' };
        if (ok) return { big: v, words: 'Regular success', tier: 'good' };
        return { big: v, words: 'Failure', tier: 'bad' };
      } },
    // 9
    { id: 'under3d6', group: 'under', name: '3d6 or 2d6 roll-under', hint: '3d6 vs skill',
      params: [
        num('skill', 'Skill', 12, 1, 30, { main: true }),
        num('mod', 'Modifier', 0, -20, 20, { main: true }),
        sel('n', 'Dice', 3, [[3, '3d6'], [2, '2d6']]),
      ],
      build: p => `${p.n}d6`,
      read: (r, p) => {
        const v = r.total, eff = p.skill + p.mod, by = eff - v;
        let critOk, critBad;
        if (p.n === 3) {
          critOk = v <= 4 || (v === 5 && eff >= 15) || (v === 6 && eff >= 16);
          critBad = v === 18 || (v === 17 && eff <= 15) || v >= eff + 10;
        } else { critOk = v === 2; critBad = v === 12; }
        if (critOk) return { big: v, words: 'Critical success', tier: 'crit', note: `by ${by}` };
        if (critBad) return { big: v, words: 'Critical failure', tier: 'botch', note: `by ${-by}` };
        return { big: v, words: v <= eff ? 'Success' : 'Failure', tier: v <= eff ? 'good' : 'bad', note: v <= eff ? `made it by ${by}` : `missed by ${-by}` };
      } },
    // 10
    { id: 'under20', group: 'under', name: 'd20 roll-under', hint: 'd20 vs a stat',
      params: [
        num('stat', 'Stat', 12, 1, 40, { main: true }),
        num('mod', 'Modifier', 0, -20, 20, { main: true }),
        bool('nat', 'A natural 1 is a critical, a natural 20 a fumble', true),
        bool('exact', 'Rolling the stat exactly is a critical (blackjack)', false),
      ],
      build: () => '1d20',
      read: (r, p) => {
        const v = r.total, target = p.stat + p.mod;
        if (p.nat && v === 1) return { big: v, words: 'Critical success', tier: 'crit' };
        if (p.nat && v === 20) return { big: v, words: 'Fumble', tier: 'botch' };
        if (p.exact && v === target) return { big: v, words: 'Critical success', tier: 'crit' };
        return { big: v, words: v <= target ? 'Success' : 'Failure', tier: v <= target ? 'good' : 'bad', note: `needed ${target} or under` };
      } },
    // 11
    { id: 'pool', group: 'pool', name: 'Count successes', hint: 'd10 or d6 pool',
      params: [
        num('n', 'Pool', 5, 1, 60, { main: true }),
        num('t', 'Difficulty', 6, 1, 30, { main: true, help: 'A die this high or higher is a success' }),
        sel('d', 'Die', 10, DIE([10, 6, 8, 12, 20])),
        num('need', 'Successes needed', 1, 1, 20),
        num('again', 'Dice this high roll again (0: none)', 0, 0, 20, { help: '10 for 10-again' }),
        num('dbl', 'Dice this high count twice (0: none)', 0, 0, 20, { help: '10 for Exalted; also a toggle for specialties' }),
        bool('ones', '1s cancel successes', false),
        sel('botch', 'Bad luck', 'none', [['none', 'None'], ['wod', 'Botch: no successes and a 1'], ['glitch', 'Glitch: more than half 1s']]),
        num('auto', 'Automatic successes', 0, 0, 10, { help: 'Willpower and the like' }),
        num('exc', 'Exceptional at this many (0: none)', 0, 0, 20),
      ],
      build: p => `${p.n}d${p.d}${p.again > 1 ? `!>=${p.again}` : ''}>=${p.t}${p.ones ? 'f1' : ''}`,
      read: (r, p) => {
        const dice = all(r.terms[0]);
        const hits = dice.filter(v => v >= p.t).length + (p.dbl > 0 ? dice.filter(v => v >= p.dbl && v >= p.t).length : 0);
        const ones = dice.filter(v => v === 1).length;
        const net = Math.max(0, hits - (p.ones ? ones : 0)) + p.auto;
        const rawHits = hits + p.auto;
        if (p.botch === 'wod' && rawHits === 0 && ones > 0) return { big: 0, words: 'Botch', tier: 'botch' };
        const glitch = p.botch === 'glitch' && ones > p.n / 2;
        if (glitch && rawHits === 0) return { big: 0, words: 'Critical glitch', tier: 'botch' };
        const tier = net >= p.need ? (p.exc && net >= p.exc ? 'crit' : 'good') : net > 0 ? 'partial' : 'bad';
        const words = `${net === 1 ? 'success' : 'successes'}${p.exc && net >= p.exc ? ', exceptional' : ''}${glitch ? ', glitch' : ''}`;
        return { big: net, words, tier: glitch && tier !== 'bad' ? 'partial' : tier, note: p.need > 1 ? `needed ${p.need}` : null };
      } },
    // 12
    { id: 'highest', group: 'pool', name: 'Highest die sets the result', hint: 'd6 pool, 1–3 · 4–5 · 6',
      params: [
        num('n', 'Dice', 2, 0, 10, { main: true, help: 'With 0 dice, roll 2 and take the lower' }),
        num('dark', 'Dark dice (a dark die highest brings a cost)', 0, 0, 6),
      ],
      build: p => `${p.n === 0 ? '2d6kl1' : `${p.n}d6`}${p.dark ? `+${p.dark}d6` : ''}`,
      read: (r, p) => {
        const light = kept(r.terms[0]), dark = p.dark ? all(r.terms[1]) : [];
        const top = Math.max(...light, ...dark);
        const sixes = [...light, ...dark].filter(v => v === 6).length;
        const cost = dark.length && Math.max(...dark) > Math.max(...light) ? ', a dark die is highest' : '';
        if (p.n > 0 && sixes >= 2) return { big: top, words: 'Critical' + cost, tier: 'crit' };
        if (top === 6) return { big: top, words: 'Full success' + cost, tier: 'good' };
        if (top >= 4) return { big: top, words: 'Partial success' + cost, tier: 'partial' };
        return { big: top, words: 'Bad outcome' + cost, tier: 'bad' };
      } },
    // 13
    { id: 'rolloff', group: 'pool', name: 'Opposed roll-off', hint: 'pool vs pool, highest die wins',
      params: [
        num('a', 'Your pool', 4, 1, 30, { main: true }),
        num('b', 'Their pool', 4, 1, 30, { main: true }),
        sel('d', 'Die', 10, DIE([10, 20, 6, 8, 12])),
      ],
      build: p => `${p.a}d${p.d}+${p.b}d${p.d}`,
      read: r => {
        const A = all(r.terms[0]).sort((x, y) => y - x), B = all(r.terms[1]).sort((x, y) => y - x);
        let k = 0;
        while (k < Math.min(A.length, B.length) && A[k] === B[k]) k++;   // ties go to the next die down
        const aWins = k < A.length && (k >= B.length || A[k] > B[k]);
        const bWins = k < B.length && (k >= A.length || B[k] > A[k]);
        if (!aWins && !bWins) return { big: 0, words: 'Tie', tier: 'partial' };
        const [W, L] = aWins ? [A, B] : [B, A];
        const wins = W.filter(v => v > L[0]).length || 1;
        return { big: wins, words: `${aWins ? 'You win' : 'They win'}: ${plural(wins, 'victory', 'victories')}`, tier: aWins ? 'good' : 'bad', note: `your best ${A[0]}, theirs ${B[0]}` };
      } },
    // 14
    { id: 'keep', group: 'pool', name: 'Roll and keep', hint: 'roll X, keep Y',
      params: [
        num('x', 'Roll', 5, 1, 20, { main: true }),
        num('y', 'Keep', 3, 1, 20, { main: true }),
        num('tn', 'Target', 15, 0, 200, { main: true }),
        num('mod', 'Modifier', 0, -20, 40),
        sel('d', 'Die', 10, DIE([10, 6, 8, 12])),
        bool('explode', 'Top faces explode', true),
        num('raise', 'A raise is every', 5, 0, 20, { help: '0 for no raises' }),
      ],
      build: p => `${p.x}d${p.d}${p.explode ? '!' : ''}kh${Math.min(p.y, p.x)}${sign(p.mod)}`,
      read: (r, p) => {
        if (!p.tn) return { big: r.total, words: '', tier: null };
        const by = r.total - p.tn;
        const raises = by >= 0 && p.raise ? Math.floor(by / p.raise) : 0;
        return { big: r.total, words: by >= 0 ? `Success${raises ? `, ${plural(raises, 'raise')}` : ''}` : 'Failure', tier: by >= 0 ? (raises ? 'crit' : 'good') : 'bad',
          note: by >= 0 ? `beat ${p.tn} by ${by}` : `missed ${p.tn} by ${-by}` };
      } },
    // 15
    { id: 'sets', group: 'pool', name: 'Matching sets (width × height)', hint: 'd10 pool',
      params: [
        num('n', 'Dice', 5, 1, 10, { main: true }),
        num('minh', 'Lowest height that counts', 1, 1, 10, { main: true }),
      ],
      build: p => `${p.n}d10`,
      read: (r, p) => {
        const count = {};
        for (const v of all(r.terms[0])) count[v] = (count[v] || 0) + 1;
        const sets = Object.entries(count).map(([h, w]) => ({ w, h: Number(h) })).filter(s => s.w >= 2 && s.h >= p.minh)
          .sort((a, b) => b.w - a.w || b.h - a.h);
        if (!sets.length) return { big: '—', words: 'No set', tier: 'bad' };
        const best = sets[0];
        return { big: `${best.w}×${best.h}`, words: sets.length > 1 ? `also ${sets.slice(1).map(s => `${s.w}×${s.h}`).join(', ')}` : 'one set', tier: best.w >= 4 ? 'crit' : 'good' };
      } },
    // 16
    { id: 'symbols', group: 'pool', name: 'Narrative symbol dice', hint: 'success and advantage',
      params: [
        num('ab', 'Ability (d8)', 2, 0, 8, { main: true }),
        num('pr', 'Proficiency (d12)', 0, 0, 8, { main: true }),
        num('di', 'Difficulty (d8)', 2, 0, 8, { main: true }),
        num('ch', 'Challenge (d12)', 0, 0, 8),
        num('bo', 'Boost (d6)', 0, 0, 6),
        num('se', 'Setback (d6)', 0, 0, 6),
      ],
      build: p => {
        const parts = SYMBOL_DICE.map(([k, sides]) => (p[k] > 0 ? `${p[k]}d${sides}` : null)).filter(Boolean);
        return parts.length ? parts.join('+') : '1d8';
      },
      read: (r, p) => {
        const tally = { s: 0, f: 0, a: 0, t: 0, tr: 0, de: 0 };
        const faces = [];
        let k = 0;
        for (const [key, , table] of SYMBOL_DICE) {
          if (!(p[key] > 0)) continue;
          const term = r.terms[k++];
          faces.push(term.dice.map(d => {
            const f = table[d.v - 1];
            for (const c of f.split(',')) if (c) tally[c]++;
            return f.split(',').filter(Boolean).map(c => SYMBOL[c]).join('') || '·';
          }));
        }
        const succ = tally.s + tally.tr - tally.f - tally.de, adv = tally.a - tally.t;
        const bits = [adv > 0 ? plural(adv, 'advantage', 'advantages') : adv < 0 ? plural(-adv, 'threat') : null,
          tally.tr ? plural(tally.tr, 'triumph') : null, tally.de ? plural(tally.de, 'despair', 'despairs') : null].filter(Boolean);
        const ok = succ > 0;
        return { big: `${succ > 0 ? succ : 0}${SYMBOL.s}`, words: `${ok ? 'Success' : 'Failure'}${bits.length ? `, ${bits.join(', ')}` : ''}`,
          tier: ok ? (tally.tr ? 'crit' : 'good') : tally.de ? 'botch' : 'bad', faces };
      } },
    // 17
    { id: 'step', group: 'step', name: 'Step die vs target, with a wild die', hint: 'd4 to d12, aces',
      params: [
        sel('trait', 'Trait die', 8, DIE([4, 6, 8, 10, 12]), { main: true }),
        num('mod', 'Modifier', 0, -10, 10, { main: true }),
        num('tn', 'Target', 4, 1, 30),
        bool('wild', 'Roll a d6 wild die too, take the higher', true),
        num('raise', 'A raise is every', 4, 0, 10, { help: '0 for no raises' }),
      ],
      build: p => `1d${p.trait}!${p.wild ? '+1d6!' : ''}`,
      read: (r, p) => {
        const t = r.terms[0].value, w = p.wild ? r.terms[1].value : -Infinity;
        const score = Math.max(t, w) + p.mod;
        if (p.wild && r.terms[0].dice[0].rolls[0] === 1 && r.terms[1].dice[0].rolls[0] === 1) return { big: score, words: 'Critical failure', tier: 'botch', note: 'both dice rolled 1' };
        const by = score - p.tn;
        const raises = by >= 0 && p.raise ? Math.floor(by / p.raise) : 0;
        return { big: score, words: by >= 0 ? `Success${raises ? `, ${plural(raises, 'raise')}` : ''}` : 'Failure', tier: by >= 0 ? (raises ? 'crit' : 'good') : 'bad',
          note: p.wild ? `trait ${t}, wild ${w}` : null };
      } },
    // 18
    { id: 'oracle', group: 'gm', name: 'Oracle: ask a yes-or-no question', hint: 'd100 vs a likelihood',
      params: [
        sel('odds', 'Likelihood', 50, [[90, 'Almost certain (90%)'], [75, 'Likely (75%)'], [50, 'Even (50%)'], [25, 'Unlikely (25%)'], [10, 'Small chance (10%)']], { main: true }),
        bool('twist', 'Doubles (11, 22 …) add a twist', true),
      ],
      build: () => '1d100',
      read: (r, p) => {
        const v = r.total;
        const twist = p.twist && v < 100 && v % 11 === 0 ? ', and a twist' : '';
        if (v <= Math.max(1, Math.floor(p.odds / 5))) return { big: v, words: 'Yes, and…' + twist, tier: 'crit' };
        if (v <= p.odds) return { big: v, words: 'Yes' + twist, tier: 'good' };
        if (v > 100 - Math.floor((100 - p.odds) / 5)) return { big: v, words: 'No, and…' + twist, tier: 'botch' };
        return { big: v, words: 'No' + twist, tier: 'bad' };
      } },
  ];
  const BY_ID = Object.fromEntries(SYSTEMS.map(s => [s.id, s]));

  // Narrative symbol dice: [parameter, sides, faces]. s success, f failure, a advantage, t threat, tr triumph, de despair.
  const SYMBOL = { s: '✓', f: '✗', a: '▲', t: '▼', tr: '★', de: '☠' };
  const SYMBOL_DICE = [
    ['ab', 8, ['', 's', 's', 's,s', 'a', 'a', 's,a', 'a,a']],
    ['pr', 12, ['', 's', 's', 's,s', 's,s', 'a', 's,a', 's,a', 's,a', 'a,a', 'a,a', 'tr']],
    ['di', 8, ['', 'f', 'f,f', 't', 't', 't', 't,t', 'f,t']],
    ['ch', 12, ['', 'f', 'f', 'f,f', 'f,f', 't', 't', 'f,t', 'f,t', 't,t', 't,t', 'de']],
    ['bo', 6, ['', '', 's', 's,a', 'a,a', 'a']],
    ['se', 6, ['', '', 'f', 'f', 't', 't']],
  ];
  const LADDER = { '-4': 'Horrifying', '-3': 'Catastrophic', '-2': 'Terrible', '-1': 'Poor', 0: 'Mediocre', 1: 'Average', 2: 'Fair', 3: 'Good', 4: 'Great', 5: 'Superb', 6: 'Fantastic', 7: 'Epic', 8: 'Legendary' };

  /** A result table typed one row a line: "1-5 Failure", "96+ Absolute success", "7 Something". A row can end with a tier
   * in brackets, like "(good)", to colour it. */
  function tableRows(text) {
    const rows = [];
    for (const line of String(text || '').split('\n')) {
      const m = /^\s*(-?\d+)\s*(?:(\+)|(?:-|–|to)\s*(-?\d+))?\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const lo = Number(m[1]), hi = m[2] ? Infinity : m[3] !== undefined ? Number(m[3]) : lo;
      const tm = /\((crit|good|partial|bad|botch)\)$/i.exec(m[4]);
      rows.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi), text: tm ? m[4].slice(0, tm.index).trim() : m[4], tier: tm ? tm[1].toLowerCase() : null });
    }
    if (rows.length) { rows[0].lo = Math.min(rows[0].lo, -Infinity); }
    return rows;
  }

  // ------------------------------------------------------------ numbers in and out
  /** A system's numbers, each one there and in range: the defaults, then the campaign's, then these. */
  function params(sys, ...layers) {
    const p = {};
    for (const d of sys.params) {
      let v = d.def;
      for (const L of layers) if (L && L[d.key] !== undefined && L[d.key] !== null && L[d.key] !== '') v = L[d.key];
      if (d.type === 'num') { v = Math.round(Number(v)); if (!isFinite(v)) v = d.def; v = Math.max(d.min, Math.min(d.max, v)); }
      else if (d.type === 'bool') v = v === true || v === 1 || v === '1' || v === 'true';
      else if (d.type === 'sel') { const hit = d.opts.find(([o]) => String(o) === String(v)); v = hit ? hit[0] : d.def; }
      else v = String(v).replace(/[#@\n]/g, '').slice(0, 40) || d.def;
      p[d.key] = v;
    }
    return p;
  }
  /** "pool n=7 t=6 …": a system and its numbers, as stored after the @ of a roll. */
  function encode(sys, p) {
    return [sys.id, ...sys.params.map(d => `${d.key}=${encodeURIComponent(d.type === 'bool' ? (p[d.key] ? 1 : 0) : p[d.key])}`)].join(' ');
  }
  function decode(str) {
    const [id, ...kv] = String(str || '').trim().split(/\s+/);
    const sys = BY_ID[id];
    if (!sys) return null;
    const raw = {};
    for (const x of kv) { const i = x.indexOf('='); if (i > 0) { try { raw[x.slice(0, i)] = decodeURIComponent(x.slice(i + 1)); } catch { /* skip */ } } }
    return { sys, p: params(sys, raw) };
  }
  /** The roll to store: its dice, @ the system, # the label. */
  function rollText(sys, p, label = '') {
    const l = String(label || '').replace(/[@\n]/g, '').trim();
    return `${sys.build(p)} @${encode(sys, p)}${l ? ` # ${l}` : ''}`;
  }
  /** Read a rolled roll (Dice.roll's result) that has a system: null when it has none or the system is unknown. */
  function read(res, ctx) {
    if (!res.system) return null;
    const d = decode(res.system);
    if (!d) return null;
    const one = res.results[0];
    return { sys: d.sys, p: d.p, ...d.sys.read(one, d.p, ctx || {}) };
  }
  /** How likely each tier is, from n rolls of fresh dice: { crit, good, partial, bad, botch } adding up to 1. */
  function odds(sys, p, ctx, n = 3000) {
    const count = Object.fromEntries(TIERS.map(t => [t, 0]));
    let none = 0;
    Dice.simulate(sys.build(p), n, one => {
      const t = sys.read(one, p, ctx || {}).tier;
      if (t) count[t]++; else none++;
    });
    if (none === n) return null;
    for (const t of TIERS) count[t] /= n;
    return count;
  }

  // ------------------------------------------------------------ Start from a game
  // Each preset says which system a game's core roll follows and with what numbers. labels rename a number on the roller.
  const PRESETS = [
    { id: 'dnd5e', name: 'D&D 5th edition (2014 and 2024)', system: 'd20', params: { tn: 15, crit: 20, fumble: true }, labels: { tn: 'DC' } },
    { id: 'pf1', name: 'Pathfinder 1st edition / D&D 3.5', system: 'd20', params: { tn: 15, crit: 20, fumble: true }, labels: { tn: 'DC' } },
    { id: 'pf2', name: 'Pathfinder 2nd edition', system: 'd20', params: { tn: 15, crit: 20, fumble: true, margin: 10 }, labels: { tn: 'DC' } },
    { id: 'sotdl', name: 'Shadow of the Demon Lord', system: 'd20', params: { tn: 10, crit: 0, fumble: false } },
    { id: 'cpred', name: 'Cyberpunk RED', system: 'd20', params: { die: 10, tn: 15, crit: 0, fumble: false }, labels: { tn: 'DV' } },
    { id: 'traveller', name: 'Traveller (Mongoose 2e)', system: 'sum', params: { n: 2, sides: 6, tn: 8 } },
    { id: 'age', name: 'AGE system (Fantasy AGE, Expanse)', system: 'sum', params: { n: 3, sides: 6, tn: 11 } },
    { id: 'd6', name: 'D6 System / Star Wars D6', system: 'sum', params: { n: 3, sides: 6, tn: 10, wild: true } },
    { id: 'fate', name: 'Fate Core / Fate Accelerated', system: 'fudge', params: { dice: '4dF' } },
    { id: 'rolemaster', name: 'Rolemaster / MERP (open-ended d100)', system: 'table', params: { dice: '1d100', open: true } },
    { id: 'pbta', name: 'Powered by the Apocalypse (Apocalypse World, Dungeon World, Masks…)', system: 'pbta', params: {} },
    { id: 'ironsworn', name: 'Ironsworn / Starforged', system: 'action', params: {} },
    { id: 'daggerheart', name: 'Daggerheart', system: 'duality', params: { sides: 12, first: 'Hope', second: 'Fear' } },
    { id: 'coc7', name: 'Call of Cthulhu 7th edition', system: 'percent', params: { mode: 'tiers' } },
    { id: 'brp', name: 'RuneQuest / Basic Roleplaying / Delta Green', system: 'percent', params: { mode: 'plain' } },
    { id: 'wfrp4', name: 'Warhammer Fantasy Roleplay 4th edition', system: 'percent', params: { mode: 'sl', doubles: true } },
    { id: 'ua', name: 'Unknown Armies', system: 'percent', params: { mode: 'plain', doubles: true, flip: true } },
    { id: 'gurps', name: 'GURPS', system: 'under3d6', params: { n: 3 } },
    { id: 'cairn', name: 'Into the Odd / Cairn / Black Hack saves', system: 'under20', params: { nat: true } },
    { id: 'v20', name: 'Vampire: The Masquerade 20th anniversary / classic World of Darkness', system: 'pool', params: { d: 10, t: 6, ones: true, botch: 'wod' }, labels: { t: 'Difficulty', n: 'Dice pool' } },
    { id: 'cofd', name: 'Chronicles of Darkness', system: 'pool', params: { d: 10, t: 8, again: 10, exc: 5 } },
    { id: 'exalted', name: 'Exalted', system: 'pool', params: { d: 10, t: 7, dbl: 10 } },
    { id: 'sr5', name: 'Shadowrun 5th edition', system: 'pool', params: { d: 6, t: 5, botch: 'glitch' }, labels: { n: 'Dice pool', need: 'Threshold' } },
    { id: 'yze', name: 'Year Zero Engine (Mutant, Alien, Forbidden Lands…)', system: 'pool', params: { d: 6, t: 6 } },
    { id: 'blades', name: 'Blades in the Dark / Forged in the Dark', system: 'highest', params: {} },
    { id: 'sorcerer', name: 'Sorcerer', system: 'rolloff', params: { d: 10 } },
    { id: 'l5r', name: 'Legend of the Five Rings (1st–4th edition)', system: 'keep', params: { d: 10, explode: true, raise: 5 } },
    { id: 'ore', name: 'One-Roll Engine (Reign, Godlike, Wild Talents)', system: 'sets', params: {} },
    { id: 'genesys', name: 'Genesys / Star Wars (narrative dice)', system: 'symbols', params: {} },
    { id: 'savage', name: 'Savage Worlds', system: 'step', params: { tn: 4, wild: true, raise: 4 } },
    { id: 'oracle', name: 'Solo play: a yes-or-no oracle', system: 'oracle', params: {} },
  ];

  /** The campaign's dice system from its settings (settings.dice.system), or null for free dice only. */
  function campaignSystem(diceSettings) {
    const s = diceSettings?.system;
    const sys = s && BY_ID[s.id];
    if (!sys) return null;
    return { sys, p: params(sys, s.params), labels: s.labels || {}, game: s.game || null, table: s.table || '' };
  }

  /** The number a character sheet's number fills in on a system's game roll: its first main number (a modifier, a
   * stat, a skill, a pool), except a sum of dice, where a sheet's number is the modifier rather than how many dice.
   * null for a system with none (the oracle). */
  function sheetKey(sys) {
    if (sys.id === 'sum') return 'mod';
    return sys.params.find(d => d.main && d.type === 'num')?.key || null;
  }

  /** What a number on a character sheet adds to a game roll. In the d20 games whose sheets keep ability scores (D&D,
   * Pathfinder), a score such as Strength 16 rolls with its modifier, +3; anything else rolls as it is.
   * cs is campaignSystem's answer. Gives { n, note }, note saying how a score was read ("+3"), or ''. */
  const SCORE_GAMES = new Set(['dnd5e', 'pf1', 'pf2']);
  const ABILITY = /^(str(ength)?|dex(terity)?|con(stitution)?|int(elligence)?|wis(dom)?|cha(risma)?)(\s*score)?$/i;
  function sheetNumber(cs, label, value) {
    const n = Math.round(Number(value));
    if (cs && SCORE_GAMES.has(cs.game) && ABILITY.test(String(label || '').trim())) {
      const m = Math.floor((n - 10) / 2);
      return { n: m, note: sign(m) || '+0' };
    }
    return { n, note: '' };
  }

  const DiceSystems = { SYSTEMS, BY_ID, GROUPS, PRESETS, TIERS, SYMBOL, params, encode, decode, rollText, read, odds, tableRows, campaignSystem, sheetKey, sheetNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = DiceSystems;
  else root.DiceSystems = DiceSystems;
})(typeof window !== 'undefined' ? window : globalThis);
