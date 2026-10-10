import { SetMetadata } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Tracer } from '@opentelemetry/api';

/**
 * CLS key under which the per-request RLS interactive-transaction client is stored.
 * PrismaRepositoryFactory reads it so every repository in a request shares the one transaction
 * on which `app.current_user_id` was set. See rls.interceptor.ts.
 */
export const RLS_TX_CLIENT = 'rls.txClient';

/**
 * Default timeout (ms) for the per-request RLS interactive transaction. Normal CRUD requests
 * finish well within this; the transaction also bounds how long a single request may hold its
 * DB connection. Override per-handler with {@link RlsTxTimeout} for endpoints that legitimately
 * run longer.
 */
export const DEFAULT_RLS_TX_TIMEOUT_MS = 15_000;

/** Reflector metadata key for a per-handler RLS transaction timeout override. */
export const RLS_TX_TIMEOUT_KEY = 'rls.txTimeoutMs';

/**
 * Override the per-request RLS transaction timeout (ms) for a route handler. Use sparingly: the
 * request holds one DB connection for the whole transaction, so a long timeout pins a connection
 * for that duration. The motivating case is `macrocycle-plan`, which calls an LLM between DB reads.
 */
export const RlsTxTimeout = (ms: number) => SetMetadata(RLS_TX_TIMEOUT_KEY, ms);

/** Reflector metadata key marking a handler that opts out of the per-request RLS transaction. */
export const RLS_SKIP_TX = 'rls.skipTx';

/**
 * CLS key under which the authenticated userId is stored on `@SkipRlsTransaction()` handlers.
 * No per-request transaction is open on those handlers, so {@link RlsContextService} reads this
 * to open its own short-lived, per-operation transaction (with `app.current_user_id` set) around
 * each unit of DB work. See rls-context.service.ts and rls.interceptor.ts.
 */
export const RLS_USER_ID_KEY = 'rls.userId';

/**
 * Opt a route handler out of the per-request RLS interactive transaction. The interceptor instead
 * stores the userId in CLS ({@link RLS_USER_ID_KEY}); the handler is then responsible for wrapping
 * each unit of DB work in {@link RlsContextService.withUserContext}. Use this for handlers that do
 * slow non-DB work (e.g. an LLM round-trip) between DB reads, so a DB connection is not pinned for
 * the whole request. The motivating case is `macrocycle-plan`. See issue #518.
 */
export const SkipRlsTransaction = () => SetMetadata(RLS_SKIP_TX, true);

/**
 * Set the transaction-local `app.current_user_id` GUC so RLS policies resolve to `userId`, wrapped
 * in a manual OpenTelemetry span. Raw SQL is not auto-traced (ADR-024), hence the explicit span.
 * `set_config(_, _, true)` is the transaction-local (SET LOCAL) form and, unlike `SET LOCAL`,
 * accepts a bind parameter. Shared by the per-request interceptor and the per-operation
 * {@link RlsContextService}; the caller passes its own tracer so spans keep their source identity.
 */
export async function setRlsUserContext(
  tracer: Tracer,
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tracer.startActiveSpan('rls.set_user_context', async (span) => {
    try {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    } finally {
      span.end();
    }
  });
}
