/* encyclopedia.js — the Proper Noun Detector, and the hotlinks that join written text to the Encyclopedia tab.
 *
 * Plain script, no build step. Nothing here talks to the server: app.js hands it the text (what was just saved, or
 * everything in the campaign for a full scan) and the names already known, and gets back the new names to offer.
 *
 * A name is offered when it is
 *   - capitalized: a run of capitalized words ("Bank of Altdorf", "Order of the Silver Flame"), leaving out common
 *     words and the calendar's own names (months, weekdays, shifts, moons). A lone capitalized word that opens a
 *     sentence or sits in a title is offered only when it isn't an everyday English word and is never written in
 *     lower case ("Walking", "Today" and "Ambush on the road" stay out; "Beastmen" and "Marienburg" come through);
 *   - emphasized by formatting: bold, italic or underlined in rich text notes;
 *   - set apart by typography: between *asterisks*, _underscores_ or quote marks;
 *   - an item of a day's Locations visited list.
 * Each name comes with a guess at its tag from the words around it (an inn is a Location, a Captain a Person) and, when
 * it overlaps a name the Encyclopedia already has ("Hoffmann" beside "Gunther Hoffmann"), the entry it may be another
 * name for. Whoever saved the text says yes or no to each one, so a stray word costs a click, not a wrong entry. */
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
  // Everyday words that turn up capitalized at the start of a sentence or in a title ("Ambush on the road", "Battle at
  // the Bridge", "Rest") and are not names on their own. They are still offered when written capitalized mid-sentence,
  // or as part of a longer run ("Battle of Blackfire Pass").
  const COMMON = new Set(`ambush attack battle siege raid skirmish fight duel war truce peace parley meeting council audience trial
    hearing feast banquet party festival fair market wedding funeral birth death murder theft robbery heist escape chase hunt
    search rescue ransom arrest capture prison trial execution ritual ceremony prayer sermon vision dream omen prophecy
    journey travel voyage march ride crossing arrival departure camp rest sleep watch guard patrol scout spy ambushed
    road path trail bridge gate wall tower keep castle fort fortress camp village town city port harbour harbor docks dock
    inn tavern temple shrine church chapel abbey monastery library tomb crypt cave mine forest wood woods river lake sea
    coast shore island mountain hill valley pass swamp marsh desert plain plains field farm mill manor hall house home
    palace court throne crown kingdom empire realm province county duchy barony land lands border frontier
    king queen prince princess duke duchess count countess baron baroness lord lady knight sir dame captain sergeant
    lieutenant general admiral commander soldier guard guardsman warden sheriff mayor priest priestess bishop abbot monk
    nun brother sister father mother son daughter uncle aunt cousin elder chief chieftain warlord bandit thief assassin
    merchant trader innkeeper smith blacksmith wizard witch sorcerer mage druid cleric paladin ranger rogue bard
    doctor master mistress madam mister miss professor
    gold silver copper coin coins treasure loot gear sword blade dagger axe bow arrow shield armour armor helm ring
    amulet potion scroll book tome map key letter note message rumour rumor news plan plot secret clue trap
    morning evening tonight later earlier before after meanwhile finally suddenly then next now soon late early
    weather rain snow storm fog wind sun moon stars dark light cold heat
    first second third last final new old big small long short great little good bad high low north south east west
    northern southern eastern western upper lower inner outer old new
    aftermath update summary recap session notes note reminder reminders event events downtime travel downtime
    day days week month year dawn dusk night shift hour
    people man men woman women boy girl child children folk party group band crew company army host horde pack
    animal horse horses dog wolf wolves bear boar deer bird dragon goblin goblins orc orcs troll trolls giant giants
    elf elves dwarf dwarves human humans undead skeleton zombie ghost demon devil
    go going went come coming came see saw find found take took make made meet met talk talked speak spoke fight fought
    kill killed leave left arrive arrived return returned buy bought sell sold ask asked tell told
    start starting end ending begin beginning continue continued stop stopped wait waited
    lost missing wanted dead alive wounded sick hurt safe free
    yes no maybe also still again never always sometimes often`.split(/\s+/).filter(Boolean));
  // Little words that can sit inside a name: "Bank of Altdorf", "Order of the Silver Flame", "Ludwig von Holzkrug".
  const JOIN = new Set(['of', 'the', 'de', 'du', 'des', 'la', 'le', 'les', 'von', 'van', 'der', 'den', 'al', 'el', 'di', 'da', 'del', 'y', 'zu']);
  // A lower-case word that finishes a name when it follows capitalized ones: "Grey Lady inn", "Reik river", "Blackfire pass".
  const SUFFIX = new Set(`inn tavern alehouse bridge road street lane gate river lake forest wood woods pass keep tower castle fort
    hill hills mountain mountains valley island isle bay marsh swamp square market docks temple shrine abbey manor estate farm mill
    guild company order house family clan tribe`.split(/\s+/).filter(Boolean));
  const ARTICLE = /^(the|a|an)\s+/i;
  const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;
  const CAP = /^\p{Lu}/u;
  const MAX_WORDS = 6, MAX_LEN = 80;

  // Words that say what kind of thing a name is, in the name itself ("the Grey Lady inn", "Order of the Silver Flame")
  // or just before or after it ("the inn called", "Captain Rolf", "the god Sigmar"). The first list that matches wins.
  const CUES = [
    ['Person', `captain sergeant lieutenant general admiral commander king queen prince princess duke duchess count countess baron
      baroness lord lady knight sir dame mayor sheriff warden priest priestess bishop abbot abbess monk nun brother sister father
      mother son daughter uncle aunt cousin elder chief chieftain warlord master mistress madam mister miss doctor professor
      innkeeper merchant trader smith wizard witch sorcerer mage druid cleric paladin ranger rogue bard assassin thief bandit
      guard soldier mercenary noble emperor empress pope herald steward squire page man woman boy girl old young
      said says asked told replied shouted whispered met meets killed wounded`],
    ['Religion', `god goddess gods temple shrine church chapel cathedral abbey monastery cult faith priest priestess worship
      worshippers followers prayer pray prayed prays blessed holy sacred saint prophet`],
    ['Group', `order guild company band brotherhood sisterhood clan tribe house family gang cult circle society league
      cabal coven council court legion regiment army watch militia crew syndicate consortium followers members`],
    ['Location', `inn tavern town city village hamlet port harbour harbor docks road street lane bridge gate wall tower keep
      castle fort fortress palace hall manor estate farm mill market square forest wood woods river lake sea coast island
      mountain mountains hill hills valley pass swamp marsh desert plain plains cave caves mine mines ruins tomb crypt
      library kingdom empire realm province county duchy barony land lands border near outside inside reached arrived`],
    ['Item', `sword blade dagger axe hammer bow staff wand ring amulet pendant crown helm shield armour armor cloak boots
      gem jewel stone orb potion scroll tome book map key relic artifact artefact chalice idol`],
    ['Event', `battle siege war festival feast tournament coronation wedding funeral massacre plague fire flood eclipse
      conclave summit treaty rebellion uprising revolt`],
  ].map(([tag, words]) => [tag, new Set(words.split(/\s+/).filter(Boolean))]);

  const lower = s => s.toLocaleLowerCase();
  /** The key two spellings of one name share: lower case, no leading article, spaces run together. */
  const keyOf = s => lower(String(s).trim().replace(/\s+/g, ' ')).replace(ARTICLE, '');
  const tidy = s => String(s).replace(/\s+/g, ' ').trim().replace(/^[\s"'“”‘’«»*_(\[{,;:.!?-]+|[\s"'“”‘’«»*_)\]},;:.!?-]+$/gu, '');
  const stripPossessive = w => w.replace(/['’]s$/u, '').replace(/(s)['’]$/u, '$1');
  const isStop = (w, extra) => STOP.has(lower(w)) || extra.has(lower(w));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
   * (or sits in a title), which is offered only when nothing says it is an ordinary word. */
  function capitalRuns(text, extra, titleLike) {
    const out = [];
    for (const line of String(text).split(/\n+/)) {
      let run = [], start = true, prevEnd = 0;
      const flush = () => {
        while (run.length && (run[run.length - 1].join || isStop(run[run.length - 1].w, extra))) run.pop();
        while (run.length && (run[0].join || isStop(run[0].w, extra))) run.shift();
        if (run.length === 1 && run[0].suffix) run = [];
        if (run.length && run.length <= MAX_WORDS * 2) {
          const caps = run.filter(x => !x.join && !x.suffix).length;
          if (caps <= MAX_WORDS) out.push({ term: run.map(x => x.w).join(' '), lone: caps === 1 && (run[0].first || titleLike), word: run[0].w, at: run[0].at });
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
          run.push({ w, first: start, at: m.index });
          if (w !== raw) flush(); // "Altdorf's bank" ends the name at the possessive
        } else if (run.length && JOIN.has(lower(w))) run.push({ w, join: true, at: m.index });
        else if (run.length && !run[run.length - 1].join && SUFFIX.has(lower(w))) { run.push({ w, suffix: true, at: m.index }); flush(); }
        else flush();
        start = false;
      }
      flush();
    }
    return out;
  }

  /** A guess at a name's tag from its own words, else from the nearest cue word within three either side of it, or null. */
  function guessTag(term, context) {
    // The last word of a name says most ("Grey Lady inn" is a place, "Lady Margaret" a person), then any word of it.
    const own = (term.match(WORD) || []).map(lower), last = own[own.length - 1];
    for (const [tag, words] of CUES) if (words.has(last)) return tag;
    for (const [tag, words] of CUES) if (own.some(w => words.has(w))) return tag;
    const tagOf = w => (CUES.find(([, words]) => words.has(w)) || [null])[0];
    const before = (context?.before.match(WORD) || []).map(lower).reverse(), after = (context?.after.match(WORD) || []).map(lower);
    for (let i = 0; i < 3; i++) {
      const t = (before[i] && tagOf(before[i])) || (after[i] && tagOf(after[i]));
      if (t) return t;
    }
    return null;
  }
  /** The text just before and after position at..at+len, cut at the sentence. */
  function around(text, at, len) {
    if (at === undefined) return null;
    const cut = /[.!?…;\n]/;
    const before = text.slice(Math.max(0, at - 60), at).split(cut).pop(), after = text.slice(at + len, at + len + 60).split(cut)[0];
    return { before, after };
  }

  /**
   * The names in sources that aren't in the Encyclopedia yet.
   * sources: [{ text, format: 'plain'|'html', kind, secret, label, title: true for a title line }]
   * opts: { known: names and aliases already entries, ignored: words turned down, stop: more words never to offer,
   *         hints: { 'name': 'Tag' } for names the campaign knows the kind of (regions are Locations, holidays Events) }
   * Returns [{ term, count, secret (found only in GM-only text), tag (a guess, or null), where: [labels] }],
   * most often found first.
   */
  function find(sources, { known = [], ignored = [], stop = [], hints = {} } = {}) {
    const extra = new Set([...stop].map(s => lower(String(s))).filter(Boolean));
    const skip = new Set([...known, ...ignored].map(keyOf));
    const hint = new Map(Object.entries(hints).map(([n, t]) => [keyOf(n), t]));
    const found = new Map();
    const seenLower = new Set(); // words written in lower case somewhere: common words, not names
    const seenMidCap = new Set(); // words written capitalized where a sentence doesn't start: names, even common ones
    const prepared = sources.map(s => {
      const rich = s.format === 'html' ? fromHtml(s.text) : { text: String(s.text || ''), marked: [], heads: [] };
      for (const m of rich.text.matchAll(WORD)) if (!CAP.test(m[0])) seenLower.add(lower(m[0]));
      return { s, ...rich };
    });
    const offer = (term, s, tag, context) => {
      term = tidy(term);
      const k = keyOf(term);
      if (!k || skip.has(k) || extra.has(k) || term.length > MAX_LEN) return;
      const f = found.get(k) || { term: term.replace(ARTICLE, ''), count: 0, secret: true, tag: null, where: [] };
      if (!CAP.test(f.term) && CAP.test(term.replace(ARTICLE, ''))) f.term = term.replace(ARTICLE, ''); // prefer the capitalized spelling
      f.count++;
      f.secret = f.secret && !!s.secret;
      f.tag = f.tag || tag || hint.get(k) || guessTag(term, context) || null;
      if (s.label && !f.where.includes(s.label) && f.where.length < 6) f.where.push(s.label);
      found.set(k, f);
    };
    // First pass: which capitalized words stand mid-sentence anywhere. A common word there ("the Captain", "the Bridge")
    // is a name after all, and so is the same word opening a sentence elsewhere.
    const runsOf = new Map();
    for (const p of prepared) {
      if (p.s.kind === 'locations') continue;
      const lines = p.s.title ? p.text.split('\n') : [p.text];
      const all = lines.map((ln, i) => capitalRuns(ln, extra, (p.s.title && i === 0) || p.heads.some(h => h.trim() === ln.trim())).map(r => ({ ...r, line: ln })));
      runsOf.set(p, all);
      for (const r of all.flat()) if (!r.lone) for (const w of r.term.match(WORD) || []) seenMidCap.add(lower(w));
    }
    for (const { s, text, marked } of prepared) {
      if (s.kind === 'locations') {
        // Every place in the list that has a capitalized word is a Location: "Altdorf", "the Grey Lady inn".
        for (const item of text.split(/[,;\n]+|\s+(?:and|&)\s+/)) {
          const t = tidy(item).replace(ARTICLE, '');
          const words = t.match(WORD) || [];
          if (t && words.length <= MAX_WORDS && words.some(w => CAP.test(w) && !isStop(w, extra))) offer(t, s, 'Location');
        }
        continue;
      }
      for (const m of [...marked, ...setApart(text)]) {
        const t = phrase(m, extra);
        if (!t) continue;
        const at = text.indexOf(m);
        offer(t, s, null, around(text, at < 0 ? undefined : at, m.length));
      }
    }
    for (const [p, all] of runsOf) {
      for (const r of all.flat()) {
        const w = lower(r.word);
        if (r.lone && (seenLower.has(w) || /(ing|ed|ly)$/i.test(r.word) || (COMMON.has(w) && !seenMidCap.has(w)))) continue;
        offer(r.term, p.s, null, around(r.line, r.at, r.term.length));
      }
    }
    return [...found.values()].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  }

  /** Entries whose name or alias contains term (or is contained in it), or starts or ends with the same word: the ones it
   * may be another name for ("Hoffmann" and "Gunther Hoffmann", "Gunther the innkeeper" and "Gunther Hoffmann").
   * entries: [{ id, name, aliases }]. Most alike first. */
  function related(term, entries) {
    const k = keyOf(term), kw = (k.match(WORD) || []);
    const ends = w => w.length > 2 && !STOP.has(w) && !JOIN.has(w) && !COMMON.has(w);
    const edges = new Set([kw[0], kw[kw.length - 1]].filter(w => w && ends(w)));
    const score = e => {
      let best = 0;
      for (const n of [e.name, ...(e.aliases || [])]) {
        const nk = keyOf(n), nw = (nk.match(WORD) || []);
        if (nk === k) return 0;
        if (nk.includes(k) || k.includes(nk)) best = Math.max(best, 3);
        else if ([nw[0], nw[nw.length - 1]].some(w => edges.has(w))) best = Math.max(best, 2);
      }
      return best;
    };
    return entries.map(e => [e, score(e)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([e]) => e);
  }

  /** The sentences of a text that name one of names, each trimmed to about 220 characters. */
  function excerpts(text, names) {
    const alt = names.filter(Boolean).map(n => esc(n.trim()).replace(/\s+/g, '\\s+')).join('|');
    if (!alt) return [];
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${alt})(?![\\p{L}\\p{N}])`, 'iu');
    const out = [];
    for (const sentence of String(text || '').split(/(?<=[.!?…])\s+|\n+/)) {
      const t = sentence.replace(/\s+/g, ' ').trim();
      if (!t || !re.test(t)) continue;
      out.push(t.length > 220 ? `${t.slice(0, 219).trimEnd()}…` : t);
    }
    return out;
  }

  // ------------------------------------------------------------ hotlinks
  /** A linker for entries [{ id, name, aliases }]: text() turns a string into text and links, tree() links the text
   * inside a rendered note in place. link(entry, text) makes the link node. Names and aliases match whole words, with
   * the first letter in either case ("Warpstone" and "warpstone"); the longest name wins where two overlap. */
  function linker(entries, link) {
    const names = [];
    for (const e of entries) for (const n of [e.name, ...(e.aliases || [])]) if (n && n.trim()) names.push([n.trim(), e]);
    names.sort((a, b) => b[0].length - a[0].length);
    if (!names.length) return { text: t => [String(t ?? '')], tree: root => root, mentions: () => [] };
    const byKey = new Map(names.map(([n, e]) => [lower(n), e]));
    const alt = names.map(([n]) => {
      const c = n[0];
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
  /** Every name an entry goes by. */
  const namesOf = e => [e.name, ...(e.aliases || [])].filter(Boolean);

  return { find, related, excerpts, linker, plain, keyOf, namesOf, guessTag };
})();
