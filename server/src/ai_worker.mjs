// Worker-thread runner for AI move search.
//
// The AI's iterative-deepening search at MASTER/POLICY difficulty can spend
// multiple seconds of wall time per move. Running that on the main event
// loop freezes WebSocket reads, heartbeats, and every other game's intent
// processing until it returns. This worker offloads chooseMove() to a
// separate thread so the main loop stays responsive.
//
// Protocol: parent posts { id, state, playerIndex, difficulty } and gets
// back { id, move } on success or { id, error } on failure. `state` is the
// plain object returned by JSON.parse(wasm.stateJson(viewerIndex)); `move`
// is { from, to } where from < 0 means flip.

import { parentPort } from 'node:worker_threads';
import { chooseMove } from '../../ai/index.mjs';

if (!parentPort) {
  throw new Error('ai_worker.mjs must be spawned as a worker_thread');
}

parentPort.on('message', (msg) => {
  const { id, state, playerIndex, difficulty } = msg;
  try {
    const move = chooseMove(state, playerIndex, difficulty);
    parentPort.postMessage({ id, move });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
