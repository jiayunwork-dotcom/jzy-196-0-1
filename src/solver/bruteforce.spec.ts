import { solveAssignment } from './assignment';
import { verifyCertificate } from './certificate';
import { AssignmentInput } from './types';

/** 穷举所有可行的人-任务匹配（含允许的闲置/顺延），返回最优业务代价。 */
function bruteForceOptimal(input: AssignmentInput): { cost: number; coverage: number } {
  const { workers, tasks, costs } = input;
  const m = workers.length;
  const t = tasks.length;
  const idle = input.idleCosts ?? new Array(m).fill(0);
  const delay = input.delayCosts ?? new Array(t).fill(0);

  let best = Infinity;
  let bestCoverage = -1;

  const recurse = (i: number, usedTasks: boolean[], cost: number, coverage: number) => {
    if (i === m) {
      let c = cost;
      for (let j = 0; j < t; j++) if (!usedTasks[j]) c += delay[j];
      // 字典序：先比 coverage，再比 cost。
      if (coverage > bestCoverage || (coverage === bestCoverage && c < best)) {
        best = c;
        bestCoverage = coverage;
      }
      return;
    }
    // 闲置。
    recurse(i + 1, usedTasks, cost + idle[i], coverage);
    // 派到任一空闲且允许的任务。
    for (let j = 0; j < t; j++) {
      if (usedTasks[j] || costs[i][j] === null) continue;
      usedTasks[j] = true;
      recurse(i + 1, usedTasks, cost + (costs[i][j] as number), coverage + 1);
      usedTasks[j] = false;
    }
  };
  recurse(0, new Array(t).fill(false), 0, 0);
  return { cost: best, coverage: bestCoverage };
}

function randomMatrix(m: number, t: number, forbiddenRate: number): (number | null)[][] {
  const out: (number | null)[][] = [];
  for (let i = 0; i < m; i++) {
    const row: (number | null)[] = [];
    for (let j = 0; j < t; j++) {
      row.push(Math.random() < forbiddenRate ? null : Math.floor(Math.random() * 20));
    }
    out.push(row);
  }
  return out;
}

describe('求解器随机穷举核对', () => {
  test('300 个随机小算例：求解值=穷举最优，且证书全部可验证', () => {
    for (let seed = 0; seed < 300; seed++) {
      const m = 1 + Math.floor(Math.random() * 5);
      const t = 1 + Math.floor(Math.random() * 5);
      const costs = randomMatrix(m, t, 0.25);
      const input: AssignmentInput = {
        workers: Array.from({ length: m }, (_, i) => `w${i}`),
        tasks: Array.from({ length: t }, (_, j) => `t${j}`),
        costs,
        idleCosts: Array.from({ length: m }, () => Math.floor(Math.random() * 3)),
        delayCosts: Array.from({ length: t }, () => Math.floor(Math.random() * 3)),
      };
      const r = solveAssignment(input);
      const bf = bruteForceOptimal(input);
      expect(r.totalCost).toBe(bf.cost);
      const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
      expect(v.valid).toBe(true);
    }
  });

  test('规模 30×50 性能与证书', () => {
    const m = 30;
    const t = 50;
    const input: AssignmentInput = {
      workers: Array.from({ length: m }, (_, i) => `w${i}`),
      tasks: Array.from({ length: t }, (_, j) => `t${j}`),
      costs: randomMatrix(m, t, 0.1),
      delayCosts: Array.from({ length: t }, () => 50),
    };
    const t0 = Date.now();
    const r = solveAssignment(input);
    const ms = Date.now() - t0;
    // 节点 162、弧 ~5000，SPFA 应当秒级以内；这里给宽裕上限。
    expect(ms).toBeLessThan(15000);
    expect(r.matches.length).toBe(m);
    expect(r.certificate.coverage).toBe(m);
    const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
    expect(v.valid).toBe(true);
  });
});
