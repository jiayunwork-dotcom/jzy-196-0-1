/**
 * Versioned plan snapshots and diffs.
 */

export interface AssignmentEntry {
  workerId: string;
  taskId: string;
}

/** Id-keyed, canonical (sorted) view of one version's plan. */
export interface PlanSnapshot {
  /** Assigned pairs, sorted by workerId. */
  assignments: AssignmentEntry[];
  /** Tasks left unassigned (delayed), sorted. */
  delayedTaskIds: string[];
  /** Workers with no task, sorted. */
  idleWorkerIds: string[];
}

export interface Reassignment {
  workerId: string;
  fromTaskId: string | null;
  toTaskId: string | null;
}

export interface PlanDiff {
  /** Workers whose task changed (task->task, task->idle, idle->task), sorted by workerId. */
  reassigned: Reassignment[];
  /** Tasks that became delayed (were assigned before), sorted. */
  tasksBecameDelayed: string[];
  /** Tasks that became assigned (were delayed before), sorted. */
  tasksBecameAssigned: string[];
  /** Workers present only in the `to` plan's data (joined) / only in `from` (left). */
  workersRemoved: string[];
  workersAdded: string[];
  tasksRemoved: string[];
  tasksAdded: string[];
}

export interface SnapshotData {
  workerIds: string[];
  taskIds: string[];
}

export function diffPlans(
  from: PlanSnapshot & SnapshotData,
  to: PlanSnapshot & SnapshotData,
): PlanDiff {
  const fromMap = new Map<string, string>();
  for (const a of from.assignments) fromMap.set(a.workerId, a.taskId);
  const toMap = new Map<string, string>();
  for (const a of to.assignments) toMap.set(a.workerId, a.taskId);

  const fromWorkers = new Set(from.workerIds);
  const toWorkers = new Set(to.workerIds);
  const fromTasks = new Set(from.taskIds);
  const toTasks = new Set(to.taskIds);

  const reassigned: Reassignment[] = [];
  const allWorkers = [...new Set([...from.workerIds, ...to.workerIds])].sort();
  for (const w of allWorkers) {
    if (!fromWorkers.has(w) || !toWorkers.has(w)) continue; // join/leave reported separately
    const f = fromMap.get(w) ?? null;
    const t = toMap.get(w) ?? null;
    if (f !== t) reassigned.push({ workerId: w, fromTaskId: f, toTaskId: t });
  }

  const fromDelayed = new Set(from.delayedTaskIds);
  const toDelayed = new Set(to.delayedTaskIds);
  const tasksBecameDelayed = [...toDelayed].filter((t) => !fromDelayed.has(t) && fromTasks.has(t)).sort();
  const tasksBecameAssigned = [...fromDelayed].filter((t) => !toDelayed.has(t) && toTasks.has(t)).sort();

  return {
    reassigned,
    tasksBecameDelayed,
    tasksBecameAssigned,
    workersRemoved: from.workerIds.filter((w) => !toWorkers.has(w)).sort(),
    workersAdded: to.workerIds.filter((w) => !fromWorkers.has(w)).sort(),
    tasksRemoved: from.taskIds.filter((t) => !toTasks.has(t)).sort(),
    tasksAdded: to.taskIds.filter((t) => !fromTasks.has(t)).sort(),
  };
}
