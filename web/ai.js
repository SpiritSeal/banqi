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
//   EXPERT – deeper alpha-beta (depth 6) with quiescence search and a
//            safety-aware evaluation, over N determinisations

export const Difficulty = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', EXPERT: 'expert' };

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
    case Difficulty.EXPERT: return chooseMoveExpert(state, legal, playerIndex);
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

// ---------------------------------------------------------------------------
// Expert: deeper alpha-beta with quiescence, transposition table, and a
// safety- and mobility-aware evaluation.
//
// Improvements over Hard:
//   - Deeper search (up to depth 6 vs Hard's 4), with a per-determinisation
//     node budget that acts as a safety cap, not the primary throttle.
//   - Transposition table (per determinisation): caches subtree scores keyed
//     by board state, with the best move used as a strong ordering hint. Cuts
//     the cost of reaching depth 6 dramatically.
//   - Quiescence search: at the depth horizon, capture sequences are played
//     out so the position is scored at rest. Removes the horizon effect that
//     lets Hard grab a piece it cannot actually keep.
//   - Safety-aware evaluation: hanging pieces (attacked and undefended,
//     including cannon-jump threats) are penalised; enemy hanging pieces are
//     rewarded.
//   - Mobility differential: rewards positions where we have more legal moves
//     than the opponent, steering the search toward Banqi's actual win
//     condition (opponent has no legal moves).
// ---------------------------------------------------------------------------
const EXPERT_DEEP_DEPTH    = 5;
const EXPERT_SHALLOW_DEPTH = 4;     // used while most of the board is hidden
const EXPERT_DETERMINISATIONS = 4;
const EXPERT_NODE_BUDGET   = 120000; // safety cap on interior nodes per determinisation
const EXPERT_QUIESCE_DEPTH = 2;

const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

// Compact key for the transposition table. Within a single determinisation
// face-down cells never move and never change identity (flipping converts
// them to face-up), so encoding "facedown" with one symbol is enough — the
// determinisation fixes `hp` positionally.
function boardKey(board) {
  let s = '';
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (!c) s += '_';
    else if (c.fd) s += 'F';
    else s += String.fromCharCode(65 + c.color * 8 + c.type);
  }
  return s + board.sidePlayer;
}

// Can any face-up `byColor` piece capture the face-up piece at `cell`?
function isAttacked(board, cell, byColor) {
  const victim = board.cells[cell];
  if (!victim || victim.fd) return false;
  const r = rowOf(cell), co = colOf(cell);
  // Adjacent (non-cannon) attackers.
  for (let d = 0; d < 4; d++) {
    const nr = r + DR[d], nc = co + DC[d];
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    const a = board.cells[rcIdx(nr, nc)];
    if (a && !a.fd && a.color === byColor && a.type !== CANNON && canCapture(a, victim)) return true;
  }
  // Cannon jump attackers: the first piece along a ray is the screen; a face-up
  // enemy cannon as the second piece along that ray can jump-capture `cell`.
  for (let d = 0; d < 4; d++) {
    let nr = r + DR[d], nc = co + DC[d], screens = 0;
    while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
      const c = board.cells[rcIdx(nr, nc)];
      if (c) {
        if (++screens === 2) {
          if (!c.fd && c.color === byColor && c.type === CANNON) return true;
          break;
        }
      }
      nr += DR[d]; nc += DC[d];
    }
  }
  return false;
}

// Would a `byColor` piece be able to recapture on `cell` if the piece sitting
// there were taken by an equal-ranked enemy? Approximates "is this defended".
function isDefended(board, cell, byColor) {
  const victim = board.cells[cell];
  if (!victim || victim.fd) return false;
  const hypothetical = { color: byColor === RED ? BLACK : RED, type: victim.type };
  const r = rowOf(cell), co = colOf(cell);
  for (let d = 0; d < 4; d++) {
    const nr = r + DR[d], nc = co + DC[d];
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    const f = board.cells[rcIdx(nr, nc)];
    if (f && !f.fd && f.color === byColor && f.type !== CANNON && canCapture(f, hypothetical)) return true;
  }
  return false;
}

