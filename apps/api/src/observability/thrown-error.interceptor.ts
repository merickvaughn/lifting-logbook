import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';
import { Observable, catchError, throwError } from 'rxjs';

/**
 * Where a request's thrown error waits on the raw response for pino-http (#1510). Not `res.err`:
 * pino-http logs whatever sits there, so a 404 from a domain error would carry an `err` too.
 */
const THROWN_ERROR = Symbol('thrownError');

type WithThrownError = ServerResponse & { [THROWN_ERROR]?: unknown };

/**
 * Keeps the error a request threw, so a 500's log line shows it rather than pino-http's
 * "failed with status code 500" (#1510). Registered in AppModule ahead of RlsInterceptor, so it
 * also sees an error from the request's transaction.
 */
@Injectable()
export class ThrownErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const reply = context.switchToHttp().getResponse<{ raw?: WithThrownError } | undefined>();
        if (reply?.raw) reply.raw[THROWN_ERROR] = error;
        return throwError(() => error);
      }),
    );
  }
}

/**
 * pino-http's `customErrorObject`, which it calls only for a response it logs as an error: a 5xx
 * here. Puts the thrown error in place of pino-http's generic one, when there is one.
 */
export function withThrownError(
  _req: IncomingMessage,
  res: ServerResponse,
  _error: Error,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const thrown = (res as WithThrownError)[THROWN_ERROR];
  return thrown === undefined ? value : { ...value, err: thrown };
}
