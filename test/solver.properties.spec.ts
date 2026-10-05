/**
 * 求解器必须成立的性质：
 *  - 参考算例；
 *  - 行/列整体平移不变（平移作用于补零后的完整行/列，即含闲置/延误代价）；
 *  - 转置问题（人↔任务、闲置↔延误）最优总代价相同、真人配对集合相同；
 *  - 最优不劣于贪心（业务场景：每个可安排的人都派出，即最大配对数下的贪心）；
 *  - 禁止组合绝不出现；全禁止的人/任务如实报告；
 *  - 同等最优解的确定性；
 *  - 每份方案附带的证书都可被独立校验器验证。
 */
import { solveAssignment } from '../src/solver/assignment';
import { verifyCertificate } from '../src/solver/certificate';
import { AssignmentInput } from '../src/solver/types';

let seedState = 1234567;
function rand(): number {
  // 确定性伪随机，保证测试可复现。
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

function makeProblem(m: number, t: number, forbiddenRate = 0): AssignmentInput {
  const costs: (number | null)[][] = [];
  for (let i = 0; i < m; i++) {
    const row: (number | null)[] = [];
    for (let j = 0; j < t; j++) {
      row.push(rand() < forbiddenRate ? null : Math.floor(rand() * 30));
    }
    costs.push(row);
  }
  return {
    workers: Array.from({ length: m }, (_, i) => `w${i}`),
    tasks: Array.from({ length: t }, (_, j) => `t${j}`),
    costs,
    idleCosts: Array.from({ length: m }, () => Math.floor(rand() * 5)),
    delayCosts: Array.from({ length: t }, () => Math.floor(rand() * 50)),
  };
}

function assignmentMap(p: AssignmentInput, r: ReturnType<typeof solveAssignment>) {
  return new Map(r.matches.map((mm) => [mm.workerId, mm.taskId]));
}

describe('求解器性质', () => {
  test('参考算例：3×3 最优总代价 5，配对为 w0→t1, w1→t0, w2→t2', () => {
    const input: AssignmentInput = {
      workers: ['w0', 'w1', 'w2'],
      tasks: ['t0', 't1', 't2'],
      costs: [
        [4, 1, 3],
        [2, 0, 5],
        [3, 2, 2],
      ],
    };
    const r = solveAssignment(input);
    expect(r.totalCost).toBe(5);
    const m = assignmentMap(input, r);
    expect(m.get('w0')).toBe('t1');
    expect(m.get('w1')).toBe('t0');
    expect(m.get('w2')).toBe('t2');
    const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
    expect(v.valid).toBe(true);
  });

  test('行/列整体加常数，最优分配不变（含闲置/延误代价的平移）', () => {
    for (let trial = 0; trial < 60; trial++) {
      const m = 1 + Math.floor(rand() * 4);
      const t = m + Math.floor(rand() * 4);
      const input = makeProblem(m, t, 0.1);
      const base = solveAssignment(input);
      const baseMap = assignmentMap(input, base);

      // 行平移：某一行所有真实代价与该行闲置代价同时加 K。
      const ri = Math.floor(rand() * m);
      const K = 1 + Math.floor(rand() * 100);
      const rowShifted: AssignmentInput = {
        ...input,
        costs: input.costs.map((row, i) => (i === ri ? row.map((c) => (c === null ? null : c + K)) : row)),
        idleCosts: input.idleCosts!.map((a, i) => (i === ri ? a + K : a)),
      };
      const rs = solveAssignment(rowShifted);
      expect(assignmentMap(rowShifted, rs)).toEqual(baseMap);
      // 总代价恰好增加 K（该人必出工或闲置，二者都被平移）。
      expect(rs.totalCost).toBe(base.totalCost + K);
      expect(verifyCertificate(rowShifted, rs.matches, rs.certificate, rs.totalCost).valid).toBe(true);

      // 列平移：某一列所有真实代价与该任务延误代价同时加 K。
      const cj = Math.floor(rand() * t);
      const K2 = 1 + Math.floor(rand() * 100);
      const colShifted: AssignmentInput = {
        ...input,
        costs: input.costs.map((row) => row.map((c, j) => (j === cj && c !== null ? c + K2 : c))),
        delayCosts: input.delayCosts!.map((d, j) => (j === cj ? d + K2 : d)),
      };
      const cs = solveAssignment(colShifted);
      expect(assignmentMap(colShifted, cs)).toEqual(baseMap);
      expect(cs.totalCost).toBe(base.totalCost + K2);
      expect(verifyCertificate(colShifted, cs.matches, cs.certificate, cs.totalCost).valid).toBe(true);
    }
  });

  test('转置问题：人与任务互换，最优总代价相同、真人配对集合相同', () => {
    for (let trial = 0; trial < 60; trial++) {
      const m = 1 + Math.floor(rand() * 4);
      const t = 1 + Math.floor(rand() * 4);
      const input = makeProblem(m, t, 0.2);
      const r = solveAssignment(input);

      const transposed: AssignmentInput = {
        workers: input.tasks.map((x) => x), // 原任务变“人”
        tasks: input.workers.map((x) => x), // 原人变“任务”
        costs: Array.from({ length: t }, (_, j) =>
          Array.from({ length: m }, (_, i) => input.costs[i][j]),
        ),
        idleCosts: [...input.delayCosts!], // 原延误变闲置
        delayCosts: [...input.idleCosts!], // 原闲置变延误
      };
      const rt = solveAssignment(transposed);
      expect(rt.totalCost).toBe(r.totalCost);

      // 真人配对集合（无序边集）相同。
      const edgesA = new Set(
        r.matches.filter((x) => x.taskId !== null).map((x) => `${x.workerId}|${x.taskId}`),
      );
      const edgesB = new Set(
        rt.matches
          .filter((x) => x.taskId !== null)
          .map((x) => `${x.taskId}|${x.workerId}`),
      );
      expect(edgesB).toEqual(edgesA);
      expect(
        verifyCertificate(transposed, rt.matches, rt.certificate, rt.totalCost).valid,
      ).toBe(true);
    }
  });

  test('最优总代价不大于“把每个人都派出去”的贪心分配（200 个随机算例）', () => {
    /**
     * 贪心：按 (i) 质检员顺序，每人选当前未被占用且允许的最便宜任务；
     * 若某人没有可去的空闲任务则闲置（仅在禁止组合严重受限的算例出现，
     * 此时该算例跳过，保证比较双方都处于同一最大可派人数）。剩余任务计延误代价。
     */
    for (let trial = 0; trial < 200; trial++) {
      const m = 2 + Math.floor(rand() * 5);
      const t = m + Math.floor(rand() * 5);
      const input = makeProblem(m, t, 0.05); // 稀疏禁止组合，业务典型场景
      const opt = solveAssignment(input);

      // 贪心 A：按人行序。
      const used = new Set<number>();
      let greedyOk = true;
      let greedyCost = 0;
      for (let i = 0; i < m; i++) {
        let best = -1;
        for (let j = 0; j < t; j++) {
          if (used.has(j) || input.costs[i][j] === null) continue;
          if (best === -1 || (input.costs[i][j] as number) < (input.costs[i][best] as number)) {
            best = j;
          }
        }
        if (best === -1) {
          // 贪心把人闲置：仅当最优也无法达到全员覆盖时才做同口径比较。
          if (opt.certificate.coverage === m) {
            greedyOk = false;
            break;
          }
          greedyCost += input.idleCosts![i];
          continue;
        }
        used.add(best);
        greedyCost += input.costs[i][best] as number;
      }
      if (!greedyOk) continue;
      for (let j = 0; j < t; j++) if (!used.has(j)) greedyCost += input.delayCosts![j];
      expect(opt.totalCost).toBeLessThanOrEqual(greedyCost + 1e-9);
      expect(verifyCertificate(input, opt.matches, opt.certificate, opt.totalCost).valid).toBe(true);

      // 贪心 B：全局最便宜边依次拿（每条边最多取一次）。
      const edges: [number, number, number][] = [];
      for (let i = 0; i < m; i++)
        for (let j = 0; j < t; j++)
          if (input.costs[i][j] !== null) edges.push([i, j, input.costs[i][j] as number]);
      edges.sort((a, b) => a[2] - b[2]);
      const w2t = new Map<number, number>();
      const takenT = new Set<number>();
      let greedyB = 0;
      for (const [i, j, c] of edges) {
        if (w2t.has(i) || takenT.has(j)) continue;
        w2t.set(i, j);
        takenT.add(j);
        greedyB += c;
      }
      for (let i = 0; i < m; i++) if (!w2t.has(i)) greedyB += input.idleCosts![i];
      for (let j = 0; j < t; j++) if (!takenT.has(j)) greedyB += input.delayCosts![j];
      // 贪心边序可能只得到极大而非最大匹配；仅在它同样全员派出时同口径比较。
      if (w2t.size === m) {
        expect(opt.totalCost).toBeLessThanOrEqual(greedyB + 1e-9);
      }
    }
  });

  test('禁止组合绝不出现；所有组合都被禁止的人/任务被如实报告', () => {
    const input: AssignmentInput = {
      workers: ['w0', 'w1', 'w2', 'w3'],
      tasks: ['t0', 't1', 't2'],
      costs: [
        [1, null, 2],
        [null, null, null], // 全禁止的人
        [3, 4, 5],
        [6, 7, null],
      ],
      delayCosts: [9, 9, 9],
    };
    const r = solveAssignment(input);
    expect(r.unassignableWorkers).toEqual(['w1']);
    for (const match of r.matches) {
      if (match.taskId === null) continue;
      const i = Number(match.workerId.slice(1));
      const j = Number(match.taskId.slice(1));
      expect(input.costs[i][j]).not.toBeNull();
    }

    const allForbiddenTask: AssignmentInput = {
      workers: ['a', 'b'],
      tasks: ['x', 'y'],
      costs: [
        [1, null],
        [2, null],
      ], // 任务 y 对所有人禁止
      delayCosts: [0, 7],
    };
    const r2 = solveAssignment(allForbiddenTask);
    expect(r2.impossibleTasks).toEqual(['y']);
    expect(r2.delayedTasks).toContain('y');
    const v = verifyCertificate(allForbiddenTask, r2.matches, r2.certificate, r2.totalCost);
    expect(v.valid).toBe(true);
  });

  test('确定性：存在多个同等最优解时，同一份输入每次返回同一个解', () => {
    const input: AssignmentInput = {
      workers: ['a', 'b', 'c'],
      tasks: ['x', 'y', 'z'],
      costs: [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    };
    const first = JSON.stringify(solveAssignment(input).matches);
    for (let k = 0; k < 20; k++) {
      expect(JSON.stringify(solveAssignment(input).matches)).toBe(first);
    }
  });
});
