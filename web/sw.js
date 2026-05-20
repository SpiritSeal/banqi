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

const BUILD_ID = '2026-05-16-ui-overhaul';
const SHELL    = `banqi-shell-${BUILD_ID}`;
const RUNTIME  = `banqi-runtime-${BUILD_ID}`;

const APP_SHELL = [
  './',
  './index.html',
  './main.js',
  './audio.js',
  './relay.js',
  './ai.js',
  './replay.js',
  './notifications.js',
  './board-hints.js',
  './board-input.js',
  './settings.js',
  './animations.js',
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
  './sounds/move.mp3',
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

// ---- Web Push ----
// Server pushes a JSON payload of the form
//   { kind:'turn', title, body, roomCode, gameId }
// when it's the recipient's turn and they have no open WebSocket. We surface
// it as a single OS-level notification; the tag collapses repeat pushes for
// the same game so a slow connection can't stack five "your turn" cards.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'Banqi', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Your turn in Banqi';
  const body  = data.body  || 'Tap to play your move.';
  const tag   = data.roomCode ? `banqi-turn-${data.roomCode}` : 'banqi-turn';
  const url   = data.roomCode ? `./#/g/${data.roomCode}` : './';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an existing tab on our origin — focus it and navigate.
    for (const client of all) {
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(new URL(target, self.location.origin).href); }
            catch (_) { /* navigate can reject across hash-only changes — ignore */ }
          }
          return;
        }
      } catch (_) { /* ignore */ }
    }
    await self.clients.openWindow(target);
  })());
});
