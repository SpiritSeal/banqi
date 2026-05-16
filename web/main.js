// Banqi web client.
//
// Three play modes:
//   * online — WebSocket to the server-authoritative engine; server runs the
//              rule engine, sends state pushes, accepts intents
//   * otb    — local hot-seat, one shared WASM Game between both seats
//   * ai     — local vs-AI, single WASM Game with the AI as player 1
//
// The WASM module is only used for OTB + AI. Online games never instantiate
// Module.Game on the client; the server is the only authority.
//
// Hash routing: #/ (lobby), #/g/<roomCode> (game), #/otb, #/ai,
//               #/dashboard, #/leaderboard, #/profile/<id>.

import createBanqiModule from './banqi.js';
import { RelayConnection } from './relay.js';
import { chooseMove, Difficulty } from './ai.js';
import { Replay, renderTranscript } from './replay.js';
import * as Notify from './notifications.js';
import { playMoveSound } from './audio.js';
import { computeMoveHints, cellHintKind } from './board-hints.js';

// ---- service worker / PWA ----
if ('serviceWorker' in navigator) {
  let _swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloading) return;
    _swReloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const showUpdateBanner = (worker) => {
      if (document.getElementById('sw-update-banner')) return;
      const b = document.createElement('div');
      b.id = 'sw-update-banner';
      b.className = 'sw-update-banner';
      b.innerHTML =
        '<span>A new version of Banqi is available.</span>' +
        '<button id="sw-update-apply" class="primary">Update</button>' +
        '<button id="sw-update-dismiss" class="link-btn">Later</button>';
      document.body.appendChild(b);
      document.getElementById('sw-update-apply').onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
      document.getElementById('sw-update-dismiss').onclick = () => b.remove();
    };
    if (reg.waiting) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });
  }).catch((e) => console.warn('SW registration failed:', e));
}

// WASM only powers OTB + AI now, but we kick the load early to keep navigation
// snappy.
let Module = null;
const _moduleReady = createBanqiModule().then((m) => { Module = m; return m; });

const $ = (id) => document.getElementById(id);

// ---- view containers ----
const views = {
  lobby:       $('view-lobby'),
  game:        $('view-game'),
  otb:         $('view-otb'),
  ai:          $('view-ai'),
  dashboard:   $('view-dashboard'),
  leaderboard: $('view-leaderboard'),
  profile:     $('view-profile'),
  friends:     $('view-friends'),
};
function showView(name) {
  for (const v of Object.values(views)) v?.classList.add('hidden');
  views[name]?.classList.remove('hidden');
  queueMicrotask(() => {
    const view = views[name];
    if (!view) return;
    const target = view.querySelector('h2[tabindex], h2, button, a[href], select, input, [tabindex="0"]');
    target?.focus({ preventScroll: false });
  });
}

let _announceTimer = null;
function announce(text) {
  if (!text) return;
  const el = document.getElementById('sr-announce');
  if (!el) return;
  el.textContent = '';
  clearTimeout(_announceTimer);
  _announceTimer = setTimeout(() => { el.textContent = String(text); }, 30);
}

// ---- session ----
let me = null;
let providers = { github: false, google: false, dev: false, guest: false };

// ---- online/offline ----
let online = navigator.onLine;
function ensureOfflineBanner() {
  let b = document.getElementById('offline-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'offline-banner';
    b.className = 'offline-banner';
    b.textContent = "You're offline — online play resumes when you reconnect.";
    document.body.insertBefore(b, document.body.firstChild);
  }
  b.hidden = online;
}
function setOnline(v) {
  if (online === v) return;
  online = v;
  document.body.classList.toggle('is-offline', !online);
  ensureOfflineBanner();
  if (!location.hash || location.hash === '#/' || location.hash === '#') renderLobby();
}
window.addEventListener('online',  () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
if (!online) document.body.classList.add('is-offline');

// ---- iOS A2H hint ----
function isIOSSafari() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|UCBrowser/.test(ua);
  return iOS && safari;
}
function inStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}
function maybeShowAddToHomeHint() {
  if (!isIOSSafari() || inStandalone()) return;
  try { if (localStorage.getItem('banqi.a2h-dismissed') === '1') return; } catch (_) {}
  if (document.getElementById('a2h-banner')) return;
  const b = document.createElement('div');
  b.id = 'a2h-banner';
  b.className = 'a2h-banner';
  b.setAttribute('role', 'note');
  b.innerHTML =
    '<div class="a2h-text"><b>Install Banqi:</b> tap ' +
      '<svg class="a2h-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2l4 4h-3v8h-2V6H8l4-4zM5 12h2v7h10v-7h2v9H5z"/>' +
      '</svg> Share, then <b>Add to Home Screen</b>.</div>' +
    '<button id="a2h-dismiss" class="link-btn" aria-label="Dismiss install hint">Dismiss</button>';
  document.body.appendChild(b);
  document.getElementById('a2h-dismiss').onclick = () => {
    try { localStorage.setItem('banqi.a2h-dismissed', '1'); } catch (_) {}
    b.remove();
  };
}

async function refreshSession() {
  try {
    const conf = await fetch('/api/config').then(r => r.json());
    providers = conf.providers || {};
  } catch (_) { providers = {}; }
  try {
    const r = await fetch('/api/me');
    me = r.ok ? await r.json() : null;
  } catch (_) { me = null; }
}

// ---- routing ----
async function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/g\/([0-9A-Za-z]+)$/);
  if (m) { announce(`Game room ${m[1]}`); return openOnlineGame(m[1].toUpperCase()); }

  const mp = hash.match(/^#\/profile\/(\d+)$/);
  if (mp) { announce('Profile'); return renderProfile(+mp[1]); }

  const ma = hash.match(/^#\/add-friend\/(\d+-[0-9a-f]{16})$/);
  if (ma) { announce('Add friend'); return addFriendByToken(ma[1]); }

  switch (hash) {
    case '#/otb':         announce('Hot-seat game');   return openOTB();
    case '#/ai':          announce('Vs AI game');       return openAIGame();
    case '#/dashboard':   announce('My games');         return renderDashboard();
    case '#/leaderboard': announce('Leaderboard');      return renderLeaderboard();
    case '#/friends':     announce('Friends');          return renderFriends();
    default:              announce('Lobby');            return renderLobby();
  }
}
window.addEventListener('hashchange', route);

// ---- sign-in ----
function renderSignInButtons(container, nextHash, { includeGuest = true } = {}) {
  const next = nextHash && nextHash.startsWith('#') ? `/${nextHash}` : '/';
  const q = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;
  const buttons = [];
  if (providers.github) buttons.push(`<a class="primary" href="/auth/github${q}">Sign in with GitHub</a>`);
  if (providers.google) buttons.push(`<a class="primary" href="/auth/google${q}">Sign in with Google</a>`);
  if (providers.dev) {
    buttons.push(`
      <form class="dev-signin" data-dev-signin>
        <label for="dev-signin-name" class="sr-only">Display name</label>
        <input id="dev-signin-name" type="text" placeholder="Display name"
               maxlength="40" autocomplete="off" required>
        <button type="submit" class="primary">Sign in (dev)</button>
      </form>`);
  }
  if (includeGuest && providers.guest) {
    buttons.push(`<a class="link-btn" href="/auth/guest${q}">Continue as guest</a>`);
  }
  if (buttons.length === 0) {
    buttons.push(`<div class="muted">Sign-in is not configured. Ask the relay admin to set OAuth credentials.</div>`);
  }
  container.innerHTML = `<div class="sign-in">${buttons.join(' ')}</div>`;
  const devForm = container.querySelector('[data-dev-signin]');
  if (devForm) {
    devForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (devForm.querySelector('#dev-signin-name').value || 'Player').trim() || 'Player';
      const params = new URLSearchParams({ name });
      if (q) params.set('next', next);
      location.href = `/auth/dev?${params.toString()}`;
    });
  }
}

