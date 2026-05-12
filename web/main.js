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
    case '#/ai':          return openAIGame();
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
  $('btn-ai').onclick = () => { location.hash = '#/ai'; };
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
    bootstrapping: log.length > 0,
    selected: null,
    pendingFinalize: false,
    finalizeReported: false,
    transport: 'federated',
    replay: new Replay(),
  };

  // Bootstrap phase: feed log entries through the Game without sending any
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
        const action = normalizeAction(parsed.payload);
        if (!action) continue;
        try { applyLocalAction(active, action); }
        catch (e) { console.warn('bootstrap local action failed:', e); }
      }
      // Skip own HELLO/SETUP/REVEAL_KEY — they regenerate naturally.
    } else {
      try { applyPeerMessage(active, m.body); }
      catch (e) { console.warn('bootstrap handle failed:', e); }
    }
  }
  active.bootstrapping = false;

  // Open the live WebSocket.
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  active.conn = new RelayConnection(`${wsScheme}://${location.host}/ws/${info.id}`);
  attachConnAsTransport(active);

  // If the live message log just brought us into a finished game state,
  // attempt finalize.
  refreshGame();
}

function attachConnAsTransport(act) {
  const { conn } = act;
  conn.on('open', () => {
    // The game has already emitted HELLO during bootstrap/start; resending
    // it is harmless because the peer ignores duplicate HELLOs (game.cpp:59).
  });
  conn.on('data', (line) => {
    if (act.bootstrapping) return;  // shouldn't happen, but be safe
    try {
      const out = applyPeerMessage(act, line);
      if (act.conn && out) act.conn.send(out);
    } catch (e) { console.warn('handleMessage:', e); }
    refreshGame();
  });
  conn.on('close', () => {
    const el = $('game-status-line');
    if (el) el.textContent = 'disconnected';
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
  if (!act.replay || act.replay.isLive()) {
    return { ...liveState, replayViewing: false };
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
  $('otb-resign').onclick = () => {
    if (view.replayViewing) return;
    const liveTurn = JSON.parse(active.hostGame.stateJson()).side_to_move;
    try { applyOTBAction(active, { kind: 'resign' }, liveTurn); }
    catch (e) { console.warn(e); }
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
  $('ai-resign').onclick = () => {
    if (!active?.isAI) return;
    const state = JSON.parse(active.humanGame.stateJson());
    if (!state.setup_done || state.game_over) return;
    if (state.side_to_move !== state.my_player_index) return; // only resign on your turn
    if (!active.replay.isLive()) return; // resign disabled in replay view
    try { applyAIAction(active, 'human', { kind: 'resign' }); }
    catch (e) { console.warn(e); }
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
  $('ai-meta').textContent = `Difficulty: ${diffLabel}`;
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
function renderBoard(boardEl, state, onClick) {
  boardEl.innerHTML = '';
  boardEl.classList.toggle('replay-viewing', !!state.replayViewing);
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
  // Highlight the cells involved in the move being viewed (replay mode).
  const highlight = state.replayMoveCells || null;
  for (let i = 0; i < 32; ++i) {
    const c = state.cells[i];
    const div = document.createElement('div');
    div.className = 'cell ' + c.state;
    if (c.state === 'faceup') {
      div.classList.add(c.color === 1 ? 'red' : 'black');
      div.textContent = c.glyph;
    }
    if (!state.replayViewing && active?.selected === i) div.classList.add('selected');
    if (state.side_to_move === state.my_player_index && !state.game_over && !state.replayViewing) {
      if (active?.selected != null && moveTargetsBySrc.get(active.selected)?.has(i)) {
        div.classList.add('legal-target');
      } else if (active?.selected == null && (flipTargets.has(i) || moveTargetsBySrc.has(i))) {
        div.classList.add('legal');
      }
    }
    if (highlight && (i === highlight.from || i === highlight.to)) {
      div.classList.add('replay-highlight');
    }
    div.addEventListener('click', () => onClick(i));
    boardEl.appendChild(div);
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
  const replayBadge = view.replayViewing
    ? `<div class="replay-badge">Reviewing move ${active.replay.currentStep()}/${active.replay.totalMoves()}</div>`
    : '';
  $('game-header').innerHTML = `
    <div class="meta">
      ${replayBadge}
      <div><b>Room:</b> <code>${active.info.room_code}</code>
           <button id="btn-copy-link" class="link-btn">Copy invite link</button></div>
      <div><b>Opponent:</b> ${escapeHtml(opp || '(waiting…)')}</div>
      <div><b>You are:</b> ${active.isHost ? 'Host (Player 1)' : 'Joiner (Player 2)'}
        ${liveState.my_color === 1 ? '· Red' : liveState.my_color === 2 ? '· Black' : ''}</div>
      <div><b>Turn:</b> <span id="game-turn">${turnLabel(liveState)}</span></div>
      <div><b>Status:</b> <span id="game-status-line">${statusLabel(liveState, active.info)}</span></div>
      <div><b>Moves:</b> ${liveState.transcript_seq}</div>
      <button id="btn-resign" ${liveState.setup_done && !liveState.game_over && !view.replayViewing ? '' : 'disabled'}>Resign</button>
      <a class="link-btn" href="#/dashboard">My games</a>
    </div>`;
  $('btn-copy-link').onclick = copyInviteLink;
  $('btn-resign').onclick = () => {
    if (!active.replay.isLive()) return;
    try {
      const out = applyLocalAction(active, { kind: 'resign' });
      if (active.conn && out) active.conn.send(out);
    } catch (e) { console.warn(e); }
    refreshGame();
  };

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
  $('cl-resign').onclick = () => {
    if (!classicGame) return;
    if (classicReplay && !classicReplay.isLive()) return;
    try {
      classicReplay?.pushPending({ kind: 'resign' }, classicGame.myPlayerIndex());
      const out = classicGame.localResign();
      classicReplay?.observe(JSON.parse(classicGame.stateJson()));
      classicConn?.send(out);
    } catch (e) { classicReplay?.dropPending(); }
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
