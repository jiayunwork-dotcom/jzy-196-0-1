/**
 * 矩形指派 → 补零方阵 → 最小费用完美匹配（自实现最小费用流，无优化库）。
 *
 * 方阵规模 n = m + t：
 *   行 0..m-1 为真人，m..n-1 为虚拟行（承接“顺延任务”）；
 *   列 0..t-1 为真任务，t..n-1 为虚拟列（承接“闲置人员”）。
 * 网络 S → 行 → 列 → T，每个 S→T 单位流恰好经过一条“行→列”边：
 *   真人→真任务（仅允许组合）主费用 c_ij − M；真人→虚拟列 主费用 a_i；
 *   虚拟行→真任务 主费用 d_j；虚拟行→虚拟列 主费用 0（填充）。
 * “恰好一条行→列边”的结构使残量增广路天然是合法的指派交错轮换，
 * 不可能产生“同一任务既顺延又被真人承接”之类的非法流。最大流恒为 n；
 * 禁止组合不连边；全禁止者/任务只能落到虚拟边，被如实报告。
 *
 * 边权为字典序三元组 (primary, retain, key)：
 *   primary 最小 → ①真人配对数最大（M 大于全部业务费用绝对值之和）
 *                 ②最大配对数下业务总代价最小；
 *   retain 最小  → ③在①②相同的方案里继承上一版配对最多（改派人数最少）；
 *   key 最小     → ④在①②③相同的方案间唯一规范序（每条边一个唯一 2 的幂，
 *                 任意两组不同边的 key 和都不相等 ⇒ 同输入必同输出）。
 */

import { AssignmentInput, AssignmentResult, Certificate, MatchEntry } from './types';
import {
  FlowNetwork,
  TupleWeight,
  cancelNegativeCycles,
  shortestPathAugment,
} from './mcmf';

export interface PreviousAssignment {
  /** workerId -> taskId | null（null=上一版闲置） */
  workerToTask: Map<string, string | null>;
}

