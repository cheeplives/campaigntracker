/* mdimport.js — reading Markdown notes (an Obsidian vault, a folder of .md files, a zip of them, or our own Markdown
 * export) for Import from Markdown (Settings → Tools).
 *
 * Plain script, no build step; also loads under Node for its tests. Nothing here talks to the server: pick() asks for
 * the files, unzip() opens a zip, parse() turns the files into entries and connections for api/mdimport.php, plan()
 * counts them for the dialog, batches() splits them for the request size limit.
 *
 * What a file becomes:
 *   - its name: front matter title:, else the first "# heading", else the file's name;
 *   - other names: front matter aliases: / alias:;  tags: front matter tags: (and #hashtags are left in the text);
 *   - Category: front matter category: / type: / kind: when it is one of ours, else the top folder if that is one
 *     (Locations/, People/, NPCs/, Items/, Groups/, Factions/, Vehicles/), else the folder becomes a tag;
 *   - GM only: front matter secret: / gm_only: true, or our own export's "🔒 GM only";
 *   - notes: the body as rich text; a "## 🔒 GM notes" section (our export) becomes the GM notes;
 *   - connections: each [[wikilink]] or link to another .md file in the import becomes "Related to"; our export's
 *     "## Connections" list keeps its words ("Member of").
 * Pictures are not brought in (a ![[picture]] is left out); that waits for uploads to be part of the import. */
'use strict';

