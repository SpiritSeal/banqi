// In-memory stand-in for the WASM-backed Banqi rules engine. Exposes the
// same surface the server's game_engine.mjs touches:
//
//   Module.Game.create()                  → FakeGame
//   Module.Game.createWithMode(mode)      → FakeGame
//   Module.Game.fromSnapshot(snapJson)    → FakeGame  (restores state)
//   game.applyFlip(pi, cell)              → JSON string of the revealed piece
//   game.applyMove(pi, from, to)          → void
//   game.applyResign(pi)                  → void
//   game.gameOver()                       → bool
//   game.winner()                         → 0 | 1 | 2 | null
//   game.stateJson(viewerIndex)           → JSON string
//   game.snapshotJson()                   → JSON string
//
// The fake is permissive on legality (any face-down cell can be flipped, any
// face-up cell can move to any non-friendly cell) because the clock tests
// don't care about Banqi rules — they only care about turn-order, first-flip
// transitions, and that move kinds round-trip through stateJson. Tests that
// need to exercise real Banqi rules should use the WASM-backed engine.

class FakeGame {
  constructor(mode = 'standard') {
    this.mode = mode;
    this._firstFlipDone = false;
    this._sideToMove = 0;
    this._gameOver = false;
    this._winner = null;          // 0 (draw) | 1 (red) | 2 (black) | null
    this._player0Color = 0;
    this._player1Color = 0;
    this._cells = Array.from({ length: 32 }, () => ({ state: 'facedown' }));
  }

  static fromSnapshot(snapJson) {
    const g = new FakeGame();
    const snap = JSON.parse(snapJson);
    g.mode            = snap.mode               ?? 'standard';
    g._firstFlipDone  = snap.first_flip_done    ?? false;
    g._sideToMove     = snap.side_to_move_player ?? 0;
    g._gameOver       = snap.game_over          ?? false;
    g._winner         = snap.winner             ?? null;
    g._player0Color   = snap.player0_color      ?? 0;
    g._player1Color   = snap.player1_color      ?? 0;
    g._cells          = snap.cells              ?? g._cells;
    return g;
  }

  // Snapshot field names mirror the real C++ engine (src/game.cpp
  // snapshot_json). The server-side fix that pins side_to_move_player when a
  // directed-challenge first-mover was chosen mutates this field by name on
  // the snapshot JSON, so the fake has to use the same names for tests to
  // exercise that path.
  snapshotJson() {
    return JSON.stringify({
      mode:                this.mode,
      first_flip_done:     this._firstFlipDone,
      side_to_move_player: this._sideToMove,
      game_over:           this._gameOver,
      winner:              this._winner,
      player0_color:       this._player0Color,
      player1_color:       this._player1Color,
      cells:               this._cells,
    });
  }

  stateJson(viewerIndex) {
    const my_color =
      viewerIndex === 0 ? this._player0Color :
      viewerIndex === 1 ? this._player1Color : 0;
    return JSON.stringify({
      cells:              this._cells,
      first_flip_done:    this._firstFlipDone,
      side_to_move:       this._sideToMove,
      my_player_index:    viewerIndex,
      player0_color:      this._player0Color,
      player1_color:      this._player1Color,
      game_over:          this._gameOver,
      legal_moves_for_me: this._legalMovesForViewer(viewerIndex),
      winner:             this._winner,
      terminal_reason:    this._terminalReason || 'none',
      plies_since_progress:  0,
      my_color,
      mode:               this.mode,
    });
  }

  _legalMovesForViewer(viewerIndex) {
    if (this._gameOver) return [];
    // Mirror BanqiRules::legal_moves: returns empty unless the viewer IS the
    // side to move, both pre- and post-first-flip. The previous fake gave
    // every face-down cell to either side pre-flip, hiding the bug where the
    // server didn't reflect a directed-challenge first-mover in the WASM's
    // side_to_move_player.
    if (viewerIndex !== this._sideToMove) return [];
    if (!this._firstFlipDone) {
      const m = [];
      for (let i = 0; i < 32; i++) {
        if (this._cells[i].state === 'facedown') m.push({ from: -1, to: i });
      }
      return m;
    }
    const myColor = viewerIndex === 0 ? this._player0Color : this._player1Color;
    const moves = [];
    for (let i = 0; i < 32; i++) {
      if (this._cells[i].state === 'facedown') moves.push({ from: -1, to: i });
      if (this._cells[i].state === 'faceup' && this._cells[i].color === myColor) {
        for (let j = 0; j < 32; j++) {
          if (i === j) continue;
          const c = this._cells[j];
          if (c.state === 'faceup' && c.color === myColor) continue;
          moves.push({ from: i, to: j });
        }
      }
    }
    return moves;
  }

  applyFlip(pi, cell) {
    if (this._gameOver) throw new Error('game over');
    // Mirror Game::check_turn in the real engine: side_to_move_player_ is
    // authoritative for whose flip is legal, including pre-first-flip. The
    // previous fake silently accepted any side's opening flip, masking the
    // bug where a directed-challenge seat-1 first-mover saw their flip
    // rejected because the WASM default initial side is 0.
    if (pi !== this._sideToMove) throw new Error('not your turn');
    if (!Number.isInteger(cell) || cell < 0 || cell >= 32) throw new Error('bad cell');
    if (this._cells[cell].state !== 'facedown') throw new Error('not facedown');
    // Deterministic reveal: cell index parity → color, fixed type/glyph.
    // First flip's revealed color becomes the mover's color.
    const revealedColor = (cell % 2) + 1;            // 1 or 2
    const piece = { color: revealedColor, type: 3, glyph: 'X' };
    this._cells[cell] = { state: 'faceup', ...piece };
    if (!this._firstFlipDone) {
      this._firstFlipDone = true;
      if (pi === 0) {
        this._player0Color = revealedColor;
        this._player1Color = revealedColor === 1 ? 2 : 1;
      } else {
        this._player1Color = revealedColor;
        this._player0Color = revealedColor === 1 ? 2 : 1;
      }
    }
    this._sideToMove = 1 - pi;
    return JSON.stringify(piece);
  }

  applyMove(pi, from, to) {
    if (this._gameOver) throw new Error('game over');
    if (pi !== this._sideToMove) throw new Error('not your turn');
    if (!Number.isInteger(from) || from < 0 || from >= 32) throw new Error('bad from');
    if (!Number.isInteger(to)   || to   < 0 || to   >= 32) throw new Error('bad to');
    if (this._cells[from].state !== 'faceup') throw new Error('source not faceup');
    this._cells[to]   = { ...this._cells[from] };
    this._cells[from] = { state: 'empty' };
    this._sideToMove  = 1 - pi;
  }

  applyResign(pi) {
    this._gameOver = true;
    // Opponent wins; map their seat-color to the winner field.
    this._winner = (pi === 0 ? this._player1Color : this._player0Color) || (pi === 0 ? 2 : 1);
    this._terminalReason = 'resigned';
  }

  gameOver() { return this._gameOver; }
  winner()   { return this._winner; }
}

// Match the shape returned by `await createBanqi()`. The engine awaits a
// loader function, so we mimic the same pattern: callers either pass a
// pre-built module object or a zero-arg async loader. `fakeBanqiModule()`
// returns the module object directly (already "loaded").
export function fakeBanqiModule() {
  return {
    Game: {
      create:         ()       => new FakeGame('standard'),
      createWithMode: (mode)   => new FakeGame(mode || 'standard'),
      fromSnapshot:   (snap)   => FakeGame.fromSnapshot(snap),
    },
  };
}
