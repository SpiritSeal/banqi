// Regression tests for the federated-relay bootstrap helper.
//
// What this exercises
// -------------------
// The bug this guards against: when both clients connected to a fresh
// federated game, neither one sent its initial HELLO — game.start()'s
// output was discarded on the assumption that the message log already
// contained an equivalent. For a brand-new game the log is empty, so
// the HELLO never reached the peer and the shuffle protocol never
// started. The UI sat on "shuffling…" indefinitely.
//
// We drive two real WASM Game instances through bootstrapFederated
// against a fake relay (just a server-side message list) and assert:
//   1. A fresh game produces a HELLO to send on first connect.
//   2. After the HELLO is exchanged, the casual shuffle reaches
//      setup_done on BOTH sides — i.e. shuffling completes.
//   3. After both sides finish, regenerating bootstrap against the
//      now-non-empty log produces no spurious resends.
//   4. A mid-protocol reconnect (the host's SETUP_COMMIT never made it
//      to the server) regenerates exactly that one message on bootstrap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createBanqiModule from '../web/banqi.js';
import { bootstrapFederated } from '../web/fed_bootstrap.js';
import { normalizeAction } from '../web/replay.js';

const Module = await createBanqiModule();

// 32-byte hex seeds for the deterministic identity keys.
const HOST_SEED = '11'.repeat(32);
const JOIN_SEED = '22'.repeat(32);
const GAME_ID   = 'fed-bootstrap-test';

