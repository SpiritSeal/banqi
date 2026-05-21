// Pure-JS unit tests for the gesture state machine in web/board-input.js.
//
// The machine is pure: in -> events. No DOM, no timers. Tests drive it
// with synthetic pointer-event-shaped objects and assert the emitted event
// stream matches expectations.
//
// Run: node tests/board_input_unit.mjs

import { createGestureMachine } from '../web/board-input.js';

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Deep-equal good enough for plain event objects (no dates, regexes, etc.).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
function fmt(v) { return JSON.stringify(v); }
function checkEq(label, got, want) {
  check(label, deepEqual(got, want), `got=${fmt(got)} want=${fmt(want)}`);
}
function kinds(events) { return events.map(e => e.kind); }

// ---- Press / tap basics ------------------------------------------------

console.log('== press / tap ==');

{
  // Tap on a non-source cell (e.g. facedown piece that you'll flip).
  const m = createGestureMachine();
  const down = m.onDown({ pointerId: 1, cellIdx: 5, x: 100, y: 100, isDraggableSource: false });
  checkEq('non-source down emits press-start',
    down, [{ kind: 'press-start', cellIdx: 5 }]);
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 5, isLegalTarget: false });
  checkEq('non-source up emits press-end + tap',
    up, [{ kind: 'press-end', cellIdx: 5 }, { kind: 'tap', cellIdx: 5 }]);
}

{
  // Tap on a draggable source with no movement — still a tap, never a drag.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 50, y: 50, isDraggableSource: true });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 10, isLegalTarget: false });
  checkEq('source-down + immediate up = tap (no drag-start)',
    kinds(up), ['press-end', 'tap']);
}

{
  // Tap that drifts to a neighbouring cell on release should target the
  // release cell — matches `click` semantics.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 50, y: 50, isDraggableSource: false });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 11, isLegalTarget: false });
  const tap = up.find(e => e.kind === 'tap');
  check('tap targets release cell, not press cell', tap?.cellIdx === 11);
}

{
  // Release off the board falls back to the press cell so edge-slips still
  // register as a tap on what the user was aiming at.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 50, y: 50, isDraggableSource: false });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: null, isLegalTarget: false });
  const tap = up.find(e => e.kind === 'tap');
  check('release off-board falls back to press cell', tap?.cellIdx === 10);
}

{
  // Tap-outside-cells: no cell at press, no cell at release → tap with null
  // cellIdx (the DOM glue maps this to -1).
  const m = createGestureMachine();
  const down = m.onDown({ pointerId: 1, cellIdx: null, x: 5, y: 5, isDraggableSource: false });
  checkEq('press off-board does NOT emit press-start',
    down, []);
  const up = m.onUp({ pointerId: 1, cellUnderIdx: null, isLegalTarget: false });
  const tap = up.find(e => e.kind === 'tap');
  check('off-board press + off-board release emits tap(null)', tap?.cellIdx === null);
}

// ---- Threshold boundary ------------------------------------------------

console.log('\n== threshold boundary ==');

