/* clocks-tab.js — Clocks: circles cut into segments that fill as something comes closer (a plot, a danger, a long job).
 *
 * The Clocks tab (under Play) lists them all; At the Table has a folded Clocks box of the running ones, and the panel
 * shows the ones players may see. Any member makes a clock: a GM's is drawn in the theme's colour, a player's in a
 * second colour with a dashed rim, so the table can tell them apart at a glance. Its maker and GMs fill it, by
 * pressing a segment or − and +. api/clocks.php says who sees and changes what.
 *
 * app.js calls make() once with its shared helpers and state (tabCtx). Plain script, no build step. */
(function (root) {
  'use strict';
  function make(ctx) {
    const { E, S, api, btn, busy, cal, campaignHeader, clean, confirmDialog, el, field, hideTip, isGM, mount, post, select, tip, toast } = ctx;

    const VIS = [['shown', 'Shown', 'Everyone sees the clock and how full it is'],
      ['vague', 'Vague', 'Everyone sees the clock is there, but only its maker and GMs see how full it is'],
      ['secret', 'Secret', 'Only GMs see this clock']];
    const SIZES = [4, 6, 8, 12];
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const canChange = c => !!c.mine && !S.viewAs;
    const full = c => c.filled !== null && c.filled >= c.segments;
    const countText = c => (c.filled === null ? `${c.segments} segments` : `${c.filled} of ${c.segments}`);
    const href = () => `#/c/${S.camp.id}/clocks`;

    /** The clock drawn: a circle of segments, the filled ones coloured, starting at the top and going clockwise. When
     * onSet is given, pressing segment k fills the clock to k (or, on the last one filled, takes that one off). */
    function clockFace(c, { size = 96, onSet = null } = {}) {
      const n = c.segments, r = 46, cx = 50, cy = 50;
      const s = svg('svg', { viewBox: '0 0 100 100', width: size, height: size, class: 'clock-svg', 'aria-hidden': onSet ? 'false' : 'true', role: onSet ? 'group' : 'img' });
      if (!onSet) s.setAttribute('aria-label', `${c.name}: ${countText(c)}`);
      s.append(svg('circle', { cx, cy, r: r + 2, class: 'clock-rim' }));
      const at = a => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
      for (let k = 0; k < n; k++) {
        const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n;
        const [x0, y0] = at(a0), [x1, y1] = at(a1);
        const on = c.filled !== null && k < c.filled;
        const seg = svg('path', { d: `M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
          class: 'clock-seg' + (on ? ' on' : '') + (c.filled === null ? ' unknown' : '') });
        if (onSet) {
          const to = c.filled === k + 1 ? k : k + 1;
          seg.setAttribute('tabindex', '0');
          seg.setAttribute('role', 'button');
          seg.setAttribute('aria-label', `Set ${c.name} to ${to} of ${n}`);
          const go = ev => { ev.preventDefault(); ev.stopPropagation(); onSet(to); };
          seg.addEventListener('click', go);
          seg.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') go(ev); });
        }
        s.append(seg);
      }
      if (c.filled === null) { const q = svg('text', { x: cx, y: cy + 9, class: 'clock-q', 'text-anchor': 'middle' }); q.textContent = '?'; s.append(q); }
      return el('span', { class: 'clock-face' + (c.by_gm ? '' : ' player') + (full(c) ? ' full' : ''), 'data-tip': onSet ? 'Press a segment to fill the clock up to it; press the last filled one to take it off' : null }, s);
    }

    /** Fill or empty clock c by `by`, then hand the clock as it now stands to after(). */
    async function tick(c, by, after) {
      if (!by) return;
      const r = await post('clock_tick', { id: c.id, by }, S.camp.id);
      if (full(r.clock) && !full(c)) toast(`${r.clock.name} is full`);
      after(r.clock);
    }
    const badges = c => clean([
      c.by_gm ? null : el('span', { class: 'chip clock-who', 'data-tip': `A player's clock${c.author ? `, made by ${c.author}` : ''}` }, '🙋 Player'),
      c.visibility === 'secret' ? el('span', { class: 'secret-tag', 'data-tip': 'Only GMs can see this clock' }, '🔒 SECRET') : null,
      c.visibility === 'vague' ? el('span', { class: 'chip clock-vague', 'data-tip': VIS[1][2] }, '👁 Vague') : null,
      full(c) ? el('span', { class: 'chip clock-full' }, 'Full') : null,
      c.archived ? el('span', { class: 'chip' }, 'Put away') : null]);
    const plusMinus = (c, after) => el('span', { class: 'clock-pm' },
      btn('−', ev => busy(ev.currentTarget, () => tick(c, -1, after))(), 'small', `Take a segment off ${c.name}`),
      btn('+', ev => busy(ev.currentTarget, () => tick(c, 1, after))(), 'small primary', `Fill a segment of ${c.name}`));
    const entryLink = c => (c.entry ? el('a', { class: 'small', href: `#/c/${S.camp.id}/encyclopedia/${c.entry.id}`, 'data-tip': 'Open the Encyclopedia entry this clock is about' }, `📖 ${c.entry.name}`) : null);
    const tickLine = t => el('li', {}, `${t.author || 'Someone'} ${t.delta > 0 ? `filled ${t.delta}` : `took off ${-t.delta}`} → ${t.filled}`,
      el('span', { class: 'muted' }, t.abs_shift !== null ? ` · ${E.fmtShift(cal(), t.abs_shift)}` : ''));

    /** A clock on the Clocks tab: the face, what it is, and (for its maker and GMs) the ways to change it. */
    function clockCard(c, redraw) {
      const card = el('article', { class: 'card clock-card' + (c.by_gm ? '' : ' player') + (c.visibility === 'secret' ? ' secret' : '') + (c.archived ? ' archived' : ''), 'data-clock': c.id });
      const after = nc => { Object.assign(c, nc); card.replaceWith(clockCard(c, redraw)); };
      const edit = canChange(c) ? btn('Edit', () => clockDialog(c).then(nc => nc && after(nc)), 'small', 'Change this clock') : null;
      const more = canChange(c) ? KIT.menu({ label: '⋯', ariaLabel: `More for ${c.name}`, cls: 'more-menu', items: [
        btn(c.archived ? 'Bring back' : 'Put away', busy(null, async () => {
          const r = await post('clock_save', { id: c.id, name: c.name, description: c.description, segments: c.segments, filled: c.filled, visibility: c.visibility,
            entry_id: c.entry?.id || null, archived: !c.archived }, S.camp.id);
          Object.assign(c, r.clock); redraw();
        }), '', c.archived ? 'Put it back with the running clocks' : 'Take it off At the Table and the running list. It keeps its history'),
        btn('Delete', busy(null, async () => {
          if (!await confirmDialog(`Delete the clock "${c.name}" and its history?`, { ok: 'Delete', danger: true })) return;
          await post('clock_delete', { id: c.id }, S.camp.id);
          c.deleted = true; redraw();
        }), 'danger', 'Delete this clock for good')] }) : null;
      card.append(
        clockFace(c, { size: 112, onSet: canChange(c) ? to => busy(null, () => tick(c, to - c.filled, after))() : null }),
        el('div', { class: 'clock-body' },
          el('div', { class: 'clock-title' }, el('h3', {}, c.name), ...badges(c)),
          el('div', { class: 'clock-count' }, countText(c), c.filled === null ? el('span', { class: 'muted small' }, ' · how full is hidden') : null),
          c.description ? el('p', { class: 'clock-desc' }, c.description) : null,
          entryLink(c),
          el('small', { class: 'muted' }, c.author ? `Made by ${c.author}` : 'Made', ` on ${String(c.created_at).slice(0, 10)}`),
          canChange(c) ? el('div', { class: 'row clock-actions' }, plusMinus(c, after), edit, more) : null,
          c.ticks.length ? el('details', { class: 'clock-log' }, el('summary', { class: 'small' }, `History (${c.ticks.length})`), el('ul', { class: 'small' }, c.ticks.map(tickLine))) : null));
      return card;
    }

    /** Make or change a clock. Resolves with the clock as saved, or null. */
    function clockDialog(c = {}) {
      hideTip();
      return new Promise(resolve => {
        const name = el('input', { maxlength: 120, value: c.name || '', required: true, placeholder: 'e.g. The cult finishes the ritual' });
        const desc = el('textarea', { rows: 3, maxlength: 1000, placeholder: 'What happens when it fills, and what moves it' }, c.description || '');
        const segs = el('input', { type: 'number', min: 2, max: 24, value: c.segments || 4, 'aria-label': 'Segments', class: 'clock-num' });
        const quick = el('div', { class: 'seg' }, SIZES.map(nn => btn(String(nn), () => { segs.value = nn; sync(); }, '', `${nn} segments`)));
        const filled = el('input', { type: 'number', min: 0, max: 24, value: c.filled ?? 0, 'aria-label': 'Filled', class: 'clock-num' });
        const vis = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Who sees it' }, VIS.filter(([k]) => k !== 'secret' || isGM()).map(([k, label, t]) =>
          el('label', { 'data-tip': t }, el('input', { type: 'radio', name: 'clock-vis', value: k, checked: (c.visibility || 'shown') === k }), el('span', {}, label))));
        const visible = (S.encyclopedia || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        const entry = el('input', { list: 'clock-entries', value: c.entry?.name || '', placeholder: 'None', autocomplete: 'off', 'aria-label': 'Encyclopedia entry' });
        const list = el('datalist', { id: 'clock-entries' }, visible.map(e => el('option', { value: e.name })));
        const preview = el('div', { class: 'clock-preview' });
        const sync = () => {
          const n = Math.max(2, Math.min(24, Number(segs.value) || 4));
          filled.max = n;
          quick.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.textContent) === n));
          preview.replaceChildren(clockFace({ name: name.value || 'New clock', segments: n, filled: Math.min(n, Math.max(0, Number(filled.value) || 0)), by_gm: c.id ? c.by_gm : isGM() }, { size: 72 }));
        };
        [segs, filled, name].forEach(i => i.addEventListener('input', sync));
        sync();
        const err = el('p', { class: 'bad small', hidden: true });
        const save = el('button', { class: 'primary', type: 'submit' }, c.id ? 'Save clock' : 'Add clock');
        const title = c.id ? `Edit ${c.name}` : 'New clock';
        const d = el('dialog', { class: 'kit-dialog clock-dialog', 'aria-label': title },
          el('form', { novalidate: true },
            el('h3', {}, title),
            field('Name', name),
            field('Description', desc),
            el('div', { class: 'clock-dialog-row' },
              el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Segments'), el('div', { class: 'row' }, quick, segs)),
              el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Filled'), filled),
              preview),
            el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Who sees it', tip('Shown: everyone sees how full it is. Vague: players see it is there, not how full. Secret: GMs only.')), vis),
            field('About an Encyclopedia entry', el('div', {}, entry, list), 'Optional: the person, place or group this clock is about'),
            err,
            el('div', { class: 'kit-dialog-actions' }, save, el('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
        let saved = null;
        d.addEventListener('close', () => { d.remove(); resolve(saved); });
        d.querySelector('form').addEventListener('submit', busy(save, async ev => {
          ev.preventDefault();
          err.hidden = true;
          const bad = (msg, box) => { err.textContent = msg; err.hidden = false; box?.focus(); };
          if (!name.value.trim()) return bad('Give the clock a name.', name);
          const n = Number(segs.value);
          if (!Number.isInteger(n) || n < 2 || n > 24) return bad('A clock has 2 to 24 segments.', segs);
          const want = entry.value.trim().toLowerCase();
          const e = want ? visible.find(x => x.name.toLowerCase() === want || (x.aliases || []).some(a => a.toLowerCase() === want)) : null;
          if (want && !e && want !== (c.entry?.name || '').toLowerCase()) return bad('Pick an entry from the list, or leave it empty.', entry);
          const body = { id: c.id, name: name.value, description: desc.value, segments: n, visibility: d.querySelector('input[name=clock-vis]:checked')?.value || 'shown',
            entry_id: e?.id || (want ? c.entry?.id : null) || null, archived: !!c.archived };
          if (c.filled !== null || !c.id) body.filled = Math.min(n, Math.max(0, Number(filled.value) || 0));
          const r = await post('clock_save', body, S.camp.id);
          saved = r.clock;
          toast(c.id ? 'Clock saved' : 'Clock added');
          d.close();
        }));
        document.body.append(d);
        d.showModal();
        name.focus();
      });
    }

    // ------------------------------------------------------------ the Clocks tab
    const SHOWS = [['running', 'Running'], ['full', 'Full'], ['away', 'Put away'], ['all', 'All']];
    const shows = { running: c => !c.archived && !full(c), full: c => !c.archived && full(c), away: c => c.archived, all: () => true };
    async function viewClocks() {
      const { clocks } = await api('clocks', { query: { cid: S.camp.id } });
      const st = ctx.vs().clocks || (ctx.vs().clocks = { show: 'running', who: '' });
      const grid = el('div', { class: 'clock-grid' });
      const filters = el('div', { class: 'row clock-filters' });
      const draw = () => {
        const live = clocks.filter(c => !c.deleted);
        const byWho = live.filter(c => !st.who || (st.who === 'gm') === c.by_gm);
        const shown = byWho.filter(shows[st.show]);
        filters.replaceChildren(
          el('div', { class: 'seg', role: 'group', 'aria-label': 'Which clocks' }, SHOWS.map(([k, label]) => {
            const b = btn(`${label} (${byWho.filter(shows[k]).length})`, () => { st.show = k; draw(); }, st.show === k ? 'on' : '');
            b.setAttribute('aria-pressed', String(st.show === k));
            return b;
          })),
          el('div', { class: 'tagpick' }, [['gm', 'GM clocks'], ['player', 'Player clocks']].map(([k, label]) => {
            const on = st.who === k;
            return el('button', { type: 'button', class: `tagopt clock-tag-${k}` + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => { st.who = on ? '' : k; draw(); } },
              el('span', { class: 'tick', 'aria-hidden': 'true' }, on ? '✓ ' : ''), `${label} (${live.filter(c => (k === 'gm') === c.by_gm).length})`);
          })));
        grid.replaceChildren(...(shown.length ? shown.map(c => clockCard(c, draw))
          : [el('p', { class: 'muted clock-empty' }, live.length ? 'No clocks here. Try another filter.'
            : 'No clocks yet. A clock is a circle of segments that fills as something comes closer: a rival\'s plan, a storm, a long job. Make one with + New clock.')]));
      };
      draw();
      const add = btn('+ New clock', async () => { const c = await clockDialog(); if (c) { clocks.unshift(c); st.show = full(c) ? 'full' : 'running'; draw(); } },
        'primary new-btn', 'Make a clock. GMs and players can both make them');
      if (S.viewAs) add.disabled = true;
      // the title, + New clock and the filters in a card along the top, as on Characters, Maps and the other tabs
      mount(...campaignHeader('clocks'), el('section', { class: 'clock-page' },
        el('div', { class: 'card clock-top' },
          el('div', { class: 'row spread clock-head' }, el('h2', {}, 'Clocks', tip('Circles of segments that fill as something comes closer. Anyone can make one; a player\'s is drawn in its own colour with a dashed rim. Its maker and GMs fill it by pressing a segment, or − and +. Running ones show on At the Table.')), add),
          filters),
        grid));
    }

    // ------------------------------------------------------------ At the Table
    /** The running clocks, small, with − and + on the ones this member can fill. dayBox comes from app.js. */
    async function tableClocks(dayBox) {
      let clocks;
      try { clocks = (await api('clocks', { query: { cid: S.camp.id } })).clocks.filter(c => !c.archived); } catch { return null; }
      const list = el('div', { class: 'clock-mini-list' });
      const row = c => {
        const r = el('div', { class: 'clock-mini' + (c.by_gm ? '' : ' player') });
        const after = nc => { Object.assign(c, nc); r.replaceWith(row(c)); sum.textContent = summary(); };
        r.append(clockFace(c, { size: 52, onSet: canChange(c) ? to => busy(null, () => tick(c, to - c.filled, after))() : null }),
          el('div', { class: 'clock-mini-body' }, el('b', {}, c.name), ' ', ...badges(c), el('div', { class: 'small muted' }, countText(c))),
          canChange(c) ? plusMinus(c, after) : null);
        return r;
      };
      const summary = () => (clocks.length ? `${clocks.length} running${clocks.some(full) ? `, ${clocks.filter(full).length} full` : ''}` : 'None running');
      list.append(...(clocks.length ? clocks.map(row) : [el('p', { class: 'muted small' }, 'No clocks running.')]));
      const add = S.viewAs ? null : btn('+ New clock', async () => { const c = await clockDialog(); if (c) { clocks.unshift(c); list.querySelector('p.muted')?.remove(); list.prepend(row(c)); sum.textContent = summary(); } },
        'new-btn', 'Make a clock. GMs and players can both make them');
      const box = dayBox('clocks', 'Clocks', { folded: true, tip: 'Clocks that are running: press a segment, or − and +, to fill one you made (a GM fills any). All of them are on the Clocks tab', summary: summary(),
        actions: [add, el('a', { class: 'button small', href: href() }, 'All clocks')] }, list);
      const sum = box.querySelector('.daybox-sum');
      return box;
    }
    /** The panel's clocks: the running ones players may see, read only. */
    async function panelClocks() {
      let clocks;
      try { clocks = (await api('clocks', { query: { cid: S.camp.id } })).clocks.filter(c => !c.archived); } catch { return null; }
      if (!clocks.length) return null;
      return el('section', { class: 'tv-sec' }, el('b', {}, 'Clocks'), el('div', { class: 'clock-mini-list' }, clocks.map(c =>
        el('div', { class: 'clock-mini' + (c.by_gm ? '' : ' player') }, clockFace(c, { size: 52 }),
          el('div', { class: 'clock-mini-body' }, el('b', {}, c.name), ' ', ...badges(c), el('div', { class: 'small muted' }, countText(c)))))));
    }

    return { viewClocks, tableClocks, panelClocks, clockFace };
  }
  root.ClocksTab = { make };
})(typeof window !== 'undefined' ? window : globalThis);
