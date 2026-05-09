// LAN relay for Banqi P2P.
//
// Run on one device on the LAN; both browsers then load
// http://<this-machine-LAN-ip>:<port>/ and the relay does two things:
//
//   1. Serves the static files from web/ (so the page is loaded from the
//      same http:// origin as the WebSocket — no mixed-content blocking).
//   2. Brokers exactly ONE pair of WebSocket connections on /banqi: the
//      first client to connect becomes the host, the second becomes the
//      joiner, and every text frame from one is forwarded verbatim to the
//      other. The relay sees only opaque bytes — in crypto mode the layout
//      remains hidden from it (mental-poker keys are end-to-end).
//
// CLI:    node infra/relay.mjs [--port N]
// Env:    PORT=N
// Default port: 3000.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

function parseArgs(argv) {
  const out = { port: parseInt(process.env.PORT || '3000', 10), host: '0.0.0.0' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) { out.port = parseInt(argv[++i], 10); }
    else if (argv[i] === '--host' && argv[i + 1]) { out.host = argv[++i]; }
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('usage: node infra/relay.mjs [--port N] [--host H]');
      process.exit(0);
    }
  }
  return out;
}

function pickLanIPv4() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let p = url.pathname;
  if (p === '/' || p === '') p = '/index.html';
  // Reject path traversal.
  const safe = normalize(p).replace(/^([/\\])+/, '/');
  if (safe.includes('..')) { res.statusCode = 400; res.end('bad path'); return; }
  // Auto-redirect bare GET / to /?relay=auto so the page enters LAN-relay
  // mode without the user having to remember the query string. Anything
  // already carrying ?relay= or other params is left alone.
  if (p === '/index.html' && url.pathname === '/' && url.searchParams.toString() === '') {
    res.statusCode = 302;
    res.setHeader('Location', '/?relay=auto');
    res.end();
    return;
  }
  const file = join(WEB_DIR, safe);
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

// Single-room state. The two clients are stored in `pair`; further connections
// get a one-shot error frame and are closed. On disconnect, the partner is
// dropped too so a new pair can form.
const room = { pair: [/* {ws, role} */] };

function broadcastClose(reason) {
  for (const m of room.pair) {
    try { m.ws.close(1000, reason); } catch (_) {}
  }
  room.pair = [];
}

function attachPair(wss, _server) {
  wss.on('connection', (ws, req) => {
    if (room.pair.length >= 2) {
      try { ws.send(JSON.stringify({ type: 'relay-error', reason: 'room full' })); } catch (_) {}
      ws.close(1008, 'room full');
      console.log(`[relay] rejected (room full) from ${req.socket.remoteAddress}`);
      return;
    }
    const role = room.pair.length === 0 ? 'host' : 'join';
    const member = { ws, role };
    room.pair.push(member);
    console.log(`[relay] connected ${role} from ${req.socket.remoteAddress} (${room.pair.length}/2)`);

    // Tell the client what role it has. The page uses this to call
    // createHost vs createJoin in the WASM module.
    try { ws.send(JSON.stringify({ type: 'relay-role', role })); } catch (_) {}

    // Once both members are present, tell BOTH "relay-paired" so the host
    // knows it's safe to emit HELLO (the relay doesn't buffer messages
    // sent before pairing — they would be silently dropped).
    if (room.pair.length === 2) {
      for (const m of room.pair) {
        try { m.ws.send(JSON.stringify({ type: 'relay-paired' })); } catch (_) {}
      }
      console.log('[relay] paired — forwarding active');
    }

    ws.on('message', (data, isBinary) => {
      const partner = room.pair.find(m => m !== member);
      if (!partner) return;        // partner not yet here / already gone
      try {
        partner.ws.send(data, { binary: isBinary });
      } catch (e) {
        console.log(`[relay] forward failed: ${e.message}`);
      }
    });

    const drop = (why) => {
      if (!room.pair.includes(member)) return;   // already dropped
      console.log(`[relay] ${role} disconnected: ${why}`);
      room.pair = room.pair.filter(m => m !== member);
      // Also close the partner so we don't strand them in a dead room.
      const partner = room.pair[0];
      if (partner) {
        try { partner.ws.send(JSON.stringify({ type: 'relay-partner-gone' })); } catch (_) {}
        try { partner.ws.close(1000, 'partner left'); } catch (_) {}
        room.pair = [];
      }
    };
    ws.on('close', (code, reason) => drop(`close ${code} ${reason || ''}`));
    ws.on('error', (e) => drop(`error ${e.message}`));
  });
}

// Programmatic start for tests / embedding. Returns an object with `port`,
// `server`, `wss`, and a `close()` that shuts both down cleanly. Resets the
// in-module room state so successive starts don't see stale members.
export async function startRelay({ port = 0, host = '127.0.0.1', verbose = true } = {}) {
  room.pair = [];
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/banqi' });
  attachPair(wss, server);
  await new Promise((res) => server.listen(port, host, res));
  const addr = server.address();
  if (verbose) console.log(`[relay] listening on ${host}:${addr.port}`);
  return {
    port: addr.port,
    server,
    wss,
    async close() {
      try { server.closeAllConnections?.(); } catch (_) {}
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
    },
  };
}

async function main() {
  const { port, host } = parseArgs(process.argv);
  const { port: actualPort } = await startRelay({ port, host });
  const lan = pickLanIPv4();
  console.log(`[relay] local : http://127.0.0.1:${actualPort}/`);
  if (lan) console.log(`[relay] LAN   : http://${lan}:${actualPort}/   ← share this with your friend`);
  console.log('[relay] open the URL above in two browsers; the first becomes host.');
  // Graceful shutdown.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[relay] ${sig}, shutting down`);
      broadcastClose('relay shutdown');
      process.exit(0);
    });
  }
}

// Run main only when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[relay]', e); process.exit(1); });
}
