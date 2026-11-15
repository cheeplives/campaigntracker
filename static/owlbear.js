/* owlbear.js — the At the Table panel as an Owlbear Rodeo extension (panel.html, opened from Owlbear's toolbar; the
 * manifest is api/index.php?a=owlbear_manifest). Owlbear frames the panel with ?obrref=… in its address; only then is
 * Owlbear's SDK loaded (static/vendor/owlbear, MIT), so the panel anywhere else never fetches it.
 *
 * What it adds over a plain frame, each through the SDK:
 *  - Share with this room: a GM puts a Public panel link in the room's metadata, and every player who opens the
 *    extension there sees the campaign without pasting anything. Room metadata is read by everyone in the room, so
 *    only a Public link (what every player may see, read-only) is ever put there; app.js checks that before sharing.
 *  - "It is now Dusk, 3 Firstmonth": when the panel sees time pass, it shows an Owlbear notification and tells the
 *    other panels in the room to look now, instead of on their next poll.
 *  - Look up in the Almanac: a right-click on a token or a piece of text looks its name up in the Encyclopedia.
 *
 * Plain script, no build step. app.js (PANEL) uses window.AlmanacOwlbear; nothing here knows about the campaign. */
'use strict';

(function (root) {
  const active = new URLSearchParams(location.search).has('obrref');
  const NS = 'com.gmsalmanac.panel';
  const SHARED = `${NS}/shared`, CHANNEL = `${NS}/refresh`, MENU = `${NS}/lookup`;
  /** This site's panel: a room's shared link is only for the site that made it. */
  const site = () => location.origin + location.pathname;
  const on = { lookup: null, refresh: null, shared: null };
  let obr = null, gm = false, waitingLookup = '';

  function loadSdk() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'static/vendor/owlbear/owlbear-sdk.js';
      s.onload = () => (root.OBR ? resolve(root.OBR) : reject(new Error('Owlbear SDK did not load')));
      s.onerror = () => reject(new Error('Owlbear SDK did not load'));
      document.head.append(s);
    });
  }
  /** The code a room's metadata shares, or '' (nothing shared, or shared by another site's panel). */
  function codeOf(metadata) {
    const m = metadata && metadata[SHARED];
    return m && m.site === site() && /^[0-9a-f]{64}$/.test(String(m.code || '')) ? m.code : '';
  }
  /** What a right-clicked item is called: its text if it has any (a label, a note), else its name. */
  function nameOf(item) {
    const text = String((item && item.text && item.text.plainText) || '').trim();
    return (text || String((item && item.name) || '').trim()).split('\n')[0].slice(0, 80);
  }

  const ready = !active ? Promise.resolve(false) : loadSdk().then(OBR => new Promise(resolve => OBR.onReady(() => resolve(OBR)))).then(async OBR => {
    obr = OBR;
    gm = (await OBR.player.getRole()) === 'GM';
    OBR.player.onChange?.(p => { gm = p.role === 'GM'; });
    OBR.room.onMetadataChange(md => on.shared?.(codeOf(md)));
    OBR.broadcast.onMessage(CHANNEL, () => on.refresh?.());
    await OBR.contextMenu.create({
      id: MENU,
      icons: [{ icon: new URL('static/icons/owlbear.svg?v=2', location.href).href, label: 'Look up in the Almanac', filter: { max: 1 } }],
      onClick(context) {
        const name = nameOf(context.items[0]);
        if (!name) return;
        OBR.action.open();
        if (on.lookup) on.lookup(name); else waitingLookup = name;
      },
    });
    return true;
  }).catch(err => { console.warn(err); obr = null; return false; });

  root.AlmanacOwlbear = {
    /** Whether Owlbear Rodeo is showing this page. */
    active,
    /** Resolves true once the SDK is ready, false outside Owlbear or when it can't be reached. */
    ready,
    isGM: () => gm,
    /** Listen: 'lookup' (name), 'refresh' (), 'shared' (code or ''). A lookup asked for before anyone listened is handed over. */
    on(what, fn) {
      on[what] = fn;
      if (what === 'lookup' && waitingLookup) { const n = waitingLookup; waitingLookup = ''; fn(n); }
    },
    /** The Public panel link code this room shares, or ''. */
    async shared() { return obr ? codeOf(await obr.room.getMetadata()) : ''; },
    /** GM: share a Public panel link's code with the room, or stop (no code). */
    async share(code) {
      if (!obr) return;
      await obr.room.setMetadata({ [SHARED]: code ? { site: site(), code } : undefined });
    },
    /** Time passed: say so here, and have the room's other panels look now. */
    async timePassed(text) {
      if (!obr) return;
      await Promise.all([obr.notification.show(text, 'INFO'), obr.broadcast.sendMessage(CHANNEL, { at: Date.now() }, { destination: 'REMOTE' })]).catch(() => {});
    },
  };
})(window);
