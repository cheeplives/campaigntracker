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

  /** A map's pixel position <-> Leaflet's. */
  const toLatLng = (x, y) => [-y, x];
  const toXY = ll => ({ x: ll.lng, y: -ll.lat });

  let say = () => {};   // the page's toast, for a marker that could not be moved

  /** A marker on `layer`: the picture, or the emoji, with its label under it. It keeps its size as the map zooms. onMove
   * runs after a drag and, if it fails, the marker goes back; onOpen's node fills the card a click opens. */
  function marker(layer, { x, y, icon, image, label, className, sizePx = 28, draggable = false, onMove, onOpen }) {
    const face = image ? el('img', { class: 'map-marker-icon', src: image, alt: '' }) : el('span', { class: 'map-marker-icon', 'aria-hidden': 'true' }, icon || '');
    const node = el('div', { class: `map-marker ${className || ''}`.trim() }, face, label ? el('span', { class: 'map-marker-label' }, label) : null);
    node.style.setProperty('--marker-size', sizePx + 'px');
    const m = L.marker(toLatLng(x, y), { icon: L.divIcon({ html: node, className: 'map-marker-box', iconSize: [sizePx, sizePx], iconAnchor: [sizePx / 2, sizePx / 2] }),
      draggable, title: label || '', keyboard: true, riseOnHover: true });
    if (onOpen) m.bindPopup(() => onOpen(), { className: 'map-card-popup', minWidth: 160 });
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

  // ------------------------------------------------------------ the list

  async function list(ctx) {
    const { el, btn, api, S } = ctx;
    const cid = S.camp.id;
    const { maps } = await api('maps', { query: { cid } });
    const cards = maps.map(m => el('a', { class: 'map-card' + (m.is_secret ? ' secret' : ''), href: `#/c/${cid}/maps/${m.id}` },
      m.image_url ? el('img', { src: m.image_url, alt: '', loading: 'lazy' }) : el('span', { class: 'map-card-blank muted small' }, 'No picture'),
      el('strong', {}, m.is_secret ? '🔒 ' : '', m.name),
      el('span', { class: 'small muted' }, m.is_secret ? 'GM only' : '', m.is_secret && m.pins ? ' · ' : '', m.pins ? `${m.pins} pin${m.pins === 1 ? '' : 's'}` : '')));
    ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card' },
      el('div', { class: 'row map-list-head' }, el('h2', {}, 'Maps'), ctx.isGM() ? btn('+ New map', () => newMap(ctx), 'primary') : null),
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
        btn('Cancel', () => d.close())));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = pic.files[0];
      if (!name.value.trim()) return toast('Give the map a name', true);
      if (!f) return toast('Choose the map\'s picture, or use Find Image', true);
      go.disabled = true;
      try {
        made = (await post('map_save', { name: name.value.trim() }, cid)).map;
        const file = await ctx.uploadFile('map', made.id, f);
        await post('map_save', { id: made.id, image_id: file.id }, cid);
        open(made, f.name);
      } catch (err) { toast(err.message, true); go.disabled = false; }
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
      return ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card' }, el('p', {}, 'That map is not here.'), el('a', { href: `#/c/${cid}/maps` }, 'Back to the maps')));
    }
    let map = data.map;
    const gm = ctx.isGM();
    const system = () => ctx.unitSystem();
    const base = `#/c/${cid}/maps/${id}`;

    const host = el('div', { class: 'map-stage' });
    const note = el('p', { class: 'small map-note', role: 'status' });
    const total = el('span', { class: 'map-measure-total', role: 'status' });
    const tools = el('div', { class: 'map-tools' });   // room for Save route… and the route list (Task 8)
    const toolbar = el('div', { class: 'map-toolbar' });
    const panelBox = el('div', { class: 'map-panel-box' });

    let lf = null, mode = null;   // mode: 'measure' | 'scale' | null
    const bounds = () => [toLatLng(0, map.height), toLatLng(map.width, 0)];

    // ---- measuring
    let pts = [];
    let measureLayer = null;
    const drawMeasure = () => {
      measureLayer.clearLayers();
      if (!pts.length) { total.textContent = ''; return; }
      L.polyline(pts.map(p => toLatLng(p.x, p.y)), { color: 'var(--accent)', weight: 3, className: 'map-line' }).addTo(measureLayer);
      pts.forEach((p, i) => {
        const c = L.circleMarker(toLatLng(p.x, p.y), { radius: 4, className: 'map-dot', interactive: false }).addTo(measureLayer);
        if (i === pts.length - 1 && i > 0) c.bindTooltip(dist(), { permanent: true, direction: 'right', className: 'map-tip' });
      });
      total.textContent = pts.length > 1 ? dist() : '';
    };
    const dist = () => G.fmtDistance(G.toMetres(G.pathPx(pts), map), system(), G.isSpace(map));
    const hasScale = () => G.toMetres(1, map) !== null;

    // ---- the scale panel
    let picks = [], pickLayer = null, panel = null;
    const drawPicks = () => {
      pickLayer.clearLayers();
      picks.forEach((p, i) => L.circleMarker(toLatLng(p.x, p.y), { radius: 5, className: 'map-dot pick', interactive: false }).bindTooltip(i ? 'B' : 'A', { permanent: true, direction: 'top', className: 'map-tip' }).addTo(pickLayer));
      if (picks.length === 2) L.polyline(picks.map(p => toLatLng(p.x, p.y)), { weight: 2, dashArray: '4 4', className: 'map-line', interactive: false }).addTo(pickLayer);
    };
    function closePanel() { panel = null; panelBox.replaceChildren(); picks = []; pickLayer?.clearLayers(); if (mode === 'scale') mode = null; syncTools(); }
    function openScale(hint) {
      mode = 'scale'; picks = []; drawPicks(); note.textContent = '';
      pts = []; measureLayer && drawMeasure();
      const hasGrid = map.grid_px > 0;
      let way = hasGrid || hint ? 'grid' : 'points', offset = null;
      const dist = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Distance', value: '' });
      const unit = select(UNITS, map.scale_unit || (system() === 'metric' ? 'km' : 'mi'), { 'aria-label': 'Unit' });
      const sq = hasGrid && map.scale_per_px ? +(map.scale_per_px * map.grid_px).toPrecision(6) : G.ROLL20.per_square;
      const per = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Distance per square', value: String(sq) });
      const perUnit = select(UNITS, hasGrid && map.scale_unit ? map.scale_unit : G.ROLL20.unit, { 'aria-label': 'Unit' });
      const px = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Pixels per square', value: hasGrid ? String(map.grid_px) : hint ? String(hint.grid_px) : '' });
      const count = el('input', { type: 'number', min: 1, step: 'any', 'aria-label': 'How many squares', value: '' });
      const way1 = btn('Two points', () => show('points'), '', 'Click two places you know the distance between');
      const way2 = btn('Grid squares', () => show('grid'), '', 'Say how big one square of the map\'s grid is');
      const body = el('div', { class: 'map-panel-body' });
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
          el('div', { class: 'row' }, field('How far apart are they?', dist), field('Unit', unit))
        ] : [
          el('div', { class: 'row' }, field('One square is', per), field('Unit', perUnit), field('Pixels per square', px, hint ? `The file name says ${Math.round(hint.grid_px * 100) / 100} px` : ''),
            btn(`Roll20 (${G.ROLL20.grid_px} px = ${G.ROLL20.per_square} ft)`, () => { px.value = String(G.ROLL20.grid_px); per.value = String(G.ROLL20.per_square); perUnit.value = G.ROLL20.unit; }, 'small')),
          el('p', { class: 'small' }, 'Or click the corners of a run of squares, then say how many squares that is.'),
          el('div', { class: 'row' }, field('How many squares is that?', count))
        ]));
      }
      const save = async () => {
        let patch;
        try {
          if (way === 'points') {
            if (picks.length < 2) throw new Error('Click two places on the map first');
            patch = { ...G.scaleFromPoints(picks[0], picks[1], +dist.value, unit.value), grid_px: null, grid_offset_x: null, grid_offset_y: null };
          } else {
            fromRun();
            if (!(+px.value > 0)) throw new Error('Type how many pixels one square is');
            if (!(+per.value > 0)) throw new Error('Type how far one square is');
            patch = G.scaleFromGrid(+px.value, +per.value, perUnit.value);
            if (picks.length) { offset = { x: ((picks[0].x % patch.grid_px) + patch.grid_px) % patch.grid_px, y: ((picks[0].y % patch.grid_px) + patch.grid_px) % patch.grid_px }; patch.grid_offset_x = offset.x; patch.grid_offset_y = offset.y; }
          }
          map = (await post('map_save', { id: map.id, ...patch }, cid)).map;
        } catch (err) { return toast(err.message, true); }
        toast('Scale saved'); closePanel(); lf.scale.update(); ctx.reloadCampaign().catch(() => {});
      };
      panel = el('div', { class: 'map-panel card', role: 'dialog', 'aria-label': 'Set the scale' },
        el('div', { class: 'row' }, el('strong', {}, 'Set the scale'), way1, way2), body,
        el('div', { class: 'row' }, el('button', { class: 'primary', type: 'button', onclick: save }, 'Save scale'), btn('Cancel', closePanel)));
      panelBox.replaceChildren(panel);
      show(way);
      syncTools();
    }

    function onClick(ev) {
      const p = toXY(ev.latlng);
      if (mode === 'measure') { pts.push(p); drawMeasure(); }
      else if (mode === 'scale') { picks = picks.length >= 2 ? [p] : [...picks, p]; drawPicks(); if (picks.length === 2) panelBox.querySelector('input[aria-label="How many squares"]')?.dispatchEvent(new Event('input')); }
    }

    // ---- the toolbar
    const measureBtn = btn('Measure', () => {
      if (mode === 'measure') { mode = null; pts = []; drawMeasure(); note.textContent = ''; return syncTools(); }
      if (!hasScale()) { note.textContent = gm ? 'Set the scale to measure' : 'The GM hasn\'t set this map\'s scale yet'; return; }
      if (mode === 'scale') closePanel();
      mode = 'measure'; note.textContent = 'Click the map to lay down points'; syncTools();
    }, '', 'Click along a path to add up its length');
    const undoBtn = btn('Undo point', () => { pts.pop(); drawMeasure(); }, 'small');
    const clearBtn = btn('Clear', () => { pts = []; drawMeasure(); }, 'small');
    function syncTools() {
      const m = mode === 'measure';
      measureBtn.setAttribute('aria-pressed', String(m));
      undoBtn.hidden = clearBtn.hidden = !m;
      total.hidden = !m;
      if (scaleBtn) scaleBtn.setAttribute('aria-pressed', String(mode === 'scale'));
      host.classList.toggle('picking', m || mode === 'scale');
    }
    const scaleBtn = gm ? btn('Scale', () => (mode === 'scale' ? closePanel() : openScale()), '', 'Tell the map how far apart things are') : null;
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
    const secretBtn = gm ? btn('GM only', async () => {
      try {
        map = (await post('map_save', { id: map.id, is_secret: !map.is_secret }, cid)).map;
        secretBtn.setAttribute('aria-pressed', String(map.is_secret)); ctx.reloadCampaign().catch(() => {});
      } catch (err) { toast(err.message, true); }
    }, '', 'Players never see a GM only map') : null;
    secretBtn?.setAttribute('aria-pressed', String(map.is_secret));
    const del = gm ? btn('Delete map', async () => {
      if (!await ctx.confirmDialog(`Delete the map "${map.name}", with its pins and routes?`, { ok: 'Delete', danger: true })) return;
      try { await post('map_delete', { id: map.id }, cid); toast('Map deleted'); await ctx.reloadCampaign(); location.hash = `#/c/${cid}/maps`; } catch (err) { toast(err.message, true); }
    }, 'danger') : null;
    const swap = gm ? el('label', { class: 'button file-add small', 'data-tip': 'Replace the map\'s picture' }, el('input', { type: 'file', accept: PICTURES, class: 'file-input', 'aria-label': 'Change the map picture',
      onchange: async ev => {
        const f = ev.target.files[0];
        if (!f) return;
        let file = null;
        try { file = await ctx.uploadFile('map', map.id, f); await post('map_save', { id: map.id, image_id: file.id }, cid); toast('Picture changed'); location.hash = `${base}?scale=1&file=${encodeURIComponent(f.name)}`; }
        catch (err) { if (file) await post('file_delete', { id: file.id }, cid).catch(() => {}); toast(err.message, true); }
      } }), 'Change picture') : null;
    toolbar.append(measureBtn, undoBtn, clearBtn, total, tools, el('span', { class: 'map-toolbar-gap' }), scaleBtn, swap, gm ? btn('Rename', rename) : null, secretBtn, del);
    const title = el('h2', {}, map.name);

    ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card map-view' },
      el('div', { class: 'row map-head' }, el('a', { href: `#/c/${cid}/maps`, class: 'small' }, '← Maps'), title), toolbar, note, panelBox, host));

    if (!map.image_url || !map.width) {
      host.replaceChildren(el('p', { class: 'muted map-empty' }, gm ? 'This map has no picture yet. Use Change picture.' : 'This map has no picture yet.'));
      syncTools();
      return;
    }
    const lmap = L.map(host, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 4, zoomSnap: 0.25, attributionControl: false });
    L.imageOverlay(map.image_url, bounds()).addTo(lmap);
    lmap.fitBounds(bounds());
    measureLayer = L.layerGroup().addTo(lmap);
    pickLayer = L.layerGroup().addTo(lmap);
    const bar = scaleControl(() => map, system).addTo(lmap);
    lf = { map: lmap, scale: bar };
    lmap.on('click', onClick);
    // the map must know its size once it is on the page, and again whenever that changes
    const fit = () => { if (!host.isConnected) { lmap.remove(); ro.disconnect(); return; } lmap.invalidateSize(); };
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    requestAnimationFrame(() => { if (host.isConnected) { lmap.invalidateSize(); lmap.fitBounds(bounds()); } });
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

  return { view, marker, toLatLng, toXY, scaleControl };
})();
