/**
 * Optimality certificate verification.
 *
 * A solution to the dispatch problem is optimal if and only if there exist
 * duals (alpha, beta) satisfying, for the given problem:
 *
 *   (D1) alpha[i] >= 0 for every worker i
 *   (D2) alpha[i] === 0 for every idle (unassigned) worker i
 *   (D3) beta[j] <= delayCost[j] for every task j
 *   (D4) beta[j] === delayCost[j] for every delayed task j
 *   (D5) beta[j] - alpha[i] <= cost[i][j] for every allowed pair (i, j)
 *   (D6) beta[j] - alpha[i] === cost[i][j] for every assigned pair (i, j)
 *   (D7) sum(beta) - sum(alpha) === totalCost
 *
 * (D1)-(D6) are dual feasibility + complementary slackness for the LP
 *   min  sum c_ij x_ij + sum d_j z_j
 *   s.t. sum_j x_ij <= 1,  sum_i x_ij + z_j = 1,  x,z >= 0
 * and (D7) makes the primal and dual objectives coincide, which by weak
 * duality proves optimality. Every check is a per-pair / per-index
 * arithmetic test, so callers can verify a certificate independently.
 *
 * Forbidden pairs are excluded from (D5)/(D6): they carry no dual
 * constraint (the structural guarantee "no forbidden pair is ever
 * assigned" is checked separately by assertAssignmentConsistent).
 */

import { DispatchProblem, DispatchSolution, UNASSIGNED } from '../solver/types';

export const DEFAULT_TOLERANCE = 1e-6;

export interface CertificateViolation {
  check: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'CONSISTENCY';
  worker?: number;
  task?: number;
  message: string;
}

export interface CertificateVerification {
  valid: boolean;
  violations: CertificateViolation[];
}

function tol(value: number, tolerance: number): number {
  return tolerance * Math.max(1, Math.abs(value));
}

/** Structural checks: the assignment itself is well-formed and respects forbidden pairs. */
export function assertAssignmentConsistent(
  problem: DispatchProblem,
  solution: Pick<DispatchSolution, 'assignment' | 'taskWorker' | 'delayed' | 'totalCost'>,
): CertificateViolation[] {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const violations: CertificateViolation[] = [];
  const seenTask = new Array<boolean>(T).fill(false);
  let recomputed = 0;

  for (let i = 0; i < W; i++) {
    const j = solution.assignment[i];
    if (j === UNASSIGNED) continue;
    if (j < 0 || j >= T) {
      violations.push({ check: 'CONSISTENCY', worker: i, message: `worker ${i} assigned to out-of-range task ${j}` });
      continue;
    }
    if (forbidden[i][j]) {
      violations.push({ check: 'CONSISTENCY', worker: i, task: j, message: `forbidden pair (${i}, ${j}) assigned` });
    }
    if (seenTask[j]) {
      violations.push({ check: 'CONSISTENCY', worker: i, task: j, message: `task ${j} assigned to more than one worker` });
    }
    seenTask[j] = true;
    if (solution.taskWorker[j] !== i) {
      violations.push({ check: 'CONSISTENCY', worker: i, task: j, message: `taskWorker[${j}] does not point back to worker ${i}` });
    }
    if (solution.delayed[j]) {
      violations.push({ check: 'CONSISTENCY', worker: i, task: j, message: `task ${j} both assigned and delayed` });
    }
    recomputed += cost[i][j];
  }
  for (let j = 0; j < T; j++) {
    if (!seenTask[j] && !solution.delayed[j]) {
      violations.push({ check: 'CONSISTENCY', task: j, message: `task ${j} neither assigned nor delayed` });
    }
    if (solution.delayed[j]) recomputed += delayCost[j];
  }
  if (Math.abs(recomputed - solution.totalCost) > tol(recomputed, DEFAULT_TOLERANCE)) {
    violations.push({
      check: 'CONSISTENCY',
      message: `totalCost ${solution.totalCost} does not match recomputed ${recomputed}`,
    });
  }
  return violations;
}

export function verifyCertificate(
  problem: DispatchProblem,
  solution: DispatchSolution,
  tolerance: number = DEFAULT_TOLERANCE,
): CertificateVerification {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const violations: CertificateViolation[] = [];
  const { alpha, beta, assignment, delayed, totalCost } = solution;

  violations.push(...assertAssignmentConsistent(problem, solution));

  for (let i = 0; i < W; i++) {
    if (alpha[i] < -tol(alpha[i], tolerance)) {
      violations.push({ check: 'D1', worker: i, message: `alpha[${i}] = ${alpha[i]} < 0` });
    }
    if (assignment[i] === UNASSIGNED && Math.abs(alpha[i]) > tolerance) {
      violations.push({ check: 'D2', worker: i, message: `idle worker ${i} has alpha ${alpha[i]} != 0` });
    }
  }
  for (let j = 0; j < T; j++) {
    if (beta[j] - delayCost[j] > tol(delayCost[j], tolerance)) {
      violations.push({ check: 'D3', task: j, message: `beta[${j}] = ${beta[j]} > delayCost ${delayCost[j]}` });
    }
    if (delayed[j] && Math.abs(beta[j] - delayCost[j]) > tol(delayCost[j], tolerance)) {
      violations.push({ check: 'D4', task: j, message: `delayed task ${j} has beta ${beta[j]} != delayCost ${delayCost[j]}` });
    }
  }
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < T; j++) {
      if (forbidden[i][j]) continue;
      const lhs = beta[j] - alpha[i];
      if (lhs - cost[i][j] > tol(cost[i][j], tolerance)) {
        violations.push({
          check: 'D5',
          worker: i,
          task: j,
          message: `beta[${j}] - alpha[${i}] = ${lhs} > cost ${cost[i][j]}`,
        });
      }
    }
  }
  for (let i = 0; i < W; i++) {
    const j = assignment[i];
    if (j === UNASSIGNED || j < 0 || j >= T) continue;
    const lhs = beta[j] - alpha[i];
    if (Math.abs(lhs - cost[i][j]) > tol(cost[i][j], tolerance)) {
      violations.push({
        check: 'D6',
        worker: i,
        task: j,
        message: `assigned pair (${i}, ${j}): beta - alpha = ${lhs} != cost ${cost[i][j]}`,
      });
    }
  }
  let dualObjective = 0;
  for (let j = 0; j < T; j++) dualObjective += beta[j];
  for (let i = 0; i < W; i++) dualObjective -= alpha[i];
  if (Math.abs(dualObjective - totalCost) > tol(totalCost, tolerance)) {
    violations.push({
      check: 'D7',
      message: `dual objective ${dualObjective} != totalCost ${totalCost}`,
    });
  }

  return { valid: violations.length === 0, violations };
}
