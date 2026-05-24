// Generic modal dialog primitives. Each function appends to
// `#modal-root` in index.html, traps focus, and resolves a promise on
// close. Game-specific dialogs (game-over modal, threefold-rep
// confirmation, challenge picker) compose these from main.js.

// True if a keydown target is something the user is actively typing
// into — used by global shortcut handlers to skip when focus is in an
// `<input>`, `<textarea>`, `<select>`, or any `contenteditable` element.
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

// Single-button info dialog. Resolves when the user dismisses it
// (button click, overlay click, or Escape).
//
//   await infoModal({ title: 'Heads up', html: '<p>…</p>' });
export function infoModal({ title, html, closeLabel = 'Close' } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-info" role="dialog" aria-modal="true" aria-labelledby="modal-title"
           aria-describedby="modal-body" tabindex="-1">
        <h2 id="modal-title"></h2>
        <div id="modal-body" class="modal-body"></div>
        <div class="modal-actions">
          <button type="button" class="btn-close primary"></button>
        </div>
      </div>`;
    overlay.querySelector('#modal-title').textContent = title || '';
    overlay.querySelector('#modal-body').innerHTML = html || '';
    const btnClose = overlay.querySelector('.btn-close');
    btnClose.textContent = closeLabel;

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { btnClose.focus(); e.preventDefault(); }
    };
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    btnClose.focus();
  });
}

// Two-button confirmation dialog. Resolves to true on confirm, false
// on cancel / overlay-dismiss / Escape. When `danger` is true the
// confirm button picks up the danger style and focus starts on the
// cancel button (so an accidental Enter doesn't trigger the
// destructive action).
//
//   const ok = await confirmModal({
//     title: 'Resign?', body: 'This will count as a loss.',
//     confirmLabel: 'Resign', danger: true,
//   });
export function confirmModal({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(false); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
           aria-describedby="modal-body" tabindex="-1">
        <h2 id="modal-title"></h2>
        <p id="modal-body" class="modal-body"></p>
        <div class="modal-actions">
          <button type="button" class="btn-cancel"></button>
          <button type="button" class="btn-confirm${danger ? ' btn-danger' : ' primary'}"></button>
        </div>
      </div>`;
    overlay.querySelector('#modal-title').textContent = title || 'Are you sure?';
    overlay.querySelector('#modal-body').textContent = body || '';
    const btnCancel = overlay.querySelector('.btn-cancel');
    const btnConfirm = overlay.querySelector('.btn-confirm');
    btnCancel.textContent = cancelLabel;
    btnConfirm.textContent = confirmLabel;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
      if (e.key === 'Tab') {
        const focusables = [btnCancel, btnConfirm];
        const idx = focusables.indexOf(document.activeElement);
        if (idx === -1) { focusables[0].focus(); e.preventDefault(); return; }
        const next = e.shiftKey ? (idx - 1 + focusables.length) % focusables.length
                                : (idx + 1) % focusables.length;
        focusables[next].focus();
        e.preventDefault();
      }
    };
    btnCancel.addEventListener('click', () => close(false));
    btnConfirm.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    (danger ? btnCancel : btnConfirm).focus();
  });
}
