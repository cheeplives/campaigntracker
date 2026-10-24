/* kit.js — small shared UI kit, written to be identical in Campaign Chronicle
 * and Sinless: the DOM builder, toasts, tooltips that also work on touch
 * screens, and in-page confirm/prompt/alert dialogs that replace the browser's
 * blocking confirm(), prompt() and alert().
 *
 * Plain script, no build step. Everything hangs off the KIT global (like
 * Sinless's RULES / STORAGE / SYNC) so it never clashes with an app's own names.
 * Styles live in each app's style.css under "kit" (#toast, .tip, #tipbox,
 * dialog.kit-dialog), using the shared token names.
 * All text goes in through textContent, never innerHTML. */
'use strict';

const KIT = (() => {
  // ------------------------------------------------------------ DOM
  /** el('div', { class: 'card', onclick: fn }, 'text', childNode, [more, kids]).
   * null / undefined / false attributes and children are skipped. */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const $ = (s, root = document) => root.querySelector(s);

  // ------------------------------------------------------------ toast
  /** A short message at the bottom of the screen. bad = true styles it as an error. */
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) document.body.append(t = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }));
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), 3200);
  }

  // ------------------------------------------------------------ tooltips
  // Any element with data-tip shows a tooltip on hover (and on keyboard focus).
  // Touch screens can't hover, so there a tap opens it instead (a second tap
  // closes it), except on links and controls, where a tap does what it always
  // did. The "?" icons from tip() open on tap everywhere. A native title
  // attribute never shows on touch. One floating box, kept inside the viewport.
  /** A small "?" icon that explains the thing next to it. */
  function tip(text) {
    return el('span', { class: 'tip', tabindex: 0, role: 'button', 'aria-label': text, 'data-tip': text,
      onclick: e => { e.preventDefault(); e.stopPropagation(); showTip(e.currentTarget); },
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTip(e.currentTarget); } } }, '?');
  }
  /** Give any element a tooltip. */
  const tipped = (node, text) => { node.dataset.tip = text; return node; };
  let tipBox = null, tipEl = null;
  function showTip(target) {
    if (!tipBox) document.body.append(tipBox = el('div', { id: 'tipbox', role: 'tooltip' }));
    tipEl = target;
    // data-tip-img adds a picture above the text; the box is placed again once it has loaded and has its size.
    const src = target.dataset.tipImg;
    tipBox.replaceChildren(...(src ? [el('img', { src, alt: '', referrerpolicy: 'no-referrer', onload: () => { if (tipEl === target) placeTip(target); } }), el('span', {}, target.dataset.tip)] : [target.dataset.tip]));
    tipBox.className = 'show' + (src ? ' with-img' : '');
    placeTip(target);
  }
  function placeTip(target) {
    const r = target.getBoundingClientRect(), bw = tipBox.offsetWidth, bh = tipBox.offsetHeight;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - 8));
    const y = r.bottom + 8 + bh > innerHeight - 8 && r.top - bh - 8 > 0 ? r.top - bh - 8 : r.bottom + 8;
    tipBox.style.left = `${x}px`; tipBox.style.top = `${y}px`;
  }
  function hideTip() { tipEl = null; if (tipBox) tipBox.className = ''; }
  const tipTarget = e => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
  const canHover = matchMedia('(hover: hover)');
  const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role=button]';
  document.addEventListener('mouseover', e => {
    if (!canHover.matches) return; // touch: tapped open instead, below (pointerup)
    const t = tipTarget(e);
    if (t) { if (t !== tipEl) showTip(t); } else if (tipEl) hideTip();
  });
  document.addEventListener('focusin', e => { const t = tipTarget(e); if (t && t.matches(':focus-visible')) showTip(t); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('click', e => { if (!tipTarget(e)) hideTip(); });
  // Touch and pen work from pointer events rather than click: iPad Safari sends no click for a tap
  // on plain text or background, and a touch-screen laptop reports it can hover even when tapped.
  document.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && !tipTarget(e)) hideTip(); });
  document.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return;
    const t = tipTarget(e);
    if (t && !t.closest(INTERACTIVE)) { if (t === tipEl) hideTip(); else showTip(t); } else if (t) hideTip();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, true);

  // ------------------------------------------------------------ dialogs
  /** One modal <dialog>. Resolves with the value of the button pressed (the
   * typed text for a prompt), or null when cancelled or dismissed with Escape.
   * List the default button first: Enter submits with it, and the CSS shows
   * the row reversed so it still sits on the right. */
  function dialog({ title, message, buttons, input }) {
    return new Promise(resolve => {
      hideTip();
      const field = input ? el('input', { class: 'kit-dialog-input', value: input.value || '', placeholder: input.placeholder || '', 'aria-label': title || message }) : null;
      const d = el('dialog', { class: 'kit-dialog', 'aria-label': title || message },
        el('form', { method: 'dialog' },
          title ? el('h3', {}, title) : null,
          el('p', { class: 'kit-dialog-msg' }, message),
          field,
          el('div', { class: 'kit-dialog-actions' }, buttons.map(b =>
            el('button', { value: b.value, class: b.cls || '', autofocus: b.focus || null, type: 'submit' }, b.label)))));
      d.addEventListener('close', () => {
        const v = d.returnValue;
        d.remove();
        resolve(v === '' || v === 'cancel' ? null : (field ? field.value : v));
      });
      d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
      document.body.append(d);
      d.showModal();
      if (field) { field.focus(); field.select(); }
    });
  }
  /** await KIT.confirmDialog('Delete it?', { ok: 'Delete', danger: true }) → true / false */
  async function confirmDialog(message, { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
    const v = await dialog({ title, message, buttons: [
      { value: 'ok', label: ok, cls: danger ? 'danger' : 'primary', focus: !danger },
      { value: 'cancel', label: cancel, focus: danger },
    ] });
    return v === 'ok';
  }
  /** await KIT.promptDialog('Name this pack:', { value: 'My Homebrew' }) → the text, or null if cancelled */
  function promptDialog(message, { title = '', value = '', placeholder = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
    return dialog({ title, message, input: { value, placeholder }, buttons: [
      { value: 'ok', label: ok, cls: danger ? 'danger' : 'primary' },
      { value: 'cancel', label: cancel },
    ] });
  }
  /** await KIT.alertDialog('Saved.') — a message that needs reading, not a toast. */
  async function alertDialog(message, { title = '', ok = 'OK' } = {}) {
    await dialog({ title, message, buttons: [{ value: 'ok', label: ok, cls: 'primary', focus: true }] });
  }

  return { el, $, toast, tip, tipped, showTip, hideTip, dialog, confirmDialog, promptDialog, alertDialog };
})();
