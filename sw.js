// sw.js — the service worker that, with manifest.webmanifest, lets Chrome and Edge offer "Install app".
//
// It deliberately caches almost nothing. Every page of the app is drawn from the API with the signed-in person's
// data, and .htaccess already makes browsers check for a new app.js after each deploy, so a cache here could only
// show someone stale or another account's data, or an old build. So: requests to the API, scripts, styles and
// everything else go straight to the network untouched, and the one thing kept is a small "you're offline" page,
// shown when opening the app with no connection instead of the browser's own error.
const CACHE = 'chronicle-offline-1';
const OFFLINE = 'offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, 'static/icons/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chronicle-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  // Not handled, so the browser fetches it as if there were no worker: anything but opening a page, and the
  // sign-in pages under api/ (their redirects and cookies stay exactly as the server sends them).
  if (e.request.mode !== 'navigate' || new URL(e.request.url).pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
