// WebSocket gateway for live game traffic.
//
// Wire protocol (JSON frames, one per WS message):
//   server → client:
//     {type:'snapshot', role, state, events}   — sent on connect / resume
//     {type:'event',    event, state}          — sent on each accepted intent
//     {type:'reject',   reason}                — sent only to the originator
//   client → server:
//     {type:'intent', kind:'flip', cell}
//     {type:'intent', kind:'move', from, to}
//     {type:'intent', kind:'resign'}
//
// Server is authoritative: every intent is dispatched through the engine,
// which validates against the rule engine. The client never runs the rule
// engine for online games — it only renders.

import { WebSocketServer } from 'ws';
import {
  recordEloChange, setGameWinnerUser, getUser, findGameById,
} from './db.mjs';
import { eloDelta } from './elo.mjs';
import { sendToUser as sendPushToUser } from './push.mjs';

// Whitelist of reject reasons we're willing to surface verbatim to the client.
// Anything else thrown by the engine / wasm layer gets logged server-side and
// the client only sees a generic 'rejected', so we don't leak internal error
// strings like Emscripten's "Aborted(...)" or stack-trace fragments.
const SAFE_REJECT_REASONS = new Set([
  'malformed JSON',
  'unknown frame type',
  'unknown intent kind',
  'illegal move',
  'not your turn',
  'game is over',
  'bad coords',
  'bad cell',
  'no draw offer to accept',
]);

function safeRejectReason(reason) {
  if (typeof reason === 'string' && SAFE_REJECT_REASONS.has(reason)) return reason;
  console.error('ws: suppressed reject reason:', reason);
  return 'rejected';
}

