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

const Module = await createBanqiModule();

const $ = (id) => document.getElementById(id);

// ---- view containers ----
const views = {
  lobby:       $('view-lobby'),
  game:        $('view-game'),
  otb:         $('view-otb'),
  dashboard:   $('view-dashboard'),
  leaderboard: $('view-leaderboard'),
  profile:     $('view-profile'),
  classic:     $('view-classic'),
};
function showView(name) {
  for (const v of Object.values(views)) v?.classList.add('hidden');
  views[name]?.classList.remove('hidden');
}

// ---- session ----
let me = null;            // current user from /api/me, or null
let providers = { github: false, google: false, dev: false };

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
  if (m) return openFederatedGame(m[1].toUpperCase());

  const mp = hash.match(/^#\/profile\/(\d+)$/);
  if (mp) return renderProfile(+mp[1]);

  switch (hash) {
    case '#/otb':         return openOTB();
    case '#/dashboard':   return renderDashboard();
    case '#/leaderboard': return renderLeaderboard();
    case '#/classic':     return renderClassicLobby();
    default:              return renderLobby();
  }
}
window.addEventListener('hashchange', route);

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
          · <a href="#/profile/${me.id}">profile</a>
        </div>
        <button id="btn-signout" class="link-btn">Sign out</button>
      </div>`;
    $('btn-signout').onclick = signOut;
  } else {
    const buttons = [];
    if (providers.github) buttons.push(`<a class="primary" href="/auth/github">Sign in with GitHub</a>`);
    if (providers.google) buttons.push(`<a class="primary" href="/auth/google">Sign in with Google</a>`);
    if (providers.dev) {
      buttons.push(`<button id="btn-dev-signin" class="primary">Sign in (dev)</button>`);
    }
    if (buttons.length === 0) {
      buttons.push(`<div class="muted">Sign-in is not configured. Ask the relay admin to set OAuth credentials, or play "on this device" below.</div>`);
    }
    meBox.innerHTML = `<div class="sign-in">${buttons.join(' ')}</div>`;
    const dev = $('btn-dev-signin');
    if (dev) dev.onclick = async () => {
      const name = prompt('Pick a display name:', 'Player') || 'Player';
      location.href = `/auth/dev?name=${encodeURIComponent(name)}`;
    };
  }
  $('btn-start-online').disabled = !me;
  $('btn-start-online').onclick = startOnlineGame;
  $('btn-otb').onclick = () => { location.hash = '#/otb'; };
  $('btn-classic').onclick = () => { location.hash = '#/classic'; };
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
  if (!res.ok) { alert('Could not create game.'); return; }
  const g = await res.json();
  location.hash = `#/g/${g.roomCode}`;
}

// ---- federated game ----
let active = null;  // {game, conn, replay, gameId, roomCode, role, ...}

