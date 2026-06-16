// "Pick the win condition" modal shown before a challenge or rematch
// can start. Resolves to a normalised mode string ('standard' or
// 'capture_general'), or `null` if the user cancels.
//
// Lives next to the other modal builders even though there's only one
// caller today — it's the kind of thing that grows as more variants
// land, and the engine boundary (normMode) lives on `util.js`.

import { normMode } from '../util.js';

export function pickChallengeMode() {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) { resolve(null); return; }
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cm-title" tabindex="-1">
        <h2 id="cm-title">Start game</h2>
        <p class="modal-body">Pick the win condition for this match.</p>
        <div class="row" style="margin:8px 0 16px">
          <label for="cm-mode">Win condition</label>
          <select id="cm-mode">
            <option value="standard" selected>Standard (no legal moves)</option>
            <option value="capture_general">Capture the General</option>
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm primary">Start</button>
        </div>
      </div>`;
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      try { previouslyFocused?.focus?.(); } catch (_) {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    overlay.querySelector('.btn-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.btn-confirm').addEventListener('click', () => {
      const v = overlay.querySelector('#cm-mode').value;
      close(normMode(v));
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    overlay.querySelector('.btn-confirm').focus();
  });
}
