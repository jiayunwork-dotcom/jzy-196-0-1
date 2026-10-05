import { solveAssignment } from './assignment';
import { verifyCertificate } from './certificate';
import { AssignmentInput } from './types';

function makeInput(costs: (number | null)[][], opts?: Partial<AssignmentInput>): AssignmentInput {
  const m = costs.length;
  const t = costs[0]?.length ?? 0;
  return {
    workers: Array.from({ length: m }, (_, i) => `w${i}`),
    tasks: Array.from({ length: t }, (_, j) => `t${j}`),
    costs,
    ...opts,
  };
}

describe('求解器快速冒烟', () => {
  test('参考算例 3×3 最优值为 5 且证书可独立验证', () => {
    const input = makeInput([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]);
    const r = solveAssignment(input);
    expect(r.totalCost).toBe(5);
    const byWorker = new Map(r.matches.map((x) => [x.workerId, x.taskId]));
    expect(byWorker.get('w0')).toBe('t1');
    expect(byWorker.get('w1')).toBe('t0');
    expect(byWorker.get('w2')).toBe('t2');
    const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
    expect(v.valid).toBe(true);
  });

  test('矩形：人少任务多，超出的人顺延', () => {
    const input = makeInput([
      [1, 10, 100],
      [10, 2, 100],
    ]);
    const r = solveAssignment(input);
    expect(r.delayedTasks).toEqual(['t2']);
    expect(r.totalCost).toBe(3);
    const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
    expect(v.valid).toBe(true);
  });

  test('禁止组合绝不出现，全禁止者被报告', () => {
    const input = makeInput([
      [1, null],
      [null, null],
      [5, 6],
    ]);
    const r = solveAssignment(input);
    expect(r.unassignableWorkers).toEqual(['w1']);
    for (const match of r.matches) {
      if (match.taskId === null) continue;
      const i = Number(match.workerId.slice(1));
      const j = Number(match.taskId.slice(1));
      expect(input.costs[i][j]).not.toBeNull();
    }
    const v = verifyCertificate(input, r.matches, r.certificate, r.totalCost);
    expect(v.valid).toBe(true);
  });

  test('确定性：同输入多次结果一致', () => {
    const input = makeInput([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const a = solveAssignment(input);
    const b = solveAssignment(input);
    expect(a.matches).toEqual(b.matches);
  });
});
