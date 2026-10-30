/* lib.js — what the sheet agent's scripts share: Playwright (from tests/node_modules, the copy the browser tests
 * already install), a browser, and a small web server for the repo's own files, so pdf.js and the app's CSS and
 * scripts load the way they do on the site. Local only: none of this is deployed. */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function playwright() {
  try {
    return require(require.resolve('@playwright/test', { paths: [path.join(ROOT, 'tests')] }));
  } catch {
    throw new Error('Playwright is not installed. Run "npm ci" in tests/ first.');
  }
}

/** A browser: the pre-installed Chromium when there is one, Playwright's own otherwise. */
async function browser() {
  const { chromium } = playwright();
  const pre = '/opt/pw-browsers/chromium';
  return chromium.launch(fs.existsSync(pre) ? { executablePath: pre } : {});
}

/** Serve the repo's files, plus $extra ({ '/url': '/abs/path' }), on 127.0.0.1. Resolves to { url, close }. */
function serve(extra = {}) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = extra[url];
    if (!file) {
      file = path.normalize(path.join(ROOT, url));
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

/** $args as { _: [positional], flag: value|true } for --flag value and --flag. */
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const next = argv[i + 1];
    out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

module.exports = { ROOT, playwright, browser, serve, args };
