// Notation + step-through replay.
//
// Drives off server-emitted event objects (or, in OTB / vs-AI, locally
// produced ones with the same shape). Each event has:
//   { seq, ts, mover, action: {kind, from?, to?}, revealed?, capture?,
//     game_over, winner }
//
// The Replay walks events forward from an initial all-face-down board to
// reconstruct cellsAfter for every step. This lets the transcript UI scroll
// back through past positions without needing the WASM engine to re-execute.

const COL_LABELS = 'abcdefgh';

export function coord(idx) {
  if (idx == null || idx < 0 || idx >= 32) return '?';
  const col = idx % 8;
  const row = Math.floor(idx / 8);
  return COL_LABELS[col] + (row + 1);
}

const PIECE_NAME = ['', 'Soldier', 'Cannon', 'Horse', 'Chariot', 'Elephant', 'Advisor', 'General'];

function colorWord(c) { return c === 1 ? 'Red' : c === 2 ? 'Black' : ''; }

function pieceName(cell) {
  if (!cell || cell.state !== 'faceup') return '';
  return `${colorWord(cell.color)} ${PIECE_NAME[cell.type] || ''}`.trim();
}

export const ZH_GLYPH = {
  1: { 1: '兵', 2: '炮', 3: '傌', 4: '俥', 5: '相', 6: '仕', 7: '帥' },
  2: { 1: '卒', 2: '砲', 3: '馬', 4: '車', 5: '象', 6: '士', 7: '將' },
};
function pieceCell(piece) {
  return {
    state: 'faceup',
    color: piece.color,
    type: piece.type,
    glyph: ZH_GLYPH[piece.color]?.[piece.type] || '?',
    ascii: '',
  };
}

export function initialCells() {
  return Array.from({ length: 32 }, () => ({ state: 'facedown' }));
}

// Mutates `cells` in place by applying event.action.
export function applyEventToCells(cells, event) {
  const a = event.action || {};
  if (a.kind === 'flip') {
    if (event.revealed) cells[a.to] = pieceCell(event.revealed);
  } else if (a.kind === 'move') {
    cells[a.to] = cells[a.from];
    cells[a.from] = { state: 'empty' };
  }
  // resign: no board change
  return cells;
}

function isCannonJump(action) {
  if (!action || action.kind !== 'move') return false;
  const dr = Math.abs(Math.floor(action.from / 8) - Math.floor(action.to / 8));
  const dc = Math.abs((action.from % 8) - (action.to % 8));
  return dr + dc > 1;
}

// Human-readable parts of a transcript row.
export function formatAction(snap, prevCells) {
  const a = snap.action || {};
  if (a.kind === 'flip') {
    const revealed = snap.cellsAfter[a.to];
    const glyph = revealed && revealed.state === 'faceup' ? revealed.glyph : '?';
    return { primary: `${coord(a.to)} ↑ ${glyph}`, detail: pieceName(revealed), piece: '', jump: false };
  }
  if (a.kind === 'move') {
    const cap = snap.capture;
    const jump = isCannonJump(a);
    const op = cap ? '×' : '–';
    const piece = prevCells?.[a.from];
    const moverGlyph = piece && piece.state === 'faceup' ? piece.glyph : '';
    let detail = '';
    if (cap) detail = `(× ${cap.glyph || '?'})`;
    return { primary: `${coord(a.from)}${op}${coord(a.to)}`, detail, piece: moverGlyph, jump };
  }
  if (a.kind === 'resign') {
    return { primary: 'Resign', detail: '', piece: '', jump: false };
  }
  return { primary: '(unknown)', detail: '', piece: '', jump: false };
}

export class Replay {
  constructor() {
    this.snapshots = [];      // { event, cellsAfter, gameOver, winner }
    this.viewIndex = null;    // null = live; -1 = before any move; else snapshot index
    this._initialCells = initialCells();
    this._cells = initialCells();
  }

  reset() {
    this.snapshots = [];
    this.viewIndex = null;
    this._initialCells = initialCells();
    this._cells = initialCells();
  }

  // Replace the full event history (used on initial snapshot + reconnect).
  setEvents(events) {
    this.snapshots = [];
    this._cells = initialCells();
    for (const e of events) this.appendEvent(e);
  }

  // Append a single event. Walks its action through the running cell state.
  appendEvent(event) {
    const cellsBefore = this._cells.map((c) => ({ ...c }));
    applyEventToCells(this._cells, event);
    this.snapshots.push({
      event,
      action: event.action,
      mover: event.mover,
      capture: event.capture || null,
      cellsBefore,
      cellsAfter: this._cells.map((c) => ({ ...c })),
      gameOver: !!event.game_over,
      winner: event.winner || 0,
    });
  }

  isLive()    { return this.viewIndex == null; }
  totalMoves(){ return this.snapshots.length; }
  currentStep() {
    if (this.viewIndex == null) return this.snapshots.length;
    if (this.viewIndex < 0) return 0;
    return this.viewIndex + 1;
  }

  cellsFor(liveCells) {
    if (this.viewIndex == null) return liveCells;
    if (this.viewIndex < 0) return this._initialCells;
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

  lastMoveCells() {
    if (this.snapshots.length === 0) return null;
    const snap = this.snapshots[this.snapshots.length - 1];
    const a = snap.action || {};
    if (a.kind === 'move') return { from: a.from, to: a.to };
    if (a.kind === 'flip') return { from: -1, to: a.to };
    return null;
  }

  goLive()  { this.viewIndex = null; }
  goFirst() { if (this.snapshots.length > 0) this.viewIndex = -1; }
  goPrev()  { const s = this.currentStep(); if (s > 0) this.goToStep(s - 1); }
  goNext()  { const s = this.currentStep(); if (s < this.snapshots.length) this.goToStep(s + 1); }
  goLast()  { this.goLive(); }
  goToStep(step) {
    const N = this.snapshots.length;
    if (step <= 0) this.viewIndex = -1;
    else if (step >= N) this.viewIndex = null;
    else this.viewIndex = step - 1;
  }
}

// Render the transcript panel + replay controls into `container`. Cheap.
//
//   replay     : Replay instance
//   container  : DOM element (will be cleared & rewritten)
//   opts.onJump: (step:number) => void
export function renderTranscript(container, replay, opts = {}) {
  if (!container) return;
  const N = replay.totalMoves();
  const step = replay.currentStep();
  const live = replay.isLive();

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
      const parts = formatAction(s, s.cellsBefore);
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
