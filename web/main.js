// Banqi web client.
//
// Drives the C++ WASM Game over three transports:
//   * federated   — WebSocket to the hosted relay (default for online play)
//   * otb         — local loopback for one-device hot-seat (no network, no auth)
//   * p2p-classic — PeerJS WebRTC, preserved for advanced/legacy use
//
// Hash routing: #/ (lobby), #/g/<roomCode> (game), #/otb, #/dashboard,
//               #/leaderboard, #/profile/<id>, #/classic (legacy P2P lobby).

import createBanqiModule from './banqi.js';
import { RelayConnection, LoopbackConnection } from './relay.js';
import { chooseMove, Difficulty } from './ai.js';
import { Replay, renderTranscript, normalizeAction } from './replay.js';
import { bootstrapFederated } from './fed_bootstrap.js';

// ---- service worker / PWA ----
// Kicked off before the WASM await so registration runs in parallel with the
// (slower) module load. Browsers without SW support (or page served over a
// non-secure origin other than localhost) silently skip this block.
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

const Module = await createBanqiModule();

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
  classic:     $('view-classic'),
};
function showView(name) {
  for (const v of Object.values(views)) v?.classList.add('hidden');
  views[name]?.classList.remove('hidden');
  // After the new view is shown, move keyboard focus to its heading so
  // screen-reader users land somewhere meaningful and keyboard users
  // resume from a sensible spot.
  queueMicrotask(() => {
    const view = views[name];
    if (!view) return;
    const target = view.querySelector('h2[tabindex], h2, button, a[href], select, input, [tabindex="0"]');
    target?.focus({ preventScroll: false });
  });
}

// Polite, throttled screen-reader announcement. Replays an empty string
// first so identical consecutive messages still re-announce. Truncates
// loud cascades by debouncing.
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
let me = null;            // current user from /api/me, or null
let providers = { github: false, google: false, dev: false };

// ---- online/offline ----
// Reflects navigator.onLine; updated by 'online'/'offline' window events. The
// banner is injected once on first transition (or on init if we boot offline)
// and toggled via CSS. We only re-render the lobby on a state change — active
// federated games handle their own reconnection via the existing WS retry
// path, and forcing route() while a game is open would leak the connection.
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
  // Re-render only the lobby; other views own their own offline behavior.
  if (!location.hash || location.hash === '#/' || location.hash === '#') renderLobby();
}
window.addEventListener('online',  () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
if (!online) document.body.classList.add('is-offline');

// ---- iOS Add-to-Home-Screen hint ----
// Apple does not fire `beforeinstallprompt`, so we surface a one-time
// dismissible footer banner pointing iOS Safari users to the Share menu.
// Hidden in standalone mode (already installed) and on non-iOS-Safari UAs.
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
  if (m) { announce(`Game room ${m[1]}`); return openFederatedGame(m[1].toUpperCase()); }

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
    case '#/classic':     announce('Classic P2P');      return renderClassicLobby();
    default:              announce('Lobby');            return renderLobby();
  }
}
window.addEventListener('hashchange', route);

// ---- sign-in ----
// Renders the GitHub/Google/dev sign-in buttons into `container`. After a
// successful sign-in the relay redirects the browser back to `nextHash`
// (e.g. '#/g/ABCDEF') so deep-linked invites resume where the user left off.
function renderSignInButtons(container, nextHash) {
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
    meBox.innerHTML = `
      <div class="me-row">
        <div><b>Hi, ${escapeHtml(me.display_name)}</b> · Elo ${me.elo}
          · <a href="#/dashboard">my games</a>
          · <a href="#/leaderboard">leaderboard</a>
          · <a href="#/friends">friends<span id="nav-notif-badge" class="badge hidden"></span></a>
          · <a href="#/profile/${me.id}">profile</a>
        </div>
        <button id="btn-signout" class="link-btn">Sign out</button>
      </div>`;
    $('btn-signout').onclick = signOut;
    refreshNotificationBadge();
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
  $('btn-classic').onclick = () => { location.hash = '#/classic'; };
  const modeExplainBtn = $('btn-mode-explain');
  const modeExplainBox = $('mode-explain-box');
  if (modeExplainBtn && modeExplainBox) {
    modeExplainBtn.onclick = () => {
      const isOpen = !modeExplainBox.classList.contains('hidden');
      modeExplainBox.classList.toggle('hidden', isOpen);
      modeExplainBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    };
  }
}

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  me = null;
  route();
}

async function startOnlineGame() {
  if (!me) return;
  const mode = $('lobby-mode').value || 'casual';
  const res = await fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) { toast('Could not create game. Try again.', { kind: 'error' }); return; }
  const g = await res.json();
  location.hash = `#/g/${g.roomCode}`;
}

// ---- federated game ----
let active = null;  // {game, conn, replay, gameId, roomCode, role, ...}

