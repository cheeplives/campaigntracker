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
    let groups = here;   // every group, for the GM's Party is here (players only ever need the ones drawn)
    const loadGroups = async () => { if (gm) groups = (await api('groups', { query: { cid } })).groups; };
    const gm = ctx.isGM();
    const system = () => ctx.unitSystem();
    const base = `#/c/${cid}/maps/${id}`;
    await loadGroups().catch(() => {});

    const host = el('div', { class: 'map-stage' });
    const note = el('p', { class: 'small map-note', role: 'status' });
    const total = el('span', { class: 'map-measure-total', role: 'status' });
    const tools = el('div', { class: 'map-tools' });
    const routeBox = el('aside', { class: 'map-routes', 'aria-label': 'Routes' });
    const toolbar = el('div', { class: 'map-toolbar' });
    const panelBox = el('div', { class: 'map-panel-box' });

    let lf = null, mode = null;   // mode: 'measure' | 'scale' | 'pin' (the next click places a pin) | null
    const bounds = () => [toLatLng(0, map.height), toLatLng(map.width, 0)];

    // ---- measuring
    let pts = [];
    let measureLayer = null;
    const drawMeasure = () => {
      measureLayer.clearLayers();
      saveRouteBtn.hidden = !(gm && mode === 'measure' && pts.length > 1);
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
    function closePanel() { panel = null; panelBox.replaceChildren(); picks = []; pickLayer?.clearLayers(); if (mode === 'scale' || mode === 'pin') mode = null; syncTools(); }
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
          el('div', { class: 'row' }, field('How far apart are they?', apart), field('Unit', unit))
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
            patch = { ...G.scaleFromPoints(picks[0], picks[1], +apart.value, unit.value), grid_px: null, grid_offset_x: null, grid_offset_y: null };
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

    // ---- pins
    let pinLayer = null, routeLayer = null;
    const pinMarkers = new Map();
    const mine = p => gm || (p.kind === 'note' && p.created_by === S.user.id);
    const entryNamed = name => S.encyclopedia.find(e => [e.name, ...(e.aliases || [])].some(n => G.nameKey(n) === G.nameKey(name))) || null;   // nameKey ignores case, accents and a leading "The"
    const pinTitle = p => (p.kind === 'entry' && p.entry ? p.entry.name : p.kind === 'event' && p.event ? p.event.title : p.label) || 'Pin';
    const pinIcon = p => p.kind === 'entry' ? (ctx.encCat(p.entry?.category)?.[2] || '📌') : p.kind === 'event' ? '📅' : '📝';
    function drawPins() {
      pinLayer.clearLayers(); pinMarkers.clear();
      for (const p of pins) pinMarkers.set(p.id, MapsTab.marker(pinLayer, { x: p.x, y: p.y, icon: pinIcon(p), label: pinTitle(p), className: 'map-pin' + (p.is_secret ? ' secret' : ''),
        draggable: mine(p), onMove: async xy => { Object.assign(p, (await post('pin_save', { id: p.id, x: xy.x, y: xy.y }, cid)).pin); }, onOpen: () => pinCard(p) }));
    }
    /** After a change: this map's pins and routes again, and the campaign's index of which entries and events are pinned where. */
    async function refresh() {
      const [d] = await Promise.all([api('map', { query: { cid, id } }), ctx.reloadCampaign().catch(() => {})]);
      map = d.map; pins = d.pins || []; routes = d.routes || []; here = d.groups || [];
      await loadGroups().catch(() => {});
      if (gone) return;
      lmap_close();   // a card open on a marker about to be redrawn would outlive it
      drawPins(); drawRoutes(); renderRoutes(); drawGroups();
    }
    // ---- the party's groups: a flag, or the group's token, with its name
    let groupLayer = null;
    const drawGroups = () => {
      groupLayer.clearLayers();
      for (const g of (gm ? groups : here).filter(q => q.map_id === map.id && q.x !== null)) {
        MapsTab.marker(groupLayer, { x: g.x, y: g.y, icon: '🚩', image: g.token_url, label: g.name, className: 'map-party', sizePx: g.token_url ? 40 : 28,
          draggable: gm, onMove: async xy => { await post('group_move', { id: g.id, map_id: map.id, x: xy.x, y: xy.y }, cid); Object.assign(g, { x: xy.x, y: xy.y }); },
          onOpen: () => el('div', { class: 'map-pin-card' }, el('strong', {}, g.name), g.is_main ? el('small', { class: 'muted' }, 'The main group') : null,
            el('small', {}, g.members.map(u => memberName(u)).join(', ') || 'No one yet')) });
      }
    };
    const memberName = uid => { const m = S.members.find(x => Number(x.id) === uid); return m ? m.character_name || m.display_name : 'Someone'; };
    /** GMs: move a group to this pin. With more than one group, a small select asks which. */
    function partyHere(p) {
      if (!gm || !groups.length) return null;
      const which = groups.length > 1 ? select(groups.map(g => [g.id, g.name]), groups[0].id, { 'aria-label': 'Which group' }) : null;
      return el('div', { class: 'row' }, which, btn('Party is here', async () => {
        const g = groups.find(q => q.id === Number(which ? which.value : groups[0].id));
        try {
          await post('group_move', { id: g.id, map_id: map.id, x: p.x, y: p.y }, cid);
          lmap_close(); await refresh(); toast(`${g.name} is at ${pinTitle(p)}`);
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
        // a new entry takes the note's text, so it goes through the Proper Noun Detector as an entry save does
        if (r.created && (p.note || '').trim()) ctx.offerNouns([{ text: p.note, label: `the note on the pin "${p.label}"` }]).catch(() => {});
      } catch (err) { toast(err.message, true); }
    }
    function pinCard(p) {
      const cardIcon = pinIcon(p);
      const head = p.kind === 'entry' && p.entry ? el('a', { href: `#/c/${cid}/encyclopedia/${p.entry.id}`, 'data-tip': 'Open this entry' }, `${cardIcon} ${p.entry.name}`)
        : el('span', {}, `${cardIcon} ${pinTitle(p)}`);
      const match = gm && p.kind === 'note' ? entryNamed(p.label) : null;
      return el('div', { class: 'map-pin-card' },
        el('strong', {}, p.is_secret ? '🔒 ' : '', head),
        p.kind === 'entry' && p.entry?.first_line ? el('p', { class: 'small' }, p.entry.first_line) : null,
        p.kind === 'event' && p.event ? el('p', { class: 'small' }, el('a', { href: `#/c/${cid}/day/${p.event.abs_day}`, 'data-tip': 'Open this day' }, ctx.fmtDay(p.event.abs_day))) : null,
        p.kind === 'note' && p.note ? el('p', { class: 'small pre' }, p.note) : null,
        p.is_secret ? el('small', { class: 'muted' }, 'GM only') : null,
        p.author ? el('small', { class: 'muted' }, `Added by ${p.author}`) : null,
        partyHere(p),
        gm && p.kind === 'note' ? el('div', { class: 'row' }, match
          ? btn(`Link to ${match.name}`, () => toEntry(p, match.id), 'small', 'Pin this to the entry that already has this name, without making another')
          : btn('Add to Encyclopedia', () => toEntry(p), 'small', 'Make an Encyclopedia entry of this pin\'s label and note, and keep the pin where it is')) : null,
        mine(p) ? el('div', { class: 'row' },
          btn('Edit', () => { lmap_close(); pinForm(p, p); }, 'small'),
          btn('Delete', async () => {
            if (!await ctx.confirmDialog(`Delete the pin "${pinTitle(p)}"?`, { ok: 'Delete', danger: true })) return;
            try { await post('pin_delete', { id: p.id }, cid); await refresh(); toast('Pin deleted'); } catch (err) { toast(err.message, true); }
          }, 'small danger')) : null);
    }
    const lmap_close = () => lf?.map.closePopup();

    /** The pin form, in the panel above the map: a new pin at xy, or pin `old` being changed. */
    function pinForm(old, xy) {
      closePanel();
      let kind = old?.kind || 'note', entry = old?.entry ? { id: old.entry.id, name: old.entry.name } : null, event = old?.event ? { id: old.event.id, title: old.event.title } : null;
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
      const kinds = [['note', 'Note'], ...(S.encReady ? [['entry', 'Encyclopedia entry']] : []), ['event', 'Event']];
      const kindBtns = kinds.map(([k, l]) => btn(l, () => { kind = k; show(); }, '', k === 'note' ? 'A label and a note' : k === 'entry' ? 'Pin an Encyclopedia entry' : 'Pin an event'));
      const body = el('div', { class: 'map-form-body' });
      const warn = (name, what) => toast(`"${name}" is GM only, so players won't see this pin until the ${what} is shown to them`);
      const save = async () => {
        if (working) return;
        const b = { map_id: map.id, x: xy.x, y: xy.y };
        if (old) b.id = old.id;
        if (gm) { b.kind = kind; b.is_secret = secret.checked; }
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
            const id = (await post('entry_save', { name, ...(S.encCatsReady ? { category: 'location' } : {}) }, cid)).id;
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
      }
      const form = el('form', { class: 'map-panel card', role: 'dialog', 'aria-label': old ? 'Edit pin' : 'Add pin' },
        el('div', { class: 'row' }, el('strong', {}, old ? 'Edit pin' : 'Add pin'), gm ? el('span', { class: 'row', role: 'group', 'aria-label': 'Kind of pin' }, kindBtns) : null),
        body,
        gm ? el('label', { class: 'check' }, secret, ' GM only') : null,
        el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit' }, old ? 'Save pin' : 'Add pin'), btn('Cancel', closePanel)));
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
      for (const r of routes) {
        const at = r.points.map(([x, y]) => toLatLng(x, y));
        const line = L.polyline(at, { weight: 3, dashArray: '8 6', interactive: false, className: 'map-route-line' + (r.is_secret ? ' secret' : '') }).addTo(routeLayer);
        // a thin dashed line is hard to hit with a finger (and a tap between dashes misses it), so an unseen wide one takes the taps
        L.polyline(at, { weight: 18, opacity: 0, className: 'map-route-hit' }).bindTooltip(el('span', {}, r.name), { sticky: true, className: 'map-tip' }).addTo(routeLayer);
        routeLines.set(r.id, line);
      }
    }
    /** A name (and, when `secret` is a boolean, a GM only box) asked for in a small dialog: resolves { name, secret }, or null if cancelled. */
    function routeDialog(title, name, secret, ok) {
      return new Promise(resolve => {
        const d = el('dialog', { class: 'kit-dialog', 'aria-label': title });
        const nameIn = el('input', { value: name, maxlength: 150, required: true, 'aria-label': 'Route name', autocomplete: 'off' });
        const box = typeof secret === 'boolean' ? el('input', { type: 'checkbox', checked: secret }) : null;
        let out = null;
        const form = el('form', {}, el('h3', {}, title), field('Route name', nameIn), box ? el('label', { class: 'check' }, box, ' GM only') : null,
          el('div', { class: 'kit-dialog-actions' }, el('button', { class: 'primary', type: 'submit' }, ok), btn('Cancel', () => d.close())));
        form.addEventListener('submit', ev => { ev.preventDefault(); if (!nameIn.value.trim()) return; out = { name: nameIn.value.trim(), secret: box ? box.checked : null }; d.close(); });
        d.addEventListener('close', () => { d.remove(); resolve(out); });
        d.append(form); document.body.append(d); d.showModal();
      });
    }
    async function saveRoute() {
      if (pts.length < 2) return;
      const got = await routeDialog('Save route', '', false, 'Save route');
      if (!got) return;
      try {
        await post('route_save', { map_id: map.id, name: got.name, points: pts.map(p => [p.x, p.y]), is_secret: got.secret }, cid);
        mode = null; pts = []; drawMeasure(); note.textContent = ''; syncTools();
        await refresh(); toast('Route saved');
      } catch (err) { toast(err.message, true); }
    }
    function renderRoutes() {
      routeBox.hidden = !routes.length;
      routeBox.replaceChildren(...(routes.length ? [el('h3', {}, 'Routes'), ...routes.map(r => el('div', { class: 'map-route' + (r.is_secret ? ' secret' : '') },
        el('button', { type: 'button', class: 'link map-route-name', 'data-tip': 'Show this route on the map', onclick: () => lf.map.fitBounds(routeLines.get(r.id).getBounds().pad(0.2)) }, r.is_secret ? '🔒 ' : '', r.name),
        el('span', { class: 'small muted map-route-len' }, lengthOf(r)),
        gm ? el('div', { class: 'row' },
          btn('Rename', async () => {
            const got = await routeDialog('Rename the route', r.name, null, 'Save');
            if (!got) return;
            try { await post('route_save', { id: r.id, name: got.name }, cid); await refresh(); } catch (err) { toast(err.message, true); }
          }, 'small'),
          (() => {
            const b = btn('GM only', async () => {
              try { await post('route_save', { id: r.id, is_secret: !r.is_secret }, cid); await refresh(); } catch (err) { toast(err.message, true); }
            }, 'small', 'Players never see a GM only route');
            b.setAttribute('aria-pressed', String(r.is_secret));
            return b;
          })(),
          btn('Delete', async () => {
            if (!await ctx.confirmDialog(`Delete the route "${r.name}"?`, { ok: 'Delete', danger: true })) return;
            try { await post('route_delete', { id: r.id }, cid); await refresh(); toast('Route deleted'); } catch (err) { toast(err.message, true); }
          }, 'small danger')) : null))] : []));
    }

    function onClick(ev) {
      const p = toXY(ev.latlng);
      if (mode === 'measure') { pts.push(p); drawMeasure(); }
      else if (mode === 'pin') {
        if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) { note.textContent = 'Click on the map\'s picture'; return; }
        mode = null; note.textContent = ''; syncTools(); pinForm(null, p);
      }
      else if (mode === 'scale') { picks = picks.length >= 2 ? [p] : [...picks, p]; drawPicks(); if (picks.length === 2) panelBox.querySelector('input[aria-label="How many squares"]')?.dispatchEvent(new Event('input')); }
    }

    // ---- the toolbar
    const measureBtn = btn('Measure', () => {
      if (mode === 'measure') { mode = null; pts = []; drawMeasure(); note.textContent = ''; return syncTools(); }
      if (!hasScale()) { note.textContent = gm ? 'Set the scale to measure' : 'The GM hasn\'t set this map\'s scale yet'; return; }
      if (mode === 'scale' || mode === 'pin') closePanel();
      mode = 'measure'; note.textContent = 'Click the map to lay down points'; syncTools();
    }, '', 'Click along a path to add up its length');
    const addPinBtn = btn('Add pin', () => {
      if (mode === 'pin') { closePanel(); note.textContent = ''; return; }
      if (mode === 'scale' || mode === 'measure') { if (mode === 'measure') { pts = []; drawMeasure(); } closePanel(); }
      panelBox.replaceChildren(); mode = 'pin'; note.textContent = 'Click the map to place the pin'; syncTools();
    }, '', 'Click the map to leave a pin there');
    addPinBtn.hidden = !map.image_url;
    const saveRouteBtn = btn('Save route…', () => saveRoute(), '', 'Keep the path you measured as a named route on this map');
    saveRouteBtn.hidden = true;
    const undoBtn = btn('Undo point', () => { pts.pop(); drawMeasure(); }, 'small');
    const clearBtn = btn('Clear', () => { pts = []; drawMeasure(); }, 'small');
    function syncTools() {
      const m = mode === 'measure';
      measureBtn.setAttribute('aria-pressed', String(m));
      addPinBtn.setAttribute('aria-pressed', String(mode === 'pin'));
      saveRouteBtn.hidden = !(gm && m && pts.length > 1);
      undoBtn.hidden = clearBtn.hidden = !m;
      total.hidden = !m;
      if (scaleBtn) scaleBtn.setAttribute('aria-pressed', String(mode === 'scale'));
      host.classList.toggle('picking', m || mode === 'scale' || mode === 'pin');
      // two quick taps while laying down points are two points, not a zoom
      lf?.map.doubleClickZoom[m || mode === 'scale' || mode === 'pin' ? 'disable' : 'enable']();
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
    tools.append(saveRouteBtn);
    toolbar.append(addPinBtn, measureBtn, undoBtn, clearBtn, total, tools, el('span', { class: 'map-toolbar-gap' }), scaleBtn, swap, gm ? btn('Rename', rename) : null, secretBtn, del);
    const title = el('h2', {}, map.name);

    ctx.mount(...ctx.campaignHeader('maps'), el('div', { class: 'card map-view' },
      el('div', { class: 'row map-head' }, el('a', { href: `#/c/${cid}/maps`, class: 'small' }, '← Maps'), title), toolbar, note, panelBox,
      el('div', { class: 'map-body' }, host, routeBox)));

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
    routeLayer = L.layerGroup().addTo(lmap);
    pinLayer = L.layerGroup().addTo(lmap);
    groupLayer = L.layerGroup().addTo(lmap);
    const bar = scaleControl(() => map, system).addTo(lmap);
    lf = { map: lmap, scale: bar };
    syncTools();
    lmap.on('click', onClick);
    // the map must know its size once it is on the page, and again whenever that changes
    let gone = false;
    const teardown = () => { if (gone) return; gone = true; ro.disconnect(); window.removeEventListener('hashchange', teardown); lmap.remove(); };
    // no animations here: Leaflet ignores a drag that starts while it is zooming, and a tap would land on a moving map
    const fit = () => { if (!host.isConnected) teardown(); else lmap.invalidateSize({ animate: false }); };
    const ro = new ResizeObserver(fit);
    window.addEventListener('hashchange', teardown);   // leaving the page (or reopening it) takes the map down at once
    ro.observe(host);
    drawRoutes(); renderRoutes(); drawPins(); drawGroups();
    requestAnimationFrame(() => {
      if (!host.isConnected || gone) return;
      lmap.invalidateSize({ animate: false }); lmap.fitBounds(bounds(), { animate: false });
      const want = pinMarkers.get(Number(params.get('pin')));   // a link back from an entry or event: centre on that pin and open its card
      const at = pins.find(q => q.id === Number(params.get('pin')));
      if (want && at) { lmap.setView(toLatLng(at.x, at.y), 0, { animate: false }); want.openPopup(); }
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

  return { view, marker, toLatLng, toXY, scaleControl };
})();
