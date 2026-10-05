import { verifyCertificate } from '../src/certificate/verify';
import { compileToSquareMatrix } from '../src/solver/compile';
import { solveDispatch } from '../src/solver/dispatch-solver';
import { hungarianSquare } from '../src/solver/hungarian';
import { DispatchProblem, UNASSIGNED } from '../src/solver/types';
import {
  assignmentKey,
  greedySolve,
  optimalRawCost,
  randomProblem,
  rng,
} from './helpers';

const BIG_DELAY = 1000;

function makeProblem(cost: number[][], delay: number[], forbidden?: Array<[number, number]>): DispatchProblem {
  const W = cost.length;
  const T = cost[0].length;
  const forb = Array.from({ length: W }, () => new Array<boolean>(T).fill(false));
  for (const [i, j] of forbidden ?? []) forb[i][j] = true;
  return { workerCount: W, taskCount: T, cost, delayCost: delay, forbidden: forb };
}

describe('reference example', () => {
  // 行依次为 (4,1,3)、(2,0,5)、(3,2,2)；最优总代价 5：
  // 第一人→第二项(1)、第二人→第一项(2)、第三人→第三项(2)
  const problem = makeProblem(
    [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ],
    [BIG_DELAY, BIG_DELAY, BIG_DELAY],
  );

  it('finds total cost 5 with the expected assignment', () => {
    const sol = solveDispatch(problem);
    expect(sol.totalCost).toBe(5);
    expect(sol.assignment[0]).toBe(1);
    expect(sol.assignment[1]).toBe(0);
    expect(sol.assignment[2]).toBe(2);
    expect(sol.delayed).toEqual([false, false, false]);
  });

  it('produces a valid optimality certificate', () => {
    const sol = solveDispatch(problem);
    const result = verifyCertificate(problem, sol);
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('certificate validity on random instances', () => {
  it('every random instance yields a verifiable certificate', () => {
    const rand = rng(42);
    for (let k = 0; k < 200; k++) {
      const problem = randomProblem(rand, {
        workers: 1 + Math.floor(rand() * 6),
        tasks: 1 + Math.floor(rand() * 6),
        forbiddenProb: rand() * 0.4,
      });
      const sol = solveDispatch(problem);
      const result = verifyCertificate(problem, sol);
      expect(result.violations).toEqual([]);
    }
  });

  it('detects tampered duals and tampered assignments', () => {
    const rand = rng(4242);
    for (let k = 0; k < 40; k++) {
      const problem = randomProblem(rand, {
        workers: 3,
        tasks: 3,
        forbiddenProb: 0.2,
      });
      const sol = solveDispatch(problem);
      // inflate one beta: dual objective no longer matches
      const tamperedBeta = { ...sol, beta: sol.beta.map((b, j) => (j === 0 ? b + 3 : b)) };
      expect(verifyCertificate(problem, tamperedBeta).valid).toBe(false);
      // inflate one alpha for an idle worker (if any) or break feasibility
      const tamperedAlpha = { ...sol, alpha: sol.alpha.map((a) => a + 2) };
      expect(verifyCertificate(problem, tamperedAlpha).valid).toBe(false);
      // wrong total cost
      expect(verifyCertificate(problem, { ...sol, totalCost: sol.totalCost + 1 }).valid).toBe(false);
    }
  });
});

describe('exhaustive optimality on small instances', () => {
  it('matches brute-force optimum', () => {
    const rand = rng(7);
    for (let k = 0; k < 120; k++) {
      const problem = randomProblem(rand, {
        workers: 1 + Math.floor(rand() * 4),
        tasks: 1 + Math.floor(rand() * 4),
        forbiddenProb: rand() * 0.3,
      });
      const sol = solveDispatch(problem);
      expect(sol.totalCost).toBe(optimalRawCost(problem));
    }
  });
});

describe('cross-validation against square Hungarian on the compiled matrix', () => {
  it('same optimal value as an independent implementation', () => {
    const rand = rng(99);
    for (let k = 0; k < 150; k++) {
      const problem = randomProblem(rand, {
        workers: 1 + Math.floor(rand() * 5),
        tasks: 1 + Math.floor(rand() * 5),
        forbiddenProb: rand() * 0.3,
      });
      const direct = solveDispatch(problem);
      const compiled = compileToSquareMatrix(problem);
      const square = hungarianSquare(compiled.matrix);
      expect(direct.totalCost).toBeCloseTo(square.totalCost, 9);
    }
  });
});

describe('row/column shift invariance', () => {
  const rand = rng(1234);

  it('compiled problem: shifting any row keeps an optimal matching optimal, optimum shifts by k', () => {
    for (let k = 0; k < 60; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 3),
        tasks: 2 + Math.floor(rand() * 3),
        forbiddenProb: 0.2,
      });
      const compiled = compileToSquareMatrix(problem);
      const base = hungarianSquare(compiled.matrix);
      const row = Math.floor(rand() * compiled.size);
      const shift = Math.floor(rand() * 37) - 18;
      const shifted = compiled.matrix.map((r, i) => (i === row ? r.map((c) => c + shift) : r.slice()));
      const after = hungarianSquare(shifted);
      expect(after.totalCost).toBeCloseTo(base.totalCost + shift, 9);
      // The matching optimal for the shifted matrix must also be optimal for the original.
      let originalCost = 0;
      for (let i = 0; i < compiled.size; i++) originalCost += compiled.matrix[i][after.matchRow[i]];
      expect(originalCost).toBeCloseTo(base.totalCost, 9);
    }
  });

  it('compiled problem: shifting any column keeps an optimal matching optimal, optimum shifts by k', () => {
    for (let k = 0; k < 60; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 3),
        tasks: 2 + Math.floor(rand() * 3),
        forbiddenProb: 0.2,
      });
      const compiled = compileToSquareMatrix(problem);
      const base = hungarianSquare(compiled.matrix);
      const col = Math.floor(rand() * compiled.size);
      const shift = Math.floor(rand() * 37) - 18;
      const shifted = compiled.matrix.map((r) => r.map((c, j) => (j === col ? c + shift : c)));
      const after = hungarianSquare(shifted);
      expect(after.totalCost).toBeCloseTo(base.totalCost + shift, 9);
      let originalCost = 0;
      for (let i = 0; i < compiled.size; i++) originalCost += compiled.matrix[i][after.matchRow[i]];
      expect(originalCost).toBeCloseTo(base.totalCost, 9);
    }
  });

  it('dispatch level: shifting a task column together with its delay cost keeps the plan optimal', () => {
    for (let k = 0; k < 60; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 3),
        tasks: 2 + Math.floor(rand() * 3),
        forbiddenProb: 0.2,
      });
      const base = solveDispatch(problem);
      const col = Math.floor(rand() * problem.taskCount);
      const shift = Math.floor(rand() * 21) - 10;
      const shifted: DispatchProblem = {
        ...problem,
        cost: problem.cost.map((r) => r.map((c, j) => (j === col ? c + shift : c))),
        delayCost: problem.delayCost.map((d, j) => (j === col ? d + shift : d)),
      };
      const after = solveDispatch(shifted);
      expect(after.totalCost).toBeCloseTo(base.totalCost + shift, 9);
      // The plan optimal after the shift must also be optimal before it.
      let rawBefore = 0;
      after.assignment.forEach((j, i) => {
        if (j !== UNASSIGNED) rawBefore += problem.cost[i][j];
      });
      after.delayed.forEach((d, j) => {
        if (d) rawBefore += problem.delayCost[j];
      });
      expect(rawBefore).toBeCloseTo(base.totalCost, 9);
    }
  });
});

