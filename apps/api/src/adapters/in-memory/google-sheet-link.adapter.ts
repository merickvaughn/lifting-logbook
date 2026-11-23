import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkInput,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
  MirrorLease,
} from '../../ports/IGoogleSheetLinkRepository';
import { StoredRow } from '../../ports/IUserDataExportRepository';

/** ADR-047, decision 19, as the Prisma repository sets it. */
const MIRROR_LEASE_MS = 5 * 60_000;

export class InMemoryGoogleSheetLinkRepository implements IGoogleSheetLinkRepository {
  private link: (GoogleSheetLinkRecord & { createdAt: Date; leaseUntil?: Date }) | null = null;
  private request: GoogleOauthRequestRecord | null = null;

  async getLink(): Promise<GoogleSheetLinkRecord | null> {
    if (!this.link) return null;
    const { createdAt: _createdAt, leaseUntil: _leaseUntil, ...link } = this.link;
    return link;
  }

  async saveLink(link: GoogleSheetLinkInput): Promise<void> {
    // As google_sheet_link_token_check does: a token exactly when the status can use one.
    if ((link.status === 'needs_relink') !== (link.token === null)) {
      throw new Error(`google_sheet_link_token_check: status ${link.status} with${link.token ? '' : 'out'} a token`);
    }
    const sameSheet = this.link?.spreadsheetId === link.spreadsheetId;
    this.link = {
      status: link.status,
      spreadsheetId: link.spreadsheetId,
      spreadsheetUrl: link.spreadsheetUrl,
      grantedScope: link.grantedScope,
      token: link.token,
      lastErrorCode: link.lastErrorCode,
      lastMirroredAt: sameSheet ? (this.link?.lastMirroredAt ?? null) : null,
      lastMirroredSeq: sameSheet ? (this.link?.lastMirroredSeq ?? null) : null,
      createdAt: this.link?.createdAt ?? new Date(),
      ...(sameSheet && this.link?.leaseUntil && { leaseUntil: this.link.leaseUntil }),
    };
  }

  async deleteLink(): Promise<void> {
    this.link = null;
  }

  /** The row, while it still holds `lease`. */
  private held(lease: MirrorLease) {
    const link = this.link;
    if (!link || link.spreadsheetId !== lease.spreadsheetId || link.leaseUntil?.getTime() !== lease.until.getTime()) return null;
    return link;
  }

  async takeMirrorLease(spreadsheetId: string): Promise<MirrorLease | null> {
    const link = this.link;
    if (!link || link.spreadsheetId !== spreadsheetId) return null;
    if (link.leaseUntil && link.leaseUntil.getTime() > Date.now()) return null;
    link.leaseUntil = new Date(Date.now() + MIRROR_LEASE_MS);
    return { spreadsheetId, until: link.leaseUntil };
  }

  async releaseMirrorLease(lease: MirrorLease, errorCode?: string): Promise<void> {
    const link = this.held(lease);
    if (!link) return;
    delete link.leaseUntil;
    if (errorCode !== undefined) link.lastErrorCode = errorCode;
  }

  async recordMirrored(lease: MirrorLease, seq: number): Promise<boolean> {
    const link = this.held(lease);
    if (!link) return false;
    delete link.leaseUntil;
    if (link.lastMirroredSeq !== null && link.lastMirroredSeq > seq) return true;
    link.lastMirroredSeq = seq;
    link.lastMirroredAt = new Date();
    link.lastErrorCode = null;
    return true;
  }

  async markNeedsRelink(spreadsheetId: string, tokenNonce: Buffer): Promise<void> {
    const link = this.link;
    if (!link || link.spreadsheetId !== spreadsheetId || !link.token?.nonce.equals(tokenNonce)) return;
    link.status = 'needs_relink';
    link.token = null;
    link.lastErrorCode = 'invalid_grant';
  }

  async markSheetMissing(spreadsheetId: string): Promise<void> {
    const link = this.link;
    if (!link || link.spreadsheetId !== spreadsheetId || link.status !== 'linked') return;
    link.status = 'sheet_missing';
    link.lastErrorCode = 'sheet_missing';
  }

  async putOauthRequest(request: GoogleOauthRequestRecord): Promise<void> {
    this.request = { ...request };
  }

  async takeOauthRequest(): Promise<GoogleOauthRequestRecord | null> {
    const request = this.request;
    this.request = null;
    return request;
  }

  /** The columns Download My Data exports, as PrismaUserDataExportRepository selects them. */
  exportRows(): StoredRow[] {
    if (!this.link) return [];
    const { status, spreadsheetUrl, lastMirroredAt, createdAt } = this.link;
    return [{ status, spreadsheetUrl, lastMirroredAt, createdAt }];
  }
}
