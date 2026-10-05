import { DispatchProblem, DispatchSolution, UNASSIGNED } from '../src/solver/types';

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomProblemOptions {
  workers: number;
  tasks: number;
  maxCost?: number;
  maxDelay?: number;
  forbiddenProb?: number;
  integerCosts?: boolean;
}

export function randomProblem(rand: () => number, opts: RandomProblemOptions): DispatchProblem {
  const W = opts.workers;
  const T = opts.tasks;
  const maxCost = opts.maxCost ?? 20;
  const maxDelay = opts.maxDelay ?? 30;
  const forbiddenProb = opts.forbiddenProb ?? 0.15;
  const integer = opts.integerCosts ?? true;
  const num = (x: number) => (integer ? Math.floor(x) : x);
  const cost: number[][] = [];
  const forbidden: boolean[][] = [];
  for (let i = 0; i < W; i++) {
    const cr: number[] = [];
    const fr: boolean[] = [];
    for (let j = 0; j < T; j++) {
      cr.push(num(rand() * maxCost));
      fr.push(rand() < forbiddenProb);
    }
    cost.push(cr);
    forbidden.push(fr);
  }
  const delayCost = Array.from({ length: T }, () => num(rand() * maxDelay));
  return { workerCount: W, taskCount: T, cost, delayCost, forbidden };
}

/** Simple greedy: cheapest allowed pair first, remaining tasks delayed. */
export function greedySolve(problem: DispatchProblem): number {
  const pairs: Array<{ i: number; j: number; c: number }> = [];
  for (let i = 0; i < problem.workerCount; i++) {
    for (let j = 0; j < problem.taskCount; j++) {
      if (!problem.forbidden[i][j]) pairs.push({ i, j, c: problem.cost[i][j] });
    }
  }
  pairs.sort((a, b) => a.c - b.c || a.i - b.i || a.j - b.j);
  const usedW = new Set<number>();
  const usedT = new Set<number>();
  let total = 0;
  for (const p of pairs) {
    if (usedW.has(p.i) || usedT.has(p.j)) continue;
    usedW.add(p.i);
    usedT.add(p.j);
    total += p.c;
  }
  for (let j = 0; j < problem.taskCount; j++) {
    if (!usedT.has(j)) total += problem.delayCost[j];
  }
  return total;
}

/**
 * Exhaustive enumeration of every feasible plan (injections of tasks into
 * workers, any task may be delayed). Returns the best raw cost and, for
 * each plan, enough information to evaluate custom objectives.
 */
export function enumeratePlans(
  problem: DispatchProblem,
): Array<{ assignment: number[]; delayed: boolean[]; rawCost: number }> {
  const { workerCount: W, taskCount: T, cost, delayCost, forbidden } = problem;
  const results: Array<{ assignment: number[]; delayed: boolean[]; rawCost: number }> = [];
  const assignment = new Array<number>(W).fill(UNASSIGNED);
  const taskWorker = new Array<number>(T).fill(UNASSIGNED);

  const rec = (j: number) => {
    if (j === T) {
      const delayed = taskWorker.map((w) => w === UNASSIGNED);
      let raw = 0;
      for (let i = 0; i < W; i++) if (assignment[i] !== UNASSIGNED) raw += cost[i][assignment[i]];
      for (let t = 0; t < T; t++) if (delayed[t]) raw += delayCost[t];
      results.push({ assignment: assignment.slice(), delayed, rawCost: raw });
      return;
    }
    // option 1: delay task j
    taskWorker[j] = UNASSIGNED;
    rec(j + 1);
    // option 2: assign to a free worker
    for (let i = 0; i < W; i++) {
      if (assignment[i] !== UNASSIGNED || forbidden[i][j]) continue;
      assignment[i] = j;
      taskWorker[j] = i;
      rec(j + 1);
      assignment[i] = UNASSIGNED;
      taskWorker[j] = UNASSIGNED;
    }
  };
  rec(0);
  return results;
}

export function optimalRawCost(problem: DispatchProblem): number {
  let best = Number.POSITIVE_INFINITY;
  for (const plan of enumeratePlans(problem)) {
    if (plan.rawCost < best) best = plan.rawCost;
  }
  return best;
}

export function assignmentKey(solution: DispatchSolution): string {
  return solution.assignment.join(',');
}
