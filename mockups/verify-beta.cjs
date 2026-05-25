// Smoke check for the beta game-layout opt-in. Boots the SPA, stubs the
// wasm so the lobby can render, then exercises the Settings toggle and
// verifies the body attribute + CSS overrides take effect.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..');

// Tiny static server rooted at the repo so relative imports like ../ai/*.mjs
// resolve. The lobby never executes wasm code paths, so we stub banqi.js /
// banqi.wasm with empty modules to let the page boot.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      // The browser loads /web/index.html as the root; the SPA's own
      // imports use relative paths from there.
      if (urlPath === '/') urlPath = '/web/index.html';

      // Stub the wasm + its loader.
      if (urlPath === '/web/banqi.js' || urlPath === '/web/banqi.wasm') {
        const body = urlPath.endsWith('.js')
          ? 'export default function createBanqiModule() { return Promise.resolve({ _malloc: () => 0, _free: () => {}, HEAPU8: new Uint8Array(0) }); };'
          : '';
        res.writeHead(200, {
          'Content-Type': urlPath.endsWith('.js') ? 'application/javascript' : 'application/wasm'
        });
        return res.end(body);
      }

      const fullPath = path.join(REPO_ROOT, urlPath);
      // Guard: don't serve outside the repo.
      if (!fullPath.startsWith(REPO_ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      const ext = path.extname(fullPath).slice(1).toLowerCase();
      const mime = {
        html: 'text/html', js: 'application/javascript', mjs: 'application/javascript',
        css: 'text/css', svg: 'image/svg+xml', png: 'image/png',
        webmanifest: 'application/manifest+json', wasm: 'application/wasm', json: 'application/json',
      }[ext] || 'application/octet-stream';
      const body = fs.readFileSync(fullPath);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function landingUrl(base) { return base + '/web/index.html'; }

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }

(async () => {
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  let ok = true;

  try {
    const context = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) {
        const u = new URL(r.url()).pathname;
        // Ignore expected misses: we don't ship a Firebase API key, the SW
        // tries to prefetch routes that don't exist in this stub server,
        // and favicons may 404 in test runs.
        if (/(\/api\/|\/sw\.js|favicon|webmanifest|\.png$)/.test(u)) return;
        errors.push(`http ${r.status()}: ${u}`);
      }
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // "Failed to load resource" is a generic restatement of an HTTP error;
      // we already check those above. Ignore SW registration warnings too.
      if (/Failed to load resource/.test(t)) return;
      if (/ServiceWorker/i.test(t)) return;
      errors.push(`console.error: ${t}`);
    });

    await page.goto(landingUrl(base), { waitUntil: 'networkidle' });

    // 1. Page should boot to the lobby with no JS errors.
    const lobbyHidden = await page.locator('#view-lobby').evaluate((el) => el.classList.contains('hidden'));
    if (lobbyHidden) { fail('lobby is hidden after boot'); ok = false; }
    else pass('lobby renders on boot');

    if (errors.length) { fail('JS errors during boot:\n' + errors.join('\n')); ok = false; }
    else pass('no JS errors during boot');

    // 2. body should have data-active-view set.
    const activeView = await page.evaluate(() => document.body.dataset.activeView);
    if (activeView !== 'lobby') { fail(`expected active-view=lobby, got ${activeView}`); ok = false; }
    else pass(`body[data-active-view] = ${activeView}`);

    // 3. body should have data-game-layout=classic by default.
    const layout = await page.evaluate(() => document.body.dataset.gameLayout);
    if (layout !== 'classic') { fail(`expected data-game-layout=classic, got ${layout}`); ok = false; }
    else pass(`body[data-game-layout] = ${layout} (default)`);

    // 4. Open settings drawer and verify the new "Game layout" row exists.
    await page.click('#btn-open-settings');
    await page.waitForSelector('#setting-game-layout', { timeout: 2000 });
    const labelText = await page.locator('label[for="setting-game-layout"] .setting-label').textContent();
    if (!labelText.includes('Game layout')) { fail(`expected "Game layout" label, got "${labelText}"`); ok = false; }
    else pass(`drawer shows "Game layout" row (label="${labelText.trim()}")`);
    const betaBadge = await page.locator('.beta-badge').count();
    if (!betaBadge) { fail('beta badge missing from drawer'); ok = false; }
    else pass('beta badge present in drawer');

    // 5. Switch to beta and verify body attribute updated + persistence.
    await page.selectOption('#setting-game-layout', 'beta');
    const newLayout = await page.evaluate(() => document.body.dataset.gameLayout);
    if (newLayout !== 'beta') { fail(`expected data-game-layout=beta after select, got ${newLayout}`); ok = false; }
    else pass(`body[data-game-layout] = ${newLayout} after toggle`);
    const stored = await page.evaluate(() => localStorage.getItem('banqi.settings.v1'));
    if (!stored?.includes('"gameLayout":"beta"')) { fail(`gameLayout not persisted to localStorage: ${stored}`); ok = false; }
    else pass('gameLayout persisted to localStorage');

    // 6. The classic site header + app-nav are still visible on the lobby
    //    (beta only hides them inside the game views).
    const headerHidden = await page.locator('header').first().evaluate((el) => {
      return getComputedStyle(el).display === 'none';
    });
    if (headerHidden) { fail('site header should be visible on lobby even with beta on'); ok = false; }
    else pass('site header stays visible on lobby under beta');

    // 7. Close settings, switch back to classic, verify revert.
    // (Press Escape to close the drawer.)
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      // re-open silently to read the select state
      window.dispatchEvent(new CustomEvent('test:noop'));
    });
    // Toggle back via localStorage path + settings event.
    await page.evaluate(async () => {
      const s = await import('/web/settings.js');
      s.setSetting('gameLayout', 'classic');
    });
    const reverted = await page.evaluate(() => document.body.dataset.gameLayout);
    if (reverted !== 'classic') { fail(`revert to classic failed: ${reverted}`); ok = false; }
    else pass('reverted to classic via setSetting()');

    // 8. Simulate entering a game view and verify chrome hiding rules
    //    activate. We can't really start a game without the wasm, but we
    //    can call showView('game') indirectly and inspect CSS effects.
    await page.evaluate(() => {
      document.body.dataset.gameLayout = 'beta';
      document.body.dataset.activeView = 'game';
    });
    const siteHeaderInGame = await page.locator('.page > header').first().evaluate((el) => {
      return getComputedStyle(el).display;
    });
    if (siteHeaderInGame !== 'none') { fail(`expected site header hidden in beta game view, got display=${siteHeaderInGame}`); ok = false; }
    else pass('site header hides inside game view under beta');
    const navInGame = await page.locator('.page > nav.app-nav').first().evaluate((el) => {
      return getComputedStyle(el).display;
    });
    if (navInGame !== 'none') { fail(`expected app-nav hidden in beta game view, got display=${navInGame}`); ok = false; }
    else pass('app-nav hides inside game view under beta');

    // 9. Empty slot collapses (no innerHTML => display:none).
    const emptySlimHidden = await page.locator('#game-slim-header').evaluate((el) => {
      return getComputedStyle(el).display;
    });
    if (emptySlimHidden !== 'none') { fail(`expected empty slim header collapsed, got display=${emptySlimHidden}`); ok = false; }
    else pass('empty slot collapses (no flash of empty containers)');

    // 10. Fill the slim header slot and verify it now shows.
    await page.evaluate(() => {
      document.getElementById('game-slim-header').innerHTML = '<a class="slim-back" href="#/">←</a><div class="slim-mid"><span class="slim-room"><code>TEST</code></span></div><button class="slim-more">⋯</button>';
    });
    const slimVisible = await page.locator('#game-slim-header').evaluate((el) => {
      return getComputedStyle(el).display;
    });
    if (slimVisible === 'none') { fail('populated slim header should be visible'); ok = false; }
    else pass(`populated slim header shows (display=${slimVisible})`);

  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('ERROR:', e); process.exitCode = 1; });
