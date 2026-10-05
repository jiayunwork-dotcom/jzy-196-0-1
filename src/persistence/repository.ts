/**
 * 仓储层：封装 days / versions 两个集合的读写，重启后据此完整恢复。
 * 读取统一使用 lean()，返回普通 JS 对象，避免 Mongoose 子文档在纯领域代码中的
 * 访问器问题；写入用 create。
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DayModel, VersionModel } from './schemas';

type DayData = {
  date: string;
  workers: { id: string; available: boolean; idleCost: number }[];
  tasks: { id: string; active: boolean; delayCost: number }[];
  costs: { workerId: string; taskId: string; cost: number }[];
  closed: boolean;
  currentVersion: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type VersionData = {
  _id: unknown;
  date: string;
  version: number;
  parentVersion: number;
  baseVersion: number;
  change: Record<string, unknown> | null;
  snapWorkers: { id: string; available: boolean; idleCost: number }[];
  snapTasks: { id: string; active: boolean; delayCost: number }[];
  snapCosts: { workerId: string; taskId: string; cost: number }[];
  matches: { workerId: string; taskId: string | null; cost: number }[];
  unassignableWorkers: string[];
  impossibleTasks: string[];
  delayedTasks: string[];
  idleWorkers: string[];
  totalCost: number;
  optimalCost: number;
  reassignedWorkers: string[];
  retainedPairs: number;
  certificate: {
    workerPotentials: number[];
    taskPotentials: number[];
    coveragePotential: number;
    coverage: number;
  };
  solveMode: string;
  diffFromParent: Record<string, unknown> | null;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class DayRepository {
  constructor(@InjectModel(DayModel.name) private readonly day: Model<DayData>) {}

  findByDate(date: string): Promise<DayData | null> {
    return this.day.findOne({ date }).lean().exec();
  }

  upsert(date: string, patch: Partial<DayData>): Promise<DayData | null> {
    return this.day
      .findOneAndUpdate({ date }, { $set: patch }, { upsert: true, new: true })
      .lean()
      .exec();
  }
}

@Injectable()
export class VersionRepository {
  constructor(@InjectModel(VersionModel.name) private readonly versions: Model<VersionData>) {}

  async insert(doc: Partial<VersionData>): Promise<VersionData> {
    const created = await this.versions.create(doc);
    return created.toObject() as unknown as VersionData;
  }

  findOne(date: string, version: number): Promise<VersionData | null> {
    return this.versions.findOne({ date, version }).lean().exec();
  }

  findAll(date: string): Promise<VersionData[]> {
    return this.versions.find({ date }).sort({ version: 1 }).lean().exec();
  }

  latest(date: string): Promise<VersionData | null> {
    return this.versions.findOne({ date }).sort({ version: -1 }).lean().exec();
  }
}
