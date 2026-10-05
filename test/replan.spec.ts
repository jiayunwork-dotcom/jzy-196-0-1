import { verifyCertificate } from '../src/certificate/verify';
import { solveIncremental, WarmStart } from '../src/replan/incremental';
import {
  buildStabilizedProblem,
  countReassigned,
  rawCostOf,
} from '../src/replan/penalty';
import { DELAYED, initialState, solveDispatch } from '../src/solver/dispatch-solver';
import { DispatchProblem, UNASSIGNED } from '../src/solver/types';
import { enumeratePlans, randomProblem, rng } from './helpers';

/**
 * The replanning claim: the plan returned after a change minimizes
 *   rawCost(plan) + rho * (#workers whose assignment changed vs previous)
 * over ALL feasible plans. Checked here by exhaustive enumeration.
 */
describe('stability penalty: exhaustive verification of the claimed property', () => {
  it('solver minimizes rawCost + rho*changes over all plans', () => {
    const rand = rng(20261005);
    for (let k = 0; k < 100; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 3),
        tasks: 2 + Math.floor(rand() * 3),
        forbiddenProb: rand() * 0.3,
      });
      const rho = Math.floor(rand() * 8);
      // Random "previous assignment" (not necessarily optimal).
      const previousAssignment = Array.from({ length: problem.workerCount }, () => {
        const r = rand();
        if (r < 0.3) return UNASSIGNED;
        return Math.floor(rand() * problem.taskCount);
      });

      const stabilized = buildStabilizedProblem(problem, previousAssignment, rho);
      const sol = solveDispatch(stabilized.problem);
      const solverPenalized = sol.totalCost + stabilized.constant;

      // Objective identity: penalized == raw + rho*changed for the returned plan.
      const raw = rawCostOf(problem, sol.assignment, sol.delayed);
      const changed = countReassigned(previousAssignment, sol.assignment);
      expect(solverPenalized).toBeCloseTo(raw + rho * changed, 9);

      // Exhaustive: no feasible plan has a smaller penalized objective.
      let best = Number.POSITIVE_INFINITY;
      for (const plan of enumeratePlans(problem)) {
        const c = countReassigned(previousAssignment, plan.assignment);
        best = Math.min(best, plan.rawCost + rho * c);
      }
      expect(solverPenalized).toBeCloseTo(best, 9);
    }
  });

  it('rho = 0 reduces to plain re-optimization', () => {
    const rand = rng(17);
    for (let k = 0; k < 40; k++) {
      const problem = randomProblem(rand, { workers: 3, tasks: 4, forbiddenProb: 0.2 });
      const previousAssignment = Array.from({ length: 3 }, () => Math.floor(rand() * 4));
      const stabilized = buildStabilizedProblem(problem, previousAssignment, 0);
      const sol = solveDispatch(stabilized.problem);
      const raw = rawCostOf(problem, sol.assignment, sol.delayed);
      let best = Number.POSITIVE_INFINITY;
      for (const plan of enumeratePlans(problem)) best = Math.min(best, plan.rawCost);
      expect(raw).toBeCloseTo(best, 9);
    }
  });
});

/* ---------- incremental repair vs from-scratch ---------- */

interface SolverLevelChange {
  removeWorkers: number[];
  removeTasks: number[];
  addTasks: Array<{ delay: number; costs: Array<number | null> }>;
  costOverrides: Array<{ i: number; j: number; cost: number | null }>;
}

