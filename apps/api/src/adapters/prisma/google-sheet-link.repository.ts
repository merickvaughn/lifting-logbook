import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkInput,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
  MirrorLease,
} from '../../ports/IGoogleSheetLinkRepository';
import { PrismaExecutor } from './prisma-tx.util';

const tracer = trace.getTracer('prisma-google-sheet-link-repository');

export class PrismaGoogleSheetLinkRepository implements IGoogleSheetLinkRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
  ) {}

  async getLink(): Promise<GoogleSheetLinkRecord | null> {
    const row = await this.prisma.googleSheetLink.findUnique({ where: { userId: this.userId } });
    if (!row) return null;
    const { refreshTokenCiphertext: ciphertext, refreshTokenDekCiphertext: wrappedKey, refreshTokenNonce: nonce } = row;
    return {
      status: row.status,
      spreadsheetId: row.spreadsheetId,
      spreadsheetUrl: row.spreadsheetUrl,
      grantedScope: row.grantedScope,
      token:
        ciphertext && wrappedKey && nonce
          ? { ciphertext: Buffer.from(ciphertext), wrappedKey: Buffer.from(wrappedKey), nonce: Buffer.from(nonce) }
          : null,
      lastErrorCode: row.lastErrorCode,
      lastMirroredAt: row.lastMirroredAt,
      lastMirroredSeq: row.lastMirroredSeq,
    };
  }

  async saveLink(link: GoogleSheetLinkInput): Promise<void> {
    const data = {
      status: link.status,
      spreadsheetId: link.spreadsheetId,
      spreadsheetUrl: link.spreadsheetUrl,
      grantedScope: link.grantedScope,
      refreshTokenCiphertext: link.token?.ciphertext ?? null,
      refreshTokenDekCiphertext: link.token?.wrappedKey ?? null,
      refreshTokenNonce: link.token?.nonce ?? null,
      lastErrorCode: link.lastErrorCode,
    };
    const stored = await this.prisma.googleSheetLink.findUnique({
      where: { userId: this.userId },
      select: { spreadsheetId: true },
    });
    // A new spreadsheet holds nothing the mirror wrote, so its history starts over (decision 19).
    const newSheet = stored !== null && stored.spreadsheetId !== link.spreadsheetId;
    await this.prisma.googleSheetLink.upsert({
      where: { userId: this.userId },
      create: { userId: this.userId, ...data },
      update: newSheet ? { ...data, lastMirroredAt: null, lastMirroredSeq: null, mirrorLeaseUntil: null } : data,
    });
  }

  async deleteLink(): Promise<void> {
    await this.prisma.googleSheetLink.deleteMany({ where: { userId: this.userId } });
  }

  /**
   * Decision 19's UPDATE, by the database's clock so app instances with drifting clocks agree on
   * when a lease expires. The column is `timestamp(3)` in UTC, as Prisma writes it, hence
   * `timezone('UTC', now())`; RETURNING gives the stored value, which the run's later writes
   * compare exactly. Raw SQL isn't auto-traced (ADR-024), hence the span.
   */
  async takeMirrorLease(spreadsheetId: string): Promise<MirrorLease | null> {
    return tracer.startActiveSpan('google_sheet_link.take_mirror_lease', async (span) => {
      try {
        const rows = await this.prisma.$queryRaw<{ until: Date }[]>`
          UPDATE "google_sheet_link"
          SET "mirrorLeaseUntil" = timezone('UTC', now()) + interval '5 minutes', "updatedAt" = timezone('UTC', now())
          WHERE "userId" = ${this.userId}
            AND "spreadsheetId" = ${spreadsheetId}
            AND ("mirrorLeaseUntil" IS NULL OR "mirrorLeaseUntil" < timezone('UTC', now()))
          RETURNING "mirrorLeaseUntil" AS until`;
        const until = rows[0]?.until;
        span.setAttribute('lease.taken', until !== undefined);
        return until === undefined ? null : { spreadsheetId, until };
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.name : 'unknown' });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** The rows that still hold `lease`: none once the lifter unlinked, linked another sheet, or another run took it. */
  private held(lease: MirrorLease) {
    return { userId: this.userId, spreadsheetId: lease.spreadsheetId, mirrorLeaseUntil: lease.until };
  }

  async releaseMirrorLease(lease: MirrorLease, errorCode?: string): Promise<void> {
    await this.prisma.googleSheetLink.updateMany({
      where: this.held(lease),
      data: { mirrorLeaseUntil: null, ...(errorCode !== undefined && { lastErrorCode: errorCode }) },
    });
  }

  async recordMirrored(lease: MirrorLease, seq: number): Promise<boolean> {
    const { count } = await this.prisma.googleSheetLink.updateMany({
      where: { ...this.held(lease), OR: [{ lastMirroredSeq: null }, { lastMirroredSeq: { lte: seq } }] },
      data: { lastMirroredSeq: seq, lastMirroredAt: new Date(), lastErrorCode: null, mirrorLeaseUntil: null },
    });
    if (count > 0) return true;
    // A later seq is already recorded: keep it, and only let the lease go.
    const released = await this.prisma.googleSheetLink.updateMany({ where: this.held(lease), data: { mirrorLeaseUntil: null } });
    return released.count > 0;
  }

  async markNeedsRelink(spreadsheetId: string, tokenNonce: Buffer): Promise<void> {
    await this.prisma.googleSheetLink.updateMany({
      where: { userId: this.userId, spreadsheetId, refreshTokenNonce: { equals: tokenNonce } },
      data: {
        status: 'needs_relink',
        refreshTokenCiphertext: null,
        refreshTokenDekCiphertext: null,
        refreshTokenNonce: null,
        lastErrorCode: 'invalid_grant',
      },
    });
  }

  async markSheetMissing(spreadsheetId: string): Promise<void> {
    await this.prisma.googleSheetLink.updateMany({
      where: { userId: this.userId, spreadsheetId, status: 'linked' },
      data: { status: 'sheet_missing', lastErrorCode: 'sheet_missing' },
    });
  }

  async putOauthRequest(request: GoogleOauthRequestRecord): Promise<void> {
    await this.prisma.googleOauthRequest.upsert({
      where: { userId: this.userId },
      create: { userId: this.userId, ...request },
      update: request,
    });
  }

  async takeOauthRequest(): Promise<GoogleOauthRequestRecord | null> {
    const row = await this.prisma.googleOauthRequest.findUnique({ where: { userId: this.userId } });
    if (!row) return null;
    // A concurrent callback that deleted it first took it: this one gets nothing (decision 5).
    const { count } = await this.prisma.googleOauthRequest.deleteMany({ where: { userId: this.userId } });
    if (count === 0) return null;
    return { stateHash: Buffer.from(row.stateHash), codeVerifier: row.codeVerifier, expiresAt: row.expiresAt };
  }
}
