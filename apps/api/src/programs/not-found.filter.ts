import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  CustomLiftNotFoundError,
  FocusBlockNotFoundError,
  HistoryEntryNotFoundError,
  ProgramNotFoundError,
  StrengthGoalNotFoundError,
  WorkoutNotFoundError,
} from '../ports/errors';

type DomainNotFound =
  | ProgramNotFoundError
  | WorkoutNotFoundError
  | HistoryEntryNotFoundError
  | StrengthGoalNotFoundError
  | CustomLiftNotFoundError
  | FocusBlockNotFoundError;

/**
 * Translates framework-agnostic domain "not found" errors raised by port
 * adapters into HTTP 404 responses. Keeps adapters free of `@nestjs/common`
 * HTTP dependencies so they can be reused by non-HTTP callers.
 */
@Catch(
  ProgramNotFoundError,
  WorkoutNotFoundError,
  HistoryEntryNotFoundError,
  StrengthGoalNotFoundError,
  CustomLiftNotFoundError,
  FocusBlockNotFoundError,
)
export class DomainNotFoundFilter implements ExceptionFilter {
  catch(err: DomainNotFound, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<FastifyReply>();
    res.status(HttpStatus.NOT_FOUND).send({
      statusCode: HttpStatus.NOT_FOUND,
      message: err.message,
      error: 'Not Found',
    });
  }
}