async function openFederatedGame(roomCode) {
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
    $('game-retry').onclick = () => openFederatedGame(roomCode);
    return;
  }

  // Look up (or join) the game.
  let info;
  try {
    info = await fetch(`/api/games/by-room/${encodeURIComponent(roomCode)}`).then(r => r.json());
    if (info.error) throw new Error(info.error);
  } catch (e) {
    $('game-header').innerHTML = `<div class="err">Couldn't find room <code>${roomCode}</code>.</div>`;
    return;
  }

  if (info.my_role == null) {
    // We're a third party — try to join.
    const jr = await fetch(`/api/games/${info.id}/join`, { method: 'POST' });
    if (!jr.ok) {
      $('game-header').innerHTML = `<div class="err">This game is full.</div>`;
      return;
    }
    info = await fetch(`/api/games/${info.id}`).then(r => r.json());
  }
  const isHost = info.my_role === 'host';

  // Construct the Game with our deterministic identity seed.
  const modeInt = info.mode === 'crypto' ? 2 : 1;
  const gameIdForCpp = String(info.id);  // any stable token works; both sides must use the same
  const game = isHost
    ? Module.Game.createHostWithSeed(modeInt, gameIdForCpp, me.identity_seed_hex)
    : Module.Game.createJoinWithSeed(modeInt, gameIdForCpp, me.identity_seed_hex);

  active = {
    info, game, isHost, conn: null,
    bootstrapping: true,
    queuedData: [],
    pendingSends: [],
    selected: null,
    pendingFinalize: false,
    finalizeReported: false,
    transport: 'federated',
    replay: new Replay(),
  };

  // Open the live WebSocket. The bootstrap (log fetch + replay) happens in
  // attachConnAsTransport's 'open' handler, AFTER our WS has been added to
  // the server's peer set. Doing the log fetch beforehand is racy: a peer
  // who connects and sends HELLO while we're not yet in the peer set will
  // have their HELLO persisted, but the broadcast goes to peers minus
  // themselves (= ∅) and never reaches us on the wire. Fetching the log
  // post-connect guarantees we see every message persisted up to our
  // connect time; anything persisted after arrives via 'data'.
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  active.conn = new RelayConnection(`${wsScheme}://${location.host}/ws/${info.id}`);
  attachConnAsTransport(active);

  refreshGame();
}

function attachConnAsTransport(act) {
  const { conn } = act;
  act.connState = 'live';
  conn.on('open', async () => {
    if (act.bootstrapping) {
      // First open: fetch the log AFTER our WS has joined the peer set, so
      // any HELLO a peer broadcast before we connected (which goes to
      // peers minus the sender = ∅ in that race) is captured by the log
      // fetch instead of being silently lost. Then bootstrap, flush, and
      // drain anything that arrived live while we were fetching.
      let log;
      try {
        log = await fetch(`/api/games/${act.info.id}/messages?since=0`)
          .then((r) => r.json());
      } catch (e) {
        console.error('relay log fetch failed:', e);
        return;
      }
      act.pendingSends = bootstrapFederated({
        game: act.game,
        log,
        myUserId: me.id,
        applyLocal: (action) => applyLocalAction(act, action),
        applyPeer:  (body)   => applyPeerMessage(act, body),
        parseJson:  parseJsonSafe,
        normalizeAction,
      });
      act.bootstrapping = false;
      if (act.pendingSends?.length) {
        act.conn.send(act.pendingSends.join('\n'));
        act.pendingSends = [];
      }
      // Drain queued live frames, deduping against the log snapshot we
      // just bootstrapped from (a frame can race with our fetch and arrive
      // on both paths).
      const logBodies = new Set(log.map((m) => String(m.body).trim()));
      const queued = act.queuedData;
      act.queuedData = [];
      for (const line of queued) {
        if (logBodies.has(String(line).trim())) continue;
        try {
          const out = applyPeerMessage(act, line);
          if (act.conn && out) act.conn.send(out);
        } catch (e) {
          console.warn('handleMessage:', e);
        }
      }
    } else if (act.pendingSends?.length) {
      // Reconnect: flush anything we generated while offline.
      act.conn.send(act.pendingSends.join('\n'));
      act.pendingSends = [];
    }
    if (act.connState !== 'live') {
      announce('Connection restored');
      toast('Reconnected.', { kind: 'success', timeoutMs: 2500 });
    }
    act.connState = 'live';
    refreshGame();
  });
  conn.on('data', (line) => {
    if (act.bootstrapping) { act.queuedData.push(line); return; }
    try {
      const out = applyPeerMessage(act, line);
      if (act.conn && out) act.conn.send(out);
    } catch (e) {
      console.warn('handleMessage:', e);
      toast('Couldn’t process a message from the relay.', { kind: 'warn' });
    }
    refreshGame();
  });
  conn.on('close', () => {
    if (act.connState === 'live') announce('Connection lost. Reconnecting…');
    act.connState = 'offline';
    refreshGame();
  });
  conn.on('reconnecting', () => {
    act.connState = 'reconnecting';
    refreshGame();
  });
  conn.on('meta', (m) => {
    // Server tells us our role; we already know it from REST, but log for diagnostics.
    console.log('relay meta:', m);
  });
}

// ---- replay/transcript helpers (used by every play mode) ----
//
// Each helper pushes a "pending" action onto the Replay before invoking the
// C++ Game so that observe() can attribute the new transcript entry. If the
// underlying call throws, the pending entry is dropped to keep the queue
// aligned with actual transcript growth.

function applyLocalAction(act, action) {
  const game = act.game;
  act.replay.pushPending(action, game.myPlayerIndex());
  let out;
  try {
    if (action.kind === 'flip') out = game.localFlip(action.to);
    else if (action.kind === 'move') out = game.localMove(action.from, action.to);
    else if (action.kind === 'resign') out = game.localResign();
    else throw new Error(`unknown local action kind: ${action.kind}`);
  } catch (e) {
    act.replay.dropPending();
    throw e;
  }
  act.replay.observe(JSON.parse(game.stateJson()));
  return out;
}

