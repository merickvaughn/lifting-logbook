import { Provider } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { trace } from '@opentelemetry/api';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { setRlsUserContext } from '../adapters/prisma/rls-context';
import type { IImportSuggestionUsage } from '../ports/IImportSuggestionProvider';
import { IMPORT_SUGGESTION_USAGE } from '../ports/tokens';

const HOUR_MS = 3_600_000;
/** Advisory lock class for the per-user count, apart from the macrocycle lock's (decision 13). */
const USAGE_LOCK_CLASS = 1174;

/** The minimal client this needs, so a test can run two against one database as two instances. */
type TransactionalClient = {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number }): Promise<T>;
};

/**
 * The hourly count in `import_suggestion_usage` (#1174, decision 12). Each call runs its own short
 * transaction as the user, outside any request transaction, and takes a per-user advisory lock so
 * two instances counting at once can't both take the tenth request.
 */
export class PrismaImportSuggestionUsage implements IImportSuggestionUsage {
  private readonly tracer = trace.getTracer('import-suggestion-usage');

  constructor(private readonly prisma: TransactionalClient) {}

  tryConsume(userId: string, now: Date, limit: number): Promise<{ allowed: true } | { allowed: false; retryAt: Date }> {
    return this.prisma.$transaction(
      async (tx) => {
        await setRlsUserContext(this.tracer, tx, userId);
        // Raw SQL isn't auto-traced (ADR-024).
        await this.tracer.startActiveSpan('import_suggestion_usage.lock', async (span) => {
          try {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USAGE_LOCK_CLASS}::int, hashtext(${userId}))`;
          } finally {
            span.end();
          }
        });
        const since = new Date(now.getTime() - HOUR_MS);
        await tx.importSuggestionUsage.deleteMany({ where: { userId, usedAt: { lte: since } } });
        const recent = await tx.importSuggestionUsage.findMany({
          where: { userId, usedAt: { gt: since } },
          orderBy: { usedAt: 'asc' },
          select: { usedAt: true },
        });
        const blocking = recent[recent.length - limit];
        if (blocking) return { allowed: false as const, retryAt: new Date(blocking.usedAt.getTime() + HOUR_MS) };
        await tx.importSuggestionUsage.create({ data: { userId, usedAt: now } });
        return { allowed: true as const };
      },
      { timeout: 5_000 },
    );
  }
}

/** The same count for the in-memory API, held per process. */
export class InMemoryImportSuggestionUsage implements IImportSuggestionUsage {
  private readonly used = new Map<string, Date[]>();

  async tryConsume(userId: string, now: Date, limit: number): Promise<{ allowed: true } | { allowed: false; retryAt: Date }> {
    const since = now.getTime() - HOUR_MS;
    const recent = (this.used.get(userId) ?? []).filter((d) => d.getTime() > since);
    const blocking = recent[recent.length - limit];
    if (blocking) {
      this.used.set(userId, recent);
      return { allowed: false, retryAt: new Date(blocking.getTime() + HOUR_MS) };
    }
    this.used.set(userId, [...recent, now]);
    return { allowed: true };
  }
}

export const importSuggestionUsageProvider: Provider = {
  provide: IMPORT_SUGGESTION_USAGE,
  useFactory: (prisma: PrismaService | null) =>
    prisma ? new PrismaImportSuggestionUsage(prisma) : new InMemoryImportSuggestionUsage(),
  inject: [{ token: PrismaService, optional: true }],
};
