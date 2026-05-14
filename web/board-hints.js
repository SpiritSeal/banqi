// Pure helpers for deriving move-hint state from a game state.
//
// Shared between the three game modes (online, OTB, vs-AI) so they all
// light up the same "legal" / "legal-target" decorations consistently.
//
// The OTB code path calls Game.stateJson(-1), which produces a state with
// my_player_index === -1 (no specific viewer). The engine still populates
// legal_moves_for_me for the side to move, so hints apply to whoever is
// up next. Online and vs-AI pass a concrete viewer (0 or 1) and hints
// only apply on the viewer's turn.
//
// Kept DOM-free so it can be unit-tested in Node without Playwright.

// Returns true when the renderer should light up legal-move decorations
// for the current cell of the board.
export function isLiveTurnForViewer(state) {
  if (!state) return false;
  if (state.game_over) return false;
  if (state.replayViewing) return false;
  // OTB / omniscient viewer: legal_moves_for_me already reflects the side
  // to move, so hints apply to whoever is up.
  if (state.my_player_index == null || state.my_player_index < 0) return true;
  return state.side_to_move === state.my_player_index;
}

// Bucket the legal moves into flip targets, move sources, and a src→dst map.
// When the turn isn't live, returns empty collections so render code can
// branch on `.live` without special-casing the rest of the data.
export function computeMoveHints(state) {
  const flipTargets = new Set();
  const moveSources = new Set();
  const moveTargetsBySrc = new Map();
  const live = isLiveTurnForViewer(state);
  if (!live) return { live, flipTargets, moveSources, moveTargetsBySrc };
  const legal = state?.legal_moves_for_me || [];
  for (const m of legal) {
    if (m.from < 0) {
      flipTargets.add(m.to);
    } else {
      moveSources.add(m.from);
      let dsts = moveTargetsBySrc.get(m.from);
      if (!dsts) { dsts = new Set(); moveTargetsBySrc.set(m.from, dsts); }
      dsts.add(m.to);
    }
  }
  return { live, flipTargets, moveSources, moveTargetsBySrc };
}

// Returns the hint kind for cell `i` given the current selection (or null).
// One of: 'flip', 'movable', 'move-target', or null.
//   * 'move-target' — cell i is a legal destination for the selected piece
//   * 'flip'        — cell i is a face-down piece that can be flipped
//   * 'movable'     — cell i is one of your face-up pieces that has a move
export function cellHintKind(hints, selected, i) {
  if (!hints || !hints.live) return null;
  if (selected != null) {
    return hints.moveTargetsBySrc.get(selected)?.has(i) ? 'move-target' : null;
  }
  if (hints.flipTargets.has(i)) return 'flip';
  if (hints.moveSources.has(i)) return 'movable';
  return null;
}
