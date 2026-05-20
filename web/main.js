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
import { Replay, renderTranscript, exportPgn } from './replay.js';
import * as Notify from './notifications.js';
import { playMoveSound } from './audio.js';
import { computeMoveHints, cellHintKind } from './board-hints.js';
import { initSettings, openSettingsDrawer, openRulesDrawer } from './settings.js';
import { captureCellRect, playEventAnimation } from './animations.js';

// Initialise settings (applies theme / animation toggles to <body>) before
// anything paints, so the first render uses the chosen palette.
initSettings();

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
  challenge:   $('view-challenge'),
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
  updateNavActive(hash);
  applyNavAuthState();
  const m = hash.match(/^#\/g\/([0-9A-Za-z]+)$/);
  if (m) { announce(`Game room ${m[1]}`); return openOnlineGame(m[1].toUpperCase()); }

  const mp = hash.match(/^#\/profile\/(\d+)$/);
  if (mp) { announce('Profile'); return renderProfile(+mp[1]); }

  const mc = hash.match(/^#\/challenge\/(\d+)$/);
  if (mc) { announce('Challenge details'); return renderChallengeDetails(+mc[1]); }

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

function updateNavActive(hash) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  // Match by data-route prefix so #/g/CODE highlights nothing (we're inside a
  // game, not on a top-level nav destination).
  for (const a of nav.querySelectorAll('a[data-route]')) {
    a.classList.toggle('active', a.dataset.route === hash || (a.dataset.route === '#/' && (hash === '' || hash === '#/' || hash === '#')));
  }
}

function applyNavAuthState() {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  const signedIn = !!me;
  const isGuest = !!me?.is_guest;
  // Compute visibility per-item so an item with both attributes (e.g.
  // Friends) doesn't get un-hidden by the second pass.
  for (const el of nav.querySelectorAll('a[data-route]')) {
    const requiresAuth = el.hasAttribute('data-requires-auth');
    const notGuest = el.hasAttribute('data-not-guest');
    let hidden = false;
    if (requiresAuth && !signedIn) hidden = true;
    if (notGuest && isGuest) hidden = true;
    el.classList.toggle('hidden', hidden);
  }
}

// Wire static nav buttons once on boot.
(function wireNav() {
  const settingsBtn = document.getElementById('btn-open-settings');
  const rulesBtn = document.getElementById('btn-open-rules');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsDrawer);
  if (rulesBtn) rulesBtn.addEventListener('click', openRulesDrawer);
})();

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
  applyNavAuthState();
  const meBox = $('lobby-me');
  if (me) {
    const guestBadge = me.is_guest ? ' <span class="muted small">(guest — not rated)</span>' : '';
    const profileLink = me.is_guest
      ? ''
      : ` · <a href="#/profile/${me.id}">profile</a>`;
    meBox.innerHTML = `
      <div class="me-row">
        <div><b>Hi, ${escapeHtml(me.display_name)}</b>${guestBadge}
          ${me.is_guest ? '' : `· Elo ${me.elo}`}${profileLink}
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

// Whitelist of game-mode strings. Matches server-side normalizeMode so the
// client can't be tricked into displaying something the server won't honour.
const GAME_MODES = ['standard', 'capture_general'];
function normMode(m) { return GAME_MODES.includes(m) ? m : 'standard'; }
function modeLabel(m) {
  return m === 'capture_general' ? 'Capture the General' : 'Standard';
}

const AI_DIFFICULTY_LABELS = {
  easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', master: 'Master',
  policy: 'Policy',
};
function aiDifficultyLabel(d) { return AI_DIFFICULTY_LABELS[d] || (d || ''); }

async function startOnlineGame() {
  if (!me) return;
  const mode = normMode($('lobby-online-mode')?.value);
  const res = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
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
    offerDraw: false,
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
      // Capture the source cell rect + moved piece info BEFORE applying the
      // new state. For animations to play smoothly we need both: the rect
      // because the source cell may not exist post-render, and the piece
      // info (glyph + color) because the dst cell will hold the captured
      // piece for capture animations.
      const boardEl = $('game-board');
      const ev = frame.event;
      let srcRect = null, piece = null;
      if (ev?.action?.kind === 'move' && active.state?.cells) {
        srcRect = captureCellRect(boardEl, ev.action.from);
        const srcCell = active.state.cells[ev.action.from];
        if (srcCell?.state === 'faceup') {
          piece = { color: srcCell.color, glyph: srcCell.glyph };
        }
      }
      const wasMyTurnBefore = isMyTurn(active.state);
      active.state = frame.state;
      active.replay.appendEvent(ev);
      playMoveSound(ev);
      if (ev.mover !== rolePlayerIndex(active)) {
        const desc = describeAction(ev);
        const drawNote = ev.draw_offered ? " (with draw offer)" : "";
        announce(`Opponent: ${desc}${drawNote}`);
        const to = ev.action?.to;
        if (typeof to === 'number') {
          active.flashCellIdx = to;
          active.flashUntil = Date.now() + 1200;
        }
      }
      if (ev.action?.kind === "accept_draw") {
        announce("Draw accepted. The game is a draw.");
      }
      maybeNotifyTurnTransition(wasMyTurnBefore);
      refreshGame();
      // Fire and forget — animations are pure decoration over the new state.
      playEventAnimation(boardEl, ev, { srcRect, piece });
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
  if (a.kind === "accept_draw") return "accepted the draw offer";
  if (a.kind === 'timeout') return 'ran out of time';
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
            ? "Connection lost — your moves are saved. We'll reconnect when you're back online."
            : "Reconnecting — your moves are saved."}</span>
         <button id="btn-retry-conn" type="button">Retry now</button>
       </div>`
    : '';
  const counts = pieceCounts(view.cells, active.replay);
  const myPlayerIdx = rolePlayerIndex(active);
  const drawOfferedBy = liveState.draw_offered_by ?? null;
  const opponentOffered = drawOfferedBy !== null && drawOfferedBy !== myPlayerIdx
                          && liveState.side_to_move === myPlayerIdx
                          && !liveState.game_over && !view.replayViewing;
  const iOffered = drawOfferedBy === myPlayerIdx && !liveState.game_over;
  const canOfferDraw = liveState.first_flip_done && !liveState.game_over
                       && !view.replayViewing
                       && liveState.side_to_move === myPlayerIdx
                       && drawOfferedBy === null;
  const drawOfferRow = opponentOffered
    ? `<div class="meta-row draw-offer-row" role="alert">
         <span>Opponent offers a draw &mdash; accept, or make your move to decline.</span>
         <button id="btn-accept-draw" class="primary" type="button">Accept Draw</button>
       </div>`
    : iOffered
      ? `<div class="meta-row draw-offer-pending-row">
           <span class="muted">Draw offer pending &mdash; waiting for opponent.</span>
         </div>`
      : "";
  const offerDrawChk = canOfferDraw
    ? `<label class="offer-draw-label" title="Attach a draw offer to your next move">
         <input type="checkbox" id="chk-offer-draw"${active.offerDraw ? " checked" : ""}> Offer draw
       </label>`
    : "";
  const clocksRow = (liveState.time_limit_ms != null && liveState.clocks)
    ? renderClocksRowHtml(liveState, myPlayerIdx, opp || 'Opponent', me?.display_name || 'You', active)
    : '';
  const isAiGame = !!active.info.opponent_is_ai;
  const aiDifficulty = active.info.ai_difficulty || '';
  // Replay-on-AI affordance: after a vs-AI game ends, drop a "play another"
  // button in the header so the user can spin up a fresh game with the same
  // settings without going back through the lobby.
  const playAnotherRow = isAiGame && liveState.game_over && !view.replayViewing
    ? `<div class="meta-row">
         <button id="btn-play-another-ai" class="primary" type="button">
           Play another vs ${escapeHtml(active.info.join_name || 'AI')}
         </button>
       </div>`
    : "";
  $('game-header').innerHTML = `
    ${disconnectBanner}
    <div class="meta game-meta">
      ${replayBadge}
      <div class="meta-row meta-row-top">
        <div class="meta-room">
          <span class="meta-label">Room</span>
          <code>${escapeHtml(active.info.room_code)}</code>
          <span class="mode-chip" aria-label="Win condition: ${escapeHtml(modeLabel(active.info.mode || liveState.mode))}">${escapeHtml(modeLabel(active.info.mode || liveState.mode))}</span>
          ${active.info.time_limit_ms != null ? `<span class="mode-chip" aria-label="Time control: ${escapeHtml(timeControlLabel(active.info.time_limit_ms, active.info.increment_ms || 0))}">${escapeHtml(timeControlLabel(active.info.time_limit_ms, active.info.increment_ms || 0))}</span>` : ''}
          <button id="btn-copy-link" class="link-btn" type="button" aria-label="Copy invite link">Copy invite link</button>
        </div>
        <div class="meta-row-right">
          <span class="conn-state conn-${connState}" aria-live="polite" aria-atomic="true">${connLabel}</span>
        </div>
      </div>
      <div class="meta-row">
        ${turnPillHtml(liveState, 'online', { opponentIsAi: isAiGame })}
        <div><span class="meta-label">vs</span> <strong>${escapeHtml(opp || '(waiting for opponent)')}</strong> ${colorChip}</div>
        <div class="meta-btn-group">
          ${offerDrawChk}
          <button id="btn-resign" class="btn-danger-inline" type="button"
            ${liveState.first_flip_done && !liveState.game_over && !view.replayViewing ? '' : 'disabled'}>Resign</button>
        </div>
      </div>
      ${clocksRow}
      ${drawOfferRow}
      ${playAnotherRow}
      <div class="meta-row meta-row-status">
        <span><span class="meta-label">Move</span> ${active.replay.totalMoves()}</span>
        <span><span class="meta-label">Status</span> <span id="game-status-line">${statusLabel(liveState, active.info, active.replay)}</span></span>
      </div>
      <div class="meta-row meta-row-counts">
        ${renderPieceCountsHtml(counts)}
      </div>
      ${renderOnlineRematchRow(liveState, view)}
    </div>`;
  $('btn-copy-link').onclick = copyInviteLink;
  const chkOfferDraw = $('chk-offer-draw');
  if (chkOfferDraw) chkOfferDraw.onchange = (e) => { if (active) active.offerDraw = e.target.checked; };
  const btnAcceptDraw = $('btn-accept-draw');
  if (btnAcceptDraw) btnAcceptDraw.onclick = () => { sendIntent({ kind: 'accept_draw' }); };
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
  wireOnlineRematch();
  const retryBtn = $('btn-retry-conn');
  if (retryBtn) retryBtn.onclick = () => { active.conn?.reconnect?.(); };
  const claimBtn = $('btn-claim-timeout');
  if (claimBtn) claimBtn.onclick = async () => {
    claimBtn.disabled = true;
    await claimTimeout(active.info.id);
    // The terminal event arrives over WS and refreshGame() repaints.
  };
  // Kick the local clock-decrement loop when this game has a TC; cheap no-op
  // when the loop is already running.
  if (liveState.time_limit_ms != null && !liveState.game_over) {
    startClockTicker();
  } else {
    stopClockTicker();
  }
  const playAnotherBtn = $('btn-play-another-ai');
  if (playAnotherBtn) {
    playAnotherBtn.onclick = async () => {
      playAnotherBtn.disabled = true;
      try {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode:     active.info.mode || 'standard',
            opponent: 'ai:' + aiDifficulty,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const g = await res.json();
        location.hash = `#/g/${g.roomCode}`;
      } catch (e) {
        playAnotherBtn.disabled = false;
        toast('Could not start a new AI game.', { kind: 'error' });
      }
    };
  }

  renderTranscript($('game-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshGame(); },
    onExport: (replay) => {
      const pgn = exportPgn(replay, {
        players: [active.info.host_name || 'Host', active.info.join_name || 'Guest'],
        round:   active.info.room_code,
        date:    active.info.created_at,
      });
      downloadPgn(pgn, `banqi-${active.info.room_code || 'online'}.pgn`);
    },
  });
  maybeShowTutorialTip($('game-board'));
  maybeShowGameOver(view);
}

function downloadPgn(text, filename) {
  try {
    const blob = new Blob([text], { type: 'application/x-chess-pgn;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) {
    toast(`Couldn't export PGN: ${e.message || e}`, { kind: 'error' });
  }
}

function sendIntent(intent) {
  if (!active?.isOnline || !active.conn) return;
  active.conn.send({ type: 'intent', ...intent });
}

function opponentUserIdFor(info, meId) {
  if (!info || !meId) return null;
  if (info.host_user_id === meId) return info.join_user_id || null;
  if (info.join_user_id === meId) return info.host_user_id || null;
  return null;
}

function renderOnlineRematchRow(liveState, view) {
  if (!liveState.game_over || view.replayViewing) return '';
  if (active?.info?.opponent_is_ai) return '';
  const oppId = opponentUserIdFor(active?.info, me?.id);
  if (!me || me.is_guest || !oppId) {
    return `
      <div class="meta-row meta-row-rematch">
        <span class="meta-label">Game over</span>
        <a class="primary" href="#/">Start a new game</a>
      </div>`;
  }
  return `
    <div class="meta-row meta-row-rematch">
      <span class="meta-label">Game over</span>
      <button id="btn-rematch" class="primary" type="button">Rematch</button>
      <a class="link-btn" href="#/">Lobby</a>
    </div>`;
}

function wireOnlineRematch() {
  const btn = $('btn-rematch');
  if (!btn) return;
  btn.onclick = async () => {
    const oppId = opponentUserIdFor(active?.info, me?.id);
    if (!oppId) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/match-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_user_id: oppId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || 'Could not send rematch.', { kind: 'error' });
        btn.disabled = false;
        return;
      }
      toast('Rematch sent. Your opponent will see it in Friends.', { kind: 'success', timeoutMs: 4000 });
    } catch (e) {
      toast(`Could not send rematch: ${e.message || e}`, { kind: 'error' });
      btn.disabled = false;
    }
  };
}

