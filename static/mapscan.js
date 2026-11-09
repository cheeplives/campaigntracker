// mapscan.js — the map text scanner, two ways of reading the place names printed on a map's picture, for the GM to
// approve or skip:
//  - claude(): sends the picture to Anthropic's API with the GM's own API key (kept in their browser only, see
//    apiKey()), and Claude reads the labels, fancy lettering and all. The request goes from the browser straight to
//    Anthropic: the key never reaches this site's server.
//  - scan(): Tesseract.js (static/vendor/tesseract, loaded the first time it is needed) reads the words on this device
//    and candidates() turns them into names. Nothing is sent anywhere, but it reads only plain printed lettering.
// candidates() and fromClaude() are plain logic with no browser in them, so they are tested under Node too.
(function (root) {
  'use strict';
  const BASE = 'static/vendor/tesseract/';
  // Tesseract reads a big picture shrunk to 4000px on its long side, and a small one enlarged to 1600 (it wants letters
  // ~20px+): picture()'s defaults. Claude reads up to 2576px on the long side, with coordinates in that picture's pixels.
  const CLAUDE_SIDE = 2576;
  const CLAUDE_MODEL = 'claude-opus-5-5';
  const KEY_STORE = 'chronicle.anthropicKey';

  let loading = null;
  /** Tesseract.js, loaded once. */
  function lib() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (!loading) loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + 'tesseract.min.js';
      s.onload = () => resolve(root.Tesseract);
      s.onerror = () => { loading = null; reject(new Error("The text scanner didn't load. Check your connection and try again.")); };
      document.head.append(s);
    });
    return loading;
  }

  const LETTER = /\p{L}/u;
  /** A word's text with stray marks (OCR noise, map symbols) trimmed off its ends. */
  const tidy = t => String(t || '').replace(/[‘’]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '').replace(/\.+$/, '').trim();
  /** A name as names are matched: any case, no accents. */
  const key = n => n.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

  /**
   * Place names from Tesseract's blocks (recognize(..., { blocks: true }).data.blocks). k is how much the picture
   * was scaled before reading (its pixels / the map's), so boxes come back in the map's own pixels.
   * The words of each line are joined into names, split where a gap is wider than the letters are tall (two labels
   * side by side); a name needs 3 letters, mostly letters, and a fair confidence. Returns
   * [{ name, conf (0–100), x, y (its centre), box: { x, y, w, h } }], one per name (the surest), most sure first.
   */
  function candidates(blocks, k = 1, opts = {}) {
    const minConf = opts.minConf ?? 45;
    const out = new Map();
    const lines = [];
    for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
    for (const line of lines) {
      const words = (line.words || []).filter(w => w.bbox && tidy(w.text)).sort((a, b) => a.bbox.x0 - b.bbox.x0);
      let group = [];
      const flush = () => {
        if (!group.length) return;
        const text = group.map(w => tidy(w.text)).join(' ').replace(/\s+/g, ' ').trim();
        const letters = [...text].filter(c => LETTER.test(c)).length;
        const conf = group.reduce((t, w) => t + (Number(w.confidence) || 0), 0) / group.length;
        const kept = group;
        group = [];
        if (letters < 3 || letters / text.replace(/\s/g, '').length < 0.7 || conf < minConf || text.length > 60) return;
        {
          const x0 = Math.min(...kept.map(w => w.bbox.x0)) / k, y0 = Math.min(...kept.map(w => w.bbox.y0)) / k;
          const x1 = Math.max(...kept.map(w => w.bbox.x1)) / k, y1 = Math.max(...kept.map(w => w.bbox.y1)) / k;
          const c = { name: text, conf: Math.round(conf), x: (x0 + x1) / 2, y: (y0 + y1) / 2, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
          const was = out.get(key(text));
          if (!was || was.conf < c.conf) out.set(key(text), c);
        }
      };
      for (const w of words) {
        // a word that is mostly digits or marks (a scale bar, a grid number, a misread symbol) ends the name it is in
        const t = tidy(w.text);
        if ([...t].filter(c => LETTER.test(c)).length / t.length < 0.75) { flush(); continue; }
        const prev = group[group.length - 1];
        const tall = Math.max(w.bbox.y1 - w.bbox.y0, prev ? prev.bbox.y1 - prev.bbox.y0 : 0, 1);
        if (prev && w.bbox.x0 - prev.bbox.x1 > tall * 1.2) flush();
        group.push(w);
      }
      flush();
    }
    return [...out.values()].sort((a, b) => b.conf - a.conf);
  }

  /** The picture at url, drawn on a canvas sized for reading (between min and max on its long side): { canvas, k }. */
  async function picture(url, MIN_SIDE = 1600, MAX_SIDE = 4000) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`The map's picture could not be fetched (${res.status})`);
    const bmp = await createImageBitmap(await res.blob());
    const side = Math.max(bmp.width, bmp.height);
    const k = side > MAX_SIDE ? MAX_SIDE / side : side < MIN_SIDE ? Math.min(2, MIN_SIDE / side) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);   // a transparent picture reads as on paper
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return { canvas, k };
  }

  /**
   * Read the words on the picture at url. onProgress(share 0–1, what) is told how it is going (the first scan also
   * downloads about 7 MB, kept by the browser for next time). Resolves { found: candidates(), canvas, k }.
   */
  async function scan(url, onProgress = () => {}) {
    onProgress(0, 'Loading the scanner…');
    const T = await lib();
    const { canvas, k } = await picture(url);
    // A file the worker can't fetch (a server refusing it, say) is reported only to errorHandler, and the worker
    // never answers; without this the dialog would sit on "Loading the scanner…" for ever.
    let fail;
    const failed = new Promise((_, reject) => { fail = err => reject(new Error(`The text scanner couldn't load its files (${String((err && err.message) || err).replace(/^Error: /, '')}). If this keeps happening, the server may be refusing them.`)); });
    failed.catch(() => {});
    const worker = await Promise.race([failed, T.createWorker('eng', 1, {   // 1: the LSTM engine only, the one these files hold
      workerPath: BASE + 'worker.min.js', corePath: BASE.replace(/\/$/, ''), langPath: BASE.replace(/\/$/, ''), workerBlobURL: false,
      // The model is gzipped but named eng.traineddata, as hosts refuse or mangle .gz files (one answered 404); the worker
      // unzips it by its first bytes.
      gzip: false,
      logger: m => {
        if (m.status === 'recognizing text') onProgress(0.2 + 0.8 * (m.progress || 0), 'Reading the map…');
        else onProgress(0.2 * (m.progress || 0), 'Loading the scanner…');
      },
      errorHandler: err => fail(err),
    })]);
    try {
      // 11: sparse text, as labels on a map are. A set DPI stops Tesseract guessing one (and saying so in the console).
      await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1', user_defined_dpi: '150' });
      const { data } = await Promise.race([failed, worker.recognize(canvas, {}, { blocks: true, text: false })]);
      return { found: candidates(data.blocks, k), canvas, k };
    } finally {
      worker.terminate().catch(() => {});
    }
  }

  /** The GM's Anthropic API key, kept in this browser only (never sent to this site's server). set(null) forgets it. */
  const apiKey = {
    get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
    set(v) {
      try { if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE); return true; } catch { return false; }
    },
  };

  const LABELS = {
    type: 'object', additionalProperties: false, required: ['labels', 'legend', 'markers'],
    properties: {
      // a legend or key that lists numbered locations ("1. Garrison"), and where each number is printed on the map
      legend: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['number', 'name'], properties: { number: { type: 'string' }, name: { type: 'string' } } } },
      markers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['number', 'x0', 'y0', 'x1', 'y1'],
        properties: { number: { type: 'string' }, x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' } } } },
      labels: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'x0', 'y0', 'x1', 'y1'],
          properties: { name: { type: 'string' }, x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' } },
        },
      },
    },
  };
  const ask = (w, h) => `This is a map from a tabletop roleplaying campaign, ${w} by ${h} pixels. List every place-name label printed on it: settlements, regions, rivers, lakes, seas, mountains, forests, roads, buildings and other landmarks.

- Leave out anything that isn't a place name: the map's title, a legend or key, a scale bar, compass letters, grid numbers, a signature or credit.
- Write each name as a person would type it, in normal capitalisation (a label in small capitals or all capitals becomes Title Case), with its own spelling, accents and apostrophes. Join the words of one label that run over two lines or bend along a river or a coast.
- Give the box around each label's lettering in this picture's own pixels: x0, y0 its top left corner and x1, y1 its bottom right, with x across from the left edge and y down from the top. For a label that slants or curves, give the box that holds all of it.
- If one name is printed in more than one place, list each place it is printed.
- If there are no place names, return an empty list.
- Some maps number their locations with small circled numbers or badges, and list them in a legend or key ("1. Garrison", "2. Museum"). When this map does, put each legend line in legend (the number as printed, and the location's name written as a person would type it), and every numbered marker you can see on the map in markers (the number as printed, and the box round the marker, as for a label). A marker that is printed more than once is listed each time. Leave the legend's own lines, and the numbers themselves, out of labels. If the map has no numbered legend, legend and markers are empty lists.`;

  /**
   * Claude's answer ({ labels: [{ name, x0, y0, x1, y1 }] }, in the pixels of the picture it was sent, which was the
   * map scaled by k) as candidates in the map's own pixels, in reading order (top to bottom, then left to right).
   * Labels with no letters, or a box outside the picture, are dropped; conf is null (Claude gives none). A numbered
   * marker whose number is in the legend becomes a candidate named as the legend names it, with num set.
   */
  function fromClaude(answer, k = 1, w = Infinity, h = Infinity) {
    const out = [];
    for (const l of (answer && answer.labels) || []) {
      const name = String(l.name || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (!name || !LETTER.test(name)) continue;
      let x0 = Math.min(l.x0, l.x1), x1 = Math.max(l.x0, l.x1), y0 = Math.min(l.y0, l.y1), y1 = Math.max(l.y0, l.y1);
      if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
      if (x1 <= x0 || y1 <= y0) continue;
      out.push({ name, conf: null, x: (x0 + x1) / 2 / k, y: (y0 + y1) / 2 / k, box: { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k } });
    }
    // numbered locations: each marker takes the name the legend gives its number, and wins over a label of the same name
    const num = n => String(n == null ? '' : n).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    const legend = new Map();
    for (const l of (answer && answer.legend) || []) {
      const name = String(l && l.name || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (name && LETTER.test(name) && num(l.number)) legend.set(num(l.number), name);
    }
    const numbered = [];
    for (const m of (answer && answer.markers) || []) {
      const name = legend.get(num(m && m.number));
      if (!name) continue;
      let x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
      if (x1 <= x0 || y1 <= y0) continue;
      numbered.push({ name, conf: null, num: String(m.number).trim(), x: (x0 + x1) / 2 / k, y: (y0 + y1) / 2 / k, box: { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k } });
    }
    const taken = new Set(numbered.map(c => key(c.name)));
    return [...out.filter(c => !taken.has(key(c.name))), ...numbered].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  }

  /** What went wrong with a call to Anthropic, said for a GM rather than a programmer. */
  function claudeError(status, body) {
    const msg = body && body.error && body.error.message ? ` (${body.error.message})` : '';
    if (status === 401) return 'Anthropic didn\'t accept your API key. Check it on your account page.';
    if (status === 403) return `Your API key isn't allowed to do this${msg}.`;
    if (status === 400 && /credit|billing/i.test(msg)) return `Your Anthropic account is out of credit${msg}.`;
    if (status === 429) return 'Anthropic says too many requests right now. Wait a minute and try again.';
    if (status === 413) return 'The picture is too big to send.';
    if (status >= 500) return 'Anthropic is busy or having trouble. Try again in a little while.';
    return `Anthropic refused the scan: ${status}${msg}`;
  }

  /**
   * Read the place names on the picture at url with Claude, using the GM's own API key. onProgress(share or null,
   * what) is told how it is going. Resolves { found: fromClaude(), canvas, k }. signal (an AbortSignal) stops it.
   */
  async function claude(url, key, onProgress = () => {}, signal) {
    if (!key) throw new Error('Add your Anthropic API key on your account page first.');
    onProgress(0, 'Getting the picture ready…');
    const { canvas, k } = await picture(url, 0, CLAUDE_SIDE);
    const data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    onProgress(null, 'Claude is reading the map. This usually takes under a minute…');
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2026-10-21',
          // the request is the GM's own, with their own key, from their own browser: Anthropic asks callers to say so
          'anthropic-dangerous-direct-browser-access': 'true',
          // a request a safety check declines is retried on another model rather than failing
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 16000,
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: LABELS } },
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: ask(canvas.width, canvas.height) },
          ] }],
        }),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error('Couldn\'t reach Anthropic. Check your connection and try again.');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(claudeError(res.status, body));
    if (body.stop_reason === 'refusal') throw new Error('Claude declined to read this picture.');
    if (body.stop_reason === 'max_tokens') throw new Error('The map has more names than one scan can list. Try a smaller part of it.');
    const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let answer;
    try { answer = JSON.parse(text); } catch { throw new Error('Claude\'s answer couldn\'t be read. Try again.'); }
    return { found: fromClaude(answer, k, canvas.width, canvas.height), canvas, k };
  }

  /** A small picture of where a candidate was read, cut from the scanned canvas, as a data: URL. */
  function crop(canvas, k, box, pad = 0.4) {
    const px = Math.max(box.w, box.h) * pad;
    const x = Math.max(0, (box.x - px) * k), y = Math.max(0, (box.y - px) * k);
    const w = Math.min(canvas.width - x, (box.w + 2 * px) * k), h = Math.min(canvas.height - y, (box.h + 2 * px) * k);
    const s = Math.min(1, 220 / w, 70 / h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  const MapScan = { scan, claude, apiKey, candidates, fromClaude, crop, key, MODEL: CLAUDE_MODEL };
  if (typeof module === 'object' && module.exports) module.exports = MapScan;
  else root.MapScan = MapScan;
})(typeof globalThis !== 'undefined' ? globalThis : this);
