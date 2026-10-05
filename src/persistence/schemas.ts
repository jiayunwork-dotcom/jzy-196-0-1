/**
 * MongoDB 持久化模型：
 * - DayDocument：每天一条，保存当前状态与当前版本号（用于重启恢复、日期关闭判断）；
 * - VersionDocument：每个版本一条不可变记录，保存当时问题快照、方案、证书、
 *   触发变动及与上一版的差异。历史永不删除，可查任意两版差异。
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
class WorkerPersist {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) available!: boolean;
  @Prop({ required: true }) idleCost!: number;
}

@Schema({ _id: false })
class TaskPersist {
  @Prop({ required: true }) id!: string;
  @Prop({ required: true }) active!: boolean;
  @Prop({ required: true }) delayCost!: number;
}

@Schema({ _id: false })
class CostEntry {
  @Prop({ required: true }) workerId!: string;
  @Prop({ required: true }) taskId!: string;
  @Prop({ required: true }) cost!: number;
}

@Schema({ collection: 'days', timestamps: true })
export class DayModel {
  /** 业务日期，YYYY-MM-DD，作为自然主键。 */
  @Prop({ required: true, unique: true, index: true }) date!: string;

  @Prop({ type: [WorkerPersist], default: [] }) workers!: WorkerPersist[];

  @Prop({ type: [TaskPersist], default: [] }) tasks!: TaskPersist[];

  @Prop({ type: [CostEntry], default: [] }) costs!: CostEntry[];

  @Prop({ required: true, default: false }) closed!: boolean;

  @Prop({ required: true, default: 0 }) currentVersion!: number;
}

export type DayDocument = HydratedDocument<DayModel>;
export const DaySchema = SchemaFactory.createForClass(DayModel);

@Schema({ _id: false })
class MatchPersist {
  @Prop({ required: true }) workerId!: string;
  @Prop({ type: String, default: null }) taskId!: string | null;
  @Prop({ required: true }) cost!: number;
}

@Schema({ _id: false })
class CertificatePersist {
  @Prop({ type: [Number], required: true }) workerPotentials!: number[];
  @Prop({ type: [Number], required: true }) taskPotentials!: number[];
  @Prop({ required: true }) coveragePotential!: number;
  @Prop({ required: true }) coverage!: number;
}

@Schema({ _id: false })
class ChangePersist {
  @Prop({ required: true }) type!: string;
  @Prop({ type: String }) workerId?: string;
  @Prop({ type: String }) taskId?: string;
  @Prop({ type: Number, default: null }) cost?: number | null;
  @Prop({ type: String }) reason?: string;
  @Prop({ type: Number }) idleCost?: number;
  @Prop({ type: Number }) delayCost?: number;
  @Prop({ type: [Object], default: [] }) costs?: { workerId: string; cost: number | null }[];
}

@Schema({ _id: false })
class ReassignmentPersist {
  @Prop({ required: true }) workerId!: string;
  @Prop({ type: String, default: null }) fromTaskId!: string | null;
  @Prop({ type: String, default: null }) toTaskId!: string | null;
}

@Schema({ _id: false })
class DiffPersist {
  @Prop({ type: [ReassignmentPersist], default: [] }) reassigned!: ReassignmentPersist[];
  @Prop({ type: [String], default: [] }) workersRemoved!: string[];
  @Prop({ type: [String], default: [] }) workersAdded!: string[];
  @Prop({ type: [String], default: [] }) tasksUnassignedInB!: string[];
  @Prop({ type: [String], default: [] }) tasksNewlyAssignedInB!: string[];
  @Prop({ required: true }) reassignedCount!: number;
}

@Schema({ collection: 'versions', timestamps: true })
export class VersionModel {
  _id!: Types.ObjectId;

  @Prop({ required: true, index: true }) date!: string;

  /** 版本号，同一天内从 1 单调递增。 */
  @Prop({ required: true }) version!: number;

  /** 基于的上一版号（首版为 0）。 */
  @Prop({ required: true }) parentVersion!: number;

  /** 提交时客户端声称看到的版本号；与 parentVersion 相同表示提交时是最新的。 */
  @Prop({ required: true }) baseVersion!: number;

  @Prop({ type: ChangePersist, default: null }) change!: InstanceType<typeof ChangePersist> | null;

  /** 该版本求解时的完整问题快照。 */
  @Prop({ type: [WorkerPersist], required: true }) snapWorkers!: WorkerPersist[];
  @Prop({ type: [TaskPersist], required: true }) snapTasks!: TaskPersist[];
  @Prop({ type: [CostEntry], required: true }) snapCosts!: CostEntry[];

  @Prop({ type: [MatchPersist], required: true }) matches!: MatchPersist[];
  @Prop({ type: [String], required: true }) unassignableWorkers!: string[];
  @Prop({ type: [String], required: true }) impossibleTasks!: string[];
  @Prop({ type: [String], required: true }) delayedTasks!: string[];
  @Prop({ type: [String], required: true }) idleWorkers!: string[];
  @Prop({ required: true }) totalCost!: number;
  @Prop({ required: true }) optimalCost!: number;
  @Prop({ type: [String], required: true }) reassignedWorkers!: string[];
  @Prop({ required: true }) retainedPairs!: number;
  @Prop({ type: CertificatePersist, required: true }) certificate!: CertificatePersist;
  @Prop({ required: true }) solveMode!: string;

  @Prop({ type: DiffPersist, default: null }) diffFromParent!: DiffPersist | null;
}

export type VersionDocument = HydratedDocument<VersionModel>;
export const VersionSchema = SchemaFactory.createForClass(VersionModel);
VersionSchema.index({ date: 1, version: 1 }, { unique: true });
