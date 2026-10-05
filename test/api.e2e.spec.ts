/**
 * 端到端测试（REST + MongoDB）：
 *  参考算例、版本链与差异查询、证书校验接口、带字段名的错误、
 *  并发变动（顺序生成 + 过期拒绝）、重启恢复、已结束日期拒绝变动。
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { newApp, startMongo, stopMongo } from './helpers/app';

const DATE = '2026-10-05';

function baseBody() {
  return {
    workers: [
      { id: 'w0' },
      { id: 'w1' },
      { id: 'w2' },
      { id: 'w3' },
      { id: 'w4' },
    ],
    tasks: [{ id: 't0' }, { id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
    costs: [
      [4, 1, 3, 7, 9],
      [2, 0, 5, 8, 6],
      [3, 2, 2, 4, 1],
      [9, 8, 7, 1, 2],
      [5, 4, 3, 2, 0],
    ],
    delayCosts: [10, 10, 10, 10, 10],
  };
}

describe('派工服务端到端', () => {
  let app: INestApplication;
  let uri: string;

  beforeAll(async () => {
    uri = await startMongo();
    app = await newApp(uri);
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    await stopMongo();
  });

  test('提交初始数据返回参考规模的最优方案与可验证证书', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/days/${DATE}/initialize`)
      .send(baseBody())
      .expect(201);
    expect(res.body.version).toBe(1);
    expect(typeof res.body.result.totalCost).toBe('number');

    const verify = await request(app.getHttpServer())
      .post(`/api/days/${DATE}/verify/1`)
      .expect(201);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.violations).toEqual([]);
  });

  test('参考算例 3×3 通过接口得到总代价 5', async () => {
    const d = '2026-10-06';
    await request(app.getHttpServer())
      .post(`/api/days/${d}/initialize`)
      .send({
        workers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        tasks: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
        costs: [
          [4, 1, 3],
          [2, 0, 5],
          [3, 2, 2],
        ],
      })
      .expect(201)
      .expect((r: request.Response) => expect(r.body.result.totalCost).toBe(5));
  });

  test('错误：非有限代价 / 维度不符 / 引用不存在 / 已结束日期', async () => {
    // 非有限代价：JSON 无法传输 NaN/Infinity（会被序列化成 null），
    // 实际坏数据通常是字符串等非数值类型。
    const bad1 = await request(app.getHttpServer())
      .post(`/api/days/${DATE}/initialize`)
      .send({ workers: [{ id: 'a' }], tasks: [{ id: 'x' }], costs: [['oops']] })
      .expect(400);
    expect(bad1.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad1.body.error.fields.field).toContain('costs');

    // 维度不符。
    const bad2 = await request(app.getHttpServer())
      .post('/api/days/bad-dim/initialize')
      .send({
        workers: [{ id: 'a' }, { id: 'b' }],
        tasks: [{ id: 'x' }],
        costs: [[1]],
      })
      .expect(400);
    expect(bad2.body.error.fields.field).toBe('costs');

    // 引用不存在的人。
    const bad3 = await request(app.getHttpServer())
      .post(`/api/days/${DATE}/changes`)
      .send({
        baseVersion: 1,
        change: { type: 'worker-unavailable', workerId: 'nobody' },
      })
      .expect(400);
    expect(bad3.body.error.code).toBe('REFERENCE_NOT_FOUND');
    expect(bad3.body.error.fields.workerId).toBe('nobody');

    // 先结束日期。
    await request(app.getHttpServer())
      .post(`/api/days/${DATE}/close`)
      .send({ baseVersion: 1 })
      .expect(201);
    const closed = await request(app.getHttpServer())
      .post(`/api/days/${DATE}/changes`)
      .send({
        baseVersion: 2,
        change: { type: 'set-cost', workerId: 'w0', taskId: 't0', cost: 12 },
      })
      .expect(400);
    expect(closed.body.error.code).toBe('DAY_CLOSED');
  });

  test('版本链、差异查询、历史版本内容', async () => {
    const d = '2026-10-07';
    const init = await request(app.getHttpServer())
      .post(`/api/days/${d}/initialize`)
      .send(baseBody())
      .expect(201);
    expect(init.body.version).toBe(1);

    const ch = await request(app.getHttpServer())
      .post(`/api/days/${d}/changes`)
      .send({
        baseVersion: 1,
        change: { type: 'set-cost', workerId: 'w0', taskId: 't1', cost: 100 },
      })
      .expect(201);
    expect(ch.body.version).toBe(2);
    expect(ch.body.parentVersion).toBe(1);
    expect(ch.body.solveMode).toBe('incremental');
    expect(Array.isArray(ch.body.result.reassignedWorkers)).toBe(true);
    expect(ch.body.diff.reassignedCount).toBeGreaterThanOrEqual(0);

    const ch2 = await request(app.getHttpServer())
      .post(`/api/days/${d}/changes`)
      .send({ baseVersion: 2, change: { type: 'worker-unavailable', workerId: 'w1' } })
      .expect(201);
    expect(ch2.body.version).toBe(3);

    const list = await request(app.getHttpServer()).get(`/api/days/${d}/versions`).expect(200);
    expect(list.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);

    const v1 = await request(app.getHttpServer()).get(`/api/days/${d}/versions/1`).expect(200);
    expect(v1.body.found).toBe(true);
    expect(v1.body.result.matches.length).toBe(5);

    const diff = await request(app.getHttpServer())
      .get(`/api/days/${d}/diff?a=1&b=3`)
      .expect(200);
    expect(diff.body.versionA).toBe(1);
    expect(diff.body.versionB).toBe(3);
    expect(diff.body.workersRemoved).toContain('w1');
    expect(Array.isArray(diff.body.reassigned)).toBe(true);
  });

  test('并发变动：版本严格串行生成，过期提交被 409 拒绝并告知当前版本', async () => {
    const d = '2026-10-08';
    await request(app.getHttpServer())
      .post(`/api/days/${d}/initialize`)
      .send(baseBody())
      .expect(201);

    // 三个请求都基于 v1 并发提交。
    const payloads = [
      { type: 'set-cost', workerId: 'w0', taskId: 't0', cost: 11 },
      { type: 'set-cost', workerId: 'w1', taskId: 't1', cost: 22 },
      { type: 'worker-unavailable', workerId: 'w2' },
    ];
    const results = await Promise.all(
      payloads.map((change) =>
        request(app.getHttpServer())
          .post(`/api/days/${d}/changes`)
          .send({ baseVersion: 1, change }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    // 恰好 1 个成功（201），其余 2 个 409。
    expect(statuses).toEqual([201, 409, 409]);
    for (const r of results) {
      if (r.status === 409) {
        expect(r.body.error.code).toBe('STALE_VERSION');
        expect(r.body.error.fields.baseVersion).toBe(1);
        expect(r.body.error.fields.currentVersion).toBeGreaterThan(1);
      }
    }

    // 成功者之后当前版本为 2；按顺序在最新版本上重放剩余变动可全部成功。
    const cur = await request(app.getHttpServer()).get(`/api/days/${d}/current`).expect(200);
    expect(cur.body.version).toBe(2);

    let base = 2;
    const landedIndex = results.findIndex((r) => r.status === 201);
    for (let i = 0; i < payloads.length; i++) {
      if (i === landedIndex) continue; // 已落地的变动不重放
      const rr = await request(app.getHttpServer())
        .post(`/api/days/${d}/changes`)
        .send({ baseVersion: base, change: payloads[i] });
      expect(rr.status).toBe(201);
      expect(rr.body.version).toBe(base + 1);
      base += 1;
    }
    const finalList = await request(app.getHttpServer()).get(`/api/days/${d}/versions`).expect(200);
    expect(finalList.body.versions.length).toBe(4);
  }, 30000);

  test('重启后当天所有版本与当前方案完整恢复', async () => {
    const d = '2026-10-09';
    await request(app.getHttpServer())
      .post(`/api/days/${d}/initialize`)
      .send(baseBody())
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/days/${d}/changes`)
      .send({
        baseVersion: 1,
        change: { type: 'set-cost', workerId: 'w0', taskId: 't1', cost: 50 },
      })
      .expect(201);

    // 模拟服务重启：新建应用实例（缓存全部失效），直连同一个 Mongo。
    const app2 = await newApp(uri);
    try {
      const cur = await request(app2.getHttpServer()).get(`/api/days/${d}/current`).expect(200);
      expect(cur.body.version).toBe(2);
      expect(cur.body.result.matches.length).toBe(5);

      const list = await request(app2.getHttpServer()).get(`/api/days/${d}/versions`).expect(200);
      expect(list.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);

      // 重启后仍可基于最新版继续提交变动。
      const next = await request(app2.getHttpServer())
        .post(`/api/days/${d}/changes`)
        .send({ baseVersion: 2, change: { type: 'worker-unavailable', workerId: 'w3' } })
        .expect(201);
      expect(next.body.version).toBe(3);

      // 旧版本的证书在重启后仍可校验。
      const verify = await request(app2.getHttpServer())
        .post(`/api/days/${d}/verify/1`)
        .expect(201);
      expect(verify.body.valid).toBe(true);
    } finally {
      await app2.close();
    }
  });

  test('全禁止人员被报告为无法安排', async () => {
    const d = '2026-10-10';
    const res = await request(app.getHttpServer())
      .post(`/api/days/${d}/initialize`)
      .send({
        workers: [{ id: 'a' }, { id: 'b' }],
        tasks: [{ id: 'x' }, { id: 'y' }],
        costs: [
          [1, 2],
          [null, null],
        ],
      })
      .expect(201);
    expect(res.body.result.unassignableWorkers).toEqual(['b']);
    const verify = await request(app.getHttpServer())
      .post(`/api/days/${d}/verify/1`)
      .expect(201);
    expect(verify.body.valid).toBe(true);
  });
});