function applySolverLevelChange(
  problem: DispatchProblem,
  change: SolverLevelChange,
  rand: () => number,
): { next: DispatchProblem; warm: WarmStart } {
  const W = problem.workerCount;
  const T = problem.taskCount;
  const keepW = problem.cost.map((_, i) => i).filter((i) => !change.removeWorkers.includes(i));
  const keepT = problem.delayCost.map((_, j) => j).filter((j) => !change.removeTasks.includes(j));

  const nextW = keepW.length;
  const nextT = keepT.length + change.addTasks.length;
  const cost: number[][] = Array.from({ length: nextW }, () => new Array<number>(nextT).fill(0));
  const forbidden: boolean[][] = Array.from({ length: nextW }, () => new Array<boolean>(nextT).fill(false));
  const delayCost: number[] = [];

  keepT.forEach((oldJ, newJ) => {
    delayCost[newJ] = problem.delayCost[oldJ];
  });
  change.addTasks.forEach((t, k) => {
    delayCost[keepT.length + k] = t.delay;
  });
  keepW.forEach((oldI, newI) => {
    keepT.forEach((oldJ, newJ) => {
      cost[newI][newJ] = problem.cost[oldI][oldJ];
      forbidden[newI][newJ] = problem.forbidden[oldI][oldJ];
    });
  });
  change.addTasks.forEach((t, k) => {
    const newJ = keepT.length + k;
    t.costs.forEach((c, newI) => {
      cost[newI][newJ] = c === null ? 0 : c;
      forbidden[newI][newJ] = c === null;
    });
  });
  for (const o of change.costOverrides) {
    const newI = keepW.indexOf(o.i);
    const newJ = keepT.indexOf(o.j);
    if (newI < 0 || newJ < 0) continue;
    if (o.cost === null) {
      forbidden[newI][newJ] = true;
    } else {
      cost[newI][newJ] = o.cost;
      forbidden[newI][newJ] = false;
    }
  }

  return {
    next: { workerCount: nextW, taskCount: nextT, cost, delayCost, forbidden },
    warm: { matchT: [], matchW: [], alpha: [], beta: [] }, // filled by caller with old state mapped
  };
}

function mapWarmState(
  oldProblem: DispatchProblem,
  oldState: WarmStart,
  change: SolverLevelChange,
  next: DispatchProblem,
): WarmStart {
  const W = oldProblem.workerCount;
  const T = oldProblem.taskCount;
  const keepW = Array.from({ length: W }, (_, i) => i).filter((i) => !change.removeWorkers.includes(i));
  const keepT = Array.from({ length: T }, (_, j) => j).filter((j) => !change.removeTasks.includes(j));

  const matchW = new Array<number>(next.workerCount).fill(UNASSIGNED);
  const matchT = new Array<number>(next.taskCount).fill(UNASSIGNED);
  const alpha = new Array<number>(next.workerCount).fill(0);
  const beta = new Array<number>(next.taskCount).fill(Number.POSITIVE_INFINITY);

  keepW.forEach((oldI, newI) => {
    alpha[newI] = oldState.alpha[oldI];
  });
  keepT.forEach((oldJ, newJ) => {
    beta[newJ] = oldState.beta[oldJ];
    if (oldState.matchT[oldJ] === DELAYED) {
      matchT[newJ] = DELAYED;
    } else if (oldState.matchT[oldJ] >= 0) {
      const newI = keepW.indexOf(oldState.matchT[oldJ]);
      if (newI >= 0) {
        matchT[newJ] = newI;
        matchW[newI] = newJ;
      }
    }
  });
  return { matchT, matchW, alpha, beta };
}

function randomChange(
  rand: () => number,
  problem: DispatchProblem,
): SolverLevelChange {
  const change: SolverLevelChange = { removeWorkers: [], removeTasks: [], addTasks: [], costOverrides: [] };
  const W = problem.workerCount;
  const T = problem.taskCount;
  if (W > 1 && rand() < 0.4) change.removeWorkers.push(Math.floor(rand() * W));
  if (T > 1 && rand() < 0.4) change.removeTasks.push(Math.floor(rand() * T));
  if (rand() < 0.5) {
    const newW = W - change.removeWorkers.length;
    const costs = Array.from({ length: newW }, () => (rand() < 0.15 ? null : Math.floor(rand() * 20)));
    change.addTasks.push({ delay: Math.floor(rand() * 30), costs });
  }
  const overrides = Math.floor(rand() * 3);
  for (let k = 0; k < overrides; k++) {
    change.costOverrides.push({
      i: Math.floor(rand() * W),
      j: Math.floor(rand() * T),
      cost: rand() < 0.2 ? null : Math.floor(rand() * 25),
    });
  }
  return change;
}