export function solveAssignment(input: AssignmentInput, previous?: PreviousAssignment): AssignmentResult {
  const { workers, tasks, costs } = input;
  const m = workers.length;
  const t = tasks.length;
  if (m === 0 && t === 0) return emptyResult();

  const idleCosts = input.idleCosts ?? new Array(m).fill(0);
  const delayCosts = input.delayCosts ?? new Array(t).fill(0);
  const n = m + t;

  // M > 全部业务费用绝对值之和 ⇒ 多一条真人-真任务边的 −M 收益压过一切费用差异。
  let absSum = 0;
  for (let i = 0; i < m; i++) {
    absSum += Math.abs(idleCosts[i]);
    for (let j = 0; j < t; j++) {
      const c = costs[i][j];
      if (c !== null) absSum += Math.abs(c);
    }
  }
  for (let j = 0; j < t; j++) absSum += Math.abs(delayCosts[j]);
  const M = absSum + 1;

  let keyBit = 0;
  const nextKey = (): bigint => 1n << BigInt(keyBit++);

  const S = 0;
  const rowNode = (r: number) => 1 + r;
  const colNode = (c: number) => 1 + n + c;
  const T = 2 * n + 1;
  const V = 2 * n + 2;

  const net = new FlowNetwork(V);
  const sourceEdge: number[] = [];
  const sinkEdge: number[] = [];
  for (let r = 0; r < n; r++)
    sourceEdge.push(net.addEdge(S, rowNode(r), 1, { primary: 0, retain: 0, key: nextKey() }));
  for (let c = 0; c < n; c++)
    sinkEdge.push(net.addEdge(colNode(c), T, 1, { primary: 0, retain: 0, key: nextKey() }));

  const realEdge: (number | null)[][] = Array.from({ length: m }, () =>
    new Array<number | null>(t).fill(null),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < t; j++) {
      const c = costs[i][j];
      if (c === null) continue;
      const retained = previous?.workerToTask.get(workers[i]) === tasks[j];
      realEdge[i][j] = net.addEdge(rowNode(i), colNode(j), 1, {
        primary: c - M,
        retain: retained ? -1 : 0,
        key: nextKey(),
      });
    }
  }
  // 真人 → 虚拟列（闲置）。
  for (let i = 0; i < m; i++) {
    const wasIdle = previous?.workerToTask.get(workers[i]) === null;
    for (let c = t; c < n; c++) {
      net.addEdge(rowNode(i), colNode(c), 1, {
        primary: idleCosts[i],
        retain: wasIdle ? -1 : 0,
        key: nextKey(),
      });
    }
  }
  // 虚拟行 → 真任务（顺延）。
  const matchedPrev = new Set<string>();
  if (previous) for (const v of previous.workerToTask.values()) if (v !== null) matchedPrev.add(v);
  for (let r = m; r < n; r++) {
    for (let j = 0; j < t; j++) {
      const wasDelayed = previous ? !matchedPrev.has(tasks[j]) : false;
      net.addEdge(rowNode(r), colNode(j), 1, {
        primary: delayCosts[j],
        retain: wasDelayed ? -1 : 0,
        key: nextKey(),
      });
    }
  }
  // 虚拟行 → 虚拟列（填充，零权）。
  for (let r = m; r < n; r++) {
    for (let c = t; c < n; c++) {
      net.addEdge(rowNode(r), colNode(c), 1, { primary: 0, retain: 0, key: nextKey() });
    }
  }

  let mode: 'scratch' | 'incremental' = 'scratch';
  if (previous) {
    mode = seedPreviousFlow(net, {
      m,
      t,
      n,
      workers,
      tasks,
      rowNode,
      colNode,
      sourceEdge,
      sinkEdge,
      realEdge,
      previous,
    });
  }

  if (mode === 'incremental') {
    // 种入的部分整数流未必是该流值最优：先消去残量字典序负环，再逐单位最短路增广。
    cancelNegativeCycles(net);
    let guard = 0;
    while (flowValue(net, S) < n) {
      if (!shortestPathAugment(net, S, T)) {
        throw new Error('infeasible padded assignment (should never happen)');
      }
      if (++guard > n + 1) throw new Error('augmentation exceeded flow bound');
    }
  } else {
    for (let k = 0; k < n; k++) {
      if (!shortestPathAugment(net, S, T)) {
        throw new Error('infeasible padded assignment (should never happen)');
      }
    }
  }

  return extractResult(net, {
    workers,
    tasks,
    m,
    t,
    costs,
    idleCosts,
    delayCosts,
    rowNode,
    colNode,
    previous,
    solveMode: mode,
  });
}

function flowValue(net: FlowNetwork, S: number): number {
  let f = 0;
  for (const id of net.adj[S]) f += net.edges[id].flow;
  return f;
}

interface SeedLayout {
  m: number;
  t: number;
  n: number;
  workers: string[];
  tasks: string[];
  rowNode: (r: number) => number;
  colNode: (c: number) => number;
  sourceEdge: number[];
  sinkEdge: number[];
  realEdge: (number | null)[][];
  previous: PreviousAssignment;
}

/** 把上一版仍成立的配对以 1 单位流量种入；未占用的虚拟行/列留给 SSP 填充。 */
function seedPreviousFlow(net: FlowNetwork, L: SeedLayout): 'scratch' | 'incremental' {
  const usedRows = new Set<number>();
  const usedCols = new Set<number>();
  let seeded = 0;

  const seed = (edgeId: number, r: number, c: number) => {
    net.edges[edgeId].flow = 1;
    net.edges[L.sourceEdge[r]].flow = 1;
    net.edges[L.sinkEdge[c]].flow = 1;
    usedRows.add(r);
    usedCols.add(c);
    seeded++;
  };

  // 真人 ↔ 真任务，且新问题仍允许。
  for (let i = 0; i < L.m; i++) {
    const prevTask = L.previous.workerToTask.get(L.workers[i]);
    if (prevTask === undefined || prevTask === null) continue;
    const j = L.tasks.indexOf(prevTask);
    if (j < 0) continue;
    const edgeId = L.realEdge[i][j];
    if (edgeId === null) continue;
    seed(edgeId, i, j);
  }

  // 上一版闲置的真人 → 任一空闲虚拟列。
  for (let i = 0; i < L.m; i++) {
    if (L.previous.workerToTask.get(L.workers[i]) !== null) continue;
    for (let c = L.t; c < L.n; c++) {
      if (usedCols.has(c)) continue;
      const edgeId = findEdgeId(net, L.rowNode(i), L.colNode(c));
      if (edgeId >= 0) seed(edgeId, i, c);
      break;
    }
  }

  // 上一版顺延的真任务 → 任一空闲虚拟行。
  const matchedIds = new Set<string>();
  for (const v of L.previous.workerToTask.values()) if (v !== null) matchedIds.add(v);
  for (let j = 0; j < L.t; j++) {
    if (matchedIds.has(L.tasks[j])) continue;
    for (let r = L.m; r < L.n; r++) {
      if (usedRows.has(r)) continue;
      const edgeId = findEdgeId(net, L.rowNode(r), L.colNode(j));
      if (edgeId >= 0) seed(edgeId, r, j);
      break;
    }
  }

  return seeded > 0 ? 'incremental' : 'scratch';
}