function turnLabel(state) {
  if (!state.first_flip_done) return 'waiting for first flip';
  if (state.game_over) return 'finished';
  return state.side_to_move === state.my_player_index ? 'your turn' : 'opponent\'s turn';
}

// HTML for the prominent turn-indicator pill shown in game HUDs.
// mode: 'online' | 'otb' | 'ai'
function turnPillHtml(state, mode, opts = {}) {
  if (!state.first_flip_done) {
    // If the game was created from a directed challenge with a fixed first
    // mover, surface whose move it is so the locked-out side knows to wait.
    let label = 'Awaiting first flip';
    let yours = null;
    if (mode === 'online' && (state.first_mover_index === 0 || state.first_mover_index === 1)) {
      yours = state.first_mover_index === state.my_player_index;
      label = yours ? 'Your move — flip first' : 'Opponent flips first';
    }
    const cls = yours === true ? 'your-turn' : yours === false ? 'opp-turn' : '';
    return `<span class="turn-pill ${cls}" role="status" aria-live="polite">
              <span class="turn-dot"></span>${label}
            </span>`;
  }
  if (state.game_over) {
    return `<span class="turn-pill finished" role="status">
              <span class="turn-dot"></span>Finished
            </span>`;
  }
  let yours, label;
  if (mode === 'online') {
    yours = state.side_to_move === state.my_player_index;
    if (yours) label = 'Your turn';
    else label = opts.opponentIsAi ? 'AI is thinking…' : "Opponent's turn";
  } else if (mode === 'ai') {
    yours = state.side_to_move === 0;
    label = yours ? 'Your turn' : 'AI thinking…';
  } else {
    // OTB — both players are local; highlight whoever is to move.
    yours = true;
    label = state.side_to_move === 0 ? "Player 1's turn" : "Player 2's turn";
  }
  return `<span class="turn-pill ${yours ? 'your-turn' : 'opp-turn'}" role="status" aria-live="polite">
            <span class="turn-dot"></span>${label}
          </span>`;
}

