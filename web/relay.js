// Thin WebSocket transport with reconnect/backoff.
//
// Constructor: new RelayConnection(wsUrl)
// Events: .on('open' | 'frame' | 'close' | 'error' | 'reconnecting', cb)
// Methods: .send(frame: object), .close(), .reconnect()
// Property: .open  (bool)

// Pure function so a Node test can pin the backoff curve without spinning
// up a full WebSocket. Capped attempts at 6 (32s base + up-to-30% jitter)
// so a long-running disconnect doesn't blow past 30s + change in delay.
// `rand` is injectable for deterministic tests.
export function computeBackoffDelay(attempt, rand = Math.random) {
  const base = Math.min(30000, 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 5));
  const jitter = base * 0.3 * rand();
  return Math.round(base + jitter);
}

export class RelayConnection {
  constructor(url) {
    this._url = url;
    this._handlers = { open: [], frame: [], close: [], error: [], reconnecting: [] };
    this.open = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._userClosed = false;
    this._connect();
  }

  _connect() {
    this._ws = new WebSocket(this._url);
    this._ws.addEventListener('open', () => {
      this.open = true;
      this._reconnectAttempts = 0;
      this._emit('open');
    });
    this._ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      try {
        const parsed = JSON.parse(text);
        this._emit('frame', parsed);
      } catch (e) {
        console.warn('relay: bad JSON frame', text, e);
      }
    });
    this._ws.addEventListener('close', () => {
      this.open = false;
      this._emit('close');
      if (!this._userClosed) this._scheduleReconnect();
    });
    this._ws.addEventListener('error', (ev) => {
      this._emit('error', ev);
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const attempt = ++this._reconnectAttempts;
    // Exponential backoff (1s, 2s, 4s, ... 32s) with up-to-30% jitter so a
    // server restart or fleet blip doesn't trigger a synchronized reconnect
    // storm from every client at the same wall-clock instants. Cap the base
    // at 30s so reconnect latency stays acceptable for live games.
    const delay = computeBackoffDelay(attempt);
    this._emit('reconnecting', { attempt, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._userClosed) this._connect();
    }, delay);
  }

  // Manually trigger an immediate reconnect (bypass the pending backoff).
  reconnect() {
    if (this._userClosed) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { this._ws?.close(); } catch (_) {}
    this._connect();
  }

  on(event, cb) {
    (this._handlers[event] ||= []).push(cb);
  }

  send(frame) {
    if (this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(frame));
    }
  }

  close() {
    this._userClosed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    try { this._ws.close(); } catch (_) {}
  }

  _emit(event, payload) {
    for (const cb of this._handlers[event] || []) {
      try { cb(payload); } catch (e) { console.error('relay handler:', e); }
    }
  }
}
