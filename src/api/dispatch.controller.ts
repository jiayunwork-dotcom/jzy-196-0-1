/**
 * REST 接口：
 *   POST   /api/days/:date/initialize      提交当日初始数据并求解（v1）
 *   POST   /api/days/:date/changes          基于 baseVersion 提交变动（生成新版本）
 *   POST   /api/days/:date/close            结束当天（body 仅需 {baseVersion}）
 *   GET    /api/days/:date/current          当前方案（含证书）
 *   GET    /api/days/:date/versions         历史版本列表
 *   GET    /api/days/:date/versions/:v      指定版本完整内容
 *   GET    /api/days/:date/diff?a=&b=       比较任意两版差异
 *   POST   /api/days/:date/verify/:v        校验某版最优性证书
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Change, DomainError } from '../domain/state';
import { validateChange, validateInitialData } from '../domain/validation';
import { SchedulerService, SubmitResult } from '../scheduler/scheduler.service';

@Controller('api/days/:date')
export class DispatchController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post('initialize')
  async initialize(@Param('date') date: string, @Body() body: unknown) {
    validateInitialData(body);
    return this.scheduler.initializeDay(date, body);
  }

  @Post('changes')
  async change(@Param('date') date: string, @Body() body: unknown) {
    validateChange(body);
    const b = body as { baseVersion: number; change: Change };
    return this.scheduler.submitChange(date, b.baseVersion, b.change);
  }

  @Post('close')
  async close(@Param('date') date: string, @Body() body: unknown) {
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { baseVersion?: unknown }).baseVersion !== 'number'
    ) {
      throw new DomainError('VALIDATION_ERROR', '需要 baseVersion', { field: 'baseVersion' });
    }
    return this.scheduler.submitChange(date, (body as { baseVersion: number }).baseVersion, {
      type: 'close-day',
    });
  }

  @Get('current')
  async current(@Param('date') date: string) {
    const result = await this.scheduler.getCurrent(date);
    if (!result) return { found: false };
    return { found: true, ...result };
  }

  @Get('versions')
  async versions(@Param('date') date: string) {
    return { date, versions: await this.scheduler.listVersions(date) };
  }

  @Get('versions/:v')
  async version(@Param('date') date: string, @Param('v') v: string) {
    const result: SubmitResult | null = await this.scheduler.getVersion(date, Number(v));
    if (!result) return { found: false };
    return { found: true, ...result };
  }

  @Get('diff')
  async diff(@Param('date') date: string, @Query('a') a: string, @Query('b') b: string) {
    return this.scheduler.diffVersions(date, Number(a), Number(b));
  }

  @Post('verify/:v')
  async verify(@Param('date') date: string, @Param('v') v: string) {
    const verification = await this.scheduler.verifyVersion(date, Number(v));
    return { version: Number(v), ...verification };
  }
}
