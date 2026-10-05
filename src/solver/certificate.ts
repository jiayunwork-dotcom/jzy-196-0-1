/**
 * 最优性证书校验器（独立于求解过程，调用方可逐条核对）。
 *
 * 固定覆盖数 k 的矩形松弛指派（最小化），外部对偶 (p_i, q_j, λ)：
 *  1. 对偶可行——每个允许组合 (i,j)：p_i + q_j + λ ≤ c_ij；
 *  2. 闲置边界——每个人：p_i ≤ a_i；
 *  3. 延误边界——每个任务：q_j ≤ d_j；
 *  4. 互补松弛（紧约束）：
 *     - 选中的真人-真任务组合 p_i + q_j + λ = c_ij；
 *     - 闲置者 p_i = a_i；顺延任务 q_j = d_j；
 *  5. 合法性——一对一、不含禁止组合、每个质检员恰有一条记录；
 *  6. 强对偶——Σp_i + Σq_j + k·λ = 业务总代价。
 * 全部通过 ⇒ 该分配是“恰好 k 对真人-真任务”可行域上的全局最优；
 * 求解器保证 k 是可行最大配对数（禁止组合受限时可能小于 min(m,t)），
 * 故事实上就是业务规则“尽可能派满、派不满才顺延/闲置”下的最优。
 */
import { AssignmentInput, Certificate, MatchEntry } from './types';

export const EPS = 1e-9;

export interface VerificationResult {
  valid: boolean;
  violations: string[];
  dualObjective: number;
  primalObjective: number;
  coverage: number;
  checks: {
    dualFeasibleEdges: number;
    tightMatchedEdges: number;
    forbiddenUsed: number;
    oneToOne: boolean;
  };
}

export function verifyCertificate(
  input: AssignmentInput,
  matches: MatchEntry[],
  cert: Certificate,
  declaredTotalCost: number,
): VerificationResult {
  const violations: string[] = [];
  const { workers, tasks, costs } = input;
  const m = workers.length;
  const t = tasks.length;
  const idleCosts = input.idleCosts ?? new Array(m).fill(0);
  const delayCosts = input.delayCosts ?? new Array(t).fill(0);
  const p = cert.workerPotentials;
  const q = cert.taskPotentials;
  const lambda = cert.coveragePotential;

  if (p.length !== m) violations.push(`workerPotentials 长度 ${p.length} ≠ 人数 ${m}`);
  if (q.length !== t) violations.push(`taskPotentials 长度 ${q.length} ≠ 任务数 ${t}`);
  if (!Number.isFinite(lambda)) violations.push('coveragePotential 非有限数');

  // 1) 允许组合对偶可行。
  let dualFeasibleEdges = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < t; j++) {
      const c = costs[i][j];
      if (c === null) continue;
      dualFeasibleEdges++;
      const lhs = p[i] + q[j] + lambda;
      if (lhs > c + EPS) {
        violations.push(
          `对偶不可行：${workers[i]}→${tasks[j]}，p_i+q_j+λ=${lhs} > c_ij=${c}`,
        );
      }
    }
  }

  // 2)/3)。
  for (let i = 0; i < m; i++) {
    if (p[i] > idleCosts[i] + EPS) {
      violations.push(`闲置边界被违反：p_${workers[i]}=${p[i]} > a_i=${idleCosts[i]}`);
    }
  }
  for (let j = 0; j < t; j++) {
    if (q[j] > delayCosts[j] + EPS) {
      violations.push(`延误边界被违反：q_${tasks[j]}=${q[j]} > d_j=${delayCosts[j]}`);
    }
  }

  const workerIndex = new Map(workers.map((w, i) => [w, i]));
  const taskIndex = new Map(tasks.map((x, j) => [x, j]));
  const seenWorkers = new Set<string>();
  const seenTasks = new Set<string>();
  let forbiddenUsed = 0;
  let tightMatchedEdges = 0;
  let primalObjective = 0;
  let coverage = 0;

  for (const match of matches) {
    const i = workerIndex.get(match.workerId);
    if (i === undefined) {
      violations.push(`分配引用了不存在的质检员：${match.workerId}`);
      continue;
    }
    if (seenWorkers.has(match.workerId)) {
      violations.push(`质检员被分配了多个任务：${match.workerId}`);
    }
    seenWorkers.add(match.workerId);

    if (match.taskId === null) {
      primalObjective += idleCosts[i];
      if (Math.abs(p[i] - idleCosts[i]) > EPS) {
        violations.push(
          `闲置配对非紧：p_${match.workerId}=${p[i]} ≠ a_i=${idleCosts[i]}`,
        );
      }
      continue;
    }

    const j = taskIndex.get(match.taskId);
    if (j === undefined) {
      violations.push(`分配引用了不存在的任务：${match.taskId}`);
      continue;
    }
    if (seenTasks.has(match.taskId)) {
      violations.push(`任务被分配给了多个质检员：${match.taskId}`);
    }
    seenTasks.add(match.taskId);

    const c = costs[i][j];
    if (c === null) {
      forbiddenUsed++;
      violations.push(`使用了禁止组合：${match.workerId}→${match.taskId}`);
      continue;
    }
    primalObjective += c;
    coverage++;
    tightMatchedEdges++;
    const lhs = p[i] + q[j] + lambda;
    if (Math.abs(lhs - c) > EPS) {
      violations.push(
        `选中组合非紧约束：${match.workerId}→${match.taskId}，p_i+q_j+λ=${lhs} ≠ c=${c}`,
      );
    }
  }

  for (let j = 0; j < t; j++) {
    if (!seenTasks.has(tasks[j])) {
      primalObjective += delayCosts[j];
      if (Math.abs(q[j] - delayCosts[j]) > EPS) {
        violations.push(`顺延任务非紧：q_${tasks[j]}=${q[j]} ≠ d_j=${delayCosts[j]}`);
      }
    }
  }
  for (const w of workers) {
    if (!seenWorkers.has(w)) violations.push(`缺少质检员的分配条目：${w}`);
  }

  const oneToOne = !violations.some(
    (v) => v.includes('多个任务') || v.includes('多个质检员'),
  );

  if (cert.coverage !== coverage) {
    violations.push(`证书声明 coverage=${cert.coverage}，实际配对数=${coverage}`);
  }

  if (
    Math.abs(primalObjective - declaredTotalCost) >
    1e-7 * Math.max(1, Math.abs(primalObjective))
  ) {
    violations.push(
      `声明总代价 ${declaredTotalCost} 与独立重算 ${primalObjective} 不一致`,
    );
  }

  // 强对偶：Σp_i + Σq_j + k·λ。
  let dualObjective = 0;
  for (let i = 0; i < m; i++) dualObjective += p[i];
  for (let j = 0; j < t; j++) dualObjective += q[j];
  dualObjective += coverage * lambda;

  if (
    Math.abs(dualObjective - primalObjective) >
    1e-7 * Math.max(1, Math.abs(primalObjective))
  ) {
    violations.push(
      `强对偶失败：对偶目标 ${dualObjective} ≠ 原始目标 ${primalObjective}`,
    );
  }

  return {
    valid: violations.length === 0,
    violations,
    dualObjective,
    primalObjective,
    coverage,
    checks: { dualFeasibleEdges, tightMatchedEdges, forbiddenUsed, oneToOne },
  };
}
