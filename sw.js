// Offline support: keeps the page and its scripts on the phone so it opens (and shrinks) without a signal.
// Pages and scripts are fetched from the network first, so a new release shows up on the next visit.
importScripts('version.js');

const CACHE = 'dr-' + DR_VERSION;
const CORE = [
  './', 'index.html', 'app.js', 'budget.js', 'caption.js', 'discord.mjs', 'version.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-180.png', 'vendor/mediabunny.min.mjs',
];
const HEAVY = ['vendor/mediabunny-aac-encoder.min.mjs']; // only some iPhones need this one; cached best-effort

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(CORE);
      await Promise.all(HEAVY.map((url) => cache.add(url).catch(() => {})));
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dr-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch Discord or anything else
  const vendor = url.pathname.includes('/vendor/');
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (vendor) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
        if (hit) return hit;
        throw e;
      }
    })(),
  );
});
