import {
  GoogleOauthRequestRecord,
  GoogleSheetLinkRecord,
  IGoogleSheetLinkRepository,
} from '../../ports/IGoogleSheetLinkRepository';
import { StoredRow } from '../../ports/IUserDataExportRepository';

export class InMemoryGoogleSheetLinkRepository implements IGoogleSheetLinkRepository {
  private link: (GoogleSheetLinkRecord & { createdAt: Date; leaseUntil?: Date; lastMirroredSeq?: number }) | null = null;
  private request: GoogleOauthRequestRecord | null = null;

  async getLink(): Promise<GoogleSheetLinkRecord | null> {
    if (!this.link) return null;
    const { createdAt: _createdAt, leaseUntil: _leaseUntil, lastMirroredSeq: _seq, ...link } = this.link;
    return link;
  }

  async saveLink(link: Omit<GoogleSheetLinkRecord, 'lastMirroredAt'>): Promise<void> {
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
      createdAt: this.link?.createdAt ?? new Date(),
      ...(sameSheet && this.link?.leaseUntil && { leaseUntil: this.link.leaseUntil }),
      ...(sameSheet && this.link?.lastMirroredSeq !== undefined && { lastMirroredSeq: this.link.lastMirroredSeq }),
    };
  }

  async deleteLink(): Promise<void> {
    this.link = null;
  }

  async takeMirrorLease(): Promise<boolean> {
    if (!this.link || (this.link.leaseUntil && this.link.leaseUntil.getTime() > Date.now())) return false;
    this.link.leaseUntil = new Date(Date.now() + 2 * 60_000);
    return true;
  }

  async releaseMirrorLease(errorCode?: string): Promise<void> {
    if (!this.link) return;
    delete this.link.leaseUntil;
    if (errorCode !== undefined) this.link.lastErrorCode = errorCode;
  }

  async recordMirrored(seq: number): Promise<void> {
    if (!this.link) return;
    delete this.link.leaseUntil;
    this.link.lastMirroredSeq = seq;
    this.link.lastMirroredAt = new Date();
    this.link.lastErrorCode = null;
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