// Count piece moves (excluding flips, which are colour-neutral) for `color`.
// Mirrors the move-generation in Board.legalMoves but only counts; used for
// the mobility differential in the evaluation.
function countPieceMoves(board, color) {
  let n = 0;
  for (let from = 0; from < CELLS; from++) {
    const src = board.cells[from];
    if (!src || src.fd || src.color !== color) continue;
    const r = rowOf(from), co = colOf(from);
    if (src.type === CANNON) {
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d], nc = co + DC[d];
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        if (!board.cells[rcIdx(nr, nc)]) n++;
      }
      for (let d = 0; d < 4; d++) {
        let nr = r + DR[d], nc = co + DC[d], screens = 0;
        while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
          const tc = board.cells[rcIdx(nr, nc)];
          if (tc) {
            if (++screens === 2) {
              if (!tc.fd && tc.color !== color) n++;
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
        const dst = board.cells[rcIdx(nr, nc)];
        if (!dst) n++;
        else if (!dst.fd && canCapture(src, dst)) n++;
      }
    }
  }
  return n;
}

// Material + progress + piece-safety + mobility heuristic for `forColor`.
function evaluateExpert(board, forColor) {
  if (board.over) {
    if (board.winner === forColor) return 1_000_000;
    if (board.winner)              return -1_000_000;
    return 0;
  }
  const oppColor = forColor === RED ? BLACK : RED;
  let score = 0;
  let myPieces = 0, oppPieces = 0, facedownCount = 0;
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (!c) continue;
    if (c.fd) { facedownCount++; continue; }
    const v = PIECE_VALUE[c.type] || 0;
    if (c.color === forColor) { score += v; myPieces++; }
    else                      { score -= v; oppPieces++; }
  }
  score += (myPieces - oppPieces) * 50;
  const emptyCount = 32 - facedownCount - myPieces - oppPieces;
  score += emptyCount * 20;
  // Piece safety: a hanging piece is worth a large fraction of its value to
  // whoever threatens it. A defended piece is only mildly discounted, since
  // the resulting recapture trade is roughly even.
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (!c || c.fd) continue;
    const v = PIECE_VALUE[c.type] || 0;
    if (c.color === forColor) {
      if (isAttacked(board, i, oppColor)) {
        score -= isDefended(board, i, forColor) ? v * 0.30 : v * 0.80;
      }
    } else {
      if (isAttacked(board, i, forColor)) {
        score += isDefended(board, i, oppColor) ? v * 0.30 : v * 0.80;
      }
    }
  }
  // Mobility differential. Banqi's win condition is "opponent has no legal
  // moves", so reducing the opponent's mobility (and keeping ours) is the
  // direct path to a stalemate win — a strategic axis Hard ignores entirely.
  score += (countPieceMoves(board, forColor) - countPieceMoves(board, oppColor)) * 6;
  return score;
}

