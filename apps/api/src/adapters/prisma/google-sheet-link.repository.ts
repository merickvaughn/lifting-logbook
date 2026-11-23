import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
} from '../../ports/IGoogleSheetLinkRepository';
import { PrismaExecutor } from './prisma-tx.util';

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
      lastErrorCode: null,
    };
    await this.prisma.googleSheetLink.upsert({
      where: { userId: this.userId },
      create: { userId: this.userId, ...data },
      update: data,
    });
  }

  async deleteLink(): Promise<void> {
    await this.prisma.googleSheetLink.deleteMany({ where: { userId: this.userId } });
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
    await this.prisma.googleOauthRequest.deleteMany({ where: { userId: this.userId } });
    return { stateHash: Buffer.from(row.stateHash), codeVerifier: row.codeVerifier, expiresAt: row.expiresAt };
  }
}