(function (root) {
  const ENTRIES_MAX = 200, LINKS_MAX = 3000, BATCH_BYTES = 1_500_000, FILES_MAX = 2000, NOTE_MAX = 200_000;
  const CATEGORY = { location: 'location', locations: 'location', place: 'location', places: 'location', person: 'person', people: 'person',
    npc: 'person', npcs: 'person', character: 'person', characters: 'person', pc: 'person', pcs: 'person', item: 'item', items: 'item',
    group: 'group', groups: 'group', faction: 'group', factions: 'group', organization: 'group', organizations: 'group', organisation: 'group',
    organisations: 'group', vehicle: 'vehicle', vehicles: 'vehicle', quest: 'quest', quests: 'quest', plot: 'quest', plots: 'quest' };
  const TRUE = /^(true|yes|y|1|on)$/i;

  const str = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const tidy = (s, n = 150) => str(s).replace(/\s+/g, ' ').trim().slice(0, n);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const key = s => tidy(s).toLowerCase();
  const baseName = p => p.replace(/^.*\//, '').replace(/\.(md|markdown|txt)$/i, '');

  // ------------------------------------------------------------ zip
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t open a zip with compressed files; unzip it first and pick the .md files');
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  /** The text files of a zip: [{ path, text }] for .md/.markdown files only, by the zip's central directory. */
  async function unzip(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('That isn\'t a zip file');
    const count = u16(bytes, end + 10);
    let o = u32(bytes, end + 16);
    const out = [], dec = new TextDecoder('utf-8');
    if (count > 50_000) throw new Error('That zip holds too many files');
    for (let n = 0; n < count; n++) {
      if (u32(bytes, o) !== 0x02014b50) throw new Error('That zip is damaged');
      const method = u16(bytes, o + 10), size = u32(bytes, o + 20), nameLen = u16(bytes, o + 28), extraLen = u16(bytes, o + 30), commentLen = u16(bytes, o + 32);
      const local = u32(bytes, o + 42);
      const path = dec.decode(bytes.subarray(o + 46, o + 46 + nameLen)).replace(/\\/g, '/');
      o += 46 + nameLen + extraLen + commentLen;
      if (path.endsWith('/') || !/\.(md|markdown)$/i.test(path) || /(^|\/)(__MACOSX|\.obsidian|\.trash)\//.test(path) || /(^|\/)\._/.test(path)) continue;
      if (size > 5_000_000) continue;
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const raw = bytes.subarray(start, start + size);
      out.push({ path, text: dec.decode(method === 0 ? raw : method === 8 ? await inflate(raw) : (() => { throw new Error('That zip uses a kind of compression this can\'t open'); })()) });
    }
    return out;
  }

  // ------------------------------------------------------------ front matter
  const unq = s => { s = s.trim(); return /^(["']).*\1$/.test(s) && s.length > 1 ? s.slice(1, -1) : s; };
  const listOf = v => (Array.isArray(v) ? v : str(v).split(/\s*,\s*/)).map(x => tidy(unq(String(x)).replace(/^#/, ''), 40)).filter(Boolean);
  /** { meta, body }: the YAML-ish block between --- lines at the top (key: value, key: [a, b], or a "- item" list), and the rest. */
  function frontMatter(text) {
    const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return { meta: {}, body: text.replace(/^﻿/, '') };
    const meta = {};
    let last = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s+-\s+(.*)$/.exec(line) || (last && /^-\s+(.*)$/.exec(line));
      if (item && last) { (Array.isArray(meta[last]) ? meta[last] : (meta[last] = [])).push(unq(item[1])); continue; }
      const kv = /^([A-Za-z_][\w -]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      last = kv[1].trim().toLowerCase();
      const v = kv[2].trim();
      meta[last] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(x => unq(x)).filter(Boolean) : v === '' ? [] : unq(v);
    }
    return { meta, body: text.slice(m[0].length) };
  }

  // ------------------------------------------------------------ Markdown → rich text
  /** Inline Markdown as rich text (strong, em, s, code, links to http(s) only); wikilinks show their words. */
  function inline(s) {
    const keep = [];
    const hold = h => { keep.push(h); return `\u0000${keep.length - 1}\u0000`; };
    s = s.replace(/!\[\[[^\]]*\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    s = s.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, a) => esc(tidy(a || t, 200)));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => (/^https?:\/\//i.test(u) ? hold(`<a href="${esc(u)}">${esc(t)}</a>`) : esc(t)));
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => hold(`<a href="${esc(u)}">${esc(u)}</a>`));
    s = esc(s)
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/==([^=]+)==/g, '$1').replace(/\^[A-Za-z0-9-]+$/, '');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
  }
  /** Block-level Markdown as rich text: headings, paragraphs, bullet and numbered lists, quotes, rules, code. */
  function toHtml(md) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [], list = null, fence = null;
    const flush = () => { if (para.length) { const h = inline(para.join(' ').trim()).trim(); if (h) out.push(`<p>${h}</p>`); para = []; } };
    const endList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence !== null) {
        if (/^\s*(```|~~~)/.test(line)) { out.push(`<p>${fence.map(esc).join('<br>')}</p>`); fence = null; } else fence.push(line);
        continue;
      }
      if (/^\s*(```|~~~)/.test(line)) { flush(); endList(); fence = []; continue; }
      if (/^\s*%%.*%%\s*$/.test(line)) continue; // an Obsidian comment
      let m;
      if (/^\s*$/.test(line)) { flush(); endList(); continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); endList(); const n = Math.min(3, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); endList(); out.push('<hr>'); continue; }
      if ((m = /^\s*(?:[-*+]|(\d+)[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line))) {
        flush();
        const tag = m[1] ? 'ol' : 'ul';
        if (list && list.tag !== tag) endList();
        (list ||= { tag, items: [] }).items.push(m[2]);
        continue;
      }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flush(); endList();
        const q = [m[1]];
        while (i + 1 < lines.length && (m = /^\s*>\s?(.*)$/.exec(lines[i + 1]))) { q.push(m[1]); i++; }
        out.push(`<blockquote><p>${inline(q.join(' ').trim())}</p></blockquote>`);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      endList();
      para.push(line.trim());
    }
    if (fence) out.push(`<p>${fence.map(esc).join('<br>')}</p>`);
    flush(); endList();
    return out.join('').slice(0, NOTE_MAX);
  }

  // ------------------------------------------------------------ one file
  const FOOT = /^\*Exported from Campaign Chronicle\b.*\*\s*$/;
  /** Our own export's "*Person · 🔒 GM only · Also called A, B · Tags: x, y*" line, read back; null when the line isn't one. */
  function aboutLine(line) {
    const m = /^\*([^*]+)\*\s*$/.exec(line.trim());
    if (!m) return null;
    const parts = m[1].split(' · ').map(s => s.trim());
    const out = { category: '', secret: false, aliases: [], tags: [] };
    let any = false;
    for (const p of parts) {
      if (CATEGORY[p.toLowerCase()]) { out.category = CATEGORY[p.toLowerCase()]; any = true; }
      else if (p === '🔒 GM only') { out.secret = true; any = true; }
      else if (/^Also called /.test(p)) { out.aliases = p.slice(11).split(/\s*,\s*/).filter(Boolean); any = true; }
      else if (/^Tags: /.test(p)) { out.tags = p.slice(6).split(/\s*,\s*/).filter(Boolean); any = true; }
      else return null;
    }
    return any ? out : null;
  }
  const mdLinkTarget = u => { try { return decodeURIComponent(u); } catch { return u; } };

  /** One file as an entry: { name, aliases, category, tags, is_secret, notes, gm_notes, targets: [{ to, label?, note?, path? }] } or null for an empty one. */
  function readFile(f) {
    const { meta, body: raw } = frontMatter(f.text);
    let body = raw.replace(/\r\n?/g, '\n');
    const parts = f.path.split('/');
    const entry = { path: f.path, name: '', aliases: [], category: '', tags: [], is_secret: false, notes: '', gm_notes: '', targets: [], folder: parts.length > 1 ? parts[parts.length - 2] : '' };
    entry.name = tidy(meta.title || meta.name || '');
    if (!entry.name) { // the first "# heading", taken out of the body
      const h = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
      if (h && body.slice(0, h.index).trim() === '') { entry.name = tidy(h[1]); body = body.slice(h.index + h[0].length); }
    } else {
      const h = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
      if (h && body.slice(0, h.index).trim() === '' && tidy(h[1]).toLowerCase() === entry.name.toLowerCase()) body = body.slice(h.index + h[0].length);
    }
    if (!entry.name) entry.name = tidy(baseName(f.path));
    entry.aliases = listOf(meta.aliases ?? meta.alias ?? []);
    entry.tags = listOf(meta.tags ?? meta.tag ?? []);
    const cat = CATEGORY[key(str(meta.category ?? meta.type ?? meta.kind ?? ''))];
    if (cat) entry.category = cat;
    entry.is_secret = TRUE.test(str(meta.secret ?? meta.gm_only ?? meta.is_secret ?? meta['gm only'] ?? ''));
    // our own export: the about line, GM notes, connections, files and footer
    const lines = body.split('\n');
    let first = lines.findIndex(l => l.trim() !== '');
    const about = first >= 0 ? aboutLine(lines[first]) : null;
    if (about) {
      lines.splice(first, 1);
      entry.category ||= about.category; entry.is_secret ||= about.secret;
      entry.aliases.push(...about.aliases); entry.tags.push(...about.tags);
    }
    const sections = { notes: [], gm: [], conns: [], files: [] };
    let at = 'notes';
    for (const l of lines) {
      const h = /^##\s+(.*?)\s*$/.exec(l);
      if (h && /^🔒\s*GM notes$/i.test(h[1])) { at = 'gm'; continue; }
      if (h && /^Connections$/i.test(h[1])) { at = 'conns'; continue; }
      if (h && /^Files$/i.test(h[1])) { at = 'files'; continue; }
      if (h && (at === 'conns' || at === 'files')) at = 'notes';
      if (FOOT.test(l.trim())) continue;
      sections[at].push(l);
    }
    for (const l of sections.conns) {
      const m = /^\s*[-*]\s+(.*?)\s*\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*?))?\s*(🔒)?\s*$/.exec(l);
      if (m) entry.targets.push({ to: tidy(m[2]), path: mdLinkTarget(m[3]), label: tidy(m[1], 40), note: tidy(m[4] || '', 200), secret: !!m[5] });
    }
    const text = sections.notes.join('\n');
    // wikilinks and links to other notes in the import are connections
    for (const w of text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) entry.targets.push({ to: tidy(w[1].replace(/\.md$/i, '')) });
    for (const w of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)\s]*)?\)/gi)) entry.targets.push({ to: '', path: mdLinkTarget(w[1]) });
    entry.notes = toHtml(text);
    entry.gm_notes = toHtml(sections.gm.join('\n'));
    entry.aliases = [...new Set(entry.aliases.map(a => tidy(a)).filter(a => a && a.toLowerCase() !== entry.name.toLowerCase()))].slice(0, 30);
    entry.tags = [...new Set(entry.tags)].slice(0, 20);
    return entry;
  }

  /** The files [{ path, text }] as { entries, links, skipped }: entries for api/mdimport.php, links between them by name. */
  function parse(files) {
    files = files.filter(f => /\.(md|markdown)$/i.test(f.path) && !/(^|\/)(\.obsidian|\.trash|__MACOSX)\//.test(f.path));
    if (!files.length) throw new Error('No Markdown (.md) files were found');
    if (files.length > FILES_MAX) throw new Error(`That is ${files.length} files; ${FILES_MAX} is the most at a time. Import a folder at a time`);
    // a zip of an Obsidian vault has one folder around everything: drop it so the next folder down is the Category
    const tops = new Set(files.map(f => f.path.split('/')[0]));
    const wrapped = tops.size === 1 && files.every(f => f.path.includes('/'));
    if (wrapped) files = files.map(f => ({ ...f, path: f.path.slice(f.path.indexOf('/') + 1) }));
    const skipped = { empty: 0, index: 0, duplicates: 0 };
    // our export's index page ("# Campaign: Encyclopedia", only links to the pages) is not an entry
    const read = [];
    for (const f of files) {
      const e = readFile(f);
      if (/: Encyclopedia$/.test(e.name) && f.text.includes('*Exported from Campaign Chronicle')) { skipped.index++; continue; }
      read.push(e);
    }
    const byPath = new Map(), byName = new Map(), entries = [];
    for (const e of read) {
      if (!e.name) { skipped.empty++; continue; }
      if (byName.has(key(e.name))) { skipped.duplicates++; byPath.set(e.path.toLowerCase(), byName.get(key(e.name))); continue; }
      // the top folder: a Category when it is one, else a tag (only when the notes are filed in folders by kind)
      const top = e.path.includes('/') ? e.path.split('/')[0] : '';
      if (top && !e.category) { if (CATEGORY[key(top)]) e.category = CATEGORY[key(top)]; else e.tags.push(tidy(top, 40)); }
      byName.set(key(e.name), e);
      byPath.set(e.path.toLowerCase(), e);
      entries.push(e);
    }
    const links = [], seen = new Set();
    let unresolved = 0;
    for (const e of entries) for (const t of e.targets) {
      let to = null;
      if (t.path) {
        const p = t.path.replace(/^\.\//, '');
        const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : '';
        to = byPath.get((dir + p).toLowerCase()) || byPath.get(p.toLowerCase()) || [...byPath].find(([k]) => k.endsWith('/' + p.toLowerCase()))?.[1] || null;
      }
      to ||= byName.get(key(t.to)) || null;
      if (!to) { unresolved++; continue; }
      if (to === e) continue;
      const label = t.label || 'Related to';
      // "Related to" reads the same both ways: one of a pair is enough
      const k = (label === 'Related to' ? [key(e.name), key(to.name)].sort() : [key(e.name), key(to.name)]).concat(label.toLowerCase()).join('\u0001');
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ from: e.name, to: to.name, label, note: t.note || '', secret: !!t.secret });
    }
    return { entries: entries.map(({ name, aliases, category, tags, is_secret, notes, gm_notes }) => ({ name, aliases, category, tags, is_secret, notes, gm_notes })), links, skipped: { ...skipped, links: unresolved } };
  }

  /** What the dialog says is in the import. */
  function plan(p) {
    const cats = {};
    for (const e of p.entries) cats[e.category || 'with no Category'] = (cats[e.category || 'with no Category'] || 0) + 1;
    return { entries: p.entries.length, categories: cats, links: p.links.length, tags: new Set(p.entries.flatMap(e => e.tags.map(key))).size, secret: p.entries.filter(e => e.is_secret || e.gm_notes).length, skipped: p.skipped };
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

  /** Asks for .md files, a folder of them, or a zip, and resolves with [{ path, text }] (empty when none is picked). */
  function pick() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = '.md,.markdown,.zip,text/markdown,application/zip'; input.hidden = true;
      input.addEventListener('change', async () => {
        input.remove();
        const out = [];
        try {
          for (const f of input.files) {
            if (/\.zip$/i.test(f.name)) out.push(...await unzip(await f.arrayBuffer()));
            else if (/\.(md|markdown)$/i.test(f.name)) out.push({ path: f.webkitRelativePath || f.name, text: await f.text() });
          }
        } catch (err) { resolve({ error: err.message }); return; }
        resolve(out.length || !input.files.length ? out : { error: 'Pick Markdown (.md) files, or a zip of them' });
      });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      document.body.append(input);
      input.click();
    });
  }

  const MdImport = { ENTRIES_MAX, LINKS_MAX, CATEGORY, unzip, frontMatter, toHtml, readFile, parse, plan, batches, pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = MdImport;
  else root.MdImport = MdImport;
})(typeof window !== 'undefined' ? window : globalThis);
