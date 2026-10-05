/**
 * Generic O(n^3) Hungarian algorithm for square minimization problems.
 *
 * This is a second, independent implementation used to cross-validate the
 * dispatch solver (the dispatch solver works directly on the rectangular
 * problem with delay slots) and to exercise the classical invariants
 * (row/column shift invariance, transpose consistency) on the compiled
 * square form.
 *
 * Deterministic: rows are processed in order and all min-scans use strict
 * comparison, so ties resolve to the lowest index.
 */

export interface SquareSolution {
  /** matchRow[i] = column assigned to row i. */
  matchRow: number[];
  /** matchCol[j] = row assigned to column j. */
  matchCol: number[];
  /** Dual potentials with rowDual[i] + colDual[j] <= a[i][j], tight on matches. */
  rowDual: number[];
  colDual: number[];
  totalCost: number;
}

export function hungarianSquare(a: number[][]): SquareSolution {
  const n = a.length;
  // 1-based arrays following the classical primal-dual formulation.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0); // p[j] = row matched to column j
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // augment
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const matchRow = new Array<number>(n).fill(-1);
  const matchCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) {
      matchRow[p[j] - 1] = j - 1;
      matchCol[j - 1] = p[j] - 1;
    }
  }
  let totalCost = 0;
  for (let i = 0; i < n; i++) totalCost += a[i][matchRow[i]];
  return {
    matchRow,
    matchCol,
    rowDual: u.slice(1).map((x) => x),
    colDual: v.slice(1).map((x) => x),
    totalCost,
  };
}