// ---- lobby ----
function renderLobby() {
  showView('lobby');
  const meBox = $('lobby-me');
  if (me) {
    const guestBadge = me.is_guest ? ' <span class="muted small">(guest — not rated)</span>' : '';
    const links = me.is_guest
      ? `· <a href="#/dashboard">my games</a>`
      : `· <a href="#/dashboard">my games</a>
         · <a href="#/leaderboard">leaderboard</a>
         · <a href="#/friends">friends<span id="nav-notif-badge" class="badge hidden"></span></a>
         · <a href="#/profile/${me.id}">profile</a>`;
    meBox.innerHTML = `
      <div class="me-row">
        <div><b>Hi, ${escapeHtml(me.display_name)}</b>${guestBadge}
          ${me.is_guest ? '' : `· Elo ${me.elo}`}
          ${links}
        </div>
        <button id="btn-signout" class="link-btn">Sign out</button>
      </div>`;
    $('btn-signout').onclick = signOut;
    if (!me.is_guest) refreshNotificationBadge();
  } else {
    renderSignInButtons(meBox, null);
  }
  ensureOfflineBanner();
  maybeShowAddToHomeHint();
  $('btn-start-online').disabled = !me || !online;
  $('btn-start-online').title = !online ? "You're offline — connect to start an online game" : '';
  $('btn-start-online').onclick = startOnlineGame;
  $('btn-otb').onclick = () => { location.hash = '#/otb'; };
  $('btn-ai').onclick = () => { location.hash = '#/ai'; };
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  me = null;
  route();
}

async function startOnlineGame() {
  if (!me) return;
  const res = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) { toast('Could not create game. Try again.', { kind: 'error' }); return; }
  const g = await res.json();
  location.hash = `#/g/${g.roomCode}`;
}

// ---- online (server-authoritative) game ----
let active = null;

async function openOnlineGame(roomCode) {
  showView('game');
  $('game-header').innerHTML = `<div class="muted">Connecting to room <code>${roomCode}</code>…</div>`;

  if (!me) {
    const header = $('game-header');
    header.innerHTML = `
      <div class="invite-signin">
        <h2>You've been invited to a game</h2>
        <p>Sign in to join room <code>${escapeHtml(roomCode)}</code>. We'll bring you right back here.</p>
        <div id="invite-signin-buttons"></div>
        <p class="muted small"><a href="#/">← Back to lobby</a></p>
      </div>`;
    renderSignInButtons($('invite-signin-buttons'), `#/g/${roomCode}`);
    return;
  }

  if (!online) {
    $('game-header').innerHTML = `
      <div class="err">You're offline. Online play resumes when you reconnect.
      <button id="game-retry" class="link-btn">Retry</button> ·
      <a href="#/">Back to lobby</a></div>`;
    $('game-retry').onclick = () => openOnlineGame(roomCode);
    return;
  }

  let info;
  try {
    info = await fetch(`/api/games/by-room/${encodeURIComponent(roomCode)}`).then(r => r.json());
    if (info.error) throw new Error(info.error);
  } catch (e) {
    $('game-header').innerHTML = `<div class="err">Couldn't find room <code>${roomCode}</code>.</div>`;
    return;
  }

  if (info.my_role == null) {
    const jr = await fetch(`/api/games/${info.id}/join`, { method: 'POST' });
    if (!jr.ok) {
      $('game-header').innerHTML = `<div class="err">This game is full.</div>`;
      return;
    }
    info = await fetch(`/api/games/${info.id}`).then(r => r.json());
  }

  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const conn = new RelayConnection(`${wsScheme}://${location.host}/ws/${info.id}`);

  active = {
    isOnline: true,
    info,
    conn,
    state: info.state || null,
    role:  info.my_role,
    selected: null,
    connState: 'connecting',
    replay: new Replay(),
    flashCellIdx: -1,
    flashUntil: 0,
  };
  if (info.events) active.replay.setEvents(info.events);

  conn.on('open',  () => { active.connState = 'live'; refreshGame(); });
  conn.on('close', () => { active.connState = 'offline'; refreshGame(); });
  conn.on('reconnecting', () => { active.connState = 'reconnecting'; refreshGame(); });
  conn.on('frame', (frame) => {
    if (!active?.isOnline) return;
    if (frame.type === 'snapshot') {
      const wasMyTurnBefore = isMyTurn(active.state);
      active.state = frame.state;
      active.replay.setEvents(frame.events || []);
      active.connState = 'live';
      maybeNotifyTurnTransition(wasMyTurnBefore);
      refreshGame();
      return;
    }
    if (frame.type === 'event') {
      const wasMyTurnBefore = isMyTurn(active.state);
      active.state = frame.state;
      active.replay.appendEvent(frame.event);
      playMoveSound(frame.event);
      if (frame.event.mover !== rolePlayerIndex(active)) {
        announce(`Opponent: ${describeAction(frame.event)}`);
        const to = frame.event.action?.to;
        if (typeof to === 'number') {
          active.flashCellIdx = to;
          active.flashUntil = Date.now() + 1200;
        }
      }
      maybeNotifyTurnTransition(wasMyTurnBefore);
      refreshGame();
      return;
    }
    if (frame.type === 'reject') {
      toast(`Move rejected: ${frame.reason || 'illegal'}`, { kind: 'warn' });
      return;
    }
  });

  refreshGame();
}

function rolePlayerIndex(act) {
  return act.role === 'host' ? 0 : act.role === 'join' ? 1 : -1;
}

// "It's my turn right now" for the live online game. False before the first
// flip and once the game is over.
function isMyTurn(state) {
  if (!state) return false;
  if (state.game_over) return false;
  if (!state.first_flip_done) return false;
  return state.side_to_move === state.my_player_index;
}

// Driven by every WS frame. Fires the in-page Notification + sound + title-bar
// alert on the not-my-turn → my-turn edge, and clears the title alert when it
// turns back into the opponent's turn (or the game ends).
function maybeNotifyTurnTransition(wasMyTurnBefore) {
  if (!active?.isOnline) return;
  const nowMine = isMyTurn(active.state);
  if (nowMine && !wasMyTurnBefore) {
    const opp = active.role === 'host'
      ? active.info?.join_name
      : active.info?.host_name;
    Notify.onYourTurn({
      opponentName: opp || null,
      roomCode: active.info?.room_code || null,
    });
  } else if (!nowMine && wasMyTurnBefore) {
    Notify.clearTurnAlert();
  }
}

// Plain-English description of an event, for the SR announcer.
function describeAction(event) {
  const a = event.action || {};
  const toCoord = (i) => i >= 0 ? 'abcdefgh'[i % 8] + ((i >> 3) + 1) : '';
  const PIECE = ['', 'Soldier', 'Cannon', 'Horse', 'Chariot', 'Elephant', 'Advisor', 'General'];
  if (a.kind === 'flip') {
    const r = event.revealed;
    const name = r ? `${r.color === 1 ? 'Red' : 'Black'} ${PIECE[r.type] || ''}`.trim() : 'face-down piece';
    return `flipped ${toCoord(a.to)} — ${name}`;
  }
  if (a.kind === 'move') {
    let s = `${toCoord(a.from)} to ${toCoord(a.to)}`;
    if (event.capture) {
      const c = event.capture;
      s += `, capturing ${c.color === 1 ? 'Red' : 'Black'} ${PIECE[c.type] || ''}`.trim();
    }
    return s;
  }
  if (a.kind === 'resign') return 'resigned';
  return 'made a move';
}

