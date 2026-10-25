/* scabard.js — reading a Scabard JSON export for Import from Scabard (Settings → Tools).
 *
 * Plain script, no build step; also loads under Node for its tests. Nothing here talks to the server: app.js asks
 * pick() for the file, parse() checks it is a Scabard export and trims each page and connection to what
 * api/scabard.php needs, plan() counts what is in it for the dialog, order() and batches() put the pages in the order
 * to send them and split them for the request size limit. See docs/superpowers/specs/2026-10-25-scabard-import-design.md. */
'use strict';

(function (root) {
  /** Scabard's kinds of page that become Encyclopedia entries, and the tag each gets. */
  const ENTRY = { Character: 'Person', Place: 'Location', Group: 'Group', Item: 'Item', Note: 'Note', Adventure: 'Adventure', Event: 'Event' };
  /** Kinds skipped: Scabard's own structure, without a page of their own here. */
  const SKIPPED = { Attribute: 'attributes', CCategory: 'categories', Folder: 'folders', FlexTab: 'tabs' };
  /** Connections that are Scabard's housekeeping. */
  const SKIP = new Set(['CONCEPT_OF', 'FOLDER_OF', 'CATEGORY_OF', 'TAB_OF', 'COMMENT_OF', 'CLONE_OF']);
  /** A request body this big is as big as a batch gets (the server takes 2 MB). */
  const BATCH_BYTES = 1_500_000;
  const PAGES_MAX = 300, CONNS_MAX = 3000;

  const str = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const tidy = s => str(s).replace(/\s+/g, ' ').trim().slice(0, 150);

  /** "2025-10-05: Final Preparations" as { date: '2025-10-05', title: 'Final Preparations' }, or null for a name that isn't dated. */
  function sessionOf(name) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s*[:\-–—.]\s*|\s+|$)([\s\S]*)$/.exec(tidy(name));
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (mo < 1 || mo > 12 || d < 1 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, title: m[4].trim() };
  }

  /** The file's text as { pages, conns }, each trimmed to what the server needs. Throws with a reason when it isn't a Scabard export. */
  function parse(text) {
    let o;
    try { o = JSON.parse(String(text)); } catch { throw new Error('That isn\'t a JSON file'); }
    if (!o || typeof o !== 'object' || !Array.isArray(o.pages) || !o.pages.length || !o.pages.every(p => p && typeof p === 'object' && p.page && typeof p.page === 'object' && typeof p.concept === 'string'))
      throw new Error('That isn\'t a Scabard export: it has no pages. In Scabard, Export campaign writes the .json file to use here');
    const concepts = new Map(o.pages.map(p => [p.id, p.concept]));
    const pages = o.pages.map(p => ({
      concept: p.concept, name: tidy(p.page.name), aliases: str(p.page.aliases), brief: str(p.page.briefSummary), description: str(p.page.description),
      secrets: str(p.page.gmSecrets) || str(p.page.secrets), is_secret: !!p.page.isSecret,
      images: [p.page.largeImageURL, p.page.imageURL].map(str).map(s => s.trim()).filter(Boolean), uri: str(p.uri),
    })).filter(p => p.name);
    const conns = (Array.isArray(o.conns) ? o.conns : []).filter(c => c && typeof c === 'object').map(c => ({
      from: tidy(c.from), to: tidy(c.to), fromc: concepts.get(c.fromid) || (c.fromu ? 'User' : ''), toc: concepts.get(c.toid) || '',
      relationship: str(c.relationship).toUpperCase(), fromu: tidy(c.fromu), secret: !!(c.r && c.r.isSecret), former: !!(c.r && c.r.isFormer),
    })).filter(c => c.relationship && c.to && !SKIP.has(c.relationship));
    return { pages, conns };
  }

  /** What an import would make, for the dialog: { kinds: { Person: n, … }, sessions, skipped: { attributes: n, … }, connections, pictures }.
   * sessions: whether dated events become Sessions (else entries tagged Event). */
  function plan({ pages, conns }, { sessions = true } = {}) {
    const out = { kinds: {}, sessions: 0, skipped: {}, connections: 0, pictures: 0, entries: 0 };
    for (const p of pages) {
      if (!ENTRY[p.concept]) { const k = SKIPPED[p.concept] || 'other pages'; out.skipped[k] = (out.skipped[k] || 0) + 1; continue; }
      if (p.concept === 'Event' && sessions && sessionOf(p.name)) { out.sessions++; continue; }
      out.kinds[ENTRY[p.concept]] = (out.kinds[ENTRY[p.concept]] || 0) + 1;
      out.entries++;
      if (p.images.length) out.pictures++;
    }
    out.connections = conns.filter(c => ENTRY[c.fromc] && ENTRY[c.toc] && !(sessions && c.fromc === 'Event' && c.toc === 'Event' && sessionOf(c.from) && sessionOf(c.to))).length;
    return out;
  }

  /** The pages in the order to send them: entries as they come, then dated events by date, so sessions are numbered in order. */
  function order(pages, sessions = true) {
    const dated = p => sessions && p.concept === 'Event' && sessionOf(p.name);
    const rest = pages.filter(p => !dated(p));
    const logs = pages.filter(dated).map((p, i) => [sessionOf(p.name).date, i, p]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map(x => x[2]);
    return [...rest, ...logs];
  }

  /** list split into runs of at most max items whose JSON is under BATCH_BYTES each (an item bigger than that goes alone). */
  function batches(list, max, bytes = BATCH_BYTES) {
    const out = [];
    let cur = [], size = 0;
    for (const item of list) {
      const n = JSON.stringify(item).length + 1;
      if (cur.length && (cur.length >= max || size + n > bytes)) { out.push(cur); cur = []; size = 0; }
      cur.push(item); size += n;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Asks for the .json file and resolves with its text, or null when none is picked. */
  function pick() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
      input.addEventListener('change', async () => {
        input.remove();
        const f = input.files[0];
        resolve(f ? await f.text() : null);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      document.body.append(input);
      input.click();
    });
  }

  const Scabard = { ENTRY, SKIPPED, PAGES_MAX, CONNS_MAX, sessionOf, parse, plan, order, batches, pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = Scabard;
  else root.Scabard = Scabard;
})(typeof window !== 'undefined' ? window : globalThis);
