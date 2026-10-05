/**
 * 接口层之外的纯数据校验：有限数、矩阵维度、引用、重复 id。
 * 抛 DomainError（带 errorCode 与字段名），由接口层映射为 400。
 */
import { CostCell } from '../solver/types';
import { Change, DomainError, InitialData } from './state';

export function validateInitialData(data: unknown): asserts data is InitialData {
  if (typeof data !== 'object' || data === null) {
    throw new DomainError('INVALID_BODY', '请求体必须是对象', {});
  }
  const d = data as Record<string, unknown>;

  const workers = d.workers;
  const tasks = d.tasks;
  const costs = d.costs;

  if (!Array.isArray(workers)) throw fieldError('workers', '必须是数组');
  if (!Array.isArray(tasks)) throw fieldError('tasks', '必须是数组');
  if (!Array.isArray(costs)) throw fieldError('costs', '必须是二维数组');

  // 可选的顶层 idleCosts / delayCosts 数组：长度与维度一致、元素为有限数。
  if (d.idleCosts !== undefined) {
    if (!Array.isArray(d.idleCosts)) throw fieldError('idleCosts', '必须是数组');
    if (d.idleCosts.length !== workers.length) {
      throw fieldError('idleCosts', `长度 ${d.idleCosts.length} 与质检员人数 ${workers.length} 不符`);
    }
    d.idleCosts.forEach((v: unknown, i: number) => {
      if (!isFiniteNumber(v)) throw fieldError(`idleCosts[${i}]`, '必须是有限数');
    });
  }
  if (d.delayCosts !== undefined) {
    if (!Array.isArray(d.delayCosts)) throw fieldError('delayCosts', '必须是数组');
    if (d.delayCosts.length !== tasks.length) {
      throw fieldError('delayCosts', `长度 ${d.delayCosts.length} 与任务数 ${tasks.length} 不符`);
    }
    d.delayCosts.forEach((v: unknown, j: number) => {
      if (!isFiniteNumber(v)) throw fieldError(`delayCosts[${j}]`, '必须是有限数');
    });
  }

  const workerIds = new Set<string>();
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i];
    if (typeof w !== 'object' || w === null || typeof (w as { id?: unknown }).id !== 'string') {
      throw fieldError(`workers[${i}].id`, '必须为字符串');
    }
    const id = (w as { id: string }).id;
    if (workerIds.has(id)) throw fieldError(`workers[${i}].id`, `重复的质检员 id：${id}`);
    workerIds.add(id);
    const idleCost = (w as { idleCost?: unknown }).idleCost;
    if (idleCost !== undefined && !isFiniteNumber(idleCost)) {
      throw fieldError(`workers[${i}].idleCost`, '必须是有限数');
    }
  }

  const taskIds = new Set<string>();
  for (let j = 0; j < tasks.length; j++) {
    const t = tasks[j];
    if (typeof t !== 'object' || t === null || typeof (t as { id?: unknown }).id !== 'string') {
      throw fieldError(`tasks[${j}].id`, '必须为字符串');
    }
    const id = (t as { id: string }).id;
    if (taskIds.has(id)) throw fieldError(`tasks[${j}].id`, `重复的任务 id：${id}`);
    taskIds.add(id);
    const delayCost = (t as { delayCost?: unknown }).delayCost;
    if (delayCost !== undefined && !isFiniteNumber(delayCost)) {
      throw fieldError(`tasks[${j}].delayCost`, '必须是有限数');
    }
  }

  if (costs.length !== workers.length) {
    throw fieldError(
      'costs',
      `矩阵行数 ${costs.length} 与质检员人数 ${workers.length} 不符`,
      { rows: costs.length, expected: workers.length },
    );
  }
  for (let i = 0; i < costs.length; i++) {
    const row = costs[i] as unknown;
    if (!Array.isArray(row)) {
      throw fieldError(`costs[${i}]`, '矩阵每一行必须是数组');
    }
    if (row.length !== tasks.length) {
      throw fieldError(
        `costs[${i}]`,
        `第 ${i} 行列数 ${row.length} 与任务数 ${tasks.length} 不符`,
        { columns: row.length, expected: tasks.length },
      );
    }
    for (let j = 0; j < row.length; j++) {
      const cell = row[j] as CostCell;
      if (cell !== null && !isFiniteNumber(cell)) {
        throw fieldError(`costs[${i}][${j}]`, '代价必须是有限数或 null');
      }
    }
  }
}

export function validateChange(body: unknown): asserts body is { baseVersion: number; change: Change } {
  if (typeof body !== 'object' || body === null) {
    throw new DomainError('INVALID_BODY', '请求体必须是对象', {});
  }
  const b = body as Record<string, unknown>;
  if (typeof b.baseVersion !== 'number' || !Number.isInteger(b.baseVersion) || b.baseVersion < 1) {
    throw fieldError('baseVersion', '必须是 ≥1 的整数（基于的版本号）');
  }
  const change = b.change;
  if (typeof change !== 'object' || change === null) {
    throw fieldError('change', '必须是对象');
  }
  const c = change as Record<string, unknown>;
  const knownTypes = new Set([
    'worker-unavailable',
    'worker-available',
    'add-worker',
    'remove-worker',
    'add-task',
    'remove-task',
    'set-cost',
    'close-day',
  ]);
  if (typeof c.type !== 'string' || !knownTypes.has(c.type)) {
    throw fieldError('change.type', '未知变动类型');
  }
  const needsWorker = [
    'worker-unavailable',
    'worker-available',
    'add-worker',
    'remove-worker',
  ];
  const needsTask = ['add-task', 'remove-task'];
  if (needsWorker.includes(c.type) && typeof c.workerId !== 'string') {
    throw fieldError('change.workerId', '该变动需要 workerId');
  }
  if (needsTask.includes(c.type) && typeof c.taskId !== 'string') {
    throw fieldError('change.taskId', '该变动需要 taskId');
  }
  if (c.type === 'set-cost') {
    if (typeof c.workerId !== 'string') throw fieldError('change.workerId', '必须为字符串');
    if (typeof c.taskId !== 'string') throw fieldError('change.taskId', '必须为字符串');
    if (c.cost !== null && !isFiniteNumber(c.cost)) {
      throw fieldError('change.cost', '代价必须是有限数或 null');
    }
  }
  if (c.type === 'add-worker' && c.idleCost !== undefined && !isFiniteNumber(c.idleCost)) {
    throw fieldError('change.idleCost', '必须是有限数');
  }
  if (c.type === 'add-task') {
    if (c.delayCost !== undefined && !isFiniteNumber(c.delayCost)) {
      throw fieldError('change.delayCost', '必须是有限数');
    }
    if (c.costs !== undefined) {
      if (!Array.isArray(c.costs)) throw fieldError('change.costs', '必须是数组');
      c.costs.forEach((entry, i) => {
        const e = entry as { cost?: unknown };
        if (e.cost !== null && !isFiniteNumber(e.cost)) {
          throw fieldError(`change.costs[${i}].cost`, '代价必须是有限数或 null');
        }
      });
    }
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fieldError(field: string, message: string, extra?: Record<string, unknown>): DomainError {
  return new DomainError('VALIDATION_ERROR', message, { field, ...extra });
}
