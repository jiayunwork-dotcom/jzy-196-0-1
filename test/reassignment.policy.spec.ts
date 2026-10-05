/**
 * 重排规则的小规模穷举核对。
 *
 * 声称的性质（文档 REASSIGNMENT_POLICY.md）：
 *   在所有“配对数最大且业务总代价等于最优值 C”的方案中，求解器返回的方案
 *   改派人数（相对上一版）最少；若仍有并列，则返回唯一的规范方案（确定性）。
 * 本测试穷举所有可行匹配逐一核对该性质。
 */
import { solveAssignment, PreviousAssignment } from '../src/solver/assignment';
import { verifyCertificate } from '../src/solver/certificate';
import { AssignmentInput, MatchEntry } from '../src/solver/types';

interface Enumerated {
  workerTask: (number | null)[];
  cost: number;
  coverage: number;
}

function enumerate(input: AssignmentInput): Enumerated[] {
  const m = input.workers.length;
  const t = input.tasks.length;
  const idle = input.idleCosts ?? new Array(m).fill(0);
  const delay = input.delayCosts ?? new Array(t).fill(0);
  const out: Enumerated[] = [];

  const recurse = (i: number, used: boolean[], wt: (number | null)[], cost: number, coverage: number) => {
    if (i === m) {
      let c = cost;
      for (let j = 0; j < t; j++) if (!used[j]) c += delay[j];
      out.push({ workerTask: [...wt], cost: c, coverage });
      return;
    }
    wt[i] = null;
    recurse(i + 1, used, wt, cost + idle[i], coverage);
    for (let j = 0; j < t; j++) {
      if (used[j] || input.costs[i][j] === null) continue;
      used[j] = true;
      wt[i] = j;
      recurse(i + 1, used, wt, cost + (input.costs[i][j] as number), coverage + 1);
      used[j] = false;
      wt[i] = null;
    }
  };
  recurse(0, new Array(t).fill(false), new Array(m).fill(null), 0, 0);
  return out;
}

let seedState = 98765;
function rand(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

function randomProblem(m: number, t: number): AssignmentInput {
  return {
    workers: Array.from({ length: m }, (_, i) => `w${i}`),
    tasks: Array.from({ length: t }, (_, j) => `t${j}`),
    costs: Array.from({ length: m }, () =>
      Array.from({ length: t }, () => (rand() < 0.2 ? null : Math.floor(rand() * 8))),
    ),
    idleCosts: Array.from({ length: m }, () => Math.floor(rand() * 3)),
    delayCosts: Array.from({ length: t }, () => Math.floor(rand() * 8)),
  };
}

function countReassigned(input: AssignmentInput, wt: (number | null)[], prev: Map<string, string | null>): number {
  let n = 0;
  input.workers.forEach((w, i) => {
    if (!prev.has(w)) return;
    const oldTask = prev.get(w)!;
    const newTask = wt[i] === null ? null : input.tasks[wt[i]!];
    if (oldTask !== newTask) n++;
  });
  return n;
}

describe('重排策略：最小改派的穷举核对', () => {
  test('120 个随机小算例：在所有最大配对数+最优代价的方案中改派人数最少', () => {
    for (let trial = 0; trial < 120; trial++) {
      const m = 1 + Math.floor(rand() * 4);
      const t = 1 + Math.floor(rand() * 4);
      const input = randomProblem(m, t);
      const all = enumerate(input);

      // 最大配对数与该配对数下的最优代价。
      const maxCoverage = Math.max(...all.map((x) => x.coverage));
      const optimalCost = Math.min(
        ...all.filter((x) => x.coverage === maxCoverage).map((x) => x.cost),
      );

      // 随机造一个“上一版”：从穷举集里任取一个可行方案作为参照。
      const reference = all[Math.floor(rand() * all.length)];
      const prev = new Map<string, string | null>();
      input.workers.forEach((w, i) => {
        const j = reference.workerTask[i];
        prev.set(w, j === null ? null : input.tasks[j]);
      });

      const expectedMinReassignments = Math.min(
        ...all
          .filter((x) => x.coverage === maxCoverage && Math.abs(x.cost - optimalCost) < 1e-9)
          .map((x) => countReassigned(input, x.workerTask, prev)),
      );

      const previous: PreviousAssignment = { workerToTask: prev };
      const r = solveAssignment(input, previous);
      expect(r.totalCost).toBeCloseTo(optimalCost, 9);

      const wtGot = input.workers.map((w) => {
        const taskId = r.matches.find((mm: MatchEntry) => mm.workerId === w)!.taskId;
        return taskId === null ? null : input.tasks.indexOf(taskId);
      });
      const gotReassignments = countReassigned(input, wtGot, prev);
      expect(gotReassignments).toBe(expectedMinReassignments);

      // 证书可独立验证。
      const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
      expect(v.valid).toBe(true);

      // 确定性：同输入+同上一版，连跑两次完全一致。
      const r2 = solveAssignment(input, previous);
      expect(r2.matches).toEqual(r.matches);
    }
  });

  test('典型场景：一次改价只应牵动必要的人，不发生大面积改派', () => {
    // 5 人 5 任务，初始有唯一最优；把某条边改贵，只允许局部轮换时改派人数应为最小。
    const input: AssignmentInput = {
      workers: ['w0', 'w1', 'w2', 'w3', 'w4'],
      tasks: ['t0', 't1', 't2', 't3', 't4'],
      costs: [
        [0, 9, 9, 9, 9],
        [9, 0, 9, 9, 9],
        [9, 9, 0, 9, 9],
        [9, 9, 9, 0, 9],
        [9, 9, 9, 9, 0],
      ],
    };
    const base = solveAssignment(input);
    const prev = new Map(base.matches.map((mm) => [mm.workerId, mm.taskId]));

    // 把 w0→t0 改贵到 20：最优变为 t0 走次便宜。构造一条局部更优链。
    input.costs[0][0] = 20;
    input.costs[0][1] = 1; // w0 抢 t1
    input.costs[1][0] = 1; // w1 接 t0
    const r = solveAssignment(input, { workerToTask: prev });

    // 只应有 w0、w1 两人改派，w2/w3/w4 不动。
    expect(r.reassignedWorkers.sort()).toEqual(['w0', 'w1']);
    const map = new Map(r.matches.map((mm) => [mm.workerId, mm.taskId]));
    expect(map.get('w2')).toBe('t2');
    expect(map.get('w3')).toBe('t3');
    expect(map.get('w4')).toBe('t4');
    // 且仍是“最大配对数下”的全局最优（穷举基准）。
    const all = enumerate(input);
    const maxCov = Math.max(...all.map((x) => x.coverage));
    const best = Math.min(...all.filter((x) => x.coverage === maxCov).map((x) => x.cost));
    expect(r.totalCost).toBe(best);
  });
});
