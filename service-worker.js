/* service-worker.js
 * - Precaches the app shell so the site opens instantly, even with no connection.
 * - Same-origin files and the Supabase SDK/fonts: serve from cache, refresh in the background.
 * - config.js: network first (so edits show up), cache as fallback.
 * - Supabase API calls are never intercepted: offline writes are handled by the app's own queue.
 * - Push: shows the daily 21:00 reminder; tapping it opens (or focuses) the app.
 * Bump VERSION when you deploy a new build to force a fresh cache.
 */
const VERSION = 'hb-v5';
const SHELL = [
  './', 'index.html', 'style.css', 'habits.js', 'app.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const CROSS_ORIGIN_OK = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    try { await cache.add(new Request(SDK, { mode: 'no-cors' })); } catch (e) { /* cached on first online use */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { event.waitUntil(network); return cached; }
  const res = await network;
  if (res) return res;
  if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
  return Response.error();
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/config.js')) { event.respondWith(networkFirst(req)); return; }
    event.respondWith(staleWhileRevalidate(event));
  } else if (CROSS_ORIGIN_OK.indexOf(url.hostname) >= 0) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'הרגלים';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'זמן לסמן את ההרגלים של היום',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'daily-reminder',
    renotify: true,
    lang: 'he',
    dir: 'rtl',
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
