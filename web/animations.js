// Piece flip / move / capture animations.
//
// Strategy: an overlay layer ('.board-anim-layer') is appended to the board
// element and survives renderBoard rebuilds (it's the *last* child).
// Animations spawn ephemeral .anim-piece nodes positioned in board-local
// coordinates, run their CSS keyframes, then remove themselves.
//
// Callers capture the *source* cell rect BEFORE re-rendering (since the
// source cell may not exist after a move). Destination rects are derived
// from the post-render DOM.
//
// All animations are no-ops when `enabled` is false — callers gate this on
// `areAnimationsEnabled()` from settings.js, which already respects
// prefers-reduced-motion.

import { areAnimationsEnabled } from './settings.js';

const FLIP_MS = 320;
const MOVE_MS = 280;
const CAPTURE_MS = 320;

function ensureLayer(boardEl) {
  let layer = boardEl.querySelector(':scope > .board-anim-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'board-anim-layer';
    boardEl.appendChild(layer);
  } else {
    // Always keep on top of cells.
    boardEl.appendChild(layer);
  }
  return layer;
}

function buildOverlay(boardEl, anchorRect, classes, glyph) {
  const boardRect = boardEl.getBoundingClientRect();
  const div = document.createElement('div');
  div.className = `anim-piece ${classes}`;
  div.style.left = `${anchorRect.left - boardRect.left}px`;
  div.style.top = `${anchorRect.top - boardRect.top}px`;
  div.style.width = `${anchorRect.width}px`;
  div.style.height = `${anchorRect.height}px`;
  if (glyph) {
    const span = document.createElement('span');
    span.className = 'cell-glyph';
    span.textContent = glyph;
    div.appendChild(span);
  }
  return div;
}

function cellAt(boardEl, idx) {
  return boardEl.querySelector(`[data-cell-index="${idx}"]`);
}

// Capture the rect of a single cell. Returns null if the cell isn't present
// (e.g. before the first render).
export function captureCellRect(boardEl, idx) {
  if (!boardEl || idx == null || idx < 0) return null;
  const el = cellAt(boardEl, idx);
  return el ? el.getBoundingClientRect() : null;
}

// Flip animation: the cell at idx has just become face-up. Briefly hide the
// rendered piece and play a 3D flip on an overlay clone.
export async function animateFlip(boardEl, idx, revealed) {
  if (!areAnimationsEnabled() || !revealed) return;
  const cell = cellAt(boardEl, idx);
  if (!cell) return;
  const rect = cell.getBoundingClientRect();
  const colorClass = revealed.color === 1 ? 'red' : 'black';
  const overlay = buildOverlay(boardEl, rect, `face-up ${colorClass} flipping`, revealed.glyph);

  const prevVis = cell.style.visibility;
  cell.style.visibility = 'hidden';
  ensureLayer(boardEl).appendChild(overlay);

  await wait(FLIP_MS);
  overlay.remove();
  cell.style.visibility = prevVis;
}

// Move animation: piece travels from srcRect (captured pre-render) to the
// destination cell's current rect. Caller must also supply the piece
// (color + glyph) — typically read from the post-state cells[to].
export async function animateMove(boardEl, srcRect, dstIdx, piece) {
  if (!areAnimationsEnabled() || !srcRect || !piece) return;
  const dst = cellAt(boardEl, dstIdx);
  if (!dst) return;
  const dstRect = dst.getBoundingClientRect();
  const colorClass = piece.color === 1 ? 'red' : 'black';
  const overlay = buildOverlay(boardEl, srcRect, `face-up ${colorClass}`, piece.glyph);
  overlay.style.transition = `transform ${MOVE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
  overlay.style.zIndex = '2';

  const prevVis = dst.style.visibility;
  dst.style.visibility = 'hidden';
  ensureLayer(boardEl).appendChild(overlay);

  // Trigger the transform on the next frame so the transition fires.
  await nextFrame();
  const dx = dstRect.left - srcRect.left;
  const dy = dstRect.top - srcRect.top;
  overlay.style.transform = `translate(${dx}px, ${dy}px)`;

  await wait(MOVE_MS);
  overlay.remove();
  dst.style.visibility = prevVis;
}

// Capture animation: the captured piece dissolves at idx. Runs in parallel
// with a move animation; the moving piece arrives just as the captured one
// fades, giving a causal feel.
export async function animateCapture(boardEl, idx, captured) {
  if (!areAnimationsEnabled() || !captured) return;
  const cell = cellAt(boardEl, idx);
  if (!cell) return;
  const rect = cell.getBoundingClientRect();
  const colorClass = captured.color === 1 ? 'red' : 'black';
  const overlay = buildOverlay(boardEl, rect, `face-up ${colorClass} dissolving`, captured.glyph);
  overlay.style.zIndex = '1';
  ensureLayer(boardEl).appendChild(overlay);
  await wait(CAPTURE_MS);
  overlay.remove();
}

// Convenience: given an event (flip/move) and the matching pre-captured
// source rect (for moves), play the right combo and resolve when done.
//
// For moves, the caller must also pass the piece info (color + glyph)
// because after re-render the source cell is empty, and we only know what
// piece it was from the prior state.
export async function playEventAnimation(boardEl, event, ctx = {}) {
  if (!areAnimationsEnabled() || !event?.action) return;
  const kind = event.action.kind;
  if (kind === 'flip') {
    await animateFlip(boardEl, event.action.to, event.revealed);
  } else if (kind === 'move') {
    const tasks = [];
    if (event.capture) tasks.push(animateCapture(boardEl, event.action.to, event.capture));
    tasks.push(animateMove(boardEl, ctx.srcRect, event.action.to, ctx.piece));
    await Promise.all(tasks);
  }
}

// ---- drag ghost (touch / mouse drag-to-move preview) -------------------
//
// Lives in the same overlay layer as the move/capture animations so it
// renders above cells but inside the board's clip. Ungated from
// `areAnimationsEnabled()` — a drag without visual feedback is broken, not
// "reduced motion".

export function spawnDragGhost(boardEl, srcRect, piece) {
  if (!boardEl || !srcRect || !piece) return null;
  const colorClass = piece.color === 1 ? 'red' : 'black';
  const overlay = buildOverlay(boardEl, srcRect, `face-up ${colorClass} drag-ghost`, piece.glyph);
  overlay.style.zIndex = '6';
  // Anchor it as if it's still at the source; subsequent moveDragGhost
  // calls translate it to follow the pointer.
  overlay._anchorX = srcRect.left + srcRect.width / 2;
  overlay._anchorY = srcRect.top + srcRect.height / 2;
  ensureLayer(boardEl).appendChild(overlay);
  return overlay;
}

export function moveDragGhost(ghostEl, clientX, clientY /* boardEl unused */) {
  if (!ghostEl) return;
  const dx = clientX - ghostEl._anchorX;
  const dy = clientY - ghostEl._anchorY;
  ghostEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function nextFrame() { return new Promise(r => requestAnimationFrame(() => r())); }
