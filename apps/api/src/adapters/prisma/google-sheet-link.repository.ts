import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
} from '../../ports/IGoogleSheetLinkRepository';
import { PrismaExecutor } from './prisma-tx.util';

/** ADR-047, decision 19: a run that dies without releasing its lease frees it after this. */
const MIRROR_LEASE_MS = 2 * 60_000;

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
    };
  }

  async saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void> {
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

  async takeMirrorLease(): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.googleSheetLink.updateMany({
      where: { userId: this.userId, OR: [{ mirrorLeaseUntil: null }, { mirrorLeaseUntil: { lt: now } }] },
      data: { mirrorLeaseUntil: new Date(now.getTime() + MIRROR_LEASE_MS) },
    });
    return count > 0;
  }

  async releaseMirrorLease(errorCode?: string): Promise<void> {
    await this.prisma.googleSheetLink.updateMany({
      where: { userId: this.userId },
      data: { mirrorLeaseUntil: null, ...(errorCode !== undefined && { lastErrorCode: errorCode }) },
    });
  }

  async recordMirrored(seq: number): Promise<void> {
    await this.prisma.googleSheetLink.updateMany({
      where: { userId: this.userId },
      data: { lastMirroredSeq: seq, lastMirroredAt: new Date(), lastErrorCode: null, mirrorLeaseUntil: null },
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
