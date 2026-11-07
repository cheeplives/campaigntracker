/* report.js — the Report (!) button in the top bar, and Site Admin's Reports tab.
 *
 * Anyone signed in presses ! to tell the site admins something is wrong. The dialog offers a screenshot of the page as
 * it was (taken in the browser with html-to-image, loaded only then, and kept out of the report if they untick it)
 * and shows everything else that goes with it: the page, the build, the browser and screen, the campaign open and the
 * page's recent errors and failed requests, which this file starts noting as soon as it loads. api/reports.php keeps
 * them; Site Admin's Reports tab lists them, to resolve unfixed, send to GitHub, reopen or delete.
 *
 * ReportLog is global so app.js can note a failed request from api(). ChronicleReport.make(ctx) is called once by app.js with its
 * helpers and state. Plain script, no build step. */
(function (root) {
  'use strict';
  const KEEP = 15;
  const errors = [], requests = [], pages = [];
  const now = () => new Date().toISOString();
  const keep = (list, item) => { list.push(item); if (list.length > KEEP) list.shift(); };
  const short = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const where = (file, line, col) => (file ? `${String(file).replace(location.origin + '/', '').replace(/^.*\/static\//, 'static/')}:${line || 0}:${col || 0}` : '');

  // The page's own errors, from the moment it loads, so a report sent after something broke says what broke.
  root.addEventListener('error', e => {
    if (e.target && e.target !== root) return;   // a picture that didn't load, not a script error
    keep(errors, { at: now(), message: short(e.message || e.error), where: where(e.filename, e.lineno, e.colno) });
  });
  root.addEventListener('unhandledrejection', e => {
    if (e.defaultPrevented) return;
    const r = e.reason;
    keep(errors, { at: now(), message: short(r && r.message ? r.message : r), where: short(r && r.stack ? String(r.stack).split('\n').slice(0, 2).join(' ') : '', 200) });
  });
  const notePage = () => { const h = location.hash || '#/'; if (pages[pages.length - 1]?.page !== h) keep(pages, { at: now(), page: short(h, 200) }); };
  root.addEventListener('hashchange', notePage);
  notePage();
  root.ReportLog = {
    /** A request to the API that failed: which action, its HTTP status (0 when it never arrived) and the message. */
    request(action, status, message) { keep(requests, { at: now(), action: short(action, 60), status: Number(status) || 0, message: short(message, 200) }); },
  };

  function make(ctx) {
    const { S, api, post, btn, el, toast, confirmDialog, promptDialog, hideTip, version } = ctx;

    // ---------------------------------------------------------------- the details that go with a report
    function details() {
      const d = document.documentElement, mq = q => { try { return matchMedia(q).matches; } catch { return false; } };
      const h1 = document.querySelector('main h1');
      let tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
      return {
        build: version,
        page: location.hash || '#/',
        heading: h1 ? short(h1.textContent.trim(), 120) : '',
        campaign: S.camp && S.camp.id ? { id: S.camp.id, name: short(S.camp.name, 120), role: S.role || '', viewing_as_player: !!S.viewAs } : null,
        browser: short(navigator.userAgent, 300),
        language: navigator.language || '',
        timezone: tz,
        screen: `${innerWidth}×${innerHeight} window, ${screen.width}×${screen.height} screen, ${Math.round((devicePixelRatio || 1) * 100) / 100}× pixels`,
        input: mq('(pointer: coarse)') ? 'touch' : 'mouse',
        installed_app: mq('(display-mode: standalone)') || navigator.standalone === true,
        theme: `${d.dataset.scheme || 'parchment'}, ${d.dataset.theme || 'dark'}`,
        online: navigator.onLine,
        local_time: new Date().toString(),
        pages: pages.slice(-10),
        errors: errors.slice(),
        requests: requests.slice(),
      };
    }
    const LABELS = { build: 'Build', page: 'Page', heading: 'Heading', campaign: 'Campaign', browser: 'Browser', language: 'Language', timezone: 'Time zone',
      screen: 'Screen', input: 'Input', installed_app: 'Installed as an app', theme: 'Theme', online: 'Online', local_time: 'Their time',
      pages: 'Pages before this', errors: 'Errors in the page', requests: 'Failed requests' };
    /** The details as label and text pairs, for the dialog and the Reports tab alike. */
    function detailRows(c) {
      const text = (k, v) => {
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        if (k === 'campaign' && typeof v === 'object') return `${v.name || ''} (#${v.id}), ${v.role === 'gm' ? 'GM' : v.role || 'member'}${v.viewing_as_player ? ', viewing as a player' : ''}`;
        if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? Object.values(x).filter(y => y !== '' && y !== null).join(' · ') : String(x))).join('\n');
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      };
      return Object.keys(c || {}).map(k => [LABELS[k] || k, text(k, c[k])]).filter(([, v]) => v !== '');
    }
    const detailList = c => el('dl', { class: 'report-details' }, detailRows(c).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

    // ---------------------------------------------------------------- the screenshot
    let libLoading = null;
    function loadLib() {
      if (root.htmlToImage) return Promise.resolve(root.htmlToImage);
      return (libLoading ??= new Promise((ok, bad) => {
        const s = el('script', { src: 'static/vendor/html-to-image/html-to-image.js' });
        s.onload = () => (root.htmlToImage ? ok(root.htmlToImage) : bad(new Error('The screenshot tool did not load')));
        s.onerror = () => { libLoading = null; bad(new Error('The screenshot tool did not load')); };
        document.head.append(s);
      }));
    }
    /** The app's own fonts as CSS with each file inlined, for the screenshot. html-to-image would read them itself, but it
     * does so through a <base> element, which the page's CSP (base-uri 'none') refuses. */
    let fontCss = null;
    function fontsInline() {
      return (fontCss ??= (async () => {
        const css = await (await fetch('static/fonts.css')).text();
        const urls = [...new Set([...css.matchAll(/url\(([^)'"]+)\)/g)].map(m => m[1]))];
        const data = await Promise.all(urls.map(async u => {
          const blob = await (await fetch(new URL(u, new URL('static/fonts.css', location.href)))).blob();
          return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });
        }));
        return urls.reduce((out, u, i) => out.split(`url(${u})`).join(`url(${data[i]})`), css);
      })().catch(err => { fontCss = null; throw err; }));
    }
    const SHOT_MAX = 1_400_000;   // characters of data: URL; the server takes up to 1.5 MB of picture
    /** What is on screen now, as a JPEG data: URL: the window's part of the page, without the report dialog, tooltips or toasts. */
    async function screenshot() {
      const [lib, fontEmbedCSS] = await Promise.all([loadLib(), fontsInline().catch(() => '')]);
      const w = innerWidth, h = innerHeight, x = scrollX, y = scrollY;
      const bg = getComputedStyle(document.body).backgroundColor;
      const skip = n => !(n.classList && (n.classList.contains('report-dialog') || n.id === 'tipbox' || n.id === 'toast'));
      const opts = { width: w, height: h, canvasWidth: w, canvasHeight: h, pixelRatio: 1, backgroundColor: bg, filter: skip, cacheBust: false, fontEmbedCSS, skipFonts: !fontEmbedCSS,
        imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
        style: { transform: `translate(${-x}px, ${-y}px)`, transformOrigin: '0 0', margin: '0' } };
      let shot = await lib.toJpeg(document.body, { ...opts, quality: 0.8 });
      if (shot.length > SHOT_MAX) shot = await lib.toJpeg(document.body, { ...opts, quality: 0.5 });
      if (shot.length > SHOT_MAX) throw new Error('The page is too large to picture');
      return shot;
    }

    // ---------------------------------------------------------------- the dialog
    let open = false;
    async function openReport() {
      if (open) return;
      open = true;
      hideTip();
      const info = details();
      const box = el('textarea', { rows: 5, required: true, maxlength: 5000, 'aria-label': 'What went wrong?',
        placeholder: 'What you were doing, what you expected, and what happened instead' });
      const keepShot = el('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': 'Include a screenshot of this page' });
      const shotArea = el('div', { class: 'report-shot-area muted small' }, 'Taking a screenshot of the page…');
      const send = el('button', { type: 'submit', class: 'primary', value: 'send' }, 'Send report');
      const form = el('form', { method: 'dialog' },
        el('h3', {}, 'Report a problem'),
        el('p', { class: 'kit-dialog-msg' }, 'Something broken, wrong or confusing? Tell the site admins. Only they see reports.'),
        el('label', { class: 'report-label' }, el('span', {}, 'What went wrong?'), box),
        el('div', { class: 'report-shot' },
          el('label', { class: 'switch-row' }, keepShot, el('span', {}, 'Include a screenshot of this page')),
          shotArea),
        el('details', { class: 'report-more' }, el('summary', {}, 'Also sent: the page and your browser'),
          el('p', { class: 'small muted' }, 'Your account, and these details from this page, so whoever fixes it can see what you saw:'),
          detailList(info)),
        el('p', { class: 'report-error bad small', role: 'alert' }),
        el('div', { class: 'kit-dialog-actions' }, send, el('button', { type: 'submit', value: 'cancel', formnovalidate: true }, 'Cancel')));
      const d = el('dialog', { class: 'kit-dialog report-dialog', 'aria-label': 'Report a problem' }, form);
      let shot = null;
      screenshot().then(s => {
        shot = s;
        keepShot.disabled = false;
        shotArea.replaceChildren(el('img', { src: s, alt: 'Screenshot of the page', class: 'report-shot-img' }));
      }, err => {
        keepShot.checked = false;
        shotArea.textContent = `No screenshot this time: ${err && err.message ? err.message : 'it could not be taken'}. The report still sends.`;
      });
      keepShot.addEventListener('change', () => shotArea.classList.toggle('off', !keepShot.checked));
      form.addEventListener('submit', async ev => {
        if (ev.submitter && ev.submitter.value === 'cancel') return;   // the dialog closes by itself
        ev.preventDefault();
        const message = box.value.trim();
        if (message.length < 3) { form.querySelector('.report-error').textContent = 'Say what went wrong first.'; box.focus(); return; }
        send.disabled = true; send.textContent = 'Sending…';
        try {
          await post('report_send', { message, page: location.href.slice(0, 500), context: info, shot: keepShot.checked ? shot : null });
          d.close();
          toast('Report sent. Thank you!');
        } catch (err) {
          form.querySelector('.report-error').textContent = err.message;
          send.disabled = false; send.textContent = 'Send report';
        }
      });
      d.addEventListener('close', () => { d.remove(); open = false; });
      document.body.append(d);
      d.showModal();
      box.focus();
    }
    /** The ! in the top bar. */
    function button() {
      const b = el('button', { type: 'button', class: 'nav-pill report-btn', 'aria-label': 'Report a problem with the site',
        'data-tip': 'Report a problem with the site to its admins, with a screenshot of this page if you like' }, '!');
      b.addEventListener('click', openReport);
      return b;
    }

    // ---------------------------------------------------------------- Site Admin, Reports tab
    const STATUS = { open: 'Open', resolved: 'Resolved unfixed', github: 'Sent to GitHub' };
    const FILTERS = [['open', 'Open'], ['github', 'Sent to GitHub'], ['resolved', 'Resolved unfixed'], ['all', 'All']];
    let filter = 'open';
    const when = s => { const t = new Date(String(s).replace(' ', 'T')); return isNaN(t) ? String(s) : t.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    /** The page's address on this site, as a link that opens it here. */
    const pageLink = u => {
      let hash = '';
      try { const p = new URL(u, location.href); if (p.origin === location.origin) hash = p.hash || '#/'; } catch { /* not an address */ }
      return hash ? el('a', { href: hash }, hash) : el('span', { class: 'mono' }, u || '(no page)');
    };

    async function viewReports(head, mount) {
      const { reports, counts, github } = await api('reports', { query: { status: filter } });
      const redraw = () => viewReports(head, mount).catch(err => toast(err.message, true));
      const act = (label, fn, cls, tipText) => {
        const b = btn(label, null, `small ${cls || ''}`, tipText);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { if (await fn() !== false) redraw(); } catch (err) { toast(err.message, true); }
          b.disabled = false;
        });
        return b;
      };
      const toGithub = r => act(r.status === 'github' ? 'Send to GitHub again' : 'Send to GitHub', async () => {
        // Opened now, while the click still counts, so Safari doesn't block it; pointed at GitHub once the server answers.
        const tab = github.direct ? null : window.open('', '_blank');
        try {
          const res = await post('report_github', { id: r.id });
          if (res.open) {
            if (tab) { tab.opener = null; tab.location.href = res.open; } else location.assign(res.open);
            toast('GitHub\'s new issue page is open: check it and press Submit there. Add the issue\'s link here afterwards if you like');
          } else toast('Issue opened on GitHub');
        } catch (err) { if (tab) tab.close(); throw err; }
      }, r.status === 'github' ? '' : 'primary', github.direct
        ? `Open an issue on ${github.repo} with the report's text and page details (not who sent it, nor the screenshot)`
        : `Open GitHub's new issue page for ${github.repo}, filled in with the report's text and page details (not who sent it, nor the screenshot)`);
      const card = r => el('li', { class: `report-card report-${r.status}` },
        el('div', { class: 'report-head' },
          el('strong', {}, `#${r.id}`),
          el('span', {}, r.who || el('span', { class: 'muted' }, 'an account since removed'), r.email ? el('span', { class: 'muted small' }, ` ${r.email}`) : null),
          el('span', { class: 'muted small' }, when(r.created_at)),
          el('span', { class: `status report-status ${r.status}` }, STATUS[r.status] || r.status)),
        el('p', { class: 'pre report-msg' }, r.message),
        el('div', { class: 'small' }, 'Page: ', pageLink(r.page)),
        r.has_shot ? el('a', { href: `api/index.php?a=report_shot&id=${r.id}`, target: '_blank', rel: 'noopener', class: 'report-thumb', 'data-tip': 'Open the screenshot full size' },
          el('img', { src: `api/index.php?a=report_shot&id=${r.id}`, alt: `Screenshot sent with report ${r.id}`, loading: 'lazy' })) : null,
        el('details', { class: 'report-more' }, el('summary', {}, 'Session details'), detailList(r.context)),
        r.status !== 'open' && r.closed_by ? el('p', { class: 'small muted' }, `${STATUS[r.status]} by ${r.closed_by}${r.closed_at ? `, ${when(r.closed_at)}` : ''}.`) : null,
        r.github_url ? el('p', { class: 'small' }, el('a', { href: r.github_url, target: '_blank', rel: 'noopener' }, 'The issue on GitHub')) : null,
        el('div', { class: 'actions report-actions' },
          r.status === 'github' ? null : toGithub(r),
          r.status === 'open' ? act('Resolve unfixed', () => post('report_status', { id: r.id, status: 'resolved' }), '', 'Close it without a fix: not a fault, already fixed, or not one to fix') : null,
          r.status !== 'open' ? act('Reopen', () => post('report_status', { id: r.id, status: 'open' }), '', 'Put it back on the Open list') : null,
          r.status === 'github' ? act(r.github_url ? 'Change issue link' : 'Add issue link', async () => {
            const url = await promptDialog('The address of the issue on GitHub, so this report links to it. Leave it empty to take the link off.',
              { title: 'Issue link', value: r.github_url || '', placeholder: `https://github.com/${github.repo || 'owner/repo'}/issues/1`, ok: 'Save' });
            if (url === null) return false;
            await post('report_github_link', { id: r.id, url: url.trim() });
          }, '', 'Keep the GitHub issue\'s address with the report') : null,
          r.status === 'github' ? toGithub(r) : null,
          act('Delete', async () => {
            if (!await confirmDialog(`Delete report #${r.id}${r.has_shot ? ' and its screenshot' : ''}? This can't be undone.`, { ok: 'Delete', danger: true })) return false;
            await post('report_delete', { id: r.id });
            toast(`Deleted report #${r.id}`);
          }, 'danger', 'Delete the report and its screenshot for good')));
      const pills = el('div', { class: 'seg report-filter', role: 'radiogroup', 'aria-label': 'Which reports' }, FILTERS.map(([k, label]) => {
        const n = k === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[k] || 0;
        const input = el('input', { type: 'radio', name: 'report-filter', value: k, checked: k === filter });
        input.addEventListener('change', () => { filter = k; redraw(); });
        return el('label', {}, input, el('span', {}, `${label} (${n})`));
      }));
      const empty = { open: 'Nothing open. People report problems with the ! button in the top bar.', github: 'None sent to GitHub yet.', resolved: 'None resolved unfixed.', all: 'No reports yet. People report problems with the ! button in the top bar.' }[filter];
      mount(head('reports'), el('div', { class: 'card' },
        el('div', { class: 'row spread' }, el('h2', {}, 'Reports'), pills),
        reports.length ? el('ul', { class: 'report-list' }, reports.map(card)) : el('p', { class: 'muted' }, empty)),
        el('p', { class: 'muted pad' }, `What people sent with the ! button in the top bar, newest first. Send to GitHub ${github.direct ? 'opens' : 'fills in'} an issue on ${github.repo || 'the repository named in the server config (github_reports.repo)'} with the report's text and page details; it leaves out who sent it and the screenshot, as a public repository's issues are public.`));
    }

    return { button, openReport, viewReports, details };
  }

  root.ChronicleReport = { make };   // not window.Report: Safari has a built-in Report (the Reporting API)
})(typeof window !== 'undefined' ? window : globalThis);
