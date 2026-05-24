// Game-over celebration modal. Composed on top of the generic modal
// machinery in this folder, but kept distinct because of the win-only
// confetti animation and the per-action `keepOpen` semantics (e.g.
// "Share replay" leaves the modal mounted; "Rematch" closes it).
//
// Caller passes:
//   outcome:  'win' | 'loss' | 'draw'
//   title:    short headline
//   subtitle: optional secondary line
//   actions:  array of { label, onClick, primary, danger, keepOpen }

import { escapeHtml } from '../util.js';

export function showGameOverModal({ outcome, title, subtitle, actions = [] }) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const glyph = outcome === 'win' ? '勝' : outcome === 'loss' ? '敗' : '和';
  const glyphCls = outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : 'draw';

  overlay.innerHTML = `
    <div class="modal game-over-modal" role="dialog" aria-modal="true"
         aria-labelledby="go-title" tabindex="-1">
      ${outcome === 'win' ? '<div class="confetti" aria-hidden="true"></div>' : ''}
      <div class="go-glyph ${glyphCls}" aria-hidden="true">${glyph}</div>
      <h2 id="go-title">${escapeHtml(title)}</h2>
      ${subtitle ? `<p class="go-sub">${escapeHtml(subtitle)}</p>` : ''}
      <div class="modal-actions"></div>
    </div>`;

  const actionsEl = overlay.querySelector('.modal-actions');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    if (a.primary) btn.className = 'primary';
    else if (a.danger) btn.className = 'btn-danger';
    // `keepOpen` actions (e.g. "Share replay") want the modal to stay up so
    // the user can still pick a follow-up action — only close on actions
    // that intentionally navigate or start a new game.
    btn.addEventListener('click', () => {
      try { a.onClick?.(btn); } finally { if (!a.keepOpen) close(); }
    });
    actionsEl.appendChild(btn);
  }

  if (outcome === 'win') seedConfetti(overlay.querySelector('.confetti'));

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    try { previouslyFocused?.focus?.(); } catch (_) {}
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  root.appendChild(overlay);
  overlay.querySelector('.modal').focus();
}

function seedConfetti(container) {
  if (!container) return;
  const colors = ['#ffb43a', '#ffc868', '#d24343', '#6ec96e', '#6ea4ff', '#e0e0e0'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.4}s`;
    s.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(s);
  }
}
