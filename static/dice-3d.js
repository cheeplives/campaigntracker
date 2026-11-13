/* dice-3d.js — How dice look: each player's colours and pattern, and the 3D dice that tumble over the page and land on
 * what was rolled.
 *
 * The numbers are never decided here. static/dice.js has already worked out every die from the roll's seed; this file
 * only throws dice that come to rest showing those numbers, so the 3D dice can't disagree with the log.
 *
 * A look is { body, ink, tex }: the dice's colour, the numbers' colour, and one of the TEXTURES, drawn here on a canvas
 * (no picture files, so nothing to license). The same pattern backs the flat dice in the log (chip()), so they match.
 * Each player picks theirs on the roller (🎨); api/dice.php sends it with each of their rolls, so everyone sees their
 * dice in their colours.
 *
 * three.js (static/vendor/three, a trimmed build: see VERSIONS.md) is loaded the first time 3D dice are thrown. Without
 * WebGL, with "Reduce motion" on, or with 3D turned off on this device, only the flat dice show.
 * Plain script, no build step. */
(function (root) {
  'use strict';
  const LIB = 'static/vendor/three/three.dice.min.mjs';
  const SETTING = 'chronicle-dice-3d';      // 'off' on this device turns the 3D dice off
  const MAX_DICE = 30;                       // more than this in one roll: flat dice only
  /** The patterns a player can pick (DICE_TEXTURES in api/dice.php checks the same list). The animated ones move: glitter
   * that sparkles, stars that drift and twinkle inside the die, embers that glow. */
  const TEXTURES = [['', 'Plain'], ['marble', 'Marble'], ['wood', 'Wood'], ['stone', 'Stone'], ['stars', 'Starfield'],
    ['metal', 'Brushed metal'], ['speckle', 'Speckled'], ['swirl', 'Resin swirl'], ['pearl', 'Pearl'], ['scales', 'Dragon scales'],
    ['carbon', 'Carbon fibre'], ['ice', 'Cracked ice'], ['lava', 'Cooled lava'],
    ['glitter', 'Glitter (animated)'], ['galaxy', 'Galaxy (animated)'], ['ember', 'Embers (animated)'],
    // the skins: a pattern that comes with its own colours (SKINS below), often a frame round each face or numbers that glow
    ['gilded', 'Paladin (animated)'], ['eldritch', 'Warlock (animated)'], ['moss', 'Druid (animated)'], ['grove', 'Druid, glowing (animated)'],
    ['fire', 'Fire (animated)'], ['magma', 'Lava (animated)'], ['shield', 'Shield'], ['leopard', 'Leopard'], ['pinstripe', 'Pink pinstripe (animated)']];
  /** The patterns that move, and what moves. */
  const ANIMATED = { glitter: 'sparkle', galaxy: 'drift', ember: 'flow', grove: 'glow', eldritch: 'pulse', fire: 'flicker', magma: 'flow',
    gilded: 'shine', pinstripe: 'shine', moss: 'drift' };
  /** Patterns with a frame round each face: [the frame's colour, its width as a share of a face]. */
  const FRAMES = { gilded: ['#d9ae48', 0.2], shield: ['#a9b0b8', 0.24], leopard: ['#f7f3ee', 0.16], pinstripe: ['#e4b852', 0.16] };
  /** Patterns whose numbers glow, lit from within like the pattern's own light. */
  const GLOWING = new Set(['grove', 'eldritch', 'fire', 'magma']);
  /** The skins' own colours: picking one of these patterns sets them too (the colours can be changed after). [name, body,
   * ink, tex]. The ideas (a paladin's gold and
   * white, a warlock's trinket, druid wood and moss, fire, lava, a shield, leopard print, glossy pink pinstripes) come from
   * the "Themed Dice Skins" Baldur's Gate 3 mod by Sir William Snugglepuff; nothing of the mod's is used, every skin is
   * drawn here. */
  const SKINS = [['Paladin', '#f3eee2', '#6e4c0c', 'gilded'], ['Warlock', '#2b1a44', '#d9b8ff', 'eldritch'],
    ['Druid', '#6e4a2a', '#f1f5d8', 'moss'], ['Druid, glowing', '#4f3520', '#c9ff9e', 'grove'], ['Fire', '#7c2108', '#ffe39a', 'fire'],
    ['Lava', '#2b2521', '#ffb44a', 'magma'], ['Shield', '#8c5b2f', '#f4f1ea', 'shield'], ['Leopard', '#e597bd', '#3a1426', 'leopard'],
    ['Pink pinstripe', '#dc4f93', '#fbe2a0', 'pinstripe']];
  /** Colours offered first on the picker (any colour can still be chosen). [body, ink, name] */
  const SWATCHES = [['#f3ecdc', '#2b2418', 'Ivory'], ['#1d1d22', '#f2f2f2', 'Black'], ['#a3222d', '#fff4e0', 'Crimson'],
    ['#1f4fa3', '#ffffff', 'Royal blue'], ['#1e7a4c', '#fff6d8', 'Emerald'], ['#5b2a86', '#f4d27a', 'Amethyst'],
    ['#c8891e', '#2a1a05', 'Amber'], ['#2f6f78', '#f0fbff', 'Teal'], ['#d36b9a', '#2a0f1c', 'Rose'], ['#8a8f98', '#111418', 'Pewter']];

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Whether this device throws 3D dice: on unless turned off here, or the system asks for less motion. */
  const enabled = () => store.get(SETTING) !== 'off';
  const setEnabled = on => store.set(SETTING, on ? null : 'off');
  // How long thrown dice stay once they land, on this device: seconds, or 0 for until the next roll (the panel closing
  // still clears them). STAYS are the 🎨 card's choices.
  const STAY = 'chronicle-dice-stay';
  const STAYS = [[3, '3 seconds'], [6, '6 seconds'], [10, '10 seconds'], [20, '20 seconds'], [0, 'Until the next roll']];
  const stay = () => { const v = Number(store.get(STAY)); return STAYS.some(([s]) => s === v) && store.get(STAY) !== null ? v : 3; };
  const setStay = sec => store.set(STAY, sec === 3 ? null : String(sec));

  // ------------------------------------------------------------ colours
  const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '')); const n = m ? parseInt(m[1], 16) : 0x888888; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const toHex = ([r, g, b]) => '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
  const lum = c => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  /** Numbers that read on a body colour: near-black on a light die, near-white on a dark one. */
  const inkFor = body => (lum(hex(body)) > 0.32 ? '#1c1a17' : '#f7f4ec');
  /** The theme's dice, for a player who hasn't picked: the accent colour with its own text colour. */
  function themeLook() {
    const cs = getComputedStyle(document.documentElement);
    const css = v => { const s = cs.getPropertyValue(v).trim(); return /^#[0-9a-f]{6}$/i.test(s) ? s : null; };
    const body = css('--accent') || '#a8741a';
    return { body, ink: css('--on-accent') || inkFor(body), tex: '' };
  }
  const keyOf = l => `${l.body}|${l.ink}|${l.tex || ''}`;

  // ------------------------------------------------------------ patterns
  /** A seeded random number source, so a pattern is the same every time it is drawn. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** Smooth noise that wraps at the tile's edges (period cells across), so the pattern repeats without a seam. */
  function noise(seed, period) {
    const R = rng(seed), g = Array.from({ length: period * period }, R);
    const at = (x, y) => g[((y % period + period) % period) * period + ((x % period + period) % period)];
    const s = t => t * t * (3 - 2 * t);
    return (x, y) => {   // x, y in 0..1 across the tile
      const fx = x * period, fy = y * period, ix = Math.floor(fx), iy = Math.floor(fy), tx = s(fx - ix), ty = s(fy - iy);
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
  }
  function fbm(seed, base, octaves) {
    const layers = Array.from({ length: octaves }, (_, k) => noise(seed + k * 101, base << k));
    return (x, y) => { let v = 0, w = 0.5, tot = 0; for (const n of layers) { v += n(x, y) * w; tot += w; w *= 0.5; } return v / tot; };
  }
  /** Distances to the nearest and next-nearest of n random points, wrapping at the tile's edges (cracked ice). */
  function voronoi(seed, n) {
    const R = rng(seed), pts = Array.from({ length: n }, () => [R(), R()]);
    return (u, v) => {
      let a = 9, b = 9;
      for (const [px, py] of pts) {
        let dx = Math.abs(u - px), dy = Math.abs(v - py);
        dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy);
        const d = Math.hypot(dx, dy);
        if (d < a) { b = a; a = d; } else if (d < b) b = d;
      }
      return [a, b];
    };
  }
  /** How hot a spot of fire is (0..1): tongues of flame rising, wrapping at the tile's edges like the rest. */
  const flame = (f, f2, u, v) => {
    const t = 0.5 + 0.5 * Math.sin((v * 2 + f(u, v) * 1.8 + f2(u * 2, v) * 0.6) * Math.PI * 2);
    return Math.max(0, Math.min(1, t * (0.55 + f2(u, v) * 0.9)));
  };
  /** Rings and rune strokes, scattered (the warlock's trinket): drawn on the pattern faintly and on its glow brightly. */
  function sigils(g, size, colour, alpha) {
    const S = rng(53);
    g.save();
    g.strokeStyle = colour; g.globalAlpha = alpha; g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const x = S() * size, y = S() * size, r = size * (0.06 + S() * 0.07);
      g.lineWidth = Math.max(1, size / 180);
      // each sigil drawn at the tile's edges too, so it wraps without a seam
      for (const [ox, oy] of [[0, 0], [-size, 0], [size, 0], [0, -size], [0, size]]) {
        const cx = x + ox, cy = y + oy;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(cx, cy, r * 0.62, 0, Math.PI * 2); g.stroke();
        const n = 3 + Math.floor(S() * 3), turn = S() * Math.PI;
        g.beginPath();
        for (let j = 0; j <= n; j++) {
          const a = turn + j * (Math.PI * 2 / n) * (n % 2 ? 2 : 1), px = cx + Math.cos(a) * r * 0.62, py = cy + Math.sin(a) * r * 0.62;
          j ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke();
      }
    }
    g.restore();
  }
  let heat = null;
  /** Soft patches of heat, 0.2 to 1, that slide along a lava die's cracks so the molten rock seems to flow. */
  function heatTile(size = 256) {
    if (heat) return heat;
    heat = document.createElement('canvas');
    heat.width = heat.height = size;
    const g = heat.getContext('2d'), img = g.createImageData(size, size), px = img.data, f = fbm(61, 3, 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = 255 * (0.2 + 0.8 * Math.max(0, Math.min(1, (f(x / size, y / size) - 0.3) * 2.2))), o = (y * size + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return heat;
  }
  /** The moving light of the fire patterns, redrawn each frame on a tile of its own: fire's flames rise up the die (two
   * layers at different speeds, so they shift as they climb); lava's and embers' cracks stay put while patches of heat
   * flow along them. Returns { cv, draw(t) }. */
  function liveTile(look, size = 256) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d'), src = glowLayer(look, size), pat = g.createPattern(src, 'repeat');
    const wrap = x => ((x % size) + size) % size;
    const draw = t => {
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
      const layer = (pt, dx, dy, a, op) => {
        g.save(); g.globalAlpha = a; g.globalCompositeOperation = op; g.translate(wrap(dx) - size, wrap(dy) - size);
        g.fillStyle = pt; g.fillRect(0, 0, size * 2, size * 2); g.restore();
      };
      if (look.tex === 'fire') {
        layer(pat, 0, -t * 0.32 * size, 0.85, 'lighter');
        layer(pat, size * 0.37, -t * 0.55 * size, 0.55, 'lighter');
      } else {
        g.drawImage(src, 0, 0);
        layer(g.createPattern(heatTile(size), 'repeat'), t * 0.09 * size, t * 0.05 * size, 1, 'multiply');
        layer(g.createPattern(heatTile(size), 'repeat'), -t * 0.06 * size + size * 0.5, t * 0.08 * size, 0.6, 'multiply');
      }
    };
    draw(0);
    return { cv, draw };
  }
  /** Fire patterns whose light moves across the die, not only brightens. */
  const LIVE = new Set(['fire', 'magma', 'ember']);
  const glows = new Map();
  /** The moving part of an animated pattern, drawn on its own tile and laid over the die as light it gives off: glitter
   * flakes, stars, the glowing cracks of embers. Black is "no light". */
  function glowLayer(look, size = 256) {
    const k = keyOf(look);
    if (glows.has(k)) return glows.get(k);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    const S = rng(41), tint = toHex(mix(hex(look.body), WHITE, 0.7));
    if (look.tex === 'glitter') {
      for (let i = 0; i < 320; i++) {
        const x = S() * size, y = S() * size, r = 0.8 + S() * 1.4;
        const grd = g.createRadialGradient(x, y, 0, x, y, r * 2.2);
        grd.addColorStop(0, S() < 0.5 ? '#ffffff' : tint); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r * 2.2, 0, Math.PI * 2); g.fill();
      }
    } else if (look.tex === 'galaxy') {
      for (let i = 0; i < 160; i++) {
        const x = S() * size, y = S() * size, r = S() < 0.1 ? 1.8 : 0.6 + S() * 0.7;
        g.fillStyle = `rgba(255,255,255,${0.5 + S() * 0.5})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    } else if (look.tex === 'ember') {
      const img = g.getImageData(0, 0, size, size), px = img.data, f = fbm(7, 4, 5);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const ridge = Math.pow(1 - Math.abs(2 * f(x / size, y / size) - 1), 22), o = (y * size + x) * 4;
        px[o] = 255 * ridge; px[o + 1] = 110 * ridge; px[o + 2] = 20 * ridge;
      }
      g.putImageData(img, 0, 0);
    } else if (look.tex === 'grove' || look.tex === 'magma' || look.tex === 'fire') {
      // grove: glowing veins through the wood; lava: the molten cracks; fire: the hottest tongues of flame
      const img = g.getImageData(0, 0, size, size), px = img.data, f = fbm(7, 4, 5), f2 = fbm(19, 8, 4);
      const hot = look.tex === 'grove' ? [150, 255, 110] : [255, 130, 30];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size, o = (y * size + x) * 4;
        const a = look.tex === 'fire' ? Math.pow(flame(f, f2, u, v), 4) : Math.pow(1 - Math.abs(2 * (look.tex === 'grove' ? f2 : f)(u, v) - 1), look.tex === 'grove' ? 26 : 60);
        px[o] = hot[0] * a; px[o + 1] = hot[1] * a; px[o + 2] = hot[2] * a;
      }
      g.putImageData(img, 0, 0);
    } else if (look.tex === 'eldritch') {
      sigils(g, size, toHex(mix(hex(look.ink), WHITE, 0.25)), 1);
    } else if (look.tex === 'gilded' || look.tex === 'pinstripe') {
      // a glint: one soft diagonal band of light, wrapping at the tile's edges, slid across the die (animate())
      const img = g.getImageData(0, 0, size, size), px = img.data;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const d = ((x + y) / size) % 1, a = Math.pow(Math.max(0, 1 - Math.abs(d - 0.5) * 9), 2) * 0.85, o = (y * size + x) * 4;
        px[o] = 255 * a; px[o + 1] = 236 * a; px[o + 2] = 190 * a;
      }
      g.putImageData(img, 0, 0);
    } else if (look.tex === 'moss') {
      // fireflies: a few soft green-gold lights that drift over the moss
      for (let i = 0; i < 14; i++) {
        const x = S() * size, y = S() * size, r = size * (0.012 + S() * 0.01);
        for (const [ox, oy] of [[0, 0], [-size, 0], [size, 0], [0, -size], [0, size]]) {
          const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r * 3);
          grd.addColorStop(0, '#f4ffb0'); grd.addColorStop(0.35, 'rgba(190,240,90,0.6)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(x + ox, y + oy, r * 3, 0, Math.PI * 2); g.fill();
        }
      }
    }
    glows.set(k, cv);
    return cv;
  }
  const patterns = new Map();
  /** The look's pattern as a square tile (size px), in its body colour. */
  function pattern(look, size = 256) {
    const k = `${keyOf(look)}|${size}`;
    if (patterns.has(k)) return patterns.get(k);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const body = hex(look.body), ink = hex(look.ink);
    if (!look.tex) {
      g.fillStyle = look.body;
      g.fillRect(0, 0, size, size);
    } else {
      const img = g.createImageData(size, size), px = img.data;
      const f = fbm(7, 4, 5), f2 = fbm(19, 8, 4), R = rng(3);
      const light = mix(body, WHITE, 0.55), dark = mix(body, BLACK, 0.45);
      const cells = look.tex === 'ice' ? voronoi(23, 18) : look.tex === 'leopard' ? voronoi(29, 46) : null;
      const moss = fbm(29, 3, 5);
      const HOT = [255, 140, 40], GOLD = [214, 170, 70], MOSS = [86, 122, 44];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size, v = y / size;
          let c;
          if (look.tex === 'marble') {
            const t = Math.sin((u + v + f(u, v) * 1.6) * Math.PI * 4);
            const vein = Math.pow(1 - Math.abs(t), 9);
            c = mix(mix(body, light, f2(u, v) * 0.35), mix(body, WHITE, 0.8), vein * 0.85);
          } else if (look.tex === 'wood') {
            const r = (v * 7 + f(u * 0.25, v) * 2.2) % 1;
            const ring = Math.pow(Math.sin(r * Math.PI), 0.6);
            c = mix(mix(dark, body, ring), mix(body, BLACK, 0.2), f2(u, v * 0.1) * 0.5);
          } else if (look.tex === 'stone') {
            const n = f(u, v);
            c = mix(mix(dark, light, Math.max(0, Math.min(1, (n - 0.3) * 1.7))), body, 0.6);
            if (R() < 0.015) c = mix(c, R() < 0.5 ? WHITE : BLACK, 0.35);
          } else if (look.tex === 'stars') {
            const n = Math.pow(f(u, v), 2.2);
            c = mix(mix(body, BLACK, 0.7), mix(body, WHITE, 0.15), n * 1.4);
          } else if (look.tex === 'metal') {
            const n = noise(31, 4)(u, v * 0.02) * 0.5 + noise(37, 64)(u * 0.05, v) * 0.5;
            const sheen = 0.5 + 0.5 * Math.cos((u * 0.7 + v * 0.3) * Math.PI * 2);
            c = mix(mix(dark, light, 0.35 + n * 0.4), WHITE, sheen * 0.18);
          } else if (look.tex === 'swirl') {
            // poured resin: the dice colour folded through with a lighter one and thin streaks of the number colour
            const w = f(u, v) * 3 + f2(u + 0.3, v) * 1.5;
            const band = 0.5 + 0.5 * Math.sin((u * 2 + w) * Math.PI * 2);
            c = mix(body, mix(body, WHITE, 0.5), Math.pow(band, 3));
            c = mix(c, ink, Math.pow(1 - Math.abs(Math.sin((v * 2 + w * 1.3) * Math.PI * 2)), 24) * 0.6);
          } else if (look.tex === 'pearl') {
            const n = f(u, v), sh = (n * 3 + u + v) * Math.PI * 2;
            c = mix(body, WHITE, 0.35 + n * 0.25);
            c = [c[0] + Math.sin(sh) * 22, c[1] + Math.sin(sh + 2.1) * 22, c[2] + Math.sin(sh + 4.2) * 22];
          } else if (look.tex === 'scales') {
            // overlapping rows of round scales, each lit from its top and shadowed at its rim
            const rows = 16, yy = v * rows, row = Math.floor(yy), xx = u * rows + (row % 2 ? 0.5 : 0);
            const lx = xx - Math.floor(xx) - 0.5, ly = yy - row;
            const d = Math.min(1, Math.hypot(lx, ly * 0.9 - 0.1) * 1.6);
            c = mix(mix(light, body, 0.4 + ly * 0.4), dark, Math.pow(d, 4));
          } else if (look.tex === 'carbon') {
            const k = 24, a = Math.floor(u * k), b = Math.floor(v * k), across = (a + b) % 2 === 0;
            const t = across ? (u * k) % 1 : (v * k) % 1;
            c = mix(mix(body, BLACK, 0.55), mix(body, WHITE, 0.15), 0.25 + 0.6 * Math.sin(t * Math.PI));
          } else if (look.tex === 'ice') {
            const [d1, d2] = cells(u, v), edge = 1 - Math.min(1, (d2 - d1) * 40);
            c = mix(mix(body, WHITE, 0.45 + f2(u, v) * 0.2), WHITE, Math.pow(edge, 2) * 0.85);
          } else if (look.tex === 'lava' || look.tex === 'ember') {
            // dark rock with glowing cracks (embers: the cracks glow in the animated layer as well)
            const n = f(u, v), ridge = Math.pow(1 - Math.abs(2 * n - 1), 22);
            c = mix(mix(body, BLACK, 0.6), mix(HOT, WHITE, 0.15), ridge);
          } else if (look.tex === 'gilded') {
            // polished ivory with faint gold veins
            const vein = Math.pow(1 - Math.abs(Math.sin((u * 1.5 + v + f(u, v) * 1.3) * Math.PI * 3)), 16);
            c = mix(mix(body, WHITE, 0.1 + f2(u, v) * 0.2), GOLD, vein * 0.45);
          } else if (look.tex === 'shield') {
            // four upright planks, each its own grain, with dark seams between them
            const p = Math.floor(u * 4), pu = u * 4 - p, sh = [0.13, 0.57, 0.31, 0.79][p];
            const r = ((v + sh) * 9 + f(pu * 0.2 + sh, v) * 1.6) % 1, ring = Math.pow(Math.sin(r * Math.PI), 0.7);
            c = mix(mix(dark, body, 0.35 + ring * 0.65), mix(body, BLACK, 0.25), f2(pu * 0.1 + sh, v) * 0.4);
            c = mix(c, BLACK, Math.pow(Math.max(0, 1 - Math.min(pu, 1 - pu) * 30), 2) * 0.75);
          } else if (look.tex === 'moss' || look.tex === 'grove') {
            // wood grain under patches of moss (glowing grove: green veins of light through it as well)
            const r = (v * 7 + f(u * 0.25, v) * 2.2) % 1, ring = Math.pow(Math.sin(r * Math.PI), 0.6);
            c = mix(mix(dark, body, ring), mix(body, BLACK, 0.2), f2(u, v * 0.1) * 0.5);
            const m = Math.max(0, Math.min(1, (moss(u, v) - 0.44) * 5));
            c = mix(c, mix(MOSS, mix(MOSS, BLACK, 0.45), f2(u * 2, v * 2)), m * 0.9);
            if (look.tex === 'grove') c = mix(c, [150, 255, 110], Math.pow(1 - Math.abs(2 * f2(u, v) - 1), 26));
          } else if (look.tex === 'leopard') {
            // soft fur, and rosettes: a broken dark ring round a spot a little darker than the fur
            const [d1, d2] = cells(u, v), n = f(u, v), fur = mix(body, mix(body, WHITE, 0.25), f2(u * 3, v * 3) * 0.6);
            const rad = 0.034 + n * 0.02, ring = d1 > rad * 0.55 && d1 < rad && (d2 - d1) > 0.012 && f2(u * 4, v * 4) > 0.36;
            c = ring ? mix([40, 22, 16], body, 0.12) : d1 < rad * 0.55 ? mix(fur, [150, 70, 50], 0.28) : fur;
          } else if (look.tex === 'pinstripe') {
            // glossy panels with fine light stripes
            const st = (u * 14) % 1, line = st < 0.09 ? 1 : 0;
            c = mix(mix(body, WHITE, 0.05 + 0.12 * (0.5 + 0.5 * Math.cos((u + v) * Math.PI * 2))), WHITE, line * 0.55);
          } else if (look.tex === 'eldritch') {
            // dark smoke with violet light curling through it (the sigils are drawn on top, below)
            const n = Math.pow(f(u, v), 2);
            c = mix(mix(body, BLACK, 0.5), mix(body, [170, 100, 255], 0.55), n * 1.3);
          } else if (look.tex === 'fire') {
            // a burning surface: dark coals with a dull red glow (the bright flames rise over it in the moving layer)
            const h = flame(f, f2, u, v);
            c = mix(mix(body, BLACK, 0.5), [190, 70, 15], Math.min(1, h * 0.8));
          } else if (look.tex === 'magma') {
            // charred rock, and molten cracks running through it
            const n = f(u, v), ridge = Math.pow(1 - Math.abs(2 * n - 1), 60);
            const rock = mix(mix(body, BLACK, 0.35), mix(body, WHITE, 0.12), Math.max(0, Math.min(1, (f2(u, v) - 0.35) * 2)));
            c = mix(rock, mix(HOT, [255, 220, 120], ridge), Math.min(1, ridge * 1.4));
          } else if (look.tex === 'galaxy') {
            const n = Math.pow(f(u, v), 1.8), m = f2(u * 0.5, v * 0.5);
            c = mix(mix(body, BLACK, 0.78), mix(mix(body, [120, 60, 200], 0.4), WHITE, 0.1), n * 1.5);
            c = mix(c, [40, 160, 220], Math.max(0, m - 0.55) * 0.9);
          } else if (look.tex === 'glitter') {
            c = mix(body, mix(body, WHITE, 0.25), f2(u, v) * 0.4);
            const r = R();
            if (r < 0.06) c = mix(c, WHITE, 0.35 + R() * 0.3); else if (r < 0.1) c = mix(c, BLACK, 0.2);
          } else {   // speckle
            c = mix(body, light, f2(u, v) * 0.25);
            const r = R();
            if (r < 0.04) c = mix(c, ink, 0.75); else if (r < 0.07) c = mix(c, WHITE, 0.6);
          }
          const o = (y * size + x) * 4;
          px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      if (look.tex === 'stars' || look.tex === 'galaxy') {
        const S = rng(11);
        for (let k = 0; k < size * size / 450; k++) {
          const x = S() * size, y = S() * size, r = S() < 0.08 ? 1.6 : 0.7 + S() * 0.5;
          g.fillStyle = `rgba(255,255,255,${0.55 + S() * 0.45})`;
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        }
      }
      if (look.tex === 'eldritch') sigils(g, size, look.ink, 0.35);
    }
    patterns.set(k, cv);
    return cv;
  }
  const chips = new Map();
  /** The flat dice's style for a look: CSS custom properties for the log's die chips (style.css .looked .die). */
  function chip(look) {
    if (!look) return null;
    const k = keyOf(look);
    if (!chips.has(k)) {
      const fr = FRAMES[look.tex];
      const st = { '--die-bg': look.body, '--die-ink': look.ink, '--die-edge': fr ? fr[0] : toHex(mix(hex(look.body), BLACK, 0.35)) };
      if (fr) st['--die-rim'] = '3px';
      if (GLOWING.has(look.tex)) st['--die-shine'] = `0 0 3px ${look.ink}, 0 0 7px ${look.ink}`;
      if (look.tex) { try { st['--die-tex'] = `url(${pattern(look, 96).toDataURL('image/png')})`; } catch { /* a canvas that can't export: plain colour */ } }
      // an animated pattern's moving layer, for the flat dice to sparkle, drift or glow too (style.css .looked.anim)
      if (ANIMATED[look.tex]) { try { st['--die-glow'] = `url(${glowLayer(look).toDataURL('image/png')})`; } catch { /* still dice */ } }
      chips.set(k, st);
    }
    return chips.get(k);
  }

  // ------------------------------------------------------------ the shapes
  // Each shape is its corners, faces found from them (all are convex), and the number on each face: opposite faces add
  // up to one more than the sides, as on real dice. A d4 is read at its top corner, so its numbers are on the corners.
  const PHI = (1 + Math.sqrt(5)) / 2;
  function d10corners() {
    const c = Math.cos(Math.PI / 5), h = 1, a = h * (1 - c) / (1 + c), out = [[0, h, 0], [0, -h, 0]];
    for (let k = 0; k < 5; k++) {
      const t = k * 2 * Math.PI / 5, u = t + Math.PI / 5;
      out.push([Math.cos(t), a, Math.sin(t)], [Math.cos(u), -a, Math.sin(u)]);
    }
    return out;
  }
  const CORNERS = {
    4: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
    6: [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z]))),
    8: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    10: d10corners(),
    12: [...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z]))),
      ...[-1, 1].flatMap(a => [-1, 1].flatMap(b => [[0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]]))],
    20: [-1, 1].flatMap(a => [-1, 1].flatMap(b => [[0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]])),
  };
  /** How big each shape is drawn, so a d4 and a d20 look a similar size. */
  const SCALE = { 4: 1.25, 6: 0.82, 8: 0.95, 10: 0.92, 12: 0.92, 20: 0.95 };
  const V = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]), norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  };
  /** The faces of the convex shape with these corners: each a list of corner numbers, counter-clockwise from outside. */
  function hull(P) {
    const faces = [], seen = new Set();
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) for (let k = j + 1; k < P.length; k++) {
      let n = V.cross(V.sub(P[j], P[i]), V.sub(P[k], P[i]));
      if (V.len(n) < 1e-9) continue;
      n = V.norm(n);
      let d = V.dot(n, P[i]);
      const side = P.map(p => V.dot(n, p) - d);
      if (side.every(s => s <= 1e-6)) { /* outward already */ } else if (side.every(s => s >= -1e-6)) { n = V.mul(n, -1); d = -d; } else continue;
      const on = P.map((p, q) => q).filter(q => Math.abs(V.dot(n, P[q]) - d) < 1e-6);
      const key = on.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const c = V.mul(on.reduce((s, q) => V.add(s, P[q]), [0, 0, 0]), 1 / on.length);
      const ax = V.norm(V.sub(P[on[0]], c)), ay = V.cross(n, ax);
      on.sort((a, b) => Math.atan2(V.dot(V.sub(P[a], c), ay), V.dot(V.sub(P[a], c), ax)) - Math.atan2(V.dot(V.sub(P[b], c), ay), V.dot(V.sub(P[b], c), ax)));
      faces.push({ idx: on, n, c });
    }
    return faces;
  }
  const shapes = new Map();
  /** One shape: corners (scaled), faces with their number, and which way is up on each face's number. */
  function shape(sides) {
    if (shapes.has(sides)) return shapes.get(sides);
    const raw = CORNERS[sides];
    const r = Math.max(...raw.map(V.len)), P = raw.map(p => V.mul(p, SCALE[sides] / r));
    const faces = hull(P);
    // numbers: opposite faces add up to sides + 1 (a d4's corners are numbered 1 to 4 instead)
    if (sides !== 4) {
      let next = 1;
      const order = faces.slice().sort((a, b) => b.n[1] - a.n[1] || b.n[0] - a.n[0] || b.n[2] - a.n[2]);
      for (const f of order) {
        if (f.value) continue;
        const opp = faces.find(g => !g.value && g !== f && V.dot(g.n, f.n) < -0.999);
        f.value = next;
        if (opp) opp.value = sides + 1 - next;
        next++;
      }
    }
    for (const f of faces) {
      const pts = f.idx.map(q => P[q]);
      let up;
      if (sides === 6) up = V.sub(V.mul(V.add(pts[0], pts[1]), 0.5), f.c);                 // a square: toward an edge
      else if (sides === 10) up = V.sub(pts.reduce((a, b) => (V.len(V.sub(a, f.c)) > V.len(V.sub(b, f.c)) ? a : b)), f.c);   // a kite: toward its point
      else up = V.sub(pts[0], f.c);
      f.up = V.norm(V.sub(up, V.mul(f.n, V.dot(up, f.n))));
      f.right = V.cross(f.up, f.n);
      f.pts = pts;
    }
    const s = { sides, P, faces };
    shapes.set(sides, s);
    return s;
  }

  // ------------------------------------------------------------ which dice to throw
  /** What each 3D die is: a shape, the labels on its faces, and which face lands on top. From a rolled roll
   * (Dice.roll), every kept or dropped die, an exploded die once per roll. Dice that have no shape here (a d2, a d7)
   * are left out. */
  function plan(res, only = null) {
    const out = [];
    const add = (sides, label, value, dim, labels) => out.push({ sides, label, value, dim, labels });
    for (const one of res.results.slice(0, 1)) {
      for (const t of one.terms) {
        for (const d of t.dice) {
          if (only && !only.has(d.i)) continue;      // only the dice just rerolled
          const dim = !!d.dropped;
          if (t.sides === 'F') { add(6, 'F', d.v, dim, FUDGE); continue; }
          if (t.sides === 66) { add(6, 'd6', Math.floor(d.v / 10), dim); add(6, 'd6', d.v % 10, dim); continue; }
          if (t.sides === 100) {
            const reads = d.note && d.note.startsWith('bonus') || d.note?.startsWith('penalty') ? d.rolls : [d.rolls[0]];
            const raw = reads.map(x => x % 100);
            for (const x of raw) add(10, 'tens', Math.floor(x / 10), dim, TENS);
            add(10, 'units', raw[0] % 10, dim, UNITS);
            continue;
          }
          if (t.sides === 3) { for (const v of d.rolls) add(6, 'd3', v, dim, D3); continue; }
          if (!CORNERS[t.sides]) continue;
          for (const v of d.rolls) add(t.sides, `d${t.sides}`, v, dim);
        }
      }
    }
    return out.length > MAX_DICE ? [] : out;
  }
  // labels for face values 1..N on a shape that isn't numbered 1 to N
  const FUDGE = { faces: ['+', '−', '', '+', '−', ''], read: v => (v > 0 ? '+' : v < 0 ? '−' : '') };
  const D3 = { faces: ['1', '2', '3', '3', '2', '1'], read: v => String(v) };
  const TENS = { faces: ['00', '10', '20', '30', '40', '50', '60', '70', '80', '90'], read: v => `${v}0` };
  const UNITS = { faces: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], read: v => String(v) };
  /** What is printed on face f of a die (its number unless labels says otherwise). */
  const faceText = (f, labels, sides) => (labels ? labels.faces[f.value - 1] : String(f.value === 10 && sides === 10 ? 10 : f.value));

  // ------------------------------------------------------------ drawing a die's faces
  /** The picture wrapped on one shape: the look's pattern under every face, each face's number in the middle. Returns
   * the canvas and where each face sits on it (uv). */
  function atlas(sh, look, labels, glow = false) {
    const F = sh.faces.length, cols = Math.ceil(Math.sqrt(F)), rows = Math.ceil(F / cols);
    const size = F > 8 ? 1024 : 512, cell = Math.floor(size / Math.max(cols, rows));
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    // glow: the picture of the light the die gives off (its numbers, and the pattern's own light), black elsewhere
    // ('numbers': the numbers alone, for a die whose pattern light is laid under them afresh each frame)
    if (glow) { g.fillStyle = '#000'; g.fillRect(0, 0, size, size); if (glow === true && ANIMATED[look.tex]) { g.globalAlpha = 0.6; g.fillStyle = g.createPattern(glowLayer(look), 'repeat'); g.fillRect(0, 0, size, size); g.globalAlpha = 1; } }
    else { g.fillStyle = g.createPattern(pattern(look), 'repeat'); g.fillRect(0, 0, size, size); }
    const ink = look.ink, frame = FRAMES[look.tex], edge = toHex(mix(hex(look.body), BLACK, 0.35));
    const uv = [];
    sh.faces.forEach((f, k) => {
      const cx = (k % cols + 0.5) * cell, cy = (Math.floor(k / cols) + 0.5) * cell;
      const loc = f.pts.map(p => { const d = V.sub(p, f.c); return [V.dot(d, f.right), V.dot(d, f.up)]; });
      const rad = Math.max(...loc.map(([x, y]) => Math.hypot(x, y)));
      const s = (cell * 0.47) / rad;
      const px = loc.map(([x, y]) => [cx + x * s, cy - y * s]);
      uv.push(px.map(([x, y]) => [x / size, 1 - y / size]));
      const inr = Math.min(...px.map((a, i) => { const b = px[(i + 1) % px.length]; const ex = b[0] - a[0], ey = b[1] - a[1]; return Math.abs((cx - a[0]) * ey - (cy - a[1]) * ex) / Math.hypot(ex, ey); }));
      // a darker rim along the edges, for depth, or the skin's frame: a band of its colour with a dark inner line
      if (!glow) {
        g.save();
        g.beginPath(); px.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
        g.clip();
        if (frame) {
          const w = inr * frame[1] * 1.8;   // by the face's size, so a d20's small faces keep room for their numbers
          g.strokeStyle = toHex(mix(hex(frame[0]), BLACK, 0.55)); g.lineWidth = w; g.stroke();
          g.strokeStyle = frame[0]; g.lineWidth = w * 0.82; g.stroke();
          g.strokeStyle = toHex(mix(hex(frame[0]), WHITE, 0.45)); g.globalAlpha = 0.7; g.lineWidth = w * 0.18; g.stroke();
        } else { g.strokeStyle = edge; g.globalAlpha = 0.55; g.lineWidth = cell * 0.05; g.stroke(); }
        g.restore();
      }
      // the number (a d4: each corner's number at that corner)
      g.fillStyle = ink;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const font = px => `700 ${Math.round(px)}px ${getComputedStyle(document.documentElement).getPropertyValue('--disp').trim() || 'system-ui'}, system-ui, sans-serif`;
      if (sh.sides === 4) {
        g.font = font(inr * 0.85);
        f.idx.forEach((q, i) => {
          const [x, y] = px[i], ang = Math.atan2(x - cx, -(y - cy));
          g.save(); g.translate(cx + (x - cx) * 0.52, cy + (y - cy) * 0.52); g.rotate(ang);
          g.fillText(String(q + 1), 0, 0); g.restore();
        });
      } else {
        const text = faceText(f, labels, sh.sides);
        const fs = inr * (text.length > 1 ? 0.95 : 1.15) * (sh.sides === 10 ? 0.85 : 1);
        g.font = font(fs);
        const y = cy + (sh.sides === 10 ? -inr * 0.15 : 0);
        g.fillText(text, cx, y);
        if ((text === '6' || text === '9') && sh.sides > 6) g.fillRect(cx - fs * 0.25, y + fs * 0.45, fs * 0.5, Math.max(2, fs * 0.07));
      }
    });
    return { cv, uv };
  }

  // ------------------------------------------------------------ three.js and the scene
  let T = null, loading = null, broken = false;
  function lib() {
    if (T) return Promise.resolve(T);
    if (!loading) loading = import(new URL(LIB, document.baseURI).href).then(m => (T = m)).catch(e => { broken = true; loading = null; throw e; });
    return loading;
  }
  let renderer = null, scene, camera, sun, floor, canvas = null, raf = 0, fadeTimer = 0, current = null, preview = null;
  const geos = new Map(), mats = new Map();
  /** The fire patterns' moving light: each emissive texture that is redrawn every frame, and how (liveTile()). */
  const lives = new WeakMap();
  /** Whether this browser can draw WebGL 2 at all, asked once without three.js (which logs an error when it can't). */
  let gl2 = null;
  function available() {
    if (gl2 === null) { try { gl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { gl2 = false; } }
    return gl2;
  }
  function setup() {
    if (renderer) return true;
    if (!available()) { broken = true; return false; }
    canvas = document.createElement('canvas');
    canvas.className = 'dice-tray';
    canvas.setAttribute('aria-hidden', 'true');
    try {
      renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch { broken = true; canvas = null; return false; }
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(22, 1, 0.5, 400);
    scene.add(new T.HemisphereLight(0xffffff, 0x3a3328, 1.7));
    sun = new T.DirectionalLight(0xffffff, 2.4);
    // low enough that its glare misses the faces lying flat under the camera: higher, it washed the top face (the one
    // that's read) to grey and hid its pattern
    sun.position.set(-10, 9, -7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 4;
    scene.add(sun, sun.target);
    floor = new T.Mesh(new T.PlaneGeometry(400, 400), new T.ShadowMaterial({ opacity: 0.28 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    document.body.append(canvas);
    return true;
  }
  /** A shape's mesh data: each face a fan of triangles, flat-shaded, with its uv from the atlas. */
  function geometry(sh, uv) {
    const pos = [], nor = [], tex = [];
    sh.faces.forEach((f, k) => {
      for (let i = 1; i < f.pts.length - 1; i++) {
        for (const j of [0, i, i + 1]) { pos.push(...f.pts[j]); nor.push(...f.n); tex.push(...uv[k][j]); }
      }
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(tex, 2));
    return g;
  }
  /** A die's mesh for a shape, a look and its face labels; geometry and material are kept for the next throw. */
  function mesh(sides, look, labels, dim) {
    const sh = shape(sides);
    const k = `${sides}|${labels ? labels.faces.join(',') : ''}|${keyOf(look)}`;
    if (!mats.has(k)) {
      if (mats.size > 40) { for (const m of mats.values()) { m.map?.dispose(); m.emissiveMap?.dispose(); m.dispose(); } mats.clear(); geos.forEach(g => g.dispose()); geos.clear(); }
      const { cv, uv } = atlas(sh, look, labels);
      const map = new T.CanvasTexture(cv);
      map.colorSpace = T.SRGBColorSpace;
      map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const metal = look.tex === 'metal';
      const shiny = ['marble', 'pearl', 'ice', 'glitter', 'galaxy', 'gilded', 'pinstripe'].includes(look.tex);
      const mat = new T.MeshStandardMaterial({ map, roughness: metal || look.tex === 'carbon' ? 0.32 : shiny ? 0.26 : 0.42, metalness: metal ? 0.35 : look.tex === 'pearl' ? 0.12 : 0.02 });
      if (GLOWING.has(look.tex) && LIVE.has(look.tex)) {
        // glowing numbers over moving fire: each frame the moving tile is laid over the faces and the numbers on top
        const tile = liveTile(look), nums = atlas(sh, look, labels, 'numbers').cv;
        const cv2 = document.createElement('canvas');
        cv2.width = cv2.height = nums.width;
        const g2 = cv2.getContext('2d');
        const draw = t => {
          tile.draw(t);
          g2.globalCompositeOperation = 'source-over'; g2.globalAlpha = 1;
          g2.fillStyle = g2.createPattern(tile.cv, 'repeat'); g2.fillRect(0, 0, cv2.width, cv2.height);
          g2.globalCompositeOperation = 'lighter'; g2.drawImage(nums, 0, 0);
        };
        draw(0);
        const glow = new T.CanvasTexture(cv2);
        glow.colorSpace = T.SRGBColorSpace;
        lives.set(glow, draw);
        mat.emissiveMap = glow;
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = 1;
        mat.userData.anim = ANIMATED[look.tex];
      } else if (GLOWING.has(look.tex)) {
        // numbers that glow: the light (numbers and the pattern's own) drawn over the same faces, and pulsed (animate())
        const glow = new T.CanvasTexture(atlas(sh, look, labels, true).cv);
        glow.colorSpace = T.SRGBColorSpace;
        mat.emissiveMap = glow;
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = 0.9;
        if (ANIMATED[look.tex]) mat.userData.anim = ANIMATED[look.tex];
      } else if (ANIMATED[look.tex]) {
        // the moving layer: its own tile, repeated over the die, lit from within and changed each frame (animate())
        const tile = LIVE.has(look.tex) ? liveTile(look) : null;
        const glow = new T.CanvasTexture(tile ? tile.cv : glowLayer(look));
        glow.colorSpace = T.SRGBColorSpace;
        if (tile) lives.set(glow, tile.draw);
        glow.wrapS = glow.wrapT = T.RepeatWrapping ?? 1000;
        const rep = look.tex === 'ember' ? 1 : 2;   // fewer repeats, bigger flakes and stars: big enough to see move
        glow.repeat.set(rep, rep);
        mat.emissiveMap = glow;
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = 0.8;
        mat.userData.anim = ANIMATED[look.tex];
      }
      mats.set(k, mat);
      const gk = `${sides}|${labels ? labels.faces.join(',') : ''}|${sh.faces.length}`;
      if (!geos.has(gk)) geos.set(gk, geometry(sh, uv));
      mats.get(k).userData.geo = gk;
    }
    let mat = mats.get(k);
    if (dim) { mat = mat.clone(); mat.transparent = true; mat.opacity = 0.45; mat.userData.temp = true; }
    const m = new T.Mesh(geos.get(mats.get(k).userData.geo), mat);
    m.castShadow = true;
    return { m, sh };
  }
  /** The way to turn a die so the face (or a d4's corner) showing value lands on top, its number upright to the viewer. */
  function landing(sh, value, labels) {
    const Y = new T.Vector3(0, 1, 0);
    let dir, up = null;
    if (sh.sides === 4) dir = sh.P[Math.max(0, Math.min(3, value - 1))];
    else {
      const want = labels ? labels.read(value) : String(value);
      const options = sh.faces.filter(f => faceText(f, labels, sh.sides) === want);
      const f = options[Math.floor(Math.random() * options.length)] || sh.faces[0];
      dir = f.n; up = f.up;
    }
    const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(...V.norm(dir)), Y);
    let yaw;
    if (up) {
      const u = new T.Vector3(...up).applyQuaternion(q);       // the number's up, now lying flat
      yaw = Math.PI - Math.atan2(u.x, u.z);                  // turn it to point away from the viewer (up the screen)
      yaw += (Math.random() - 0.5) * 0.5;
    } else yaw = Math.random() * Math.PI * 2;
    return new T.Quaternion().setFromAxisAngle(Y, yaw).multiply(q);
  }

  /** The part of the window the dice may land in: beside or above the roller, whichever is bigger. */
  function area() {
    const vw = innerWidth, vh = innerHeight;
    const p = document.querySelector('.dice-panel:not([hidden])')?.getBoundingClientRect();
    if (!p || p.width < 10) return { x: 0, y: 0, w: vw, h: vh };
    const left = p.left, above = p.top;
    if (left * vh >= above * vw && left > 160) return { x: 0, y: 0, w: left, h: vh };
    if (above > 160) return { x: 0, y: 0, w: vw, h: above };
    return { x: 0, y: 0, w: vw, h: vh };
  }

  let lastSpark = 0;
  /** Move the animated patterns of the dice on show: glitter flakes jump to new spots (so they sparkle), stars drift
   * and twinkle, embers pulse. t is seconds since the throw. */
  function animate(list, t) {
    const seen = new Set();
    for (const d of list) {
      const m = d.m.material;
      if (!m.userData.anim || seen.has(m.emissiveMap)) continue;
      seen.add(m.emissiveMap);
      const g = m.emissiveMap;
      // fire that moves: its picture is redrawn for this moment and sent to the GPU again
      const live = lives.get(g);
      if (live) { live(t); g.needsUpdate = true; m.emissiveIntensity = 1 + 0.15 * Math.sin(t * 11) * Math.sin(t * 6.1); continue; }
      // strong enough to see in the second or two the dice rest before they fade (the flat dice's CSS is the yardstick)
      if (m.userData.anim === 'sparkle') {
        if (t - lastSpark > 0.12) { g.offset.set(Math.random(), Math.random()); lastSpark = t; }
        m.emissiveIntensity = 1.6 + 0.8 * Math.sin(t * 9);
      } else if (m.userData.anim === 'drift') {
        g.offset.set(t * 0.07, t * 0.03);
        m.emissiveIntensity = 1 + 0.6 * Math.sin(t * 4.1) * Math.sin(t * 2.3);
      } else if (m.userData.anim === 'shine') {
        g.offset.set((t * 0.3) % 1, 0);
        m.emissiveIntensity = 1;
      } else if (m.userData.anim === 'pulse') {
        m.emissiveIntensity = 0.45 + 0.9 * (0.5 + 0.5 * Math.sin(t * 2.2));
      } else if (m.userData.anim === 'flicker') {
        m.emissiveIntensity = 1 + 0.35 * Math.sin(t * 13) * Math.sin(t * 7.3) + 0.2 * Math.sin(t * 23.1);
      } else {
        m.emissiveIntensity = 0.25 + 1.1 * (0.5 + 0.5 * Math.sin(t * 3.2) * Math.sin(t * 1.3 + 1));
      }
    }
  }
  const moving = list => !reduced() && list.some(d => d.m.material.userData.anim);
  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    clearTimeout(fadeTimer);
    if (current) {
      for (const d of current.dice) { scene.remove(d.m); if (d.m.material.userData.temp) d.m.material.dispose(); }
      current.done(false);
      current = null;
    }
    if (canvas) { canvas.classList.remove('on', 'fade'); }
  }
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  /**
   * Throw the dice of a rolled roll (Dice.roll) in a look, over the page. Resolves true when they have landed, or
   * false at once when they can't be shown (3D off, no WebGL, a roll with no dice that have a shape), so the caller can
   * show the result then. A new throw clears the last one. only: a Set of die numbers (d.i) to throw just those.
   */
  async function toss(res, look, only = null) {
    if (!enabled() || reduced() || broken) return false;
    const list = plan(res, only);
    if (!list.length) return false;
    try { await lib(); } catch { return false; }
    if (!setup()) return false;
    stop();
    look = look || themeLook();
    const A = area();
    canvas.style.left = `${A.x}px`; canvas.style.top = `${A.y}px`;
    canvas.style.width = `${A.w}px`; canvas.style.height = `${A.h}px`;
    renderer.setSize(A.w, A.h, false);
    // a die is about P pixels across; fewer pixels each when there are many
    let P = Math.max(44, Math.min(78, Math.min(A.w, A.h) / 6.5));
    P = Math.max(30, Math.min(P, Math.sqrt((A.w * A.h) / (list.length * 9))));
    const unit = 1.6 / P;                      // world units per pixel on the floor
    const fov = 22 * Math.PI / 180, D = (A.h * unit) / (2 * Math.tan(fov / 2));
    camera.aspect = A.w / A.h;
    camera.position.set(0, D, D * 0.12);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const halfW = (A.w * unit) / 2 - 1.1, halfH = (A.h * unit) / 2 - 1.1;
    const sc = sun.shadow.camera;
    sc.left = -halfW - 4; sc.right = halfW + 4; sc.top = halfH + 4; sc.bottom = -halfH - 4; sc.far = 60;
    sc.updateProjectionMatrix();
    // where each die comes to rest: spread out, not on top of each other
    const spots = [];
    const spread = Math.min(halfW, Math.max(2.2, Math.sqrt(list.length) * 1.5)), spreadH = Math.min(halfH, Math.max(2, Math.sqrt(list.length) * 1.3));
    for (let i = 0; i < list.length; i++) {
      let best = null, bestD = -1;
      for (let tries = 0; tries < 40; tries++) {
        const p = [(Math.random() * 2 - 1) * spread, (Math.random() * 2 - 1) * spreadH];
        const d = Math.min(99, ...spots.map(s => Math.hypot(s[0] - p[0], s[1] - p[1])));
        if (d > bestD) { best = p; bestD = d; }
        if (d > 1.7) break;
      }
      spots.push(best);
    }
    const from = Math.random() < 0.5 ? 1 : -1;          // thrown in from the right or the left
    const dice = list.map((d, i) => {
      const { m, sh } = mesh(d.sides, look, d.labels, d.dim);
      const end = landing(sh, d.value, d.labels);
      // how high its centre sits when resting this way up
      const low = Math.min(...sh.P.map(p => new T.Vector3(...p).applyQuaternion(end).y));
      const [ex, ez] = spots[i];
      const start = [from * (halfW + 3 + Math.random() * 2), ez + (Math.random() - 0.5) * 3];
      const dir = V.norm([ex - start[0], 0, ez - start[1]]);
      const axis = new T.Vector3(...V.norm(V.cross([0, 1, 0], dir)));
      const T0 = i * 0.045 + Math.random() * 0.08, dur = 1.05 + Math.random() * 0.35;
      scene.add(m);
      m.visible = false;
      return { m, end, rest: -low, ex, ez, start, axis, spin: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3), turns: -(5 + Math.random() * 5), T0, dur, bounce: 1.4 + Math.random() * 0.8 };
    });
    canvas.classList.remove('fade');
    canvas.classList.add('on');
    return new Promise(resolve => {
      const t0 = performance.now();
      let landed = false, landedAt = 0;
      current = { dice, done: v => resolve(v) };
      const q = new T.Quaternion(), qs = new T.Quaternion(), Y = new T.Vector3(0, 1, 0);
      const frame = now => {
        const t = (now - t0) / 1000;
        let all = true;
        for (const d of dice) {
          const u = Math.max(0, Math.min(1, (t - d.T0) / d.dur));
          if (u < 1) all = false;
          d.m.visible = t >= d.T0;
          const e = easeOut(u);
          d.m.position.set(d.start[0] + (d.ex - d.start[0]) * e, 0, d.start[1] + (d.ez - d.start[1]) * e);
          // bounces that die away, landing at rest when u reaches 1
          d.m.position.y = d.rest + d.bounce * Math.exp(-3.2 * u) * Math.abs(Math.cos(u * Math.PI * 2.6)) * (1 - u);
          q.setFromAxisAngle(d.axis, d.turns * (1 - e));
          qs.setFromAxisAngle(Y, d.spin * (1 - e) * (1 - e));
          d.m.quaternion.copy(q).multiply(qs).multiply(d.end);
        }
        animate(dice, t);
        renderer.render(scene, camera);
        if (all && !landed) {
          landed = true;
          resolve(true);
          // the dice stay as long as this device asks (stay()) so everyone sees them, then fade; or until the next roll
          const hold = stay();
          landedAt = t;
          if (hold) fadeTimer = setTimeout(() => {
            canvas.classList.add('fade');
            fadeTimer = setTimeout(() => { if (current?.dice === dice) { current.done = () => {}; stop(); } }, 600);
          }, hold * 1000 - 400);
          // still dice need no more frames; animated patterns keep moving until the dice fade
          if (!moving(dice)) { raf = 0; return; }
        }
        // dice staying until the next roll stop moving after a while, so they cost nothing while they wait
        if (landed && t - landedAt > 20) { raf = 0; return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  /** A still of one die in a look, drawn into a 2D canvas (the 🎨 picker's preview). False when 3D isn't available. */
  async function still(target, look, sides = 20) {
    if (broken) return false;
    try { await lib(); } catch { return false; }
    if (!setup()) return false;
    // its own small scene and renderer, so a preview never disturbs dice that are on the page
    if (!preview) {
      try { preview = { r: new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }), s: new T.Scene(), c: new T.PerspectiveCamera(32, 1, 0.5, 50) }; } catch { return false; }
      preview.s.add(new T.HemisphereLight(0xffffff, 0x3a3328, 1.7));
      const sunP = new T.DirectionalLight(0xffffff, 2.4);
      sunP.position.set(-10, 9, -7);
      preview.s.add(sunP);
      preview.c.position.set(0, 4.6, 0.01);
      preview.c.up.set(0, 0, -1);
      preview.c.lookAt(0, 0, 0);
    }
    const w = target.width, h = target.height;
    const { m, sh } = mesh(sides, look || themeLook(), null, false);
    const end = landing(sh, sides, null);
    m.quaternion.copy(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -0.45)).multiply(end);
    preview.s.add(m);
    preview.r.setSize(w, h, false);
    preview.c.aspect = w / h;
    preview.c.updateProjectionMatrix();
    preview.r.render(preview.s, preview.c);
    const g = target.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.drawImage(preview.r.domElement, 0, 0, w, h);
    preview.s.remove(m);
    return true;
  }

  /** Whether toss() would throw this roll's dice (so its result can wait for them). */
  const can = (res, only) => enabled() && !reduced() && !broken && available() && plan(res, only).length > 0;

  /** For the tests (tests/browser/dice-3d.spec.js), with three.js handed in: what shows on top once a die of this
   * shape lands on value (a d4: the corner that points up). */
  function topAfter(lib3, sides, value, labels) {
    T = T || lib3;
    const sh = shape(sides), q = landing(sh, value, labels);
    if (sides === 4) {
      const ys = sh.P.map(p => new T.Vector3(...p).applyQuaternion(q).y);
      return String(ys.indexOf(Math.max(...ys)) + 1);
    }
    const ys = sh.faces.map(f => new T.Vector3(...f.n).applyQuaternion(q).y);
    const f = sh.faces[ys.indexOf(Math.max(...ys))];
    const up = new T.Vector3(...f.up).applyQuaternion(q);
    return { text: faceText(f, labels, sides), flat: Math.max(...ys), upright: -up.z };
  }

  root.Dice3D = { TEXTURES, ANIMATED, SWATCHES, SKINS, FRAMES, GLOWING, can, available, enabled, setEnabled, STAYS, stay, setStay, themeLook, inkFor, pattern, chip, plan, toss, still, stop, shape, topAfter, LABELS: { FUDGE, D3, TENS, UNITS } };
})(window);
