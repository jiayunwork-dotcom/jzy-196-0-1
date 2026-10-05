import { DayRepository, VersionRepository } from '../src/persistence/repositories';
import {
  CreateDayInput,
  DispatchService,
  toProblem,
} from '../src/dispatch/dispatch.service';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  StaleVersionError,
} from '../src/dispatch/errors';
import { Change } from '../src/dispatch/change';
import { solveDispatch } from '../src/solver/dispatch-solver';
import { freshDb, stopSharedMongo } from './mongo.helper';
import { Db } from 'mongodb';

function makeService(db: Db): DispatchService {
  return new DispatchService(new DayRepository(db), new VersionRepository(db));
}

function dayInput(date: string): CreateDayInput {
  return {
    date,
    workers: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
    tasks: [
      { id: 't1', delayCost: 50 },
      { id: 't2', delayCost: 50 },
      { id: 't3', delayCost: 50 },
    ],
    costMatrix: [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ],
    reassignmentPenalty: 10,
  };
}

describe('DispatchService (integration, in-memory MongoDB)', () => {
  let db: Db;
  let service: DispatchService;

  beforeAll(async () => {
    ({ db } = await freshDb());
    service = makeService(db);
  });

  afterAll(async () => {
    await stopSharedMongo();
  });

  it('creates a day and solves version 1 (reference example, cost 5)', async () => {
    const v1 = await service.createDay(dayInput('2026-10-05'));
    expect(v1.version).toBe(1);
    expect(v1.costs.raw).toBe(5);
    const pairs = Object.fromEntries(v1.plan.assignments.map((a) => [a.workerId, a.taskId]));
    expect(pairs).toEqual({ w1: 't2', w2: 't1', w3: 't3' });
    expect(v1.plan.delayedTaskIds).toEqual([]);

    const verify = await service.verify('2026-10-05', 1);
    expect(verify.valid).toBe(true);
  });

  it('rejects duplicate day creation', async () => {
    await expect(service.createDay(dayInput('2026-10-05'))).rejects.toBeInstanceOf(ConflictError);
  });

  it('validates initial data with precise field errors', async () => {
    const fieldsOf = (e: unknown) => (e as DomainValidationError).errors.map((x) => x.field);
    // non-finite cost
    await service
      .createDay({ ...dayInput('2026-10-06'), costMatrix: [[1, Number.NaN, 3], [1, 2, 3], [1, 2, 3]] })
      .then(() => fail('should reject'), (e) => expect(fieldsOf(e)).toContain('costMatrix[0][1]'));
    // dimension mismatch: wrong row count
    await service
      .createDay({ ...dayInput('2026-10-06'), costMatrix: [[1, 2, 3]] })
      .then(() => fail('should reject'), (e) => expect(fieldsOf(e)).toContain('costMatrix'));
    // dimension mismatch: wrong column count
    await service
      .createDay({ ...dayInput('2026-10-06'), costMatrix: [[1, 2], [1, 2], [1, 2]] })
      .then(() => fail('should reject'), (e) => expect(fieldsOf(e)).toContain('costMatrix[0]'));
    // non-finite delay cost
    const badDelay = dayInput('2026-10-06');
    badDelay.tasks = [{ id: 't1', delayCost: Number.POSITIVE_INFINITY }, { id: 't2', delayCost: 1 }, { id: 't3', delayCost: 1 }];
    await service
      .createDay(badDelay)
      .then(() => fail('should reject'), (e) => expect(fieldsOf(e)).toContain('tasks[0].delayCost'));
    // unknown forbidden reference
    await service
      .createDay({ ...dayInput('2026-10-06'), forbidden: [{ workerId: 'ghost', taskId: 't1' }] })
      .then(() => fail('should reject'), (e) => expect(fieldsOf(e)).toContain('forbidden[0].workerId'));
  });

  describe('changes and versioning', () => {
    const DATE = '2026-10-07';

    it('applies a sequence of changes, one version each, certificates valid', async () => {
      await service.createDay(dayInput(DATE));

      // 1) cost override: make w3->t3 expensive; plan should adapt
      const v2 = await service.submitChange(DATE, {
        baseVersion: 1,
        change: { type: 'cost_override', workerId: 'w3', taskId: 't3', cost: 40 },
      });
      expect(v2.version).toBe(2);
      expect((await service.verify(DATE, 2)).valid).toBe(true);

      // 2) worker unavailable
      const v3 = await service.submitChange(DATE, {
        baseVersion: 2,
        change: { type: 'worker_unavailable', workerId: 'w2' },
      });
      expect(v3.version).toBe(3);
      expect(v3.plan.assignments.some((a) => a.workerId === 'w2')).toBe(false);
      expect((await service.verify(DATE, 3)).valid).toBe(true);

      // 3) urgent task added
      const v4 = await service.submitChange(DATE, {
        baseVersion: 3,
        change: {
          type: 'task_added',
          task: { id: 't4', delayCost: 30 },
          costs: [
            { workerId: 'w1', cost: 3 },
            { workerId: 'w3', cost: 4 },
          ],
        },
      });
      expect(v4.version).toBe(4);
      expect((await service.verify(DATE, 4)).valid).toBe(true);

      // 4) task cancelled
      const v5 = await service.submitChange(DATE, {
        baseVersion: 4,
        change: { type: 'task_cancelled', taskId: 't1' },
      });
      expect(v5.version).toBe(5);
      expect(v5.plan.assignments.some((a) => a.taskId === 't1')).toBe(false);
      expect((await service.verify(DATE, 5)).valid).toBe(true);

      // history is complete
      const versions = await service.listVersions(DATE);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);

      // current plan equals version 5
      const current = await service.getCurrent(DATE);
      expect(current.version).toBe(5);
    });

    it('records diffs and can compare arbitrary versions', async () => {
      const diff15 = await service.diff(DATE, 1, 5);
      // w2 was removed along the way
      expect(diff15.workersRemoved).toEqual(['w2']);
      expect(diff15.tasksAdded).toEqual(['t4']);
      expect(diff15.tasksRemoved).toEqual(['t1']);
      // consecutive diffs are recorded on each version
      const v3 = await service.getVersion(DATE, 3);
      expect(v3.diffFromPrevious).not.toBeNull();
      const v2 = await service.getVersion(DATE, 2);
      // the cost override made w3->t3 unattractive: somebody moved
      expect(v2.diffFromPrevious!.reassigned.length).toBeGreaterThan(0);
    });

    it('rejects changes based on a stale version and reports the current one', async () => {
      await expect(
        service.submitChange(DATE, {
          baseVersion: 1,
          change: { type: 'task_cancelled', taskId: 't2' },
        }),
      ).rejects.toMatchObject({ currentVersion: 5 });
    });

    it('rejects unknown references in changes with field errors', async () => {
      await expect(
        service.submitChange(DATE, { baseVersion: 5, change: { type: 'worker_unavailable', workerId: 'ghost' } }),
      ).rejects.toMatchObject({ errors: [{ field: 'change.workerId' }] });
      await expect(
        service.submitChange(DATE, { baseVersion: 5, change: { type: 'task_cancelled', taskId: 'ghost' } }),
      ).rejects.toMatchObject({ errors: [{ field: 'change.taskId' }] });
      await expect(
        service.submitChange(DATE, {
          baseVersion: 5,
          change: { type: 'cost_override', workerId: 'w1', taskId: 't2', cost: Number.NaN },
        }),
      ).rejects.toMatchObject({ errors: [{ field: 'change.cost' }] });
      // failed changes create no version
      expect((await service.getCurrent(DATE)).version).toBe(5);
    });

    it('serializes concurrent submissions on the same base version', async () => {
      const results = await Promise.allSettled([
        service.submitChange(DATE, { baseVersion: 5, change: { type: 'cost_override', workerId: 'w1', taskId: 't2', cost: 9 } }),
        service.submitChange(DATE, { baseVersion: 5, change: { type: 'cost_override', workerId: 'w1', taskId: 't2', cost: 1 } }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const conflicted = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect((conflicted[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);
      expect((conflicted[0] as PromiseRejectedResult).reason.currentVersion).toBe(6);
      // exactly one new version, no gaps
      const versions = await service.listVersions(DATE);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('recovers the full state after a restart', async () => {
      // A brand-new service instance over the same database (process restart).
      const restarted = makeService(db);
      const current = await restarted.getCurrent(DATE);
      expect(current.version).toBe(6);
      const before = await service.getCurrent(DATE);
      expect(current.plan).toEqual(before.plan);
      const versions = await restarted.listVersions(DATE);
      expect(versions).toHaveLength(6);
      const verify = await restarted.verify(DATE, 6);
      expect(verify.valid).toBe(true);
    });

    it('rejects changes after the day is closed', async () => {
      await service.closeDay(DATE);
      await expect(
        service.submitChange(DATE, { baseVersion: 6, change: { type: 'task_cancelled', taskId: 't2' } }),
      ).rejects.toMatchObject({ errors: [{ field: 'date' }] });
      // reads still work
      expect((await service.getCurrent(DATE)).version).toBe(6);
    });

    it('returns 404-style errors for unknown days/versions', async () => {
      await expect(service.getCurrent('2099-01-01')).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.getVersion(DATE, 99)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('service-level invariants over random change sequences', () => {
    it('incremental versions match from-scratch objectives and stay verifiable', async () => {
      const helpers = await import('./helpers');
      const rand = helpers.rng(777);
      for (let day = 0; day < 6; day++) {
        const W = 3 + Math.floor(rand() * 3);
        const T = 4 + Math.floor(rand() * 3);
        const prob = helpers.randomProblem(rand, { workers: W, tasks: T, forbiddenProb: 0.15 });
        const date = `2026-11-0${day + 1}`;
        await service.createDay({
          date,
          workers: prob.cost.map((_, i) => ({ id: `w${i}` })),
          tasks: prob.delayCost.map((d, j) => ({ id: `t${j}`, delayCost: d })),
          costMatrix: prob.cost.map((row, i) => row.map((c, j) => (prob.forbidden[i][j] ? (null as never) : c))),
          reassignmentPenalty: 5,
        });
        let base = 1;
        for (let step = 0; step < 6; step++) {
          const r = rand();
          const current = await service.getVersion(date, base);
          const allWorkers = current.data.workerIds;
          const allTasks = current.data.tasks.map((t) => t.id);
          let change: Change;
          if (r < 0.25 && allWorkers.length > 1) {
            change = { type: 'worker_unavailable', workerId: allWorkers[Math.floor(rand() * allWorkers.length)] };
          } else if (r < 0.5) {
            change = {
              type: 'task_added',
              task: { id: `x${step}`, delayCost: Math.floor(rand() * 30) },
              costs: allWorkers.map((w) => ({ workerId: w, cost: rand() < 0.15 ? null : Math.floor(rand() * 20) })),
            };
          } else if (r < 0.7 && allTasks.length > 1) {
            change = { type: 'task_cancelled', taskId: allTasks[Math.floor(rand() * allTasks.length)] };
          } else {
            change = {
              type: 'cost_override',
              workerId: allWorkers[Math.floor(rand() * allWorkers.length)],
              taskId: allTasks[Math.floor(rand() * allTasks.length)],
              cost: rand() < 0.15 ? null : Math.floor(rand() * 25),
            };
          }
          const v = await service.submitChange(date, { baseVersion: base, change });
          base = v.version;

          // From-scratch check: re-solve this version's stabilized problem
          // independently and compare the penalized objective.
          const doc = await service.getVersion(date, base);
          const effectiveProblem = toProblem({
            workerIds: doc.data.workerIds,
            tasks: doc.data.tasks,
            costs: doc.certificate.effectiveCosts,
          });
          const scratch = solveDispatch(effectiveProblem);
          expect(scratch.totalCost + doc.certificate.constant).toBeCloseTo(doc.costs.penalized, 9);

          const verify = await service.verify(date, base);
          expect(verify.valid).toBe(true);
          expect(verify.checks.penalizedObjectiveIdentity).toBe(true);
        }
      }
    });
  });

  it('same input on two dates yields identical plans (determinism)', async () => {
    const a = await service.createDay(dayInput('2026-12-01'));
    const b = await service.createDay(dayInput('2026-12-02'));
    expect(a.plan).toEqual(b.plan);
    expect(a.certificate.alpha).toEqual(b.certificate.alpha);
    expect(a.certificate.beta).toEqual(b.certificate.beta);
  });
});