describe('transpose consistency', () => {
  it('compiled matrix and its transpose have the same optimal value', () => {
    const rand = rng(555);
    for (let k = 0; k < 80; k++) {
      const problem = randomProblem(rand, {
        workers: 1 + Math.floor(rand() * 5),
        tasks: 1 + Math.floor(rand() * 5),
        forbiddenProb: rand() * 0.3,
      });
      const compiled = compileToSquareMatrix(problem);
      const transposed = compiled.matrix[0].map((_, j) => compiled.matrix.map((row) => row[j]));
      const a = hungarianSquare(compiled.matrix);
      const b = hungarianSquare(transposed);
      expect(a.totalCost).toBeCloseTo(b.totalCost, 9);
    }
  });
});

describe('never worse than greedy', () => {
  it('optimal <= greedy on random instances', () => {
    const rand = rng(2024);
    for (let k = 0; k < 150; k++) {
      const problem = randomProblem(rand, {
        workers: 1 + Math.floor(rand() * 6),
        tasks: 1 + Math.floor(rand() * 6),
        forbiddenProb: rand() * 0.3,
      });
      const sol = solveDispatch(problem);
      expect(sol.totalCost).toBeLessThanOrEqual(greedySolve(problem) + 1e-9);
    }
  });
});

describe('forbidden pairs', () => {
  it('never assigns a forbidden pair', () => {
    const rand = rng(31337);
    for (let k = 0; k < 150; k++) {
      const problem = randomProblem(rand, {
        workers: 2 + Math.floor(rand() * 5),
        tasks: 2 + Math.floor(rand() * 5),
        forbiddenProb: 0.4,
      });
      const sol = solveDispatch(problem);
      sol.assignment.forEach((j, i) => {
        if (j !== UNASSIGNED) expect(problem.forbidden[i][j]).toBe(false);
      });
    }
  });

  it('reports workers and tasks whose pairs are all forbidden', () => {
    const problem = makeProblem(
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      [50, 50],
      [
        [2, 0],
        [2, 1],
        [0, 1],
        [1, 1],
      ],
    );
    const sol = solveDispatch(problem);
    expect(sol.unassignableWorkers).toEqual([2]);
    expect(sol.unassignableTasks).toEqual([1]);
    expect(sol.assignment[2]).toBe(UNASSIGNED);
    expect(sol.delayed[1]).toBe(true);
    // task 0 assigned to the cheaper of workers 0/1
    expect(sol.totalCost).toBe(1 + 50);
    const result = verifyCertificate(problem, sol);
    expect(result.valid).toBe(true);
  });

  it('delays everything when all pairs are forbidden', () => {
    const problem = makeProblem(
      [
        [1, 2],
        [3, 4],
      ],
      [7, 8],
      [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ],
    );
    const sol = solveDispatch(problem);
    expect(sol.totalCost).toBe(15);
    expect(sol.delayed).toEqual([true, true]);
    expect(sol.assignment).toEqual([UNASSIGNED, UNASSIGNED]);
    expect(verifyCertificate(problem, sol).valid).toBe(true);
  });
});

