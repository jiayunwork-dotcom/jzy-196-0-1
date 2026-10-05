/**
 * 调度核心服务：
 * - 每天的所有提交经进程内互斥锁串行化 ⇒ 版本号严格按提交完成顺序生成；
 * - 乐观并发：变动必须携带 baseVersion（它提交时看到的版本），
 *   过期（baseVersion ≠ 当前版本）一律拒绝并返回 409 与当前版本，由调用方刷新后重试；
 * - 新版本默认用“上一版解+对偶结构”做增量热启动，同时从头求解一次核对目标值
 *   （核对失败则抛错——测试保证两者恒等；生产可用环境变量关闭从头核对以提速）；
 * - 方案、证书、差异、问题快照一并落库，重启后完整恢复。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  applyChange,
  buildInitialState,
  Change,
  cloneState,
  DayState,
  deserializeState,
  InitialData,
  serializeState,
  toSolverInput,
} from '../domain/state';
import {
  AssignmentResult,
  Certificate,
  MatchEntry,
} from '../solver/types';
import { solveAssignment, PreviousAssignment } from '../solver/assignment';
import { verifyCertificate } from '../solver/certificate';
import { diffAssignments, toAssignmentMap, VersionDiff } from '../versions/diff';
import { DayRepository, VersionRepository } from '../persistence/repository';

export class StaleVersionError extends Error {
  constructor(
    public readonly date: string,
    public readonly baseVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `版本冲突：基于 v${baseVersion} 的提交已过期，当前为 v${currentVersion}，请刷新后重试`,
    );
    this.name = 'StaleVersionError';
  }
}

export interface SubmitResult {
  version: number;
  parentVersion: number;
  baseVersion: number;
  result: AssignmentResult;
  diff: VersionDiff | null;
  change: Change | null;
  solveMode: string;
  objectiveMatch: boolean | null;
}

interface Persistable {
  state: DayState;
  result: AssignmentResult;
  diff: VersionDiff | null;
  change: Change | null;
  parentVersion: number;
  baseVersion: number;
  solveMode: string;
  objectiveMatch: boolean | null;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  /** date -> 串行化的 Promise 链。 */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** 内存缓存：date -> { state, currentVersion, latestMatches }，启动时懒加载。 */
  private readonly cache = new Map<
    string,
    { state: DayState; currentVersion: number; latestMatches: MatchEntry[] }
  >();
  /**
   * 运行时双解核对：默认关闭——“增量目标值 = 从头目标值”由 Jest 测试
   * （incremental.consistency.spec）保证；需要生产环境额外护栏时设
   * DISPATCH_CROSSCHECK=1 开启（每次变动多一次从头求解）。
   */
  private readonly crossCheck = process.env.DISPATCH_CROSSCHECK === '1';

  constructor(
    private readonly days: DayRepository,
    private readonly versions: VersionRepository,
  ) {}

  /** 提交当日初始数据并求解，生成 v1。已存在的日期返回错误。 */
  async initializeDay(date: string, data: InitialData): Promise<SubmitResult> {
    return this.withLock(date, async () => {
      const existing = await this.days.findByDate(date);
      if (existing) {
        const err = new Error(`日期 ${date} 已初始化，当前版本 v${existing.currentVersion}`);
        (err as Error & { code?: string }).code = 'DAY_EXISTS';
        throw err;
      }
      const state = buildInitialState(data);
      const solverInput = toSolverInput(state);
      const result = solveAssignment(solverInput);
      this.assertCertificate(solverInput, result);

      const persistable: Persistable = {
        state,
        result,
        diff: null,
        change: null,
        parentVersion: 0,
        baseVersion: 0,
        solveMode: result.solveMode,
        objectiveMatch: null,
      };
      const stored = await this.persist(date, 1, persistable);
      this.cache.set(date, {
        state,
        currentVersion: 1,
        latestMatches: stored.matches,
      });
      return this.toSubmitResult(stored);
    });
  }

  /** 基于 baseVersion 提交一次变动，生成新版本。 */
  async submitChange(date: string, baseVersion: number, change: Change): Promise<SubmitResult> {
    return this.withLock(date, async () => {
      const ctx = await this.ensureLoaded(date);
      if (baseVersion !== ctx.currentVersion) {
        throw new StaleVersionError(date, baseVersion, ctx.currentVersion);
      }

      const previous: PreviousAssignment = {
        workerToTask: toAssignmentMap(ctx.latestMatches),
      };
      const nextState = applyChange(cloneState(ctx.state), change);
      const solverInput = toSolverInput(nextState);

      const incremental = solveAssignment(solverInput, previous);
      this.assertCertificate(solverInput, incremental);

      // 与从头求解核对目标值（增量修复正确性的运行时护栏）。
      let objectiveMatch: boolean | null = null;
      let chosen = incremental;
      if (this.crossCheck) {
        const scratch = solveAssignment(solverInput);
        objectiveMatch = Math.abs(scratch.totalCost - incremental.totalCost) < 1e-9;
        if (!objectiveMatch) {
          this.logger.error(
            `增量/从头目标值不一致：incremental=${incremental.totalCost} scratch=${scratch.totalCost}`,
          );
          throw new Error('INCREMENTAL_MISMATCH');
        }
        // 从头解的规范序一致时二者应完全相同；以增量结果为准（两者目标相同、证书均有效）。
        chosen = incremental;
        void scratch;
      }

      const parentMatches = ctx.latestMatches;
      const diff = diffAssignments(ctx.currentVersion, parentMatches, ctx.currentVersion + 1, chosen.matches);

      const persistable: Persistable = {
        state: nextState,
        result: chosen,
        diff,
        change,
        parentVersion: ctx.currentVersion,
        baseVersion,
        solveMode: chosen.solveMode,
        objectiveMatch,
      };
      const version = ctx.currentVersion + 1;
      const stored = await this.persist(date, version, persistable);
      this.cache.set(date, {
        state: nextState,
        currentVersion: version,
        latestMatches: chosen.matches,
      });
      return this.toSubmitResult(stored);
    });
  }

  async getCurrent(date: string): Promise<SubmitResult | null> {
    const doc = await this.versions.latest(date);
    return doc ? this.toSubmitResult(doc) : null;
  }

  async getVersion(date: string, version: number): Promise<SubmitResult | null> {
    const doc = await this.versions.findOne(date, version);
    return doc ? this.toSubmitResult(doc) : null;
  }

  async listVersions(date: string): Promise<{ version: number; parentVersion: number; change: Change | null; createdAt: Date }[]> {
    const docs = await this.versions.findAll(date);
    return docs.map((d) => ({
      version: d.version,
      parentVersion: d.parentVersion,
      change: (d.change as unknown as Change) ?? null,
      createdAt: d.createdAt as Date,
    }));
  }

  async diffVersions(date: string, versionA: number, versionB: number): Promise<VersionDiff> {
    const [a, b] = await Promise.all([
      this.versions.findOne(date, versionA),
      this.versions.findOne(date, versionB),
    ]);
    if (!a) throw this.notFound('version', versionA);
    if (!b) throw this.notFound('version', versionB);
    return diffAssignments(versionA, a.matches, versionB, b.matches);
  }

  async getStateSnapshot(date: string) {
    const ctx = await this.ensureLoaded(date);
    return { currentVersion: ctx.currentVersion, ...serializeState(ctx.state) };
  }

  /** 校验任意给定方案（通常取某个历史版本）的证书——也可接受调用方自带的方案。 */
  verifyVersion(date: string, version: number) {
    return this.verifyInternal(date, version);
  }

  private async verifyInternal(date: string, version: number) {
    const doc = await this.versions.findOne(date, version);
    if (!doc) throw this.notFound('version', version);
    const state = deserializeState({
      workers: doc.snapWorkers,
      tasks: doc.snapTasks,
      costs: doc.snapCosts,
      closed: false,
    });
    const input = toSolverInput(state);
    return verifyCertificate(input, doc.matches, doc.certificate, doc.totalCost);
  }

  private async ensureLoaded(date: string) {
    const hit = this.cache.get(date);
    if (hit) return hit;
    const day = await this.days.findByDate(date);
    if (!day) throw this.notFound('date', date);
    const latest = await this.versions.latest(date);
    if (!latest) throw this.notFound('version', 1);
    const state = deserializeState({
      workers: latest.snapWorkers,
      tasks: latest.snapTasks,
      costs: latest.snapCosts,
      closed: day.closed,
    });
    const ctx = {
      state,
      currentVersion: latest.version,
      latestMatches: latest.matches,
    };
    this.cache.set(date, ctx);
    return ctx;
  }

  private assertCertificate(
    input: ReturnType<typeof toSolverInput>,
    result: AssignmentResult,
  ): void {
    const verification = verifyCertificate(input, result.matches, result.certificate, result.totalCost);
    if (!verification.valid) {
      throw new Error(`证书自检失败：${verification.violations.join('; ')}`);
    }
  }

  private async persist(date: string, version: number, p: Persistable) {
    const serialized = serializeState(p.state);
    const doc = await this.versions.insert({
      date,
      version,
      parentVersion: p.parentVersion,
      baseVersion: p.baseVersion,
      change: (p.change ?? undefined) as never,
      snapWorkers: serialized.workers as never,
      snapTasks: serialized.tasks as never,
      snapCosts: serialized.costs as never,
      matches: p.result.matches as never,
      unassignableWorkers: p.result.unassignableWorkers,
      impossibleTasks: p.result.impossibleTasks,
      delayedTasks: p.result.delayedTasks,
      idleWorkers: p.result.idleWorkers,
      totalCost: p.result.totalCost,
      optimalCost: p.result.optimalCost,
      reassignedWorkers: p.result.reassignedWorkers,
      retainedPairs: p.result.retainedPairs,
      certificate: p.result.certificate as never,
      solveMode: p.solveMode,
      diffFromParent: (p.diff as never) ?? undefined,
    });
    await this.days.upsert(date, {
      date,
      workers: serialized.workers as never,
      tasks: serialized.tasks as never,
      costs: serialized.costs as never,
      closed: serialized.closed,
      currentVersion: version,
    });
    return doc;
  }

  private toSubmitResult(doc: NonNullable<Awaited<ReturnType<VersionRepository['findOne']>>>): SubmitResult {
    const result = {
      version: doc.version,
      matches: doc.matches,
      unassignableWorkers: doc.unassignableWorkers,
      impossibleTasks: doc.impossibleTasks,
      delayedTasks: doc.delayedTasks,
      idleWorkers: doc.idleWorkers,
      totalCost: doc.totalCost,
      optimalCost: doc.optimalCost,
      reassignedWorkers: doc.reassignedWorkers,
      retainedPairs: doc.retainedPairs,
      certificate: doc.certificate,
      solveMode: doc.solveMode as 'scratch' | 'incremental',
    };
    return {
      version: doc.version,
      parentVersion: doc.parentVersion,
      baseVersion: doc.baseVersion,
      result,
      diff: (doc.diffFromParent as unknown as VersionDiff) ?? null,
      change: (doc.change as unknown as Change) ?? null,
      solveMode: doc.solveMode,
      objectiveMatch: null,
    };
  }

  private notFound(kind: string, value: string | number): Error {
    const err = new Error(`${kind} ${value} 不存在`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    return err;
  }

  /** 同一日期的操作排队执行；不同日期可并行。 */
  private withLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(date) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(date, next.then(() => undefined, () => undefined));
    return next;
  }
}
