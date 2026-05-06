// Web entry point: PeerJS for signaling, embind module for game logic.
import createBanqiModule from './banqi.js';

const Module = await createBanqiModule();

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
};

let peer = null;          // PeerJS Peer
let conn = null;          // DataConnection
let game = null;          // GameWrapper from C++
let selected = null;      // currently-selected source cell index (move pending)

function genGameId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

function modeInt() {
  return parseInt($('mode-select').value, 10);
}

// ---------- network ----------
function sendOutbound(strs) {
  if (!strs) return;
  for (const line of strs.split('\n')) {
    if (!line) continue;
    if (conn && conn.open) conn.send(line);
    log('→ ' + line.slice(0, 120));
  }
}

function onConnOpen(isHost, gameId) {
  $('lobby').classList.add('hidden');
  $('play').classList.remove('hidden');
  $('mode-label').textContent = $('mode-select').selectedOptions[0].text;

  game = isHost
    ? Module.Game.createHost(modeInt(), gameId)
    : Module.Game.createJoin(modeInt(), gameId);
  log('game created (' + (isHost ? 'host' : 'join') + ')');

  conn.on('data', (data) => {
    log('← ' + String(data).slice(0, 120));
    try {
      const out = game.handleMessage(String(data));
      sendOutbound(out);
    } catch (e) {
      log('!! ' + (e.message || e));
    }
    refresh();
  });

  // Send our HELLO immediately.
  const out = game.start();
  sendOutbound(out);
  refresh();
}

function setupCreate() {
  const gameId = genGameId();
  peer = new Peer();
  peer.on('open', (id) => {
    $('lobby-status').innerHTML =
      'Your peer ID: <code>' + id + '</code>' +
      '<br>Share this with your friend so they can join. Mode: ' +
      $('mode-select').selectedOptions[0].text +
      '<br>Game id: <code>' + gameId + '</code>';
  });
  peer.on('connection', (c) => {
    conn = c;
    conn.on('open', () => {
      // Send the game_id and mode to the joiner so they can construct.
      conn.send(JSON.stringify({_lobby: true, gameId, mode: modeInt()}));
      onConnOpen(true, gameId);
    });
  });
  peer.on('error', (e) => log('peer error: ' + e));
}

function setupJoin() {
  const remoteId = $('join-id').value.trim();
  if (!remoteId) { $('lobby-status').textContent = 'Enter a peer ID first.'; return; }
  peer = new Peer();
  peer.on('open', () => {
    conn = peer.connect(remoteId);
    conn.on('open', () => {
      // Wait for the host's lobby announcement (gameId + mode), then proceed.
      conn.once('data', (data) => {
        let lobby;
        try { lobby = JSON.parse(String(data)); } catch (e) { lobby = null; }
        if (!lobby || !lobby._lobby) {
          log('!! expected lobby announcement first'); return;
        }
        $('mode-select').value = String(lobby.mode);
        onConnOpen(false, lobby.gameId);
      });
    });
    conn.on('error', (e) => log('conn error: ' + e));
  });
  peer.on('error', (e) => log('peer error: ' + e));
}

// ---------- UI ----------
function renderBoard(state) {
  const board = $('board');
  board.innerHTML = '';

  // Build a quick set of legal target cells (for highlights).
  const legal = state.legal_moves_for_me;
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
    if (selected === i) div.classList.add('selected');
    if (state.side_to_move === state.my_player_index && !state.game_over) {
      if (selected != null && moveTargetsBySrc.get(selected)?.has(i)) {
        div.classList.add('legal-target');
      } else if (selected == null && (flipTargets.has(i) || moveTargetsBySrc.has(i))) {
        div.classList.add('legal');
      }
    }
    div.addEventListener('click', () => onCellClick(i, state));
    board.appendChild(div);
  }

  // Status header
  $('me-label').textContent =
    'P' + state.my_player_index + (state.my_color === 1 ? ' (Red)' : state.my_color === 2 ? ' (Black)' : '');
  $('turn-label').textContent =
    state.first_flip_done
      ? (state.side_to_move === state.my_player_index ? 'your turn' : 'waiting on opponent')
      : 'waiting on first flip';
  $('seq-label').textContent = state.transcript_seq;

  let s = '';
  if (!state.handshake_done) s = 'connecting…';
  else if (!state.setup_done) s = 'shuffling (' + state.mode + ')…';
  else if (state.game_over) {
    const w = state.winner;
    s = 'game over · winner: ' + (w === 1 ? 'Red' : w === 2 ? 'Black' : 'none');
  } else {
    s = 'playing';
  }
  $('status-label').textContent = s;

  $('btn-resign').disabled = !state.setup_done || state.game_over;
}

function onCellClick(idx, state) {
  if (!state.setup_done || state.game_over) return;
  if (state.side_to_move !== state.my_player_index) return;

  // Determine action.
  const c = state.cells[idx];
  const legal = state.legal_moves_for_me;

  if (selected == null) {
    // First click. If face-down, flip. If own face-up piece, select.
    if (c.state === 'facedown' && legal.some(m => m.from < 0 && m.to === idx)) {
      try { sendOutbound(game.localFlip(idx)); } catch (e) { log('!! ' + e); }
      refresh();
      return;
    }
    if (c.state === 'faceup' && c.color === state.my_color) {
      // Has any legal move from here?
      if (legal.some(m => m.from === idx)) {
        selected = idx;
        refresh();
      }
    }
    return;
  }

  // Second click: if it's a legal target, perform the move.
  if (legal.some(m => m.from === selected && m.to === idx)) {
    const from = selected;
    selected = null;
    try { sendOutbound(game.localMove(from, idx)); } catch (e) { log('!! ' + e); }
    refresh();
    return;
  }
  // Otherwise re-select or clear.
  if (idx === selected) { selected = null; refresh(); return; }
  if (c.state === 'faceup' && c.color === state.my_color &&
      legal.some(m => m.from === idx)) {
    selected = idx; refresh(); return;
  }
  selected = null;
  refresh();
}

function refresh() {
  if (!game) return;
  let state;
  try { state = JSON.parse(game.stateJson()); }
  catch (e) { log('!! state parse: ' + e); return; }
  renderBoard(state);
}

// ---------- buttons ----------
$('btn-create').addEventListener('click', setupCreate);
$('btn-join').addEventListener('click', setupJoin);
$('btn-resign').addEventListener('click', () => {
  if (!game) return;
  try { sendOutbound(game.localResign()); } catch (e) { log('!! ' + e); }
  refresh();
});