{
  // Default threshold = 8px. Strict greater-than: exactly 8px is still a tap.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  const at7 = m.onMove({ pointerId: 1, x: 107, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  check('7px movement does not start drag', !kinds(at7).includes('drag-start'));
  const at8 = m.onMove({ pointerId: 1, x: 108, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  check('exactly 8px movement does not start drag (strict >)',
    !kinds(at8).includes('drag-start'));
  const at9 = m.onMove({ pointerId: 1, x: 109, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  check('9px movement starts drag', kinds(at9).includes('drag-start'));
}

{
  // Threshold honoured on diagonal moves too.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  // 5,5 → max(5,5) = 5 ≤ 8 → tap
  const a = m.onMove({ pointerId: 1, x: 105, y: 105, cellUnderIdx: 10, isLegalTarget: false });
  check('diagonal 5px stays tap', !kinds(a).includes('drag-start'));
  // 0,9 → max(0,9) = 9 > 8 → drag
  const b = m.onMove({ pointerId: 1, x: 100, y: 109, cellUnderIdx: 10, isLegalTarget: false });
  check('vertical 9px starts drag', kinds(b).includes('drag-start'));
}

{
  // Threshold is configurable.
  const m = createGestureMachine({ dragThresholdPx: 20 });
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  const at15 = m.onMove({ pointerId: 1, x: 115, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  check('threshold=20: 15px stays tap', !kinds(at15).includes('drag-start'));
  const at21 = m.onMove({ pointerId: 1, x: 121, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  check('threshold=20: 21px starts drag', kinds(at21).includes('drag-start'));
}

{
  // A non-source pointer never enters drag mode even past the threshold.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 5, x: 100, y: 100, isDraggableSource: false });
  const a = m.onMove({ pointerId: 1, x: 200, y: 200, cellUnderIdx: 9, isLegalTarget: false });
  check('non-source: large move emits no drag-start', !kinds(a).includes('drag-start'));
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 9, isLegalTarget: false });
  check('non-source large-move release still emits tap', kinds(up).includes('tap'));
}

// ---- Drag flow ---------------------------------------------------------

console.log('\n== drag flow ==');

{
  // Happy path: drag from source to a legal target.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 120, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 11, isLegalTarget: true });
  check('happy drag up emits drag-leave then drag-move',
    deepEqual(up, [
      { kind: 'drag-leave', cellIdx: 11 },
      { kind: 'drag-move', from: 10, to: 11 },
    ]));
}

{
  // Drop onto an illegal cell — cancel.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 6, isLegalTarget: false });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 6, isLegalTarget: false });
  check('drop on illegal cell emits drag-cancel', kinds(up).includes('drag-cancel'));
  check('drop on illegal cell does NOT emit drag-move',
    !kinds(up).includes('drag-move'));
}

{
  // Drop off the board — cancel.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: null, isLegalTarget: false });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: null, isLegalTarget: false });
  check('drop off-board emits drag-cancel', kinds(up).includes('drag-cancel'));
}

{
  // Drag back to source, release on source — cancel (machine defensively
  // refuses src === dst even if caller reports it legal).
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  m.onMove({ pointerId: 1, x: 100, y: 100, cellUnderIdx: 10, isLegalTarget: true /* misreported */ });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 10, isLegalTarget: true });
  check('drop on source emits drag-cancel (defensive)',
    kinds(up).includes('drag-cancel') && !kinds(up).includes('drag-move'));
}

{
  // Hover transitions: A → B → C → A emits enter/leave pairs in order.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  const enterA = m.onMove({ pointerId: 1, x: 120, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  const enterB = m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 12, isLegalTarget: false });
  const enterC = m.onMove({ pointerId: 1, x: 200, y: 100, cellUnderIdx: 13, isLegalTarget: true });
  const backA  = m.onMove({ pointerId: 1, x: 120, y: 100, cellUnderIdx: 11, isLegalTarget: true });

  check('first move into a cell emits drag-enter',
    kinds(enterA).includes('drag-enter'));
  check('hovering a new cell emits leave-then-enter',
    kinds(enterB).slice(0, 2).join(',') === 'drag-leave,drag-enter');
  check('legality flag carried on drag-enter',
    enterB.find(e => e.kind === 'drag-enter')?.isLegalTarget === false);
  check('moving on to next cell continues leave-then-enter pattern',
    kinds(enterC).slice(0, 2).join(',') === 'drag-leave,drag-enter');
  check('returning to a previously-hovered cell re-emits enter',
    backA.find(e => e.kind === 'drag-enter')?.cellIdx === 11);
}

{
  // Pointer cancel mid-drag — cancel, never move.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  const c = m.onCancel({ pointerId: 1 });
  check('pointer cancel mid-drag emits drag-cancel',
    kinds(c).includes('drag-cancel') && !kinds(c).includes('drag-move'));
  // After cancel the machine is idle and a new gesture starts cleanly.
  const restart = m.onDown({ pointerId: 2, cellIdx: 0, x: 0, y: 0, isDraggableSource: false });
  check('machine returns to idle after cancel',
    deepEqual(restart, [{ kind: 'press-start', cellIdx: 0 }]));
}

{
  // Pointer cancel before threshold — press-end, no drag events.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  const c = m.onCancel({ pointerId: 1 });
  check('pre-drag cancel emits press-end only',
    deepEqual(c, [{ kind: 'press-end', cellIdx: 10 }]));
}

// ---- Multi-pointer handling --------------------------------------------

console.log('\n== multi-pointer ==');

{
  // Secondary pointer is ignored while primary is active.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  const secondary = m.onDown({ pointerId: 2, cellIdx: 20, x: 200, y: 200, isDraggableSource: true });
  checkEq('secondary down returns empty events', secondary, []);

  const moveOther = m.onMove({ pointerId: 2, x: 250, y: 250, cellUnderIdx: 21, isLegalTarget: true });
  checkEq('move from secondary ignored', moveOther, []);

  const upOther = m.onUp({ pointerId: 2, cellUnderIdx: 21, isLegalTarget: true });
  checkEq('up from secondary ignored', upOther, []);

  // Primary still completes normally.
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 11, isLegalTarget: true });
  check('primary still completes drag-move', kinds(up).includes('drag-move'));
}

// ---- Edge cases --------------------------------------------------------

console.log('\n== edge cases ==');

{
  // No active pointer at all: move/up/cancel are no-ops.
  const m = createGestureMachine();
  checkEq('move with no active = []',
    m.onMove({ pointerId: 1, x: 0, y: 0, cellUnderIdx: null, isLegalTarget: false }), []);
  checkEq('up with no active = []',
    m.onUp({ pointerId: 1, cellUnderIdx: null, isLegalTarget: false }), []);
  checkEq('cancel with no active = []',
    m.onCancel({ pointerId: 1 }), []);
}

{
  // Drag that re-enters the source cell mid-flight emits leave for whatever
  // was hovered before — and the next legal release works.
  const m = createGestureMachine();
  m.onDown({ pointerId: 1, cellIdx: 10, x: 100, y: 100, isDraggableSource: true });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  m.onMove({ pointerId: 1, x: 100, y: 100, cellUnderIdx: 10, isLegalTarget: false });
  m.onMove({ pointerId: 1, x: 160, y: 100, cellUnderIdx: 11, isLegalTarget: true });
  const up = m.onUp({ pointerId: 1, cellUnderIdx: 11, isLegalTarget: true });
  check('back-and-forth then drop on legal target still moves',
    kinds(up).includes('drag-move'));
}

// ---- summary ----

console.log(`\nboard_input unit: ${failed === 0 ? 'OK' : `${failed} failure(s)`}`);
if (failed > 0) process.exit(1);
