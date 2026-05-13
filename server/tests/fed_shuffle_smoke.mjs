// Federated shuffle end-to-end test.
//
// Drives two real WASM Game instances over the real relay (HTTP REST
// + WebSocket + Postgres) and asserts that the casual shuffle protocol
// completes — i.e. `setup_done` becomes true on both sides — within a
// reasonable wall-clock budget. This is the strongest available guard
// against the "stuck on shuffling…" regression: it puts actual bytes
// through every layer of the relay stack.
//
// Requires the WASM module to be built (web/banqi.js + web/banqi.wasm).
// CI: builds WASM, runs `npm test` in server/, which picks this up.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildApp } from '../src/index.mjs';

const PORT = 19182;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

let server, db, baseUrl, Module;

async function signInAs(name) {
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  return setCookie.split(';')[0];
}

async function authedFetch(cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
               ...(init.headers || {}) },
  });
}

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: `http://localhost:${PORT}`,
    envOverride: process.env,
  });
  db = built.db;
  server = built.server;
  await db.query(
    'TRUNCATE finalize_claims, elo_history, messages, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;

  // Lazy-load the WASM module; CI builds it before running these tests.
  // If the build is missing, surface a clear message rather than failing
  // deep inside emscripten's runtime loader.
  try {
    const mod = await import('../../web/banqi.js');
    Module = await mod.default();
  } catch (e) {
    throw new Error(`WASM module missing or unloadable — run \`make wasm\` first. (${e.message})`);
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

// Attach a persistent reader that feeds every incoming non-meta frame
// into the Game and sends any responses back over the same socket.
function attachReader(ws, game) {
  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === '_meta') return;
    } catch (_) { /* not JSON; pass through */ }
    let out;
    try { out = game.handleMessage(text); }
    catch (e) { console.warn('handleMessage failed:', e.message); return; }
    if (out) ws.send(out);
  });
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs} ms`);
}

describe('federated shuffle end-to-end', () => {
  it('two WASM clients complete the casual shuffle through the real relay', async () => {
    const alice = await signInAs('AliceShuffle');
    const bob   = await signInAs('BobShuffle');
    const meA = await (await authedFetch(alice, '/api/me')).json();
    const meB = await (await authedFetch(bob, '/api/me')).json();
    assert.ok(meA.identity_seed_hex && meB.identity_seed_hex);

    const created = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'casual' }),
    })).json();
    await authedFetch(bob, `/api/games/${created.id}/join`, { method: 'POST' });

    const wsUrl = `ws://localhost:${PORT}/ws/${created.id}`;
    const aliceWs = new WebSocket(wsUrl, { headers: { Cookie: alice } });
    const bobWs   = new WebSocket(wsUrl, { headers: { Cookie: bob } });
    await Promise.all([
      new Promise((r) => aliceWs.on('open', r)),
      new Promise((r) => bobWs.on('open', r)),
    ]);

    const gameId = String(created.id);
    const host = Module.Game.createHostWithSeed(1, gameId, meA.identity_seed_hex);
    const join = Module.Game.createJoinWithSeed(1, gameId, meB.identity_seed_hex);

    attachReader(aliceWs, host);
    attachReader(bobWs,   join);

    try {
      // The fix: each side must SEND its initial HELLO. The previous code
      // discarded game.start()'s output, leaving the peer waiting forever.
      const hostHello = host.start();
      const joinHello = join.start();
      assert.ok(hostHello.includes('"type":"HELLO"'), 'host.start() emits HELLO');
      assert.ok(joinHello.includes('"type":"HELLO"'), 'join.start() emits HELLO');
      aliceWs.send(hostHello);
      bobWs.send(joinHello);

      await waitFor(() => host.setupDone() && join.setupDone(), { timeoutMs: 5_000 });
      assert.equal(host.setupDone(), true, 'host should reach setup_done');
      assert.equal(join.setupDone(), true, 'join should reach setup_done');
    } finally {
      aliceWs.close();
      bobWs.close();
    }

    // The HELLO + SETUP_* exchange should be persisted in the relay log so a
    // reconnecting client can replay it. Verify the log shape: at least one
    // HELLO from each user and SETUP_COMMIT / SETUP_REVEAL frames from both.
    const log = await (await authedFetch(alice,
      `/api/games/${created.id}/messages?since=0`)).json();
    const byType = {};
    for (const m of log) {
      const t = JSON.parse(m.body).type;
      (byType[t] ||= []).push(m);
    }
    assert.equal(byType.HELLO?.length, 2,        'two HELLOs (one per user)');
    assert.equal(byType.SETUP_COMMIT?.length, 2, 'two SETUP_COMMITs');
    assert.equal(byType.SETUP_REVEAL?.length, 2, 'two SETUP_REVEALs');
  });
});
