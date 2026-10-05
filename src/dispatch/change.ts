/**
 * The evolving day data (id-keyed) and the supported intra-day changes.
 *
 * Change types (one new version per applied change):
 *   - worker_unavailable: a worker leaves for the day (row removed)
 *   - task_added:         a new urgent task with its full cost column
 *   - task_cancelled:     a task is cancelled (column removed)
 *   - cost_override:      dispatcher rewrites one pair's cost
 *                         (finite number, or null to forbid the pair)
 */

import { DomainValidationError, FieldError } from './errors';

export interface TaskSpec {
  id: string;
  delayCost: number;
}

/** costs[i][j] aligns with workerIds[i] and tasks[j].id; null = forbidden pair. */
export interface DayData {
  workerIds: string[];
  tasks: TaskSpec[];
  costs: (number | null)[][];
}

export type Change =
  | { type: 'worker_unavailable'; workerId: string }
  | { type: 'task_added'; task: TaskSpec; costs: Array<{ workerId: string; cost: number | null }> }
  | { type: 'task_cancelled'; taskId: string }
  | { type: 'cost_override'; workerId: string; taskId: string; cost: number | null };

export const CHANGE_TYPES = ['worker_unavailable', 'task_added', 'task_cancelled', 'cost_override'] as const;

function fail(errors: FieldError[]): never {
  throw new DomainValidationError(errors);
}

export function validateDayData(data: DayData): void {
  const errors: FieldError[] = [];
  const workerSeen = new Set<string>();
  data.workerIds.forEach((id, k) => {
    if (typeof id !== 'string' || id.length === 0) {
      errors.push({ field: `workers[${k}].id`, message: 'worker id must be a non-empty string' });
    } else if (workerSeen.has(id)) {
      errors.push({ field: `workers[${k}].id`, message: `duplicate worker id '${id}'` });
    }
    workerSeen.add(id);
  });
  const taskSeen = new Set<string>();
  data.tasks.forEach((t, k) => {
    if (typeof t?.id !== 'string' || t.id.length === 0) {
      errors.push({ field: `tasks[${k}].id`, message: 'task id must be a non-empty string' });
    } else if (taskSeen.has(t.id)) {
      errors.push({ field: `tasks[${k}].id`, message: `duplicate task id '${t.id}'` });
    }
    taskSeen.add(t?.id);
    if (!Number.isFinite(t?.delayCost)) {
      errors.push({ field: `tasks[${k}].delayCost`, message: 'delay cost must be a finite number' });
    }
  });
  if (!Array.isArray(data.costs) || data.costs.length !== data.workerIds.length) {
    errors.push({
      field: 'costMatrix',
      message: `expected ${data.workerIds.length} rows (one per worker), got ${Array.isArray(data.costs) ? data.costs.length : 'non-array'}`,
    });
    fail(errors);
  }
  data.costs.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== data.tasks.length) {
      errors.push({
        field: `costMatrix[${i}]`,
        message: `expected ${data.tasks.length} entries (one per task), got ${Array.isArray(row) ? row.length : 'non-array'}`,
      });
      return;
    }
    row.forEach((c, j) => {
      if (c !== null && !Number.isFinite(c)) {
        errors.push({ field: `costMatrix[${i}][${j}]`, message: 'cost must be a finite number (or null for forbidden)' });
      }
    });
  });
  if (errors.length > 0) fail(errors);
}

export function applyChange(data: DayData, change: Change): DayData {
  switch (change?.type) {
    case 'worker_unavailable':
      return applyWorkerUnavailable(data, change.workerId);
    case 'task_added':
      return applyTaskAdded(data, change);
    case 'task_cancelled':
      return applyTaskCancelled(data, change.taskId);
    case 'cost_override':
      return applyCostOverride(data, change);
    default:
      fail([{ field: 'change.type', message: `unknown change type '${(change as { type?: unknown })?.type}'` }]);
  }
}

