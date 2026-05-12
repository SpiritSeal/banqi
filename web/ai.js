// Banqi AI engine.
//
// Provides move selection at three difficulty levels using a pure-JS
// board simulator for lookahead. Real moves are executed through the
// WASM Game API in main.js.
//
// Difficulty levels:
//   EASY   – random move with light preference for captures
//   MEDIUM – 1-ply greedy: maximises immediate material gain, penalises exposure
//   HARD   – alpha-beta minimax (depth 4) over N determinisations of unknown pieces

export const Difficulty = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard' };

// Piece type constants (match C++ PieceType enum values)
const SOLDIER=1, CANNON=2, HORSE=3, CHARIOT=4, ELEPHANT=5, ADVISOR=6, GENERAL=7;
const RED=1, BLACK=2;
const ROWS=4, COLS=8, CELLS=32;
const DR=[-1,1,0,0], DC=[0,0,-1,1];

const rowOf = i => (i / COLS) | 0;
const colOf = i => i % COLS;
const rcIdx = (r, c) => r * COLS + c;

// Piece material values
const PIECE_VALUE = [0, 100, 200, 300, 400, 500, 600, 700];
// index = piece type (0 unused, 1=Soldier … 7=General)

function canCapture(atk, vic) {
  if (!atk || !vic || atk.color === vic.color) return false;
  if (atk.type === CANNON) return false;  // cannons never capture orthogonally
  if (atk.type === GENERAL && vic.type === SOLDIER) return false;
  if (atk.type === SOLDIER && vic.type === GENERAL) return true;
  return atk.type >= vic.type;
}

// ---------------------------------------------------------------------------
// Board – lightweight mutable board for simulation.
//
// Cell representation:
//   null                              → empty
//   { fd: true, hp?: {color, type} } → face-down (hp = hidden piece, set after determinisation)
//   { color: int, type: int }         → face-up piece
// ---------------------------------------------------------------------------
class Board {
  constructor() {
    this.cells = new Array(CELLS).fill(null);
    this.firstFlipDone = false;
    this.sidePlayer = 0;       // player index (0 or 1) whose turn it is
    this.playerColors = [0, 0]; // resolved color for each player (0 = unassigned)
    this.over = false;
    this.winner = 0;
  }

  clone() {
    const b = new Board();
    b.cells = this.cells.map(c => {
      if (!c) return null;
      if (c.fd) return c.hp ? { fd: true, hp: { color: c.hp.color, type: c.hp.type } } : { fd: true };
      return { color: c.color, type: c.type };
    });
    b.firstFlipDone = this.firstFlipDone;
    b.sidePlayer = this.sidePlayer;
    b.playerColors = [...this.playerColors];
    b.over = this.over;
    b.winner = this.winner;
    return b;
  }

  // Build from a WASM stateJson() parsed object.
  static fromState(state) {
    const b = new Board();
    b.firstFlipDone = state.first_flip_done;
    b.sidePlayer = state.side_to_move;
    b.over = state.game_over;
    b.winner = state.winner;
    const mi = state.my_player_index;
    const mc = state.my_color;
    if (mc) {
      b.playerColors[mi] = mc;
      b.playerColors[1 - mi] = mc === RED ? BLACK : RED;
    }
    for (let i = 0; i < CELLS; i++) {
      const c = state.cells[i];
      if (c.state === 'empty')    b.cells[i] = null;
      else if (c.state === 'facedown') b.cells[i] = { fd: true };
      else b.cells[i] = { color: c.color, type: c.type };
    }
    return b;
  }

