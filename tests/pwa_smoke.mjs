// Real-browser PWA smoke test. Boots a static server, opens Chromium, waits
// for the service worker to register + control the page, then forces the
// browser offline and reloads to prove the cached shell still serves.
//
// Requires `make wasm` to have built web/banqi.{js,wasm} — the SW precaches
// the shell with `cache.addAll`, which fails fast if any URL 404s.
//
// Usage:
//   make wasm
//   node tests/pwa_smoke.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const MIME = {
  '.html':         'text/html; charset=utf-8',
  '.js':           'text/javascript; charset=utf-8',
  '.mjs':          'text/javascript; charset=utf-8',
  '.css':          'text/css; charset=utf-8',
  '.wasm':         'application/wasm',
  '.json':         'application/json; charset=utf-8',
  '.webmanifest':  'application/manifest+json; charset=utf-8',
  '.svg':          'image/svg+xml',
  '.png':          'image/png',
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fail('web/banqi.wasm not built — run `make wasm` first'); }

async function startServer() {
  const server = createServer(async (req, res) => {
    let p = (req.url || '/').split('?')[0];
    if (p === '/' || p === '') p = '/index.html';
    try {
      const data = await readFile(join(WEB_DIR, p));
      res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const { server, url } = await startServer();
const browser = await chromium.launch();
let exitCode = 0;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(url);

  // Service worker should register and become the active controller.
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    null, { timeout: 30000 }
  );
  console.log('  ok: service worker registered and controlling');

  // Manifest is fetchable from the page with the right MIME type.
  const manifestInfo = await page.evaluate(async () => {
    const r = await fetch('./manifest.webmanifest');
    return {
      ok: r.ok,
      type: r.headers.get('content-type'),
      json: await r.json().catch(() => null),
    };
  });
  if (!manifestInfo.ok) fail('manifest.webmanifest did not fetch with 2xx');
  if (!manifestInfo.type || !manifestInfo.type.includes('manifest+json')) {
    fail(`manifest.webmanifest served with wrong content-type: ${manifestInfo.type}`);
  }
  if (!manifestInfo.json || !manifestInfo.json.name) {
    fail('manifest.webmanifest did not parse as expected');
  }
  console.log(`  ok: manifest served as ${manifestInfo.type}`);

  // Shell files should be in the cache after install.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith('banqi-shell-'));
    if (!shell) return null;
    const c = await caches.open(shell);
    const keys = await c.keys();
    return keys.map((k) => new URL(k.url).pathname);
  });
  if (!cached) fail('no banqi-shell-* cache found after install');
  const required = ['/index.html', '/main.js', '/sw.js' /* served, not cached */];
  for (const f of ['/index.html', '/main.js', '/style.css', '/manifest.webmanifest', '/banqi.wasm']) {
    if (!cached.some((p) => p === f || p.endsWith(f))) fail(`shell cache missing ${f}`);
  }
  console.log(`  ok: shell cache contains ${cached.length} entries`);

  // Offline reload: kill the upstream and confirm the page still boots.
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const titleOffline = await page.title();
  if (!titleOffline.includes('Banqi')) {
    fail(`offline reload returned an unexpected page: title="${titleOffline}"`);
  }
  console.log('  ok: page reloads from cache while offline');

  // Navigating to OTB hash should render the OTB view (full app loads).
  await page.evaluate(() => { location.hash = '#/otb'; });
  await page.waitForFunction(
    () => !document.getElementById('view-otb')?.classList.contains('hidden'),
    null, { timeout: 15000 }
  );
  console.log('  ok: OTB view renders while offline');

  if (errs.length) fail(`page errors during run: ${errs.join('; ')}`);

  console.log('\nPWA smoke test: PASS');
} catch (e) {
  console.error('FAIL:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
  process.exit(exitCode);
}
