import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Db } from 'mongodb';
import { DispatchController } from './api/dispatch.controller';
import { DomainExceptionFilter } from './api/domain-exception.filter';
import { DispatchService } from './dispatch/dispatch.service';
import { MongoConnection } from './persistence/mongo';
import { DayRepository, VersionRepository } from './persistence/repositories';

@Module({
  controllers: [DispatchController],
  providers: [
    MongoConnection,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: 'DB',
      useFactory: async (conn: MongoConnection): Promise<Db> => conn.connect(),
      inject: [MongoConnection],
    },
    {
      provide: DayRepository,
      useFactory: (db: Db) => new DayRepository(db),
      inject: ['DB'],
    },
    {
      provide: VersionRepository,
      useFactory: (db: Db) => new VersionRepository(db),
      inject: ['DB'],
    },
    DispatchService,
  ],
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly conn: MongoConnection) {}

  async onModuleInit(): Promise<void> {
    await this.conn.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.conn.close();
  }
}
