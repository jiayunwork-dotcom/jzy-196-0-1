import { Collection, Db, MongoServerError } from 'mongodb';
import { DayData } from '../dispatch/change';
import { PlanDiff, PlanSnapshot } from '../version/diff';
import { ConflictError } from '../dispatch/errors';

export interface DayDoc {
  date: string;
  status: 'open' | 'closed';
  reassignmentPenalty: number;
  createdAt: Date;
  closedAt?: Date;
}

export interface StoredChange {
  type: string;
  [key: string]: unknown;
}

export interface VersionDoc {
  date: string;
  version: number;
  /** The change that produced this version; null for the initial version. */
  change: StoredChange | null;
  /** Day data AFTER applying the change (source of truth for the next replan). */
  data: DayData;
  plan: PlanSnapshot;
  /** Dual certificate, id-keyed. */
  alpha: Record<string, number>;
  beta: Record<string, number>;
  /** The stabilized cost matrix actually solved (null = forbidden). */
  effectiveCosts: (number | null)[][];
  /** Penalty constant: penalizedCost = solverTotal(effectiveCosts) + constant. */
  constant: number;
  /** Cost of the plan under the TRUE costs. */
  rawCost: number;
  /** rawCost + rho * (#reassigned workers) — the quantity proven minimal. */
  penalizedCost: number;
  reassignmentPenalty: number;
  reassignedCount: number;
  unassignableWorkerIds: string[];
  unassignableTaskIds: string[];
  diffFromPrevious: PlanDiff | null;
  createdAt: Date;
}

export class DuplicateKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateKey';
  }
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

export class DayRepository {
  private readonly col: Collection<DayDoc>;

  constructor(db: Db) {
    this.col = db.collection<DayDoc>('days');
  }

  async insert(doc: DayDoc): Promise<void> {
    try {
      await this.col.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError(`day '${doc.date}' already exists`);
      throw err;
    }
  }

  async findByDate(date: string): Promise<DayDoc | null> {
    return this.col.findOne({ date });
  }

  async close(date: string): Promise<void> {
    await this.col.updateOne(
      { date },
      { $set: { status: 'closed', closedAt: new Date() } },
    );
  }
}

export class VersionRepository {
  private readonly col: Collection<VersionDoc>;

  constructor(db: Db) {
    this.col = db.collection<VersionDoc>('versions');
  }

  /** Insert the next version; the unique (date, version) index serializes concurrent writers. */
  async insert(doc: VersionDoc): Promise<void> {
    try {
      await this.col.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new DuplicateKey(`version ${doc.version} of day '${doc.date}' already exists`);
      }
      throw err;
    }
  }

  async find(date: string, version: number): Promise<VersionDoc | null> {
    return this.col.findOne({ date, version });
  }

  async latest(date: string): Promise<VersionDoc | null> {
    return this.col.findOne({ date }, { sort: { version: -1 } });
  }

  async list(date: string): Promise<VersionDoc[]> {
    return this.col.find({ date }).sort({ version: 1 }).toArray();
  }
}
