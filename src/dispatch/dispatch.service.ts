/**
 * DispatchService: orchestrates solving, versioning, changes and diffs.
 *
 * Concurrency model (documented in docs/DESIGN.md):
 *  - Every change submission must name the `baseVersion` it was computed
 *    from. If it is not the current version, the submission is rejected
 *    with 409 and the current version number (no automatic replay).
 *  - Version creation is serialized by the unique (date, version) index:
 *    if two submissions race on the same base, exactly one insert wins;
 *    the loser is rejected the same way.
 *  - Each version document carries the full day data after the change, so
 *    the state is always recoverable from the versions collection alone
 *    (restart recovery = plain reads).
 */

import { Injectable } from '@nestjs/common';
import { verifyCertificate } from '../certificate/verify';
import { solveIncremental, WarmStart } from '../replan/incremental';
import {
  buildStabilizedProblem,
  countReassigned,
  rawCostOf,
} from '../replan/penalty';
import { solveDispatch, DELAYED } from '../solver/dispatch-solver';
import { DispatchProblem, DispatchSolution, UNASSIGNED } from '../solver/types';
import { diffPlans, PlanDiff, PlanSnapshot } from '../version/diff';
import {
  applyChange,
  Change,
  DayData,
  validateDayData,
} from './change';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  StaleVersionError,
} from './errors';
import {
  DayRepository,
  DuplicateKey,
  VersionDoc,
  VersionRepository,
} from '../persistence/repositories';

export const DEFAULT_REASSIGNMENT_PENALTY = 10;

export interface CreateDayInput {
  date: string;
  workers: Array<{ id: string }>;
  tasks: Array<{ id: string; delayCost: number }>;
  costMatrix: number[][];
  forbidden?: Array<{ workerId: string; taskId: string }>;
  reassignmentPenalty?: number;
}

export interface SubmitChangeInput {
  baseVersion: number;
  change: Change;
  reassignmentPenalty?: number;
}

export interface VersionView {
  date: string;
  version: number;
  change: unknown;
  createdAt: Date;
  /** Day data after applying the change (each version is self-contained). */
  data: DayData;
  plan: PlanSnapshot;
  costs: {
    raw: number;
    penalized: number;
    reassignmentPenalty: number;
    reassignedCount: number;
  };
  certificate: {
    alpha: Record<string, number>;
    beta: Record<string, number>;
    effectiveCosts: (number | null)[][];
    constant: number;
  };
  unassignable: { workers: string[]; tasks: string[] };
  diffFromPrevious: PlanDiff | null;
}

