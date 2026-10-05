/**
 * Replanning policy: stability penalty.
 *
 * When re-solving after a change we do NOT minimize raw cost alone; we
 * minimize
 *
 *      rawCost(plan) + rho * (#workers whose assignment differs from the
 *                              previous version)
 *
 * where rawCost = sum of pair costs + sum of delay costs under the TRUE
 * costs, and "differs" covers task A -> task B, task -> idle and
 * idle -> task. Workers removed by the change (e.g. unavailable) are not
 * counted. rho >= 0 is the price (in cost units) of reassigning one
 * person; rho = 0 reduces to plain re-optimization.
 *
 * The property is exactly verifiable: the returned plan minimizes the
 * penalized objective over ALL feasible plans, and the dual certificate
 * we return proves it for the transformed costs below. The test suite
 * checks the claim by exhaustive enumeration on small instances.
 *
 * Transformation to a plain dispatch problem (so the same solver and
 * certificate machinery apply unchanged):
 *   - worker previously assigned to task j0:
 *       cost'(i, j0) = cost(i, j0) - rho
 *       cost'(i, j)  = cost(i, j)          (j != j0)
 *       constant    += rho
 *     (staying on j0 pays cost - rho + rho = cost; moving elsewhere or
 *      going idle pays an extra rho overall)
 *   - worker previously idle:
 *       cost'(i, j)  = cost(i, j) + rho    (all j)
 *     (taking any task pays one rho; staying idle pays nothing)
 *   - delay costs are unchanged.
 * Then  penalizedObjective = solverTotal(cost') + constant.
 */

import { DispatchProblem, UNASSIGNED } from '../solver/types';

export interface StabilizedProblem {
  problem: DispatchProblem;
  /** Add this constant to the solver's totalCost to get the penalized objective. */
  constant: number;
  rho: number;
}

/**
 * @param problem        the (already updated) dispatch problem with true costs
 * @param previousAssignment  previous assignment in the CURRENT index space:
 *        previousAssignment[i] = task index worker i had before, or UNASSIGNED
 *        (also for workers whose previous task no longer exists)
 * @param rho            reassignment penalty, >= 0
 */
export function buildStabilizedProblem(
  problem: DispatchProblem,
  previousAssignment: number[],
  rho: number,
): StabilizedProblem {
  if (rho < 0 || !Number.isFinite(rho)) {
    throw new Error(`reassignment penalty must be a finite number >= 0, got ${rho}`);
  }
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const newCost: number[][] = Array.from({ length: W }, (_, i) => cost[i].slice());
  let constant = 0;
  for (let i = 0; i < W; i++) {
    const prev = previousAssignment[i];
    if (prev === undefined || prev === UNASSIGNED || prev < 0 || prev >= T) {
      // Previously idle (or previous task is gone): any assignment costs rho.
      if (rho !== 0) {
        for (let j = 0; j < T; j++) newCost[i][j] = cost[i][j] + rho;
      }
    } else {
      // Previously on task prev: keeping it is rewarded by rho (equivalently,
      // leaving it costs rho, including going idle -> accounted via constant).
      newCost[i][prev] = cost[i][prev] - rho;
      constant += rho;
    }
  }
  return {
    problem: {
      workerCount: W,
      taskCount: T,
      cost: newCost,
      delayCost: delayCost.slice(),
      forbidden: forbidden.map((row) => row.slice()),
    },
    constant,
    rho,
  };
}

/** Raw cost of a solution under the TRUE costs (what dispatchers care about). */
export function rawCostOf(problem: DispatchProblem, assignment: number[], delayed: boolean[]): number {
  let total = 0;
  for (let i = 0; i < problem.workerCount; i++) {
    const j = assignment[i];
    if (j !== UNASSIGNED) total += problem.cost[i][j];
  }
  for (let j = 0; j < problem.taskCount; j++) {
    if (delayed[j]) total += problem.delayCost[j];
  }
  return total;
}

/** Number of workers whose assignment differs from the previous one. */
export function countReassigned(previousAssignment: number[], newAssignment: number[]): number {
  let changed = 0;
  for (let i = 0; i < newAssignment.length; i++) {
    const prev = previousAssignment[i] === undefined ? UNASSIGNED : previousAssignment[i];
    if (prev !== newAssignment[i]) changed++;
  }
  return changed;
}
