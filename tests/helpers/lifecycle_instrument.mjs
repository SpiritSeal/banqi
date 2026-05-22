// Page-side instrumentation that counts long-lived browser resources
// (WebSockets, intervals, timeouts, in-flight fetches) by monkey-patching
// the constructors / globals before the SPA's main.js runs. Used by the
// view-lifecycle smoke tests to assert that entering and leaving a view
// returns each counter to baseline — the same shape the teleport bug
// (PR #102 / #98) would have tripped if the test had existed.
//
// Wire-up:
//   import { INSTRUMENT_SOURCE, snapshotCounts, assertCleanRoundTrip }
//     from './lifecycle_instrument.mjs';
//   const ctx = await browser.newContext();
//   await ctx.addInitScript({ content: INSTRUMENT_SOURCE });
//   // ... subsequent ctx.newPage() / page.goto() are instrumented.
//
// The patches are intentionally minimal:
//   - `window.__lifecycle = { wsOpen, intervals, timeouts, fetches }`
//   - WebSocket constructor counts open sockets; decremented on 'close'.
//   - setInterval/setTimeout track active ids; cleared on
//     clearInterval/clearTimeout or natural timer firing.
//   - fetch counts in-flight; decremented when the promise settles.
//
// What it does NOT track (intentional):
//   - addEventListener on per-element targets (DOM render churn is noisy
//     and not the leak shape we're chasing).
//   - requestAnimationFrame / requestIdleCallback (not historically a
//     leak vector here).
//
// The baseline is captured AFTER the SPA has booted into the lobby, so
// app-lifetime intervals (e.g. setInterval(checkForUpdate, 1h) in
// main.js's SW registration) are folded into the baseline and don't
// trigger spurious failures.

export const INSTRUMENT_SOURCE = `
(() => {
  if (window.__lifecycle) return;
  const lc = window.__lifecycle = {
    wsOpen: 0, intervals: 0, timeouts: 0, fetches: 0,
  };

  // WebSocket: count opens, decrement on close. ws.close() is async
  // (close handshake), so the counter drops only after the handshake
  // completes — assertions need to wait for it.
  const OrigWS = window.WebSocket;
  function WrappedWS(url, protocols) {
    const ws = protocols == null
      ? new OrigWS(url)
      : new OrigWS(url, protocols);
    lc.wsOpen += 1;
    let closed = false;
    const drop = () => {
      if (closed) return;
      closed = true;
      lc.wsOpen -= 1;
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
    return ws;
  }
  WrappedWS.prototype = OrigWS.prototype;
  WrappedWS.CONNECTING = OrigWS.CONNECTING;
  WrappedWS.OPEN       = OrigWS.OPEN;
  WrappedWS.CLOSING    = OrigWS.CLOSING;
  WrappedWS.CLOSED     = OrigWS.CLOSED;
  window.WebSocket = WrappedWS;

  // Use a single id→kind map for setInterval / setTimeout, since
  // clearInterval and clearTimeout are interchangeable in browsers and
  // separate tracking would let a mismatched clear leave the counter
  // out of whack.
  const live = new Map();
  function refresh() {
    let i = 0, t = 0;
    for (const kind of live.values()) {
      if (kind === 'interval') i += 1;
      else t += 1;
    }
    lc.intervals = i;
    lc.timeouts  = t;
  }

  const origSetInterval = window.setInterval;
  const origClearInterval = window.clearInterval;
  const origSetTimeout = window.setTimeout;
  const origClearTimeout = window.clearTimeout;

  window.setInterval = function setInterval(fn, ms, ...rest) {
    const id = origSetInterval.call(this, fn, ms, ...rest);
    live.set(id, 'interval');
    refresh();
    return id;
  };
  window.clearInterval = function clearInterval(id) {
    if (live.delete(id)) refresh();
    return origClearInterval.call(this, id);
  };
  window.setTimeout = function setTimeout(fn, ms, ...rest) {
    let id;
    const wrapped = typeof fn === 'function'
      ? function () {
          live.delete(id);
          refresh();
          return fn.apply(this, arguments);
        }
      : fn;
    id = origSetTimeout.call(this, wrapped, ms, ...rest);
    live.set(id, 'timeout');
    refresh();
    return id;
  };
  window.clearTimeout = function clearTimeout(id) {
    if (live.delete(id)) refresh();
    return origClearTimeout.call(this, id);
  };

  // fetch: count in-flight. The original is preserved on Window so the
  // SPA's existing calls keep working.
  const origFetch = window.fetch.bind(window);
  window.fetch = function fetch(...args) {
    lc.fetches += 1;
    const settle = () => { lc.fetches -= 1; };
    return origFetch(...args).then(
      (res) => { settle(); return res; },
      (err) => { settle(); throw err; },
    );
  };
})();
`;

// Snapshot the current counters from the page. Returns a plain object,
// not a live reference.
export async function snapshotCounts(page) {
  return await page.evaluate(() => ({ ...window.__lifecycle }));
}

// Wait until `wsOpen` matches `target.wsOpen` AND `intervals` matches
// `target.intervals`. fetches naturally settle on networkidle so we
// don't poll for them here. timeouts are noisy (animation chains, etc.)
// — caller decides whether to assert on them.
export async function waitForLifecycleSettle(page, target, { timeoutMs = 5000 } = {}) {
  await page.waitForFunction(
    (t) => {
      const lc = window.__lifecycle;
      if (!lc) return false;
      return lc.wsOpen === t.wsOpen && lc.intervals === t.intervals;
    },
    target,
    { timeout: timeoutMs },
  );
}

// Convenience: navigate via hash, then wait for networkidle + a RAF tick
// so transient fetches / setTimeouts initiated by the route resolve.
export async function navigateHash(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Enter `hash`, settle, leave back to `#/`, settle, assert that
// `wsOpen` and `intervals` returned to baseline. `name` is logged in
// failure messages.
//
// Returns { ok, label, detail } so the caller can aggregate.
export async function assertViewClean(page, hash, baseline) {
  await navigateHash(page, hash);
  // Some views do still-in-flight work after networkidle (e.g. the
  // dashboard's user-profile fetch chains); give the counters a moment
  // to stabilise before leaving.
  await page.waitForTimeout(150);

  await navigateHash(page, '#/');
  // wsOpen drops only after the close handshake completes; intervals
  // drop synchronously on clearInterval but may take a tick if the
  // teardown path is async.
  try {
    await waitForLifecycleSettle(page, baseline, { timeoutMs: 5000 });
  } catch (_) { /* fall through to the assertion below for a useful diff */ }

  const after = await snapshotCounts(page);
  const drift = {};
  for (const k of ['wsOpen', 'intervals']) {
    if (after[k] !== baseline[k]) drift[k] = `${baseline[k]} → ${after[k]}`;
  }
  if (Object.keys(drift).length === 0) {
    return { ok: true, label: `${hash} returns to baseline` };
  }
  return {
    ok: false,
    label: `${hash} leaked resources`,
    detail: JSON.stringify(drift),
  };
}
