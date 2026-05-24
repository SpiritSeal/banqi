// Browser smoke test for the custom PWA install affordance (#17).
//
// `beforeinstallprompt` is fired by the browser itself when the PWA becomes
// installable on Android / desktop Chromium. We can't trigger that real
// path from a test, but we can synthesize the event and prove the JS
// handler does the right thing: stash the event, render the button on the
// lobby, run the prompt on click, hide the button on `accepted`, and clear
// on `appinstalled`.
//
// Usage:
//   make wasm
//   node tests/pwa_install_prompt.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');
const AI_DIR = join(__dirname, '..', 'ai');

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
    const [rootDir, relPath] = p.startsWith('/ai/')
      ? [AI_DIR, p.slice(4)]
      : [WEB_DIR, p];
    try {
      const data = await readFile(join(rootDir, relPath));
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
  // Wait for main.js to bind the lobby (lobby-me is populated by renderLobby).
  await page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 15000 });

  // Install a hook so the page exposes the prompt resolution to the test —
  // we resolve userChoice manually so we can drive both the "accepted" and
  // "dismissed" branches deterministically.
  await page.evaluate(() => {
    window.__bipPrompts = 0;
    window.__bipChoice = null;
    const ev = new Event('beforeinstallprompt');
    ev.prompt = () => { window.__bipPrompts += 1; return Promise.resolve(); };
    Object.defineProperty(ev, 'userChoice', {
      get: () => new Promise((res) => { window.__bipResolveChoice = res; }),
    });
    window.dispatchEvent(ev);
  });

  // The handler dispatches `maybeShowInstallButton` synchronously when the
  // event fires on the lobby; the button should appear without needing a
  // re-render.
  await page.waitForSelector('#btn-install-pwa', { timeout: 5000 });
  console.log('  ok: install button appears after beforeinstallprompt');

  // Clicking the button should call event.prompt() and await userChoice.
  await page.click('#btn-install-pwa');
  await page.waitForFunction(() => window.__bipPrompts === 1, null, { timeout: 5000 });
  console.log('  ok: clicking the button calls event.prompt()');

  // Dismissed branch — button stays mounted, re-enables.
  await page.evaluate(() => window.__bipResolveChoice({ outcome: 'dismissed' }));
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('btn-install-pwa');
      return btn && !btn.disabled;
    },
    null, { timeout: 5000 },
  );
  console.log('  ok: dismissed prompt re-enables the button');

  // appinstalled should always drop the button (covers the case where the
  // user installs via the browser's own affordance after dismissing ours).
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await page.waitForFunction(
    () => !document.getElementById('btn-install-pwa'),
    null, { timeout: 5000 },
  );
  console.log('  ok: appinstalled removes the install button');

  // Re-arm with a fresh event, this time take the accepted path.
  await page.evaluate(() => {
    window.__bipPrompts = 0;
    const ev = new Event('beforeinstallprompt');
    ev.prompt = () => { window.__bipPrompts += 1; return Promise.resolve(); };
    Object.defineProperty(ev, 'userChoice', {
      get: () => Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(ev);
  });
  await page.waitForSelector('#btn-install-pwa', { timeout: 5000 });
  await page.click('#btn-install-pwa');
  await page.waitForFunction(
    () => !document.getElementById('btn-install-pwa'),
    null, { timeout: 5000 },
  );
  console.log('  ok: accepted prompt removes the install button');

  if (errs.length) fail(`page errors during run: ${errs.join('; ')}`);

  console.log('\nPWA install prompt test: PASS');
} catch (e) {
  console.error('FAIL:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
  process.exit(exitCode);
}
