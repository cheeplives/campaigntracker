/* GM's Almanac Import — a Roll20 Mod (API) script that turns a GM's Almanac Encyclopedia export into Roll20 handouts.
 *
 * Roll20 gives outside programs no way in, and a Mod can't fetch anything, so the Encyclopedia comes over as text the
 * GM pastes once:
 *   1. In GM's Almanac: Encyclopedia → ⬇ Export… → "Roll20 handouts", and open the .txt file it downloads.
 *   2. In Roll20: make a handout named "Almanac Import", paste the file's text into its GM Notes, and save.
 *   3. In the game's chat, as GM:   !almanac import
 * Each entry becomes a handout: its notes for everyone, its GM notes and GM-only paragraphs in the handout's GM Notes,
 * its connections as links to the other handouts. GM-only entries are handouts only the GM sees. Importing again
 * updates the handouts made before (this script remembers which is which) instead of making new ones.
 *
 *   !almanac import            from the handout named "Almanac Import"
 *   !almanac import My Notes   from another handout
 *   !almanac import --hidden   every handout for the GM only, to hand out one at a time
 *   !almanac forget            forget which handouts were imported (the next import makes new ones)
 *   !almanac help
 *
 * Pictures don't come over: a Mod can only use pictures already in a Roll20 library.
 * Needs a Pro subscription on the game's creator, as every Mod script does. MIT licence.
 * https://github.com/cheeplives/campaigntracker */
