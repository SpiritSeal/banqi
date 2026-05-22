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
// BUILD_ID and APP_SHELL are written by scripts/stamp-sw.mjs on every build
// (Makefile + Dockerfile). BUILD_ID is the first 12 hex chars of a sha256
// over every file in web/, so any change to the shipped bundle invalidates
// the cache atomically (see activate handler) and surfaces the "Update
// available" banner wired up in main.js.

const BUILD_ID = 'f6bcd0dc33a8';
const SHELL    = `banqi-shell-${BUILD_ID}`;
const RUNTIME  = `banqi-runtime-${BUILD_ID}`;

// AUTO-PRECACHE START
const APP_SHELL = [
  "./",
  "../ai/index.mjs",
  "./animations.js",
  "./audio.js",
  "./banqi.js",
  "./banqi.wasm",
  "./board-hints.js",
  "./board-input.js",
  "./favicon.svg",
  "./icons/apple-touch-icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./main.js",
  "./manifest.webmanifest",
  "./notifications.js",
  "./offline.html",
  "./relay.js",
  "./replay.js",
  "./settings.js",
  "./sounds/move.mp3",
  "./style.css",
];
// AUTO-PRECACHE END

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
