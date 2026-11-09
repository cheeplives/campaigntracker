/* maps.js — the Maps tab: a list of maps, and one map shown with Leaflet (static/vendor/leaflet) as a flat picture
 * (L.CRS.Simple). A map's own pixels are the coordinates: x runs right and y runs down from the top-left corner, and
 * Leaflet's latitude is -y. app.js hands it a context (mapsCtx), as for the Tokens tab.
 *
 * Plain script, no build step. MapsTab.marker() is the one place a marker is built: pins, party markers and later
 * tokens all use it. */
'use strict';

const MapsTab = (() => {
  const G = MapGeo, { el } = KIT;
  const UNITS = [['ft', 'Feet'], ['m', 'Metres'], ['mi', 'Miles'], ['km', 'Kilometres'], ['au', 'Astronomical units'], ['ly', 'Light-years']];
  const PICTURES = 'image/png,image/jpeg,image/gif,image/webp';
  const VTT_FILES = '.uvtt,.dd2vtt,.df2vtt,.json,' + PICTURES;
  /** Icons a pin can have, with a name each for screen readers and the picker's tips. */
  const PIN_ICONS = [['📍', 'Pin'], ['🏰', 'Castle'], ['🏯', 'Fortress'], ['🏛️', 'Temple or hall'], ['⛪', 'Church'], ['🏠', 'House'], ['🏘️', 'Village'],
    ['🏙️', 'City'], ['🍺', 'Tavern or inn'], ['🛖', 'Hut'], ['⛺', 'Camp'], ['🗼', 'Tower'], ['🗿', 'Monument'], ['🏚️', 'Ruin'], ['⚓', 'Port'],
    ['⛵', 'Ship'], ['🌉', 'Bridge'], ['🚪', 'Door or gate'], ['🕳️', 'Cave or pit'], ['⛏️', 'Mine'], ['🌲', 'Forest'], ['⛰️', 'Hill'],
    ['🏔️', 'Mountain'], ['🌋', 'Volcano'], ['🏝️', 'Island'], ['🌊', 'Water'], ['💧', 'Spring or well'], ['🔥', 'Fire'], ['⚔️', 'Battle'],
    ['🛡️', 'Guard post'], ['💀', 'Danger'], ['☠️', 'Death'], ['🐉', 'Monster'], ['👑', 'Royal seat'], ['💰', 'Treasure'], ['💎', 'Gem'],
    ['🗝️', 'Key'], ['📜', 'Clue'], ['❓', 'Unknown'], ['❗', 'Important'], ['⭐', 'Star'], ['🚩', 'Flag'], ['✨', 'Magic'], ['🌀', 'Portal'],
    ['🪐', 'Planet'], ['🚀', 'Starship'], ['🛰️', 'Station'], ['☢️', 'Hazard']];
  /** Colours for pins and routes, picked to read on light and dark maps. */
  const COLOURS = [['#d64541', 'Red'], ['#f08c2e', 'Orange'], ['#f4c430', 'Yellow'], ['#3fae4b', 'Green'], ['#1fa5a0', 'Teal'], ['#3a7bd5', 'Blue'],
    ['#8a5cd1', 'Purple'], ['#e05aa6', 'Pink'], ['#8b5a2b', 'Brown'], ['#222222', 'Black'], ['#f5f5f5', 'White']];
  /** Route lines: name -> [label, SVG dash pattern (null: solid), round ends]. */
  const DASHES = { dashed: ['Dashed', '8 6', false], solid: ['Solid', null, false], dotted: ['Dotted', '1 7', true], dashdot: ['Dash-dot', '12 6 1 6', true] };

  /** A map's pixel position <-> Leaflet's. */
  const toLatLng = (x, y) => [-y, x];
  const toXY = ll => ({ x: ll.lng, y: -ll.lat });

  let say = () => {};   // the page's toast, for a marker that could not be moved
  // Leaflet focuses the map on a press, then scrolls the window back to where it was; with the page's smooth scrolling
  // that scroll-back is animated, moving a marker out from under the finger between press and release (so the tap misses it)
  if (typeof L !== 'undefined' && L.Map.Keyboard) L.Map.Keyboard.prototype._onMouseDown = function () { if (!this._focused) this._map._container.focus({ preventScroll: true }); };

  /** A marker on `layer`: the picture, or the emoji, with its label under it. It keeps its size as the map zooms. onMove
   * runs after a drag and, if it fails, the marker goes back; onOpen's node fills the card a click opens. */
  // GM only switches: the 🔒 button the rich text editor marks GM-only paragraphs with (app.js has the same lockBox)
  function lockBox(input, tipText) {
    if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', 'GM only');
    return el('label', { class: 'lock-toggle', 'data-tip': `GM only: ${tipText}` }, input, el('span', { 'aria-hidden': 'true' }, '🔒'));
  }
  const lockBtn = (onclick, tipText, cls) => el('button', { type: 'button', class: `lock-toggle ${cls || ''}`.trim(), 'aria-label': 'GM only', 'aria-pressed': 'false', 'data-tip': `GM only: ${tipText}`, onclick }, '🔒');
  function marker(layer, { x, y, icon, image, label, className, color, sizePx = 28, draggable = false, onMove, onOpen, pad, onPick }) {
    const tint = color && !image;
    const face = image ? el('img', { class: 'map-marker-icon', src: image, alt: '' })
      : el('span', { class: 'map-marker-icon' + (tint ? ' tinted' : ''), 'aria-hidden': 'true', 'data-icon': tint ? icon || '' : null }, icon || '');
    const node = el('div', { class: `map-marker ${tint ? 'has-colour ' : ''}${className || ''}`.trim() }, face, label ? el('span', { class: 'map-marker-label' }, label) : null);
    node.style.setProperty('--marker-size', sizePx + 'px');
    if (color) node.style.setProperty('--pin-colour', color);
    const m = L.marker(toLatLng(x, y), { icon: L.divIcon({ html: node, className: 'map-marker-box', iconSize: [sizePx, sizePx], iconAnchor: [sizePx / 2, sizePx / 2] }),
      draggable, title: label || '', keyboard: true, riseOnHover: true });
    if (onOpen) {
      // pad: { tl, br }, the room a card keeps from the map's edges ([x, y] arrays, read each time a card opens)
      m.bindPopup(() => onOpen(), { className: 'map-card-popup', minWidth: 160, ...(pad ? { autoPanPaddingTopLeft: pad.tl, autoPanPaddingBottomRight: pad.br } : {}) });
      m.on('popupopen', () => node.classList.add('selected')).on('popupclose', () => node.classList.remove('selected'));   // its label shows while its card is open
      // onPick: a click the page takes for itself (true) opens no card
      if (onPick) { m.off('click', m._openPopup, m); m.on('click', e => { if (!onPick()) m._openPopup(e); }); }
    }
    let was = m.getLatLng();
    if (onMove) m.on('dragend', async () => {
      try { await onMove(toXY(m.getLatLng())); was = m.getLatLng(); } catch (err) { m.setLatLng(was); say(err.message, true); }
    });
    m.addTo(layer);
    return m;
  }

  /** The scale bar: a round distance drawn to the zoom. Leaflet's own L.control.scale assumes the Earth. */
  function scaleControl(getMap, system) {
    const Bar = L.Control.extend({
      onAdd(map) {
        this._map = map;
        this._line = el('div', { class: 'map-scale-line' });
        this._text = el('span', {});
        this._box = el('div', { class: 'map-scale', 'aria-label': 'Scale bar', role: 'img' }, this._text, this._line);
        map.on('zoom zoomend move', this.update, this);
        this.update();
        return this._box;
      },
      onRemove(map) { map.off('zoom zoomend move', this.update, this); },
      update() {
        const map = getMap(), m = this._map;
        const perPx = G.toMetres(1, map);
        this._box.hidden = !(perPx > 0);
        if (this._box.hidden) return;
        // a screen pixel is 2^-zoom picture pixels
        const mPerScreen = perPx / m.getZoomScale(m.getZoom(), 0);
        const space = G.isSpace(map);
        const max = 100 * mPerScreen;
        const unit = /\s(\S+)$/.exec(G.fmtDistance(max, system(), space))?.[1];
        const factor = { ft: G.UNIT_M.ft, mi: G.UNIT_M.mi, m: 1, km: 1000, AU: G.UNIT_M.au, ly: G.UNIT_M.ly }[unit] || 1;
        const inUnit = max / factor, mag = 10 ** Math.floor(Math.log10(inUnit));
        const nice = [5, 2, 1].map(n => n * mag).find(n => n <= inUnit) || mag;
        this._text.textContent = G.fmtDistance(nice * factor, system(), space);
        this._line.style.width = Math.max(8, Math.round(nice * factor / mPerScreen)) + 'px';
      },
    });
    return new Bar({ position: 'bottomleft' });
  }

  // ------------------------------------------------------------ very large pictures

  const BIG_PICTURE = 16e6;   // pixels (4000 x 4000), from where a picture is tiled

  /** A tile layer showing the picture at `url` (w x h, in the map's own pixels): each 256 px tile is drawn from the decoded
   * image when it is asked for, from a half, quarter... size copy (made once, on first use) when zoomed out. */
  function bigPicture(url, w, h, bounds) {
    const img = new Image();
    const loaded = (img.src = url, img.decode ? img.decode().catch(() => new Promise(r => { img.onload = r; img.onerror = r; })) : new Promise(r => { img.onload = r; img.onerror = r; }));
    const levels = new Map();   // how many halvings => the source to draw from (a promise)
    const level = k => {
      if (!levels.has(k)) {
        levels.set(k, k === 0 || typeof createImageBitmap !== 'function' ? Promise.resolve(img)
          : createImageBitmap(img, { resizeWidth: Math.max(1, Math.ceil(w / 2 ** k)), resizeHeight: Math.max(1, Math.ceil(h / 2 ** k)), resizeQuality: 'high' }).catch(() => img));
      }
      return levels.get(k);
    };
    const Tiles = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("canvas");
        tile.width = tile.height = 256;
        const scale = 2 ** coords.z, span = 256 / scale;   // picture pixels one tile covers
        const k = coords.z < 0 ? Math.min(Math.floor(-coords.z), 8) : 0;
        loaded.then(() => level(k)).then(src => {
          const f = src === img ? 1 : (src.width / w);   // the source's pixels per picture pixel
          const sx = coords.x * span * f, sy = coords.y * span * f, sw = span * f, sh = span * f;
          const ex = Math.min(sx + sw, src.width), ey = Math.min(sy + sh, src.height);
          if (ex > sx && ey > sy) tile.getContext('2d').drawImage(src, sx, sy, ex - sx, ey - sy, 0, 0, Math.round(256 * (ex - sx) / sw), Math.round(256 * (ey - sy) / sh));
          done(null, tile);
        }).catch(err => done(err, tile));
        return tile;
      },
    });
    return new Tiles({ pane: 'mapPicture', tileSize: 256, bounds, noWrap: true, minZoom: -5, maxZoom: 4, minNativeZoom: -8, maxNativeZoom: 6, className: 'map-big-picture', keepBuffer: 1 });
  }

  // ------------------------------------------------------------ the list

  async function list(ctx) {
    const { el, btn, api, S } = ctx;
    const cid = S.camp.id;
    const { maps } = await api('maps', { query: { cid } });
    const cards = maps.map(m => el('a', { class: 'map-card' + (m.is_secret ? ' secret' : ''), href: `#/c/${cid}/maps/${m.id}` },
      m.image_url ? el('img', { src: m.image_url, alt: '', loading: 'lazy' }) : el('span', { class: 'map-card-blank muted small' }, 'No picture'),
      el('strong', {}, m.is_secret ? '🔒 ' : '', m.name),
      el('span', { class: 'small muted' }, m.is_secret ? '🔒 GM only' : '', m.is_secret && m.pins ? ' · ' : '', m.pins ? `${m.pins} pin${m.pins === 1 ? '' : 's'}` : ''),
      m.inside ? el('span', { class: 'small muted map-card-inside' }, `Inside ${m.inside.label} on ${m.inside.map_name}`) : null));
    ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card' },
      el('div', { class: 'row map-list-head' }, el('h2', {}, 'Maps'), ctx.isGM() ? btn('+ New map', () => newMap(ctx), 'primary small') : null),
      cards.length ? el('div', { class: 'map-grid' }, cards) : el('p', { class: 'muted' }, ctx.isGM() ? 'No maps yet. Add one with + New map.' : 'No maps yet.')));
  }

  /** + New map: a name and a picture (uploaded, or found), then the scale panel opens on the new map. */
  function newMap(ctx) {
    const { el, btn, post, field, toast, S } = ctx;
    const cid = S.camp.id;
    const d = el('dialog', { class: 'kit-dialog map-dialog', 'aria-label': 'New map' });
    const name = el('input', { maxlength: 150, required: true, 'aria-label': 'Map name', autocomplete: 'off', placeholder: 'e.g. Sartar' });
    const pic = el('input', { type: 'file', accept: PICTURES, 'aria-label': 'Map picture' });
    const go = el('button', { class: 'primary', type: 'submit' }, 'Create map');
    let made = null, kept = false;
    const open = (map, fileName) => { kept = true; d.close(); location.hash = `#/c/${cid}/maps/${map.id}?scale=1${fileName ? '&file=' + encodeURIComponent(fileName) : ''}`; };
    const form = el('form', {}, el('h3', {}, 'New map'), field('Name', name), field('Picture', pic, 'JPEG, PNG, WebP or GIF'),
      el('div', { class: 'kit-dialog-actions' }, go,
        btn('Find Image…', async () => {
          if (!name.value.trim()) return toast('Give the map a name first', true);
          try { made = (await post('map_save', { name: name.value.trim() }, cid)).map; } catch (err) { return toast(err.message, true); }
          d.replaceChildren(el('h3', {}, `Find a picture for ${made.name}`), ctx.findImage('map', made.id, made.name, { copyOnly: true, onAdded: async file => {
            try { await post('map_save', { id: made.id, image_id: file.id }, cid); open(made); } catch (err) {
              await post('file_delete', { id: file.id }, cid).catch(() => {});
              toast(err.message, true);
            }
          } }), el('div', { class: 'kit-dialog-actions' }, btn('Cancel', () => d.close())));
        }, '', 'Search open picture libraries for the map\'s picture'),
        el('label', { class: 'button file-add', 'data-tip': 'A Universal VTT file (from Dungeondraft, Dungeon Alchemist, DungeonFog…), or a Foundry scene\'s JSON picked together with its picture' },
          el('input', { type: 'file', multiple: true, accept: VTT_FILES, class: 'file-input', 'aria-label': 'Import a VTT file', onchange: ev => importVtt([...ev.target.files]) }), 'Import a VTT file…'),
        btn('Cancel', () => d.close())));
    // a VTT file: read here, then the map is made with its picture, grid and scale, and its notes become GM-only pins
    async function importVtt(files) {
      if (!files.length) return;
      let vtt, file = null;
      try {
        vtt = await VTT.readVtt(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
        made = made || (await post('map_save', { name: name.value.trim() || vtt.name || 'Imported map' }, cid)).map;
        file = await ctx.uploadFile('map', made.id, new File([vtt.picture.bytes], vtt.picture.name, { type: vtt.picture.type }));
        const g = vtt.grid, sc = vtt.scale;
        await post('map_save', { id: made.id, image_id: file.id, ...(g ? { grid_px: g.px, grid_offset_x: g.offset_x, grid_offset_y: g.offset_y, grid_type: g.type, grid_shown: true } : {}),
          ...(g && sc ? { scale_per_px: sc.per_square / g.px, scale_unit: sc.unit } : {}) }, cid);
      } catch (err) {
        if (file) await post('file_delete', { id: file.id }, cid).catch(() => {});
        return toast(err.message, true);
      }
      let pinned = 0;
      for (const n of vtt.notes) {
        try { await post('pin_save', { map_id: made.id, x: n.x, y: n.y, kind: 'note', label: n.label, is_secret: true }, cid); pinned++; } catch { /* a note that can't be a pin is left out */ }
      }
      const said = [`Imported from a ${vtt.format}.`];
      if (pinned) said.push(pinned === 1 ? '1 note became a GM-only pin.' : `${pinned} notes became GM-only pins.`);
      if (vtt.dropped.walls || vtt.dropped.lights) said.push('Walls and lights aren\'t kept.');
      if (vtt.scale?.guessed) said.push('The file doesn\'t say how far a square is, so 5 ft was assumed: check it here.');
      toast(said.join(' '));
      open(made);
    }
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = pic.files[0];
      if (!name.value.trim()) return toast('Give the map a name', true);
      if (!f) return toast('Choose the map\'s picture, or use Find Image', true);
      go.disabled = true;
      let file = null;
      try {
        if (!made) made = (await post('map_save', { name: name.value.trim() }, cid)).map;   // a retry reuses the map already made
        file = await ctx.uploadFile('map', made.id, f);
        await post('map_save', { id: made.id, image_id: file.id }, cid);
        open(made, f.name);
      } catch (err) {
        if (file) await post('file_delete', { id: file.id }, cid).catch(() => {});   // not kept as a picture the map can't use
        toast(err.message, true); go.disabled = false;
      }
    });
    // a map made for a picture that never came is not kept
    d.addEventListener('close', async () => {
      d.remove();
      if (made && !kept) await post('map_delete', { id: made.id }, cid).catch(() => {});
      ctx.reloadCampaign().catch(() => {});
    });
    d.append(form);
    document.body.append(d);
    d.showModal();
  }

  // ------------------------------------------------------------ one map

  async function one(ctx, id, query) {
    const { el, btn, api, post, field, select, toast, S } = ctx;
    const cid = S.camp.id;
    say = toast;
    const params = new URLSearchParams(query || '');
    let data;
    try { data = await api('map', { query: { cid, id } }); } catch {
      return ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card' }, el('p', {}, 'Map not found'), el('a', { href: `#/c/${cid}/maps` }, 'Back to the maps')));
    }
    let map = data.map, pins = data.pins || [], routes = data.routes || [], here = data.groups || [];   // here: the groups on this map
    let trail = data.trail || [];   // where the groups were put on this map, oldest first, each with the shift it was on
    let groups = here;   // every group, for the GM's Party is here (players only ever need the ones drawn)
    const loadGroups = async () => { if (gm) groups = (await api('groups', { query: { cid } })).groups; };
    const gm = ctx.isGM();
    const system = () => ctx.unitSystem();
    const base = `#/c/${cid}/maps/${id}`;
    await loadGroups().catch(() => {});

    // the stage fills the window under the header; the Leaflet canvas and every control floating on the map are its children
    const stage = el('div', { class: `map-stage map-genre-${ctx.genre ? ctx.genre() : 'fantasy'}` });
    const host = el('div', { class: 'map-canvas' });
    stage.append(host);
    const note = el('p', { class: 'small map-note', role: 'status' });
    const total = el('span', { class: 'map-measure-total', role: 'status' });
    // the room an open card keeps clear of what floats on the map: the toolbar along the top, and the drawer (kept up to date in syncDrawer)
    const cardPad = { tl: [16, 64], br: [16, 16] };
    const routeBox = el('aside', { class: 'map-routes surface-float', 'aria-label': 'Routes' });
    routeBox.hidden = true;   // until there is a route or a pin to list
    const toolbar = el('div', { class: 'map-toolbar surface-float' });
    /** A toolbar button: an emoji and a short word (hidden on a phone), named for screen readers and tests by `name`. */
    const tbtn = (icon, word, name, onclick, tip) => {
      const b = btn([`${icon} `, el('span', { class: 'map-tool-word' }, word)], onclick, 'small', tip);
      b.setAttribute('aria-label', name);
      return b;
    };
    const panelBox = el('div', { class: 'map-panel-box' });
    // the mode's hint sits under a form open there, never over it: the stage knows where the form ends
    new ResizeObserver(() => stage.style.setProperty('--panel-bottom', `${panelBox.offsetTop + panelBox.offsetHeight}px`)).observe(panelBox);

    // sheetAway: on a phone the sheet folds away while a tool is in use or a card is open, without changing how it was left
    let lf = null, mode = null, toolMode = null, sheetAway = false;   // mode: 'measure' | 'scale' | 'pin' (the next click places a pin) | 'party' (the next click moves a group there) | 'label' (each click asks for a place's name and pins it) | null
    const bounds = () => [toLatLng(0, map.height), toLatLng(map.width, 0)];
    /** The whole picture in view. While the scale panel is open it floats over the map's left side, and its two points
     * are picked on the picture, so the picture is fitted beside it (when there is room). */
    const fitPicture = () => {
      if (!lf) return;
      // clear of the toolbar along the top and the legend or measure bar along the bottom (and a phone's open sheet)
      const sheet = stage.classList.contains('drawer-open') && window.matchMedia('(max-width: 720px)').matches;
      const phone = window.matchMedia('(max-width: 720px)').matches;
      if (mode !== 'scale') return lf.map.fitBounds(bounds(), { paddingTopLeft: [12, phone ? 64 : toolbar.offsetTop + toolbar.offsetHeight + 8],
        paddingBottomRight: [!phone && stage.classList.contains('drawer-open') ? 312 : 12, phone ? (sheet ? Math.round(stage.clientHeight * 0.45) : 0) + 128 : 48], animate: false });   // a phone: the toolbar, and the measure bar over it
      // beside it when there is room, otherwise under it (a phone)
      const pad = stage.clientWidth > 720 ? [panelBox.offsetWidth + 24, 56] : [12, panelBox.offsetTop + panelBox.offsetHeight + 12];
      lf.map.fitBounds(bounds(), { paddingTopLeft: pad, paddingBottomRight: [12, phone ? 76 : 12], animate: false });
    };

    // ---- measuring
    let pts = [];
    let measureLayer = null;
    const drawMeasure = () => {
      measureLayer.clearLayers();
      saveRouteBtn.hidden = !(gm && mode === 'measure' && pts.length > 1);
      planBtn.hidden = !(gm && mode === 'measure' && pts.length > 1 && hasScale());
      if (!pts.length) { total.textContent = ''; return; }
      L.polyline(pts.map(p => toLatLng(p.x, p.y)), { color: 'var(--accent)', weight: 3, className: 'map-line' }).addTo(measureLayer);
      pts.forEach((p, i) => {
        const c = L.circleMarker(toLatLng(p.x, p.y), { radius: 4, className: 'map-dot', interactive: false }).addTo(measureLayer);
        if (i === pts.length - 1 && i > 0) c.bindTooltip(dist(), { permanent: true, direction: 'right', className: 'map-tip' });
      });
      total.textContent = pts.length > 1 ? dist() : '';
    };
    const dist = () => {
      const d = G.fmtDistance(G.toMetres(G.pathPx(pts), map), system(), G.isSpace(map));
      const n = map.grid_px > 0 ? G.squaresAlong(G.pathPx(pts), map.grid_px) : null;
      const hex = map.grid_type === 'hex_flat' || map.grid_type === 'hex_pointy';
      return n === null ? d : `${d} · ${n} ${hex ? (n === 1 ? 'hex' : 'hexes') : (n === 1 ? 'square' : 'squares')}`;
    };
    const hasScale = () => G.toMetres(1, map) !== null;

    // ---- the grid overlay: one SVG pattern over the picture, in its pixels, drawn for whoever has it shown
    let gridLayer = null, gridLines = [];
    const gridKey = `chronicle-map-grid-${cid}-${id}`;
    const gridWanted = () => {
      try { const v = localStorage.getItem(gridKey); if (v !== null) return v === '1'; } catch { /* storage may be off */ }
      return !!map.grid_shown;
    };
    const opacityKey = gridKey + '-opacity';
    const gridOpacity = () => {
      try { const v = Number(localStorage.getItem(opacityKey)); if (v >= 0.1 && v <= 1) return v; } catch { /* storage may be off */ }
      return 1;
    };
    const gridWidth = () => {   // lines one screen pixel wide (with a light edge) at every zoom
      const k = lf ? 1 / lf.map.getZoomScale(lf.map.getZoom(), 0) : 1;
      gridLines.forEach((l, i) => l.setAttribute('stroke-width', String((i ? 1 : 3) * k)));
    };
    let gridPreview = null;   // {px, ox, oy}: a grid just found on the picture, drawn before it is saved
    function drawGrid() {
      gridLayer?.remove(); gridLayer = null; gridLines = [];
      const has = map.grid_px > 0;
      gridBtn.hidden = !has || !map.image_url;
      gridBtn.setAttribute('aria-pressed', String(has && gridWanted()));
      opacityBox.hidden = !has || !map.image_url || !gridWanted();
      const g = gridPreview ? { px: gridPreview.px, ox: gridPreview.ox, oy: gridPreview.oy, type: gridPreview.type } : { px: map.grid_px, ox: map.grid_offset_x, oy: map.grid_offset_y, type: map.grid_type };
      if (!lf || !(g.px > 0) || !(gridPreview || (has && gridWanted()))) return;
      const NS = 'http://www.w3.org/2000/svg', svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
      const t = G.gridTile(g.type, g.px), pid = `map-grid-${id}`;
      const root = svg('svg', { viewBox: `0 0 ${map.width} ${map.height}`, preserveAspectRatio: 'none' });
      const pattern = svg('pattern', { id: pid, patternUnits: 'userSpaceOnUse', x: g.ox || 0, y: g.oy || 0, width: t.w, height: t.h });
      gridLines = [svg('path', { d: t.d, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.45 }), svg('path', { d: t.d, fill: 'none', stroke: '#000', 'stroke-opacity': 0.55 })];
      pattern.append(...gridLines);
      root.append(svg('defs', {}), svg('rect', { width: map.width, height: map.height, fill: `url(#${pid})` }));
      root.firstChild.append(pattern);
      gridWidth();
      gridLayer = L.svgOverlay(root, bounds(), { pane: 'mapGrid', interactive: false, className: 'map-grid', opacity: gridOpacity() }).addTo(lf.map);
    }
    const gridBtn = tbtn('▦', 'Grid', 'Grid', () => {
      const on = !gridWanted();
      try { localStorage.setItem(gridKey, on ? '1' : '0'); } catch { /* shown or hidden for this visit only */ }
      drawGrid();
    }, 'Show or hide the map\'s grid (just for you)');
    gridBtn.hidden = true;
    const opacityIn = el('input', { type: 'range', min: 10, max: 100, step: 5, value: String(Math.round(gridOpacity() * 100)), 'aria-label': 'Grid opacity' });
    opacityIn.addEventListener('input', () => {
      const v = Number(opacityIn.value) / 100;
      try { localStorage.setItem(opacityKey, String(v)); } catch { /* this visit only */ }
      gridLayer?.setOpacity(v);
    });
    const opacityBox = el('label', { class: 'map-grid-opacity small', 'data-tip': 'How strongly the grid is drawn (just for you)' }, 'Opacity ', opacityIn);
    opacityBox.hidden = true;

    // ---- the scale panel
    let picks = [], pickLayer = null, panel = null;
    const drawPicks = () => {
      pickLayer.clearLayers();
      picks.forEach((p, i) => {
        const dot = L.circleMarker(toLatLng(p.x, p.y), { radius: 5, className: 'map-dot pick', interactive: false });
        if (mode === 'scale') dot.bindTooltip(i ? 'B' : 'A', { permanent: true, direction: 'top', className: 'map-tip' });   // Quick label's spot needs no letter
        dot.addTo(pickLayer);
      });
      if (picks.length === 2) L.polyline(picks.map(p => toLatLng(p.x, p.y)), { weight: 2, dashArray: '4 4', className: 'map-line', interactive: false }).addTo(pickLayer);
    };
    function closePanel() {
      const refit = mode === 'scale';   // the picture was fitted beside (or under) the scale panel: back to the whole stage
      if (gridPreview) { gridPreview = null; drawGrid(); }
      panel = null; panelBox.replaceChildren(); picks = []; pickLayer?.clearLayers(); if (mode === 'scale' || mode === 'pin' || mode === 'label') mode = null; syncTools();
      if (refit) fitPicture();
    }
    /** Look for a square or hex grid in the map's picture (in the browser, on a shrunk copy): {type, px, offset_x, offset_y} in picture pixels, or null. */
    async function findGrid() {
      const img = new Image();
      img.src = map.image_url;
      await img.decode();
      const f = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * f)), h = Math.max(1, Math.round(img.naturalHeight * f));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0, w, h);
      const d = c.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
      for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      await new Promise(r => setTimeout(r, 30));   // let "Looking…" show before the work holds the page
      const r = G.detectAnyGrid(gray, w, h);
      if (!r) return null;
      const k = map.width / w;   // back to picture pixels
      const q = v => Math.round(v * k * 100) / 100;
      return { type: r.type, px: q(r.px), offset_x: q(r.offset_x), offset_y: q(r.offset_y) };
    }
    function openScale(hint) {
      if (mode === 'pin') note.textContent = '';
      mode = 'scale'; picks = []; drawPicks(); note.textContent = '';
      pts = []; measureLayer && drawMeasure();
      const hasGrid = map.grid_px > 0;
      let way = hasGrid || hint ? 'grid' : 'points', offset = null;
      const apart = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Distance', value: '' });
      const unit = select(UNITS, map.scale_unit || (system() === 'metric' ? 'km' : 'mi'), { 'aria-label': 'Unit' });
      const sq = hasGrid && map.scale_per_px ? +(map.scale_per_px * map.grid_px).toPrecision(6) : G.ROLL20.per_square;
      const per = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Distance per square', value: String(sq) });
      const perUnit = select(UNITS, hasGrid && map.scale_unit ? map.scale_unit : G.ROLL20.unit, { 'aria-label': 'Unit' });
      const px = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Pixels per square', value: hasGrid ? String(map.grid_px) : hint ? String(hint.grid_px) : '' });
      const count = el('input', { type: 'number', min: 1, step: 'any', 'aria-label': 'How many squares', value: '' });
      const shape = select([['square', 'Squares'], ['hex_flat', 'Hexes (flat top)'], ['hex_pointy', 'Hexes (pointy top)']], map.grid_type || 'square', { 'aria-label': 'Shape' });
      const shown = el('input', { type: 'checkbox', checked: !!map.grid_shown });
      const way1 = btn('Two points', () => show('points'), '', 'Click two places you know the distance between');
      const way2 = btn('Grid squares', () => show('grid'), '', 'Say how big one square of the map\'s grid is');
      const body = el('div', { class: 'map-panel-body' });
      let found = null, finding = false;   // found: the grid detected on the picture, whose offset is saved with it
      const find = async quiet => {
        if (finding || !map.image_url) return;
        finding = true; findBtn.disabled = true;
        try {
          const r = await findGrid();
          if (r && panel) {
            found = r; px.value = String(r.px); shape.value = r.type; show('grid');
            gridPreview = { type: r.type, px: r.px, ox: r.offset_x, oy: r.offset_y }; drawGrid();
            toast(`Found a ${r.type === 'square' ? 'square' : 'hex'} grid of about ${Math.round(r.px * 10) / 10} px. Check it lines up, then save the scale`);
          } else if (!quiet) toast('No grid found on the picture. Type its size, or click a run of squares', true);
        } catch { if (!quiet) toast('Couldn\'t read the picture to look for a grid', true); } finally { finding = false; findBtn.disabled = false; }
      };
      const findBtn = btn('Find the grid', () => find(false), 'small', 'Look for a square grid drawn on the picture and fill in its size');
      shape.addEventListener('change', () => { if (found && shape.value !== found.type) found = null; if (gridPreview) { gridPreview.type = shape.value; drawGrid(); } });   // the preview follows the shape picked
      px.addEventListener('input', () => { found = null; if (gridPreview) { gridPreview = null; drawGrid(); } });
      const fromRun = () => {
        const n = +count.value;
        if (picks.length === 2 && n > 0) px.value = String(+(Math.hypot(picks[1].x - picks[0].x, picks[1].y - picks[0].y) / n).toPrecision(6));
      };
      count.addEventListener('input', fromRun);
      function show(w) {
        way = w; picks = []; drawPicks();
        way1.setAttribute('aria-pressed', String(w === 'points')); way2.setAttribute('aria-pressed', String(w === 'grid'));
        body.replaceChildren(...(w === 'points' ? [
          el('p', { class: 'small' }, 'Click two places you know the distance between.'),
          el('div', { class: 'row' }, field('How far apart are they?', apart), field('Unit', unit))
        ] : [
          el('div', { class: 'row' }, field('Shape', shape, null, 'A hex\'s size is from its centre to the next one\'s, flat side to flat side'),
            el('label', { class: 'check' }, shown, ' Show the grid to everyone')),
          el('div', { class: 'row' }, field('One square is', per), field('Unit', perUnit), field('Pixels per square', px, hint ? `The file name says ${Math.round(hint.grid_px * 100) / 100} px` : ''), findBtn,
            btn(`Roll20 (${G.ROLL20.grid_px} px = ${G.ROLL20.per_square} ft)`, () => { px.value = String(G.ROLL20.grid_px); per.value = String(G.ROLL20.per_square); perUnit.value = G.ROLL20.unit; }, 'small')),
          el('p', { class: 'small' }, 'Or click the corners of a run of squares, then say how many squares that is.'),
          el('div', { class: 'row' }, field('How many squares is that?', count))
        ].filter(Boolean)));
      }
      const save = async () => {
        let patch;
        try {
          if (way === 'points') {
            if (picks.length < 2) throw new Error('Click two places on the map first');
            patch = { ...G.scaleFromPoints(picks[0], picks[1], +apart.value, unit.value), grid_px: null, grid_offset_x: null, grid_offset_y: null };
          } else {
            fromRun();
            if (!(+px.value > 0)) throw new Error('Type how many pixels one square is');
            if (!(+per.value > 0)) throw new Error('Type how far one square is');
            patch = G.scaleFromGrid(+px.value, +per.value, perUnit.value);
            Object.assign(patch, { grid_type: shape.value, grid_shown: shown.checked });
            if (found && !picks.length) { patch.grid_offset_x = found.offset_x; patch.grid_offset_y = found.offset_y; }
            if (picks.length) { offset = { x: ((picks[0].x % patch.grid_px) + patch.grid_px) % patch.grid_px, y: ((picks[0].y % patch.grid_px) + patch.grid_px) % patch.grid_px }; patch.grid_offset_x = offset.x; patch.grid_offset_y = offset.y; }
          }
          map = (await post('map_save', { id: map.id, ...patch }, cid)).map;
        } catch (err) { return toast(err.message, true); }
        toast('Scale saved'); closePanel(); lf.scale.update(); drawGrid(); ctx.reloadCampaign().catch(() => {});
      };
      panel = el('div', { class: 'map-panel card', role: 'dialog', 'aria-label': 'Set the scale' },
        el('div', { class: 'row' }, el('strong', {}, 'Set the scale'), way1, way2), body,
        el('div', { class: 'row' }, el('button', { class: 'primary', type: 'button', onclick: save }, 'Save scale'), btn('Cancel', closePanel)));
      panelBox.replaceChildren(panel);
      show(way);
      syncTools();
      fitPicture();
      if (!hasGrid && !hint) find(true);   // a map with no grid yet: look for one without being asked
    }

    // ---- pins
    let pinLayer = null, routeLayer = null;
    const pinMarkers = new Map();
    const mine = p => gm || (p.kind === 'note' && p.created_by === S.user.id);
    const entryNamed = name => S.encyclopedia.find(e => [e.name, ...(e.aliases || [])].some(n => G.nameKey(n) === G.nameKey(name))) || null;   // nameKey ignores case, accents and a leading "The"
    const pinTitle = p => (p.kind === 'entry' && p.entry ? p.entry.name : p.kind === 'event' && p.event ? p.event.title : p.label) || 'Pin';
    const kindIcon = p => p.kind === 'entry' ? (ctx.encCat(p.entry?.category)?.[2] || '📌') : p.kind === 'event' ? '📅' : '📝';
    const pinIcon = p => p.icon || kindIcon(p);
    // Routes and locations hidden from the picture: the viewer's own choice, kept on this device for this map. The lists still show them.
    function hiddenIds() { try { return new Set(JSON.parse(localStorage.getItem(`chronicle-map-hidden-${map.id}`) || '[]')); } catch { return new Set(); } }
    function setHidden(id, hide) {
      const ids = hiddenIds();
      if (hide) ids.add(id); else ids.delete(id);
      try { localStorage.setItem(`chronicle-map-hidden-${map.id}`, JSON.stringify([...ids])); } catch { /* hidden for this visit only */ }
      drawPins(); drawRoutes(); renderRoutes();
    }
    /** A group's tick in the side panel: off hides every row of the group, on shows them all; part shown is "mixed". */
    function groupTick(title, ids, hid) {
      const shown = ids.filter(i => !hid.has(i)).length;
      const box = el('input', { type: 'checkbox', checked: shown === ids.length, 'aria-label': `Show all ${title.toLowerCase()}` });
      box.indeterminate = shown > 0 && shown < ids.length;
      box.addEventListener('click', e => e.stopPropagation());   // ticking it doesn't fold the group
      box.addEventListener('change', () => {
        const now = hiddenIds();
        for (const i of ids) { if (box.checked) now.delete(i); else now.add(i); }
        try { localStorage.setItem(`chronicle-map-hidden-${map.id}`, JSON.stringify([...now])); } catch { /* hidden for this visit only */ }
        drawPins(); drawRoutes(); renderRoutes();
      });
      return el('label', { class: 'map-show', 'data-tip': `Show or hide all the ${title.toLowerCase()} on the map` }, box);
    }
    /** The "show on the map" tick of a route or location in the side panel: id is 'r' + route id or 'p' + pin id. */
    function showTick(id, name, hid) {
      const box = el('input', { type: 'checkbox', checked: !hid.has(id), 'aria-label': `Show ${name} on the map` });
      box.addEventListener('change', () => setHidden(id, !box.checked));
      return el('label', { class: 'map-show', 'data-tip': 'Show this on the map' }, box);
    }
    function drawPins() {
      pinLayer.clearLayers(); pinMarkers.clear();
      const hid = hiddenIds();
      for (const p of pins) if (!hid.has('p' + p.id)) pinMarkers.set(p.id, MapsTab.marker(pinLayer, { x: p.x, y: p.y, icon: pinIcon(p), label: pinTitle(p), color: p.color,
        className: 'map-pin' + (p.is_secret ? ' secret' : '') + (p.is_locked ? ' locked' : ''),
        draggable: mine(p) && !p.is_locked, onMove: async xy => { Object.assign(p, (await post('pin_save', { id: p.id, x: xy.x, y: xy.y }, cid)).pin); }, onOpen: () => pinCard(p), pad: cardPad,
        onPick: () => pickAt(p) }));
    }
    /** Centre the map on pin p and open its card. */
    const showPin = p => { if (hiddenIds().has('p' + p.id)) setHidden('p' + p.id, false); const m = pinMarkers.get(p.id); if (!m || !lf) return; lf.map.setView(toLatLng(p.x, p.y), Math.max(lf.map.getZoom(), 0)); m.openPopup(); };
    /** After a change: this map's pins and routes again, and the campaign's index of which entries and events are pinned where. */
    async function refresh() {
      const [d] = await Promise.all([api('map', { query: { cid, id } }), ctx.reloadCampaign().catch(() => {})]);
      map = d.map; pins = d.pins || []; routes = d.routes || []; here = d.groups || []; trail = d.trail || [];
      await loadGroups().catch(() => {});
      if (gone) return;
      lmap_close();   // a card open on a marker about to be redrawn would outlive it
      drawPins(); drawRoutes(); renderRoutes(); drawGroups();
      meta.textContent = metaText();
    }
    // ---- the party's groups: a flag, or the group's token, with its name
    let groupLayer = null, trailLayer = null;
    // The party's trail: a dotted line through where each group was put, shift by shift, a dot at each with when it was.
    // Shown unless hidden from the legend, which this browser remembers.
    const TRAIL_KEY = 'chronicle:maptrail';
    let trailShown = (() => { try { return localStorage.getItem(TRAIL_KEY) !== 'off'; } catch { return true; } })();
    const drawTrail = () => {
      trailLayer.clearLayers();
      if (!trailShown) return;
      const byGroup = new Map();
      for (const t of trail) byGroup.set(t.group_id, [...(byGroup.get(t.group_id) || []), t]);
      for (const [gid, pts] of byGroup) {
        const g = (gm ? groups : here).find(q => q.id === gid) || groups.find(q => q.id === gid);
        const name = g?.name || 'The party';
        // where the group stands now is the trail's last point, so the line runs on to the flag
        const at = pts.map(t => toLatLng(t.x, t.y));
        if (g && g.map_id === map.id && g.x !== null && (pts.at(-1).x !== g.x || pts.at(-1).y !== g.y)) at.push(toLatLng(g.x, g.y));
        if (at.length > 1) L.polyline(at, { weight: 3, dashArray: '2 7', lineCap: 'round', interactive: false, className: 'map-trail-line' }).addTo(trailLayer);
        pts.forEach((t, i) => L.circleMarker(toLatLng(t.x, t.y), { radius: i === pts.length - 1 ? 5 : 4, weight: 2, className: 'map-trail-dot' })
          .bindTooltip(el('span', {}, `${name}: ${ctx.fmtShift(t.abs_shift)}`), { className: 'map-tip' }).addTo(trailLayer));
      }
    };
    const clearTrail = async g => {
      if (!await ctx.confirmDialog(`Clear ${g.name}'s trail on this map? Where it stands now stays.`, { ok: 'Clear trail', danger: true })) return;
      try { await post('trail_clear', { map_id: map.id, id: g.id }, cid); lmap_close(); await refresh(); toast('Trail cleared'); }
      catch (err) { toast(err.message, true); }
    };
    const drawGroups = () => {
      groupLayer.clearLayers();
      drawTrail();
      for (const g of (gm ? groups : here).filter(q => q.map_id === map.id && q.x !== null)) {
        MapsTab.marker(groupLayer, { x: g.x, y: g.y, icon: '🚩', image: g.token_url, label: g.name, className: 'map-party', sizePx: g.token_url ? 40 : 28, pad: cardPad, onPick: () => pickAt(g),
          draggable: gm, onMove: async xy => { await post('group_move', { id: g.id, map_id: map.id, x: xy.x, y: xy.y }, cid); Object.assign(g, { x: xy.x, y: xy.y }); offerLog(g, xy); },
          onOpen: () => el('div', { class: 'map-pin-card' }, el('strong', {}, g.name), g.is_main ? el('small', { class: 'muted' }, 'The main group') : null,
            el('small', {}, partyNames(g).join(', ') || 'No one yet'),
            gm ? el('div', { class: 'row' }, btn('New location here', () => { lmap_close(); pinForm(null, { x: g.x, y: g.y }); }, 'small',
              'Pin a place where the party is now, as a new Encyclopedia entry or a note'),
              trail.some(t => t.group_id === g.id) ? btn('Clear trail', () => clearTrail(g), 'small', 'Forget where this group has been on this map, leaving where it stands now') : null) : null) });
      }
    };
    /** The main group was moved on this map: offer, under the toolbar, to write it on the clock's shift ("Moved to Tarsk",
     * by the pin nearest where it now stands). Nothing is written unless Log it is pressed. */
    function offerLog(g, at) {
      if (!gm || !g?.is_main || !ctx.logOnShift) return;
      const pin = G.nearestPin(pins, at, reach());
      const text = pin ? `Moved to ${G.pinName(pin)}` : `Moved on ${map.name}`;
      const go = btn('Log it', async () => {
        try { await ctx.logOnShift(text); note.textContent = ''; toast(`Logged on ${ctx.fmtShift(ctx.nowShift())}`); }
        catch (err) { toast(err.message, true); }
      }, 'small', `Add "${text}" to what the party does this ${ctx.slotWord()}`);
      note.replaceChildren(`${g.name} moved. Log "${text}" on ${ctx.fmtShift(ctx.nowShift())}? `, go, ' ',
        Object.assign(btn('✕', () => { note.textContent = ''; }, 'link small', 'Don\'t log it'), { ariaLabel: 'Don\'t log it' }));
    }
    const memberName = uid => { const m = S.members.find(x => Number(x.id) === uid); return m ? m.character_name || m.display_name : 'Someone'; };
    /** Who is in group g: its players, then the characters with no player who travel with it. */
    const partyNames = g => [...g.members.map(memberName), ...(g.characters || []).map(c => (c.kind === 'npc' ? `${c.name} (NPC)` : c.name))];
    /** GMs: move a group to this pin. With more than one group, a small select asks which. */
    function partyHere(p) {
      if (!gm || !groups.length) return null;
      const which = groups.length > 1 ? select(groups.map(g => [g.id, g.name]), groups[0].id, { 'aria-label': 'Which group' }) : null;
      return el('span', { class: 'mpc-party' }, which, btn('Party is here', async () => {
        const g = groups.find(q => q.id === Number(which ? which.value : groups[0].id));
        try {
          await post('group_move', { id: g.id, map_id: map.id, x: p.x, y: p.y }, cid);
          lmap_close(); await refresh(); toast(`${g.name} is at ${pinTitle(p)}`); offerLog(g, p);
        } catch (err) { toast(err.message, true); }
      }, 'small', 'Put a group of the party here, with its marker'));
    }
    async function toEntry(p, entryId) {
      try {
        const r = await post('pin_to_entry', entryId ? { id: p.id, entry_id: entryId } : { id: p.id }, cid);
        await refresh();
        const e = S.encyclopedia.find(x => x.id === r.entry_id);
        toast(r.created ? `Added "${e?.name || p.label}" to the Encyclopedia`
          : `Linked to "${e?.name || 'the entry'}"${e?.is_secret ? '. It is GM only, so players won\'t see the pin until the entry is shown to them' : ''}`);
        // a new entry takes the note's text, so it goes through the Feature Highlighter as an entry save does
        if (r.created && (p.note || '').trim()) ctx.offerNouns([{ text: p.note, label: `the note on the pin "${p.label}"` }]).catch(() => {});
      } catch (err) { toast(err.message, true); }
    }
    /** How far pin p is from the party's marker on this map, said in the map's units, or null (no scale, or the party isn't here). */
    function fromParty(p) {
      const g = here.find(q => q.map_id === map.id && q.x !== null && q.y !== null);
      if (!g || !hasScale() || (g.x === p.x && g.y === p.y)) return null;
      const m = G.toMetres(Math.hypot(g.x - p.x, g.y - p.y), map);
      return m === null ? null : `${G.fmtDistance(m, system(), G.isSpace(map))} from ${g.name}`;
    }
    function pinCard(p) {
      const kindName = p.kind === 'entry' ? ctx.encCat(p.entry?.category)?.[1] || 'Entry' : p.kind === 'event' ? 'Event' : 'Note';
      const name = p.kind === 'entry' && p.entry ? el('a', { href: `#/c/${cid}/encyclopedia/${p.entry.id}`, 'data-tip': 'Open this entry' }, pinTitle(p)) : el('span', {}, pinTitle(p));
      const sub = [kindName, p.is_secret ? '🔒 GM only' : null, p.is_locked ? 'Locked in place' : null].filter(Boolean).join(' · ');
      const match = gm && p.kind === 'note' ? entryNamed(p.label) : null;
      const dist = fromParty(p);
      const facts = [dist ? el('span', {}, dist) : null,
        p.kind === 'event' && p.event ? el('a', { href: `#/c/${cid}/day/${p.event.abs_day}`, 'data-tip': 'Open this day' }, ctx.fmtDay(p.event.abs_day)) : null,
        p.child_map ? el('a', { class: 'map-pin-opens', href: `#/c/${cid}/maps/${p.child_map.id}`, 'data-tip': 'Open the map inside this place' }, `🗺️ Open ${p.child_map.name}`) : null].filter(Boolean);
      const acts = [partyHere(p),
        gm && p.kind === 'note' ? (match
          ? btn(`Link to ${match.name}`, () => toEntry(p, match.id), '', 'Pin this to the entry that already has this name, without making another')
          : btn('Add to Encyclopedia', () => toEntry(p), '', 'Make an Encyclopedia entry of this pin\'s label and note, and keep the pin where it is')) : null,
        mine(p) ? btn('Edit', () => { lmap_close(); pinForm(p, p); }) : null,
        mine(p) ? btn(p.is_locked ? 'Unlock' : 'Lock', async () => {
          try { await post('pin_save', { id: p.id, is_locked: !p.is_locked }, cid); lmap_close(); await refresh(); toast(p.is_locked ? 'Pin unlocked' : 'Pin locked in place'); }
          catch (err) { toast(err.message, true); }
        }, '', p.is_locked ? 'Let this pin be dragged again' : 'Stop this pin being dragged by accident') : null,
        mine(p) ? btn('Delete', async () => {
          if (!await ctx.confirmDialog(`Delete the pin "${pinTitle(p)}"?`, { ok: 'Delete', danger: true })) return;
          try { await post('pin_delete', { id: p.id }, cid); await refresh(); toast('Pin deleted'); } catch (err) { toast(err.message, true); }
        }, 'danger') : null].filter(Boolean);
      return el('div', { class: 'map-pin-card' },
        el('div', { class: 'mpc-head' }, el('span', { class: 'mpc-glyph', 'aria-hidden': 'true' }, el('span', {}, pinIcon(p))),
          el('div', { class: 'mpc-title' }, el('strong', {}, name), el('span', { class: 'mpc-sub' }, sub))),
        p.kind === 'entry' && p.entry?.first_line ? el('p', { class: 'mpc-text' }, p.entry.first_line) : null,
        p.kind === 'note' && p.note ? el('p', { class: 'mpc-text pre' }, p.note) : null,
        facts.length ? el('div', { class: 'mpc-facts' }, facts) : null,
        acts.length ? el('div', { class: 'mpc-actions' }, acts) : null);
    }
    const lmap_close = () => lf?.map.closePopup();

    /** The pin form, in the panel above the map: a new pin at xy, or pin `old` being changed. */
    function pinForm(old, xy) {
      closePanel();
      let kind = old?.kind || (gm ? 'entry' : 'note'), entry = old?.entry ? { id: old.entry.id, name: old.entry.name } : null, event = old?.event ? { id: old.event.id, title: old.event.title } : null;
      let events = null, working = false;
      const label = el('input', { maxlength: 150, autocomplete: 'off', value: old?.kind === 'note' ? old.label : '' });
      const noteIn = el('textarea', { rows: 2, maxlength: 1000, placeholder: 'A short note, if you like' }, old?.kind === 'note' ? old.note || '' : '');
      const qEntry = el('input', { autocomplete: 'off', value: entry?.name || '', placeholder: 'Search by name, or type a new one' });
      const qEvent = el('input', { autocomplete: 'off', value: event?.title || '', placeholder: 'Search by title, or type a new one' });
      const secret = el('input', { type: 'checkbox', checked: !!old?.is_secret });
      const entryList = el('div', { class: 'map-pick-list' }), eventList = el('div', { class: 'map-pick-list' });
      const pick = (on, text, onclick) => el('button', { type: 'button', class: 'map-pick' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick }, text);
      const drawEntries = () => {
        const k = qEntry.value.trim().toLowerCase();
        const found = S.encyclopedia.filter(e => !k || [e.name, ...(e.aliases || [])].some(n => n.toLowerCase().includes(k))).slice(0, 8);
        entryList.replaceChildren(...(found.length ? found.map(e => pick(entry?.id === e.id, e.is_secret ? `🔒 ${e.name} (GM only)` : e.name, () => { entry = e; qEntry.value = e.name; drawEntries(); }))
          : [el('small', { class: 'muted' }, 'No entry has that name yet')]));
      };
      const drawEvents = () => {
        if (!events) return eventList.replaceChildren(el('small', { class: 'muted' }, 'Looking…'));
        const k = qEvent.value.trim().toLowerCase();
        const found = events.filter(e => !k || e.title.toLowerCase().includes(k)).sort((a, b) => b.abs_day - a.abs_day).slice(0, 8);
        eventList.replaceChildren(...(found.length ? found.map(e => pick(event?.id === e.id, `${ctx.fmtDay(Number(e.abs_day))} · ${e.is_secret ? '🔒 ' : ''}${e.title}`, () => { event = e; qEvent.value = e.title; drawEvents(); }))
          : [el('small', { class: 'muted' }, 'No event has that title yet')]));
      };
      qEntry.addEventListener('input', () => { if (entry && qEntry.value !== entry.name) entry = null; drawEntries(); });
      qEvent.addEventListener('input', () => { if (event && qEvent.value !== event.title) event = null; drawEvents(); });
      const kinds = [['entry', 'Encyclopedia entry'], ['note', 'Note'], ['event', 'Event']];
      // its icon (none: the kind's own) and colour, once the database has them
      let icon = old?.icon || null, colour = old?.color || null;
      const iconBox = el('div', { class: 'map-icon-pick', role: 'group', 'aria-label': 'Icon' });
      const colourBox = el('div', { class: 'map-colour-pick', role: 'group', 'aria-label': 'Colour' });
      const drawStyle = () => {
        const fake = { kind, entry: entry ? { category: S.encyclopedia.find(e => e.id === entry.id)?.category || (entry.blank ? 'location' : null) } : null };
        const opt = (v, face, name, on) => el('button', { type: 'button', class: 'map-icon-opt' + (on ? ' on' : ''), 'aria-pressed': String(on), 'aria-label': name, 'data-tip': name,
          onclick: () => { icon = v; drawStyle(); } }, face);
        iconBox.replaceChildren(opt(null, kindIcon(fake), 'The kind\'s own icon', !icon), ...PIN_ICONS.map(([e, name]) => opt(e, e, name, icon === e)));
        const sw = (v, name) => {
          const on = (colour || null) === v;
          const b = el('button', { type: 'button', class: 'map-swatch' + (v ? '' : ' none') + (on ? ' on' : ''), 'aria-pressed': String(on), 'aria-label': name, 'data-tip': name,
            onclick: () => { colour = v; drawStyle(); } }, v ? '' : '∅');
          if (v) b.style.setProperty('--swatch', v);
          return b;
        };
        colourBox.replaceChildren(sw(null, 'No colour'), ...COLOURS.map(([v, name]) => sw(v, name)));
      };
      // not field(): its <label> would pass a click on one of these buttons to the first of them once the click has
      // redrawn the buttons (older Chrome does), putting the choice straight back
      // GMs: the map this pin opens (a town pin opens the town's map); the list comes once the form is open
      let child = old?.child_map ? old.child_map.id : null;
      const childSel = el('select', { 'aria-label': 'Opens map' }, el('option', { value: '' }, 'No map'));
      if (gm) api('maps', { query: { cid } }).then(r => {
        childSel.replaceChildren(el('option', { value: '' }, 'No map'), ...r.maps.filter(m => m.id !== map.id).map(m => el('option', { value: String(m.id) }, (m.is_secret ? '🔒 ' : '') + m.name)));
        childSel.value = child === null ? '' : String(child);
      }).catch(() => {});
      childSel.addEventListener('change', () => { child = childSel.value ? Number(childSel.value) : null; });
      const group = (name, box) => el('div', { class: 'field' }, el('span', { class: 'lbl', 'aria-hidden': 'true' }, name), box);
      const styleFields = el('details', { class: 'map-style-fold' }, el('summary', {}, 'Icon and colour'), group('Icon', iconBox), group('Colour', colourBox));
      const kindBtns = kinds.map(([k, l]) => btn(l, () => { kind = k; show(); }, '', k === 'note' ? 'A label and a note' : k === 'entry' ? 'Pin an Encyclopedia entry' : 'Pin an event'));
      const body = el('div', { class: 'map-form-body' });
      const warn = (name, what) => toast(`"${name}" is GM only, so players won't see this pin until the ${what} is shown to them`);
      const save = async () => {
        if (working) return;
        const b = { map_id: map.id, x: xy.x, y: xy.y };
        if (old) b.id = old.id;
        if (gm) { b.kind = kind; b.is_secret = secret.checked; b.child_map_id = child; }
        b.icon = icon; b.color = colour;
        let hidden = null;
        if (kind === 'note') {
          if (!label.value.trim()) return toast('Give the pin a label', true);
          b.label = label.value.trim(); b.note = noteIn.value;
        } else if (kind === 'entry') {
          entry = entry || entryNamed(qEntry.value);
          if (!entry) return toast('Pick an entry, or press New entry here', true);
          b.entry_id = entry.id; b.label = ''; b.note = '';
          if (S.encyclopedia.find(e => e.id === entry.id)?.is_secret) hidden = [entry.name, 'entry'];
        } else {
          if (!event) return toast('Pick an event, or press New event here', true);
          b.event_id = event.id; b.label = ''; b.note = '';
          if (event.is_secret) hidden = [event.title, 'event'];
        }
        working = true;
        try {
          await post('pin_save', b, cid);
          closePanel(); await refresh();
          if (hidden) warn(...hidden);
        } catch (err) { toast(err.message, true); } finally { working = false; }
      };
      let creating = false;   // a double click must not make two entries or events
      const newEntry = async () => {
        const name = qEntry.value.trim();
        if (!name) return toast('Type the new entry\'s name first', true);
        if (creating || working) return;
        creating = true;
        try {
          let found = entryNamed(name);   // no second entry of a name that is already one, nor on a retry after a failed pin
          if (!found) {
            const id = (await post('entry_save', { name, category: 'location' }, cid)).id;
            found = { id, name, aliases: [], is_secret: false, blank: true, preview: '' };
            S.encyclopedia = [...S.encyclopedia, found];
          }
          entry = found;
          await save();
        } catch (err) { toast(err.message, true); } finally { creating = false; }
      };
      const newEvent = async () => {
        const t = qEvent.value.trim();
        if (!t) return toast('Type the new event\'s title first', true);
        if (creating || working) return;
        creating = true;
        try {
          if (!event || event.title !== t) event = { id: (await post('event_save', { abs_day: ctx.today(), title: t, shift: null }, cid)).id, title: t };   // kept for a retry
          await save();
        } catch (err) { toast(err.message, true); } finally { creating = false; }
      };
      function show() {
        kinds.forEach(([k], i) => kindBtns[i].setAttribute('aria-pressed', String(k === kind)));
        if (kind === 'event' && !events) api('events', { query: { cid } }).then(r => { events = r.events || []; drawEvents(); }).catch(err => toast(err.message, true));
        body.replaceChildren(...(kind === 'note' ? [field('Label', label), field('Note', noteIn)]
          : kind === 'entry' ? [field('Entry name', qEntry), entryList, el('div', { class: 'row' }, btn('New entry here', newEntry, 'small', 'Add an Encyclopedia entry of this name (a Location) and pin it'))]
          : [field('Event title', qEvent), eventList, el('div', { class: 'row' }, btn('New event here', newEvent, 'small', 'Add an all-day event of this title on the campaign\'s current day, and pin it'))]));
        if (kind === 'entry') drawEntries(); else if (kind === 'event') drawEvents();
        drawStyle();
      }
      const form = el('form', { class: 'map-panel card', role: 'dialog', 'aria-label': old ? 'Edit pin' : 'Add pin' },
        el('div', { class: 'row' }, el('strong', {}, old ? 'Edit pin' : 'Add pin'), gm ? el('span', { class: 'row map-kinds', role: 'group', 'aria-label': 'Kind of pin' }, kindBtns) : null),
        body, styleFields,
        old && old.author ? el('p', { class: 'small muted' }, `Added by ${old.author}`) : null,
        gm ? field('Opens map', childSel, 'Clicking this pin offers a link to that map') : null,
        gm ? lockBox(secret, 'players won\'t see this pin') : null,
        el('div', { class: 'row map-panel-actions' }, el('button', { class: 'primary', type: 'submit' }, old ? 'Save pin' : 'Add pin'), btn('Cancel', closePanel)));
      form.addEventListener('submit', ev => { ev.preventDefault(); save(); });
      panelBox.replaceChildren(form);
      panel = form;
      show();
      (kind === 'note' ? label : kind === 'entry' ? qEntry : qEvent).focus();
    }

    // ---- routes
    const lengthOf = r => {
      const m = G.toMetres(G.pathPx(r.points.map(([x, y]) => ({ x, y }))), map);
      return m === null ? 'no scale yet' : G.fmtDistance(m, system(), G.isSpace(map));
    };
    const routeLines = new Map();
    function drawRoutes() {
      routeLayer.clearLayers(); routeLines.clear();
      const hid = hiddenIds();
      for (const r of routes) {
        if (hid.has('r' + r.id)) continue;
        const at = r.points.map(([x, y]) => toLatLng(x, y));
        const [, dash, round] = DASHES[r.dash] || DASHES.dashed;
        const line = L.polyline(at, { weight: 3, dashArray: dash, lineCap: round ? 'round' : 'butt', interactive: false,
          ...(r.color ? { color: r.color } : {}), className: 'map-route-line' + (r.color ? ' coloured' : '') + (r.is_secret ? ' secret' : '') }).addTo(routeLayer);
        // a thin dashed line is hard to hit with a finger (and a tap between dashes misses it), so an unseen wide one takes the taps
        L.polyline(at, { weight: 18, opacity: 0, className: 'map-route-hit' }).bindTooltip(el('span', {}, r.name), { sticky: true, className: 'map-tip' }).addTo(routeLayer);
        routeLines.set(r.id, line);
      }
    }
    const reach = () => Math.max(map.width || 0, map.height || 0) * 0.03 + 10;   // a pin this close to a route's end is where it starts or stops
    const endPin = pt => G.nearestPin(pins, { x: pt[0], y: pt[1] }, reach());
    /** The route dialog: its name, colour and line, and (once saved, with pins on the map) the pins it starts and ends at.
     * `r` is the route being changed, or a new one { points }; `secret` a boolean asks GM only too. Resolves the changes, or null. */
    const TERRAINS = [[1, 'Road or open ground ×1'], [2, 'Woods, hills or ruins ×2'], [3, 'Mountains ×3'], [4, 'Swamp ×4']];
    /** The terrain of each leg of route r, which Plan this trip takes into the travel time. */
    function terrainDialog(r) {
      const d = el('dialog', { class: 'kit-dialog map-route-dialog', 'aria-label': 'Terrain of the route' });
      const legs = r.points.slice(1).map((pt, i) => {
        const a = r.points[i], from = endPin(a), to = endPin(pt);
        const sel = select(TERRAINS, (r.terrain && r.terrain[i]) || 1, { 'aria-label': `Terrain of leg ${i + 1}` });
        return { sel, row: el('div', { class: 'row map-leg' }, el('span', { class: 'map-leg-name' }, `${i + 1}. ${from ? pinTitle(from) : 'Point ' + (i + 1)} → ${to ? pinTitle(to) : 'Point ' + (i + 2)}`,
          el('span', { class: 'small muted' }, ' ' + lengthOf({ points: [a, pt] }))), sel) };
      });
      const form = el('form', {}, el('h3', {}, `Terrain along ${r.name}`),
        el('p', { class: 'small muted' }, 'Slow going multiplies the travel time of that leg. Plan this trip averages the legs by their length.'),
        el('div', { class: 'map-legs' }, legs.map(l => l.row)),
        el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Save terrain'), btn('Cancel', () => d.close())));
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        try { await post('route_save', { id: r.id, terrain: legs.map(l => Number(l.sel.value)) }, cid); d.close(); await refresh(); toast('Terrain saved'); } catch (err) { toast(err.message, true); }
      });
      d.addEventListener('close', () => d.remove());
      d.append(form); document.body.append(d); d.showModal();
    }
    function routeDialog(title, r, secret, ok) {
      return new Promise(resolve => {
        const d = el('dialog', { class: 'kit-dialog map-route-dialog', 'aria-label': title });
        const nameIn = el('input', { value: r.name || '', maxlength: 150, required: true, 'aria-label': 'Route name', autocomplete: 'off' });
        const box = typeof secret === 'boolean' ? el('input', { type: 'checkbox', checked: secret }) : null;
        const colour = select([['', 'The usual green'], ...COLOURS], r.color || '', { 'aria-label': 'Route colour' });
        const dash = select(Object.entries(DASHES).map(([k, [l]]) => [k, l]), r.dash || 'dashed', { 'aria-label': 'Line' });
        const named = [...pins].sort((a, b) => pinTitle(a).localeCompare(pinTitle(b)));
        const pinSel = (label, pt) => select([['', '— none —'], ...named.map(p => [String(p.id), `${pinIcon(p)} ${pinTitle(p)}`])], String(pt ? endPin(pt)?.id || '' : ''), { 'aria-label': label });
        const from = pinSel('Starts at', r.points[0]), to = pinSel('Ends at', r.points[r.points.length - 1]);
        const was = [from.value, to.value];
        let out = null;
        const form = el('form', {}, el('h3', {}, title), field('Route name', nameIn),
          el('div', { class: 'row' }, field('Colour', colour), field('Line', dash)),
          named.length ? el('div', { class: 'row' }, field('Starts at', from, null, 'A pin on this map: the route is drawn on to it, and the Travel tab starts the trip there'),
            field('Ends at', to, null, 'A pin on this map: the route is drawn on to it, and the Travel tab ends the trip there')) : null,
          box ? lockBox(box, 'players never see a GM only route') : null,
          el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, ok), btn('Cancel', () => d.close())));
        form.addEventListener('submit', ev => {
          ev.preventDefault();
          if (!nameIn.value.trim()) return;
          // a new start or end pin: the route's end moves onto it, or is drawn on to it when it is further off
          let points = r.points.map(p => [...p]);
          const snap = (sel, at, i) => {
            if (sel.value === at) return;
            const p = pins.find(q => String(q.id) === sel.value);
            if (!p) return;
            const end = points[i === 0 ? 0 : points.length - 1];
            const near = Math.hypot(end[0] - p.x, end[1] - p.y) <= reach();
            if (near) end.splice(0, 2, p.x, p.y);
            else if (i === 0) points.unshift([p.x, p.y]); else points.push([p.x, p.y]);
          };
          snap(from, was[0], 0); snap(to, was[1], 1);
          out = { name: nameIn.value.trim(), secret: box ? box.checked : null, points, moved: JSON.stringify(points) !== JSON.stringify(r.points),
            color: colour.value || null, dash: dash.value === 'dashed' ? null : dash.value };
          d.close();
        });
        d.addEventListener('close', () => { d.remove(); resolve(out); });
        d.append(form); document.body.append(d); d.showModal();
      });
    }
    async function saveRoute() {
      if (pts.length < 2) return;
      const got = await routeDialog('Save route', { name: '', points: pts.map(p => [p.x, p.y]) }, false, 'Save route');
      if (!got) return;
      try {
        await post('route_save', { map_id: map.id, name: got.name, points: got.points, is_secret: got.secret, color: got.color, dash: got.dash }, cid);
        mode = null; pts = []; drawMeasure(); note.textContent = ''; syncTools();
        await refresh(); toast('Route saved');
      } catch (err) { toast(err.message, true); }
    }
    /** The drawer over the map's right edge: a search box, then Routes and Locations (every pin), each folding up. It
     * slides away to its tab, never changing the map's size. How it was left is remembered on this device. */
    const sideKey = `chronicle-map-side-${cid}`;
    // until it has been opened or closed on this device, the drawer starts open, except on a phone, where it would cover half the map
    const sideState = () => {
      let st = {};
      try { st = JSON.parse(localStorage.getItem(sideKey) || '{}') || {}; } catch { /* storage may be off */ }
      return 'collapsed' in st ? st : { ...st, collapsed: window.matchMedia('(max-width: 720px)').matches };
    };
    const keepSide = patch => { try { localStorage.setItem(sideKey, JSON.stringify({ ...sideState(), ...patch })); } catch { /* this visit only */ } };
    const fold = btn('', () => {
      if (sheetAway) { sheetAway = false; keepSide({ collapsed: false }); } else keepSide({ collapsed: !sideState().collapsed });
      syncDrawer();
    }, 'small map-side-fold');
    const sideList = el('div', { class: 'map-side-list' });
    const finder = el('input', { type: 'search', class: 'map-side-find', 'aria-label': 'Find on this map', placeholder: 'Find on this map', autocomplete: 'off' });
    /** Hide the rows whose name doesn't hold what is typed in the search box (matched as names are: case, accents, "The"). */
    const filterRows = () => {
      const q = G.nameKey(finder.value);
      routeBox.querySelectorAll('[data-name]').forEach(row => { row.hidden = !!q && !G.nameKey(row.dataset.name).includes(q); });
    };
    finder.addEventListener('input', filterRows);
    const sections = el('div', { class: 'map-side-secs' });
    sideList.append(finder, sections);
    routeBox.append(fold, sideList);
    /** A card opening keeps out from under the open drawer: from its side, or on a phone (a sheet along the bottom) its top. */
    const syncPad = () => {
      const open = stage.classList.contains('drawer-open'), sheet = window.matchMedia('(max-width: 720px)').matches;
      // the toolbar runs along the top, or on a phone along the bottom (over the sheet when it is open)
      cardPad.tl[1] = sheet ? 64 : toolbar.offsetTop + toolbar.offsetHeight + 8;
      cardPad.br[0] = open && !sheet ? 316 : 16;
      cardPad.br[1] = sheet ? (open ? Math.round(stage.clientHeight * 0.45) : 0) + 70 : 16;
    };
    function syncDrawer() {
      const shut = !!sideState().collapsed || sheetAway;
      routeBox.hidden = !routes.length && !pins.length;
      routeBox.className = 'map-routes surface-float ' + (shut ? 'closed' : 'open');
      stage.classList.toggle('drawer-open', !shut && !routeBox.hidden);
      syncPad();
      fold.textContent = shut ? '⟨' : '⟩';
      fold.dataset.tip = shut ? 'Show the routes and locations' : 'Slide the routes and locations away';
      fold.setAttribute('aria-label', shut ? 'Show routes and locations' : 'Hide routes and locations');
      fold.setAttribute('aria-expanded', String(!shut));
    }
    function renderRoutes() {
      const st = sideState();
      syncDrawer();
      const section = (key, title, kids, ids) => {
        const d = el('details', { class: 'map-side-sec', open: st[key] !== false },
          el('summary', {}, groupTick(title, ids, hid), el('h3', {}, title, el('span', { class: 'muted small' }, ` ${kids.length}`))), ...kids);
        d.addEventListener('toggle', () => keepSide({ [key]: d.open }));
        return d;
      };
      const hid = hiddenIds();
      const routeRows = routes.map(r => {
        const a = endPin(r.points[0]), z = endPin(r.points[r.points.length - 1]);
        const swatch = el('span', { class: 'map-route-swatch' + (r.color ? '' : ' plain') + ' ' + (r.dash || 'dashed'), 'aria-hidden': 'true' });
        if (r.color) swatch.style.setProperty('--swatch', r.color);
        return el('div', { class: 'map-route' + (r.is_secret ? ' secret' : ''), 'data-name': r.name },
          el('div', { class: 'map-route-top' }, showTick('r' + r.id, r.name, hid),
            el('button', { type: 'button', class: 'link map-route-name', 'data-tip': 'Show this route on the map', onclick: () => { if (hid.has('r' + r.id)) setHidden('r' + r.id, false); lf.map.fitBounds(routeLines.get(r.id).getBounds().pad(0.2)); } }, swatch, r.is_secret ? '🔒 ' : '', r.name)),
          a || z ? el('span', { class: 'small map-route-ends' }, a ? pinTitle(a) : '…', ' → ', z ? pinTitle(z) : '…') : null,
          el('span', { class: 'small muted map-route-len' }, lengthOf(r)),
          // Plan this trip and Edit stay out; the terrain, GM only and Delete wait in the shared ⋯ (KIT.menu)
          gm ? el('div', { class: 'row' },
            hasScale() ? btn('Plan this trip', () => { location.hash = tripLink(`route=${r.id}`); }, 'small', 'Work out the travel time along this route on the Travel tab') : null,
            btn('Edit', async () => {
              const got = await routeDialog('Edit the route', r, null, 'Save');
              if (!got) return;
              try {
                await post('route_save', { id: r.id, name: got.name, ...(got.moved ? { points: got.points } : {}), color: got.color, dash: got.dash }, cid);
                await refresh();
              } catch (err) { toast(err.message, true); }
            }, 'small', 'Its name, colour and line, and the pins it starts and ends at'),
            KIT.menu({ label: '⋯', ariaLabel: `More for ${r.name}`, tip: 'More: the terrain, GM only, delete', cls: 'more-menu', items: [
              btn('Terrain…', () => terrainDialog(r), 'small', r.terrain ? 'The terrain of each leg (set): it changes the travel time Plan this trip works out' : 'Slow going on some legs of the route, for the travel time Plan this trip works out'),
              (() => {
                // in the menu the lock gets its words, and a tick while it is on
                const b = btn([r.is_secret ? '🔒 ' : '🔓 ', 'GM only', r.is_secret ? ' ✓' : ''], async () => {
                  try { await post('route_save', { id: r.id, is_secret: !r.is_secret }, cid); await refresh(); } catch (err) { toast(err.message, true); }
                }, 'small', r.is_secret ? 'GM only: players never see this route. Press to show it to them' : 'Players see this route. Press to make it GM only');
                b.setAttribute('aria-label', 'GM only');
                b.setAttribute('aria-pressed', String(r.is_secret));
                return b;
              })(),
              el('hr'),
              btn('Delete', async () => {
                if (!await ctx.confirmDialog(`Delete the route "${r.name}"?`, { ok: 'Delete', danger: true })) return;
                try { await post('route_delete', { id: r.id }, cid); await refresh(); toast('Route deleted'); } catch (err) { toast(err.message, true); }
              }, 'small danger')] })) : null);
      });
      const placeRows = [...pins].sort((a, b) => pinTitle(a).localeCompare(pinTitle(b), undefined, { sensitivity: 'base' })).map(p => {
        const face = el('span', { class: 'map-place-icon' + (p.color ? ' has-colour tinted' : ''), 'aria-hidden': 'true', 'data-icon': p.color ? pinIcon(p) : null }, pinIcon(p));
        if (p.color) face.style.setProperty('--pin-colour', p.color);
        return el('div', { class: 'map-place-row', 'data-name': pinTitle(p) }, showTick('p' + p.id, pinTitle(p), hid),
          el('button', { type: 'button', class: 'map-place' + (p.is_secret ? ' secret' : ''), 'data-tip': 'Show this pin on the map', onclick: () => showPin(p) },
            face, el('span', {}, p.is_secret ? '🔒 ' : '', pinTitle(p)), p.is_locked ? el('span', { class: 'muted small' }, ' (locked)') : null));
      });
      sections.replaceChildren(...[routes.length ? section('routes', 'Routes', routeRows, routes.map(r => 'r' + r.id)) : null,
        pins.length ? section('places', 'Locations', placeRows, pins.map(p => 'p' + p.id)) : null].filter(Boolean));
      filterRows();
    }

    /** Measuring, a click on a pin or the party lays the next point exactly on it (so a route starts and ends there)
     * instead of opening its card. */
    function pickAt(at) {
      if (mode !== 'measure') return false;
      pts.push({ x: at.x, y: at.y }); drawMeasure();
      return true;
    }
    function onClick(ev) {
      const p = toXY(ev.latlng);
      if (mode === 'measure') { pts.push(p); drawMeasure(); }
      else if (mode === 'pin') {
        if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) { note.textContent = 'Click on the map\'s picture'; return; }
        mode = null; note.textContent = ''; syncTools(); pinForm(null, p);
      }
      else if (mode === 'label') {
        if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) { note.textContent = 'Click on the map\'s picture'; return; }
        labelAt(p);
      }
      else if (mode === 'party') {
        if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) { note.textContent = 'Click on the map\'s picture'; return; }
        const g = groups.find(q => q.id === Number(partyWhich.value)) || groups[0];
        mode = null; note.textContent = ''; syncTools();
        post('group_move', { id: g.id, map_id: map.id, x: p.x, y: p.y }, cid).then(() => refresh()).then(() => { toast(`${g.name} moved`); offerLog(g, p); }).catch(err => toast(err.message, true));
      }
      else if (mode === 'scale') { picks = picks.length >= 2 ? [p] : [...picks, p]; drawPicks(); if (picks.length === 2) panelBox.querySelector('input[aria-label="How many squares"]')?.dispatchEvent(new Event('input')); }
    }

    // ---- the toolbar
    const measureBtn = tbtn('📏', 'Route', 'Measure/Route', () => {
      if (mode === 'measure') { mode = null; pts = []; drawMeasure(); note.textContent = ''; return syncTools(); }
      if (!hasScale()) { note.textContent = gm ? 'Set the scale to measure' : 'The GM hasn\'t set this map\'s scale yet'; return; }
      if (mode === 'scale' || mode === 'pin' || mode === 'label') closePanel();
      mode = 'measure'; note.textContent = gm ? 'Click the map to lay down points, then Save route… to keep it' : 'Click the map to lay down points'; syncTools();
    }, gm ? 'Click along a path to add up its length, and keep it as a route (M)' : 'Click along a path to add up its length (M)');
    const addPinBtn = tbtn('📍', 'Pin', 'Add pin', () => {
      if (mode === 'pin') { closePanel(); note.textContent = ''; return; }
      if (mode === 'label') closePanel();
      if (mode === 'scale' || mode === 'measure') { if (mode === 'measure') { pts = []; drawMeasure(); } closePanel(); }
      panelBox.replaceChildren(); mode = 'pin'; note.textContent = 'Click the map to place the pin'; syncTools();
    }, 'Click the map to leave a pin there (P)');
    addPinBtn.hidden = !map.image_url;
    // Quick label (GMs): each click on the map asks for the name of the place there, and pins it as that Encyclopedia
    // entry (or a new Location), staying in this mode for the next one: a map's labels pinned by hand, fast.
    const labelBtn = gm ? tbtn('🏷', 'Label', 'Quick label', () => {
      if (mode === 'label') { closePanel(); note.textContent = ''; return; }
      if (mode === 'measure') { pts = []; drawMeasure(); }
      if (mode) closePanel();
      mode = 'label'; note.textContent = 'Click a place on the map, then type its name. Press Quick label again when you\'re done'; syncTools();
    }, 'Click each place on the map and type its name: each becomes a pin and an Encyclopedia location (L)') : null;
    if (labelBtn) labelBtn.hidden = !map.image_url;
    function labelAt(xy) {
      picks = [xy]; drawPicks();
      const name = el('input', { maxlength: 150, autocomplete: 'off', required: true, 'aria-label': 'Name of this place', placeholder: 'Name of this place' });
      const what = el('small', { class: 'muted' }, 'A new Location in the Encyclopedia');
      name.addEventListener('input', () => {
        const e = entryNamed(name.value);
        what.textContent = e ? `Pins the entry ${e.name}${e.is_secret ? ' (GM only)' : ''}` : 'A new Location in the Encyclopedia';
      });
      const go = el('button', { class: 'primary', type: 'submit' }, 'Pin it');
      const form = el('form', { class: 'map-label-form' }, name, go, btn('Skip', () => { picks = []; drawPicks(); panelBox.replaceChildren(); }), what);
      name.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); picks = []; drawPicks(); panelBox.replaceChildren(); } });
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const n = name.value.trim();
        if (!n || go.disabled) return;
        go.disabled = true;
        try {
          let e = entryNamed(n), made = false;
          if (!e) {
            const id = (await post('entry_save', { name: n, category: 'location' }, cid)).id;
            e = { id, name: n, aliases: [], is_secret: false, blank: true, preview: '' };
            S.encyclopedia = [...S.encyclopedia, e];
            made = true;
          }
          await post('pin_save', { map_id: map.id, x: xy.x, y: xy.y, kind: 'entry', entry_id: e.id, label: '', note: '' }, cid);
          picks = []; panelBox.replaceChildren();
          await refresh();
          drawPicks();
          note.textContent = `Pinned ${e.name}${made ? ' (a new Location)' : ''}. Click the next place, or press Quick label when you're done`;
        } catch (err) { toast(err.message, true); go.disabled = false; }
      });
      panelBox.replaceChildren(form);
      name.focus();
    }
    // GMs: put a group of the party anywhere on the map (a pin isn't needed), with a select when there is more than one group
    const partyWhich = select(groups.map(g => [g.id, g.name]), groups[0]?.id ?? '', { 'aria-label': 'Which group', class: 'small' });
    const partyBtn = gm ? tbtn('🚩', 'Party', 'Place party', () => {
      if (mode === 'party') { mode = null; note.textContent = ''; return syncTools(); }
      if (mode === 'measure') { pts = []; drawMeasure(); }
      if (mode) closePanel();
      if (!groups.length) { note.textContent = 'The party has no group yet: add players on the Members tab'; return; }
      mode = 'party'; note.textContent = 'Click the map where the party is'; syncTools();
    }, 'Put the party\'s marker anywhere on this map (T)') : null;
    if (partyBtn) partyBtn.hidden = !map.image_url;
    // Labels: on, every pin's name shows at every zoom; turned off, none do (a hover or the open card still names one);
    // until the button has been pressed on this device, names show close up only
    const labelsKey = `chronicle-map-labels-${cid}-${id}`;
    const labelsStored = () => { try { return localStorage.getItem(labelsKey); } catch { return null; } };
    let labelsSet = labelsStored();   // '1', '0' or null; kept here too, for a browser that won't store it
    const syncLabels = () => {
      stage.classList.toggle('labels-on', labelsSet === '1');
      stage.classList.toggle('labels-off', labelsSet === '0');
      labelsBtn.setAttribute('aria-pressed', String(labelsSet === '1'));
    };
    const labelsBtn = tbtn('🔤', 'Labels', 'Labels', () => {
      labelsSet = labelsSet === '1' ? '0' : '1';
      try { localStorage.setItem(labelsKey, labelsSet); } catch { /* this visit only */ }
      syncLabels();
    }, 'Show every pin\'s name, or none (just for you)');
    labelsBtn.hidden = !map.image_url;
    syncLabels();
    const saveRouteBtn = btn('Save route…', () => saveRoute(), 'small', 'Keep the path you measured as a named route on this map');
    saveRouteBtn.hidden = true;
    // Plan this trip: the Travel tab, with the path's length and the pins at its ends filled in
    const tripLink = query => `#/c/${cid}/travel?map=${map.id}&${query}`;
    const planBtn = btn('Plan this trip', () => { location.hash = tripLink('path=' + pts.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')); }, 'small',
      'Work out the travel time along this path on the Travel tab; Depart then moves the party\'s marker to its end');
    planBtn.hidden = true;
    const undoBtn = btn('Undo point', () => { pts.pop(); drawMeasure(); }, 'small');
    const clearBtn = btn('Clear', () => { pts = []; drawMeasure(); }, 'small');
    function syncTools() {
      const m = mode === 'measure';
      measureBtn.setAttribute('aria-pressed', String(m));
      addPinBtn.setAttribute('aria-pressed', String(mode === 'pin'));
      labelBtn?.setAttribute('aria-pressed', String(mode === 'label'));
      partyBtn?.setAttribute('aria-pressed', String(mode === 'party'));
      partyWhich.hidden = !(mode === 'party' && groups.length > 1);
      if (!groups.some(g => String(g.id) === partyWhich.value)) partyWhich.replaceChildren(...groups.map(g => el('option', { value: g.id }, g.name)));
      saveRouteBtn.hidden = !(gm && m && pts.length > 1);
      planBtn.hidden = !(gm && m && pts.length > 1 && hasScale());
      undoBtn.hidden = clearBtn.hidden = !m;
      total.hidden = !m;
      measureBar.hidden = !m;
      if (scaleBtn) { scaleBtn.setAttribute('aria-pressed', String(mode === 'scale')); scaleBtn.textContent = 'Set scale…' + scaleText(); }
      stage.classList.toggle('picking', !!mode);
      stage.classList.toggle('measuring', m);   // the measure bar takes the legend's place along the bottom
      // two quick taps while laying down points are two points, not a zoom
      lf?.map.doubleClickZoom[mode ? 'disable' : 'enable']();
      // on a phone the sheet would cover half of the map a tool is used on, so it folds away until the tool is put down
      if (mode !== toolMode) { toolMode = mode; sheetAway = !!mode && window.matchMedia('(max-width: 720px)').matches; syncDrawer(); }
    }
    const scaleBtn = gm ? btn('Set scale…', () => (mode === 'scale' ? closePanel() : openScale()), '', 'Tell the map how far apart things are') : null;
    scaleBtn?.setAttribute('aria-label', 'Scale');
    // the scale as the ⚙ menu shows it: "· 1 sq = 5 mi" (a grid) or "· 100 px = 2 mi"
    const scaleText = () => {
      if (!hasScale()) return '';
      const sq = map.grid_px > 0, d = G.fmtDistance(G.toMetres(sq ? map.grid_px : 100, map), system(), G.isSpace(map));
      return ` · ${sq ? '1 sq' : '100 px'} = ${d}`;
    };
    const rename = () => {
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'Rename the map' });
      const name = el('input', { value: map.name, maxlength: 150, required: true, 'aria-label': 'New name', autocomplete: 'off' });
      const form = el('form', {}, el('h3', {}, 'Rename the map'), field('Name', name),
        el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Save'), btn('Cancel', () => d.close())));
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        try { map = (await post('map_save', { id: map.id, name: name.value }, cid)).map; d.close(); title.textContent = map.name; ctx.reloadCampaign().catch(() => {}); } catch (err) { toast(err.message, true); }
      });
      d.addEventListener('close', () => d.remove());
      d.append(form); document.body.append(d); d.showModal();
    };
    /** Export…: the picture as uploaded, or the map as a Universal VTT file for another tabletop (it needs the grid). */
    const exportMap = () => {
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': 'Export the map' });
      const fileName = ext => `${map.name.replace(/[\\/:*?"<>|\s]+/g, ' ').trim() || 'map'}.${ext}`;
      const save = (blob, nameOf) => {
        const a = el('a', { href: URL.createObjectURL(blob), download: nameOf });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      };
      const picture = async () => {
        const res = await fetch(map.image_url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`The picture could not be fetched (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
      const asPicture = btn('Picture', async () => {
        try { const bytes = await picture(); save(new Blob([bytes], { type: VTT.pictureType(bytes) || 'application/octet-stream' }), fileName(EXT[VTT.pictureType(bytes)] || 'img')); d.close(); }
        catch (err) { toast(err.message, true); }
      }, '', 'The map\'s picture, as it was uploaded');
      const hasGrid = map.grid_px > 0;
      const asUvtt = btn('Universal VTT (.dd2vtt)', async () => {
        try { save(new Blob([VTT.toUvtt(map, await picture())], { type: 'application/json' }), fileName('dd2vtt')); d.close(); }
        catch (err) { toast(err.message, true); }
      }, '', 'The picture with its grid, for Foundry, Roll20, Owlbear Rodeo, MapTool or Fantasy Grounds. Pins and routes stay here');
      asUvtt.disabled = !hasGrid;
      // Foundry reads a scene's JSON with the pins as Notes; the picture is kept beside it, so it is named in the scene
      const asFoundry = btn('Foundry scene (.json)', async () => {
        try {
          const bytes = await picture(), ext = EXT[VTT.pictureType(bytes)] || 'img';
          save(new Blob([VTT.toFoundry(map, pins.map(p => ({ x: p.x, y: p.y, text: G.pinName(p) })), fileName(ext))], { type: 'application/json' }), fileName('json'));
          d.close(); toast(`Saved the scene. Export the picture too and keep it as ${fileName(ext)} beside it`);
        } catch (err) { toast(err.message, true); }
      }, '', 'The map as a Foundry scene with its pins as Notes (Import Data). Export the picture too: Foundry keeps it separate');
      d.append(el('h3', {}, `Export ${map.name}`),
        el('div', { class: 'row' }, asPicture, asUvtt, asFoundry),
        hasGrid ? el('p', { class: 'small muted' }, 'Pins and routes stay in Chronicle: Universal VTT has no place for them.')
          : el('p', { class: 'small' }, 'Set grid squares first (⚙ → Set scale… → Grid squares) to export a Universal VTT file.'),
        el('div', { class: 'kit-dialog-actions' }, btn('Close', () => d.close())));
      d.addEventListener('close', () => d.remove());
      document.body.append(d); d.showModal();
    };
    const exportBtn = gm && map.image_url ? btn('Export…', exportMap, '', 'Download the picture, or the map for another virtual tabletop') : null;
    const secretBtn = gm ? lockBtn(async () => {
      try {
        map = (await post('map_save', { id: map.id, is_secret: !map.is_secret }, cid)).map;
        secretBtn.setAttribute('aria-pressed', String(map.is_secret)); ctx.reloadCampaign().catch(() => {});
      } catch (err) { toast(err.message, true); }
    }, 'players never see a GM only map') : null;
    secretBtn?.setAttribute('aria-pressed', String(map.is_secret));
    const del = gm ? btn('Delete map', async () => {
      if (!await ctx.confirmDialog(`Delete the map "${map.name}", with its pins and routes?`, { ok: 'Delete', danger: true })) return;
      try { await post('map_delete', { id: map.id }, cid); toast('Map deleted'); await ctx.reloadCampaign(); location.hash = `#/c/${cid}/maps`; } catch (err) { toast(err.message, true); }
    }, 'danger') : null;
    // wipe a map's pins and/or routes in one go (the Encyclopedia entries and Events the pins pointed to stay)
    const clearAll = (what, label) => btn(label, async () => {
      const n = what.pins ? pins.length : routes.length;
      if (!n) { toast(`This map has no ${what.pins ? 'pins' : 'routes'}`); return; }
      const word = what.pins ? (n === 1 ? 'pin' : 'pins') : (n === 1 ? 'route' : 'routes');
      if (!await ctx.confirmDialog(`Delete all ${n} ${word} on "${map.name}"?${what.pins ? ' Their Encyclopedia entries and Events stay.' : ''}`, { ok: `Delete ${n} ${word}`, danger: true })) return;
      try { await post('map_clear', { map_id: map.id, ...what }, cid); await refresh(); toast(`Deleted ${n} ${word}`); } catch (err) { toast(err.message, true); }
    }, 'danger', what.pins ? 'Remove every pin from this map, players\' notes too' : 'Remove every route from this map');
    const clearPins = gm ? clearAll({ pins: true }, 'Delete all pins…') : null, clearRoutes = gm ? clearAll({ routes: true }, 'Delete all routes…') : null;
    const swap = gm ? el('label', { class: 'button file-add', 'data-tip': 'Replace the map\'s picture' }, el('input', { type: 'file', accept: PICTURES, class: 'file-input', 'aria-label': 'Change the map picture',
      onchange: async ev => {
        const f = ev.target.files[0];
        if (!f) return;
        let file = null;
        try { file = await ctx.uploadFile('map', map.id, f); await post('map_save', { id: map.id, image_id: file.id }, cid); toast('Picture changed'); location.hash = `${base}?scale=1&file=${encodeURIComponent(f.name)}`; }
        catch (err) { if (file) await post('file_delete', { id: file.id }, cid).catch(() => {}); toast(err.message, true); }
      } }), 'Change picture') : null;
    /** Scan for place names: Claude (with the GM's own Anthropic key) or Tesseract (on this device) reads the labels on
     * the picture, and the GM approves or skips each one. An approved name is pinned where it was read, as its
     * Encyclopedia entry (the entry of that name, or a new Location). */
    function scanNames() {
      const d = el('dialog', { class: 'kit-dialog map-scan-dialog', 'aria-label': 'Scan for place names' });
      let stop = false, abort = null;
      d.addEventListener('close', () => { stop = true; abort?.abort(); d.remove(); });
      const key = MapScan.apiKey.get();
      const way = (title, text, action) => el('div', { class: 'map-scan-way' }, el('div', {}, el('strong', {}, title), el('p', { class: 'small muted' }, text)), action);
      d.append(el('h3', {}, `Scan ${map.name} for place names`),
        way('Read with Claude', key
          ? 'Sends the picture to Anthropic, where Claude reads it with your own API key. Reads fancy and slanted lettering well, and a numbered legend: each numbered spot is named from the legend. Costs your Anthropic account a few cents a scan.'
          : 'Claude reads fancy and slanted lettering well, using your own Anthropic API key. Add your key on your account page to use it.',
        key ? btn('Read with Claude', () => run('claude'), 'primary') : el('a', { class: 'button', href: '#/account', onclick: () => d.close() }, 'Add your key')),
        way('Read on this device', 'Free, and the picture stays on your device, but it only reads plain printed lettering. The first scan downloads the scanner (about 7 MB), which your browser keeps.',
          btn('Read here', () => run('here'))),
        el('p', { class: 'small muted' }, 'To label a map by hand instead, use Quick label: click a spot and type its name.'),
        el('div', { class: 'kit-dialog-actions' }, btn('Cancel', () => d.close())));
      document.body.append(d); d.showModal();

      function run(how) {
        const bar = el('progress', { max: 1, value: 0, 'aria-label': 'Scanning' });
        const said = el('p', { class: 'small', role: 'status' }, how === 'claude' ? 'Getting the picture ready…' : 'Loading the scanner…');
        d.replaceChildren(el('h3', {}, `Scan ${map.name} for place names`),
          el('p', { class: 'small muted' }, how === 'claude' ? 'Claude is reading the picture, with your own Anthropic API key.'
            : 'The picture is read here on your device and isn\'t sent anywhere. The first scan downloads the scanner (about 7 MB), which your browser keeps for next time.'),
          bar, said, el('div', { class: 'kit-dialog-actions' }, btn('Cancel', () => d.close())));
        const progress = (share, what) => { if (share === null) bar.removeAttribute('value'); else bar.value = share; said.textContent = what; };
        abort = new AbortController();
        (how === 'claude' ? MapScan.claude(map.image_url, key, progress, abort.signal) : MapScan.scan(map.image_url, progress))
          .then(({ found, canvas, k }) => { if (!stop) review(found, canvas, k, how); })
          .catch(err => { if (stop) return; said.textContent = err.message; bar.remove(); });
      }

      function review(found, canvas, k, how) {
        const pinned = new Set(pins.map(p => G.nameKey(pinTitle(p))));
        if (!found.length) {
          d.replaceChildren(el('h3', {}, 'No place names found'), el('p', {}, how === 'claude' ? 'Claude found no place names on this picture.'
            : 'The scanner found no words it was sure of. It reads straight, printed labels best: curved, faint, fancy or handwritten ones are often missed. Read with Claude does much better on those.'),
            el('div', { class: 'kit-dialog-actions' }, btn('Close', () => d.close())));
          return;
        }
        const rows = found.map(c => {
          const already = pinned.has(G.nameKey(c.name));
          const box = el('input', { type: 'checkbox', checked: !already && (c.conf === null || c.conf >= 70), 'aria-label': `Add ${c.name}` });
          const name = el('input', { value: c.name, maxlength: 150, autocomplete: 'off', 'aria-label': 'Place name' });
          const what = el('small', { class: 'muted' });
          const say = () => {
            const e = entryNamed(name.value);
            what.textContent = pinned.has(G.nameKey(name.value)) ? 'Already pinned on this map'
              : e ? `Pins the entry ${e.name}${e.is_secret ? ' (GM only)' : ''}` : 'A new Location in the Encyclopedia';
          };
          name.addEventListener('input', () => { say(); box.checked = !!name.value.trim(); count(); });
          box.addEventListener('change', () => count());
          say();
          const row = el('div', { class: 'map-scan-row' + (already ? ' already' : '') }, box,
            el('img', { src: MapScan.crop(canvas, k, c.box), alt: `Where "${c.name}" was read`, class: 'map-scan-crop' }),
            el('div', { class: 'map-scan-name' }, name, el('span', {}, what, c.num ? el('small', { class: 'muted' }, ` · number ${c.num} in the legend`) : null, c.conf === null ? null : el('small', { class: 'muted' }, ` · ${c.conf}% sure`))));
          return { c, box, name, row };
        });
        const go = el('button', { class: 'primary', type: 'button' });
        const count = () => { const n = rows.filter(r => r.box.checked && r.name.value.trim()).length; go.textContent = n === 1 ? 'Add 1 pin' : `Add ${n} pins`; go.disabled = !n; };
        const all = on => () => { rows.forEach(r => { r.box.checked = on && !r.row.classList.contains('already'); }); count(); };
        go.addEventListener('click', async () => {
          const pick = rows.filter(r => r.box.checked && r.name.value.trim());
          go.disabled = true;
          let added = 0, made = 0;
          try {
            for (const r of pick) {
              const n = r.name.value.trim();
              go.textContent = `Adding ${added + 1} of ${pick.length}…`;
              let e = entryNamed(n);
              if (!e) {
                const id = (await post('entry_save', { name: n, category: 'location' }, cid)).id;
                e = { id, name: n, aliases: [], is_secret: false, blank: true, preview: '' };
                S.encyclopedia = [...S.encyclopedia, e];
                made++;
              }
              const x = Math.min(map.width, Math.max(0, r.c.x)), y = Math.min(map.height, Math.max(0, r.c.y));
              await post('pin_save', { map_id: map.id, x, y, kind: 'entry', entry_id: e.id, label: '', note: '' }, cid);
              added++;
              r.box.checked = false; r.row.classList.add('already');
            }
          } catch (err) { toast(err.message, true); }
          d.close();
          await refresh().catch(() => {});
          if (added) toast(`Added ${added === 1 ? '1 pin' : `${added} pins`}${made ? `, with ${made === 1 ? '1 new Location' : `${made} new Locations`} in the Encyclopedia` : ''}`);
        });
        count();
        d.replaceChildren(el('h3', {}, `Found ${found.length === 1 ? '1 name' : `${found.length} names`} on ${map.name}`),
          el('p', { class: 'small muted' }, 'Tick the ones to pin, and fix any the scanner misread. Each is pinned where it was read, as the Encyclopedia entry of that name, or a new Location.'),
          el('div', { class: 'row' }, btn('Select all', all(true), 'small'), btn('Select none', all(false), 'small')),
          el('div', { class: 'map-scan-list' }, rows.map(r => r.row)),
          el('div', { class: 'kit-dialog-actions' }, go, btn('Cancel', () => d.close())));
      }
    }
    const scanBtn = gm && map.image_url && typeof MapScan !== 'undefined'
      ? btn('Scan for names…', scanNames, '', 'Read the place names printed on the map, then pick which to pin as Encyclopedia locations') : null;

    // ⚙: setup and the map's own changes, kept out of the toolbar: done once per map, and not to be pressed by accident
    const off = new AbortController();   // the page's own listeners on the document, taken down when it is left
    window.addEventListener('hashchange', () => off.abort(), { once: true });
    // KIT.menu closes it when an item is picked, on a click anywhere else and on Escape
    const gear = gm ? KIT.menu({ label: '⚙', ariaLabel: 'Map settings', tip: 'Scale, scanning, export, and changing, renaming, clearing or deleting this map',
      cls: 'map-gear', listCls: 'map-gear-menu', items: [scaleBtn, opacityBox, scanBtn, exportBtn, el('hr'), swap, btn('Rename', rename), el('hr'), clearPins, clearRoutes, del] }) : null;
    gear?.querySelector('input[type=file]').addEventListener('change', () => { gear.open = false; });
    // keys, until the page is left: P Add pin, L Quick label, M Measure/Route, T Place party, Escape out of what is open.
    // Not while typing, nor while a dialog is open over the page.
    document.addEventListener('keydown', ev => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
      if (ev.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
      const press = b => { if (b && !b.hidden) { ev.preventDefault(); b.click(); } };
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (k === 'p') press(addPinBtn);
      else if (k === 'l') press(labelBtn);
      else if (k === 'm') press(measureBtn);
      else if (k === 't') press(partyBtn);
      else if (k === 'Escape') {
        if (gear?.open) gear.open = false;
        else if (lf?.map.getContainer().querySelector('.leaflet-popup')) lmap_close();
        else if (mode === 'scale') closePanel();
        else press({ pin: addPinBtn, label: labelBtn, measure: measureBtn, party: partyBtn }[mode]);
      }
    }, { signal: off.signal });
    // the toolbar: the modes used all the time, then what is only seen; the measure bar while measuring; GM only and ⚙ top-right
    // it folds away to one button, remembered on this device; its keys still work while it is folded
    const toolsKey = `chronicle-map-tools-${cid}`;
    let toolsFolded = (() => { try { return localStorage.getItem(toolsKey) === 'folded'; } catch { return false; } })();
    const toolsFold = btn('', () => {
      toolsFolded = !toolsFolded;
      try { localStorage.setItem(toolsKey, toolsFolded ? 'folded' : 'open'); } catch { /* this visit only */ }
      syncToolsFold();
    }, 'small map-tools-fold');
    const syncToolsFold = () => {
      toolbar.classList.toggle('folded', toolsFolded);
      toolsFold.textContent = toolsFolded ? '🧰' : '⟨';
      toolsFold.setAttribute('aria-label', toolsFolded ? 'Show the toolbar' : 'Hide the toolbar');
      toolsFold.setAttribute('aria-expanded', String(!toolsFolded));
      toolsFold.dataset.tip = toolsFolded ? 'Show the map tools' : 'Fold the map tools away';
      if (lf) syncPad();
    };
    toolbar.append(el('div', { class: 'map-tool-group' }, ...[addPinBtn, labelBtn, measureBtn, partyBtn, partyWhich].filter(Boolean)),
      el('div', { class: 'map-tool-group' }, labelsBtn, gridBtn), toolsFold);
    syncToolsFold();
    const measureBar = el('div', { class: 'map-measure-bar surface-float' }, total, undoBtn, clearBtn, saveRouteBtn, planBtn);
    measureBar.hidden = true;
    stage.append(toolbar, panelBox, note, measureBar, routeBox);   // panelBox: the scale, pin and Quick label forms, floating under the toolbar
    if (gm) stage.append(el('div', { class: 'map-corner' }, secretBtn, gear));
    const title = el('h2', {}, map.name);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const metaText = () => `${plural(pins.length, 'location')} · ${plural(routes.length, 'route')}${hasScale() ? ' · scale set' : ''}`;
    const meta = el('span', { class: 'map-meta small muted' }, metaText());

    ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'map-view' },
      el('div', { class: 'row map-head' }, el('a', { href: `#/c/${cid}/maps`, class: 'small' }, '← Maps'), title, meta),
      data.parent ? el('p', { class: 'small muted map-inside' }, 'Inside: ', el('strong', {}, data.parent.label), ' on ',
        el('a', { href: `#/c/${cid}/maps/${data.parent.map_id}` }, data.parent.map_name)) : null,
      el('div', { class: 'map-body' }, stage)));

    if (!map.image_url || !map.width) {
      host.replaceChildren(el('p', { class: 'muted map-empty' }, gm ? 'This map has no picture yet. Use ⚙ → Change picture.' : 'This map has no picture yet.'));
      syncTools();
      return;
    }
    const lmap = L.map(host, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 4, zoomSnap: 0.25, attributionControl: false });
    // the picture, then the grid over it, both under the routes and pins (overlayPane is 400, markers above)
    lmap.createPane('mapPicture').style.zIndex = 300;
    lmap.createPane('mapGrid').style.zIndex = 350;
    // a very large picture is drawn in tiles, cut from the image as they are needed (and from smaller copies when zoomed out),
    // so no one huge element has to be scaled: tablets and phones refuse or blur those
    if (map.width * map.height > BIG_PICTURE) bigPicture(map.image_url, map.width, map.height, bounds()).addTo(lmap);
    else L.imageOverlay(map.image_url, bounds(), { pane: 'mapPicture' }).addTo(lmap);
    lmap.fitBounds(bounds());
    measureLayer = L.layerGroup().addTo(lmap);
    pickLayer = L.layerGroup().addTo(lmap);
    routeLayer = L.layerGroup().addTo(lmap);
    trailLayer = L.layerGroup().addTo(lmap);
    pinLayer = L.layerGroup().addTo(lmap);
    groupLayer = L.layerGroup().addTo(lmap);
    const bar = scaleControl(() => map, system).addTo(lmap);
    lf = { map: lmap, scale: bar };
    // on a phone a card wants more of the map than the open sheet leaves it, so the sheet folds away while one is open
    const phone = () => window.matchMedia('(max-width: 720px)').matches;
    lmap.on('popupopen', () => { if (phone() && !sheetAway) { sheetAway = true; syncDrawer(); } })
      .on('popupclose', () => { if (sheetAway && !mode) { sheetAway = false; syncDrawer(); } });
    // what the markers mean, bottom-left under the scale bar
    stage.append(el('div', { class: 'map-legend surface-float', role: 'note', 'aria-label': 'Legend' },
      ['📍 Place', '📅 Event', '📝 Note', '🚩 Party'].map(t => el('span', { class: 'map-legend-item' }, t)),
      trail.length ? (() => {
        const b = el('button', { type: 'button', class: 'map-legend-item map-legend-trail', 'aria-pressed': String(trailShown),
          'data-tip': 'The party\'s trail: where each group was put on this map, shift by shift. Press to hide or show it' },
          el('i', { class: 'map-legend-dots', 'aria-hidden': 'true' }), 'Trail');
        b.addEventListener('click', () => {
          trailShown = !trailShown; b.setAttribute('aria-pressed', String(trailShown));
          try { localStorage.setItem(TRAIL_KEY, trailShown ? 'on' : 'off'); } catch {}
          drawTrail();
        });
        return b;
      })() : null,
      el('span', { class: 'map-legend-item' }, el('i', { class: 'map-legend-gm', 'aria-hidden': 'true' }), 'GM only')));
    // pins' names show once zoomed in well past the fit the page opened at (as well as on hover, on the open card, and with Labels)
    let baseZoom = lmap.getZoom();
    const syncZoom = () => stage.classList.toggle('zoomed-in', lmap.getZoom() >= baseZoom + 1.5);
    lmap.on('zoomend', syncZoom);
    syncZoom();
    syncTools();
    lmap.on('click', onClick);
    lmap.on('zoom', gridWidth);
    drawGrid();
    // the map must know its size once it is on the page, and again whenever that changes
    let gone = false;
    const teardown = () => { if (gone) return; gone = true; ro.disconnect(); window.removeEventListener('hashchange', teardown); window.removeEventListener('resize', fit); lmap.remove(); lf = null; };
    // no animations here: Leaflet ignores a drag that starts while it is zooming, and a tap would land on a moving map.
    // --map-top is how far down the window the stage starts, so the CSS can take it to the window's bottom edge
    // A link back to a pin (?pin=) opens its card. The page can still be settling then (Firefox lays the stage out again
    // a frame later, and the card can close with it), so until someone touches the map, a card that closed opens again.
    let linked = null;
    for (const ev of ['pointerdown', 'keydown', 'wheel']) stage.addEventListener(ev, () => { linked = null; }, { capture: true, once: true });
    const keepLinked = () => { if (linked && !gone && !linked.isPopupOpen()) linked.openPopup(); };
    const fit = () => {
      if (!host.isConnected) return teardown();
      keepLinked();
      const top = Math.round(stage.getBoundingClientRect().top + window.scrollY) + 'px';
      if (stage.style.getPropertyValue('--map-top') !== top) stage.style.setProperty('--map-top', top);
      lmap.invalidateSize({ animate: false, pan: false });   // the picture stays put under the pointer as the stage grows or shrinks at the bottom
      syncPad();
    };
    // the page's body too: the bar over the tabs can grow after the map is drawn, moving the stage down. A frame later,
    // so the stage's new height is never a change inside the observer's own callback
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    window.addEventListener('hashchange', teardown);   // leaving the page (or reopening it) takes the map down at once
    window.addEventListener('resize', fit);
    ro.observe(stage); ro.observe(document.body);
    drawRoutes(); renderRoutes(); drawPins(); drawGroups();
    requestAnimationFrame(() => {
      if (!host.isConnected || gone) return;
      lmap.invalidateSize({ animate: false }); fitPicture(); baseZoom = lmap.getZoom(); syncZoom();
      const want = pinMarkers.get(Number(params.get('pin')));   // a link back from an entry or event: centre on that pin and open its card
      const at = pins.find(q => q.id === Number(params.get('pin')));
      if (want && at) { lmap.setView(toLatLng(at.x, at.y), 0, { animate: false }); want.openPopup(); linked = want; for (const t of [250, 800]) setTimeout(keepLinked, t); setTimeout(() => { linked = null; }, 3000); }
      else if (params.get('pin')) note.textContent = 'That pin is not on this map';
    });
    syncTools();

    if (params.get('scale') === '1' && gm) {
      const file = params.get('file');
      openScale(file ? G.gridHint(file, map.width, map.height) : null);
      history.replaceState(null, '', base);   // reloading the page does not open it again
    }
  }

  async function view(ctx, sel, query) {
    return sel ? one(ctx, Number(sel), query) : list(ctx);
  }

  return { view, marker, toLatLng, toXY, scaleControl, PIN_ICONS, COLOURS, DASHES };
})();