// Format a remaining-time value for a chess-style clock display.
// >= 1m  → 'M:SS'.   <10s  → 'S.t' (one decimal).   Otherwise 'M:SS'.
function formatClockMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 10_000) {
    return (ms / 1000).toFixed(1) + 's';
  }
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Render the two-clock strip + optional "Claim time" button. The data-clock-pi
// attribute lets the local decrement loop update the right cell without a
// full refreshGame().
function renderClocksRowHtml(state, myPlayerIdx, oppName, myName, active) {
  const c0 = state.clocks?.[0] ?? 0;
  const c1 = state.clocks?.[1] ?? 0;
  const myMs   = myPlayerIdx === 0 ? c0 : c1;
  const oppMs  = myPlayerIdx === 0 ? c1 : c0;
  const myActive  = state.clock_active_index === myPlayerIdx;
  const oppActive = state.clock_active_index === (1 - myPlayerIdx);
  const lowMine  = myActive  && myMs  < 30_000;
  const lowOpp   = oppActive && oppMs < 30_000;
  // Claim-timeout: opponent is the active side and their clock is at 0.
  const canClaim = !state.game_over
    && state.clock_active_index === (1 - myPlayerIdx)
    && oppMs <= 0
    && !active.replayViewing;
  return `
    <div class="meta-row clocks-row">
      <div class="clock opp-clock ${oppActive ? 'active' : ''} ${lowOpp ? 'low' : ''}"
           aria-label="${escapeHtml(oppName)} clock">
        <span class="clock-name">${escapeHtml(oppName)}</span>
        <span class="clock-time" data-clock-pi="${1 - myPlayerIdx}">${formatClockMs(oppMs)}</span>
      </div>
      <div class="clock my-clock ${myActive ? 'active' : ''} ${lowMine ? 'low' : ''}"
           aria-label="${escapeHtml(myName)} clock">
        <span class="clock-name">${escapeHtml(myName)}</span>
        <span class="clock-time" data-clock-pi="${myPlayerIdx}">${formatClockMs(myMs)}</span>
      </div>
      ${canClaim ? `<button id="btn-claim-timeout" class="primary" type="button">Claim win on time</button>` : ''}
    </div>`;
}

// Run a single requestAnimationFrame loop while an online game is active and
// has clocks enabled. Updates only the active-side cell to avoid layout
// thrash. Re-anchors from state.clocks + clock_server_ts every frame so it
// stays in sync with the most-recently-received server snapshot/event.
let _clockRafHandle = null;
function startClockTicker() {
  if (_clockRafHandle != null) return;
  const tick = () => {
    _clockRafHandle = null;
    if (!active?.isOnline || !active.state || active.state.game_over) return;
    const s = active.state;
    if (!s.clocks || s.clock_active_index !== 0 && s.clock_active_index !== 1) {
      _clockRafHandle = requestAnimationFrame(tick);
      return;
    }
    const elapsed = Math.max(0, Date.now() - (s.clock_server_ts || Date.now()));
    const activePi = s.clock_active_index;
    const liveMs = Math.max(0, s.clocks[activePi] - elapsed);
    const el = document.querySelector(`#game-header .clock-time[data-clock-pi="${activePi}"]`);
    if (el) {
      const newText = formatClockMs(liveMs);
      if (el.textContent !== newText) el.textContent = newText;
      // Add a "low" class to the clock container when under 30s.
      const wrap = el.closest('.clock');
      if (wrap) wrap.classList.toggle('low', liveMs < 30_000);
      // If we just crossed zero and we're not the active side, surface the
      // claim button by triggering a full refresh.
      if (liveMs === 0 && activePi !== rolePlayerIndex(active)) {
        const existing = document.getElementById('btn-claim-timeout');
        if (!existing) refreshGame();
      }
    }
    _clockRafHandle = requestAnimationFrame(tick);
  };
  _clockRafHandle = requestAnimationFrame(tick);
}
function stopClockTicker() {
  if (_clockRafHandle != null) {
    cancelAnimationFrame(_clockRafHandle);
    _clockRafHandle = null;
  }
}

async function claimTimeout(gameId) {
  try {
    const r = await fetch(`/api/games/${gameId}/claim-timeout`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(body.error || 'Could not claim timeout.', { kind: 'warn' });
      return;
    }
  } catch (_) {
    toast('Network error — could not claim timeout.', { kind: 'error' });
  }
}
function statusLabel(state, info, replay) {
  if (state.game_over) {
    const w = state.winner;
    if (w === 1) return 'winner: Red';
    if (w === 2) return 'winner: Black';
    const lastKind = replay?.snapshots?.[replay.snapshots.length - 1]?.action?.kind;
    return lastKind === "accept_draw" ? "draw" : "winner: —";
  }
  if (info.join_user_id == null || info.status === 'waiting') return 'waiting for opponent to join';
  return 'playing';
}

