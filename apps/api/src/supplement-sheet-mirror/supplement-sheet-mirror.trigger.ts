import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { runAfterCommit } from '../adapters/prisma/after-commit';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { GoogleSheetLinkRecord, IGoogleSheetLinkRepository } from '../ports/IGoogleSheetLinkRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CloudTasksError, ISheetMirrorQueue, MirrorTaskKind, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

type Outcome = 'enqueued' | 'no_link' | 'failed';

const fail = (status: HttpStatus, error: string, message: string) =>
  new HttpException({ statusCode: status, error, message }, status);

/**
 * Enqueues the supplement sheet mirror (#1444, ADR-047 decisions 16, 17, 22, 24). Nothing is sent
 * until a `linked` row exists. Spans and logs carry the outcome, the Cloud Tasks status and reason,
 * the last mirrored `seq` and the link's status, and never the error's message (which could echo a
 * request), a token, the spreadsheet ID or URL, or a cell value.
 */
@Injectable()
export class SupplementSheetMirrorTrigger {
  private readonly logger = new Logger(SupplementSheetMirrorTrigger.name);
  private readonly tracer = trace.getTracer('supplement-sheet-mirror');

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rls: RlsContextService,
    private readonly cls: ClsService,
    @Inject(SHEET_MIRROR_QUEUE) private readonly queue: ISheetMirrorQueue,
  ) {}

  /**
   * Enqueues one run if the link read says the user has a `linked` row. Returns the outcome and
   * never throws, so a failure here can't change what the caller answers.
   */
  private enqueue(user: AuthUser, kind: MirrorTaskKind, readLink: () => Promise<GoogleSheetLinkRecord | null>) {
    return this.tracer.startActiveSpan('sheet_mirror.enqueue', async (span) => {
      const record: {
        outcome?: Outcome;
        kind: MirrorTaskKind;
        linkStatus?: string;
        lastMirroredSeq?: number;
        status?: number;
        reason?: string;
        error?: string;
      } = { kind };
      try {
        const link = await readLink();
        record.linkStatus = link?.status ?? 'unlinked';
        if (link?.lastMirroredSeq != null) record.lastMirroredSeq = link.lastMirroredSeq;
        if (link?.status !== 'linked') {
          record.outcome = 'no_link';
          return record;
        }
        await this.queue.enqueue(user.id, new Date(), kind);
        record.outcome = 'enqueued';
        return record;
      } catch (err) {
        record.outcome = 'failed';
        if (err instanceof CloudTasksError) {
          record.status = err.status;
          // Google's `error.status` enum, never its message (decision 24).
          if (err.reason !== undefined) record.reason = err.reason;
        }
        record.error = err instanceof Error ? err.name : 'unknown';
        // The write already committed and the next change, or Sync now, enqueues again.
        // fallback-covered-by: apps/api/src/supplement-sheet-mirror/supplement-sheet-mirror.trigger.e2e.spec.ts
        this.logger.warn({ operation: 'sheet_mirror.enqueue', ...record }, 'Supplement sheet mirror run not enqueued (#1444)');
        span.setStatus({ code: SpanStatusCode.ERROR });
        return record;
      } finally {
        span.setAttributes({
          'sheet_mirror.kind': record.kind,
          'sheet_mirror.outcome': record.outcome ?? 'unknown',
          ...(record.linkStatus !== undefined && { 'sheet_mirror.link_status': record.linkStatus }),
          ...(record.lastMirroredSeq !== undefined && { 'sheet_mirror.last_mirrored_seq': record.lastMirroredSeq }),
          ...(record.status !== undefined && { 'sheet_mirror.google_status': record.status }),
          ...(record.reason !== undefined && { 'sheet_mirror.google_reason': record.reason }),
          ...(record.error !== undefined && { 'sheet_mirror.error': record.error }),
        });
        span.end();
      }
    });
  }

  /**
   * Called inside a supplement write's own transaction once it logged a change (decision 16). The
   * link is read there, so an unlinked user pays one indexed read in a transaction that's already
   * open; only a linked user registers the enqueue, which runs once the transaction commits.
   */
  async afterWrite(user: AuthUser, links: IGoogleSheetLinkRepository): Promise<void> {
    const link = await links.getLink();
    if (link?.status !== 'linked') return;
    runAfterCommit(this.cls, () => this.enqueue(user, 'change', async () => link));
  }

  /** Sync now: 409 when nothing is linked, 502 when the queue refused (the lifter can press it again). */
  async syncNow(user: AuthUser): Promise<{ queued: true }> {
    const { outcome } = await this.enqueue(user, 'sync', () =>
      this.rls.withUserContext(async () => (await this.factory.forUser(user)).googleSheetLink.getLink()),
    );
    if (outcome === 'no_link') throw fail(HttpStatus.CONFLICT, 'google-sheet-not-linked', 'No Google Sheet is linked.');
    if (outcome === 'failed') throw fail(HttpStatus.BAD_GATEWAY, 'sheet-mirror-enqueue-failed', 'The sync could not be started.');
    return { queued: true };
  }
}
