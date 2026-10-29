// Virtual tabletop map files, read and written in the browser (and under Node for the tests): Universal VTT
// (.uvtt, .dd2vtt, .df2vtt) and a Foundry scene's JSON with its picture. Each is turned into the same shape: the map's
// picture, its grid and, where the file says, the distance a square is. Foundry, Roll20, Owlbear Rodeo, MapTool and Fantasy
// Grounds all read Universal VTT, so it is also what a map is exported as.
(function (root) {
  const fail = msg => { throw new Error(msg); };
  const NOT_VTT = "That isn't a Universal VTT file or a Foundry scene";

  // ---------------------------------------------------------------- bytes

  const text = bytes => new TextDecoder().decode(bytes);

  function fromBase64(s) {
    const bin = atob(String(s).replace(/^data:[^,]*,/, '').replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** A picture's type from its first bytes, or null when it is no picture a map can use. */
  function pictureType(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (text(b.subarray(0, 4)) === 'RIFF' && text(b.subarray(8, 12)) === 'WEBP') return 'image/webp';
    return null;
  }
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

  // ---------------------------------------------------------------- the formats

  const UNITS = { ft: 'ft', feet: 'ft', foot: 'ft', "'": 'ft', m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm', mi: 'mi', mile: 'mi', miles: 'mi', km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km' };
  const unitOf = u => UNITS[String(u || '').trim().toLowerCase().replace(/\.$/, '')] || null;
  const wrap = (v, size) => ((v % size) + size) % size;
  const baseName = name => String(name || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const picture = (bytes, name) => {
    const type = pictureType(bytes);
    if (!type) fail('No map picture in that file');
    return { bytes, type, name: `${baseName(name) || 'map'}.${EXT[type]}` };
  };
  const grid = (type, px, ox, oy) => (px > 0 ? { type, px, offset_x: wrap(+ox || 0, px), offset_y: wrap(+oy || 0, px) } : null);

  /** Universal VTT: the picture is inside, as base64; map_origin is where the picture starts, in squares. */
  function fromUvtt(json, fileName) {
    const r = json.resolution || {};
    const ppg = +r.pixels_per_grid;
    if (!json.image) fail('No map picture in that file');
    const o = r.map_origin || {};
    const walls = (json.line_of_sight || []).length + (json.objects_line_of_sight || []).length + (json.portals || []).length;
    return { format: 'Universal VTT', name: baseName(fileName), picture: picture(fromBase64(json.image), fileName),
      grid: grid('square', ppg, -(+o.x || 0) * ppg, -(+o.y || 0) * ppg), scale: ppg > 0 ? { per_square: 5, unit: 'ft', guessed: true } : null,
      notes: [], dropped: { walls, lights: (json.lights || []).length } };
  }

  /** A Foundry scene's JSON (any version from 0.8 on) with the picture picked beside it. */
  function fromFoundry(json, pic) {
    if (!pic) fail('Pick the scene\'s picture together with its JSON file');
    const g = typeof json.grid === 'object' && json.grid ? json.grid : { size: json.grid, type: json.gridType, distance: json.gridDistance, units: json.gridUnits };
    const size = +g.size || 100, t = +(g.type ?? 1);
    const type = t === 2 || t === 3 ? 'hex_pointy' : t === 4 || t === 5 ? 'hex_flat' : 'square';
    const bg = json.background && typeof json.background === 'object' ? json.background : {};
    const shiftX = +(bg.offsetX ?? json.shiftX ?? 0), shiftY = +(bg.offsetY ?? json.shiftY ?? 0);
    // notes sit on the whole canvas, which has padding round the picture, rounded up to whole squares
    const pad = +json.padding || 0, w = +json.width || 0, h = +json.height || 0;
    const px = Math.ceil(w * pad / size) * size, py = Math.ceil(h * pad / size) * size;
    const notes = (json.notes || []).map(n => ({ x: +n.x - px - shiftX, y: +n.y - py - shiftY, label: String(n.text || n.label || 'Note').trim().slice(0, 150) || 'Note' }))
      .filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= 0 && n.y >= 0 && (!w || n.x <= w) && (!h || n.y <= h));
    const unit = unitOf(g.units);
    return { format: 'Foundry scene', name: String(json.name || baseName(pic.name)).slice(0, 150), picture: picture(pic.bytes, pic.name),
      grid: t === 0 ? null : grid(type, size, -shiftX, -shiftY), scale: t !== 0 && unit && +g.distance > 0 ? { per_square: +g.distance, unit } : null,
      notes, dropped: { walls: (json.walls || []).length, lights: (json.lights || []).length } };
  }

  /** The map in the files a GM picked ([{ name, bytes }]): one Universal VTT file, or a Foundry scene's JSON with its
   * picture. */
  async function readVtt(files) {
    if (!files || !files.length) fail('Choose a file');
    const json = files.find(f => /\.(uvtt|dd2vtt|df2vtt|json)$/i.test(f.name));
    if (json) {
      let data;
      try { data = JSON.parse(text(json.bytes)); } catch { fail(NOT_VTT); }
      if (data && data.resolution && 'image' in data) return fromUvtt(data, json.name);
      if (data && ('grid' in data || 'gridType' in data) && ('width' in data || 'img' in data || 'background' in data))
        return fromFoundry(data, files.find(f => f !== json && pictureType(f.bytes)));
    }
    fail(NOT_VTT);
  }

  /** A map as a Universal VTT file (the .dd2vtt JSON), with its picture's bytes; it needs the map's grid. */
  function toUvtt(map, bytes) {
    const ppg = +map.grid_px;
    if (!(ppg > 0)) fail('Set grid squares first (Scale → Grid squares)');
    const r = n => +n.toFixed(4);
    return JSON.stringify({
      format: 0.3, software: 'Campaign Chronicle',
      resolution: { map_origin: { x: r(-(+map.grid_offset_x || 0) / ppg), y: r(-(+map.grid_offset_y || 0) / ppg) },
        map_size: { x: r(map.width / ppg), y: r(map.height / ppg) }, pixels_per_grid: ppg },
      line_of_sight: [], objects_line_of_sight: [], portals: [], environment: { baked_lighting: true, ambient_light: 'ffffffff' }, lights: [],
      image: toBase64(bytes),
    });
  }

  const VTT = { readVtt, toUvtt, pictureType, toBase64, fromBase64, NOT_VTT };
  if (typeof module !== 'undefined' && module.exports) module.exports = VTT;
  else root.VTT = VTT;
})(typeof window !== 'undefined' ? window : globalThis);
