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

  const nameKey = s => String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ').replace(/^the /, '');

  function pinFor(pins, name) {
    const k = nameKey(name);
    const entryName = p => p.entry && p.entry.name != null ? p.entry.name : p.entry_name;   // pin_out has entry: {id, name}
    return pins.find(p => nameKey(p.label) === k || (entryName(p) != null && nameKey(entryName(p)) === k)) || null;
  }

  const MapGeo = { UNIT_M, ROLL20, isSpace, scaleFromPoints, scaleFromGrid, gridHint, pathPx, toMetres, fmtDistance, nameKey, pinFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = MapGeo;
  else root.MapGeo = MapGeo;
})(typeof window !== 'undefined' ? window : globalThis);