function viewState(act, liveState) {
  const lastMoveCells = act.replay?.lastMoveCells() || null;
  const flashCellIdx = act.flashUntil && Date.now() < act.flashUntil ? act.flashCellIdx : -1;
  if (!act.replay || act.replay.isLive()) {
    return { ...liveState, replayViewing: false, lastMoveCells, flashCellIdx };
  }
  const finality = act.replay.finalityFor(liveState);
  let replayMoveCells = null;
  if (act.replay.viewIndex >= 0) {
    const snap = act.replay.snapshots[act.replay.viewIndex];
    if (snap?.action?.kind === 'move') replayMoveCells = { from: snap.action.from, to: snap.action.to };
    else if (snap?.action?.kind === 'flip') replayMoveCells = { from: -1, to: snap.action.to };
  }
  return {
    ...liveState,
    cells: act.replay.cellsFor(liveState.cells),
    legal_moves_for_me: [],
    game_over: finality.game_over,
    winner: finality.winner,
    replayViewing: true,
    replayMoveCells,
  };
}

function refreshGame() {
  if (!active?.isOnline) return;
  if (!active.state) return;
  const liveState = active.state;
  const view = viewState(active, liveState);
  renderBoard($('game-board'), view, (idx) => {
    if (view.replayViewing) return;
    onOnlineCellClick(idx, view);
  });
  const opp = active.role === 'host' ? active.info.join_name : active.info.host_name;
  const colorChip = liveState.my_color === 1
    ? '<span class="color-chip red" aria-label="You are Red">帥 Red</span>'
    : liveState.my_color === 2
      ? '<span class="color-chip black" aria-label="You are Black">將 Black</span>'
      : '';
  const connState = active.connState || 'connecting';
  const connLabel = connState === 'live' ? 'Live'
                   : connState === 'reconnecting' ? 'Reconnecting…'
                   : connState === 'offline' ? 'Offline'
                   : 'Connecting…';
  const replayBadge = view.replayViewing
    ? `<div class="replay-badge">Reviewing move ${active.replay.currentStep()}/${active.replay.totalMoves()}</div>`
    : '';
  const disconnectBanner = connState !== 'live' && connState !== 'connecting'
    ? `<div class="disconnect-banner" role="alert">
         <span>${connState === 'offline'
            ? 'Connection lost. Trying to reconnect…'
            : 'Reconnecting to the server…'}</span>
         <button id="btn-retry-conn" type="button">Retry now</button>
       </div>`
    : '';
  const counts = pieceCounts(view.cells, active.replay);
  $('game-header').innerHTML = `
    ${disconnectBanner}
    <div class="meta game-meta">
      ${replayBadge}
      <div class="meta-row meta-row-top">
        <div class="meta-room">
          <span class="meta-label">Room</span>
          <code>${escapeHtml(active.info.room_code)}</code>
          <button id="btn-copy-link" class="link-btn" type="button" aria-label="Copy invite link">Copy invite link</button>
        </div>
        <div class="meta-row-right">
          <span class="conn-state conn-${connState}" aria-live="polite" aria-atomic="true">${connLabel}</span>
          <a class="link-btn" href="#/dashboard">My games</a>
        </div>
      </div>
      <div class="meta-row">
        <div><span class="meta-label">You vs</span> <strong>${escapeHtml(opp || '(waiting for opponent)')}</strong> ${colorChip}</div>
        <button id="btn-resign" class="btn-danger-inline" type="button"
          ${liveState.first_flip_done && !liveState.game_over && !view.replayViewing ? '' : 'disabled'}>Resign</button>
      </div>
      <div class="meta-row meta-row-status">
        <span><span class="meta-label">Move</span> ${active.replay.totalMoves()}</span>
        <span><span class="meta-label">Status</span> <span id="game-status-line">${statusLabel(liveState, active.info)}</span></span>
        <span><span class="meta-label">Turn</span> <span id="game-turn">${turnLabel(liveState)}</span></span>
      </div>
      <div class="meta-row meta-row-counts">
        ${renderPieceCountsHtml(counts)}
      </div>
    </div>`;
  $('btn-copy-link').onclick = copyInviteLink;
  $('btn-resign').onclick = async () => {
    if (!active.replay.isLive()) return;
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: 'Your opponent will win. This can’t be undone.',
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    sendIntent({ kind: 'resign' });
  };
  const retryBtn = $('btn-retry-conn');
  if (retryBtn) retryBtn.onclick = () => { active.conn?.reconnect?.(); };

  renderTranscript($('game-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshGame(); },
  });
}

function sendIntent(intent) {
  if (!active?.isOnline || !active.conn) return;
  active.conn.send({ type: 'intent', ...intent });
}

function turnLabel(state) {
  if (!state.first_flip_done) return 'waiting for first flip';
  if (state.game_over) return 'finished';
  return state.side_to_move === state.my_player_index ? 'your turn' : 'opponent\'s turn';
}
function statusLabel(state, info) {
  if (state.game_over) {
    const w = state.winner;
    return `winner: ${w === 1 ? 'Red' : w === 2 ? 'Black' : '—'}`;
  }
  if (info.join_user_id == null || info.status === 'waiting') return 'waiting for opponent to join';
  return 'playing';
}

function onOnlineCellClick(idx, state) {
  if (state.game_over) return;
  if (state.replayViewing) return;
  if (state.side_to_move !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      sendIntent({ kind: 'flip', cell: idx });
      return;
    }
    if (c.state === 'faceup' && c.color === state.my_color &&
        legal.some(m => m.from === idx)) {
      active.selected = idx;
      refreshGame();
    }
    return;
  }
  if (legal.some(m => m.from === active.selected && m.to === idx)) {
    const from = active.selected;
    active.selected = null;
    sendIntent({ kind: 'move', from, to: idx });
    return;
  }
  if (idx === active.selected) { active.selected = null; refreshGame(); return; }
  active.selected = null;
  refreshGame();
}

