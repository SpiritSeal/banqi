// Web entry point: PeerJS for signaling, embind module for game logic.
import createBanqiModule from './banqi.js';

const Module = await createBanqiModule();

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
};
const setStatus = (html) => { $('lobby-status').innerHTML = html; };

let peer = null;          // PeerJS Peer
let conn = null;          // DataConnection
let game = null;          // GameWrapper from C++
let selected = null;      // currently-selected source cell index (move pending)
let watchdog = null;      // setTimeout handle for connection-establish timeout

function genGameId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

function modeInt() {
  return parseInt($('mode-select').value, 10);
}

// Optional TURN server via URL params, e.g.
//   ?turn=turn:turn.example.com:3478&user=foo&pass=bar
// If absent, PeerJS uses Google STUN only — fine for cross-NAT but cannot
// hairpin two peers behind the same router.
function makePeerOptions() {
  const params = new URLSearchParams(location.search);
  const turnUrl = params.get('turn');
  if (!turnUrl) return undefined;
  return {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: turnUrl,
          username:   params.get('user') || '',
          credential: params.get('pass') || '' },
      ],
    },
  };
}

function teardownPeer() {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
}

function startWatchdog(label) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    setStatus(
      label + ' is taking too long. The WebRTC peer-to-peer link could not be ' +
      'established. This usually happens when both peers are on the same ' +
      'router and it does not support NAT hairpinning. Try one peer on a ' +
      'different network (e.g. cellular), or pass a TURN server in the URL: ' +
      '<code>?turn=turn:host:port&amp;user=U&amp;pass=P</code>.'
    );
  }, 20000);
}

// ---------- network ----------
function sendOutbound(strs) {
  if (!strs) return;
  for (const line of strs.split('\n')) {
    if (!line) continue;
    if (conn && conn.open) {
      conn.send(line);
      log('→ ' + line.slice(0, 120));
    } else {
      log('!! dropped (not connected): ' + line.slice(0, 120));
      $('status-label').textContent = 'connection lost';
    }
  }
}

function onConnOpen(isHost, gameId) {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
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
  teardownPeer();
  const gameId = genGameId();
  setStatus('initializing peer…');
  peer = new Peer(makePeerOptions());
  peer.on('open', (id) => {
    setStatus(
      'Your peer ID: <code>' + id + '</code>' +
      '<br>Share this with your friend so they can join. Mode: ' +
      $('mode-select').selectedOptions[0].text +
      '<br>Game id: <code>' + gameId + '</code>' +
      '<br><small>Waiting for opponent…</small>'
    );
    startWatchdog('Waiting for an opponent to join');
  });
  peer.on('connection', (c) => {
    conn = c;
    setStatus('opponent connecting…');
    startWatchdog('Establishing the data channel');
    attachConnDiagnostics(conn);
    conn.on('open', () => {
      // Send the game_id and mode to the joiner so they can construct.
      conn.send(JSON.stringify({_lobby: true, gameId, mode: modeInt()}));
      onConnOpen(true, gameId);
    });
    conn.on('error', (e) => {
      setStatus('Data-channel error: ' + (e.message || e.type || e));
      log('conn error: ' + JSON.stringify(e.message || e.type || e));
    });
    conn.on('close', () => {
      log('conn closed');
    });
  });
  peer.on('error', (e) => {
    setStatus('Peer error: ' + (e.message || e.type || e));
    log('peer error: ' + JSON.stringify(e.message || e.type || e));
  });
  peer.on('disconnected', () => log('peer disconnected from broker'));
}

function setupJoin() {
  const remoteId = $('join-id').value.trim();
  if (!remoteId) { setStatus('Enter a peer ID first.'); return; }
  teardownPeer();
  setStatus('connecting to <code>' + remoteId.slice(0, 8) + '…</code>');
  peer = new Peer(makePeerOptions());
  startWatchdog('Connecting to ' + remoteId.slice(0, 8));
  peer.on('open', () => {
    conn = peer.connect(remoteId, { reliable: true });
    attachConnDiagnostics(conn);
    conn.on('open', () => {
      setStatus('connected, awaiting lobby announcement…');
      conn.once('data', (data) => {
        let lobby;
        try { lobby = JSON.parse(String(data)); } catch (e) { lobby = null; }
        if (!lobby || !lobby._lobby) {
          setStatus('Expected lobby announcement first; got something else.');
          return;
        }
        $('mode-select').value = String(lobby.mode);
        onConnOpen(false, lobby.gameId);
      });
    });
    conn.on('error', (e) => {
      setStatus('Data-channel error: ' + (e.message || e.type || e));
      log('conn error: ' + JSON.stringify(e.message || e.type || e));
    });
    conn.on('close', () => {
      log('conn closed');
      if (!game) setStatus('Connection closed before the game started.');
    });
  });
  peer.on('error', (e) => {
    setStatus('Peer error: ' + (e.message || e.type || e));
    log('peer error: ' + JSON.stringify(e.message || e.type || e));
  });
  peer.on('disconnected', () => log('peer disconnected from broker'));
}

// Attach an ICE-state observer so the user can see WebRTC progress.
function attachConnDiagnostics(c) {
  // PeerJS exposes the underlying RTCPeerConnection on `peerConnection`.
  const tryAttach = () => {
    const pc = c && c.peerConnection;
    if (!pc) return false;
    const onChange = () => {
      log('ice: ' + pc.iceConnectionState + ' / dtls: ' +
          (pc.connectionState || 'n/a'));
      if (pc.iceConnectionState === 'failed' ||
          pc.connectionState === 'failed') {
        setStatus(
          'WebRTC ICE failed — no usable network path between the two peers. ' +
          'Most common cause: both peers behind the same router with no NAT ' +
          'hairpinning. Try a different network, or supply a TURN server: ' +
          '<code>?turn=turn:host:port&amp;user=U&amp;pass=P</code>.'
        );
      }
    };
    pc.addEventListener('iceconnectionstatechange', onChange);
    pc.addEventListener('connectionstatechange', onChange);
    return true;
  };
  if (!tryAttach()) {
    // peerConnection isn't always set immediately; poll briefly.
    let n = 0;
    const t = setInterval(() => { if (tryAttach() || ++n > 40) clearInterval(t); }, 100);
  }
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
