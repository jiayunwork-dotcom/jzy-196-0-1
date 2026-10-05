/**
 * Core types for the dispatch assignment problem.
 *
 * Problem: rectangular assignment with forbidden pairs.
 *  - Every task must be covered: either assigned to exactly one worker,
 *    or left unassigned ("delayed") paying its own delay cost.
 *  - Every worker is assigned to at most one task; idle workers cost 0.
 *  - Forbidden pairs may never be assigned.
 *
 * The solver is index-based (0..W-1 workers, 0..T-1 tasks); the service
 * layer maps ids <-> indices.
 */

/** cost[i][j] is finite for allowed pairs; forbidden pairs are listed in `forbidden`. */
export interface DispatchProblem {
  workerCount: number;
  taskCount: number;
  /** cost[i][j]: cost of assigning worker i to task j. Meaningless where forbidden. */
  cost: number[][];
  /** delayCost[j]: cost of leaving task j unassigned. */
  delayCost: number[];
  /** forbidden[i][j]: true when pair (i, j) may not be assigned. */
  forbidden: boolean[][];
}

export const UNASSIGNED = -1;

export interface DispatchSolution {
  /** assignment[i] = task index assigned to worker i, or UNASSIGNED. */
  assignment: number[];
  /** taskWorker[j] = worker index assigned to task j, or UNASSIGNED (delayed). */
  taskWorker: number[];
  /** delayed[j] = true when task j is left unassigned (delay cost applies). */
  delayed: boolean[];
  /** Total cost: sum of assigned pair costs + sum of delay costs of delayed tasks. */
  totalCost: number;
  /**
   * Dual certificate (see certificate/verify.ts):
   *  - alpha[i] >= 0, and alpha[i] === 0 when worker i is idle
   *  - beta[j] <= delayCost[j], and beta[j] === delayCost[j] when task j is delayed
   *  - beta[j] - alpha[i] <= cost[i][j] for every allowed pair
   *  - beta[j] - alpha[i] === cost[i][j] for every assigned pair
   *  - sum(beta) - sum(alpha) === totalCost
   */
  alpha: number[];
  beta: number[];
  /** Workers whose every pair is forbidden (they can never be assigned). */
  unassignableWorkers: number[];
  /** Tasks whose every pair is forbidden (they are always delayed). */
  unassignableTasks: number[];
}

export function emptyProblem(workerCount: number, taskCount: number): DispatchProblem {
  return {
    workerCount,
    taskCount,
    cost: Array.from({ length: workerCount }, () => new Array<number>(taskCount).fill(0)),
    delayCost: new Array<number>(taskCount).fill(0),
    forbidden: Array.from({ length: workerCount }, () => new Array<boolean>(taskCount).fill(false)),
  };
}
