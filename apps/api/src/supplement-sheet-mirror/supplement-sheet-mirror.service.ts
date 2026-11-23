import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import {
  GOOGLE_SHEET_CLIENT,
  GOOGLE_TOKEN_CIPHER,
} from '../google-sheet/google-sheet.service';
import {
  GoogleApiError,
  IGoogleSheetClient,
  OAuthClientCredentials,
  isSheetMissing,
  isTransientGoogleError,
} from '../google-sheet/google-sheet.client';
import { TokenCipher } from '../google-sheet/token-cipher';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { GoogleSheetLinkRecord, MirrorLease } from '../ports/IGoogleSheetLinkRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { ISheetMirrorQueue, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';
import { HISTORY_TAB, SUPPLEMENTS_TAB, historyRows, mirrorRequests, supplementsRows } from './sheet-tabs';

/** The queue's `max-attempts` (decision 15). */
const MAX_ATTEMPTS = 8;
/** `attempt` is `X-CloudTasks-TaskRetryCount`, 0 on the first attempt, so 7 is the eighth and last. */
const isLastAttempt = (attempt: number) => attempt + 1 >= MAX_ATTEMPTS;
/**
 * The transaction that reads the stack and the whole change log, which grows without bound (the
 * History tab holds one row per change, decision 20), so it gets longer than the 5 s default.
 */
const SNAPSHOT_TX_TIMEOUT_MS = 20_000;

type Outcome =
  | 'success'
  | 'no_link'
  | 'lease_held'
  | 'lease_lost'
  | 'needs_relink'
  | 'sheet_missing'
  | 'google_rejected'
  | 'retry_google'
  | 'retry_internal';

/** What a run logs and records on its span (decision 24): outcomes and counts, never contents. */
interface RunRecord {
  outcome?: Outcome;
  attempt: number;
  linkStatus?: string;
  googleStatus?: number;
  googleReason?: string;
  supplementRows?: number;
  historyRows?: number;
  seq?: number;
}

const fail = (status: HttpStatus, error: string, message: string) =>
  new HttpException({ statusCode: status, error, message }, status);

/**
 * One run of the supplement sheet mirror (#1443, ADR-047 decisions 15-25): takes the lease, reads
 * the stack and change log, writes both tabs in one batchUpdate, and records what it wrote. Each
 * database step is its own short RLS transaction, and Google and KMS are called between them, so
 * no connection is held across a network call.
 */
