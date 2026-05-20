// Quick timing/throughput probe for chooseMove on a fixed early-game state.
// Used to compare difficulties under matching positions.

import createBanqiModule from '../web/banqi.js';
import { chooseMove, Difficulty } from '../web/ai.js';

const Module = await createBanqiModule();

// Bring the game to a representative mid-game position: do a few flips and
// some moves so legal_moves_for_me has a typical mid-game branching factor.
const g = Module.Game.create();
g.applyFlip(0, 12);   // P0 first flip — assigns colors
g.applyFlip(1, 19);   // P1 reveal
g.applyFlip(0, 5);
g.applyFlip(1, 22);
g.applyFlip(0, 17);
g.applyFlip(1, 4);

for (const diff of [Difficulty.MASTER, Difficulty.POLICY]) {
  const stm = g.sideToMovePlayer();
  const st = JSON.parse(g.stateJson(stm));
  const t0 = performance.now();
  const m = chooseMove(st, st.my_player_index, diff);
  const dt = performance.now() - t0;
  console.log(`${diff.padEnd(6)} → move from=${m.from} to=${m.to} in ${dt.toFixed(0)} ms`);
}
