// Smoke test for the replay sharing affordance (#16). Boots the static web
// shell in Chromium, mocks the dashboard's HTTP dependencies, and walks the
// real renderDashboard / renderGameCard / share-button delegation code so
// the share path under test is the production one — not a stand-in.
//
// What we cover:
//   - The Share button only renders on completed cards (not playing /
//     waiting), so the production card markup gating is exercised.
//   - On coarse-pointer devices with `navigator.share`, clicking it calls
//     the share sheet with a URL that points at the canonical
//     /#/games/:id replay route.
//   - The share sheet being dismissed (AbortError) does NOT fall through
//     to a clipboard write (mirrors copyInviteLink's contract).
//   - On desktop (no `navigator.share`), the helper writes the same URL
//     to the clipboard and surfaces a toast.
//
// Usage:
//   make wasm
//   node tests/pwa_share_replay.mjs

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

// Synthetic dashboard payload: one completed game (eligible for share) and
// one in-progress one (must NOT render a share button).
const ME = { id: 42, display_name: 'Alice', elo: 1500, is_guest: false };
const GAMES = [
  {
    id: 4242, room_code: 'COMPL1', status: 'complete',
    host_user_id: 42, join_user_id: 99, winner_user_id: 42, winner_color: 1,
    host_name: 'Alice', join_name: 'Bob',
    mode: 'standard', move_count: 24,
    created_at: '2026-05-20T10:00:00Z', last_move_at: '2026-05-20T10:20:00Z',
    ended_at: '2026-05-20T10:20:00Z',
  },
  {
    id: 4343, room_code: 'PLAY01', status: 'playing',
    host_user_id: 42, join_user_id: 100, winner_user_id: null,
    your_turn: true, active_index: 0, my_role: 'host',
    host_name: 'Alice', join_name: 'Carol',
    mode: 'standard', move_count: 4,
    created_at: '2026-05-23T10:00:00Z', last_move_at: '2026-05-23T11:00:00Z',
  },
];

async function startServer() {
  const server = createServer(async (req, res) => {
    let p = (req.url || '/').split('?')[0];
    if (p === '/' || p === '') p = '/index.html';

    // Backend mocks. Returning JSON inline avoids the need for a real
    // relay + DB just to exercise the dashboard rendering path.
    if (p === '/api/config') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ providers: {} })); return;
    }
    if (p === '/api/me') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(ME)); return;
    }
    if (p === '/api/notifications') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ count: 0, items: [] })); return;
    }
    if (p === '/api/games') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(GAMES)); return;
    }

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

  // Pre-stage matchMedia + navigator.share BEFORE the SPA boots so the
  // helper sees the coarse-pointer + share-capable environment on first
  // render. The SPA reads pointer media at click time, not on boot, so
  // injecting these later would also work — pre-staging is just safer.
  await page.addInitScript(() => {
    window.__shared = null;
    window.__shareCalls = 0;
    window.__clipCalls = 0;
    window.__clipLast = null;
    const realMM = window.matchMedia?.bind(window);
    window.matchMedia = (q) => q === '(pointer: coarse)'
      ? { matches: true, addEventListener() {}, removeEventListener() {} }
      : (realMM ? realMM(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
    navigator.share = async (payload) => {
      window.__shareCalls += 1;
      window.__shared = payload;
    };
    navigator.clipboard = navigator.clipboard || {};
    navigator.clipboard.writeText = async (s) => {
      window.__clipCalls += 1;
      window.__clipLast = s;
    };
  });

  await page.goto(url);
  await page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 15000 });

  // Navigate to dashboard. renderDashboard will fetch /api/games (mocked
  // above) and run the real renderGameCard path.
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForSelector('#view-dashboard:not(.hidden)', { timeout: 10000 });
  await page.waitForSelector('[data-game-id="4242"]', { timeout: 10000 });

  // Completed game has a share button; playing game does not.
  const completedHasShare = await page.locator('[data-game-id="4242"] [data-action="share"]').count();
  const playingHasShare   = await page.locator('[data-game-id="4343"] [data-action="share"]').count();
  if (completedHasShare !== 1) fail(`completed card has ${completedHasShare} share buttons, expected 1`);
  if (playingHasShare   !== 0) fail(`playing card has ${playingHasShare} share buttons, expected 0`);
  console.log('  ok: share button gated to completed games');

  // Click share on the completed row. The helper should call
  // navigator.share with a URL pointing at /#/games/4242.
  await page.click('[data-game-id="4242"] [data-action="share"]');
  await page.waitForFunction(() => window.__shareCalls === 1, null, { timeout: 5000 });
  const shared = await page.evaluate(() => window.__shared);
  if (!shared || !shared.url || !shared.url.endsWith('/#/games/4242')) {
    fail(`share payload missing replay URL: ${JSON.stringify(shared)}`);
  }
  console.log('  ok: share button invokes navigator.share with canonical URL');

  // AbortError must NOT fall through to clipboard.
  await page.evaluate(() => {
    window.__shareCalls = 0;
    window.__clipCalls = 0;
    navigator.share = async () => {
      window.__shareCalls += 1;
      const e = new Error('User cancelled');
      e.name = 'AbortError';
      throw e;
    };
  });
  await page.click('[data-game-id="4242"] [data-action="share"]');
  await page.waitForFunction(() => window.__shareCalls === 1, null, { timeout: 5000 });
  // Give the helper a tick to finish before asserting no clipboard write.
  await page.waitForTimeout(50);
  const clipsAfterAbort = await page.evaluate(() => window.__clipCalls);
  if (clipsAfterAbort !== 0) fail(`AbortError fell through to clipboard (${clipsAfterAbort} writes)`);
  console.log('  ok: AbortError from share sheet does not fall through to clipboard');

  // Desktop fallback: drop navigator.share, click again, expect a clipboard
  // write + toast.
  await page.evaluate(() => {
    window.__clipCalls = 0;
    window.__clipLast = null;
    delete navigator.share;
  });
  await page.click('[data-game-id="4242"] [data-action="share"]');
  await page.waitForFunction(() => window.__clipCalls === 1, null, { timeout: 5000 });
  const copied = await page.evaluate(() => window.__clipLast);
  if (!copied || !copied.endsWith('/#/games/4242')) {
    fail(`clipboard did not receive canonical URL: ${copied}`);
  }
  await page.waitForSelector('.toast', { timeout: 3000 });
  console.log('  ok: desktop fallback copies link + shows toast');

  if (errs.length) fail(`page errors during run: ${errs.join('; ')}`);

  console.log('\nPWA share replay test: PASS');
} catch (e) {
  console.error('FAIL:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
  process.exit(exitCode);
}
