// Polls /api/notifications every minute and updates the
// `#nav-notif-badge` chip with the count of incoming match requests.
// Distinct from the per-turn notifications mechanism in
// `web/notifications.js`, which handles browser / audio / push cues
// for a game already in progress — this is just the unread-counter
// next to the nav link.
//
// Caller passes a boolean for "is the current user signed in" so the
// polling module doesn't have to import main.js. On sign-out the
// caller is expected to call `clearNotifPolling()` to stop the timer
// — `refreshNotificationBadge(false)` does the same thing but is
// usually called only on sign-in / view-change.

let _notifTimer = null;

export function clearNotifPolling() {
  if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
}

export async function refreshNotificationBadge(isSignedIn) {
  clearNotifPolling();
  if (!isSignedIn) return;
  const tick = async () => {
    try {
      const r = await fetch('/api/notifications');
      if (!r.ok) return;
      const { incoming_match_requests = 0 } = await r.json();
      const badge = document.getElementById('nav-notif-badge');
      if (!badge) return;
      if (incoming_match_requests > 0) {
        badge.textContent = ` ${incoming_match_requests}`;
        badge.classList.remove('hidden');
      } else {
        badge.textContent = '';
        badge.classList.add('hidden');
      }
    } catch (_) { /* offline-ish; try again next tick */ }
  };
  tick();
  _notifTimer = setInterval(tick, 60_000);
}