describe('determinism with tied optima', () => {
  it('same input always yields the same assignment', () => {
    // Many ties: identical rows/columns.
    const problem = makeProblem(
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
      [5, 5, 5],
    );
    const first = assignmentKey(solveDispatch(problem));
    for (let k = 0; k < 20; k++) {
      expect(assignmentKey(solveDispatch(problem))).toBe(first);
    }
  });

  it('deterministic across random tied instances', () => {
    const rand = rng(808);
    for (let k = 0; k < 60; k++) {
      const problem = randomProblem(rand, {
        workers: 3,
        tasks: 3,
        maxCost: 3, // heavy ties
        maxDelay: 4,
        forbiddenProb: 0.2,
      });
      const a = solveDispatch(problem);
      const b = solveDispatch(problem);
      expect(assignmentKey(a)).toBe(assignmentKey(b));
      expect(a.alpha).toEqual(b.alpha);
      expect(a.beta).toEqual(b.beta);
    }
  });
});

describe('edge cases', () => {
  it('no workers: every task delayed', () => {
    const problem: DispatchProblem = {
      workerCount: 0,
      taskCount: 2,
      cost: [],
      delayCost: [3, 4],
      forbidden: [],
    };
    const sol = solveDispatch(problem);
    expect(sol.totalCost).toBe(7);
    expect(sol.delayed).toEqual([true, true]);
    expect(verifyCertificate(problem, sol).valid).toBe(true);
  });

  it('no tasks: everyone idle, zero cost', () => {
    const problem = makeProblem([[], []], []);
    const sol = solveDispatch(problem);
    expect(sol.totalCost).toBe(0);
    expect(sol.assignment).toEqual([UNASSIGNED, UNASSIGNED]);
    expect(verifyCertificate(problem, sol).valid).toBe(true);
  });

  it('more workers than tasks and vice versa', () => {
    const rand = rng(64);
    for (let k = 0; k < 60; k++) {
      const problem = randomProblem(rand, {
        workers: k % 2 === 0 ? 6 : 2,
        tasks: k % 2 === 0 ? 2 : 6,
        forbiddenProb: 0.2,
      });
      const sol = solveDispatch(problem);
      expect(sol.totalCost).toBe(optimalRawCost(problem));
      expect(verifyCertificate(problem, sol).valid).toBe(true);
    }
  });

  it('negative costs are supported', () => {
    const problem = makeProblem(
      [
        [-5, 1],
        [2, -3],
      ],
      [10, 10],
    );
    const sol = solveDispatch(problem);
    expect(sol.totalCost).toBe(-8);
    expect(verifyCertificate(problem, sol).valid).toBe(true);
  });
});
