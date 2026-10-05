/**
 * 通用最小费用流引擎（自实现，不依赖任何优化库）。
 *
 * 边权为字典序三元组 (primary, retain, key)：
 *  1. primary —— 标量主费用。指派网络中真人-真任务边取 c_ij − M（M 为足够大的
 *     “覆盖奖励”，使最大化真人-真任务配对数在字典序上优先于费用最小化），
 *     其余边取自身费用（闲置 a_i / 延误 d_j / 虚拟-虚拟 0）；
 *  2. retain  —— 保留分（整数）。继承自上一版的配对边取 −1，其它边取 0，
 *     从而在“主费用相同”的方案里保留配对最多（= 改派人数最少）；
 *  3. key    —— BigInt 序键。每条真人-真任务边对应一个唯一的 2 的幂，
 *     任意两组不同边的序键和都不相等，因此“主费用与保留分都相同”的方案间
 *     仍有唯一规范先后 → 同输入必定同输出（确定性）。
 *
 * 残量网络中弧 (u→v) 的三元组取反即为反向弧 (v→u) 的权。
 */

export interface TupleWeight {
  primary: number;
  retain: number;
  key: bigint;
}

interface Edge {
  from: number;
  to: number;
  cap: number;
  weight: TupleWeight;
  flow: number;
}

export class FlowNetwork {
  readonly n: number;
  /** 邻接表按插入顺序存放（确定性），元素为 edges 下标。 */
  readonly adj: number[][] = [];
  readonly edges: Edge[] = [];

  constructor(n: number) {
    this.n = n;
    for (let i = 0; i < n; i++) this.adj.push([]);
  }

  addEdge(from: number, to: number, cap: number, weight: TupleWeight): number {
    const id = this.edges.length;
    this.edges.push({ from, to, cap, weight, flow: 0 });
    this.adj[from].push(id);
    return id;
  }

  /** 残量正向边：cap − flow > 0；残量反向边：flow > 0。 */
  residualEdges(): {
    from: number;
    to: number;
    w: TupleWeight;
    edgeId: number;
    reverse: boolean;
  }[] {
    const out: {
      from: number;
      to: number;
      w: TupleWeight;
      edgeId: number;
      reverse: boolean;
    }[] = [];
    for (let id = 0; id < this.edges.length; id++) {
      const e = this.edges[id];
      if (e.cap - e.flow > 0) {
        out.push({ from: e.from, to: e.to, w: e.weight, edgeId: id, reverse: false });
      }
      if (e.flow > 0) {
        out.push({
          from: e.to,
          to: e.from,
          w: { primary: -e.weight.primary, retain: -e.weight.retain, key: -e.weight.key },
          edgeId: id,
          reverse: true,
        });
      }
    }
    return out;
  }

  push(edgeId: number, reverse: boolean, delta = 1): void {
    this.edges[edgeId].flow += reverse ? -delta : delta;
  }
}

/** 字典序小于：优先 primary，其次 retain，最后 key。 */
export function tupleLess(a: TupleWeight, b: TupleWeight): boolean {
  if (a.primary < b.primary) return true;
  if (a.primary > b.primary) return false;
  if (a.retain < b.retain) return true;
  if (a.retain > b.retain) return false;
  return a.key < b.key;
}

function tupleAdd(a: TupleWeight, b: TupleWeight): TupleWeight {
  return { primary: a.primary + b.primary, retain: a.retain + b.retain, key: a.key + b.key };
}

export const ZERO_W: TupleWeight = { primary: 0, retain: 0, key: 0n };

interface PathArc {
  edgeId: number;
  reverse: boolean;
}

/**
 * SPFA（Bellman-Ford 队列实现）求 source→sink 的字典序最短路并增广 1 单位。
 * 标准初始化：dist[source]=0，其余 +∞。从零流（本网络为 DAG）出发的逐最短路
 * 增广（SSP）定理保证每次增广前残量网络都没有负环，因此源点 SPFA 即可；
 * 增量模式下先调用 cancelNegativeCycles 把种入流恢复到该流值最优，再进入本函数。
 * 弧按固定生成顺序扫描、FIFO 入队 ⇒ 结果确定。
 */
