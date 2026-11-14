import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  CustomLiftConflictError,
  FocusBlockConflictError,
  FocusBlockStaleError,
  LiftModificationConflictError,
  MacrocycleNumberConflictError,
  ReservedLiftNameConflictError,
} from '../ports/errors';

type DomainConflict =
  | CustomLiftConflictError
  | ReservedLiftNameConflictError
  | FocusBlockConflictError
  | FocusBlockStaleError
  | LiftModificationConflictError
  | MacrocycleNumberConflictError;

/**
 * Translates framework-agnostic domain "conflict" errors raised by port
 * adapters into HTTP 409 responses. Mirrors DomainNotFoundFilter so adapters
 * stay free of `@nestjs/common` HTTP dependencies.
 */
@Catch(
  CustomLiftConflictError,
  ReservedLiftNameConflictError,
  FocusBlockConflictError,
  FocusBlockStaleError,
  LiftModificationConflictError,
  MacrocycleNumberConflictError,
)
export class DomainConflictFilter implements ExceptionFilter {
  catch(err: DomainConflict, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<FastifyReply>();
    res.status(HttpStatus.CONFLICT).send({
      statusCode: HttpStatus.CONFLICT,
      message: err.message,
      error: 'Conflict',
      // A client tells this 409 from the others by its code (ADR-042), when the error has one.
      ...('code' in err && typeof err.code === 'string' && { code: err.code }),
    });
  }
}
