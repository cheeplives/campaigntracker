/* web.js — the arithmetic behind the Encyclopedia's connection web and family tree: which entries are one or two steps
 * from another, where each sits on the page, and who is whose parent, partner and sibling.
 *
 * Plain script, no build step, and no page needed: app.js hands it the connections it already holds (connIndex's map of
 * entry id to [{ r, type, side, label, other }]) and the entries by id, and gets back nodes, edges and positions, so the
 * same file runs under Node in the tests. It only ever sees what the member was already sent, so a player's web holds
 * only what the server showed them.
 *
 * Nothing is random: the same connections give the same picture each time. */
'use strict';

const Web = (() => {
  // How a connection's label reads from the entry it is on, for the family tree. Matched on the words, so the starter
  // "Parent of / Child of", a Scabard import's "Mother of" and a GM's own "Married to" all count.
  const ROLES = [
    ['parent', /^(parent|mother|father|guardian|stepparent|step-parent|stepmother|stepfather)s? of$/i],
    ['child', /^(child|son|daughter|ward|stepchild|stepson|stepdaughter)(ren)? of$/i],
    ['partner', /^(partner|spouse|husband|wife|married|consort|lover|betrothed|fianc[eé]e?)( of| to| with)?$/i],
    ['sibling', /^(sibling|brother|sister|twin|half-sibling|half-brother|half-sister)s? of$/i],
  ];
  /** 'parent', 'child', 'partner' or 'sibling' for a label as read from one end, else null. */
  function roleOf(label) {
    const s = String(label || '').trim();
    for (const [role, re] of ROLES) if (re.test(s)) return role;
    return null;
  }

  /** One connection as the picture needs it: the ends in the order it was made, its kind and both readings. */
  function edgeOf(c) {
    const t = c.type;
    return { id: c.r.id, a: c.r.from_id, b: c.r.to_id, kind: t.id, color: t.color, label: t.label,
      inverse: t.symmetric ? '' : t.inverse_label, symmetric: !!t.symmetric, note: c.r.note || '', secret: !!c.r.is_secret };
  }
  const nodeOf = (e, depth) => ({ id: e.id, name: e.name, depth, secret: !!e.is_secret, category: e.category || null });
  const byDepthName = (x, y) => x.depth - y.depth || x.name.localeCompare(y.name);

  /** The entries within `depth` steps of `center` (hiding the connection kinds in `off`, a Set of type ids), with every
   * connection among them. Each node carries its distance from the centre. */
  function neighbourhood({ conns, byId }, center, depth = 1, off = new Set()) {
    const dist = new Map([[center, 0]]);
    let frontier = [center];
    for (let d = 1; d <= depth; d++) {
      const next = [];
      for (const id of frontier) for (const c of conns.get(id) || []) {
        if (off.has(c.type.id) || dist.has(c.other.id)) continue;
        dist.set(c.other.id, d); next.push(c.other.id);
      }
      frontier = next;
    }
    const edges = new Map();
    for (const id of dist.keys()) for (const c of conns.get(id) || []) {
      if (!off.has(c.type.id) && dist.has(c.other.id) && !edges.has(c.r.id)) edges.set(c.r.id, edgeOf(c));
    }
    const nodes = [...dist].map(([id, d]) => byId.get(id) && nodeOf(byId.get(id), d)).filter(Boolean).sort(byDepthName);
    return { nodes, edges: [...edges.values()] };
  }

  /** Every entry that has a connection, with all of them. Past `limit` entries only the most connected are kept, and
   * `cut` says how many were left out. */
  function whole({ conns, byId }, off = new Set(), limit = 250) {
    const edges = new Map(), degree = new Map();
    for (const [id, list] of conns) for (const c of list) {
      if (off.has(c.type.id)) continue;
      if (!edges.has(c.r.id)) edges.set(c.r.id, edgeOf(c));
      degree.set(id, (degree.get(id) || 0) + 1);
    }
    let ids = [...degree.keys()].filter(id => byId.has(id));
    const cut = Math.max(0, ids.length - limit);
    if (cut) ids = ids.sort((x, y) => degree.get(y) - degree.get(x) || byId.get(x).name.localeCompare(byId.get(y).name)).slice(0, limit);
    const keep = new Set(ids);
    return { nodes: ids.map(id => nodeOf(byId.get(id), 0)).sort(byDepthName),
      edges: [...edges.values()].filter(e => keep.has(e.a) && keep.has(e.b)), cut };
  }

  /** Where each node goes, as a Map of id to { x, y } inside width by height: a force layout (Fruchterman-Reingold) that
   * starts from rings around `center` (or one spiral when there is none), so a small web comes out tidy and the same
   * every time. The centre stays in the middle. */
  function layout(nodes, edges, { width = 900, height = 600, center = null, iterations = 260 } = {}) {
    const pos = new Map(), n = nodes.length;
    if (!n) return pos;
    const cx = width / 2, cy = height / 2, pad = 30;
    const maxD = Math.max(1, ...nodes.map(x => x.depth || 0));
    const R = Math.min(width, height) / 2 - pad;
    if (center != null) {
      const rings = new Map(), seen = new Map();
      for (const nd of nodes) rings.set(nd.depth || 0, (rings.get(nd.depth || 0) || 0) + 1);
      for (const nd of nodes) {
        const d = nd.depth || 0, i = seen.get(d) || 0;
        seen.set(d, i + 1);
        if (d === 0) { pos.set(nd.id, { x: cx, y: cy }); continue; }
        const a = (2 * Math.PI * i) / rings.get(d) + d * 0.6 - Math.PI / 2, r = (R * d) / maxD;
        pos.set(nd.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
    } else {
      nodes.forEach((nd, i) => {
        const a = i * 2.399963, r = R * Math.sqrt((i + 0.5) / n);
        pos.set(nd.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      });
    }
    if (n === 1) return pos;
    const ix = new Map(nodes.map((nd, i) => [nd.id, i]));
    const P = nodes.map(nd => pos.get(nd.id));
    const links = edges.map(e => [ix.get(e.a), ix.get(e.b)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
    const k = Math.sqrt((width * height) / n) * 0.7;
    const pinned = center != null ? ix.get(center) : -1;
    let t = Math.min(width, height) / 6;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let it = 0; it < iterations; it++) {
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let ux = P[i].x - P[j].x, uy = P[i].y - P[j].y, d2 = ux * ux + uy * uy;
        if (d2 < 0.01) { ux = (i % 2 ? 1 : -1) * 0.1; uy = (j % 2 ? 1 : -1) * 0.1; d2 = ux * ux + uy * uy; }
        const f = (k * k) / d2;           // repulsion k²/d, spread over the unit vector
        dx[i] += ux * f; dy[i] += uy * f; dx[j] -= ux * f; dy[j] -= uy * f;
      }
      for (const [a, b] of links) {
        const ux = P[a].x - P[b].x, uy = P[a].y - P[b].y, d = Math.sqrt(ux * ux + uy * uy) || 0.1, f = d / k;
        dx[a] -= ux * f; dy[a] -= uy * f; dx[b] += ux * f; dy[b] += uy * f;
      }
      for (let i = 0; i < n; i++) {
        if (i === pinned) continue;
        dx[i] -= (P[i].x - cx) * 0.04; dy[i] -= (P[i].y - cy) * 0.04;      // a pull to the middle keeps strays on the page
        const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01, lim = Math.min(len, t);
        P[i].x = Math.min(width - pad, Math.max(pad, P[i].x + (dx[i] / len) * lim));
        P[i].y = Math.min(height - pad, Math.max(pad, P[i].y + (dy[i] / len) * lim));
      }
      t *= 0.985;
    }
    return pos;
  }

  /** Whether entry `id` has a parent, child, partner or sibling connection (so a family tree is worth offering). */
  function hasFamily({ conns }, id) {
    return (conns.get(id) || []).some(c => roleOf(c.label));
  }

  /** The family around `center`: everyone reached through parent, child, partner and sibling connections, in rows by
   * generation (parents above children), partners side by side and children under their parents where there is room.
   * Returns { nodes: [{ id, name, gen, x, y, secret }], edges: [{ kind, ... }], width, rows }, x and y in slots. */
  function familyTree({ conns, byId }, center, limit = 80) {
    const parents = new Map(), partners = new Map(), siblings = new Map();   // id -> Set of ids
    const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
    const comp = new Set([center]);
    const queue = [center];
    while (queue.length && comp.size < limit) {
      const id = queue.shift();
      for (const c of conns.get(id) || []) {
        const role = roleOf(c.label), o = c.other.id;
        if (!role || !byId.has(o)) continue;
        if (role === 'parent') add(parents, o, id);                // o has id as a parent
        else if (role === 'child') add(parents, id, o);
        else if (role === 'partner') { add(partners, id, o); add(partners, o, id); }
        else { add(siblings, id, o); add(siblings, o, id); }
        if (!comp.has(o) && comp.size < limit) { comp.add(o); queue.push(o); }
      }
    }
    const inside = id => comp.has(id);
    // generations: parents one above their children, partners and siblings level
    const gen = new Map([[center, 0]]);
    for (let pass = 0; pass < comp.size + 2; pass++) {
      let moved = false;
      const set = (id, g) => { if (!gen.has(id)) { gen.set(id, g); moved = true; } };
      for (const [child, ps] of parents) for (const p of ps) {
        if (!inside(child) || !inside(p)) continue;
        if (gen.has(p)) set(child, gen.get(p) + 1);
        if (gen.has(child)) set(p, gen.get(child) - 1);
      }
      for (const m of [partners, siblings]) for (const [a, bs] of m) for (const b of bs) {
        if (!inside(a) || !inside(b)) continue;
        if (gen.has(a)) set(b, gen.get(a));
      }
      if (!moved) break;
    }
    for (const id of comp) if (!gen.has(id)) gen.set(id, 0);
    const minGen = Math.min(...gen.values());
    const rows = new Map();
    for (const id of comp) {
      const g = gen.get(id) - minGen;
      if (!rows.has(g)) rows.set(g, []);
      rows.get(g).push(id);
    }
    const name = id => byId.get(id).name;
    const x = new Map();
    for (const g of [...rows.keys()].sort((a, b) => a - b)) {
      const ids = rows.get(g).sort((a, b) => name(a).localeCompare(name(b)));
      // partners (in this row) form a unit that stays together
      const unitOf = new Map(), units = [];
      for (const id of ids) {
        if (unitOf.has(id)) continue;
        const unit = [], stack = [id];
        while (stack.length) {
          const u = stack.pop();
          if (unitOf.has(u)) continue;
          unitOf.set(u, unit); unit.push(u);
          for (const p of partners.get(u) || []) if (ids.includes(p)) stack.push(p);
        }
        unit.sort((a, b) => name(a).localeCompare(name(b)));
        units.push(unit);
      }
      const want = unit => {                                       // the middle of the members' parents, if placed
        const xs = unit.flatMap(m => [...(parents.get(m) || [])].filter(p => x.has(p)).map(p => x.get(p)));
        return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
      };
      units.sort((u, v) => {
        const a = want(u), b = want(v);
        return (a ?? Infinity) - (b ?? Infinity) || name(u[0]).localeCompare(name(v[0])) || 0;
      });
      let cursor = 0;
      for (const unit of units) {
        const w = want(unit);
        const at = Math.max(cursor, w === null ? cursor : w - (unit.length - 1) / 2);
        unit.forEach((m, i) => x.set(m, at + i));
        cursor = at + unit.length + 0.5;
      }
    }
    const left = Math.min(...x.values());
    const nodes = [...comp].map(id => ({ id, name: name(id), gen: gen.get(id) - minGen, x: x.get(id) - left, y: gen.get(id) - minGen,
      secret: !!byId.get(id).is_secret })).sort((a, b) => a.y - b.y || a.x - b.x);
    const edges = [], seenPair = new Set();
    for (const [child, ps] of parents) for (const p of ps) if (inside(child) && inside(p)) edges.push({ kind: 'parent', parent: p, child });
    for (const [kind, m] of [['partner', partners], ['sibling', siblings]]) for (const [a, bs] of m) for (const b of bs) {
      const key = `${kind}:${Math.min(a, b)}:${Math.max(a, b)}`;
      if (a === b || seenPair.has(key) || !inside(a) || !inside(b)) continue;
      seenPair.add(key);
      // siblings who share a parent are already joined through it
      if (kind === 'sibling' && [...(parents.get(a) || [])].some(p => parents.get(b)?.has(p))) continue;
      edges.push({ kind, a, b });
    }
    return { nodes, edges, width: Math.max(...nodes.map(nd => nd.x)) + 1, rows: Math.max(...nodes.map(nd => nd.y)) + 1 };
  }

  /** The kinds of connection among `edges`, most used first: [{ kind, label, inverse, color, count }]. */
  function kinds(edges) {
    const m = new Map();
    for (const e of edges) {
      if (!m.has(e.kind)) m.set(e.kind, { kind: e.kind, label: e.label, inverse: e.inverse, color: e.color, count: 0 });
      m.get(e.kind).count++;
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  return { roleOf, neighbourhood, whole, layout, familyTree, hasFamily, kinds };
})();

if (typeof module !== 'undefined') module.exports = Web;