@Injectable()
export class SupplementSheetMirrorService {
  private readonly logger = new Logger(SupplementSheetMirrorService.name);
  private readonly tracer = trace.getTracer('supplement-sheet-mirror');

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rls: RlsContextService,
    @Inject(GOOGLE_SHEET_CLIENT) private readonly google: IGoogleSheetClient,
    @Inject(GOOGLE_TOKEN_CIPHER) private readonly cipher: TokenCipher,
    @Inject(SHEET_MIRROR_QUEUE) private readonly queue: ISheetMirrorQueue,
  ) {}

  private db<T>(user: AuthUser, fn: (repos: RepositoryBundle) => Promise<T>, timeoutMs?: number): Promise<T> {
    return this.rls.withUserContext(async () => fn(await this.factory.forUser(user)), timeoutMs);
  }

  /** Resolves for a 204, and throws the HttpException Cloud Tasks acts on otherwise (decision 21). */
  run(user: AuthUser, attempt: number): Promise<void> {
    return this.tracer.startActiveSpan('sheet_mirror.run', async (span) => {
      const record: RunRecord = { attempt };
      try {
        await this.mirror(user, record);
      } catch (err) {
        record.outcome ??= 'retry_internal';
        // A held lease is expected contention, not a failure, whatever the attempt (decision 21).
        if (record.outcome === 'lease_held') {
          this.logger.log({ operation: 'sheet_mirror.run', ...record }, 'Supplement sheet mirror: another run holds the lease (#1443)');
        } else {
          this.logFailure(record);
          // The last attempt ends the task itself: Cloud Tasks keeps retrying until both
          // `max-attempts` and `max-retry-duration` (24 h) are reached, so a 5xx here would bring
          // retries, each logged at error, for hours after the code was stored (decision 21).
          if (isLastAttempt(record.attempt) && record.outcome.startsWith('retry')) return;
        }
        throw err instanceof HttpException ? err : fail(HttpStatus.SERVICE_UNAVAILABLE, 'sheet-mirror-failed', 'The mirror run failed.');
      } finally {
        this.finish(span, record);
      }
    });
  }

  private finish(span: Span, r: RunRecord) {
    span.setAttributes({
      'sheet_mirror.outcome': r.outcome ?? 'unknown',
      'sheet_mirror.attempt': r.attempt,
      ...(r.linkStatus !== undefined && { 'sheet_mirror.link_status': r.linkStatus }),
      ...(r.googleStatus !== undefined && { 'sheet_mirror.google_status': r.googleStatus }),
      ...(r.googleReason !== undefined && { 'sheet_mirror.google_reason': r.googleReason }),
      ...(r.supplementRows !== undefined && { 'sheet_mirror.rows.supplements': r.supplementRows }),
      ...(r.historyRows !== undefined && { 'sheet_mirror.rows.history': r.historyRows }),
      ...(r.seq !== undefined && { 'sheet_mirror.seq': r.seq }),
    });
    if (r.outcome?.startsWith('retry')) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }

  /** `warn` while Cloud Tasks will retry, `error` once retries run out (decision 24). */
  private logFailure(r: RunRecord) {
    this.logger[isLastAttempt(r.attempt) ? 'error' : 'warn']({ operation: 'sheet_mirror.run', ...r }, 'Supplement sheet mirror run failed (#1443)');
  }

  private async mirror(user: AuthUser, record: RunRecord): Promise<void> {
    const link = await this.db(user, (r) => r.googleSheetLink.getLink());
    record.linkStatus = link?.status ?? 'unlinked';
    // Nothing to mirror to, or no token to do it with: an unlink or a terminal state (decisions 10-12).
    if (!link || link.status !== 'linked' || !link.token) {
      record.outcome = 'no_link';
      return;
    }
    const token = link.token;
    const lease = await this.db(user, (r) => r.googleSheetLink.takeMirrorLease(link.spreadsheetId));
    if (!lease) {
      record.outcome = 'lease_held';
      throw fail(HttpStatus.CONFLICT, 'sheet-mirror-lease-held', 'Another run holds the lease.');
    }

    try {
      const snapshot = await this.db(
        user,
        async (r) => {
          const state = await r.supplement.load();
          return { state, changes: await r.supplement.allChanges() };
        },
        SNAPSHOT_TX_TIMEOUT_MS,
      );
      const seq = snapshot.state.nextSeq - 1;
      const supplements = supplementsRows(snapshot.state);
      const history = historyRows(snapshot.changes);
      record.seq = seq;
      record.supplementRows = supplements.length - 1;
      record.historyRows = history.length - 1;

      const refreshToken = await this.cipher.decrypt(user.id, token);
      const accessToken = await this.google.refreshAccessToken(this.credentials(), refreshToken);
      const tabs = await this.google.listTabs(accessToken, link.spreadsheetId);
      await this.google.batchUpdate(
        accessToken,
        link.spreadsheetId,
        mirrorRequests(tabs, [
          { title: SUPPLEMENTS_TAB, rows: supplements },
          { title: HISTORY_TAB, rows: history },
        ]),
      );

      // Records only while the row still holds this run's lease: an unlink, a link to another
      // sheet or an expired lease another run took since means this run's write is not the record.
      const { recorded, latest } = await this.db(user, async (r) => ({
        recorded: await r.googleSheetLink.recordMirrored(lease, seq),
        latest: (await r.supplement.load()).nextSeq - 1,
      }));
      record.outcome = recorded ? 'success' : 'lease_lost';
      if (recorded && latest > seq) await this.enqueueFollowUp(user.id);
    } catch (err) {
      await this.handle(user, link, lease, err, record);
    }
  }

  private credentials(): OAuthClientCredentials {
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
    };
  }

  /** The seq moved on while the run wrote, so one more run catches it up (decision 19). */
  private async enqueueFollowUp(userId: string) {
    try {
      await this.queue.enqueue(userId);
    } catch (err) {
      // The run itself succeeded; the next change, or Sync now, enqueues again.
      // fallback-covered-by: apps/api/src/supplement-sheet-mirror/supplement-sheet-mirror.e2e.spec.ts
      this.logger.warn({ operation: 'sheet_mirror.follow_up', reason: err instanceof Error ? err.name : 'unknown' }, 'Supplement sheet mirror follow-up not enqueued (#1443)');
    }
  }

  /**
   * Maps a failure to its outcome (decisions 11, 12, 21) and settles the lease. Returns for the
   * terminal states, which answer 204, and throws for the ones Cloud Tasks retries.
   */
  private async handle(user: AuthUser, link: GoogleSheetLinkRecord, lease: MirrorLease, err: unknown, record: RunRecord): Promise<void> {
    if (err instanceof GoogleApiError) {
      record.googleStatus = err.status;
      record.googleReason = err.reason;
    }
    if (err instanceof HttpException) throw err;

    if (err instanceof GoogleApiError && !isTransientGoogleError(err)) {
      // The grant is gone: delete the ciphertext and ask the lifter to link again (decision 11).
      // Conditional writes only, so an unlink or a new link made during the run stays as it is.
      if (err.reason === 'invalid_grant' && link.token) {
        const nonce = link.token.nonce;
        record.outcome = 'needs_relink';
        await this.db(user, async (r) => {
          await r.googleSheetLink.markNeedsRelink(lease.spreadsheetId, nonce);
          await r.googleSheetLink.releaseMirrorLease(lease);
        });
        this.logger.error({ operation: 'sheet_mirror.run', ...record }, 'Supplement sheet mirror: Google access was removed (#1443)');
        return;
      }
      // The sheet was deleted or is out of the grant's reach (decision 12).
      if (isSheetMissing(err)) {
        record.outcome = 'sheet_missing';
        await this.db(user, async (r) => {
          await r.googleSheetLink.markSheetMissing(lease.spreadsheetId);
          await r.googleSheetLink.releaseMirrorLease(lease);
        });
        this.logger.error({ operation: 'sheet_mirror.run', ...record }, 'Supplement sheet mirror: the sheet is missing (#1443)');
        return;
      }
      // Any other 4xx but a 408 rejects the request itself, which a retry would send unchanged, so
      // it is terminal too (decision 21): the code stays on the link for Settings to show.
      if (err.status >= 400 && err.status < 500 && err.status !== 408) {
        record.outcome = 'google_rejected';
        const code = `google_${err.status}`;
        await this.db(user, (r) => r.googleSheetLink.releaseMirrorLease(lease, code));
        this.logger.error({ operation: 'sheet_mirror.run', ...record }, 'Supplement sheet mirror: Google rejected the write (#1443)');
        return;
      }
    }

    // A Google 408, 429 or 5xx, a quota 403, a KMS or database failure or a timeout: Cloud Tasks retries.
    record.outcome = err instanceof GoogleApiError ? 'retry_google' : 'retry_internal';
    // The code is recorded on the last attempt, which answers 204 so Cloud Tasks stops, and Settings
    // shows "Last sync failed" (decision 21).
    const code = isLastAttempt(record.attempt) ? (err instanceof GoogleApiError ? `google_${err.status}` : 'mirror_failed') : undefined;
    // allow-skewed: best effort; the run's own error is what's thrown, and a lease that isn't released expires after five minutes.
    await this.db(user, (r) => r.googleSheetLink.releaseMirrorLease(lease, code)).catch(() => undefined);
    throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'sheet-mirror-failed', 'The mirror run failed and will be retried.');
  }
}
