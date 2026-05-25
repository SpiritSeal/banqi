// Render the actual SPA (lobby + settings drawer + a simulated beta game
// view) so we can eyeball the changes alongside the mockups.
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
          ? 'export default function createBanqiModule() { return Promise.resolve({ _malloc: () => 0, _free: () => {}, HEAPU8: new Uint8Array(0) }); };'
          : '';
        res.writeHead(200, { 'Content-Type': urlPath.endsWith('.js') ? 'application/javascript' : 'application/wasm' });
        return res.end(body);
      }
      const fullPath = path.join(REPO_ROOT, urlPath);
      if (!fullPath.startsWith(REPO_ROOT) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      const ext = path.extname(fullPath).slice(1).toLowerCase();
      const mime = { html:'text/html', js:'application/javascript', mjs:'application/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png', webmanifest:'application/manifest+json', wasm:'application/wasm' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(fullPath));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Sample beta-mode HTML injected into the static slot divs so the
// screenshots show what the layout looks like with content. Mirrors what
// the live render fns would produce mid-game.
function injectBetaContent(coords) {
  // coords: 'game' | 'otb' | 'ai'
  const inject = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  // We're in the page context here (page.evaluate).
  return {
    [`${coords}-slim-header`]: `
      <a class="slim-back" href="#/" aria-label="Back to lobby">←</a>
      <div class="slim-mid">
        <code class="slim-room-code" aria-label="Room 7K3M2">7K3M2</code>
        <span class="mode-chip">Standard</span>
        <span class="mode-chip">10+5</span>
      </div>
      <button class="slim-more" aria-label="More">⋯</button>`,
    [`${coords}-opp-card`]: `
      <div class="player-card player-card-opp player-card-color-black">
        <div class="player-card-id">
          <span class="player-card-avatar avatar-black">W</span>
          <div class="player-card-name-block">
            <div class="player-card-name">Wen</div>
            <div class="player-card-sub">Black</div>
          </div>
        </div>
        <span class="pc-tray">
          <span class="pc-tray-piece pc-tray-red">兵</span>
          <span class="pc-tray-piece pc-tray-red">兵</span>
          <span class="pc-tray-piece pc-tray-red">相</span>
          <span class="pc-tray-diff">+3</span>
        </span>
        <span class="player-card-clock clock"><span class="clock-time">9:18</span></span>
      </div>`,
    [`${coords}-board-coords`]: `<span class="board-coord-file">a</span><span class="board-coord-file">b</span><span class="board-coord-file">c</span><span class="board-coord-file">d</span><span class="board-coord-file">e</span><span class="board-coord-file">f</span><span class="board-coord-file">g</span><span class="board-coord-file">h</span>`,
    [`${coords}-you-card`]: `
      <div class="player-card player-card-you player-card-color-red is-active">
        <div class="player-card-id">
          <span class="player-card-avatar avatar-red">Y</span>
          <div class="player-card-name-block">
            <div class="player-card-name">You <span class="player-card-move">· move</span></div>
            <div class="player-card-sub">Red</div>
          </div>
        </div>
        <span class="pc-tray">
          <span class="pc-tray-piece pc-tray-black">卒</span>
          <span class="pc-tray-piece pc-tray-black">象</span>
        </span>
        <span class="player-card-clock clock active"><span class="clock-time">8:42</span></span>
      </div>`,
    [`${coords}-bottom-bar`]: `
      <button class="bb-btn bb-icon" type="button" aria-label="Step back">↶</button>
      <button class="bb-btn" type="button">Offer draw</button>
      <button class="bb-btn bb-danger" type="button">Resign</button>`,
  };
}

// Populate the transcript panel with a realistic move list so the screenshot
// shows the lower half of portrait the way production users will see it.
// In a real game this is rendered by replay.js `renderTranscript`; we
// hand-roll a representative DOM that uses the production classes.
function injectFakeTranscript(panelId) {
  const rows = [
    [8,  'p2', 'B', '士', 'flip'],
    [9,  'p1', 'R', '炮', 'b1 flip'],
    [10, 'p2', 'B', '將', 'flip'],
    [11, 'p1', 'R', '兵', 'e4–e3'],
    [12, 'p2', 'B', '馬', 'g2–f4'],
    [13, 'p1', 'R', '傌', 'c2–c3'],
    [14, 'p2', 'B', '卒', 'g4 flip', true],
  ].map(([n, klass, label, glyph, notation, current]) => `
    <button class="transcript-row${current ? ' current' : ''}" type="button">
      <span class="t-num">${n}.</span>
      <span class="t-mover mover-${klass}">${label}</span>
      <span class="t-piece">${glyph}</span>
      <span class="t-notation">${notation}</span>
    </button>`).join('');
  return `
    const panel = document.getElementById('${panelId}');
    if (panel) {
      panel.innerHTML = \`
        <div class="transcript-head">
          <h3>Moves</h3>
          <div class="transcript-controls">
            <button type="button">⏮</button>
            <button type="button">◀</button>
            <span class="transcript-step">14 / 14</span>
            <button type="button">▶</button>
            <button type="button" class="transcript-export">PGN</button>
          </div>
        </div>
        <div class="transcript-list">${rows.replace(/\`/g, '\\\\\`')}</div>
      \`;
    }
  `;
}

// Also stuff some cells into the board so the board renders something.
function paintFakeBoard(boardId) {
  return `
    const board = document.getElementById('${boardId}');
    if (board) {
      const cells = [
        ['fd','背'],['fd','背'],['fu red','帥',7],['empty',''],['fd','背'],['fu black','將',7],['fd','背'],['fd','背'],
        ['fd','背'],['fu red selected','俥',4],['empty legal-target',''],['fd','背'],['empty legal-target',''],['fd','背'],['fd','背'],['fu black last-move','兵',1],
        ['fd','背'],['fd','背'],['fu red','傌',3],['empty',''],['fd','背'],['fu black','象',5],['fd','背'],['fd','背'],
        ['fd','背'],['fu red','炮',2],['fd','背'],['fd','背'],['fd','背'],['fd','背'],['fu black','卒',1],['fd','背'],
      ];
      board.innerHTML = cells.map(([cls, txt, val]) => {
        const v = val != null ? '<span class="cell-value">' + val + '</span>' : '';
        return '<button type="button" class="cell ' + cls + '">' + txt + v + '</button>';
      }).join('');
    }
  `;
}

(async () => {
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  try {
    const targets = [
      { name: 'classic-lobby',     viewport: { width: 414, height: 896 }, view: 'lobby', layout: 'classic' },
      { name: 'beta-lobby',        viewport: { width: 414, height: 896 }, view: 'lobby', layout: 'beta' },
      { name: 'beta-game-portrait',viewport: { width: 414, height: 896 }, view: 'game',  layout: 'beta', injectBoard: 'game' },
      { name: 'beta-game-landscape',viewport:{ width: 896, height: 414 }, view: 'game',  layout: 'beta', injectBoard: 'game' },
      { name: 'beta-game-desktop', viewport: { width: 1440, height: 900 }, view: 'game', layout: 'beta', injectBoard: 'game' },
      { name: 'classic-game-portrait', viewport:{ width: 414, height: 896 }, view: 'game', layout: 'classic', injectBoard: 'game' },
    ];

    for (const t of targets) {
      const ctx = await browser.newContext({ viewport: t.viewport, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(base + '/web/index.html', { waitUntil: 'networkidle' });
      // Apply layout + view via the actual settings + showView fns.
      await page.evaluate(({ layout, view, slots, injectBoardCode, injectTranscriptCode }) => {
        document.body.dataset.gameLayout = layout;
        document.body.dataset.activeView = view;
        for (const sec of ['view-lobby','view-game','view-otb','view-ai','view-dashboard']) {
          const el = document.getElementById(sec);
          if (!el) continue;
          if (sec === 'view-' + view) el.classList.remove('hidden');
          else el.classList.add('hidden');
        }
        if (slots) {
          for (const id in slots) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = slots[id];
          }
        }
        if (injectBoardCode) {
          // eslint-disable-next-line no-eval
          eval(injectBoardCode);
        }
        if (injectTranscriptCode) {
          // eslint-disable-next-line no-eval
          eval(injectTranscriptCode);
        }
      }, {
        layout: t.layout,
        view: t.view,
        slots: t.layout === 'beta' && t.view === 'game' ? injectBetaContent('game') : null,
        injectBoardCode: t.injectBoard ? paintFakeBoard(t.injectBoard + '-board') : null,
        injectTranscriptCode: t.layout === 'beta' && t.view === 'game' ? injectFakeTranscript('game-transcript') : null,
      });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `live-${t.name}.png`, fullPage: false });
      console.log('wrote live-' + t.name + '.png');
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('ERROR:', e); process.exitCode = 1; });