function findEdgeId(net: FlowNetwork, from: number, to: number): number {
  for (const id of net.adj[from]) {
    const e = net.edges[id];
    if (e.to === to && e.cap - e.flow > 0) return id;
  }
  return -1;
}

function extractResult(
  net: FlowNetwork,
  L: {
    workers: string[];
    tasks: string[];
    m: number;
    t: number;
    costs: (number | null)[][];
    idleCosts: number[];
    delayCosts: number[];
    rowNode: (r: number) => number;
    colNode: (c: number) => number;
    previous?: PreviousAssignment;
    solveMode: 'scratch' | 'incremental';
  },
): AssignmentResult {
  const { m, t } = L;
  const realColStart = L.colNode(0);
  const workerTask = new Array<number | null>(m).fill(null);

  for (let i = 0; i < m; i++) {
    for (const id of net.adj[L.rowNode(i)]) {
      const e = net.edges[id];
      if (e.flow === 1 && e.to >= realColStart && e.to < realColStart + t) {
        workerTask[i] = e.to - realColStart;
      }
    }
  }

  const matches: MatchEntry[] = [];
  const idleWorkers: string[] = [];
  const delayedTasks: string[] = [];
  let totalCost = 0;
  let retainedPairs = 0;

  for (let i = 0; i < m; i++) {
    const j = workerTask[i];
    if (j === null) {
      idleWorkers.push(L.workers[i]);
      totalCost += L.idleCosts[i];
      matches.push({ workerId: L.workers[i], taskId: null, cost: L.idleCosts[i] });
    } else {
      const c = L.costs[i][j]!;
      totalCost += c;
      matches.push({ workerId: L.workers[i], taskId: L.tasks[j], cost: c });
      if (L.previous?.workerToTask.get(L.workers[i]) === L.tasks[j]) retainedPairs++;
    }
  }

  const matchedTaskSet = new Set(workerTask.filter((j): j is number => j !== null));
  for (let j = 0; j < t; j++) {
    if (!matchedTaskSet.has(j)) {
      delayedTasks.push(L.tasks[j]);
      totalCost += L.delayCosts[j];
    }
  }

  const unassignableWorkers: string[] = [];
  for (let i = 0; i < m; i++) {
    let anyAllowed = false;
    for (let j = 0; j < t; j++) if (L.costs[i][j] !== null) anyAllowed = true;
    if (!anyAllowed) unassignableWorkers.push(L.workers[i]);
  }
  const impossibleTasks: string[] = [];
  for (let j = 0; j < t; j++) {
    let anyAllowed = false;
    for (let i = 0; i < m; i++) if (L.costs[i][j] !== null) anyAllowed = true;
    if (!anyAllowed) impossibleTasks.push(L.tasks[j]);
  }

  const reassignedWorkers: string[] = [];
  if (L.previous) {
    for (let i = 0; i < m; i++) {
      if (!L.previous.workerToTask.has(L.workers[i])) continue;
      const old = L.previous.workerToTask.get(L.workers[i])!;
      const now = workerTask[i] === null ? null : L.tasks[workerTask[i]!];
      if (old !== now) reassignedWorkers.push(L.workers[i]);
    }
  }

  const coverage = workerTask.filter((j) => j !== null).length;
  const certificate = buildCertificate({
    m,
    t,
    costs: L.costs,
    idleCosts: L.idleCosts,
    delayCosts: L.delayCosts,
    workerTask,
  });

  return {
    version: 0,
    matches,
    unassignableWorkers,
    impossibleTasks,
    delayedTasks,
    idleWorkers,
    totalCost,
    optimalCost: totalCost,
    reassignedWorkers,
    retainedPairs,
    certificate: { ...certificate, coverage },
    solveMode: L.solveMode,
  };
}