export interface VerifyResult {
  valid: boolean;
  violations: unknown[];
  checks: {
    dualFeasible: boolean;
    complementarySlackness: boolean;
    objectiveIdentity: boolean;
    consistent: boolean;
    penalizedObjectiveIdentity: boolean;
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class DispatchService {
  constructor(
    private readonly days: DayRepository,
    private readonly versions: VersionRepository,
  ) {}

  async createDay(input: CreateDayInput): Promise<VersionView> {
    const errors: Array<{ field: string; message: string }> = [];
    if (typeof input?.date !== 'string' || !DATE_RE.test(input.date)) {
      errors.push({ field: 'date', message: 'date must be a string of form YYYY-MM-DD' });
    }
    if (!Array.isArray(input?.workers)) {
      errors.push({ field: 'workers', message: 'workers must be an array' });
    }
    if (!Array.isArray(input?.tasks)) {
      errors.push({ field: 'tasks', message: 'tasks must be an array' });
    }
    if (errors.length > 0) throw new DomainValidationError(errors);

    const data: DayData = {
      workerIds: input.workers.map((w, k) => {
        if (typeof w?.id !== 'string' || w.id.length === 0) {
          errors.push({ field: `workers[${k}].id`, message: 'worker id must be a non-empty string' });
        }
        return w?.id;
      }),
      tasks: input.tasks.map((t) => ({ id: t?.id, delayCost: t?.delayCost })),
      costs: (input.costMatrix ?? []).map((row) =>
        Array.isArray(row) ? row.map((c) => c) : (row as never),
      ),
    };
    validateDayData(data); // throws with precise fields (dims, non-finite, duplicates)

    // Forbidden pairs are marked separately from the cost matrix.
    const forbiddenInput = input.forbidden ?? [];
    forbiddenInput.forEach((p, k) => {
      if (!data.workerIds.includes(p?.workerId)) {
        errors.push({ field: `forbidden[${k}].workerId`, message: `unknown worker '${p?.workerId}'` });
      }
      if (!data.tasks.some((t) => t.id === p?.taskId)) {
        errors.push({ field: `forbidden[${k}].taskId`, message: `unknown task '${p?.taskId}'` });
      }
    });
    const rho = input.reassignmentPenalty ?? DEFAULT_REASSIGNMENT_PENALTY;
    if (!Number.isFinite(rho) || rho < 0) {
      errors.push({ field: 'reassignmentPenalty', message: 'must be a finite number >= 0' });
    }
    if (errors.length > 0) throw new DomainValidationError(errors);

    for (const p of forbiddenInput) {
      const i = data.workerIds.indexOf(p.workerId);
      const j = data.tasks.findIndex((t) => t.id === p.taskId);
      data.costs[i][j] = null;
    }

    await this.days.insert({
      date: input.date,
      status: 'open',
      reassignmentPenalty: rho,
      createdAt: new Date(),
    });

    // First version of the day: pure cost optimization (nothing to stabilize against).
    const problem = toProblem(data);
    const solution = solveDispatch(problem);
    const versionDoc = this.buildVersionDoc({
      date: input.date,
      version: 1,
      change: null,
      data,
      problem,
      solution,
      effectiveCosts: data.costs,
      constant: 0,
      rho: 0,
      previous: null,
    });
    await this.versions.insert(versionDoc);
    return toVersionView(versionDoc);
  }

  async submitChange(date: string, input: SubmitChangeInput): Promise<VersionView> {
    const day = await this.days.findByDate(date);
    if (!day) throw new NotFoundError(`day '${date}' not found`);
    if (day.status === 'closed') {
      throw new DomainValidationError([{ field: 'date', message: `day '${date}' is closed` }]);
    }
    const previous = await this.versions.latest(date);
    if (!previous) throw new NotFoundError(`day '${date}' has no versions`);
    const currentVersion = previous.version;
    if (typeof input?.baseVersion !== 'number' || !Number.isInteger(input.baseVersion)) {
      throw new DomainValidationError([
        { field: 'baseVersion', message: 'baseVersion (integer) is required and must name the version the change was computed from' },
      ]);
    }
    if (input.baseVersion !== currentVersion) {
      throw new StaleVersionError(input.baseVersion, currentVersion);
    }
    const rho = input.reassignmentPenalty ?? day.reassignmentPenalty;
    if (!Number.isFinite(rho) || rho < 0) {
      throw new DomainValidationError([
        { field: 'reassignmentPenalty', message: 'must be a finite number >= 0' },
      ]);
    }

    // Apply the change to the data carried by the current version.
    const newData = applyChange(previous.data, input.change);
    validateDayData(newData);
    const problem = toProblem(newData);

    // Warm start: previous matching + duals mapped into the new index space.
    const warm = mapWarmStart(previous, newData);
    const previousAssignment = previousAssignmentInNewIndices(previous, newData);

    // Stability penalty: minimize rawCost + rho * (#reassigned workers).
    const stabilized = buildStabilizedProblem(problem, previousAssignment, rho);
    const solution = solveIncremental(stabilized.problem, warm);

    const versionDoc = this.buildVersionDoc({
      date,
      version: currentVersion + 1,
      change: input.change as unknown as VersionDoc['change'],
      data: newData,
      problem,
      solution,
      effectiveCosts: stabilized.problem.cost.map((row, i) =>
        row.map((c, j) => (stabilized.problem.forbidden[i][j] ? null : c)),
      ),
      constant: stabilized.constant,
      rho,
      previous,
    });

    try {
      await this.versions.insert(versionDoc);
    } catch (err) {
      if (err instanceof DuplicateKey) {
        const now = await this.versions.latest(date);
        throw new StaleVersionError(input.baseVersion, now?.version ?? currentVersion);
      }
      throw err;
    }
    return toVersionView(versionDoc);
  }

  async getCurrent(date: string): Promise<VersionView> {
    await this.requireDay(date);
    const latest = await this.versions.latest(date);
    if (!latest) throw new NotFoundError(`day '${date}' has no versions`);
    return toVersionView(latest);
  }

  async getVersion(date: string, version: number): Promise<VersionView> {
    await this.requireDay(date);
    const doc = await this.versions.find(date, version);
    if (!doc) throw new NotFoundError(`version ${version} of day '${date}' not found`);
    return toVersionView(doc);
  }

  async listVersions(date: string): Promise<Array<Record<string, unknown>>> {
    await this.requireDay(date);
    const all = await this.versions.list(date);
    return all.map((v) => ({
      date: v.date,
      version: v.version,
      change: v.change,
      createdAt: v.createdAt,
      rawCost: v.rawCost,
      penalizedCost: v.penalizedCost,
      reassignedCount: v.reassignedCount,
      reassignmentPenalty: v.reassignmentPenalty,
      reassignedFromPrevious: v.diffFromPrevious?.reassigned ?? [],
    }));
  }

  async diff(date: string, fromVersion: number, toVersion: number): Promise<PlanDiff> {
    await this.requireDay(date);
    const [from, to] = await Promise.all([
      this.versions.find(date, fromVersion),
      this.versions.find(date, toVersion),
    ]);
    if (!from) throw new NotFoundError(`version ${fromVersion} of day '${date}' not found`);
    if (!to) throw new NotFoundError(`version ${toVersion} of day '${date}' not found`);
    return diffPlans(snapshotWithData(from), snapshotWithData(to));
  }

  async verify(date: string, version: number): Promise<VerifyResult> {
    await this.requireDay(date);
    const doc = await this.versions.find(date, version);
    if (!doc) throw new NotFoundError(`version ${version} of day '${date}' not found`);

    // The certificate certifies optimality of the STABILIZED problem actually solved.
    const effectiveProblem = toProblem({
      workerIds: doc.data.workerIds,
      tasks: doc.data.tasks,
      costs: doc.effectiveCosts,
    });
    const solution = solutionFromDoc(doc);
    const result = verifyCertificate(effectiveProblem, solution);

    // Objective identity the dispatcher cares about:
    // penalizedCost === rawCost(true costs) + rho * (#reassigned).
    const trueProblem = toProblem(doc.data);
    const raw = rawCostOf(trueProblem, solution.assignment, solution.delayed);
    const penalizedIdentity =
      Math.abs(doc.penalizedCost - (raw + doc.reassignmentPenalty * doc.reassignedCount)) <
      1e-6 * Math.max(1, Math.abs(doc.penalizedCost));
    const rawConsistent = Math.abs(raw - doc.rawCost) < 1e-6 * Math.max(1, Math.abs(raw));

    const has = (c: string) => result.violations.some((v) => v.check === c);
    return {
      valid: result.valid && penalizedIdentity && rawConsistent,
      violations: result.violations,
      checks: {
        dualFeasible: !has('D1') && !has('D3') && !has('D5'),
        complementarySlackness: !has('D2') && !has('D4') && !has('D6'),
        objectiveIdentity: !has('D7'),
        consistent: !has('CONSISTENCY') && rawConsistent,
        penalizedObjectiveIdentity: penalizedIdentity,
      },
    };
  }

  async closeDay(date: string): Promise<void> {
    await this.requireDay(date);
    await this.days.close(date);
  }

  private async requireDay(date: string): Promise<void> {
    const day = await this.days.findByDate(date);
    if (!day) throw new NotFoundError(`day '${date}' not found`);
  }

  private buildVersionDoc(args: {
    date: string;
    version: number;
    change: VersionDoc['change'];
    data: DayData;
    problem: DispatchProblem;
    solution: DispatchSolution;
    effectiveCosts: (number | null)[][];
    constant: number;
    rho: number;
    previous: VersionDoc | null;
  }): VersionDoc {
    const { data, problem, solution } = args;
    const plan = planSnapshot(data, solution);
    const raw = rawCostOf(problem, solution.assignment, solution.delayed);
    const previousAssignment = args.previous
      ? previousAssignmentInNewIndices(args.previous, data)
      : data.workerIds.map(() => UNASSIGNED);
    const reassignedCount = args.previous
      ? countReassigned(previousAssignment, solution.assignment)
      : 0;
    const penalized = args.previous ? raw + args.rho * reassignedCount : raw;
    const alpha: Record<string, number> = {};
    data.workerIds.forEach((w, i) => {
      alpha[w] = solution.alpha[i];
    });
    const beta: Record<string, number> = {};
    data.tasks.forEach((t, j) => {
      beta[t.id] = solution.beta[j];
    });
    return {
      date: args.date,
      version: args.version,
      change: args.change,
      data,
      plan,
      alpha,
      beta,
      effectiveCosts: args.effectiveCosts,
      constant: args.constant,
      rawCost: raw,
      penalizedCost: penalized,
      reassignmentPenalty: args.rho,
      reassignedCount,
      unassignableWorkerIds: solution.unassignableWorkers.map((i) => data.workerIds[i]),
      unassignableTaskIds: solution.unassignableTasks.map((j) => data.tasks[j].id),
      diffFromPrevious: args.previous
        ? diffPlans(snapshotWithData(args.previous), { ...plan, workerIds: data.workerIds, taskIds: data.tasks.map((t) => t.id) })
        : null,
      createdAt: new Date(),
    };
  }
}

/* ---------- helpers: id <-> index conversions ---------- */

export function toProblem(data: DayData): DispatchProblem {
  const W = data.workerIds.length;
  const T = data.tasks.length;
  const cost: number[][] = [];
  const forbidden: boolean[][] = [];
  for (let i = 0; i < W; i++) {
    const costRow: number[] = [];
    const forbRow: boolean[] = [];
    for (let j = 0; j < T; j++) {
      const c = data.costs[i][j];
      forbRow.push(c === null);
      costRow.push(c === null ? 0 : c);
    }
    cost.push(costRow);
    forbidden.push(forbRow);
  }
  return {
    workerCount: W,
    taskCount: T,
    cost,
    delayCost: data.tasks.map((t) => t.delayCost),
    forbidden,
  };
}

function planSnapshot(data: DayData, solution: DispatchSolution): PlanSnapshot {
  const assignments: Array<{ workerId: string; taskId: string }> = [];
  const delayedTaskIds: string[] = [];
  const idleWorkerIds: string[] = [];
  solution.assignment.forEach((j, i) => {
    if (j === UNASSIGNED) idleWorkerIds.push(data.workerIds[i]);
    else assignments.push({ workerId: data.workerIds[i], taskId: data.tasks[j].id });
  });
  solution.delayed.forEach((d, j) => {
    if (d) delayedTaskIds.push(data.tasks[j].id);
  });
  assignments.sort((a, b) => (a.workerId < b.workerId ? -1 : 1));
  delayedTaskIds.sort();
  idleWorkerIds.sort();
  return { assignments, delayedTaskIds, idleWorkerIds };
}

function snapshotWithData(doc: VersionDoc): PlanSnapshot & { workerIds: string[]; taskIds: string[] } {
  return {
    ...doc.plan,
    workerIds: doc.data.workerIds,
    taskIds: doc.data.tasks.map((t) => t.id),
  };
}

/** Previous assignment expressed in the NEW index space. */
function previousAssignmentInNewIndices(previous: VersionDoc, newData: DayData): number[] {
  const prevTaskIndex = new Map<string, number>();
  previous.data.tasks.forEach((t, j) => prevTaskIndex.set(t.id, j));
  const newTaskIndex = new Map<string, number>();
  newData.tasks.forEach((t, j) => newTaskIndex.set(t.id, j));
  const prevAssignmentByWorker = new Map<string, string>();
  for (const a of previous.plan.assignments) prevAssignmentByWorker.set(a.workerId, a.taskId);
  return newData.workerIds.map((w) => {
    const t = prevAssignmentByWorker.get(w);
    if (t === undefined) return UNASSIGNED;
    return newTaskIndex.get(t) ?? UNASSIGNED;
  });
}

/** Previous solver state (matching + duals) mapped into the NEW index space. */
function mapWarmStart(previous: VersionDoc, newData: DayData): WarmStart {
  const newWorkerIndex = new Map<string, number>();
  newData.workerIds.forEach((w, i) => newWorkerIndex.set(w, i));
  const newTaskIndex = new Map<string, number>();
  newData.tasks.forEach((t, j) => newTaskIndex.set(t.id, j));

  const W = newData.workerIds.length;
  const T = newData.tasks.length;
  const matchW = new Array<number>(W).fill(UNASSIGNED);
  const matchT = new Array<number>(T).fill(UNASSIGNED);
  const alpha = new Array<number>(W).fill(0);
  const beta = new Array<number>(T).fill(Number.POSITIVE_INFINITY);

  newData.workerIds.forEach((w, i) => {
    const a = previous.alpha[w];
    if (typeof a === 'number') alpha[i] = a;
  });
  newData.tasks.forEach((t, j) => {
    const b = previous.beta[t.id];
    if (typeof b === 'number') beta[j] = b;
  });
  for (const a of previous.plan.assignments) {
    const i = newWorkerIndex.get(a.workerId);
    const j = newTaskIndex.get(a.taskId);
    if (i !== undefined && j !== undefined) {
      matchW[i] = j;
      matchT[j] = i;
    }
  }
  // Tasks that were delayed before stay delayed (their beta carried over).
  const newTaskIds = new Set(newData.tasks.map((t) => t.id));
  for (const t of previous.plan.delayedTaskIds) {
    if (newTaskIds.has(t)) {
      matchT[newTaskIndex.get(t)!] = DELAYED;
    }
  }
  return { matchT, matchW, alpha, beta };
}

function solutionFromDoc(doc: VersionDoc): DispatchSolution {
  const W = doc.data.workerIds.length;
  const T = doc.data.tasks.length;
  const assignment = new Array<number>(W).fill(UNASSIGNED);
  const taskWorker = new Array<number>(T).fill(UNASSIGNED);
  const delayed = new Array<boolean>(T).fill(false);
  const taskIndex = new Map<string, number>();
  doc.data.tasks.forEach((t, j) => taskIndex.set(t.id, j));
  for (const a of doc.plan.assignments) {
    const i = doc.data.workerIds.indexOf(a.workerId);
    const j = taskIndex.get(a.taskId)!;
    assignment[i] = j;
    taskWorker[j] = i;
  }
  for (const t of doc.plan.delayedTaskIds) {
    const j = taskIndex.get(t);
    if (j !== undefined) delayed[j] = true;
  }
  return {
    assignment,
    taskWorker,
    delayed,
    // The certificate is over the stabilized costs actually solved, so the
    // dual objective must equal the stabilized total (penalized - constant).
    totalCost: doc.penalizedCost - doc.constant,
    alpha: doc.data.workerIds.map((w) => doc.alpha[w]),
    beta: doc.data.tasks.map((t) => doc.beta[t.id]),
    unassignableWorkers: [],
    unassignableTasks: [],
  };
}

function toVersionView(doc: VersionDoc): VersionView {
  return {
    date: doc.date,
    version: doc.version,
    change: doc.change,
    createdAt: doc.createdAt,
    data: doc.data,
    plan: doc.plan,
    costs: {
      raw: doc.rawCost,
      penalized: doc.penalizedCost,
      reassignmentPenalty: doc.reassignmentPenalty,
      reassignedCount: doc.reassignedCount,
    },
    certificate: {
      alpha: doc.alpha,
      beta: doc.beta,
      effectiveCosts: doc.effectiveCosts,
      constant: doc.constant,
    },
    unassignable: {
      workers: doc.unassignableWorkerIds,
      tasks: doc.unassignableTaskIds,
    },
    diffFromPrevious: doc.diffFromPrevious,
  };
}