function applyPeerMessage(act, line) {
  const game = act.game;
  const parsed = parseJsonSafe(line);
  let pushed = false;
  if (parsed?.type === 'MOVE_ENTRY') {
    const action = normalizeAction(parsed.payload);
    if (action) {
      act.replay.pushPending(action, 1 - game.myPlayerIndex());
      pushed = true;
    }
  }
  let out;
  try { out = game.handleMessage(line); }
  catch (e) {
    if (pushed) act.replay.dropPending();
    throw e;
  }
  act.replay.observe(JSON.parse(game.stateJson()));
  // Announce the opponent's move + briefly flag the destination cell so it
  // flashes on the next render. Skipped during bootstrap to avoid replaying
  // the whole log into the screen-reader buffer.
  if (pushed && !act.bootstrapping) {
    const lastSnap = act.replay.snapshots[act.replay.snapshots.length - 1];
    if (lastSnap) {
      announce(`Opponent: ${describeAction(lastSnap, act.replay)}`);
      act.flashCellIdx = lastSnap.action?.to;
      act.flashUntil = Date.now() + 1200;
    }
  }
  return out;
}

// OTB / vs-AI helper: the replay tracker observes one of the two paired
// games (since they keep identical rules state). Pending action is pushed
// once per logical move, against the mover's side.
function applyOTBAction(act, action, moverIdx) {
  const game = moverIdx === 0 ? act.hostGame : act.joinGame;
  const sender = moverIdx === 0 ? act.hostTr : act.joinTr;
  act.replay.pushPending(action, moverIdx);
  let out;
  try {
    if (action.kind === 'flip') out = game.localFlip(action.to);
    else if (action.kind === 'move') out = game.localMove(action.from, action.to);
    else if (action.kind === 'resign') out = game.localResign();
    else throw new Error(`unknown otb action kind: ${action.kind}`);
  } catch (e) {
    act.replay.dropPending();
    throw e;
  }
  if (out) sender.send(out);
  act.replay.observe(JSON.parse(game.stateJson()));
  return out;
}

function applyAIAction(act, side, action) {
  const game = side === 'human' ? act.humanGame : act.aiGame;
  const sender = side === 'human' ? act.humanTr : act.aiTr;
  // moverIdx: human = host = 0, AI = join = 1
  const moverIdx = side === 'human' ? 0 : 1;
  act.replay.pushPending(action, moverIdx);
  let out;
  try {
    if (action.kind === 'flip') out = game.localFlip(action.to);
    else if (action.kind === 'move') out = game.localMove(action.from, action.to);
    else if (action.kind === 'resign') out = game.localResign();
    else throw new Error(`unknown ai action kind: ${action.kind}`);
  } catch (e) {
    act.replay.dropPending();
    throw e;
  }
  if (out) sender.send(out);
  act.replay.observe(JSON.parse(game.stateJson()));
  return out;
}

