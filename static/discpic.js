/* discpic.js — a picture in a round disc (a character's portrait, an Encyclopedia entry's disc, a token, the token on
 * a map pin), framed the way it was set: the point of the picture kept in the middle and how far it is zoomed in. The
 * framing rides on the picture's address after a # ("api/index.php?a=file&cid=1&id=7#frame=50,20,180": across and down
 * in percent, then the zoom in percent), as api/files.php pic_url() writes it, so every place that is handed the
 * address draws the same circle without asking for anything more. And the Fit in the circle box that sets it.
 *
 * Plain script, no build step; uses KIT (static/kit.js). */
'use strict';

const DiscPic = (() => {
  const { el } = KIT;
  const PLAIN = { x: 50, y: 50, zoom: 100 };

  /** The framing an address carries, or null when it carries none (the middle, just filling the circle). */
  function frameOf(url) {
    const m = /#frame=(\d+),(\d+),(\d+)/.exec(url || '');
    return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null;
  }
  /** The file's id, from its address. */
  function fileId(url) {
    const m = /[?&]id=(\d+)/.exec(url || '');
    return m ? +m[1] : null;
  }
  /** Place the picture: object-position keeps the point at the same place in the circle as in the picture, and the zoom
   * grows it around that same point, so the point stays put (the circle's own overflow trims the rest). */
  function apply(img, f) {
    f = f || PLAIN;
    img.style.objectPosition = `${f.x}% ${f.y}%`;
    img.style.transformOrigin = `${f.x}% ${f.y}%`;
    img.style.transform = f.zoom > 100 ? `scale(${f.zoom / 100})` : '';
  }
  /** The picture alone, framed, for a round box that already trims what spills over (.token-face). */
  function img(url, attrs = {}) {
    const node = el('img', { alt: '', ...attrs, src: url });
    apply(node, frameOf(url));
    return node;
  }
  /** The disc: a span with the given classes (which size, ring and round it) trimming the framed picture inside. */
  function disc(url, cls = '', attrs = {}) {
    return el('span', { class: `disc-pic ${cls}`.trim() }, img(url, attrs));
  }

  /** The Fit in the circle box: the picture in a big circle to drag (or the arrow keys), with a Zoom slider (or the
   * wheel, or a pinch). Resolves with the framing chosen, or null when cancelled. */
  function edit(url, { title = 'Fit in the circle' } = {}) {
    return new Promise(resolve => {
      KIT.hideTip();
      let f = { ...(frameOf(url) || PLAIN) };
      const pic = el('img', { src: url.replace(/#.*$/, ''), alt: '', draggable: 'false' });
      const view = el('div', { class: 'disc-pic framer-disc', tabindex: '0', role: 'group',
        'aria-label': 'The picture in its circle: drag it, or use the arrow keys, to move it' }, pic);
      const zoom = el('input', { type: 'range', min: 100, max: 400, step: 5, value: f.zoom, class: 'framer-zoom', 'aria-label': 'Zoom' });
      const zoomOut = el('output', { class: 'small muted framer-zoom-out' });
      const show = () => { apply(pic, f); zoom.value = f.zoom; zoomOut.textContent = `${(f.zoom / 100).toFixed(2).replace(/\.?0+$/, '')}×`; };
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const setZoom = z => { f.zoom = Math.round(clamp(z, 100, 400)); show(); };
      // How far the picture overhangs the circle, across and down, at this zoom: a drag of that many pixels moves the
      // point the whole way from one edge to the other (left' = p × (box − zoom × width), api: object-position + scale)
      const overhang = () => {
        const box = view.clientWidth, w = pic.naturalWidth, h = pic.naturalHeight;
        if (!box || !w || !h) return [0, 0];
        const s = Math.max(box / w, box / h) * f.zoom / 100;
        return [w * s - box, h * s - box];
      };
      const nudge = (dx, dy) => {
        const [ox, oy] = overhang();
        if (ox > 0.5) f.x = clamp(f.x - dx / ox * 100, 0, 100);
        if (oy > 0.5) f.y = clamp(f.y - dy / oy * 100, 0, 100);
        show();
      };
      // dragging with one finger or the mouse; two fingers pinch to zoom
      const pts = new Map();
      let pinch = null;
      const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
      view.addEventListener('pointerdown', ev => {
        view.setPointerCapture(ev.pointerId);
        pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pts.size === 2) pinch = { d: gap(), z: f.zoom };
        ev.preventDefault();
      });
      view.addEventListener('pointermove', ev => {
        const p = pts.get(ev.pointerId);
        if (!p) return;
        const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
        p.x = ev.clientX; p.y = ev.clientY;
        if (pts.size === 2 && pinch) { if (pinch.d > 0) setZoom(pinch.z * gap() / pinch.d); }
        else if (pts.size === 1) nudge(dx, dy);
      });
      const up = ev => { pts.delete(ev.pointerId); if (pts.size < 2) pinch = null; };
      view.addEventListener('pointerup', up);
      view.addEventListener('pointercancel', up);
      view.addEventListener('wheel', ev => { ev.preventDefault(); setZoom(f.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
      view.addEventListener('keydown', ev => {
        const step = ev.shiftKey ? 10 : 2;
        const keys = { ArrowLeft: ['x', -step], ArrowRight: ['x', step], ArrowUp: ['y', -step], ArrowDown: ['y', step] };
        if (keys[ev.key]) { const [k, d] = keys[ev.key]; f[k] = clamp(f[k] + d, 0, 100); show(); ev.preventDefault(); }
        else if (ev.key === '+' || ev.key === '=') { setZoom(f.zoom + 10); ev.preventDefault(); }
        else if (ev.key === '-') { setZoom(f.zoom - 10); ev.preventDefault(); }
      });
      zoom.addEventListener('input', () => setZoom(+zoom.value));
      const reset = el('button', { type: 'button', class: 'small', onclick: () => { f = { ...PLAIN }; show(); } }, 'Reset');
      const d = el('dialog', { class: 'kit-dialog framer-dialog', 'aria-label': title },
        el('form', { method: 'dialog' },
          el('h3', {}, title),
          el('p', { class: 'small muted' }, 'Drag the picture to move it in the circle, and zoom in on the face. It is shown this way wherever the picture is round: the sheet, the Encyclopedia and the map.'),
          view,
          el('div', { class: 'row framer-zoom-row' }, el('span', { class: 'small', 'aria-hidden': 'true' }, 'Zoom'), zoom, zoomOut, reset),
          el('div', { class: 'kit-dialog-actions' },
            el('button', { value: 'ok', class: 'primary', type: 'submit' }, 'Save'),
            el('button', { value: 'cancel', type: 'submit' }, 'Cancel'))));
      d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
      d.addEventListener('close', () => {
        const v = d.returnValue;
        d.remove();
        resolve(v === 'ok' ? { x: Math.round(f.x), y: Math.round(f.y), zoom: Math.round(f.zoom) } : null);
      });
      show();
      document.body.append(d);
      d.showModal();
      view.focus();
    });
  }
  /** Fit in the circle for picture url and save it: post(action, body) is the page's api post. Resolves with the file as
   * saved (its url carrying the new framing), or null when cancelled. */
  async function frame(url, post) {
    const id = fileId(url);
    if (!id) return null;
    const f = await edit(url);
    if (!f) return null;
    return (await post('file_frame', { id, ...f })).file;
  }

  return { frameOf, fileId, apply, img, disc, edit, frame };
})();
