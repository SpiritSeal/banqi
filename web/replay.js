// Notation, signed-transcript history, and step-through replay.
//
// Used by every play mode (federated, OTB, vs-AI, classic P2P). The Replay
// instance lives alongside an active Game and incrementally captures a
// snapshot of cells / terminal state after each transcript entry resolves.
// Viewing a past snapshot is read-only — no calls into the C++ Game — so
// scrolling back during a live game cannot cause takebacks.
//
// Snapshot timing:
//   * Local action       → pushPending(action, mover), call game.local*(...),
//                          then observe(state).
//   * Inbound message    → if it's a MOVE_ENTRY, pushPending; call
//                          game.handleMessage(line); then observe(state).
//   * Reveal completes   → observe(state) refreshes the latest snapshot's
//                          cells so a mid-flip crypto-mode entry gets its
//                          post-flip cells once both keys arrive.

const COL_LABELS = 'abcdefgh';

export function coord(idx) {
  if (idx == null || idx < 0 || idx >= 32) return '?';
  const col = idx % 8;
  const row = Math.floor(idx / 8);
  return COL_LABELS[col] + (row + 1);
}

// Normalize a MOVE_ENTRY payload (or parsed object) into a uniform shape.
// The C++ side encodes flip actions with `cell` rather than `to`
// (messages.hpp encode_move_action); we coerce to `to` so downstream
// snapshot / notation code can treat all flips identically.
export function normalizeAction(payloadOrObj) {
  const a = typeof payloadOrObj === 'string'
    ? (() => { try { return JSON.parse(payloadOrObj); } catch (_) { return null; } })()
    : payloadOrObj;
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'flip') {
    const to = a.to ?? a.cell;
    if (to === undefined || to === null) return null;
    return { kind: 'flip', to };
  }
  if (a.kind === 'move') {
    if (a.from === undefined || a.to === undefined) return null;
    return { kind: 'move', from: a.from, to: a.to };
  }
  if (a.kind === 'resign') return { kind: 'resign' };
  return null;
}

function cloneCells(cells) {
  return cells.map((c) => ({ ...c }));
}

function inferCapture(action, beforeCells) {
  if (!action || action.kind !== 'move') return null;
  const dst = beforeCells?.[action.to];
  if (!dst || dst.state === 'empty') return null;
  if (dst.state === 'facedown') return { facedown: true };
  return {
    facedown: false,
    color: dst.color,
    type: dst.type,
    glyph: dst.glyph,
  };
}

function isCannonJump(action) {
  if (!action || action.kind !== 'move') return false;
  const dr = Math.abs(Math.floor(action.from / 8) - Math.floor(action.to / 8));
  const dc = Math.abs((action.from % 8) - (action.to % 8));
  return dr + dc > 1;
}

const PIECE_NAME = [
  '',
  'Soldier',
  'Cannon',
  'Horse',
  'Chariot',
  'Elephant',
  'Advisor',
  'General',
];

function colorWord(c) {
  return c === 1 ? 'Red' : c === 2 ? 'Black' : '';
}

function pieceName(cell) {
  if (!cell || cell.state !== 'faceup') return '';
  return `${colorWord(cell.color)} ${PIECE_NAME[cell.type] || ''}`.trim();
}

// Build the human-readable parts of a transcript row.
//   primary : "b3 ↑ 帥"     |  "a2-a3"  |  "b3×c3"  |  "Resign"
//   detail  : "Red General" |  ""        |  "(× 將)"  |  ""
//   piece   : optional moving-piece glyph for move/capture rows
//   jump    : true iff this is a cannon jump
export function formatAction(snap, prevCells, initialCells) {
  const a = snap.action || {};
  const before = prevCells || initialCells || null;

  if (a.kind === 'flip') {
    const revealed = snap.cellsAfter[a.to];
    const glyph = revealed && revealed.state === 'faceup' ? revealed.glyph : '?';
    return {
      primary: `${coord(a.to)} ↑ ${glyph}`,
      detail: pieceName(revealed),
      piece: '',
      jump: false,
    };
  }
  if (a.kind === 'move') {
    const captured = snap.captured;
    const jump = isCannonJump(a);
    const op = captured ? '×' : '–';
    const piece = before?.[a.from];
    const moverGlyph = piece && piece.state === 'faceup' ? piece.glyph : '';
    let detail = '';
    if (captured) {
      detail = captured.facedown
        ? '(× ?)'
        : `(× ${captured.glyph})`;
    }
    return {
      primary: `${coord(a.from)}${op}${coord(a.to)}`,
      detail,
      piece: moverGlyph,
      jump,
    };
  }
  if (a.kind === 'resign') {
    return { primary: 'Resign', detail: '', piece: '', jump: false };
  }
  return { primary: '(unknown)', detail: '', piece: '', jump: false };
}

