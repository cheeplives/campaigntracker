// Map distance maths, free of the page (so Node can test it): a map's scale from two points or a grid, grid hints from
// a file name, path lengths, distance wording for ground and space maps, and matching pins to entry names.
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  // Metres in each unit a map's scale can be set in; the au and light-year come from engine.js.
  const UNIT_M = { ft: 0.3048, m: 1, mi: 1609.344, km: 1000, au: E.AU, ly: E.LY };
  const ROLL20 = { grid_px: 70, per_square: 5, unit: 'ft' };

  const isSpace = map => map.scale_unit === 'au' || map.scale_unit === 'ly';

  function scaleFromPoints(a, b, distance, unit) {
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (px < 1) throw new Error('Pick two different places');
    if (!(distance > 0)) throw new Error('Type a distance above 0');
    return { scale_per_px: distance / px, scale_unit: unit };
  }

  function scaleFromGrid(squarePx, perSquare, unit) {
    return { scale_per_px: perSquare / squarePx, scale_unit: unit, grid_px: squarePx };
  }

  // A grid size guessed from a file name: "_30x20" squares across a picture whose sides agree, or "70px".
  function gridHint(fileName, width, height) {
    const sq = /(?:^|[\s_\[(])(\d+)\s*[x×]\s*(\d+)(?=$|[\s_\])\.])/i.exec(fileName);
    if (sq) {
      const across = +sq[1], down = +sq[2];
      // Under 8 px a square is no grid (a "1920x1080" resolution gives 1), so that name says nothing.
      if (across > 0 && down > 0 && Math.abs(width / across - height / down) <= 1 && width / across >= 8) return { grid_px: width / across, from: 'squares' };
    }
    const px = /(?:^|[\s_\[(-])(\d+)\s*px(?=$|[\s_\])\.-])/i.exec(fileName);
    if (px && +px[1] > 0) return { grid_px: +px[1], from: 'pixels' };
    return null;
  }


  // ---- finding a square grid on a plain picture
  // `gray` is the picture's brightness (0..255), row by row, `w` x `h`. Grid lines are long straight edges, so each column
  // (and row) is scored by how many of its pixels sit on an edge; the scores repeat every square, which an autocorrelation
  // finds, and a comb laid over the scores then sets the size to a fraction of a pixel and where the first line falls.
  // Returns { px, offset_x, offset_y, confidence (0..1) } or null when nothing regular is there.
  function detectGrid(gray, w, h) {
    const EDGE = 20, MIN_P = 10;
    const colEdge = new Float64Array(w), rowEdge = new Float64Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (x + 1 < w && Math.abs(gray[y * w + x + 1] - v) > EDGE) colEdge[x]++;
      if (y + 1 < h && Math.abs(gray[(y + 1) * w + x] - v) > EDGE) rowEdge[y]++;
    }
    const smooth = (a, len) => {   // a line has two edges a pixel apart: blur them into one hump
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = ((a[i - 1] || 0) + a[i] + (a[i + 1] || 0)) / len / 3;
      return out;
    };
    const cp = smooth(colEdge, h), rp = smooth(rowEdge, w);
    const mean = a => a.reduce((t, v) => t + v, 0) / a.length;
    const centred = a => { const m = mean(a); return Float64Array.from(a, v => v - m); };
    const cc = centred(cp), rc = centred(rp);
    const maxP = Math.floor(Math.min(w, h) / 3);
    if (maxP <= MIN_P + 2) return null;
    const auto = c => {
      const n = c.length, r = new Float64Array(maxP + 2);
      let zero = 0;
      for (let i = 0; i < n; i++) zero += c[i] * c[i];
      if (zero < 1e-9) return r;
      for (let p = 1; p <= maxP + 1; p++) {
        let t = 0;
        for (let i = 0; i + p < n; i++) t += c[i] * c[i + p];
        r[p] = (t / (n - p)) / (zero / n);
      }
      return r;
    };
    const ra = auto(cc), rb = auto(rc), r = ra.map((v, i) => (v + rb[i]) / 2);
    let best = 0;
    for (let p = MIN_P; p <= maxP; p++) best = Math.max(best, r[p]);
    if (best < 0.15) return null;
    let p0 = 0;   // the smallest period that is nearly as strong as the strongest (its multiples are as strong)
    for (let p = MIN_P; p <= maxP; p++) if (r[p] >= 0.6 * best && r[p] >= r[p - 1] && r[p] >= r[p + 1]) { p0 = p; break; }
    if (!p0) return null;
    const comb = (prof, p, phase) => {
      let t = 0, k = 0;
      for (let x = phase; x < prof.length - 1; x += p) { t += prof[Math.round(x)]; k++; }
      return k ? t / k : 0;
    };
    const bestPhase = (prof, p) => {
      let bp = 0, bs = -1;
      for (let ph = 0; ph < p; ph += 0.5) { const sc = comb(prof, p, ph); if (sc > bs) { bs = sc; bp = ph; } }
      return [bp, bs];
    };
    let px = p0, top = -1;
    for (let q = p0 - 1.5; q <= p0 + 1.5; q += 0.05) {
      if (q < MIN_P) continue;
      const sc = bestPhase(cp, q)[1] + bestPhase(rp, q)[1];
      if (sc > top) { top = sc; px = q; }
    }
    const [ox0, sx] = bestPhase(cp, px), [oy0, sy] = bestPhase(rp, px);
    // The comb is only near: find each line's own place beside where the comb puts it, and fit a straight line through them
    // (line k at offset + k * size), which fixes the size to a fraction of a pixel even when the picture's own edges pull on the comb.
    const fit = (prof, p, phase) => {
      const m = mean(prof);
      let ks = [], xs = [];
      for (let k = 0; phase + k * p < prof.length - 1; k++) {
        const c = Math.round(phase + k * p);
        let bi = -1, bv = -1;
        for (let i = Math.max(0, c - 3); i <= Math.min(prof.length - 1, c + 3); i++) if (prof[i] > bv) { bv = prof[i]; bi = i; }
        if (bv < 1.5 * m) continue;
        const a = prof[bi - 1] || 0, b = prof[bi], d = prof[bi + 1] || 0;
        ks.push(k); xs.push(bi + (d - a) / ((a + b + d) || 1));
      }
      if (ks.length < 3) return [p, phase];
      const n = ks.length, mk = ks.reduce((t, v) => t + v, 0) / n, mx = xs.reduce((t, v) => t + v, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) { num += (ks[i] - mk) * (xs[i] - mx); den += (ks[i] - mk) ** 2; }
      return den ? [num / den, mx - (num / den) * mk] : [p, phase];
    };
    const [fx, fox] = fit(cp, px, ox0), [fy, foy] = fit(rp, px, oy0);
    px = (fx + fy) / 2;
    const ox = fox, oy = foy;
    return { px: Math.round(px * 100) / 100, offset_x: Math.round((((ox + 0.5) % px) + px) % px * 100) / 100, offset_y: Math.round((((oy + 0.5) % px) + px) % px * 100) / 100, confidence: Math.min(1, best) };
  }


  // ---- finding a hex grid, or choosing between squares and hexes
  // Hex edges are slanted, so the column and row scores of detectGrid can't see them. Instead each candidate grid (a shape, a
  // size and where it sits) is laid over the picture and scored by how strong the picture's edges are along its lines compared
  // with the picture's average edge: the right grid sits on edges everywhere, a wrong one on none.
  function edgeMap(gray, w, h) {
    const e = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      e[i] = Math.min(255, Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]));
    }
    const out = new Float32Array(w * h);   // a pixel's own edge or its neighbours', so a line a pixel off still counts
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.max(e[i], e[i - 1], e[i + 1], e[i - w], e[i + w]);
    }
    return out;
  }
  // The lines of a grid of `type` and `size` whose pattern starts at (ox, oy), as segments [x1, y1, x2, y2] inside the box.
  function gridSegments(type, size, ox, oy, box) {
    const segs = [];
    if (type === 'square') {
      for (let x = box.x0 + ((ox - box.x0) % size + size) % size; x <= box.x1; x += size) segs.push([x, box.y0, x, box.y1]);
      for (let y = box.y0 + ((oy - box.y0) % size + size) % size; y <= box.y1; y += size) segs.push([box.x0, y, box.x1, y]);
      return segs;
    }
    const flip = type === 'hex_pointy', r = size / Math.sqrt(3);
    // centres of a flat-topped lattice (turned on its side for pointy), then each hex's six sides
    const [a0, a1, b0, b1] = flip ? [box.y0, box.y1, box.x0, box.x1] : [box.x0, box.x1, box.y0, box.y1];
    const [pa, pb] = flip ? [oy, ox] : [ox, oy];
    const corners = [0, 1, 2, 3, 4, 5].map(k => [r * Math.cos(k * Math.PI / 3), (size / 2) * 0 + r * Math.sin(k * Math.PI / 3)]);
    const iMin = Math.floor((a0 - pa - r) / (1.5 * r)) - 1, iMax = Math.ceil((a1 - pa) / (1.5 * r)) + 1;
    for (let i = iMin; i <= iMax; i++) {
      const ca = pa + r + 1.5 * r * i;
      const jMin = Math.floor((b0 - pb) / size) - 1, jMax = Math.ceil((b1 - pb) / size) + 1;
      for (let j = jMin; j <= jMax; j++) {
        const cb = pb + size / 2 + size * j + (((i % 2) + 2) % 2) * size / 2;
        for (let k = 0; k < 6; k++) {
          const [u1, v1] = corners[k], [u2, v2] = corners[(k + 1) % 6];
          const p1 = flip ? [cb + v1, ca + u1] : [ca + u1, cb + v1], p2 = flip ? [cb + v2, ca + u2] : [ca + u2, cb + v2];
          segs.push([p1[0], p1[1], p2[0], p2[1]]);
        }
      }
    }
    return segs;
  }
  function gridScore(edge, w, h, segs, box) {
    let t = 0, n = 0;
    for (const [x1, y1, x2, y2] of segs) {
      const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(1, Math.round(len / 2));
      for (let k = 0; k <= steps; k++) {
        const x = Math.round(x1 + (x2 - x1) * k / steps), y = Math.round(y1 + (y2 - y1) * k / steps);
        if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1 || x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        t += edge[y * w + x]; n++;
      }
    }
    return n ? t / n : 0;
  }
  // The best square, flat-hex or pointy-hex grid on the picture, as { type, px, offset_x, offset_y, lift (how many times the
  // average edge its lines sit on) }, or null when none beats 2.2 times the average. Squares come from detectGrid.
  function detectAnyGrid(gray, w, h) {
    const MIN_S = 14, BOX = 200;
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    const box = { x0: Math.max(1, cx - BOX), x1: Math.min(w - 2, cx + BOX), y0: Math.max(1, cy - BOX), y1: Math.min(h - 2, cy + BOX) };
    const edge = edgeMap(gray, w, h);
    let mean = 0, cnt = 0;
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) { mean += edge[y * w + x]; cnt++; }
    mean = (mean / cnt) || 1;
    const maxS = Math.min(120, Math.floor(Math.min(box.x1 - box.x0, box.y1 - box.y0) / 3));
    if (maxS <= MIN_S) return null;
    const score = (type, s, ox, oy) => gridScore(edge, w, h, gridSegments(type, s, ox, oy, box), box) / mean;
    const periods = type => {   // where the pattern's first line can start: one square, or a hex's repeat less its mirror
      const r = s => s / Math.sqrt(3);
      return type === 'square' ? s => [s, s] : type === 'hex_flat' ? s => [1.5 * r(s), s] : s => [s, 1.5 * r(s)];
    };
    const search = (type, sFrom, sTo, sStep, fine) => {
      let best = { lift: 0 };
      for (let s = sFrom; s <= sTo; s += sStep) {
        const [px, py] = periods(type)(s);
        const st = fine ? fine : Math.max(1, s / 6);
        for (let ox = 0; ox < px; ox += st) for (let oy = 0; oy < py; oy += st) {
          const lift = score(type, s, ox, oy);
          if (lift > best.lift) best = { type, px: s, offset_x: ox, offset_y: oy, lift };
        }
      }
      return best;
    };
    const refine = c => {
      let b = c;
      // first within a coarse step of where it was found, then a pixel or less around that
      for (const [rs, ro, step, ostep] of [[2, c.px / 6, 0.5, c.px / 24], [0.6, 1, 0.15, 0.25]]) {
        const from = b;
        for (let s = Math.max(MIN_S, from.px - rs); s <= from.px + rs; s += step) for (let ox = from.offset_x - ro; ox <= from.offset_x + ro; ox += ostep) for (let oy = from.offset_y - ro; oy <= from.offset_y + ro; oy += ostep) {
          const lift = score(c.type, s, ox, oy);
          if (lift > b.lift) b = { type: c.type, px: s, offset_x: ox, offset_y: oy, lift };
        }
      }
      return b;
    };
    // squares from detectGrid (it is exact), scored the same way as the hexes so the two can be compared
    const sq = detectGrid(gray, w, h);
    let best = sq ? { type: 'square', px: sq.px, offset_x: sq.offset_x, offset_y: sq.offset_y, lift: score('square', sq.px, sq.offset_x, sq.offset_y) } : null;
    for (const type of ['hex_flat', 'hex_pointy']) {
      const c = refine(search(type, MIN_S, maxS, 2));
      if (c.lift && (!best || c.lift > best.lift * 1.1)) best = c;   // a hex must clearly beat the squares: slanted sides cross square lines now and then
    }
    if (!best || best.lift < 2.2) return null;
    if (best.type === 'square') return { type: 'square', px: sq.px, offset_x: sq.offset_x, offset_y: sq.offset_y, lift: Math.round(best.lift * 100) / 100 };
    const [px, py] = periods(best.type)(best.px);
    const wrap = (v, m) => ((v % m) + m) % m;
    const r2 = v => Math.round(v * 100) / 100;
    return { type: best.type, px: r2(best.px), offset_x: r2(wrap(best.offset_x, px)), offset_y: r2(wrap(best.offset_y, py)), lift: r2(best.lift) };
  }

  function pathPx(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return sum;
  }

  function toMetres(px, map) {
    if (!map || !(map.scale_per_px > 0) || !UNIT_M[map.scale_unit]) return null;
    return px * map.scale_per_px * UNIT_M[map.scale_unit];
  }

  // Whole numbers from 100 up, one decimal below that (dropping a trailing .0), thousands separated.
  function num(v) {
    const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return r.toLocaleString('en-US');
  }

  function fmtDistance(metres, system, space = false) {
    const imperial = system === 'imperial';
    if (space) {
      if (metres >= UNIT_M.ly || metres >= 1000 * UNIT_M.au) {
        const ly = metres / UNIT_M.ly;
        return (ly < 1 ? String(+ly.toPrecision(2)) : num(ly)) + ' ly';
      }
      if (metres >= 0.01 * UNIT_M.au) {
        const au = metres / UNIT_M.au;
        return (au < 1 ? String(+au.toPrecision(2)) : num(au)) + ' AU';
      }
    }
    if (imperial) return metres < UNIT_M.mi ? num(metres / UNIT_M.ft) + ' ft' : num(metres / UNIT_M.mi) + ' mi';
    return metres < 1000 ? num(metres) + ' m' : num(metres / 1000) + ' km';
  }

  const nameKey = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/^the /, '');

  function pinFor(pins, name) {
    const k = nameKey(name);
    const entryName = p => p.entry && p.entry.name != null ? p.entry.name : p.entry_name;   // pin_out has entry: {id, name}
    return pins.find(p => nameKey(p.label) === k || (entryName(p) != null && nameKey(entryName(p)) === k)) || null;
  }

  // The pin nearest a point, if one is within maxPx picture pixels, and the name a pin goes by (its entry's or event's,
  // else its label), for Plan this trip's From and To.
  function nearestPin(pins, pt, maxPx) {
    let best = null, bestD = Infinity;
    for (const p of pins || []) {
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d <= maxPx && d < bestD) { best = p; bestD = d; }
    }
    return best;
  }
  const pinName = p => (p.kind === 'entry' && p.entry && p.entry.name) || (p.kind === 'event' && p.event && p.event.title) || p.label || '';

  const GRID_TYPES = ['square', 'hex_flat', 'hex_pointy'];

  // One tile of a grid's SVG pattern, in picture pixels: { w, h, d } (d is the path of its lines). size is the square's
  // side, or for hexes the distance from one hex's centre to the next across a flat side. A hex tile holds one whole
  // hex and the line that joins it to the next column (or row), so tiles side by side draw the whole grid.
  function gridTile(type, size) {
    const n = v => +v.toFixed(3);
    if (type !== 'hex_flat' && type !== 'hex_pointy') return { w: n(size), h: n(size), d: `M0 0H${n(size)}M0 0V${n(size)}` };
    const r = size / Math.sqrt(3), h = size;   // a corner's distance from the centre, and the flat-to-flat height
    const pts = [[0, h / 2], [r / 2, 0], [1.5 * r, 0], [2 * r, h / 2], [1.5 * r, h], [r / 2, h]];
    const join = [[2 * r, h / 2], [3 * r, h / 2]];
    const flip = type === 'hex_pointy';   // pointy-topped is the flat-topped tile turned on its side
    const xy = ([x, y]) => (flip ? `${n(y)} ${n(x)}` : `${n(x)} ${n(y)}`);
    const d = `M${pts.map(xy).join('L')}ZM${join.map(xy).join('L')}`;
    return flip ? { w: n(h), h: n(3 * r), d } : { w: n(3 * r), h: n(h), d };
  }

  // How many squares (or hexes) a straight length of px picture pixels crosses, to the nearest whole one.
  function squaresAlong(px, size) {
    return size > 0 ? Math.round(px / size) : null;
  }

  const MapGeo = { UNIT_M, ROLL20, GRID_TYPES, isSpace, scaleFromPoints, scaleFromGrid, gridHint, detectGrid, detectAnyGrid, pathPx, toMetres, fmtDistance, nameKey, pinFor, gridTile, squaresAlong, nearestPin, pinName };
  if (typeof module !== 'undefined' && module.exports) module.exports = MapGeo;
  else root.MapGeo = MapGeo;
})(typeof window !== 'undefined' ? window : globalThis);
