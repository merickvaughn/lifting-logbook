import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

/** What a failure log may say about an error. */
export interface Failure {
  error: string;
  code?: string;
  dbCode?: string;
  target?: unknown;
  message?: string;
}

/**
 * What a failure log may say about `err`: its name and Prisma code and target. A Prisma error's
 * message can quote the call's arguments, which here are the lifter's rows, so only other errors'
 * messages are logged.
 */
export function describeFailure(err: unknown): Failure {
  if (err instanceof PrismaClientKnownRequestError) {
    // A raw query's failure (P2010) carries the Postgres error code; its message quotes the query.
    const dbCode = err.meta?.['code'];
    return { error: err.name, code: err.code, target: err.meta?.['target'], ...(typeof dbCode === 'string' ? { dbCode } : {}) };
  }
  if (!(err instanceof Error)) return { error: typeof err };
  return err.name.startsWith('PrismaClient') ? { error: err.name } : { error: err.name, message: err.message };
}