function applyWorkerUnavailable(data: DayData, workerId: string): DayData {
  const idx = data.workerIds.indexOf(workerId);
  if (idx < 0) {
    fail([{ field: 'change.workerId', message: `unknown worker '${workerId}'` }]);
  }
  const workerIds = data.workerIds.filter((_, k) => k !== idx);
  const costs = data.costs.filter((_, k) => k !== idx).map((row) => row.slice());
  return { workerIds, tasks: data.tasks.map((t) => ({ ...t })), costs };
}

function applyTaskAdded(
  data: DayData,
  change: { task: TaskSpec; costs: Array<{ workerId: string; cost: number | null }> },
): DayData {
  const errors: FieldError[] = [];
  if (!change.task || typeof change.task.id !== 'string' || change.task.id.length === 0) {
    errors.push({ field: 'change.task.id', message: 'task id must be a non-empty string' });
  } else if (data.tasks.some((t) => t.id === change.task.id)) {
    errors.push({ field: 'change.task.id', message: `task '${change.task.id}' already exists` });
  }
  if (!Number.isFinite(change.task?.delayCost)) {
    errors.push({ field: 'change.task.delayCost', message: 'delay cost must be a finite number' });
  }
  const entries = Array.isArray(change.costs) ? change.costs : [];
  const seen = new Set<string>();
  const column = new Map<string, number | null>();
  entries.forEach((e, k) => {
    if (!data.workerIds.includes(e?.workerId)) {
      errors.push({ field: `change.costs[${k}].workerId`, message: `unknown worker '${e?.workerId}'` });
      return;
    }
    if (seen.has(e.workerId)) {
      errors.push({ field: `change.costs[${k}].workerId`, message: `duplicate entry for worker '${e.workerId}'` });
      return;
    }
    seen.add(e.workerId);
    if (e.cost !== null && !Number.isFinite(e.cost)) {
      errors.push({ field: `change.costs[${k}].cost`, message: 'cost must be a finite number (or null for forbidden)' });
      return;
    }
    column.set(e.workerId, e.cost);
  });
  for (const w of data.workerIds) {
    if (!seen.has(w)) {
      errors.push({ field: 'change.costs', message: `missing cost entry for worker '${w}'` });
    }
  }
  if (errors.length > 0) fail(errors);

  const tasks = [...data.tasks.map((t) => ({ ...t })), { id: change.task.id, delayCost: change.task.delayCost }];
  const costs = data.costs.map((row, i) => [...row, column.get(data.workerIds[i]) ?? null]);
  return { workerIds: data.workerIds.slice(), tasks, costs };
}

function applyTaskCancelled(data: DayData, taskId: string): DayData {
  const idx = data.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) {
    fail([{ field: 'change.taskId', message: `unknown task '${taskId}'` }]);
  }
  const tasks = data.tasks.filter((_, k) => k !== idx).map((t) => ({ ...t }));
  const costs = data.costs.map((row) => row.filter((_, k) => k !== idx));
  return { workerIds: data.workerIds.slice(), tasks, costs };
}

function applyCostOverride(
  data: DayData,
  change: { workerId: string; taskId: string; cost: number | null },
): DayData {
  const errors: FieldError[] = [];
  const wi = data.workerIds.indexOf(change.workerId);
  if (wi < 0) errors.push({ field: 'change.workerId', message: `unknown worker '${change.workerId}'` });
  const ti = data.tasks.findIndex((t) => t.id === change.taskId);
  if (ti < 0) errors.push({ field: 'change.taskId', message: `unknown task '${change.taskId}'` });
  if (change.cost !== null && !Number.isFinite(change.cost)) {
    errors.push({ field: 'change.cost', message: 'cost must be a finite number (or null to forbid the pair)' });
  }
  if (errors.length > 0) fail(errors);
  const costs = data.costs.map((row) => row.slice());
  costs[wi][ti] = change.cost;
  return { workerIds: data.workerIds.slice(), tasks: data.tasks.map((t) => ({ ...t })), costs };
}
