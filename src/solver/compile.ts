/**
 * Compilation of the dispatch problem to an equivalent square assignment
 * problem (perfect matching on an N x N matrix, N = W + T):
 *
 *   rows  0..W-1        real workers
 *   rows  W..W+T-1      delay row of task j (task j left unassigned)
 *   cols  0..T-1        real tasks
 *   cols  T..T+W-1      idle columns (worker rests / delay slot unused)
 *
 *   C[i][j]        = cost[i][j]            worker i does task j (BIG if forbidden)
 *   C[i][T+k]      = 0                     worker i idles
 *   C[W+j][j]      = delayCost[j]          task j delayed
 *   C[W+j][j']     = BIG  (j' != j)        delay slot of j cannot cover j'
 *   C[W+j][T+k]    = 0                     delay slot unused
 *
 * Every perfect matching of the padded matrix corresponds to a dispatch
 * solution of identical cost, and vice versa. BIG is chosen larger than
 * any achievable spread of legitimate costs, so an optimal matching never
 * uses a BIG edge (a BIG-free perfect matching always exists: delay every
 * task, idle every worker).
 *
 * The classical invariants hold exactly on this compiled form:
 *   - adding a constant to any row or column leaves the optimal matching
 *     unchanged (and shifts the optimum by that constant);
 *   - the transposed matrix has the same optimal value.
 */

import { DispatchProblem } from './types';

export interface CompiledProblem {
  size: number;
  matrix: number[][];
  /** bigM used for forbidden / impossible entries. */
  bigM: number;
}

export function computeBigM(problem: DispatchProblem): number {
  let sum = 0;
  for (let i = 0; i < problem.workerCount; i++) {
    for (let j = 0; j < problem.taskCount; j++) {
      if (!problem.forbidden[i][j]) sum += Math.abs(problem.cost[i][j]);
    }
  }
  for (let j = 0; j < problem.taskCount; j++) sum += Math.abs(problem.delayCost[j]);
  const n = problem.workerCount + problem.taskCount;
  return 10 * (n + 1) * (sum + 1);
}

export function compileToSquareMatrix(problem: DispatchProblem): CompiledProblem {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const n = W + T;
  const bigM = computeBigM(problem);
  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < T; j++) {
      matrix[i][j] = forbidden[i][j] ? bigM : cost[i][j];
    }
    // idle columns stay 0
  }
  for (let j = 0; j < T; j++) {
    for (let j2 = 0; j2 < T; j2++) {
      matrix[W + j][j2] = j2 === j ? delayCost[j] : bigM;
    }
    // idle columns stay 0
  }
  return { size: n, matrix, bigM };
}
