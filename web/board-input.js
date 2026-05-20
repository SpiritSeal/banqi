// Touch/mouse/pen input for the board.
//
// Two layers:
//   1. `createGestureMachine` — pure state machine. No DOM, no timers. Given
//      pointer events as data, it emits semantic events like 'tap',
//      'drag-start', 'drag-move'. Unit-tested in tests/board_input_unit.mjs.
//   2. `bindBoardInput` — DOM glue. Wires a board element to the machine,
//      manages pointer capture, the drag ghost overlay, and CSS classes.
//
// The split lets us add tap/drag/visual-feedback behavior without making
// renderBoard any bigger, and lets the gesture rules be tested in isolation.
//
// Gesture rules:
//   - Tap on any cell  → 'tap'.
//   - Press on a draggable source, move past `dragThresholdPx`, release on
//     a legal target → 'drag-move'. Anywhere else → 'drag-cancel'.
//   - Secondary pointers are ignored while a primary pointer is captured.
//   - Movement under the threshold is still a tap (handles wobbly fingers).

import { spawnDragGhost, moveDragGhost } from './animations.js';

const DEFAULT_THRESHOLD_PX = 8;

// Pure state machine. State: { active: null | { pointerId, startX, startY,
// cellIdx, isDraggableSource, dragging, lastHoverIdx } }. All methods return
// an array of event objects so callers can drive side effects deterministically.
export function createGestureMachine({ dragThresholdPx = DEFAULT_THRESHOLD_PX } = {}) {
  let active = null;
  const threshold = dragThresholdPx;

  function reset() { active = null; }

  function onDown({ pointerId, cellIdx, x, y, isDraggableSource }) {
    if (active) return [];
    active = {
      pointerId, startX: x, startY: y,
      cellIdx, isDraggableSource: !!isDraggableSource,
      dragging: false, lastHoverIdx: null,
    };
    if (cellIdx == null) return [];
    return [{ kind: 'press-start', cellIdx }];
  }

  function onMove({ pointerId, x, y, cellUnderIdx, isLegalTarget }) {
    if (!active || active.pointerId !== pointerId) return [];
    const events = [];
    if (!active.dragging) {
      // Strict greater-than: a move of exactly `threshold` px is still a tap,
      // which makes the boundary easy to reason about in tests.
      const dx = x - active.startX;
      const dy = y - active.startY;
      if (active.isDraggableSource && (Math.abs(dx) > threshold || Math.abs(dy) > threshold)) {
        active.dragging = true;
        events.push({ kind: 'drag-start', cellIdx: active.cellIdx });
      } else {
        return events;
      }
    }
    // We're dragging. Track hover transitions for visual feedback.
    if (cellUnderIdx !== active.lastHoverIdx) {
      if (active.lastHoverIdx != null) {
        events.push({ kind: 'drag-leave', cellIdx: active.lastHoverIdx });
      }
      if (cellUnderIdx != null) {
        events.push({ kind: 'drag-enter', cellIdx: cellUnderIdx, isLegalTarget: !!isLegalTarget });
      }
      active.lastHoverIdx = cellUnderIdx;
    }
    events.push({ kind: 'drag-pos', x, y });
    return events;
  }

  function onUp({ pointerId, cellUnderIdx, isLegalTarget }) {
    if (!active || active.pointerId !== pointerId) return [];
    const events = [];
    if (active.dragging) {
      if (active.lastHoverIdx != null) {
        events.push({ kind: 'drag-leave', cellIdx: active.lastHoverIdx });
      }
      if (cellUnderIdx != null && isLegalTarget && cellUnderIdx !== active.cellIdx) {
        events.push({ kind: 'drag-move', from: active.cellIdx, to: cellUnderIdx });
      } else {
        events.push({ kind: 'drag-cancel', cellIdx: active.cellIdx });
      }
    } else {
      events.push({ kind: 'press-end', cellIdx: active.cellIdx });
      // Tap targets the cell under release — matches `click` semantics for
      // pointers that drifted onto a neighbour. If release left the board,
      // fall back to the original press cell so accidental edge-slips still
      // register as a tap on what the user was aiming at.
      const tapIdx = cellUnderIdx != null ? cellUnderIdx : active.cellIdx;
      events.push({ kind: 'tap', cellIdx: tapIdx });
    }
    reset();
    return events;
  }

  function onCancel({ pointerId }) {
    if (!active || active.pointerId !== pointerId) return [];
    const events = [];
    if (active.dragging) {
      if (active.lastHoverIdx != null) {
        events.push({ kind: 'drag-leave', cellIdx: active.lastHoverIdx });
      }
      events.push({ kind: 'drag-cancel', cellIdx: active.cellIdx });
    } else {
      events.push({ kind: 'press-end', cellIdx: active.cellIdx });
    }
    reset();
    return events;
  }

  return { onDown, onMove, onUp, onCancel, _peek: () => active };
}

