// Virtual tabletop map files, read and written in the browser (and under Node for the tests): Universal VTT
// (.uvtt, .dd2vtt, .df2vtt), a Foundry scene's JSON with its picture, MapTool's .rpmap and Fantasy Grounds' .mod.
// Each is turned into the same shape: the map's picture, its grid and, where the file says, the distance a square is.
// The zips are read here with the browser's own DecompressionStream, so the server never unpacks one.
(function (root) {
  const MAX_ENTRY = 300 * 1024 * 1024;   // no picture in a map file is this big; a larger entry is refused, not read

  const fail = msg => { throw new Error(msg); };
  const NOT_VTT = "That isn't a Universal VTT, Foundry, MapTool or Fantasy Grounds file";

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

  // ---------------------------------------------------------------- zip

  /** The entries of a zip: [{ name, size, read() → Promise<Uint8Array> }]. Stored and deflated entries only. */
  function readZip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) fail(NOT_VTT);
    const count = v.getUint16(end + 10, true);
    let at = v.getUint32(end + 16, true);
    if (count === 0xffff || at === 0xffffffff) fail('That file is too big to read here');
    const out = [];
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50) fail(NOT_VTT);
      const method = v.getUint16(at + 10, true), csize = v.getUint32(at + 20, true), size = v.getUint32(at + 24, true);
      const nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), noteLen = v.getUint16(at + 32, true);
      const local = v.getUint32(at + 42, true);
      const name = text(bytes.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/');
      at += 46 + nameLen + extraLen + noteLen;
      if (name.endsWith('/')) continue;
      out.push({ name, size, read: async () => {
        if (size > MAX_ENTRY) fail('A picture in that file is too big');
        if (v.getUint32(local, true) !== 0x04034b50) fail(NOT_VTT);
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method !== 8) fail('That file is packed in a way this page can\'t read');
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const parts = [];
        let total = 0;
        for (const reader = stream.getReader(); ;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_ENTRY) { reader.cancel(); fail('A picture in that file is too big'); }
          parts.push(value);
        }
        const all = new Uint8Array(total);
        let k = 0;
        for (const p of parts) { all.set(p, k); k += p.length; }
        return all;
      } });
    }
    return out;
  }

  // ---------------------------------------------------------------- a little XML

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

  /** XML as a tree of { tag, attrs, children, text }: enough for MapTool's and Fantasy Grounds' files. */
  function parseXml(src) {
    const top = { tag: '#root', attrs: {}, children: [], text: '' }, stack = [top];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      const cur = stack[stack.length - 1];
      if (m[1] !== undefined) cur.text += m[1];
      else if (m[2]) { if (stack.length > 1 && cur.tag === m[2]) stack.pop(); }
      else if (m[3]) {
        const attrs = {};
        for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3]);
        const node = { tag: m[3], attrs, children: [], text: '', parent: cur };
        cur.children.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[6] !== undefined) cur.text += unescape(m[6]);
    }
    return top;
  }
  const all = (node, tag, out = []) => { for (const c of node.children) { if (c.tag === tag) out.push(c); all(c, tag, out); } return out; };
  const first = (node, tag) => all(node, tag)[0] || null;
  const childText = (node, tag) => { const c = node && node.children.find(x => x.tag === tag); return c ? c.text.trim() : null; };

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

  /** MapTool's .rpmap: the zone's grid in content.xml, its pictures under assets/. */
  async function fromMapTool(entries, fileName) {
    const content = entries.find(e => e.name === 'content.xml');
    if (!content) fail(NOT_VTT);
    const doc = parseXml(text(await content.read()));
    const zone = first(doc, 'zone') || doc;
    const g = zone.children.find(c => c.tag === 'grid');
    const cls = (g && g.attrs.class) || '';
    // MapTool's vertical hex grid stands in columns (flat-topped hexes), its horizontal one in rows (pointy-topped)
    const type = /HexGridVertical/i.test(cls) ? 'hex_flat' : /HexGridHorizontal/i.test(cls) ? 'hex_pointy' : 'square';
    const size = +childText(g, 'size') || 0;
    const per = +childText(zone, 'unitsPerCell') || 0;
    // the zone's map picture when it names one, else the largest picture in the file
    const want = childText(first(zone, 'mapAsset') || { children: [] }, 'id') || childText(first(first(zone, 'backgroundPaint') || { children: [] }, 'assetId') || { children: [] }, 'id');
    const pics = entries.filter(e => e.name.startsWith('assets/') && e.size > 0);
    let pick = want && pics.find(e => e.name.replace(/^assets\//, '').replace(/\.[^.]+$/, '') === want && /\.\w+$/.test(e.name));
    let bytes = pick ? await pick.read() : null;
    if (!pictureType(bytes)) {
      bytes = null;
      for (const e of pics.sort((a, b) => b.size - a.size)) { const b = await e.read(); if (pictureType(b)) { bytes = b; pick = e; break; } }
    }
    if (!bytes) fail('No map picture in that file');
    const name = childText(zone, 'name') || childText(zone, 'playerAlias') || baseName(fileName);
    return { format: 'MapTool map', name, picture: picture(bytes, name), grid: grid(type, size, childText(g, 'offsetX'), childText(g, 'offsetY')),
      scale: size > 0 && per > 0 ? { per_square: per, unit: 'ft' } : null, notes: [], dropped: { walls: 0, lights: 0 } };
  }

  /** A Fantasy Grounds module's image records (db.xml, or client.xml/common.xml), each with its picture in the zip. */
  async function fromFantasyGrounds(entries, fileName) {
    const db = ['db.xml', 'client.xml', 'common.xml'].map(n => entries.find(e => e.name.toLowerCase() === n)).find(Boolean);
    if (!db) fail(NOT_VTT);
    const doc = parseXml(text(await db.read()));
    const byName = new Map(entries.map(e => [e.name.toLowerCase(), e]));
    const maps = [];
    for (const img of all(doc, 'image').filter(n => n.attrs.type === 'image')) {
      const bmp = first(img, 'bitmap');
      const path = bmp && bmp.text.trim().replace(/\\/g, '/').replace(/@.*$/, '').replace(/^\//, '');
      const entry = path && byName.get(path.toLowerCase());
      if (!entry) continue;
      const record = img.parent;
      const label = childText(record, 'name') || baseName(path);
      const [gx, gy] = (childText(img, 'gridsize') || '').split(',').map(Number);
      const [ox, oy] = (childText(img, 'gridoffset') || '').split(',').map(Number);
      const gt = (childText(img, 'gridtype') || '').toLowerCase();
      const type = gt === 'hexrow' ? 'hex_pointy' : gt === 'hexcolumn' ? 'hex_flat' : 'square';
      const off = childText(img, 'grid') === 'off';
      const size = gx > 0 ? gx : gy > 0 ? gy : 0;
      maps.push({ label, read: async () => ({ format: 'Fantasy Grounds module', name: label, picture: picture(await entry.read(), label),
        grid: off ? null : grid(type, size, ox, oy), scale: !off && size > 0 ? { per_square: 5, unit: 'ft', guessed: true } : null,
        notes: [], dropped: { walls: 0, lights: 0 } }) });
    }
    if (!maps.length) fail('No map picture in that file');
    return maps;
  }

  /**
   * Read the files a GM picked ([{ name, bytes }]): one VTT file, or a Foundry scene's JSON with its picture. Resolves
   * to a list of maps found ({ label, read() }): one for most files, one per picture for a Fantasy Grounds module.
   */
  async function readVtt(files) {
    if (!files || !files.length) fail('Choose a file');
    const json = files.find(f => /\.(uvtt|dd2vtt|df2vtt|json)$/i.test(f.name));
    if (json) {
      let data;
      try { data = JSON.parse(text(json.bytes)); } catch { fail(NOT_VTT); }
      if (data && data.resolution && 'image' in data) return [{ label: baseName(json.name), read: async () => fromUvtt(data, json.name) }];
      if (data && ('grid' in data || 'gridType' in data) && ('width' in data || 'img' in data || 'background' in data)) {
        const pic = files.find(f => f !== json && pictureType(f.bytes));
        return [{ label: String(data.name || baseName(json.name)), read: async () => fromFoundry(data, pic) }];
      }
      fail(NOT_VTT);
    }
    const f = files[0];
    if (!/\.(rpmap|mod|zip)$/i.test(f.name)) fail(NOT_VTT);
    const entries = readZip(f.bytes);
    if (entries.some(e => e.name === 'content.xml')) return [{ label: baseName(f.name), read: () => fromMapTool(entries, f.name) }];
    return fromFantasyGrounds(entries, f.name);
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

  const VTT = { readVtt, readZip, parseXml, toUvtt, pictureType, toBase64, fromBase64, NOT_VTT };
  if (typeof module !== 'undefined' && module.exports) module.exports = VTT;
  else root.VTT = VTT;
})(typeof window !== 'undefined' ? window : globalThis);
