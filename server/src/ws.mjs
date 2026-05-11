// WebSocket relay for live game traffic.
//
// Wire protocol:
//   - Client connects to /ws/<gameId>, with the session cookie.
//   - Server authenticates via the same Passport session.
//   - Each frame the client sends is one newline-delimited JSON line, exactly
//     what the C++ Game emits as `out` lines.
//   - Server appends every frame to the messages table (so reconnecting
//     clients can replay), then broadcasts it to the other player in the
//     same game.
//
// Server does NOT validate game logic — clients run authoritative state.
// Server is a persistent, authenticated dumb-pipe.

import { WebSocketServer } from 'ws';
import { findGameById, appendMessage } from './db.mjs';

export function attachWebSocket(server, { db, sessionParser, passport }) {
  const wss = new WebSocketServer({ noServer: true });

  // game id → Set of { ws, userId }
  const rooms = new Map();

  function broadcast(gameId, fromUserId, payload) {
    const peers = rooms.get(gameId);
    if (!peers) return;
    for (const peer of peers) {
      if (peer.userId === fromUserId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) {
        peer.ws.send(payload);
      }
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/ws\/(\d+)$/);
    if (!m) { socket.destroy(); return; }
    const gameId = +m[1];

    // Run express-session + passport against the upgrade request to recover
    // req.user. The same middleware chain the HTTP server uses.
    sessionParser(req, {}, () => {
      passport.initialize()(req, {}, () => {
        passport.session()(req, {}, () => {
          if (!req.user) { socket.destroy(); return; }
          const game = findGameById(db, gameId);
          if (!game) { socket.destroy(); return; }
          if (game.host_user_id !== req.user.id && game.join_user_id !== req.user.id) {
            socket.destroy(); return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, game);
          });
        });
      });
    });
  });

  wss.on('connection', (ws, req, game) => {
    const userId = req.user.id;
    const entry = { ws, userId };
    let peers = rooms.get(game.id);
    if (!peers) { peers = new Set(); rooms.set(game.id, peers); }
    peers.add(entry);

    ws.send(JSON.stringify({ type: '_meta', kind: 'hello',
                             role: game.host_user_id === userId ? 'host' : 'join' }));

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      // Each WS message may contain one or more newline-delimited JSON lines
      // (mirroring the C++ output format).
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          appendMessage(db, {
            gameId: game.id, senderUserId: userId, body: line,
          });
        } catch (e) {
          ws.send(JSON.stringify({ type: '_meta', kind: 'error', error: String(e.message || e) }));
          continue;
        }
        broadcast(game.id, userId, line);
      }
    });

    ws.on('close', () => {
      const set = rooms.get(game.id);
      if (set) {
        set.delete(entry);
        if (set.size === 0) rooms.delete(game.id);
      }
    });
  });

  // Heartbeat: drop dead connections every 30 s.
  setInterval(() => {
    for (const set of rooms.values()) {
      for (const e of set) {
        try { e.ws.ping(); } catch (_) {}
      }
    }
  }, 30_000).unref();
}
