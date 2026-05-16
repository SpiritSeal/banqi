// Client-side turn-notification mechanisms. Four layers, each independently
// toggleable from the settings UI:
//
//   1. In-page Notification API — OS-level card when the tab is hidden but
//      the WS is still alive (e.g. user switched tabs).
//   2. Title-bar prefix         — "(your turn) Banqi · 半棋" while the tab is
//      hidden, restored when it regains visibility or the opponent moves
//      again. Works without any permission grant.
//   3. Audio cue                — short two-tone beep on a Web Audio context.
//   4. Web Push                 — handled by the server + service worker;
//      this module owns the client-side subscribe/unsubscribe + settings
//      flow only.
//
// Preferences live in localStorage under the keys below. They default ON the
// first time, and any write goes through saveSettings so the rest of the app
// can observe via getSettings().

const LS_KEY = 'banqi.notifySettings';
const DEFAULT_SETTINGS = {
  sound:          true,   // play the audio cue on turn flips
  desktopAlerts:  true,   // call new Notification(...) when the tab is hidden
  push:           false,  // OS-level Web Push (requires permission + sub)
};

const TITLE_PREFIX = '(your turn) ';
let _origTitle = null;
let _titleAlerted = false;
let _audioCtx = null;
let _visibilityBound = false;

export function getSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch (_) { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

// Called from the game frame handler when the local player's side_to_move
// transitions from "not me" → "me". Idempotent — safe to call repeatedly.
export function onYourTurn({ opponentName, roomCode } = {}) {
  const settings = getSettings();
  if (settings.sound)         playTurnCue();
  if (settings.desktopAlerts) maybeShowDesktopAlert(opponentName, roomCode);
  setTitleAlerted(true);
  bindVisibilityWatch();
}

// Called when the local player's turn is over (made a move, or game ended).
// Clears any active "your turn" title/badge.
export function clearTurnAlert() {
  setTitleAlerted(false);
}

function setTitleAlerted(on) {
  if (_origTitle == null) _origTitle = document.title;
  if (on === _titleAlerted) return;
  _titleAlerted = on;
  if (on) {
    if (!document.title.startsWith(TITLE_PREFIX)) {
      document.title = TITLE_PREFIX + (_origTitle || document.title);
    }
  } else {
    if (document.title.startsWith(TITLE_PREFIX)) {
      document.title = document.title.slice(TITLE_PREFIX.length);
    }
  }
}

function bindVisibilityWatch() {
  if (_visibilityBound) return;
  _visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _titleAlerted) {
      // User came back; drop the title prefix. Game UI now visibly reflects
      // "your turn" so the marker is redundant.
      setTitleAlerted(false);
    }
  });
}

function maybeShowDesktopAlert(opponentName, roomCode) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  // Only nag the user when they're not actively looking at this tab. If the
  // tab is visible they can see the board update on their own.
  if (!document.hidden) return;
  try {
    const n = new Notification('Your turn in Banqi', {
      body: opponentName ? `${opponentName} played a move.` : 'Tap to play your move.',
      tag:  roomCode ? `banqi-turn-${roomCode}` : 'banqi-turn',
      renotify: true,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
    });
    n.onclick = () => {
      window.focus();
      if (roomCode) location.hash = `#/g/${roomCode}`;
      n.close();
    };
  } catch (_) { /* some browsers throw when called too aggressively — ignore */ }
}

function playTurnCue() {
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _audioCtx = new AC();
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    twoTone(ctx, now,        660, 0.10);
    twoTone(ctx, now + 0.13, 880, 0.14);
  } catch (_) { /* audio is best-effort */ }
}

function twoTone(ctx, t0, freq, durSec) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.18, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0005, t0 + durSec);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.02);
}

// ---- Web Push lifecycle ----
//
// requestPushPermissionAndSubscribe()  asks for OS notification permission,
//   subscribes the service-worker registration to the push service using the
//   server's VAPID public key, POSTs the subscription to the server, and
//   flips the persisted setting on. Returns { ok: bool, reason?: string }.
//
// unsubscribePush()  drops the local push subscription and tells the server.

export async function isPushSupported() {
  return 'serviceWorker' in navigator
      && 'PushManager'    in window
      && 'Notification'   in window;
}

export async function currentPushSubscription() {
  if (!(await isPushSupported())) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function requestPushPermissionAndSubscribe() {
  if (!(await isPushSupported())) {
    return { ok: false, reason: 'unsupported' };
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    perm = await Notification.requestPermission();
  }
  if (perm !== 'granted') return { ok: false, reason: 'denied' };

  let keyRes;
  try {
    keyRes = await fetch('/api/push/vapid-key');
  } catch (_) {
    return { ok: false, reason: 'network' };
  }
  if (keyRes.status === 503) return { ok: false, reason: 'server-disabled' };
  if (!keyRes.ok)             return { ok: false, reason: 'server-error' };
  const { publicKey } = await keyRes.json();
  if (!publicKey) return { ok: false, reason: 'server-error' };

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const payload = sub.toJSON();
  const r = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    // Best-effort: drop the local subscription if the server refused it.
    try { await sub.unsubscribe(); } catch (_) {}
    return { ok: false, reason: r.status === 403 ? 'guest' : 'server-error' };
  }
  saveSettings({ push: true });
  return { ok: true };
}

export async function unsubscribePush() {
  saveSettings({ push: false });
  if (!(await isPushSupported())) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (_) {}
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
    } catch (_) { /* offline; the server prunes 410s lazily anyway */ }
  } catch (_) { /* registration not ready — nothing to do */ }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
