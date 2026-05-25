// Keyboard navigation for the board. Each cell button carries a
// `data-cell-index` (0..31) and is independently focusable; this
// module wires WASD + Home/End on those cells to move focus around
// the 4×8 grid. Selection / move / flip semantics on Enter/Space are
// handled by the per-cell click handler — this module only changes
// which cell has focus.
//
// `attachBoardKeyNav` is idempotent so the move dispatcher can call
// it on every render without piling up listeners.

function boardArrowFocus(boardEl, currentIdx, dr, dc) {
  const r = (currentIdx >> 3) + dr;
  const c = (currentIdx & 7) + dc;
  if (r < 0 || r > 3 || c < 0 || c > 7) return;
  const next = boardEl.querySelector(`[data-cell-index="${r * 8 + c}"]`);
  if (next) next.focus();
}

export function attachBoardKeyNav(boardEl) {
  if (boardEl.dataset.keyNav === '1') return;
  boardEl.dataset.keyNav = '1';
  boardEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target.closest('[data-cell-index]');
    if (!target || target.parentElement !== boardEl) return;
    const idx = parseInt(target.dataset.cellIndex, 10);
    if (isNaN(idx)) return;
    let handled = true;
    switch (e.key.toLowerCase()) {
      case 'w':    boardArrowFocus(boardEl, idx, -1, 0); break;
      case 'a':    boardArrowFocus(boardEl, idx,  0, -1); break;
      case 's':    boardArrowFocus(boardEl, idx,  1, 0); break;
      case 'd':    boardArrowFocus(boardEl, idx,  0, 1); break;
      case 'home': boardArrowFocus(boardEl, idx,  0, -8); break;
      case 'end':  boardArrowFocus(boardEl, idx,  0, 8); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });
}