async function copyInviteLink() {
  if (!active?.info) return;
  const url = `${location.origin}/#/g/${active.info.room_code}`;
  const preferShare = typeof navigator.share === 'function'
    && window.matchMedia?.('(pointer: coarse)').matches;
  if (preferShare) {
    try {
      await navigator.share({
        title: 'Banqi game',
        text: `Join my Banqi game (room ${active.info.room_code})`,
        url,
      });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flashCopied('Copied!');
  } catch (_) {
    prompt('Share this link:', url);
  }
}
function flashCopied(label = 'Copied!') {
  const btn = $('btn-copy-link');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ---- OTB (single shared local Game) ----
async function openOTB() {
  showView('otb');
  await _moduleReady;
  const game = Module.Game.create();
  active = {
    isOTB: true,
    game,
    selected: null,
    replay: new Replay(),
  };
  refreshOTB();
}

function localApply(intent) {
  // Apply intent to the local WASM game and synthesize a replay-shaped event.
  const game = active.game;
  const stm = game.sideToMovePlayer();
  let event = { seq: active.replay.totalMoves(), ts: Date.now(), mover: stm, action: null,
                revealed: null, capture: null, game_over: false, winner: 0 };
  if (intent.kind === 'flip') {
    const piece = JSON.parse(game.applyFlip(stm, intent.cell));
    event.action = { kind: 'flip', to: intent.cell };
    event.revealed = piece;
  } else if (intent.kind === 'move') {
    const before = JSON.parse(game.stateJson(-1));
    const dst = before.cells[intent.to];
    game.applyMove(stm, intent.from, intent.to);
    if (dst.state === 'faceup') event.capture = { color: dst.color, type: dst.type, glyph: dst.glyph };
    event.action = { kind: 'move', from: intent.from, to: intent.to };
  } else if (intent.kind === 'resign') {
    game.applyResign(stm);
    event.action = { kind: 'resign' };
  }
  event.game_over = game.gameOver();
  event.winner = game.winner();
  active.replay.appendEvent(event);
  playMoveSound(event);
  return event;
}

function refreshOTB() {
  if (!active?.isOTB) return;
  const liveState = JSON.parse(active.game.stateJson(-1));
  const view = viewState(active, liveState);
  renderBoard($('otb-board'), view, (idx) => {
    if (view.replayViewing) return;
    onLocalCellClick(idx, view, 'otb');
  });
  let banner;
  if (view.replayViewing) {
    banner = `Replay — viewing move ${active.replay.currentStep()} / ${active.replay.totalMoves()}`;
  } else if (view.game_over) {
    const w = view.winner;
    banner = `Game over — winner: ${w === 1 ? 'Red' : w === 2 ? 'Black' : '—'}`;
  } else if (!view.first_flip_done) {
    banner = `Player 1 — flip a piece (your color is decided by your first flip)`;
  } else {
    const turnIdx = liveState.side_to_move;
    const sideName = turnIdx === 0 ? 'Player 1' : 'Player 2';
    const movingColor = turnIdx === 0 ? liveState.player0_color : liveState.player1_color;
    banner = `${sideName}'s turn (${colorWord(movingColor)})`;
  }
  $('otb-banner').textContent = banner;
  $('otb-counts').innerHTML = renderPieceCountsHtml(pieceCounts(view.cells, active.replay));
  $('otb-resign').disabled = !liveState.first_flip_done || liveState.game_over || view.replayViewing;
  $('otb-resign').onclick = async () => {
    if (view.replayViewing) return;
    const turnIdx = active.game.sideToMovePlayer();
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: `Player ${turnIdx + 1} resigns. The other player wins. This can't be undone.`,
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    try { localApply({ kind: 'resign' }); }
    catch (e) { toast(`Couldn't resign: ${e.message || e}`, { kind: 'error' }); }
    refreshOTB();
  };

  renderTranscript($('otb-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshOTB(); },
  });
}
function colorWord(c) { return c === 1 ? 'Red' : c === 2 ? 'Black' : ''; }

function onLocalCellClick(idx, state, mode) {
  if (state.game_over) return;
  if (state.replayViewing) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  const refresh = () => mode === 'otb' ? refreshOTB() : refreshAI();
  const sideToMove = state.side_to_move;
  if (mode === 'ai' && sideToMove !== state.my_player_index) return;
  if (mode === 'ai' && active.aiThinking) return;

  const myColorForClick = mode === 'ai' ? state.my_color : (
    sideToMove === 0 ? state.player0_color : state.player1_color
  );

  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { localApply({ kind: 'flip', cell: idx }); }
      catch (e) { console.warn(e); }
      if (mode === 'ai') scheduleAIMove();
      refresh();
      return;
    }
    if (c.state === 'faceup' && c.color === myColorForClick &&
        legal.some(m => m.from === idx)) {
      active.selected = idx;
      refresh();
    }
    return;
  }
  if (legal.some(m => m.from === active.selected && m.to === idx)) {
    const from = active.selected;
    active.selected = null;
    try { localApply({ kind: 'move', from, to: idx }); }
    catch (e) { console.warn(e); }
    if (mode === 'ai') scheduleAIMove();
    refresh();
    return;
  }
  if (idx === active.selected) { active.selected = null; refresh(); return; }
  active.selected = null;
  refresh();
}

// ---- vs AI (single local Game; human = player 0, AI = player 1) ----
const AI_THINK_DELAY_MS = 350;

async function openAIGame() {
  const difficulty = $('lobby-ai-difficulty')?.value || Difficulty.MEDIUM;
  await _moduleReady;
  _startAIGame(difficulty);
}

function _startAIGame(difficulty) {
  showView('ai');
  const game = Module.Game.create();
  active = {
    isAI: true,
    game,
    difficulty,
    selected: null,
    aiThinking: false,
    replay: new Replay(),
  };
  $('ai-resign').onclick = async () => {
    if (!active?.isAI) return;
    const state = JSON.parse(active.game.stateJson(0));
    if (!state.first_flip_done || state.game_over) return;
    if (state.side_to_move !== 0) return;
    if (!active.replay.isLive()) return;
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: 'You forfeit the game. The AI wins. This can’t be undone.',
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    try { localApply({ kind: 'resign' }); }
    catch (e) { toast(`Couldn't resign: ${e.message || e}`, { kind: 'error' }); }
    refreshAI();
  };
  $('ai-new-game').onclick = () => {
    const diff = active?.difficulty || Difficulty.MEDIUM;
    _startAIGame(diff);
  };
  refreshAI();
}

function refreshAI() {
  if (!active?.isAI) return;
  // Human is player 0. Render from the human's POV.
  const liveState = JSON.parse(active.game.stateJson(0));
  const view = viewState(active, liveState);
  renderBoard($('ai-board'), view, (idx) => {
    if (view.replayViewing) return;
    onLocalCellClick(idx, view, 'ai');
  });

  const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', master: 'Master' }[active.difficulty] || '';
  let banner;
  if (view.replayViewing) {
    banner = `Replay — viewing move ${active.replay.currentStep()} / ${active.replay.totalMoves()}`;
  } else if (view.game_over) {
    const w = view.winner;
    if (w === view.my_color) banner = `You win! 🎉`;
    else if (w !== 0)         banner = `AI wins. Better luck next time.`;
    else                      banner = `Game over`;
  } else if (!view.first_flip_done) {
    banner = `Your turn — flip a piece to begin`;
  } else if (view.side_to_move === 0) {
    banner = `Your turn (${colorWord(view.my_color)})`;
  } else {
    banner = active.aiThinking ? `AI is thinking…` : `AI's turn (${colorWord(view.my_color === 1 ? 2 : 1)})`;
  }
  $('ai-banner').textContent = banner;
  $('ai-counts').innerHTML = renderPieceCountsHtml(pieceCounts(view.cells, active.replay));
  const nextDiff = { easy: 'medium', medium: 'hard', hard: 'expert', expert: 'master', master: 'easy' }[active.difficulty] || 'medium';
  $('ai-meta').innerHTML = `
    <span class="meta-label">Difficulty</span>
    <button id="ai-diff-chip" class="diff-chip" type="button"
            aria-label="Difficulty ${diffLabel}. Click to change to ${nextDiff} on next new game"
            title="Click to cycle (takes effect on next New game)">${diffLabel} ↻</button>`;
  $('ai-diff-chip').onclick = () => {
    active.difficulty = nextDiff;
    const sel = $('lobby-ai-difficulty');
    if (sel) sel.value = nextDiff;
    toast(`Difficulty will be ${({easy:'Easy', medium:'Medium', hard:'Hard', expert:'Expert', master:'Master'})[nextDiff]} on the next new game.`,
          { kind: 'info', timeoutMs: 3000 });
    refreshAI();
  };
  $('ai-resign').disabled = !liveState.first_flip_done || liveState.game_over
    || liveState.side_to_move !== 0 || view.replayViewing;
  $('ai-new-game').disabled = false;
  $('ai-thinking').classList.toggle('hidden', !active.aiThinking);

  renderTranscript($('ai-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshAI(); },
  });
}

function scheduleAIMove() {
  if (!active?.isAI) return;
  // Run AI on its turn (player 1).
  const stateAI = JSON.parse(active.game.stateJson(1));
  if (stateAI.game_over) return;
  if (stateAI.side_to_move !== 1) return;

  active.aiThinking = true;
  refreshAI();
  const session = active;
  setTimeout(() => {
    if (active !== session) return;
    const fresh = JSON.parse(active.game.stateJson(1));
    if (fresh.game_over || fresh.side_to_move !== 1) {
      active.aiThinking = false; refreshAI(); return;
    }
    try {
      const move = chooseMove(fresh, 1, active.difficulty);
      if (move) {
        const intent = move.from < 0
          ? { kind: 'flip', cell: move.to }
          : { kind: 'move', from: move.from, to: move.to };
        localApply(intent);
      }
    } catch (e) { console.warn('AI move error:', e); }
    active.aiThinking = false;
    refreshAI();
  }, AI_THINK_DELAY_MS);
}