// Render a state through the replay lens. Returns a "view state" with cells
// possibly frozen to a past snapshot, legal_moves stripped to disable
// interactivity, and a replayViewing flag for the renderer.
function viewState(act, liveState) {
  const lastMoveCells = lastMoveFromReplay(act.replay);
  const flashCellIdx = act.flashUntil && Date.now() < act.flashUntil ? act.flashCellIdx : -1;
  if (!act.replay || act.replay.isLive()) {
    return { ...liveState, replayViewing: false, lastMoveCells, flashCellIdx };
  }
  const finality = act.replay.finalityFor(liveState);
  // Highlight the move that produced this position. viewIndex === -1 → no move.
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

function lastMoveFromReplay(replay) {
  if (!replay || replay.snapshots.length === 0) return null;
  const snap = replay.snapshots[replay.snapshots.length - 1];
  const a = snap.action || {};
  if (a.kind === 'move') return { from: a.from, to: a.to };
  if (a.kind === 'flip') return { from: -1, to: a.to };
  return null;
}

// Plain-English description of a transcript snapshot, for the SR announcer.
function describeAction(snap, replay) {
  const a = snap?.action || {};
  const toCoord = (i) => i >= 0 ? 'abcdefgh'[i % 8] + ((i >> 3) + 1) : '';
  if (a.kind === 'flip') {
    const cell = snap.cellsAfter?.[a.to];
    const name = cell && cell.state === 'faceup'
      ? `${cell.color === 1 ? 'Red' : 'Black'} ${['','Soldier','Cannon','Horse','Chariot','Elephant','Advisor','General'][cell.type] || ''}`.trim()
      : 'face-down piece';
    return `flipped ${toCoord(a.to)} — ${name}`;
  }
  if (a.kind === 'move') {
    let s = `${toCoord(a.from)} to ${toCoord(a.to)}`;
    if (snap.captured) {
      s += snap.captured.facedown
        ? ', capturing a face-down piece'
        : `, capturing ${snap.captured.color === 1 ? 'Red' : 'Black'} ${['','Soldier','Cannon','Horse','Chariot','Elephant','Advisor','General'][snap.captured.type] || ''}`.trim();
    }
    return s;
  }
  if (a.kind === 'resign') return 'resigned';
  return 'made a move';
}

// ---- over-the-board ----
function openOTB() {
  showView('otb');
  // Two Games, two loopback transports wired peer-to-peer.
  //
  // Wiring: a.send(line) → fires b.on('data', line) and vice versa. So each
  // game *sends* on its OWN transport, and *receives* from its OWN
  // transport's 'data' event (which fires when the peer sends).
  //
  // The Replay tracker observes hostGame (the two games' rules state stays
  // in sync, so either is fine). pushPending only fires at the click site,
  // so the join-side handleMessage doesn't double-count entries.
  const gameId = `otb-${Date.now()}`;
  const hostGame = Module.Game.createHost(1, gameId);   // 1 = casual
  const joinGame = Module.Game.createJoin(1, gameId);
  const [hostTr, joinTr] = LoopbackConnection.pair();

  hostTr.on('data', (line) => {
    try {
      const out = hostGame.handleMessage(line);
      if (out) hostTr.send(out);
    } catch (e) { console.warn('host otb:', e); }
    if (active?.replay) active.replay.observe(JSON.parse(hostGame.stateJson()));
    refreshOTB();
  });
  joinTr.on('data', (line) => {
    try {
      const out = joinGame.handleMessage(line);
      if (out) joinTr.send(out);
    } catch (e) { console.warn('join otb:', e); }
    refreshOTB();
  });

  // Bootstrap: each game emits its HELLO on its own transport.
  hostTr.send(hostGame.start());
  joinTr.send(joinGame.start());

  active = {
    isOTB: true,
    hostGame, joinGame, hostTr, joinTr,
    selected: null,
    transport: 'otb',
    replay: new Replay(),
  };
  refreshOTB();
}

function refreshOTB() {
  if (!active?.isOTB) return;
  // Determine which game is "active" — the one whose side_to_move == its own
  // player index. Both games have the same shared rules-engine state by
  // construction, so we can ask either.
  // Probe the host game just to get the global turn index.
  active.replay.observe(JSON.parse(active.hostGame.stateJson()));

  const turnIdx = JSON.parse(active.hostGame.stateJson()).side_to_move;
  const activeGame = turnIdx === 0 ? active.hostGame : active.joinGame;
  const liveState = JSON.parse(activeGame.stateJson());
  // state.my_player_index already equals turnIdx because activeGame is the
  // side whose turn it is. legal_moves_for_me and my_color are already
  // computed against the active side. No massaging needed.
  const view = viewState(active, liveState);
  renderBoard($('otb-board'), view, (idx) => {
    if (view.replayViewing) return;  // replay view is read-only
    onOTBCellClick(idx, view);
  });
  // Banner
  let banner;
  if (view.replayViewing) {
    banner = `Replay — viewing move ${active.replay.currentStep()} / ${active.replay.totalMoves()}`;
  } else if (view.game_over) {
    const w = view.winner;
    banner = `Game over — winner: ${w === 1 ? 'Red' : w === 2 ? 'Black' : '—'}`;
  } else if (!view.first_flip_done) {
    banner = `Player 1 — flip a piece (your color is decided by your first flip)`;
  } else {
    const sideName = turnIdx === 0 ? 'Player 1' : 'Player 2';
    banner = `${sideName}'s turn (${colorWord(view.my_color)})`;
  }
  $('otb-banner').textContent = banner;
  $('otb-resign').disabled = !liveState.setup_done || liveState.game_over || view.replayViewing;
  $('otb-resign').onclick = async () => {
    if (view.replayViewing) return;
    const liveTurn = JSON.parse(active.hostGame.stateJson()).side_to_move;
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: `Player ${liveTurn + 1} resigns. The other player wins. This can't be undone.`,
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    try { applyOTBAction(active, { kind: 'resign' }, liveTurn); }
    catch (e) { toast(`Couldn't resign: ${e.message || e}`, { kind: 'error' }); }
    refreshOTB();
  };

  renderTranscript($('otb-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshOTB(); },
  });
}
function colorWord(c) { return c === 1 ? 'Red' : c === 2 ? 'Black' : ''; }

function onOTBCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.replayViewing) return;
  const turnIdx = state.side_to_move;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { applyOTBAction(active, { kind: 'flip', to: idx }, turnIdx); }
      catch (e) { console.warn(e); }
      refreshOTB();
      return;
    }
    if (c.state === 'faceup' && c.color === state.my_color &&
        legal.some(m => m.from === idx)) {
      active.selected = idx;
      refreshOTB();
    }
    return;
  }
  if (legal.some(m => m.from === active.selected && m.to === idx)) {
    const from = active.selected;
    active.selected = null;
    try { applyOTBAction(active, { kind: 'move', from, to: idx }, turnIdx); }
    catch (e) { console.warn(e); }
    refreshOTB();
    return;
  }
  if (idx === active.selected) { active.selected = null; refreshOTB(); return; }
  active.selected = null;
  refreshOTB();
}

// ---- vs AI ----
//
// The human is the host (player 0, moves first).
// The AI is the join player (player 1).
// Both sides use the same OTB loopback-transport structure; the AI simply
// submits moves automatically instead of waiting for clicks.

const AI_THINK_DELAY_MS = 350; // brief pause so moves feel natural

function openAIGame() {
  // Read difficulty from the lobby selector (retained across navigations).
  const difficulty = $('lobby-ai-difficulty')?.value || Difficulty.MEDIUM;
  _startAIGame(difficulty);
}

