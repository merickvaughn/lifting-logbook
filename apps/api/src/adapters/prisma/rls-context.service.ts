import { Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { trace } from '@opentelemetry/api';
import { PrismaService } from './prisma.service';
import { RLS_TX_CLIENT, RLS_USER_ID_KEY, setRlsUserContext } from './rls-context';

/**
 * Opens a short-lived, per-operation Postgres RLS transaction for `@SkipRlsTransaction()` handlers
 * (issue #518).
 *
 * On those handlers the interceptor does NOT open a per-request transaction — it only stores the
 * authenticated userId in CLS ({@link RLS_USER_ID_KEY}). The handler then wraps each unit of DB
 * work in {@link withUserContext}, which opens its own transaction, sets `app.current_user_id`
 * (so RLS policies resolve to the caller), stashes the transaction client in CLS so repositories
 * built inside the callback route through it, and tears the binding down afterwards.
 *
 * The point is to keep slow non-DB work (e.g. an LLM round-trip) OUTSIDE any transaction: a DB
 * connection is held only for the brief span of each DB operation, not for the whole request.
 *
 * No-ops (runs the callback directly, no transaction) when there is no Prisma client — the
 * in-memory / SystemDb factories, which need no RLS GUC.
 */
@Injectable()
export class RlsContextService {
  // Each DB operation finishes quickly; the LLM latency lives between operations, outside any
  // transaction. A short timeout keeps a stuck operation from pinning a connection.
  private static readonly SHORT_TX_TIMEOUT_MS = 5_000;

  private readonly tracer = trace.getTracer('rls-context-service');

  constructor(
    private readonly cls: ClsService,
    @Optional() private readonly prisma: PrismaService | null = null,
  ) {}

  /**
   * Run `fn` inside a short-lived transaction with `app.current_user_id` set to the CLS userId, so
   * repositories built inside `fn` are RLS-scoped to the caller. When there is no Prisma client
   * (in-memory mode), `fn` runs directly with no transaction. A caller whose one operation reads a
   * lot can pass a longer `timeoutMs`.
   */
  async withUserContext<T>(
    fn: () => Promise<T>,
    timeoutMs: number = RlsContextService.SHORT_TX_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.prisma) {
      return fn();
    }
    const userId = this.cls.get(RLS_USER_ID_KEY) as string | undefined;
    if (!userId) {
      // async method, so this surfaces as a rejected promise (not a synchronous throw) — callers
      // that `await` or `.catch()` it behave consistently.
      throw new Error(
        'RlsContextService.withUserContext called outside an RLS context (no userId in CLS). ' +
          'The handler must be decorated with @SkipRlsTransaction() and run within the interceptor.',
      );
    }
    return this.prisma.$transaction(
      async (tx) => {
        await setRlsUserContext(this.tracer, tx, userId);
        this.cls.set(RLS_TX_CLIENT, tx);
        try {
          return await fn();
        } finally {
          // Tear down the binding so a later operation in the same request cannot accidentally
          // route through this (now-closed) transaction client.
          this.cls.set(RLS_TX_CLIENT, undefined);
        }
      },
      { timeout: timeoutMs },
    );
  }
}