function onOnlineCellClick(idx, state) {
  if (state.game_over) return;
  if (state.replayViewing) return;
  if (state.side_to_move !== state.my_player_index) return;
  // Pre-first-flip lock from a directed challenge: only the chosen first-mover
  // may make the opening flip. Server rejects either way; we just avoid round-trips.
  if (!state.first_flip_done
      && (state.first_mover_index === 0 || state.first_mover_index === 1)
      && state.first_mover_index !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      const drawOffer = active.offerDraw;
      active.offerDraw = false;
      sendIntent({ kind: 'flip', cell: idx, offer_draw: drawOffer });
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
    const drawOffer = active.offerDraw;
    active.offerDraw = false;
    sendIntent({ kind: 'move', from, to: idx, offer_draw: drawOffer });
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
  const mode = normMode($('lobby-otb-mode')?.value);
  _startOTBGame(mode);
}

function _startOTBGame(mode) {
  const game = mode === 'capture_general'
    ? Module.Game.createWithMode('capture_general')
    : Module.Game.create();
  active = {
    isOTB: true,
    game,
    mode,
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
  const modeBadge = (active.mode && active.mode !== 'standard')
    ? ` · ${modeLabel(active.mode)}`
    : '';
  let banner;
  if (view.replayViewing) {
    banner = `Replay — viewing move ${active.replay.currentStep()} / ${active.replay.totalMoves()}${modeBadge}`;
  } else if (view.game_over) {
    const w = view.winner;
    banner = `Game over — winner: ${w === 1 ? 'Red' : w === 2 ? 'Black' : '—'}${modeBadge}`;
  } else if (!view.first_flip_done) {
    banner = `Player 1 — flip a piece (your color is decided by your first flip)`;
  } else {
    const turnIdx = liveState.side_to_move;
    const sideName = turnIdx === 0 ? 'Player 1' : 'Player 2';
    const movingColor = turnIdx === 0 ? liveState.player0_color : liveState.player1_color;
    banner = `${sideName}'s turn (${colorWord(movingColor)})${modeBadge}`;
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
  const otbRematch = $('otb-rematch');
  otbRematch.classList.toggle('hidden', !view.game_over || view.replayViewing);
  otbRematch.onclick = () => { _startOTBGame(active.mode); };

  renderTranscript($('otb-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshOTB(); },
    onExport: (replay) => {
      const pgn = exportPgn(replay, { players: ['Player 1', 'Player 2'], event: 'Banqi (over-the-board)' });
      downloadPgn(pgn, `banqi-otb-${pgnFileStamp()}.pgn`);
    },
  });
  maybeShowTutorialTip($('otb-board'));
  maybeShowGameOver(view);
}
function colorWord(c) { return c === 1 ? 'Red' : c === 2 ? 'Black' : ''; }

function onLocalCellClick(idx, state, mode) {
  if (state.game_over) return;
  if (state.replayViewing) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  const refresh = () => mode === 'otb' ? refreshOTB() : refreshAI();
  const boardEl = $(mode === 'otb' ? 'otb-board' : 'ai-board');
  const sideToMove = state.side_to_move;
  if (mode === 'ai' && sideToMove !== state.my_player_index) return;
  if (mode === 'ai' && active.aiThinking) return;

  const myColorForClick = mode === 'ai' ? state.my_color : (
    sideToMove === 0 ? state.player0_color : state.player1_color
  );

  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      let event = null;
      try { event = localApply({ kind: 'flip', cell: idx }); }
      catch (e) { console.warn(e); }
      if (mode === 'ai') scheduleAIMove();
      refresh();
      if (event) playEventAnimation(boardEl, event, {});
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
    // Snapshot the source rect + piece before state changes for the move
    // animation overlay.
    const srcRect = captureCellRect(boardEl, from);
    const srcCell = state.cells[from];
    const piece = srcCell?.state === 'faceup'
      ? { color: srcCell.color, glyph: srcCell.glyph }
      : null;
    let event = null;
    try { event = localApply({ kind: 'move', from, to: idx }); }
    catch (e) { console.warn(e); }
    if (mode === 'ai') scheduleAIMove();
    refresh();
    if (event) playEventAnimation(boardEl, event, { srcRect, piece });
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
  const mode = normMode($('lobby-ai-mode')?.value);
  // Signed-in non-guest users get a server-persisted AI game that shows up
  // on their dashboard, contributes to Elo, and survives a refresh. Guests
  // and logged-out users keep the local-only WASM flow.
  if (me && !me.is_guest && online) {
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, opponent: 'ai:' + difficulty }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const g = await res.json();
      location.hash = `#/g/${g.roomCode}`;
      return;
    } catch (e) {
      toast('Could not start AI game. Falling back to local play.', { kind: 'warn' });
      // fall through to local mode
    }
  }
  await _moduleReady;
  _startAIGame(difficulty, mode);
}

function _startAIGame(difficulty, mode = 'standard') {
  showView('ai');
  const game = mode === 'capture_general'
    ? Module.Game.createWithMode('capture_general')
    : Module.Game.create();
  active = {
    isAI: true,
    game,
    difficulty,
    mode,
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
    const m = active?.mode || 'standard';
    _startAIGame(diff, m);
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

  const diffLabel = aiDifficultyLabel(active.difficulty);
  const modeBadge = (active.mode && active.mode !== 'standard')
    ? ` · ${modeLabel(active.mode)}`
    : '';
  let banner;
  if (view.replayViewing) {
    banner = `Replay — viewing move ${active.replay.currentStep()} / ${active.replay.totalMoves()}${modeBadge}`;
  } else if (view.game_over) {
    const w = view.winner;
    if (w === view.my_color) banner = `You win! 🎉${modeBadge}`;
    else if (w !== 0)         banner = `AI wins. Better luck next time.${modeBadge}`;
    else                      banner = `Game over${modeBadge}`;
  } else if (!view.first_flip_done) {
    banner = `Your turn — flip a piece to begin${modeBadge}`;
  } else if (view.side_to_move === 0) {
    banner = `Your turn (${colorWord(view.my_color)})${modeBadge}`;
  } else {
    banner = (active.aiThinking ? `AI is thinking…` : `AI's turn (${colorWord(view.my_color === 1 ? 2 : 1)})`) + modeBadge;
  }
  $('ai-banner').textContent = banner;
  $('ai-counts').innerHTML = renderPieceCountsHtml(pieceCounts(view.cells, active.replay));
  const nextDiff = { easy: 'medium', medium: 'hard', hard: 'expert', expert: 'master', master: 'policy', policy: 'easy' }[active.difficulty] || 'medium';
  $('ai-meta').innerHTML = `
    <span class="meta-label">Difficulty</span>
    <button id="ai-diff-chip" class="diff-chip" type="button"
            aria-label="Difficulty ${diffLabel}. Click to change to ${nextDiff} on next new game"
            title="Click to cycle (takes effect on next New game)">${diffLabel} ↻</button>`;
  $('ai-diff-chip').onclick = () => {
    active.difficulty = nextDiff;
    const sel = $('lobby-ai-difficulty');
    if (sel) sel.value = nextDiff;
    toast(`Difficulty will be ${aiDifficultyLabel(nextDiff)} on the next new game.`,
          { kind: 'info', timeoutMs: 3000 });
    refreshAI();
  };
  $('ai-resign').disabled = !liveState.first_flip_done || liveState.game_over
    || liveState.side_to_move !== 0 || view.replayViewing;
  $('ai-new-game').disabled = false;
  $('ai-new-game').classList.toggle('btn-emphasis', !!view.game_over);
  $('ai-thinking').classList.toggle('hidden', !active.aiThinking);

  renderTranscript($('ai-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshAI(); },
    onExport: (replay) => {
      const diff = aiDifficultyLabel(active.difficulty);
      const pgn = exportPgn(replay, {
        players: ['You', `AI (${diff || active.difficulty})`],
        event:   'Banqi (vs AI)',
      });
      downloadPgn(pgn, `banqi-ai-${pgnFileStamp()}.pgn`);
    },
  });
  maybeShowTutorialTip($('ai-board'));
  maybeShowGameOver(view);
}

function pgnFileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
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
    let event = null;
    let animCtx = {};
    try {
      const move = chooseMove(fresh, 1, active.difficulty);
      if (move) {
        const intent = move.from < 0
          ? { kind: 'flip', cell: move.to }
          : { kind: 'move', from: move.from, to: move.to };
        const boardEl = $('ai-board');
        if (intent.kind === 'move') {
          // Capture source from the human's POV state — that's what the
          // board element currently reflects.
          const humanPov = JSON.parse(active.game.stateJson(0));
          const srcCell = humanPov.cells[intent.from];
          animCtx = {
            srcRect: captureCellRect(boardEl, intent.from),
            piece: srcCell?.state === 'faceup'
              ? { color: srcCell.color, glyph: srcCell.glyph }
              : null,
          };
        }
        event = localApply(intent);
      }
    } catch (e) { console.warn('AI move error:', e); }
    active.aiThinking = false;
    refreshAI();
    if (event) playEventAnimation($('ai-board'), event, animCtx);
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
        parts.push(`<span class="pc-chip" title="${label}" aria-label="${label}"><span class="pc-chip-g">${glyphs[t]}</span><span class="pc-chip-r" aria-hidden="true">${t}</span><span class="pc-chip-n">${n}</span></span>`);
      }
    }
    return parts.length
      ? `<span class="pc-breakdown" aria-hidden="false">${parts.join('')}</span>`
      : '';
  };
  const row = (label, sideGlyph, cls, colorVal, c) =>
    `<div class="pc-row pc-row-${cls}">
      <span class="pc-side ${cls}" aria-label="${label}">
        <span class="pc-glyph" aria-hidden="true">${sideGlyph}</span>${label}
      </span>
      <span class="pc-stat"><span class="pc-label">Shown</span> ${c.shown}${breakdown(colorVal, c.byType, 'shown')}</span>
      <span class="pc-stat"><span class="pc-label">Hidden</span> ${c.hidden}${breakdown(colorVal, c.byType, 'hidden')}</span>
      <span class="pc-stat"><span class="pc-label">Capt</span> ${c.captured}${breakdown(colorVal, c.byType, 'captured')}</span>
    </div>`;
  return `<div class="piece-counts">${row('Red', '帥', 'red', 1, counts.red)}${row('Black', '將', 'black', 2, counts.black)}</div>`;
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

// ---- dashboard / My Games ----------------------------------------------
//
// `renderDashboard` does the one-shot fetch + state-reset + shell mount;
// after that, search/chip clicks call `rerenderDashboardBody` which only
// touches the sections container.

const DASH_CHIPS = [
  { id: 'all',       label: 'All' },
  { id: 'your_turn', label: 'Your turn' },
  { id: 'waiting',   label: 'Waiting' },
  { id: 'completed', label: 'Completed' },
];
const dashState = {
  query: '',
  chip: 'all',
  collapsedCompleted: true,
  games: [],
  shellMounted: false,
};

async function renderDashboard() {
  showView('dashboard');
  refreshNotificationBadge();
  ensureNotifySettingsPanel();
  const sections = $('dashboard-sections');
  const controls = $('dash-controls');
  if (!me) {
    controls.classList.add('hidden');
    sections.innerHTML = `<div>Sign in first. <a href="#/">Lobby</a></div>`;
    return;
  }
  if (!online) {
    controls.classList.add('hidden');
    sections.innerHTML = `<div class="muted">You're offline — can't load games. <a href="#/">Lobby</a></div>`;
    return;
  }
  renderNotifySettings();
  let games;
  try {
    const r = await fetch('/api/games');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    games = await r.json();
  } catch (e) {
    controls.classList.add('hidden');
    sections.innerHTML = `<div class="err">Couldn't load your games.
      <a href="#/dashboard">Retry</a>.</div>`;
    toast('Couldn’t load your games.', { kind: 'error' });
    return;
  }
  dashState.games = games;
  if (!games.length) {
    controls.classList.add('hidden');
    sections.innerHTML = `
      <div class="empty-state">
        <p>You haven’t played a game yet.</p>
        <div class="row">
          <a href="#/" class="primary">Start a game</a>
          <a href="#/ai" class="link-btn">…or play the AI</a>
        </div>
      </div>`;
    return;
  }
  controls.classList.remove('hidden');
  mountDashboardShell();
  rerenderDashboardBody();
}

