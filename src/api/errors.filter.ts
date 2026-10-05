/**
 * 统一错误响应：{ error: { code, message, fields? } }，字段名原样返回。
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../domain/state';
import { StaleVersionError } from '../scheduler/scheduler.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: { code: exception.errorCode, message: exception.message, fields: exception.fields },
      });
      return;
    }

    if (exception instanceof StaleVersionError) {
      res.status(HttpStatus.CONFLICT).json({
        error: {
          code: 'STALE_VERSION',
          message: exception.message,
          fields: {
            date: exception.date,
            baseVersion: exception.baseVersion,
            currentVersion: exception.currentVersion,
          },
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)
          : { message: raw };
      res.status(status).json({
        error: {
          code: status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : 'HTTP_ERROR',
          message: typeof body.message === 'string' ? body.message : JSON.stringify(body.message),
          fields: (body.fields as Record<string, unknown>) ?? undefined,
        },
      });
      return;
    }

    const code = (exception as { code?: string })?.code;
    if (code === 'NOT_FOUND') {
      res.status(HttpStatus.NOT_FOUND).json({
        error: { code: 'NOT_FOUND', message: (exception as Error).message },
      });
      return;
    }
    if (code === 'DAY_EXISTS') {
      res.status(HttpStatus.CONFLICT).json({
        error: { code: 'DAY_EXISTS', message: (exception as Error).message },
      });
      return;
    }
    if (code === 'INCREMENTAL_MISMATCH') {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: { code: 'INCREMENTAL_MISMATCH', message: '增量修复与从头求解结果不一致' },
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: '内部错误' },
    });
  }
}
