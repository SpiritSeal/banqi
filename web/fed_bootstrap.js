// Federated relay bootstrap helper.
//
// On every (re)connect, the client pulls the full message log from the
// server and replays it through the local WASM Game so the C++ rules /
// shuffle / transcript state matches what the live session would be.
// The server is the source of truth: anything already in the log was
// successfully persisted and broadcast.
//
// The local Game emits messages as it replays — most are deterministic
// regenerations of what's already in the log, but some are not:
//   * The very first HELLO on a fresh game (empty log) has never been
//     sent. Without sending it, the peer never sees us and the shuffle
//     never starts ("stuck on shuffling…").
//   * If we disconnected mid-protocol after receiving a peer message but
//     before our response was sent, the response is regenerated here
//     but is not in the log; it needs to go out on (re)connect.
//
// This module is pure JS that operates on a Game-like interface (just
// the methods we call) so it can be unit-tested under Node against the
// real WASM Module without any DOM. See tests/fed_bootstrap_test.mjs.
//
// `applyLocal(action)` and `applyPeer(line)` are caller-provided wrappers
// that drive the Game and (in the browser) also update the Replay UI.
// They MUST return whatever the underlying Game.* call returned (a
// newline-delimited JSON string of outbound messages, or empty).
//
// `log` is the server's message log: an array of
//   { seq, sender_user_id, body, created_at }
// objects, in seq order.
//
// `myUserId` is the current client's user id (numeric).
//
// `parseJson` is a safe JSON.parse that returns null on invalid input.
//
// `normalizeAction` is the same helper used by the live message handler
// (replay.js).
//
// Returns: an array of newline-free outbound JSON strings that haven't
// been seen by the server yet. The caller should send them over WS
// once the connection opens.

export function bootstrapFederated({
  game,
  log,
  myUserId,
  applyLocal,
  applyPeer,
  parseJson,
  normalizeAction,
}) {
  const emitted = [];
  function pushOut(s) {
    if (!s) return;
    for (const line of String(s).split('\n')) {
      const t = line.trim();
      if (t) emitted.push(t);
    }
  }

  // Always emit HELLO. On a reconnect this regenerates the same HELLO
  // the server already has; the dedupe step below drops the duplicate.
  pushOut(game.start());

  for (const m of log) {
    const parsed = parseJson(m.body);
    if (!parsed) continue;
    if (m.sender_user_id === myUserId) {
      // Own messages: only MOVE_ENTRY needs to be re-driven so the
      // transcript advances and is re-signed. HELLO / SETUP_* /
      // REVEAL_KEY are produced as side effects of handling the peer's
      // counterpart messages, so they regenerate naturally.
      if (parsed.type === 'MOVE_ENTRY') {
        const action = normalizeAction(parsed.payload);
        if (!action) continue;
        try { pushOut(applyLocal(action)); }
        catch (e) { /* swallow; the live path will surface errors */ void e; }
      }
    } else {
      try { pushOut(applyPeer(m.body)); }
      catch (e) { void e; }
    }
  }

  // Deduplicate against messages already persisted from this user. The
  // C++ Game is deterministic given (game_id, identity_seed), and
  // Ed25519 signatures are deterministic per RFC 8032, so regenerated
  // messages are byte-identical to the originals.
  const seen = new Set();
  for (const m of log) {
    if (m.sender_user_id === myUserId) seen.add(String(m.body).trim());
  }
  return emitted.filter((line) => !seen.has(line));
}
