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

export function attachWebSocket(server, { db, sessionParser, passport, engine }) {
  const wss = new WebSocketServer({ noServer: true });

  // gameId → Set of { ws, userId, playerIndex }
  const rooms = new Map();

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

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/ws\/(\d+)$/);
    if (!m) { socket.destroy(); return; }
    const gameId = +m[1];

    sessionParser(req, {}, () => {
      passport.initialize()(req, {}, () => {
        passport.session()(req, {}, async () => {
          if (!req.user) { socket.destroy(); return; }
          const session = await engine.getSession(gameId);
          if (!session) { socket.destroy(); return; }
          const pi = session.playerIndexFor(req.user.id);
          if (pi < 0) { socket.destroy(); return; }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, session, pi);
          });
        });
      });
    });
  });

  wss.on('connection', (ws, req, session, playerIndex) => {
    const userId = req.user.id;
    const entry = { ws, userId, playerIndex };
    let peers = rooms.get(session.gameId);
    if (!peers) { peers = new Set(); rooms.set(session.gameId, peers); }
    peers.add(entry);

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
        pushTo(entry, { type: 'reject', reason: result.reason });
        return;
      }
      await broadcastEvent(session.gameId, result.event, session);
      if (result.endedNow) {
        const isDraw = result.event.action?.kind === 'accept_draw';
        const lossReason = result.event.action?.kind === 'timeout' ? 'timeout' : null;
        try { await applyEloOnEnd(session, session.gameId, result.event.winner, isDraw, lossReason); }
        catch (e) { console.error('elo update failed:', e); }
      }
    });

    ws.on('close', () => {
      const set = rooms.get(session.gameId);
      if (set) {
        set.delete(entry);
        if (set.size === 0) rooms.delete(session.gameId);
      }
    });
  });

  // Heartbeat: drop dead connections every 30s.
  setInterval(() => {
    for (const set of rooms.values()) {
      for (const e of set) {
        try { e.ws.ping(); } catch (_) {}
      }
    }
  }, 30_000).unref();

  // Exposed so HTTP routes that synthesize terminal events outside the WS
  // path (e.g. POST /api/games/:id/claim-timeout) can broadcast + finalize
  // through the same channel as in-game intents.
  return { broadcastEvent, applyEloOnEnd };
}
