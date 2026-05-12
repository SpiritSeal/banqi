// Banqi service worker — offline app shell + cache management.
//
// Strategy:
//   * App shell (HTML/CSS/JS/WASM/icons/manifest): precached on install,
//     cache-first with background revalidation on fetch.
//   * /api/*, /auth/*: bypassed — always live network, never cached.
//   * /ws/*: not fetched by the worker (WebSocket upgrade), nothing to do.
//   * Navigation requests (mode === 'navigate'): network-first; on failure,
//     fall back to cached index.html so the hash router can take over;
//     last-ditch fallback to offline.html.
//   * Anything else same-origin: stale-while-revalidate.
//
// Bump BUILD_ID on every deploy; the new install drops the old caches in
// activate(), and the new SW reaches the page via the "Update available"
// banner wired up in main.js.

const BUILD_ID = '2026-05-12-1';
const SHELL    = `banqi-shell-${BUILD_ID}`;
const RUNTIME  = `banqi-runtime-${BUILD_ID}`;

// Files cached on install. peerjs.min.js is intentionally excluded — it's
// lazy-loaded only when a user enters the legacy classic-P2P flow, so it
// lands in the runtime cache on first use.
const APP_SHELL = [
  './',
  './index.html',
  './main.js',
  './relay.js',
  './ai.js',
  './replay.js',
  './style.css',
  './favicon.svg',
  './banqi.js',
  './banqi.wasm',
  './manifest.webmanifest',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pass through auth/API: must always hit the network (cookies + freshness).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match('./index.html'))
            || (await caches.match('./offline.html'))
            || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const networkFetch = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => null);

    if (cached) {
      networkFetch.catch(() => {});
      return cached;
    }
    const fresh = await networkFetch;
    return fresh || new Response('Not cached', { status: 504 });
  })());
});
