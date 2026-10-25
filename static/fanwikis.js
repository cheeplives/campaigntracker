/* fanwikis.js — the browser side of fan wikis (api/fanwikis.php): Summary from <wiki> on an Encyclopedia entry, Find
 * Image's Fan wikis tab and the About page's list of the wikis.
 *
 * Plain script, no build step. A module of its own: app.js uses it only when it is loaded (window.FanWikis) and the
 * server says it is switched on, so deleting this file, or switching fan wikis off in the config, leaves the rest
 * of the app as it was. The server does every request to the wikis, so the page needs no new connect-src or img-src.
 *
 * Which wiki: the one the GM picks in the campaign's Settings (settings.fan_wiki), for everyone in the campaign; None
 * (or nothing saved yet) means no fan wiki, for a game of its own. Settings suggests one from the campaign's name and
 * calendar (Calendar of Harptos: the Forgotten Realms Wiki), but nothing is looked up until the GM saves it. */
'use strict';

const FanWikis = (() => {
  let info = null;
  /** The server's list, asked once: { enabled, open_only, wikis: [{ key, name, settings, host, site, license, license_url, open, note }] }. */
  const load = api => (info ??= api('fanwiki_wikis').catch(() => ({ enabled: false, wikis: [] })));
  const on = i => i && i.enabled && i.wikis.length;

  // Words in a campaign's name or calendar, and the wiki they point to. Only wikis the server lists are picked.
  const GUESS = [
    [/harptos|forgotten realms|faer[uû]n|sword coast/i, 'forgottenrealms'], [/spelljammer|wildspace/i, 'spelljammer'], [/dark sun|athas/i, 'darksun'],
    [/greyhawk|oerik|flanaess/i, 'greyhawkonline'], [/imperial calendar|warhammer|old world|reikland/i, 'warhammerfantasy'],
    [/shire reckoning|middle-?earth|one ring|tolkien|eriador/i, 'tolkiengateway'], [/galactic standard|star wars|\bbby\b|\baby\b/i, 'starwars'],
    [/glorantha|orlanth|runequest|dragon pass/i, 'runequest-glorantha'], [/star ?trek|stardate|starfleet/i, 'memory-alpha'],
    [/battletech|mechwarrior|inner sphere/i, 'sarna'], [/travell?er|third imperium/i, 'traveller'], [/fallout|wasteland|vault-tec/i, 'fallout'],
    [/cthulhu|lovecraft|arkham|delta green/i, 'lovecraft'], [/shadowrun|sixth world/i, 'shadowrun'], [/cyberpunk|night city/i, 'cyberpunk'],
    [/expanse|belters?\b/i, 'expanse'], [/rifts|palladium/i, 'rifts'], [/fading suns|known worlds/i, 'fadingsuns'],
    [/world of darkness|vampire|werewolf|mage: the/i, 'whitewolf'], [/firefly|serenity|\bthe verse\b/i, 'firefly'], [/blade ?runner/i, 'bladerunner'],
    [/bebop/i, 'cowboybebop'], [/hero academia|\bmha\b/i, 'myheroacademia'], [/conan|hyborian|cimmeria/i, 'conan'],
    [/twilight:? ?2000/i, 'twilight2000'], [/robotech|macross/i, 'robotech'],
  ];
  function guess(wikis, hint) {
    const has = k => wikis.some(w => w.key === k);
    for (const [re, key] of GUESS) if (re.test(hint) && has(key)) return key;
    const low = hint.toLowerCase();
    return (wikis.find(w => w.open && w.settings.some(s => low.includes(s.toLowerCase()))) || wikis.find(w => w.settings.some(s => low.includes(s.toLowerCase()))))?.key || '';
  }
  /** The campaign's wiki: only the one the GM saved in Settings (ctx.key). None saved, or 'none' for a game of its own: no wiki. */
  const chosen = (i, ctx) => i.wikis.find(w => w.key === ctx.key) || null;

  /** Settings' Fan wiki field: a dropdown with one group per setting (a wiki covering several is in each), open wikis
   * first, starting on ctx.key or the guess. Filled in once the list comes; removed when fan wikis are off. */
  function settingsSelect(ctx) {
    const { el, api } = ctx;
    const sel = el('select', { name: 'fan_wiki', 'aria-label': 'Fan wiki' }, el('option', { value: 'none' }, 'None'));
    load(api).then(i => {
      if (!on(i)) return sel.closest('.field, label')?.remove();
      const settings = [...new Set(i.wikis.flatMap(w => w.settings))].sort((a, b) => a.localeCompare(b));
      sel.append(...settings.map(s => el('optgroup', { label: s }, i.wikis.filter(w => w.settings.includes(s)).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
        .map(w => el('option', { value: w.key }, w.open ? w.name : `${w.name} (not open)`)))));
      // a saved choice (None included) stands; until there is one, the guess is offered, and nothing is used until saved
      sel.value = ctx.key === 'none' ? 'none' : chosen(i, ctx)?.key || guess(i.wikis, ctx.hint || '') || 'none';
    });
    return sel;
  }

  /** Summary from <wiki>, under Generate Summary: ctx { el, btn, api, cid, name (the Name input), pub (the Public notes editor), hint }. */
  function summary(ctx) {
    const { el, btn, api, cid, name, pub } = ctx;
    const box = el('div', { class: 'fanwiki' });
    load(api).then(i => {
      const w0 = on(i) && chosen(i, ctx);
      if (!w0) return box.remove();                    // no wiki for this campaign: nothing to show until Settings has one
      const out = el('div', { class: 'enc-wiki-out', 'aria-live': 'polite' });
      const say = (...t) => out.replaceChildren(el('p', { class: 'muted small' }, ...t));
      async function search() {
        const q = name.value.trim(), w = w0;
        if (!q) return say('Give the entry a name first.');
        say('Looking…');
        try {
          const { hits } = await api('fanwiki_search', { query: { cid, wiki: w.key, q } });
          if (!hits.length) return say(`${w.name} has no article matching "${q}".`);
          out.replaceChildren(el('p', { class: 'muted small' }, `Which of these is it? Pick one to see its summary.`),
            el('div', { class: 'enc-wiki-hits' }, hits.map(h => el('button', { type: 'button', class: 'enc-wiki-hit', onclick: () => show(w, h.page), 'data-tip': `Show the summary of "${h.title}"` },
              el('strong', {}, h.title), h.line ? el('span', { class: 'muted small' }, h.line) : null))),
            el('div', { class: 'row' }, btn('None of these', () => out.replaceChildren(), 'link small')));
        } catch (err) { say(err.message); }
      }
      async function show(w, page) {
        say('Looking…');
        try {
          const s = await api('fanwiki_summary', { query: { cid, wiki: w.key, page } });
          const lic = s.license_url ? el('a', { href: s.license_url, target: '_blank', rel: 'noopener noreferrer' }, s.license) : s.license;
          out.replaceChildren(el('div', { class: 'enc-quote' },
            el('blockquote', {}, s.paragraphs.map(p => el('p', {}, p)), el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'small muted' }, `${s.title}, ${s.wiki}`)),
            el('p', { class: 'small muted fanwiki-terms' }, 'Licence: ', lic, s.fair_use ? '. This wiki states no open licence, so the text is for your campaign\'s own use.' : '.', s.note ? ` ${s.note}` : ''),
            el('div', { class: 'row' },
              btn('Add to notes', ev => {
                for (const p of s.paragraphs) pub.insertText(p);
                pub.insertText('Source: ', { text: s.title, link: s.url }, `, ${s.wiki}, ${s.license}`);
                ev.currentTarget.disabled = true;
              }, 'small', 'Put this summary at the end of the Public notes, with a link to the article and its licence. Rewrite it as you like'),
              btn('Back', search, 'link small'))));
        } catch (err) { out.replaceChildren(el('p', { class: 'muted small' }, err.message), btn('Back', search, 'link small')); }
      }
      box.append(btn(`🗂️ Summary from ${w0.name}`, search, 'small',
        `Look this name up on ${w0.name}, this campaign's fan wiki (set in Settings), and add a short summary of the article to the Public notes, credited`), out);
    });
    return box;
  }

  /** Find Image's tab for the campaign's fan wiki, or null when there is none: { key, label, tip, search(q) -> results }. */
  async function findTab(ctx) {
    const { api, cid } = ctx;
    const i = await load(api);
    if (!on(i)) return null;
    const w = chosen(i, ctx);
    if (!w) return null;
    return { key: 'fanwiki', label: w.name,
      tip: i.open_only ? `Openly licensed pictures from ${w.name}, this campaign's fan wiki`
        : `Pictures from ${w.name}, this campaign's fan wiki: openly licensed ones are copied with their credit, the rest only for your campaign's own use`,
      async search(q) { return (await api('fanwiki_images', { query: { cid, wiki: w.key, q } })).results; } };
  }

  /** The About page's lines: { used, nonOpen }, each an element filled in once the list comes, and taken out (with its
   * list item) when fan wikis are off. */
  function about(ctx) {
    const { el, api, extLink } = ctx;
    const used = el('span', { class: 'fanwiki-about' }), nonOpen = el('span', { class: 'fanwiki-about-nonopen' });
    const name = w => el('span', {}, extLink({ url: w.site, title: w.name }), el('span', { class: 'muted' }, ` · ${w.settings.join(', ')} (${w.license || 'no licence stated'})`));
    const join = list => list.flatMap((w, n) => (n ? ['; ', name(w)] : [name(w)]));
    load(api).then(i => {
      if (!on(i)) { used.closest('li')?.remove(); nonOpen.closest('li')?.remove(); return; }
      const open = i.wikis.filter(w => w.open), closed = i.wikis.filter(w => !w.open);
      used.append('Summary from a fan wiki and Find Image\'s fan wiki tab on an Encyclopedia entry look the name up on the campaign\'s fan wiki (picked in Settings), only when pressed and through this server. ',
        'Openly licensed: ', ...join(open), '. Fandom wikis\' text is CC BY-SA 3.0 unless the wiki says otherwise; each wiki is asked for its own licence when it is used. ',
        'Text added to notes links to its article and names the wiki and licence; a picture keeps its title, artist, licence and source.');
      if (!closed.length && i.open_only) return nonOpen.closest('li')?.remove();
      nonOpen.append(...(closed.length ? ['Fan wikis that are not openly licensed, each credited where it is used: ', ...join(closed), '. ',
        'Non-commercial text is added with its licence named, and text from a wiki with no licence as personal fair use. '] : []),
        i.open_only ? '' : 'Pictures on any fan wiki that are not openly licensed (most of them: screenshots, covers and official art) can be kept on an entry as personal fair use, credited to the wiki, for the campaign\'s own use. ',
        'If a wiki or an owner asks, their text and pictures will be removed.');
    });
    return { used, nonOpen };
  }

  return { load, guess, settingsSelect, summary, findTab, about };
})();
