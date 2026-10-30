/* lore-export.js — the Encyclopedia as files for a virtual tabletop or a wiki: a zip of Markdown pages with their
 * pictures, a Foundry VTT journal, and one entry as a handout to paste into Roll20, Owlbear or anything else.
 *
 * Plain script, no build step, and no page needed: app.js hands it the entries the Encyclopedia tab already received
 * (so a player's export holds only what that player can see) and the pictures' bytes, and gets back text and bytes.
 * The same file runs under Node in the tests. toMarkdown (rich text to Markdown) comes from richtext.js, which needs a
 * page, so it is passed in.
 *
 * An entry here is { id, name, category, aliases, tags: [{ name }], notes, gm_notes, is_secret, files, links }, where
 * links are its connections as seen from it: [{ label, to (an entry id), note, is_secret }], and files are the API's
 * attachments ({ id, name, mime, kind, caption, is_secret, credit, embed, url }). */
'use strict';

(function (root) {
  const CATEGORIES = { location: 'Location', person: 'Person', item: 'Item', group: 'Group', vehicle: 'Vehicle' };
  const SECRET_RE = /<aside>[\s\S]*?<\/aside>/g;
  const has = v => v !== null && v !== undefined && String(v).trim() !== '';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** What goes in an export. A GM's export leaves out GM-only entries, connections, pictures, GM notes and secret
   * paragraphs unless gmOnly is ticked; a player's entries never had them. Connections to an entry left out go too. */
  function pick(entries, { gmOnly = false } = {}) {
    const kept = entries.filter(e => gmOnly || !e.is_secret);
    const ids = new Set(kept.map(e => e.id));
    return kept.map(e => ({
      ...e,
      notes: gmOnly ? e.notes || '' : String(e.notes || '').replace(SECRET_RE, ''),
      gm_notes: gmOnly ? e.gm_notes || '' : '',
      files: (e.files || []).filter(f => gmOnly || !f.is_secret),
      links: (e.links || []).filter(l => ids.has(l.to) && (gmOnly || !l.is_secret)),
    }));
  }

  /** A name safe as a file name on Windows, macOS and Linux, and unique among names (ignoring case). */
  function fileNamer() {
    const used = new Set();
    return (name, ext) => {
      const base = String(name || '').replace(/[\\/:*?"<>|#^[\]\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'Untitled';
      let n = `${base}${ext}`, i = 2;
      while (used.has(n.toLowerCase())) n = `${base} ${i++}${ext}`;
      used.add(n.toLowerCase());
      return n;
    };
  }
  /** A Markdown link target: spaces and brackets escaped, as Obsidian and GitHub both read it. */
  const mdHref = path => path.split('/').map(encodeURIComponent).join('/');
  const mdText = s => String(s).replace(/([\\[\]*_`])/g, '\\$1');

  const extOf = f => (/\.[a-z0-9]{1,5}$/i.exec(f.name || '') || [''])[0].toLowerCase()
    || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[f.mime] || '');
  /** Who made a picture found with Find Image, and its licence, as one line: the credit its licence asks for. */
  function creditLine(c) {
    if (!c) return '';
    const by = c.author ? ` by ${c.author}` : '';
    return [`${c.title || 'Picture'}${by}`, c.license, c.source].filter(has).join(', ');
  }

  /** The pictures and files to put in the zip: [{ entry, file, path }], each with a unique path under pictures/. */
  function plan(entries) {
    const name = fileNamer(), out = [];
    for (const e of entries) for (const f of e.files) if (f.kind !== 'embed') out.push({ entry: e, file: f, path: `pictures/${name(`${e.name} ${f.caption || f.name.replace(/\.[^.]+$/, '')}`, extOf(f))}` });
    return out;
  }

  /** The Markdown export: { files: [{ path, text }] } for each entry and the index, given plan()'s pictures.
   * opts: { campaign, gm, gmOnly, toMarkdown, date }. Pictures' bytes are added by the caller. */
  function markdown(entries, pictures, opts) {
    const page = fileNamer(), byId = new Map(), out = [];
    page('Encyclopedia', '.md');
    for (const e of entries) byId.set(e.id, { e, path: page(e.name, '.md') });
    const link = id => { const t = byId.get(id); return t ? `[${mdText(t.e.name)}](${mdHref(t.path)})` : null; };
    const foot = `*Exported from Campaign Chronicle · ${opts.campaign} · ${opts.gm ? opts.gmOnly ? 'GM view, with GM-only notes' : 'GM view, without GM-only notes' : 'player view'} · ${opts.date}*`;
    for (const e of entries) {
      const L = [`# ${e.name}`, ''];
      const about = [CATEGORIES[e.category], e.is_secret ? '🔒 GM only' : null, e.aliases?.length ? `Also called ${e.aliases.join(', ')}` : null,
        e.tags?.length ? `Tags: ${e.tags.map(t => t.name).join(', ')}` : null].filter(Boolean);
      if (about.length) L.push(`*${about.join(' · ')}*`, '');
      const mine = pictures.filter(p => p.entry.id === e.id);
      for (const p of mine.filter(p => p.file.kind === 'image')) {
        L.push(`![${mdText(p.file.caption || e.name)}](${mdHref(p.path)})`);
        const credit = creditLine(p.file.credit);
        L.push(...(credit ? ['', `*${credit}*`] : []), '');
      }
      for (const f of e.files.filter(f => f.kind === 'embed' && f.embed?.url)) L.push(`[${mdText(f.caption || 'Picture on DeviantArt')}](${f.embed.url})`, '');
      if (has(e.notes)) L.push(opts.toMarkdown(e.notes), '');
      if (opts.gmOnly && has(e.gm_notes)) L.push('## 🔒 GM notes', '', opts.toMarkdown(e.gm_notes), '');
      if (e.links.length) {
        L.push('## Connections', '');
        for (const l of e.links) L.push(`- ${l.label} ${link(l.to)}${has(l.note) ? `: ${l.note}` : ''}${l.is_secret ? ' 🔒' : ''}`);
        L.push('');
      }
      const files = mine.filter(p => p.file.kind !== 'image');
      if (files.length) {
        L.push('## Files', '');
        for (const p of files) L.push(`- [${mdText(p.file.caption || p.file.name)}](${mdHref(p.path)})`);
        L.push('');
      }
      L.push(foot);
      out.push({ path: byId.get(e.id).path, text: L.join('\n') + '\n' });
    }
    // The index: every entry by Category, in the order the Encyclopedia tab lists them.
    const I = [`# ${opts.campaign}: Encyclopedia`, ''];
    for (const [k, title] of [...Object.entries(CATEGORIES), ['', 'No category']]) {
      const list = entries.filter(e => (e.category || '') === k);
      if (!list.length) continue;
      I.push(`## ${title}`, '', ...list.map(e => `- ${link(e.id)}`), '');
    }
    I.push(foot);
    out.unshift({ path: 'Encyclopedia.md', text: I.join('\n') + '\n' });
    return { files: out };
  }

  // ------------------------------------------------------------ Foundry VTT
  /** A Foundry document id: 16 letters and digits. */
  function foundryId(random = Math.random) {
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 16; i++) s += abc[Math.floor(random() * abc.length)];
    return s;
  }
  /** Where the pictures go in Foundry's User Data folder, and so the start of their paths in the journal. */
  const foundryFolder = campaign => `chronicle/${String(campaign || 'campaign').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'campaign'}`;

  /** The Foundry export: one JournalEntry, "<campaign> Encyclopedia", with a page for each entry (and, when gmOnly, a
   * GM-only page for its GM notes), as Foundry's Import Data reads it. Pictures are referred to under folder/, where
   * the GM uploads the zip's pictures. A GM-only entry's pages, and secret paragraphs (as Foundry's own secret blocks),
   * are hidden from players by Foundry too. Connections link to their pages. */
  function foundry(entries, pictures, { campaign, gmOnly = false, random = Math.random }) {
    const folder = foundryFolder(campaign);
    const pageId = new Map(entries.map(e => [e.id, foundryId(random)]));
    const names = new Map(entries.map(e => [e.id, e.name]));
    const pages = [];
    let sort = 0;
    for (const e of entries) {
      const about = [CATEGORIES[e.category], e.aliases?.length ? `Also called ${e.aliases.join(', ')}` : null, e.tags?.length ? `Tags: ${e.tags.map(t => t.name).join(', ')}` : null].filter(Boolean);
      const pics = pictures.filter(p => p.entry.id === e.id && p.file.kind === 'image')
        .map(p => `<p><img src="${esc(`${folder}/${p.path}`)}" alt="${esc(p.file.caption || e.name)}"></p>${creditLine(p.file.credit) ? `<p><em>${esc(creditLine(p.file.credit))}</em></p>` : ''}`);
      const links = e.links.filter(l => names.has(l.to));
      const html = [about.length ? `<p><em>${esc(about.join(' · '))}</em></p>` : '', ...pics, gmOnly ? asideToSecret(e.notes, random) : e.notes || '',
        links.length ? `<h2>Connections</h2><ul>${links.map(l => `<li>${esc(l.label)} @UUID[.${pageId.get(l.to)}]{${esc(names.get(l.to)).replace(/[{}]/g, '')}}${has(l.note) ? `: ${esc(l.note)}` : ''}</li>`).join('')}</ul>` : '']
        .filter(Boolean).join('\n');
      pages.push({ _id: pageId.get(e.id), name: e.name, type: 'text', title: { show: true, level: 1 }, text: { content: html, format: 1 }, sort: sort += 100000,
        ownership: { default: e.is_secret ? 0 : -1 }, flags: {} });
      if (gmOnly && has(e.gm_notes)) pages.push({ _id: foundryId(random), name: `${e.name} (GM notes)`, type: 'text', title: { show: true, level: 1 },
        text: { content: asideToSecret(e.gm_notes, random), format: 1 }, sort: sort += 100000, ownership: { default: 0 }, flags: {} });
    }
    return { name: `${campaign} Encyclopedia`, pages, ownership: { default: 2 }, flags: {} };
  }
  /** Stored rich text with its secret paragraphs as Foundry's secret blocks. */
  function asideToSecret(html, random = Math.random) {
    return String(html || '').replace(/<aside>([\s\S]*?)<\/aside>/g, (m, inner) => `<section class="secret" id="secret-${foundryId(random)}"><p>${inner}</p></section>`);
  }

  // ------------------------------------------------------------ zip
  // A zip with no compression (pictures are compressed already), which every system opens. Names are UTF-8 (flag bit 11).
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /** files: [{ path, data: Uint8Array or string }] → the zip's bytes. date: the files' time (a Date). */
  function zip(files, date = new Date()) {
    const enc = new TextEncoder(), parts = [], central = [];
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const head = (sig, extra) => {
        const b = new DataView(new ArrayBuffer(extra ? 46 : 30));
        let i = 0;
        const u32 = v => { b.setUint32(i, v, true); i += 4; }, u16 = v => { b.setUint16(i, v, true); i += 2; };
        u32(sig);
        if (extra) u16(20);                       // made by
        u16(20); u16(0x0800); u16(0);             // version needed, UTF-8 names, stored
        u16(dosTime); u16(dosDate); u32(crc); u32(data.length); u32(data.length); u16(name.length); u16(0);
        if (extra) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
        return new Uint8Array(b.buffer);
      };
      const local = head(0x04034b50, false);
      parts.push(local, name, data);
      central.push(head(0x02014b50, true), name);
      offset += local.length + name.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  // ------------------------------------------------------------ one entry as a handout
  /** One entry as HTML to paste into a Roll20 handout, an Owlbear note or a Foundry journal page: its name, what it is,
   * its notes and connections. Stored notes are clean already (api/richtext.php), so they go in as they are.
   * names: entry id → name, for the connections. */
  function handout(e, names) {
    const about = [CATEGORIES[e.category], e.aliases?.length ? `Also called ${e.aliases.join(', ')}` : null].filter(Boolean);
    const links = e.links.filter(l => names.has(l.to));
    return [`<h2>${esc(e.name)}</h2>`, about.length ? `<p><em>${esc(about.join(' · '))}</em></p>` : '', e.notes || '',
      links.length ? `<h3>Connections</h3><ul>${links.map(l => `<li>${esc(l.label)} ${esc(names.get(l.to))}${has(l.note) ? `: ${esc(l.note)}` : ''}</li>`).join('')}</ul>` : '']
      .filter(Boolean).join('\n');
  }

  const api = { CATEGORIES, pick, plan, markdown, foundry, foundryFolder, zip, crc32, handout, creditLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LoreExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