// ---- shared rendering ----
const PIECE_NAMES = ['', 'Soldier', 'Cannon', 'Horse', 'Chariot', 'Elephant', 'Advisor', 'General'];
const PIECE_TYPE_TOTALS = [0, 5, 2, 2, 2, 2, 2, 1]; // count of each type per color (index = type rank)
const PIECE_GLYPHS = {
  1: ['', '兵', '炮', '傌', '俥', '相', '仕', '帥'],
  2: ['', '卒', '砲', '馬', '車', '象', '士', '將'],
};
// Display order: General → Soldier (rank high to low).
const PIECE_TYPE_DISPLAY_ORDER = [7, 6, 5, 4, 3, 2, 1];

function pieceCounts(cells, replay) {
  const shown = { 1: [0, 0, 0, 0, 0, 0, 0, 0], 2: [0, 0, 0, 0, 0, 0, 0, 0] };
  for (const c of cells) {
    if (c.state === 'faceup' && (c.color === 1 || c.color === 2) && c.type >= 1 && c.type <= 7) {
      shown[c.color][c.type]++;
    }
  }
  const captured = { 1: [0, 0, 0, 0, 0, 0, 0, 0], 2: [0, 0, 0, 0, 0, 0, 0, 0] };
  if (replay) {
    const upTo = replay.isLive()
      ? replay.snapshots.length
      : (replay.viewIndex >= 0 ? replay.viewIndex + 1 : 0);
    for (let i = 0; i < upTo; i++) {
      const cap = replay.snapshots[i]?.capture;
      if (cap && (cap.color === 1 || cap.color === 2) && cap.type >= 1 && cap.type <= 7) {
        captured[cap.color][cap.type]++;
      }
    }
  }
  const build = (color) => {
    const byType = {};
    let shownTotal = 0, hiddenTotal = 0, capturedTotal = 0;
    for (let t = 1; t <= 7; t++) {
      const s = shown[color][t];
      const cap = captured[color][t];
      const h = Math.max(0, PIECE_TYPE_TOTALS[t] - s - cap);
      byType[t] = { shown: s, hidden: h, captured: cap };
      shownTotal += s; hiddenTotal += h; capturedTotal += cap;
    }
    return { shown: shownTotal, hidden: hiddenTotal, captured: capturedTotal, byType };
  };
  return { red: build(1), black: build(2) };
}

function renderPieceCountsHtml(counts) {
  const breakdown = (colorVal, byType, category) => {
    const glyphs = PIECE_GLYPHS[colorVal];
    const parts = [];
    for (const t of PIECE_TYPE_DISPLAY_ORDER) {
      const n = byType[t][category];
      if (n > 0) {
        const name = PIECE_NAMES[t];
        const label = `${name} ${category}: ${n}`;
        parts.push(`<span class="pc-chip" title="${label}" aria-label="${label}">${glyphs[t]}<span class="pc-chip-n">${n}</span></span>`);
      }
    }
    return parts.length
      ? `<span class="pc-breakdown" aria-hidden="false">${parts.join('')}</span>`
      : '';
  };
  const row = (label, cls, colorVal, c) =>
    `<div class="pc-row pc-row-${cls}">
      <span class="pc-side ${cls}">${label}</span>
      <span class="pc-stat"><span class="pc-label">Shown</span> ${c.shown}${breakdown(colorVal, c.byType, 'shown')}</span>
      <span class="pc-stat"><span class="pc-label">Hidden</span> ${c.hidden}${breakdown(colorVal, c.byType, 'hidden')}</span>
      <span class="pc-stat"><span class="pc-label">Capt</span> ${c.captured}${breakdown(colorVal, c.byType, 'captured')}</span>
    </div>`;
  return `<div class="piece-counts">${row('Red', 'red', 1, counts.red)}${row('Black', 'black', 2, counts.black)}</div>`;
}

function cellAriaLabel(idx, cell, opts = {}) {
  const col = 'abcdefgh'[idx % 8];
  const row = (idx >> 3) + 1;
  const coord = `${col}${row}`;
  let base;
  if (cell.state === 'facedown') base = `${coord}, face-down`;
  else if (cell.state === 'empty') base = `${coord}, empty`;
  else {
    const color = cell.color === 1 ? 'Red' : 'Black';
    const name = PIECE_NAMES[cell.type] || '';
    base = `${coord}, ${color} ${name}`.trim();
  }
  const tags = [];
  if (opts.selected) tags.push('selected');
  if (opts.legal === 'flip') tags.push('legal flip');
  else if (opts.legal === 'move-target') tags.push('legal move target');
  else if (opts.legal === 'movable') tags.push('your piece — selectable');
  if (opts.lastMove) tags.push('last move');
  return tags.length ? `${base}; ${tags.join(', ')}` : base;
}

function boardArrowFocus(boardEl, currentIdx, dr, dc) {
  const r = (currentIdx >> 3) + dr;
  const c = (currentIdx & 7) + dc;
  if (r < 0 || r > 3 || c < 0 || c > 7) return;
  const next = boardEl.querySelector(`[data-cell-index="${r * 8 + c}"]`);
  if (next) next.focus();
}

function attachBoardKeyNav(boardEl) {
  if (boardEl.dataset.keyNav === '1') return;
  boardEl.dataset.keyNav = '1';
  boardEl.addEventListener('keydown', (e) => {
    const target = e.target.closest('[data-cell-index]');
    if (!target || target.parentElement !== boardEl) return;
    const idx = parseInt(target.dataset.cellIndex, 10);
    if (isNaN(idx)) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':  boardArrowFocus(boardEl, idx, 0, -1); break;
      case 'ArrowRight': boardArrowFocus(boardEl, idx, 0,  1); break;
      case 'ArrowUp':    boardArrowFocus(boardEl, idx, -1, 0); break;
      case 'ArrowDown':  boardArrowFocus(boardEl, idx,  1, 0); break;
      case 'Home':       boardArrowFocus(boardEl, idx, 0, -8); break;
      case 'End':        boardArrowFocus(boardEl, idx, 0,  8); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });
}