  // ---- Move generation (mirrors C++ BanqiRules::legal_moves) ----
  legalMoves(playerIndex) {
    if (this.over || playerIndex !== this.sidePlayer) return [];
    const out = [];

    // Flips
    for (let i = 0; i < CELLS; i++) {
      if (this.cells[i]?.fd) out.push({ from: -1, to: i });
    }

    const mc = this.playerColors[playerIndex];
    if (!this.firstFlipDone || !mc) return out;

    for (let from = 0; from < CELLS; from++) {
      const src = this.cells[from];
      if (!src || src.fd || src.color !== mc) continue;
      const r = rowOf(from), co = colOf(from);

      if (src.type === CANNON) {
        // 1-step orthogonal to empty (repositioning)
        for (let d = 0; d < 4; d++) {
          const nr = r + DR[d], nc = co + DC[d];
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          if (!this.cells[rcIdx(nr, nc)]) out.push({ from, to: rcIdx(nr, nc) });
        }
        // Jump: scan outward; first non-empty = screen, second non-empty = target.
        // Taiwanese rule: target must be a face-up enemy piece. A face-down piece
        // can serve as the screen but cannot itself be captured.
        for (let d = 0; d < 4; d++) {
          let nr = r + DR[d], nc = co + DC[d], screens = 0;
          while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
            const to = rcIdx(nr, nc);
            const tc = this.cells[to];
            if (tc) {
              if (++screens === 2) {
                if (!tc.fd && tc.color !== mc) out.push({ from, to });
                break;
              }
            }
            nr += DR[d]; nc += DC[d];
          }
        }
      } else {
        for (let d = 0; d < 4; d++) {
          const nr = r + DR[d], nc = co + DC[d];
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          const to = rcIdx(nr, nc);
          const dst = this.cells[to];
          if (!dst) {
            out.push({ from, to });
          } else if (!dst.fd && canCapture(src, dst)) {
            out.push({ from, to });
          }
        }
      }
    }
    return out;
  }

  // Apply a flip with a known piece identity.
  applyFlip(cell, piece) {
    this.cells[cell] = { color: piece.color, type: piece.type };
    if (!this.firstFlipDone) {
      this.firstFlipDone = true;
      this.playerColors[this.sidePlayer] = piece.color;
      this.playerColors[1 - this.sidePlayer] = piece.color === RED ? BLACK : RED;
    }
    this._advanceTurn();
  }

  // Apply a flip using the cell's stored hidden piece (for determinised boards).
  applyFlipKnown(cell) {
    const hp = this.cells[cell]?.hp;
    this.applyFlip(cell, hp ?? { color: RED, type: SOLDIER });
  }

  applyMove(from, to) {
    this.cells[to] = this.cells[from];
    this.cells[from] = null;
    this._advanceTurn();
  }

  _advanceTurn() {
    this.sidePlayer = 1 - this.sidePlayer;
    if (this.firstFlipDone && !this.over) {
      if (!this.legalMoves(this.sidePlayer).length) {
        this.over = true;
        this.winner = this.playerColors[1 - this.sidePlayer];
      }
    }
  }

  // Material + progress + threat heuristic for `forColor`.
  evaluate(forColor) {
    if (this.over) {
      if (this.winner === forColor) return 1_000_000;
      if (this.winner)              return -1_000_000;
      return 0;
    }
    let score = 0;
    let myPieces = 0, oppPieces = 0, facedownCount = 0;
    for (let i = 0; i < CELLS; i++) {
      const c = this.cells[i];
      if (!c) continue;
      if (c.fd) { facedownCount++; continue; }
      const v = PIECE_VALUE[c.type] || 0;
      if (c.color === forColor) { score += v; myPieces++; }
      else                      { score -= v; oppPieces++; }
    }
    // Piece-count dominance and progress both use a strong weight so that
    // material-even trades look attractive (they reduce piece count and advance
    // the game toward a won endgame).
    score += (myPieces - oppPieces) * 50;
    const emptyCount = 32 - facedownCount - myPieces - oppPieces;
    score += emptyCount * 20;
    // Threat bonus: reward pieces that are adjacent to capturable enemies.
    // Guides the search toward active, attacking positions and prevents
    // indefinite passive shuffling when no captures are currently on the board.
    for (let i = 0; i < CELLS; i++) {
      const src = this.cells[i];
      if (!src || src.fd || src.color !== forColor) continue;
      const r = rowOf(i), co = colOf(i);
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d], nc = co + DC[d];
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        const dst = this.cells[rcIdx(nr, nc)];
        if (dst && !dst.fd && canCapture(src, dst)) score += 45;
      }
    }
    return score;
  }
}