// ---- DOM glue ----------------------------------------------------------

function cellIdxFromEvent(boardEl, ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!el) return null;
  const cell = el.closest('[data-cell-index]');
  if (!cell || cell.parentElement !== boardEl) return null;
  const n = parseInt(cell.dataset.cellIndex, 10);
  return Number.isNaN(n) ? null : n;
}

function cellNodeAt(boardEl, idx) {
  if (idx == null) return null;
  return boardEl.querySelector(`[data-cell-index="${idx}"]`);
}

// Wires `boardEl` to the gesture machine. Idempotent per element.
//
// Callbacks:
//   onTap(idx)              — tap on cell idx, or idx === -1 for tap-outside.
//   onDragMove(from, to)    — drag released on a legal target.
//   getDragSource(idx)      — returns truthy ({piece, srcRect}) if the cell
//                             at idx is a draggable source for the current
//                             player; null otherwise.
//   isLegalTarget(from, to) — true iff `from→to` is a legal move right now.
export function bindBoardInput(boardEl, callbacks) {
  if (boardEl.dataset.pointerNav === '1') {
    // Idempotent: update the callbacks but don't re-attach listeners.
    boardEl._touchCallbacks = callbacks;
    return;
  }
  boardEl.dataset.pointerNav = '1';
  boardEl._touchCallbacks = callbacks;

  const machine = createGestureMachine();
  let ghost = null;
  let hoverCellNode = null;
  let pressCellNode = null;

  function clearPress() {
    if (pressCellNode) {
      pressCellNode.classList.remove('is-pressing');
      pressCellNode = null;
    }
  }
  function clearHover() {
    if (hoverCellNode) {
      hoverCellNode.classList.remove('drag-over-legal', 'drag-over-illegal');
      hoverCellNode = null;
    }
  }
  function clearGhost() {
    if (ghost) { ghost.remove(); ghost = null; }
    const src = boardEl.querySelector('.cell.is-dragging');
    if (src) src.classList.remove('is-dragging');
  }
  function teardown() { clearPress(); clearHover(); clearGhost(); }

  function applyEvents(events) {
    const cbs = boardEl._touchCallbacks;
    for (const ev of events) {
      switch (ev.kind) {
        case 'press-start': {
          const node = cellNodeAt(boardEl, ev.cellIdx);
          if (node) { node.classList.add('is-pressing'); pressCellNode = node; }
          break;
        }
        case 'press-end':
          clearPress();
          break;
        case 'tap': {
          // Tap-outside-cells maps to -1 (deselect convention shared with
          // the click handlers in main.js).
          cbs.onTap(ev.cellIdx == null ? -1 : ev.cellIdx);
          break;
        }
        case 'drag-start': {
          clearPress();
          const src = cellNodeAt(boardEl, ev.cellIdx);
          const dragInfo = cbs.getDragSource(ev.cellIdx);
          if (src && dragInfo) {
            src.classList.add('is-dragging');
            ghost = spawnDragGhost(boardEl, dragInfo.srcRect, dragInfo.piece);
          }
          break;
        }
        case 'drag-enter': {
          const node = cellNodeAt(boardEl, ev.cellIdx);
          if (node) {
            node.classList.add(ev.isLegalTarget ? 'drag-over-legal' : 'drag-over-illegal');
            hoverCellNode = node;
          }
          break;
        }
        case 'drag-leave':
          clearHover();
          break;
        case 'drag-pos':
          if (ghost) moveDragGhost(ghost, ev.x, ev.y, boardEl);
          break;
        case 'drag-move':
          teardown();
          cbs.onDragMove(ev.from, ev.to);
          break;
        case 'drag-cancel':
          teardown();
          // No state change — but we may need a refresh to clear any stale
          // visuals. `onTap(-1)` deselects in the existing handlers, which
          // also refreshes the render.
          cbs.onTap(-1);
          break;
      }
    }
  }

  boardEl.addEventListener('pointerdown', (ev) => {
    // Ignore secondary mouse buttons; only left-click and touch/pen taps.
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const idx = cellIdxFromEvent(boardEl, ev);
    const cbs = boardEl._touchCallbacks;
    const dragInfo = idx != null ? cbs.getDragSource(idx) : null;
    const events = machine.onDown({
      pointerId: ev.pointerId,
      cellIdx: idx,
      x: ev.clientX, y: ev.clientY,
      isDraggableSource: !!dragInfo,
    });
    if (events.length) {
      try { boardEl.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      // Stop the synthetic click from also firing on the cell (we handle
      // taps via pointerup); also keeps mobile browsers from focusing wrong
      // elements. Don't preventDefault on pointerdown — that breaks
      // setPointerCapture in some browsers.
    }
    applyEvents(events);
  });

  boardEl.addEventListener('pointermove', (ev) => {
    const cbs = boardEl._touchCallbacks;
    const active = machine._peek();
    if (!active || active.pointerId !== ev.pointerId) return;
    const idx = cellIdxFromEvent(boardEl, ev);
    const legal = (active.dragging || active.isDraggableSource) && idx != null
      ? cbs.isLegalTarget(active.cellIdx, idx)
      : false;
    const events = machine.onMove({
      pointerId: ev.pointerId,
      x: ev.clientX, y: ev.clientY,
      cellUnderIdx: idx,
      isLegalTarget: legal,
    });
    applyEvents(events);
  });

  function endPointer(ev) {
    const cbs = boardEl._touchCallbacks;
    const active = machine._peek();
    if (!active || active.pointerId !== ev.pointerId) return;
    const idx = cellIdxFromEvent(boardEl, ev);
    const legal = active.dragging && idx != null
      ? cbs.isLegalTarget(active.cellIdx, idx)
      : false;
    const events = machine.onUp({
      pointerId: ev.pointerId,
      cellUnderIdx: idx,
      isLegalTarget: legal,
    });
    try { boardEl.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    applyEvents(events);
  }
  boardEl.addEventListener('pointerup', endPointer);

  function cancelPointer(ev) {
    const active = machine._peek();
    if (!active || active.pointerId !== ev.pointerId) return;
    const events = machine.onCancel({ pointerId: ev.pointerId });
    try { boardEl.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    applyEvents(events);
  }
  boardEl.addEventListener('pointercancel', cancelPointer);
  boardEl.addEventListener('lostpointercapture', cancelPointer);

  // Click handler serves two purposes:
  //   1. Suppress the synthetic click that follows every pointerup on a
  //      <button> cell — we already emitted 'tap' from the pointer machine.
  //   2. Route keyboard-induced clicks (Enter/Space on a focused cell) to
  //      onTap, since we no longer attach per-cell click listeners.
  //
  // The distinguisher is `MouseEvent.detail`: keyboard-fired clicks always
  // have detail === 0, while pointer-fired clicks have detail >= 1.
  boardEl.addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-cell-index]');
    if (!cell || cell.parentElement !== boardEl) return;
    if (ev.detail >= 1) {
      // Pointer-initiated click — already handled via the gesture machine.
      ev.preventDefault();
      return;
    }
    const idx = parseInt(cell.dataset.cellIndex, 10);
    if (!Number.isNaN(idx)) boardEl._touchCallbacks.onTap(idx);
  });
}
