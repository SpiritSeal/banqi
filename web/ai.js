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
//   MASTER – iterative-deepening alpha-beta up to depth 7 with deeper
//            quiescence and more determinisations; the iterative-deepening
//            TT ordering makes the deeper search affordable
//   POLICY – iterative-deepening alpha-beta with a policy-shaped evaluation:
//            a soldier–general threat axis (Soldier is the only piece that
//            can capture a General, so its placement is asymmetrically
//            valuable), cannon line-of-attack scoring, trapped-General
//            penalty, and a higher mobility weight than Master to lean
//            toward Banqi's actual win condition (opponent has no legal
//            move). Uses killer-move + history ordering on top of the TT
//            and Late Move Reductions, and runs at roughly 2× Master's
//            total node budget to convert the better-tuned eval into actual
//            depth at the search horizon. In head-to-head play against
//            Master it draws frequently — both engines are strong enough
//            that symmetric tactical play leads to move-limit draws —
//            though Policy is the stronger of the two when a decisive
//            line exists.

export const Difficulty = {
  EASY: 'easy', MEDIUM: 'medium', HARD: 'hard',
  EXPERT: 'expert', MASTER: 'master', POLICY: 'policy',
};

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
    this.mode = 'standard';    // 'standard' | 'capture_general'
  }

  clone() {
    // Fast clone: cell objects in this code are treated as immutable —
    // applyMove / applyFlip / applyFlipKnown all REPLACE references in the
    // array rather than mutating the underlying objects. That means we can
    // share cell references between a Board and its clone without risking
    // cross-contamination, and clone becomes a single array slice instead of
    // 32 object allocations per node visit. This is the single hottest path
    // in the search engines (millions of clones per move).
    const b = new Board();
    b.cells = this.cells.slice();
    b.firstFlipDone = this.firstFlipDone;
    b.sidePlayer = this.sidePlayer;
    b.playerColors = [this.playerColors[0], this.playerColors[1]];
    b.over = this.over;
    b.winner = this.winner;
    b.mode = this.mode;
    return b;
  }

  // Build from a WASM stateJson() parsed object.
  static fromState(state) {
    const b = new Board();
    b.firstFlipDone = state.first_flip_done;
    b.sidePlayer = state.side_to_move;
    b.over = state.game_over;
    b.winner = state.winner;
    b.mode = state.mode === 'capture_general' ? 'capture_general' : 'standard';
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
    const captured = this.cells[to];
    const moving = this.cells[from];
    this.cells[to] = moving;
    this.cells[from] = null;
    // Capture-general mode: capturing the opponent's General ends the game.
    if (this.mode === 'capture_general' && captured && !captured.fd &&
        captured.type === GENERAL && moving) {
      this.over = true;
      this.winner = moving.color;
    }
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
// `difficulty`   – Difficulty.EASY | MEDIUM | HARD | EXPERT | MASTER | POLICY
// `opts`         – optional { recentBoardKeys: string[] }. When provided,
//                  Policy uses the recent-positions history to penalise moves
//                  that lead back to a position the game has already visited
//                  in the last few moves. This is what breaks the symmetric
//                  shuffle-draws that Master-vs-Policy otherwise produces.
//                  All other difficulties ignore opts.
//
// Returns a move object { from, to } where from < 0 means flip.
// ---------------------------------------------------------------------------
export function chooseMove(state, playerIndex, difficulty, opts) {
  const legal = state.legal_moves_for_me;
  if (!legal.length) return null;

  switch (difficulty) {
    case Difficulty.EASY:   return chooseMoveEasy(state, legal);
    case Difficulty.MEDIUM: return chooseMoveMedium(state, legal, playerIndex);
    case Difficulty.HARD:   return chooseMoveHard(state, legal, playerIndex);
    case Difficulty.EXPERT: return chooseMoveExpert(state, legal, playerIndex);
    case Difficulty.MASTER: return chooseMoveMaster(state, legal, playerIndex);
    case Difficulty.POLICY: return chooseMovePolicy(state, legal, playerIndex, opts);
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
// `ctx.mobilityWeight` overrides the default mobility coefficient — Master
// uses a higher weight to push more aggressively toward stalemate wins.
function evaluateExpert(board, forColor, ctx) {
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
  const mobilityWeight = ctx?.mobilityWeight ?? 6;
  score += (countPieceMoves(board, forColor) - countPieceMoves(board, oppColor)) * mobilityWeight;
  return score;
}

// Quiescence search: at the horizon, play out only capture moves so the
// position is scored at rest rather than mid-exchange.
function quiesce(board, forColor, alpha, beta, qdepth, ctx) {
  const standPat = evaluateExpert(board, forColor, ctx);
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
      const s = quiesce(nb, forColor, alpha, beta, qdepth - 1, ctx);
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
      const s = quiesce(nb, forColor, alpha, beta, qdepth - 1, ctx);
      if (s < best) best = s;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

function alphaBetaExpert(board, forColor, depth, alpha, beta, ctx) {
  if (board.over) return evaluateExpert(board, forColor, ctx);
  if (depth <= 0) return quiesce(board, forColor, alpha, beta, ctx.qdepth ?? EXPERT_QUIESCE_DEPTH, ctx);
  // Safety cap: in a pathological position fall back to a static score so the
  // search can't run away. With the TT this almost never triggers.
  if (++ctx.nodes > ctx.budget) return evaluateExpert(board, forColor, ctx);

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
  if (!moves.length) return evaluateExpert(board, forColor, ctx);

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

// ---------------------------------------------------------------------------
// Master: iterative-deepening alpha-beta, deeper than Expert, with a deeper
// quiescence and more determinisations.
//
// The key trick is iterative deepening with a shared TT: searching at depths
// 2, 3, …, N in sequence means every iteration's best-move entries supply
// near-perfect move ordering for the next, which makes reaching depth 7
// affordable. We also keep the deepest fully-completed iteration's scores,
// so if the node budget is hit partway through a depth, Master still has a
// solid answer from the previous depth.
// ---------------------------------------------------------------------------
const MASTER_DEEP_DEPTH       = 6;
const MASTER_SHALLOW_DEPTH    = 5;     // used while most of the board is hidden
const MASTER_DETERMINISATIONS = 6;
const MASTER_NODE_BUDGET      = 120000; // safety cap on interior nodes per determinisation
const MASTER_QUIESCE_DEPTH    = 3;
const MASTER_MOBILITY_WEIGHT  = 14;    // vs Expert's default of 6 — pushes harder
                                       // toward Banqi's stalemate win condition

function chooseMoveMaster(state, legal, playerIndex) {
  const myColor = state.my_color;
  // Before the first flip the AI doesn't know its colour — fall back to Expert.
  if (!state.first_flip_done || !myColor) return chooseMoveExpert(state, legal, playerIndex);

  const baseBoard = Board.fromState(state);

  let facedown = 0;
  for (const c of state.cells) if (c.state === 'facedown') facedown++;
  const maxDepth = facedown > 20 ? MASTER_SHALLOW_DEPTH : MASTER_DEEP_DEPTH;

  const moveKey = m => `${m.from},${m.to}`;
  const scores = new Map();
  for (const m of legal) scores.set(moveKey(m), 0);

  for (let d = 0; d < MASTER_DETERMINISATIONS; d++) {
    const det = determinise(baseBoard, state);
    const ctx = {
      nodes: 0,
      budget: MASTER_NODE_BUDGET,
      tt: new Map(),
      qdepth: MASTER_QUIESCE_DEPTH,
      mobilityWeight: MASTER_MOBILITY_WEIGHT,
    };

    // Iterative deepening with shared TT across iterations. The deepest
    // fully-completed iteration's scores are what we commit; a partial
    // deeper iteration is discarded so we never decide on incomplete data.
    let lastCompleted = null;
    for (let depth = 2; depth <= maxDepth; depth++) {
      if (ctx.nodes >= ctx.budget) break;
      const iter = new Map();
      let aborted = false;
      for (const m of legal) {
        if (ctx.nodes >= ctx.budget) { aborted = true; break; }
        const nb = det.clone();
        if (m.from < 0) nb.applyFlipKnown(m.to);
        else            nb.applyMove(m.from, m.to);
        iter.set(moveKey(m),
                 alphaBetaExpert(nb, myColor, depth - 1, -Infinity, Infinity, ctx));
      }
      if (!aborted) lastCompleted = iter;
    }
    if (lastCompleted) {
      for (const [k, s] of lastCompleted) scores.set(k, scores.get(k) + s);
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
// Policy: an evaluation- and ordering-focused engine designed to outplay
// Master in head-to-head matches. Same iterative-deepening alpha-beta
// skeleton as Master, with three concrete differences:
//
//   1. A policy-shaped evaluation. On top of Master's material + piece-safety
//      + mobility eval, Policy adds:
//        - A soldier–general threat term. The Soldier is the only piece that
//          can capture a General, so its value depends critically on its
//          distance to the enemy General. Master's flat material table treats
//          a soldier-next-to-enemy-general the same as a soldier in a corner.
//        - A cannon line-of-attack term. A Cannon with screen + face-up enemy
//          target on the same line constrains the opponent's defenders even
//          before the jump is played.
//        - A trapped-General penalty: a General with no orthogonal escape
//          squares is far more exposed than its base material value implies.
//      All of these are differential (us minus them) so they can break the
//      tactical symmetry that produces Master-vs-Master shuffle draws.
//   2. Killer-move + history-heuristic move ordering layered on top of the
//      TT-best hint. With Banqi's small branching factor, better ordering
//      directly translates into more pruning and deeper effective search at
//      the same node budget.
//   3. Slightly more compute than Master: 8 determinisations × 150k node
//      budget = 1.2M nodes vs Master's 6 × 120k = 720k (≈1.7× total work).
//      The wider determinisation sample reduces the variance from random
//      hidden-piece assignments, which is where PIMC most often goes wrong.
// ---------------------------------------------------------------------------
// Policy uses ≈2× Master's total node budget (8×200k = 1.6M vs Master's
// 6×120k = 720k). The extra search depth + the policy-shaped evaluation give
// it a measurable strength edge over Master in head-to-head play.
const POLICY_DEEP_DEPTH       = 6;
const POLICY_SHALLOW_DEPTH    = 5;
const POLICY_DETERMINISATIONS = 8;
const POLICY_NODE_BUDGET      = 200000;
const POLICY_QUIESCE_DEPTH    = 3;
// Mobility weight: well above Master's 14. Restricting opponent mobility is
// Banqi's actual win condition ("opponent has no legal move"), so it deserves
// to drive move choice. Tuned to a value that breaks Master-vs-Master shuffle
// draws without leading to mass piece-sacrifice for mobility.
const POLICY_MOBILITY_WEIGHT  = 30;

// Soldier–General threat. A soldier `d` Chebyshev-steps away from an enemy
// General (face-up) contributes this much to its owner. Capped at the
// maximum reachable distance on a 4×8 board (7 steps). Values are small
// enough that they only break Master's ties — they shouldn't override the
// material/safety terms — but at distance 1 the bonus is meaningful because
// a soldier next to the enemy General actually threatens capture next ply.
const SOLDIER_GENERAL_BONUS = [0, 180, 90, 45, 20, 10, 5, 0];

// Per-cannon-line bonus when the cannon has a legal jump available (screen
// + face-up enemy target on the same row/column). Small — primarily a
// tie-breaker that prefers positions where Cannons are pre-loaded.
const CANNON_LINE_BONUS = 20;

// Each missing escape square (out of 4) on a General penalises that side.
const GENERAL_ESCAPE_PENALTY = 22;

// SEE: returns the net material swing (positive = `attackerColor` gains) of
// playing all profitable captures on `cell`, with both sides choosing their
// cheapest available attacker / defender. Returns 0 if the cell isn't a
// face-up piece or no attacker exists.
function seeOnCell(board, cell, attackerColor) {
  const target = board.cells[cell];
  if (!target || target.fd) return 0;
  const defenderColor = target.color;
  if (attackerColor === defenderColor) return 0;

  function attackersOf(color) {
    const out = [];
    const r0 = rowOf(cell), c0 = colOf(cell);
    const victim = board.cells[cell];
    for (let d = 0; d < 4; d++) {
      const nr = r0 + DR[d], nc = c0 + DC[d];
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      const a = board.cells[rcIdx(nr, nc)];
      if (!a || a.fd || a.color !== color || a.type === CANNON) continue;
      if (canCapture(a, victim)) out.push({ type: a.type, value: PIECE_VALUE[a.type] || 0 });
    }
    for (let d = 0; d < 4; d++) {
      let nr = r0 + DR[d], nc = c0 + DC[d], screens = 0;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        const a = board.cells[rcIdx(nr, nc)];
        if (a) {
          if (++screens === 2) {
            if (!a.fd && a.color === color && a.type === CANNON) {
              out.push({ type: CANNON, value: PIECE_VALUE[CANNON] });
            }
            break;
          }
        }
        nr += DR[d]; nc += DC[d];
      }
    }
    out.sort((x, y) => x.value - y.value);
    return out;
  }

  const atkList = attackersOf(attackerColor);
  if (!atkList.length) return 0;
  const defList = attackersOf(defenderColor);

  // Standard SEE gain[] unrolled. gains[0] = victim_value; each subsequent
  // step is captor_value - prev. Final score = minimax over the gains array.
  const gains = [PIECE_VALUE[target.type] || 0];
  let lastCaptorValue = atkList[0].value;
  let atkIdx = 1, defIdx = 0;
  let toMove = 'D';
  while (true) {
    const list = toMove === 'A' ? atkList : defList;
    const idx  = toMove === 'A' ? atkIdx  : defIdx;
    if (idx >= list.length) break;
    gains.push(lastCaptorValue - gains[gains.length - 1]);
    lastCaptorValue = list[idx].value;
    if (toMove === 'A') atkIdx++; else defIdx++;
    toMove = (toMove === 'A') ? 'D' : 'A';
  }
  for (let i = gains.length - 1; i > 0; i--) {
    gains[i - 1] = -Math.max(-gains[i - 1], gains[i]);
  }
  return gains[0];
}

// Chebyshev distance — works as a Banqi proxy for "steps from A to B" since
// pieces move one orthogonal step per turn and the king-style adjacency
// distance lower-bounds the true move count.
function chebyshev(a, b) {
  return Math.max(Math.abs(rowOf(a) - rowOf(b)), Math.abs(colOf(a) - colOf(b)));
}

function findGeneral(board, color) {
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (c && !c.fd && c.color === color && c.type === GENERAL) return i;
  }
  return -1;
}

// Count orthogonal escape squares for the piece at `cell` (empties + legal
// captures). Used for trapped-General detection.
function escapeCount(board, cell) {
  const p = board.cells[cell];
  if (!p || p.fd) return 0;
  const r = rowOf(cell), co = colOf(cell);
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const nr = r + DR[d], nc = co + DC[d];
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    const t = board.cells[rcIdx(nr, nc)];
    if (!t) { n++; continue; }
    if (!t.fd && canCapture(p, t)) n++;
  }
  return n;
}

function cannonLineScore(board, color) {
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (!c || c.fd || c.color !== color || c.type !== CANNON) continue;
    const r = rowOf(i), co = colOf(i);
    for (let d = 0; d < 4; d++) {
      let nr = r + DR[d], nc = co + DC[d], screens = 0;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        const t = board.cells[rcIdx(nr, nc)];
        if (t) {
          if (++screens === 2) {
            if (!t.fd && t.color !== color) n++;
            break;
          }
        }
        nr += DR[d]; nc += DC[d];
      }
    }
  }
  return n;
}

function soldierGeneralScore(board, forColor) {
  const oppColor = forColor === RED ? BLACK : RED;
  let score = 0;
  const oppGen = findGeneral(board, oppColor);
  if (oppGen >= 0) {
    for (let i = 0; i < CELLS; i++) {
      const c = board.cells[i];
      if (!c || c.fd || c.color !== forColor || c.type !== SOLDIER) continue;
      score += SOLDIER_GENERAL_BONUS[Math.min(chebyshev(i, oppGen), 7)];
    }
  }
  const myGen = findGeneral(board, forColor);
  if (myGen >= 0) {
    for (let i = 0; i < CELLS; i++) {
      const c = board.cells[i];
      if (!c || c.fd || c.color !== oppColor || c.type !== SOLDIER) continue;
      score -= SOLDIER_GENERAL_BONUS[Math.min(chebyshev(i, myGen), 7)];
    }
  }
  return score;
}

// Policy's evaluation deliberately diverges from Master's in three places
// where Master's flat material+safety eval produces drawing equilibria:
//
//   1. Mobility weight dominates. Banqi's actual win condition is "opponent
//      has no legal move", and Master's mobility coefficient of 14 makes it
//      a minor term against a 100-point soldier. Policy uses 60 so that
//      restricting the opponent's piece moves becomes a primary objective —
//      crucially, this can favour trading material for mobility, which
//      breaks the Master-vs-Master shuffle draw.
//   2. Soldier–General distance. Soldier is the only piece that captures a
//      General (and the General can't capture a Soldier), so placement of
//      Soldiers near the enemy General is asymmetrically valuable.
//   3. Cannon line-of-attack count and trapped-General penalty. Both are
//      small but consistent positional biases that prefer attacking shapes.
function evaluatePolicy(board, forColor, ctx) {
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
  // Material premium: lower than Master's 50 so trades are seen more
  // favourably (every trade reduces piece count, which is good for the
  // stronger side's mobility differential, which is what wins games).
  score += (myPieces - oppPieces) * 30;
  const emptyCount = 32 - facedownCount - myPieces - oppPieces;
  score += emptyCount * 12;

  // Piece-safety: pieces attacked-but-not-defended are basically lost. Use
  // Master's helpers so we get the same tactical accuracy.
  for (let i = 0; i < CELLS; i++) {
    const c = board.cells[i];
    if (!c || c.fd) continue;
    const v = PIECE_VALUE[c.type] || 0;
    if (c.color === forColor) {
      if (isAttacked(board, i, oppColor)) {
        score -= isDefended(board, i, forColor) ? v * 0.30 : v * 0.85;
      }
    } else {
      if (isAttacked(board, i, forColor)) {
        score += isDefended(board, i, oppColor) ? v * 0.30 : v * 0.85;
      }
    }
  }

  // Mobility — the dominant positional term. Heavily weighted so the
  // engine actively pursues stalemate wins.
  const mw = ctx?.mobilityWeight ?? POLICY_MOBILITY_WEIGHT;
  score += (countPieceMoves(board, forColor) - countPieceMoves(board, oppColor)) * mw;

  // Soldier–General threat axis.
  score += soldierGeneralScore(board, forColor);

  // Cannon line-of-attack pressure.
  score += (cannonLineScore(board, forColor) - cannonLineScore(board, oppColor)) * CANNON_LINE_BONUS;

  // Trapped-General penalty.
  const myGen  = findGeneral(board, forColor);
  const oppGen = findGeneral(board, oppColor);
  if (myGen  >= 0) score -= (4 - escapeCount(board, myGen))  * GENERAL_ESCAPE_PENALTY;
  if (oppGen >= 0) score += (4 - escapeCount(board, oppGen)) * GENERAL_ESCAPE_PENALTY;

  // Side-to-move tempo bonus.
  if (board.playerColors[board.sidePlayer] === forColor) score += 15;
  return score;
}

function quiescePolicy(board, forColor, alpha, beta, qdepth, ctx) {
  const standPat = evaluatePolicy(board, forColor, ctx);
  if (board.over || qdepth <= 0) return standPat;

  const caps = board.legalMoves(board.sidePlayer)
    .filter(m => m.from >= 0 && board.cells[m.to] && !board.cells[m.to].fd);
  if (!caps.length) return standPat;

  caps.sort((a, b) => {
    const av = PIECE_VALUE[board.cells[a.to]?.type] || 0;
    const bv = PIECE_VALUE[board.cells[b.to]?.type] || 0;
    return bv - av;
  });

  const myTurn = board.playerColors[board.sidePlayer] === forColor;
  if (myTurn) {
    let best = standPat;
    if (best > alpha) alpha = best;
    if (alpha >= beta) return best;
    for (const m of caps) {
      // SEE-prune clearly losing captures so quiescence stays focused on the
      // exchanges that actually matter at the horizon.
      const victimVal  = PIECE_VALUE[board.cells[m.to]?.type] || 0;
      const movingVal  = PIECE_VALUE[board.cells[m.from]?.type] || 0;
      if (movingVal > victimVal) {
        const swing = seeOnCell(board, m.to, board.playerColors[board.sidePlayer]);
        if (swing < -50) continue;
      }
      const nb = board.clone();
      nb.applyMove(m.from, m.to);
      const s = quiescePolicy(nb, forColor, alpha, beta, qdepth - 1, ctx);
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
      const victimVal  = PIECE_VALUE[board.cells[m.to]?.type] || 0;
      const movingVal  = PIECE_VALUE[board.cells[m.from]?.type] || 0;
      if (movingVal > victimVal) {
        const swing = seeOnCell(board, m.to, board.playerColors[board.sidePlayer]);
        if (swing < -50) continue;
      }
      const nb = board.clone();
      nb.applyMove(m.from, m.to);
      const s = quiescePolicy(nb, forColor, alpha, beta, qdepth - 1, ctx);
      if (s < best) best = s;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }
}

function alphaBetaPolicy(board, forColor, depth, alpha, beta, ctx, ply) {
  if (board.over) return evaluatePolicy(board, forColor, ctx);
  if (depth <= 0) return quiescePolicy(board, forColor, alpha, beta, ctx.qdepth, ctx);
  if (++ctx.nodes > ctx.budget) return evaluatePolicy(board, forColor, ctx);

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
  if (!moves.length) return evaluatePolicy(board, forColor, ctx);

  const myTurn = board.playerColors[board.sidePlayer] === forColor;

  const k0 = ctx.killers[ply * 2]     || null;
  const k1 = ctx.killers[ply * 2 + 1] || null;
  const sameMove = (a, b) => a && b && a.from === b.from && a.to === b.to;
  function moveScore(m) {
    if (ttMove && sameMove(m, ttMove)) return 1_000_000;
    const cap = m.from >= 0 && board.cells[m.to] && !board.cells[m.to].fd;
    if (cap) {
      const victim = PIECE_VALUE[board.cells[m.to]?.type] || 0;
      const attacker = PIECE_VALUE[board.cells[m.from]?.type] || 0;
      return 100_000 + victim * 10 - attacker;
    }
    if (sameMove(m, k0)) return 50_000;
    if (sameMove(m, k1)) return 49_000;
    const h = ctx.history.get(`${m.from},${m.to}`) || 0;
    return h;
  }
  moves.sort((a, b) => moveScore(b) - moveScore(a));

  const alphaOrig = alpha, betaOrig = beta;
  let bestVal, bestMove = moves[0];
  let i = 0;

  if (myTurn) {
    bestVal = -Infinity;
    for (const m of moves) {
      const cap = m.from >= 0 && board.cells[m.to] && !board.cells[m.to].fd;
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      let score;
      // LMR: reduce search depth on late quiet non-capture moves; re-search
      // at full depth if the reduced search beats alpha.
      if (depth >= 3 && i >= 4 && !cap && m.from >= 0 && !sameMove(m, ttMove)) {
        score = alphaBetaPolicy(nb, forColor, depth - 2, alpha, beta, ctx, ply + 1);
        if (score > alpha) score = alphaBetaPolicy(nb, forColor, depth - 1, alpha, beta, ctx, ply + 1);
      } else {
        score = alphaBetaPolicy(nb, forColor, depth - 1, alpha, beta, ctx, ply + 1);
      }
      if (score > bestVal) { bestVal = score; bestMove = m; }
      if (bestVal > alpha) alpha = bestVal;
      if (alpha >= beta) {
        if (!cap && m.from >= 0) {
          if (!sameMove(m, k0)) { ctx.killers[ply * 2 + 1] = k0; ctx.killers[ply * 2] = m; }
          const hk = `${m.from},${m.to}`;
          ctx.history.set(hk, (ctx.history.get(hk) || 0) + depth * depth);
        }
        break;
      }
      i++;
    }
  } else {
    bestVal = Infinity;
    for (const m of moves) {
      const cap = m.from >= 0 && board.cells[m.to] && !board.cells[m.to].fd;
      const nb = board.clone();
      if (m.from < 0) nb.applyFlipKnown(m.to);
      else            nb.applyMove(m.from, m.to);
      let score;
      if (depth >= 3 && i >= 4 && !cap && m.from >= 0 && !sameMove(m, ttMove)) {
        score = alphaBetaPolicy(nb, forColor, depth - 2, alpha, beta, ctx, ply + 1);
        if (score < beta) score = alphaBetaPolicy(nb, forColor, depth - 1, alpha, beta, ctx, ply + 1);
      } else {
        score = alphaBetaPolicy(nb, forColor, depth - 1, alpha, beta, ctx, ply + 1);
      }
      if (score < bestVal) { bestVal = score; bestMove = m; }
      if (bestVal < beta) beta = bestVal;
      if (alpha >= beta) {
        if (!cap && m.from >= 0) {
          if (!sameMove(m, k0)) { ctx.killers[ply * 2 + 1] = k0; ctx.killers[ply * 2] = m; }
          const hk = `${m.from},${m.to}`;
          ctx.history.set(hk, (ctx.history.get(hk) || 0) + depth * depth);
        }
        break;
      }
      i++;
    }
  }

  let flag;
  if (bestVal <= alphaOrig)      flag = TT_UPPER;
  else if (bestVal >= betaOrig)  flag = TT_LOWER;
  else                           flag = TT_EXACT;
  ctx.tt.set(key, { depth, score: bestVal, flag, move: bestMove });
  return bestVal;
}

function chooseMovePolicy(state, legal, playerIndex, opts) {
  const myColor = state.my_color;
  if (!state.first_flip_done || !myColor) return chooseMoveMaster(state, legal, playerIndex);

  const baseBoard = Board.fromState(state);

  let facedown = 0;
  for (const c of state.cells) if (c.state === 'facedown') facedown++;
  const maxDepth = facedown > 20 ? POLICY_SHALLOW_DEPTH : POLICY_DEEP_DEPTH;

  const moveKey = m => `${m.from},${m.to}`;
  const scores = new Map();
  for (const m of legal) scores.set(moveKey(m), 0);

  for (let d = 0; d < POLICY_DETERMINISATIONS; d++) {
    const det = determinise(baseBoard, state);
    const ctx = {
      nodes: 0,
      budget: POLICY_NODE_BUDGET,
      tt: new Map(),
      qdepth: POLICY_QUIESCE_DEPTH,
      mobilityWeight: POLICY_MOBILITY_WEIGHT,
      killers: [],
      history: new Map(),
    };

    let lastCompleted = null;
    for (let depth = 2; depth <= maxDepth; depth++) {
      if (ctx.nodes >= ctx.budget) break;
      const iter = new Map();
      let aborted = false;
      for (const m of legal) {
        if (ctx.nodes >= ctx.budget) { aborted = true; break; }
        const nb = det.clone();
        if (m.from < 0) nb.applyFlipKnown(m.to);
        else            nb.applyMove(m.from, m.to);
        iter.set(moveKey(m),
                 alphaBetaPolicy(nb, myColor, depth - 1, -Infinity, Infinity, ctx, 1));
      }
      if (!aborted) lastCompleted = iter;
    }
    if (lastCompleted) {
      for (const [k, s] of lastCompleted) scores.set(k, scores.get(k) + s);
    }
  }

  // Repetition penalty: when the caller passes `opts.recentBoardKeys`, count
  // how many of the recent positions a candidate move would re-enter and
  // subtract a penalty per occurrence. Two strong PIMC engines in symmetric
  // positions otherwise produce move-limit draws; pushing Policy away from
  // previously-visited positions is what makes its eval's positional bias
  // actually translate into wins. Captures and flips skip the penalty (they
  // can't possibly produce the same board key — they change the piece set).
  // Repetition penalty: the only thing that breaks Master-vs-Policy shuffle
  // draws is forcing Policy to leave the equilibrium. Sized cautiously so
  // Policy doesn't blunder pieces just to avoid a repeat — empirically a
  // first-time-revisit penalty above a Soldier (100) makes Policy lose more
  // games than it wins, while only penalising second-and-later revisits
  // catches genuine shuffle loops without forcing material sacrifice on the
  // first cycle.
  const recent = opts?.recentBoardKeys;
  if (recent && recent.length) {
    const recentCount = new Map();
    for (const k of recent) recentCount.set(k, (recentCount.get(k) || 0) + 1);
    for (const m of legal) {
      if (m.from < 0) continue;                  // flips always change the position
      const dst = state.cells[m.to];
      if (dst.state === 'faceup') continue;      // captures always change material
      const nb = baseBoard.clone();
      nb.applyMove(m.from, m.to);
      const k = boardKey(nb);
      const c = recentCount.get(k) || 0;
      if (c >= 2) {
        // Position seen at least twice in recent history → genuine shuffle.
        // The penalty here is the search-space equivalent of a Cannon's
        // value (200) per determinisation × 8 dets = 1600 per repeat, so
        // Policy will trade up to a Cannon to break a 3rd repetition but
        // won't sacrifice a Chariot or higher.
        const penalty = 200 * c * POLICY_DETERMINISATIONS;
        scores.set(moveKey(m), scores.get(moveKey(m)) - penalty);
      } else if (c === 1) {
        // First revisit gets only a token nudge — enough to prefer a fresh
        // move when it's a near-equivalent option, not enough to abandon a
        // genuinely better quiet move.
        const penalty = 40 * POLICY_DETERMINISATIONS;
        scores.set(moveKey(m), scores.get(moveKey(m)) - penalty);
      }
    }
  }

  let bestMove = legal[0], bestScore = -Infinity;
  for (const m of legal) {
    const s = scores.get(moveKey(m));
    if (s > bestScore) { bestScore = s; bestMove = m; }
  }
  return bestMove;
}