/* global on, state, findObjs, getObj, createObj, sendChat, playerIsGM, log */
var GMsAlmanacImport = GMsAlmanacImport || (function () {
  'use strict';
  var VERSION = '1.0.0', WHO = "GM's Almanac", SOURCE = 'Almanac Import', MARK = 'ALMANAC1:', BATCH = 15;

  function say(text) { sendChat(WHO, '/w gm ' + text, null, { noarchive: true }); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function store() {
    state.GMsAlmanacImport = state.GMsAlmanacImport || { handouts: {} };
    return state.GMsAlmanacImport;
  }

  /** Base64 to text (UTF-8), by hand: the sandbox promises neither atob nor TextDecoder. */
  function fromBase64(b64) {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = [], bits = 0, n = 0, i, v;
    for (i = 0; i < b64.length; i++) {
      if (b64.charAt(i) === '=') break;
      v = abc.indexOf(b64.charAt(i));
      if (v < 0) throw new Error('not base64');
      bits = (bits << 6) | v; n += 6;
      if (n >= 8) { n -= 8; bytes.push((bits >> n) & 0xff); }
    }
    var out = [], c, cp;
    for (i = 0; i < bytes.length;) {
      c = bytes[i++];
      if (c < 0x80) cp = c;
      else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (bytes[i++] & 0x3f);
      else if (c < 0xf0) { cp = ((c & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
      else { cp = ((c & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
      if (cp > 0xffff) { cp -= 0x10000; out.push(String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))); }
      else out.push(String.fromCharCode(cp));
    }
    return out.join('');
  }

  /** The export inside what was pasted: Roll20's editor wraps it in tags and may break it over lines. */
  function readExport(pasted) {
    var text = String(pasted || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '');
    var at = text.indexOf(MARK);
    if (at < 0) return null;
    var data = JSON.parse(fromBase64(text.slice(at + MARK.length).replace(/[^A-Za-z0-9+/=].*$/, '')));
    if (!data || data.format !== 'gms-almanac-roll20' || !(data.entries instanceof Array)) return null;
    return data;
  }

  /** Stored text with its {{almanac:ID|Name}} marks as links to the handouts made for those entries. */
  function linked(html, ids) {
    return String(html || '').replace(/\{\{almanac:(\d+)\|([^}]*)\}\}/g, function (m, id, name) {
      return ids[id] ? '<a href="http://journal.roll20.net/handout/' + ids[id] + '">' + name + '</a>' : name;
    });
  }

  function runImport(sourceName, hidden) {
    var source = findObjs({ _type: 'handout', name: sourceName })[0];
    if (!source) return say('There is no handout named "' + esc(sourceName) + '". Make one, paste the export from GM\'s Almanac into its GM Notes, save it, and run this again.');
    source.get('gmnotes', function (gmnotes) {
      source.get('notes', function (notes) {
        var data = null;
        try { data = readExport(gmnotes) || readExport(notes); } catch (e) { data = null; }
        if (!data) return say('"' + esc(sourceName) + '" doesn\'t hold a GM\'s Almanac export. Paste the whole text of the .txt file (it starts with ' + MARK + ') into its GM Notes and save.');
        var key = String(data.campaign || 'campaign'), st = store();
        var known = st.handouts[key] = st.handouts[key] || {};
        var ids = {}, made = 0, updated = 0, entries = data.entries, i = 0;
        say('Importing ' + entries.length + ' entries from ' + esc(key) + '…');
        // first every handout exists (so links have somewhere to go), then each gets its text; a few at a time, so a
        // long Encyclopedia doesn't trip the sandbox's watchdog
        function create() {
          for (var end = Math.min(i + BATCH, entries.length); i < end; i++) {
            var e = entries[i], h = known[e.id] ? getObj('handout', known[e.id]) : null;
            var journals = hidden || e.secret ? '' : 'all';
            if (h) { h.set({ name: e.name, inplayerjournals: journals }); updated++; }
            else { h = createObj('handout', { name: e.name, inplayerjournals: journals, archived: false }); known[e.id] = h.id; made++; }
            ids[e.id] = h.id;
          }
          if (i < entries.length) return setTimeout(create, 50);
          i = 0;
          fill();
        }
        function fill() {
          for (var end = Math.min(i + BATCH, entries.length); i < end; i++) {
            var e = entries[i], h = getObj('handout', ids[e.id]);
            if (!h) continue;
            h.set('notes', linked(e.html, ids));
            h.set('gmnotes', linked(e.gm, ids));
          }
          if (i < entries.length) return setTimeout(fill, 50);
          say('Done: ' + made + ' new handout' + (made === 1 ? '' : 's') + ', ' + updated + ' updated. ' +
            (hidden ? 'All are for the GM only; show one to players from its Edit dialog.' : 'GM-only entries are handouts only you see.'));
        }
        create();
      });
    });
  }

  function onChat(msg) {
    if (msg.type !== 'api' || !/^!almanac(\s|$)/.test(msg.content)) return;
    if (!playerIsGM(msg.playerid)) return sendChat(WHO, '/w "' + String(msg.who).replace(/ \(GM\)$/, '').replace(/"/g, '') + '" Only the GM can use !almanac.', null, { noarchive: true });
    var args = msg.content.replace(/^!almanac\s*/, '').trim();
    var hidden = /(^|\s)--hidden(\s|$)/.test(args);
    args = args.replace(/(^|\s)--hidden(\s|$)/, ' ').trim();
    var verb = args.split(/\s+/)[0] || 'help', rest = args.slice(verb.length).trim();
    if (verb === 'import') return runImport(rest || SOURCE, hidden);
    if (verb === 'forget') { store().handouts = {}; return say('Forgotten. The next import makes new handouts; the old ones stay until you delete them.'); }
    say('<b>GM\'s Almanac Import ' + VERSION + '</b><br>1. In GM\'s Almanac: Encyclopedia → Export… → Roll20 handouts.<br>2. Paste the file\'s text into the GM Notes of a handout named "' + SOURCE + '" and save.<br>3. <code>!almanac import</code> (add <code>--hidden</code> to keep every handout for the GM only).<br>Importing again updates the same handouts. <code>!almanac forget</code> starts afresh.');
  }

  on('ready', function () {
    store();
    on('chat:message', onChat);
    log("GM's Almanac Import " + VERSION + ' ready: !almanac help');
  });

  return { VERSION: VERSION, readExport: readExport, fromBase64: fromBase64, linked: linked };
}());
