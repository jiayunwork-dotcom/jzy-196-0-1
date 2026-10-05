import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DayModel, DaySchema, VersionModel, VersionSchema } from './persistence/schemas';
import { DayRepository, VersionRepository } from './persistence/repository';
import { SchedulerService } from './scheduler/scheduler.service';
import { DispatchController } from './api/dispatch.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DayModel.name, schema: DaySchema },
      { name: VersionModel.name, schema: VersionSchema },
    ]),
  ],
  controllers: [DispatchController],
  providers: [DayRepository, VersionRepository, SchedulerService],
})
export class DispatchModule {}
