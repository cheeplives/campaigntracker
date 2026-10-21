/* encyclopedia.js — the Proper Noun Detector, and the hotlinks that join written text to the Encyclopedia tab.
 *
 * Plain script, no build step. Nothing here talks to the server: app.js hands it the text (what was just saved, or
 * everything in the campaign for a full scan) and the names already known, and gets back the new names to offer.
 *
 * A name is offered when it is
 *   - capitalized: a run of capitalized words ("Bank of Altdorf", "Order of the Silver Flame"), leaving out common
 *     words, the calendar's own names (months, weekdays, shifts, moons) and a lone first word of a sentence that is
 *     also written in lower case somewhere ("Walking", "Today");
 *   - emphasized by formatting: bold, italic or underlined in rich text notes;
 *   - set apart by typography: between *asterisks*, _underscores_ or quote marks;
 *   - an item of a day's Locations visited list.
 * Whoever saved the text says yes or no to each one, so a stray word costs a click, not a wrong entry. */
'use strict';

const Nouns = (() => {
  // Common words that are capitalized only because they start a sentence (or always are, like "I" and "OK"), and the
  // words that start a run like "The" and "When". A run is trimmed of them at both ends.
  const STOP = new Set(`a about above after again against all almost along also although always am among an and another any
    anyone anything anyway are around as at away back be because been before behind being below beside besides best better
    between beyond both but by can cannot could did do does doing done down during each either else enough even ever every
    everyone everything few first for from further had has have having he her here hers herself him himself his how however i
    i'd i'll i'm i've if in inside instead into is it it's its itself just last later least less let like many maybe me meanwhile
    might mine more most much must my myself near nearly neither never next no nobody none nor not nothing now of off often oh ok
    okay on once one only onto or other others otherwise our ours ourselves out outside over own perhaps please quite rather
    really same second several shall she should since so some someone something sometimes soon still such than that that's the
    their theirs them themselves then there there's these they they're this those though through throughout thus to today
    together tomorrow tonight too toward towards under unless until up upon us very via was we we're well were what what's
    whatever when whenever where wherever whether which while who whoever whole whom whose why will with within without would
    yes yesterday yet you you're your yours yourself yourselves
    after afterwards again ago ahead alas aye hello hey hi meanwhile no nope note notes oh sure thanks well yeah yep
    day days night week weeks month months year years morning evening afternoon noon midnight dawn midday dusk overnight
    hour hours shift shifts
    monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
    october november december spring summer autumn fall winter
    gm gms npc npcs pc pcs hp xp ac dc dm tbd todo ps`.split(/\s+/).filter(Boolean));
  // Little words that can sit inside a name: "Bank of Altdorf", "Order of the Silver Flame", "Ludwig von Holzkrug".
  const JOIN = new Set(['of', 'the', 'de', 'du', 'des', 'la', 'le', 'les', 'von', 'van', 'der', 'den', 'al', 'el', 'di', 'da', 'del', 'y', 'zu']);
  const ARTICLE = /^(the|a|an)\s+/i;
  const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;
  const CAP = /^\p{Lu}/u;
  const MAX_WORDS = 6, MAX_LEN = 80;

  const lower = s => s.toLocaleLowerCase();
  /** The key two spellings of one name share: lower case, no leading article, spaces run together. */
  const keyOf = s => lower(String(s).trim().replace(/\s+/g, ' ')).replace(ARTICLE, '');
  const tidy = s => String(s).replace(/\s+/g, ' ').trim().replace(/^[\s"'“”‘’«»*_(\[{,;:.!?-]+|[\s"'“”‘’«»*_)\]},;:.!?-]+$/gu, '');
  const stripPossessive = w => w.replace(/['’]s$/u, '').replace(/(s)['’]$/u, '$1');
  const isStop = (w, extra) => STOP.has(lower(w)) || extra.has(lower(w));

  /** Plain text of a rich text note, one line per block, plus the runs set in bold, italic or underline. */
  function fromHtml(html) {
    const body = new DOMParser().parseFromString(String(html || ''), 'text/html').body;
    const marked = [];
    for (const n of body.querySelectorAll('strong, b, em, i, u')) {
      if (n.parentElement.closest('strong, b, em, i, u')) continue; // bold inside italic is one run
      marked.push(n.textContent);
    }
    const heads = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(h => h.textContent);
    for (const b of body.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, br')) b.after('\n');
    for (const c of body.querySelectorAll('td, th')) c.after(' | ');
    return { text: body.textContent, marked, heads };
  }

  /** Phrases set apart by typography: *this*, **this**, _this_, "this", “this”, ‘this’, 'this', «this». */
  function setApart(text) {
    const out = [];
    const PAIRS = [/\*\*([^*\n]+)\*\*/g, /(?:^|[^\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])/gu, /(?:^|[^\p{L}\p{N}_])__?([^_\n]+)__?(?![\p{L}\p{N}_])/gu,
      /"([^"\n]+)"/g, /“([^”\n]+)”/g, /«([^»\n]+)»/g, /‘([^’\n]+)’(?![\p{L}])/gu, /(?:^|[\s(\[])'([^'\n]+)'(?=$|[\s.,;:!?)\]])/gu];
    for (const re of PAIRS) for (const m of text.matchAll(re)) out.push(m[1]);
    return out;
  }

  /** A phrase picked out by formatting or typography, if it reads like a name: a few words, not a sentence. */
  function phrase(raw, extra) {
    const t = tidy(raw).replace(ARTICLE, '');
    if (!t || t.length > MAX_LEN || /[.,!?;:|]/.test(t) || /^\d/.test(t)) return null;
    const words = t.match(WORD) || [];
    if (!words.length || words.length > 5) return null;
    if (words.every(w => isStop(w, extra) || JOIN.has(lower(w)))) return null;
    return t;
  }

  /** Runs of capitalized words in plain text. Each comes with whether it is a lone word that opened a sentence
   * (or sits in a title), which counts only when the word is never written in lower case. */
  function capitalRuns(text, extra, titleLike) {
    const out = [];
    for (const line of String(text).split(/\n+/)) {
      let run = [], start = true, prevEnd = 0;
      const flush = () => {
        while (run.length && (run[run.length - 1].join || isStop(run[run.length - 1].w, extra))) run.pop();
        while (run.length && (run[0].join || isStop(run[0].w, extra))) run.shift();
        if (run.length && run.length <= MAX_WORDS * 2) {
          const caps = run.filter(x => !x.join).length;
          if (caps <= MAX_WORDS) out.push({ term: run.map(x => x.w).join(' '), lone: caps === 1 && (run[0].first || titleLike), word: run[0].w });
        }
        run = [];
      };
      for (const m of line.matchAll(WORD)) {
        const gap = line.slice(prevEnd, m.index);
        prevEnd = m.index + m[0].length;
        if (/[^\s]/.test(gap)) {
          flush();
          if (/[.!?…:;•]|^\s*[-–—*>]/.test(gap)) start = true;
        }
        const raw = m[0], w = stripPossessive(raw);
        if (CAP.test(w) && !/\d/.test(w) && !(w.length <= 3 && w === w.toUpperCase() && w.length > 1)) {
          run.push({ w, first: start });
          if (w !== raw) flush(); // "Altdorf's bank" ends the name at the possessive
        } else if (run.length && JOIN.has(lower(w))) run.push({ w, join: true });
        else flush();
        start = false;
      }
      flush();
    }
    return out;
  }

  /**
   * The names in sources that aren't in the Encyclopedia yet.
   * sources: [{ text, format: 'plain'|'html', kind, secret, label, title: true for a title line }]
   * opts: { known: names already entries, ignored: words turned down, stop: more words never to offer (the calendar's) }
   * Returns [{ term, count, secret (found only in GM-only text), tag ('Location' for a Locations visited item), where: [labels] }],
   * most often found first.
   */
  function find(sources, { known = [], ignored = [], stop = [] } = {}) {
    const extra = new Set([...stop].map(s => lower(String(s))).filter(Boolean));
    const skip = new Set([...known, ...ignored].map(keyOf));
    const found = new Map();
    const seenLower = new Set(); // words written in lower case somewhere: common words, not names
    const prepared = sources.map(s => {
      const rich = s.format === 'html' ? fromHtml(s.text) : { text: String(s.text || ''), marked: [], heads: [] };
      for (const m of rich.text.matchAll(WORD)) if (!CAP.test(m[0])) seenLower.add(lower(m[0]));
      return { s, ...rich };
    });
    const offer = (term, s, tag) => {
      term = tidy(term);
      const k = keyOf(term);
      if (!k || skip.has(k) || extra.has(k) || term.length > MAX_LEN) return;
      const f = found.get(k) || { term: term.replace(ARTICLE, ''), count: 0, secret: true, tag: null, where: [] };
      if (!CAP.test(f.term) && CAP.test(term.replace(ARTICLE, ''))) f.term = term.replace(ARTICLE, ''); // prefer the capitalized spelling
      f.count++;
      f.secret = f.secret && !!s.secret;
      f.tag = f.tag || tag || null;
      if (s.label && !f.where.includes(s.label) && f.where.length < 6) f.where.push(s.label);
      found.set(k, f);
    };
    for (const { s, text, marked, heads } of prepared) {
      if (s.kind === 'locations') {
        // Every place in the list that has a capitalized word is a Location: "Altdorf", "the Grey Lady inn".
        for (const item of text.split(/[,;\n]+|\s+(?:and|&)\s+/)) {
          const t = tidy(item).replace(ARTICLE, '');
          const words = t.match(WORD) || [];
          if (t && words.length <= MAX_WORDS && words.some(w => CAP.test(w) && !isStop(w, extra))) offer(t, s, 'Location');
        }
        continue;
      }
      for (const m of [...marked, ...setApart(text)]) { const t = phrase(m, extra); if (t) offer(t, s); }
      const titled = new Set(heads.map(h => h.trim()));
      const lines = s.title ? text.split('\n') : [text];
      lines.forEach((ln, i) => {
        const titleLike = (s.title && i === 0) || titled.has(ln.trim());
        for (const r of capitalRuns(ln, extra, titleLike)) {
          if (r.lone && seenLower.has(lower(r.word))) continue;
          if (r.lone && /(ing|ed|ly)$/i.test(r.word)) continue; // "Walking to the inn", "Finally"
          offer(r.term, s);
        }
      });
    }
    return [...found.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  }

  // ------------------------------------------------------------ hotlinks
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** A linker for entries [{ id, name }]: text() turns a string into text and links, tree() links the text inside a
   * rendered note in place. link(entry, text) makes the link node. Names match whole words, with the first letter in
   * either case ("Warpstone" and "warpstone"); the longest name wins where two overlap. */
  function linker(entries, link) {
    const list = entries.filter(e => e.name && e.name.trim()).slice().sort((a, b) => b.name.length - a.name.length);
    if (!list.length) return { text: t => [String(t ?? '')], tree: root => root, mentions: () => [] };
    const byKey = new Map(list.map(e => [lower(e.name), e]));
    const alt = list.map(e => {
      const n = e.name.trim(), c = n[0];
      return (lower(c) !== c.toLocaleUpperCase() ? `[${esc(c.toLocaleUpperCase())}${esc(lower(c))}]` : esc(c)) + esc(n.slice(1)).replace(/\s+/g, '\\s+');
    }).join('|');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${alt})(?![\\p{L}\\p{N}])`, 'gu');
    const entryFor = m => byKey.get(lower(m.replace(/\s+/g, ' '))) || null;
    /** Each mention of an entry in t: [{ entry, start, match }]. */
    function scan(t) {
      const out = [];
      for (const m of String(t ?? '').matchAll(re)) {
        const e = entryFor(m[2]);
        if (e) out.push({ entry: e, start: m.index + m[1].length, match: m[2] });
      }
      return out;
    }
    function text(t) {
      t = String(t ?? '');
      const out = [];
      let at = 0;
      for (const { entry, start, match } of scan(t)) {
        if (start > at) out.push(t.slice(at, start));
        out.push(link(entry, match));
        at = start + match.length;
      }
      if (at < t.length || !out.length) out.push(t.slice(at));
      return out;
    }
    function tree(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('a, code, pre')) nodes.push(walker.currentNode);
      for (const n of nodes) {
        const parts = text(n.nodeValue);
        if (parts.length > 1 || typeof parts[0] !== 'string') n.replaceWith(...parts);
      }
      return root;
    }
    /** The entries a text mentions, each once. */
    const mentions = t => [...new Set(scan(t).map(x => x.entry))];
    return { text, tree, mentions };
  }

  /** Plain text of a stored note, for searching: rich text loses its markup. */
  const plain = (text, format) => (format === 'html' ? fromHtml(text).text : String(text || ''));

  return { find, linker, plain, keyOf };
})();