function renderBoard(boardEl, state, onClick) {
  const prevFocusIdx = boardEl.querySelector('[data-cell-index][tabindex="0"]')?.dataset.cellIndex;
  const hadDomFocus = boardEl.contains(document.activeElement);

  boardEl.innerHTML = '';
  boardEl.classList.toggle('replay-viewing', !!state.replayViewing);
  attachBoardKeyNav(boardEl);

  const legal = state.legal_moves_for_me || [];
  const hints = computeMoveHints(state);
  const highlight = state.replayMoveCells || state.lastMoveCells || null;
  const myTurnLive = hints.live;

  let focusIdx;
  if (prevFocusIdx != null && +prevFocusIdx >= 0 && +prevFocusIdx < 32) focusIdx = +prevFocusIdx;
  else if (active?.selected != null) focusIdx = active.selected;
  else if (myTurnLive && legal.length) focusIdx = legal[0].from < 0 ? legal[0].to : legal[0].from;
  else focusIdx = 0;

  for (let i = 0; i < 32; ++i) {
    const c = state.cells[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell ' + c.state;
    btn.dataset.cellIndex = String(i);
    btn.tabIndex = i === focusIdx ? 0 : -1;

    let opts = {};
    if (c.state === 'faceup') {
      btn.classList.add(c.color === 1 ? 'red' : 'black');
      const glyphSpan = document.createElement('span');
      glyphSpan.className = 'cell-glyph';
      glyphSpan.textContent = c.glyph;
      btn.appendChild(glyphSpan);
      const valueSpan = document.createElement('span');
      valueSpan.className = 'cell-value';
      valueSpan.textContent = String(c.type);
      valueSpan.setAttribute('aria-hidden', 'true');
      btn.appendChild(valueSpan);
    }
    const isSelected = !state.replayViewing && active?.selected === i;
    if (isSelected) { btn.classList.add('selected'); opts.selected = true; }
    const hintKind = cellHintKind(hints, active?.selected ?? null, i);
    if (hintKind === 'move-target') { btn.classList.add('legal-target'); opts.legal = 'move-target'; }
    else if (hintKind === 'flip')   { btn.classList.add('legal');        opts.legal = 'flip'; }
    else if (hintKind === 'movable'){ btn.classList.add('legal');        opts.legal = 'movable'; }
    const isLastMove = highlight && (i === highlight.from || i === highlight.to);
    if (isLastMove) {
      btn.classList.add(state.replayViewing ? 'replay-highlight' : 'last-move');
      opts.lastMove = true;
    }
    if (state.flashCellIdx === i) btn.classList.add('opp-move-flash');
    btn.setAttribute('aria-label', cellAriaLabel(i, c, opts));
    if (state.replayViewing) btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', () => onClick(i));
    boardEl.appendChild(btn);
  }

  if (state.replayViewing) {
    const wm = document.createElement('div');
    wm.className = 'replay-watermark';
    wm.textContent = 'REPLAY';
    wm.setAttribute('aria-hidden', 'true');
    boardEl.appendChild(wm);
  }

  if (hadDomFocus) {
    const tgt = boardEl.querySelector(`[data-cell-index="${focusIdx}"]`);
    tgt?.focus();
  }
}

// ---- dashboard ----
async function renderDashboard() {
  showView('dashboard');
  refreshNotificationBadge();
  ensureNotifySettingsPanel();
  const list = $('dashboard-list');
  if (!me) { list.innerHTML = `<div>Sign in first. <a href="#/">Lobby</a></div>`; return; }
  if (!online) {
    list.innerHTML = `<div class="muted">You're offline — can't load games. <a href="#/">Lobby</a></div>`;
    return;
  }
  renderNotifySettings();
  let games;
  try {
    const r = await fetch('/api/games');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    games = await r.json();
  } catch (e) {
    list.innerHTML = `<div class="err">Couldn't load your games.
      <a href="#/dashboard">Retry</a>.</div>`;
    toast('Couldn’t load your games.', { kind: 'error' });
    return;
  }
  if (!games.length) {
    list.innerHTML = `
      <div class="empty-state">
        <p>You haven’t played a game yet.</p>
        <div class="row">
          <a href="#/" class="primary">Start a game</a>
          <a href="#/ai" class="link-btn">…or play the AI</a>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = games.map(g => {
    const opp = g.host_user_id === me.id ? (g.join_name || '(waiting for opponent)')
                                          : (g.host_name || '(waiting for opponent)');
    const ts = new Date(g.last_move_at || g.created_at).toLocaleString();
    const tag = g.status === 'complete'  ? 'complete'
              : g.status === 'waiting'   ? 'awaiting opponent'
              : 'in progress';
    return `<div class="game-row" data-game-id="${g.id}" data-room="${escapeHtml(g.room_code)}">
              <a class="game-row-link" href="#/g/${g.room_code}">
                <div class="g-opp">vs ${escapeHtml(opp)}</div>
                <div class="g-status">${tag}</div>
                <div class="g-meta muted">${ts} · room ${g.room_code}</div>
              </a>
              <button class="game-row-delete" type="button"
                      title="Remove from my games"
                      aria-label="Remove game vs ${escapeHtml(opp)} from my games">×</button>
            </div>`;
  }).join('');
  list.querySelectorAll('.game-row-delete').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const row = btn.closest('.game-row');
      const id = row?.dataset.gameId;
      const room = row?.dataset.room || '';
      if (!id) return;
      if (!confirm(`Remove game ${room} from your dashboard?\n\nThis hides it from your list. Completed games stay in the leaderboard / Elo history; an opponent who already joined will still see the game on their side.`)) return;
      btn.disabled = true;
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        row.remove();
        if (!list.querySelector('.game-row')) renderDashboard();
        toast('Removed from your games.', { kind: 'success', timeoutMs: 2500 });
      } catch (e) {
        btn.disabled = false;
        toast(`Couldn't remove game: ${e.message || e}`, { kind: 'error' });
      }
    };
  });
}

// ---- notification settings (rendered in the dashboard view) ----
function ensureNotifySettingsPanel() {
  if (document.getElementById('notify-settings')) return;
  const view = views.dashboard;
  if (!view) return;
  const panel = document.createElement('div');
  panel.id = 'notify-settings';
  panel.className = 'notify-settings';
  // Insert just above the games list so users can flip it on without scrolling.
  const list = $('dashboard-list');
  view.insertBefore(panel, list);
}

