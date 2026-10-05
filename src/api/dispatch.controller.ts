import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateDayInput,
  DispatchService,
  SubmitChangeInput,
} from '../dispatch/dispatch.service';

@Controller('dispatch/days')
export class DispatchController {
  constructor(private readonly service: DispatchService) {}

  /** Submit the day's initial data and solve the first version. */
  @Post()
  createDay(@Body() body: CreateDayInput) {
    return this.service.createDay(body);
  }

  /** Submit one intra-day change; creates the next version. */
  @Post(':date/changes')
  submitChange(@Param('date') date: string, @Body() body: SubmitChangeInput) {
    return this.service.submitChange(date, body);
  }

  /** Current plan (latest version). */
  @Get(':date/current')
  getCurrent(@Param('date') date: string) {
    return this.service.getCurrent(date);
  }

  /** Version history (summaries). */
  @Get(':date/versions')
  listVersions(@Param('date') date: string) {
    return this.service.listVersions(date);
  }

  /** One historical version, including its optimality certificate. */
  @Get(':date/versions/:version')
  getVersion(@Param('date') date: string, @Param('version', ParseIntPipe) version: number) {
    return this.service.getVersion(date, version);
  }

  /** Who got reassigned between two versions. */
  @Get(':date/diff')
  diff(
    @Param('date') date: string,
    @Query('from', ParseIntPipe) from: number,
    @Query('to', ParseIntPipe) to: number,
  ) {
    return this.service.diff(date, from, to);
  }

  /** Verify the optimality certificate of a stored version. */
  @Post(':date/versions/:version/verify')
  @HttpCode(200)
  verify(@Param('date') date: string, @Param('version', ParseIntPipe) version: number) {
    return this.service.verify(date, version);
  }

  /** Close the day; further changes are rejected. */
  @Post(':date/close')
  @HttpCode(200)
  async closeDay(@Param('date') date: string) {
    await this.service.closeDay(date);
    return { date, status: 'closed' };
  }
}