function _startAIGame(difficulty) {
  showView('ai');

  const gameId = `ai-${Date.now()}`;
  const humanGame = Module.Game.createHost(1, gameId);  // human = host = player 0
  const aiGame    = Module.Game.createJoin(1, gameId);  // AI    = join = player 1
  const [humanTr, aiTr] = LoopbackConnection.pair();

  // Wire the human transport: messages from the AI land here.
  humanTr.on('data', (line) => {
    try {
      const out = humanGame.handleMessage(line);
      if (out) humanTr.send(out);
    } catch (e) { console.warn('human handleMessage:', e); }
    if (active?.replay) active.replay.observe(JSON.parse(humanGame.stateJson()));
    refreshAI();
  });

  // Wire the AI transport: messages from the human land here.
  aiTr.on('data', (line) => {
    try {
      const out = aiGame.handleMessage(line);
      if (out) aiTr.send(out);
    } catch (e) { console.warn('ai handleMessage:', e); }
    refreshAI();
    scheduleAIMove();
  });

  // Bootstrap handshake
  humanTr.send(humanGame.start());
  aiTr.send(aiGame.start());

  active = {
    isAI: true,
    humanGame, aiGame, humanTr, aiTr,
    difficulty,
    selected: null,
    aiThinking: false,
    transport: 'ai',
    replay: new Replay(),
  };

  // Button wiring
  $('ai-resign').onclick = async () => {
    if (!active?.isAI) return;
    const state = JSON.parse(active.humanGame.stateJson());
    if (!state.setup_done || state.game_over) return;
    if (state.side_to_move !== state.my_player_index) return; // only resign on your turn
    if (!active.replay.isLive()) return; // resign disabled in replay view
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: 'You forfeit the game. The AI wins. This can’t be undone.',
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    try { applyAIAction(active, 'human', { kind: 'resign' }); }
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
  const liveState = JSON.parse(active.humanGame.stateJson());
  active.replay.observe(liveState);
  const view = viewState(active, liveState);
  renderBoard($('ai-board'), view, (idx) => {
    if (view.replayViewing) return;
    onAICellClick(idx, view);
  });

  const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[active.difficulty] || '';
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
  } else if (view.side_to_move === view.my_player_index) {
    banner = `Your turn (${colorWord(view.my_color)})`;
  } else {
    banner = active.aiThinking ? `AI is thinking…` : `AI's turn (${colorWord(view.my_color === 1 ? 2 : 1)})`;
  }
  $('ai-banner').textContent = banner;
  // Render difficulty as an interactive chip — click cycles to the next
  // difficulty; the change takes effect on the next "New game".
  const nextDiff = { easy: 'medium', medium: 'hard', hard: 'easy' }[active.difficulty] || 'medium';
  $('ai-meta').innerHTML = `
    <span class="meta-label">Difficulty</span>
    <button id="ai-diff-chip" class="diff-chip" type="button"
            aria-label="Difficulty ${diffLabel}. Click to change to ${nextDiff} on next new game"
            title="Click to cycle (takes effect on next New game)">${diffLabel} ↻</button>`;
  $('ai-diff-chip').onclick = () => {
    active.difficulty = nextDiff;
    // Reflect in lobby selector so a re-entry uses the new value.
    const sel = $('lobby-ai-difficulty');
    if (sel) sel.value = nextDiff;
    toast(`Difficulty will be ${({easy:'Easy', medium:'Medium', hard:'Hard'})[nextDiff]} on the next new game.`,
          { kind: 'info', timeoutMs: 3000 });
    refreshAI();
  };
  $('ai-resign').disabled = !liveState.setup_done || liveState.game_over
    || liveState.side_to_move !== liveState.my_player_index
    || view.replayViewing;
  $('ai-new-game').disabled = false;
  $('ai-thinking').classList.toggle('hidden', !active.aiThinking);

  renderTranscript($('ai-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshAI(); },
  });
}

function onAICellClick(idx, state) {
  if (!active?.isAI) return;
  if (!state.setup_done || state.game_over) return;
  if (state.replayViewing) return;
  if (state.side_to_move !== state.my_player_index) return; // not human's turn
  if (active.aiThinking) return;

  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;

  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { applyAIAction(active, 'human', { kind: 'flip', to: idx }); }
      catch (e) { console.warn(e); }
      refreshAI();
      return;
    }
    if (c.state === 'faceup' && c.color === state.my_color && legal.some(m => m.from === idx)) {
      active.selected = idx;
      refreshAI();
    }
    return;
  }
  if (legal.some(m => m.from === active.selected && m.to === idx)) {
    const from = active.selected;
    active.selected = null;
    try { applyAIAction(active, 'human', { kind: 'move', from, to: idx }); }
    catch (e) { console.warn(e); }
    refreshAI();
    return;
  }
  if (idx === active.selected) { active.selected = null; refreshAI(); return; }
  active.selected = null;
  refreshAI();
}

function scheduleAIMove() {
  if (!active?.isAI) return;
  const state = JSON.parse(active.aiGame.stateJson());
  if (!state.setup_done || state.game_over) return;
  if (state.side_to_move !== state.my_player_index) return; // not AI's turn

  active.aiThinking = true;
  refreshAI();

  const thisSession = active; // capture to detect stale timeouts
  setTimeout(() => {
    if (active !== thisSession) return; // user started a new game

    const freshState = JSON.parse(active.aiGame.stateJson());
    if (freshState.game_over || freshState.side_to_move !== freshState.my_player_index) {
      active.aiThinking = false;
      refreshAI();
      return;
    }

    try {
      const move = chooseMove(freshState, freshState.my_player_index, active.difficulty);
      if (move) {
        const action = move.from < 0
          ? { kind: 'flip', to: move.to }
          : { kind: 'move', from: move.from, to: move.to };
        applyAIAction(active, 'ai', action);
      }
    } catch (e) { console.warn('AI move error:', e); }

    active.aiThinking = false;
    refreshAI();
  }, AI_THINK_DELAY_MS);
}