export class Replay {
  constructor() {
    this.snapshots = []; // { seq, action, mover, cellsAfter, captured, gameOver, winner }
    this.viewIndex = null; // null = live; -1 = before any move; else snapshot index
    this._lastSeq = 0;
    this._initialCells = null;
    this._pending = []; // FIFO of { action, mover }
  }

  reset() {
    this.snapshots = [];
    this.viewIndex = null;
    this._lastSeq = 0;
    this._initialCells = null;
    this._pending = [];
  }

  // Announce an action that's about to be appended to the transcript.
  pushPending(action, mover) {
    this._pending.push({ action, mover });
  }

  // Cancel the most-recently-pushed pending entry (call after a failed action).
  dropPending() {
    this._pending.pop();
  }

  // Reconcile snapshots with the latest game state.
  observe(state) {
    if (!state || !Array.isArray(state.cells)) return;
    if (this._initialCells === null) {
      this._initialCells = cloneCells(state.cells);
    }

    // Catch up: each unit of seq growth consumes one pending entry.
    while (state.transcript_seq > this._lastSeq) {
      const pending = this._pending.shift() || {};
      const action = pending.action || { kind: 'unknown' };
      const mover = pending.mover ?? -1;
      const beforeCells = this.snapshots.length === 0
        ? this._initialCells
        : this.snapshots[this.snapshots.length - 1].cellsAfter;
      this.snapshots.push({
        seq: this._lastSeq,
        action,
        mover,
        cellsAfter: cloneCells(state.cells),
        captured: inferCapture(action, beforeCells),
        gameOver: !!state.game_over,
        winner: state.winner || 0,
      });
      this._lastSeq += 1;
    }

    // Refresh the latest snapshot's cells. This is where crypto-mode reveals
    // post-MOVE_ENTRY land — the seq is unchanged but cells have updated.
    if (this.snapshots.length > 0) {
      const last = this.snapshots[this.snapshots.length - 1];
      last.cellsAfter = cloneCells(state.cells);
      last.gameOver = !!state.game_over;
      last.winner = state.winner || 0;
    }
  }

  isLive() {
    return this.viewIndex == null;
  }

  totalMoves() {
    return this.snapshots.length;
  }

  // 0 = initial position; N = after move N (1-indexed).
  currentStep() {
    if (this.viewIndex == null) return this.snapshots.length;
    if (this.viewIndex < 0) return 0;
    return this.viewIndex + 1;
  }

  cellsFor(liveCells) {
    if (this.viewIndex == null) return liveCells;
    if (this.viewIndex < 0) return this._initialCells || liveCells;
    return this.snapshots[this.viewIndex].cellsAfter;
  }

  finalityFor(liveState) {
    if (this.viewIndex == null) {
      return { game_over: !!liveState.game_over, winner: liveState.winner || 0 };
    }
    if (this.viewIndex < 0) return { game_over: false, winner: 0 };
    const s = this.snapshots[this.viewIndex];
    return { game_over: !!s.gameOver, winner: s.winner || 0 };
  }

  goLive() {
    this.viewIndex = null;
  }
  goFirst() {
    if (this.snapshots.length > 0) this.viewIndex = -1;
  }
  goPrev() {
    const s = this.currentStep();
    if (s <= 0) return;
    this.goToStep(s - 1);
  }
  goNext() {
    const s = this.currentStep();
    const N = this.snapshots.length;
    if (s >= N) return;
    this.goToStep(s + 1);
  }
  goLast() {
    this.goLive();
  }
  goToStep(step) {
    const N = this.snapshots.length;
    if (step <= 0) this.viewIndex = -1;
    else if (step >= N) this.viewIndex = null;
    else this.viewIndex = step - 1;
  }
}

