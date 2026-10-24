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
    'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
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
  function copy(from, to, depth) {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) { to.append(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      let tag = n.nodeName.toLowerCase();
      if (DROP.has(tag)) continue;
      tag = ALIAS[tag] || tag;
      if (!TAGS.has(tag) || depth >= MAX_DEPTH) { copy(n, to, depth); continue; }
      let node;
      if (tag === 'a') {
        const href = safeHref(n.getAttribute('href'));
        if (!href) { copy(n, to, depth); continue; }
        node = el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
      } else node = document.createElement(tag);
      to.append(node);
      copy(n, node, depth + 1);
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

  // ------------------------------------------------------------ Markdown, for the day export
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr']);
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
    'table', 'table-row', 'table-body', 'table-container'];
  const TABLE_ACTIONS = [['', 'Table…'], ['insert', 'Insert a 3 × 3 table'], ['row', 'Add a row below'], ['col', 'Add a column to the right'],
    ['delrow', 'Delete this row'], ['delcol', 'Delete this column'], ['deltable', 'Delete the table']];

  function toolbar(label) {
    const b = (cls, tipText, value) => el('button', { type: 'button', class: cls, value, 'aria-label': tipText, 'data-tip': tipText });
    const heading = el('select', { class: 'ql-header', 'aria-label': 'Paragraph style' },
      el('option', { value: '1' }), el('option', { value: '2' }), el('option', { value: '3' }), el('option', { selected: true }));
    const table = el('select', { class: 'rt-table', 'aria-label': 'Table', 'data-tip': 'Insert a table, or add and remove rows and columns of the one the cursor is in' },
      TABLE_ACTIONS.map(([v, t]) => el('option', { value: v }, t)));
    const undo = el('button', { type: 'button', class: 'rt-undo', 'aria-label': 'Undo', 'data-tip': 'Undo' }, '↶');
    const redo = el('button', { type: 'button', class: 'rt-redo', 'aria-label': 'Redo', 'data-tip': 'Redo' }, '↷');
    // Quill's toolbar turns every <select> in it into its own picker, so the table menu and undo/redo sit beside it.
    const quillBar = el('div', { class: 'rt-quillbar' },
      el('span', { class: 'ql-formats' }, heading),
      el('span', { class: 'ql-formats' }, b('ql-bold', 'Bold'), b('ql-italic', 'Italic'), b('ql-underline', 'Underline'), b('ql-strike', 'Strikethrough')),
      el('span', { class: 'ql-formats' }, b('ql-list', 'Numbered list', 'ordered'), b('ql-list', 'Bulleted list', 'bullet'), b('ql-blockquote', 'Quote'), b('ql-link', 'Link')),
      el('span', { class: 'ql-formats' }, b('ql-clean', 'Clear formatting')));
    const node = el('div', { class: 'rt-toolbar', role: 'toolbar', 'aria-label': `${label} formatting` },
      quillBar, el('span', { class: 'rt-extra' }, table, undo, redo));
    return { node, quillBar, table, undo, redo };
  }

  /** A rich text editor for one note. text/format: what is stored now ('plain' text is opened as paragraphs).
   * Returns { node, value() }, where value() gives { text, format: 'html' } to save ('' for an empty note). */
  function editor({ text = '', format = 'plain', label = 'Notes', placeholder = '' } = {}) {
    const bar = toolbar(label);
    const area = el('div', { class: 'rt-area' });
    const node = el('div', { class: 'rt-editor loading' }, bar.node, area);
    let quill = null;
    load().then(() => {
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
    return { node, value, insertText, ready: () => !!quill };
  }

  return { render, view, toMarkdown, editor, load, safeHref };
})();