export function attachWebSocket(server, { db, sessionParser, passport, engine,
                                          publicUrl, env = process.env }) {
  // 4 KiB is well above the largest intent frame we send (a couple hundred
  // bytes for a move with offer_draw) but small enough to make memory abuse
  // via giant frames a non-starter. `ws` enforces this and closes oversize
  // frames with close code 1009.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  // gameId → Set of { ws, userId, playerIndex }
  const rooms = new Map();

  // userId → live socket count, so we can cap simultaneous connections per
  // user across rooms. Defaults to 4 (host + spectator + mobile + dev tab is
  // already a stretch); override via WS_MAX_PER_USER for ops scenarios.
  const MAX_PER_USER = Math.max(1, parseInt(env.WS_MAX_PER_USER || '4', 10) || 4);
  const perUserCount = new Map();
  function incUser(userId) {
    perUserCount.set(userId, (perUserCount.get(userId) || 0) + 1);
  }
  function decUser(userId) {
    const n = (perUserCount.get(userId) || 0) - 1;
    if (n <= 0) perUserCount.delete(userId);
    else perUserCount.set(userId, n);
  }

  // Parse the allowed origin set once. PUBLIC_URL alone is the common case;
  // WS_EXTRA_ORIGINS is an opt-in comma list for staging / preview hosts.
  const allowedOrigins = new Set();
  if (publicUrl) {
    try { allowedOrigins.add(new URL(publicUrl).origin); } catch (_) {}
  }
  if (env.WS_EXTRA_ORIGINS) {
    for (const raw of String(env.WS_EXTRA_ORIGINS).split(',')) {
      const s = raw.trim();
      if (!s) continue;
      try { allowedOrigins.add(new URL(s).origin); } catch (_) {}
    }
  }
  function originAllowed(origin) {
    // Missing Origin is allowed: non-browser clients (including the Node `ws`
    // client our tests use) don't send one by default. Browsers always do,
    // so a present-but-wrong Origin is the attack we actually care about.
    if (!origin) return true;
    try { return allowedOrigins.has(new URL(origin).origin); }
    catch (_) { return false; }
  }

  function viewerStateForUser(session, userId) {
    return engine.viewerStateForUser(session, userId);
  }

  function pushTo(peer, frame) {
    if (peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(JSON.stringify(frame));
    }
  }

  async function broadcastEvent(gameId, event, session) {
    const peers = rooms.get(gameId);
    if (peers) {
      for (const peer of peers) {
        pushTo(peer, {
          type:  'event',
          event,
          state: viewerStateForUser(session, peer.userId),
        });
      }
    }
    // Fire a Web Push to the player whose turn it is now, but only if they
    // don't already have an open WebSocket in the room (otherwise their tab
    // can handle the in-page Notification API). Skip on game-over and skip
    // for guest accounts (excluded from push subscriptions).
    try { await maybePushTurnNotification(gameId, event, session, peers); }
    catch (e) { console.warn('push: turn-notify failed:', e.message || e); }
  }

  async function maybePushTurnNotification(gameId, event, session, peers) {
    if (event.game_over) return;
    const state = engine.viewerState(session, -1);
    const nextPi = state.side_to_move;
    if (nextPi !== 0 && nextPi !== 1) return;
    const nextUserId = nextPi === 0 ? session.hostUserId : session.joinUserId;
    if (!nextUserId) return;
    if (peers && [...peers].some((p) => p.userId === nextUserId)) return;
    const recipient = await getUser(db, nextUserId);
    if (!recipient || recipient.provider === 'guest') return;
    const game = await findGameById(db, gameId);
    if (!game) return;
    const mover = nextPi === 0
      ? await getUser(db, session.joinUserId)
      : await getUser(db, session.hostUserId);
    const oppName = mover?.display_name || 'Your opponent';
    await sendPushToUser(db, nextUserId, {
      kind:      'turn',
      title:     'Your turn in Banqi',
      body:      `${oppName} played a move — tap to play.`,
      roomCode:  game.room_code,
      gameId:    game.id,
    });
  }

  async function applyEloOnEnd(session, gameId, winnerColor, isDraw, lossReason = null) {
    // Pre-flip resign — no Elo applied.
    if (!isDraw && winnerColor !== 1 && winnerColor !== 2) return;
    // Skip Elo if either side is a guest account (ephemeral, unrated).
    const [host, join] = await Promise.all([
      getUser(db, session.hostUserId),
      session.joinUserId ? getUser(db, session.joinUserId) : null,
    ]);
    if (!host || !join) return;
    if (host.provider === 'guest' || join.provider === 'guest') {
      if (!isDraw) {
        // Still record winner_user_id for game history, just no rating change.
        const state = engine.viewerState(session, -1);
        const winnerPlayerIndex =
          state.player0_color === winnerColor ? 0 :
          state.player1_color === winnerColor ? 1 : -1;
        if (winnerPlayerIndex >= 0) {
          const winnerUserId = winnerPlayerIndex === 0 ? session.hostUserId : session.joinUserId;
          await setGameWinnerUser(db, gameId, winnerUserId);
        }
      }
      return;
    }
    if (isDraw) {
      const dH = eloDelta(host.elo, join.elo, 0.5);
      const dJ = eloDelta(join.elo, host.elo, 0.5);
      await Promise.all([
        recordEloChange(db, {
          userId: host.id, gameId, opponentId: join.id,
          eloBefore: host.elo, eloAfter: host.elo + dH, result: 'draw',
        }),
        recordEloChange(db, {
          userId: join.id, gameId, opponentId: host.id,
          eloBefore: join.elo, eloAfter: join.elo + dJ, result: 'draw',
        }),
      ]);
      return;
    }
    const state = engine.viewerState(session, -1);
    const winnerPlayerIndex =
      state.player0_color === winnerColor ? 0 :
      state.player1_color === winnerColor ? 1 : -1;
    if (winnerPlayerIndex < 0) return;
    const winnerUserId = winnerPlayerIndex === 0 ? session.hostUserId : session.joinUserId;
    await setGameWinnerUser(db, gameId, winnerUserId);
    const winner = winnerUserId === host.id ? host : join;
    const loser  = winnerUserId === host.id ? join : host;
    const dW = eloDelta(winner.elo, loser.elo, 1);
    const dL = eloDelta(loser.elo,  winner.elo, 0);
    await Promise.all([
      recordEloChange(db, {
        userId: winner.id, gameId, opponentId: loser.id,
        eloBefore: winner.elo, eloAfter: winner.elo + dW, result: 'win',
      }),
      recordEloChange(db, {
        userId: loser.id, gameId, opponentId: winner.id,
        eloBefore: loser.elo, eloAfter: loser.elo + dL, result: 'loss',
        lossReason,
      }),
    ]);
  }

  // Subscribe to engine events. The engine fires this for human-driven
  // intents (via applyIntent), server-initiated AI follow-up moves, and
  // out-of-band terminal events like claim-timeout, so all paths funnel
  // through the same broadcast + Elo logic.
  engine.onEvent(async ({ gameId, event, session, endedNow, isDraw }) => {
    await broadcastEvent(gameId, event, session);
    if (endedNow) {
      const lossReason = event.action?.kind === 'timeout' ? 'timeout' : null;
      try { await applyEloOnEnd(session, gameId, event.winner, isDraw, lossReason); }
      catch (e) { console.error('elo update failed:', e); }
    }
  });

  // The wss object itself can emit 'error' (e.g. handshake failures before a
  // connection makes it to 'connection'). Swallow + log to avoid unhandled
  // EventEmitter errors crashing the process.
  wss.on('error', (err) => {
    console.warn('ws: server error:', err?.message || err);
  });

  server.on('upgrade', (req, socket, head) => {
    // Raw upgrade sockets can error out (client disconnects mid-handshake).
    // Attach a no-op error handler so node doesn't surface this as an
    // unhandled exception.
    socket.on('error', (err) => {
      console.warn('ws: upgrade socket error:', err?.message || err);
    });
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/ws\/(\d+)$/);
    if (!m) { socket.destroy(); return; }
    const gameId = +m[1];

    // CSWSH defence: if the browser sent an Origin header that doesn't match
    // our public URL, refuse the upgrade. A missing Origin (non-browser
    // client) is allowed.
    if (!originAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    sessionParser(req, {}, () => {
      passport.initialize()(req, {}, () => {
        passport.session()(req, {}, async () => {
          // Wrap the async DB-lookup path so a thrown engine.getSession
          // (e.g. transient pg pool error) destroys the socket cleanly
          // instead of leaving the upgrade half-completed. Without the
          // try/catch the client sits in "connecting…" until its own
          // socket timeout fires — potentially minutes.
          try {
            if (!req.user) { socket.destroy(); return; }
            const session = await engine.getSession(gameId);
            if (!session) { socket.destroy(); return; }
            const pi = session.playerIndexFor(req.user.id);
            if (pi < 0) { socket.destroy(); return; }
            // Per-user cap. Counted at upgrade time and decremented on close,
            // so a 5th simultaneous tab from the same user is rejected with a
            // 429 until one of the live sockets closes.
            if ((perUserCount.get(req.user.id) || 0) >= MAX_PER_USER) {
              socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
              socket.destroy();
              return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
              wss.emit('connection', ws, req, session, pi);
            });
          } catch (e) {
            console.error('ws upgrade failed:', e);
            try { socket.destroy(); } catch (_) {}
          }
        });
      });
    });
  });

  wss.on('connection', (ws, req, session, playerIndex) => {
    const userId = req.user.id;
    const entry = { ws, userId, playerIndex };
    // isAlive drives the heartbeat reaper. Each interval tick: any peer
    // still at isAlive=false (didn't pong since the previous ping) gets
    // terminated, freeing the room slot. Without this the server treats
    // half-dead sockets — phones putting the tab to sleep, NAT rebinds,
    // VPN reconnects — as live peers forever and never broadcasts state
    // pushes through their dropped TCP connection.
    entry.isAlive = true;
    ws.on('pong', () => { entry.isAlive = true; });
    let peers = rooms.get(session.gameId);
    if (!peers) { peers = new Set(); rooms.set(session.gameId, peers); }
    peers.add(entry);
    incUser(userId);

    // Swallow per-socket errors. `ws` emits 'error' (RangeError for oversize
    // frames hitting maxPayload, ECONNRESET on abrupt client drops, etc.) and
    // an unhandled 'error' on an EventEmitter would crash the process. The
    // socket is being torn down anyway — 'close' will run the per-user
    // decrement — so we just log and move on.
    ws.on('error', (err) => {
      console.warn('ws: socket error:', err?.message || err);
    });

    // Initial snapshot.
    pushTo(entry, {
      type:   'snapshot',
      role:   playerIndex === 0 ? 'host' : 'join',
      state:  viewerStateForUser(session, userId),
      events: session.events,
    });

    ws.on('message', async (data) => {
      let frame;
      try { frame = JSON.parse(data.toString('utf8')); }
      catch (_) {
        pushTo(entry, { type: 'reject', reason: 'malformed JSON' });
        return;
      }
      if (frame?.type !== 'intent') {
        pushTo(entry, { type: 'reject', reason: 'unknown frame type' });
        return;
      }
      const result = await engine.applyIntent(session.gameId, userId, frame);
      if (!result.ok) {
        pushTo(entry, { type: 'reject', reason: safeRejectReason(result.reason) });
        return;
      }
      // Broadcast + Elo handled by the engine.onEvent subscriber above.
    });

    ws.on('close', () => {
      const set = rooms.get(session.gameId);
      if (set) {
        set.delete(entry);
        if (set.size === 0) rooms.delete(session.gameId);
      }
      decUser(userId);
    });
  });

  // Heartbeat: actively reap dead connections. Each tick, any peer that
  // didn't send a pong since the previous ping is terminated (.terminate
  // skips the close handshake and rips the TCP connection down immediately
  // so its 'close' handler runs synchronously and the room slot frees).
  // Surviving peers get a fresh ping and have until next tick to respond.
  //
  // Without the isAlive/pong/terminate cycle the previous heartbeat was a
  // no-op for stability: ws.ping() against a half-closed TCP socket
  // succeeds at the API level but the bytes never reach the peer, so we'd
  // happily fan out state pushes into the void and the room would fill
  // with phantom peers across a long-running game.
  //
  // .unref() is belt-and-braces so a forgotten close() doesn't keep the
  // process alive on its own.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  function runHeartbeat() {
    for (const set of rooms.values()) {
      for (const e of set) {
        if (e.isAlive === false) {
          try { e.ws.terminate(); } catch (_) {}
          // 'close' handler removes the entry from the room set; skip to
          // the next peer so we don't ping an already-terminated socket.
          continue;
        }
        e.isAlive = false;
        try { e.ws.ping(); } catch (_) {}
      }
    }
  }
  const heartbeat = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    rooms.clear();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  // `rooms` and `runHeartbeat` are exposed for the heartbeat reaper test —
  // they're not part of the public WS contract and shouldn't be relied on
  // from production code.
  return { wss, close, _rooms: rooms, _runHeartbeat: runHeartbeat };
}
