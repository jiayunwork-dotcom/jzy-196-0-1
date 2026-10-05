/**
 * Primal-dual (Hungarian-style) solver for the dispatch assignment problem.
 *
 * Instead of padding the problem to a square matrix, the algorithm works
 * directly on the original bipartite graph:
 *   - tasks are on the left and must ALL be matched (to a worker, or to
 *     their private "delay slot" at cost delayCost[j]);
 *   - workers are on the right and may be left idle (cost 0).
 *
 * It maintains dual values
 *   alpha[i] >= 0                       (worker potentials)
 *   beta[j]  <= delayCost[j]            (task potentials)
 *   beta[j] - alpha[i] <= cost[i][j]    (reduced-cost feasibility)
 * and a matching on tight edges. Complementary slackness at termination:
 *   assigned (i,j)  => beta[j] - alpha[i] === cost[i][j]
 *   idle worker i   => alpha[i] === 0
 *   delayed task j  => beta[j] === delayCost[j]
 * so sum(beta) - sum(alpha) equals the primal cost, which makes the duals
 * a self-contained optimality certificate (see certificate/verify.ts).
 *
 * Determinism: tasks are processed in index order and every "pick the
 * minimum" scan uses strict comparison, so ties always resolve to the
 * lowest index. Same input => same assignment, every time.
 *
 * Complexity: O(T * (W + T) * W); trivial at the dispatch scale (tens).
 */

import { DispatchProblem, DispatchSolution, UNASSIGNED } from './types';

/** matchT[j] === DELAYED means task j is covered by its delay slot. */
export const DELAYED = -2;

/** Mutable solver state; exposed so incremental repair can warm-start. */
export interface SolverState {
  /** matchT[j] = worker index, UNASSIGNED (not processed yet) or DELAYED. */
  matchT: number[];
  /** matchW[i] = task index or UNASSIGNED. */
  matchW: number[];
  alpha: number[];
  beta: number[];
}

export function initialState(problem: DispatchProblem): SolverState {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const alpha = new Array<number>(W).fill(0);
  const beta = new Array<number>(T);
  for (let j = 0; j < T; j++) {
    let b = delayCost[j];
    for (let i = 0; i < W; i++) {
      if (!forbidden[i][j] && cost[i][j] < b) b = cost[i][j];
    }
    beta[j] = b;
  }
  return {
    matchT: new Array<number>(T).fill(UNASSIGNED),
    matchW: new Array<number>(W).fill(UNASSIGNED),
    alpha,
    beta,
  };
}

/** Per-phase scratch, allocated once and reused across phases. */
class PhaseScratch {
  readonly parentT: number[];
  readonly parentW: number[];
  readonly inTreeT: boolean[];
  readonly inTreeW: boolean[];
  readonly slack: number[];
  readonly slackFrom: number[];

  constructor(problem: DispatchProblem) {
    this.parentT = new Array<number>(problem.taskCount);
    this.parentW = new Array<number>(problem.workerCount);
    this.inTreeT = new Array<boolean>(problem.taskCount);
    this.inTreeW = new Array<boolean>(problem.workerCount);
    this.slack = new Array<number>(problem.workerCount);
    this.slackFrom = new Array<number>(problem.workerCount);
  }

  reset(): void {
    this.parentT.fill(UNASSIGNED);
    this.parentW.fill(UNASSIGNED);
    this.inTreeT.fill(false);
    this.inTreeW.fill(false);
    this.slack.fill(Number.POSITIVE_INFINITY);
    this.slackFrom.fill(UNASSIGNED);
  }
}

export function solveDispatch(problem: DispatchProblem, state?: SolverState): DispatchSolution {
  const st = state ?? initialState(problem);
  const scratch = new PhaseScratch(problem);
  for (let r = 0; r < problem.taskCount; r++) {
    if (st.matchT[r] === UNASSIGNED) {
      augmentFrom(problem, st, scratch, r);
    }
  }
  return buildSolution(problem, st);
}

/**
 * Re-run augmentation phases for every currently-unmatched task.
 * Used by incremental repair after the warm-start state has been fixed up;
 * duals must be feasible and surviving matched edges tight on entry.
 */
export function completeMatching(problem: DispatchProblem, state: SolverState): void {
  const scratch = new PhaseScratch(problem);
  for (let r = 0; r < problem.taskCount; r++) {
    if (state.matchT[r] === UNASSIGNED) {
      augmentFrom(problem, state, scratch, r);
    }
  }
}