// ---------------------------------------------------------------------------
// Determinisation helpers
// ---------------------------------------------------------------------------

// The canonical 32-piece pool (mirrors C++ code_to_piece / initial_deck).
function makePiecePool() {
  const pool = [];
  for (let i = 1; i <= 32; i++) {
    const color = i <= 16 ? RED : BLACK;
    const local = i <= 16 ? i : i - 16;
    let type;
    if (local === 1)       type = GENERAL;
    else if (local <= 3)   type = ADVISOR;
    else if (local <= 5)   type = ELEPHANT;
    else if (local <= 7)   type = CHARIOT;
    else if (local <= 9)   type = HORSE;
    else if (local <= 11)  type = CANNON;
    else                   type = SOLDIER;
    pool.push({ color, type });
  }
  return pool;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Create a determinised copy of `board`: randomly assign remaining unknown
// pieces to face-down cells. Face-down cells in the result have `hp` set.
function determinise(board, state) {
  // Collect revealed pieces from the live state
  const revealed = [];
  for (const c of state.cells) {
    if (c.state === 'faceup') revealed.push({ color: c.color, type: c.type });
  }

  // Remaining pieces = full pool minus revealed
  const pool = makePiecePool();
  const remaining = pool.filter(p => {
    const idx = revealed.findIndex(r => r.color === p.color && r.type === p.type);
    if (idx >= 0) { revealed.splice(idx, 1); return false; }
    return true;
  });
  shuffleInPlace(remaining);

  const det = board.clone();
  let ri = 0;
  for (let i = 0; i < CELLS; i++) {
    if (det.cells[i]?.fd) {
      det.cells[i] = { fd: true, hp: remaining[ri++] ?? { color: RED, type: SOLDIER } };
    }
  }
  return det;
}

// ---------------------------------------------------------------------------
// Alpha-beta minimax
// ---------------------------------------------------------------------------
const HARD_DEPTH = 4;
const HARD_DETERMINISATIONS = 6;

function alphaBeta(board, forColor, depth, alpha, beta) {
  if (board.over || depth === 0) return board.evaluate(forColor);

  const moves = board.legalMoves(board.sidePlayer);
  if (!moves.length) return board.evaluate(forColor);

  const myTurn = board.playerColors[board.sidePlayer] === forColor;

  // Order: captures / flips of likely-good pieces first (improves pruning)
  moves.sort((a, b) => {
    const aCapture = a.from >= 0 && board.cells[a.to] && !board.cells[a.to].fd;
    const bCapture = b.from >= 0 && board.cells[b.to] && !board.cells[b.to].fd;
    if (aCapture && !bCapture) return -1;
    if (!aCapture && bCapture) return 1;
    if (aCapture && bCapture) {
      const aVal = PIECE_VALUE[board.cells[a.to]?.type] || 0;
      const bVal = PIECE_VALUE[board.cells[b.to]?.type] || 0;
      return bVal - aVal;
    }
    return 0;
  });

  if (myTurn) {
    let best = -Infinity;
    for (const m of moves) {
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBeta(nb, forColor, depth - 1, alpha, beta);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBeta(nb, forColor, depth - 1, alpha, beta);
      if (score < best) best = score;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Public: choose the best move for the AI
//
// `state`        – parsed stateJson() from the AI's Game object
// `playerIndex`  – the AI's player index (usually 1)
// `difficulty`   – Difficulty.EASY | MEDIUM | HARD
//
// Returns a move object { from, to } where from < 0 means flip.
// ---------------------------------------------------------------------------
export function chooseMove(state, playerIndex, difficulty) {
  const legal = state.legal_moves_for_me;
  if (!legal.length) return null;

  switch (difficulty) {
    case Difficulty.EASY:   return chooseMoveEasy(state, legal);
    case Difficulty.MEDIUM: return chooseMoveMedium(state, legal, playerIndex);
    case Difficulty.HARD:   return chooseMoveHard(state, legal, playerIndex);
    default:                return chooseMoveEasy(state, legal);
  }
}

// ---- Easy: random with slight capture preference ----
function chooseMoveEasy(state, legal) {
  const captures = legal.filter(m => {
    if (m.from < 0) return false;
    return state.cells[m.to].state !== 'empty';
  });
  const pool = (captures.length && Math.random() < 0.65) ? captures : legal;
  return pool[(Math.random() * pool.length) | 0];
}

// ---- Medium: 1-ply greedy ----
// Priority: good capture > flip > passive move (with danger adjustment).
function chooseMoveMedium(state, legal, playerIndex) {
  const myColor = state.my_color;
  let bestMove = legal[0], bestScore = -Infinity;

  for (const move of legal) {
    let score = 0;

    if (move.from < 0) {
      // Flip: revealing a piece always makes progress. Fixed base score beats
      // passive moves but loses to genuine captures.
      score = 40 + Math.random() * 10;
    } else {
      const src = state.cells[move.from];
      const dst = state.cells[move.to];
      const srcVal = PIECE_VALUE[src.type] || 0;

      if (dst.state === 'faceup' && dst.color !== myColor) {
        // Capture known enemy: net trade value. Base 200 ensures captures
        // always beat passive moves even on losing trades.
        const dstVal = PIECE_VALUE[dst.type] || 0;
        score = 200 + dstVal - srcVal * 0.5;
      } else {
        // Passive move to empty cell
        score = 10 + Math.random() * 10;
        const r = rowOf(move.to), co = colOf(move.to);
        for (let d = 0; d < 4; d++) {
          const nr = r + DR[d], nc = co + DC[d];
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
          const adj = state.cells[rcIdx(nr, nc)];
          if (!adj || adj.state === 'empty') continue;
          if (adj.state === 'faceup' && adj.color !== myColor) {
            if (canCapture({ color: src.color, type: src.type },
                           { color: adj.color, type: adj.type })) {
              // Moves into capture range of an enemy we can beat: big bonus
              score += (PIECE_VALUE[adj.type] || 0) * 0.6 + 40;
            } else if (canCapture({ color: adj.color, type: adj.type },
                                   { color: src.color, type: src.type })) {
              // Moving into danger from an enemy that can beat us: penalise
              score -= srcVal * 0.7;
            }
          }
        }
      }
    }

    if (score > bestScore) { bestScore = score; bestMove = move; }
  }
  return bestMove;
}

// ---- Hard: determinisation + alpha-beta ----
function chooseMoveHard(state, legal, playerIndex) {
  const myColor = state.my_color;

  // Before the first flip the AI doesn't know its color yet — fall back to medium.
  if (!state.first_flip_done || !myColor) return chooseMoveMedium(state, legal, playerIndex);

  const baseBoard = Board.fromState(state);

  // Accumulate scores per move key across determinisations
  const moveKey = m => `${m.from},${m.to}`;
  const scores = new Map();
  for (const m of legal) scores.set(moveKey(m), 0);

  for (let d = 0; d < HARD_DETERMINISATIONS; d++) {
    const det = determinise(baseBoard, state);

    // Score each root move on this determinisation
    for (const m of legal) {
      const nb = det.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBeta(nb, myColor, HARD_DEPTH - 1, -Infinity, Infinity);
      scores.set(moveKey(m), scores.get(moveKey(m)) + score);
    }
  }

  let bestMove = legal[0], bestScore = -Infinity;
  for (const m of legal) {
    const s = scores.get(moveKey(m));
    if (s > bestScore) { bestScore = s; bestMove = m; }
  }
  return bestMove;
}
