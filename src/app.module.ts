import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DispatchModule } from './dispatch.module';

@Module({
  imports: [
    // 延迟到应用创建时读取 MONGO_URL，便于测试把连接串指向 mongodb-memory-server。
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/dispatch',
        serverSelectionTimeoutMS: 10000,
      }),
    }),
    DispatchModule,
  ],
})
export class AppModule {}
