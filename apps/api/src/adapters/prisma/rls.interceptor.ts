import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Observable, defaultIfEmpty, from, lastValueFrom } from 'rxjs';
import { PrismaService } from './prisma.service';
import {
  DEFAULT_RLS_TX_TIMEOUT_MS,
  RLS_SKIP_TX,
  RLS_TX_CLIENT,
  RLS_TX_TIMEOUT_KEY,
  RLS_USER_ID_KEY,
  setRlsUserContext,
} from './rls-context';

/**
 * Establishes the per-request Postgres Row-Level Security context (issue #511).
 *
 * For every authenticated HTTP request that reaches the Prisma-backed factory, it opens one
 * interactive transaction, sets the `app.current_user_id` GUC (a SET LOCAL, via `set_config`) so
 * RLS policies resolve to the caller, and stores the transaction client in CLS so
 * PrismaRepositoryFactory routes every repository query through it. The GUC is transaction-local,
 * which is why all of a request's DB work shares a single transaction.
 *
 * No-ops when there is no Prisma client AND no DATABASE_URL configured (in-memory / SystemDb
 * factories), or when there is no authenticated user (public routes such as /health and /readyz).
 * Those run on the base client with no GUC — which is fail-closed for any userId-scoped table
 * (zero rows) and harmless for the table-less probes.
 *
 * If DATABASE_URL IS configured but the Prisma client still can't be resolved, that's broken DI
 * plumbing (issue #644), not a legitimate no-DB environment — silently falling through here
 * produces "empty reads / rejected writes" symptoms indistinguishable from "this user has no data
 * yet," which is why #644 went undiagnosed for weeks. This throws InternalServerErrorException
 * instead of no-op'ing in that case (issue #649) — deliberately including unauthenticated routes
 * like /health and /readyz, since a deployment with broken RLS plumbing should fail its readiness
 * probe and stop receiving traffic rather than report healthy while every real endpoint silently
 * drops RLS.
 *
 * PrismaService is resolved lazily via ModuleRef on every request rather than constructor-injected.
 * RlsInterceptor is bound via APP_INTERCEPTOR, which Nest instantiates as part of its early
 * global-enhancer setup — before PrismaService's useFactory provider (declared in the same module)
 * is guaranteed to have run. A constructor-injected `@Optional() PrismaService` captured that
 * premature `null` permanently (RlsInterceptor is a singleton), silently disabling the RLS
 * transaction — and therefore the `app.current_user_id` GUC — for the lifetime of the process. See
 * issue #644.
 *
 * The resolution is cached after the first non-null lookup: PrismaService, once resolved, is a
 * singleton that cannot become unavailable again for the process's lifetime, so paying for a
 * `strict: false` module-graph search on every request — including unauthenticated /health and
 * /readyz probe traffic — would be pure repeated overhead.
 */
@Injectable()
export class RlsInterceptor implements NestInterceptor {
  private readonly tracer = trace.getTracer('rls-interceptor');
  private cachedPrisma: PrismaService | null = null;

  constructor(
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const prisma = this.cachedPrisma ?? this.moduleRef.get(PrismaService, { strict: false });
    if (prisma) {
      this.cachedPrisma = prisma;
    }
    // Only the HTTP path is RLS-wired today; `apps/api` exposes no GraphQL resolvers
    // (no GraphQLModule). If GraphQL resolvers touching userId tables are ever added, this guard
    // must be broadened to the 'graphql' context type — otherwise those queries skip the GUC and
    // fail closed (zero rows) under lifting_app rather than scoping correctly. See issue #511.
    if (context.getType() !== 'http') {
      return next.handle();
    }
    if (!prisma) {
      if (this.isDatabaseUrlConfigured()) {
        // A real Postgres connection is configured but the Prisma client still couldn't be
        // resolved from the module graph — the broken-plumbing case from issue #644, not the
        // legitimate in-memory/SystemDb no-op. Fail loudly rather than silently running this
        // request with no RLS GUC set (issue #649). The client-facing message stays generic —
        // the diagnostic detail (which env signal was involved) lives in `cause` instead, so it
        // reaches server-side logs/traces (via the existing Pino/OTel auto-instrumentation) without
        // also being echoed back in the HTTP response body, since no global filter in main.ts
        // redacts InternalServerErrorException messages before they reach the client.
        throw new InternalServerErrorException('RLS context could not be established for this request.', {
          cause: new Error(
            'RlsInterceptor could not resolve PrismaService even though DATABASE_URL is configured.',
          ),
        });
      }
      return next.handle();
    }
    // routerPath is the Fastify property for the matched route pattern (e.g. /programs/:id).
    // request.url is the full URL with query params — used as fallback only.
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { id?: string }; routerPath?: string; url?: string }>();
    const userId = request?.user?.id;
    if (!userId) {
      return next.handle();
    }

    // `@SkipRlsTransaction()` handlers opt out of the per-request transaction (e.g. macrocycle-plan,
    // which calls an LLM between DB reads). The userId is stashed in CLS so RlsContextService can
    // open a short-lived transaction per DB operation instead of pinning a connection for the
    // whole request. See issue #518.
    const skipTx =
      this.reflector.getAllAndOverride<boolean>(RLS_SKIP_TX, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (skipTx) {
      return from(
        this.cls.run(() => {
          this.cls.set(RLS_USER_ID_KEY, userId);
          return lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)));
        }),
      );
    }

    const timeoutMs =
      this.reflector.getAllAndOverride<number>(RLS_TX_TIMEOUT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_RLS_TX_TIMEOUT_MS;

    const route = request?.routerPath ?? request?.url ?? 'unknown';
    return from(this.cls.run(() => this.runWithRlsContext(prisma, userId, timeoutMs, route, next)));
  }

  // Split out so unit tests can stub the "DB expected" signal without needing a real DATABASE_URL —
  // jest.env.setup.js's Proxy discards writes to it outside the Testcontainers sentinel.
  private isDatabaseUrlConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
  }

  private runWithRlsContext(
    prisma: PrismaService,
    userId: string,
    timeoutMs: number,
    route: string,
    next: CallHandler,
  ): Promise<unknown> {
    return this.tracer.startActiveSpan('rls.transaction', async (span) => {
      span.setAttribute('rls.userId', userId);
      span.setAttribute('rls.route', route);
      try {
        return await prisma.$transaction(
          async (tx) => {
            await setRlsUserContext(this.tracer, tx, userId);
            this.cls.set(RLS_TX_CLIENT, tx);
            return lastValueFrom(next.handle().pipe(defaultIfEmpty(undefined)));
          },
          { timeout: timeoutMs },
        );
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2028') {
          span.setAttribute('rls.transaction.timeout', true);
        }
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
