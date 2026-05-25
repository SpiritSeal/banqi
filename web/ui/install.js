// Two PWA install affordances that share the "is this device already
// installed?" signal but otherwise fire on different events:
//
//   * Android Chrome / desktop Chromium — the browser surfaces a
//     `beforeinstallprompt` event once it decides the PWA is
//     installable. We stash it, render an in-app "Install" button next
//     to sign-out, and call `event.prompt()` on click. Spent events
//     can't be reprompted (per spec) so we drop the reference after
//     prompting, and listen for `appinstalled` to clean up the button.
//
//   * iOS Safari — never fires `beforeinstallprompt`, so for those
//     users we render a bottom banner pointing at the Share → Add to
//     Home Screen flow. Dismissals are remembered per-origin.
//
// Both affordances no-op inside an installed standalone window.

let _installPromptEvent = null;

function isIOSSafari() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|UCBrowser/.test(ua);
  return iOS && safari;
}

function inStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}

// Render a small "Install" affordance in the lobby when the browser has
// surfaced a `beforeinstallprompt` event and the app isn't already
// installed.
export function maybeShowInstallButton() {
  if (!_installPromptEvent || inStandalone()) return;
  const meBox = document.getElementById('lobby-me');
  if (!meBox || meBox.querySelector('#btn-install-pwa')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-install-pwa';
  btn.type = 'button';
  btn.className = 'install-btn';
  btn.textContent = 'Install app';
  btn.setAttribute('aria-label', 'Install Banqi as an app');
  btn.title = 'Install Banqi as an app on this device';
  btn.addEventListener('click', async () => {
    const ev = _installPromptEvent;
    if (!ev) { btn.remove(); return; }
    btn.disabled = true;
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      if (choice?.outcome === 'accepted') btn.remove();
      else btn.disabled = false;
    } catch (_) {
      btn.disabled = false;
    } finally {
      // Per spec, a captured `beforeinstallprompt` event can only be
      // prompted once. Drop the reference either way so a re-render
      // doesn't try to reuse a spent event; the browser will fire a
      // fresh event later if the app becomes installable again.
      _installPromptEvent = null;
    }
  });
  // Insert just before the signout button (if present) so it clusters
  // with the right-hand controls in the me-row instead of falling on
  // its own line under the user name.
  const signOut = meBox.querySelector('#btn-signout');
  const row = signOut?.parentElement || meBox;
  if (signOut) row.insertBefore(btn, signOut);
  else row.appendChild(btn);
}

export function maybeShowAddToHomeHint() {
  if (!isIOSSafari() || inStandalone()) return;
  try { if (localStorage.getItem('banqi.a2h-dismissed') === '1') return; } catch (_) {}
  if (document.getElementById('a2h-banner')) return;
  const b = document.createElement('div');
  b.id = 'a2h-banner';
  b.className = 'a2h-banner';
  b.setAttribute('role', 'note');
  b.innerHTML =
    '<div class="a2h-text"><b>Install Banqi:</b> tap ' +
      '<svg class="a2h-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2l4 4h-3v8h-2V6H8l4-4zM5 12h2v7h10v-7h2v9H5z"/>' +
      '</svg> Share, then <b>Add to Home Screen</b>.</div>' +
    '<button id="a2h-dismiss" class="link-btn" aria-label="Dismiss install hint">Dismiss</button>';
  document.body.appendChild(b);
  document.getElementById('a2h-dismiss').onclick = () => {
    try { localStorage.setItem('banqi.a2h-dismissed', '1'); } catch (_) {}
    b.remove();
  };
}

// Wire up the browser-side listeners. Call this once on boot; main.js
// is the only caller. Kept separate from module load so unit tests can
// import the helpers without binding global listeners.
export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPromptEvent = e;
    // If the user is already on the lobby when the event fires (most
    // common case), surface the button right away instead of waiting
    // for a re-render.
    const lobby = document.getElementById('view-lobby');
    if (lobby && !lobby.classList.contains('hidden')) maybeShowInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    _installPromptEvent = null;
    document.getElementById('btn-install-pwa')?.remove();
  });
}
