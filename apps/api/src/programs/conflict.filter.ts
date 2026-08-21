import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { CustomLiftConflictError, ReservedLiftNameConflictError } from '../ports/errors';

type DomainConflict = CustomLiftConflictError | ReservedLiftNameConflictError;

/**
 * Translates framework-agnostic domain "conflict" errors raised by port
 * adapters into HTTP 409 responses. Mirrors DomainNotFoundFilter so adapters
 * stay free of `@nestjs/common` HTTP dependencies.
 */
@Catch(CustomLiftConflictError, ReservedLiftNameConflictError)
export class DomainConflictFilter implements ExceptionFilter {
  catch(err: DomainConflict, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<FastifyReply>();
    res.status(HttpStatus.CONFLICT).send({
      statusCode: HttpStatus.CONFLICT,
      message: err.message,
      error: 'Conflict',
    });
  }
}