function augmentFrom(problem: DispatchProblem, st: SolverState, sc: PhaseScratch, root: number): void {
  const { workerCount: W, cost, delayCost, forbidden } = problem;
  const { alpha, beta, matchT, matchW } = st;
  sc.reset();

  const addTaskToTree = (j: number, viaWorker: number): void => {
    sc.inTreeT[j] = true;
    sc.parentT[j] = viaWorker;
    for (let i = 0; i < W; i++) {
      if (sc.inTreeW[i] || forbidden[i][j]) continue;
      const val = cost[i][j] - beta[j] + alpha[i];
      if (val < sc.slack[i]) {
        sc.slack[i] = val;
        sc.slackFrom[i] = j;
      }
    }
  };

  addTaskToTree(root, UNASSIGNED);
  // Minimum delay slack among tree tasks, and the task attaining it.
  let delayMin = delayCost[root] - beta[root];
  let delayArg = root;

  for (;;) {
    // Smallest slack over workers not in the tree (lowest index on ties).
    let workerDelta = Number.POSITIVE_INFINITY;
    let nextW = UNASSIGNED;
    for (let i = 0; i < W; i++) {
      if (!sc.inTreeW[i] && sc.slack[i] < workerDelta) {
        workerDelta = sc.slack[i];
        nextW = i;
      }
    }

    if (workerDelta <= delayMin) {
      const delta = workerDelta;
      applyDualUpdate(problem, st, sc, delta);
      delayMin -= delta;
      // Edge (nextW, slackFrom[nextW]) is now tight.
      const i = nextW;
      sc.parentW[i] = sc.slackFrom[i];
      if (matchW[i] === UNASSIGNED) {
        augmentViaWorker(st, sc, root, i);
        return;
      }
      sc.inTreeW[i] = true;
      const j2 = matchW[i];
      addTaskToTree(j2, i);
      const dSlack = delayCost[j2] - beta[j2];
      if (dSlack < delayMin) {
        delayMin = dSlack;
        delayArg = j2;
      }
    } else {
      const delta = delayMin;
      applyDualUpdate(problem, st, sc, delta);
      // beta[delayArg] === delayCost[delayArg]: route the root chain to the delay slot.
      augmentViaDelay(st, sc, root, delayArg);
      return;
    }
  }
}

function applyDualUpdate(
  problem: DispatchProblem,
  st: SolverState,
  sc: PhaseScratch,
  delta: number,
): void {
  if (delta === 0) return;
  const { workerCount: W, taskCount: T } = problem;
  for (let j = 0; j < T; j++) if (sc.inTreeT[j]) st.beta[j] += delta;
  for (let i = 0; i < W; i++) {
    if (sc.inTreeW[i]) st.alpha[i] += delta;
    else sc.slack[i] -= delta;
  }
}

/** Flip the alternating path root ~> worker `iStar` (an unmatched worker). */
function augmentViaWorker(st: SolverState, sc: PhaseScratch, root: number, iStar: number): void {
  let i = iStar;
  let j = sc.slackFrom[iStar];
  for (;;) {
    const iPrev = sc.parentT[j];
    st.matchW[i] = j;
    st.matchT[j] = i;
    if (j === root) return;
    const jPrev = sc.parentW[iPrev];
    j = jPrev;
    i = iPrev;
  }
}

/** Flip the alternating path root ~> task `jStar`, which takes its delay slot. */
function augmentViaDelay(st: SolverState, sc: PhaseScratch, root: number, jStar: number): void {
  st.matchT[jStar] = DELAYED;
  let j = jStar;
  while (j !== root) {
    const i = sc.parentT[j];
    const jPrev = sc.parentW[i];
    st.matchW[i] = jPrev;
    st.matchT[jPrev] = i;
    j = jPrev;
  }
}

export function buildSolution(problem: DispatchProblem, st: SolverState): DispatchSolution {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const assignment = new Array<number>(W).fill(UNASSIGNED);
  const taskWorker = new Array<number>(T).fill(UNASSIGNED);
  const delayed = new Array<boolean>(T).fill(false);
  let totalCost = 0;
  for (let j = 0; j < T; j++) {
    const w = st.matchT[j];
    if (w === DELAYED || w === UNASSIGNED) {
      delayed[j] = true;
      totalCost += delayCost[j];
    } else {
      taskWorker[j] = w;
      assignment[w] = j;
      totalCost += cost[w][j];
    }
  }
  const unassignableWorkers: number[] = [];
  for (let i = 0; i < W; i++) {
    let allForbidden = true;
    for (let j = 0; j < T; j++) {
      if (!forbidden[i][j]) {
        allForbidden = false;
        break;
      }
    }
    if (allForbidden) unassignableWorkers.push(i);
  }
  const unassignableTasks: number[] = [];
  for (let j = 0; j < T; j++) {
    let allForbidden = true;
    for (let i = 0; i < W; i++) {
      if (!forbidden[i][j]) {
        allForbidden = false;
        break;
      }
    }
    if (allForbidden) unassignableTasks.push(j);
  }
  return {
    assignment,
    taskWorker,
    delayed,
    totalCost,
    alpha: st.alpha.slice(),
    beta: st.beta.slice(),
    unassignableWorkers,
    unassignableTasks,
  };
}