function parseJsonSafe(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// Build a Game-like proxy that exposes just the methods bootstrapFederated
// needs, plus the local-action wrappers main.js provides. No Replay, no
// DOM — the helper is concerned with bytes on the wire.
function makeBindings(game) {
  return {
    game,
    applyLocal: (action) => {
      if (action.kind === 'flip')   return game.localFlip(action.to);
      if (action.kind === 'move')   return game.localMove(action.from, action.to);
      if (action.kind === 'resign') return game.localResign();
      throw new Error('unknown action kind: ' + action.kind);
    },
    applyPeer:  (body)   => game.handleMessage(body),
  };
}

// Minimal stand-in for the relay's message log. Server appends in arrival
// order; clients pull `since=0` and replay.
class FakeRelay {
  constructor() { this.log = []; }
  append(senderUserId, body) {
    for (const line of String(body).split('\n')) {
      if (!line.trim()) continue;
      this.log.push({
        seq: this.log.length,
        sender_user_id: senderUserId,
        body: line,
        created_at: Date.now(),
      });
    }
  }
  snapshot() { return this.log.map((m) => ({ ...m })); }
}

// Drive bootstrap → send pending → receive peer messages, alternating
// until neither side has anything new to say. Returns the relay log.
function exchangeUntilQuiescent({ host, join, relay, hostUserId, joinUserId }) {
  // First: each side bootstraps from the (possibly-stale) log.
  const hostB = makeBindings(host);
  const joinB = makeBindings(join);
  let hostPending = bootstrapFederated({
    game: host, log: relay.snapshot(), myUserId: hostUserId,
    applyLocal: hostB.applyLocal, applyPeer: hostB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });
  let joinPending = bootstrapFederated({
    game: join, log: relay.snapshot(), myUserId: joinUserId,
    applyLocal: joinB.applyLocal, applyPeer: joinB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });

  // Send each side's initial pending batch onto the relay.
  for (const line of hostPending) relay.append(hostUserId, line);
  for (const line of joinPending) relay.append(joinUserId, line);

  // Now pump live: each side processes messages that aren't its own.
  let cursors = { host: 0, join: 0 };
  let safety = 200;
  while (safety-- > 0) {
    const before = relay.log.length;
    // Host consumes messages it hasn't seen.
    while (cursors.host < relay.log.length) {
      const m = relay.log[cursors.host++];
      if (m.sender_user_id === hostUserId) continue;
      const out = host.handleMessage(m.body);
      if (out) relay.append(hostUserId, out);
    }
    // Join consumes messages it hasn't seen.
    while (cursors.join < relay.log.length) {
      const m = relay.log[cursors.join++];
      if (m.sender_user_id === joinUserId) continue;
      const out = join.handleMessage(m.body);
      if (out) relay.append(joinUserId, out);
    }
    if (relay.log.length === before) break;
  }
  if (safety <= 0) throw new Error('exchange did not quiesce');
  return { hostPending, joinPending };
}

test('fresh game: bootstrap produces HELLO and shuffling completes', () => {
  const host = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const join = Module.Game.createJoinWithSeed(1, GAME_ID, JOIN_SEED);
  const relay = new FakeRelay();
  const { hostPending, joinPending } = exchangeUntilQuiescent({
    host, join, relay, hostUserId: 1, joinUserId: 2,
  });

  // Both sides must have something to send on the first connect — at
  // minimum, their HELLO. The bug was that this list was empty.
  assert.ok(hostPending.length > 0, 'host should have pending messages on fresh game');
  assert.ok(joinPending.length > 0, 'join should have pending messages on fresh game');
  assert.ok(hostPending.some((l) => parseJsonSafe(l)?.type === 'HELLO'),
            'host pending must include HELLO');
  assert.ok(joinPending.some((l) => parseJsonSafe(l)?.type === 'HELLO'),
            'join pending must include HELLO');

  // The whole point of the fix: shuffling completes.
  assert.equal(host.setupDone(), true,  'host setup must complete');
  assert.equal(join.setupDone(), true,  'join setup must complete');
  assert.equal(host.handshakeDone(), true);
  assert.equal(join.handshakeDone(), true);
});

test('reconnect on a fully-played setup: nothing extra to send', () => {
  // First: play the setup all the way through, recording the log.
  const host = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const join = Module.Game.createJoinWithSeed(1, GAME_ID, JOIN_SEED);
  const relay = new FakeRelay();
  exchangeUntilQuiescent({ host, join, relay, hostUserId: 1, joinUserId: 2 });
  assert.ok(host.setupDone());
  const fullLog = relay.snapshot();

  // Reconnect: brand-new Game instances replay the log.
  const host2 = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const join2 = Module.Game.createJoinWithSeed(1, GAME_ID, JOIN_SEED);
  const hostB = makeBindings(host2);
  const joinB = makeBindings(join2);
  const hostPending = bootstrapFederated({
    game: host2, log: fullLog, myUserId: 1,
    applyLocal: hostB.applyLocal, applyPeer: hostB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });
  const joinPending = bootstrapFederated({
    game: join2, log: fullLog, myUserId: 2,
    applyLocal: joinB.applyLocal, applyPeer: joinB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });
  assert.deepEqual(hostPending, [], 'host should have nothing new to send after a complete-setup reconnect');
  assert.deepEqual(joinPending, [], 'join should have nothing new to send after a complete-setup reconnect');
  assert.equal(host2.setupDone(), true);
  assert.equal(join2.setupDone(), true);
});

test('mid-protocol reconnect: missing host SETUP_COMMIT is re-emitted', () => {
  // Simulate: host successfully sent its HELLO, join received and
  // responded with HELLO. Host's SETUP_COMMIT (response to join's HELLO)
  // got generated but never made it to the server (network drop, server
  // crash, etc.). On reconnect we expect bootstrap to regenerate exactly
  // that SETUP_COMMIT in pendingSends.

  // First produce a complete log so we can extract individual messages.
  const sa = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const sb = Module.Game.createJoinWithSeed(1, GAME_ID, JOIN_SEED);
  const relayFull = new FakeRelay();
  exchangeUntilQuiescent({ host: sa, join: sb, relay: relayFull, hostUserId: 1, joinUserId: 2 });
  const log = relayFull.snapshot();

  const helloHost = log.find((m) => m.sender_user_id === 1 && parseJsonSafe(m.body).type === 'HELLO');
  const helloJoin = log.find((m) => m.sender_user_id === 2 && parseJsonSafe(m.body).type === 'HELLO');
  const setupCommitHost = log.find((m) => m.sender_user_id === 1 && parseJsonSafe(m.body).type === 'SETUP_COMMIT');
  assert.ok(helloHost && helloJoin && setupCommitHost);

  // Partial log: host's HELLO, join's HELLO. Missing host's SETUP_COMMIT.
  const partialLog = [
    { ...helloHost,  seq: 0 },
    { ...helloJoin,  seq: 1 },
  ];

  const host = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const hostB = makeBindings(host);
  const pending = bootstrapFederated({
    game: host, log: partialLog, myUserId: 1,
    applyLocal: hostB.applyLocal, applyPeer: hostB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });
  assert.ok(pending.includes(setupCommitHost.body),
            `pending must regenerate host's SETUP_COMMIT (got: ${JSON.stringify(pending)})`);
  // HELLO itself should NOT be re-sent — it's already in the log.
  assert.ok(!pending.some((l) => parseJsonSafe(l)?.type === 'HELLO'),
            'HELLO must dedupe against the persisted log');
});

test('after sending pending and re-bootstrapping, nothing is sent twice', () => {
  // This is the "subsequent reconnect" invariant: once pending is sent,
  // a later reconnect that sees those messages in the log produces zero
  // pendingSends, so the server doesn't accumulate duplicates.
  const host = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const join = Module.Game.createJoinWithSeed(1, GAME_ID, JOIN_SEED);
  const relay = new FakeRelay();
  exchangeUntilQuiescent({ host, join, relay, hostUserId: 1, joinUserId: 2 });
  const log = relay.snapshot();

  // Second bootstrap on the same Game pair (simulating a WS-only blip
  // where openFederatedGame re-runs).
  const host2 = Module.Game.createHostWithSeed(1, GAME_ID, HOST_SEED);
  const hostB = makeBindings(host2);
  const pending = bootstrapFederated({
    game: host2, log, myUserId: 1,
    applyLocal: hostB.applyLocal, applyPeer: hostB.applyPeer,
    parseJson: parseJsonSafe, normalizeAction,
  });
  assert.deepEqual(pending, []);
});

test('crypto mode: bootstrap still kicks off shuffling on a fresh game', () => {
  // The bug applied to both modes — guard the crypto path explicitly so a
  // future change to either shuffle protocol can't silently regress it.
  const host = Module.Game.createHostWithSeed(2, GAME_ID, HOST_SEED);
  const join = Module.Game.createJoinWithSeed(2, GAME_ID, JOIN_SEED);
  const relay = new FakeRelay();
  exchangeUntilQuiescent({ host, join, relay, hostUserId: 1, joinUserId: 2 });
  assert.equal(host.setupDone(), true, 'crypto host must finish setup');
  assert.equal(join.setupDone(), true, 'crypto join must finish setup');
});
