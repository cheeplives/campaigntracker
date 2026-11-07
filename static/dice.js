/* dice.js — The die roller's engine: reads a free roll ("4d6kh3 + 2 # strength") and rolls it from a seed.
 *
 * Every roll is made from a seed the server picks (api/dice.php), so everyone at the table works out the same dice from
 * the same seed, and nobody can choose their own result: the seed only exists once the roll has been asked for. The
 * notation is the one the roller's ? card lists (static/dice-tab.js, HELP). Plain script, no build step; also loads
 * under Node for tests/browser/dice-engine.spec.js. */
(function (root) {
  'use strict';
  /** Bumped if a seed would ever roll differently, so a stored roll can say which engine rolled it. */
  const VERSION = 1;
  const LIMITS = { count: 100, sides: 1000, draws: 2000, repeat: 20, length: 200, chain: 100 };

  class DiceError extends Error {}
  const bad = msg => { throw new DiceError(msg); };

  // ------------------------------------------------------------ randomness
  /** A seed: 32 hex digits (128 bits). The server's come from random_int; this one is for rolls nobody else sees. */
  function newSeed() {
    const a = new Uint32Array(4);
    (root.crypto || globalThis.crypto).getRandomValues(a);
    return [...a].map(x => x.toString(16).padStart(8, '0')).join('');
  }
  /** Dice from a seed (at most cap of them): sfc32, whose 128 bits of state are the seed itself. int(n) is 1..n, evenly, by throwing away the
   * few draws at the top of the range that would favour the low faces (rejection sampling). */
  function seeded(seed, cap = LIMITS.draws) {
    if (!/^[0-9a-f]{32}$/i.test(String(seed))) bad('That roll has no seed');
    let [a, b, c, d] = [0, 8, 16, 24].map(i => parseInt(seed.slice(i, i + 8), 16) >>> 0);
    const next = () => {
      const t = (((a + b) >>> 0) + d) >>> 0;
      d = (d + 1) >>> 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) >>> 0;
      c = ((c << 21) | (c >>> 11)) >>> 0;
      c = (c + t) >>> 0;
      return t;
    };
    for (let i = 0; i < 12; i++) next();
    let draws = 0;
    return {
      int(n) {
        if (++draws > cap) bad(`Too many dice in one roll (the most is ${cap}, explosions and rerolls included)`);
        const top = Math.floor(0x100000000 / n) * n;
        let x;
        do x = next(); while (x >= top);
        return (x % n) + 1;
      },
    };
  }

  // ------------------------------------------------------------ reading the notation
  /** Shortcuts written as words, swapped for what they stand for before reading. */
  const WORDS = [[/\badv\b|\badvantage\b/g, '2d20kh1'], [/\bdis\b|\bdisadvantage\b/g, '2d20kl1']];

  /** Tidy a free roll for reading: its label (after #) apart, lower case, the maths signs as typed on a keyboard, and
   * no spaces. */
  function tidy(input) {
    const s = String(input ?? '');
    if (s.length > LIMITS.length) bad(`That's too long (the most is ${LIMITS.length} characters)`);
    const hash = s.indexOf('#');
    const label = hash >= 0 ? s.slice(hash + 1).trim() : '';
    let expr = (hash >= 0 ? s.slice(0, hash) : s).toLowerCase().replace(/[−–—]/g, '-').replace(/×/g, '*').replace(/÷/g, '/').replace(/≥/g, '>=').replace(/≤/g, '<=');
    for (const [re, to] of WORDS) expr = expr.replace(re, to);
    expr = expr.replace(/\s+/g, '');
    return { expr, label };
  }

  /** Read a free roll into a tree, or fail with a DiceError that says what is wrong. */
  function parse(input) {
    const { expr, label } = tidy(input);
    if (!expr) bad('Type a roll, like 2d6+3');
    const rep = /^(\d+)x\((.+)\)$/.exec(expr);
    if (rep) {
      const times = Number(rep[1]);
      if (times < 1 || times > LIMITS.repeat) bad(`Repeat a roll 1 to ${LIMITS.repeat} times`);
      return { repeat: times, node: read(rep[2]), expr, label };
    }
    if (/\dx\(/.test(expr)) bad('Repeat goes round the whole roll, like 6x(4d6kh3)');
    return { node: read(expr), expr, label };
  }

  function read(s) {
    let i = 0;
    const peek = (n = 1) => s.slice(i, i + n);
    const eat = t => (s.startsWith(t, i) ? ((i += t.length), true) : false);
    const num = what => {
      const m = /^\d+/.exec(s.slice(i));
      if (!m) bad(`Expected a number ${what} at "${s.slice(i, i + 6) || 'the end'}"`);
      i += m[0].length;
      return Number(m[0]);
    };
    const cmp = (what, bareEquals) => {
      for (const op of ['>=', '<=', '>', '<', '=']) if (eat(op)) return { op, n: num(what) };
      if (bareEquals && /^\d/.test(s.slice(i))) return { op: '=', n: num(what) };
      return null;
    };
    function expr() {
      let left = term();
      for (;;) {
        if (eat('+')) left = { op: '+', a: left, b: term() };
        else if (eat('-')) left = { op: '-', a: left, b: term() };
        else return left;
      }
    }
    function term() {
      let left = unary();
      for (;;) {
        if (eat('*')) left = { op: '*', a: left, b: unary() };
        else if (eat('/')) left = { op: '/', a: left, b: unary() };
        else return left;
      }
    }
    function unary() {
      if (eat('-')) return { op: 'neg', a: unary() };
      if (eat('+')) return unary();
      return primary();
    }
    function primary() {
      if (eat('(')) {
        const e = expr();
        if (!eat(')')) bad('A bracket is missing its )');
        return e;
      }
      const start = i;
      let count = null;
      if (/^\d/.test(peek())) count = num('');
      if (peek() === 'd') { i++; return dice(count ?? 1, start); }
      if (count === null) bad(peek() ? `Can't read "${s.slice(i, i + 6)}"` : 'The roll ends too soon');
      return { num: count };
    }
    function dice(count, start) {
      const t = { dice: true, count };
      if (eat('%')) t.sides = 100;
      else if (peek() === 'f' && !/^f(?:>=|<=|>|<|=|\d)/.test(s.slice(i))) { i++; t.fudge = true; t.sides = 3; }
      else t.sides = num('of sides after d');
      if (t.count < 1 || t.count > LIMITS.count) bad(`Roll 1 to ${LIMITS.count} dice at a time`);
      if (!t.fudge && (t.sides < 2 || t.sides > LIMITS.sides)) bad(`A die has 2 to ${LIMITS.sides} sides`);
      if (t.sides === 66 && !t.fudge) t.d66 = true;
      const once = k => { if (t[k] !== undefined) bad(`Say ${k} once per dice`); };
      for (;;) {
        if (eat('kh') || (peek() === 'k' && /^k\d/.test(s.slice(i)) && eat('k'))) { once('keep'); t.keep = { hi: true, n: num('after kh') }; }
        else if (eat('kl')) { once('keep'); t.keep = { hi: false, n: num('after kl') }; }
        else if (eat('dh')) { once('keep'); t.drop = { hi: true, n: num('after dh') }; t.keep = null; }
        else if (eat('dl')) { once('keep'); t.drop = { hi: false, n: num('after dl') }; t.keep = null; }
        else if (eat('!!')) { once('explode'); t.explode = { compound: true, when: cmp('after !!', true) }; }
        else if (eat('!')) { once('explode'); t.explode = { compound: false, when: cmp('after !', true) }; }
        else if (eat('ro')) { once('reroll'); t.reroll = { once: true, when: cmp('after ro', true) || bad('Say which rolls to reroll, like ro1') }; }
        else if (eat('r')) { once('reroll'); t.reroll = { once: false, when: cmp('after r', true) || bad('Say which rolls to reroll, like r1 or r<3') }; }
        else if (eat('flip')) { once('flip'); t.flip = 'flip'; }
        else if (eat('swap')) { once('flip'); t.flip = 'swap'; }
        else if (peek() === 'b' && /^b\d/.test(s.slice(i))) { i++; once('tens'); t.tens = num('after b'); }
        else if (peek() === 'p' && /^p\d/.test(s.slice(i))) { i++; once('tens'); t.tens = -num('after p'); }
        else if (eat('f')) { once('fail'); t.fail = cmp('after f', true) || bad('Say which rolls are failures, like f1'); }
        else {
          const c = cmp('', false);
          if (!c) break;
          once('success');
          t.success = c;
        }
      }
      if (t.keep === null) delete t.keep;
      if (t.fail && !t.success) bad('Failures (f) cancel successes, so give a success target too, like 7d10>=6f1');
      if ((t.flip || t.tens !== undefined) && t.sides !== 100) bad('flip, swap, b and p are for d100 (or d%)');
      if (t.flip && t.tens !== undefined) bad('Use flip or swap, or bonus and penalty dice, not both');
      if (t.tens !== undefined && (Math.abs(t.tens) < 1 || Math.abs(t.tens) > 2)) bad('Take 1 or 2 bonus (b) or penalty (p) dice');
      const faces = face(t);
      const all = when => when && faces.every(v => test(when, v));
      if (t.explode) {
        if (t.flip || t.tens !== undefined || t.d66) bad('Those dice can\'t explode');
        t.explode.when = t.explode.when || { op: '=', n: Math.max(...faces) };
        if (all(t.explode.when)) bad('Every face would explode, forever');
      }
      if (t.reroll && all(t.reroll.when)) bad('Every face would be rerolled, forever');
      t.src = s.slice(start, i);
      return t;
    }
    const tree = expr();
    if (i < s.length) bad(s[i] === ')' ? 'A ) has no ( to match' : `Can't read "${s.slice(i, i + 6)}"`);
    return tree;
  }
  /** Every face a die of term t can show. */
  function face(t) {
    if (t.fudge) return [-1, 0, 1];
    if (t.d66) { const f = []; for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) f.push(a * 10 + b); return f; }
    return Array.from({ length: t.sides }, (_, k) => k + 1);
  }
  const test = (c, v) => ({ '>=': v >= c.n, '<=': v <= c.n, '>': v > c.n, '<': v < c.n, '=': v === c.n }[c.op]);

  // ------------------------------------------------------------ rolling
  /** Read the two digits of a d100 result (100 is 00) the other way round: 73 → 37, 40 → 4, 100 → 100. */
  const swapped = v => { const t = Math.floor(v / 10) % 10, u = v % 10, w = u * 10 + t; return w === 0 ? 100 : w; };

  /** One die of term t: its value, and how it got there. */
  function oneDie(t, R) {
    const draw = () => {
      if (t.fudge) return R.int(3) - 2;
      if (t.d66) return R.int(6) * 10 + R.int(6);
      return R.int(t.sides);
    };
    const d = { v: 0, rolls: [], rerolled: [] };
    if (t.tens !== undefined) {
      // Call of Cthulhu's bonus and penalty dice: one units die and 1 + N tens dice; the best (bonus) or worst (penalty) tens die counts.
      const units = R.int(10) - 1;
      const tens = Array.from({ length: Math.abs(t.tens) + 1 }, () => (R.int(10) - 1) * 10);
      const reads = tens.map(x => (x + units === 0 ? 100 : x + units));
      d.v = t.tens > 0 ? Math.min(...reads) : Math.max(...reads);
      d.rolls = reads;
      d.note = `${t.tens > 0 ? 'bonus' : 'penalty'}: tens ${tens.map(x => String(x / 10)).join(', ')}, units ${units}`;
      return d;
    }
    let r = draw();
    if (t.reroll) {
      let n = 0;
      while (test(t.reroll.when, r) && n < (t.reroll.once ? 1 : LIMITS.chain)) { d.rerolled.push(r); r = draw(); n++; }
    }
    d.rolls.push(r);
    d.v = r;
    if (t.flip) {
      const w = swapped(r);
      d.v = t.flip === 'swap' ? w : Math.min(r, w);
      d.note = `${t.flip} ${r} ↔ ${w}`;
    }
    if (t.explode?.compound) {
      let last = r, n = 0;
      while (test(t.explode.when, last) && n++ < LIMITS.chain) { last = draw(); d.rolls.push(last); d.v += last; }
      if (d.rolls.length > 1) d.exploded = true;
    }
    return d;
  }

  /** Roll a dice term: its dice (an exploded die adds another die after it), which are kept, and what it comes to. */
  function rollTerm(t, R) {
    const dice = [];
    for (let k = 0; k < t.count; k++) {
      let d = oneDie(t, R);
      dice.push(d);
      if (t.explode && !t.explode.compound) {
        let n = 0;
        while (test(t.explode.when, d.v) && n++ < LIMITS.chain) { d.exploded = true; d = oneDie(t, R); d.extra = true; dice.push(d); }
      }
    }
    const order = dice.map((d, k) => k).sort((x, y) => dice[x].v - dice[y].v || x - y);   // low to high
    const n = dice.length;
    let dropped = [];
    if (t.keep) dropped = t.keep.hi ? order.slice(0, Math.max(0, n - t.keep.n)) : order.slice(Math.min(n, t.keep.n));
    if (t.drop) dropped = t.drop.hi ? order.slice(Math.max(0, n - t.drop.n)) : order.slice(0, Math.min(n, t.drop.n));
    for (const k of dropped) dice[k].dropped = true;
    const kept = dice.filter(d => !d.dropped);
    let value, successes = null, failures = null;
    if (t.success) {
      successes = 0; failures = 0;
      for (const d of kept) {
        if (test(t.success, d.v)) { d.success = true; successes++; }
        else if (t.fail && test(t.fail, d.v)) { d.fail = true; failures++; }
      }
      value = successes - failures;
    } else value = kept.reduce((sum, d) => sum + d.v, 0);
    return { src: t.src, sides: t.fudge ? 'F' : t.sides, dice, value, successes, failures, counts: !!t.success };
  }

  function evalNode(node, R, terms) {
    if ('num' in node) return node.num;
    if (node.dice) { const r = rollTerm(node, R); terms.push(r); return r.value; }
    const a = evalNode(node.a, R, terms);
    if (node.op === 'neg') return -a;
    const b = evalNode(node.b, R, terms);
    if (node.op === '+') return a + b;
    if (node.op === '-') return a - b;
    if (node.op === '*') return a * b;
    if (b === 0) bad('That divides by zero');
    return Math.floor(a / b);   // rounds down, as halving does in most games
  }

  /** One result: the total, and each dice term with its dice. mode is 'successes' when the dice count successes. */
  function rollOnce(node, R) {
    const terms = [];
    const total = evalNode(node, R, terms);
    return { total, terms, mode: terms.length && terms.every(t => t.counts) ? 'successes' : 'total' };
  }

  /** Roll a free roll from a seed. Same input and seed, same result, on every device. Fails with a DiceError. */
  function roll(input, seed) {
    const p = parse(input);
    const R = seeded(seed || newSeed());
    const results = Array.from({ length: p.repeat || 1 }, () => rollOnce(p.node, R));
    return { expr: p.expr, label: p.label, repeat: p.repeat || 0, results, v: VERSION };
  }

  /** "Is this a roll?" for the free-roll box: null when it reads, else what is wrong. */
  function check(input) {
    try { parse(input); return null; } catch (e) { if (e instanceof DiceError) return e.message; throw e; }
  }

  /** The result in a few words: "14", "3 successes", "1 success", or "18, 12, 15…" for a repeat. */
  function summary(r) {
    const one = x => (x.mode === 'successes' ? `${x.total} success${Math.abs(x.total) === 1 ? '' : 'es'}` : String(x.total));
    return r.results.map(one).join(', ');
  }

  const Dice = { VERSION, LIMITS, DiceError, newSeed, seeded, parse, roll, check, summary, swapped };
  if (typeof module !== 'undefined' && module.exports) module.exports = Dice;
  else root.Dice = Dice;
})(typeof window !== 'undefined' ? window : globalThis);
