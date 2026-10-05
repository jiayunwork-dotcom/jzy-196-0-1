/**
 * 端到端测试引导：启动 mongodb-memory-server，装配 Nest 应用。
 * 重启恢复测试通过 newApp() 创建第二个共享同一 Mongo 的应用实例来模拟。
 */
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/api/errors.filter';

let mongod: MongoMemoryServer | null = null;

export async function startMongo(): Promise<string> {
  if (!mongod) {
    if (process.arch === 'arm64') {
      // aarch64 无 debian12 构建，固定使用已验证存在的 ubuntu2204 包。
      process.env.MONGOMS_VERSION = '7.0.21';
      process.env.MONGOMS_ARCH = 'aarch64';
      process.env.MONGOMS_DISTRO = 'ubuntu-22.04';
    } else {
      process.env.MONGOMS_VERSION = '7.0.21';
    }
    mongod = await MongoMemoryServer.create();
  }
  return mongod.getUri();
}

export async function stopMongo(): Promise<void> {
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function newApp(uri: string): Promise<INestApplication> {
  process.env.MONGO_URL = uri;
  // 重新实例化模块（清掉 Mongoose 连接缓存）。
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}