async function openFederatedGame(roomCode) {
  showView('game');
  $('game-header').innerHTML = `<div class="muted">Connecting to room <code>${roomCode}</code>…</div>`;

  if (!me) {
    $('game-header').innerHTML = `
      <div>You need to be signed in to play online.
      <a href="#/">Back to lobby</a> to sign in.</div>`;
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

  // Pull the message log so we can replay if mid-game.
  const log = await fetch(`/api/games/${info.id}/messages?since=0`).then(r => r.json());

  // Construct the Game with our deterministic identity seed.
  const modeInt = info.mode === 'crypto' ? 2 : 1;
  const gameIdForCpp = String(info.id);  // any stable token works; both sides must use the same
  const game = isHost
    ? Module.Game.createHostWithSeed(modeInt, gameIdForCpp, me.identity_seed_hex)
    : Module.Game.createJoinWithSeed(modeInt, gameIdForCpp, me.identity_seed_hex);

  active = {
    info, game, isHost, conn: null,
    replay: log.length > 0,
    selected: null,
    pendingFinalize: false,
    finalizeReported: false,
    transport: 'federated',
  };

  // Replay phase: feed log entries through the Game without sending any
  // outbound (the server already has them). Own MOVE_ENTRYs need to be
  // re-driven through local_* so they get re-signed; others go via
  // handle_message. See test_game.cpp "reconnect-by-replay" for the same
  // shape.
  game.start();   // emit own HELLO (discarded — log already has the equivalent)
  for (const m of log) {
    const parsed = parseJsonSafe(m.body);
    if (!parsed) continue;
    if (m.sender_user_id === me.id) {
      if (parsed.type === 'MOVE_ENTRY') {
        const action = parseJsonSafe(parsed.payload);
        if (!action) continue;
        try {
          if (action.kind === 'flip')   game.localFlip(action.to);
          else if (action.kind === 'move') game.localMove(action.from, action.to);
          else if (action.kind === 'resign') game.localResign();
        } catch (e) { console.warn('replay local action failed:', e); }
      }
      // Skip own HELLO/SETUP/REVEAL_KEY — they regenerate naturally.
    } else {
      try { game.handleMessage(m.body); } catch (e) { console.warn('replay handle failed:', e); }
    }
  }
  active.replay = false;

  // Open the live WebSocket.
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  active.conn = new RelayConnection(`${wsScheme}://${location.host}/ws/${info.id}`);
  attachConnAsTransport(active);

  // If the live message log just brought us into a finished game state,
  // attempt finalize.
  refreshGame();
}

function attachConnAsTransport(act) {
  const { game, conn } = act;
  conn.on('open', () => {
    // The game has already emitted HELLO during replay/start; resending it
    // is harmless because the peer ignores duplicate HELLOs (game.cpp:59).
  });
  conn.on('data', (line) => {
    if (act.replay) return;  // shouldn't happen, but be safe
    try {
      const out = game.handleMessage(line);
      if (act.conn && out) act.conn.send(out);
    } catch (e) { console.warn('handleMessage:', e); }
    refreshGame();
  });
  conn.on('close', () => {
    $('game-status-line').textContent = 'disconnected';
  });
  conn.on('meta', (m) => {
    // Server tells us our role; we already know it from REST, but log for diagnostics.
    console.log('relay meta:', m);
  });
}

// ---- over-the-board ----
function openOTB() {
  showView('otb');
  // Two Games, two loopback transports wired peer-to-peer.
  //
  // Wiring: a.send(line) → fires b.on('data', line) and vice versa. So each
  // game *sends* on its OWN transport, and *receives* from its OWN
  // transport's 'data' event (which fires when the peer sends).
  const gameId = `otb-${Date.now()}`;
  const hostGame = Module.Game.createHost(1, gameId);   // 1 = casual
  const joinGame = Module.Game.createJoin(1, gameId);
  const [hostTr, joinTr] = LoopbackConnection.pair();

  hostTr.on('data', (line) => {
    try {
      const out = hostGame.handleMessage(line);
      if (out) hostTr.send(out);
    } catch (e) { console.warn('host otb:', e); }
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
  };
  refreshOTB();
}

function refreshOTB() {
  if (!active?.isOTB) return;
  // Determine which game is "active" — the one whose side_to_move == its own
  // player index. Both games have the same shared rules-engine state by
  // construction, so we can ask either.
  // Probe the host game just to get the global turn index.
  const turnIdx = JSON.parse(active.hostGame.stateJson()).side_to_move;
  const activeGame = turnIdx === 0 ? active.hostGame : active.joinGame;
  const state = JSON.parse(activeGame.stateJson());
  // state.my_player_index already equals turnIdx because activeGame is the
  // side whose turn it is. legal_moves_for_me and my_color are already
  // computed against the active side. No massaging needed.
  renderBoard($('otb-board'), state, (idx) => onOTBCellClick(idx, state));
  // Banner
  let banner;
  if (state.game_over) {
    const w = state.winner;
    banner = `Game over — winner: ${w === 1 ? 'Red' : w === 2 ? 'Black' : '—'}`;
  } else if (!state.first_flip_done) {
    banner = `Player 1 — flip a piece (your color is decided by your first flip)`;
  } else {
    const sideName = turnIdx === 0 ? 'Player 1' : 'Player 2';
    banner = `${sideName}'s turn (${colorWord(state.my_color)})`;
  }
  $('otb-banner').textContent = banner;
  $('otb-resign').disabled = !state.setup_done || state.game_over;
  $('otb-resign').onclick = () => {
    try {
      const sender = turnIdx === 0 ? active.hostTr : active.joinTr;
      const out = (turnIdx === 0 ? active.hostGame : active.joinGame).localResign();
      sender.send(out);
    } catch (e) { console.warn(e); }
    refreshOTB();
  };
}
function colorWord(c) { return c === 1 ? 'Red' : c === 2 ? 'Black' : ''; }

function onOTBCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  const turnIdx = state.side_to_move;
  const sender = turnIdx === 0 ? active.hostTr : active.joinTr;
  const game   = turnIdx === 0 ? active.hostGame : active.joinGame;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { sender.send(game.localFlip(idx)); } catch (e) { console.warn(e); }
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
    try { sender.send(game.localMove(from, idx)); } catch (e) { console.warn(e); }
    refreshOTB();
    return;
  }
  if (idx === active.selected) { active.selected = null; refreshOTB(); return; }
  active.selected = null;
  refreshOTB();
}

