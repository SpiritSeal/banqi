// Service-worker registration + update-banner wiring. Mounts a small
// "A new version of Banqi is available." bar at the bottom when the
// SW has a waiting worker (i.e. a fresh deploy is sitting one
// activation away). The bar's Update button sends SKIP_WAITING; the
// resulting controllerchange triggers a single page reload so the
// running tab picks up the new bundle.
//
// No-op in browsers without service workers.

export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Track whether there was already a controller when this page
  // loaded. The first `controllerchange` after a no-controller load
  // is just the SW claiming this page — there's no stale code in
  // scope to reload past, so a reload here would be a needless full
  // nav (and races with anything running mid-load, e.g. test
  // harnesses). Only reload when the controllerchange follows a
  // SKIP_WAITING from the update banner.
  let hadController = !!navigator.serviceWorker.controller;
  let _swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloading) return;
    if (!hadController) { hadController = true; return; }
    _swReloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const showUpdateBanner = (worker) => {
      if (document.getElementById('sw-update-banner')) return;
      const b = document.createElement('div');
      b.id = 'sw-update-banner';
      b.className = 'sw-update-banner';
      b.innerHTML =
        '<span>A new version of Banqi is available.</span>' +
        '<button id="sw-update-apply" class="primary">Update</button>' +
        '<button id="sw-update-dismiss" class="link-btn">Later</button>';
      document.body.appendChild(b);
      document.getElementById('sw-update-apply').onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
      document.getElementById('sw-update-dismiss').onclick = () => b.remove();
    };
    if (reg.waiting) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });
    // Browsers normally only check for an updated SW on navigation. A
    // tab left open for days never notices a deploy. Re-check on a
    // long interval (cheap — it's a single conditional GET against
    // /sw.js) and whenever the tab returns to visible, so a user
    // coming back from a backgrounded tab sees the update banner
    // promptly instead of after the next reload.
    const checkForUpdate = () => { reg.update().catch(() => {}); };
    setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
  }).catch((e) => console.warn('SW registration failed:', e));
}
