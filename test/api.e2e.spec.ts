import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { freshDb, sharedMongoUri, stopSharedMongo } from './mongo.helper';

/**
 * End-to-end API tests against a real Nest application backed by
 * in-memory MongoDB. Restart recovery is exercised by creating a second
 * application instance over the same database.
 */
describe('Dispatch API (e2e)', () => {
  let app: INestApplication;
  let dbName: string;

  beforeAll(async () => {
    const { db } = await freshDb();
    dbName = db.databaseName;
    process.env.MONGODB_URI = sharedMongoUri()!;
    process.env.MONGODB_DB = dbName;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await stopSharedMongo();
  });

  const DATE = '2026-10-05';
  const dayBody = {
    date: DATE,
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

  it('POST /dispatch/days creates version 1 with a certificate', async () => {
    const res = await request(app.getHttpServer()).post('/dispatch/days').send(dayBody).expect(201);
    expect(res.body.version).toBe(1);
    expect(res.body.costs.raw).toBe(5);
    expect(res.body.certificate.alpha).toBeDefined();
    expect(res.body.certificate.beta).toBeDefined();
    expect(res.body.plan.assignments).toHaveLength(3);
  });

  it('POST /dispatch/days validates with field-named errors', async () => {
    const res = await request(app.getHttpServer())
      .post('/dispatch/days')
      .send({ ...dayBody, date: '2026-10-06', costMatrix: [[1, 2, 3], [4, 'x', 6], [7, 8, 9]] })
      .expect(400);
    expect(res.body.errors).toEqual([{ field: 'costMatrix[1][1]', message: expect.any(String) }]);

    const res2 = await request(app.getHttpServer())
      .post('/dispatch/days')
      .send({ ...dayBody, date: '2026-10-06', costMatrix: [[1, 2], [3, 4], [5, 6]] })
      .expect(400);
    expect(res2.body.errors[0].field).toBe('costMatrix[0]');
  });

  it('full change flow: changes, versions, diff, verify', async () => {
    const server = app.getHttpServer();
    // change 1: cost override
    const v2 = await request(server)
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 1, change: { type: 'cost_override', workerId: 'w3', taskId: 't3', cost: 40 } })
      .expect(201);
    expect(v2.body.version).toBe(2);

    // change 2: worker unavailable
    const v3 = await request(server)
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 2, change: { type: 'worker_unavailable', workerId: 'w2' } })
      .expect(201);
    expect(v3.body.version).toBe(3);
    expect(v3.body.plan.assignments.some((a: { workerId: string }) => a.workerId === 'w2')).toBe(false);

    // change 3: urgent task
    await request(server)
      .post(`/dispatch/days/${DATE}/changes`)
      .send({
        baseVersion: 3,
        change: {
          type: 'task_added',
          task: { id: 't4', delayCost: 25 },
          costs: [
            { workerId: 'w1', cost: 2 },
            { workerId: 'w3', cost: 6 },
          ],
        },
      })
      .expect(201);

    // change 4: cancellation
    await request(server)
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 4, change: { type: 'task_cancelled', taskId: 't1' } })
      .expect(201);

    const current = await request(server).get(`/dispatch/days/${DATE}/current`).expect(200);
    expect(current.body.version).toBe(5);

    const versions = await request(server).get(`/dispatch/days/${DATE}/versions`).expect(200);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([1, 2, 3, 4, 5]);

    const diff = await request(server).get(`/dispatch/days/${DATE}/diff?from=1&to=5`).expect(200);
    expect(diff.body.workersRemoved).toEqual(['w2']);
    expect(diff.body.tasksAdded).toEqual(['t4']);
    expect(diff.body.tasksRemoved).toEqual(['t1']);

    for (const n of [1, 2, 3, 4, 5]) {
      const verify = await request(server).post(`/dispatch/days/${DATE}/versions/${n}/verify`).expect(200);
      expect(verify.body.valid).toBe(true);
    }
  });

  it('rejects stale base versions with 409 and the current version', async () => {
    const res = await request(app.getHttpServer())
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 2, change: { type: 'task_cancelled', taskId: 't2' } })
      .expect(409);
    expect(res.body.currentVersion).toBe(5);
  });

  it('rejects changes referencing unknown workers/tasks with field errors', async () => {
    const res = await request(app.getHttpServer())
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 5, change: { type: 'worker_unavailable', workerId: 'ghost' } })
      .expect(400);
    expect(res.body.errors).toEqual([{ field: 'change.workerId', message: expect.any(String) }]);
  });

  it('serializes concurrent change submissions', async () => {
    const server = app.getHttpServer();
    const [r1, r2] = await Promise.all([
      request(server)
        .post(`/dispatch/days/${DATE}/changes`)
        .send({ baseVersion: 5, change: { type: 'cost_override', workerId: 'w1', taskId: 't2', cost: 7 } }),
      request(server)
        .post(`/dispatch/days/${DATE}/changes`)
        .send({ baseVersion: 5, change: { type: 'cost_override', workerId: 'w3', taskId: 't3', cost: 8 } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = r1.status === 409 ? r1 : r2;
    expect(conflict.body.currentVersion).toBe(6);
    const versions = await request(server).get(`/dispatch/days/${DATE}/versions`).expect(200);
    expect(versions.body).toHaveLength(6);
  });

  it('recovers everything after a restart', async () => {
    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer();

    const current = await request(server).get(`/dispatch/days/${DATE}/current`).expect(200);
    expect(current.body.version).toBe(6);
    const versions = await request(server).get(`/dispatch/days/${DATE}/versions`).expect(200);
    expect(versions.body).toHaveLength(6);
    const verify = await request(server).post(`/dispatch/days/${DATE}/versions/6/verify`).expect(200);
    expect(verify.body.valid).toBe(true);
  });

  it('rejects changes to a closed day and unknown days', async () => {
    const server = app.getHttpServer();
    await request(server).post(`/dispatch/days/${DATE}/close`).expect(200);
    const res = await request(server)
      .post(`/dispatch/days/${DATE}/changes`)
      .send({ baseVersion: 6, change: { type: 'task_cancelled', taskId: 't2' } })
      .expect(400);
    expect(res.body.errors).toEqual([{ field: 'date', message: expect.any(String) }]);

    await request(server).get('/dispatch/days/2099-01-01/current').expect(404);
  });
});