function mountDashboardShell() {
  if (dashState.shellMounted) return;
  dashState.shellMounted = true;

  const search = $('dash-search');
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      dashState.query = search.value.trim();
      rerenderDashboardBody();
    }, 120);
  });

  // Click delegation across the whole sections container handles delete
  // buttons (one listener regardless of how many cards exist) and the
  // collapsed/expanded toggle on the Completed section header.
  const sections = $('dashboard-sections');
  sections.addEventListener('click', async (ev) => {
    const del = ev.target.closest('[data-action="delete"]');
    if (del) {
      ev.preventDefault();
      ev.stopPropagation();
      await handleDeleteClick(del);
      return;
    }
    const toggle = ev.target.closest('[data-action="toggle-completed"]');
    if (toggle) {
      ev.preventDefault();
      dashState.collapsedCompleted = !dashState.collapsedCompleted;
      rerenderDashboardBody();
    }
  });

  // Chips render once into #dash-chips; clicks update dashState.chip.
  const chipRow = $('dash-chips');
  chipRow.innerHTML = DASH_CHIPS.map((c) => `
    <button class="chip" type="button" role="tab" data-chip="${c.id}"
            aria-selected="${c.id === dashState.chip}">
      ${escapeHtml(c.label)}<span class="chip-count" data-count="${c.id}"></span>
    </button>`).join('');
  chipRow.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.chip');
    if (!btn) return;
    dashState.chip = btn.dataset.chip;
    chipRow.querySelectorAll('.chip').forEach((b) =>
      b.setAttribute('aria-selected', b.dataset.chip === dashState.chip));
    rerenderDashboardBody();
  });
}

function rerenderDashboardBody() {
  const sections = $('dashboard-sections');
  const buckets = bucketGames(dashState.games);

  // Live counts inside the chip pills, computed from un-search-filtered
  // buckets so the numbers stay stable as the user types.
  const chipRow = $('dash-chips');
  if (chipRow) {
    const counts = {
      all:       dashState.games.length,
      your_turn: buckets.yourTurn.length,
      waiting:   buckets.waiting.length,
      completed: buckets.completed.length,
    };
    chipRow.querySelectorAll('[data-count]').forEach((el) => {
      const n = counts[el.dataset.count] ?? 0;
      el.textContent = n ? ` · ${n}` : '';
    });
  }

  const filtered = filterGames(dashState.games, dashState.query, dashState.chip);
  if (!filtered.length) {
    sections.innerHTML = renderFilterEmptyState();
    return;
  }

  if (dashState.chip !== 'all') {
    sections.innerHTML = filtered.map(renderGameCard).join('');
    return;
  }
  const fb = bucketGames(filtered);
  const html = [
    renderSection('Your turn',  fb.yourTurn,  { emphasize: true }),
    renderSection('Their turn', fb.theirTurn, {}),
    renderSection('Waiting for opponent', fb.waiting, {}),
    renderSection('Completed', fb.completed,
      { collapsible: true, collapsed: dashState.collapsedCompleted, capVisible: 20 }),
  ].filter(Boolean).join('');
  sections.innerHTML = html;
}

function bucketGames(games) {
  const out = { yourTurn: [], theirTurn: [], waiting: [], completed: [] };
  for (const g of games) {
    if (g.status === 'complete')      out.completed.push(g);
    else if (g.status === 'waiting')  out.waiting.push(g);
    else if (g.your_turn)             out.yourTurn.push(g);
    else                              out.theirTurn.push(g);
  }
  return out;
}

function filterGames(games, query, chip) {
  let pool = games;
  if (chip === 'your_turn') pool = pool.filter((g) => g.status === 'playing' && g.your_turn);
  else if (chip === 'waiting')   pool = pool.filter((g) => g.status === 'waiting');
  else if (chip === 'completed') pool = pool.filter((g) => g.status === 'complete');
  if (!query) return pool;
  const q = query.toLowerCase();
  return pool.filter((g) => {
    const opp = (opponentNameFor(g) || '').toLowerCase();
    const room = (g.room_code || '').toLowerCase();
    return opp.includes(q) || room.includes(q);
  });
}

function renderSection(title, games, opts) {
  if (!games.length) return '';
  const cap = opts.capVisible || games.length;
  const visible = games.slice(0, cap);
  const hidden = games.length - visible.length;
  const collapsedClass = opts.collapsed ? ' collapsed' : '';
  const headerTag = opts.collapsible ? 'button' : 'div';
  const headerAttrs = opts.collapsible
    ? `type="button" data-action="toggle-completed" aria-expanded="${!opts.collapsed}"`
    : '';
  const chevron = opts.collapsible
    ? `<span class="dash-section-chevron" aria-hidden="true">▾</span>`
    : '';
  const more = hidden > 0
    ? `<div class="gc-meta" style="text-align:center;padding:6px 0;">+ ${hidden} older</div>`
    : '';
  return `
    <section class="dash-section${collapsedClass}">
      <${headerTag} class="dash-section-header" ${headerAttrs}>
        ${escapeHtml(title)}
        <span class="dash-section-count">(${games.length})</span>
        ${chevron}
      </${headerTag}>
      <div class="dash-section-body">
        ${visible.map(renderGameCard).join('')}
        ${more}
      </div>
    </section>`;
}

function renderGameCard(g) {
  const oppName  = opponentNameFor(g);
  const oppLabel = g.opponent_is_ai ? 'AI' : (oppName || '(waiting for opponent)');
  const avatarClass = g.opponent_is_ai ? 'gc-avatar gc-avatar--ai' : 'gc-avatar';
  const avatarChar  = g.opponent_is_ai ? '🤖' : initialsFor(oppName);
  const yourTurn = g.status === 'playing' && g.your_turn;
  const cardClass = yourTurn ? 'game-card your-turn' : 'game-card';

  const ts = g.status === 'complete'
    ? (g.ended_at || g.last_move_at || g.created_at)
    : (g.last_move_at || g.created_at);
  const ago = relativeTime(ts);

  let meta;
  if (g.status === 'waiting') {
    meta = `Waiting for opponent · room ${escapeHtml(g.room_code)}`;
  } else if (g.status === 'complete') {
    meta = `${ago} · room ${escapeHtml(g.room_code)}`;
  } else if (yourTurn) {
    meta = `Your move · ${ago}`;
  } else if (g.active_index == null && g.my_role) {
    meta = `Either side can flip first · ${ago}`;
  } else {
    meta = `${escapeHtml(oppLabel)}'s move · ${ago}`;
  }

  const badges = [];
  if (g.status === 'complete') {
    const myId = me?.id;
    const oppId = g.host_user_id === myId ? g.join_user_id : g.host_user_id;
    if (g.winner_user_id == null)            badges.push('<span class="badge badge--draw">Draw</span>');
    else if (g.winner_user_id === myId)      badges.push('<span class="badge badge--win">Won</span>');
    else if (g.winner_user_id === oppId)     badges.push('<span class="badge badge--loss">Lost</span>');
  }
  if (g.opponent_is_ai && g.ai_difficulty) {
    badges.push(`<span class="badge badge--ai">AI · ${escapeHtml(aiDifficultyLabel(g.ai_difficulty))}</span>`);
  }
  if (g.mode && g.mode !== 'standard') {
    badges.push(`<span class="badge badge--mode">${escapeHtml(modeLabel(g.mode))}</span>`);
  }
  if (g.status === 'playing' && g.time_limit_ms != null) {
    badges.push(`<span class="badge badge--clock">${escapeHtml(timeControlLabel(g.time_limit_ms, g.increment_ms))}</span>`);
  }

  const dot = yourTurn ? `<span class="gc-turn-dot" aria-hidden="true"></span>` : '';

  // Wrap card body in an <a> (no nested button — invalid HTML) and sit the
  // delete button beside it as an absolutely-positioned sibling.
  return `
    <div class="${cardClass}" data-game-id="${g.id}" data-room="${escapeHtml(g.room_code)}">
      <a class="game-card-link" href="#/g/${escapeHtml(g.room_code)}">
        <div class="${avatarClass}" aria-hidden="true">${avatarChar}</div>
        <div class="gc-main">
          ${dot}<span class="gc-name">vs ${escapeHtml(oppLabel)}</span>
        </div>
        <div class="gc-meta">${meta}</div>
        <div class="gc-badges">${badges.join('')}</div>
      </a>
      <button class="gc-delete" type="button" data-action="delete"
              title="Remove from my games"
              aria-label="Remove game vs ${escapeHtml(oppLabel)} from my games">×</button>
    </div>`;
}

function renderFilterEmptyState() {
  const q = dashState.query;
  const chipLabel = (DASH_CHIPS.find((c) => c.id === dashState.chip) || {}).label || '';
  const detail = q
    ? `No games match “${escapeHtml(q)}”${chipLabel && chipLabel !== 'All' ? ` in ${escapeHtml(chipLabel)}` : ''}.`
    : `No games in ${escapeHtml(chipLabel)}.`;
  return `<div class="dash-empty-filter">${detail}
            <a href="#" class="link-btn" data-action="clear-filters">Clear filters</a>
          </div>`;
}