// Quiescence search: at the horizon, play out only capture moves so the
// position is scored at rest rather than mid-exchange.
function quiesce(board, forColor, alpha, beta, qdepth) {
  const standPat = evaluateExpert(board, forColor);
  if (board.over || qdepth <= 0) return standPat;

  const caps = board.legalMoves(board.sidePlayer)
    .filter(m => m.from >= 0 && board.cells[m.to] && !board.cells[m.to].fd);
  if (!caps.length) return standPat;

  const myTurn = board.playerColors[board.sidePlayer] === forColor;
  if (myTurn) {
    let best = standPat;
    if (best > alpha) alpha = best;
    if (alpha >= beta) return best;
    for (const m of caps) {
      const nb = board.clone();
      nb.applyMove(m.from, m.to);
      const s = quiesce(nb, forColor, alpha, beta, qdepth - 1);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  } else {
    let best = standPat;
    if (best < beta) beta = best;
    if (alpha >= beta) return best;
    for (const m of caps) {
      const nb = board.clone();
      nb.applyMove(m.from, m.to);
      const s = quiesce(nb, forColor, alpha, beta, qdepth - 1);
      if (s < best) best = s;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

function alphaBetaExpert(board, forColor, depth, alpha, beta, ctx) {
  if (board.over) return evaluateExpert(board, forColor);
  if (depth <= 0) return quiesce(board, forColor, alpha, beta, EXPERT_QUIESCE_DEPTH);
  // Safety cap: in a pathological position fall back to a static score so the
  // search can't run away. With the TT this almost never triggers.
  if (++ctx.nodes > ctx.budget) return evaluateExpert(board, forColor);

  const key = boardKey(board);
  const cached = ctx.tt.get(key);
  let ttMove = null;
  if (cached) {
    ttMove = cached.move;
    if (cached.depth >= depth) {
      if (cached.flag === TT_EXACT) return cached.score;
      if (cached.flag === TT_LOWER) { if (cached.score > alpha) alpha = cached.score; }
      else                          { if (cached.score < beta)  beta  = cached.score; }
      if (alpha >= beta) return cached.score;
    }
  }

  const moves = board.legalMoves(board.sidePlayer);
  if (!moves.length) return evaluateExpert(board, forColor);

  const myTurn = board.playerColors[board.sidePlayer] === forColor;

  // Move ordering: TT-best first (huge pruning win), then captures by victim
  // value, then everything else.
  moves.sort((a, b) => {
    if (ttMove) {
      const aTT = a.from === ttMove.from && a.to === ttMove.to;
      const bTT = b.from === ttMove.from && b.to === ttMove.to;
      if (aTT && !bTT) return -1;
      if (!aTT && bTT) return 1;
    }
    const aCap = a.from >= 0 && board.cells[a.to] && !board.cells[a.to].fd;
    const bCap = b.from >= 0 && board.cells[b.to] && !board.cells[b.to].fd;
    if (aCap && !bCap) return -1;
    if (!aCap && bCap) return 1;
    if (aCap && bCap) {
      const aVal = PIECE_VALUE[board.cells[a.to]?.type] || 0;
      const bVal = PIECE_VALUE[board.cells[b.to]?.type] || 0;
      return bVal - aVal;
    }
    return 0;
  });

  const alphaOrig = alpha, betaOrig = beta;
  let bestVal, bestMove = moves[0];
  if (myTurn) {
    bestVal = -Infinity;
    for (const m of moves) {
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBetaExpert(nb, forColor, depth - 1, alpha, beta, ctx);
      if (score > bestVal) { bestVal = score; bestMove = m; }
      if (bestVal > alpha) alpha = bestVal;
      if (alpha >= beta) break;
    }
  } else {
    bestVal = Infinity;
    for (const m of moves) {
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBetaExpert(nb, forColor, depth - 1, alpha, beta, ctx);
      if (score < bestVal) { bestVal = score; bestMove = m; }
      if (bestVal < beta) beta = bestVal;
      if (alpha >= beta) break;
    }
  }

  // Fail-soft bound classification.
  let flag;
  if (bestVal <= alphaOrig)      flag = TT_UPPER;
  else if (bestVal >= betaOrig)  flag = TT_LOWER;
  else                           flag = TT_EXACT;
  ctx.tt.set(key, { depth, score: bestVal, flag, move: bestMove });
  return bestVal;
}

// ---- Expert: determinisation + deep alpha-beta with quiescence ----
function chooseMoveExpert(state, legal, playerIndex) {
  const myColor = state.my_color;
  // Before the first flip the AI doesn't know its color — fall back to Hard.
  if (!state.first_flip_done || !myColor) return chooseMoveHard(state, legal, playerIndex);

  const baseBoard = Board.fromState(state);

  // Adapt search depth to how much of the board is still hidden: deep search
  // through randomly determinised pieces is low-value, so save the budget for
  // when enough is revealed to make the lookahead meaningful.
  let facedown = 0;
  for (const c of state.cells) if (c.state === 'facedown') facedown++;
  const depth = facedown > 20 ? EXPERT_SHALLOW_DEPTH : EXPERT_DEEP_DEPTH;

  const moveKey = m => `${m.from},${m.to}`;
  const scores = new Map();
  for (const m of legal) scores.set(moveKey(m), 0);

  for (let d = 0; d < EXPERT_DETERMINISATIONS; d++) {
    const det = determinise(baseBoard, state);
    // One context (and TT) per determinisation, shared across all root moves.
    // The TT pays off doubly here: sibling root moves transpose constantly,
    // and the TT-best-move hint makes the next root's search prune harder.
    const ctx = { nodes: 0, budget: EXPERT_NODE_BUDGET, tt: new Map() };
    for (const m of legal) {
      const nb = det.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      const score = alphaBetaExpert(nb, myColor, depth - 1, -Infinity, Infinity, ctx);
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