/**
 * 由补零方阵的最优完美匹配 μ 构造对偶势（等号分量 + 分量间 Bellman-Ford）。
 *
 * 步骤：
 *  1. 匹配边必须取等 u_r + v_c = W_rc。匹配边（行↔列）把节点分成若干连通分量，
 *     每个分量任取一行锚定 u=0 后，分量内所有 u、v 由匹配等式交替唯一确定。
 *  2. 此时非匹配边给出跨分量的可行性约束 u_r + v_c ≤ W_rc。把每个分量的平移量
 *     t_k（分量内行 +t、列 −t）作为变量，该约束化为 t_b − t_a ≤ slack 的标准
 *     差分约束，用 Bellman-Ford 求最大可行 t（最优匹配保证系统无负环）。
 *  3. 应用平移即得全部边可行且匹配边取等的 (u,v)；外部 p_i=u_i、q_j=v_j、λ=M。
 *     匹配到虚拟列的真人 u_i=a_i（闲置取等），匹配到虚拟行的真任务 v_j=d_j。
 */
export function buildCertificate(arg: {
  m: number;
  t: number;
  costs: (number | null)[][];
  idleCosts: number[];
  delayCosts: number[];
  workerTask: (number | null)[];
}): Omit<Certificate, 'coverage'> {
  const { m, t, costs, idleCosts, delayCosts, workerTask } = arg;
  const n = m + t;

  let absSum = 0;
  for (let i = 0; i < m; i++) {
    absSum += Math.abs(idleCosts[i]);
    for (let j = 0; j < t; j++) {
      const c0 = costs[i][j];
      if (c0 !== null) absSum += Math.abs(c0);
    }
  }
  for (let j = 0; j < t; absSum += Math.abs(delayCosts[j]), j++);
  const M = absSum + 1;

  const W: (number | null)[][] = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < m; i++) for (let j = 0; j < t; j++) {
    const c0 = costs[i][j];
    if (c0 !== null) W[i][j] = c0 - M;
  }
  for (let i = 0; i < m; i++) for (let c = t; c < n; c++) W[i][c] = idleCosts[i];
  for (let r = m; r < n; r++) for (let j = 0; j < t; j++) W[r][j] = delayCosts[j];
  for (let r = m; r < n; r++) for (let c = t; c < n; c++) W[r][c] = 0;

  const matchR = new Array<number>(n).fill(-1);
  const usedCol = new Set<number>();
  const idleWorkers: number[] = [];
  for (let i = 0; i < m; i++) {
    if (workerTask[i] !== null) { matchR[i] = workerTask[i] as number; usedCol.add(workerTask[i] as number); }
    else idleWorkers.push(i);
  }
  let dr = m;
  for (let j = 0; j < t; j++) if (!usedCol.has(j)) { matchR[dr++] = j; usedCol.add(j); }
  let dc = t;
  const nextFreeCol = () => { while (usedCol.has(dc)) dc++; const c = dc; usedCol.add(c); return c; };
  for (const i of idleWorkers) matchR[i] = nextFreeCol();
  for (let r = m; r < n; r++) if (matchR[r] === -1) matchR[r] = nextFreeCol();
  const matchC = new Array<number>(n).fill(-1);
  for (let r = 0; r < n; r++) matchC[matchR[r]] = r;

  // 1) 等号连通分量（并查集：行 r 与列 n+c 经匹配边相连）。
  const parent = Array.from({ length: 2 * n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let r = 0; r < n; r++) {
    const a = r;
    const b = n + matchR[r];
    parent[find(a)] = find(b);
  }
  const compOfNode = new Array<number>(2 * n).fill(-1);
  let K = 0;
  const compIndex = new Map<number, number>();
  for (let x = 0; x < 2 * n; x++) {
    const root = find(x);
    if (!compIndex.has(root)) compIndex.set(root, K++);
    compOfNode[x] = compIndex.get(root)!;
  }

  // 分量内沿匹配等式交替推出 u、v：每分量锚定其最小编号行 u=0。
  const u = new Array<number>(n).fill(0);
  const v = new Array<number>(n).fill(0);
  const doneComp = new Set<number>();
  for (let start = 0; start < n; start++) {
    const k = compOfNode[start];
    if (doneComp.has(k)) continue;
    doneComp.add(k);
    u[start] = 0;
    const queue = [start];
    const seenRow = new Set<number>([start]);
    while (queue.length) {
      const r = queue.shift()!;
      const c = matchR[r];
      v[c] = W[r][c]! - u[r];
      const r2 = matchC[c];
      if (r2 >= 0 && !seenRow.has(r2)) { seenRow.add(r2); u[r2] = W[r2][c]! - v[c]; queue.push(r2); }
    }
  }

  // 2) 跨分量平移：分量 k 内行 +t_k、列 −t_k。
  //    边 (r∈a)→(c∈b) 可行：u_r+t_a + v_c−t_b ≤ W ⟺ t_b ≥ t_a + (u_r+v_c−W)。
  //    写成 dist[t_b] ≥ dist[t_a] + w（求最大可行），边 a→b 权 slack=u_r+v_c−W。
  interface D { a: number; b: number; w: number }
  const dedge: D[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const w = W[r][c];
      if (w === null) continue;
      const a = compOfNode[r];
      const b = compOfNode[n + c];
      if (a === b) continue;
      dedge.push({ a, b, w: u[r] + v[c] - w });
    }
  }
  // 求最大可行 t：t_b ≥ t_a + w ⟺ 用最长路松弛；初始 0，BF 正向迭代。
  const shift = new Array<number>(K).fill(0);
  for (let pass = 0; pass < K; pass++) {
    let changed = false;
    for (const e of dedge) {
      const nd = shift[e.a] + e.w;
      if (nd > shift[e.b] + 1e-12) { shift[e.b] = nd; changed = true; }
    }
    if (!changed) break;
  }

  // 3) 应用平移。
  const uFinal = new Array<number>(n);
  const vFinal = new Array<number>(n);
  for (let r = 0; r < n; r++) uFinal[r] = u[r] + shift[compOfNode[r]];
  for (let c = 0; c < n; c++) vFinal[c] = v[c] - shift[compOfNode[n + c]];

  // 规范平移（p_i = u_i − δ，q_j = v_j + δ，λ 不变）：
  //   闲置边界 p_i ≤ a_i ⟺ δ ≥ u_i − a_i；
  //   延误边界 q_j ≤ d_j ⟺ δ ≤ d_j − v_j；
  //   顺延任务取等 q_j = d_j 把 δ 钉为 d_j − v_j；
  //   闲置者取等 p_i = a_i 把 δ 钉为 u_i − a_i。
  // 取所有“取等”条件给出的 δ（最优匹配保证它们一致），否则取闲置边界最紧下界。
  let delta: number | null = null;
  for (let i = 0; i < m; i++) {
    if (workerTask[i] === null) delta = delta === null ? uFinal[i] - idleCosts[i] : delta;
  }
  for (let j = 0; j < t; j++) {
    let matched = false;
    for (let i = 0; i < m; i++) if (workerTask[i] === j) matched = true;
    if (!matched) {
      const d2 = delayCosts[j] - vFinal[j];
      delta = delta === null ? d2 : delta;
    }
  }
  if (delta === null) {
    delta = 0;
    for (let i = 0; i < m; i++) delta = Math.max(delta, uFinal[i] - idleCosts[i]);
  }
  const p = uFinal.slice(0, m).map((x) => x - delta);
  const q = vFinal.slice(0, t).map((x) => x + delta);
  return { workerPotentials: p, taskPotentials: q, coveragePotential: M };
}

function emptyResult(): AssignmentResult {
  return {
    version: 0,
    matches: [],
    unassignableWorkers: [],
    impossibleTasks: [],
    delayedTasks: [],
    idleWorkers: [],
    totalCost: 0,
    optimalCost: 0,
    reassignedWorkers: [],
    retainedPairs: 0,
    certificate: { workerPotentials: [], taskPotentials: [], coveragePotential: 0, coverage: 0 },
    solveMode: 'scratch',
  };
}