export function shortestPathAugment(net: FlowNetwork, source: number, sink: number): boolean {
  const n = net.n;
  const INF: TupleWeight = { primary: Infinity, retain: Infinity, key: 0n };
  const dist: TupleWeight[] = new Array(n).fill(INF);
  const prevArc: (PathArc | null)[] = new Array(n).fill(null);
  const inQueue = new Array<boolean>(n).fill(false);
  const queue: number[] = [source];
  dist[source] = { ...ZERO_W };
  inQueue[source] = true;

  const arcs = net.residualEdges();
  const fromIndex: number[][] = Array.from({ length: n }, () => []);
  arcs.forEach((a, idx) => fromIndex[a.from].push(idx));

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    inQueue[u] = false;
    for (const idx of fromIndex[u]) {
      const a = arcs[idx];
      const nd = tupleAdd(dist[u], a.w);
      if (tupleLess(nd, dist[a.to])) {
        dist[a.to] = nd;
        prevArc[a.to] = { edgeId: a.edgeId, reverse: a.reverse };
        if (!inQueue[a.to]) {
          queue.push(a.to);
          inQueue[a.to] = true;
        }
      }
    }
  }

  if (dist[sink].primary === Infinity) return false;

  let v = sink;
  while (v !== source) {
    const arc = prevArc[v]!;
    net.push(arc.edgeId, arc.reverse, 1);
    v = arc.reverse ? net.edges[arc.edgeId].to : net.edges[arc.edgeId].from;
  }
  return true;
}

/**
 * 字典序负环检测（SPFA 松弛次数法），找到后沿前驱链还原该环。
 * 存在负环意味着当前流不是字典序最优，可沿环改流改进。
 */
export function findNegativeCycle(net: FlowNetwork): PathArc[] | null {
  const n = net.n;
  const dist: TupleWeight[] = Array.from({ length: n }, () => ({ ...ZERO_W }));
  const prevArc: (PathArc | null)[] = new Array(n).fill(null);
  const inQueue = new Array<boolean>(n).fill(true);
  const count = new Array<number>(n).fill(0);
  const queue: number[] = Array.from({ length: n }, (_, i) => i);

  const arcs = net.residualEdges();
  const fromIndex: number[][] = Array.from({ length: n }, () => []);
  arcs.forEach((a, idx) => fromIndex[a.from].push(idx));

  let head = 0;
  let total = n;
  while (head < total) {
    const u = queue[head++];
    inQueue[u] = false;
    for (const idx of fromIndex[u]) {
      const a = arcs[idx];
      const nd = tupleAdd(dist[u], a.w);
      if (tupleLess(nd, dist[a.to])) {
        dist[a.to] = nd;
        prevArc[a.to] = { edgeId: a.edgeId, reverse: a.reverse };
        count[a.to] = count[u] + 1;
        if (count[a.to] >= n) {
          return extractCycle(prevArc, a.to, n, net);
        }
        if (!inQueue[a.to]) {
          queue.push(a.to);
          total++;
          inQueue[a.to] = true;
        }
      }
    }
  }
  return null;
}

/** 沿前驱链还原负环：先走 n 步落到环上一点，再完整绕一圈。 */
function extractCycle(
  prevArc: (PathArc | null)[],
  start: number,
  n: number,
  net: FlowNetwork,
): PathArc[] {
  let x = start;
  for (let i = 0; i < n; i++) x = arcFrom(prevArc[x]!, net);
  const cycleStart = x;
  const cycle: PathArc[] = [];
  let cur = cycleStart;
  do {
    const arc = prevArc[cur]!;
    cycle.push(arc);
    cur = arcFrom(arc, net);
  } while (cur !== cycleStart);
  return cycle;
}

function arcFrom(arc: PathArc, net: FlowNetwork): number {
  return arc.reverse ? net.edges[arc.edgeId].to : net.edges[arc.edgeId].from;
}

export function augmentAlongCycle(net: FlowNetwork, cycle: PathArc[]): void {
  for (const arc of cycle) net.push(arc.edgeId, arc.reverse, 1);
}

/**
 * 从任意整数流出发反复消去字典序负环直到不存在负环。
 * 用于增量修复：把上一版可行流搬到新图后，结构变化/改价只可能制造负环。
 */
export function cancelNegativeCycles(net: FlowNetwork, maxCycles = 2_000_000): number {
  let cycles = 0;
  for (;;) {
    const cycle = findNegativeCycle(net);
    if (!cycle) break;
    augmentAlongCycle(net, cycle);
    cycles++;
    if (cycles > maxCycles) throw new Error('negative-cycle cancellation did not converge');
  }
  return cycles;
}