async function renderNotifySettings() {
  const panel = document.getElementById('notify-settings');
  if (!panel) return;
  if (!me || me.is_guest) {
    panel.innerHTML = me?.is_guest
      ? `<div class="muted small">Sign in (not as a guest) to enable turn notifications across devices.</div>`
      : '';
    return;
  }
  const s = Notify.getSettings();
  const pushSupported = await Notify.isPushSupported();
  const browserPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
  const currentSub = pushSupported ? await Notify.currentPushSubscription() : null;
  const pushOn = !!currentSub && s.push;

  let pushStatus = '';
  if (!pushSupported) pushStatus = 'Push not supported on this browser.';
  else if (browserPerm === 'denied') pushStatus = 'Browser notifications are blocked — re-enable in site settings.';
  else if (pushOn) pushStatus = 'On — you\'ll get a notification on this device when it\'s your turn.';
  else pushStatus = 'Off — turn on to get notified when your tab is closed.';

  panel.innerHTML = `
    <details class="notify-card">
      <summary><b>Turn notifications</b> <span class="muted small" id="notify-status"></span></summary>
      <div class="notify-row">
        <label><input type="checkbox" id="notify-sound" ${s.sound ? 'checked' : ''}>
          Play a sound when it's my turn</label>
      </div>
      <div class="notify-row">
        <label><input type="checkbox" id="notify-desktop" ${s.desktopAlerts ? 'checked' : ''}>
          Show a desktop alert when this tab is hidden</label>
      </div>
      <div class="notify-row">
        <div>
          <div><b>Push notifications</b></div>
          <div class="muted small" id="notify-push-status">${escapeHtml(pushStatus)}</div>
        </div>
        <button type="button" id="notify-push-toggle"
                class="${pushOn ? 'link-btn' : 'primary'}"
                ${(!pushSupported || browserPerm === 'denied') ? 'disabled' : ''}>
          ${pushOn ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </details>`;

  const summaryStatus = $('notify-status');
  const compactStatus = () => {
    const bits = [];
    if (s.sound) bits.push('sound');
    if (s.desktopAlerts) bits.push('alerts');
    if (pushOn) bits.push('push');
    return bits.length ? bits.join(' · ') : 'off';
  };
  summaryStatus.textContent = compactStatus();

  $('notify-sound').addEventListener('change', (e) => {
    Notify.saveSettings({ sound: e.target.checked });
    renderNotifySettings();
  });
  $('notify-desktop').addEventListener('change', async (e) => {
    const want = e.target.checked;
    if (want && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    Notify.saveSettings({ desktopAlerts: want });
    renderNotifySettings();
  });
  $('notify-push-toggle').addEventListener('click', async () => {
    const btn = $('notify-push-toggle');
    btn.disabled = true;
    if (pushOn) {
      await Notify.unsubscribePush();
      toast('Push notifications turned off.', { kind: 'info', timeoutMs: 2500 });
    } else {
      const result = await Notify.requestPushPermissionAndSubscribe();
      if (!result.ok) {
        const msg = result.reason === 'denied'        ? 'Permission denied. Allow notifications in your browser settings.'
                  : result.reason === 'unsupported'   ? 'Push is not supported on this browser.'
                  : result.reason === 'server-disabled' ? 'Push isn\'t configured on this server.'
                  : result.reason === 'guest'         ? 'Sign in (not as a guest) to enable push.'
                  : 'Could not enable push. Try again later.';
        toast(msg, { kind: 'warn' });
      } else {
        toast('Push notifications enabled.', { kind: 'success', timeoutMs: 2500 });
      }
    }
    renderNotifySettings();
  });
}

// ---- leaderboard ----
async function renderLeaderboard() {
  showView('leaderboard');
  if (!online) {
    $('leaderboard-table').innerHTML = `<div class="muted">You're offline — can't load the leaderboard. <a href="#/">Lobby</a></div>`;
    return;
  }
  let data;
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    $('leaderboard-table').innerHTML = `<div class="err">Couldn't load the leaderboard.
      <a href="#/leaderboard">Retry</a>.</div>`;
    toast('Couldn’t load the leaderboard.', { kind: 'error' });
    return;
  }
  if (!data.length) {
    $('leaderboard-table').innerHTML = `<div class="empty-state">
      <p>No rated games yet. Be the first — invite a friend.</p>
      <div class="row"><a href="#/" class="primary">Start a game</a></div>
    </div>`;
    return;
  }
  $('leaderboard-table').innerHTML = `
    <table><thead><tr><th>#</th><th>Player</th><th>Elo</th><th>W</th><th>L</th></tr></thead>
    <tbody>${data.map((u, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><a href="#/profile/${u.id}">${escapeHtml(u.display_name)}</a></td>
        <td>${u.elo}</td><td>${u.wins}</td><td>${u.losses}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

// ---- profile ----
async function renderProfile(userId) {
  showView('profile');
  if (!online) {
    $('profile-body').innerHTML = `<div class="muted">You're offline — can't load this profile. <a href="#/">Lobby</a></div>`;
    return;
  }
  let p;
  try {
    const r = await fetch(`/api/users/${userId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p = await r.json();
  } catch (e) {
    $('profile-body').innerHTML = `<div class="err">Profile not found.</div>`;
    return;
  }
  const h2h = p.head_to_head || [];
  const isSelf = me && p.id === me.id;
  const challengeBlock = (me && !isSelf) ? `
    <div class="row" style="margin:12px 0">
      <button id="btn-challenge" class="primary">Challenge to a game</button>
      <span class="muted small">Sends a match request. They have to be a friend or someone you've played before.</span>
    </div>` : '';
  $('profile-body').innerHTML = `
    <h2>${escapeHtml(p.display_name)}</h2>
    <div><b>Elo:</b> ${p.elo}</div>
    ${challengeBlock}
    <h3>Head-to-head</h3>
    ${h2h.length === 0 ? `<div class="muted">No games played yet.</div>` :
      `<table><thead><tr><th>Opponent</th><th>W</th><th>L</th><th>D</th></tr></thead>
       <tbody>${h2h.map(r => `
         <tr><td><a href="#/profile/${r.opponent_id}">${escapeHtml(r.opponent_name || '')}</a></td>
             <td>${r.wins}</td><td>${r.losses}</td><td>${r.draws}</td></tr>`).join('')}
       </tbody></table>`}
    ${isSelf ? `
      <hr style="margin-top:24px;border:none;border-top:1px solid #333">
      <h3>Danger zone</h3>
      <p class="muted">Deleting your account anonymizes your past games and removes your sign-in. This cannot be undone.</p>
      <button id="btn-delete-account" class="link-btn" style="color:#d24343">Delete my account…</button>` : ''}`;
  if (challengeBlock) {
    $('btn-challenge').onclick = () => challengePlayer(p.id);
  }
  if (isSelf) {
    $('btn-delete-account').onclick = async () => {
      const typed = prompt(`To confirm deletion, type your display name:\n\n${p.display_name}`);
      if (typed == null) return;
      if (typed !== p.display_name) { alert("That doesn't match — cancelled."); return; }
      const r = await fetch('/api/me', { method: 'DELETE' });
      if (!r.ok) { alert('Delete failed.'); return; }
      me = null;
      location.hash = '#/';
    };
  }
}

// ---- friends + match requests ----

async function challengePlayer(toUserId) {
  if (!me) return;
  const res = await fetch('/api/match-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_user_id: toUserId }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) {
    toast(body.error || 'Become friends first to challenge each other.', { kind: 'warn' });
    return;
  }
  if (!res.ok) {
    toast(body.error || 'Could not send challenge.', { kind: 'error' });
    return;
  }
  toast('Challenge sent.', { kind: 'success' });
}

async function addFriendByToken(combined) {
  if (!me) {
    showView('friends');
    $('friends-invite-box').innerHTML = `
      <div class="invite-signin">
        <h3>Sign in to add a friend</h3>
        <p>We'll bring you right back here.</p>
        <div id="add-friend-signin-buttons"></div>
      </div>`;
    $('friends-incoming-requests').innerHTML = '';
    $('friends-outgoing-requests').innerHTML = '';
    $('friends-list').innerHTML = '';
    renderSignInButtons($('add-friend-signin-buttons'), `#/add-friend/${combined}`);
    return;
  }
  showView('friends');
  $('friends-invite-box').innerHTML = `<div class="muted">Adding friend…</div>`;
  $('friends-incoming-requests').innerHTML = '';
  $('friends-outgoing-requests').innerHTML = '';
  $('friends-list').innerHTML = '';
  const res = await fetch('/api/friends/by-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: combined }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(body.error || 'Could not add friend.', { kind: 'error' });
  } else {
    toast(`You and ${body.friend?.display_name || 'your friend'} are now friends.`, { kind: 'success' });
  }
  location.hash = '#/friends';
  // hashchange fires the renderFriends() route.
}