// ---- shared rendering ----
const PIECE_NAMES = ['', 'Soldier', 'Cannon', 'Horse', 'Chariot', 'Elephant', 'Advisor', 'General'];

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

// Move focus by a (dRow, dCol) step on a board grid keyed by data-cell-index.
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
  // Roving-tabindex: remember which cell holds tab focus across re-renders.
  const prevFocusIdx = boardEl.querySelector('[data-cell-index][tabindex="0"]')?.dataset.cellIndex;
  const hadDomFocus = boardEl.contains(document.activeElement);

  boardEl.innerHTML = '';
  boardEl.classList.toggle('replay-viewing', !!state.replayViewing);
  attachBoardKeyNav(boardEl);

  const legal = state.legal_moves_for_me || [];
  const flipTargets = new Set();
  const moveTargetsBySrc = new Map();
  for (const m of legal) {
    if (m.from < 0) flipTargets.add(m.to);
    else {
      if (!moveTargetsBySrc.has(m.from)) moveTargetsBySrc.set(m.from, new Set());
      moveTargetsBySrc.get(m.from).add(m.to);
    }
  }
  // Highlight the cells involved in the move being viewed (replay mode) or
  // the most recent move (live mode).
  const highlight = state.replayMoveCells || state.lastMoveCells || null;
  const myTurnLive = state.side_to_move === state.my_player_index && !state.game_over && !state.replayViewing;

  // Determine which cell will hold tabindex=0 (single tab-stop into the grid).
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
      btn.textContent = c.glyph;
    }
    const isSelected = !state.replayViewing && active?.selected === i;
    if (isSelected) { btn.classList.add('selected'); opts.selected = true; }
    if (myTurnLive) {
      if (active?.selected != null && moveTargetsBySrc.get(active.selected)?.has(i)) {
        btn.classList.add('legal-target'); opts.legal = 'move-target';
      } else if (active?.selected == null && flipTargets.has(i)) {
        btn.classList.add('legal'); opts.legal = 'flip';
      } else if (active?.selected == null && moveTargetsBySrc.has(i)) {
        btn.classList.add('legal'); opts.legal = 'movable';
      }
    }
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

  // Watermark when viewing a past position.
  if (state.replayViewing) {
    const wm = document.createElement('div');
    wm.className = 'replay-watermark';
    wm.textContent = 'REPLAY';
    wm.setAttribute('aria-hidden', 'true');
    boardEl.appendChild(wm);
  }

  // Restore DOM focus if it was inside the board before the redraw.
  if (hadDomFocus) {
    const tgt = boardEl.querySelector(`[data-cell-index="${focusIdx}"]`);
    tgt?.focus();
  }
}

