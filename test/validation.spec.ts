/**
 * 输入校验单元测试：NaN/Infinity 在 JSON 传输前的纯数据层面必须被拒绝。
 */
import { validateInitialData, validateChange } from '../src/domain/validation';

describe('输入校验', () => {
  test('NaN / Infinity / -Infinity 代价一律拒绝', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        validateInitialData({
          workers: [{ id: 'a' }],
          tasks: [{ id: 'x' }],
          costs: [[bad]],
        }),
      ).toThrow(/有限数/);
    }
    expect(() =>
      validateInitialData({
        workers: [{ id: 'a' }],
        tasks: [{ id: 'x' }],
        costs: [[3]],
      }),
    ).not.toThrow();
  });

  test('矩阵维度不符', () => {
    expect(() =>
      validateInitialData({
        workers: [{ id: 'a' }],
        tasks: [{ id: 'x' }, { id: 'y' }],
        costs: [[1]],
      }),
    ).toThrow(/任务数/);
  });

  test('变动校验：set-cost 的 null 合法，字符串非法', () => {
    expect(() =>
      validateChange({ baseVersion: 1, change: { type: 'set-cost', workerId: 'a', taskId: 'x', cost: null } }),
    ).not.toThrow();
    expect(() =>
      validateChange({ baseVersion: 1, change: { type: 'set-cost', workerId: 'a', taskId: 'x', cost: NaN } }),
    ).toThrow(/有限数/);
    expect(() => validateChange({ baseVersion: 0, change: { type: 'close-day' } })).toThrow();
  });
});
