import { CallHandler, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { Observable, tap } from 'rxjs';
import { RLS_USER_ID_KEY } from '../adapters/prisma/rls-context';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { GoogleSheetLinkRecord } from '../ports/IGoogleSheetLinkRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CloudTasksError, ISheetMirrorQueue, MirrorTaskKind, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

type Outcome = 'enqueued' | 'no_link' | 'failed';

const fail = (status: HttpStatus, error: string, message: string) =>
  new HttpException({ statusCode: status, error, message }, status);

/**
 * Enqueues the supplement sheet mirror (#1444, ADR-047 decisions 16, 17, 22, 24). Nothing is sent
 * until a `linked` row exists. Spans and logs carry the outcome, the Cloud Tasks status, the last
 * mirrored `seq` and the link's status, and never the error's message (which could echo a
 * request), a token, the spreadsheet ID or URL, or a cell value.
 */
@Injectable()
export class SupplementSheetMirrorTrigger {
  private readonly logger = new Logger(SupplementSheetMirrorTrigger.name);
  private readonly tracer = trace.getTracer('supplement-sheet-mirror');
  /** The users whose request logged a change, by the request's own `AuthUser` object. */
  private readonly written = new WeakSet<AuthUser>();

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rls: RlsContextService,
    private readonly cls: ClsService,
    @Inject(SHEET_MIRROR_QUEUE) private readonly queue: ISheetMirrorQueue,
  ) {}

  /** A supplement write logged a change; the interceptor enqueues once the request has committed. */
  noteWrite(user: AuthUser): void {
    this.written.add(user);
  }

  takeWrite(user: AuthUser | undefined): boolean {
    return user !== undefined && this.written.delete(user);
  }

  /** The link, read in a short transaction of its own, with the user's context set outside a request. */
  private readLink(user: AuthUser): Promise<GoogleSheetLinkRecord | null> {
    return this.cls.run(() => {
      this.cls.set(RLS_USER_ID_KEY, user.id);
      return this.rls.withUserContext(async () => (await this.factory.forUser(user)).googleSheetLink.getLink());
    });
  }

  /**
   * Enqueues one run if the user has a `linked` row. Returns the outcome and never throws, so a
   * failure here can't change what the caller answers.
   */
  private enqueue(user: AuthUser, kind: MirrorTaskKind): Promise<Outcome> {
    return this.tracer.startActiveSpan('sheet_mirror.enqueue', async (span) => {
      const record: { outcome?: Outcome; kind: MirrorTaskKind; linkStatus?: string; seq?: number; status?: number; reason?: string } = { kind };
      try {
        const link = await this.readLink(user);
        record.linkStatus = link?.status ?? 'unlinked';
        if (link?.lastMirroredSeq != null) record.seq = link.lastMirroredSeq;
        if (link?.status !== 'linked') {
          record.outcome = 'no_link';
          return 'no_link';
        }
        await this.queue.enqueue(user.id, new Date(), kind);
        record.outcome = 'enqueued';
        return 'enqueued';
      } catch (err) {
        record.outcome = 'failed';
        if (err instanceof CloudTasksError) record.status = err.status;
        record.reason = err instanceof Error ? err.name : 'unknown';
        // The write already committed and the next change, or Sync now, enqueues again.
        // fallback-covered-by: apps/api/src/supplement-sheet-mirror/supplement-sheet-mirror.e2e.spec.ts
        this.logger.warn({ operation: 'sheet_mirror.enqueue', ...record }, 'Supplement sheet mirror run not enqueued (#1444)');
        span.setStatus({ code: SpanStatusCode.ERROR });
        return 'failed';
      } finally {
        span.setAttributes({
          'sheet_mirror.kind': record.kind,
          'sheet_mirror.outcome': record.outcome ?? 'unknown',
          ...(record.linkStatus !== undefined && { 'sheet_mirror.link_status': record.linkStatus }),
          ...(record.seq !== undefined && { 'sheet_mirror.seq': record.seq }),
          ...(record.status !== undefined && { 'sheet_mirror.google_status': record.status }),
          ...(record.reason !== undefined && { 'sheet_mirror.google_reason': record.reason }),
        });
        span.end();
      }
    });
  }

  /** After a committed supplement write (decision 16). Nothing awaits it. */
  afterWrite(user: AuthUser): void {
    void this.enqueue(user, 'change');
  }

  /** Sync now: 409 when nothing is linked, 502 when the queue refused (the lifter can press it again). */
  async syncNow(user: AuthUser): Promise<{ queued: true }> {
    const outcome = await this.enqueue(user, 'sync');
    if (outcome === 'no_link') throw fail(HttpStatus.CONFLICT, 'google-sheet-not-linked', 'No Google Sheet is linked.');
    if (outcome === 'failed') throw fail(HttpStatus.BAD_GATEWAY, 'sheet-mirror-enqueue-failed', 'The sync could not be started.');
    return { queued: true };
  }
}

/**
 * Enqueues once a supplement write's response is on its way. The per-request RLS transaction is
 * outside this interceptor, so it has committed by the time the response ends; a rolled-back
 * request ends with an error status and enqueues nothing.
 */
@Injectable()
export class SheetMirrorAfterWriteInterceptor implements NestInterceptor {
  constructor(private readonly trigger: SupplementSheetMirrorTrigger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const user = http.getRequest<{ user?: AuthUser }>().user;
    const reply = http.getResponse<{ raw: { statusCode: number; once(event: 'finish', cb: () => void): void } }>();
    return next.handle().pipe(
      tap({
        complete: () => {
          if (!this.trigger.takeWrite(user)) return;
          reply.raw.once('finish', () => {
            if (reply.raw.statusCode < 400 && user) this.trigger.afterWrite(user);
          });
        },
      }),
    );
  }
}
