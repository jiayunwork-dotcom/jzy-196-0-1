/**
 * Incremental repair: re-optimize after a small change by warm-starting
 * from the previous version's matching and dual values instead of solving
 * from scratch.
 *
 * Input is the NEW problem plus the previous solver state mapped into the
 * new index space (entries of removed workers/tasks dropped; brand-new
 * tasks carry beta = +Infinity and are unmatched). The repair then:
 *
 *   1. breaks matched pairs that are no longer valid (forbidden by an
 *      override, or no longer tight after a cost change);
 *   2. resets alpha of idle workers to 0 (required by the certificate:
 *      idle <=> alpha = 0) and restores dual feasibility by lowering
 *      beta[j] := min(delayCost[j], min_i alpha[i] + cost[i][j]);
 *      lowering beta can break the tightness of that task's matched edge,
 *      in which case the pair is unmatched and the cascade repeats
 *      (finitely: matches only break, never form, during repair);
 *   3. re-runs the primal-dual augmentation phases for every unmatched
 *      task (solver.completeMatching), which provably terminates with an
 *      optimal matching for the new problem.
 *
 * Because step 3 is exactly the from-scratch algorithm started from a
 * feasible dual solution and a valid partial tight matching, the result
 * is optimal for the new problem; the test suite asserts that the
 * objective value always equals the from-scratch objective.
 */

import { completeMatching, DELAYED, SolverState } from '../solver/dispatch-solver';
import { DispatchProblem, DispatchSolution, UNASSIGNED } from '../solver/types';
import { buildSolution } from '../solver/dispatch-solver';

export interface WarmStart {
  matchT: number[];
  matchW: number[];
  alpha: number[];
  beta: number[];
}

const TIGHT_EPS = 1e-9;

function isTight(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIGHT_EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

export function solveIncremental(problem: DispatchProblem, warm: WarmStart): DispatchSolution {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const state: SolverState = {
    matchT: warm.matchT.slice(),
    matchW: warm.matchW.slice(),
    alpha: warm.alpha.slice(),
    beta: warm.beta.slice(),
  };

  // Step 1: drop pairs that are forbidden or no longer tight.
  for (let j = 0; j < T; j++) {
    const m = state.matchT[j];
    if (m >= 0) {
      const broken =
        forbidden[m][j] || !isTight(state.beta[j] - state.alpha[m], cost[m][j]);
      if (broken) {
        state.matchT[j] = UNASSIGNED;
        state.matchW[m] = UNASSIGNED;
      }
    } else if (m === DELAYED) {
      if (!isTight(state.beta[j], delayCost[j])) {
        state.matchT[j] = UNASSIGNED;
      }
    }
  }

  // Step 2: restore dual feasibility (fixpoint; matches only break).
  for (;;) {
    let changed = false;
    for (let i = 0; i < W; i++) {
      if (state.matchW[i] === UNASSIGNED && state.alpha[i] !== 0) {
        state.alpha[i] = 0;
        changed = true;
      }
    }
    for (let j = 0; j < T; j++) {
      let b = delayCost[j];
      for (let i = 0; i < W; i++) {
        if (!forbidden[i][j]) {
          const cand = state.alpha[i] + cost[i][j];
          if (cand < b) b = cand;
        }
      }
      if (b < state.beta[j]) {
        state.beta[j] = b;
        const m = state.matchT[j];
        if (m >= 0 && !isTight(state.beta[j] - state.alpha[m], cost[m][j])) {
          state.matchT[j] = UNASSIGNED;
          state.matchW[m] = UNASSIGNED;
        } else if (m === DELAYED && !isTight(state.beta[j], delayCost[j])) {
          state.matchT[j] = UNASSIGNED;
        }
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Step 3: complete the matching optimally.
  completeMatching(problem, state);
  return buildSolution(problem, state);
}