async function renderFriends() {
  showView('friends');
  if (!me) {
    $('friends-invite-box').innerHTML = `<div>Sign in to use friends. <a href="#/">Lobby</a></div>`;
    $('friends-incoming-requests').innerHTML = '';
    $('friends-outgoing-requests').innerHTML = '';
    $('friends-list').innerHTML = '';
    return;
  }
  if (!online) {
    $('friends-invite-box').innerHTML = `<div class="muted">You're offline — can't load friends. <a href="#/">Lobby</a></div>`;
    $('friends-incoming-requests').innerHTML = '';
    $('friends-outgoing-requests').innerHTML = '';
    $('friends-list').innerHTML = '';
    return;
  }
  refreshNotificationBadge();
  // Optimistic placeholders, then populate in parallel.
  $('friends-invite-box').innerHTML = `<div class="muted">Loading…</div>`;
  $('friends-incoming-requests').innerHTML = '';
  $('friends-outgoing-requests').innerHTML = '';
  $('friends-list').innerHTML = '';

  let invite, friends, requests;
  try {
    [invite, friends, requests] = await Promise.all([
      fetch('/api/friends/my-invite').then(r => r.json()),
      fetch('/api/friends').then(r => r.json()),
      fetch('/api/match-requests').then(r => r.json()),
    ]);
  } catch (e) {
    $('friends-invite-box').innerHTML = `<div class="err">Couldn't load friends.</div>`;
    toast('Couldn’t load friends.', { kind: 'error' });
    return;
  }

  $('friends-invite-box').innerHTML = `
    <div class="friends-invite">
      <h3>Your invite link</h3>
      <p class="muted">Send this to anyone you want to add as a friend. Anyone who opens it while signed in becomes your friend instantly — same trust model as a game room link.</p>
      <div class="row">
        <input id="friends-invite-url" type="text" readonly value="${escapeHtml(invite.url)}" style="flex:1">
        <button id="friends-invite-copy" class="primary">Copy</button>
      </div>
    </div>`;
  $('friends-invite-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      toast('Invite link copied.', { kind: 'success', timeoutMs: 2500 });
    } catch (_) {
      $('friends-invite-url').select();
      toast('Press Cmd/Ctrl+C to copy the link.', { kind: 'info' });
    }
  };

  const incoming = requests?.incoming || [];
  $('friends-incoming-requests').innerHTML = `
    <h3>Incoming match requests${incoming.length ? ` (${incoming.length})` : ''}</h3>
    ${incoming.length === 0 ? `<div class="muted">No pending requests.</div>` :
      `<ul class="friends-req-list">${incoming.map(r => `
        <li data-req="${r.id}">
          <span><b>${escapeHtml(r.from_name || '')}</b> wants to play</span>
          <span class="row">
            <button class="primary" data-action="accept" data-req="${r.id}">Accept</button>
            <button class="link-btn" data-action="decline" data-req="${r.id}">Decline</button>
          </span>
        </li>`).join('')}</ul>`}`;

  const outgoing = requests?.outgoing || [];
  $('friends-outgoing-requests').innerHTML = `
    <h3>Sent challenges${outgoing.length ? ` (${outgoing.length})` : ''}</h3>
    ${outgoing.length === 0 ? `<div class="muted">No outgoing requests.</div>` :
      `<ul class="friends-req-list">${outgoing.map(r => `
        <li data-req="${r.id}">
          <span>Sent to <b>${escapeHtml(r.to_name || '')}</b></span>
          <button class="link-btn" data-action="cancel" data-req="${r.id}">Cancel</button>
        </li>`).join('')}</ul>`}`;

  // Friends list + per-friend Challenge + Remove.
  $('friends-list').innerHTML = `
    <h3>Your friends${friends.length ? ` (${friends.length})` : ''}</h3>
    ${friends.length === 0 ? `<div class="muted">No friends yet — copy your invite link above and share it.</div>` :
      `<ul class="friends-list">${friends.map(f => `
        <li data-friend="${f.id}">
          <span><a href="#/profile/${f.id}">${escapeHtml(f.display_name)}</a>
            <span class="muted small">Elo ${f.elo}</span></span>
          <span class="row">
            <button class="primary" data-action="challenge" data-friend="${f.id}">Challenge</button>
            <button class="link-btn" data-action="remove" data-friend="${f.id}">Remove</button>
          </span>
        </li>`).join('')}</ul>`}`;

  // Single delegated click handler for all the action buttons in the friends view.
  views.friends.onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const reqId = btn.dataset.req ? +btn.dataset.req : null;
    const friendId = btn.dataset.friend ? +btn.dataset.friend : null;
    btn.disabled = true;
    try {
      if (action === 'accept' && reqId) {
        const res = await fetch(`/api/match-requests/${reqId}/accept`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { toast(body.error || 'Could not accept.', { kind: 'error' }); return; }
        if (body.room_code) { location.hash = `#/g/${body.room_code}`; return; }
        renderFriends();
      } else if (action === 'decline' && reqId) {
        const res = await fetch(`/api/match-requests/${reqId}/decline`, { method: 'POST' });
        if (!res.ok) toast('Could not decline.', { kind: 'error' });
        renderFriends();
      } else if (action === 'cancel' && reqId) {
        const res = await fetch(`/api/match-requests/${reqId}`, { method: 'DELETE' });
        if (!res.ok) toast('Could not cancel.', { kind: 'error' });
        renderFriends();
      } else if (action === 'challenge' && friendId) {
        await challengePlayer(friendId);
        renderFriends();
      } else if (action === 'remove' && friendId) {
        const ok = await confirmModal({
          title: 'Remove this friend?',
          body: 'You can re-add each other any time with an invite link.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        const res = await fetch(`/api/friends/${friendId}`, { method: 'DELETE' });
        if (!res.ok) { toast('Could not remove.', { kind: 'error' }); return; }
        renderFriends();
      }
    } finally {
      btn.disabled = false;
    }
  };
}

// Polls /api/notifications. Updates #nav-notif-badge if present.
let _notifTimer = null;
async function refreshNotificationBadge() {
  if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
  if (!me) return;
  const tick = async () => {
    try {
      const r = await fetch('/api/notifications');
      if (!r.ok) return;
      const { incoming_match_requests = 0 } = await r.json();
      const badge = document.getElementById('nav-notif-badge');
      if (!badge) return;
      if (incoming_match_requests > 0) {
        badge.textContent = ` ${incoming_match_requests}`;
        badge.classList.remove('hidden');
      } else {
        badge.textContent = '';
        badge.classList.add('hidden');
      }
    } catch (_) { /* offline-ish; try again next tick */ }
  };
  tick();
  _notifTimer = setInterval(tick, 60_000);
}

// ---- toast notifications ----
let _toastSeq = 0;
function toast(message, opts = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const kind = opts.kind || 'info';
  const id = `toast-${++_toastSeq}`;
  const div = document.createElement('div');
  div.className = `toast toast-${kind}`;
  div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  div.id = id;
  div.innerHTML = `
    <button class="toast-close" type="button" aria-label="Dismiss">×</button>
    <span class="toast-msg"></span>`;
  div.querySelector('.toast-msg').textContent = message;
  const close = () => { div.remove(); };
  div.querySelector('.toast-close').addEventListener('click', close);
  stack.appendChild(div);
  const timeoutMs = opts.timeoutMs ?? (kind === 'error' ? 8000 : 5000);
  if (timeoutMs > 0) setTimeout(close, timeoutMs);
  return close;
}

// ---- modal dialog ----
function confirmModal({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(false); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
           aria-describedby="modal-body" tabindex="-1">
        <h2 id="modal-title"></h2>
        <p id="modal-body" class="modal-body"></p>
        <div class="modal-actions">
          <button type="button" class="btn-cancel"></button>
          <button type="button" class="btn-confirm${danger ? ' btn-danger' : ' primary'}"></button>
        </div>
      </div>`;
    overlay.querySelector('#modal-title').textContent = title || 'Are you sure?';
    overlay.querySelector('#modal-body').textContent = body || '';
    const btnCancel = overlay.querySelector('.btn-cancel');
    const btnConfirm = overlay.querySelector('.btn-confirm');
    btnCancel.textContent = cancelLabel;
    btnConfirm.textContent = confirmLabel;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
      if (e.key === 'Tab') {
        const focusables = [btnCancel, btnConfirm];
        const idx = focusables.indexOf(document.activeElement);
        if (idx === -1) { focusables[0].focus(); e.preventDefault(); return; }
        const next = e.shiftKey ? (idx - 1 + focusables.length) % focusables.length
                                : (idx + 1) % focusables.length;
        focusables[next].focus();
        e.preventDefault();
      }
    };
    btnCancel.addEventListener('click', () => close(false));
    btnConfirm.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    (danger ? btnCancel : btnConfirm).focus();
  });
}

// ---- utils ----
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- boot ----
function initCribDefault() {
  const details = document.getElementById('crib-details');
  if (!details) return;
  const small = window.matchMedia('(max-width: 700px)');
  details.open = !small.matches;
}
initCribDefault();

await refreshSession();
route();
