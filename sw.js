// Open House kiosk — service worker. Caches the whole app so it runs with no network.
// BUILD is a hash of every file in ASSETS. After changing any of them run `npm run stamp`
// (a test fails until you do). A changed sw.js is what makes installed iPads pick up the new version.
const BUILD = '128dec507217b';
const CACHE = 'oh-kiosk-' + BUILD;
const ASSETS = [
  './',
  './index.html',
  './js/app.js',
  './js/core.js',
  './js/db.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-512.png',
];

// Some hosts (e.g. Cloudflare Pages) redirect /index.html → /. A redirected response can't be used to answer
// a page load, so store a clean, non-redirected copy of every file.
async function cacheFile(cache, url) {
  const res = await fetch(new Request(url, { cache: 'reload' }));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const clean = res.redirected
    ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
    : res;
  await cache.put(url, clean);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const existed = await caches.has(CACHE);
    const cache = await caches.open(CACHE);
    try {
      await Promise.all(ASSETS.map(u => cacheFile(cache, u)));
    } catch (err) {
      if (!existed) await caches.delete(CACHE); // never leave a half-filled new cache; never touch the live one
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('oh-kiosk-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Cache first: the kiosk must open identically with or without wifi.
// caches.match(…, { cacheName }) never creates an empty cache (caches.open would).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const scope = self.registration.scope;
      const shell = await caches.match(scope, { cacheName: CACHE })
        ?? await caches.match(new URL('./index.html', scope).href, { cacheName: CACHE });
      if (shell) return shell;
    }
    return fetch(req);
  })());
});
