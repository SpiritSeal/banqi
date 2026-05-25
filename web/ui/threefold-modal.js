// Threefold-repetition guard. Sits between the move dispatcher and
// the engine: when a candidate move would trigger a draw by repetition
// AND the user has the warning setting on, surfaces a confirm dialog
// so they don't accidentally end the game.
//
// `confirmThreefoldIfNeeded` is the only entry point the move
// dispatcher should care about — it returns true if the caller should
// proceed with the move, false to abort.

import { warnBeforeThreefold, setSetting } from '../settings.js';

// True if the move from -> to carries the engine's `threefold` flag in
// the current legal-moves list. Cheap — the legal moves array is
// short.
function moveTriggersThreefold(state, from, to) {
  const legal = state?.legal_moves_for_me || [];
  for (const m of legal) {
    if (m.from === from && m.to === to) return !!m.threefold;
  }
  return false;
}

// Returns true if the move was confirmed (caller should send it),
// false if cancelled. When `warnBeforeThreefold` is off, returns true
// immediately — no modal. The "Don't show again" checkbox toggles the
// setting.
export async function confirmThreefoldIfNeeded({ from, to, state }) {
  if (!moveTriggersThreefold(state, from, to)) return true;
  if (!warnBeforeThreefold()) return true;
  return confirmThreefoldModal();
}

// Confirm-this-move dialog with a "Don't show again" checkbox.
// Resolves true (commit the move) or false (cancel). On
// commit-with-checkbox, persists warnBeforeThreefold = 'off' to
// settings.
function confirmThreefoldModal() {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(true); return; }   // fail-open: if no modal root, just send.
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true"
           aria-labelledby="threefold-title" aria-describedby="threefold-body" tabindex="-1">
        <h2 id="threefold-title">End the game by repetition?</h2>
        <p id="threefold-body" class="modal-body">
          This move recreates a position that has already occurred twice with
          you to move. Playing it ends the game as a draw by threefold
          repetition. Continue?
        </p>
        <label class="modal-checkbox">
          <input type="checkbox" id="threefold-dont-show">
          <span>Don't show this warning again</span>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm primary">Continue &amp; draw</button>
        </div>
      </div>`;
    const btnCancel = overlay.querySelector('.btn-cancel');
    const btnConfirm = overlay.querySelector('.btn-confirm');
    const dontShow = overlay.querySelector('#threefold-dont-show');
    const close = (result) => {
      if (result && dontShow.checked) setSetting('warnBeforeThreefold', 'off');
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
      if (e.key === 'Tab') {
        const focusables = [btnCancel, btnConfirm, dontShow];
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
    btnCancel.focus();
  });
}