function opponentNameFor(g) {
  if (!me) return g.host_name || g.join_name || '';
  return g.host_user_id === me.id ? (g.join_name || '') : (g.host_name || '');
}

async function handleDeleteClick(btn) {
  const card = btn.closest('.game-card');
  const id = card?.dataset.gameId;
  const room = card?.dataset.room || '';
  if (!id) return;
  if (!confirm(`Remove game ${room} from your dashboard?\n\nThis hides it from your list. Completed games stay in the leaderboard / Elo history; an opponent who already joined will still see the game on their side.`)) return;
  btn.disabled = true;
  try {
    const r = await fetch(`/api/games/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    dashState.games = dashState.games.filter((g) => String(g.id) !== String(id));
    if (!dashState.games.length) renderDashboard();
    else rerenderDashboardBody();
    toast('Removed from your games.', { kind: 'success', timeoutMs: 2500 });
  } catch (e) {
    btn.disabled = false;
    toast(`Couldn't remove game: ${e.message || e}`, { kind: 'error' });
  }
}

// "Clear filters" link inside the empty-filter state and any future inline
// resets live here so they don't need their own listener inside render fns.
document.addEventListener('click', (ev) => {
  const clear = ev.target.closest('[data-action="clear-filters"]');
  if (!clear) return;
  ev.preventDefault();
  dashState.query = '';
  dashState.chip = 'all';
  const search = document.getElementById('dash-search');
  if (search) search.value = '';
  const chipRow = document.getElementById('dash-chips');
  if (chipRow) chipRow.querySelectorAll('.chip').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.chip === 'all'));
  rerenderDashboardBody();
});

// ---- notification settings (rendered in the dashboard view) ----
function ensureNotifySettingsPanel() {
  if (document.getElementById('notify-settings')) return;
  const view = views.dashboard;
  if (!view) return;
  const panel = document.createElement('div');
  panel.id = 'notify-settings';
  panel.className = 'notify-settings';
  // Sit just above the search/chip controls so users can flip notifications
  // on without scrolling past their actual games.
  const anchor = $('dash-controls') || $('dashboard-sections');
  view.insertBefore(panel, anchor);
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
  const isAi = p.provider === 'ai';
  // AI profiles get a "Play vs <difficulty>" CTA instead of the human
  // challenge button — match requests and friending are blocked server-side
  // for AI rows, so we shouldn't offer those affordances here either.
  const challengeBlock = isAi
    ? (me && !me.is_guest ? `
        <div class="row" style="margin:12px 0">
          <button id="btn-play-ai-from-profile" class="primary">Play Banqi AI · ${escapeHtml((p.provider_id || '').replace(/^./, (c) => c.toUpperCase()))}</button>
        </div>` : '')
    : (me && !isSelf ? `
        <div class="row" style="margin:12px 0">
          <button id="btn-challenge" class="primary">Challenge to a game</button>
          <span class="muted small">Sends a match request. They have to be a friend or someone you've played before.</span>
        </div>` : '');
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
  if (challengeBlock && !isAi) {
    $('btn-challenge').onclick = () => {
      location.hash = `#/challenge/${p.id}`;
    };
  }
  if (isAi && $('btn-play-ai-from-profile')) {
    $('btn-play-ai-from-profile').onclick = async () => {
      const mode = await pickChallengeMode();
      if (mode == null) return;
      try {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, opponent: 'ai:' + p.provider_id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const g = await res.json();
        location.hash = `#/g/${g.roomCode}`;
      } catch (e) {
        toast('Could not start AI game.', { kind: 'error' });
      }
    };
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

async function challengePlayer(toUserId, opts = {}) {
  if (!me) return null;
  const mode = normMode(opts.mode);
  const firstMoverPref = normFirstMoverPref(opts.first_mover_pref);
  const message = (typeof opts.message === 'string') ? opts.message.trim() : '';
  const body = {
    to_user_id: toUserId,
    mode,
    first_mover_pref: firstMoverPref,
  };
  if (message) body.message = message;
  if (Number.isInteger(opts.time_limit_ms)) body.time_limit_ms = opts.time_limit_ms;
  if (Number.isInteger(opts.increment_ms) && opts.increment_ms > 0) {
    body.increment_ms = opts.increment_ms;
  }
  const res = await fetch('/api/match-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  if (res.status === 403) {
    toast(responseBody.error || 'Become friends first to challenge each other.', { kind: 'warn' });
    return null;
  }
  if (!res.ok) {
    toast(responseBody.error || 'Could not send challenge.', { kind: 'error' });
    return null;
  }
  const tcChip = body.time_limit_ms ? ` · ${timeControlLabel(body.time_limit_ms, body.increment_ms || 0)}` : '';
  toast(`Challenge sent (${modeLabel(mode)}${tcChip}).`, { kind: 'success' });
  return responseBody;
}

const FIRST_MOVER_PREFS = ['challenger', 'opponent', 'random'];
function normFirstMoverPref(p) {
  return FIRST_MOVER_PREFS.includes(p) ? p : 'random';
}

// Time-control presets surfaced in the challenge picker. value === '' is
// the special "unlimited" sentinel; 'custom' opens the inline number inputs.
// Each preset is { base_min, inc_sec } in human units.
const TIME_CONTROL_PRESETS = [
  { value: '',         label: 'Unlimited' },
  { value: '1+0',      label: '1 + 0',   base_min: 1,  inc_sec: 0  },
  { value: '3+0',      label: '3 + 0',   base_min: 3,  inc_sec: 0  },
  { value: '3+2',      label: '3 + 2',   base_min: 3,  inc_sec: 2  },
  { value: '5+0',      label: '5 + 0',   base_min: 5,  inc_sec: 0  },
  { value: '5+3',      label: '5 + 3',   base_min: 5,  inc_sec: 3  },
  { value: '10+0',     label: '10 + 0',  base_min: 10, inc_sec: 0  },
  { value: '10+5',     label: '10 + 5',  base_min: 10, inc_sec: 5  },
  { value: '15+10',    label: '15 + 10', base_min: 15, inc_sec: 10 },
  { value: '30+0',     label: '30 + 0',  base_min: 30, inc_sec: 0  },
  { value: 'custom',   label: 'Custom…' },
];

// Render a human label for a (time_limit_ms, increment_ms) pair. Returns
// 'Unlimited' when there's no clock, otherwise 'minutes+seconds'.
function timeControlLabel(timeLimitMs, incrementMs = 0) {
  if (timeLimitMs == null) return 'Unlimited';
  const baseMin = Math.round(timeLimitMs / 60000);
  const incSec  = Math.round((incrementMs || 0) / 1000);
  return `${baseMin}+${incSec}`;
}

// Compact human-readable "time since" string. Falls back to an absolute
// date for events older than a week so we don't bury the year in a "Nd ago".
function relativeTime(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 45)        return 'just now';
  if (sec < 90)        return '1m ago';
  const min = Math.round(sec / 60);
  if (min < 60)        return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr  < 24)        return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7)         return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Per-perspective chip text. Outgoing = the viewer is the challenger;
// incoming = the viewer is the recipient. 'random' renders no chip (it's
// the default, no need to clutter the row).
function firstMoverChipText(pref, perspective) {
  if (pref === 'random' || !pref) return null;
  if (perspective === 'outgoing') {
    return pref === 'challenger' ? 'You flip first' : 'They flip first';
  }
  return pref === 'challenger' ? 'They flip first' : 'You flip first';
}

function matchRequestChips(req, perspective) {
  const parts = [
    `<span class="mode-chip small">${escapeHtml(modeLabel(normMode(req.mode)))}</span>`,
  ];
  const fm = firstMoverChipText(req.first_mover_pref, perspective);
  if (fm) parts.push(`<span class="mode-chip small">${escapeHtml(fm)}</span>`);
  // Only show a TC chip when there's actually a clock; "Unlimited" is the
  // default and would clutter every row.
  if (req.time_limit_ms != null) {
    parts.push(`<span class="mode-chip small">${escapeHtml(timeControlLabel(req.time_limit_ms, req.increment_ms || 0))}</span>`);
  }
  return parts.join(' ');
}

