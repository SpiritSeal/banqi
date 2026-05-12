// Thin WebSocket transport that mimics the parts of PeerJS's DataConnection
// API we use, so the same `attachDataHandler` / `sendOutbound` logic can drive
// either transport.
//
// Constructor: new RelayConnection(wsUrl)
// Events: .on('open' | 'data' | 'close' | 'error', cb)
// Methods: .send(text), .close()
// Property: .open  (bool)

export class RelayConnection {
  constructor(url) {
    this._url = url;
    this._handlers = { open: [], data: [], close: [], error: [], meta: [], reconnecting: [] };
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
      // The server interleaves a `_meta` JSON frame (auth/role) alongside
      // gameplay frames. Surface that on a separate handler so callers can
      // discover their assigned role (host vs join) before the game starts.
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.type === '_meta') {
          this._emit('meta', parsed);
          return;
        }
      } catch (_) { /* not JSON or not _meta; treat as game frame */ }
      this._emit('data', text);
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
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
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

  send(text) {
    if (this._ws.readyState === WebSocket.OPEN) this._ws.send(text);
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

// Loopback transport for the OTB (over-the-board) hot-seat mode. Two
// LoopbackConnection instances are wired together: data sent on one fires
// 'data' on the other, with messages split on newlines (mirroring the
// newline-delimited JSON output the C++ Game emits).
export class LoopbackConnection {
  constructor() {
    this._peer = null;
    this._handlers = { open: [], data: [], close: [], error: [] };
    this.open = true;
  }
  static pair() {
    const a = new LoopbackConnection();
    const b = new LoopbackConnection();
    a._peer = b; b._peer = a;
    return [a, b];
  }
  on(event, cb) { (this._handlers[event] ||= []).push(cb); }
  send(text) {
    if (!this._peer) return;
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      queueMicrotask(() => this._peer._emit('data', line));
    }
  }
  close() {
    this.open = false;
    this._emit('close');
    if (this._peer && this._peer.open) this._peer.close();
  }
  _emit(event, payload) {
    for (const cb of this._handlers[event] || []) {
      try { cb(payload); } catch (e) { console.error('loopback handler:', e); }
    }
  }
}
