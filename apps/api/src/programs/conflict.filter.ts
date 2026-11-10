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
  LiftModificationConflictError,
  MacrocycleNumberConflictError,
  ReservedLiftNameConflictError,
} from '../ports/errors';

type DomainConflict =
  | CustomLiftConflictError
  | ReservedLiftNameConflictError
  | FocusBlockConflictError
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
      // A client tells this 409 from the others by its code (ADR-042).
      ...(err instanceof MacrocycleNumberConflictError && { code: err.code }),
    });
  }
}
