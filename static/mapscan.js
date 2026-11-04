// mapscan.js — the map text scanner: Tesseract.js (static/vendor/tesseract, loaded the first time it is needed) reads
// the words printed on a map's picture, and candidates() turns them into place names with where each sits on the map,
// for the GM to approve or skip. It all runs in the browser: the picture is read on the GM's device and sent nowhere.
// candidates() is plain logic with no browser in it, so it is tested under Node too.
(function (root) {
  'use strict';
  const BASE = 'static/vendor/tesseract/';
  const MAX_SIDE = 4000;    // a bigger picture is read shrunk to this; a small one is enlarged, as OCR wants letters ~20px+
  const MIN_SIDE = 1600;

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

  /** The picture at url, drawn on a canvas sized for reading: { canvas, k }. */
  async function picture(url) {
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

  const MapScan = { scan, candidates, crop, key };
  if (typeof module === 'object' && module.exports) module.exports = MapScan;
  else root.MapScan = MapScan;
})(typeof globalThis !== 'undefined' ? globalThis : this);
