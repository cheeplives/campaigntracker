/* web-view.js — the dialog that draws the Encyclopedia's connection web and family tree (the arithmetic is in web.js).
 *
 * Plain script, no build step. Encyclopedia tab hands it the connections it already holds and says which entry to centre
 * on; everything drawn is something the member was already sent. Pan by dragging, zoom with the wheel or the buttons,
 * click an entry to see its connections and to centre the picture on it. The list beside the picture says the same in
 * words, for screen readers and for anyone who would rather read than look. */
'use strict';

const WebView = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, ...kids) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  /** Open the dialog. conns / byId: connIndex's map and the entries by id. center: an entry id, or null for the whole
   * campaign. mode: 'web' or 'family' (needs a centre). href(id): where an entry's page is. */
  function open({ conns, byId, center = null, mode = 'web', href, campaignName = '' }) {
    const { el } = KIT;
    const st = { center, mode: center === null ? 'campaign' : mode, depth: 1, off: new Set(), pick: center, vb: null, cut: 0 };
    const stage = el('div', { class: 'web-stage' });
    const svg = sv('svg', { class: 'web-svg', role: 'group', 'aria-label': 'Connections', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
    const panel = el('div', { class: 'web-panel', 'aria-live': 'polite' });
    const legend = el('div', { class: 'web-legend', role: 'group', 'aria-label': 'Kinds of connection' });
    const note = el('p', { class: 'small muted web-note' });
    const title = el('h3', {});
    const dlg = el('dialog', { class: 'kit-dialog web-dialog', 'aria-label': 'Connection web' });
    const modeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'View' });
    const depthSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Steps out' });
    const seg = (parent, items, cur, set) => {
      parent.replaceChildren(...items.map(([v, label, tip]) => el('button', { type: 'button', class: v === cur ? 'on' : '', 'aria-pressed': v === cur ? 'true' : 'false', 'data-tip': tip, onclick: () => set(v) }, label)));
    };

    const nameOf = id => byId.get(id)?.name || '?';
    /** The viewBox that fits the drawn content, with a margin. */
    function fit(w, h) { st.vb = { x: -20, y: -20, w: w + 40, h: h + 40 }; setVb(); }
    function setVb() { svg.setAttribute('viewBox', `${st.vb.x} ${st.vb.y} ${st.vb.w} ${st.vb.h}`); }
    function zoom(f, px = 0.5, py = 0.5) {
      const v = st.vb, nw = Math.min(Math.max(v.w * f, 120), 6000), nh = nw * (v.h / v.w);
      st.vb = { x: v.x + (v.w - nw) * px, y: v.y + (v.h - nh) * py, w: nw, h: nh };
      setVb();
    }

    function select(id) { st.pick = id; draw(false); }
    function recentre(id) { st.center = id; st.pick = id; if (st.mode === 'campaign') st.mode = 'web'; draw(true); }

    function side(id, graphEdges) {
      const e = byId.get(id);
      if (!e) { panel.replaceChildren(el('p', { class: 'muted' }, 'Click an entry to see how it is connected.')); return; }
      const list = (conns.get(id) || []).filter(c => !st.off.has(c.type.id));
      const rows = list.map(c => el('li', {}, el('span', { class: 'chip enc-rel', style: { background: c.type.color } }, c.label), ' ',
        el('a', { class: 'enc-link', href: href(c.other.id) }, c.other.name), c.r.note ? el('small', { class: 'muted' }, ` (${c.r.note})`) : null,
        c.r.is_secret ? el('span', { 'data-tip': 'GM only' }, ' 🔒') : null));
      panel.replaceChildren(
        el('h4', {}, e.is_secret ? '🔒 ' : '', e.name),
        el('div', { class: 'row' },
          el('a', { class: 'button small primary', href: href(id), 'data-act': 'open' }, 'Open page'),
          st.center !== id ? el('button', { type: 'button', class: 'small', 'data-act': 'centre', onclick: () => recentre(id) }, st.mode === 'campaign' ? 'Show its web' : 'Centre here') : null,
          st.mode === 'web' && Web.hasFamily({ conns }, id) ? el('button', { type: 'button', class: 'small', onclick: () => { st.center = id; st.mode = 'family'; draw(true); } }, '🌳 Family') : null),
        rows.length ? el('ul', { class: 'web-list' }, rows) : el('p', { class: 'muted small' }, 'No connections shown.'));
    }

    function drawWeb() {
      // the page is laid out at the size it is shown, so the labels are readable and the picture fills the stage
      const W = Math.max(480, stage.clientWidth), H = Math.max(360, stage.clientHeight);
      const g = st.mode === 'campaign' ? Web.whole({ conns, byId }, st.off) : Web.neighbourhood({ conns, byId }, st.center, st.depth, st.off);
      st.cut = g.cut || 0;
      const pos = Web.layout(g.nodes, g.edges, { width: W, height: H, center: st.mode === 'campaign' ? null : st.center });
      const near = new Set(), hot = new Set();
      if (st.pick !== null) for (const e of g.edges) if (e.a === st.pick || e.b === st.pick) { near.add(e.a); near.add(e.b); hot.add(e.id); }
      const lines = g.edges.filter(e => pos.has(e.a) && pos.has(e.b)).map(e => {
        const a = pos.get(e.a), b = pos.get(e.b);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const arrow = !e.symmetric ? sv('path', { d: `M ${b.x - ux * 13} ${b.y - uy * 13} l ${-ux * 9 - uy * 4.5} ${-uy * 9 + ux * 4.5} l ${uy * 9} ${-ux * 9} z`, fill: e.color }) : null;
        const dim = st.pick !== null && !hot.has(e.id);
        return sv('g', { class: 'web-edge' + (hot.has(e.id) ? ' hot' : '') + (dim ? ' dim' : ''), 'data-edge': e.id },
          sv('title', {}, `${nameOf(e.a)} ${e.label} ${nameOf(e.b)}${e.secret ? ' (GM only)' : ''}`),
          sv('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: e.color, 'stroke-width': hot.has(e.id) ? 3 : 1.6, 'stroke-dasharray': e.secret ? '5 4' : null }), arrow);
      });
      const dots = g.nodes.map(nd => {
        const p = pos.get(nd.id), isC = nd.id === st.center, sel = nd.id === st.pick;
        const dim = st.pick !== null && !sel && !near.has(nd.id);
        return sv('g', { class: 'web-node' + (isC ? ' centre' : '') + (sel ? ' sel' : '') + (dim ? ' dim' : '') + (nd.secret ? ' secret' : ''), tabindex: 0, role: 'button',
          'aria-label': `${nd.name}${nd.secret ? ' (GM only)' : ''}`, 'data-node': nd.id, transform: `translate(${p.x} ${p.y})`,
          onclick: ev => { ev.stopPropagation(); select(nd.id); }, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(nd.id); } } },
          sv('rect', { class: 'hit', x: -42, y: -15, width: 84, height: 48, fill: 'transparent' }), sv('circle', { r: isC ? 13 : 9 }), sv('text', { y: isC ? 28 : 23, 'text-anchor': 'middle' }, clip(nd.name, 22)));
      });
      svg.replaceChildren(sv('g', { class: 'web-edges' }, lines), sv('g', { class: 'web-nodes' }, dots));
      g.W = W; g.H = H;
      return g;
    }

    function drawFamily() {
      const f = Web.familyTree({ conns, byId }, st.center);
      const CW = 150, CH = 40, GX = 175, GY = 100;
      const at = new Map(f.nodes.map(n => [n.id, { x: n.x * GX, y: n.y * GY }]));
      const edges = f.edges.map(e => {
        if (e.kind === 'parent') {
          const p = at.get(e.parent), c = at.get(e.child), my = (p.y + CH + c.y) / 2;
          return sv('path', { class: 'web-fam parent', d: `M ${p.x + CW / 2} ${p.y + CH} V ${my} H ${c.x + CW / 2} V ${c.y}`, fill: 'none' });
        }
        const a = at.get(e.a), b = at.get(e.b);
        if (e.kind === 'partner') return sv('line', { class: 'web-fam partner', x1: a.x + CW, y1: a.y + CH / 2, x2: b.x, y2: b.y + CH / 2 });
        return sv('path', { class: 'web-fam sibling', d: `M ${a.x + CW / 2} ${a.y} q ${(b.x - a.x) / 2} -26 ${b.x - a.x} 0`, fill: 'none' });
      });
      const boxes = f.nodes.map(nd => {
        const p = at.get(nd.id), isC = nd.id === st.center, sel = nd.id === st.pick;
        return sv('g', { class: 'web-person' + (isC ? ' centre' : '') + (sel ? ' sel' : '') + (nd.secret ? ' secret' : ''), tabindex: 0, role: 'button', 'aria-label': nd.name, 'data-node': nd.id,
          transform: `translate(${p.x} ${p.y})`, onclick: ev => { ev.stopPropagation(); select(nd.id); }, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(nd.id); } } },
          sv('rect', { width: CW, height: CH, rx: 6 }), sv('text', { x: CW / 2, y: CH / 2 + 5, 'text-anchor': 'middle' }, clip(nd.name, 20)));
      });
      svg.replaceChildren(sv('g', {}, edges), sv('g', {}, boxes));
      return { w: Math.max(0, (f.width - 1)) * GX + CW, h: (f.rows - 1) * GY + CH, nodes: f.nodes, edges: [] };
    }

    function draw(refit) {
      const family = st.mode === 'family';
      title.textContent = st.mode === 'campaign' ? `${campaignName ? `${campaignName}: ` : ''}every connection` : family ? `${nameOf(st.center)}: family` : `${nameOf(st.center)}: connections`;
      seg(modeSeg, st.center === null ? [] : [['web', 'Web', 'Who this entry is connected to'], ['family', '🌳 Family tree', 'Parents, partners, children and siblings, in generations']], st.mode, v => { st.mode = v; draw(true); });
      seg(depthSeg, st.mode === 'web' ? [[1, '1 step', 'Only direct connections'], [2, '2 steps', 'Connections of connections']] : [], st.depth, v => { st.depth = v; draw(true); });
      let g;
      if (family) { g = drawFamily(); if (refit || !st.vb) fit(g.w, g.h); }
      else { g = drawWeb(); if (refit || !st.vb) fit(g.W, g.H); }
      // the kinds in use, as switches: a kind switched off keeps its chip (outlined) so it can be switched back on
      const all = st.mode === 'campaign' ? Web.whole({ conns, byId }).edges : Web.neighbourhood({ conns, byId }, st.center, st.depth).edges;
      const used = family ? [] : Web.kinds(all);
      legend.replaceChildren(...used.map(k => el('button', { type: 'button', class: 'chip web-kind', 'aria-pressed': st.off.has(k.kind) ? 'false' : 'true', 'data-kind': k.kind,
        style: { background: st.off.has(k.kind) ? 'transparent' : k.color, color: st.off.has(k.kind) ? 'var(--dim)' : '#fff', borderColor: k.color },
        'data-tip': k.inverse ? `${k.label} / ${k.inverse}: click to hide or show` : `${k.label}: click to hide or show`,
        onclick: () => { st.off.has(k.kind) ? st.off.delete(k.kind) : st.off.add(k.kind); draw(false); } }, `${k.label} ${k.count}`)));
      note.textContent = family ? (f_empty(g) ? 'No parent, child, partner or sibling connections yet. Connect them with Parent of, Partner of or Sibling of.' : 'Parents above children. Click a person to look at them, then Centre here to see their family.')
        : st.cut ? `Showing the ${g.nodes.length} most connected entries (${st.cut} more are left out). Hide a kind of connection to see more.`
        : g.nodes.length < 2 ? 'Nothing is connected to this entry yet. Use 🔗 Link on its page.' : 'Click an entry to see how it is connected. Drag to move, scroll to zoom.';
      side(st.pick ?? st.center, g);
    }
    const f_empty = g => g.nodes.length < 2;

    // pan and zoom
    let drag = null;
    svg.addEventListener('pointerdown', ev => { if (ev.target.closest('[data-node]')) return; drag = { x: ev.clientX, y: ev.clientY, vb: { ...st.vb } }; svg.setPointerCapture(ev.pointerId); });
    svg.addEventListener('pointermove', ev => {
      if (!drag) return;
      const r = svg.getBoundingClientRect(), s = Math.max(drag.vb.w / r.width, drag.vb.h / r.height);
      st.vb = { ...drag.vb, x: drag.vb.x - (ev.clientX - drag.x) * s, y: drag.vb.y - (ev.clientY - drag.y) * s }; setVb();
    });
    const stop = () => { drag = null; };
    svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop);
    svg.addEventListener('wheel', ev => { ev.preventDefault(); const r = svg.getBoundingClientRect(); zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height); }, { passive: false });
    svg.addEventListener('click', () => { if (st.pick !== null && st.mode === 'campaign') { st.pick = null; draw(false); } });

    const close = () => { dlg.close(); };
    dlg.append(
      el('div', { class: 'web-head' }, title, el('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: close }, '✕')),
      el('div', { class: 'web-tools' }, modeSeg, depthSeg,
        el('span', { class: 'seg' }, el('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoom(1 / 1.3) }, '+'), el('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoom(1.3) }, '−'),
          el('button', { type: 'button', onclick: () => draw(true) }, 'Fit'))),
      legend, note,
      el('div', { class: 'web-body' }, stage, panel));
    stage.append(svg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', ev => { if (ev.target === dlg) close(); });
    document.body.append(dlg);
    dlg.showModal();
    draw(true);
    return dlg;
  }

  return { open };
})();
