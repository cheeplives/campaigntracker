/* tour.js — the welcome tutorial's engine: a run of tips, each pointing at one part of the page.
 *
 * Tour.run(steps, { label, onEnd }) shows the steps one at a time in a modal layer over the page. Each step is
 * { title, text, at }, where `at` is a CSS selector (or a list of them, the first one showing wins) for the part of the
 * page the tip is about, which is ringed and scrolled into view. A step with no `at`, or whose part isn't showing on this
 * screen (a tab tucked into the iPad's drawer, a GM's button for a player), is shown in the middle with nothing ringed;
 * a step marked `optional` is left out instead. Steps may be functions, called when they are reached, returning a step
 * or null (left out).
 *
 * The layer is a <dialog> opened with showModal(), so the page behind is inert, the keyboard stays in the tip, and a
 * screen reader hears the tip's title and text. Next (or →) and Back (or ←) move through it, Escape closes this page's
 * tips, and Skip tutorial ends the whole tutorial. onEnd(how) is told which: 'done', 'closed' or 'skipped'.
 *
 * Drawn from the theme's tokens (static/style.css .tour-*), so every scheme and both modes follow.
 */
const Tour = (() => {
  const el = (...a) => KIT.el(...a);
  let open = null;   // the dialog showing now, if any

  /** Is this element on the screen, with some size, and not hidden away? */
  function showing(node) {
    if (!node || !node.isConnected) return false;
    if (node.closest('[hidden], [inert]')) return false;
    if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // tucked off to the side (the Legend's drawer slides out of view rather than hiding)
    return r.right > 0 && r.left < innerWidth;
  }
  function find(at) {
    for (const sel of [].concat(at || [])) {
      const hit = [...document.querySelectorAll(sel)].find(n => !n.closest('dialog.tour') && showing(n));
      if (hit) return hit;
    }
    return null;
  }

  function run(steps, { label = 'Tips for this page', onEnd = () => {} } = {}) {
    if (open) return Promise.resolve('busy');
    return new Promise(resolve => {
      const hole = el('div', { class: 'tour-hole', 'aria-hidden': 'true' });
      const title = el('h2', { class: 'tour-title', id: 'tour-title' });
      const body = el('div', { class: 'tour-text', id: 'tour-text' });
      const count = el('p', { class: 'tour-count small' });
      const back = el('button', { type: 'button', class: 'small' }, 'Back');
      const next = el('button', { type: 'button', class: 'small primary' }, 'Next');
      const skip = el('button', { type: 'button', class: 'small tour-skip', 'data-tip': 'Turn the whole tutorial off. Your Account page can turn it back on' }, 'Skip tutorial');
      const labelEl = el('p', { class: 'tour-label small' }, label);
      const card = el('div', { class: 'tour-card', role: 'document' },
        labelEl, title, body,
        el('div', { class: 'tour-foot' }, count, el('div', { class: 'tour-buttons' }, skip, back, next)));
      const dlg = el('dialog', { class: 'tour', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' }, hole, card);
      document.body.append(dlg);
      open = dlg;

      let i = -1, shown = [], target = null, how = 'closed';
      // Each step is worked out as it is reached (a function may look at the page), and remembered so Back finds it again.
      const stepAt = n => {
        while (shown.length <= n && shown.length < steps.length + 50) {
          const raw = steps[shown.length + skipped];
          if (raw === undefined) return null;
          const s = typeof raw === 'function' ? raw() : raw;
          if (!s) { skipped++; continue; }
          const node = s.at ? find(s.at) : null;
          if (s.at && !node && s.optional) { skipped++; continue; }
          shown.push({ ...s, node });
        }
        return shown[n] || null;
      };
      let skipped = 0;
      const total = () => { let n = shown.length; while (stepAt(n)) n++; return n; };

      const place = () => {
        const pad = 6, gap = 12, gutter = 16;
        const vw = document.documentElement.clientWidth, vh = innerHeight;
        const cw = Math.min(380, vw - gutter * 2);
        card.style.width = `${cw}px`;
        const ch = card.offsetHeight;
        if (!target || !showing(target)) {
          dlg.classList.add('no-target');
          hole.style.display = 'none';
          card.style.left = `${Math.round((vw - cw) / 2)}px`;
          card.style.top = `${Math.max(gutter, Math.round((vh - ch) / 2))}px`;
          return;
        }
        dlg.classList.remove('no-target');
        const r = target.getBoundingClientRect();
        const box = { left: Math.max(2, r.left - pad), top: Math.max(2, r.top - pad), right: Math.min(vw - 2, r.right + pad), bottom: Math.min(vh - 2, r.bottom + pad) };
        Object.assign(hole.style, { display: '', left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
        // below if it fits, else above, else beside, else over the bottom of the screen
        const clampX = x => Math.min(Math.max(gutter, x), vw - cw - gutter);
        const clampY = y => Math.min(Math.max(gutter, y), vh - ch - gutter);
        let left, top;
        if (box.bottom + gap + ch <= vh - gutter) { top = box.bottom + gap; left = clampX(box.left); }
        else if (box.top - gap - ch >= gutter) { top = box.top - gap - ch; left = clampX(box.left); }
        else if (box.right + gap + cw <= vw - gutter) { left = box.right + gap; top = clampY(box.top); }
        else if (box.left - gap - cw >= gutter) { left = box.left - gap - cw; top = clampY(box.top); }
        else { left = clampX((vw - cw) / 2); top = clampY(vh - ch - gutter); }
        card.style.left = `${Math.round(left)}px`;
        card.style.top = `${Math.round(top)}px`;
      };

      const go = n => {
        const s = stepAt(n);
        if (!s) return finish('done');
        i = n;
        target = s.node && s.node.isConnected ? s.node : (s.at ? find(s.at) : null);
        if (target) target.scrollIntoView({ block: 'center', inline: 'nearest' });
        labelEl.textContent = s.label || label;
        title.replaceChildren(...KIT.withIcons(s.title || ''));
        body.replaceChildren(...[].concat(s.text || []).map(t => (typeof t === 'string' ? el('p', {}, t) : t)));
        const of = total();
        count.textContent = `${n + 1} of ${of}`;
        back.style.display = n === 0 ? 'none' : '';
        next.textContent = n + 1 >= of ? 'Done' : 'Next';
        place();
        requestAnimationFrame(place);   // once the card's new text has its height
        next.focus();
      };

      const reflow = () => requestAnimationFrame(place);
      addEventListener('resize', reflow);
      addEventListener('scroll', reflow, true);
      const finish = why => {
        how = why;
        removeEventListener('resize', reflow);
        removeEventListener('scroll', reflow, true);
        if (dlg.open) dlg.close();
        dlg.remove();
        if (open === dlg) open = null;
        try { onEnd(how); } finally { resolve(how); }
      };

      next.addEventListener('click', () => go(i + 1));
      back.addEventListener('click', () => go(Math.max(0, i - 1)));
      skip.addEventListener('click', () => finish('skipped'));
      dlg.addEventListener('cancel', ev => { ev.preventDefault(); finish('closed'); });   // Escape
      dlg.addEventListener('keydown', ev => {
        if (ev.target.closest('input, textarea, select')) return;
        if (ev.key === 'ArrowRight') { ev.preventDefault(); go(i + 1); }
        else if (ev.key === 'ArrowLeft' && i > 0) { ev.preventDefault(); go(i - 1); }
      });
      // a tap on the dimmed page does nothing, so a stray tap doesn't lose the tip
      KIT.hideTip?.();
      dlg.showModal();
      go(0);
    });
  }

  /** Close the tips showing now, if any, as if Escape were pressed (a move to another page does this). */
  function close() {
    if (open) open.dispatchEvent(new Event('cancel', { cancelable: true }));
  }

  return { run, close, isOpen: () => !!open, showing };
})();
