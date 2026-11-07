/* diff.js — what changed between two versions of a note, for the History dialog: paragraph by paragraph, and within a
 * paragraph that was reworded, word by word.
 *
 * Plain script, no build step, and no page needed (so the same file runs under Node in the tests): it takes text, not
 * HTML, so htmlText() turns a note's stored HTML into plain paragraphs first. */
'use strict';

const Diff = (() => {
  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  /** A note's HTML as plain text, one line per paragraph, list item, heading or quote. */
  function htmlText(html) {
    return String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|aside|tr|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m])
      .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{2,}/g, '\n').trim();
  }

  /** The longest common run of a and b as pairs [i, j] of matching positions, or null when a and b are too big to
   * compare (cells over the limit). */
  function lcs(a, b, limit = 4_000_000) {
    const n = a.length, m = b.length;
    if (n * m > limit) return null;
    const w = m + 1, t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
    return out;
  }

  /** Word by word: [{ t: '=' | '-' | '+', s }] with runs of the same kind joined. */
  function words(oldLine, newLine) {
    const a = oldLine.match(/\s+|\S+/g) || [], b = newLine.match(/\s+|\S+/g) || [];
    const common = lcs(a, b);
    const ops = [];
    const push = (t, s) => { if (ops.length && ops[ops.length - 1].t === t) ops[ops.length - 1].s += s; else ops.push({ t, s }); };
    if (!common) { if (oldLine) push('-', oldLine); if (newLine) push('+', newLine); return ops; }
    let i = 0, j = 0;
    for (const [x, y] of [...common, [a.length, b.length]]) {
      while (i < x) push('-', a[i++]);
      while (j < y) push('+', b[j++]);
      if (x < a.length) { push('=', a[x]); i++; j++; }
    }
    return ops;
  }

  /** The paragraphs of newText against oldText: [{ type: 'same' | 'add' | 'del' | 'change', text, parts? }]. A paragraph
   * reworded in place is one 'change', with its words as parts; otherwise lines only in the old text are 'del' and
   * lines only in the new one 'add'. */
  function lines(oldText, newText) {
    const a = oldText ? String(oldText).split('\n') : [], b = newText ? String(newText).split('\n') : [];
    const common = lcs(a, b);
    const out = [];
    const flush = (dels, adds) => {
      // equal numbers of removed and added lines in a row are taken as rewordings, line for line
      if (dels.length && dels.length === adds.length) dels.forEach((d, k) => out.push({ type: 'change', text: adds[k], parts: words(d, adds[k]) }));
      else { for (const d of dels) out.push({ type: 'del', text: d }); for (const x of adds) out.push({ type: 'add', text: x }); }
    };
    if (!common) { flush(a, b); return out; }
    let i = 0, j = 0;
    for (const [x, y] of [...common, [a.length, b.length]]) {
      const dels = [], adds = [];
      while (i < x) dels.push(a[i++]);
      while (j < y) adds.push(b[j++]);
      flush(dels, adds);
      if (x < a.length) { out.push({ type: 'same', text: a[x] }); i++; j++; }
    }
    return out;
  }

  /** Whether the diff holds any change. */
  const changed = d => d.some(x => x.type !== 'same');
  /** How many paragraphs were added, removed and reworded. */
  function counts(d) {
    const c = { add: 0, del: 0, change: 0 };
    for (const x of d) if (x.type !== 'same') c[x.type]++;
    return c;
  }

  return { htmlText, lcs, words, lines, changed, counts };
})();

if (typeof module !== 'undefined') module.exports = Diff;