// Minimal mode-only modal used by the AI profile button ("Play Banqi AI · X").
// AI games are created via POST /api/games and don't carry first-mover / TC /
// message; the full challenge-details screen is reserved for human directed
// challenges. Resolves to the chosen mode string, or null if cancelled.
function pickChallengeMode() {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(null); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cm-title" tabindex="-1">
        <h2 id="cm-title">Start game</h2>
        <p class="modal-body">Pick the win condition for this match.</p>
        <div class="row" style="margin:8px 0 16px">
          <label for="cm-mode">Win condition</label>
          <select id="cm-mode">
            <option value="standard" selected>Standard (no legal moves)</option>
            <option value="capture_general">Capture the General</option>
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm primary">Start</button>
        </div>
      </div>`;
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    overlay.querySelector('.btn-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.btn-confirm').addEventListener('click', () => {
      const v = overlay.querySelector('#cm-mode').value;
      close(normMode(v));
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    overlay.querySelector('.btn-confirm').focus();
  });
}

// Full-screen view the challenger lands on after clicking "Challenge". Lets
// them pick the win condition, who flips first, and an optional message,
// then sends the match request via challengePlayer().
async function renderChallengeDetails(targetUserId) {
  showView('challenge');
  const body = $('challenge-body');
  if (!me) {
    body.innerHTML = `<div class="muted">Sign in to send a challenge. <a href="#/">Lobby</a></div>`;
    return;
  }
  if (me.id === targetUserId) {
    body.innerHTML = `<div class="err">You can't challenge yourself. <a href="#/friends">Friends</a></div>`;
    return;
  }
  if (!online) {
    body.innerHTML = `<div class="muted">You're offline — can't send a challenge right now. <a href="#/">Lobby</a></div>`;
    return;
  }
  body.innerHTML = `<div class="muted">Loading…</div>`;
  let opponent;
  try {
    const r = await fetch(`/api/users/${targetUserId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    opponent = await r.json();
  } catch (_) {
    body.innerHTML = `<div class="err">Couldn't load that player. <a href="#/friends">Friends</a></div>`;
    return;
  }
  body.innerHTML = `
    <div class="challenge-details">
      <p class="muted">Sending a challenge to <b>${escapeHtml(opponent.display_name)}</b>
         <span class="muted small">(Elo ${opponent.elo})</span>.
         They'll see this request in their Friends page and can accept, decline, or ignore it.</p>

      <fieldset class="challenge-section">
        <legend>Win condition</legend>
        <label class="radio-row">
          <input type="radio" name="cd-mode" value="standard" checked>
          <span><b>Standard</b> <span class="muted small">— you lose if you have no legal move.</span></span>
        </label>
        <label class="radio-row">
          <input type="radio" name="cd-mode" value="capture_general">
          <span><b>Capture the General</b> <span class="muted small">— win by capturing the opposing General.</span></span>
        </label>
      </fieldset>

      <fieldset class="challenge-section">
        <legend>Who flips first</legend>
        <label class="radio-row">
          <input type="radio" name="cd-first" value="random" checked>
          <span><b>Random</b> <span class="muted small">— decided when they accept.</span></span>
        </label>
        <label class="radio-row">
          <input type="radio" name="cd-first" value="challenger">
          <span><b>I flip first</b> <span class="muted small">— I'll make the opening flip (claiming that color).</span></span>
        </label>
        <label class="radio-row">
          <input type="radio" name="cd-first" value="opponent">
          <span><b>${escapeHtml(opponent.display_name)} flips first</b> <span class="muted small">— they make the opening flip.</span></span>
        </label>
      </fieldset>

      <fieldset class="challenge-section">
        <legend>Time control</legend>
        <div class="row">
          <label for="cd-tc-preset">Pace</label>
          <select id="cd-tc-preset">
            ${TIME_CONTROL_PRESETS.map(p =>
              `<option value="${escapeHtml(p.value)}"${p.value === '' ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
            ).join('')}
          </select>
        </div>
        <div id="cd-tc-custom" class="row hidden" style="margin-top:8px">
          <label for="cd-tc-base">Base minutes</label>
          <input id="cd-tc-base" type="number" min="1" max="180" step="1" value="5" inputmode="numeric">
          <label for="cd-tc-inc">Increment seconds</label>
          <input id="cd-tc-inc"  type="number" min="0" max="60"  step="1" value="0" inputmode="numeric">
        </div>
        <div class="muted small" id="cd-tc-help">No clock — players take as long as they want.</div>
      </fieldset>

      <fieldset class="challenge-section">
        <legend>Message <span class="muted small">(optional)</span></legend>
        <textarea id="cd-message" maxlength="280" rows="3"
                  placeholder="Add a note for your opponent — they'll see it on their incoming request."></textarea>
        <div class="muted small"><span id="cd-message-count">0</span> / 280</div>
      </fieldset>

      <div class="row challenge-actions">
        <button type="button" id="cd-cancel" class="link-btn">Cancel</button>
        <button type="button" id="cd-send" class="primary">Send challenge</button>
      </div>
    </div>`;

  const messageEl = $('cd-message');
  const countEl = $('cd-message-count');
  messageEl.addEventListener('input', () => {
    countEl.textContent = String(messageEl.value.length);
  });

  const tcPresetEl = $('cd-tc-preset');
  const tcCustomEl = $('cd-tc-custom');
  const tcBaseEl   = $('cd-tc-base');
  const tcIncEl    = $('cd-tc-inc');
  const tcHelpEl   = $('cd-tc-help');
  const refreshTcUI = () => {
    const v = tcPresetEl.value;
    tcCustomEl.classList.toggle('hidden', v !== 'custom');
    const tc = readTcFromPicker();
    if (tc.time_limit_ms == null) {
      tcHelpEl.textContent = 'No clock — players take as long as they want.';
    } else {
      const baseMin = Math.round(tc.time_limit_ms / 60000);
      const incSec  = Math.round(tc.increment_ms / 1000);
      tcHelpEl.textContent = `${baseMin} minute${baseMin === 1 ? '' : 's'} per side, +${incSec}s per move.`;
    }
  };
  function readTcFromPicker() {
    const v = tcPresetEl.value;
    if (v === '') return { time_limit_ms: null, increment_ms: 0 };
    if (v === 'custom') {
      const baseMin = Math.max(1, Math.min(180, parseInt(tcBaseEl.value, 10) || 0));
      const incSec  = Math.max(0, Math.min(60,  parseInt(tcIncEl.value,  10) || 0));
      return { time_limit_ms: baseMin * 60000, increment_ms: incSec * 1000 };
    }
    const preset = TIME_CONTROL_PRESETS.find(p => p.value === v);
    if (!preset) return { time_limit_ms: null, increment_ms: 0 };
    return {
      time_limit_ms: preset.base_min * 60000,
      increment_ms:  preset.inc_sec  * 1000,
    };
  }
  tcPresetEl.addEventListener('change', refreshTcUI);
  tcBaseEl.addEventListener('input', refreshTcUI);
  tcIncEl.addEventListener('input', refreshTcUI);
  refreshTcUI();

  $('cd-cancel').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.hash = `#/profile/${targetUserId}`;
  });

  $('cd-send').addEventListener('click', async (e) => {
    const sendBtn = e.currentTarget;
    sendBtn.disabled = true;
    const mode = body.querySelector('input[name="cd-mode"]:checked')?.value || 'standard';
    const firstMoverPref = body.querySelector('input[name="cd-first"]:checked')?.value || 'random';
    const message = messageEl.value || '';
    const tc = readTcFromPicker();
    const result = await challengePlayer(targetUserId, {
      mode, first_mover_pref: firstMoverPref, message,
      time_limit_ms: tc.time_limit_ms, increment_ms: tc.increment_ms,
    });
    if (!result) {
      sendBtn.disabled = false;
      return;
    }
    location.hash = '#/friends';
  });
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
          <div class="req-summary">
            <span><b>${escapeHtml(r.from_name || '')}</b> wants to play
              ${matchRequestChips(r, 'incoming')}</span>
            <span class="row">
              <button class="primary" data-action="accept" data-req="${r.id}">Accept</button>
              <button class="link-btn" data-action="decline" data-req="${r.id}">Decline</button>
            </span>
          </div>
          ${r.message ? `<div class="req-message">“${escapeHtml(r.message)}”</div>` : ''}
        </li>`).join('')}</ul>`}`;

  const outgoing = requests?.outgoing || [];
  $('friends-outgoing-requests').innerHTML = `
    <h3>Sent challenges${outgoing.length ? ` (${outgoing.length})` : ''}</h3>
    ${outgoing.length === 0 ? `<div class="muted">No outgoing requests.</div>` :
      `<ul class="friends-req-list">${outgoing.map(r => `
        <li data-req="${r.id}">
          <div class="req-summary">
            <span>Sent to <b>${escapeHtml(r.to_name || '')}</b>
              ${matchRequestChips(r, 'outgoing')}</span>
            <button class="link-btn" data-action="cancel" data-req="${r.id}">Cancel</button>
          </div>
          ${r.message ? `<div class="req-message">“${escapeHtml(r.message)}”</div>` : ''}
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
        location.hash = `#/challenge/${friendId}`;
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
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

function infoModal({ title, html, closeLabel = 'Close' } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-info" role="dialog" aria-modal="true" aria-labelledby="modal-title"
           aria-describedby="modal-body" tabindex="-1">
        <h2 id="modal-title"></h2>
        <div id="modal-body" class="modal-body"></div>
        <div class="modal-actions">
          <button type="button" class="btn-close primary"></button>
        </div>
      </div>`;
    overlay.querySelector('#modal-title').textContent = title || '';
    overlay.querySelector('#modal-body').innerHTML = html || '';
    const btnClose = overlay.querySelector('.btn-close');
    btnClose.textContent = closeLabel;

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { btnClose.focus(); e.preventDefault(); }
    };
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    btnClose.focus();
  });
}

function showKeyboardHelp() {
  if (document.querySelector('.modal-overlay')) return;
  const html = `
    <p class="muted small" style="margin-top:0">Shortcuts work anywhere unless you're typing in a text field.</p>
    <dl class="kbd-help">
      <dt><kbd>?</kbd></dt>            <dd>Show this help</dd>
      <dt><kbd>Esc</kbd></dt>          <dd>Close a dialog</dd>
      <dt><kbd>Tab</kbd></dt>          <dd>Move focus between controls</dd>
    </dl>
    <h3 class="kbd-help-section">Board (when a cell is focused)</h3>
    <dl class="kbd-help">
      <dt><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move focus between cells</dd>
      <dt><kbd>Home</kbd> / <kbd>End</kbd></dt><dd>Jump to row start / end</dd>
      <dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>Flip, select, or move to the focused cell</dd>
    </dl>`;
  infoModal({ title: 'Keyboard shortcuts', html });
}

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

// ---- game-over celebration modal ----
// outcome: 'win' | 'loss' | 'draw'
// actions: array of { label, onClick, primary, danger }
function showGameOverModal({ outcome, title, subtitle, actions = [] }) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const glyph = outcome === 'win' ? '勝' : outcome === 'loss' ? '敗' : '和';
  const glyphCls = outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : 'draw';

  overlay.innerHTML = `
    <div class="modal game-over-modal" role="dialog" aria-modal="true"
         aria-labelledby="go-title" tabindex="-1">
      ${outcome === 'win' ? '<div class="confetti" aria-hidden="true"></div>' : ''}
      <div class="go-glyph ${glyphCls}" aria-hidden="true">${glyph}</div>
      <h2 id="go-title">${escapeHtml(title)}</h2>
      ${subtitle ? `<p class="go-sub">${escapeHtml(subtitle)}</p>` : ''}
      <div class="modal-actions"></div>
    </div>`;

  const actionsEl = overlay.querySelector('.modal-actions');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    if (a.primary) btn.className = 'primary';
    else if (a.danger) btn.className = 'btn-danger';
    btn.addEventListener('click', () => {
      try { a.onClick?.(); } finally { close(); }
    });
    actionsEl.appendChild(btn);
  }

  if (outcome === 'win') seedConfetti(overlay.querySelector('.confetti'));

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    try { previouslyFocused?.focus?.(); } catch (_) {}
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  root.appendChild(overlay);
  overlay.querySelector('.modal').focus();
}

function seedConfetti(container) {
  if (!container) return;
  const colors = ['#ffb43a', '#ffc868', '#d24343', '#6ec96e', '#6ea4ff', '#e0e0e0'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.4}s`;
    s.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(s);
  }
}

