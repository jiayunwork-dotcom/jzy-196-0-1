/**
 * 增量修复正确性：对“上一版 → 变动后的新问题”，
 * 增量热启动（负环消去 + 最短路补齐）与从零求解必须得到相同的目标值，
 * 并且增量结果证书同样通过独立校验。
 *
 * 覆盖的变动：人员请假/销假、新增/删除任务、任务取消、若干组合改价/改禁止。
 */
import { solveAssignment, PreviousAssignment } from '../src/solver/assignment';
import { verifyCertificate } from '../src/solver/certificate';
import { AssignmentInput } from '../src/solver/types';
import { applyChange, buildInitialState, Change, cloneState, DayState, toSolverInput } from '../src/domain/state';

let seedState = 424242;
function rand(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

function randomInitial(m: number, t: number) {
  return {
    workers: Array.from({ length: m }, (_, i) => ({ id: `w${i}`, idleCost: Math.floor(rand() * 3) })),
    tasks: Array.from({ length: t }, (_, j) => ({ id: `t${j}`, delayCost: Math.floor(rand() * 40) })),
    costs: Array.from(
      { length: m },
      () => Array.from({ length: t }, () => (rand() < 0.15 ? null : Math.floor(rand() * 30))),
    ),
  };
}

function prevMapFromResult(workers: string[], tasks: string[], result: ReturnType<typeof solveAssignment>) {
  const map = new Map<string, string | null>();
  for (const w of workers) map.set(w, null);
  for (const mm of result.matches) map.set(mm.workerId, mm.taskId);
  void tasks;
  return map;
}

describe('增量修复 vs 从头求解', () => {
  test('对 150 个随机变动序列，两种求解目标值完全一致', () => {
    for (let trial = 0; trial < 150; trial++) {
      const m = 2 + Math.floor(rand() * 5);
      const t = 3 + Math.floor(rand() * 5);
      let state: DayState = buildInitialState(randomInitial(m, t));
      let input = toSolverInput(state);
      let result = solveAssignment(input);
      expect(verifyCertificate(input, result.matches, result.certificate, result.totalCost).valid).toBe(true);

      // 每个算例连续施加 1..4 次变动，每次都核对。
      const steps = 1 + Math.floor(rand() * 4);
      for (let s = 0; s < steps; s++) {
        const change = randomChange(state);
        if (!change) break;
        state = applyChange(cloneState(state), change);
        input = toSolverInput(state);
        const prev: PreviousAssignment = { workerToTask: prevMapFromResult(input.workers, input.tasks, result) };

        const inc = solveAssignment(input, prev);
        const scratch = solveAssignment(input);
        expect(inc.totalCost).toBeCloseTo(scratch.totalCost, 9);
        expect(inc.certificate.coverage).toBe(scratch.certificate.coverage);
        const v = verifyCertificate(input, inc.matches, inc.certificate, inc.totalCost);
        expect(v.valid).toBe(true);
        result = inc;
      }
    }
  });

  test('规模 30×50 的单个变动：增量解同样最优（与从头目标一致）', () => {
    let state: DayState = buildInitialState(randomInitial(30, 50));
    let input = toSolverInput(state);
    const base = solveAssignment(input);

    // 改一条边的代价。
    state = applyChange(cloneState(state), {
      type: 'set-cost',
      workerId: 'w3',
      taskId: 't20',
      cost: (input.costs[3][20] ?? 10) + 25,
    });
    input = toSolverInput(state);
    const prev: PreviousAssignment = { workerToTask: prevMapFromResult(input.workers, input.tasks, base) };
    const inc = solveAssignment(input, prev);
    const scratch = solveAssignment(input);
    expect(inc.totalCost).toBeCloseTo(scratch.totalCost, 9);
    expect(verifyCertificate(input, inc.matches, inc.certificate, inc.totalCost).valid).toBe(true);

    // 一个人请假。
    let state2 = applyChange(cloneState(state), { type: 'worker-unavailable', workerId: 'w7' });
    const input2 = toSolverInput(state2);
    const prev2: PreviousAssignment = { workerToTask: prevMapFromResult(input2.workers, input2.tasks, inc) };
    const inc2 = solveAssignment(input2, prev2);
    const scratch2 = solveAssignment(input2);
    expect(inc2.totalCost).toBeCloseTo(scratch2.totalCost, 9);
    expect(verifyCertificate(input2, inc2.matches, inc2.certificate, inc2.totalCost).valid).toBe(true);
  });
});

function randomChange(state: DayState): Change | null {
  const pick = function <T>(arr: T[]): T {
    return arr[Math.floor(rand() * arr.length)];
  };
  const kinds = ['unavail', 'avail', 'addTask', 'removeTask', 'setCost', 'setForbidden', 'addWorker'];
  for (let attempt = 0; attempt < 6; attempt++) {
    const kind = pick(kinds);
    switch (kind) {
      case 'unavail': {
        const w = pick(state.workers);
        if (!w.available) continue;
        return { type: 'worker-unavailable', workerId: w.id };
      }
      case 'avail': {
        const w = pick(state.workers);
        if (w.available) continue;
        return { type: 'worker-available', workerId: w.id };
      }
      case 'addTask': {
        const id = `newT${Math.floor(rand() * 1e9)}`;
        return {
          type: 'add-task',
          taskId: id,
          delayCost: Math.floor(rand() * 40),
          costs: state.workers
            .filter(() => rand() < 0.7)
            .map((w) => ({ workerId: w.id, cost: Math.floor(rand() * 30) })),
        };
      }
      case 'removeTask': {
        if (state.tasks.length <= 1) continue;
        return { type: 'remove-task', taskId: pick(state.tasks).id };
      }
      case 'setCost':
      case 'setForbidden': {
        const w = pick(state.workers);
        const t = pick(state.tasks);
        return {
          type: 'set-cost',
          workerId: w.id,
          taskId: t.id,
          cost: kind === 'setForbidden' ? null : Math.floor(rand() * 30),
        };
      }
      case 'addWorker': {
        const id = `newW${Math.floor(rand() * 1e9)}`;
        return { type: 'add-worker', workerId: id, idleCost: Math.floor(rand() * 3) };
      }
    }
  }
  return null;
}