describe('incremental repair', () => {
  it('reaches the same objective as solving from scratch (raw problem)', () => {
    const rand = rng(9001);
    for (let k = 0; k < 250; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 5),
        tasks: 2 + Math.floor(rand() * 5),
        forbiddenProb: rand() * 0.25,
      });
      const before = solveDispatch(problem);
      const oldState: WarmStart = {
        matchT: before.taskWorker.map((w, j) => (before.delayed[j] ? DELAYED : w)),
        matchW: before.assignment.slice(),
        alpha: before.alpha.slice(),
        beta: before.beta.slice(),
      };
      const change = randomChange(rand, problem);
      const { next } = applySolverLevelChange(problem, change, rand);
      const warm = mapWarmState(problem, oldState, change, next);

      const incremental = solveIncremental(next, warm);
      const scratch = solveDispatch(next);

      expect(incremental.totalCost).toBeCloseTo(scratch.totalCost, 9);
      const cert = verifyCertificate(next, incremental);
      expect(cert.violations).toEqual([]);
    }
  });

  it('reaches the same objective as solving from scratch (stabilized problem)', () => {
    const rand = rng(4711);
    for (let k = 0; k < 200; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 5),
        tasks: 2 + Math.floor(rand() * 5),
        forbiddenProb: rand() * 0.25,
      });
      const rho = Math.floor(rand() * 6);
      const prevAssignment = Array.from({ length: problem.workerCount }, () =>
        rand() < 0.4 ? UNASSIGNED : Math.floor(rand() * problem.taskCount),
      );
      const stab0 = buildStabilizedProblem(problem, prevAssignment, rho);
      const before = solveDispatch(stab0.problem);
      const oldState: WarmStart = {
        matchT: before.taskWorker.map((w, j) => (before.delayed[j] ? DELAYED : w)),
        matchW: before.assignment.slice(),
        alpha: before.alpha.slice(),
        beta: before.beta.slice(),
      };
      const change = randomChange(rand, problem);
      const { next } = applySolverLevelChange(problem, change, rand);
      // Stabilize the new problem against the previous assignment (mapped).
      const keepW = Array.from({ length: problem.workerCount }, (_, i) => i).filter(
        (i) => !change.removeWorkers.includes(i),
      );
      const keepT = Array.from({ length: problem.taskCount }, (_, j) => j).filter(
        (j) => !change.removeTasks.includes(j),
      );
      const mappedPrev = keepW.map((oldI) => {
        const t = prevAssignment[oldI];
        if (t === UNASSIGNED || t >= problem.taskCount) return UNASSIGNED;
        const nj = keepT.indexOf(t);
        return nj >= 0 ? nj : UNASSIGNED;
      });
      const stab1 = buildStabilizedProblem(next, mappedPrev, rho);
      const warm = mapWarmState(problem, oldState, change, stab1.problem);

      const incremental = solveIncremental(stab1.problem, warm);
      const scratch = solveDispatch(stab1.problem);

      expect(incremental.totalCost).toBeCloseTo(scratch.totalCost, 9);
      expect(verifyCertificate(stab1.problem, incremental).violations).toEqual([]);
    }
  });

  it('is a no-op when nothing changed', () => {
    const rand = rng(1313);
    for (let k = 0; k < 40; k++) {
      const problem = randomProblem(rand, { workers: 4, tasks: 5, forbiddenProb: 0.2 });
      const before = solveDispatch(problem);
      const warm: WarmStart = {
        matchT: before.taskWorker.map((w, j) => (before.delayed[j] ? DELAYED : w)),
        matchW: before.assignment.slice(),
        alpha: before.alpha.slice(),
        beta: before.beta.slice(),
      };
      const after = solveIncremental(problem, warm);
      expect(after.totalCost).toBeCloseTo(before.totalCost, 12);
      expect(after.assignment).toEqual(before.assignment);
    }
  });

  it('initialState is a valid warm start equivalent to from-scratch', () => {
    const rand = rng(2323);
    for (let k = 0; k < 40; k++) {
      const problem = randomProblem(rand, { workers: 3, tasks: 4, forbiddenProb: 0.2 });
      const st = initialState(problem);
      const viaWarm = solveIncremental(problem, {
        matchT: st.matchT,
        matchW: st.matchW,
        alpha: st.alpha,
        beta: st.beta,
      });
      const direct = solveDispatch(problem);
      expect(viaWarm.totalCost).toBeCloseTo(direct.totalCost, 12);
    }
  });
});
