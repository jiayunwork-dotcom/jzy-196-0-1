/**
 * 版本间方案差异计算（纯函数）。
 *
 * 改派口径：同一名质检员在两版中“去的任务”不同（在岗↔闲置、任务 A→任务 B）
 * 即算一次改派；只在新版出现的人、只在旧版存在的人单独列出，不计入 reassigned。
 */
import { MatchEntry } from '../solver/types';

export type AssignmentMap = Map<string, string | null>;

export function toAssignmentMap(matches: MatchEntry[]): AssignmentMap {
  return new Map(matches.map((m) => [m.workerId, m.taskId]));
}

export interface Reassignment {
  workerId: string;
  fromTaskId: string | null;
  toTaskId: string | null;
}

export interface VersionDiff {
  versionA: number;
  versionB: number;
  /** A→B 中任务发生变化的质检员（两版都存在）。 */
  reassigned: Reassignment[];
  /** 仅在 A 版存在的质检员（被移除/请假）。 */
  workersRemoved: string[];
  /** 仅在 B 版存在的质检员（新增/销假）。 */
  workersAdded: string[];
  /** A 版有但 B 版没有承接人的任务（含取消/顺延变化）。 */
  tasksUnassignedInB: string[];
  /** B 版新被承接的任务。 */
  tasksNewlyAssignedInB: string[];
  /** 改派人数。 */
  reassignedCount: number;
}

export function diffAssignments(
  aVersion: number,
  a: MatchEntry[],
  bVersion: number,
  b: MatchEntry[],
): VersionDiff {
  const mapA = toAssignmentMap(a);
  const mapB = toAssignmentMap(b);

  const reassigned: Reassignment[] = [];
  for (const [workerId, taskB] of mapB) {
    if (!mapA.has(workerId)) continue;
    const taskA = mapA.get(workerId)!;
    if (taskA !== taskB) reassigned.push({ workerId, fromTaskId: taskA, toTaskId: taskB });
  }
  reassigned.sort((x, y) => (x.workerId < y.workerId ? -1 : 1));

  const workersAdded = [...mapB.keys()].filter((w) => !mapA.has(w)).sort();
  const workersRemoved = [...mapA.keys()].filter((w) => !mapB.has(w)).sort();

  const assignedA = new Set([...mapA.values()].filter((v): v is string => v !== null));
  const assignedB = new Set([...mapB.values()].filter((v): v is string => v !== null));
  const tasksUnassignedInB = [...assignedA].filter((t) => !assignedB.has(t)).sort();
  const tasksNewlyAssignedInB = [...assignedB].filter((t) => !assignedA.has(t)).sort();

  return {
    versionA: aVersion,
    versionB: bVersion,
    reassigned,
    workersRemoved,
    workersAdded,
    tasksUnassignedInB,
    tasksNewlyAssignedInB,
    reassignedCount: reassigned.length,
  };
}