// Render the transcript panel + replay controls into `container`. Re-renders
// from scratch each call; cheap relative to the C++ work.
//
//   replay        : Replay instance
//   container     : DOM element (will be cleared & rewritten)
//   opts.onJump   : (step:number) => void   called when user clicks a row
//                                            or a control (0..N).
export function renderTranscript(container, replay, opts = {}) {
  if (!container) return;
  const N = replay.totalMoves();
  const step = replay.currentStep();
  const live = replay.isLive();
  const prevCells = (i) =>
    i === 0 ? replay._initialCells : replay.snapshots[i - 1]?.cellsAfter;

  const header = `
    <div class="transcript-head">
      <h3 id="transcript-heading">Transcript</h3>
      <div class="transcript-controls" role="group" aria-label="Replay navigation">
        <button data-jump="first" type="button" aria-label="Go to initial position" ${N === 0 || step === 0 ? 'disabled' : ''} title="Initial position">|◀</button>
        <button data-jump="prev"  type="button" aria-label="Previous move" ${step === 0 ? 'disabled' : ''} title="Previous move">◀</button>
        <span class="transcript-step" aria-live="polite">${N === 0 ? 'no moves' : (live ? `live (${N}/${N})` : `${step}/${N}`)}</span>
        <button data-jump="next"  type="button" aria-label="Next move" ${live || N === 0 ? 'disabled' : ''} title="Next move">▶</button>
        <button data-jump="last"  type="button" aria-label="Latest position (live)" ${live || N === 0 ? 'disabled' : ''} title="Latest / Live">▶|</button>
      </div>
    </div>`;

  let rows;
  if (N === 0) {
    rows = `<div class="transcript-empty muted">No moves yet — the move list will fill in as the game progresses.</div>`;
  } else {
    const items = replay.snapshots.map((s, i) => {
      const parts = formatAction(s, prevCells(i), replay._initialCells);
      const isCurrent = !live && replay.viewIndex === i;
      const moverCls = s.mover === 0 ? 'mover-p1' : s.mover === 1 ? 'mover-p2' : '';
      const moverLbl = s.mover === 0 ? 'P1' : s.mover === 1 ? 'P2' : '?';
      const moverFull = s.mover === 0 ? 'Player 1' : s.mover === 1 ? 'Player 2' : 'Unknown player';
      const cls = [
        'transcript-row',
        isCurrent ? 'current' : '',
        s.action?.kind === 'resign' ? 'resign' : '',
      ].filter(Boolean).join(' ');
      const jumpLabel = parts.jump ? '<span class="badge jump" aria-label="cannon jump">jump</span>' : '';
      const piece = parts.piece ? `<span class="t-piece" aria-hidden="true">${parts.piece}</span>` : '';
      const detail = parts.detail ? `<span class="t-detail">${escapeHtml(parts.detail)}</span>` : '';
      const screenLabel = `Move ${i + 1}, ${moverFull}: ${parts.primary}${parts.detail ? ', ' + parts.detail : ''}${parts.jump ? ', cannon jump' : ''}`;
      return `
        <button class="${cls}" data-step="${i + 1}" type="button"
                aria-label="${escapeHtml(screenLabel)}"
                ${isCurrent ? 'aria-current="true"' : ''}>
          <span class="t-num" aria-hidden="true">${i + 1}.</span>
          <span class="t-mover ${moverCls}" aria-hidden="true">${moverLbl}</span>
          ${piece}
          <span class="t-notation" aria-hidden="true">${escapeHtml(parts.primary)}</span>
          ${jumpLabel}
          ${detail}
        </button>`;
    }).join('');
    rows = `<div class="transcript-list" role="list" aria-labelledby="transcript-heading">${items}</div>`;
  }

  const banner = live
    ? ''
    : `<div class="replay-banner" role="status">Reviewing move ${step} of ${N}.
         <button class="link-btn" data-jump="last" type="button">Return to live →</button></div>`;

  container.innerHTML = `${banner}${header}${rows}`;

  const onJump = opts.onJump || (() => {});
  for (const btn of container.querySelectorAll('[data-jump]')) {
    btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-jump');
      if (k === 'first') onJump(0);
      else if (k === 'prev') onJump(Math.max(0, replay.currentStep() - 1));
      else if (k === 'next') onJump(replay.currentStep() + 1);
      else if (k === 'last') onJump(N);
    });
  }
  for (const row of container.querySelectorAll('[data-step]')) {
    row.addEventListener('click', () => {
      const step = parseInt(row.getAttribute('data-step'), 10) || 0;
      onJump(step);
    });
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
