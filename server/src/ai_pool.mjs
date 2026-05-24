// Worker-thread pool for AI move search.
//
// The AI is CPU-bound: a single worker is enough to unblock the Node event
// loop, since multiple concurrent AI games would each still need their
// own CPU time. The default pool size is 1; operators with heavy AI
// concurrency can dial it up via createGameEngine({ aiPoolSize: N }).

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('./ai_worker.mjs', import.meta.url));

export function createAiPool({ workerCount = 1 } = {}) {
  if (!Number.isInteger(workerCount) || workerCount < 1) workerCount = 1;
  const workers = [];
  const inflight = new Map(); // id -> { resolve, reject, workerIdx }
  let nextId = 1;
  let nextWorker = 0;
  let closed = false;

  function spawn(idx) {
    const w = new Worker(WORKER_PATH);
    // Don't keep the process alive just because the worker is idle — engine
    // close() terminates workers explicitly, but callers that drop the engine
    // without closing it shouldn't hang the event loop on a stuck worker.
    w.unref?.();
    w.on('message', (msg) => {
      const job = inflight.get(msg.id);
      if (!job) return;
      inflight.delete(msg.id);
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.move);
    });
    w.on('error', (e) => {
      console.error('AI worker error:', e);
    });
    w.on('exit', (code) => {
      for (const [id, job] of inflight) {
        if (job.workerIdx !== idx) continue;
        inflight.delete(id);
        job.reject(new Error(`AI worker exited (code ${code})`));
      }
      if (!closed && code !== 0) {
        workers[idx] = spawn(idx);
      }
    });
    return w;
  }

  for (let i = 0; i < workerCount; i++) workers.push(spawn(i));

  function chooseMove(state, playerIndex, difficulty) {
    if (closed) return Promise.reject(new Error('AI pool is closed'));
    const id = nextId++;
    const idx = nextWorker;
    nextWorker = (nextWorker + 1) % workers.length;
    return new Promise((resolve, reject) => {
      inflight.set(id, { resolve, reject, workerIdx: idx });
      workers[idx].postMessage({ id, state, playerIndex, difficulty });
    });
  }

  async function close() {
    closed = true;
    for (const [id, job] of inflight) {
      inflight.delete(id);
      job.reject(new Error('AI pool is closed'));
    }
    const ws = workers.splice(0, workers.length);
    await Promise.all(ws.map((w) => w.terminate()));
  }

  return { chooseMove, close };
}