// Decides what to show in the game-over modal for the current active session
// and triggers it (idempotent — calls itself only once per game).
function maybeShowGameOver(view) {
  if (!view?.game_over) return;
  if (!active || active._gameOverShown) return;
  active._gameOverShown = true;

  const winner = view.winner;
  // Online: my_color is the side YOU play. If winner === my_color, you won.
  // OTB: nobody is "you"; use a generic banner.
  // AI: my_color === 1 for player 0 (human).
  let outcome, title, subtitle;
  if (active.isOnline) {
    const myColor = view.my_color;
    if (winner === 0 || winner == null) { outcome = 'draw'; title = "It's a draw"; }
    else if (winner === myColor) { outcome = 'win'; title = 'You win!'; subtitle = 'Nicely played.'; }
    else { outcome = 'loss'; title = 'You lost'; subtitle = 'Good game — review the moves to learn.'; }
  } else if (active.isAI) {
    if (winner === 0 || winner == null) { outcome = 'draw'; title = "It's a draw"; }
    else if (winner === view.my_color) { outcome = 'win'; title = 'You beat the AI!'; subtitle = 'Try a harder difficulty.'; }
    else { outcome = 'loss'; title = 'The AI wins'; subtitle = "Try again — the AI doesn't get tired."; }
  } else {
    // OTB
    const name = winner === 1 ? 'Red' : winner === 2 ? 'Black' : null;
    outcome = name ? 'win' : 'draw';
    title = name ? `${name} wins!` : "It's a draw";
    subtitle = name ? 'Good game.' : null;
  }

  const actions = [];
  if (active.isAI) {
    actions.push({ label: 'New game', primary: true, onClick: () => {
      const diff = active?.difficulty || Difficulty.MEDIUM;
      const m = active?.mode || 'standard';
      _startAIGame(diff, m);
    }});
    actions.push({ label: 'Review moves', onClick: () => {} });
  } else if (active.isOTB) {
    actions.push({ label: 'New game', primary: true, onClick: () => { openOTB(); }});
    actions.push({ label: 'Lobby', onClick: () => { location.hash = '#/'; }});
  } else {
    actions.push({ label: 'Lobby', primary: true, onClick: () => { location.hash = '#/'; }});
    actions.push({ label: 'Review moves', onClick: () => {} });
  }

  showGameOverModal({ outcome, title, subtitle, actions });
}

// ---- contextual tutorial tooltip (first-time players) ----
function maybeShowTutorialTip(boardEl) {
  try {
    if (localStorage.getItem('banqi.tutorial-seen') === '1') return;
  } catch (_) { return; }
  // Only show on the very first board view (a fresh game with all cells
  // face-down).
  const facedown = boardEl.querySelectorAll('.cell.facedown');
  if (facedown.length < 30) return;  // not a fresh game
  if (document.querySelector('.tutorial-tip')) return;  // already showing

  // Anchor near a face-down piece in the middle of the board.
  const anchor = boardEl.querySelector('[data-cell-index="10"]') || facedown[0];
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();

  const tip = document.createElement('div');
  tip.className = 'tutorial-tip';
  tip.setAttribute('role', 'note');
  tip.innerHTML = `
    <div><strong>Click any face-down piece to start.</strong></div>
    <div style="margin-top:4px;font-weight:400;font-size:12px;">
      The piece you reveal sets your color for the game.
    </div>
    <button type="button" class="tip-dismiss">Got it</button>`;
  document.body.appendChild(tip);
  // Position below the anchor, clamped to viewport.
  const tipRect = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tipRect.width / 2;
  let top = r.bottom + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  if (top + tipRect.height > window.innerHeight - 8) {
    top = r.top - tipRect.height - 10;
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;

  const dismiss = () => {
    try { localStorage.setItem('banqi.tutorial-seen', '1'); } catch (_) {}
    tip.remove();
  };
  tip.querySelector('.tip-dismiss').addEventListener('click', dismiss);
  // Auto-dismiss on first click of any cell.
  const onAnyClick = () => { dismiss(); boardEl.removeEventListener('click', onAnyClick, true); };
  boardEl.addEventListener('click', onAnyClick, true);
}

// ---- utils ----
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// First letter of a display name, uppercased, for avatar initials. Strips
// emoji/punctuation so we land on a letter when one is available.
function initialsFor(name) {
  const ch = String(name || '').replace(/[^\p{L}\p{N}]+/gu, '').charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

// ---- boot ----
document.addEventListener('keydown', (e) => {
  if (e.key !== '?') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  if (document.querySelector('.modal-overlay')) return;
  e.preventDefault();
  showKeyboardHelp();
});

const btnHelp = document.getElementById('btn-keyboard-help');
if (btnHelp) btnHelp.addEventListener('click', showKeyboardHelp);

await refreshSession();
applyNavAuthState();
route();
