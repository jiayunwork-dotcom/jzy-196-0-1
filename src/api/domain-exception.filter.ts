import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  StaleVersionError,
} from '../dispatch/errors';

/**
 * Maps domain errors to structured HTTP responses. Validation errors
 * always carry the offending field names.
 */
@Catch(DomainValidationError, StaleVersionError, NotFoundError, ConflictError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainValidationError | StaleVersionError | NotFoundError | ConflictError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainValidationError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'validation failed',
        errors: exception.errors,
      });
      return;
    }
    if (exception instanceof StaleVersionError) {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: exception.message,
        currentVersion: exception.currentVersion,
      });
      return;
    }
    if (exception instanceof NotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        message: exception.message,
      });
      return;
    }
    res.status(HttpStatus.CONFLICT).json({
      statusCode: HttpStatus.CONFLICT,
      message: exception.message,
    });
  }
}
