// Web entry point: PeerJS for signaling, embind module for game logic.
import createBanqiModule from './banqi.js';

const Module = await createBanqiModule();

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
  // Also forward to the dev console so headless tests / browser devtools can
  // see the message stream without expanding the <details>.
  try { console.log('[banqi]', msg); } catch (_) {}
};
const setStatus = (html) => { $('lobby-status').innerHTML = html; };

// Big top-of-page error banner. Use for serious problems the user must act on.
function showBanner(html) {
  const b = $('conn-banner');
  b.innerHTML = html;
  b.classList.remove('hidden');
}
function hideBanner() {
  $('conn-banner').classList.add('hidden');
}

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

// TURN configuration: prefer the in-page form (#turn-url etc.), fall back to
// URL params (?turn=...&user=...&pass=...).  Either source lets the user point
// the WebRTC stack at a TURN relay so two peers behind the same NAT can
// connect.
//
// Other URL params:
//   ?peerHost=...&peerPort=...&peerPath=...&peerSecure=0|1
//      Custom PeerJS signalling broker (used by the E2E test).
function readTurnConfig() {
  const params = new URLSearchParams(location.search);
  const url  = ($('turn-url')?.value  || '').trim() || params.get('turn')  || '';
  const user = ($('turn-user')?.value || '').trim() || params.get('user')  || '';
  const pass = ($('turn-pass')?.value || '').trim() || params.get('pass')  || '';
  if (!url) return null;
  return { urls: url, username: user, credential: pass };
}

let lastTurnUsed = null;   // exposed in error messages so the user can see what was tried

function makePeerOptions() {
  const params = new URLSearchParams(location.search);
  const opts = {};
  const turn = readTurnConfig();
  lastTurnUsed = turn;
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (turn) iceServers.push(turn);
  opts.config = { iceServers };
  const peerHost = params.get('peerHost');
  if (peerHost) {
    opts.host = peerHost;
    if (params.has('peerPort')) opts.port = parseInt(params.get('peerPort'), 10);
    if (params.has('peerPath')) opts.path = params.get('peerPath');
    if (params.has('peerSecure')) opts.secure = params.get('peerSecure') === '1';
  }
  return opts;
}

function teardownPeer() {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
}

function startWatchdog(label) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    showConnectionFailure(label + ' did not complete within 20 s.');
  }, 20000);
}

// Render a clear, action-oriented failure banner. Always reachable, regardless
// of which lobby step the failure came from.
function showConnectionFailure(reason) {
  const used = lastTurnUsed
    ? `TURN attempted: <code>${lastTurnUsed.urls}</code> (auth ${lastTurnUsed.username ? 'set' : 'absent'})`
    : 'No TURN server configured — only STUN was tried.';
  showBanner(`
    <h3>WebRTC could not establish a peer-to-peer link</h3>
    <div>${reason}</div>
    <div style="margin-top:6px">
      The most common cause is <b>both peers behind the same router</b> with
      no NAT hairpinning. Either move one peer to a different network
      (cellular works), or supply a TURN relay.
    </div>
    <div style="margin-top:6px">${used}</div>
    <div style="margin-top:6px">Open <em>Advanced: TURN server</em> below
      and paste credentials, then click Create / Join again. Free credentials
      are available at
      <a href="https://www.metered.ca/tools/openrelay/" target="_blank" rel="noopener">metered.ca</a>.
    </div>`);
  setStatus('connection failed — see banner above');
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

// Single conn.on('data') handler. Registered exactly once per conn, before any
// 'open' handlers, so a message arriving early is never lost.
//
// On the host side: the game is constructed locally before any inbound data
// can arrive (the host owns gameId + mode), so this handler always sees `game`
// already defined.
//
// On the joiner side: the very first inbound message is the host's HELLO,
// which carries `game_id` and `mode`. The joiner uses those to construct its
// Game synchronously, then re-dispatches the same HELLO into game.handleMessage
// so the protocol's HELLO-handler runs normally. (We used to send a separate
// "_lobby" announcement before HELLO, but PeerJS occasionally drops the first
// send right after `open` — so we made HELLO self-bootstrapping instead.)
function attachDataHandler(isHost) {
  conn.on('data', (data) => {
    const s = String(data);
    log('← ' + s.slice(0, 120));
    if (!game) {
      // Joiner: first inbound must be HELLO. Use it to construct the game.
      let parsed;
      try { parsed = JSON.parse(s); } catch (_) { parsed = null; }
      if (!parsed || parsed.type !== 'HELLO' ||
          typeof parsed.game_id !== 'string' ||
          (parsed.mode !== 'casual' && parsed.mode !== 'crypto')) {
        setStatus('Expected HELLO from host first; got something else.');
        log('!! pre-HELLO data, ignored: ' + s.slice(0, 120));
        return;
      }
      const modeNum = parsed.mode === 'crypto' ? 2 : 1;
      $('mode-select').value = String(modeNum);
      onConnOpen(false, parsed.game_id);
      // Re-dispatch HELLO into the freshly-constructed game.
      try {
        const out = game.handleMessage(s);
        sendOutbound(out);
      } catch (e) {
        log('!! HELLO handle: ' + (e.message || e));
      }
      refresh();
      return;
    }
    try {
      const out = game.handleMessage(s);
      sendOutbound(out);
    } catch (e) {
      log('!! ' + (e.message || e));
    }
    refresh();
  });
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

  // Send our HELLO immediately.
  const out = game.start();
  sendOutbound(out);
  refresh();
}

function setupCreate() {
  teardownPeer();
  hideBanner();
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
    attachDataHandler(true);
    conn.on('open', () => {
      // game.start() emits HELLO which carries gameId + mode, so the joiner
      // can construct its Game from HELLO directly. No separate lobby send.
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
  hideBanner();
  setStatus('connecting to <code>' + remoteId.slice(0, 8) + '…</code>');
  peer = new Peer(makePeerOptions());
  startWatchdog('Connecting to ' + remoteId.slice(0, 8));
  peer.on('open', () => {
    conn = peer.connect(remoteId, { reliable: true });
    attachConnDiagnostics(conn);
    // Register the data handler BEFORE 'open' so a lobby message that arrives
    // early (PeerJS data event firing the same tick as open) is never dropped.
    attachDataHandler(false);
    conn.on('open', () => {
      setStatus('connected, awaiting lobby announcement…');
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
        showConnectionFailure('ICE state reached <b>failed</b> — no path between the two peers.');
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
