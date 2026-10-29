// Drafting a sheet template from a PDF, all in the browser: pdf.js (static/vendor/pdfjs, loaded the first time it is
// needed) reads a fillable PDF's form fields, or a flat sheet's lines of text, and SheetLayout turns them into a
// layout. The PDF is never uploaded or saved; the editor shows its pages beside the draft and closes it when it closes.
(function (root) {
  'use strict';
  const NOTICE = "This PDF stays on your device. It isn't uploaded or saved, and it's gone when you close the editor.";
  const NOT_PDF = "That file isn't a PDF.";
  const NOTHING = 'No form fields or text found in this PDF. Start from a blank template, or fork one from the library.';
  const BASE = 'static/vendor/pdfjs/';

  let loading = null;
  /** pdf.js, loaded once. */
  function lib() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (!loading) loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + 'pdf.min.js';
      s.onload = () => {
        root.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
        resolve(root.pdfjsLib);
      };
      s.onerror = () => { loading = null; reject(new Error("The PDF reader didn't load. Check your connection and try again.")); };
      document.head.append(s);
    });
    return loading;
  }

  /** A form field as SheetLayout.draftFromFormFields takes it, or null for anything that isn't one. */
  function formField(a, page) {
    if (a.subtype !== 'Widget' || !a.fieldName) return null;
    const base = { name: a.fieldName, page, rect: a.rect };
    if (a.fieldType === 'Tx') return { ...base, type: 'text' };
    if (a.fieldType === 'Btn' && a.checkBox) return { ...base, type: 'checkbox' };
    if (a.fieldType === 'Btn' && a.radioButton) return { ...base, type: 'radio', options: a.buttonValue != null ? [String(a.buttonValue)] : [] };
    if (a.fieldType === 'Ch') return { ...base, type: 'choice', options: (a.options || []).map(o => o.displayValue ?? o.exportValue) };
    return null;
  }

  /** Read $file: { layout, from: 'fields'|'text', pages, doc }. The caller keeps doc to show its pages, then close()s it. */
  async function read(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
    if (!head.includes('%PDF-')) throw new Error(NOT_PDF);
    const pdfjs = await lib();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
    } catch (e) {
      throw new Error(e && e.name === 'PasswordException' ? 'That PDF has a password. Open it, save a copy without one, and try again.' : NOT_PDF);
    }
    try {
      const fields = [], texts = [], radios = new Map();
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        for (const a of await page.getAnnotations()) {
          const f = formField(a, n);
          if (!f) continue;
          // a radio group is one field whose buttons are its options
          if (f.type === 'radio') {
            const g = radios.get(f.name);
            if (g) { g.options.push(...f.options); continue; }
            radios.set(f.name, f);
          }
          fields.push(f);
        }
        for (const it of (await page.getTextContent()).items) {
          const str = String(it.str || '').trim();
          if (!str) continue;
          const [, , c, d, x, y] = it.transform;
          texts.push({ str, page: n, x, y, h: it.height || Math.hypot(c, d) });
        }
        page.cleanup();
      }
      let layout = null, from = 'fields';
      if (fields.length) layout = root.SheetLayout.draftFromFormFields(fields, texts);
      if (!layout || !layout.sections.length) { layout = root.SheetLayout.draftFromText(texts); from = 'text'; }
      if (!layout.sections.length) throw new Error(NOTHING);
      return { layout, from, pages: doc.numPages, doc };
    } catch (e) {
      close(doc);
      throw e;
    }
  }

  /** Draw page $n of $doc into $canvas, $width CSS pixels wide. */
  async function renderPage(doc, n, canvas, width) {
    const page = await doc.getPage(n);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const ratio = root.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }

  /** Let go of $doc: pdf.js frees its copy of the file and its worker. */
  function close(doc) {
    if (doc) doc.destroy().catch(() => {});
  }

  root.PdfImport = { NOTICE, read, renderPage, close };
})(window);
