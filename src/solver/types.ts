/**
 * 求解器领域类型定义。
 *
 * 矩形指派模型：
 * - m 个质检员（行），t 个任务（列）；
 * - cost[i][j] 为有限数表示允许组合；null/undefined 或 NaN 表示资质不符的禁止组合；
 * - idleCost[i] 为第 i 个人闲置（不出工）的代价，默认 0；
 * - delayCost[j] 为第 j 个任务无人承接（顺延）的延误代价，默认 0；
 * - 每个人最多一个任务、每个任务最多一个人，允许人与任务空着。
 */

/** 代价矩阵单元格：有限数 = 允许；null = 禁止组合。 */
export type CostCell = number | null;

export interface AssignmentInput {
  /** 质检员 id（顺序即矩阵行序）。 */
  workers: string[];
  /** 任务 id（顺序即矩阵列序）。 */
  tasks: string[];
  /** m×t 代价矩阵；元素为有限数或 null（禁止）。 */
  costs: CostCell[][];
  /** 每个任务顺延的延误代价，长度 t；缺省全 0。 */
  delayCosts?: number[];
  /** 每个人闲置代价，长度 m；缺省全 0。 */
  idleCosts?: number[];
}

export interface MatchEntry {
  workerId: string;
  /** null 表示该质检员当天闲置。 */
  taskId: string | null;
  /** 该边代价：出工为组合代价，闲置为闲置代价。 */
  cost: number;
}

/**
 * 对偶最优性证书（固定覆盖数 k 的矩形松弛指派外部对偶）。
 *
 * 原始问题（k = 真人-真任务配对数，由“尽可能派满”规则确定）：
 *   min  Σc_ij x_ij + Σa_i s_i + Σd_j y_j
 *   s.t. Σ_j x_ij + s_i = 1，Σ_i x_ij + y_j = 1，Σ x_ij = k，变量非负
 * 对偶变量 p_i（行等式乘子）、q_j（列等式乘子）、λ（配对数等式乘子）：
 *   可行：p_i + q_j + λ ≤ c_ij（所有允许组合）；p_i ≤ a_i；q_j ≤ d_j
 *   紧约束（互补松弛）：选中边 p_i + q_j + λ = c_ij；闲置者 p_i = a_i；顺延任务 q_j = d_j
 *   强对偶：Σ_i p_i + Σ_j q_j + k·λ = 总代价
 * (p_i, q_j, λ) 存在整体平移规范自由度，校验只依赖上述不等式与等式，与规范选择无关。
 */
export interface Certificate {
  /** 行对偶值 p_i，长度 m。 */
  workerPotentials: number[];
  /** 列对偶值 q_j，长度 t。 */
  taskPotentials: number[];
  /** 配对数等式乘子 λ。 */
  coveragePotential: number;
  /** 证书对应的真人-真任务配对数 k。 */
  coverage: number;
}

export interface AssignmentResult {
  version: number;
  matches: MatchEntry[];
  /** 当天无人可派的质检员 id（其所有组合都被禁止——只能闲置，如实报告）。 */
  unassignableWorkers: string[];
  /** 当天不可能有人承接的任务 id（其所有组合都被禁止——必然顺延，如实报告）。 */
  impossibleTasks: string[];
  /** 被顺延的任务 id。 */
  delayedTasks: string[];
  /** 闲置质检员 id。 */
  idleWorkers: string[];
  /** 方案总代价（出工代价 + 闲置代价 + 顺延代价）。 */
  totalCost: number;
  /** 最优总代价（本求解器保证 totalCost === optimalCost）。 */
  optimalCost: number;
  /** 相比参考方案（通常是上一版）被改派的质检员 id。 */
  reassignedWorkers: string[];
  /** 相比参考方案，保留原任务（人在、任务也在且配对不变）的配对数。 */
  retainedPairs: number;
  certificate: Certificate;
  /** 求解方式：scratch=从零；incremental=基于上一版增量修复。 */
  solveMode: 'scratch' | 'incremental';
}
