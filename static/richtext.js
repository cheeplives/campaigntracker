/* richtext.js — the word-processor editor for the day's Public and Secret notes, and the one place stored rich
 * text is turned back into page content.
 *
 * Plain script, no build step. The editor is Quill 2 (static/vendor/quill/, BSD licence), loaded the first time a
 * GM opens an editor, so players never download it. Notes are saved as HTML, which api/richtext.php cleans to a
 * strict allow-list; render() applies the same allow-list again in the browser and builds the nodes one by one
 * with createElement, so stored text still never reaches innerHTML. */
'use strict';

const RichText = (() => {
  const { el } = KIT;
  // Keep these three lists the same as api/richtext.php.
  const TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'hr',
    'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'aside']);
  const ALIAS = { b: 'strong', i: 'em', strike: 's', del: 's', h4: 'h3', h5: 'h3', h6: 'h3', div: 'p' };
  const DROP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
    'head', 'title', 'meta', 'link', 'base', 'textarea', 'select', 'option', 'button', 'input', 'form', 'img', 'picture', 'video', 'audio',
    'source', 'track', 'canvas', 'map', 'area']);
  const MAX_DEPTH = 24;

  /** A safe link target, or null: http(s) and mailto only. */
  function safeHref(h) {
    const v = String(h || '').replace(/[\x00-\x20\x7f]+/g, '');
    return /^(https?:\/\/|mailto:)/i.test(v) && v.length <= 2000 ? v : null;
  }

  // A DOMParser document is inert: its scripts never run and its images never load. Nothing from it is kept;
  // only allowed elements are rebuilt, with no attributes but a checked href.
  const parse = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body;
  function copy(from, to, depth, inSecret = false) {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) { to.append(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      let tag = n.nodeName.toLowerCase();
      if (DROP.has(tag)) continue;
      tag = ALIAS[tag] || tag;
      if (!TAGS.has(tag) || depth >= MAX_DEPTH || (tag === 'aside' && inSecret)) { copy(n, to, depth, inSecret); continue; }
      let node;
      if (tag === 'a') {
        const href = safeHref(n.getAttribute('href'));
        if (!href) { copy(n, to, depth); continue; }
        node = el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
      } else if (tag === 'aside') node = el('aside', { class: 'rt-secret', 'data-tip': 'Only GMs ever see this paragraph. The server never sends it to players' });
      else node = document.createElement(tag);
      to.append(node);
      copy(n, node, depth + 1, inSecret || tag === 'aside');
    }
  }
  /** Stored rich text as a DocumentFragment of allowed elements. */
  function render(html) {
    const frag = document.createDocumentFragment();
    copy(parse(html), frag, 0);
    return frag;
  }
  /** A note as it shows on the page: rich text formatted, plain text as it was typed. */
  const view = (text, format, cls = '') => format === 'html'
    ? el('div', { class: `richtext ${cls}`.trim() }, render(text))
    : el('div', { class: `pre ${cls}`.trim() }, text);

  /** Stored rich text split into what everyone may read and its secret paragraphs (GM only), each still rich text.
   * Stored text is already clean, so each secret paragraph is exactly <aside>…</aside>, never nested. */
  const SECRET_RE = /<aside>[\s\S]*?<\/aside>/g;
  const split = html => ({ open: String(html || '').replace(SECRET_RE, ''), secret: (String(html || '').match(SECRET_RE) || []).join('') });

  // ------------------------------------------------------------ Markdown, for the day export
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr', 'aside']);
  function inline(n) {
    let s = '';
    for (const k of n.childNodes) {
      if (k.nodeType === 3) { s += k.nodeValue.replace(/\s+/g, ' '); continue; }
      const tag = k.nodeName.toLowerCase(), t = inline(k);
      if (tag === 'br') s += '\n';
      else if (tag === 'strong') s += t.trim() ? `**${t}**` : t;
      else if (tag === 'em') s += t.trim() ? `*${t}*` : t;
      else if (tag === 's') s += t.trim() ? `~~${t}~~` : t;
      else if (tag === 'code') s += `\`${t}\``;
      else if (tag === 'a') s += `[${t}](${k.getAttribute('href')})`;
      else s += t;
    }
    return s;
  }
  function list(n, depth) {
    const L = [];
    let i = 0;
    for (const li of n.children) {
      if (li.nodeName.toLowerCase() !== 'li') continue;
      const mark = n.nodeName.toLowerCase() === 'ol' ? `${++i}.` : '-';
      const nested = [...li.children].filter(k => /^(ul|ol)$/i.test(k.nodeName));
      const own = li.cloneNode(true);
      [...own.children].filter(k => /^(ul|ol)$/i.test(k.nodeName)).forEach(k => k.remove());
      L.push(`${'   '.repeat(depth)}${mark} ${inline(own).trim()}`);
      for (const k of nested) L.push(...list(k, depth + 1));
    }
    return L;
  }
  function blocks(root) {
    const out = [];
    let run = '';
    const flush = () => { if (run.trim()) out.push(run.trim()); run = ''; };
    for (const k of root.childNodes) {
      const tag = k.nodeType === 1 ? k.nodeName.toLowerCase() : '';
      if (!BLOCK.has(tag)) { const holder = document.createElement('span'); holder.append(k.cloneNode(true)); run += inline(holder); continue; }
      flush();
      if (tag === 'p') out.push(inline(k).trim());
      else if (tag[0] === 'h') out.push(`${'#'.repeat(Number(tag[1]) + 2)} ${inline(k).trim()}`); // under the export's ## sections
      else if (tag === 'ul' || tag === 'ol') out.push(list(k, 0).join('\n'));
      else if (tag === 'blockquote') out.push(blocks(k).split('\n').map(l => `> ${l}`.trimEnd()).join('\n'));
      else if (tag === 'pre') out.push('```\n' + k.textContent.replace(/\n$/, '') + '\n```');
      else if (tag === 'hr') out.push('---');
      else if (tag === 'aside') out.push(`> 🔒 GM only: ${inline(k).trim()}`);
      else if (tag === 'table') {
        const rows = [...k.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inline(td).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
        if (!rows.length) continue;
        const cols = Math.max(...rows.map(r => r.length));
        const line = r => `| ${Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ')} |`;
        out.push([line(rows[0]), `|${' --- |'.repeat(cols)}`, ...rows.slice(1).map(line)].join('\n'));
      }
    }
    flush();
    return out.filter(Boolean).join('\n\n');
  }
  /** Stored rich text as Markdown (GitHub style, for Scabard and wikis). */
  function toMarkdown(html) {
    const holder = document.createElement('div');
    holder.append(render(html));
    return blocks(holder);
  }

  // ------------------------------------------------------------ the editor
  let loading = null;
  /** Load Quill and its stylesheet once. */
  function load() {
    if (window.Quill) return Promise.resolve();
    return loading || (loading = new Promise((resolve, reject) => {
      document.head.append(el('link', { rel: 'stylesheet', href: 'static/vendor/quill/quill.snow.css' }));
      const s = el('script', { src: 'static/vendor/quill/quill.js' });
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => { loading = null; reject(new Error('The editor did not load')); });
      document.head.append(s);
    }));
  }

  const FORMATS = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'header', 'list', 'indent', 'blockquote', 'code-block',
    'table', 'table-row', 'table-body', 'table-container', 'secret'];
  /** A secret paragraph in the editor: a line saved as <aside>, which the server never sends to players. */
  let secretReady = false;
  function registerSecret() {
    if (secretReady) return;
    const Block = window.Quill.import('blots/block');
    class Secret extends Block {}
    Secret.blotName = 'secret';
    Secret.tagName = 'ASIDE';
    window.Quill.register(Secret, true);
    secretReady = true;
  }
  const TABLE_ACTIONS = [['', 'Table…'], ['insert', 'Insert a 3 × 3 table'], ['row', 'Add a row below'], ['col', 'Add a column to the right'],
    ['delrow', 'Delete this row'], ['delcol', 'Delete this column'], ['deltable', 'Delete the table']];

  function toolbar(label, secret) {
    const b = (cls, tipText, value) => el('button', { type: 'button', class: cls, value, 'aria-label': tipText, 'data-tip': tipText });
    const heading = el('select', { class: 'ql-header', 'aria-label': 'Paragraph style' },
      el('option', { value: '1' }), el('option', { value: '2' }), el('option', { value: '3' }), el('option', { selected: true }));
    const table = el('select', { class: 'rt-table', 'aria-label': 'Table', 'data-tip': 'Insert a table, or add and remove rows and columns of the one the cursor is in' },
      TABLE_ACTIONS.map(([v, t]) => el('option', { value: v }, t)));
    const undo = el('button', { type: 'button', class: 'rt-undo', 'aria-label': 'Undo', 'data-tip': 'Undo' }, '↶');
    const redo = el('button', { type: 'button', class: 'rt-redo', 'aria-label': 'Redo', 'data-tip': 'Redo' }, '↷');
    // The tools used most stay on one line; ⋯ shows the rest (strikethrough, quote, clear formatting, tables, undo and
    // redo; Ctrl+Z still undoes) and ⤢ gives the note the whole window. Quill's toolbar turns every <select> in it into its
    // own picker, so the table menu and undo/redo sit beside it.
    const quillBar = el('div', { class: 'rt-quillbar' },
      el('span', { class: 'ql-formats' }, heading),
      el('span', { class: 'ql-formats' }, b('ql-bold', 'Bold'), b('ql-italic', 'Italic'), b('ql-underline', 'Underline')),
      el('span', { class: 'ql-formats' }, b('ql-list', 'Numbered list', 'ordered'), b('ql-list', 'Bulleted list', 'bullet'), b('ql-link', 'Link')),
      secret ? el('span', { class: 'ql-formats' }, el('button', { type: 'button', class: 'ql-secret', 'aria-label': 'GM only paragraph',
        'data-tip': 'Make the paragraphs you have picked GM only: players never see them. Press again to make them public' }, '🔒')) : null,
      el('span', { class: 'ql-formats rt-more' }, b('ql-strike', 'Strikethrough'), b('ql-blockquote', 'Quote'), b('ql-clean', 'Clear formatting')));
    const more = el('button', { type: 'button', class: 'rt-morebtn', 'aria-label': 'More formatting', 'aria-expanded': 'false',
      'data-tip': 'More formatting: strikethrough, quote, clear formatting, tables, undo and redo' }, '⋯');
    const focus = el('button', { type: 'button', class: 'rt-focusbtn', 'aria-label': 'Focus', 'aria-pressed': 'false',
      'data-tip': 'Write in the whole window, at reading width. Esc or ⤡ comes back' }, '⤢');
    const node = el('div', { class: 'rt-toolbar', role: 'toolbar', 'aria-label': `${label} formatting` },
      quillBar, el('span', { class: 'rt-tools' }, more, focus), el('span', { class: 'rt-extra rt-more' }, table, undo, redo));
    more.addEventListener('click', () => { const on = node.classList.toggle('more'); more.setAttribute('aria-expanded', String(on)); });
    return { node, quillBar, table, undo, redo, focus };
  }

  /** A rich text editor for one note. text/format: what is stored now ('plain' text is opened as paragraphs).
   * secret: offer the 🔒 button that makes paragraphs GM only (for GMs, in notes players can read).
   * mentions: { list, create } for the @ list of Encyclopedia names (see mentionPicker).
   * Returns { node, value() }, where value() gives { text, format: 'html' } to save ('' for an empty note). */
  function editor({ text = '', format = 'plain', label = 'Notes', placeholder = '', secret = false, mentions = null } = {}) {
    const bar = toolbar(label, secret);
    const area = el('div', { class: 'rt-area' });
    const node = el('div', { class: 'rt-editor loading' }, bar.node, area);
    let quill = null;
    load().then(() => {
      registerSecret();
      quill = new window.Quill(area, {
        theme: 'snow', bounds: node, placeholder, formats: FORMATS,
        modules: {
          toolbar: bar.quillBar, table: true,
          keyboard: { bindings: { 'table next cell': { key: 'Tab', format: ['table'], handler: range => nextCell(range) } } },
        },
      });
      if (format === 'html') quill.setContents(quill.clipboard.convert({ html: String(text || '') }), 'silent');
      else quill.setText(String(text || ''), 'silent');
      quill.history.clear();
      quill.root.setAttribute('aria-label', label);
      quill.root.setAttribute('aria-multiline', 'true');
      quill.root.setAttribute('role', 'textbox');
      if (mentions) mentionPicker(quill, node, mentions);
      node.classList.remove('loading');
    }).catch(err => { node.classList.remove('loading'); area.textContent = err.message; });

    // Tab moves to the next cell; in the last cell it adds a row first.
    function nextCell(range) {
      const t = quill.getModule('table');
      const [, row, cell] = t.getTable(range);
      if (!cell) return true;
      let next = cell.next || row.next?.children.head;
      if (!next) { t.insertRowBelow(); next = row.next?.children.head; }
      if (next) quill.setSelection(next.offset(quill.scroll), 0, 'user');
      return false;
    }
    bar.table.addEventListener('change', () => {
      const what = bar.table.value;
      bar.table.value = '';
      if (!quill || !what) return;
      quill.focus();
      const t = quill.getModule('table');
      if (what === 'insert') { if (t.getTable()[0]) return; t.insertTable(3, 3); return; }
      if (!t.getTable()[0]) { KIT.toast('Put the cursor in a table first', true); return; }
      ({ row: () => t.insertRowBelow(), col: () => t.insertColumnRight(), delrow: () => t.deleteRow(), delcol: () => t.deleteColumn(), deltable: () => t.deleteTable() })[what]();
    });
    // Focus: the editor takes the window, at reading width, until ⤡ or Esc; what's typed stays in it for the page's own Save
    const head = el('div', { class: 'rt-focushead' }, el('strong', {}, label), el('span', { class: 'small muted' }, 'Esc or ⤡ to go back. Save from the page as usual'));
    node.prepend(head);
    const setFocus = on => {
      node.classList.toggle('rt-focus', on);
      document.documentElement.classList.toggle('rt-focusing', on);
      bar.focus.textContent = on ? '⤡' : '⤢';
      bar.focus.setAttribute('aria-pressed', String(on));
      quill?.focus();
    };
    bar.focus.addEventListener('click', () => setFocus(!node.classList.contains('rt-focus')));
    node.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !ev.defaultPrevented && node.classList.contains('rt-focus')) { ev.stopPropagation(); setFocus(false); } });
    bar.undo.addEventListener('click', () => quill?.history.undo());
    bar.redo.addEventListener('click', () => quill?.history.redo());

    function value() {
      if (!quill) return { text: format === 'html' ? text : String(text || ''), format };
      const empty = !quill.getText().trim() && !quill.root.querySelector('table');
      // Quill writes spaces as &nbsp;, which would stop lines wrapping.
      return { text: empty ? '' : quill.getSemanticHTML().replace(/&nbsp;/g, ' '), format: 'html' };
    }
    /** Add a paragraph of plain text at the end (what was written about something elsewhere, quoted into an entry).
     * runs: more text for the same paragraph, each a string or { text, link } for a link. */
    function insertText(t, ...runs) {
      const parts = [{ text: t }, ...runs.map(r => typeof r === 'string' ? { text: r } : r)];
      if (!quill) {
        const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        const html = parts.map(r => r.link && safeHref(r.link) ? `<a href="${esc(r.link)}">${esc(r.text)}</a>` : esc(r.text)).join('');
        text = format === 'html' ? `${text || ''}<p>${html}</p>` : `${text ? `${text}\n` : ''}${parts.map(r => r.text).join('')}`;
        return;
      }
      let at = quill.getLength() - 1;
      if (quill.getText().trim()) quill.insertText(at++, '\n', 'user');
      for (const r of parts) {
        quill.insertText(at, r.text, { link: r.link && safeHref(r.link) || false }, 'user');
        at += r.text.length;
      }
      quill.setSelection(quill.getLength() - 1, 0, 'silent');
    }
    /** Put rich text (already cleaned, or built from escaped text) in the editor, in place of what's there or below it. */
    function setHtml(html, append = false) {
      if (!quill) { text = append && text ? `${text}${html}` : html; format = 'html'; return; }
      const delta = quill.clipboard.convert({ html });
      if (append && quill.getText().trim()) quill.updateContents({ ops: [{ retain: quill.getLength() }, ...delta.ops] }, 'user');
      else quill.setContents(delta, 'user');
      quill.setSelection(quill.getLength() - 1, 0, 'silent');
    }
    return { node, value, insertText, setHtml, ready: () => !!quill };
  }

  // ------------------------------------------------------------ @ mentions
  /** Typing @ and a few letters lists the Encyclopedia names (and other names) that match; picking one writes the
   * entry's name in place of the @ and what was typed, and the note links it the way it links every name. The last
   * line adds what was typed as a new entry. m: { list() → [{ name, aliases }], create(name) → Promise<bool> }.
   * a, the text it works in: { caret() → index or null, textBefore(index, n) → string, replace(start, end, text),
   * anchor(index) → { top, left } in node's coordinates }. Returns { show, close, keydown(ev) → whether it took the key }. */
  function mentionList(a, node, m) {
    const box = el('ul', { class: 'rt-mentions', role: 'listbox', 'aria-label': 'Encyclopedia names', hidden: true });
    node.append(box);
    let at = -1, items = [], pick = 0, dismissed = -1;
    const close = () => { at = -1; box.hidden = true; box.replaceChildren(); };
    /** The @ being typed before the cursor, as [where the @ is, what follows it], or null. */
    function typed() {
      const i = a.caret();
      if (i === null) return null;
      const before = a.textBefore(i, 41);
      const hit = /(^|[\s(["'])@([^@\n]{0,40})$/.exec(before);
      if (!hit || /^\s/.test(hit[2])) return null;
      return [i - hit[2].length - 1, hit[2]];
    }
    function show() {
      const t = typed();
      if (!t) return close();
      const [where, q] = t, low = q.toLowerCase().trim();
      if (where === dismissed) return close();
      at = where;
      const seen = new Set();
      items = [];
      for (const e of m.list()) {
        const names = [e.name, ...(e.aliases || [])];
        const hit = !low ? e.name : names.find(n => n.toLowerCase().startsWith(low)) || names.find(n => n.toLowerCase().split(/\s+/).some(w => w.startsWith(low)));
        if (!hit || seen.has(e.name)) continue;
        seen.add(e.name);
        items.push({ name: e.name, via: hit !== e.name ? hit : '' });
        if (items.length >= 8) break;
      }
      if (q.trim() && !m.list().some(e => [e.name, ...(e.aliases || [])].some(n => n.toLowerCase() === low))) items.push({ name: q.trim(), create: true });
      if (!items.length) return close();
      pick = Math.min(pick, items.length - 1);
      box.replaceChildren(...items.map((it, i) => el('li', { role: 'option', class: i === pick ? 'on' : '', 'aria-selected': String(i === pick),
        onmousedown: ev => { ev.preventDefault(); choose(i); } },
        it.create ? ['Add ', el('strong', {}, `"${it.name}"`), ' to the Encyclopedia'] : [el('strong', {}, it.name), it.via ? el('span', { class: 'muted' }, ` (${it.via})`) : null])));
      const b = a.anchor(where);
      Object.assign(box.style, { top: `${b.top}px`, left: `${Math.max(0, Math.min(b.left, node.clientWidth - 260))}px` });
      box.hidden = false;
    }
    async function choose(i) {
      const it = items[i], start = at, end = a.caret();
      if (!it || start < 0 || end === null) return;
      close();
      if (it.create && !await m.create(it.name)) return;
      a.replace(start, end, `${it.name} `);
    }
    /** Ahead of the text's own keys while the list is open: arrows move, Enter or Tab picks, Escape leaves the @ as typed. */
    function keydown(ev) {
      if (box.hidden) return false;
      const keys = { ArrowDown: () => { pick = (pick + 1) % items.length; show(); }, ArrowUp: () => { pick = (pick - 1 + items.length) % items.length; show(); },
        Enter: () => choose(pick), Tab: () => choose(pick), Escape: () => { dismissed = at; close(); } };
      if (!keys[ev.key]) return false;
      ev.preventDefault(); ev.stopPropagation();
      keys[ev.key]();
      return true;
    }
    return { show: () => { pick = 0; show(); }, refresh: () => { if (at >= 0) show(); }, close, keydown };
  }
  /** The @ list in a Quill editor. */
  function mentionPicker(quill, node, m) {
    const list = mentionList({
      caret: () => { const sel = quill.getSelection(); return sel && !sel.length ? sel.index : null; },
      textBefore: (i, n) => quill.getText(Math.max(0, i - n), Math.min(n, i)),
      replace: (start, end, text) => {
        quill.deleteText(start, end - start, 'user');
        quill.insertText(start, text, 'user');
        quill.setSelection(start + text.length, 0, 'user');
      },
      anchor: where => { const b = quill.getBounds(where); return { top: quill.root.offsetTop + b.bottom + 4, left: b.left }; },
    }, node, m);
    quill.on('text-change', (delta, old, source) => { if (source === 'user') list.show(); });
    quill.on('selection-change', range => { if (!range) list.close(); else list.refresh(); });
    node.addEventListener('keydown', ev => list.keydown(ev), true);
    return { close: list.close };
  }
  /** The @ list in a one-line text box; holder is the positioned element the list hangs under. Returns { keydown }
   * for the box's own key handler to ask first. */
  function inputMentions(input, holder, m) {
    const list = mentionList({
      caret: () => (input.selectionStart === input.selectionEnd ? input.selectionStart : null),
      textBefore: (i, n) => input.value.slice(Math.max(0, i - n), i),
      replace: (start, end, text) => {
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.setSelectionRange(start + text.length, start + text.length);
        input.focus();
      },
      anchor: () => ({ top: input.offsetTop + input.offsetHeight + 4, left: input.offsetLeft }),
    }, holder, m);
    input.addEventListener('input', () => list.show());
    input.addEventListener('blur', () => list.close());
    return { keydown: ev => list.keydown(ev), close: list.close };
  }

  return { render, view, toMarkdown, editor, load, safeHref, split, inputMentions };
})();
