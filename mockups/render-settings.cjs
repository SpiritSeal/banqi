const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const REPO_ROOT = path.resolve(__dirname, '..');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/web/index.html';
      if (urlPath === '/web/banqi.js' || urlPath === '/web/banqi.wasm') {
        const body = urlPath.endsWith('.js')
          ? 'export default function createBanqiModule() { return Promise.resolve({ _malloc:()=>0, _free:()=>{}, HEAPU8:new Uint8Array(0) }); };'
          : '';
        res.writeHead(200, { 'Content-Type': urlPath.endsWith('.js') ? 'application/javascript' : 'application/wasm' });
        return res.end(body);
      }
      const fullPath = path.join(REPO_ROOT, urlPath);
      if (!fullPath.startsWith(REPO_ROOT) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) { res.writeHead(404); return res.end(); }
      const ext = path.extname(fullPath).slice(1).toLowerCase();
      const mime = { html:'text/html', js:'application/javascript', mjs:'application/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png', webmanifest:'application/manifest+json', wasm:'application/wasm' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(fullPath));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(base + '/web/index.html', { waitUntil: 'networkidle' });
    await page.click('#btn-open-settings');
    await page.waitForSelector('#setting-game-layout');
    await page.screenshot({ path: 'live-settings-drawer.png', fullPage: false });
    console.log('wrote live-settings-drawer.png');
  } finally {
    await browser.close(); server.close();
  }
})();