// ---- federated game rendering ----
function refreshGame() {
  if (!active || active.isOTB) return;
  const liveState = JSON.parse(active.game.stateJson());
  active.replay?.observe(liveState);
  const view = viewState(active, liveState);
  renderBoard($('game-board'), view, (idx) => {
    if (view.replayViewing) return;
    onFedCellClick(idx, view);
  });
  const opp = active.isHost ? active.info.join_name : active.info.host_name;
  const colorChip = liveState.my_color === 1
    ? '<span class="color-chip red" aria-label="You are Red">帥 Red</span>'
    : liveState.my_color === 2
      ? '<span class="color-chip black" aria-label="You are Black">將 Black</span>'
      : '';
  const connState = active.connState || 'live';   // live | reconnecting | offline
  const connLabel = connState === 'live' ? 'Live'
                   : connState === 'reconnecting' ? 'Reconnecting…'
                   : 'Offline';
  const replayBadge = view.replayViewing
    ? `<div class="replay-badge">Reviewing move ${active.replay.currentStep()}/${active.replay.totalMoves()}</div>`
    : '';
  const disconnectBanner = connState !== 'live'
    ? `<div class="disconnect-banner" role="alert">
         <span>${connState === 'offline'
            ? 'Connection lost. Trying to reconnect…'
            : 'Reconnecting to the relay…'}</span>
         <button id="btn-retry-conn" type="button">Retry now</button>
       </div>`
    : '';
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
          ${liveState.setup_done && !liveState.game_over && !view.replayViewing ? '' : 'disabled'}>Resign</button>
      </div>
      <div class="meta-row meta-row-status">
        <span><span class="meta-label">Move</span> ${liveState.transcript_seq}</span>
        <span><span class="meta-label">Status</span> <span id="game-status-line">${statusLabel(liveState, active.info)}</span></span>
        <span><span class="meta-label">Turn</span> <span id="game-turn">${turnLabel(liveState)}</span></span>
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
    try {
      const out = applyLocalAction(active, { kind: 'resign' });
      if (active.conn && out) active.conn.send(out);
    } catch (e) { toast(`Couldn't resign: ${e.message || e}`, { kind: 'error' }); }
    refreshGame();
  };
  const retryBtn = $('btn-retry-conn');
  if (retryBtn) retryBtn.onclick = () => { active.conn?.reconnect?.(); };

  renderTranscript($('game-transcript'), active.replay, {
    onJump: (step) => { active.replay.goToStep(step); refreshGame(); },
  });

  // If the game just ended, report finalize once. Use liveState so the
  // finalize fires on the actual end of game, not while viewing a replay.
  if (liveState.game_over && !active.finalizeReported) {
    active.finalizeReported = true;
    const myColor = liveState.my_color;
    const iWon = liveState.winner !== 0 && liveState.winner === myColor;
    fetch(`/api/games/${active.info.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        winner_color: liveState.winner,
        tip_hash: liveState.tip_hash || '',
        i_won: iWon,
      }),
    }).then((r) => {
      if (!r.ok) throw new Error(`finalize HTTP ${r.status}`);
    }).catch(() => {
      // Reset so the next render retries.
      active.finalizeReported = false;
      toast('Couldn’t save the result. Will retry…', { kind: 'warn' });
    });
  }
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
  // setup_done is the authoritative "we're playing" signal — it only
  // flips once both sides have exchanged HELLO + SETUP_*. info.status
  // is a REST snapshot taken on entry; it can read 'waiting' on a host
  // that already saw its peer connect via WS, so we treat the WASM
  // state as ground truth.
  if (state.setup_done) return 'playing';
  if (info.status === 'waiting') return 'waiting for opponent to join';
  return 'shuffling…';
}

function onFedCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.replayViewing) return;
  if (state.side_to_move !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try {
        const out = applyLocalAction(active, { kind: 'flip', to: idx });
        if (active.conn && out) active.conn.send(out);
      } catch (e) { console.warn(e); }
      refreshGame();
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
    try {
      const out = applyLocalAction(active, { kind: 'move', from, to: idx });
      if (active.conn && out) active.conn.send(out);
    } catch (e) { console.warn(e); }
    refreshGame();
    return;
  }
  if (idx === active.selected) { active.selected = null; refreshGame(); return; }
  active.selected = null;
  refreshGame();
}

async function copyInviteLink() {
  if (!active?.info) return;
  const url = `${location.origin}/#/g/${active.info.room_code}`;
  // Prefer the native share sheet when it's available AND the input was a
  // touch tap — on desktop, copying to the clipboard is faster than a share
  // sheet detour. window.matchMedia tracks input type cheaply.
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
      // AbortError is the user dismissing — fall through silently. Other
      // errors fall through to clipboard.
      if (e?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flashCopied('Copied!');
  } catch (_) {
    // Last-ditch fallback if clipboard API is blocked (insecure context, etc).
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

// ---- dashboard ----
async function renderDashboard() {
  showView('dashboard');
  refreshNotificationBadge();
  const list = $('dashboard-list');
  if (!me) { list.innerHTML = `<div>Sign in first. <a href="#/">Lobby</a></div>`; return; }
  if (!online) { list.innerHTML = `<div class="muted">You're offline — can't load games. <a href="#/">Lobby</a></div>`; return; }
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
              : g.status === 'disputed'  ? 'disputed'
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

async function challengePlayer(toUserId, mode = 'casual') {
  if (!me) return;
  const res = await fetch('/api/match-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_user_id: toUserId, mode }),
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
          <span><b>${escapeHtml(r.from_name || '')}</b> wants to play
            <code>${escapeHtml(r.mode)}</code></span>
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
          <span>Sent to <b>${escapeHtml(r.to_name || '')}</b>
            (<code>${escapeHtml(r.mode)}</code>)</span>
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

// ---- classic P2P lobby (legacy PeerJS flow, preserved) ----
async function renderClassicLobby() {
  showView('classic');
  // Lazy-load PeerJS to avoid the network/script cost when not in use.
  if (!window.Peer) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'peerjs.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => {});
  }
  if (!window.Peer) {
    $('classic-body').innerHTML = `<div class="err">Couldn't load PeerJS.</div>`;
    return;
  }
  initClassicUI();
}

// (Lightweight version of the previous main.js classic-mode flow, behind a
// disclosure. Single Peer + DataConnection, with peer-ID copy/paste.)
let classicPeer = null, classicConn = null, classicGame = null;
let classicReplay = null;
function initClassicUI() {
  $('classic-body').innerHTML = `
    <h2>Advanced: peer-to-peer (no account, no rating)</h2>
    <p class="muted">Pure WebRTC. Share your peer ID by hand. Useful if you'd rather not use the relay.</p>
    <div class="row">
      <label>Mode:
        <select id="cl-mode"><option value="1">Casual</option><option value="2">Crypto</option></select>
      </label>
    </div>
    <div class="row">
      <button id="cl-create">Create</button>
      <span class="sep">or</span>
      <input id="cl-joinid" type="text" placeholder="Paste peer ID">
      <button id="cl-join">Join</button>
    </div>
    <div id="cl-status" class="status"></div>
    <div id="cl-board-wrap" class="hidden">
      <div id="cl-board" class="board"></div>
      <button id="cl-resign">Resign</button>
      <div id="cl-transcript" class="transcript-panel"></div>
    </div>`;
  $('cl-create').onclick = classicCreate;
  $('cl-join').onclick   = classicJoin;
  $('cl-resign').onclick = async () => {
    if (!classicGame) return;
    if (classicReplay && !classicReplay.isLive()) return;
    const ok = await confirmModal({
      title: 'Resign this game?',
      body: 'Your peer will win. This can’t be undone.',
      confirmLabel: 'Resign',
      cancelLabel: 'Keep playing',
      danger: true,
    });
    if (!ok) return;
    try {
      classicReplay?.pushPending({ kind: 'resign' }, classicGame.myPlayerIndex());
      const out = classicGame.localResign();
      classicReplay?.observe(JSON.parse(classicGame.stateJson()));
      classicConn?.send(out);
    } catch (e) {
      classicReplay?.dropPending();
      toast(`Couldn't resign: ${e.message || e}`, { kind: 'error' });
    }
    classicRefresh();
  };
}

function classicSetup(mode, gameId, isHost) {
  classicGame = isHost
    ? Module.Game.createHost(mode, gameId)
    : Module.Game.createJoin(mode, gameId);
  classicReplay = new Replay();
}

function classicCreate() {
  const mode = parseInt($('cl-mode').value, 10);
  const gameId = crypto.randomUUID();
  if (classicPeer) try { classicPeer.destroy(); } catch (_) {}
  classicPeer = new Peer();
  classicPeer.on('open', (id) => {
    $('cl-status').innerHTML = `Your peer ID: <code>${id}</code> — share with friend.`;
  });
  classicPeer.on('connection', (c) => {
    classicConn = c;
    classicConn.on('open', () => {
      classicSetup(mode, gameId, true);
      classicConn.send(classicGame.start());
      $('cl-board-wrap').classList.remove('hidden');
      classicRefresh();
    });
    classicConn.on('data', (d) => {
      classicHandleInbound(String(d));
      classicRefresh();
    });
  });
}
function classicJoin() {
  const remote = $('cl-joinid').value.trim();
  if (!remote) return;
  const mode = parseInt($('cl-mode').value, 10);
  if (classicPeer) try { classicPeer.destroy(); } catch (_) {}
  classicPeer = new Peer();
  classicPeer.on('open', () => {
    classicConn = classicPeer.connect(remote, { reliable: true });
    classicConn.on('open', () => $('cl-status').textContent = 'connected, waiting for HELLO…');
    classicConn.on('data', (d) => {
      const text = String(d);
      if (!classicGame) {
        // First inbound is host's HELLO carrying game_id and mode.
        const parsed = parseJsonSafe(text);
        if (!parsed || parsed.type !== 'HELLO') return;
        const modeNum = parsed.mode === 'crypto' ? 2 : 1;
        classicSetup(modeNum, parsed.game_id, false);
        classicConn.send(classicGame.start());
        classicHandleInbound(text);
        $('cl-board-wrap').classList.remove('hidden');
        classicRefresh();
        return;
      }
      classicHandleInbound(text);
      classicRefresh();
    });
  });
}

function classicHandleInbound(line) {
  const parsed = parseJsonSafe(line);
  let pushed = false;
  if (parsed?.type === 'MOVE_ENTRY' && classicReplay) {
    const action = normalizeAction(parsed.payload);
    if (action) {
      classicReplay.pushPending(action, 1 - classicGame.myPlayerIndex());
      pushed = true;
    }
  }
  try {
    const out = classicGame.handleMessage(line);
    if (out) classicConn?.send(out);
    classicReplay?.observe(JSON.parse(classicGame.stateJson()));
  } catch (e) {
    if (pushed) classicReplay?.dropPending();
  }
}

function classicRefresh() {
  if (!classicGame) return;
  const liveState = JSON.parse(classicGame.stateJson());
  classicReplay?.observe(liveState);
  const stub = { game: classicGame, replay: classicReplay, selected: active?.selected };
  const view = viewState(stub, liveState);
  renderBoard($('cl-board'), view, (idx) => {
    if (view.replayViewing) return;
    classicCellClick(idx, view);
  });
  $('cl-resign').disabled = !liveState.setup_done || liveState.game_over || (classicReplay && !classicReplay.isLive());
  if (classicReplay) {
    renderTranscript($('cl-transcript'), classicReplay, {
      onJump: (step) => { classicReplay.goToStep(step); classicRefresh(); },
    });
  }
}
function classicCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.replayViewing) return;
  if (state.side_to_move !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;
  // Use the shared `active.selected` for selection state.
  active = active || { selected: null };
  const performLocal = (action) => {
    classicReplay?.pushPending(action, classicGame.myPlayerIndex());
    try {
      let out;
      if (action.kind === 'flip') out = classicGame.localFlip(action.to);
      else if (action.kind === 'move') out = classicGame.localMove(action.from, action.to);
      if (out) classicConn?.send(out);
      classicReplay?.observe(JSON.parse(classicGame.stateJson()));
    } catch (e) {
      classicReplay?.dropPending();
    }
  };
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      performLocal({ kind: 'flip', to: idx });
      classicRefresh();
      return;
    }
    if (c.state === 'faceup' && c.color === state.my_color &&
        legal.some(m => m.from === idx)) {
      active.selected = idx;
      classicRefresh();
    }
    return;
  }
  if (legal.some(m => m.from === active.selected && m.to === idx)) {
    const from = active.selected;
    active.selected = null;
    performLocal({ kind: 'move', from, to: idx });
    classicRefresh();
    return;
  }
  active.selected = null;
  classicRefresh();
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
//
// confirmModal({ title, body, confirmLabel, cancelLabel, danger }) → Promise<bool>
// Renders a focus-trapped modal at #modal-root. Esc and backdrop click resolve
// to false. Used for resign confirmation; reusable for any destructive action.
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
        // Trap focus between the two buttons.
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
    // Focus the destructive button's safe partner (Cancel) by default.
    (danger ? btnCancel : btnConfirm).focus();
  });
}

// ---- utils ----
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function parseJsonSafe(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ---- boot ----
//
// Default the crib sheet collapsed on small screens to free up vertical
// space; on desktop it stays open.
function initCribDefault() {
  const details = document.getElementById('crib-details');
  if (!details) return;
  const small = window.matchMedia('(max-width: 700px)');
  // Only set initial state — preserve user toggling on subsequent resizes.
  details.open = !small.matches;
}
initCribDefault();

await refreshSession();
route();
