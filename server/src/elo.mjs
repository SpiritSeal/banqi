// Classic Elo with K=32 (typical for casual play). Draws aren't currently
// produced by the rules engine; included for completeness.

const K = 32;

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// score: 1 = win, 0.5 = draw, 0 = loss
export function eloDelta(myElo, opponentElo, score) {
  return Math.round(K * (score - expected(myElo, opponentElo)));
}