// ---- shared rendering ----
function renderBoard(boardEl, state, onClick) {
  boardEl.innerHTML = '';
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
  for (let i = 0; i < 32; ++i) {
    const c = state.cells[i];
    const div = document.createElement('div');
    div.className = 'cell ' + c.state;
    if (c.state === 'faceup') {
      div.classList.add(c.color === 1 ? 'red' : 'black');
      div.textContent = c.glyph;
    }
    if (active?.selected === i) div.classList.add('selected');
    if (state.side_to_move === state.my_player_index && !state.game_over) {
      if (active?.selected != null && moveTargetsBySrc.get(active.selected)?.has(i)) {
        div.classList.add('legal-target');
      } else if (active?.selected == null && (flipTargets.has(i) || moveTargetsBySrc.has(i))) {
        div.classList.add('legal');
      }
    }
    div.addEventListener('click', () => onClick(i));
    boardEl.appendChild(div);
  }
}

// ---- federated game rendering ----
function refreshGame() {
  if (!active || active.isOTB) return;
  const state = JSON.parse(active.game.stateJson());
  renderBoard($('game-board'), state, (idx) => onFedCellClick(idx, state));
  const opp = active.isHost ? active.info.join_name : active.info.host_name;
  $('game-header').innerHTML = `
    <div class="meta">
      <div><b>Room:</b> <code>${active.info.room_code}</code>
           <button id="btn-copy-link" class="link-btn">Copy invite link</button></div>
      <div><b>Opponent:</b> ${escapeHtml(opp || '(waiting…)')}</div>
      <div><b>You are:</b> ${active.isHost ? 'Host (Player 1)' : 'Joiner (Player 2)'}
        ${state.my_color === 1 ? '· Red' : state.my_color === 2 ? '· Black' : ''}</div>
      <div><b>Turn:</b> <span id="game-turn">${turnLabel(state)}</span></div>
      <div><b>Status:</b> <span id="game-status-line">${statusLabel(state, active.info)}</span></div>
      <div><b>Moves:</b> ${state.transcript_seq}</div>
      <button id="btn-resign" ${state.setup_done && !state.game_over ? '' : 'disabled'}>Resign</button>
      <a class="link-btn" href="#/dashboard">My games</a>
    </div>`;
  $('btn-copy-link').onclick = copyInviteLink;
  $('btn-resign').onclick = () => {
    try {
      const out = active.game.localResign();
      if (active.conn) active.conn.send(out);
    } catch (e) { console.warn(e); }
    refreshGame();
  };

  // If the game just ended, report finalize once.
  if (state.game_over && !active.finalizeReported) {
    active.finalizeReported = true;
    const myColor = state.my_color;
    const iWon = state.winner !== 0 && state.winner === myColor;
    fetch(`/api/games/${active.info.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        winner_color: state.winner,
        tip_hash: state.tip_hash || '',
        i_won: iWon,
      }),
    }).catch(() => {});
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
  if (info.status === 'waiting') return 'waiting for opponent to join';
  if (!state.setup_done) return 'shuffling…';
  return 'playing';
}

function onFedCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.side_to_move !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me || [];
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try {
        const out = active.game.localFlip(idx);
        if (active.conn) active.conn.send(out);
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
      const out = active.game.localMove(from, idx);
      if (active.conn) active.conn.send(out);
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
  try {
    await navigator.clipboard.writeText(url);
    flashCopied();
  } catch (_) {
    prompt('Share this link:', url);
  }
}
function flashCopied() {
  const btn = $('btn-copy-link');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ---- dashboard ----
async function renderDashboard() {
  showView('dashboard');
  const list = $('dashboard-list');
  if (!me) { list.innerHTML = `<div>Sign in first. <a href="#/">Lobby</a></div>`; return; }
  const games = await fetch('/api/games').then(r => r.json()).catch(() => []);
  if (!games.length) {
    list.innerHTML = `<div class="muted">No games yet.
      <a href="#/">Start one</a>.</div>`;
    return;
  }
  list.innerHTML = games.map(g => {
    const opp = g.host_user_id === me.id ? (g.join_name || '(waiting)')
                                          : (g.host_name || '(empty)');
    const ts = new Date(g.last_move_at || g.created_at).toLocaleString();
    const tag = g.status === 'complete'  ? 'complete'
              : g.status === 'disputed'  ? 'disputed'
              : g.status === 'waiting'   ? 'awaiting opponent'
              : 'in progress';
    return `<a class="game-row" href="#/g/${g.room_code}">
              <div class="g-opp">vs ${escapeHtml(opp)}</div>
              <div class="g-status">${tag}</div>
              <div class="g-meta muted">${ts} · room ${g.room_code}</div>
            </a>`;
  }).join('');
}

// ---- leaderboard ----
async function renderLeaderboard() {
  showView('leaderboard');
  const data = await fetch('/api/leaderboard').then(r => r.json()).catch(() => []);
  if (!data.length) {
    $('leaderboard-table').innerHTML = `<div class="muted">No rated games yet.</div>`;
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
  const p = await fetch(`/api/users/${userId}`).then(r => r.json()).catch(() => null);
  if (!p) { $('profile-body').innerHTML = `<div>Not found.</div>`; return; }
  const h2h = p.head_to_head || [];
  $('profile-body').innerHTML = `
    <h2>${escapeHtml(p.display_name)}</h2>
    <div><b>Elo:</b> ${p.elo}</div>
    <h3>Head-to-head</h3>
    ${h2h.length === 0 ? `<div class="muted">No games played yet.</div>` :
      `<table><thead><tr><th>Opponent</th><th>W</th><th>L</th><th>D</th></tr></thead>
       <tbody>${h2h.map(r => `
         <tr><td><a href="#/profile/${r.opponent_id}">${escapeHtml(r.opponent_name || '')}</a></td>
             <td>${r.wins}</td><td>${r.losses}</td><td>${r.draws}</td></tr>`).join('')}
       </tbody></table>`}`;
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
    </div>`;
  $('cl-create').onclick = classicCreate;
  $('cl-join').onclick   = classicJoin;
  $('cl-resign').onclick = () => {
    if (!classicGame) return;
    try { classicConn?.send(classicGame.localResign()); } catch (e) {}
    classicRefresh();
  };
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
      classicGame = Module.Game.createHost(mode, gameId);
      classicConn.send(classicGame.start());
      $('cl-board-wrap').classList.remove('hidden');
      classicRefresh();
    });
    classicConn.on('data', (d) => {
      try { classicConn.send(classicGame.handleMessage(String(d))); } catch (e) {}
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
        classicGame = Module.Game.createJoin(modeNum, parsed.game_id);
        classicConn.send(classicGame.start());
        classicConn.send(classicGame.handleMessage(text));
        $('cl-board-wrap').classList.remove('hidden');
        classicRefresh();
        return;
      }
      try { classicConn.send(classicGame.handleMessage(text)); } catch (e) {}
      classicRefresh();
    });
  });
}
let classicSelected = null;
function classicRefresh() {
  if (!classicGame) return;
  const state = JSON.parse(classicGame.stateJson());
  renderBoard($('cl-board'), state, (idx) => classicCellClick(idx, state));
}
function classicCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.side_to_move !== state.my_player_index) return;
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;
  // Use the shared `active.selected` for selection state.
  active = active || { selected: null };
  if (active.selected == null) {
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { classicConn.send(classicGame.localFlip(idx)); } catch (e) {}
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
    try { classicConn.send(classicGame.localMove(from, idx)); } catch (e) {}
    classicRefresh();
    return;
  }
  active.selected = null;
  classicRefresh();
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
await refreshSession();
route();
